"""Sandbox: backend selection, restricted subprocess exec, quota, level gating."""

from __future__ import annotations

import asyncio
import os
import shlex
import sys

import pytest

from cognivoy.services.sandbox.backends import (
    BwrapBackend,
    RestrictedSubprocessBackend,
    RunnerSidecarBackend,
    SandboxBackend,
)
from cognivoy.services.sandbox.config import SandboxSettings, build_backend
from cognivoy.services.sandbox.quota import QuotaExceeded, UserExecQuota
from cognivoy.services.sandbox.service import SandboxService
from cognivoy.services.sandbox.spec import ExecRequest, ExecResult, IsolationLevel, ResourceLimits


def test_backend_selection_runner_url() -> None:
    settings = SandboxSettings(runner_url="http://sandbox-runner:8900", runner_token="secret")
    backend = build_backend(settings)
    assert isinstance(backend, RunnerSidecarBackend)
    assert backend.level is IsolationLevel.SYSTEM


def test_only_bwrap_claims_account_filesystem_isolation() -> None:
    assert BwrapBackend().isolates_accounts is True
    assert (
        RunnerSidecarBackend("http://sandbox-runner:8900", auth_token="secret").isolates_accounts
        is False
    )
    assert RestrictedSubprocessBackend().isolates_accounts is False


def test_runner_requires_auth_token_to_be_selected() -> None:
    settings = SandboxSettings(runner_url="http://sandbox-runner:8900", runner_token="")
    assert not isinstance(build_backend(settings), RunnerSidecarBackend)


def test_backend_selection_none_without_optin() -> None:
    # No runner, subprocess not allowed → no backend (on non-bwrap hosts).
    settings = SandboxSettings(runner_url="", allow_subprocess=False)
    backend = build_backend(settings)
    # On a Linux host with bwrap installed this could be BwrapBackend; the
    # invariant we assert is that subprocess fallback is NOT silently used.
    from cognivoy.services.sandbox.backends import RestrictedSubprocessBackend

    assert not isinstance(backend, RestrictedSubprocessBackend)


def test_backend_selection_subprocess_optin() -> None:
    settings = SandboxSettings(runner_url="", allow_subprocess=True)
    # build_backend prefers bwrap on Linux; force the subprocess path by
    # asserting only when no bwrap candidate is chosen.
    backend = build_backend(settings)
    assert backend is not None


def test_bwrap_binds_usr_local_when_available(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    usr = tmp_path / "usr"
    usr_local = tmp_path / "usr" / "local"
    missing = tmp_path / "missing"
    usr_local.mkdir(parents=True)

    monkeypatch.setattr(
        BwrapBackend,
        "_RO_SYSTEM_DIRS",
        (str(usr), str(usr_local), str(missing)),
    )

    argv = BwrapBackend(bwrap_path="bwrap")._build_argv(ExecRequest(command="true"))

    usr_index = argv.index(str(usr))
    assert argv[usr_index - 1 : usr_index + 2] == ["--ro-bind", str(usr), str(usr)]
    assert str(usr_local) in argv
    assert str(missing) not in argv


@pytest.mark.asyncio
async def test_restricted_subprocess_runs() -> None:
    backend = RestrictedSubprocessBackend()
    result = await backend.exec(ExecRequest(command="echo hello"))
    assert result.ok
    assert "hello" in result.stdout
    assert result.exit_code == 0


@pytest.mark.asyncio
async def test_restricted_subprocess_timeout() -> None:
    backend = RestrictedSubprocessBackend()
    result = await backend.exec(ExecRequest(command="sleep 5", limits=ResourceLimits(timeout_s=1)))
    assert result.timed_out
    assert result.exit_code == 124


@pytest.mark.asyncio
async def test_restricted_subprocess_caps_output_while_draining_streams() -> None:
    backend = RestrictedSubprocessBackend()
    result = await backend.exec(
        ExecRequest.of_argv(
            (sys.executable, "-c", "print('x' * 50_000, end='')"),
            limits=ResourceLimits(timeout_s=10, max_output_chars=1_000),
        )
    )

    assert result.ok
    assert result.stdout.startswith("x")
    assert result.stdout.endswith("x")
    assert "bytes truncated" in result.stdout
    assert len(result.stdout) < 1_500


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")
async def test_restricted_subprocess_timeout_kills_descendants(tmp_path) -> None:
    pid_file = tmp_path / "background.pid"
    command = f"sleep 30 & echo $! > {shlex.quote(str(pid_file))}; sleep 30"
    backend = RestrictedSubprocessBackend()

    result = await backend.exec(ExecRequest(command=command, limits=ResourceLimits(timeout_s=1)))

    assert result.timed_out
    assert result.exit_code == 124
    child_pid = int(pid_file.read_text(encoding="utf-8").strip())
    for _ in range(40):
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        await asyncio.sleep(0.05)
    else:
        pytest.fail("sandbox timeout left a descendant process running")


@pytest.mark.asyncio
async def test_service_disabled_when_no_backend() -> None:
    svc = SandboxService(SandboxSettings(runner_url="", allow_subprocess=False))
    # Force the "no backend" branch deterministically.
    svc._backend = None
    assert await svc.isolation_level() is IsolationLevel.OFF
    result = await svc.run(ExecRequest(command="echo hi"), user_id="u1")
    assert not result.ok
    assert result.error


@pytest.mark.asyncio
async def test_service_refuses_backend_without_per_task_isolation() -> None:
    svc = SandboxService(SandboxSettings(allow_subprocess=True))
    svc._backend = RestrictedSubprocessBackend()
    svc._healthy = True
    result = await svc.run(ExecRequest(command="echo sandboxed"), user_id="u1")
    assert not result.ok
    assert result.error


@pytest.mark.asyncio
async def test_shared_runner_fails_closed_for_a_non_admin(monkeypatch) -> None:
    class _SharedBackend(SandboxBackend):
        level = IsolationLevel.SYSTEM
        isolates_accounts = False

        async def exec(self, request: ExecRequest) -> ExecResult:
            raise AssertionError("non-admin request must not reach the shared runner")

    from cognivoy.multi_user import context as user_context

    monkeypatch.setattr(
        user_context,
        "get_current_user",
        lambda: type("User", (), {"is_admin": False})(),
    )
    service = SandboxService(SandboxSettings())
    service._backend = _SharedBackend()
    service._healthy = True

    result = await service.run(ExecRequest(command="cat /app/data/users/victim/db"), user_id="u1")

    assert not result.ok
    assert result.error


@pytest.mark.asyncio
async def test_quota_rate_limit() -> None:
    quota = UserExecQuota(max_concurrent=5, max_per_minute=2)
    async with await quota.acquire("u1"):
        pass
    async with await quota.acquire("u1"):
        pass
    with pytest.raises(QuotaExceeded):
        await quota.acquire("u1")
    # a different user is unaffected
    async with await quota.acquire("u2"):
        pass


@pytest.mark.asyncio
async def test_quota_concurrency_limit() -> None:
    quota = UserExecQuota(max_concurrent=1, max_per_minute=100)
    lease = await quota.acquire("u1")
    with pytest.raises(QuotaExceeded):
        await quota.acquire("u1")
    await lease.__aexit__(None, None, None)
    # slot freed
    async with await quota.acquire("u1"):
        pass


def test_exec_result_render_truncates() -> None:
    result = ExecResult(stdout="x" * 1000, exit_code=0)
    rendered = result.render(max_chars=100)
    assert "truncated" in rendered
    assert len(rendered) < 400


def test_exec_result_render_error() -> None:
    assert "boom" in ExecResult(error="boom").render(100)


def test_runner_server_validates_request_shape() -> None:
    from cognivoy.services.sandbox.runner import server

    assert "command" in server.execute({})["error"]
    assert "workdir" in server.execute({"command": "true", "workdir": 123})["error"]
    assert "env" in server.execute({"command": "true", "env": ["bad"]})["error"]
    assert "mounts" in server.execute({"command": "true", "mounts": {"bad": True}})["error"]
    assert "limits" in server.execute({"command": "true", "limits": ["bad"]})["error"]


def test_runner_bearer_auth_fails_closed() -> None:
    from cognivoy.services.sandbox.runner import server

    assert server._authorized("Bearer secret", "secret") is True
    assert server._authorized("Bearer wrong", "secret") is False
    assert server._authorized("", "") is False


def test_runner_server_executes_and_truncates_output() -> None:
    from cognivoy.services.sandbox.runner import server

    command = shlex.join([sys.executable, "-c", "print('x' * 200)"])
    result = server.execute(
        {
            "command": command,
            "limits": {"timeout_s": 5, "max_output_chars": 40},
        }
    )

    assert result["exit_code"] == 0
    assert result["error"] == ""
    assert "truncated" in result["stdout"]
    assert len(result["stdout"]) < 120


def test_runner_server_rejects_workdir_outside_allowed_roots(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from cognivoy.services.sandbox.runner import server

    allowed = tmp_path / "workspace"
    allowed.mkdir()
    monkeypatch.setattr(server, "_ALLOWED_WORKDIR_ROOTS", [str(allowed)])

    outside = server.execute({"command": "true", "workdir": str(tmp_path / "elsewhere")})
    assert "outside the shared workspace roots" in outside["error"]

    # Symlinks that point out of the allowed tree must not slip through.
    sneaky = allowed / "link"
    sneaky.symlink_to(tmp_path)
    via_link = server.execute({"command": "true", "workdir": str(sneaky)})
    assert "outside the shared workspace roots" in via_link["error"]

    inside = server.execute(
        {"command": "true", "workdir": str(allowed), "limits": {"timeout_s": 5}}
    )
    assert inside["error"] == ""
    assert inside["exit_code"] == 0
