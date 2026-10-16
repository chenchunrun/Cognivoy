"""Message bus module for decoupled channel-agent communication."""

from cognivoy.partners.bus.events import InboundMessage, OutboundMessage
from cognivoy.partners.bus.queue import MessageBus

__all__ = ["MessageBus", "InboundMessage", "OutboundMessage"]
