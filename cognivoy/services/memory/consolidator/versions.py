"""Stable content versions shared by consolidation and overview metrics."""

from __future__ import annotations

import hashlib
import json

from cognivoy.services.memory.document import Entry
from cognivoy.services.memory.snapshot.entity import Entity


def entity_version(entity: Entity) -> str:
    payload = {
        "fingerprint": entity.fingerprint,
        "label": entity.label,
        "ts": entity.ts,
        "content": entity.content,
        "metadata": entity.metadata,
    }
    return _digest(payload)


def entry_version(entry: Entry) -> str:
    return _digest(
        {
            "section": entry.section,
            "text": entry.text,
            "refs": sorted(set(entry.refs)),
        }
    )


def version_diff_count(current: dict[str, str], seen: dict[str, str]) -> int:
    """Count added, modified, and deleted upstream items."""
    changed = sum(1 for key, version in current.items() if seen.get(key) != version)
    deleted = sum(1 for key in seen if key not in current)
    return changed + deleted


def _digest(payload: dict) -> str:
    raw = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()
