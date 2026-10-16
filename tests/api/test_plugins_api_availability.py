from fastapi import FastAPI
from fastapi.testclient import TestClient

from cognivoy.api.routers import plugins_api


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(plugins_api.router, prefix="/api/v1/plugins")
    return TestClient(app)


def test_plugin_catalog_exposes_live_math_animator_availability(monkeypatch):
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability.get_math_animator_readiness",
        lambda: __import__(
            "cognivoy.agents.math_animator.availability", fromlist=["MathAnimatorReadiness"]
        ).MathAnimatorReadiness(False, ("manim",), "Install math-animator dependencies."),
    )

    payload = _client().get("/api/v1/plugins/list").json()
    animator = next(item for item in payload["capabilities"] if item["name"] == "math_animator")
    assert animator["availability"]["available"] is False
    assert "math-animator" in animator["availability"]["install_hint"]


def test_unavailable_math_animator_is_rejected_before_streaming(monkeypatch):
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability.get_math_animator_readiness",
        lambda: __import__(
            "cognivoy.agents.math_animator.availability", fromlist=["MathAnimatorReadiness"]
        ).MathAnimatorReadiness(False, ("LaTeX",), "Install LaTeX."),
    )

    response = _client().post(
        "/api/v1/plugins/capabilities/math_animator/execute-stream",
        json={"content": "animate x squared"},
    )
    assert response.status_code == 503
    body = response.json()
    assert body["code"] == "capability_unavailable"
    assert "unavailable" in body["message"].lower()
    assert body["retryable"] is False
    assert body["trace_id"]


def test_tool_failure_uses_safe_error_envelope(monkeypatch):
    class BrokenTool:
        async def execute(self, **_params):
            raise RuntimeError("provider secret=never-show-this")

    class Registry:
        def get(self, name):
            return BrokenTool() if name == "broken" else None

    monkeypatch.setattr(plugins_api, "get_tool_registry", lambda: Registry())

    response = _client().post(
        "/api/v1/plugins/tools/broken/execute",
        json={"params": {}},
    )
    assert response.status_code == 500
    body = response.json()
    assert body["code"] == "tool_execution_failed"
    assert body["retryable"] is True
    assert body["trace_id"]
    assert body["details"] == {"tool": "broken"}
    assert "never-show-this" not in response.text


def test_streamed_tool_failure_uses_same_safe_error_envelope(monkeypatch):
    class BrokenTool:
        async def execute(self, **_params):
            raise RuntimeError("provider secret=never-show-this")

    class Registry:
        def get(self, name):
            return BrokenTool() if name == "broken" else None

    monkeypatch.setattr(plugins_api, "get_tool_registry", lambda: Registry())

    response = _client().post(
        "/api/v1/plugins/tools/broken/execute-stream",
        json={"params": {}},
    )
    assert response.status_code == 200
    assert "event: error" in response.text
    assert '"code": "tool_execution_failed"' in response.text
    assert '"retryable": true' in response.text
    assert "never-show-this" not in response.text


def test_execution_policy_blocks_direct_and_streamed_playground_runs(monkeypatch):
    monkeypatch.setattr(plugins_api, "_playground_execution_enabled", lambda: False)

    direct = _client().post(
        "/api/v1/plugins/tools/anything/execute",
        json={"params": {}},
    )
    assert direct.status_code == 403
    assert direct.json()["code"] == "playground_execution_disabled"
    assert direct.json()["retryable"] is False

    streamed = _client().post(
        "/api/v1/plugins/capabilities/chat/execute-stream",
        json={"content": "hello"},
    )
    assert streamed.status_code == 403
    assert streamed.json()["code"] == "playground_execution_disabled"


def test_catalog_exposes_execution_policy(monkeypatch):
    monkeypatch.setattr(plugins_api, "_playground_execution_enabled", lambda: False)
    payload = _client().get("/api/v1/plugins/list").json()
    assert payload["execution_enabled"] is False


def test_catalog_rejects_unisolated_manim_execution():
    payload = _client().get("/api/v1/plugins/list").json()
    animator = next(item for item in payload["capabilities"] if item["name"] == "math_animator")
    assert animator["availability"]["available"] is False
    assert animator["availability"]["missing_dependencies"] == ["isolated-renderer"]


def test_math_animator_source_can_be_edited_and_rerendered(monkeypatch):
    calls = []

    class FakeArtifact:
        def model_dump(self):
            return {
                "type": "video",
                "url": "/api/outputs/math/edit.mp4",
                "filename": "edit.mp4",
                "content_type": "video/mp4",
                "label": "Animation video",
            }

    class FakeResult:
        artifacts = [FakeArtifact()]
        output_mode = "video"
        source_code_path = "/private/source/scene.py"
        quality = "high"

    class FakeRenderer:
        def __init__(self, turn_id):
            calls.append(("init", turn_id))

        async def render(self, **kwargs):
            calls.append(("render", kwargs))
            return FakeResult()

    monkeypatch.setattr(plugins_api, "ManimRenderService", FakeRenderer)
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability.get_math_animator_readiness",
        lambda: __import__(
            "cognivoy.agents.math_animator.availability", fromlist=["MathAnimatorReadiness"]
        ).MathAnimatorReadiness(True, (), ""),
    )

    response = _client().post(
        "/api/v1/plugins/math-animator/rerender",
        json={
            "parent_turn_id": "turn-12345678",
            "code": "from manim import *\nclass Demo(Scene):\n    def construct(self): pass",
            "output_mode": "video",
            "quality": "high",
            "width": 1920,
            "height": 1080,
            "fps": 30,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["artifacts"][0]["url"].endswith("edit.mp4")
    assert body["parent_turn_id"] == "turn-12345678"
    assert body["render_id"].startswith("rerender-")
    assert "private" not in response.text
    assert calls[1][1]["quality"] == "high"
