from __future__ import annotations

import json
from pathlib import Path
import sqlite3

from cognivoy.services.subagent.opencode_history import (
    parse_opencode_session,
    scan_opencode_sessions,
)


def _database(path: Path) -> Path:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
            time_updated INTEGER, data TEXT
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
            time_created INTEGER, time_updated INTEGER, data TEXT
        );
        """
    )
    connection.execute(
        "INSERT INTO session VALUES (?,?,?,?,?)",
        ("ses_test", "/workspace", "Imported title", 1_700_000_000_000, 1_700_000_010_000),
    )
    connection.executemany(
        "INSERT INTO message VALUES (?,?,?,?,?)",
        [
            ("msg_u", "ses_test", 1_700_000_001_000, 0, json.dumps({"role": "user"})),
            ("msg_a", "ses_test", 1_700_000_002_000, 0, json.dumps({"role": "assistant"})),
        ],
    )
    connection.executemany(
        "INSERT INTO part VALUES (?,?,?,?,?,?)",
        [
            (
                "prt_u",
                "msg_u",
                "ses_test",
                1,
                1,
                json.dumps(
                    {
                        "type": "text",
                        "text": "question<system-reminder>internal harness</system-reminder>",
                    }
                ),
            ),
            (
                "prt_r",
                "msg_a",
                "ses_test",
                2,
                2,
                json.dumps({"type": "reasoning", "text": "private"}),
            ),
            ("prt_a", "msg_a", "ses_test", 3, 3, json.dumps({"type": "text", "text": "answer"})),
        ],
    )
    connection.commit()
    connection.close()
    return path


def test_scan_and_parse_opencode_database(tmp_path: Path) -> None:
    path = _database(tmp_path / "opencode.db")
    scanned = scan_opencode_sessions(db_path=path)
    assert scanned == [
        {
            "id": "ses_test",
            "cwd": "/workspace",
            "title": "Imported title",
            "created_at": 1_700_000_000.0,
            "updated_at": 1_700_000_010.0,
            "message_count": 2,
        }
    ]

    parsed = parse_opencode_session("ses_test", db_path=path)
    assert parsed is not None
    assert [item["content"] for item in parsed["messages"]] == ["question", "answer"]
    assert all("private" not in item["content"] for item in parsed["messages"])


def test_invalid_or_missing_session_is_rejected(tmp_path: Path) -> None:
    path = _database(tmp_path / "opencode.db")
    assert parse_opencode_session("../bad", db_path=path) is None
    assert parse_opencode_session("ses_missing", db_path=path) is None
