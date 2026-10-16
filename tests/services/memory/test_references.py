"""Tests for ref pool validation and chunk-level concat helpers."""

from __future__ import annotations

from cognivoy.services.memory.consolidator.references import (
    ExtractedFact,
    refs_in_chunk_l2,
    refs_in_chunk_l3,
    refs_in_span_l2,
    render_l2_entries_for_concat,
    render_traces_for_concat,
    validate_fact_refs,
)
from cognivoy.services.memory.document import Entry
from cognivoy.services.memory.snapshot.entity import Entity


def _entity(eid: str) -> Entity:
    return Entity(
        id=eid,
        label=f"entity {eid}",
        ts="2026-05-20T00:00:00Z",
        content=f"body of {eid}",
        metadata={},
        fingerprint="fp",
    )


def test_render_traces_yields_unique_markers_per_entity() -> None:
    text = render_traces_for_concat([_entity("01A"), _entity("01B")], surface="chat")
    assert "@entity chat:01A" in text
    assert "@entity chat:01B" in text


def test_refs_in_chunk_l2_only_lists_refs_visible_in_chunk() -> None:
    full = render_traces_for_concat([_entity("01A"), _entity("01B")], surface="chat")
    # Take a substring that contains only 01A.
    cut = full.index("@entity chat:01B")
    chunk = full[:cut]
    allowed = refs_in_chunk_l2([_entity("01A"), _entity("01B")], surface="chat", chunk_text=chunk)
    assert "chat:01A" in allowed
    assert "chat:01B" not in allowed


def test_refs_in_span_l2_keeps_ref_when_chunk_starts_inside_entity_body() -> None:
    full = render_traces_for_concat([_entity("01A"), _entity("01B")], surface="chat")
    start = full.index("body of 01A")
    end = start + len("body of 01A")
    allowed = refs_in_span_l2(
        [_entity("01A"), _entity("01B")],
        surface="chat",
        full_text=full,
        start=start,
        end=end,
    )
    assert "chat:01A" in allowed
    assert "chat:01B" not in allowed


def test_render_l2_for_concat_exposes_entry_ids_but_not_l1_refs() -> None:
    """L3 cites exact L2 entries without exposing the upstream L1 refs."""
    entries = {
        "chat": [
            Entry(
                id="m_01HZK1ABCDEFGHJKMNPQRSTVWX",
                section="Themes",
                text="alpha",
                refs=["chat:r1", "chat:r2"],
            ),
        ],
    }
    text = render_l2_entries_for_concat(entries)
    assert "### surface: chat" in text
    assert "alpha" in text
    assert "m_01HZK1ABCDEFGHJKMNPQRSTVWX" in text
    assert "@l2" in text
    assert "chat:r1" not in text


def test_refs_in_chunk_l3_returns_entry_ids_visible_in_chunk() -> None:
    chat_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    notebook_id = "m_01HZK2ABCDEFGHJKMNPQRSTVWX"
    entries = {
        "chat": [Entry(id=chat_id, section="S", text="alpha", refs=[])],
        "notebook": [Entry(id=notebook_id, section="S", text="beta", refs=[])],
    }
    text = render_l2_entries_for_concat(entries)
    # Take a substring that contains only the chat block.
    cut = text.index("### surface: notebook")
    chunk = text[:cut]
    allowed = refs_in_chunk_l3(chunk, entries_by_surface=entries)
    assert allowed == {chat_id}


def test_refs_in_span_l3_keeps_entry_when_chunk_starts_mid_block() -> None:
    """An overlapping chunk retains every intersecting L2 entry ref."""
    from cognivoy.services.memory.consolidator.references import refs_in_span_l3

    chat_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    notebook_id = "m_01HZK2ABCDEFGHJKMNPQRSTVWX"
    entries = {
        "chat": [Entry(id=chat_id, section="S", text="alpha", refs=[])],
        "notebook": [Entry(id=notebook_id, section="S", text="beta", refs=[])],
    }
    text = render_l2_entries_for_concat(entries)
    # Start mid-way through the chat body, end mid-way through notebook.
    start = text.index("alpha") + 2
    end = text.index("beta") + 2
    allowed = refs_in_span_l3(
        entries_by_surface=entries,
        full_text=text,
        start=start,
        end=end,
    )
    assert allowed == {chat_id, notebook_id}


def test_validate_fact_refs_drops_out_of_pool_when_drop_invalid_true() -> None:
    fact = ExtractedFact(text="x", refs=["chat:01A", "chat:01Z"])
    kept, reject = validate_fact_refs(
        fact,
        allowed={"chat:01A"},
        enforce_required=True,
        drop_invalid=True,
    )
    assert kept == ["chat:01A"]
    assert reject is None


def test_validate_fact_refs_recovers_label_prefixed_l2_ref() -> None:
    fact = ExtractedFact(
        text="x",
        refs=["AutoAgent:chat:unified_1773210349762_5680af00"],
    )
    kept, reject = validate_fact_refs(
        fact,
        allowed={"chat:unified_1773210349762_5680af00"},
        enforce_required=True,
        drop_invalid=True,
    )
    assert kept == ["chat:unified_1773210349762_5680af00"]
    assert reject is None


def test_validate_fact_refs_rejects_when_drop_invalid_false() -> None:
    fact = ExtractedFact(text="x", refs=["chat:01A", "chat:01Z"])
    _, reject = validate_fact_refs(
        fact, allowed={"chat:01A"}, enforce_required=True, drop_invalid=False
    )
    assert reject is not None and "out-of-pool" in reject


def test_validate_fact_refs_rejects_empty_refs_when_required() -> None:
    fact = ExtractedFact(text="x", refs=[])
    _, reject = validate_fact_refs(
        fact, allowed={"chat:01A"}, enforce_required=True, drop_invalid=True
    )
    assert reject is not None and "missing refs" in reject
