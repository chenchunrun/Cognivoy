"""Tests for the main notebook router (/api/v1/notebook).

Verifies that records can only be saved using real notebook UUIDs
(from /api/v1/notebook/list), not question-notebook category integer IDs.
"""

from __future__ import annotations

import asyncio
import importlib
import json

import pytest

pytest.importorskip("fastapi")

FastAPI = pytest.importorskip("fastapi").FastAPI
TestClient = pytest.importorskip("fastapi.testclient").TestClient

notebook_router = importlib.import_module("cognivoy.api.routers.notebook").router

from cognivoy.services.notebook.service import NotebookManager


def _build_app(manager: NotebookManager) -> FastAPI:
    app = FastAPI()
    app.include_router(notebook_router, prefix="/api/v1/notebook")
    return app


@pytest.fixture
def manager(tmp_path, monkeypatch) -> NotebookManager:
    instance = NotebookManager(base_dir=str(tmp_path / "notebooks"))
    monkeypatch.setattr(
        "cognivoy.api.routers.notebook.notebook_manager",
        instance,
    )
    monkeypatch.setattr(
        "cognivoy.api.routers.notebook._record_project_notebook_activity",
        lambda _request, _result: None,
    )
    return instance


def test_list_notebooks_empty(manager: NotebookManager) -> None:
    with TestClient(_build_app(manager)) as client:
        resp = client.get("/api/v1/notebook/list")
        assert resp.status_code == 200
        data = resp.json()
        assert data["notebooks"] == []
        assert data["total"] == 0


def test_create_and_list_notebook(manager: NotebookManager) -> None:
    with TestClient(_build_app(manager)) as client:
        create_resp = client.post(
            "/api/v1/notebook/create",
            json={"name": "Study Notes", "description": "Physics"},
        )
        assert create_resp.status_code == 200
        nb = create_resp.json()["notebook"]
        assert nb["name"] == "Study Notes"
        nb_id = nb["id"]

        listing = client.get("/api/v1/notebook/list").json()
        assert listing["total"] == 1
        assert listing["notebooks"][0]["id"] == nb_id


def test_add_record_with_valid_notebook_id(manager: NotebookManager) -> None:
    """Records saved with a real notebook UUID must appear in that notebook."""
    nb = manager.create_notebook(name="My Notes")
    nb_id = nb["id"]

    with TestClient(_build_app(manager)) as client:
        resp = client.post(
            "/api/v1/notebook/add_record",
            json={
                "notebook_ids": [nb_id],
                "record_type": "chat",
                "title": "Draft on Fourier",
                "summary": "Existing summary",
                "user_query": "Explain Fourier",
                "output": "Fourier transform is...",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert nb_id in body["added_to_notebooks"]

        detail = client.get(f"/api/v1/notebook/{nb_id}").json()
        assert len(detail["records"]) == 1
        assert detail["records"][0]["title"] == "Draft on Fourier"


def test_add_record_projects_linked_notebook_activity(
    manager: NotebookManager,
    monkeypatch,
) -> None:
    notebook = manager.create_notebook(name="Project notes")
    calls: list[tuple[object, dict]] = []
    monkeypatch.setattr(
        "cognivoy.api.routers.notebook._record_project_notebook_activity",
        lambda request, result: calls.append((request, result)),
    )

    with TestClient(_build_app(manager)) as client:
        response = client.post(
            "/api/v1/notebook/add_record",
            json={
                "notebook_ids": [notebook["id"]],
                "record_type": "chat",
                "title": "Reusable evidence",
                "summary": "summary",
                "user_query": "question",
                "output": "answer",
                "idempotency_key": "project-note-1",
            },
        )

    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0][0].notebook_ids == [notebook["id"]]
    assert calls[0][1]["record"]["id"] == response.json()["record"]["id"]


def test_notebook_records_are_server_paginated_and_searchable(manager: NotebookManager) -> None:
    notebook = manager.create_notebook(name="Large notes")
    for index in range(75):
        manager.add_record(
            notebook_ids=[notebook["id"]],
            record_type="chat",
            title=f"Record {index:03d}",
            summary="",
            user_query=f"Query {index}",
            output="needle" if index in {51, 61, 71} else "ordinary",
        )

    with TestClient(_build_app(manager)) as client:
        page = client.get(
            f"/api/v1/notebook/{notebook['id']}/records",
            params={"q": "needle", "limit": 2, "offset": 1},
        )

    assert page.status_code == 200
    payload = page.json()
    assert payload["total"] == 3
    assert payload["limit"] == 2
    assert payload["offset"] == 1
    assert [item["title"] for item in payload["items"]] == ["Record 061", "Record 051"]


def test_add_record_with_numeric_category_id_saves_nothing(manager: NotebookManager) -> None:
    """Using a question-notebook integer category ID must NOT match any notebook.

    This is the root cause of issue #301: the old SaveToNotebookModal sent
    numeric category IDs from /api/v1/question-notebook/categories instead of
    UUID notebook IDs from /api/v1/notebook/list.
    """
    manager.create_notebook(name="My Notes")

    with TestClient(_build_app(manager)) as client:
        resp = client.post(
            "/api/v1/notebook/add_record",
            json={
                "notebook_ids": ["1", "42"],
                "record_type": "chat",
                "title": "Lost draft",
                "summary": "This should not be saved anywhere",
                "user_query": "...",
                "output": "...",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["added_to_notebooks"] == []


def test_stream_add_record_with_summary_strips_thinking_tags(
    manager: NotebookManager,
    monkeypatch,
) -> None:
    class FakeSummarizeAgent:
        def __init__(self, language: str = "en") -> None:
            self.language = language

        async def stream_summary(self, **_kwargs):
            yield "<thi"
            yield "nk>private reasoning</think>\n"
            yield "Final reusable summary."

    monkeypatch.setattr(
        "cognivoy.api.routers.notebook.NotebookSummarizeAgent",
        FakeSummarizeAgent,
    )
    nb = manager.create_notebook(name="My Notes")

    async def collect_events() -> list[dict]:
        request = importlib.import_module("cognivoy.api.routers.notebook").AddRecordRequest(
            notebook_ids=[nb["id"]],
            record_type="chat",
            title="Streaming save",
            user_query="Explain Fourier",
            output="Fourier transform is...",
        )
        events: list[dict] = []
        async for raw in importlib.import_module(
            "cognivoy.api.routers.notebook"
        )._stream_add_record_with_summary(request):
            assert "<think" not in raw.lower()
            assert "private reasoning" not in raw
            events.append(json.loads(raw.removeprefix("data: ").strip()))
        return events

    events = asyncio.run(collect_events())
    assert events[-1]["type"] == "result"
    assert events[-1]["summary"] == "Final reusable summary."

    detail = manager.get_notebook(nb["id"])
    assert detail is not None
    assert detail["records"][0]["summary"] == "Final reusable summary."


def test_record_api_is_idempotent_and_rejects_stale_revision(
    manager: NotebookManager,
) -> None:
    nb = manager.create_notebook(name="Versioned notes")
    payload = {
        "notebook_ids": [nb["id"]],
        "record_type": "chat",
        "title": "Stable save",
        "summary": "summary",
        "user_query": "question",
        "output": "answer",
        "tags": ["math"],
        "references": [{"type": "session", "id": "turn-1"}],
        "idempotency_key": "save:turn-1",
    }
    with TestClient(_build_app(manager)) as client:
        first = client.post("/api/v1/notebook/add_record", json=payload)
        second = client.post("/api/v1/notebook/add_record", json=payload)
        assert first.status_code == second.status_code == 200
        assert first.json()["created"] is True
        assert second.json()["created"] is False
        record = first.json()["record"]

        updated = client.put(
            f"/api/v1/notebook/{nb['id']}/records/{record['id']}",
            json={"output": "new answer", "expected_revision": 1},
        )
        assert updated.status_code == 200
        assert updated.json()["record"]["revision"] == 2
        stale = client.put(
            f"/api/v1/notebook/{nb['id']}/records/{record['id']}",
            json={"output": "stale answer", "expected_revision": 1},
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "revision_conflict"
        assert stale.json()["detail"]["current"]["output"] == "new answer"


def test_markdown_import_endpoint_supports_append_and_replace(
    manager: NotebookManager,
) -> None:
    nb = manager.create_notebook(name="Imports")
    manager.add_record(
        notebook_ids=[nb["id"]],
        record_type="chat",
        title="Existing",
        user_query="",
        output="existing",
    )
    with TestClient(_build_app(manager)) as client:
        appended = client.post(
            f"/api/v1/notebook/{nb['id']}/import-markdown",
            json={
                "content": "# Notes\n\n## One\nFirst section\n\n## Two\nSecond section",
                "mode": "append",
                "idempotency_key": "import:notes:v1",
            },
        )
        assert appended.status_code == 200
        assert appended.json()["imported_count"] == 2

        replaced = client.post(
            f"/api/v1/notebook/{nb['id']}/import-markdown",
            json={
                "content": "# Replacement\n\nNew body",
                "mode": "replace",
                "idempotency_key": "import:replacement:v1",
            },
        )
        assert replaced.status_code == 200
        assert replaced.json()["replaced_count"] == 3
        detail = client.get(f"/api/v1/notebook/{nb['id']}").json()
        assert [record["title"] for record in detail["records"]] == ["Replacement"]
