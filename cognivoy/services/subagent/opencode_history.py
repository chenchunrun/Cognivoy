"""Read opencode chat history from its local SQLite store without mutating it."""

from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
import re
import sqlite3
from typing import Any

_SESSION_ID = re.compile(r"ses_[A-Za-z0-9_-]{1,192}")
_SYSTEM_REMINDER = re.compile(r"<system-reminder>[\s\S]*?</system-reminder>", re.IGNORECASE)


def opencode_database() -> Path:
    return Path.home() / ".local" / "share" / "opencode" / "opencode.db"


def scan_opencode_sessions(
    *, limit: int = 500, db_path: Path | None = None
) -> list[dict[str, Any]]:
    path = db_path or opencode_database()
    if not path.is_file():
        return []
    try:
        with _connect_readonly(path) as connection:
            rows = connection.execute(
                """
                SELECT s.id, s.directory, s.title, s.time_created, s.time_updated,
                       COUNT(m.id) AS message_count
                  FROM session AS s
             LEFT JOIN message AS m ON m.session_id = s.id
              GROUP BY s.id
                HAVING COUNT(m.id) > 0
              ORDER BY s.time_updated DESC
                 LIMIT ?
                """,
                (max(1, min(limit, 1000)),),
            ).fetchall()
    except (OSError, sqlite3.Error):
        return []
    return [
        {
            "id": str(row["id"]),
            "cwd": str(row["directory"] or ""),
            "title": str(row["title"] or "OpenCode conversation"),
            "created_at": _epoch_seconds(row["time_created"]),
            "updated_at": _epoch_seconds(row["time_updated"]),
            "message_count": int(row["message_count"] or 0),
        }
        for row in rows
    ]


def parse_opencode_session(
    session_id: str, *, db_path: Path | None = None
) -> dict[str, Any] | None:
    if not _SESSION_ID.fullmatch(session_id):
        return None
    path = db_path or opencode_database()
    if not path.is_file():
        return None
    try:
        with _connect_readonly(path) as connection:
            session = connection.execute(
                """
                SELECT id, directory, title, time_created, time_updated
                  FROM session WHERE id = ?
                """,
                (session_id,),
            ).fetchone()
            if session is None:
                return None
            rows = connection.execute(
                """
                SELECT m.id AS message_id, m.time_created, m.data AS message_data,
                       p.id AS part_id, p.data AS part_data
                  FROM message AS m
             LEFT JOIN part AS p ON p.message_id = m.id
                 WHERE m.session_id = ?
              ORDER BY m.time_created, m.id, p.time_created, p.id
                """,
                (session_id,),
            ).fetchall()
    except (OSError, sqlite3.Error):
        return None

    grouped: dict[str, dict[str, Any]] = {}
    texts: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        message_id = str(row["message_id"])
        if message_id not in grouped:
            try:
                message_data = json.loads(row["message_data"])
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            role = message_data.get("role")
            if role not in {"user", "assistant"}:
                continue
            grouped[message_id] = {
                "role": role,
                "created_at": _epoch_seconds(row["time_created"]),
            }
        if not row["part_data"]:
            continue
        try:
            part = json.loads(row["part_data"])
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if part.get("type") == "text":
            text = _clean_text(str(part.get("text") or ""))
            if text:
                texts[message_id].append(text)

    messages = []
    for message_id, metadata in grouped.items():
        content = "\n".join(texts.get(message_id, [])).strip()
        if content:
            messages.append({**metadata, "content": content})
    if not messages:
        return None
    return {
        "external_id": str(session["id"]),
        "title": str(session["title"] or _title(messages)),
        "source_cwd": str(session["directory"] or ""),
        "created_at": _epoch_seconds(session["time_created"]),
        "updated_at": _epoch_seconds(session["time_updated"]),
        "messages": messages,
    }


def _connect_readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _epoch_seconds(value: Any) -> float:
    try:
        timestamp = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return timestamp / 1000 if timestamp > 10_000_000_000 else timestamp


def _title(messages: list[dict[str, Any]]) -> str:
    first_user = next((str(item["content"]) for item in messages if item["role"] == "user"), "")
    return " ".join(first_user.split())[:80] or "OpenCode conversation"


def _clean_text(text: str) -> str:
    """Remove opencode-injected harness context from the human transcript."""
    return _SYSTEM_REMINDER.sub("", text).strip()


__all__ = [
    "opencode_database",
    "parse_opencode_session",
    "scan_opencode_sessions",
]
