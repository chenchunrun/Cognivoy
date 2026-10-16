"""Run trusted blocking integrations behind a process cancellation boundary."""

from __future__ import annotations

import asyncio
import importlib
import inspect
import multiprocessing
from multiprocessing.reduction import ForkingPickler
import os
import queue
import signal
import time
import traceback
from typing import Any, Callable


def current_user_context_payload() -> dict[str, Any]:
    """Return the minimum explicit user scope safe to copy into a child."""

    from cognivoy.multi_user.context import get_current_user

    user = get_current_user()
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "scope_kind": user.scope.kind,
        "scope_root": str(user.scope.root),
    }


def _resolve_callable(module: str, qualname: str) -> Callable[..., Any]:
    value: Any = importlib.import_module(module)
    for part in qualname.split("."):
        value = getattr(value, part)
    if not callable(value):
        raise TypeError(f"Isolated target is not callable: {module}:{qualname}")
    return value


def _apply_user_context(payload: dict[str, Any] | None) -> None:
    if not payload:
        return
    from pathlib import Path

    from cognivoy.multi_user.context import set_current_user
    from cognivoy.multi_user.models import CurrentUser, UserScope

    role = "admin" if str(payload.get("role")) == "admin" else "user"
    scope_kind = "admin" if str(payload.get("scope_kind")) == "admin" else "user"
    set_current_user(
        CurrentUser(
            id=str(payload.get("id") or "local-admin"),
            username=str(payload.get("username") or "local"),
            role=role,
            scope=UserScope(
                kind=scope_kind,
                user_id=str(payload.get("id") or "local-admin"),
                root=Path(str(payload.get("scope_root") or ".")).resolve(),
            ),
        )
    )


def _child_main(
    result_queue: Any,
    module: str,
    qualname: str,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    user_context: dict[str, Any] | None,
    progress_kwarg: str | None,
) -> None:
    if os.name != "nt":
        try:
            os.setsid()
        except OSError:
            pass
    try:
        _apply_user_context(user_context)
        if progress_kwarg:

            def emit_progress(*args: Any, **progress_kwargs: Any) -> None:
                result_queue.put(
                    bytes(ForkingPickler.dumps(("progress", tuple(args), dict(progress_kwargs))))
                )

            kwargs = {**kwargs, progress_kwarg: emit_progress}
        result = _resolve_callable(module, qualname)(*args, **kwargs)
        if inspect.isawaitable(result):
            result = asyncio.run(result)
        # Serialize before enqueueing: Queue's feeder thread otherwise swallows
        # pickling errors, leaving the parent with no terminal outcome.
        result_queue.put(bytes(ForkingPickler.dumps(("ok", result))))
    except BaseException as exc:  # child must serialize every terminal outcome
        result_queue.put(
            bytes(
                ForkingPickler.dumps(
                    ("error", type(exc).__name__, str(exc), traceback.format_exc())
                )
            )
        )


def _terminate_process(process: multiprocessing.Process) -> None:
    if not process.is_alive():
        process.join(timeout=0.1)
        return
    if os.name != "nt":
        try:
            if os.getpgid(process.pid) == process.pid:
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except (ProcessLookupError, PermissionError, OSError):
            process.terminate()
    else:  # pragma: no cover - Windows CI only
        process.terminate()
    process.join(timeout=0.5)
    if process.is_alive():
        if os.name != "nt":
            try:
                if os.getpgid(process.pid) == process.pid:
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except (ProcessLookupError, PermissionError, OSError):
                process.kill()
        else:  # pragma: no cover - Windows CI only
            process.kill()
        process.join(timeout=0.5)


async def run_in_killable_process(
    *,
    module: str,
    qualname: str,
    args: tuple[Any, ...] = (),
    kwargs: dict[str, Any] | None = None,
    timeout_seconds: float = 900.0,
    user_context: dict[str, Any] | None = None,
    on_started: Callable[[int], None] | None = None,
    progress_kwarg: str | None = None,
    on_progress: Callable[..., Any] | None = None,
) -> Any:
    """Await a blocking call while guaranteeing cancellation kills its process."""
    ctx = multiprocessing.get_context("spawn")
    # One ordered IPC queue carries progress and the terminal result.  Ordering
    # matters: callers must observe the final progress update before success.
    result_queue = ctx.Queue()
    process = ctx.Process(
        target=_child_main,
        args=(
            result_queue,
            module,
            qualname,
            tuple(args),
            dict(kwargs or {}),
            user_context,
            str(progress_kwarg) if progress_kwarg else None,
        ),
        daemon=False,
    )
    process.start()
    if on_started is not None:
        on_started(process.pid)
    deadline = time.monotonic() + max(0.01, float(timeout_seconds))
    exited = False
    try:
        while True:
            try:
                message = result_queue.get_nowait()
            except queue.Empty:
                message = None
            if message is not None:
                message = ForkingPickler.loads(message)
                if message[0] == "progress":
                    if on_progress is not None:
                        progress_result = on_progress(*message[1], **message[2])
                        if inspect.isawaitable(progress_result):
                            await progress_result
                    continue
                await asyncio.to_thread(process.join, 0.5)
                if message[0] == "ok":
                    return message[1]
                _, error_type, error_message, child_traceback = message
                raise RuntimeError(
                    f"{error_type}: {error_message}\n[isolated worker]\n{child_traceback}"
                )
            if not process.is_alive():
                await asyncio.to_thread(process.join, 0.1)
                # Recheck after join: the worker can finish flushing its queue
                # between get_nowait() and is_alive().
                if not exited:
                    exited = True
                    continue
                raise RuntimeError(
                    f"Isolated worker exited without a result (exit code {process.exitcode}; "
                    f"target {module}:{qualname}). Check backend stderr for worker startup errors."
                )
            if time.monotonic() >= deadline:
                await asyncio.to_thread(_terminate_process, process)
                raise TimeoutError(
                    f"Isolated operation exceeded {float(timeout_seconds):g} seconds."
                )
            await asyncio.sleep(0.02)
    except asyncio.CancelledError:
        await asyncio.to_thread(_terminate_process, process)
        raise
    finally:
        if process.is_alive():
            await asyncio.to_thread(_terminate_process, process)
        result_queue.close()
        result_queue.join_thread()


__all__ = ["current_user_context_payload", "run_in_killable_process"]
