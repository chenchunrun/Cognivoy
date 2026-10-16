from __future__ import annotations

import asyncio

import pytest

from cognivoy.api.utils.knowledge_task_registry import KnowledgeTaskRegistry


@pytest.mark.asyncio
async def test_registry_cancels_and_removes_live_task() -> None:
    registry = KnowledgeTaskRegistry()
    started = asyncio.Event()
    stopped = asyncio.Event()

    async def job() -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    registry.start("task-1", "kb-1", job())
    await started.wait()

    assert await registry.cancel("task-1", kb_name="kb-1") is True
    await asyncio.wait_for(stopped.wait(), timeout=1)
    await asyncio.sleep(0)
    assert registry.get("task-1") is None


@pytest.mark.asyncio
async def test_registry_rejects_cross_kb_cancellation() -> None:
    registry = KnowledgeTaskRegistry()

    async def job() -> None:
        await asyncio.Event().wait()

    registry.start("task-2", "kb-owner", job())
    assert await registry.cancel("task-2", kb_name="kb-other") is False
    assert await registry.cancel("task-2", kb_name="kb-owner") is True
