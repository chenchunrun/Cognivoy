"""Configuration schema — Pydantic models for partner channels."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Base(BaseModel):
    """Base model that accepts both camelCase and snake_case keys."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class DeliveryOverrides(Base):
    """Per-channel delivery switches."""

    send_progress: bool = Field(
        default=True,
        description="Deliver agent narration progress to this channel.",
    )
    send_tool_hints: bool = Field(
        default=True,
        description="Deliver one-line tool-call hints to this channel.",
    )
    inbound_rate_limit_per_minute: int = Field(
        default=30,
        ge=1,
        le=600,
        description=(
            "Maximum accepted inbound messages per sender in a sliding minute. "
            "The limit is isolated per channel instance."
        ),
    )
    inbound_dedupe_ttl_seconds: int = Field(
        default=86_400,
        ge=60,
        le=604_800,
        description="How long platform message ids remain protected from redelivery.",
    )


class StreamingSupport(Base):
    """Opt-in live streaming for channels that can edit messages in place."""

    streaming: bool = Field(
        default=False,
        description=(
            "Stream replies live by editing the message in place as text arrives. "
            "Requires send_progress: narration rounds stream as they happen."
        ),
    )


class ChannelsConfig(Base):
    """Configuration for chat channels.

    Built-in and plugin channel configs are stored as extra fields (dicts).
    Each channel parses its own config in __init__.
    """

    model_config = ConfigDict(extra="allow")

    # Outbound delivery failures retry with exponential backoff (1s/2s/4s…).
    send_max_retries: int = 3
