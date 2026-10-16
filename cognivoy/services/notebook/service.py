"""
Shared notebook manager.

This module keeps the notebook storage format unchanged so Web and CLI
can operate on the same files under ``data/user``.
"""

from __future__ import annotations

from copy import deepcopy
from enum import Enum
import json
from pathlib import Path
import re
import threading
import time
import uuid

from pydantic import BaseModel, Field

from cognivoy.services.llm import clean_thinking_tags
from cognivoy.services.path_service import get_path_service


class RecordType(str, Enum):
    """Notebook record type."""

    SOLVE = "solve"
    QUESTION = "question"
    RESEARCH = "research"
    CHAT = "chat"
    CO_WRITER = "co_writer"
    TUTORBOT = "tutorbot"


class NotebookRecord(BaseModel):
    """Single record stored in a notebook."""

    id: str
    type: RecordType
    title: str
    summary: str = ""
    user_query: str
    output: str
    metadata: dict = Field(default_factory=dict)
    created_at: float
    updated_at: float
    revision: int = 1
    tags: list[str] = Field(default_factory=list)
    references: list[dict] = Field(default_factory=list)
    idempotency_key: str | None = None
    kb_name: str | None = None


class Notebook(BaseModel):
    """Notebook model."""

    id: str
    name: str
    description: str = ""
    created_at: float
    updated_at: float
    records: list[NotebookRecord] = Field(default_factory=list)
    color: str = "#3B82F6"
    icon: str = "book"


_UNSET = object()


class NotebookRevisionConflict(ValueError):
    """Raised when an optimistic record update targets a stale revision."""

    def __init__(self, current: dict) -> None:
        self.current = deepcopy(current)
        super().__init__("notebook record revision conflict")


def _clean_record_summary(summary: str) -> str:
    """Remove private model scratchpads before notebook summaries are persisted."""
    return clean_thinking_tags(str(summary or "")).strip()


def _normalize_tags(tags: list[str] | None) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in tags or []:
        value = str(raw).strip()
        key = value.casefold()
        if not value or key in seen:
            continue
        seen.add(key)
        normalized.append(value)
    return normalized[:50]


def _normalize_references(references: list[dict] | None) -> list[dict]:
    normalized: list[dict] = []
    for raw in references or []:
        if not isinstance(raw, dict):
            continue
        item = {str(key): value for key, value in raw.items() if str(key).strip()}
        if item and item not in normalized:
            normalized.append(item)
    return normalized[:100]


def _markdown_records(markdown: str, *, fallback_title: str = "Imported note") -> list[dict]:
    """Split Markdown into stable record payloads at H2 boundaries."""
    content = str(markdown or "").strip()
    if not content:
        raise ValueError("markdown content must not be empty")
    lines = content.splitlines()
    document_title = fallback_title.strip() or "Imported note"
    for line in lines:
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            document_title = match.group(1).strip()
            break

    sections: list[tuple[str, list[str]]] = []
    current_title: str | None = None
    current_lines: list[str] = []
    for line in lines:
        match = re.match(r"^##\s+(.+?)\s*$", line)
        if match:
            if current_title is not None:
                sections.append((current_title, current_lines))
            current_title = match.group(1).strip()
            current_lines = []
        elif current_title is not None:
            current_lines.append(line)
    if current_title is not None:
        sections.append((current_title, current_lines))

    if not sections:
        return [{"title": document_title, "output": content}]
    return [
        {
            "title": title,
            "output": f"## {title}\n\n{chr(10).join(body).strip()}".rstrip(),
        }
        for title, body in sections
    ]


class NotebookManager:
    """Manage notebook files stored under ``data/user/workspace/notebook``."""

    def __init__(self, base_dir: str | None = None):
        if base_dir is None:
            path_service = get_path_service()
            base_dir_path = path_service.get_notebook_dir()
        else:
            base_dir_path = Path(base_dir)

        self.base_dir = base_dir_path
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.index_file = self.base_dir / "notebooks_index.json"
        self._lock = threading.RLock()
        self._ensure_index()

    def _ensure_index(self) -> None:
        if not self.index_file.exists():
            with open(self.index_file, "w", encoding="utf-8") as f:
                json.dump({"notebooks": []}, f, indent=2, ensure_ascii=False)

    def _load_index(self) -> dict:
        try:
            with open(self.index_file, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {"notebooks": []}

    def _save_index(self, index: dict) -> None:
        with open(self.index_file, "w", encoding="utf-8") as f:
            json.dump(index, f, indent=2, ensure_ascii=False)

    def _get_notebook_file(self, notebook_id: str) -> Path:
        return self.base_dir / f"{notebook_id}.json"

    def _load_notebook(self, notebook_id: str) -> dict | None:
        filepath = self._get_notebook_file(notebook_id)
        if not filepath.exists():
            return None
        try:
            with open(filepath, encoding="utf-8") as f:
                notebook = json.load(f)
        except Exception:
            return None
        if self._sanitize_loaded_notebook(notebook):
            try:
                self._save_notebook(notebook)
            except Exception:
                pass
        return notebook

    def _sanitize_loaded_notebook(self, notebook: dict) -> bool:
        changed = False
        records = notebook.get("records", [])
        if not isinstance(records, list):
            return False
        for record in records:
            if not isinstance(record, dict):
                continue
            raw_summary = record.get("summary", "")
            cleaned = _clean_record_summary(raw_summary)
            if cleaned != raw_summary:
                record["summary"] = cleaned
                changed = True
            metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
            if record.get("metadata") is not metadata:
                record["metadata"] = metadata
                changed = True
            created_at = float(record.get("created_at") or time.time())
            defaults = {
                "updated_at": created_at,
                "revision": 1,
                "tags": _normalize_tags(
                    record.get("tags")
                    if isinstance(record.get("tags"), list)
                    else metadata.get("tags")
                    if isinstance(metadata.get("tags"), list)
                    else []
                ),
                "references": _normalize_references(
                    record.get("references")
                    if isinstance(record.get("references"), list)
                    else metadata.get("source_refs")
                    if isinstance(metadata.get("source_refs"), list)
                    else []
                ),
                "idempotency_key": None,
            }
            for key, value in defaults.items():
                if key not in record:
                    record[key] = value
                    changed = True
        return changed

    def _save_notebook(self, notebook: dict) -> None:
        filepath = self._get_notebook_file(notebook["id"])
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(notebook, f, indent=2, ensure_ascii=False)

    def _touch_index_entry(self, notebook_id: str, notebook: dict) -> None:
        index = self._load_index()
        for nb_info in index.get("notebooks", []):
            if nb_info["id"] != notebook_id:
                continue
            nb_info["name"] = notebook.get("name", nb_info.get("name", ""))
            nb_info["description"] = notebook.get("description", nb_info.get("description", ""))
            nb_info["updated_at"] = notebook["updated_at"]
            nb_info["record_count"] = len(notebook.get("records", []))
            nb_info["color"] = notebook.get("color", nb_info.get("color", "#3B82F6"))
            nb_info["icon"] = notebook.get("icon", nb_info.get("icon", "book"))
            break
        self._save_index(index)

    # === Notebook Operations ===

    def create_notebook(
        self, name: str, description: str = "", color: str = "#3B82F6", icon: str = "book"
    ) -> dict:
        notebook_id = str(uuid.uuid4())[:8]
        now = time.time()

        notebook = {
            "id": notebook_id,
            "name": name,
            "description": description,
            "created_at": now,
            "updated_at": now,
            "records": [],
            "color": color,
            "icon": icon,
        }

        self._save_notebook(notebook)

        index = self._load_index()
        index["notebooks"].append(
            {
                "id": notebook_id,
                "name": name,
                "description": description,
                "created_at": now,
                "updated_at": now,
                "record_count": 0,
                "color": color,
                "icon": icon,
            }
        )
        self._save_index(index)
        return notebook

    def list_notebooks(self) -> list[dict]:
        index = self._load_index()
        notebooks: list[dict] = []
        entries = index.get("notebooks", [])
        if not isinstance(entries, list):
            entries = []
        complete_fields = {
            "id",
            "name",
            "description",
            "created_at",
            "updated_at",
            "record_count",
            "color",
            "icon",
        }
        repaired = False
        retained_entries: list[dict] = []
        for raw_info in entries:
            if not isinstance(raw_info, dict) or not str(raw_info.get("id") or ""):
                repaired = True
                continue
            notebook_id = str(raw_info["id"])
            if not self._get_notebook_file(notebook_id).exists():
                repaired = True
                continue
            nb_info = raw_info
            if not complete_fields.issubset(nb_info):
                notebook = self._load_notebook(notebook_id)
                if notebook is None:
                    repaired = True
                    continue
                nb_info = {
                    "id": notebook["id"],
                    "name": notebook["name"],
                    "description": notebook.get("description", ""),
                    "created_at": notebook["created_at"],
                    "updated_at": notebook["updated_at"],
                    "record_count": len(notebook.get("records", [])),
                    "color": notebook.get("color", "#3B82F6"),
                    "icon": notebook.get("icon", "book"),
                }
                repaired = True
            retained_entries.append(nb_info)
            notebooks.append({key: deepcopy(nb_info[key]) for key in complete_fields})

        if repaired:
            index["notebooks"] = retained_entries
            self._save_index(index)

        notebooks.sort(key=lambda x: x["updated_at"], reverse=True)
        return notebooks

    def get_notebook(self, notebook_id: str) -> dict | None:
        return self._load_notebook(notebook_id)

    def list_records(
        self,
        notebook_id: str,
        *,
        query: str = "",
        limit: int = 50,
        offset: int = 0,
    ) -> dict | None:
        """Return a stable, bounded record page without changing disk format."""
        notebook = self._load_notebook(notebook_id)
        if notebook is None:
            return None
        needle = query.strip().casefold()
        records = [record for record in notebook.get("records", []) if isinstance(record, dict)]
        if needle:
            records = [
                record
                for record in records
                if needle
                in " ".join(
                    str(record.get(field) or "")
                    for field in ("title", "summary", "user_query", "output")
                ).casefold()
            ]
        records.sort(
            key=lambda record: float(record.get("updated_at") or record.get("created_at") or 0),
            reverse=True,
        )
        bounded_limit = max(1, min(int(limit), 200))
        bounded_offset = max(0, int(offset))
        return {
            "items": deepcopy(records[bounded_offset : bounded_offset + bounded_limit]),
            "total": len(records),
            "limit": bounded_limit,
            "offset": bounded_offset,
            "notebook": {
                key: deepcopy(value) for key, value in notebook.items() if key != "records"
            }
            | {"record_count": len(notebook.get("records", []))},
        }

    def update_notebook(
        self,
        notebook_id: str,
        name: str | None = None,
        description: str | None = None,
        color: str | None = None,
        icon: str | None = None,
    ) -> dict | None:
        notebook = self._load_notebook(notebook_id)
        if not notebook:
            return None

        if name is not None:
            notebook["name"] = name
        if description is not None:
            notebook["description"] = description
        if color is not None:
            notebook["color"] = color
        if icon is not None:
            notebook["icon"] = icon

        notebook["updated_at"] = time.time()
        self._save_notebook(notebook)
        self._touch_index_entry(notebook_id, notebook)
        return notebook

    def delete_notebook(self, notebook_id: str) -> bool:
        filepath = self._get_notebook_file(notebook_id)
        if not filepath.exists():
            return False

        filepath.unlink()
        index = self._load_index()
        index["notebooks"] = [nb for nb in index["notebooks"] if nb["id"] != notebook_id]
        self._save_index(index)
        return True

    # === Record Operations ===

    def add_record(
        self,
        notebook_ids: list[str],
        record_type: RecordType | str,
        title: str,
        user_query: str,
        output: str,
        summary: str = "",
        metadata: dict | None = None,
        kb_name: str | None = None,
        tags: list[str] | None = None,
        references: list[dict] | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        with self._lock:
            now = time.time()
            normalized_key = str(idempotency_key or "").strip() or None
            notebooks = [
                (notebook_id, self._load_notebook(notebook_id))
                for notebook_id in dict.fromkeys(notebook_ids)
            ]
            notebooks = [(notebook_id, notebook) for notebook_id, notebook in notebooks if notebook]
            existing: dict | None = None
            if normalized_key:
                for _, notebook in notebooks:
                    existing = next(
                        (
                            record
                            for record in notebook.get("records", [])
                            if record.get("idempotency_key") == normalized_key
                        ),
                        None,
                    )
                    if existing is not None:
                        break

            created = existing is None
            record = existing or self._new_record(
                record_type=record_type,
                title=title,
                summary=summary,
                user_query=user_query,
                output=output,
                metadata=metadata,
                kb_name=kb_name,
                tags=tags,
                references=references,
                idempotency_key=normalized_key,
                now=now,
            )
            present_in: list[str] = []
            for notebook_id, notebook in notebooks:
                already_present = any(
                    item.get("id") == record["id"]
                    or (normalized_key and item.get("idempotency_key") == normalized_key)
                    for item in notebook.get("records", [])
                )
                if not already_present:
                    notebook["records"].append(deepcopy(record))
                    notebook["updated_at"] = now
                    self._save_notebook(notebook)
                    self._touch_index_entry(notebook_id, notebook)
                present_in.append(notebook_id)

            return {
                "record": deepcopy(record),
                "added_to_notebooks": present_in,
                "created": created,
            }

    @staticmethod
    def _new_record(
        *,
        record_type: RecordType | str,
        title: str,
        summary: str,
        user_query: str,
        output: str,
        metadata: dict | None,
        kb_name: str | None,
        tags: list[str] | None,
        references: list[dict] | None,
        idempotency_key: str | None,
        now: float,
    ) -> dict:
        resolved_type = (
            record_type if isinstance(record_type, RecordType) else RecordType(str(record_type))
        )
        return {
            "id": str(uuid.uuid4())[:8],
            "type": resolved_type,
            "title": title,
            "summary": _clean_record_summary(summary),
            "user_query": user_query,
            "output": output,
            "metadata": metadata or {},
            "created_at": now,
            "updated_at": now,
            "revision": 1,
            "tags": _normalize_tags(tags),
            "references": _normalize_references(references),
            "idempotency_key": idempotency_key,
            "kb_name": kb_name,
        }

    def get_records(self, notebook_id: str, record_ids: list[str] | None = None) -> list[dict]:
        notebook = self._load_notebook(notebook_id)
        if not notebook:
            return []

        records = list(notebook.get("records", []))
        if not record_ids:
            return records

        wanted = set(record_ids)
        return [record for record in records if str(record.get("id", "")) in wanted]

    def get_record(self, notebook_id: str, record_id: str) -> dict | None:
        records = self.get_records(notebook_id, [record_id])
        return records[0] if records else None

    def update_record(
        self,
        notebook_id: str,
        record_id: str,
        *,
        title: str | None = None,
        summary: str | None = None,
        user_query: str | None = None,
        output: str | None = None,
        metadata: dict | None = None,
        kb_name: str | None | object = _UNSET,
        tags: list[str] | None = None,
        references: list[dict] | None = None,
        expected_revision: int | None = None,
    ) -> dict | None:
        with self._lock:
            notebook = self._load_notebook(notebook_id)
            if not notebook:
                return None

            updated_record: dict | None = None
            for record in notebook.get("records", []):
                if str(record.get("id", "")) != str(record_id):
                    continue
                current_revision = int(record.get("revision", 1) or 1)
                if expected_revision is not None and expected_revision != current_revision:
                    raise NotebookRevisionConflict(record)
                if title is not None:
                    record["title"] = title
                if summary is not None:
                    record["summary"] = _clean_record_summary(summary)
                if user_query is not None:
                    record["user_query"] = user_query
                if output is not None:
                    record["output"] = output
                if metadata is not None:
                    current_metadata = record.get("metadata", {}) or {}
                    record["metadata"] = {**current_metadata, **metadata}
                if kb_name is not _UNSET:
                    record["kb_name"] = kb_name
                if tags is not None:
                    record["tags"] = _normalize_tags(tags)
                if references is not None:
                    record["references"] = _normalize_references(references)
                now = time.time()
                record["updated_at"] = now
                record["revision"] = current_revision + 1
                updated_record = record
                break

            if updated_record is None:
                return None

            notebook["updated_at"] = updated_record["updated_at"]
            self._save_notebook(notebook)
            self._touch_index_entry(notebook_id, notebook)
            return deepcopy(updated_record)

    def import_markdown(
        self,
        notebook_id: str,
        *,
        markdown: str,
        mode: str = "append",
        title: str = "Imported note",
        idempotency_key: str | None = None,
    ) -> dict:
        if mode not in {"append", "replace"}:
            raise ValueError("markdown import mode must be append or replace")
        sections = _markdown_records(markdown, fallback_title=title)
        normalized_key = str(idempotency_key or "").strip() or None
        with self._lock:
            notebook = self._load_notebook(notebook_id)
            if not notebook:
                raise KeyError(notebook_id)
            now = time.time()
            imported: list[dict] = []
            for index, section in enumerate(sections):
                section_key = f"{normalized_key}:{index}" if normalized_key else None
                imported.append(
                    self._new_record(
                        record_type=RecordType.CO_WRITER,
                        title=section["title"],
                        summary="",
                        user_query="",
                        output=section["output"],
                        metadata={"import_source": "markdown"},
                        kb_name=None,
                        tags=["markdown-import"],
                        references=[],
                        idempotency_key=section_key,
                        now=now,
                    )
                )

            existing = list(notebook.get("records", []))
            if mode == "append":
                existing_keys = {
                    record.get("idempotency_key")
                    for record in existing
                    if record.get("idempotency_key")
                }
                additions = [
                    record
                    for record in imported
                    if not record.get("idempotency_key")
                    or record.get("idempotency_key") not in existing_keys
                ]
                if additions:
                    notebook["records"] = [*existing, *additions]
                replaced_count = 0
            else:
                imported_keys = [record.get("idempotency_key") for record in imported]
                existing_keys = [record.get("idempotency_key") for record in existing]
                if normalized_key and imported_keys == existing_keys:
                    additions = []
                    replaced_count = 0
                else:
                    additions = imported
                    replaced_count = len(existing)
                    notebook["records"] = additions

            if additions or replaced_count:
                notebook["updated_at"] = now
                self._save_notebook(notebook)
                self._touch_index_entry(notebook_id, notebook)
            return {
                "notebook_id": notebook_id,
                "mode": mode,
                "imported_count": len(additions),
                "replaced_count": replaced_count,
                "records": deepcopy(additions),
                "updated_at": notebook.get("updated_at"),
            }

    def get_records_by_references(self, notebook_references: list[dict]) -> list[dict]:
        resolved: list[dict] = []

        for ref in notebook_references:
            notebook_id = str(ref.get("notebook_id", "") or "").strip()
            if not notebook_id:
                continue
            record_ids = [
                str(record_id).strip()
                for record_id in (ref.get("record_ids") or [])
                if str(record_id).strip()
            ]
            notebook = self._load_notebook(notebook_id)
            if not notebook:
                continue

            notebook_name = str(notebook.get("name", "") or notebook_id)
            for record in self.get_records(notebook_id, record_ids):
                resolved.append(
                    {
                        **record,
                        "notebook_id": notebook_id,
                        "notebook_name": notebook_name,
                    }
                )

        return resolved

    def remove_record(self, notebook_id: str, record_id: str) -> bool:
        notebook = self._load_notebook(notebook_id)
        if not notebook:
            return False

        original_count = len(notebook["records"])
        notebook["records"] = [r for r in notebook["records"] if r["id"] != record_id]

        if len(notebook["records"]) == original_count:
            return False

        notebook["updated_at"] = time.time()
        self._save_notebook(notebook)
        self._touch_index_entry(notebook_id, notebook)
        return True

    def get_statistics(self) -> dict:
        notebooks = self.list_notebooks()

        total_records = 0
        type_counts = {
            "solve": 0,
            "question": 0,
            "research": 0,
            "chat": 0,
            "co_writer": 0,
        }

        for nb_info in notebooks:
            notebook = self._load_notebook(nb_info["id"])
            if notebook:
                for record in notebook.get("records", []):
                    total_records += 1
                    record_type = record.get("type", "")
                    if record_type in type_counts:
                        type_counts[record_type] += 1

        return {
            "total_notebooks": len(notebooks),
            "total_records": total_records,
            "records_by_type": type_counts,
            "recent_notebooks": notebooks[:5],
        }


_instances: dict[str, NotebookManager] = {}


def get_notebook_manager() -> NotebookManager:
    base_dir = get_path_service().get_notebook_dir().resolve()
    key = str(base_dir)
    if key not in _instances:
        _instances[key] = NotebookManager(base_dir=str(base_dir))
    return _instances[key]


class _NotebookManagerProxy:
    def __getattr__(self, name: str):
        return getattr(get_notebook_manager(), name)


notebook_manager = _NotebookManagerProxy()
