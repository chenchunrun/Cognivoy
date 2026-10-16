"""
Sandbox backends: one class per isolation mechanism.

* :class:`RunnerSidecarBackend` — submits the command to a separate runner
  container over authenticated HTTP. It isolates the app process, but the
  legacy shared volume does not isolate tasks, so the service rejects it for
  model-driven execution until the deployment supplies per-task mounts.
* :class:`BwrapBackend` — wraps the command in ``bwrap`` mount namespaces on
  Linux bare-metal (SYSTEM isolation).
* :class:`RestrictedSubprocessBackend` — a plain subprocess with cleaned env
  and path-confined cwd (APPLICATION isolation). Degraded fallback for local
  dev (e.g. macOS); admin-opt-in only because it does not OS-isolate.

Every backend is constructed from :class:`SandboxSettings` and reports the
isolation level it actually provides via :attr:`level`.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
import os
from pathlib import Path
import shutil
import signal
import sys

import httpx

from cognivoy.services.sandbox.spec import (
    ExecRequest,
    ExecResult,
    IsolationLevel,
)


class SandboxBackend:
    """Abstract execution backend."""

    level: IsolationLevel = IsolationLevel.OFF
    # Whether two untrusted accounts can execute without seeing each other's
    # files. Process/container isolation alone is not sufficient for this.
    isolates_accounts: bool = False
    # Whether a command is OS-confined to only the current turn/task files.
    # A shared sidecar that mounts the whole workspace does not satisfy this.
    isolates_tasks: bool = False

    async def exec(self, request: ExecRequest) -> ExecResult:
        raise NotImplementedError

    async def health(self) -> tuple[bool, str]:
        """Return ``(available, detail)`` — whether the backend can run now."""
        return True, ""


class RunnerSidecarBackend(SandboxBackend):
    """Delegate execution to the runner sidecar over HTTP."""

    level = IsolationLevel.SYSTEM

    def __init__(self, base_url: str, *, auth_token: str, connect_timeout_s: float = 5.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._auth_token = auth_token
        self._connect_timeout_s = connect_timeout_s

    async def exec(self, request: ExecRequest) -> ExecResult:
        payload = {
            # Both spellings travel. A runner that understands ``argv`` prefers
            # it and runs without a shell; an older image ignores the unknown
            # field and executes the equivalent shell string. That keeps a
            # rolling deploy correct in either order, with no version handshake.
            "command": request.command,
            "argv": list(request.argv),
            "workdir": request.workdir,
            "env": request.env,
            "mounts": [
                {
                    "host_path": m.host_path,
                    "sandbox_path": m.sandbox_path,
                    "read_only": m.read_only,
                }
                for m in request.mounts
            ],
            "limits": {
                "timeout_s": request.limits.timeout_s,
                "memory_mb": request.limits.memory_mb,
                "cpu_seconds": request.limits.cpu_seconds,
                "max_output_chars": request.limits.max_output_chars,
            },
        }
        # Allow the HTTP call to outlast the command's own timeout a little so
        # the runner can report a clean timeout result instead of us aborting.
        http_timeout = httpx.Timeout(
            request.limits.timeout_s + 15,
            connect=self._connect_timeout_s,
        )
        try:
            async with httpx.AsyncClient(timeout=http_timeout) as client:
                resp = await client.post(
                    f"{self._base_url}/exec",
                    json=payload,
                    headers={"Authorization": f"Bearer {self._auth_token}"},
                )
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPError as exc:
            return ExecResult(error=f"runner unavailable: {type(exc).__name__}: {exc}")
        return ExecResult(
            stdout=str(data.get("stdout", "")),
            stderr=str(data.get("stderr", "")),
            exit_code=int(data.get("exit_code", 0)),
            timed_out=bool(data.get("timed_out", False)),
            error=str(data.get("error", "")),
        )

    async def health(self) -> tuple[bool, str]:
        try:
            async with httpx.AsyncClient(timeout=self._connect_timeout_s) as client:
                resp = await client.get(f"{self._base_url}/health")
                resp.raise_for_status()
            return True, "runner reachable"
        except httpx.HTTPError as exc:
            return False, f"runner unreachable: {type(exc).__name__}"


class BwrapBackend(SandboxBackend):
    """Bubblewrap mount-namespace isolation (Linux only)."""

    level = IsolationLevel.SYSTEM
    isolates_accounts = True
    isolates_tasks = True

    _RO_SYSTEM_DIRS = ("/usr", "/usr/local", "/bin", "/lib", "/lib64", "/etc", "/sbin")

    def __init__(self, bwrap_path: str = "bwrap") -> None:
        self._bwrap = bwrap_path

    def _build_argv(self, request: ExecRequest) -> list[str]:
        argv = [
            self._bwrap,
            "--die-with-parent",
            "--unshare-all",
            "--new-session",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",  # nosec B108 — path inside the bwrap mount namespace, not the host
        ]
        for system_dir in self._RO_SYSTEM_DIRS:
            if Path(system_dir).exists():
                argv += ["--ro-bind", system_dir, system_dir]
        for mount in request.mounts:
            flag = "--ro-bind" if mount.read_only else "--bind"
            argv += [flag, mount.host_path, mount.sandbox_path]
        if request.workdir:
            argv += ["--chdir", request.workdir]
        for key, value in request.env.items():
            argv += ["--setenv", key, value]
        if request.argv:
            # No shell in between: bwrap execs the vector directly.
            argv += ["--", *request.argv]
        else:
            argv += ["/bin/sh", "-c", request.command]
        return argv

    async def exec(self, request: ExecRequest) -> ExecResult:
        argv = self._build_argv(request)
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=sys.platform != "win32",
            )
        except FileNotFoundError:
            return ExecResult(error="bwrap not found on host")
        return await _communicate(
            process,
            request.limits.timeout_s,
            request.limits.max_output_chars,
        )

    async def health(self) -> tuple[bool, str]:
        if shutil.which(self._bwrap) is None:
            return False, "bwrap not installed"
        # bwrap needs unprivileged user namespaces; a default-seccomp Docker
        # container blocks them, so confirm a trivial sandbox actually runs.
        probe = ExecRequest(command="true")
        result = await self.exec(probe)
        if result.error:
            return False, result.error
        return True, "bwrap functional"


class RestrictedSubprocessBackend(SandboxBackend):
    """Plain subprocess with a scrubbed env and confined cwd (no OS isolation)."""

    level = IsolationLevel.APPLICATION

    _SAFE_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR")

    async def exec(self, request: ExecRequest) -> ExecResult:
        env = {k: os.environ[k] for k in self._SAFE_ENV_KEYS if k in os.environ}
        env.update(request.env)
        cwd = request.workdir or None
        try:
            if request.argv:
                process = await asyncio.create_subprocess_exec(
                    *request.argv,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=env,
                    start_new_session=sys.platform != "win32",
                )
            else:
                process = await asyncio.create_subprocess_shell(
                    request.command,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=env,
                    start_new_session=sys.platform != "win32",
                )
        except Exception as exc:
            return ExecResult(error=f"{type(exc).__name__}: {exc}")
        return await _communicate(
            process,
            request.limits.timeout_s,
            request.limits.max_output_chars,
        )


async def _capture_limited(stream: asyncio.StreamReader | None, max_chars: int) -> bytes:
    """Drain one subprocess stream while retaining only bounded samples."""
    if stream is None:
        return b""
    if max_chars <= 0:
        while await stream.read(64 * 1024):
            pass
        return b""

    head = bytearray()
    tail = bytearray()
    total_bytes = 0
    while True:
        chunk = await stream.read(64 * 1024)
        if not chunk:
            break
        total_bytes += len(chunk)
        head_capacity = max_chars - len(head)
        if head_capacity:
            accepted = chunk[:head_capacity]
            head.extend(accepted)
            chunk = chunk[len(accepted) :]
        if chunk:
            tail.extend(chunk)
            if len(tail) > max_chars:
                del tail[: len(tail) - max_chars]

    if total_bytes <= max_chars:
        return bytes(head)

    prefix_size = max_chars // 2
    suffix_size = max_chars - prefix_size
    prefix = head[:prefix_size]
    suffix = tail[-suffix_size:] if suffix_size else bytearray()
    dropped = total_bytes - len(prefix) - len(suffix)
    marker = f"\n\n... ({dropped:,} bytes truncated) ...\n\n".encode()
    return bytes(prefix) + marker + bytes(suffix)


async def _terminate_process_tree(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    if sys.platform != "win32":
        try:
            os.killpg(process.pid, signal.SIGKILL)
            return
        except ProcessLookupError:
            return
        except PermissionError:
            with suppress(ProcessLookupError):
                process.kill()
            return

    try:
        killer = await asyncio.create_subprocess_exec(
            "taskkill",
            "/PID",
            str(process.pid),
            "/T",
            "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(killer.wait(), timeout=5.0)
    except OSError:
        process.kill()


async def _communicate(
    process: asyncio.subprocess.Process,
    timeout_s: int,
    max_output_chars: int,
) -> ExecResult:
    stdout_task = asyncio.create_task(_capture_limited(process.stdout, max_output_chars))
    stderr_task = asyncio.create_task(_capture_limited(process.stderr, max_output_chars))
    wait_task = asyncio.create_task(process.wait())
    try:
        _, stdout, stderr = await asyncio.wait_for(
            asyncio.gather(wait_task, stdout_task, stderr_task),
            timeout=timeout_s,
        )
    except asyncio.TimeoutError:
        for task in (wait_task, stdout_task, stderr_task):
            task.cancel()
        await asyncio.gather(wait_task, stdout_task, stderr_task, return_exceptions=True)
        await _terminate_process_tree(process)
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(process.wait(), timeout=5.0)
        return ExecResult(timed_out=True, exit_code=124)
    return ExecResult(
        stdout=stdout.decode("utf-8", errors="replace") if stdout else "",
        stderr=stderr.decode("utf-8", errors="replace") if stderr else "",
        exit_code=process.returncode if process.returncode is not None else 0,
    )


__all__ = [
    "BwrapBackend",
    "RestrictedSubprocessBackend",
    "RunnerSidecarBackend",
    "SandboxBackend",
]
