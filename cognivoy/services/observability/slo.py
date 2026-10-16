"""SQLite-backed service-level indicators shared by local API workers.

Only aggregate operational facts are stored: route group, status, duration and
an allow-listed business counter. Prompts, paths with identifiers and user
identity never enter this database.
"""

from __future__ import annotations

from datetime import datetime, timezone
import math
from pathlib import Path
import re
import sqlite3
import time
from typing import Any

BUSINESS_METRICS = (
    "asset_saved",
    "learning_completed",
    "reference_clicked",
    "turn_recovered",
)
_SAFE_GROUP = re.compile(r"^[a-z0-9_-]{1,64}$")
_RETENTION_SECONDS = 30 * 24 * 60 * 60


class SloStore:
    """Durable, multi-worker request and product SLI store."""

    def __init__(
        self,
        path: Path,
        *,
        availability_target: float = 99.5,
        p95_target_ms: float = 1_000,
        minimum_samples: int = 20,
    ) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.availability_target = float(availability_target)
        self.p95_target_ms = float(p95_target_ms)
        self.minimum_samples = max(1, int(minimum_samples))
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS slo_requests (
                    occurred_at REAL NOT NULL,
                    route_group TEXT NOT NULL,
                    status_code INTEGER NOT NULL,
                    duration_ms REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS slo_requests_window
                    ON slo_requests(occurred_at);
                CREATE INDEX IF NOT EXISTS slo_requests_group_window
                    ON slo_requests(route_group, occurred_at);
                CREATE TABLE IF NOT EXISTS slo_business_events (
                    occurred_at REAL NOT NULL,
                    name TEXT NOT NULL,
                    amount INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS slo_business_window
                    ON slo_business_events(occurred_at, name);
                """
            )

    def record_request(
        self,
        *,
        route_group: str,
        status_code: int,
        duration_ms: float,
        now: float | None = None,
    ) -> None:
        group = str(route_group or "other").strip().lower()
        if not _SAFE_GROUP.fullmatch(group):
            group = "other"
        timestamp = time.time() if now is None else float(now)
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO slo_requests(occurred_at, route_group, status_code, duration_ms) "
                "VALUES (?, ?, ?, ?)",
                (
                    timestamp,
                    group,
                    max(100, min(int(status_code), 599)),
                    max(0.0, float(duration_ms)),
                ),
            )
            self._prune(connection, timestamp)

    def record_business_event(
        self, name: str, *, amount: int = 1, now: float | None = None
    ) -> None:
        metric = str(name or "").strip()
        if metric not in BUSINESS_METRICS:
            raise ValueError(f"unsupported SLO business metric: {metric}")
        count = int(amount)
        if count <= 0 or count > 10_000:
            raise ValueError("SLO business metric amount must be positive and at most 10000")
        timestamp = time.time() if now is None else float(now)
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO slo_business_events(occurred_at, name, amount) VALUES (?, ?, ?)",
                (timestamp, metric, count),
            )
            self._prune(connection, timestamp)

    def snapshot(self, *, window_seconds: int = 86_400, now: float | None = None) -> dict[str, Any]:
        timestamp = time.time() if now is None else float(now)
        window = max(300, min(int(window_seconds), _RETENTION_SECONDS))
        since = timestamp - window
        with self._connect() as connection:
            request_rows = list(
                connection.execute(
                    "SELECT route_group, status_code, duration_ms FROM slo_requests "
                    "WHERE occurred_at >= ? ORDER BY occurred_at",
                    (since,),
                )
            )
            business_rows = list(
                connection.execute(
                    "SELECT name, COALESCE(SUM(amount), 0) FROM slo_business_events "
                    "WHERE occurred_at >= ? GROUP BY name",
                    (since,),
                )
            )

        request_count = len(request_rows)
        server_errors = sum(1 for _, status, _ in request_rows if int(status) >= 500)
        successful = request_count - server_errors
        availability = round(successful * 100 / request_count, 3) if request_count else None
        durations = [float(row[2]) for row in request_rows]
        latency = {
            "p50": _percentile(durations, 0.50),
            "p95": _percentile(durations, 0.95),
        }
        grouped: dict[str, list[tuple[int, float]]] = {}
        for group, status, duration in request_rows:
            grouped.setdefault(str(group), []).append((int(status), float(duration)))
        route_groups = []
        for name, rows in sorted(grouped.items()):
            group_errors = sum(1 for status, _ in rows if status >= 500)
            route_groups.append(
                {
                    "name": name,
                    "requests": len(rows),
                    "server_errors": group_errors,
                    "availability_percent": round((len(rows) - group_errors) * 100 / len(rows), 3),
                    "p95_ms": _percentile([duration for _, duration in rows], 0.95),
                }
            )

        alerts: list[dict[str, Any]] = []
        if request_count >= self.minimum_samples:
            if availability is not None and availability < self.availability_target:
                alerts.append(
                    {
                        "code": "availability_below_target",
                        "severity": "critical",
                        "actual": availability,
                        "target": self.availability_target,
                    }
                )
            if latency["p95"] is not None and latency["p95"] > self.p95_target_ms:
                alerts.append(
                    {
                        "code": "p95_above_target",
                        "severity": "warning",
                        "actual": latency["p95"],
                        "target": self.p95_target_ms,
                    }
                )

        business = {name: 0 for name in BUSINESS_METRICS}
        for name, amount in business_rows:
            if name in business:
                business[str(name)] = int(amount)
        return {
            "generated_at": datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat(),
            "window_seconds": window,
            "targets": {
                "availability_percent": self.availability_target,
                "p95_ms": self.p95_target_ms,
                "minimum_samples": self.minimum_samples,
            },
            "requests": request_count,
            "successful_requests": successful,
            "server_errors": server_errors,
            "availability_percent": availability,
            "latency_ms": latency,
            "alerts": alerts,
            "business_metrics": business,
            "route_groups": route_groups,
        }

    @staticmethod
    def _prune(connection: sqlite3.Connection, timestamp: float) -> None:
        cutoff = timestamp - _RETENTION_SECONDS
        connection.execute("DELETE FROM slo_requests WHERE occurred_at < ?", (cutoff,))
        connection.execute("DELETE FROM slo_business_events WHERE occurred_at < ?", (cutoff,))


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1))
    return round(float(ordered[index]), 3)


def route_group_for_path(path: str) -> str:
    """Collapse an API path to its non-identifying top-level product domain."""
    parts = [part for part in str(path or "").split("/") if part]
    if len(parts) >= 3 and parts[0:2] == ["api", "v1"]:
        candidate = parts[2].lower()
        return candidate if _SAFE_GROUP.fullmatch(candidate) else "other"
    return "other"


_service: SloStore | None = None


def get_slo_service() -> SloStore:
    global _service
    if _service is None:
        from cognivoy.multi_user.paths import get_admin_path_service

        path = get_admin_path_service().workspace_root / "observability" / "slo.sqlite3"
        _service = SloStore(path)
    return _service


__all__ = ["BUSINESS_METRICS", "SloStore", "get_slo_service", "route_group_for_path"]
