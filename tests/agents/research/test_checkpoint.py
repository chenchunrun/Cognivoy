from __future__ import annotations

from pathlib import Path

import pytest

from cognivoy.agents.research.checkpoint import ResearchCheckpointStore
from cognivoy.agents.research.data_structures import DynamicTopicQueue, TopicStatus
from cognivoy.agents.research.request_config import validate_research_request_config


def test_checkpoint_id_is_strictly_validated() -> None:
    valid = validate_research_request_config(
        {"mode": "report", "depth": "standard", "checkpoint_id": "research_abcd1234"}
    )
    assert valid.checkpoint_id == "research_abcd1234"

    with pytest.raises(ValueError, match="checkpoint_id"):
        validate_research_request_config(
            {"mode": "report", "depth": "standard", "checkpoint_id": "../../escape"}
        )


def test_checkpoint_resumes_only_incomplete_blocks(tmp_path: Path) -> None:
    store = ResearchCheckpointStore("research_abcd1234", root=tmp_path)
    queue = DynamicTopicQueue("research_abcd1234", max_length=4)
    completed = queue.add_block("Completed topic", "done")
    incomplete = queue.add_block("Interrupted topic", "continue")
    queue.mark_completed(completed.block_id)
    queue.mark_researching(incomplete.block_id)
    store.start(topic="A durable research task", queue=queue)

    restored = store.resume(topic="A durable research task")
    assert restored is not None
    assert restored.get_block_by_id(completed.block_id).status == TopicStatus.COMPLETED
    assert restored.get_block_by_id(incomplete.block_id).status == TopicStatus.PENDING
    assert restored.state_file == str(store.queue_path)


def test_completed_checkpoint_starts_a_fresh_run(tmp_path: Path) -> None:
    store = ResearchCheckpointStore("research_abcd1234", root=tmp_path)
    queue = DynamicTopicQueue("research_abcd1234")
    queue.add_block("Topic", "")
    store.start(topic="Topic", queue=queue)
    store.finish(partial=False)

    assert store.resume(topic="Topic") is None


def test_checkpoint_rejects_cross_topic_resume(tmp_path: Path) -> None:
    store = ResearchCheckpointStore("research_abcd1234", root=tmp_path)
    queue = DynamicTopicQueue("research_abcd1234")
    queue.add_block("Topic A", "")
    store.start(topic="Topic A", queue=queue)

    with pytest.raises(ValueError, match="different research topic"):
        store.resume(topic="Topic B")
