from fastapi import FastAPI
from fastapi.testclient import TestClient

from cognivoy.api.routers.capabilities_settings import router
from cognivoy.services.config import capabilities_settings as settings


def test_adaptive_settings_http_round_trip_isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "_agents_yaml_path", lambda: tmp_path / "agents.yaml")
    monkeypatch.setattr(settings.ConfigManager, "load_config", lambda self: {})
    app = FastAPI()
    app.include_router(router, prefix="/api/v1/capabilities")
    with TestClient(app) as client:
        initial = client.get("/api/v1/capabilities/settings")
        assert initial.status_code == 200
        assert initial.json()["chat"]["max_extra_rounds"] == 8
        result = client.put("/api/v1/capabilities/settings", json={"chat": {"max_extra_rounds": 0}})
        assert result.status_code == 200
        assert result.json()["chat"]["max_extra_rounds"] == 0
        assert client.get("/api/v1/capabilities/settings").json()["chat"]["max_rounds"] == 8
        assert "max_extra_rounds: 0" in (tmp_path / "agents.yaml").read_text()
