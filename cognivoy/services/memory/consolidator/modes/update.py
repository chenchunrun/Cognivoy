"""Update mode — chunk-based incremental fact extraction.

Algorithm
---------
1. Compute new or modified input using content versions in ``*.meta.json``.
2. Concatenate the new inputs by time (oldest first).
3. ``chunk_with_boundary`` cuts the concat into ≤ budget pieces, never
   truncating mid-paragraph (or mid-sentence, per settings).
4. For each chunk: LLM call → parse facts → filter by ref pool → append
   to in-memory ``Document``.
5. Atomic flush to disk + update ``*.meta.json``.
6. If ``dedup.auto_after_update`` is set, kick off the dedup pass.

The append step uses the existing :class:`ops.AddOp` apply path so the
document's invariants (id allocation, validation, footnote rebuild on
serialize) stay centralized.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging

from cognivoy.services.memory import paths
from cognivoy.services.memory import snapshot as snap
from cognivoy.services.memory.consolidator.chunker import (
    chunk_with_boundary,
)
from cognivoy.services.memory.consolidator.meta import (
    load_l2_meta,
    load_l3_meta,
    save_l2_meta,
    save_l3_meta,
)
from cognivoy.services.memory.consolidator.modes._runtime import (
    OnEvent,
    call_llm,
    emit,
    load_doc,
    load_prompt,
    slot_focus,
    surface_focus,
    today_iso,
    write_doc_checkpoint,
)
from cognivoy.services.memory.consolidator.references import (
    ExtractedFact,
    refs_in_span_l2,
    refs_in_span_l3,
    render_l2_entries_for_concat,
    render_traces_for_concat,
    validate_fact_refs,
)
from cognivoy.services.memory.consolidator.versions import entity_version, entry_version
from cognivoy.services.memory.document import Document, Entry, serialize
from cognivoy.services.memory.ops import AddOp
from cognivoy.services.memory.ops import apply as apply_ops
from cognivoy.services.memory.paths import L3Slot, Surface
from cognivoy.services.memory.settings import load_memory_settings

logger = logging.getLogger(__name__)

Layer = str  # "L2" | "L3"


@dataclass
class UpdateResult:
    layer: Layer
    key: str
    chunks_processed: int
    facts_added: int
    refs_dropped: int
    new_entry_ids: list[str] = field(default_factory=list)
    no_new_input: bool = False


# ── Public entry ────────────────────────────────────────────────────────


async def run_update(
    layer: Layer,
    key: str,
    *,
    language: str = "en",
    user_label: str = "anonymous",
    budget: int | None = None,
    llm_selection: dict | None = None,
    on_event: OnEvent | None = None,
) -> UpdateResult:
    """Dispatch to the layer-specific update implementation.

    The chosen ``llm_selection`` (``{profile_id, model_id}``) is
    installed as a scoped LLM config for the duration of the run so
    every internal :func:`call_llm` resolves to the right provider.
    """
    from cognivoy.services.model_selection.runtime import (
        activate_llm_selection,
        reset_llm_selection,
    )

    settings = load_memory_settings()
    token = None
    if llm_selection:
        try:
            _config, token = activate_llm_selection(llm_selection)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "memory update: ignoring unresolvable llm_selection %s: %s", llm_selection, exc
            )
            token = None
    try:
        if layer == "L2":
            return await _run_update_l2(
                key,  # type: ignore[arg-type]
                language=language,
                user_label=user_label,
                budget=budget if budget is not None else settings.update.l2_budget,
                llm_selection=llm_selection,
                on_event=on_event,
                settings=settings,
            )
        if layer == "L3":
            return await _run_update_l3(
                key,  # type: ignore[arg-type]
                language=language,
                user_label=user_label,
                budget=budget if budget is not None else settings.update.l3_budget,
                llm_selection=llm_selection,
                on_event=on_event,
                settings=settings,
            )
        raise ValueError(f"unknown layer {layer!r}")
    finally:
        reset_llm_selection(token)


# ── L2 ──────────────────────────────────────────────────────────────────


async def _run_update_l2(
    surface: Surface,
    *,
    language: str,
    user_label: str,
    budget: int,
    llm_selection: dict | None,
    on_event: OnEvent | None,
    settings,
) -> UpdateResult:
    meta = load_l2_meta(surface)
    all_entities = sorted(
        snap.read_snapshot(surface),
        key=lambda e: (e.ts or "", e.id),
    )
    seen = meta.seen_entity_versions
    seen_now = {f"{surface}:{entity.id}": entity_version(entity) for entity in all_entities}
    new_entities = [
        entity
        for entity in all_entities
        if seen.get(f"{surface}:{entity.id}") != seen_now[f"{surface}:{entity.id}"]
    ]
    invalidated_refs = {
        ref
        for ref, old_version in seen.items()
        if ref not in seen_now or seen_now[ref] != old_version
    }
    l2_path = paths.l2_file(surface)
    doc = load_doc(l2_path, default_title=f"{surface} memory")
    invalidated_facts = _remove_invalidated_refs(doc, invalidated_refs)

    await emit(
        on_event,
        {
            "stage": "trace_loaded",
            "surface": surface,
            "total": len(all_entities),
            "new": len(new_entities),
        },
    )

    if not new_entities:
        # Still persist a fresh meta so the "last_update_at" timestamp
        # moves; this signals "we checked, nothing new".
        if invalidated_facts:
            await write_doc_checkpoint(
                l2_path,
                doc,
                layer="L2",
                key=surface,
                on_event=on_event,
                label="update",
                action="remove_stale_facts",
            )
        save_l2_meta(surface, seen_entity_versions=seen_now)
        # Even when no facts were added we still run merge — the doc may
        # be in the legacy entry-keyed footnote layout and the user
        # expects "click update" to clean it up.
        if settings.merge.auto_after_update:
            from cognivoy.services.memory.consolidator.modes.merge import run_merge

            await run_merge(
                "L2",
                surface,
                language=language,
                user_label=user_label,
                on_event=on_event,
            )
        await emit(on_event, {"stage": "done", "no_new_input": True, "facts_added": 0})
        return UpdateResult(
            layer="L2",
            key=surface,
            chunks_processed=0,
            facts_added=0,
            refs_dropped=0,
            no_new_input=True,
        )

    text = render_traces_for_concat(new_entities, surface=surface)
    chunks = chunk_with_boundary(
        text,
        budget=budget,
        overlap_ratio=settings.chunking.overlap_ratio,
        min_chunk_chars=settings.chunking.min_chunk_chars,
        max_chunk_chars=settings.chunking.max_chunk_chars,
        boundary=settings.chunking.boundary,
    )
    await emit(
        on_event,
        {"stage": "chunked", "chunks": len(chunks), "budget": budget, "chars": len(text)},
    )

    prompt = load_prompt("update_l2", language)
    focus, sections = surface_focus(language, surface)
    facts_added = 0
    refs_dropped = 0
    new_entry_ids: list[str] = []

    for chunk in chunks:
        await emit(
            on_event,
            {
                "stage": "progress",
                "mode": "update",
                "turn": chunk.index + 1,
                "total": len(chunks),
                "chunk_start": chunk.start,
                "chunk_end": chunk.end,
            },
        )
        system = prompt["system"].format(
            user_label=user_label,
            surface=surface,
            sections=", ".join(sections) if sections else "(any)",
            focus=focus,
            today=today_iso(),
        )
        allowed = refs_in_span_l2(
            new_entities,
            surface=surface,
            full_text=text,
            start=chunk.start,
            end=chunk.end,
        )
        user = prompt["user"].format(
            surface=surface,
            existing=_render_existing_l2(doc),
            chunk=_chunk_with_ref_header(chunk.text, allowed),
            chunk_index=chunk.index + 1,
            chunk_total=len(chunks),
            chunk_start=chunk.start,
            chunk_end=chunk.end,
        )
        raw = await call_llm(
            system_prompt=system,
            user_prompt=user,
            on_event=on_event,
            turn=chunk.index + 1,
            chunk_index=chunk.index,
            label="update",
        )
        facts = _parse_facts(raw)
        kept_in_chunk, rejected = _validate_extracted_facts(
            facts,
            allowed=allowed,
            enforce_required=settings.reference.enforce_required,
            drop_invalid=settings.reference.drop_invalid_refs,
        )

        for fact, reject_reason in rejected:
            refs_dropped += 1
            await emit(
                on_event,
                {
                    "stage": "refs_dropped",
                    "turn": chunk.index + 1,
                    "reason": reject_reason,
                    "text": fact.text[:120],
                },
            )

        added_now = _append_facts_to_doc(doc, kept_in_chunk, sections)
        facts_added += len(added_now)
        new_entry_ids.extend(added_now)
        await emit(
            on_event,
            {
                "stage": "facts_extracted",
                "turn": chunk.index + 1,
                "kept": len(kept_in_chunk),
                "added": len(added_now),
            },
        )

    # Commit document and cursor only after every chunk completed and parsed.
    # A provider/network/format failure therefore leaves all input retryable.
    if facts_added or invalidated_facts:
        await write_doc_checkpoint(
            l2_path,
            doc,
            layer="L2",
            key=surface,
            on_event=on_event,
            label="update",
            action="replace_stale_and_append_facts",
        )
    save_l2_meta(surface, seen_entity_versions=seen_now)

    await emit(
        on_event,
        {
            "stage": "done",
            "facts_added": facts_added,
            "refs_dropped": refs_dropped,
            "chunks_processed": len(chunks),
            "auto_dedup": settings.dedup.auto_after_update,
        },
    )

    if settings.dedup.auto_after_update and facts_added > 0:
        # Avoid a circular import: dedup imports settings, refs, line_doc.
        from cognivoy.services.memory.consolidator.modes.dedup import run_dedup

        await run_dedup(
            "L2",
            surface,
            language=language,
            user_label=user_label,
            iterations=settings.dedup.iterations,
            llm_selection=llm_selection,
            on_event=on_event,
        )

    if settings.merge.auto_after_update:
        from cognivoy.services.memory.consolidator.modes.merge import run_merge

        await run_merge(
            "L2",
            surface,
            language=language,
            user_label=user_label,
            on_event=on_event,
        )

    return UpdateResult(
        layer="L2",
        key=surface,
        chunks_processed=len(chunks),
        facts_added=facts_added,
        refs_dropped=refs_dropped,
        new_entry_ids=new_entry_ids,
    )


# ── L3 ──────────────────────────────────────────────────────────────────


async def _run_update_l3(
    slot: L3Slot,
    *,
    language: str,
    user_label: str,
    budget: int,
    llm_selection: dict | None,
    on_event: OnEvent | None,
    settings,
) -> UpdateResult:
    if slot == "preferences":
        raise ValueError("preferences.md is not auto-consolidated")

    meta = load_l3_meta(slot)
    l2_docs = _load_all_l2_docs()
    entries_by_surface: dict[str, list[Entry]] = {}
    seen_now: dict[str, dict[str, str]] = {}
    for surface, doc in l2_docs.items():
        all_entries = doc.all_entries()
        seen_now[surface] = {entry.id: entry_version(entry) for entry in all_entries}
        # Sort by id (ULID) ascending → roughly time-ascending.
        new_entries = sorted(
            (
                entry
                for entry in all_entries
                if meta.seen_l2_entry_versions.get(surface, {}).get(entry.id)
                != seen_now[surface][entry.id]
            ),
            key=lambda e: e.id,
        )
        entries_by_surface[surface] = new_entries

    new_count = sum(len(v) for v in entries_by_surface.values())
    total_count = sum(len(d.all_entries()) for d in l2_docs.values())
    await emit(
        on_event,
        {
            "stage": "trace_loaded",
            "slot": slot,
            "total_l2_entries": total_count,
            "new_l2_entries": new_count,
        },
    )

    l3_path = paths.l3_file(slot)
    doc = load_doc(l3_path, default_title=_default_l3_title(slot))
    valid_l2_refs = {entry_id for versions in seen_now.values() for entry_id in versions}
    invalidated_facts = _retain_valid_refs(doc, valid_l2_refs)

    if new_count == 0:
        if invalidated_facts:
            await write_doc_checkpoint(
                l3_path,
                doc,
                layer="L3",
                key=slot,
                on_event=on_event,
                label="update",
                action="remove_stale_facts",
            )
        save_l3_meta(slot, seen_l2_entry_versions=seen_now)
        if settings.merge.auto_after_update:
            from cognivoy.services.memory.consolidator.modes.merge import run_merge

            await run_merge(
                "L3",
                slot,
                language=language,
                user_label=user_label,
                on_event=on_event,
            )
        await emit(on_event, {"stage": "done", "no_new_input": True, "facts_added": 0})
        return UpdateResult(
            layer="L3",
            key=slot,
            chunks_processed=0,
            facts_added=0,
            refs_dropped=0,
            no_new_input=True,
        )

    text = render_l2_entries_for_concat(entries_by_surface)
    chunks = chunk_with_boundary(
        text,
        budget=budget,
        overlap_ratio=settings.chunking.overlap_ratio,
        min_chunk_chars=settings.chunking.min_chunk_chars,
        max_chunk_chars=settings.chunking.max_chunk_chars,
        boundary=settings.chunking.boundary,
    )
    await emit(
        on_event,
        {"stage": "chunked", "chunks": len(chunks), "budget": budget, "chars": len(text)},
    )

    prompt = load_prompt("update_l3", language)
    focus, sections = slot_focus(language, slot)
    facts_added = 0
    refs_dropped = 0
    new_entry_ids: list[str] = []

    for chunk in chunks:
        await emit(
            on_event,
            {
                "stage": "progress",
                "mode": "update",
                "turn": chunk.index + 1,
                "total": len(chunks),
                "chunk_start": chunk.start,
                "chunk_end": chunk.end,
            },
        )
        system = prompt["system"].format(
            user_label=user_label,
            slot=slot,
            sections=", ".join(sections) if sections else "(any)",
            focus=focus,
            today=today_iso(),
        )
        # Cite exact L2 entry ids so graph traversal, confidence and conflict
        # review all operate on the same evidence contract.
        allowed = refs_in_span_l3(
            entries_by_surface=entries_by_surface,
            full_text=text,
            start=chunk.start,
            end=chunk.end,
        )
        user = prompt["user"].format(
            slot=slot,
            existing=_render_existing_l3(doc),
            chunk=_chunk_with_ref_header(chunk.text, allowed),
            chunk_index=chunk.index + 1,
            chunk_total=len(chunks),
        )
        raw = await call_llm(
            system_prompt=system,
            user_prompt=user,
            on_event=on_event,
            turn=chunk.index + 1,
            chunk_index=chunk.index,
            label="update",
        )
        facts = _parse_facts(raw)

        kept_in_chunk, rejected = _validate_extracted_facts(
            facts,
            allowed=allowed,
            enforce_required=settings.reference.enforce_required,
            drop_invalid=settings.reference.drop_invalid_refs,
        )

        # A reasoning model may still copy the surface label (``chat``)
        # instead of an exact L2 entry id. Correct it once before advancing
        # the cursor; otherwise one malformed answer can silently lose a
        # complete L3 input chunk.
        if facts and not kept_in_chunk and rejected and allowed:
            await emit(
                on_event,
                {
                    "stage": "refs_retry",
                    "turn": chunk.index + 1,
                    "reason": rejected[0][1],
                    "allowed_refs": sorted(allowed),
                },
            )
            allowed_text = ", ".join(sorted(allowed))
            if language.startswith("zh"):
                correction = (
                    "\n\n# 引用格式纠错\n"
                    "上一次结果的 refs 无效。请重新输出完整 JSON；每个 refs 值必须从"
                    f"以下列表逐字复制，禁止写 surface 名：{allowed_text}"
                )
            else:
                correction = (
                    "\n\n# Citation correction\n"
                    "The previous refs were invalid. Return the complete JSON again. "
                    "Every refs value must be copied verbatim from this list; never use "
                    f"a surface name: {allowed_text}"
                )
            retry_raw = await call_llm(
                system_prompt=system,
                user_prompt=user + correction,
                on_event=on_event,
                turn=chunk.index + 1,
                chunk_index=chunk.index,
                label="update_refs_retry",
            )
            retry_facts = _parse_facts(retry_raw)
            kept_in_chunk, rejected = _validate_extracted_facts(
                retry_facts,
                allowed=allowed,
                enforce_required=settings.reference.enforce_required,
                drop_invalid=settings.reference.drop_invalid_refs,
            )

        for fact, reject_reason in rejected:
            refs_dropped += 1
            await emit(
                on_event,
                {
                    "stage": "refs_dropped",
                    "turn": chunk.index + 1,
                    "reason": reject_reason,
                    "text": fact.text[:120],
                },
            )

        added_now = _append_facts_to_doc(doc, kept_in_chunk, sections)
        facts_added += len(added_now)
        new_entry_ids.extend(added_now)
        await emit(
            on_event,
            {
                "stage": "facts_extracted",
                "turn": chunk.index + 1,
                "kept": len(kept_in_chunk),
                "added": len(added_now),
            },
        )

    if facts_added or invalidated_facts:
        await write_doc_checkpoint(
            l3_path,
            doc,
            layer="L3",
            key=slot,
            on_event=on_event,
            label="update",
            action="replace_stale_and_append_facts",
        )
    save_l3_meta(slot, seen_l2_entry_versions=seen_now)
    await emit(
        on_event,
        {
            "stage": "done",
            "facts_added": facts_added,
            "refs_dropped": refs_dropped,
            "chunks_processed": len(chunks),
            "auto_dedup": settings.dedup.auto_after_update,
        },
    )

    if settings.dedup.auto_after_update and facts_added > 0:
        from cognivoy.services.memory.consolidator.modes.dedup import run_dedup

        await run_dedup(
            "L3",
            slot,
            language=language,
            user_label=user_label,
            iterations=settings.dedup.iterations,
            llm_selection=llm_selection,
            on_event=on_event,
        )

    if settings.merge.auto_after_update:
        from cognivoy.services.memory.consolidator.modes.merge import run_merge

        await run_merge(
            "L3",
            slot,
            language=language,
            user_label=user_label,
            on_event=on_event,
        )

    return UpdateResult(
        layer="L3",
        key=slot,
        chunks_processed=len(chunks),
        facts_added=facts_added,
        refs_dropped=refs_dropped,
        new_entry_ids=new_entry_ids,
    )


# ── Helpers ─────────────────────────────────────────────────────────────


def _parse_facts(raw: str) -> list[ExtractedFact]:
    """Parse a structured fact response; malformed output is retryable."""
    if not raw:
        raise ValueError("memory consolidator returned an empty response")
    snippet = _extract_json_object(raw)
    if snippet is None:
        raise ValueError("memory consolidator response did not contain JSON")
    try:
        data = json.loads(snippet)
    except json.JSONDecodeError as exc:
        raise ValueError("memory consolidator returned malformed JSON") from exc
    items = data.get("facts") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise ValueError("memory consolidator response is missing a facts list")
    out: list[ExtractedFact] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()
        section = str(item.get("section", "")).strip()
        refs_raw = item.get("refs", [])
        refs = [str(r).strip() for r in (refs_raw if isinstance(refs_raw, list) else []) if r]
        if not text:
            continue
        out.append(ExtractedFact(text=text, refs=refs, section=section))
    return out


def _validate_extracted_facts(
    facts: list[ExtractedFact],
    *,
    allowed: set[str],
    enforce_required: bool,
    drop_invalid: bool,
) -> tuple[list[ExtractedFact], list[tuple[ExtractedFact, str]]]:
    """Normalize chunk-local refs while preserving rejection diagnostics."""
    kept: list[ExtractedFact] = []
    rejected: list[tuple[ExtractedFact, str]] = []
    for fact in facts:
        kept_refs, reject_reason = validate_fact_refs(
            fact,
            allowed=allowed,
            enforce_required=enforce_required,
            drop_invalid=drop_invalid,
        )
        if reject_reason is not None:
            rejected.append((fact, reject_reason))
            continue
        kept.append(ExtractedFact(text=fact.text, refs=kept_refs, section=fact.section))
    return kept, rejected


def _remove_invalidated_refs(doc: Document, invalidated_refs: set[str]) -> int:
    """Remove evidence derived from changed/deleted L1 entities."""
    if not invalidated_refs:
        return 0
    changed = 0
    for _section, entries in doc.sections:
        for entry in list(entries):
            refs = [ref for ref in entry.refs if ref not in invalidated_refs]
            if refs == entry.refs:
                continue
            changed += 1
            if refs:
                entry.refs = refs
            else:
                entries.remove(entry)
    return changed


def _retain_valid_refs(doc: Document, valid_refs: set[str]) -> int:
    """Drop stale/legacy L3 evidence and claims left without evidence."""
    changed = 0
    for _section, entries in doc.sections:
        for entry in list(entries):
            refs = [ref for ref in entry.refs if ref in valid_refs]
            if refs == entry.refs:
                continue
            changed += 1
            if refs:
                entry.refs = refs
            else:
                entries.remove(entry)
    return changed


def _extract_json_object(raw: str) -> str | None:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    start = text.find("{")
    if start == -1:
        return None
    try:
        _parsed, end = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError:
        return None
    return text[start : start + end]


def _append_facts_to_doc(
    doc: Document, facts: list[ExtractedFact], allowed_sections: list[str]
) -> list[str]:
    """Append each fact as one AddOp; return the new entry ids."""
    new_ids: list[str] = []
    fallback_section = allowed_sections[0] if allowed_sections else "Notes"
    for fact in facts:
        section = fact.section if fact.section else fallback_section
        if allowed_sections and section not in allowed_sections:
            # Map an off-list section into the first allowed one — keeps
            # the section catalog stable across runs.
            section = fallback_section
        op = AddOp(section=section, text=fact.text, refs=fact.refs)
        report = apply_ops(doc, [op])
        if report.accepted and report.results:
            new_id = report.results[0].entry_id
            if new_id:
                new_ids.append(new_id)
        else:
            logger.warning(
                "update: skipped fact (%s): %s",
                report.reason,
                fact.text[:80],
            )
    return new_ids


def _render_existing_l2(doc: Document) -> str:
    if not doc.all_entries():
        return "(empty — first run)"
    return serialize(doc).strip()


def _render_existing_l3(doc: Document) -> str:
    if not doc.all_entries():
        return "(empty — first run)"
    return serialize(doc).strip()


def _chunk_with_ref_header(chunk_text: str, allowed: set[str]) -> str:
    if not allowed:
        return chunk_text
    refs = "\n".join(f"- {ref}" for ref in sorted(allowed))
    return f"# Chunk-local citeable refs\n{refs}\n\n{chunk_text}"


def _load_all_l2_docs() -> dict[str, Document]:
    from cognivoy.services.memory.document import parse

    docs: dict[str, Document] = {}
    for surface in paths.SURFACES:
        path = paths.l2_file(surface)
        if not path.exists():
            continue
        try:
            docs[surface] = parse(path.read_text(encoding="utf-8"))
        except Exception:
            continue
    return docs


def _default_l3_title(slot: L3Slot) -> str:
    return {
        "recent": "Recent summary",
        "profile": "User profile",
        "scope": "Knowledge scope",
        "preferences": "Preferences",
    }[slot]


__all__ = ["UpdateResult", "run_update"]
