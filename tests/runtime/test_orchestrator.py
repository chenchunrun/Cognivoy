"""Tests for ChatOrchestrator routing and lifecycle."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from cognivoy.core.capability_protocol import BaseCapability, CapabilityManifest
from cognivoy.core.context import UnifiedContext
from cognivoy.core.stream import StreamEvent, StreamEventType
from cognivoy.core.stream_bus import StreamBus
from cognivoy.runtime.orchestrator import ChatOrchestrator, _turn_timeout_seconds


@pytest.fixture(autouse=True)
def _patch_event_bus():
    """Prevent EventBus background processor from running during tests."""
    mock_bus = MagicMock()
    mock_bus.publish = AsyncMock()
    with patch("cognivoy.runtime.orchestrator.get_event_bus", return_value=mock_bus):
        yield
    from cognivoy.events.event_bus import EventBus

    EventBus.reset()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _EchoCapability(BaseCapability):
    """Minimal capability that echoes the user message."""

    manifest = CapabilityManifest(
        name="echo",
        description="Echoes back user message.",
        stages=["responding"],
    )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        await stream.content(context.user_message, source=self.name)


class _FailingCapability(BaseCapability):
    """Capability that raises."""

    manifest = CapabilityManifest(name="fail", description="Always fails.")

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        raise RuntimeError("intentional failure")


class _StalledCapability(BaseCapability):
    manifest = CapabilityManifest(name="stall", description="Never finishes.")

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        await asyncio.Event().wait()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "capability", ["visualize", "chat", "mastery_path", "deep_solve", "deep_question"]
)
async def test_generation_failure_is_retryable_and_never_completed(capability):
    from cognivoy.core.errors import CapabilityGenerationError

    class EmptyGeneration(BaseCapability):
        manifest = CapabilityManifest(name=capability, description="Synthetic empty generation")

        async def run(self, context, stream):
            raise CapabilityGenerationError(
                "No usable output. Please retry.", reason="empty_output"
            )

    orch = _make_orchestrator({capability: EmptyGeneration()})
    events = [
        e
        async for e in orch.handle(
            UnifiedContext(user_message="test", active_capability=capability)
        )
    ]
    error = next(e for e in events if e.type == StreamEventType.ERROR)
    assert error.metadata["turn_terminal"] is True
    assert error.metadata["retryable"] is True
    assert error.metadata["reason"] == "empty_output"
    assert events[-1].metadata["status"] == "failed"
    assert not any(e.type == StreamEventType.RESULT for e in events)


class _PauseThenFinishCapability(BaseCapability):
    manifest = CapabilityManifest(name="pause", description="Waits for a user reply.")

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        waiter = context.metadata["wait_for_user_reply"]
        await waiter()
        await asyncio.sleep(0.005)
        await stream.content("continued", source=self.name)


def _make_orchestrator(
    capabilities: dict[str, BaseCapability] | None = None,
) -> ChatOrchestrator:
    """Build an orchestrator with fake registries."""
    cap_reg = MagicMock()
    cap_map = capabilities or {}
    cap_reg.get = lambda name: cap_map.get(name)
    cap_reg.list_capabilities = lambda: list(cap_map.keys())

    tool_reg = MagicMock()
    tool_reg.list_tools = MagicMock(return_value=[])
    tool_reg.build_openai_schemas = MagicMock(return_value=[])

    orch = ChatOrchestrator.__new__(ChatOrchestrator)
    orch._cap_registry = cap_reg
    orch._tool_registry = tool_reg
    return orch


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


class TestOrchestratorRouting:
    @pytest.mark.asyncio
    async def test_routes_to_active_capability(self) -> None:
        echo = _EchoCapability()
        orch = _make_orchestrator({"echo": echo})

        ctx = UnifiedContext(
            user_message="ping",
            active_capability="echo",
        )
        events: list[StreamEvent] = []
        async for event in orch.handle(ctx):
            events.append(event)

        types = [e.type for e in events]
        assert StreamEventType.SESSION in types
        assert StreamEventType.CONTENT in types
        assert StreamEventType.DONE in types

        content_events = [e for e in events if e.type == StreamEventType.CONTENT]
        assert content_events[0].content == "ping"

    @pytest.mark.asyncio
    async def test_defaults_to_chat_capability(self) -> None:
        chat_cap = _EchoCapability()
        chat_cap.manifest = CapabilityManifest(
            name="chat", description="Default chat.", stages=["responding"]
        )
        orch = _make_orchestrator({"chat": chat_cap})

        ctx = UnifiedContext(user_message="hello")
        events: list[StreamEvent] = []
        async for event in orch.handle(ctx):
            events.append(event)

        content_events = [e for e in events if e.type == StreamEventType.CONTENT]
        assert len(content_events) == 1
        assert content_events[0].content == "hello"

    @pytest.mark.asyncio
    async def test_auto_mode_routes_before_capability_lookup(self) -> None:
        solve_cap = _EchoCapability()
        solve_cap.manifest = CapabilityManifest(name="deep_solve", description="solve")
        orch = _make_orchestrator({"deep_solve": solve_cap})
        ctx = UnifiedContext(user_message="求解 x²=4", active_capability="auto", language="zh")

        events = [event async for event in orch.handle(ctx)]

        assert ctx.active_capability == "deep_solve"
        assert any(event.type == StreamEventType.CONTENT for event in events)

    @pytest.mark.asyncio
    async def test_unknown_capability_yields_error(self) -> None:
        orch = _make_orchestrator({})

        ctx = UnifiedContext(
            user_message="hi",
            active_capability="nonexistent",
        )
        events: list[StreamEvent] = []
        async for event in orch.handle(ctx):
            events.append(event)

        error_events = [e for e in events if e.type == StreamEventType.ERROR]
        assert len(error_events) == 1
        assert "Unknown capability" in error_events[0].content
        assert error_events[0].metadata == {
            "turn_terminal": True,
            "status": "failed",
        }
        done_events = [e for e in events if e.type == StreamEventType.DONE]
        assert len(done_events) == 1
        assert done_events[0].metadata["status"] == "failed"

    @pytest.mark.asyncio
    async def test_control_plane_denies_capability_before_it_runs(self) -> None:
        echo = _EchoCapability()
        orch = _make_orchestrator({"echo": echo})
        ctx = UnifiedContext(
            user_message="ping",
            active_capability="echo",
            metadata={"allowed_capabilities": ["chat"]},
        )

        events = [event async for event in orch.handle(ctx)]

        assert not any(event.type == StreamEventType.CONTENT for event in events)
        error = next(event for event in events if event.type == StreamEventType.ERROR)
        done = next(event for event in events if event.type == StreamEventType.DONE)
        assert error.metadata["status"] == "denied"
        assert error.metadata["policy_rule_id"] == "capability.allowlist"
        assert done.metadata["status"] == "denied"


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


class TestOrchestratorErrorHandling:
    def test_long_running_capabilities_have_extended_total_budgets(self) -> None:
        context = UnifiedContext(user_message="test")
        assert _turn_timeout_seconds(context, "chat") == 180
        assert _turn_timeout_seconds(context, "deep_question") == 180
        assert _turn_timeout_seconds(context, "visualize") == 300
        assert _turn_timeout_seconds(context, "deep_research") == 600
        assert _turn_timeout_seconds(context, "math_animator") == 600

    @pytest.mark.asyncio
    async def test_capability_exception_yields_error_event(self) -> None:
        fail_cap = _FailingCapability()
        orch = _make_orchestrator({"fail": fail_cap})

        ctx = UnifiedContext(
            user_message="boom",
            active_capability="fail",
        )
        events: list[StreamEvent] = []
        async for event in orch.handle(ctx):
            events.append(event)

        error_events = [e for e in events if e.type == StreamEventType.ERROR]
        assert len(error_events) == 1
        assert "intentional failure" in error_events[0].content
        assert error_events[0].metadata == {
            "turn_terminal": True,
            "status": "failed",
        }

        done_events = [e for e in events if e.type == StreamEventType.DONE]
        assert len(done_events) == 1
        assert done_events[0].metadata["status"] == "failed"

    @pytest.mark.asyncio
    async def test_total_timeout_is_localized_retryable_and_terminal(self, monkeypatch) -> None:
        monkeypatch.setattr(
            "cognivoy.runtime.orchestrator._turn_timeout_seconds",
            lambda _context, _capability: 0.01,
        )
        orch = _make_orchestrator({"stall": _StalledCapability()})
        ctx = UnifiedContext(
            user_message="等待",
            active_capability="stall",
            language="zh",
            config_overrides={"total_timeout_seconds": 0.01},
        )
        events = [event async for event in orch.handle(ctx)]

        error = next(event for event in events if event.type == StreamEventType.ERROR)
        done = next(event for event in events if event.type == StreamEventType.DONE)
        assert "运行上限" in error.content
        assert error.metadata["status"] == "timed_out"
        assert error.metadata["retryable"] is True
        assert done.metadata["status"] == "timed_out"

    @pytest.mark.asyncio
    async def test_user_reply_wait_does_not_consume_runtime_budget(self) -> None:
        queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        pause_event = asyncio.Event()
        resume_event = asyncio.Event()
        resume_event.set()

        async def waiter() -> dict[str, str]:
            resume_event.clear()
            pause_event.set()
            try:
                return await queue.get()
            finally:
                pause_event.clear()
                resume_event.set()

        orch = _make_orchestrator({"pause": _PauseThenFinishCapability()})
        ctx = UnifiedContext(
            user_message="ask",
            active_capability="pause",
            config_overrides={"total_timeout_seconds": 0.02},
            metadata={
                "wait_for_user_reply": waiter,
                "user_input_pause_event": pause_event,
                "user_input_resume_event": resume_event,
            },
        )

        async def reply_later() -> None:
            await asyncio.sleep(0.05)  # longer than the active 20ms budget
            await queue.put({"text": "answer"})

        reply_task = asyncio.create_task(reply_later())
        events = [event async for event in orch.handle(ctx)]
        await reply_task
        assert any(event.content == "continued" for event in events)
        done = next(event for event in events if event.type == StreamEventType.DONE)
        assert done.metadata["status"] == "completed"


# ---------------------------------------------------------------------------
# Session ID management
# ---------------------------------------------------------------------------


class TestOrchestratorSessionId:
    @pytest.mark.asyncio
    async def test_assigns_session_id_if_missing(self) -> None:
        echo = _EchoCapability()
        orch = _make_orchestrator({"echo": echo})

        ctx = UnifiedContext(user_message="test", active_capability="echo")
        assert ctx.session_id == ""

        async for _ in orch.handle(ctx):
            pass

        assert ctx.session_id != ""

    @pytest.mark.asyncio
    async def test_current_message_language_overrides_saved_fallback(self) -> None:
        echo = _EchoCapability()
        orch = _make_orchestrator({"echo": echo})
        ctx = UnifiedContext(
            user_message="请解释后训练",
            active_capability="echo",
            language="en",
        )
        _ = [event async for event in orch.handle(ctx)]
        assert ctx.language == "zh"

    @pytest.mark.asyncio
    async def test_preserves_existing_session_id(self) -> None:
        echo = _EchoCapability()
        orch = _make_orchestrator({"echo": echo})

        ctx = UnifiedContext(
            session_id="my-session",
            user_message="test",
            active_capability="echo",
        )
        async for _ in orch.handle(ctx):
            pass

        assert ctx.session_id == "my-session"


# ---------------------------------------------------------------------------
# List helpers
# ---------------------------------------------------------------------------


class TestOrchestratorHelpers:
    def test_list_tools(self) -> None:
        orch = _make_orchestrator()
        assert orch.list_tools() == []

    def test_list_capabilities(self) -> None:
        echo = _EchoCapability()
        orch = _make_orchestrator({"echo": echo})
        assert orch.list_capabilities() == ["echo"]

    def test_get_tool_schemas(self) -> None:
        orch = _make_orchestrator()
        schemas = orch.get_tool_schemas()
        assert isinstance(schemas, list)
