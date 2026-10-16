"""Per-doc consolidator metadata (``*.meta.json`` files).

For each L2/L3 markdown doc we keep a sidecar JSON capturing the content
version of every upstream item seen by the last successful update.  The
versioned cursor detects additions, edits, and deletions without relying on
mtime or wall-clock ordering.

Files
-----
* ``memory/L2/<surface>.meta.json``::

      {
        "version": 2,
        "last_update_at": "<iso-utc>",
        "seen_entity_versions": {"chat:01HZK4...": "sha256:..."}
      }

* ``memory/L3/<slot>.meta.json``::

      {
        "version": 2,
        "last_update_at": "<iso-utc>",
        "seen_l2_entry_versions": {
          "chat": {"m_xxx": "sha256:..."},
          "notebook": {"m_yyy": "sha256:..."},
          ...
        }
      }

Atomic writes via temp + rename. Missing files behave as "first run".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import tempfile

from cognivoy.services.memory import paths
from cognivoy.services.memory.paths import L3Slot, Surface

logger = logging.getLogger(__name__)

_META_VERSION = 2


# ── L2 meta ─────────────────────────────────────────────────────────────


@dataclass
class L2Meta:
    last_update_at: str | None = None
    seen_entity_versions: dict[str, str] = field(default_factory=dict)

    @property
    def seen_entity_refs(self) -> set[str]:
        """Compatibility view for callers/tests written against v1 metadata."""
        return set(self.seen_entity_versions)


def l2_meta_path(surface: Surface) -> Path:
    return paths.l2_dir() / f"{surface}.meta.json"


def load_l2_meta(surface: Surface) -> L2Meta:
    return _load_meta_l2(l2_meta_path(surface))


def save_l2_meta(
    surface: Surface,
    *,
    seen_entity_versions: dict[str, str] | None = None,
    seen_entity_refs: set[str] | None = None,
) -> L2Meta:
    path = l2_meta_path(surface)
    meta = L2Meta(
        last_update_at=_now_iso(),
        seen_entity_versions=(
            dict(seen_entity_versions)
            if seen_entity_versions is not None
            else {ref: "" for ref in (seen_entity_refs or set())}
        ),
    )
    _atomic_write_json(
        path,
        {
            "version": _META_VERSION,
            "last_update_at": meta.last_update_at,
            "seen_entity_versions": dict(sorted(meta.seen_entity_versions.items())),
        },
    )
    return meta


# ── L3 meta ─────────────────────────────────────────────────────────────


@dataclass
class L3Meta:
    last_update_at: str | None = None
    seen_l2_entry_versions: dict[str, dict[str, str]] = field(default_factory=dict)

    @property
    def seen_l2_entry_ids(self) -> dict[str, set[str]]:
        """Compatibility view for callers/tests written against v1 metadata."""
        return {surface: set(versions) for surface, versions in self.seen_l2_entry_versions.items()}


def l3_meta_path(slot: L3Slot) -> Path:
    return paths.l3_dir() / f"{slot}.meta.json"


def load_l3_meta(slot: L3Slot) -> L3Meta:
    return _load_meta_l3(l3_meta_path(slot))


def save_l3_meta(
    slot: L3Slot,
    *,
    seen_l2_entry_versions: dict[str, dict[str, str]] | None = None,
    seen_l2_entry_ids: dict[str, set[str]] | None = None,
) -> L3Meta:
    path = l3_meta_path(slot)
    meta = L3Meta(
        last_update_at=_now_iso(),
        seen_l2_entry_versions=(
            {surface: dict(versions) for surface, versions in seen_l2_entry_versions.items()}
            if seen_l2_entry_versions is not None
            else {
                surface: {entry_id: "" for entry_id in ids}
                for surface, ids in (seen_l2_entry_ids or {}).items()
            }
        ),
    )
    _atomic_write_json(
        path,
        {
            "version": _META_VERSION,
            "last_update_at": meta.last_update_at,
            "seen_l2_entry_versions": {
                surface: dict(sorted(versions.items()))
                for surface, versions in sorted(meta.seen_l2_entry_versions.items())
            },
        },
    )
    return meta


# ── Internals ───────────────────────────────────────────────────────────


def _load_meta_l2(path: Path) -> L2Meta:
    data = _read_json(path)
    if not data:
        return L2Meta()
    versions = data.get("seen_entity_versions")
    if not isinstance(versions, dict):
        refs = data.get("seen_entity_refs") or []
        versions = {str(ref): "" for ref in refs} if isinstance(refs, list) else {}
    return L2Meta(
        last_update_at=data.get("last_update_at"),
        seen_entity_versions={
            str(ref): str(version) for ref, version in versions.items() if str(ref)
        },
    )


def _load_meta_l3(path: Path) -> L3Meta:
    data = _read_json(path)
    if not data:
        return L3Meta()
    raw = data.get("seen_l2_entry_versions")
    if not isinstance(raw, dict):
        legacy = data.get("seen_l2_entry_ids") or {}
        raw = (
            {
                surface: {str(entry_id): "" for entry_id in ids}
                for surface, ids in legacy.items()
                if isinstance(ids, list)
            }
            if isinstance(legacy, dict)
            else {}
        )
    if not isinstance(raw, dict):
        raw = {}
    return L3Meta(
        last_update_at=data.get("last_update_at"),
        seen_l2_entry_versions={
            str(surface): {
                str(entry_id): str(version)
                for entry_id, version in versions.items()
                if str(entry_id)
            }
            for surface, versions in raw.items()
            if isinstance(versions, dict)
        },
    )


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("memory meta: failed to read %s: %s", path, exc)
        return None


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_str = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_str, path)
    finally:
        if os.path.exists(tmp_str):
            try:
                os.remove(tmp_str)
            except OSError:
                pass


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


__all__ = [
    "L2Meta",
    "L3Meta",
    "l2_meta_path",
    "l3_meta_path",
    "load_l2_meta",
    "load_l3_meta",
    "save_l2_meta",
    "save_l3_meta",
]
