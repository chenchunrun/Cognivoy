from __future__ import annotations

import asyncio
from pathlib import Path
import sqlite3
import time

import pytest

from cognivoy.services.path_service import PathService
from cognivoy.services.session.sqlite_store import SQLiteSessionStore


def test_sqlite_store_defaults_to_data_user_chat_history_db(tmp_path: Path) -> None:
    service = PathService.get_instance()
    original_root = service._project_root
    original_user_dir = service._user_data_dir

    try:
        service._project_root = tmp_path
        service._user_data_dir = tmp_path / "data" / "user"

        store = SQLiteSessionStore()

        assert store.db_path == tmp_path / "data" / "user" / "chat_history.db"
        assert store.db_path.exists()
    finally:
        service._project_root = original_root
        service._user_data_dir = original_user_dir


def test_sqlite_store_migrates_legacy_chat_history_db(tmp_path: Path) -> None:
    service = PathService.get_instance()
    original_root = service._project_root
    original_user_dir = service._user_data_dir

    try:
        service._project_root = tmp_path
        service._user_data_dir = tmp_path / "data" / "user"
        legacy_db = tmp_path / "data" / "chat_history.db"
        legacy_db.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(legacy_db) as conn:
            conn.execute("CREATE TABLE legacy (id INTEGER PRIMARY KEY)")
            conn.commit()

        store = SQLiteSessionStore()

        assert store.db_path.exists()
        assert not legacy_db.exists()
    finally:
        service._project_root = original_root
        service._user_data_dir = original_user_dir


def test_sqlite_store_migrates_legacy_question_notebook_before_review_index(
    tmp_path: Path,
) -> None:
    """A pre-adaptive notebook must open before indexes use new columns."""

    db_path = tmp_path / "legacy-question-notebook.db"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE notebook_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                question_id TEXT NOT NULL,
                question TEXT NOT NULL,
                question_type TEXT DEFAULT '',
                options_json TEXT DEFAULT '{}',
                correct_answer TEXT DEFAULT '',
                explanation TEXT DEFAULT '',
                difficulty TEXT DEFAULT '',
                user_answer TEXT DEFAULT '',
                is_correct INTEGER DEFAULT 0,
                bookmarked INTEGER DEFAULT 0,
                followup_session_id TEXT DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(session_id, question_id)
            );
            """
        )

    SQLiteSessionStore(db_path=db_path)

    with sqlite3.connect(db_path) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(notebook_entries)")}
        indexes = {row[1] for row in conn.execute("PRAGMA index_list(notebook_entries)")}
        assert "review_due_at" in columns
        assert "idx_notebook_entries_review_due" in indexes


def test_question_notebook_migration_backfills_learning_project_context(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "project-question-notebook.db"
    store = SQLiteSessionStore(db_path=db_path)
    session = asyncio.run(store.create_session(title="Project practice"))
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [{"question_id": "q-old", "question": "Unrelated warm-up"}],
        )
    )
    asyncio.run(
        store.add_message(
            session["id"],
            "user",
            "Start practice",
            metadata={
                "request_snapshot": {
                    "learningContext": {
                        "project_id": "cisa-project",
                        "task_id": "domain-1",
                    }
                }
            },
        )
    )
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [{"question_id": "q1", "question": "What is governance?"}],
        )
    )
    with sqlite3.connect(db_path) as conn:
        conn.execute("UPDATE notebook_entries SET learning_project_id = '', learning_task_id = ''")
        conn.commit()

    migrated = SQLiteSessionStore(db_path=db_path)
    listing = asyncio.run(migrated.list_notebook_entries(learning_project_id="cisa-project"))

    assert listing["total"] == 1
    assert listing["items"][0]["learning_project_id"] == "cisa-project"
    assert listing["items"][0]["learning_task_id"] == "domain-1"
    unassigned = asyncio.run(migrated.list_notebook_entries(learning_project_id="__unassigned__"))
    assert [item["question_id"] for item in unassigned["items"]] == ["q-old"]


@pytest.fixture
def store(tmp_path: Path) -> SQLiteSessionStore:
    return SQLiteSessionStore(db_path=tmp_path / "test.db")


def test_context_rows_keep_only_resolved_ask_user_trace(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    events = [
        {"type": "content", "content": "large stream delta"},
        {
            "type": "tool_result",
            "metadata": {
                "tool_metadata": {"ask_user": {"questions": [{"id": "q1", "prompt": "Choose?"}]}}
            },
        },
        {
            "type": "progress",
            "metadata": {
                "ask_user_resolved": True,
                "answers": [{"questionId": "q1", "text": "A"}],
            },
        },
    ]
    asyncio.run(store.add_message(session["id"], "assistant", "answer", events=events))

    rows = asyncio.run(store.get_messages_for_context(session["id"]))
    assert [event["type"] for event in rows[0]["events"]] == ["tool_result", "progress"]


def _make_items(*specs):
    """Build notebook entry dicts from (qid, question, is_correct) tuples."""
    items = []
    for qid, question, is_correct in specs:
        items.append(
            {
                "question_id": qid,
                "question": question,
                "question_type": "choice",
                "options": {"A": "opt_a", "B": "opt_b"},
                "user_answer": "A",
                "correct_answer": "B",
                "explanation": "expl",
                "difficulty": "medium",
                "is_correct": is_correct,
            }
        )
    return items


# ── Notebook entries ──────────────────────────────────────────────


def test_upsert_notebook_entries_persists_all(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session(title="Test"))
    items = _make_items(("q1", "2+2?", False), ("q2", "3+3?", True), ("q3", "5+5?", False))
    upserted = asyncio.run(store.upsert_notebook_entries(session["id"], items))
    assert upserted == 3
    result = asyncio.run(store.list_notebook_entries())
    assert result["total"] == 3
    assert all(e["session_title"] == "Test" for e in result["items"])


def test_upsert_notebook_entries_updates_on_conflict(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    sid = session["id"]
    asyncio.run(store.upsert_notebook_entries(sid, _make_items(("q1", "Q?", False))))
    result = asyncio.run(store.list_notebook_entries())
    assert result["items"][0]["is_correct"] is False

    asyncio.run(
        store.upsert_notebook_entries(
            sid,
            [
                {
                    "question_id": "q1",
                    "question": "Q?",
                    "user_answer": "B",
                    "correct_answer": "B",
                    "is_correct": True,
                }
            ],
        )
    )
    result = asyncio.run(store.list_notebook_entries())
    assert result["total"] == 1
    assert result["items"][0]["is_correct"] is True
    assert result["items"][0]["user_answer"] == "B"


def test_upsert_skips_blank_questions(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    items = [
        {"question_id": "q1", "question": "", "is_correct": False},
        {"question_id": "", "question": "Valid?", "is_correct": False},
        {"question_id": "q3", "question": "OK?", "is_correct": False},
    ]
    upserted = asyncio.run(store.upsert_notebook_entries(session["id"], items))
    assert upserted == 1


def test_upsert_unknown_session_raises(store: SQLiteSessionStore) -> None:
    with pytest.raises(ValueError, match="Session not found"):
        asyncio.run(store.upsert_notebook_entries("nope", _make_items(("q1", "Q?", False))))


def test_list_entries_filters_bookmarked(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            _make_items(
                ("q1", "Q1?", False),
                ("q2", "Q2?", True),
            ),
        )
    )
    entries = asyncio.run(store.list_notebook_entries())["items"]
    asyncio.run(store.update_notebook_entry(entries[0]["id"], {"bookmarked": True}))
    bm = asyncio.run(store.list_notebook_entries(bookmarked=True))
    assert bm["total"] == 1
    assert bm["items"][0]["bookmarked"] is True


def test_list_entries_filters_is_correct(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            _make_items(
                ("q1", "Q1?", False),
                ("q2", "Q2?", True),
            ),
        )
    )
    wrong = asyncio.run(store.list_notebook_entries(is_correct=False))
    assert wrong["total"] == 1
    assert wrong["items"][0]["question_id"] == "q1"


def test_unattempted_questions_do_not_count_as_wrong_or_lower_accuracy(
    store: SQLiteSessionStore,
) -> None:
    session = asyncio.run(store.create_session(title="Practice bank"))
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [
                {
                    "question_id": "answered",
                    "question": "Answered correctly",
                    "is_correct": True,
                },
                {
                    "question_id": "new",
                    "question": "Not attempted yet",
                    "is_correct": False,
                    "record_attempt": False,
                },
            ],
        )
    )

    wrong = asyncio.run(store.list_notebook_entries(is_correct=False))
    stats = asyncio.run(store.get_question_notebook_statistics())

    assert wrong["total"] == 0
    assert stats["total"] == 2
    assert stats["unique_total"] == 2
    assert stats["attempted"] == 1
    assert stats["correct"] == 1
    assert stats["incorrect"] == 0
    assert stats["accuracy_percent"] == 100
    assert stats["recent_errors"] == []


def test_list_entries_supports_search_type_difficulty_and_time(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session(title="Math review"))
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [
                {
                    "question_id": "q1",
                    "question": "Solve the quadratic equation",
                    "question_type": "written",
                    "difficulty": "hard",
                    "explanation": "Use the quadratic formula",
                    "is_correct": False,
                },
                {
                    "question_id": "q2",
                    "question": "Capital of France?",
                    "question_type": "choice",
                    "difficulty": "easy",
                    "is_correct": True,
                },
            ],
        )
    )
    all_items = asyncio.run(store.list_notebook_entries())["items"]
    q1 = next(item for item in all_items if item["question_id"] == "q1")

    result = asyncio.run(
        store.list_notebook_entries(
            query="quadratic",
            question_type="written",
            difficulty="hard",
            updated_from=q1["updated_at"] - 1,
            updated_to=q1["updated_at"] + 1,
        )
    )

    assert result["total"] == 1
    assert result["items"][0]["question_id"] == "q1"


def test_question_notebook_statistics_are_derived_from_all_entries(
    store: SQLiteSessionStore,
) -> None:
    session = asyncio.run(store.create_session(title="Quiz"))
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [
                {
                    **_make_items(("q1", "Q1?", False))[0],
                    "question_type": "written",
                    "difficulty": "hard",
                },
                {
                    **_make_items(("q2", "Q2?", True))[0],
                    "question_type": "choice",
                    "difficulty": "easy",
                },
                {
                    **_make_items(("q3", "Q3?", True))[0],
                    "question_type": "choice",
                    "difficulty": "medium",
                },
            ],
        )
    )
    first = asyncio.run(store.list_notebook_entries())["items"][0]
    asyncio.run(store.update_notebook_entry(first["id"], {"bookmarked": True}))

    stats = asyncio.run(store.get_question_notebook_statistics())

    assert stats["total"] == 3
    assert stats["unique_total"] == 3
    assert stats["attempted"] == 3
    assert stats["correct"] == 2
    assert stats["incorrect"] == 1
    assert stats["bookmarked"] == 1
    assert stats["due_review"] == 1
    assert stats["accuracy_percent"] == 67
    assert stats["question_types"] == {"choice": 2, "written": 1}
    assert stats["difficulties"] == {"easy": 1, "hard": 1, "medium": 1}
    assert [item["question_id"] for item in stats["recent_errors"]] == ["q1"]


def test_one_question_can_be_reused_by_multiple_learning_tasks(
    store: SQLiteSessionStore,
) -> None:
    session = asyncio.run(store.create_session(title="Reusable assessment"))
    base = {
        "turn_id": "turn-1",
        "question_id": "q-1",
        "question": "Which control best reduces privileged-access risk?",
        "learning_project_id": "cisa",
        "record_attempt": False,
    }
    asyncio.run(
        store.upsert_notebook_entries(session["id"], [{**base, "learning_task_id": "baseline"}])
    )
    asyncio.run(
        store.upsert_notebook_entries(session["id"], [{**base, "learning_task_id": "week-4"}])
    )

    baseline = asyncio.run(store.list_notebook_entries(learning_task_id="baseline"))
    weekly = asyncio.run(store.list_notebook_entries(learning_task_id="week-4"))
    all_entries = asyncio.run(store.list_notebook_entries(learning_project_id="cisa"))

    assert baseline["total"] == 1
    assert weekly["total"] == 1
    assert all_entries["total"] == 1


def test_question_attempts_are_idempotent_and_schedule_spaced_review(
    store: SQLiteSessionStore,
) -> None:
    session = asyncio.run(store.create_session(title="Adaptive quiz"))
    sid = session["id"]
    base = {
        "turn_id": "turn-adaptive",
        "question_id": "q1",
        "question": "Solve x + 2 = 5",
        "question_type": "short_answer",
        "difficulty": "medium",
        "knowledge_points": ["linear equations"],
        "source_refs": [{"type": "book", "id": "page-1"}],
        "rubric": {"max_score": 2},
        "record_attempt": True,
    }

    asyncio.run(
        store.upsert_notebook_entries(
            sid,
            [{**base, "attempt_id": "attempt-1", "user_answer": "2", "is_correct": False}],
        )
    )
    first = asyncio.run(store.find_notebook_entry(sid, "q1", "turn-adaptive"))
    assert first is not None
    assert first["attempt_count"] == 1
    assert first["correct_streak"] == 0
    assert first["incorrect_streak"] == 1
    assert first["review_status"] == "due"
    assert first["review_due_at"] <= time.time() + 1
    assert first["knowledge_points"] == ["linear equations"]
    assert first["source_refs"] == [{"type": "book", "id": "page-1"}]
    assert first["rubric"] == {"max_score": 2}

    # Retrying the same HTTP submission must not create another learning
    # attempt or move the review schedule.
    asyncio.run(
        store.upsert_notebook_entries(
            sid,
            [{**base, "attempt_id": "attempt-1", "user_answer": "2", "is_correct": False}],
        )
    )
    duplicate = asyncio.run(store.find_notebook_entry(sid, "q1", "turn-adaptive"))
    assert duplicate is not None
    assert duplicate["attempt_count"] == 1
    assert duplicate["incorrect_streak"] == 1

    asyncio.run(
        store.upsert_notebook_entries(
            sid,
            [{**base, "attempt_id": "attempt-2", "user_answer": "3", "is_correct": True}],
        )
    )
    second = asyncio.run(store.find_notebook_entry(sid, "q1", "turn-adaptive"))
    assert second is not None
    assert second["attempt_count"] == 2
    assert second["correct_streak"] == 1
    assert second["incorrect_streak"] == 0
    assert second["review_interval_days"] == 1
    assert second["review_status"] == "scheduled"
    assert second["review_due_at"] > time.time() + 23 * 60 * 60

    asyncio.run(
        store.upsert_notebook_entries(
            sid,
            [{**base, "attempt_id": "attempt-3", "user_answer": "3", "is_correct": True}],
        )
    )
    third = asyncio.run(store.find_notebook_entry(sid, "q1", "turn-adaptive"))
    assert third is not None
    assert third["attempt_count"] == 3
    assert third["correct_streak"] == 2
    assert third["review_interval_days"] == 3
    assert third["review_status"] == "scheduled"


def test_adaptive_profile_uses_attempt_evidence_and_weak_knowledge_points(
    store: SQLiteSessionStore,
) -> None:
    session = asyncio.run(store.create_session(title="Adaptive evidence"))
    sid = session["id"]
    attempts = [
        ("q1", "a1", False, "fractions"),
        ("q2", "a2", False, "fractions"),
        ("q3", "a3", True, "geometry"),
    ]
    for question_id, attempt_id, correct, knowledge_point in attempts:
        asyncio.run(
            store.upsert_notebook_entries(
                sid,
                [
                    {
                        "turn_id": "turn-profile",
                        "question_id": question_id,
                        "question": question_id,
                        "difficulty": "medium",
                        "knowledge_points": [knowledge_point],
                        "attempt_id": attempt_id,
                        "record_attempt": True,
                        "is_correct": correct,
                    }
                ],
            )
        )

    profile = asyncio.run(store.get_question_adaptive_profile())

    assert profile["attempt_count"] == 3
    assert profile["recent_accuracy_percent"] == 33
    assert profile["recommended_difficulty"] == "easy"
    assert profile["weak_knowledge_points"][0] == {
        "knowledge_point": "fractions",
        "incorrect_attempts": 2,
        "total_attempts": 2,
    }


def test_list_entries_filters_real_review_state_not_latest_correctness(
    store: SQLiteSessionStore,
) -> None:
    session = asyncio.run(store.create_session(title="Review filters"))
    sid = session["id"]
    asyncio.run(
        store.upsert_notebook_entries(
            sid,
            [
                {
                    "question_id": "due",
                    "question": "Due question",
                    "attempt_id": "review-due",
                    "record_attempt": True,
                    "is_correct": False,
                },
                {
                    "question_id": "scheduled",
                    "question": "Scheduled question",
                    "attempt_id": "review-scheduled",
                    "record_attempt": True,
                    "is_correct": True,
                },
            ],
        )
    )

    due = asyncio.run(store.list_notebook_entries(review_status="due"))
    scheduled = asyncio.run(store.list_notebook_entries(review_status="scheduled"))

    assert [item["question_id"] for item in due["items"]] == ["due"]
    assert [item["question_id"] for item in scheduled["items"]] == ["scheduled"]


def test_list_entries_filters_by_verified_source_type(
    store: SQLiteSessionStore,
) -> None:
    session = asyncio.run(store.create_session(title="Source filters"))
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [
                {
                    "question_id": "kb",
                    "question": "Knowledge-backed",
                    "source_refs": [{"type": "knowledge_base", "id": "algebra"}],
                },
                {
                    "question_id": "paper",
                    "question": "Paper-backed",
                    "source_refs": [{"source_type": "papers", "url": "https://example.test/p"}],
                },
                {"question_id": "none", "question": "No verified source"},
            ],
        )
    )

    kb = asyncio.run(store.list_notebook_entries(source_type="knowledge_base"))
    papers = asyncio.run(store.list_notebook_entries(source_type="papers"))

    assert [item["question_id"] for item in kb["items"]] == ["kb"]
    assert [item["question_id"] for item in papers["items"]] == ["paper"]


def test_update_notebook_entry_bookmark_roundtrip(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(store.upsert_notebook_entries(session["id"], _make_items(("q1", "Q?", False))))
    eid = asyncio.run(store.list_notebook_entries())["items"][0]["id"]
    assert asyncio.run(store.update_notebook_entry(eid, {"bookmarked": True})) is True
    assert asyncio.run(store.get_notebook_entry(eid))["bookmarked"] is True
    assert asyncio.run(store.update_notebook_entry(eid, {"bookmarked": False})) is True
    assert asyncio.run(store.get_notebook_entry(eid))["bookmarked"] is False
    assert asyncio.run(store.update_notebook_entry(99999, {"bookmarked": True})) is False


def test_update_followup_session_id(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(store.upsert_notebook_entries(session["id"], _make_items(("q1", "Q?", False))))
    eid = asyncio.run(store.list_notebook_entries())["items"][0]["id"]
    asyncio.run(store.update_notebook_entry(eid, {"followup_session_id": "sess_fu"}))
    entry = asyncio.run(store.get_notebook_entry(eid))
    assert entry["followup_session_id"] == "sess_fu"


def test_find_notebook_entry(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(store.upsert_notebook_entries(session["id"], _make_items(("q1", "Q?", False))))
    found = asyncio.run(store.find_notebook_entry(session["id"], "q1"))
    assert found is not None
    assert found["question_id"] == "q1"
    assert asyncio.run(store.find_notebook_entry(session["id"], "nope")) is None


def test_delete_notebook_entry(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            _make_items(
                ("q1", "Q1?", False),
                ("q2", "Q2?", False),
            ),
        )
    )
    eid = asyncio.run(store.list_notebook_entries())["items"][0]["id"]
    assert asyncio.run(store.delete_notebook_entry(eid)) is True
    assert asyncio.run(store.list_notebook_entries())["total"] == 1
    assert asyncio.run(store.delete_notebook_entry(99999)) is False


def test_entries_cascade_on_session_delete(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(store.upsert_notebook_entries(session["id"], _make_items(("q1", "Q?", False))))
    assert asyncio.run(store.list_notebook_entries())["total"] == 1
    asyncio.run(store.delete_session(session["id"]))
    assert asyncio.run(store.list_notebook_entries())["total"] == 0


# ── Categories ────────────────────────────────────────────────────


def test_category_crud(store: SQLiteSessionStore) -> None:
    cat = asyncio.run(store.create_category("Math"))
    assert cat["name"] == "Math"
    cats = asyncio.run(store.list_categories())
    assert len(cats) == 1
    assert cats[0]["entry_count"] == 0

    asyncio.run(store.rename_category(cat["id"], "Algebra"))
    cats = asyncio.run(store.list_categories())
    assert cats[0]["name"] == "Algebra"

    asyncio.run(store.delete_category(cat["id"]))
    assert asyncio.run(store.list_categories()) == []


def test_entry_category_association(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(store.upsert_notebook_entries(session["id"], _make_items(("q1", "Q?", False))))
    eid = asyncio.run(store.list_notebook_entries())["items"][0]["id"]
    cat = asyncio.run(store.create_category("Physics"))

    assert asyncio.run(store.add_entry_to_category(eid, cat["id"])) is True
    entry = asyncio.run(store.get_notebook_entry(eid))
    assert len(entry["categories"]) == 1
    assert entry["categories"][0]["name"] == "Physics"

    by_cat = asyncio.run(store.list_notebook_entries(category_id=cat["id"]))
    assert by_cat["total"] == 1

    asyncio.run(store.remove_entry_from_category(eid, cat["id"]))
    assert asyncio.run(store.get_entry_categories(eid)) == []


def test_category_cascade_on_entry_delete(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(store.upsert_notebook_entries(session["id"], _make_items(("q1", "Q?", False))))
    eid = asyncio.run(store.list_notebook_entries())["items"][0]["id"]
    cat = asyncio.run(store.create_category("History"))
    asyncio.run(store.add_entry_to_category(eid, cat["id"]))
    asyncio.run(store.delete_notebook_entry(eid))
    cats = asyncio.run(store.list_categories())
    assert cats[0]["entry_count"] == 0
