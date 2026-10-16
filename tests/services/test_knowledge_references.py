from __future__ import annotations

import json
from pathlib import Path
import sqlite3

from cognivoy.knowledge.references import KnowledgeReferenceService


def _service(tmp_path: Path) -> KnowledgeReferenceService:
    return KnowledgeReferenceService(
        db_path=tmp_path / "chat.db",
        notebook_dir=tmp_path / "workspace" / "notebook",
        workspace_dir=tmp_path / "workspace",
        tombstone_path=tmp_path / "knowledge-tombstones.json",
    )


def test_deletion_impact_covers_sessions_notebooks_and_workspace(tmp_path: Path) -> None:
    service = _service(tmp_path)
    with sqlite3.connect(service.db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE sessions (id TEXT, preferences_json TEXT);
            CREATE TABLE messages (session_id TEXT, metadata_json TEXT);
            """
        )
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?)",
            ("s1", json.dumps({"knowledge_bases": ["course-kb"]})),
        )
        conn.execute(
            "INSERT INTO messages VALUES (?, ?)",
            ("s2", json.dumps({"request_snapshot": {"knowledgeBases": ["course-kb"]}})),
        )

    service.notebook_dir.mkdir(parents=True)
    (service.notebook_dir / "notes.json").write_text(
        json.dumps(
            {
                "id": "notes",
                "records": [
                    {
                        "id": "r1",
                        "kb_name": "course-kb",
                        "references": [{"type": "knowledge_base", "name": "course-kb"}],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    book_dir = service.workspace_dir / "book"
    book_dir.mkdir(parents=True)
    (book_dir / "book.json").write_text(
        json.dumps({"sources": {"knowledge_bases": ["course-kb"]}}), encoding="utf-8"
    )

    impact = service.build_impact("course-kb")
    assert impact["counts"] == {"sessions": 2, "notebook_records": 1, "workspace_files": 1}
    assert impact["total_references"] == 4
    assert len(impact["confirmation_token"]) == 64


def test_deletion_tombstone_preserves_impact_and_is_queryable(tmp_path: Path) -> None:
    service = _service(tmp_path)
    impact = service.build_impact("course-kb")
    stored = service.record_deletion("course-kb", impact=impact)

    assert stored["name"] == "course-kb"
    assert stored["impact"]["confirmation_token"] == impact["confirmation_token"]
    assert service.get_tombstone("course-kb")["status"] == "deleted"
    assert [row["name"] for row in service.list_tombstones()] == ["course-kb"]
