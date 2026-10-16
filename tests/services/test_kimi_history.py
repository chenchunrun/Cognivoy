from __future__ import annotations

import json
from pathlib import Path

from cognivoy.services.subagent import kimi_history


def _write_session(root: Path) -> str:
    session_id = "session_123"
    folder = root / "wd_project_hash" / session_id
    wire = folder / "agents" / "main" / "wire.jsonl"
    wire.parent.mkdir(parents=True)
    (folder / "state.json").write_text(
        json.dumps(
            {
                "id": session_id,
                "cwd": "/tmp/project",
                "createdAt": 1_700_000_000_000,
                "updatedAt": 1_700_000_001_000,
                "archived": False,
            }
        ),
        encoding="utf-8",
    )
    rows = [
        {"type": "profile.bind", "profileName": "researcher", "time": 1},
        {
            "type": "turn.prompt",
            "input": [{"type": "text", "text": "Explain RAG"}],
            "time": 1_700_000_000_100,
        },
        {
            "type": "context.append_message",
            "message": {"role": "user", "content": [{"type": "text", "text": "duplicate"}]},
            "time": 1_700_000_000_100,
        },
        {
            "type": "context.append_loop_event",
            "event": {"type": "content.part", "part": {"type": "think", "think": "secret"}},
            "time": 1_700_000_000_200,
        },
        {
            "type": "context.append_loop_event",
            "event": {"type": "content.part", "part": {"type": "text", "text": "RAG answer"}},
            "time": 1_700_000_000_300,
        },
    ]
    wire.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
    return session_id


def test_scan_and_parse_kimi_history(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "sessions"
    session_id = _write_session(root)
    monkeypatch.setattr(kimi_history, "kimi_sessions_root", lambda: root)
    scanned = kimi_history.scan_kimi_sessions()
    assert scanned[0]["profile"] == "researcher"
    assert scanned[0]["title"] == "Explain RAG"
    assert scanned[0]["message_count"] == 2
    parsed = kimi_history.parse_kimi_session(session_id)
    assert parsed is not None
    assert [(m["role"], m["content"]) for m in parsed["messages"]] == [
        ("user", "Explain RAG"),
        ("assistant", "RAG answer"),
    ]
    assert "secret" not in json.dumps(parsed)


def test_parse_rejects_path_traversal(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(kimi_history, "kimi_sessions_root", lambda: tmp_path)
    assert kimi_history.parse_kimi_session("../state") is None
    assert kimi_history.parse_kimi_session("session_*") is None
