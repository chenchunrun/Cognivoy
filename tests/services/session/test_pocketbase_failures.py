from __future__ import annotations

import pytest

from cognivoy.services.session.errors import SessionStorageUnavailableError
from cognivoy.services.session.pocketbase_store import PocketBaseSessionStore


class _BrokenPocketBase:
    def collection(self, _name: str):
        raise ConnectionError("offline")


@pytest.mark.asyncio
async def test_list_sessions_does_not_turn_backend_failure_into_empty_list(monkeypatch) -> None:
    monkeypatch.setattr(
        "cognivoy.services.session.pocketbase_store._pb", lambda: _BrokenPocketBase()
    )

    with pytest.raises(SessionStorageUnavailableError, match="list_sessions"):
        await PocketBaseSessionStore().list_sessions()


@pytest.mark.asyncio
async def test_count_sessions_does_not_turn_backend_failure_into_zero(monkeypatch) -> None:
    monkeypatch.setattr(
        "cognivoy.services.session.pocketbase_store._pb", lambda: _BrokenPocketBase()
    )

    with pytest.raises(SessionStorageUnavailableError, match="count_sessions"):
        await PocketBaseSessionStore().count_sessions()


@pytest.mark.asyncio
async def test_add_message_does_not_report_false_success(monkeypatch) -> None:
    monkeypatch.setattr(
        "cognivoy.services.session.pocketbase_store._pb", lambda: _BrokenPocketBase()
    )

    with pytest.raises(SessionStorageUnavailableError, match="add_message"):
        await PocketBaseSessionStore().add_message("session-1", "user", "hello")
