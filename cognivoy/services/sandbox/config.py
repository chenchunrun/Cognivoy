"""
Sandbox configuration and backend selection.

The active backend is chosen from environment so it tracks the deployment
shape without per-user config:

* runner URL + token set ⇒ authenticated runner candidate (Docker deployment);
* else on Linux with a functional ``bwrap`` ⇒ bwrap (bare-metal);
* else, only when ``COGNIVOY_SANDBOX_ALLOW_SUBPROCESS=1`` ⇒ restricted
  subprocess (admin-opt-in local dev — APPLICATION isolation only);
* else ⇒ no sandbox (exec disabled).

``exec`` is exposed only when the backend also declares OS-enforced per-task
filesystem isolation.  The legacy shared-workspace runner and restricted
subprocess therefore fail closed. Per-user quotas live in
:mod:`cognivoy.services.sandbox.quota`.
"""

from __future__ import annotations

from dataclasses import dataclass
import os

from cognivoy.services.sandbox.backends import (
    BwrapBackend,
    RestrictedSubprocessBackend,
    RunnerSidecarBackend,
    SandboxBackend,
)
from cognivoy.services.sandbox.spec import ResourceLimits

RUNNER_URL_ENV = "COGNIVOY_SANDBOX_RUNNER_URL"
RUNNER_TOKEN_ENV = "COGNIVOY_SANDBOX_RUNNER_TOKEN"
ALLOW_SUBPROCESS_ENV = "COGNIVOY_SANDBOX_ALLOW_SUBPROCESS"

# Per-user execution quotas (see quota.py). Conservative defaults; override
# via the matching env vars.
MAX_CONCURRENT_ENV = "COGNIVOY_SANDBOX_MAX_CONCURRENT"
MAX_PER_MINUTE_ENV = "COGNIVOY_SANDBOX_MAX_PER_MINUTE"


@dataclass(frozen=True)
class SandboxSettings:
    runner_url: str = ""
    runner_token: str = ""
    allow_subprocess: bool = False
    default_limits: ResourceLimits = ResourceLimits()
    max_concurrent_per_user: int = 2
    max_runs_per_minute_per_user: int = 20

    @classmethod
    def from_env(cls) -> "SandboxSettings":
        def _int(name: str, default: int) -> int:
            try:
                return int(os.environ.get(name, "") or default)
            except ValueError:
                return default

        return cls(
            runner_url=os.environ.get(RUNNER_URL_ENV, "").strip(),
            runner_token=os.environ.get(RUNNER_TOKEN_ENV, "").strip(),
            allow_subprocess=os.environ.get(ALLOW_SUBPROCESS_ENV, "").strip()
            in {"1", "true", "yes"},
            max_concurrent_per_user=_int(MAX_CONCURRENT_ENV, 2),
            max_runs_per_minute_per_user=_int(MAX_PER_MINUTE_ENV, 20),
        )


def build_backend(settings: SandboxSettings) -> SandboxBackend | None:
    """Pick the backend implied by *settings*; ``None`` when none is usable.

    Note: returns the candidate by configuration shape. Liveness (e.g. can
    bwrap actually create namespaces here) is confirmed lazily via the
    backend's ``health()`` — see :mod:`cognivoy.services.sandbox.service`.
    """
    import sys

    if settings.runner_url and settings.runner_token:
        return RunnerSidecarBackend(settings.runner_url, auth_token=settings.runner_token)
    if sys.platform.startswith("linux"):
        import shutil

        if shutil.which("bwrap"):
            return BwrapBackend()
    if settings.allow_subprocess:
        return RestrictedSubprocessBackend()
    return None


__all__ = [
    "ALLOW_SUBPROCESS_ENV",
    "RUNNER_URL_ENV",
    "RUNNER_TOKEN_ENV",
    "SandboxSettings",
    "build_backend",
]
