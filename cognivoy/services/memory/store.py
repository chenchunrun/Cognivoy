"""High-level facade for the three-layer memory subsystem.

All callers — API routers, LLM tools, surface event hooks — go through
:class:`MemoryStore`. The store is stateless; per-user isolation is
inherited from :func:`paths.memory_root` which resolves :class:`PathService`
lazily via context variables.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
from pathlib import Path
import shutil
from typing import Any, Literal, Sequence
import uuid

from cognivoy.services.memory import consolidator, paths, trace
from cognivoy.services.memory.consolidator import ConsolidateResult, OnEvent
from cognivoy.services.memory.document import Document, Entry, parse, serialize
from cognivoy.services.memory.ops import AddOp, ApplyReport, EditOp, OpResult
from cognivoy.services.memory.ops import apply as ops_apply
from cognivoy.services.memory.paths import L3Slot, Surface
from cognivoy.services.memory.trace import TraceEvent

logger = logging.getLogger(__name__)

Layer = Literal["L2", "L3"]

_V1_FILES = ("PROFILE.md", "SUMMARY.md")


def _normalize_pref_text(text: str) -> str:
    """Whitespace/case-insensitive key for duplicate-preference detection."""
    return " ".join(str(text or "").split()).casefold()


def _find_duplicate_preference(doc: Document, section: str, text: str):
    """Return an existing entry in ``section`` whose text matches ``text``.

    Read-only — does not create the section if it is absent.
    """
    target = _normalize_pref_text(text)
    if not target:
        return None
    for entry in doc.all_entries():
        if entry.section == section and _normalize_pref_text(entry.text) == target:
            return entry
    return None


def _conflict_entry_payload(entry: Entry, valid_l2_ids: set[str]) -> dict:
    ref_count = len(entry.refs)
    valid_ref_count = len(set(entry.refs) & valid_l2_ids)
    return {
        "id": entry.id,
        "section": entry.section,
        "text": entry.text,
        "refs": list(entry.refs),
        "ref_count": ref_count,
        "valid_ref_count": valid_ref_count,
        "confidence": round(valid_ref_count / ref_count, 3) if ref_count else 0.0,
    }


_NO_MEMORY = (
    "(No memory available — interact with Cognivoy and update from the Memory page to build one.)"
)


@dataclass
class DocOverview:
    layer: Layer
    key: str  # surface name (L2) or slot name (L3)
    exists: bool
    updated_at: str | None
    entry_count: int
    backlog: int  # versioned upstream inputs not reflected in this doc


class MemoryVersionConflict(ValueError):
    """An optimistic memory mutation targeted a stale document version."""

    def __init__(self, current_version: str) -> None:
        self.current_version = current_version
        super().__init__("memory document changed since it was loaded")


class MemoryStore:
    """Stateless facade. Safe to call as a process-wide singleton."""

    def __init__(self) -> None:
        self._write_locks: dict[str, asyncio.Lock] = {}

    # ── L1 ────────────────────────────────────────────────────────────────

    async def emit(self, event: TraceEvent) -> None:
        from cognivoy.services.memory.settings import load_memory_settings

        policy = load_memory_settings().collection
        if not policy.enabled or not policy.auto_capture:
            return
        if policy.retention_days > 0:
            await asyncio.to_thread(
                _prune_trace_retention,
                event.surface,
                policy.retention_days,
            )
        await trace.append(event)
        from cognivoy.services.memory.automation import get_auto_consolidation_scheduler

        get_auto_consolidation_scheduler().notify()

    # ── L2 / L3 read ──────────────────────────────────────────────────────

    def read_doc(self, layer: Layer, key: str) -> Document:
        path = self._path(layer, key)
        if not path.exists():
            return Document(title=_default_title(layer, key))
        return parse(path.read_text(encoding="utf-8"))

    def read_raw(self, layer: Layer, key: str) -> str:
        path = self._path(layer, key)
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def resource_version(self, layer: Layer, key: str) -> str:
        """Content-addressed document version used by optimistic writes."""
        digest = hashlib.sha256(self.read_raw(layer, key).encode("utf-8")).hexdigest()
        return f"sha256:{digest}"

    def list_resource_items(self, layer: Layer, key: str) -> list[dict[str, Any]]:
        path = self._path(layer, key)
        updated_at = (
            datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
            if path.exists()
            else None
        )
        version = self.resource_version(layer, key)
        states = self._read_resource_states()
        entries = self.read_doc(layer, key).all_entries()
        fallback_created_at = updated_at or datetime.now(tz=timezone.utc).isoformat()
        states_changed = False
        for entry in entries:
            state_key = self._resource_state_key(layer, key, entry.id)
            current = dict(states.get(state_key) or {})
            if not current.get("created_at"):
                current["created_at"] = fallback_created_at
                states[state_key] = current
                states_changed = True
        if states_changed:
            _atomic_write(
                self._resource_state_path(),
                json.dumps(states, ensure_ascii=False, indent=2, sort_keys=True),
            )
        return [
            {
                "id": entry.id,
                "layer": layer,
                "key": key,
                "section": entry.section,
                "text": entry.text,
                "refs": list(entry.refs),
                "source_count": len(entry.refs),
                "confidence": 1.0 if entry.refs else 0.0,
                "updated_at": updated_at,
                "status": "active",
                "version": version,
                **self._resource_state_payload(states, layer, key, entry.id),
            }
            for entry in entries
        ]

    def _active_doc(self, layer: Layer, key: str) -> Document:
        """Return a document with learner-paused entries removed."""
        doc = self.read_doc(layer, key)
        states = self._read_resource_states()
        retained: list[tuple[str, list[Entry]]] = []
        for section, entries in doc.sections:
            active = [
                entry
                for entry in entries
                if not self._resource_state_payload(states, layer, key, entry.id)["paused"]
            ]
            retained.append((section, active))
        doc.sections = retained
        return doc

    def read_l3_concat(self) -> str:
        """Concatenate all four L3 docs for the ``read_memory`` tool."""
        parts: list[str] = []
        used: list[tuple[Layer, str, str]] = []
        for slot in paths.L3_SLOTS:
            source_has_entries = bool(self.read_doc("L3", slot).all_entries())
            doc = self._active_doc("L3", slot)
            entries = doc.all_entries()
            # Pre-structured L3 files may contain headings and free-form
            # bullets without stable entry IDs. They remain readable until a
            # later consolidation migrates them; learner state controls only
            # apply once stable IDs exist.
            body = (
                serialize(doc).strip()
                if entries
                else ""
                if source_has_entries
                else self.read_raw("L3", slot).strip()
            )
            if body:
                parts.append(body)
                used.extend(("L3", slot, entry.id) for entry in entries)
        if used:
            self._touch_resources(used)
        if not parts:
            return _NO_MEMORY
        return "\n\n---\n\n".join(parts) + "\n"

    def read_l3_selected(self, references: Sequence[str]) -> str:
        """Read only the L3 slots explicitly selected for this turn.

        ``summary`` is the legacy client name for the ``recent`` slot. Unknown
        values are ignored and each canonical slot is included at most once.
        """
        aliases = {"summary": "recent"}
        selected: list[str] = []
        for reference in references:
            slot = aliases.get(reference, reference)
            if slot in paths.L3_SLOTS and slot not in selected:
                selected.append(slot)
        parts: list[str] = []
        used: list[tuple[Layer, str, str]] = []
        for slot in selected:
            source_has_entries = bool(self.read_doc("L3", slot).all_entries())
            doc = self._active_doc("L3", slot)
            entries = doc.all_entries()
            body = (
                serialize(doc).strip()
                if entries
                else ""
                if source_has_entries
                else self.read_raw("L3", slot).strip()
            )
            if body:
                parts.append(body)
                used.extend(("L3", slot, entry.id) for entry in entries)
        if used:
            self._touch_resources(used)
        return "\n\n---\n\n".join(parts) + "\n" if parts else _NO_MEMORY

    async def set_resource_state(
        self,
        layer: Layer,
        key: str,
        entry_id: str,
        *,
        paused: bool | None = None,
        flagged_incorrect: bool | None = None,
        reason: str | None = None,
    ) -> dict[str, Any] | None:
        """Persist learner control metadata without rewriting memory Markdown."""
        if self.read_doc(layer, key).find(entry_id) is None:
            return None
        state_path = self._resource_state_path()
        async with self._lock_for(state_path):
            states = self._read_resource_states()
            state_key = self._resource_state_key(layer, key, entry_id)
            current = dict(states.get(state_key) or {})
            if paused is not None:
                current["paused"] = bool(paused)
            if flagged_incorrect is not None:
                current["flagged_incorrect"] = bool(flagged_incorrect)
                if flagged_incorrect:
                    current["paused"] = True
            if reason is not None:
                current["reason"] = str(reason).strip()[:500]
            current["state_updated_at"] = datetime.now(tz=timezone.utc).isoformat()
            states[state_key] = current
            await asyncio.to_thread(
                _atomic_write,
                state_path,
                json.dumps(states, ensure_ascii=False, indent=2, sort_keys=True),
            )
        item = next(
            (
                resource
                for resource in self.list_resource_items(layer, key)
                if resource["id"] == entry_id
            ),
            None,
        )
        return item

    async def set_resource_projects(
        self,
        layer: Layer,
        key: str,
        entry_id: str,
        project_ids: Sequence[str],
    ) -> tuple[dict[str, Any] | None, list[str], list[str]]:
        """Persist explicit learner-approved project membership.

        Memory documents intentionally remain project-agnostic Markdown. The
        association therefore lives beside the other learner controls and is
        returned on every resource read.  The caller receives the membership
        delta so it can append an auditable learning-project event without
        guessing project ownership from memory text.
        """
        if self.read_doc(layer, key).find(entry_id) is None:
            return None, [], []
        normalized = list(
            dict.fromkeys(value for raw in project_ids if (value := str(raw).strip()))
        )
        state_path = self._resource_state_path()
        async with self._lock_for(state_path):
            states = self._read_resource_states()
            state_key = self._resource_state_key(layer, key, entry_id)
            current = dict(states.get(state_key) or {})
            previous = [
                str(value) for value in current.get("project_ids", []) if str(value).strip()
            ]
            previous_set = set(previous)
            next_set = set(normalized)
            added = [value for value in normalized if value not in previous_set]
            removed = [value for value in previous if value not in next_set]
            if added or removed:
                current["project_ids"] = normalized
                current["project_links_updated_at"] = datetime.now(tz=timezone.utc).isoformat()
                current["project_link_revision"] = (
                    int(current.get("project_link_revision") or 0) + 1
                )
                states[state_key] = current
                await asyncio.to_thread(
                    _atomic_write,
                    state_path,
                    json.dumps(states, ensure_ascii=False, indent=2, sort_keys=True),
                )
        item = next(
            (
                resource
                for resource in self.list_resource_items(layer, key)
                if resource["id"] == entry_id
            ),
            None,
        )
        return item, added, removed

    async def merge_resources(
        self,
        layer: Layer,
        key: str,
        entry_ids: Sequence[str],
        *,
        expected_version: str,
        merged_text: str | None = None,
        reason: str = "learner_merged_duplicates",
    ) -> dict[str, Any]:
        """Merge two or more duplicate memories while preserving all evidence."""
        unique_ids = list(dict.fromkeys(str(entry_id) for entry_id in entry_ids))
        if len(unique_ids) < 2:
            raise ValueError("select at least two memories to merge")
        path = self._path(layer, key)
        async with self._lock_for(path):
            current_version = self.resource_version(layer, key)
            if expected_version != current_version:
                raise MemoryVersionConflict(current_version)
            doc = self.read_doc(layer, key)
            entries = [doc.find(entry_id) for entry_id in unique_ids]
            if any(entry is None for entry in entries):
                raise ValueError("one or more memories no longer exist")
            found = [entry for entry in entries if entry is not None]
            section = found[0].section
            if any(entry.section != section for entry in found):
                raise ValueError("memories must belong to the same section")
            text = str(merged_text if merged_text is not None else found[0].text).strip()
            if not text:
                raise ValueError("merged memory text must not be empty")
            kept = found[0]
            refs = list(dict.fromkeys(ref for entry in found for ref in entry.refs))[:100]
            for duplicate in found[1:]:
                await self._write_tombstone(
                    layer,
                    key,
                    duplicate,
                    reason=reason[:500],
                )
                doc.remove(duplicate.id)
            doc.remove(kept.id)
            doc.section_entries(section).append(
                Entry(id=kept.id, section=section, text=text, refs=refs)
            )
            await asyncio.to_thread(_atomic_write, path, serialize(doc))
            return {
                "kept_id": kept.id,
                "merged_ids": unique_ids,
                "version": self.resource_version(layer, key),
                "item": next(
                    item for item in self.list_resource_items(layer, key) if item["id"] == kept.id
                ),
            }

    # ── L2 / L3 write (manual paths) ──────────────────────────────────────

    async def overwrite_doc(
        self,
        layer: Layer,
        key: str,
        md: str,
        *,
        expected_version: str | None = None,
    ) -> str:
        """Direct user-driven save from the workbench editor."""
        path = self._path(layer, key)
        async with self._lock_for(path):
            current_version = self.resource_version(layer, key)
            if expected_version is not None and expected_version != current_version:
                raise MemoryVersionConflict(current_version)
            await asyncio.to_thread(_atomic_write, path, md)
            return self.resource_version(layer, key)

    async def update_resource(
        self,
        layer: Layer,
        key: str,
        entry_id: str,
        *,
        expected_version: str,
        text: str,
        section: str | None = None,
        refs: list[str] | None = None,
    ) -> dict[str, Any] | None:
        path = self._path(layer, key)
        async with self._lock_for(path):
            current_version = self.resource_version(layer, key)
            if expected_version != current_version:
                raise MemoryVersionConflict(current_version)
            if not path.exists():
                return None
            doc = parse(path.read_text(encoding="utf-8"))
            entry = doc.find(entry_id)
            if entry is None:
                return None
            target_section = str(section if section is not None else entry.section).strip()
            target_text = str(text).strip()
            if not target_section or not target_text:
                raise ValueError("section and text must not be empty")
            target_refs = list(
                dict.fromkeys(
                    str(ref).strip()
                    for ref in (refs if refs is not None else entry.refs)
                    if str(ref).strip()
                )
            )[:100]
            doc.remove(entry_id)
            updated_entry = Entry(
                id=entry_id,
                section=target_section,
                text=target_text,
                refs=target_refs,
            )
            doc.section_entries(target_section).append(updated_entry)
            await asyncio.to_thread(_atomic_write, path, serialize(doc))
            new_version = self.resource_version(layer, key)
            item = next(
                resource
                for resource in self.list_resource_items(layer, key)
                if resource["id"] == entry_id
            )
            return {"item": item, "version": new_version}

    async def delete_resource(
        self,
        layer: Layer,
        key: str,
        entry_id: str,
        *,
        expected_version: str,
        reason: str,
    ) -> dict[str, Any] | None:
        path = self._path(layer, key)
        async with self._lock_for(path):
            current_version = self.resource_version(layer, key)
            if expected_version != current_version:
                raise MemoryVersionConflict(current_version)
            if not path.exists():
                return None
            doc = parse(path.read_text(encoding="utf-8"))
            entry = doc.find(entry_id)
            if entry is None:
                return None
            await self._write_tombstone(
                layer,
                key,
                entry,
                reason=str(reason or "user_delete")[:500],
            )
            doc.remove(entry_id)
            await asyncio.to_thread(_atomic_write, path, serialize(doc))
            return {
                "deleted": entry_id,
                "recoverable": True,
                "version": self.resource_version(layer, key),
            }

    async def delete_entry(self, layer: Layer, key: str, entry_id: str) -> bool:
        path = self._path(layer, key)
        if not path.exists():
            return False
        async with self._lock_for(path):
            doc = parse(path.read_text(encoding="utf-8"))
            entry = doc.find(entry_id)
            if entry is None:
                return False
            await self._write_tombstone(layer, key, entry)
            if not doc.remove(entry_id):
                return False
            await asyncio.to_thread(_atomic_write, path, serialize(doc))
            return True

    def list_deleted_entries(
        self,
        *,
        layer: Layer | None = None,
        key: str | None = None,
    ) -> list[dict]:
        root = paths.memory_root() / "trash"
        search = root
        if layer is not None:
            search = search / layer
        if key is not None:
            if layer is None:
                return []
            search = search / key
        if not search.exists():
            return []
        deleted: list[dict] = []
        for tombstone in search.rglob("*.json"):
            try:
                payload = json.loads(tombstone.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                logger.warning("Ignoring invalid memory tombstone %s", tombstone)
                continue
            if isinstance(payload, dict) and isinstance(payload.get("entry"), dict):
                deleted.append(payload)
        deleted.sort(key=lambda item: str(item.get("deleted_at", "")), reverse=True)
        return deleted

    async def restore_deleted_entry(
        self,
        layer: Layer,
        key: str,
        entry_id: str,
    ) -> bool:
        path = self._path(layer, key)
        tombstone_path = self._trash_path(layer, key, entry_id)
        if not tombstone_path.exists():
            return False
        async with self._lock_for(path):
            try:
                payload = json.loads(tombstone_path.read_text(encoding="utf-8"))
                raw = payload["entry"]
                restored = Entry(
                    id=str(raw["id"]),
                    section=str(raw["section"]),
                    text=str(raw["text"]),
                    refs=[str(ref) for ref in raw.get("refs", [])],
                )
            except (OSError, KeyError, TypeError, json.JSONDecodeError):
                return False
            doc = (
                parse(path.read_text(encoding="utf-8"))
                if path.exists()
                else Document(title=_default_title(layer, key))
            )
            if doc.find(entry_id) is None:
                doc.section_entries(restored.section).append(restored)
                await asyncio.to_thread(_atomic_write, path, serialize(doc))
            tombstone_path.unlink(missing_ok=True)
            return True

    async def permanently_delete_entry(
        self,
        layer: Layer,
        key: str,
        entry_id: str,
    ) -> bool:
        tombstone_path = self._trash_path(layer, key, entry_id)
        if not tombstone_path.exists():
            return False
        await asyncio.to_thread(tombstone_path.unlink)
        await self._remove_resource_state(layer, key, entry_id)
        return True

    @staticmethod
    def _resource_state_key(layer: Layer, key: str, entry_id: str) -> str:
        return f"{layer}:{key}:{entry_id}"

    @staticmethod
    def _resource_state_path() -> Path:
        return paths.memory_root() / "resource-state.json"

    def _read_resource_states(self) -> dict[str, dict[str, Any]]:
        path = self._resource_state_path()
        if not path.exists():
            return {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("Ignoring invalid memory resource state %s", path)
            return {}
        return payload if isinstance(payload, dict) else {}

    def _resource_state_payload(
        self,
        states: dict[str, dict[str, Any]],
        layer: Layer,
        key: str,
        entry_id: str,
    ) -> dict[str, Any]:
        state = states.get(self._resource_state_key(layer, key, entry_id)) or {}
        return {
            "created_at": state.get("created_at"),
            "paused": bool(state.get("paused", False)),
            "flagged_incorrect": bool(state.get("flagged_incorrect", False)),
            "state_reason": str(state.get("reason") or ""),
            "state_updated_at": state.get("state_updated_at"),
            "last_used_at": state.get("last_used_at"),
            "project_ids": [
                str(value) for value in state.get("project_ids", []) if str(value).strip()
            ],
            "project_links_updated_at": state.get("project_links_updated_at"),
            "project_link_revision": int(state.get("project_link_revision") or 0),
        }

    def _touch_resources(self, resources: Sequence[tuple[Layer, str, str]]) -> None:
        states = self._read_resource_states()
        now = datetime.now(tz=timezone.utc).isoformat()
        changed = False
        for layer, key, entry_id in resources:
            state_key = self._resource_state_key(layer, key, entry_id)
            current = dict(states.get(state_key) or {})
            current["last_used_at"] = now
            states[state_key] = current
            changed = True
        if changed:
            _atomic_write(
                self._resource_state_path(),
                json.dumps(states, ensure_ascii=False, indent=2, sort_keys=True),
            )

    async def _remove_resource_state(self, layer: Layer, key: str, entry_id: str) -> None:
        state_path = self._resource_state_path()
        async with self._lock_for(state_path):
            states = self._read_resource_states()
            removed = states.pop(self._resource_state_key(layer, key, entry_id), None)
            if removed is not None:
                await asyncio.to_thread(
                    _atomic_write,
                    state_path,
                    json.dumps(states, ensure_ascii=False, indent=2, sort_keys=True),
                )

    async def _write_tombstone(
        self,
        layer: Layer,
        key: str,
        entry: Entry,
        *,
        reason: str = "user_delete",
        resolution_id: str | None = None,
    ) -> Path:
        tombstone = {
            "layer": layer,
            "key": key,
            "deleted_at": datetime.now(tz=timezone.utc).isoformat(),
            "reason": reason,
            "resolution_id": resolution_id,
            "created_at": self._resource_state_payload(
                self._read_resource_states(), layer, key, entry.id
            ).get("created_at"),
            "entry": {
                "id": entry.id,
                "section": entry.section,
                "text": entry.text,
                "refs": list(entry.refs),
            },
        }
        trash_path = self._trash_path(layer, key, entry.id)
        await asyncio.to_thread(
            _atomic_write,
            trash_path,
            json.dumps(tombstone, ensure_ascii=False, indent=2),
        )
        return trash_path

    @staticmethod
    def _trash_path(layer: Layer, key: str, entry_id: str) -> Path:
        if any(
            not value or value in {".", ".."} or "/" in value or "\\" in value
            for value in (key, entry_id)
        ):
            raise ValueError("invalid memory trash path component")
        return paths.memory_root() / "trash" / layer / key / f"{entry_id}.json"

    # ── L3 conflict review ───────────────────────────────────────────────

    def find_conflicts(self, *, limit: int = 500) -> list[dict]:
        """Return deterministic L3 review candidates.

        This deliberately does not claim semantic contradiction. Two distinct
        statements in the same slot/section enter review only when they share
        at least one *currently valid* L2 evidence id. Confidence is the
        explainable ratio of valid references to all references.
        """
        valid_l2_ids = {
            entry.id
            for surface in paths.SURFACES
            for entry in self.read_doc("L2", surface).all_entries()
        }
        items: list[dict] = []
        for slot in paths.L3_SLOTS:
            doc = self.read_doc("L3", slot)
            for section, entries in doc.sections:
                ordered = sorted(entries, key=lambda entry: entry.id)
                for index, left in enumerate(ordered):
                    for right in ordered[index + 1 :]:
                        if _normalize_pref_text(left.text) == _normalize_pref_text(right.text):
                            continue
                        shared_refs = sorted(set(left.refs) & set(right.refs) & valid_l2_ids)
                        if not shared_refs:
                            continue
                        items.append(
                            {
                                "id": f"L3:{slot}:{left.id}:{right.id}",
                                "layer": "L3",
                                "key": slot,
                                "section": section,
                                "reason": "shared_evidence_distinct_claims",
                                "shared_refs": shared_refs,
                                "left": _conflict_entry_payload(left, valid_l2_ids),
                                "right": _conflict_entry_payload(right, valid_l2_ids),
                            }
                        )
                        if len(items) >= max(1, min(limit, 2_000)):
                            return items
        return items

    async def resolve_conflict(
        self,
        *,
        layer: Layer,
        key: str,
        left_id: str,
        right_id: str,
        action: Literal["keep_left", "keep_right", "merge", "delete_both"],
        merged_text: str | None = None,
        reason: str = "",
        conflict_id: str | None = None,
    ) -> dict:
        """Resolve one live conflict and preserve discarded entries in trash."""
        if layer != "L3":
            raise ValueError("conflict resolution is only supported for L3")
        if left_id == right_id:
            raise ValueError("conflict entries must be distinct")
        path = self._path(layer, key)
        if not path.exists():
            raise ValueError("memory document not found")
        resolution_id = f"mr_{uuid.uuid4().hex}"
        async with self._lock_for(path):
            doc = parse(path.read_text(encoding="utf-8"))
            left = doc.find(left_id)
            right = doc.find(right_id)
            if left is None or right is None:
                raise ValueError("conflict entry no longer exists")
            if left.section != right.section:
                raise ValueError("conflict entries must belong to the same section")
            if _normalize_pref_text(left.text) == _normalize_pref_text(right.text):
                raise ValueError("conflict entries are identical")
            shared_refs = sorted(set(left.refs) & set(right.refs))
            if not shared_refs:
                raise ValueError("conflict entries no longer share evidence")

            if action == "merge":
                normalized_merge = str(merged_text or "").strip()
                if not normalized_merge:
                    raise ValueError("merged_text is required for merge")
                if len(normalized_merge) > 4_000:
                    raise ValueError("merged_text is too long")
                left.text = normalized_merge
                left.refs = list(dict.fromkeys([*left.refs, *right.refs]))
                discarded = [right]
                kept_ids = [left.id]
            elif action == "keep_left":
                discarded = [right]
                kept_ids = [left.id]
            elif action == "keep_right":
                discarded = [left]
                kept_ids = [right.id]
            elif action == "delete_both":
                discarded = [left, right]
                kept_ids = []
            else:
                raise ValueError(f"unsupported conflict action {action!r}")

            created_tombstones: list[Path] = []
            try:
                for entry in discarded:
                    created_tombstones.append(
                        await self._write_tombstone(
                            layer,
                            key,
                            entry,
                            reason=f"conflict_resolution:{action}",
                            resolution_id=resolution_id,
                        )
                    )
                for entry in discarded:
                    if not doc.remove(entry.id):
                        raise RuntimeError(f"failed to remove conflict entry {entry.id}")
                await asyncio.to_thread(_atomic_write, path, serialize(doc))
            except Exception:
                for tombstone in created_tombstones:
                    tombstone.unlink(missing_ok=True)
                raise

            audit_record = {
                "id": resolution_id,
                "conflict_id": conflict_id
                or f"L3:{key}:{min(left_id, right_id)}:{max(left_id, right_id)}",
                "resolved_at": datetime.now(tz=timezone.utc).isoformat(),
                "layer": layer,
                "key": key,
                "section": left.section,
                "action": action,
                "left_id": left_id,
                "right_id": right_id,
                "shared_refs": shared_refs,
                "kept_ids": kept_ids,
                "deleted_ids": [entry.id for entry in discarded],
                "reason": reason.strip(),
            }
            await self._append_conflict_audit(audit_record)
            return audit_record

    def list_conflict_audit(self, *, limit: int = 100) -> list[dict]:
        path = self._conflict_audit_path()
        if not path.exists():
            return []
        records: list[dict] = []
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            logger.exception("Failed to read memory conflict audit")
            return []
        for line in lines[-max(1, min(limit, 1_000)) :]:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                records.append(payload)
        return records

    async def _append_conflict_audit(self, record: dict) -> None:
        path = self._conflict_audit_path()
        async with self._lock_for(path):
            existing = path.read_text(encoding="utf-8") if path.exists() else ""
            content = existing + json.dumps(record, ensure_ascii=False) + "\n"
            await asyncio.to_thread(_atomic_write, path, content)

    @staticmethod
    def _conflict_audit_path() -> Path:
        return paths.memory_root() / "conflict-audit.jsonl"

    # ── L2 / L3 write (consolidator paths) ────────────────────────────────

    async def update_l2(
        self,
        surface: Surface,
        *,
        language: str = "en",
        user_label: str = "anonymous",
        on_event: OnEvent | None = None,
        apply_ops: bool = True,
    ) -> ConsolidateResult:
        path = paths.l2_file(surface)
        async with self._lock_for(path):
            return await consolidator.consolidate_l2(
                surface,
                language=language,
                user_label=user_label,
                on_event=on_event,
                apply_ops=apply_ops,
            )

    async def update_l3(
        self,
        slot: L3Slot,
        *,
        language: str = "en",
        user_label: str = "anonymous",
        on_event: OnEvent | None = None,
        apply_ops: bool = True,
    ) -> ConsolidateResult:
        if slot == "preferences":
            raise ValueError("preferences.md is not auto-consolidated")
        path = paths.l3_file(slot)
        async with self._lock_for(path):
            return await consolidator.consolidate_l3(
                slot,
                language=language,
                user_label=user_label,
                on_event=on_event,
                apply_ops=apply_ops,
            )

    async def apply_ops_payload(
        self, layer: Layer, key: str, ops_payload: list[dict]
    ) -> ApplyReport:
        """Apply a list of ops-as-JSON to a layer doc atomically.

        Used by the workbench's preview → apply two-step flow. The
        payload typically comes from a previous ``apply_ops=False``
        consolidate call surfaced to the user for review.
        """
        from cognivoy.services.memory.consolidator import _parse_ops_response

        path = self._path(layer, key)
        json_like = {"ops": ops_payload}
        import json as _json

        ops = _parse_ops_response(_json.dumps(json_like, ensure_ascii=False))
        async with self._lock_for(path):
            default_title = _default_title(layer, key)
            doc = (
                parse(path.read_text(encoding="utf-8"))
                if path.exists()
                else Document(title=default_title)
            )
            report = ops_apply(doc, ops)
            if report.accepted and ops:
                path.parent.mkdir(parents=True, exist_ok=True)
                await asyncio.to_thread(_atomic_write, path, serialize(doc))
            return report

    async def write_preference(
        self,
        *,
        op: Literal["add", "edit"],
        text: str,
        target_id: str | None = None,
        reason: str | None = None,
        trace_id: str,
    ) -> ApplyReport:
        """Write the chat-mode preference signal. The ``write_memory`` tool
        is the only caller; ``trace_id`` is the current chat turn's L1 id
        injected by runtime."""
        path = paths.l3_file("preferences")
        async with self._lock_for(path):
            doc = (
                parse(path.read_text(encoding="utf-8"))
                if path.exists()
                else Document(title=_default_title("L3", "preferences"))
            )
            section = "Preferences"
            if op == "add":
                # Idempotent add: preferences.md is never auto-consolidated
                # (see update_l3), so an identical bullet added again would
                # persist forever as a duplicate. Guided-learning turns are
                # highly tool-driven and long-running, so the model tends to
                # re-issue the same write_memory across turns (issue #647).
                # Short-circuit to a no-op that reports the existing entry as
                # already saved instead of appending a duplicate.
                duplicate = _find_duplicate_preference(doc, section, text)
                if duplicate is not None:
                    return ApplyReport(
                        accepted=True,
                        results=[
                            OpResult(
                                op=AddOp(section=section, text=text, refs=[trace_id]),
                                status="applied",
                                entry_id=duplicate.id,
                                detail="duplicate",
                            )
                        ],
                    )
                report = ops_apply(
                    doc,
                    [AddOp(section=section, text=text, refs=[trace_id])],
                )
            else:
                if not target_id:
                    return ApplyReport(accepted=False, reason="edit requires target_id")
                report = ops_apply(
                    doc,
                    [
                        EditOp(
                            target_id=target_id,
                            new_text=text,
                            new_refs=[trace_id],
                        )
                    ],
                )
            if report.accepted:
                await asyncio.to_thread(_atomic_write, path, serialize(doc))
            if reason:
                # Surface the reason in logs for workbench observability.
                logger.info("write_memory %s id=%s reason=%s", op, target_id or "new", reason)
            return report

    # ── Workbench overview ────────────────────────────────────────────────

    def overview(self) -> list[DocOverview]:
        rows: list[DocOverview] = []
        for surface in paths.SURFACES:
            rows.append(self._overview_for("L2", surface))
        for slot in paths.L3_SLOTS:
            rows.append(self._overview_for("L3", slot))
        return rows

    def _overview_for(self, layer: Layer, key: str) -> DocOverview:
        path = self._path(layer, key)
        backlog = self._versioned_backlog(layer, key)
        if not path.exists():
            return DocOverview(
                layer=layer,
                key=key,
                exists=False,
                updated_at=None,
                entry_count=0,
                backlog=backlog,
            )

        stat = path.stat()
        updated_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        try:
            doc = parse(path.read_text(encoding="utf-8"))
            entry_count = len(doc.all_entries())
        except Exception:
            entry_count = 0

        return DocOverview(
            layer=layer,
            key=key,
            exists=True,
            updated_at=updated_at,
            entry_count=entry_count,
            backlog=backlog,
        )

    def _versioned_backlog(self, layer: Layer, key: str) -> int:
        """Use the exact version cursor consumed by the consolidator."""
        from cognivoy.services.memory import snapshot
        from cognivoy.services.memory.consolidator.meta import load_l2_meta, load_l3_meta
        from cognivoy.services.memory.consolidator.versions import (
            entity_version,
            entry_version,
            version_diff_count,
        )

        try:
            if layer == "L2":
                current = {
                    f"{key}:{entity.id}": entity_version(entity)
                    for entity in snapshot.read_snapshot(key)  # type: ignore[arg-type]
                }
                return version_diff_count(
                    current,
                    load_l2_meta(key).seen_entity_versions,  # type: ignore[arg-type]
                )

            current_by_surface = {
                surface: {
                    entry.id: entry_version(entry)
                    for entry in self.read_doc("L2", surface).all_entries()
                }
                for surface in paths.SURFACES
            }
            seen_by_surface = load_l3_meta(key).seen_l2_entry_versions  # type: ignore[arg-type]
            return sum(
                version_diff_count(
                    current_by_surface.get(surface, {}),
                    seen_by_surface.get(surface, {}),
                )
                for surface in set(current_by_surface) | set(seen_by_surface)
            )
        except Exception as exc:
            logger.warning("memory overview backlog failed for %s/%s: %s", layer, key, exc)
            return 0

    # ── Internals ─────────────────────────────────────────────────────────

    def _path(self, layer: Layer, key: str) -> Path:
        if layer == "L2":
            if key not in paths.SURFACES:
                raise ValueError(f"unknown surface {key!r}")
            return paths.l2_file(key)  # type: ignore[arg-type]
        if key not in paths.L3_SLOTS:
            raise ValueError(f"unknown L3 slot {key!r}")
        return paths.l3_file(key)  # type: ignore[arg-type]

    def _lock_for(self, path: Path) -> asyncio.Lock:
        key = str(path)
        lock = self._write_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._write_locks[key] = lock
        return lock


# ── v1 → v2 startup migration ─────────────────────────────────────────────


def migrate_v1_if_needed() -> Path | None:
    """If any v1 memory files are present under the memory root, move the
    whole memory directory's loose files into ``memory/backup/<ts>/``.

    Idempotent: if there's nothing v1-shaped at the root, this is a no-op.

    Returns the backup directory path on migration, or ``None`` otherwise.
    """
    root = paths.memory_root()
    if not root.exists():
        return None
    v1_present = [name for name in _V1_FILES if (root / name).exists()]
    if not v1_present:
        return None

    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = paths.backup_root() / ts
    backup_dir.mkdir(parents=True, exist_ok=True)
    for item in list(root.iterdir()):
        if item.name in {"trace", "L2", "L3", "backup"}:
            continue
        try:
            shutil.move(str(item), str(backup_dir / item.name))
        except OSError:
            logger.warning("v1 memory migration: failed to move %s", item, exc_info=True)
    logger.info("v1 memory migrated to %s", backup_dir)
    return backup_dir


def migrate_partner_surface_if_needed() -> bool:
    """Rename the legacy ``tutorbot`` memory surface to ``partner``.

    The partner surface key used to be ``tutorbot`` — so footnote refs read
    ``tutorbot:<id>`` and the consolidator even wrote "tutorbot" into L2
    prose. It is now ``partner``. This moves any on-disk artifacts (L2 doc +
    meta, snapshot dir, trace dir) to the new name, rewrites the ``tutorbot``
    token to ``partner`` inside the L2 doc/meta (both the ``tutorbot:`` ref
    prefix and the bare prose word), and renames the per-surface key inside
    every L3 meta.

    Idempotent: skips any target that already exists; a no-op when nothing
    tutorbot-shaped lives under the memory root.
    """
    import json
    import re

    root = paths.memory_root()
    if not root.exists():
        return False

    moved = False

    l2 = paths.l2_dir()
    old_md, new_md = l2 / "tutorbot.md", l2 / "partner.md"
    if old_md.exists() and not new_md.exists():
        text = old_md.read_text(encoding="utf-8")
        text = text.replace("tutorbot:", "partner:")  # footnote/inline refs
        text = re.sub(r"\btutorbot\b", "partner", text)  # bare prose word
        text = re.sub(r"\bTutorbot\b", "Partner", text)
        new_md.write_text(text, encoding="utf-8")
        old_md.unlink()
        moved = True
    old_meta, new_meta = l2 / "tutorbot.meta.json", l2 / "partner.meta.json"
    if old_meta.exists() and not new_meta.exists():
        text = old_meta.read_text(encoding="utf-8").replace("tutorbot:", "partner:")
        new_meta.write_text(text, encoding="utf-8")
        old_meta.unlink()
        moved = True

    # snapshot/<surface>/ and trace/<surface>/ — plain directory moves
    # (entity ids carry no surface prefix, so no content rewrite needed).
    for sub in ("snapshot", "trace"):
        old_dir, new_dir = root / sub / "tutorbot", root / sub / "partner"
        if old_dir.is_dir() and not new_dir.exists():
            shutil.move(str(old_dir), str(new_dir))
            moved = True

    # L3 metas track seen L2 entry ids per surface — rename that key.
    l3 = paths.l3_dir()
    if l3.is_dir():
        for meta_path in l3.glob("*.meta.json"):
            try:
                data = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            seen = data.get("seen_l2_entry_ids")
            if isinstance(seen, dict) and "tutorbot" in seen and "partner" not in seen:
                seen["partner"] = seen.pop("tutorbot")
                meta_path.write_text(
                    json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                moved = True

    if moved:
        logger.info("migrated legacy 'tutorbot' memory surface to 'partner'")
    return moved


# ── Singleton accessor ────────────────────────────────────────────────────


_singleton: MemoryStore | None = None


def get_memory_store() -> MemoryStore:
    global _singleton
    if _singleton is None:
        _singleton = MemoryStore()
    return _singleton


# ── Helpers ───────────────────────────────────────────────────────────────


def _default_title(layer: Layer, key: str) -> str:
    if layer == "L2":
        return f"{key} memory"
    return {
        "recent": "Recent summary",
        "profile": "User profile",
        "scope": "Knowledge scope",
        "preferences": "Preferences",
    }.get(key, key)


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _prune_trace_retention(surface: Surface, retention_days: int) -> int:
    """Remove complete UTC-day trace files older than the retention window.

    The boundary day is retained: with ``retention_days=30`` a file dated
    exactly 30 days ago remains available. Files with non-ISO names are never
    touched so an operator's diagnostics cannot be deleted accidentally.
    Returns the number of files removed for observability and focused tests.
    """
    if retention_days <= 0:
        return 0
    cutoff = datetime.now(tz=timezone.utc).date() - timedelta(days=retention_days)
    removed = 0
    for path in paths.trace_dir(surface).glob("*.jsonl"):
        try:
            file_day = datetime.strptime(path.stem, "%Y-%m-%d").date()
        except ValueError:
            logger.warning("Ignoring non-date memory trace file %s", path)
            continue
        if file_day >= cutoff:
            continue
        try:
            path.unlink()
            removed += 1
        except OSError:
            logger.warning("Failed to prune memory trace file %s", path, exc_info=True)
    return removed
