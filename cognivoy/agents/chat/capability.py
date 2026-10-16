"""Agentic chat capability."""

from __future__ import annotations

from cognivoy.agents.chat.agentic_pipeline import CHAT_OPTIONAL_TOOLS, AgenticChatPipeline
from cognivoy.core.capability_protocol import BaseCapability, CapabilityManifest
from cognivoy.core.context import UnifiedContext
from cognivoy.core.stream_bus import StreamBus
from cognivoy.runtime.request_contracts import get_capability_request_schema


class ChatCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="chat",
        description=(
            "Agentic chat: an exploring agent loop with tools, followed by "
            "a respond stage that streams the answer."
        ),
        stages=["exploring", "responding"],
        tools_used=CHAT_OPTIONAL_TOOLS,
        cli_aliases=["chat"],
        request_schema=get_capability_request_schema("chat"),
    )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        pipeline = AgenticChatPipeline(language=context.language, adaptive_rounds=True)
        await pipeline.run(context, stream)
