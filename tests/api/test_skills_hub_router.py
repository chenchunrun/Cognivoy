"""API tests for the in-app EduHub skill browser endpoints.

``GET /api/v1/skills/hub/catalog`` and ``/hub/detail`` proxy a hub's public
catalog so the web panel can render it in Cognivoy's own UI (no iframe, no
login). The hub provider is mocked over an ``httpx`` transport.
"""

from __future__ import annotations

import importlib

import httpx
import pytest

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except Exception:  # pragma: no cover - optional dependency in lightweight envs
    FastAPI = None
    TestClient = None

pytestmark = pytest.mark.skipif(
    FastAPI is None or TestClient is None, reason="fastapi not installed"
)

from cognivoy.services.skill import hub as hub_module
from cognivoy.services.skill.hub import ClawHubProvider


def _mock_provider() -> ClawHubProvider:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v1/skills":
            return httpx.Response(
                200,
                json={
                    "skills": [
                        {
                            "slug": "socratic-tutor",
                            "displayName": "Socratic Tutor",
                            "summary": "Teach by asking.",
                            "version": "1.0.0",
                            "stats": {"downloads": 8, "stars": 2},
                            "owner": {
                                "displayName": "Cognivoy",
                                "htmlUrl": "https://deeptutor.info",
                            },
                        }
                    ]
                },
            )
        if path == "/api/v1/skills/socratic-tutor":
            return httpx.Response(
                200,
                json={
                    "skill": {
                        "slug": "socratic-tutor",
                        "displayName": "Socratic Tutor",
                        "summary": "Teach.",
                        "description": "---\nname: socratic-tutor\n---\n\n# Body\n",
                        "tags": ["tutor"],
                        "stats": {"downloads": 8, "stars": 2},
                    },
                    "owner": {"displayName": "Cognivoy", "htmlUrl": "https://deeptutor.info"},
                    "distTags": {"latest": "1.0.0"},
                },
            )
        return httpx.Response(404, text="nope")

    return ClawHubProvider(
        "eduhub",
        base_url="https://eduhub.deeptutor.info/api/v1",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def _build_app() -> FastAPI:
    router = importlib.import_module("cognivoy.api.routers.skills").router
    app = FastAPI()
    app.include_router(router, prefix="/api/v1/skills")
    return app


def test_hub_catalog_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hub_module, "get_hub_provider", lambda name: _mock_provider())
    client = TestClient(_build_app())
    resp = client.get("/api/v1/skills/hub/catalog")
    assert resp.status_code == 200
    data = resp.json()
    assert data["hub"] == "eduhub"
    assert data["web_url"] == "https://eduhub.deeptutor.info"
    row = data["skills"][0]
    assert row["slug"] == "socratic-tutor"
    assert row["downloads"] == 8 and row["stars"] == 2
    assert row["owner"] == "Cognivoy"


def test_hub_detail_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hub_module, "get_hub_provider", lambda name: _mock_provider())
    client = TestClient(_build_app())
    resp = client.get("/api/v1/skills/hub/detail", params={"slug": "socratic-tutor"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == "1.0.0"
    assert "# Body" in data["content"]
    assert data["web_url"] == "https://eduhub.deeptutor.info/skills/socratic-tutor"


def test_skill_install_requires_preview_confirmation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = TestClient(_build_app())
    response = client.post(
        "/api/v1/skills/install",
        json={"ref": "eduhub:socratic-tutor@1.0.0"},
    )
    assert response.status_code == 428
    assert response.json()["detail"]["code"] == "skill.preview_required"


def test_reviewed_skill_install_runs_as_pollable_cancellable_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cognivoy.api.routers import skills
    from cognivoy.services.skill.install_jobs import SkillInstallJob

    queued = SkillInstallJob(
        task_id="task-1",
        ref="eduhub:socratic-tutor@1.0.0",
        status="queued",
        created_at="now",
        updated_at="now",
    )

    class FakeRegistry:
        def start(self, payload):
            assert payload["confirmed"] is True
            assert payload["confirmation_digest"] == "digest"
            return queued

        def get(self, task_id):
            assert task_id == "task-1"
            return queued

        def cancel(self, task_id):
            assert task_id == "task-1"
            return SkillInstallJob(**{**queued.to_dict(), "status": "cancelling"})

    monkeypatch.setattr(skills, "_install_job_registry", lambda: FakeRegistry())
    client = TestClient(_build_app())
    started = client.post(
        "/api/v1/skills/install-jobs",
        json={
            "ref": "eduhub:socratic-tutor@1.0.0",
            "confirmed": True,
            "confirmation_digest": "digest",
        },
    )
    assert started.status_code == 202
    assert started.json()["status"] == "queued"
    assert client.get("/api/v1/skills/install-jobs/task-1").status_code == 200
    assert client.delete("/api/v1/skills/install-jobs/task-1").json()["status"] == "cancelling"
