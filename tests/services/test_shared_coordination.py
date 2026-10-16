from __future__ import annotations

import asyncio

import pytest

from cognivoy.services.coordination import (
    SharedConfigRevisionWatcher,
    SharedCoordinationStore,
)


def test_inbound_deduplication_and_rate_limit_are_shared_between_instances(tmp_path):
    first = SharedCoordinationStore(tmp_path / "coordination.sqlite3")
    second = SharedCoordinationStore(tmp_path / "coordination.sqlite3")

    assert first.accept_inbound(
        namespace="partner:ada:telegram",
        dedupe_key="chat-1:message-1",
        rate_key="sender-1",
        rate_limit=2,
        window_seconds=60,
        dedupe_ttl_seconds=3600,
        now=100.0,
    ) == (True, "accepted")
    assert second.accept_inbound(
        namespace="partner:ada:telegram",
        dedupe_key="chat-1:message-1",
        rate_key="sender-1",
        rate_limit=2,
        window_seconds=60,
        dedupe_ttl_seconds=3600,
        now=101.0,
    ) == (False, "duplicate")
    assert second.accept_inbound(
        namespace="partner:ada:telegram",
        dedupe_key="chat-1:message-2",
        rate_key="sender-1",
        rate_limit=2,
        window_seconds=60,
        dedupe_ttl_seconds=3600,
        now=102.0,
    ) == (True, "accepted")
    assert first.accept_inbound(
        namespace="partner:ada:telegram",
        dedupe_key="chat-1:message-3",
        rate_key="sender-1",
        rate_limit=2,
        window_seconds=60,
        dedupe_ttl_seconds=3600,
        now=103.0,
    ) == (False, "rate_limited")


def test_fifo_capacity_is_shared_and_expired_leases_are_recovered(tmp_path):
    first = SharedCoordinationStore(tmp_path / "coordination.sqlite3")
    second = SharedCoordinationStore(tmp_path / "coordination.sqlite3")

    assert (
        first.try_acquire_slot(
            namespace="subagents",
            ticket="first",
            max_active=1,
            max_queued=1,
            lease_seconds=30,
            now=100.0,
        )
        == "acquired"
    )
    assert (
        second.try_acquire_slot(
            namespace="subagents",
            ticket="second",
            max_active=1,
            max_queued=1,
            lease_seconds=30,
            now=101.0,
        )
        == "waiting"
    )
    assert (
        first.try_acquire_slot(
            namespace="subagents",
            ticket="third",
            max_active=1,
            max_queued=1,
            lease_seconds=30,
            now=102.0,
        )
        == "rejected"
    )

    first.release_slot(namespace="subagents", ticket="first")
    assert (
        second.try_acquire_slot(
            namespace="subagents",
            ticket="second",
            max_active=1,
            max_queued=1,
            lease_seconds=30,
            now=103.0,
        )
        == "acquired"
    )
    assert second.slot_snapshot("subagents", now=103.0) == {
        "active_runs": 1,
        "queued_runs": 0,
    }

    # A dead worker cannot hold capacity forever.
    assert (
        first.try_acquire_slot(
            namespace="subagents",
            ticket="third",
            max_active=1,
            max_queued=1,
            lease_seconds=30,
            now=134.0,
        )
        == "acquired"
    )


@pytest.mark.asyncio
async def test_generic_claim_allows_only_one_worker_per_occurrence(tmp_path):
    first = SharedCoordinationStore(tmp_path / "coordination.sqlite3")
    second = SharedCoordinationStore(tmp_path / "coordination.sqlite3")

    results = await asyncio.gather(
        asyncio.to_thread(
            first.claim,
            namespace="cron",
            key="job-1:due-100",
            owner="worker-1",
            lease_seconds=60,
            now=100.0,
        ),
        asyncio.to_thread(
            second.claim,
            namespace="cron",
            key="job-1:due-100",
            owner="worker-2",
            lease_seconds=60,
            now=100.0,
        ),
    )
    assert sorted(results) == [False, True]


def test_config_revision_is_observed_once_by_each_worker(tmp_path):
    store = SharedCoordinationStore(tmp_path / "coordination.sqlite3")
    first = SharedConfigRevisionWatcher("providers", store=store)
    second = SharedConfigRevisionWatcher("providers", store=store)

    assert first.changed() is False
    assert second.changed() is False
    assert store.publish_revision("providers") == 1
    assert first.changed() is True
    assert first.changed() is False
    assert second.changed() is True
