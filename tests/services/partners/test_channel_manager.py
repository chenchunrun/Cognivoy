"""Unit tests for TutorBot channel dispatch behavior."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cognivoy.partners.bus.events import OutboundMessage
from cognivoy.partners.bus.queue import MessageBus
from cognivoy.partners.channels.base import BaseChannel
from cognivoy.partners.channels.dead_letter import DeadLetterStore
from cognivoy.partners.channels.manager import ChannelConfigurationError, ChannelManager
from cognivoy.partners.config.schema import ChannelsConfig
from cognivoy.services.coordination import SharedCoordinationStore


class _OneShotBus:
    def __init__(self, msg: OutboundMessage):
        self._msg = msg
        self._calls = 0

    async def consume_outbound(self) -> OutboundMessage:
        self._calls += 1
        if self._calls == 1:
            return self._msg
        raise asyncio.CancelledError


class _DummyChannel:
    def __init__(self):
        self.send = AsyncMock()
        self.send_delta = AsyncMock()
        # Effective flags normally set by ChannelManager._init_channels
        # from the per-channel config.
        self.send_progress = True
        self.send_tool_hints = True
        self._running = True

    async def health(self):
        return {
            "status": "healthy",
            "running": True,
            "capabilities": {
                "text": True,
                "inbound_attachments": False,
                "outbound_attachments": False,
                "streaming": False,
            },
        }


class _InboundChannel(BaseChannel):
    name = "test"

    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False

    async def send(self, msg: OutboundMessage) -> None:
        del msg


def _inbound_channel(*, limit: int = 30, ttl: int = 86_400):
    bus = MessageBus()
    config = SimpleNamespace(
        allow_from=["*"],
        inbound_rate_limit_per_minute=limit,
        inbound_dedupe_ttl_seconds=ttl,
    )
    return _InboundChannel(config, bus), bus


async def _dispatch_one(
    msg: OutboundMessage,
    *,
    send_progress: bool = True,
    send_tool_hints: bool = True,
    config: ChannelsConfig | None = None,
) -> _DummyChannel:
    channel = _DummyChannel()
    channel.send_progress = send_progress
    channel.send_tool_hints = send_tool_hints
    manager = ChannelManager(config or ChannelsConfig(), _OneShotBus(msg))  # type: ignore[arg-type]
    manager.channels = {msg.channel: channel}  # type: ignore[dict-item]

    await manager._dispatch_outbound()
    return channel


class TestChannelManagerToolHints:
    @pytest.mark.asyncio
    async def test_tool_hint_progress_skipped_by_default(self):
        msg = OutboundMessage(
            channel="zulip",
            chat_id="pm:42",
            content='message("Hello")',
            metadata={"_progress": True, "_tool_hint": True},
        )

        channel = await _dispatch_one(msg, send_tool_hints=False)

        channel.send.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_tool_hint_progress_dispatched_when_enabled(self):
        msg = OutboundMessage(
            channel="zulip",
            chat_id="pm:42",
            content='message("Hello")',
            metadata={"_progress": True, "_tool_hint": True},
        )

        channel = await _dispatch_one(msg, send_tool_hints=True)

        channel.send.assert_awaited_once_with(msg)


class _MultiShotBus:
    """Bus stub that yields queued messages then cancels the dispatcher.

    Messages live in ``outbound`` (a real queue) so the manager's delta
    coalescing — which drains ``bus.outbound`` directly — sees them too.
    """

    def __init__(self, msgs: list[OutboundMessage]):
        self.outbound = asyncio.Queue()
        for m in msgs:
            self.outbound.put_nowait(m)

    async def consume_outbound(self) -> OutboundMessage:
        try:
            return self.outbound.get_nowait()
        except asyncio.QueueEmpty:
            raise asyncio.CancelledError from None


async def _dispatch_many(
    msgs: list[OutboundMessage], config: ChannelsConfig | None = None
) -> _DummyChannel:
    channel = _DummyChannel()
    manager = ChannelManager(config or ChannelsConfig(), _MultiShotBus(msgs))  # type: ignore[arg-type]
    manager.channels = {msgs[0].channel: channel}  # type: ignore[dict-item]
    await manager._dispatch_outbound()
    return channel


class TestSendRetry:
    @pytest.mark.asyncio
    async def test_send_retries_on_failure_then_succeeds(self, monkeypatch):
        monkeypatch.setattr("cognivoy.partners.channels.manager._SEND_RETRY_DELAYS", (0, 0, 0))
        msg = OutboundMessage(channel="zulip", chat_id="1", content="hi")
        channel = _DummyChannel()
        channel.send.side_effect = [RuntimeError("boom"), None]
        manager = ChannelManager(ChannelsConfig(), _MultiShotBus([]))  # type: ignore[arg-type]

        await manager._send_with_retry(channel, msg)  # type: ignore[arg-type]

        assert channel.send.await_count == 2

    @pytest.mark.asyncio
    async def test_send_gives_up_after_max_retries(self, monkeypatch):
        monkeypatch.setattr("cognivoy.partners.channels.manager._SEND_RETRY_DELAYS", (0, 0, 0))
        msg = OutboundMessage(channel="zulip", chat_id="1", content="hi")
        channel = _DummyChannel()
        channel.send.side_effect = RuntimeError("boom")
        manager = ChannelManager(
            ChannelsConfig(send_max_retries=2),
            _MultiShotBus([]),  # type: ignore[arg-type]
        )

        await manager._send_with_retry(channel, msg)  # type: ignore[arg-type]

        assert channel.send.await_count == 2

    @pytest.mark.asyncio
    async def test_send_exhaustion_is_persisted_for_recovery(self, monkeypatch, tmp_path):
        monkeypatch.setattr("cognivoy.partners.channels.manager._SEND_RETRY_DELAYS", (0, 0, 0))
        msg = OutboundMessage(
            channel="zulip",
            chat_id="1",
            content="important answer",
            metadata={"origin_message_id": "origin-1"},
        )
        channel = _DummyChannel()
        channel.send.side_effect = RuntimeError("upstream unavailable")
        store = DeadLetterStore(tmp_path / "outbound.jsonl")
        manager = ChannelManager(
            ChannelsConfig(send_max_retries=2),
            _MultiShotBus([]),  # type: ignore[arg-type]
            dead_letter_store=store,
        )

        delivered = await manager._send_with_retry(channel, msg)  # type: ignore[arg-type]

        assert delivered is False
        records = store.list_records()
        assert len(records) == 1
        assert records[0]["channel"] == "zulip"
        assert records[0]["content"] == "important answer"
        assert records[0]["attempts"] == 2
        assert records[0]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_dead_letter_can_be_replayed_and_resolved(self, monkeypatch, tmp_path):
        monkeypatch.setattr("cognivoy.partners.channels.manager._SEND_RETRY_DELAYS", (0,))
        store = DeadLetterStore(tmp_path / "outbound.jsonl")
        failed = store.append(
            OutboundMessage(
                channel="zulip",
                chat_id="room-1",
                content="recover me",
                media=["/tmp/result.pdf"],
                metadata={"origin_message_id": "origin-1"},
            ),
            attempts=3,
            error=RuntimeError("offline"),
        )
        channel = _DummyChannel()
        manager = ChannelManager(
            ChannelsConfig(send_max_retries=1),
            _MultiShotBus([]),  # type: ignore[arg-type]
            dead_letter_store=store,
        )
        manager.channels = {"zulip": channel}  # type: ignore[dict-item]

        replayed = await manager.retry_dead_letter(failed["id"])

        assert replayed["status"] == "replayed"
        channel.send.assert_awaited_once()
        sent = channel.send.await_args.args[0]
        assert sent.content == "recover me"
        assert sent.media == ["/tmp/result.pdf"]
        assert store.list_records(status="pending") == []

    def test_dead_letter_can_be_acknowledged_without_replay(self, tmp_path):
        store = DeadLetterStore(tmp_path / "outbound.jsonl")
        failed = store.append(
            OutboundMessage(channel="email", chat_id="u@example.com", content="old"),
            attempts=2,
            error=RuntimeError("mailbox gone"),
        )

        resolved = store.resolve(failed["id"], status="discarded", note="recipient removed")

        assert resolved["status"] == "discarded"
        assert resolved["resolution_note"] == "recipient removed"
        assert store.list_records(status="pending") == []

    def test_two_store_instances_preserve_concurrent_resolutions(self, tmp_path):
        path = tmp_path / "outbound.jsonl"
        seed = DeadLetterStore(path)
        first_record = seed.append(
            OutboundMessage(channel="email", chat_id="one@example.com", content="one"),
            attempts=2,
            error=RuntimeError("offline"),
        )
        second_record = seed.append(
            OutboundMessage(channel="email", chat_id="two@example.com", content="two"),
            attempts=2,
            error=RuntimeError("offline"),
        )
        first = DeadLetterStore(path)
        second = DeadLetterStore(path)
        barrier = threading.Barrier(2)

        def pause_after_read(store):
            original = store._read_unlocked

            def paused():
                rows = original()
                try:
                    barrier.wait(timeout=0.2)
                except threading.BrokenBarrierError:
                    pass
                return rows

            store._read_unlocked = paused

        pause_after_read(first)
        pause_after_read(second)
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = [
                pool.submit(
                    first.resolve,
                    first_record["id"],
                    status="discarded",
                    note="invalid recipient",
                ),
                pool.submit(
                    second.resolve,
                    second_record["id"],
                    status="replayed",
                    note="delivery restored",
                ),
            ]
            for outcome in outcomes:
                outcome.result(timeout=2)

        by_id = {row["id"]: row for row in DeadLetterStore(path).list_records()}
        assert by_id[first_record["id"]]["status"] == "discarded"
        assert by_id[second_record["id"]]["status"] == "replayed"


class TestChannelHealthContract:
    @pytest.mark.asyncio
    async def test_status_exposes_uniform_health_and_capabilities(self):
        manager = ChannelManager(ChannelsConfig(), _MultiShotBus([]))  # type: ignore[arg-type]
        manager.channels = {"zulip": _DummyChannel()}  # type: ignore[dict-item]

        status = await manager.get_status()

        assert status["zulip"]["status"] == "healthy"
        assert status["zulip"]["capabilities"]["text"] is True
        assert status["zulip"]["capabilities"]["outbound_attachments"] is False


class TestDuplicateSuppression:
    @pytest.mark.asyncio
    async def test_same_reply_to_same_origin_suppressed(self):
        meta = {"origin_message_id": "m1"}
        msgs = [
            OutboundMessage(channel="zulip", chat_id="1", content="same", metadata=dict(meta)),
            OutboundMessage(channel="zulip", chat_id="1", content="same", metadata=dict(meta)),
        ]
        channel = await _dispatch_many(msgs)
        assert channel.send.await_count == 1

    @pytest.mark.asyncio
    async def test_same_reply_to_different_origin_delivered(self):
        msgs = [
            OutboundMessage(
                channel="zulip",
                chat_id="1",
                content="same",
                metadata={"origin_message_id": "m1"},
            ),
            OutboundMessage(
                channel="zulip",
                chat_id="1",
                content="same",
                metadata={"origin_message_id": "m2"},
            ),
        ]
        channel = await _dispatch_many(msgs)
        assert channel.send.await_count == 2


class TestInboundReliability:
    @pytest.mark.asyncio
    async def test_message_id_redelivery_is_suppressed_but_distinct_ids_survive(self):
        channel, bus = _inbound_channel()

        await channel._handle_message("u1", "c1", "same", metadata={"message_id": "m1"})
        await channel._handle_message("u1", "c1", "same", metadata={"message_id": "m1"})
        await channel._handle_message("u1", "c1", "same", metadata={"message_id": "m2"})

        assert bus.inbound_size == 2
        first = await bus.consume_inbound()
        second = await bus.consume_inbound()
        assert first.metadata["message_id"] == "m1"
        assert second.metadata["message_id"] == "m2"
        health = await channel.health()
        assert health["inbound_reliability"]["duplicates_dropped"] == 1

    @pytest.mark.asyncio
    async def test_nested_platform_message_ids_share_the_same_dedupe_contract(self):
        channel, bus = _inbound_channel()
        slack = {"slack": {"event": {"client_msg_id": "slack-1", "ts": "1.0"}}}
        teams = {"msteams": {"activity_id": "teams-1"}}
        mattermost = {"mattermost": {"post_id": "post-1"}}

        for metadata in (slack, slack, teams, teams, mattermost, mattermost):
            await channel._handle_message("u1", "c1", "hello", metadata=metadata)

        assert bus.inbound_size == 3

    @pytest.mark.asyncio
    async def test_rate_limit_is_per_sender_and_channel_instance(self):
        channel, bus = _inbound_channel(limit=2)

        for index in range(3):
            await channel._handle_message(
                "noisy", "c1", f"message {index}", metadata={"message_id": f"n{index}"}
            )
        await channel._handle_message("other", "c1", "allowed", metadata={"message_id": "other-1"})

        assert bus.inbound_size == 3
        health = await channel.health()
        reliability = health["inbound_reliability"]
        assert reliability["rate_limited_dropped"] == 1
        assert reliability["rate_limit_per_minute"] == 2
        assert reliability["dedupe_ttl_seconds"] == 86_400

    @pytest.mark.asyncio
    async def test_dedupe_and_rate_limit_are_shared_for_partner_workers(self, tmp_path):
        store = SharedCoordinationStore(tmp_path / "coordination.sqlite3")
        first, first_bus = _inbound_channel(limit=2)
        second, second_bus = _inbound_channel(limit=2)
        first.configure_shared_coordination("partner-1", store)
        second.configure_shared_coordination("partner-1", store)

        await first._handle_message("u1", "c1", "first", metadata={"message_id": "shared-1"})
        await second._handle_message("u1", "c1", "duplicate", metadata={"message_id": "shared-1"})
        await second._handle_message("u1", "c1", "second", metadata={"message_id": "shared-2"})
        await first._handle_message("u1", "c1", "limited", metadata={"message_id": "shared-3"})

        assert first_bus.inbound_size == 1
        assert second_bus.inbound_size == 1
        assert (await second.health())["inbound_reliability"]["duplicates_dropped"] == 1
        assert (await first.health())["inbound_reliability"]["rate_limited_dropped"] == 1


class TestStreamDispatch:
    @pytest.mark.asyncio
    async def test_consecutive_deltas_coalesce(self):
        sid = {"_stream_delta": True, "_stream_id": "t:1"}
        msgs = [
            OutboundMessage(channel="zulip", chat_id="1", content="a", metadata=dict(sid)),
            OutboundMessage(channel="zulip", chat_id="1", content="b", metadata=dict(sid)),
            OutboundMessage(channel="zulip", chat_id="1", content="c", metadata=dict(sid)),
        ]
        channel = await _dispatch_many(msgs)
        # First delta waits on the queue; the rest coalesce into one edit.
        assert channel.send_delta.await_count <= 2
        total = "".join(c.args[1] for c in channel.send_delta.await_args_list)
        assert total == "abc"
        channel.send.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_stream_end_routed_to_send_delta(self):
        msgs = [
            OutboundMessage(
                channel="zulip",
                chat_id="1",
                content="",
                metadata={"_stream_end": True, "_stream_id": "t:1"},
            ),
        ]
        channel = await _dispatch_many(msgs)
        channel.send_delta.assert_awaited_once()
        channel.send.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_streamed_final_skips_plain_send(self):
        msgs = [
            OutboundMessage(
                channel="zulip",
                chat_id="1",
                content="final",
                metadata={"_streamed": True},
            ),
        ]
        channel = await _dispatch_many(msgs)
        channel.send.assert_not_awaited()
        channel.send_delta.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_deltas_of_different_streams_not_merged(self):
        msgs = [
            OutboundMessage(
                channel="zulip",
                chat_id="1",
                content="a",
                metadata={"_stream_delta": True, "_stream_id": "t:1"},
            ),
            OutboundMessage(
                channel="zulip",
                chat_id="1",
                content="b",
                metadata={"_stream_delta": True, "_stream_id": "t:2"},
            ),
        ]
        channel = await _dispatch_many(msgs)
        assert channel.send_delta.await_count == 2
        chunks = [c.args[1] for c in channel.send_delta.await_args_list]
        assert chunks == ["a", "b"]


def test_channel_registry_discovers_builtin_channels() -> None:
    from cognivoy.partners.channels.base import BaseChannel
    from cognivoy.partners.channels.registry import discover_all, discover_channel_names

    names = set(discover_channel_names())
    assert {"telegram", "slack", "discord", "zulip"} <= names

    channels = discover_all()
    assert {"telegram", "slack", "discord", "zulip"} <= set(channels)
    assert all(issubclass(cls, BaseChannel) for cls in channels.values())


def test_strict_channel_validation_raises_domain_error_not_system_exit() -> None:
    with pytest.raises(ChannelConfigurationError, match="empty allowFrom"):
        ChannelManager(
            ChannelsConfig(telegram={"enabled": True, "token": "123:ABC", "allow_from": []}),
            _MultiShotBus([]),  # type: ignore[arg-type]
            strict_config=True,
        )


def test_strict_channel_validation_requires_telegram_token() -> None:
    with pytest.raises(ChannelConfigurationError, match="non-empty token"):
        ChannelManager(
            ChannelsConfig(telegram={"enabled": True, "token": "", "allow_from": ["*"]}),
            _MultiShotBus([]),  # type: ignore[arg-type]
            strict_config=True,
        )
