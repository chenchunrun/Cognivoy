from __future__ import annotations

import asyncio

import pytest

from cognivoy.core.stream import StreamEvent, StreamEventType
from cognivoy.services.session.sqlite_store import SQLiteSessionStore
from cognivoy.services.session.turn_recovery import TurnRecoveryStore
from cognivoy.services.session.turn_runtime import (
    TurnRuntimeManager,
    _resolve_turn_outcome,
    _TurnExecution,
)


def test_terminal_error_marks_turn_failed() -> None:
    error_message = "provider authentication failed"
    status, error = _resolve_turn_outcome(
        [
            {
                "type": "error",
                "content": error_message,
                "metadata": {"turn_terminal": True, "status": "failed"},
            }
        ],
        StreamEvent(
            type=StreamEventType.DONE,
            source="chat",
            metadata={"status": "failed"},
        ),
    )

    assert status == "failed"
    assert error == error_message


def test_non_terminal_error_keeps_completed_done_status() -> None:
    status, error = _resolve_turn_outcome(
        [
            {
                "type": "error",
                "content": "recoverable tool error",
                "metadata": {},
            }
        ],
        StreamEvent(
            type=StreamEventType.DONE,
            source="chat",
            metadata={"status": "completed"},
        ),
    )

    assert status == "completed"
    assert error == ""


def test_timed_out_terminal_status_is_preserved() -> None:
    message = "runtime budget exhausted"
    status, error = _resolve_turn_outcome(
        [
            {
                "type": "error",
                "content": message,
                "metadata": {"turn_terminal": True, "status": "timed_out"},
            }
        ],
        StreamEvent(
            type=StreamEventType.DONE,
            source="chat",
            metadata={"status": "timed_out"},
        ),
    )

    assert status == "timed_out"
    assert error == message


@pytest.mark.asyncio
async def test_turn_store_persists_the_full_active_and_terminal_state_machine(tmp_path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    session = await store.ensure_session(None)

    turn = await store.create_turn(session["id"], capability="chat")
    assert turn["status"] == "queued"
    assert (await store.get_active_turn(session["id"]))["status"] == "queued"

    for status in ("running", "waiting_for_input", "running"):
        assert await store.update_turn_status(turn["id"], status) is True
        persisted = await store.get_turn(turn["id"])
        assert persisted is not None
        assert persisted["status"] == status
        assert persisted["finished_at"] is None
        assert (await store.get_active_turn(session["id"]))["status"] == status

    assert await store.update_turn_status(turn["id"], "timed_out", "budget exhausted") is True
    persisted = await store.get_turn(turn["id"])
    assert persisted is not None
    assert persisted["status"] == "timed_out"
    assert persisted["error"] == "budget exhausted"
    assert persisted["finished_at"] is not None
    assert await store.get_active_turn(session["id"]) is None


@pytest.mark.asyncio
async def test_wait_for_user_reply_persists_pause_and_resume_states(tmp_path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    session = await store.ensure_session(None)
    turn = await store.create_turn(session["id"], capability="chat")
    await store.update_turn_status(turn["id"], "running")
    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    pause_event = asyncio.Event()
    resume_event = asyncio.Event()
    resume_event.set()

    waiter = asyncio.create_task(
        runtime._wait_for_user_reply(
            turn["id"],
            queue,
            pause_event=pause_event,
            resume_event=resume_event,
        )
    )
    await asyncio.wait_for(pause_event.wait(), timeout=1)
    persisted = await store.get_turn(turn["id"])
    assert persisted is not None
    assert persisted["status"] == "waiting_for_input"
    assert resume_event.is_set() is False

    await queue.put({"text": "continue"})
    assert await asyncio.wait_for(waiter, timeout=1) == {"text": "continue"}
    persisted = await store.get_turn(turn["id"])
    assert persisted is not None
    assert persisted["status"] == "running"
    assert pause_event.is_set() is False
    assert resume_event.is_set() is True


@pytest.mark.asyncio
async def test_subscribe_turn_does_not_synthesize_done_for_running_turn(tmp_path) -> None:
    """A paused/replaced subscription must not make the UI think the turn ended."""

    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    session = await store.ensure_session(None)
    turn = await store.create_turn(session["id"], capability="chat")
    await store.update_turn_status(turn["id"], "running")
    execution = _TurnExecution(
        turn_id=turn["id"],
        session_id=session["id"],
        capability="chat",
        payload={},
    )
    runtime._executions[turn["id"]] = execution

    events: list[dict] = []

    async def _collect() -> None:
        async for event in runtime.subscribe_turn(turn["id"], after_seq=0):
            events.append(event)

    task = asyncio.create_task(_collect())
    for _ in range(200):
        if execution.subscribers:
            break
        await asyncio.sleep(0.01)

    assert execution.subscribers
    await execution.subscribers[0].queue.put(None)
    await asyncio.wait_for(task, timeout=1)

    assert events == []
    persisted = await store.get_turn(turn["id"])
    assert persisted is not None
    assert persisted["status"] == "running"


@pytest.mark.asyncio
async def test_subscribe_turn_marks_orphan_running_turn_failed(tmp_path) -> None:
    """A DB-running turn with no in-process execution is stale after restart."""

    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    session = await store.ensure_session(None)
    turn = await store.create_turn(session["id"], capability="chat")

    events: list[dict] = []
    async for event in runtime.subscribe_turn(turn["id"], after_seq=0):
        events.append(event)

    persisted = await store.get_turn(turn["id"])
    assert persisted is not None
    assert persisted["status"] == "failed"
    assert "restart" in persisted["error"].lower()
    assert [event["type"] for event in events] == ["error", "done"]
    assert events[-1]["metadata"]["status"] == "failed"


@pytest.mark.asyncio
async def test_recover_orphan_turn_restarts_from_durable_request(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    recovery = TurnRecoveryStore(root=tmp_path / "recovery")
    session = await store.ensure_session(None)
    turn = await store.create_turn(session["id"], capability="deep_research")
    payload = {
        "type": "start_turn",
        "content": "research durable workflows",
        "session_id": session["id"],
        "capability": "deep_research",
        "tools": [],
        "knowledge_bases": [],
        "attachments": [],
        "language": "en",
        "config": {"checkpoint_id": f"research_{turn['id']}"},
    }
    recovery.create(
        turn_id=turn["id"],
        session_id=session["id"],
        capability="deep_research",
        payload=payload,
    )
    recovery.mark_input_persisted(turn["id"], message_id=13)

    runtime = TurnRuntimeManager(store, recovery_store=recovery)
    entered = asyncio.Event()
    release = asyncio.Event()

    async def _hold_recovered_turn(execution):
        entered.set()
        await release.wait()

    monkeypatch.setattr(runtime, "_run_turn", _hold_recovered_turn)

    recovered = await runtime.recover_orphan_turn(turn)
    await asyncio.wait_for(entered.wait(), timeout=1)

    assert recovered is not None
    assert recovered["status"] == "running"
    assert await runtime.has_live_execution(turn["id"])
    execution = runtime._executions[turn["id"]]  # noqa: SLF001 - runtime contract test
    assert execution.payload["config"]["_persist_user_message"] is False
    assert execution.payload["config"]["_recovery_attempt"] == 1
    assert execution.payload["config"]["_recovery_mode"] == "checkpoint"
    assert execution.next_seq == 2
    recovery_events = await store.get_turn_events(turn["id"])
    assert recovery_events[0]["stage"] == "recovery"
    assert recovery_events[0]["metadata"]["recovered_after_restart"] is True
    assert recovery_events[0]["metadata"]["recovery_mode"] == "checkpoint"

    release.set()
    assert execution.task is not None
    await asyncio.wait_for(execution.task, timeout=1)


@pytest.mark.asyncio
async def test_unknown_capability_orphan_fails_instead_of_unsafe_replay(tmp_path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    recovery = TurnRecoveryStore(root=tmp_path / "recovery")
    session = await store.ensure_session(None)
    turn = await store.create_turn(session["id"], capability="third_party_side_effect")
    recovery.create(
        turn_id=turn["id"],
        session_id=session["id"],
        capability="third_party_side_effect",
        payload={
            "type": "start_turn",
            "content": "perform an external action",
            "session_id": session["id"],
            "capability": "third_party_side_effect",
            "config": {},
        },
    )

    runtime = TurnRuntimeManager(store, recovery_store=recovery)
    recovered = await runtime.recover_orphan_turn(turn)

    assert recovered is not None
    assert recovered["status"] == "failed"
    assert "restart" in recovered["error"].lower()
    assert recovery.load(turn["id"])["status"] == "failed"


@pytest.mark.asyncio
async def test_start_turn_clears_orphan_running_turn_before_create(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """A stale active turn should not block the next user message after restart."""

    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    session = await store.ensure_session(None)
    stale = await store.create_turn(session["id"], capability="chat")

    async def _noop_run_turn(_execution):
        return None

    monkeypatch.setattr(runtime, "_run_turn", _noop_run_turn)

    _, new_turn = await runtime.start_turn(
        {
            "type": "start_turn",
            "session_id": session["id"],
            "capability": "chat",
            "content": "hello",
            "tools": [],
            "knowledge_bases": [],
            "attachments": [],
            "language": "en",
            "config": {},
        }
    )

    assert new_turn["id"] != stale["id"]
    persisted = await store.get_turn(stale["id"])
    assert persisted is not None
    assert persisted["status"] == "failed"


@pytest.mark.asyncio
async def test_runtime_instances_have_distinct_lease_owners(tmp_path) -> None:
    recovery = TurnRecoveryStore(root=tmp_path / "recovery")
    first = TurnRuntimeManager(SQLiteSessionStore(tmp_path / "first.db"), recovery_store=recovery)
    second = TurnRuntimeManager(SQLiteSessionStore(tmp_path / "second.db"), recovery_store=recovery)

    assert first._worker_id != second._worker_id  # noqa: SLF001


@pytest.mark.asyncio
async def test_cross_worker_subscription_polls_persisted_events_until_terminal(
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    recovery = TurnRecoveryStore(root=tmp_path / "recovery")
    owner = TurnRuntimeManager(store, recovery_store=recovery)
    subscriber_runtime = TurnRuntimeManager(store, recovery_store=recovery)
    session = await store.ensure_session(None)
    turn = await store.create_turn(session["id"], capability="chat")
    await store.update_turn_status(turn["id"], "running")
    recovery.create(
        turn_id=turn["id"],
        session_id=session["id"],
        capability="chat",
        payload={"content": "hello"},
        worker_id=owner._worker_id,  # noqa: SLF001
        lease_seconds=30,
    )

    async def persist_from_owner() -> None:
        await asyncio.sleep(0.05)
        await store.append_turn_event(
            turn["id"],
            {
                "type": "content",
                "source": "chat",
                "content": "remote output",
            },
        )
        await store.update_turn_status(turn["id"], "completed")
        recovery.finish(turn["id"], status="completed")

    producer = asyncio.create_task(persist_from_owner())
    events: list[dict] = []
    async with asyncio.timeout(2):
        async for event in subscriber_runtime.subscribe_turn(turn["id"]):
            events.append(event)
    await producer

    assert [event["type"] for event in events] == ["content", "done"]
    assert events[0]["content"] == "remote output"
    assert events[-1]["metadata"]["status"] == "completed"


@pytest.mark.asyncio
async def test_user_reply_can_be_delivered_from_another_runtime(tmp_path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    recovery = TurnRecoveryStore(root=tmp_path / "recovery")
    owner = TurnRuntimeManager(store, recovery_store=recovery)
    remote = TurnRuntimeManager(store, recovery_store=recovery)
    session = await store.ensure_session(None)
    turn = await store.create_turn(session["id"], capability="chat")
    await store.update_turn_status(turn["id"], "running")
    recovery.create(
        turn_id=turn["id"],
        session_id=session["id"],
        capability="chat",
        payload={"content": "ask me"},
        worker_id=owner._worker_id,  # noqa: SLF001
    )
    queue: asyncio.Queue[dict | None] = asyncio.Queue()
    pause_event = asyncio.Event()
    resume_event = asyncio.Event()
    resume_event.set()
    waiter = asyncio.create_task(
        owner._wait_for_user_reply(  # noqa: SLF001
            turn["id"],
            queue,
            pause_event=pause_event,
            resume_event=resume_event,
        )
    )
    await asyncio.wait_for(pause_event.wait(), timeout=1)

    assert await remote.submit_user_reply(turn["id"], "continue") is True
    assert await asyncio.wait_for(waiter, timeout=2) == {
        "text": "continue",
        "answers": None,
    }
