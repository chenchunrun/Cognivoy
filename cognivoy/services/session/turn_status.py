"""Canonical persisted states for unified turns."""

from __future__ import annotations

ACTIVE_TURN_STATUSES = frozenset({"queued", "running", "waiting_for_input"})
TERMINAL_TURN_STATUSES = frozenset({"completed", "failed", "cancelled", "timed_out", "rejected"})
ALL_TURN_STATUSES = ACTIVE_TURN_STATUSES | TERMINAL_TURN_STATUSES


def is_active_turn_status(status: object) -> bool:
    return str(status or "") in ACTIVE_TURN_STATUSES


def is_terminal_turn_status(status: object) -> bool:
    return str(status or "") in TERMINAL_TURN_STATUSES


__all__ = [
    "ACTIVE_TURN_STATUSES",
    "ALL_TURN_STATUSES",
    "TERMINAL_TURN_STATUSES",
    "is_active_turn_status",
    "is_terminal_turn_status",
]
