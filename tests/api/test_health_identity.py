from fastapi.testclient import TestClient

from cognivoy.api.main import app


def test_health_identity_is_public_and_stable() -> None:
    response = TestClient(app).get("/api/v1/health/identity")

    assert response.status_code == 200
    assert response.json() == {"service": "cognivoy", "api_version": "v1"}
