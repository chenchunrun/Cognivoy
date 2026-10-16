"""Chat channels module with plugin architecture."""

from cognivoy.partners.channels.base import BaseChannel
from cognivoy.partners.channels.manager import ChannelManager

__all__ = ["BaseChannel", "ChannelManager"]
