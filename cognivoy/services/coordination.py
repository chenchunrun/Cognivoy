"""Small SQLite-backed coordination primitives shared by local workers.

The bundled deployment intentionally avoids requiring Redis.  SQLite gives
all API workers which mount the same Cognivoy data volume one atomic source
of truth for leases, FIFO capacity, inbound idempotency and sliding-window
limits.  A distributed deployment may replace this class behind the same
contract with a database or Redis implementation.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import sqlite3
import time
from typing import Iterator, Literal

SlotDecision = Literal["acquired", "waiting", "rejected"]


class SharedCoordinationStore:
    """Transactional coordination state stored in a single SQLite file."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0, isolation_level=None)
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS coordination_slots (
                    namespace TEXT NOT NULL,
                    ticket TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state IN ('waiting', 'active')),
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    PRIMARY KEY (namespace, ticket)
                );
                CREATE INDEX IF NOT EXISTS coordination_slots_order
                    ON coordination_slots(namespace, state, created_at, ticket);

                CREATE TABLE IF NOT EXISTS coordination_claims (
                    namespace TEXT NOT NULL,
                    claim_key TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    PRIMARY KEY (namespace, claim_key)
                );

                CREATE TABLE IF NOT EXISTS inbound_dedupe (
                    namespace TEXT NOT NULL,
                    dedupe_key TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    PRIMARY KEY (namespace, dedupe_key)
                );

                CREATE TABLE IF NOT EXISTS inbound_rate_events (
                    namespace TEXT NOT NULL,
                    rate_key TEXT NOT NULL,
                    occurred_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS inbound_rate_window
                    ON inbound_rate_events(namespace, rate_key, occurred_at);

                CREATE TABLE IF NOT EXISTS login_rate_events (
                    bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('identity', 'ip')),
                    bucket_key TEXT NOT NULL,
                    occurred_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS login_rate_window
                    ON login_rate_events(bucket_kind, bucket_key, occurred_at);

                CREATE TABLE IF NOT EXISTS coordination_metrics (
                    namespace TEXT NOT NULL,
                    metric TEXT NOT NULL,
                    value INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (namespace, metric)
                );

                CREATE TABLE IF NOT EXISTS coordination_revisions (
                    topic TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL DEFAULT 0,
                    updated_at REAL NOT NULL
                );
                """
            )

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.execute("COMMIT")
        except BaseException:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def try_acquire_slot(
        self,
        *,
        namespace: str,
        ticket: str,
        max_active: int,
        max_queued: int,
        lease_seconds: float,
        waiter_ttl_seconds: float | None = None,
        now: float | None = None,
    ) -> SlotDecision:
        timestamp = time.time() if now is None else float(now)
        active_expiry = timestamp + max(1.0, float(lease_seconds))
        waiting_expiry = timestamp + max(
            1.0,
            float(waiter_ttl_seconds if waiter_ttl_seconds is not None else lease_seconds),
        )
        with self._transaction() as connection:
            connection.execute(
                "DELETE FROM coordination_slots WHERE namespace = ? AND expires_at <= ?",
                (namespace, timestamp),
            )
            existing = connection.execute(
                "SELECT state FROM coordination_slots WHERE namespace = ? AND ticket = ?",
                (namespace, ticket),
            ).fetchone()
            active = int(
                connection.execute(
                    "SELECT COUNT(*) FROM coordination_slots "
                    "WHERE namespace = ? AND state = 'active'",
                    (namespace,),
                ).fetchone()[0]
            )
            first_waiter = connection.execute(
                "SELECT ticket FROM coordination_slots "
                "WHERE namespace = ? AND state = 'waiting' "
                "ORDER BY created_at, ticket LIMIT 1",
                (namespace,),
            ).fetchone()

            if existing and existing[0] == "active":
                connection.execute(
                    "UPDATE coordination_slots SET expires_at = ? "
                    "WHERE namespace = ? AND ticket = ?",
                    (active_expiry, namespace, ticket),
                )
                return "acquired"

            may_enter = active < max_active and (first_waiter is None or first_waiter[0] == ticket)
            if may_enter:
                connection.execute(
                    "INSERT INTO coordination_slots"
                    "(namespace, ticket, state, created_at, expires_at) "
                    "VALUES (?, ?, 'active', ?, ?) "
                    "ON CONFLICT(namespace, ticket) DO UPDATE SET "
                    "state = 'active', expires_at = excluded.expires_at",
                    (namespace, ticket, timestamp, active_expiry),
                )
                return "acquired"

            if existing:
                connection.execute(
                    "UPDATE coordination_slots SET expires_at = ? "
                    "WHERE namespace = ? AND ticket = ?",
                    (waiting_expiry, namespace, ticket),
                )
                return "waiting"

            queued = int(
                connection.execute(
                    "SELECT COUNT(*) FROM coordination_slots "
                    "WHERE namespace = ? AND state = 'waiting'",
                    (namespace,),
                ).fetchone()[0]
            )
            if queued >= max_queued:
                return "rejected"
            connection.execute(
                "INSERT INTO coordination_slots"
                "(namespace, ticket, state, created_at, expires_at) "
                "VALUES (?, ?, 'waiting', ?, ?)",
                (namespace, ticket, timestamp, waiting_expiry),
            )
            return "waiting"

    def release_slot(self, *, namespace: str, ticket: str) -> None:
        with self._transaction() as connection:
            connection.execute(
                "DELETE FROM coordination_slots WHERE namespace = ? AND ticket = ?",
                (namespace, ticket),
            )

    def slot_snapshot(self, namespace: str, *, now: float | None = None) -> dict[str, int]:
        timestamp = time.time() if now is None else float(now)
        with self._transaction() as connection:
            connection.execute(
                "DELETE FROM coordination_slots WHERE namespace = ? AND expires_at <= ?",
                (namespace, timestamp),
            )
            rows = dict(
                connection.execute(
                    "SELECT state, COUNT(*) FROM coordination_slots "
                    "WHERE namespace = ? GROUP BY state",
                    (namespace,),
                ).fetchall()
            )
        return {
            "active_runs": int(rows.get("active", 0)),
            "queued_runs": int(rows.get("waiting", 0)),
        }

    def increment_metric(self, namespace: str, metric: str, amount: int = 1) -> None:
        with self._transaction() as connection:
            connection.execute(
                "INSERT INTO coordination_metrics(namespace, metric, value) VALUES (?, ?, ?) "
                "ON CONFLICT(namespace, metric) DO UPDATE SET value = value + excluded.value",
                (namespace, metric, int(amount)),
            )

    def metrics(self, namespace: str) -> dict[str, int]:
        with self._connect() as connection:
            return {
                str(metric): int(value)
                for metric, value in connection.execute(
                    "SELECT metric, value FROM coordination_metrics WHERE namespace = ?",
                    (namespace,),
                ).fetchall()
            }

    def revision(self, topic: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT revision FROM coordination_revisions WHERE topic = ?",
                (topic,),
            ).fetchone()
        return int(row[0]) if row else 0

    def publish_revision(self, topic: str) -> int:
        with self._transaction() as connection:
            connection.execute(
                "INSERT INTO coordination_revisions(topic, revision, updated_at) "
                "VALUES (?, 1, ?) ON CONFLICT(topic) DO UPDATE SET "
                "revision = revision + 1, updated_at = excluded.updated_at",
                (topic, time.time()),
            )
            row = connection.execute(
                "SELECT revision FROM coordination_revisions WHERE topic = ?",
                (topic,),
            ).fetchone()
        return int(row[0])

    def claim(
        self,
        *,
        namespace: str,
        key: str,
        owner: str,
        lease_seconds: float,
        now: float | None = None,
    ) -> bool:
        timestamp = time.time() if now is None else float(now)
        with self._transaction() as connection:
            connection.execute(
                "DELETE FROM coordination_claims WHERE namespace = ? AND expires_at <= ?",
                (namespace, timestamp),
            )
            existing = connection.execute(
                "SELECT 1 FROM coordination_claims WHERE namespace = ? AND claim_key = ?",
                (namespace, key),
            ).fetchone()
            if existing:
                return False
            connection.execute(
                "INSERT INTO coordination_claims(namespace, claim_key, owner, expires_at) "
                "VALUES (?, ?, ?, ?)",
                (namespace, key, owner, timestamp + max(1.0, float(lease_seconds))),
            )
            return True

    def accept_inbound(
        self,
        *,
        namespace: str,
        dedupe_key: str,
        rate_key: str,
        rate_limit: int,
        window_seconds: float,
        dedupe_ttl_seconds: float,
        now: float | None = None,
    ) -> tuple[bool, str]:
        timestamp = time.time() if now is None else float(now)
        with self._transaction() as connection:
            connection.execute(
                "DELETE FROM inbound_dedupe WHERE namespace = ? AND expires_at <= ?",
                (namespace, timestamp),
            )
            connection.execute(
                "DELETE FROM inbound_rate_events WHERE namespace = ? AND occurred_at <= ?",
                (namespace, timestamp - float(window_seconds)),
            )
            if dedupe_key:
                duplicate = connection.execute(
                    "SELECT 1 FROM inbound_dedupe WHERE namespace = ? AND dedupe_key = ?",
                    (namespace, dedupe_key),
                ).fetchone()
                if duplicate:
                    return False, "duplicate"

            event_count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM inbound_rate_events WHERE namespace = ? AND rate_key = ?",
                    (namespace, rate_key),
                ).fetchone()[0]
            )
            if event_count >= int(rate_limit):
                return False, "rate_limited"

            connection.execute(
                "INSERT INTO inbound_rate_events(namespace, rate_key, occurred_at) "
                "VALUES (?, ?, ?)",
                (namespace, rate_key, timestamp),
            )
            if dedupe_key:
                connection.execute(
                    "INSERT INTO inbound_dedupe(namespace, dedupe_key, expires_at) "
                    "VALUES (?, ?, ?)",
                    (
                        namespace,
                        dedupe_key,
                        timestamp + max(1.0, float(dedupe_ttl_seconds)),
                    ),
                )
            return True, "accepted"

    def login_retry_after(
        self,
        *,
        identity_key: str,
        ip_key: str,
        identity_limit: int,
        ip_limit: int,
        window_seconds: float,
        now: float | None = None,
    ) -> int:
        """Return the shared sliding-window delay for a login identity/IP."""
        import math

        timestamp = time.time() if now is None else float(now)
        cutoff = timestamp - float(window_seconds)
        remaining = 0
        with self._transaction() as connection:
            connection.execute("DELETE FROM login_rate_events WHERE occurred_at <= ?", (cutoff,))
            for kind, key, limit in (
                ("identity", identity_key, int(identity_limit)),
                ("ip", ip_key, int(ip_limit)),
            ):
                rows = connection.execute(
                    "SELECT occurred_at FROM login_rate_events "
                    "WHERE bucket_kind = ? AND bucket_key = ? "
                    "ORDER BY occurred_at",
                    (kind, key),
                ).fetchall()
                if len(rows) >= limit:
                    remaining = max(
                        remaining,
                        math.ceil(float(window_seconds) - (timestamp - float(rows[0][0]))),
                    )
        return max(0, int(remaining))

    def record_login_failure(
        self,
        *,
        identity_key: str,
        ip_key: str,
        now: float | None = None,
    ) -> None:
        timestamp = time.time() if now is None else float(now)
        with self._transaction() as connection:
            connection.executemany(
                "INSERT INTO login_rate_events(bucket_kind, bucket_key, occurred_at) "
                "VALUES (?, ?, ?)",
                (("identity", identity_key, timestamp), ("ip", ip_key, timestamp)),
            )

    def clear_login_identity(self, identity_key: str) -> None:
        with self._transaction() as connection:
            connection.execute(
                "DELETE FROM login_rate_events WHERE bucket_kind = 'identity' AND bucket_key = ?",
                (identity_key,),
            )

    def clear_login_events(self) -> None:
        with self._transaction() as connection:
            connection.execute("DELETE FROM login_rate_events")


_shared_store: SharedCoordinationStore | None = None


class SharedConfigRevisionWatcher:
    """Per-worker edge trigger for a shared configuration generation."""

    def __init__(
        self,
        topic: str,
        *,
        store: SharedCoordinationStore | None = None,
    ) -> None:
        self.topic = topic
        self.store = store or get_shared_coordination_store()
        self._seen = self.store.revision(topic)

    def changed(self) -> bool:
        current = self.store.revision(self.topic)
        if current == self._seen:
            return False
        self._seen = current
        return True


def get_shared_coordination_store() -> SharedCoordinationStore:
    """Return the deployment coordinator anchored at the admin data volume."""
    global _shared_store
    if _shared_store is None:
        from cognivoy.multi_user.paths import get_admin_path_service

        path = get_admin_path_service().workspace_root / "coordination.sqlite3"
        _shared_store = SharedCoordinationStore(path)
    return _shared_store


__all__ = [
    "SharedCoordinationStore",
    "SharedConfigRevisionWatcher",
    "SlotDecision",
    "get_shared_coordination_store",
]
