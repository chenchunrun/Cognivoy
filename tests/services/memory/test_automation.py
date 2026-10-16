from __future__ import annotations

from types import SimpleNamespace

import pytest

from cognivoy.services.memory import paths
from cognivoy.services.memory.automation import AutoConsolidationScheduler
from cognivoy.services.memory.settings import AutomationSettings, MemorySettings
from cognivoy.services.memory.store import DocOverview


@pytest.mark.asyncio
async def test_auto_cycle_orders_l2_before_l3(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(paths, "memory_root", lambda: tmp_path / "memory")
    monkeypatch.setattr(
        "cognivoy.services.memory.automation.load_memory_settings",
        lambda: MemorySettings(
            automation=AutomationSettings(
                enabled=True,
                min_backlog=1,
                max_retries=0,
                retry_delay_seconds=1,
            )
        ),
    )
    calls = 0

    def overview(_self):
        nonlocal calls
        calls += 1
        rows = [
            DocOverview("L2", surface, False, None, 0, 1 if calls == 1 and surface == "chat" else 0)
            for surface in paths.SURFACES
        ]
        rows.extend(
            DocOverview("L3", slot, False, None, 0, 1 if calls > 1 and slot == "profile" else 0)
            for slot in paths.L3_SLOTS
        )
        return rows

    monkeypatch.setattr("cognivoy.services.memory.automation.MemoryStore.overview", overview)
    scheduler = AutoConsolidationScheduler()
    order: list[tuple[str, str]] = []

    async def fake_target(layer, key, max_retries, delay):
        order.append((layer, key))
        return SimpleNamespace(id=f"{layer}-{key}", _task=None)

    monkeypatch.setattr(scheduler, "_run_target", fake_target)
    started = await scheduler.run_cycle()

    assert order == [("L2", "chat"), ("L3", "profile")]
    assert started == ["L2-chat", "L3-profile"]
