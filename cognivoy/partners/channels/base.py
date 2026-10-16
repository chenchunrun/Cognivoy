"""Base channel interface for chat platforms."""

from __future__ import annotations

from abc import ABC, abstractmethod
import asyncio
from collections import deque
from pathlib import Path
import time
from typing import TYPE_CHECKING, Any

from cognivoy.partners.bus.events import InboundMessage, OutboundMessage
from cognivoy.partners.bus.queue import MessageBus

if TYPE_CHECKING:
    from cognivoy.services.coordination import SharedCoordinationStore


def _logger():
    from loguru import logger as _log

    return _log


class BaseChannel(ABC):
    """
    Abstract base class for chat channel implementations.

    Each channel (Telegram, Discord, etc.) should implement this interface
    to integrate with the TutorBot message bus.
    """

    name: str = "base"
    display_name: str = "Base"
    transcription_api_key: str = ""
    # Effective delivery flags for this channel instance; the manager resolves
    # them from the channel's own config at init time.
    send_progress: bool = True
    send_tool_hints: bool = True
    supports_inbound_attachments: bool = False
    supports_outbound_attachments: bool = False

    def __init__(self, config: Any, bus: MessageBus):
        """
        Initialize the channel.

        Args:
            config: Channel-specific configuration.
            bus: The message bus for communication.
        """
        self.config = config
        self.bus = bus
        self._running = False
        self._inbound_guard = asyncio.Lock()
        self._inbound_seen: dict[str, float] = {}
        self._inbound_windows: dict[str, deque[float]] = {}
        self._inbound_duplicates_dropped = 0
        self._inbound_rate_limited_dropped = 0
        self._coordination_scope = ""
        self._coordination_store: SharedCoordinationStore | None = None

    def configure_shared_coordination(
        self,
        scope: str,
        store: "SharedCoordinationStore | None" = None,
    ) -> None:
        """Share inbound idempotency and limits across channel workers."""
        from cognivoy.services.coordination import get_shared_coordination_store

        self._coordination_scope = str(scope).strip()
        self._coordination_store = store or get_shared_coordination_store()

    def _config_int(self, key: str, default: int, minimum: int, maximum: int) -> int:
        raw = (
            self.config.get(key, default)
            if isinstance(self.config, dict)
            else getattr(self.config, key, default)
        )
        try:
            return max(minimum, min(int(raw), maximum))
        except (TypeError, ValueError):
            return default

    @property
    def inbound_rate_limit_per_minute(self) -> int:
        return self._config_int("inbound_rate_limit_per_minute", 30, 1, 600)

    @property
    def inbound_dedupe_ttl_seconds(self) -> int:
        return self._config_int("inbound_dedupe_ttl_seconds", 86_400, 60, 604_800)

    @staticmethod
    def _platform_message_id(metadata: dict[str, Any]) -> str:
        """Extract an adapter's immutable upstream id without hashing content.

        Repeated user text must remain valid.  Only a platform-issued id is
        strong enough to suppress a delivery, so known nested channel payloads
        are traversed but arbitrary ``id`` fields are deliberately ignored.
        """
        identity_keys = (
            "message_id",
            "event_id",
            "activity_id",
            "post_id",
            "client_msg_id",
            "uid",
        )
        pending: list[dict[str, Any]] = [metadata]
        visited: set[int] = set()
        while pending:
            current = pending.pop(0)
            marker = id(current)
            if marker in visited:
                continue
            visited.add(marker)
            for key in identity_keys:
                value = current.get(key)
                if isinstance(value, (str, int)) and str(value).strip():
                    return str(value).strip()
            for value in current.values():
                if isinstance(value, dict):
                    pending.append(value)
        return ""

    async def _accept_inbound(
        self,
        *,
        sender_id: str,
        chat_id: str,
        metadata: dict[str, Any],
    ) -> tuple[bool, str]:
        """Apply uniform idempotency and a per-sender sliding-window limit."""
        message_id = self._platform_message_id(metadata)
        if self._coordination_store is not None and self._coordination_scope:
            dedupe_key = f"{chat_id}:{message_id}" if message_id else ""
            accepted, reason = await asyncio.to_thread(
                self._coordination_store.accept_inbound,
                namespace=f"partner:{self._coordination_scope}:{self.name}",
                dedupe_key=dedupe_key,
                rate_key=str(sender_id),
                rate_limit=self.inbound_rate_limit_per_minute,
                window_seconds=60.0,
                dedupe_ttl_seconds=float(self.inbound_dedupe_ttl_seconds),
            )
            if not accepted:
                if reason == "duplicate":
                    self._inbound_duplicates_dropped += 1
                elif reason == "rate_limited":
                    self._inbound_rate_limited_dropped += 1
                return False, reason
            return True, message_id

        now = time.monotonic()
        async with self._inbound_guard:
            ttl = self.inbound_dedupe_ttl_seconds
            cutoff = now - ttl
            if self._inbound_seen:
                self._inbound_seen = {
                    key: seen_at for key, seen_at in self._inbound_seen.items() if seen_at > cutoff
                }
            if message_id:
                dedupe_key = f"{self.name}:{chat_id}:{message_id}"
                if dedupe_key in self._inbound_seen:
                    self._inbound_duplicates_dropped += 1
                    return False, "duplicate"

            rate_key = str(sender_id)
            window = self._inbound_windows.setdefault(rate_key, deque())
            minute_ago = now - 60.0
            while window and window[0] <= minute_ago:
                window.popleft()
            if len(window) >= self.inbound_rate_limit_per_minute:
                self._inbound_rate_limited_dropped += 1
                return False, "rate_limited"

            window.append(now)
            if message_id:
                self._inbound_seen[dedupe_key] = now
            return True, message_id

    async def transcribe_audio(self, file_path: str | Path) -> str:
        """Transcribe an audio file via Groq Whisper. Returns empty string on failure."""
        if not self.transcription_api_key:
            return ""
        try:
            from cognivoy.partners.transcription import GroqTranscriptionProvider

            provider = GroqTranscriptionProvider(api_key=self.transcription_api_key)
            return await provider.transcribe(file_path)
        except Exception as e:
            _logger().warning("{}: audio transcription failed: {}", self.name, e)
            return ""

    @abstractmethod
    async def start(self) -> None:
        """
        Start the channel and begin listening for messages.

        This should be a long-running async task that:
        1. Connects to the chat platform
        2. Listens for incoming messages
        3. Forwards messages to the bus via _handle_message()
        """
        pass

    @abstractmethod
    async def stop(self) -> None:
        """Stop the channel and clean up resources."""
        pass

    @abstractmethod
    async def send(self, msg: OutboundMessage) -> None:
        """
        Send a message through this channel.

        Args:
            msg: The message to send.

        Implementations should raise on delivery failure so the channel
        manager can apply the retry policy in one place.
        """
        pass

    async def send_delta(
        self, chat_id: str, delta: str, metadata: dict[str, Any] | None = None
    ) -> None:
        """Deliver a streaming text chunk.

        Override in subclasses to enable streaming (in-place message edits).
        Implementations should raise on delivery failure so the channel
        manager can retry.

        Streaming contract: ``_stream_delta`` marks a chunk, ``_stream_end``
        ends the current segment, and stateful implementations must key
        buffers by ``_stream_id`` rather than only by ``chat_id``.
        """
        pass

    @property
    def supports_streaming(self) -> bool:
        """True when config enables streaming AND this subclass implements send_delta."""
        cfg = self.config
        streaming = (
            cfg.get("streaming", False)
            if isinstance(cfg, dict)
            else getattr(cfg, "streaming", False)
        )
        return bool(streaming) and type(self).send_delta is not BaseChannel.send_delta

    def is_allowed(self, sender_id: str) -> bool:
        """Check if *sender_id* is permitted.  Empty list → deny all; ``"*"`` → allow all."""
        allow_list = getattr(self.config, "allow_from", [])
        if not allow_list:
            _logger().warning("{}: allow_from is empty — all access denied", self.name)
            return False
        if "*" in allow_list:
            return True
        return str(sender_id) in allow_list

    async def _handle_message(
        self,
        sender_id: str,
        chat_id: str,
        content: str,
        media: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        session_key: str | None = None,
    ) -> None:
        """
        Handle an incoming message from the chat platform.

        This method checks permissions and forwards to the bus.

        Args:
            sender_id: The sender's identifier.
            chat_id: The chat/channel identifier.
            content: Message text content.
            media: Optional list of media URLs.
            metadata: Optional channel-specific metadata.
            session_key: Optional session key override (e.g. thread-scoped sessions).
        """
        if not self.is_allowed(sender_id):
            _logger().warning(
                "Access denied for sender {} on channel {}. "
                "Add them to allowFrom list in config to grant access.",
                sender_id,
                self.name,
            )
            return

        meta = dict(metadata or {})
        accepted, identity = await self._accept_inbound(
            sender_id=str(sender_id),
            chat_id=str(chat_id),
            metadata=meta,
        )
        if not accepted:
            _logger().warning(
                "Dropped {} inbound delivery from {} on channel {}",
                identity,
                sender_id,
                self.name,
            )
            return
        if identity:
            # Normalize nested platform payloads for downstream reply
            # correlation and outbound duplicate suppression.
            meta.setdefault("message_id", identity)
        if self.supports_streaming and self.send_progress:
            # The runner streams reply text live only when asked to. Streaming
            # requires send_progress: narration rounds stream as they happen,
            # so with progress muted we fall back to buffered delivery.
            meta = {**meta, "_wants_stream": True}

        msg = InboundMessage(
            channel=self.name,
            sender_id=str(sender_id),
            chat_id=str(chat_id),
            content=content,
            media=media or [],
            metadata=meta,
            session_key_override=session_key,
        )

        await self.bus.publish_inbound(msg)

    @classmethod
    def default_config(cls) -> dict[str, Any]:
        """Return default config for onboard. Override in plugins to auto-populate config.json."""
        return {"enabled": False}

    @property
    def is_running(self) -> bool:
        """Check if the channel is running."""
        return self._running

    async def health(self) -> dict[str, Any]:
        """Return the uniform, secret-free channel readiness contract.

        Adapters may override this to perform a bounded upstream probe.  The
        default is deliberately honest: it reports local listener state and
        explicitly declares optional transport capabilities instead of
        pretending every integration has attachment or streaming parity.
        """
        return {
            "status": "healthy" if self._running else "stopped",
            "running": self._running,
            "capabilities": {
                "text": True,
                "inbound_attachments": self.supports_inbound_attachments,
                "outbound_attachments": self.supports_outbound_attachments,
                "streaming": self.supports_streaming,
            },
            "inbound_reliability": {
                "duplicates_dropped": self._inbound_duplicates_dropped,
                "rate_limited_dropped": self._inbound_rate_limited_dropped,
                "rate_limit_per_minute": self.inbound_rate_limit_per_minute,
                "dedupe_ttl_seconds": self.inbound_dedupe_ttl_seconds,
            },
        }
