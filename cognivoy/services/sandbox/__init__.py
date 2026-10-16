"""Sandboxed shell execution: pluggable isolation backends + per-user quota."""

from cognivoy.services.sandbox.service import (
    SandboxService,
    exec_capability_available,
    get_sandbox_service,
    reset_sandbox_service,
)
from cognivoy.services.sandbox.spec import (
    ExecRequest,
    ExecResult,
    IsolationLevel,
    Mount,
    ResourceLimits,
)

__all__ = [
    "ExecRequest",
    "ExecResult",
    "IsolationLevel",
    "Mount",
    "ResourceLimits",
    "SandboxService",
    "exec_capability_available",
    "get_sandbox_service",
    "reset_sandbox_service",
]
