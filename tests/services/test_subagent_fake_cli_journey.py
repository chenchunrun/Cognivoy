"""Real subprocess journey for an imported local CLI agent.

The fake executable speaks Claude Code's public stream-json contract.  These
tests intentionally do not stub process creation: timeout and cancellation
must tear down the actual child, not only stop rendering its response.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys

import pytest

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except Exception:  # pragma: no cover - optional in lightweight installs
    FastAPI = None
    TestClient = None

from cognivoy.services.subagent.claude_code import ClaudeCodeBackend
from cognivoy.services.subagent.config import BackendConfig
from cognivoy.services.subagent.runtime import (
    SubagentResourceGovernor,
    SubagentResourcePolicy,
    SubagentTimeoutError,
    consult_with_timeout,
)


def _make_fake_claude(tmp_path: Path) -> Path:
    executable = tmp_path / "claude"
    executable.write_text(
        f"""#!{sys.executable}
import json
import os
import sys
import time

if "--version" in sys.argv:
    print("fake-claude 1.0")
    raise SystemExit(0)

prompt = sys.argv[sys.argv.index("-p") + 1]
pid_file = os.environ.get("FAKE_CLAUDE_PID_FILE")
if pid_file:
    with open(pid_file, "w", encoding="utf-8") as handle:
        handle.write(str(os.getpid()))

if "hang" in prompt:
    time.sleep(60)

session_id = "fake-session-1"
print(json.dumps({{"type": "system", "subtype": "init", "model": "fake", "session_id": session_id}}), flush=True)
print(json.dumps({{"type": "assistant", "session_id": session_id, "message": {{"id": "m1", "content": [{{"type": "text", "text": "fake answer"}}]}}}}), flush=True)
print(json.dumps({{"type": "result", "subtype": "success", "session_id": session_id, "result": "fake answer"}}), flush=True)
""",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    return executable


def _is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def _wait_for_pid(path: Path) -> int:
    for _ in range(100):
        if path.exists() and path.read_text(encoding="utf-8").strip():
            return int(path.read_text(encoding="utf-8"))
        await asyncio.sleep(0.01)
    raise AssertionError("fake CLI did not write its pid")


async def _wait_until_stopped(pid: int) -> None:
    for _ in range(100):
        if not _is_process_alive(pid):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"fake CLI process {pid} was left running")


@pytest.fixture
def fake_backend(tmp_path, monkeypatch) -> ClaudeCodeBackend:
    backend = ClaudeCodeBackend()
    backend.cli_command = str(_make_fake_claude(tmp_path))
    monkeypatch.setattr(
        "cognivoy.services.subagent.runtime.require_outbound_network", lambda _feature: None
    )
    monkeypatch.setattr(
        "cognivoy.services.subagent.runtime.load_resource_policy",
        lambda: SubagentResourcePolicy(2, 5, 1, 10_000),
    )
    monkeypatch.setattr(
        "cognivoy.services.subagent.runtime._resource_governor", SubagentResourceGovernor()
    )
    return backend


@pytest.mark.asyncio
async def test_fake_cli_detect_chat_timeout_and_cancel(
    fake_backend: ClaudeCodeBackend, tmp_path: Path, monkeypatch
) -> None:
    detected = await fake_backend.detect()
    assert detected.available is True
    assert detected.version == "fake-claude 1.0"

    events = []

    async def capture(event):
        events.append(event)

    result = await consult_with_timeout(
        fake_backend,
        "answer normally",
        config=BackendConfig(runtime_timeout_seconds=30),
        on_event=capture,
        cwd=str(tmp_path),
    )
    assert result.success is True
    assert result.final_text == "fake answer"
    assert result.session_id == "fake-session-1"
    assert any(event.kind == "text" and event.text == "fake answer" for event in events)

    timeout_pid_file = tmp_path / "timeout.pid"
    monkeypatch.setenv("FAKE_CLAUDE_PID_FILE", str(timeout_pid_file))
    with pytest.raises(SubagentTimeoutError):
        await consult_with_timeout(
            fake_backend,
            "hang for timeout",
            config=BackendConfig(runtime_timeout_seconds=0.05),  # type: ignore[arg-type]
            on_event=lambda _event: None,
            cwd=str(tmp_path),
        )
    await _wait_until_stopped(await _wait_for_pid(timeout_pid_file))

    cancel_pid_file = tmp_path / "cancel.pid"
    monkeypatch.setenv("FAKE_CLAUDE_PID_FILE", str(cancel_pid_file))
    task = asyncio.create_task(
        consult_with_timeout(
            fake_backend,
            "hang until cancelled",
            config=BackendConfig(runtime_timeout_seconds=30),
            on_event=lambda _event: None,
            cwd=str(tmp_path),
        )
    )
    cancel_pid = await _wait_for_pid(cancel_pid_file)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await _wait_until_stopped(cancel_pid)


class _FakeKBManager:
    def __init__(self) -> None:
        self.entries: dict[str, dict] = {}

    def list_knowledge_bases(self):
        return list(self.entries)

    def get_metadata(self, name=None):
        return dict(self.entries.get(name or "", {}))

    def register_subagent_connection(self, name, agent_kind, **kwargs):
        entry = {
            "type": "subagent",
            "agent_kind": agent_kind,
            "cwd": kwargs.get("cwd", ""),
            "partner_id": kwargs.get("partner_id", ""),
            "agent_profile": kwargs.get("agent_profile", ""),
        }
        self.entries[name] = entry
        return entry

    def delete_knowledge_base(self, name, confirm=False):
        self.entries.pop(name, None)
        return True


@pytest.mark.skipif(FastAPI is None or TestClient is None, reason="fastapi not installed")
def test_fake_cli_api_detect_connect_chat_disconnect(
    fake_backend: ClaudeCodeBackend, tmp_path: Path, monkeypatch
) -> None:
    import cognivoy.api.routers.subagents as router_module
    import cognivoy.services.subagent.registry as registry
    import cognivoy.services.subagent.sessions as sessions

    manager = _FakeKBManager()
    monkeypatch.setattr(router_module, "current_kb_manager", lambda: manager)
    monkeypatch.setattr(router_module, "list_backend_kinds", lambda: ["claude_code"])
    monkeypatch.setattr(router_module, "assert_path_allowed", lambda value: Path(value))
    monkeypatch.setattr(registry, "_BACKENDS", {"claude_code": fake_backend})
    monkeypatch.setattr(sessions, "_path", lambda: tmp_path / "sessions.json")
    monkeypatch.setattr(
        "cognivoy.services.subagent.config._settings_path", lambda: tmp_path / "settings.json"
    )

    async def detect_one():
        return [await fake_backend.detect()]

    monkeypatch.setattr(router_module, "detect_all", detect_one)
    app = FastAPI()
    app.include_router(router_module.router, prefix="/api/v1/subagents")
    app.dependency_overrides[router_module.require_admin] = lambda: None

    with TestClient(app) as client:
        detection = client.get("/api/v1/subagents/detect")
        assert detection.status_code == 200
        assert detection.json()["backends"][0]["version"] == "fake-claude 1.0"

        connected = client.post(
            "/api/v1/subagents/connections",
            json={"name": "Fake Claude", "agent_kind": "claude_code", "cwd": str(tmp_path)},
        )
        assert connected.status_code == 200

        response = client.post(
            "/api/v1/subagents/connections/Fake%20Claude/message",
            json={"chat_session_id": "chat-1", "message": "answer normally"},
        )
        lines = [json.loads(line) for line in response.text.splitlines() if line.strip()]
        assert any(
            line.get("channel") == "text" and line.get("text") == "fake answer" for line in lines
        )
        assert lines[-1] == {
            "done": True,
            "success": True,
            "session_id": "fake-session-1",
        }

        disconnected = client.delete("/api/v1/subagents/connections/Fake%20Claude")
        assert disconnected.status_code == 200
        assert client.get("/api/v1/subagents/connections").json()["connections"] == []
