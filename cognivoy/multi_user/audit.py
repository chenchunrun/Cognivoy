"""Audit log for resource access and admin actions in the multi-user layer."""

from __future__ import annotations

from collections import Counter
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import threading
from typing import Any

from cognivoy.services.file_io import atomic_write_json

from .context import get_current_user
from .paths import ensure_system_dirs

_AUDIT_MAX_BYTES = 10 * 1024 * 1024
_AUDIT_BACKUPS = 5
_AUDIT_QUERY_SCAN_LIMIT = 20_000
_audit_lock = threading.Lock()

_CONTROL_PLANE_PUBLIC_FIELDS = frozenset(
    {
        "time",
        "event",
        "category",
        "action",
        "decision_id",
        "kind",
        "name",
        "allowed",
        "rule_id",
        "reason",
        "risk_level",
        "args_digest",
        "source",
        "stage",
        "success",
        "error_type",
        "target_digest",
        "policy_digest",
        "target_user_id",
        "tenant_id",
        "user_id",
        "role",
        "session_id",
        "turn_id",
    }
)


def _audit_file():
    # Resolved per call so monkey-patched SYSTEM_ROOT (e.g. in tests) takes
    # effect without a module reload.
    from . import paths

    return paths.SYSTEM_ROOT / "audit" / "usage.jsonl"


def _control_plane_audit_file() -> Path:
    from . import paths

    return paths.SYSTEM_ROOT / "audit" / "control-plane.jsonl"


def _control_plane_ack_file() -> Path:
    from . import paths

    return paths.SYSTEM_ROOT / "control-plane" / "alert-acknowledgements.json"


def _rotate(path: Path) -> None:
    """Bound an audit stream without ever deleting the active file first."""
    try:
        if not path.exists() or path.stat().st_size < _AUDIT_MAX_BYTES:
            return
        oldest = path.with_name(f"{path.name}.{_AUDIT_BACKUPS}")
        oldest.unlink(missing_ok=True)
        for index in range(_AUDIT_BACKUPS - 1, 0, -1):
            source = path.with_name(f"{path.name}.{index}")
            if source.exists():
                source.replace(path.with_name(f"{path.name}.{index + 1}"))
        path.replace(path.with_name(f"{path.name}.1"))
    except OSError:
        # Failure to rotate must not make the protected operation unavailable.
        return


def _write(payload: dict[str, Any], *, path: Path | None = None) -> None:
    try:
        with _audit_lock:
            ensure_system_dirs()
            target = path or _audit_file()
            _rotate(target)
            with target.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
    except Exception:
        # Auditing must never break a request.
        return


def log_control_plane_event(payload: dict[str, Any]) -> None:
    """Persist a redacted control-plane decision/outcome for incident review."""
    row = {"time": datetime.now(timezone.utc).isoformat(), **payload}
    _write(row, path=_control_plane_audit_file())


def _parse_audit_time(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iter_recent_control_plane_rows():
    """Yield newest-first rows from bounded active and rotated audit files."""
    active = _control_plane_audit_file()
    paths = [active] + [
        active.with_name(f"{active.name}.{index}") for index in range(1, _AUDIT_BACKUPS + 1)
    ]
    scanned = 0
    for path in paths:
        try:
            lines = path.read_bytes().splitlines()
        except OSError:
            continue
        for raw in reversed(lines):
            if scanned >= _AUDIT_QUERY_SCAN_LIMIT:
                return
            scanned += 1
            try:
                row = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if isinstance(row, dict):
                yield row


def query_control_plane_events(
    *,
    since_hours: int = 24,
    limit: int = 100,
    decision: str = "all",
    risk_level: str = "",
    user_id: str = "",
    name: str = "",
) -> dict[str, Any]:
    """Return a bounded, redacted operator view of execution policy activity."""
    hours = max(1, min(720, int(since_hours)))
    row_limit = max(1, min(200, int(limit)))
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    selected: list[dict[str, Any]] = []
    summary_rows: list[dict[str, Any]] = []
    scanned = 0

    for row in _iter_recent_control_plane_rows():
        scanned += 1
        timestamp = _parse_audit_time(row.get("time"))
        if timestamp is None or timestamp < cutoff:
            continue
        public = {key: row[key] for key in _CONTROL_PLANE_PUBLIC_FIELDS if key in row}
        summary_rows.append(public)

        if decision == "allowed" and public.get("allowed") is not True:
            continue
        if decision == "denied" and public.get("allowed") is not False:
            continue
        if risk_level and public.get("risk_level") != risk_level:
            continue
        if user_id and public.get("user_id") != user_id:
            continue
        if name and public.get("name") != name:
            continue
        if len(selected) < row_limit:
            selected.append(public)

    decisions = [row for row in summary_rows if row.get("event") == "policy_decision"]
    outcomes = [row for row in summary_rows if row.get("event") == "execution_outcome"]
    denied = [row for row in decisions if row.get("allowed") is False]
    critical_denied = [row for row in denied if row.get("risk_level") == "critical"]
    budget_denied = [row for row in denied if str(row.get("rule_id", "")).startswith("budget.")]
    failures = [row for row in outcomes if row.get("success") is False]
    network_denied = [
        row
        for row in summary_rows
        if row.get("event") == "security_event" and row.get("category") == "network_policy_denial"
    ]
    denied_names = Counter(str(row.get("name") or "unknown") for row in denied)
    alerts: list[dict[str, Any]] = []

    def append_alert(code: str, severity: str, rows: list[dict[str, Any]]) -> None:
        latest = max((str(row.get("time") or "") for row in rows), default="")
        fingerprint = hashlib.sha256(f"{code}:{len(rows)}:{latest}".encode("utf-8")).hexdigest()[
            :16
        ]
        alerts.append(
            {
                "code": code,
                "severity": severity,
                "count": len(rows),
                "fingerprint": fingerprint,
            }
        )

    if critical_denied:
        append_alert("critical_policy_denials", "critical", critical_denied)
    if len(budget_denied) >= 5:
        append_alert("repeated_budget_denials", "warning", budget_denied)
    if len(decisions) >= 10 and len(denied) / len(decisions) >= 0.1:
        append_alert("elevated_denial_rate", "warning", denied)
    if network_denied:
        append_alert("network_policy_denials", "warning", network_denied)

    acknowledgements = _load_alert_acknowledgements()
    for alert in alerts:
        acknowledgement = acknowledgements.get(alert["fingerprint"])
        alert["acknowledged"] = acknowledgement is not None
        alert["acknowledged_at"] = str(acknowledgement.get("time") or "") if acknowledgement else ""

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_hours": hours,
        "events": selected,
        "summary": {
            "decisions": len(decisions),
            "allowed": len(decisions) - len(denied),
            "denied": len(denied),
            "critical_denied": len(critical_denied),
            "budget_denied": len(budget_denied),
            "outcomes": len(outcomes),
            "failed_outcomes": len(failures),
            "network_denied": len(network_denied),
            "unique_users": len(
                {str(row.get("user_id")) for row in decisions if row.get("user_id")}
            ),
            "top_denied": [
                {"name": denied_name, "count": count}
                for denied_name, count in denied_names.most_common(5)
            ],
        },
        "alerts": alerts,
        "scanned": scanned,
        "scan_truncated": scanned >= _AUDIT_QUERY_SCAN_LIMIT,
    }


def _load_alert_acknowledgements() -> dict[str, dict[str, str]]:
    try:
        raw = json.loads(_control_plane_ack_file().read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    entries = raw.get("acknowledgements") if isinstance(raw, dict) else None
    if not isinstance(entries, dict):
        return {}
    return {
        str(key): {"time": str(value.get("time") or ""), "user_id": str(value.get("user_id") or "")}
        for key, value in entries.items()
        if isinstance(value, dict)
    }


def acknowledge_control_plane_alert(fingerprint: str, *, user_id: str) -> dict[str, str]:
    normalized = str(fingerprint or "").strip().lower()
    if len(normalized) != 16 or any(char not in "0123456789abcdef" for char in normalized):
        raise ValueError("Invalid alert fingerprint")
    acknowledgement = {
        "time": datetime.now(timezone.utc).isoformat(),
        "user_id": str(user_id or ""),
    }
    with _audit_lock:
        entries = _load_alert_acknowledgements()
        entries[normalized] = acknowledgement
        # Retain only the newest bounded set. Old fingerprints are obsolete as
        # soon as their alert receives another matching event.
        newest = sorted(entries.items(), key=lambda item: item[1].get("time", ""), reverse=True)[
            :1000
        ]
        atomic_write_json(
            _control_plane_ack_file(),
            {"version": 1, "acknowledgements": dict(newest)},
        )
    return acknowledgement


def export_control_plane_events_csv(*, since_hours: int = 24) -> str:
    """Export bounded redacted rows while neutralizing spreadsheet formulas."""
    hours = max(1, min(720, int(since_hours)))
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows: list[dict[str, Any]] = []
    for row in _iter_recent_control_plane_rows():
        timestamp = _parse_audit_time(row.get("time"))
        if timestamp is None or timestamp < cutoff:
            continue
        rows.append({key: row[key] for key in _CONTROL_PLANE_PUBLIC_FIELDS if key in row})
        if len(rows) >= 10_000:
            break

    fields = sorted(_CONTROL_PLANE_PUBLIC_FIELDS)
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        safe = {}
        for key in fields:
            value = str(row.get(key, ""))
            safe[key] = "'" + value if value.startswith(("=", "+", "-", "@")) else value
        writer.writerow(safe)
    return buffer.getvalue()


def log_usage(
    resource_type: str,
    resource_id: str,
    action: str,
    extra: dict[str, Any] | None = None,
) -> None:
    """Record an ordinary user's access to an admin-curated resource.

    Admin self-access is intentionally not recorded here (admins constantly
    interact with their own workspace; logging every read would dilute the
    signal). Use :func:`log_admin_action` for admin-side write events.
    """
    user = get_current_user()
    if user.is_admin:
        return
    payload: dict[str, Any] = {
        "time": datetime.now(timezone.utc).isoformat(),
        "user_id": user.id,
        "username": user.username,
        "resource_type": resource_type,
        "resource_id": resource_id,
        "action": action,
    }
    if extra:
        payload["extra"] = extra
    _write(payload)


def log_admin_action(
    action: str,
    target_user_id: str | None = None,
    summary: dict[str, Any] | None = None,
) -> None:
    """Record an admin-side write (grant change, user CRUD, etc.).

    The current user (the actor) is captured automatically; ``target_user_id``
    identifies which user the action affects (if any). ``summary`` may carry a
    short, non-secret payload describing what changed.
    """
    user = get_current_user()
    payload: dict[str, Any] = {
        "time": datetime.now(timezone.utc).isoformat(),
        "actor_id": user.id,
        "actor_username": user.username,
        "actor_role": user.role,
        "action": action,
    }
    if target_user_id:
        payload["target_user_id"] = target_user_id
    if summary:
        payload["summary"] = summary
    _write(payload)
