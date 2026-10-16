"""Opt-in durable background L1 → L2 → L3 consolidation."""

from __future__ import annotations

import asyncio
import logging

from cognivoy.services.memory import paths
from cognivoy.services.memory.consolidator import run_update
from cognivoy.services.memory.consolidator.runs import RunBusyError, get_run_manager
from cognivoy.services.memory.settings import load_memory_settings
from cognivoy.services.memory.store import MemoryStore

logger = logging.getLogger(__name__)


class AutoConsolidationScheduler:
    def __init__(self) -> None:
        self._workers: dict[str, asyncio.Task] = {}
        self._cycles: dict[str, asyncio.Task] = {}

    def ensure_started(self) -> None:
        settings = load_memory_settings().automation
        root = str(paths.memory_root())
        if not settings.enabled or root in self._workers:
            return
        self._workers[root] = asyncio.create_task(self._loop(root))

    def notify(self) -> None:
        """Debounce an immediate threshold check after new activity."""
        self.ensure_started()
        root = str(paths.memory_root())
        if root not in self._workers:
            return
        current = self._cycles.get(root)
        if current is None or current.done():
            self._cycles[root] = asyncio.create_task(self.run_cycle())

    async def reconfigure(self) -> None:
        root = str(paths.memory_root())
        if load_memory_settings().automation.enabled:
            self.ensure_started()
            self.notify()
            return
        tasks = [self._workers.pop(root, None), self._cycles.pop(root, None)]
        live = [task for task in tasks if task is not None]
        for task in live:
            task.cancel()
        if live:
            await asyncio.gather(*live, return_exceptions=True)

    async def run_cycle(self) -> list[str]:
        """Run one ordered L2-then-L3 cycle; exposed for deterministic tests."""
        settings = load_memory_settings().automation
        if not settings.enabled:
            return []
        store = MemoryStore()
        started: list[str] = []
        l2_runs = []
        overview = {(row.layer, row.key): row for row in store.overview()}
        for surface in paths.SURFACES:
            if overview[("L2", surface)].backlog < settings.min_backlog:
                continue
            run = await self._run_target(
                "L2", surface, settings.max_retries, settings.retry_delay_seconds
            )
            if run is not None:
                started.append(run.id)
                l2_runs.append(run)
        await self._wait(l2_runs)

        # L3 always follows completed L2 work and consumes its exact versions.
        overview = {(row.layer, row.key): row for row in store.overview()}
        l3_runs = []
        for slot in paths.L3_SLOTS:
            if slot == "preferences" or overview[("L3", slot)].backlog < settings.min_backlog:
                continue
            run = await self._run_target(
                "L3", slot, settings.max_retries, settings.retry_delay_seconds
            )
            if run is not None:
                started.append(run.id)
                l3_runs.append(run)
        await self._wait(l3_runs)
        return started

    async def stop_all(self) -> None:
        tasks = [*self._workers.values(), *self._cycles.values()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._workers.clear()
        self._cycles.clear()

    async def _loop(self, root: str) -> None:
        try:
            while True:
                interval = load_memory_settings().automation.interval_minutes * 60
                await asyncio.sleep(interval)
                if str(paths.memory_root()) != root:
                    return
                await self.run_cycle()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("automatic memory consolidation loop failed for %s", root)
            self._workers.pop(root, None)

    async def _run_target(self, layer: str, key: str, max_retries: int, delay: int):
        manager = get_run_manager()
        retry_of: str | None = None
        for attempt in range(max_retries + 1):

            async def runner(on_event, *, _layer=layer, _key=key):
                await run_update(_layer, _key, on_event=on_event)

            try:
                run = await manager.start(
                    layer=layer,
                    key=key,
                    mode="update",
                    runner=runner,
                    params={"automatic": True, "attempt": attempt},
                    retry_of=retry_of,
                    user_label="automatic-memory",
                )
            except RunBusyError:
                return None
            if run._task is not None:
                await run._task
            if run.status == "done":
                return run
            retry_of = run.id
            if attempt < max_retries:
                await asyncio.sleep(delay)
        return run

    @staticmethod
    async def _wait(runs) -> None:
        tasks = [run._task for run in runs if run._task is not None and not run._task.done()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


_scheduler: AutoConsolidationScheduler | None = None


def get_auto_consolidation_scheduler() -> AutoConsolidationScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = AutoConsolidationScheduler()
    return _scheduler
