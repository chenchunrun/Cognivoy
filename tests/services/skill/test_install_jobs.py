from __future__ import annotations

import asyncio
import json
from pathlib import Path

from cognivoy.services.skill.install_jobs import SkillInstallJobRegistry


def test_skill_install_job_persists_result_and_progress(tmp_path: Path) -> None:
    async def scenario() -> None:
        async def installer(payload, *, cancel_requested, progress):
            assert payload["ref"] == "eduhub:demo@1"
            assert cancel_requested() is False
            progress("verified")
            return {"skill": {"name": "demo"}, "version": "1"}

        registry = SkillInstallJobRegistry(tmp_path, installer=installer)
        started = registry.start({"ref": "eduhub:demo@1"})
        finished = await registry.wait(started.task_id)
        assert finished.status == "completed"
        assert finished.result["skill"]["name"] == "demo"
        assert "verified" in finished.log
        assert (
            SkillInstallJobRegistry(tmp_path, installer=installer).get(started.task_id).status
            == "completed"
        )

    asyncio.run(scenario())


def test_skill_install_job_cancel_and_restart_are_terminal(tmp_path: Path) -> None:
    async def scenario() -> None:
        entered = asyncio.Event()

        async def installer(payload, *, cancel_requested, progress):
            entered.set()
            while not cancel_requested():
                await asyncio.sleep(0.01)
            raise asyncio.CancelledError

        registry = SkillInstallJobRegistry(tmp_path, installer=installer)
        started = registry.start({"ref": "eduhub:demo@1"})
        await entered.wait()
        assert registry.cancel(started.task_id).status == "cancelling"
        assert (await registry.wait(started.task_id)).status == "cancelled"

        orphan = {
            **started.to_dict(),
            "task_id": "orphan",
            "status": "running",
            "message": "",
        }
        (tmp_path / "orphan.json").write_text(json.dumps(orphan), encoding="utf-8")
        recovered = SkillInstallJobRegistry(tmp_path, installer=installer).get("orphan")
        assert recovered.status == "failed"
        assert "restart" in recovered.message.lower()

    asyncio.run(scenario())
