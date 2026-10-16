"""Impact analysis and durable tombstones for knowledge-base deletion."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
from typing import Any

from cognivoy.services.path_service import get_path_service

_SCALAR_KEYS = {"kb_name", "knowledge_base", "knowledgeBase"}
_LIST_KEYS = {"knowledge_bases", "knowledgeBases"}


def _json(value: str) -> Any:
    try:
        return json.loads(value or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}


def _contains_kb(value: Any, kb_name: str) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in _SCALAR_KEYS and str(item) == kb_name:
                return True
            if key in _LIST_KEYS and isinstance(item, list) and kb_name in map(str, item):
                return True
            if key == "references" and isinstance(item, list):
                for reference in item:
                    if not isinstance(reference, dict):
                        continue
                    kind = str(reference.get("type") or reference.get("kind") or "").lower()
                    target = (
                        reference.get("name") or reference.get("id") or reference.get("kb_name")
                    )
                    if (
                        kind in {"kb", "knowledge_base", "knowledge-base"}
                        and str(target) == kb_name
                    ):
                        return True
            if _contains_kb(item, kb_name):
                return True
    elif isinstance(value, list):
        return any(_contains_kb(item, kb_name) for item in value)
    return False


class KnowledgeReferenceService:
    def __init__(
        self,
        *,
        db_path: Path | None = None,
        notebook_dir: Path | None = None,
        workspace_dir: Path | None = None,
        tombstone_path: Path | None = None,
    ) -> None:
        paths = get_path_service()
        self.db_path = Path(db_path or paths.get_chat_history_db())
        self.notebook_dir = Path(notebook_dir or paths.get_notebook_dir())
        self.workspace_dir = Path(workspace_dir or paths.get_workspace_dir())
        self.tombstone_path = Path(
            tombstone_path or (paths.get_user_root() / "knowledge-tombstones.json")
        )
        self._lock = threading.RLock()

    def build_impact(self, kb_name: str) -> dict[str, Any]:
        sessions = self._session_references(kb_name)
        notebook_records = self._notebook_references(kb_name)
        workspace_files = self._workspace_references(kb_name)
        payload: dict[str, Any] = {
            "knowledge_base": kb_name,
            "counts": {
                "sessions": len(sessions),
                "notebook_records": len(notebook_records),
                "workspace_files": len(workspace_files),
            },
            "sessions": sessions,
            "notebook_records": notebook_records,
            "workspace_files": workspace_files,
        }
        payload["total_references"] = sum(payload["counts"].values())
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        payload["confirmation_token"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return payload

    def record_deletion(self, kb_name: str, *, impact: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            record = {
                "name": kb_name,
                "status": "deleted",
                "deleted_at": datetime.now(timezone.utc).isoformat(),
                "impact": impact,
            }
            data[kb_name] = record
            self._save(data)
            return record

    def get_tombstone(self, kb_name: str) -> dict[str, Any] | None:
        value = self._load().get(kb_name)
        return dict(value) if isinstance(value, dict) else None

    def list_tombstones(self) -> list[dict[str, Any]]:
        rows = [dict(value) for value in self._load().values() if isinstance(value, dict)]
        rows.sort(key=lambda row: str(row.get("deleted_at") or ""), reverse=True)
        return rows

    def _session_references(self, kb_name: str) -> list[dict[str, str]]:
        if not self.db_path.exists():
            return []
        found: set[str] = set()
        try:
            with sqlite3.connect(self.db_path) as conn:
                tables = {
                    str(row[0])
                    for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
                }
                if "sessions" in tables:
                    for session_id, preferences in conn.execute(
                        "SELECT id, preferences_json FROM sessions"
                    ):
                        if _contains_kb(_json(preferences), kb_name):
                            found.add(str(session_id))
                if "messages" in tables:
                    for session_id, metadata in conn.execute(
                        "SELECT session_id, metadata_json FROM messages"
                    ):
                        if _contains_kb(_json(metadata), kb_name):
                            found.add(str(session_id))
        except (OSError, sqlite3.DatabaseError):
            return []
        return [{"session_id": session_id} for session_id in sorted(found)]

    def _notebook_references(self, kb_name: str) -> list[dict[str, str]]:
        found: list[dict[str, str]] = []
        if not self.notebook_dir.exists():
            return found
        for path in sorted(self.notebook_dir.glob("*.json")):
            value = _json(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                continue
            notebook_id = str(value.get("id") or path.stem)
            for record in value.get("records") or []:
                if isinstance(record, dict) and _contains_kb(record, kb_name):
                    found.append(
                        {
                            "notebook_id": notebook_id,
                            "record_id": str(record.get("id") or ""),
                            "title": str(record.get("title") or ""),
                        }
                    )
        return found

    def _workspace_references(self, kb_name: str) -> list[dict[str, str]]:
        found: list[dict[str, str]] = []
        if not self.workspace_dir.exists():
            return found
        for path in sorted(self.workspace_dir.rglob("*.json")):
            try:
                relative = path.relative_to(self.workspace_dir)
            except ValueError:
                continue
            if relative.parts and relative.parts[0] in {"notebook", "chat"}:
                continue
            try:
                value = _json(path.read_text(encoding="utf-8"))
            except OSError:
                continue
            if _contains_kb(value, kb_name):
                found.append({"path": relative.as_posix()})
        return found

    def _load(self) -> dict[str, Any]:
        if not self.tombstone_path.exists():
            return {}
        try:
            value = json.loads(self.tombstone_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _save(self, value: dict[str, Any]) -> None:
        self.tombstone_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.tombstone_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )
        temporary.replace(self.tombstone_path)


def get_knowledge_reference_service() -> KnowledgeReferenceService:
    return KnowledgeReferenceService()


__all__ = ["KnowledgeReferenceService", "get_knowledge_reference_service"]
