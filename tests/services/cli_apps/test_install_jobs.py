from __future__ import annotations

import asyncio
import json
from pathlib import Path

from cognivoy.services.cli_apps.install_jobs import CliInstallJobRegistry
from cognivoy.services.cli_apps.installer import InstallOutcome
from cognivoy.services.cli_apps.models import (
    AppRuntime,
    AppTrust,
    CliAppEntry,
    InstallKind,
    InstallPlan,
)


def _entry() -> CliAppEntry:
    return CliAppEntry(
        id="demo",
        display_name="Demo",
        description="Demo app",
        category="utility",
        origin="test",
        entry_point="demo",
        install=InstallPlan(
            kind=InstallKind.PIP,
            runtime=AppRuntime.PYTHON,
            trust=AppTrust.THIRD_PARTY,
            target="demo==1",
        ),
    )


def test_install_job_persists_progress_and_completion(tmp_path: Path) -> None:
    async def scenario() -> None:
        async def fake_install(entry, *, cancel_requested=None, progress=None):
            assert cancel_requested is not None
            progress("downloading")
            await asyncio.sleep(0)
            progress("installed")
            return InstallOutcome(ok=True, app_id=entry.id, log="done")

        registry = CliInstallJobRegistry(tmp_path / "jobs", installer=fake_install)
        started = registry.start(_entry())
        finished = await registry.wait(started.task_id)
        assert finished.status == "completed"
        assert "downloading" in finished.log and "installed" in finished.log

        reloaded = CliInstallJobRegistry(tmp_path / "jobs", installer=fake_install)
        assert reloaded.get(started.task_id).status == "completed"
        assert reloaded.get(started.task_id).log.endswith("done")

    asyncio.run(scenario())


def test_install_job_cancel_is_terminal_and_signals_the_installer(tmp_path: Path) -> None:
    async def scenario() -> None:
        entered = asyncio.Event()

        async def fake_install(entry, *, cancel_requested=None, progress=None):
            entered.set()
            while not cancel_requested():
                await asyncio.sleep(0.01)
            return InstallOutcome(
                ok=False,
                app_id=entry.id,
                code="cli.install_cancelled",
                message="Cancelled by administrator.",
                log="cancelled",
            )

        registry = CliInstallJobRegistry(tmp_path / "jobs", installer=fake_install)
        started = registry.start(_entry())
        await entered.wait()
        cancelled = registry.cancel(started.task_id)
        assert cancelled.status == "cancelling"
        finished = await registry.wait(started.task_id)
        assert finished.status == "cancelled"
        assert registry.cancel(started.task_id).status == "cancelled"

    asyncio.run(scenario())


def test_restart_marks_orphaned_jobs_failed_and_retryable(tmp_path: Path) -> None:
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    for task_id, status in (
        ("queued-job", "queued"),
        ("running-job", "running"),
        ("cancel-job", "cancelling"),
    ):
        (jobs / f"{task_id}.json").write_text(
            json.dumps(
                {
                    "task_id": task_id,
                    "app_id": "demo",
                    "display_name": "Demo",
                    "status": status,
                    "log": "before restart",
                    "message": "",
                    "created_at": "2026-08-16T00:00:00+00:00",
                    "updated_at": "2026-08-16T00:00:00+00:00",
                }
            ),
            encoding="utf-8",
        )

    registry = CliInstallJobRegistry(jobs)
    for task_id in ("queued-job", "running-job", "cancel-job"):
        recovered = registry.get(task_id)
        assert recovered.status == "failed"
        assert "restart" in recovered.message.lower()
        assert "before restart" in recovered.log
