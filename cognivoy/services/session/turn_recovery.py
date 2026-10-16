"""Durable request manifests and leases for restartable turns.

The session database is the source of truth for user-visible events and turn
status.  This sidecar stores the executable request and stage checkpoint needed
to reconstruct an in-memory runner after the API process disappears.  Files are
owner-scoped by :class:`PathService` and atomically replaced under an advisory
lock so multiple workers cannot resume the same turn concurrently.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import socket
import threading
import time
from typing import Any, Callable, Iterator, Literal

from cognivoy.services.path_service import get_path_service

_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
_TERMINAL = frozenset({"completed", "failed", "cancelled", "timed_out", "rejected"})

RecoveryMode = Literal["checkpoint", "replay", "fail"]

# Restart semantics are explicit because replaying an unknown/plugin
# capability can repeat irreversible tool side effects.  Checkpoint-capable
# pipelines persist typed stage payloads; the remaining built-ins restart from the
# validated request while suppressing duplicate user-message persistence.
CAPABILITY_RECOVERY_MODES: dict[str, RecoveryMode] = {
    "chat": "replay",
    "deep_solve": "checkpoint",
    "deep_question": "checkpoint",
    "deep_research": "checkpoint",
    "math_animator": "checkpoint",
    "visualize": "checkpoint",
    "mastery_path": "replay",
}


def recovery_mode_for(capability: str) -> RecoveryMode:
    return CAPABILITY_RECOVERY_MODES.get(str(capability or "").strip(), "fail")


class TurnRecoveryStore:
    """Persist restart data and coordinate one recovery owner per turn."""

    def __init__(self, *, root: Path | None = None) -> None:
        self.root = (
            Path(root)
            if root is not None
            else (get_path_service().get_chat_workspace_root() / "_turn_recovery")
        )
        self._thread_lock = threading.RLock()

    def create(
        self,
        *,
        turn_id: str,
        session_id: str,
        capability: str,
        payload: dict[str, Any],
        worker_id: str = "",
        lease_seconds: float = 15.0,
    ) -> dict[str, Any]:
        now = self._now()
        manifest = {
            "version": 1,
            "turn_id": self._safe_id(turn_id),
            "session_id": str(session_id),
            "capability": str(capability or "chat"),
            "payload": dict(payload),
            "status": "active",
            "input_persisted": False,
            "user_message_id": None,
            "last_stage": "",
            "checkpoint": {},
            "waiting_for_input": False,
            "pending_reply": None,
            "resume_count": 0,
            "lease_owner": str(worker_id),
            "lease_expires_at": (
                time.time() + max(1.0, float(lease_seconds)) if worker_id else 0.0
            ),
            "created_at": now,
            "updated_at": now,
        }
        with self._locked(turn_id):
            self._write_unlocked(turn_id, manifest)
        return dict(manifest)

    def load(self, turn_id: str) -> dict[str, Any] | None:
        with self._locked(turn_id):
            value = self._read_unlocked(turn_id)
        return dict(value) if value is not None else None

    def mark_input_persisted(self, turn_id: str, *, message_id: int | str) -> None:
        self._update(
            turn_id,
            lambda value: {
                **value,
                "input_persisted": True,
                "user_message_id": message_id,
            },
        )

    def record_checkpoint(
        self,
        turn_id: str,
        *,
        stage: str,
        checkpoint: dict[str, Any] | None = None,
    ) -> None:
        def apply(value: dict[str, Any]) -> dict[str, Any]:
            merged = dict(value.get("checkpoint") or {})
            if checkpoint:
                merged.update(checkpoint)
            return {
                **value,
                "last_stage": str(stage or value.get("last_stage") or ""),
                "checkpoint": merged,
            }

        self._update(turn_id, apply)

    def mark_waiting_for_input(self, turn_id: str, *, waiting: bool) -> None:
        """Persist whether the runner is paused for learner input.

        A pending reply is intentionally retained when a recovering runner
        marks itself waiting again.  That is what lets input accepted by a
        different API worker survive a process crash between submission and
        consumption.
        """

        self._update(
            turn_id,
            lambda value: {**value, "waiting_for_input": bool(waiting)},
        )

    def submit_reply(self, turn_id: str, payload: dict[str, Any]) -> bool:
        """Atomically enqueue one reply for a durably paused turn."""

        accepted = False

        def apply(value: dict[str, Any]) -> dict[str, Any]:
            nonlocal accepted
            if (
                str(value.get("status") or "") in _TERMINAL
                or not bool(value.get("waiting_for_input"))
                or value.get("pending_reply") is not None
            ):
                return value
            accepted = True
            return {
                **value,
                "pending_reply": dict(payload),
                "reply_submitted_at": self._now(),
            }

        self._update(turn_id, apply)
        return accepted

    def take_reply(self, turn_id: str) -> dict[str, Any] | None:
        """Consume a pending reply exactly once."""

        reply: dict[str, Any] | None = None

        def apply(value: dict[str, Any]) -> dict[str, Any]:
            nonlocal reply
            candidate = value.get("pending_reply")
            if not isinstance(candidate, dict):
                return value
            reply = dict(candidate)
            return {
                **value,
                "pending_reply": None,
                "waiting_for_input": False,
                "reply_consumed_at": self._now(),
            }

        self._update(turn_id, apply)
        return reply

    def claim_resume(
        self,
        turn_id: str,
        *,
        worker_id: str | None = None,
        lease_seconds: float = 60.0,
    ) -> dict[str, Any] | None:
        """Claim an expired/unowned active manifest, or return ``None``."""
        owner = str(worker_id or self.default_worker_id())
        now = time.time()
        with self._locked(turn_id):
            value = self._read_unlocked(turn_id)
            if value is None or str(value.get("status") or "") in _TERMINAL:
                return None
            existing_owner = str(value.get("lease_owner") or "")
            expires_at = float(value.get("lease_expires_at") or 0.0)
            if (
                existing_owner
                and existing_owner != owner
                and expires_at > now
                and self._owner_is_alive(existing_owner)
            ):
                return None
            value.update(
                {
                    "lease_owner": owner,
                    "lease_expires_at": now + max(1.0, float(lease_seconds)),
                    "resume_count": int(value.get("resume_count") or 0) + 1,
                    "resumed_at": self._now(),
                    "updated_at": self._now(),
                }
            )
            self._write_unlocked(turn_id, value)
            return dict(value)

    def renew_lease(
        self,
        turn_id: str,
        *,
        worker_id: str | None = None,
        lease_seconds: float = 60.0,
    ) -> bool:
        owner = str(worker_id or self.default_worker_id())
        renewed = False

        def apply(value: dict[str, Any]) -> dict[str, Any]:
            nonlocal renewed
            if str(value.get("lease_owner") or "") != owner:
                return value
            renewed = True
            return {**value, "lease_expires_at": time.time() + max(1.0, lease_seconds)}

        self._update(turn_id, apply)
        return renewed

    def release(self, turn_id: str, *, worker_id: str | None = None) -> None:
        owner = str(worker_id or self.default_worker_id())

        def apply(value: dict[str, Any]) -> dict[str, Any]:
            if str(value.get("lease_owner") or "") not in {"", owner}:
                return value
            return {**value, "lease_owner": "", "lease_expires_at": 0.0}

        self._update(turn_id, apply)

    def finish(self, turn_id: str, *, status: str) -> None:
        terminal = str(status or "failed")
        if terminal not in _TERMINAL:
            raise ValueError(f"Recovery manifest status must be terminal: {terminal}")
        self._update(
            turn_id,
            lambda value: {
                **value,
                "status": terminal,
                "lease_owner": "",
                "lease_expires_at": 0.0,
                "finished_at": self._now(),
            },
        )

    def _update(
        self,
        turn_id: str,
        updater: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any] | None:
        with self._locked(turn_id):
            value = self._read_unlocked(turn_id)
            if value is None:
                return None
            updated = updater(dict(value))
            updated["updated_at"] = self._now()
            self._write_unlocked(turn_id, updated)
            return dict(updated)

    @contextmanager
    def _locked(self, turn_id: str) -> Iterator[None]:
        safe_id = self._safe_id(turn_id)
        self.root.mkdir(parents=True, exist_ok=True)
        lock_path = self.root / f"{safe_id}.lock"
        with self._thread_lock, lock_path.open("a+b") as handle:
            if os.name == "nt":  # pragma: no cover - Windows CI only
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                try:
                    yield
                finally:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _path(self, turn_id: str) -> Path:
        return self.root / f"{self._safe_id(turn_id)}.json"

    def _read_unlocked(self, turn_id: str) -> dict[str, Any] | None:
        path = self._path(turn_id)
        if not path.exists():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def _write_unlocked(self, turn_id: str, value: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(turn_id)
        temporary = path.with_suffix(f".json.{os.getpid()}.tmp")
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)

    @staticmethod
    def default_worker_id() -> str:
        return f"{socket.gethostname()}:{os.getpid()}"

    @staticmethod
    def _owner_is_alive(owner: str) -> bool:
        """Treat same-host dead PIDs as expired without waiting for the lease."""
        match = re.match(r"^(.*):(\d+)(?::[^:]*)?$", owner)
        if match is None:
            return True
        host, raw_pid = match.groups()
        pid = int(raw_pid)
        if host != socket.gethostname():
            return True
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except (PermissionError, OSError):
            return True
        return True

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _safe_id(value: str) -> str:
        candidate = str(value or "").strip()
        if not _SAFE_ID.fullmatch(candidate):
            raise ValueError("turn_id contains unsafe characters")
        return candidate


__all__ = [
    "CAPABILITY_RECOVERY_MODES",
    "RecoveryMode",
    "TurnRecoveryStore",
    "recovery_mode_for",
]
