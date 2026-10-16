"""Regression checks for exception information crossing HTTP/SSE boundaries."""

import json
import logging
from types import SimpleNamespace

import pytest

SECRET = "token=regression-secret /private/server/config.json"


def fail(*args, **kwargs):
    raise RuntimeError(SECRET)


@pytest.mark.asyncio
async def test_health_failure_does_not_return_traceback(monkeypatch):
    from cognivoy.api.routers import knowledge

    monkeypatch.setattr(knowledge, "get_kb_manager", fail)
    response = await knowledge.health_check()
    assert response["status"] == "error"
    assert "traceback" not in response
    assert SECRET not in json.dumps(response)


@pytest.mark.asyncio
async def test_system_status_hides_configuration_exception(monkeypatch):
    from cognivoy.api.routers import system

    for name in ("get_llm_config", "get_embedding_config", "resolve_search_runtime_config"):
        monkeypatch.setattr(system, name, fail)
    monkeypatch.setattr(system, "get_current_user", lambda: SimpleNamespace(is_admin=False))
    response = await system.get_system_status()
    assert all(response[name]["status"] == "error" for name in ("llm", "embeddings", "search"))
    assert SECRET not in json.dumps(response)


@pytest.mark.asyncio
async def test_notebook_stream_hides_exception(monkeypatch):
    from cognivoy.api.routers import notebook

    monkeypatch.setattr(notebook, "NotebookSummarizeAgent", fail)
    request = notebook.AddRecordRequest(
        notebook_ids=[], record_type="chat", title="test", user_query="test", output="test"
    )
    frames = [frame async for frame in notebook._stream_add_record_with_summary(request)]
    assert '"type": "error"' in "".join(frames)
    assert SECRET not in "".join(frames)


@pytest.mark.asyncio
async def test_cowriter_stream_hides_exception(monkeypatch):
    from cognivoy.api.routers import co_writer

    monkeypatch.setattr(co_writer, "_current_language", lambda: "en")
    monkeypatch.setattr(co_writer, "_run_react_edit", fail)
    frames = [frame async for frame in co_writer._stream_react_edit(SimpleNamespace())]
    assert "event: error" in "".join(frames)
    assert SECRET not in "".join(frames)


@pytest.mark.asyncio
async def test_partner_stream_hides_exception(monkeypatch):
    from cognivoy.api.routers import partners

    monkeypatch.setattr(partners, "get_partner_manager", lambda: SimpleNamespace(send_message=fail))
    monkeypatch.setattr(partners, "_materialize_partner_attachments", lambda *args: [])
    monkeypatch.setattr(partners, "_resolve_http_session", lambda *args: ("session", "chat"))
    frames = [
        frame
        async for frame in partners._partner_chat_stream(
            "partner", partners.ChatMessageRequest(content="hello")
        )
    ]
    assert "event: error" in "".join(frames)
    assert SECRET not in "".join(frames)


@pytest.mark.parametrize("kind", ["parser", "model"])
def test_background_job_launch_and_cancel_hide_exceptions(monkeypatch, kind):
    from cognivoy.services.parsing.engines import _install
    from cognivoy.services.parsing.engines.mineru import models

    monkeypatch.setattr(_install.subprocess, "Popen", fail)
    if kind == "parser":
        manager = _install.BackgroundJobManager()
        response = manager.start_install(engine="docling", specs=["docling"])
    else:
        manager = models.ModelDownloadManager()
        response = manager.start(
            downloader="mineru-models-download", model_type="pipeline", source="huggingface"
        )
    assert response["ok"] is False
    assert SECRET not in json.dumps([response, manager.status()])
    manager._state = "running"
    manager._process = SimpleNamespace(poll=lambda: None, terminate=fail)
    response = manager.cancel()
    assert response["ok"] is False
    assert SECRET not in json.dumps(response)


@pytest.mark.asyncio
async def test_memory_run_failure_is_safe_in_history_and_events(monkeypatch, tmp_path):
    from cognivoy.services.memory.consolidator.runs import RunManager

    monkeypatch.setattr("cognivoy.services.memory.paths.memory_root", lambda: tmp_path)
    manager = RunManager()
    run = await manager.start(layer="L2", key="chat", mode="update", runner=fail)
    await run._task
    assert run.status == "error"
    assert SECRET not in json.dumps(run.to_dict())
    assert SECRET not in json.dumps([event.payload for event in run.events])


@pytest.mark.asyncio
async def test_playground_stream_keeps_progress_but_not_diagnostics(monkeypatch, capsys):
    from cognivoy.api.routers import plugins_api
    from cognivoy.runtime import orchestrator

    class FakeOrchestrator:
        def list_capabilities(self):
            return ["chat"]

        async def handle(self, context):
            print(SECRET)
            logging.getLogger("cognivoy.test").error("Traceback: %s", SECRET)
            logging.getLogger("cognivoy.test").info("Preparing result")
            yield SimpleNamespace(
                type=SimpleNamespace(value="status"),
                to_dict=lambda: {"type": "status", "content": "Preparing result"},
            )

    monkeypatch.setattr(orchestrator, "ChatOrchestrator", FakeOrchestrator)
    monkeypatch.setattr(logging.getLogger("cognivoy.test"), "level", logging.INFO)
    response = "".join(
        [
            frame
            async for frame in plugins_api._execute_capability_stream(
                "chat", plugins_api.CapabilityExecuteRequest(content="hello")
            )
        ]
    )
    assert "Preparing result" in response
    assert SECRET not in response
    assert SECRET in capsys.readouterr().out
