"""Subagent driver layer — drive a user's local agent CLI as a subagent.

Cognivoy runs on the same machine as the user's configured agent CLIs — Claude
Code, Codex, Gemini CLI, Kimi CLI, opencode, MiMo Code — so the backend can
drive them directly (spawned in print mode, or via a managed local server for
the opencode family) and stream back every native event. This package is the
decoupled core of that: backends that know one CLI each, a shared
streaming-subprocess primitive, and the value types that cross into the chat
capability. It knows nothing about the chat loop, KBs, or HTTP — those wire in
through the consult tool and the API.
"""

from __future__ import annotations

from cognivoy.services.subagent.base import OnEvent, SubagentBackend
from cognivoy.services.subagent.config import (
    CONSULT_BUDGET_MAX,
    CONSULT_BUDGET_MIN,
    DEFAULT_CONSULT_BUDGET,
    DEFAULT_RUNTIME_TIMEOUT_SECONDS,
    RUNTIME_TIMEOUT_MAX_SECONDS,
    RUNTIME_TIMEOUT_MIN_SECONDS,
    BackendConfig,
    SubagentSettings,
    get_consult_budget,
    load_subagent_settings,
    save_subagent_settings,
    settings_from_dict,
)
from cognivoy.services.subagent.partner import PARTNER_BACKEND_KIND
from cognivoy.services.subagent.registry import detect_all, get_backend, list_backend_kinds
from cognivoy.services.subagent.runtime import (
    SubagentCapacityError,
    SubagentOutputLimitError,
    SubagentQueueTimeoutError,
    SubagentTimeoutError,
    consult_with_timeout,
    get_subagent_resource_status,
)
from cognivoy.services.subagent.types import (
    ConsultResult,
    DetectResult,
    SubagentEvent,
)

__all__ = [
    "OnEvent",
    "SubagentBackend",
    "BackendConfig",
    "SubagentSettings",
    "DEFAULT_CONSULT_BUDGET",
    "CONSULT_BUDGET_MIN",
    "CONSULT_BUDGET_MAX",
    "DEFAULT_RUNTIME_TIMEOUT_SECONDS",
    "RUNTIME_TIMEOUT_MIN_SECONDS",
    "RUNTIME_TIMEOUT_MAX_SECONDS",
    "PARTNER_BACKEND_KIND",
    "get_consult_budget",
    "load_subagent_settings",
    "save_subagent_settings",
    "settings_from_dict",
    "detect_all",
    "get_backend",
    "list_backend_kinds",
    "SubagentTimeoutError",
    "SubagentCapacityError",
    "SubagentQueueTimeoutError",
    "SubagentOutputLimitError",
    "get_subagent_resource_status",
    "consult_with_timeout",
    "ConsultResult",
    "DetectResult",
    "SubagentEvent",
]
