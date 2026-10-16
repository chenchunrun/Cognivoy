from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from cognivoy.api.routers import sessions as sessions_router


class _Store:
    def __init__(self) -> None:
        self.items = [
            {
                "id": "s3",
                "session_id": "s3",
                "title": "Algebra review",
                "last_message": "Factor a quadratic",
                "updated_at": 300.0,
                "preferences": {"capability": "deep_question"},
            },
            {
                "id": "s2",
                "session_id": "s2",
                "title": "RAG architecture",
                "last_message": "Research report",
                "updated_at": 200.0,
                "preferences": {"capability": "deep_research"},
            },
            {
                "id": "s1",
                "session_id": "s1",
                "title": "Geometry",
                "last_message": "Algebra appears in the proof",
                "updated_at": 100.0,
                "preferences": {"capability": "chat"},
            },
        ]

    async def list_sessions(self, limit: int = 50, offset: int = 0):
        return self.items[offset : offset + limit]

    async def count_sessions(self) -> int:
        return len(self.items)


def _client(monkeypatch) -> TestClient:
    store = _Store()
    monkeypatch.setattr(sessions_router, "get_session_store", lambda: store)
    app = FastAPI()
    app.include_router(sessions_router.router, prefix="/api/v1/sessions")
    return TestClient(app)


def test_session_search_matches_title_and_last_message(monkeypatch) -> None:
    response = _client(monkeypatch).get("/api/v1/sessions?q=algebra")
    assert response.status_code == 200
    assert [item["session_id"] for item in response.json()["sessions"]] == ["s3", "s1"]


def test_session_capability_and_time_filters_apply_before_pagination(monkeypatch) -> None:
    client = _client(monkeypatch)
    response = client.get(
        "/api/v1/sessions?capability=deep_research&updated_from=150&updated_to=250&limit=1"
    )
    assert response.status_code == 200
    assert [item["session_id"] for item in response.json()["sessions"]] == ["s2"]

    paged = client.get("/api/v1/sessions?q=a&limit=1&offset=1")
    assert paged.status_code == 200
    assert paged.json()["sessions"][0]["session_id"] == "s2"


def test_session_filter_rejects_reversed_time_range(monkeypatch) -> None:
    response = _client(monkeypatch).get("/api/v1/sessions?updated_from=300&updated_to=100")
    assert response.status_code == 422


def test_session_stats_return_authoritative_total_and_latest_activity(monkeypatch) -> None:
    response = _client(monkeypatch).get("/api/v1/sessions/stats")
    assert response.status_code == 200
    assert response.json() == {"total": 3, "updated_at": 300.0}
