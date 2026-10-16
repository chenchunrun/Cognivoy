"""Safe reader for kimi-code 0.34 session metadata and chat text.

Only ``sessions/*/session_*/state.json`` and the main agent's ``wire.jsonl``
are inspected.  Authentication, provider and OAuth directories are never
traversed.  Corrupt sessions are skipped independently.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any


def kimi_sessions_root() -> Path:
    return Path.home() / ".kimi-code" / "sessions"


def scan_kimi_sessions(*, cwd: str = "", limit: int = 500) -> list[dict[str, Any]]:
    root = kimi_sessions_root()
    if not root.is_dir():
        return []
    wanted_cwd = str(Path(cwd).expanduser().resolve()) if cwd else ""
    sessions: list[dict[str, Any]] = []
    for state_path in root.glob("wd_*/session_*/state.json"):
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            session_cwd = str(state.get("cwd") or "")
            if wanted_cwd and str(Path(session_cwd).expanduser().resolve()) != wanted_cwd:
                continue
            wire_path = state_path.parent / "agents" / "main" / "wire.jsonl"
            profile, title, message_count = _wire_summary(wire_path)
            sessions.append(
                {
                    "id": str(state.get("id") or state_path.parent.name),
                    "cwd": session_cwd,
                    "created_at": _epoch_seconds(state.get("createdAt")),
                    "updated_at": _epoch_seconds(state.get("updatedAt")),
                    "archived": bool(state.get("archived", False)),
                    "profile": profile,
                    "title": title,
                    "message_count": message_count,
                }
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    sessions.sort(key=lambda item: item["updated_at"], reverse=True)
    return sessions[: max(1, min(limit, 1000))]


def parse_kimi_session(session_id: str) -> dict[str, Any] | None:
    if not re.fullmatch(r"session_[A-Za-z0-9_-]{1,128}", session_id):
        return None
    root = kimi_sessions_root()
    matches = list(root.glob(f"wd_*/{session_id}/state.json"))
    if len(matches) != 1:
        return None
    state_path = matches[0]
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        messages, profile = _wire_messages(state_path.parent / "agents" / "main" / "wire.jsonl")
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if not messages:
        return None
    first_user = next((m["content"] for m in messages if m["role"] == "user"), "")
    return {
        "external_id": session_id,
        "title": _title(first_user),
        "source_cwd": str(state.get("cwd") or ""),
        "created_at": _epoch_seconds(state.get("createdAt")),
        "updated_at": _epoch_seconds(state.get("updatedAt")),
        "messages": messages,
        "profile": profile,
    }


def _wire_summary(path: Path) -> tuple[str, str, int]:
    messages, profile = _wire_messages(path)
    first_user = next((m["content"] for m in messages if m["role"] == "user"), "")
    return profile, _title(first_user), len(messages)


def _wire_messages(path: Path) -> tuple[list[dict[str, Any]], str]:
    profile = ""
    messages: list[dict[str, Any]] = []
    # Kimi writes the user's prompt both as ``turn.prompt`` and as context.  The
    # prompt record is the canonical, non-system-expanded text. Assistant text
    # is emitted through ``content.part`` loop events.
    for raw in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(raw)
        except (ValueError, TypeError, json.JSONDecodeError):
            continue
        row_type = row.get("type")
        if row_type == "profile.bind":
            profile = str(row.get("profileName") or "").strip()
        elif row_type == "turn.prompt":
            text = _parts_text(row.get("input"))
            if text:
                messages.append(
                    {"role": "user", "content": text, "created_at": _epoch_seconds(row.get("time"))}
                )
        elif row_type == "context.append_loop_event":
            event = row.get("event") if isinstance(row.get("event"), dict) else {}
            part = event.get("part") if isinstance(event.get("part"), dict) else {}
            if event.get("type") == "content.part" and part.get("type") == "text":
                text = str(part.get("text") or "").strip()
                if text:
                    messages.append(
                        {
                            "role": "assistant",
                            "content": text,
                            "created_at": _epoch_seconds(row.get("time")),
                        }
                    )
    return messages, profile


def _parts_text(parts: Any) -> str:
    if not isinstance(parts, list):
        return ""
    return "\n".join(
        str(part.get("text") or "").strip()
        for part in parts
        if isinstance(part, dict) and part.get("type") == "text" and part.get("text")
    ).strip()


def _title(text: str) -> str:
    compact = " ".join(text.split())
    return compact[:80] or "Kimi conversation"


def _epoch_seconds(value: Any) -> float:
    try:
        timestamp = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return timestamp / 1000 if timestamp > 10_000_000_000 else timestamp


__all__ = ["kimi_sessions_root", "parse_kimi_session", "scan_kimi_sessions"]
