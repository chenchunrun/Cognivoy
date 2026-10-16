"""The public Python SDK mirrors the wire contract and raises typed errors."""

from __future__ import annotations

from typing import Any

import pytest

from cognivoy.app import (
    CapabilityNotFoundError,
    CognivoyApp,
    CognivoySDKError,
    ResourceNotFoundError,
    TurnRequest,
    TurnStateError,
)


def test_unknown_capability_uses_typed_sdk_error() -> None:
    app = CognivoyApp()

    with pytest.raises(CapabilityNotFoundError) as raised:
        app.resolve_capability("does-not-exist")

    assert isinstance(raised.value, CognivoySDKError)
    assert isinstance(raised.value, ValueError)
    assert raised.value.code == "capability_not_found"
    assert raised.value.details["capability"] == "does-not-exist"
    assert "chat" in raised.value.details["available"]


def test_turn_request_matches_the_complete_websocket_contract() -> None:
    request = TurnRequest(
        content="continue",
        question_notebook_references=[7, 9],
        book_references=[{"book_id": "book-1", "page_ids": ["page-2"]}],
        persona="Socratic",
        llm_selection={"profile_id": "primary", "model_id": "gpt-5"},
        parent_message_id=42,
        memory_references=["profile", "preferences"],
        skills=["socratic-tutor"],
    )

    payload = request.to_payload()

    assert payload["question_notebook_references"] == [7, 9]
    assert payload["book_references"] == [{"book_id": "book-1", "page_ids": ["page-2"]}]
    assert payload["persona"] == "Socratic"
    assert payload["llm_selection"] == {
        "profile_id": "primary",
        "model_id": "gpt-5",
    }
    assert payload["parent_message_id"] == 42
    assert payload["memory_references"] == ["profile", "preferences"]
    assert payload["skills"] == ["socratic-tutor"]


class _MissingSessionStore:
    async def get_session_with_messages(self, session_id: str) -> None:
        return None

    async def update_session_title(self, session_id: str, title: str) -> bool:
        return False

    async def delete_session(self, session_id: str) -> bool:
        return False


class _MissingNotebookManager:
    def get_notebook(self, notebook_id: str) -> None:
        return None

    def update_record(self, notebook_id: str, record_id: str, **kwargs: Any) -> None:
        return None

    def remove_record(self, notebook_id: str, record_id: str) -> bool:
        return False


def _facade_without_runtime() -> CognivoyApp:
    app = object.__new__(CognivoyApp)
    app.store = _MissingSessionStore()
    app.notebooks = _MissingNotebookManager()
    return app


@pytest.mark.asyncio
async def test_session_crud_raises_resource_not_found() -> None:
    app = _facade_without_runtime()

    with pytest.raises(ResourceNotFoundError) as get_error:
        await app.get_session("missing-session")
    assert get_error.value.code == "session_not_found"
    assert get_error.value.details == {"session_id": "missing-session"}

    with pytest.raises(ResourceNotFoundError):
        await app.rename_session("missing-session", "Title")
    with pytest.raises(ResourceNotFoundError):
        await app.delete_session("missing-session")


def test_notebook_crud_raises_resource_not_found() -> None:
    app = _facade_without_runtime()

    with pytest.raises(ResourceNotFoundError) as notebook_error:
        app.get_notebook("missing-notebook")
    assert notebook_error.value.code == "notebook_not_found"

    with pytest.raises(ResourceNotFoundError) as record_error:
        app.update_record("notebook-1", "missing-record", output="replacement")
    assert record_error.value.code == "record_not_found"
    assert record_error.value.details["record_id"] == "missing-record"

    with pytest.raises(ResourceNotFoundError):
        app.remove_record("notebook-1", "missing-record")


class _InactiveTurnRuntime:
    async def cancel_turn(self, turn_id: str) -> bool:
        return False

    async def submit_user_reply(self, turn_id: str, **_kwargs: Any) -> bool:
        return False


@pytest.mark.asyncio
async def test_turn_mutations_raise_typed_state_errors() -> None:
    app = object.__new__(CognivoyApp)
    app.runtime = _InactiveTurnRuntime()

    with pytest.raises(TurnStateError) as cancel_error:
        await app.cancel_turn("turn-1")
    assert cancel_error.value.code == "turn_not_active"
    assert cancel_error.value.to_dict()["details"] == {"turn_id": "turn-1"}

    with pytest.raises(TurnStateError) as reply_error:
        await app.submit_user_reply("turn-2", text="answer")
    assert reply_error.value.code == "turn_not_waiting_for_reply"
