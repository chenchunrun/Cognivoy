from __future__ import annotations

import pytest

from cognivoy.agents._shared.capability_result import emit_capability_result
from cognivoy.core.stream import StreamEventType
from cognivoy.core.stream_bus import StreamBus


@pytest.mark.asyncio
async def test_capability_result_adds_a_stable_cross_capability_envelope() -> None:
    bus = StreamBus()
    payload = {
        "response": "answer",
        "verification": {"passed": True},
        "metadata": {"partial": False},
    }

    await emit_capability_result(bus, payload, source="deep_solve")

    event = bus.history()[-1]
    assert event.type == StreamEventType.RESULT
    assert event.metadata["schema_version"] == "1.0"
    assert event.metadata["capability"] == "deep_solve"
    assert event.metadata["response"] == "answer"
    assert event.metadata["artifacts"] == []
    assert event.metadata["metadata"] == {
        "partial": False,
        "schema_version": "1.0",
        "capability": "deep_solve",
    }
    # Capability-specific fields remain available for existing clients.
    assert event.metadata["verification"] == {"passed": True}


@pytest.mark.asyncio
async def test_capability_result_rejects_a_non_string_response() -> None:
    with pytest.raises(TypeError, match="response"):
        await emit_capability_result(StreamBus(), {"response": {"unsafe": True}}, source="chat")
