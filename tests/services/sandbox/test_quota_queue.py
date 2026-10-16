import asyncio

import pytest

from cognivoy.services.sandbox.quota import QuotaExceeded, UserExecQuota


@pytest.mark.asyncio
async def test_three_parallel_calls_queue_with_two_slots():
    quota = UserExecQuota(max_concurrent=2, max_per_minute=10)
    active = peak = completed = 0

    async def run():
        nonlocal active, peak, completed
        async with await quota.acquire("u", wait_timeout_s=1):
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            completed += 1

    await asyncio.gather(*(run() for _ in range(3)))
    assert (peak, completed) == (2, 3)


@pytest.mark.asyncio
async def test_wait_timeout_and_cancellation_release_queue_entries():
    quota = UserExecQuota(max_concurrent=1, max_per_minute=10)
    async with await quota.acquire("u"):
        with pytest.raises(QuotaExceeded, match="wait timed out"):
            await quota.acquire("u", wait_timeout_s=0.001)
        waiting = asyncio.create_task(quota.acquire("u", wait_timeout_s=1))
        await asyncio.sleep(0)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        assert quota._waiting["u"] == 0
        async with await quota.acquire("other"):
            pass
    async with await quota.acquire("u"):
        pass


@pytest.mark.asyncio
async def test_queue_is_bounded_and_rate_limit_still_enforced():
    quota = UserExecQuota(max_concurrent=1, max_per_minute=1)
    async with await quota.acquire("u"):
        waiting = [asyncio.create_task(quota.acquire("u", wait_timeout_s=1)) for _ in range(8)]
        await asyncio.sleep(0)
        with pytest.raises(QuotaExceeded, match="queue is full"):
            await quota.acquire("u", wait_timeout_s=1)
    results = await asyncio.gather(*waiting, return_exceptions=True)
    assert all(
        isinstance(result, QuotaExceeded) and "rate limit" in str(result) for result in results
    )
    assert not quota._semaphore("u").locked()
    assert quota._waiting["u"] == 0


@pytest.mark.asyncio
async def test_service_rechecks_revoked_permission_after_queue(monkeypatch):
    from cognivoy.services.sandbox.config import SandboxSettings
    from cognivoy.services.sandbox.service import SandboxService
    from cognivoy.services.sandbox.spec import ExecRequest, ExecResult

    allowed = True
    calls = []

    class Backend:
        isolates_accounts = True
        isolates_tasks = True

        async def exec(self, request):
            calls.append(request.command)
            return ExecResult(exit_code=0)

    service = SandboxService(SandboxSettings())
    service._backend = Backend()
    service._healthy = True
    service._quota = UserExecQuota(max_concurrent=1, max_per_minute=10)
    monkeypatch.setattr("cognivoy.multi_user.tool_access.exec_override", lambda: allowed)
    async with await service._quota.acquire("u"):
        waiting = asyncio.create_task(service.run(ExecRequest(command="never run"), user_id="u"))
        await asyncio.sleep(0)
        assert service._quota._waiting["u"] == 1
        allowed = False
    result = await waiting
    assert result.error
    assert calls == []
    assert not service._quota._semaphore("u").locked()
