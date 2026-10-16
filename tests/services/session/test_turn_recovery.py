from __future__ import annotations

import time

from cognivoy.services.session.turn_recovery import (
    CAPABILITY_RECOVERY_MODES,
    TurnRecoveryStore,
    recovery_mode_for,
)


def test_every_builtin_capability_has_an_explicit_restart_policy() -> None:
    from cognivoy.runtime.bootstrap.builtin_capabilities import (
        BUILTIN_CAPABILITY_CLASSES,
    )

    assert set(CAPABILITY_RECOVERY_MODES) == set(BUILTIN_CAPABILITY_CLASSES)
    assert recovery_mode_for("deep_research") == "checkpoint"
    assert recovery_mode_for("math_animator") == "checkpoint"
    assert recovery_mode_for("deep_solve") == "checkpoint"
    assert recovery_mode_for("visualize") == "checkpoint"
    assert recovery_mode_for("deep_question") == "checkpoint"
    assert recovery_mode_for("chat") == "replay"
    assert recovery_mode_for("unknown-plugin") == "fail"


def test_turn_recovery_manifest_round_trips_request_and_progress(tmp_path) -> None:
    store = TurnRecoveryStore(root=tmp_path)
    store.create(
        turn_id="turn_123",
        session_id="session_1",
        capability="deep_research",
        payload={"content": "research this", "config": {"depth": "deep"}},
    )

    store.mark_input_persisted("turn_123", message_id=41)
    store.record_checkpoint(
        "turn_123",
        stage="researching",
        checkpoint={"research_checkpoint_id": "research_turn_123"},
    )

    manifest = store.load("turn_123")
    assert manifest is not None
    assert manifest["payload"]["content"] == "research this"
    assert manifest["input_persisted"] is True
    assert manifest["user_message_id"] == 41
    assert manifest["last_stage"] == "researching"
    assert manifest["checkpoint"] == {"research_checkpoint_id": "research_turn_123"}


def test_resume_claim_is_exclusive_and_expired_leases_can_be_reclaimed(tmp_path) -> None:
    store = TurnRecoveryStore(root=tmp_path)
    store.create(
        turn_id="turn_123",
        session_id="session_1",
        capability="math_animator",
        payload={"content": "animate"},
    )

    first = store.claim_resume("turn_123", worker_id="worker-a", lease_seconds=30)
    assert first is not None
    assert first["resume_count"] == 1
    assert store.claim_resume("turn_123", worker_id="worker-b", lease_seconds=30) is None

    # Simulate a process that died without releasing its lease.
    store._update(  # noqa: SLF001 - test-only crash simulation
        "turn_123", lambda value: {**value, "lease_expires_at": time.time() - 1}
    )
    reclaimed = store.claim_resume("turn_123", worker_id="worker-b", lease_seconds=30)
    assert reclaimed is not None
    assert reclaimed["resume_count"] == 2


def test_terminal_manifest_cannot_be_claimed_for_resume(tmp_path) -> None:
    store = TurnRecoveryStore(root=tmp_path)
    store.create(
        turn_id="turn_123",
        session_id="session_1",
        capability="chat",
        payload={"content": "hello"},
    )
    store.finish("turn_123", status="completed")

    assert store.claim_resume("turn_123", worker_id="worker-a") is None
    assert store.load("turn_123")["status"] == "completed"


def test_waiting_reply_round_trips_once_across_processes(tmp_path) -> None:
    store = TurnRecoveryStore(root=tmp_path)
    store.create(
        turn_id="turn_123",
        session_id="session_1",
        capability="chat",
        payload={"content": "help me choose"},
    )

    assert store.submit_reply("turn_123", {"text": "Option B"}) is False
    store.mark_waiting_for_input("turn_123", waiting=True)
    assert store.submit_reply("turn_123", {"text": "Option B"}) is True

    # A new worker can consume the reply after the original process exits, but
    # a duplicate consumer cannot replay the same learner input.
    assert store.take_reply("turn_123") == {"text": "Option B"}
    assert store.take_reply("turn_123") is None
    manifest = store.load("turn_123")
    assert manifest is not None
    assert manifest["waiting_for_input"] is False
