"""Reference validation + raw-trace lookup used by update / audit.

Two distinct concerns share this module because they both center on
"the set of refs the LLM is allowed to cite":

* **Update mode** — refs must point at entities that appear in the
  current chunk's source range. :func:`refs_in_chunk` returns the
  allowed pool; :func:`validate_fact_refs` filters extracted facts.
* **Audit mode** — every entry on a md chunk gets its raw-trace
  content spliced in as evidence. :func:`annotate_line_with_evidence`
  formats one entry + sources into a block fed to the LLM.

No I/O happens beyond reading from the same in-memory entity / L2 doc
maps the caller has already loaded — the modes are responsible for
hydrating those once per run.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
import re
from typing import Iterable

from cognivoy.services.memory.document import Document, Entry
from cognivoy.services.memory.ids import is_entry_id, is_valid_ref
from cognivoy.services.memory.snapshot.entity import Entity

logger = logging.getLogger(__name__)


# ── Update-mode helpers ─────────────────────────────────────────────────


@dataclass(frozen=True)
class ExtractedFact:
    """One fact pulled by the LLM during update mode."""

    text: str
    refs: list[str]
    section: str = ""


def refs_in_chunk_l2(
    entities: Iterable[Entity],
    *,
    surface: str,
    chunk_text: str,
) -> set[str]:
    """Set of allowed refs (``surface:entity_id``) for this chunk.

    An entity is considered "in this chunk" if its rendered marker
    appears in ``chunk_text``. The marker is the same one written by
    :func:`render_traces_for_concat`.
    """
    allowed: set[str] = set()
    for ent in entities:
        marker = _entity_marker(surface, ent.id)
        if marker in chunk_text:
            allowed.add(f"{surface}:{ent.id}")
    return allowed


def refs_in_span_l2(
    entities: Iterable[Entity],
    *,
    surface: str,
    full_text: str,
    start: int,
    end: int,
) -> set[str]:
    """Allowed L2 refs for a chunk span, including long split entities."""
    markers: list[tuple[int, str]] = []
    for ent in entities:
        marker = _entity_marker(surface, ent.id)
        pos = full_text.find(marker)
        if pos != -1:
            markers.append((pos, f"{surface}:{ent.id}"))
    return _refs_overlapping_span(markers, text_len=len(full_text), start=start, end=end)


_L3_ENTRY_MARKER_RE = re.compile(r"^=== @l2 (m_[0-9A-HJKMNP-TV-Z]{26}) ===$", re.MULTILINE)


def refs_in_chunk_l3(
    chunk_text: str,
    *,
    entries_by_surface: dict[str, list[Entry]],
) -> set[str]:
    """Return the L2 entry ids that are visible in an L3 source chunk."""
    del entries_by_surface
    return {m.group(1) for m in _L3_ENTRY_MARKER_RE.finditer(chunk_text)}


def refs_in_span_l3(
    *,
    entries_by_surface: dict[str, list[Entry]],
    full_text: str,
    start: int,
    end: int,
) -> set[str]:
    """L2 entry refs whose rendered block intersects ``[start, end)``."""
    del entries_by_surface
    markers = [(match.start(), match.group(1)) for match in _L3_ENTRY_MARKER_RE.finditer(full_text)]
    if not markers:
        return set()
    return _refs_overlapping_span(markers, text_len=len(full_text), start=start, end=end)


def validate_fact_refs(
    fact: ExtractedFact,
    *,
    allowed: set[str],
    enforce_required: bool,
    drop_invalid: bool,
) -> tuple[list[str], str | None]:
    """Filter / reject a fact's refs.

    Returns ``(kept_refs, reject_reason)``. ``reject_reason`` is ``None``
    when the fact survives. Behavior:

    * ``enforce_required=True`` + no refs → reject.
    * ``drop_invalid=True``: refs outside ``allowed`` are removed;
      if the result is empty under ``enforce_required`` → reject.
    * ``drop_invalid=False``: any out-of-pool ref → reject the fact.
    """
    if not fact.refs:
        if enforce_required:
            return [], "missing refs"
        return [], None

    if drop_invalid:
        kept = [
            normalized
            for ref in fact.refs
            if (normalized := _normalize_allowed_ref(ref, allowed)) is not None
        ]
        if not kept and enforce_required:
            return [], "no surviving refs in chunk pool"
        return _dedupe(kept), None

    for ref in fact.refs:
        normalized = _normalize_allowed_ref(ref, allowed)
        if normalized is None and not is_valid_ref(ref):
            return [], f"malformed ref {ref!r}"
        if normalized is None:
            return [], f"out-of-pool ref {ref!r}"
    return _dedupe([_normalize_allowed_ref(ref, allowed) or ref for ref in fact.refs]), None


# ── Rendering: traces → concatenated text ───────────────────────────────


_ENTITY_HEADER_FMT = "=== {marker} ==="
# ``_L2_ENTRY_HEADER_FMT`` and ``_l2_entry_marker`` are no longer used:
# the L3 input is text-only, so no L2-entry markers are emitted. They
# would have been ``"=== @l2 m_xxx ==="``.


def render_traces_for_concat(entities: list[Entity], *, surface: str) -> str:
    """Concatenate a list of L2 raw-trace entities into one timeline string.

    The chunk-pool detector relies on the marker line being unique per
    entity, so it doubles as both a human delimiter and a machine anchor.
    """
    blocks: list[str] = []
    for ent in entities:
        header = _ENTITY_HEADER_FMT.format(marker=_entity_marker(surface, ent.id))
        meta_str = _format_meta(ent)
        body = (ent.content or "").strip()
        block = "\n".join(
            x
            for x in (
                header,
                f"ref: {surface}:{ent.id}",
                f"label: {ent.label}",
                f"ts: {ent.ts or '?'}",
                f"meta: {meta_str}" if meta_str else None,
                "",
                body,
            )
            if x is not None
        )
        blocks.append(block)
    return "\n\n".join(blocks)


def render_l2_entries_for_concat(
    entries_by_surface: dict[str, list[Entry]],
) -> str:
    """Concatenate L2 prose with stable entry-id citation anchors.

    Upstream L1 refs remain hidden, but every L2 statement gets a marker so
    L3 claims can be traced to the exact evidence item instead of a whole
    surface file.
    """
    blocks: list[str] = []
    for surface, entries in entries_by_surface.items():
        if not entries:
            continue
        blocks.append(f"### surface: {surface}")
        for entry in entries:
            blocks.extend(
                [
                    f"=== @l2 {entry.id} ===",
                    f"ref: {entry.id}",
                    f"section: {entry.section or 'Notes'}",
                    entry.text,
                ]
            )
    return "\n\n".join(blocks)


# ── Audit-mode helpers ──────────────────────────────────────────────────


def annotate_l2_line_with_evidence(
    line_number: int,
    entry: Entry,
    *,
    surface: str,
    entity_lookup: dict[str, Entity],
) -> str:
    """Render one L2 bullet + every raw trace it cites, full content.

    Output is intentionally human-readable so the model can reason
    about correspondence (md statement ↔ original wording). No
    truncation, ever — that is the point of audit mode.
    """
    lines: list[str] = [
        f"line {line_number}: {entry.text} [^{entry.id}]",
        f"  section: {entry.section}",
    ]
    if not entry.refs:
        lines.append("  sources: (none)")
        return "\n".join(lines)
    lines.append(f"  sources ({len(entry.refs)}):")
    for ref in entry.refs:
        if ":" not in ref:
            lines.append(f"    └ {ref}: (malformed)")
            continue
        _, ent_id = ref.split(":", 1)
        ent = entity_lookup.get(ent_id)
        if ent is None:
            lines.append(f"    └ {ref}: (entity not found in current workspace)")
            continue
        body = (ent.content or "").rstrip()
        lines.append(f"    └ {ref} (ts={ent.ts or '?'}, label={ent.label!r}):")
        for src_line in body.splitlines():
            lines.append(f"        {src_line}")
    return "\n".join(lines)


def annotate_l3_line_with_evidence(
    line_number: int,
    entry: Entry,
    *,
    l2_entry_lookup: dict[str, Entry],
) -> str:
    """Render one L3 bullet + every L2 entry it cites, full text + refs."""
    lines: list[str] = [
        f"line {line_number}: {entry.text} [^{entry.id}]",
        f"  section: {entry.section}",
    ]
    if not entry.refs:
        lines.append("  sources: (none)")
        return "\n".join(lines)
    lines.append(f"  sources ({len(entry.refs)}):")
    for ref in entry.refs:
        if not is_entry_id(ref):
            lines.append(f"    └ {ref}: (malformed L2 id)")
            continue
        src = l2_entry_lookup.get(ref)
        if src is None:
            lines.append(f"    └ {ref}: (L2 entry not found)")
            continue
        lines.append(f"    └ {ref} (section={src.section!r}):")
        lines.append(f"        {src.text}")
        if src.refs:
            lines.append(f"        upstream refs: {', '.join(src.refs)}")
    return "\n".join(lines)


# ── Internals ───────────────────────────────────────────────────────────


def _entity_marker(surface: str, entity_id: str) -> str:
    return f"@entity {surface}:{entity_id}"


def _format_meta(ent: Entity) -> str:
    if not ent.metadata:
        return ""
    bits = [f"{k}={v}" for k, v in ent.metadata.items() if v not in (None, "", [], {})]
    return " ".join(bits)


def _normalize_allowed_ref(ref: str, allowed: set[str]) -> str | None:
    """Return the canonical allowed ref when the model added label text.

    LLMs often copy a rendered source as ``<label>:chat:<id>`` even though
    the prompt asks for ``chat:<id>``. Treat that as a recoverable citation
    as long as it unambiguously ends with an allowed chunk-local ref.
    """
    candidate = _strip_ref_wrappers(str(ref).strip())
    if candidate in allowed and is_valid_ref(candidate):
        return candidate
    for allowed_ref in sorted(allowed, key=len, reverse=True):
        if not is_valid_ref(allowed_ref):
            continue
        if _has_ref_suffix(candidate, allowed_ref):
            return allowed_ref
    return None


def _strip_ref_wrappers(ref: str) -> str:
    return ref.strip().strip("`[](){}<>").lstrip("^").strip()


def _has_ref_suffix(candidate: str, allowed_ref: str) -> bool:
    if candidate == allowed_ref:
        return True
    if not candidate.endswith(allowed_ref):
        return False
    prefix = candidate[: -len(allowed_ref)]
    if not prefix:
        return True
    # Common hallucinated forms: "Title:chat:id", "Title?chat:id",
    # "[^m_id]". Do not accept alnum/underscore adjacency.
    return prefix[-1] in {":", "：", "?", "？", "#", "/", "|", " ", "\t", "\n", "^"}


def _dedupe(refs: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for ref in refs:
        if ref in seen:
            continue
        seen.add(ref)
        out.append(ref)
    return out


def _refs_overlapping_span(
    markers: list[tuple[int, str]], *, text_len: int, start: int, end: int
) -> set[str]:
    allowed: set[str] = set()
    ordered = sorted(markers, key=lambda item: item[0])
    for idx, (block_start, ref) in enumerate(ordered):
        block_end = ordered[idx + 1][0] if idx + 1 < len(ordered) else text_len
        if block_start < end and block_end > start:
            allowed.add(ref)
    return allowed


def collect_l2_entries(docs: dict[str, Document]) -> dict[str, list[Entry]]:
    """Helper for L3 — pull all entries from a {surface: Document} map."""
    return {surface: doc.all_entries() for surface, doc in docs.items()}


__all__ = [
    "ExtractedFact",
    "annotate_l2_line_with_evidence",
    "annotate_l3_line_with_evidence",
    "collect_l2_entries",
    "refs_in_chunk_l2",
    "refs_in_chunk_l3",
    "refs_in_span_l2",
    "refs_in_span_l3",
    "render_l2_entries_for_concat",
    "render_traces_for_concat",
    "validate_fact_refs",
]
