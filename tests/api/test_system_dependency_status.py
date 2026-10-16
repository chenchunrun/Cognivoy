from __future__ import annotations

import asyncio
from types import SimpleNamespace


def test_dependency_status_aggregates_services_without_secrets(monkeypatch):
    from cognivoy.api.routers import system as system_router

    monkeypatch.setattr(
        system_router,
        "_model_service_dependencies",
        lambda: {
            "tts": {"status": "configured", "profile": "voice-main"},
            "stt": {"status": "not_configured"},
            "imagegen": {"status": "configured", "profile": "image-main"},
            "videogen": {"status": "not_configured"},
        },
    )
    monkeypatch.setattr(
        system_router,
        "_parser_dependency",
        lambda: {"status": "configured", "engine": "text"},
    )
    monkeypatch.setattr(
        system_router,
        "_manim_dependency",
        lambda: {"status": "unavailable", "missing_dependencies": ["manim"]},
    )

    async def fake_agents():
        return {
            "status": "configured",
            "available": 2,
            "total": 6,
            "backends": ["codex", "kimi"],
        }

    monkeypatch.setattr(system_router, "_agent_dependency", fake_agents)

    result = asyncio.run(system_router.get_dependency_status())

    assert result["dependencies"]["parser"]["engine"] == "text"
    assert result["dependencies"]["manim"]["status"] == "unavailable"
    assert result["dependencies"]["agents"]["available"] == 2
    assert result["dependencies"]["media"]["tts"]["status"] == "configured"
    assert "api_key" not in repr(result)


def test_slo_status_and_business_event_contract(monkeypatch):
    from cognivoy.api.routers import system as system_router

    fake = SimpleNamespace(
        snapshot=lambda **kwargs: {
            "window_seconds": kwargs["window_seconds"],
            "requests": 20,
            "availability_percent": 99.5,
            "latency_ms": {"p50": 40.0, "p95": 120.0},
            "alerts": [],
            "business_metrics": {},
            "route_groups": [],
        },
        record_business_event=lambda name, amount=1: (name, amount),
    )
    monkeypatch.setattr(system_router, "get_slo_service", lambda: fake)

    result = asyncio.run(system_router.get_slo_status(window_seconds=3600))
    recorded = asyncio.run(
        system_router.record_slo_event(
            system_router.SloEventRequest(name="reference_clicked", amount=2)
        )
    )

    assert result["window_seconds"] == 3600
    assert recorded == {"recorded": True, "name": "reference_clicked", "amount": 2}
