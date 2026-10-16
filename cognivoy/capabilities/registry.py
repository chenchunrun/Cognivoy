"""Built-in loop-capability registry."""

from __future__ import annotations

from cognivoy.capabilities.explore_context import ExploreContextCapability
from cognivoy.capabilities.mastery import MasteryLoopCapability
from cognivoy.capabilities.obsidian import ObsidianCapability
from cognivoy.capabilities.protocol import LoopCapability
from cognivoy.capabilities.solve import SolveLoopCapability
from cognivoy.capabilities.subagent import SubagentCapability
from cognivoy.core.context import UnifiedContext

LOOP_CAPABILITIES: tuple[LoopCapability, ...] = (
    MasteryLoopCapability(),
    SolveLoopCapability(),
    ObsidianCapability(),
    SubagentCapability(),
    ExploreContextCapability(),
)


def active_loop_capabilities(context: UnifiedContext) -> tuple[LoopCapability, ...]:
    """Return the loop capabilities active for this turn in stable registry order."""
    return tuple(cap for cap in LOOP_CAPABILITIES if cap.is_active(context))


def any_exclusive_capability_active(context: UnifiedContext) -> bool:
    """Whether an active capability *replaces* the tool surface (knowledge category).

    Drives the pipeline's exclusive-tools branch and the suppression of rag
    scaffolding (KB seed / kb note) — the turn runs only on the capability's
    own tools. ``getattr`` default keeps plain capabilities (solve / mastery)
    out of this path.
    """
    return any(getattr(cap, "exclusive_tools", False) for cap in active_loop_capabilities(context))


def capability_tool_owners() -> dict[str, str]:
    """Map each capability-owned tool name to its owning capability name.

    Static (independent of any turn) so the settings UI can group capability
    tools under their owner. Built-in/system tools are absent from the map.
    """
    return {name: cap.name for cap in LOOP_CAPABILITIES for name in cap.owned_tools}


__all__ = [
    "LOOP_CAPABILITIES",
    "active_loop_capabilities",
    "any_exclusive_capability_active",
    "capability_tool_owners",
]
