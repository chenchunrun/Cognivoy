from __future__ import annotations

import asyncio
import os
import time

import pytest

from cognivoy.services.process_isolation import run_in_killable_process


def _emit_progress(callback) -> str:
    callback(1, 3, "first")
    callback(3, 3, "done")
    return "complete"


def _read_user_scope() -> tuple[str, str, str]:
    from cognivoy.multi_user.context import get_current_user

    user = get_current_user()
    return user.id, user.role, str(user.scope.root)


def _unpicklable_result():
    return lambda: None


@pytest.mark.asyncio
async def test_unpicklable_result_reports_serialization_error() -> None:
    with pytest.raises(RuntimeError, match="local object|pickle"):
        await run_in_killable_process(
            module="tests.services.test_process_isolation",
            qualname="_unpicklable_result",
            timeout_seconds=5,
        )


@pytest.mark.asyncio
async def test_abnormal_exit_identifies_target() -> None:
    with pytest.raises(RuntimeError, match=r"exit code 1; target os:_exit"):
        await run_in_killable_process(
            module="os",
            qualname="_exit",
            args=(1,),
            timeout_seconds=5,
        )


@pytest.mark.asyncio
async def test_killable_process_returns_picklable_result() -> None:
    result = await run_in_killable_process(
        module="builtins",
        qualname="sum",
        args=([1, 2, 3],),
        timeout_seconds=5,
    )
    assert result == 6


@pytest.mark.asyncio
async def test_killable_process_awaits_async_entrypoint() -> None:
    result = await run_in_killable_process(
        module="asyncio",
        qualname="sleep",
        args=(0.01, "done"),
        timeout_seconds=5,
    )
    assert result == "done"


@pytest.mark.asyncio
async def test_killable_process_forwards_progress_from_child() -> None:
    progress: list[tuple[int, int, str]] = []

    result = await run_in_killable_process(
        module="tests.services.test_process_isolation",
        qualname="_emit_progress",
        progress_kwarg="callback",
        on_progress=lambda current, total, message: progress.append((current, total, message)),
        timeout_seconds=5,
    )

    assert result == "complete"
    assert progress == [(1, 3, "first"), (3, 3, "done")]


@pytest.mark.asyncio
async def test_killable_process_applies_explicit_user_scope(tmp_path) -> None:
    result = await run_in_killable_process(
        module="tests.services.test_process_isolation",
        qualname="_read_user_scope",
        user_context={
            "id": "user-7",
            "username": "learner",
            "role": "user",
            "scope_kind": "user",
            "scope_root": str(tmp_path),
        },
        timeout_seconds=5,
    )
    assert result == ("user-7", "user", str(tmp_path))


@pytest.mark.asyncio
async def test_cancelling_wait_terminates_the_worker_process() -> None:
    pids: list[int] = []
    task = asyncio.create_task(
        run_in_killable_process(
            module="time",
            qualname="sleep",
            args=(30,),
            timeout_seconds=60,
            on_started=pids.append,
        )
    )
    for _ in range(100):
        if pids:
            break
        await asyncio.sleep(0.01)
    assert pids

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    for _ in range(100):
        try:
            os.kill(pids[0], 0)
        except ProcessLookupError:
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("isolated worker survived cancellation")


@pytest.mark.asyncio
async def test_timeout_terminates_worker_and_reports_timeout() -> None:
    started = time.monotonic()
    with pytest.raises(TimeoutError, match="exceeded"):
        await run_in_killable_process(
            module="time",
            qualname="sleep",
            args=(30,),
            timeout_seconds=0.1,
        )
    assert time.monotonic() - started < 3
