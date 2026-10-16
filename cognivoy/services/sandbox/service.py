"""
Sandbox service facade.

The single entry point the rest of the app uses. It owns the chosen backend,
caches its liveness probe, enforces per-user quotas, and answers the
capability questions the skill/exec layers ask:

* :func:`exec_capability_available` — does a usable sandbox of this kind
  exist at all? (drives skill ``requires.sandbox`` gating)
* :meth:`SandboxService.isolation_level` — how strong is it? (drives the
  exec policy gate: SYSTEM for everyone, APPLICATION for admins only)
* :meth:`SandboxService.run` — execute, subject to quota.
"""

from __future__ import annotations

import asyncio
import logging

from cognivoy.core.i18n import t
from cognivoy.services.sandbox.backends import SandboxBackend
from cognivoy.services.sandbox.config import SandboxSettings, build_backend
from cognivoy.services.sandbox.quota import QuotaExceeded, UserExecQuota
from cognivoy.services.sandbox.spec import ExecRequest, ExecResult, IsolationLevel

logger = logging.getLogger(__name__)


class SandboxService:
    def __init__(self, settings: SandboxSettings | None = None) -> None:
        self._settings = settings or SandboxSettings.from_env()
        self._backend: SandboxBackend | None = build_backend(self._settings)
        self._healthy: bool | None = None
        self._health_detail = ""
        self._health_lock = asyncio.Lock()
        self._quota = UserExecQuota(
            max_concurrent=self._settings.max_concurrent_per_user,
            max_per_minute=self._settings.max_runs_per_minute_per_user,
        )

    @property
    def settings(self) -> SandboxSettings:
        return self._settings

    async def _ensure_healthy(self) -> bool:
        if self._backend is None:
            return False
        if self._healthy is not None:
            return self._healthy
        async with self._health_lock:
            if self._healthy is None:
                try:
                    self._healthy, self._health_detail = await self._backend.health()
                except Exception as exc:
                    self._healthy = False
                    self._health_detail = f"health check failed: {exc}"
                if not self._healthy:
                    logger.warning(
                        "sandbox backend %s unhealthy: %s",
                        type(self._backend).__name__,
                        self._health_detail,
                    )
        return bool(self._healthy)

    async def isolation_level(self) -> IsolationLevel:
        """Effective isolation level (OFF when no healthy backend)."""
        if not await self._ensure_healthy() or self._backend is None:
            return IsolationLevel.OFF
        if not self._backend.isolates_tasks:
            return IsolationLevel.OFF
        return self._backend.level

    async def available(self) -> bool:
        return await self.isolation_level() is not IsolationLevel.OFF

    async def supports_account_isolation(self) -> bool:
        """Whether the active backend enforces a filesystem boundary per account."""

        if not await self._ensure_healthy() or self._backend is None:
            return False
        return bool(self._backend.isolates_accounts)

    async def supports_task_isolation(self) -> bool:
        """Whether execution is OS-confined to the current task directory."""

        if not await self._ensure_healthy() or self._backend is None:
            return False
        return bool(self._backend.isolates_tasks)

    async def run(self, request: ExecRequest, *, user_id: str) -> ExecResult:
        """Run *request* for *user_id*, enforcing quota; never raises for
        command failure — only the sandbox/quota envelope is reported via
        :attr:`ExecResult.error`."""
        if not await self._ensure_healthy() or self._backend is None:
            return ExecResult(error=self._health_detail or t("sandbox.no_backend"))
        if not self._backend.isolates_tasks:
            logger.error(
                "refusing unsafe sandbox backend without per-task filesystem isolation: %s",
                type(self._backend).__name__,
            )
            return ExecResult(error=t("sandbox.task_isolation_required"))
        if not self._backend.isolates_accounts:
            # The shared Docker runner isolates commands from the app process,
            # but cannot safely serve separate user workspaces. Fail closed for
            # non-admin identities even if a stale grant or direct call reaches
            # this backstop.
            try:
                from cognivoy.multi_user.context import get_current_user

                if not get_current_user().is_admin:
                    return ExecResult(error=t("sandbox.disabled_for_account"))
            except Exception:
                logger.warning("sandbox account-isolation check failed", exc_info=True)
                return ExecResult(error=t("sandbox.disabled_for_account"))
        # Backstop for the per-user exec grant: pipelines hide the exec tool
        # when the grant denies it, but any path that reaches the sandbox
        # directly still answers to the same policy.
        try:
            from cognivoy.multi_user.tool_access import exec_override

            if exec_override() is False:
                return ExecResult(error=t("sandbox.disabled_for_account"))
        except Exception:
            logger.warning("per-user exec policy check failed; continuing", exc_info=True)
        try:
            lease = await self._quota.acquire(user_id, wait_timeout_s=30.0)
        except QuotaExceeded as exc:
            return ExecResult(error=str(exc))
        async with lease:
            # Admission may wait. Recheck revocable permissions at execution
            # time, not only when the task entered the bounded queue.
            try:
                from cognivoy.multi_user.context import get_current_user
                from cognivoy.multi_user.tool_access import exec_override

                if exec_override() is False or (
                    not self._backend.isolates_accounts and not get_current_user().is_admin
                ):
                    return ExecResult(error=t("sandbox.disabled_for_account"))
            except Exception:
                logger.warning("sandbox queued authorization recheck failed", exc_info=True)
                return ExecResult(error=t("sandbox.disabled_for_account"))
            return await self._backend.exec(request)


_service: SandboxService | None = None


def get_sandbox_service() -> SandboxService:
    global _service
    if _service is None:
        _service = SandboxService()
    return _service


def reset_sandbox_service() -> None:
    """Drop the cached service (tests / config reloads)."""
    global _service
    _service = None


def exec_capability_available(kind: str = "shell") -> bool:
    """Whether a usable sandbox exists — used by skill ``requires.sandbox``.

    Synchronous (skill summary rendering is sync). Returns ``True`` when a
    backend is configured at all; the per-run health probe still gates
    actual execution, so a configured-but-down runner won't silently run
    unsandboxed.
    """
    if kind not in ("", "shell"):
        return False
    backend = get_sandbox_service()._backend
    return backend is not None and backend.isolates_tasks


__all__ = [
    "SandboxService",
    "exec_capability_available",
    "get_sandbox_service",
    "reset_sandbox_service",
]
