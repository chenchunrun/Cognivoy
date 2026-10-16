from __future__ import annotations

import asyncio
import base64
import importlib
from pathlib import Path

import pytest

pytest.importorskip("fastapi")

FastAPI = pytest.importorskip("fastapi").FastAPI
TestClient = pytest.importorskip("fastapi.testclient").TestClient
notebook_router = importlib.import_module("cognivoy.api.routers.question_notebook").router
sessions_router = importlib.import_module("cognivoy.api.routers.sessions").router

from cognivoy.learning.project_models import LearningProject, LearningTask
from cognivoy.learning.project_storage import LearningProjectStore
from cognivoy.services.session.sqlite_store import SQLiteSessionStore


def _build_app(store: SQLiteSessionStore) -> FastAPI:
    app = FastAPI()
    app.include_router(notebook_router, prefix="/api/v1/question-notebook")
    app.include_router(sessions_router, prefix="/api/v1/sessions")
    return app


@pytest.fixture
def store(tmp_path: Path, monkeypatch) -> SQLiteSessionStore:
    instance = SQLiteSessionStore(db_path=tmp_path / "router-test.db")
    monkeypatch.setattr(
        "cognivoy.api.routers.question_notebook.get_sqlite_session_store",
        lambda: instance,
    )
    monkeypatch.setattr(
        "cognivoy.api.routers.sessions.get_sqlite_session_store",
        lambda: instance,
    )
    return instance


def _quiz_answers():
    return [
        {
            "question_id": "q1",
            "question": "Capital of France?",
            "question_type": "choice",
            "options": {"A": "Berlin", "B": "Paris"},
            "user_answer": "A",
            "correct_answer": "B",
            "explanation": "Paris is the capital.",
            "difficulty": "easy",
            "is_correct": False,
        },
        {
            "question_id": "q2",
            "question": "2+2?",
            "question_type": "choice",
            "options": {"A": "3", "B": "4"},
            "user_answer": "B",
            "correct_answer": "B",
            "is_correct": True,
        },
    ]


def test_list_entries_empty(store: SQLiteSessionStore) -> None:
    with TestClient(_build_app(store)) as client:
        resp = client.get("/api/v1/question-notebook/entries")
        assert resp.status_code == 200
        assert resp.json() == {"items": [], "total": 0}


def test_quiz_results_populates_notebook(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session(title="Quiz Session"))
    sid = session["id"]

    with TestClient(_build_app(store)) as client:
        resp = client.post(
            f"/api/v1/sessions/{sid}/quiz-results",
            json={"answers": _quiz_answers()},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["recorded"] is True
        assert body["notebook_count"] == 2
        assert "[Quiz Performance]" in body["content"]

        listing = client.get("/api/v1/question-notebook/entries")
        assert listing.status_code == 200
        items = listing.json()["items"]
        assert len(items) == 2


def test_notebook_entry_attempt_records_progress_and_is_idempotent(
    store: SQLiteSessionStore,
) -> None:
    session = asyncio.run(store.create_session(title="Course practice"))
    sid = session["id"]
    with TestClient(_build_app(store)) as client:
        created = client.post(
            "/api/v1/question-notebook/entries/upsert",
            json={
                "session_id": sid,
                "question_id": "baseline-1",
                "question": "Capital of France?",
                "question_type": "choice",
                "options": {"A": "Berlin", "B": "Paris"},
                "correct_answer": "B",
                "learning_project_id": "cisa",
                "learning_task_id": "baseline",
            },
        )
        assert created.status_code == 200
        entry_id = created.json()["id"]
        first = client.post(
            f"/api/v1/question-notebook/entries/{entry_id}/attempt",
            json={"answer": "B", "attempt_id": "baseline-attempt-1"},
        )
        duplicate = client.post(
            f"/api/v1/question-notebook/entries/{entry_id}/attempt",
            json={"answer": "B", "attempt_id": "baseline-attempt-1"},
        )

    assert first.status_code == 200
    assert first.json()["is_correct"] is True
    assert first.json()["attempt_count"] == 1
    assert first.json()["review_status"] == "scheduled"
    assert duplicate.status_code == 200
    assert duplicate.json()["attempt_count"] == 1


def test_quiz_results_materializes_answer_images_and_retry_is_idempotent(
    store: SQLiteSessionStore, monkeypatch
) -> None:
    """A submitted handwritten answer must survive notebook reloads.

    The quiz-results endpoint is the durable write boundary, so it must turn
    browser base64 uploads into AttachmentStore references before recording
    the notebook attempt. Retrying the same submission must retain one image
    and one learning attempt.
    """

    class FakeAttachmentStore:
        def __init__(self) -> None:
            self.puts: list[dict] = []

        async def put(self, **kwargs):
            self.puts.append(kwargs)
            return (
                f"/api/attachments/{kwargs['session_id']}/"
                f"{kwargs['attachment_id']}/{kwargs['filename']}"
            )

    attachments = FakeAttachmentStore()
    monkeypatch.setattr(
        "cognivoy.api.routers.sessions.get_attachment_store",
        lambda: attachments,
    )
    session = asyncio.run(store.create_session(title="Handwritten quiz"))
    sid = session["id"]
    answer = _quiz_answers()[0]
    answer["question_type"] = "written"
    answer["user_answer"] = "See attached working"
    answer["user_answer_images"] = [
        {
            "id": "work-1",
            "base64": base64.b64encode(b"tiny-png").decode("ascii"),
            "filename": "working.png",
            "mime_type": "image/png",
        }
    ]
    payload = {
        "answers": [answer],
        "turn_id": "turn-images",
        "submission_id": "submission-images",
    }

    with TestClient(_build_app(store)) as client:
        first = client.post(f"/api/v1/sessions/{sid}/quiz-results", json=payload)
        retry = client.post(f"/api/v1/sessions/{sid}/quiz-results", json=payload)
        lookup = client.get(
            "/api/v1/question-notebook/entries/lookup/by-question",
            params={
                "session_id": sid,
                "turn_id": "turn-images",
                "question_id": "q1",
            },
        )

    assert first.status_code == 200
    assert retry.status_code == 200
    assert retry.json()["duplicate_submission"] is True
    assert len(attachments.puts) == 1
    assert attachments.puts[0]["data"] == b"tiny-png"
    entry = lookup.json()
    assert entry["attempt_count"] == 1
    assert entry["user_answer_images"] == [
        {
            "id": "work-1",
            "url": f"/api/attachments/{sid}/work-1/working.png",
            "filename": "working.png",
            "mime_type": "image/png",
        }
    ]


def test_notebook_search_filters_and_statistics_endpoint(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session(title="World knowledge"))
    answers = _quiz_answers()
    answers[0]["source_refs"] = [{"type": "knowledge_base", "id": "atlas"}]
    answers[1]["source_refs"] = [{"type": "web", "url": "https://example.test"}]
    asyncio.run(store.upsert_notebook_entries(session["id"], answers))

    with TestClient(_build_app(store)) as client:
        filtered = client.get(
            "/api/v1/question-notebook/entries",
            params={"q": "france", "question_type": "choice", "difficulty": "easy"},
        )
        statistics = client.get("/api/v1/question-notebook/statistics")
        sourced = client.get(
            "/api/v1/question-notebook/entries",
            params={"source_type": "knowledge_base"},
        )

    assert filtered.status_code == 200
    assert filtered.json()["total"] == 1
    assert filtered.json()["items"][0]["question_id"] == "q1"
    assert sourced.status_code == 200
    assert [item["question_id"] for item in sourced.json()["items"]] == ["q1"]
    assert statistics.status_code == 200
    assert statistics.json()["total"] == 2
    assert statistics.json()["correct"] == 1
    assert statistics.json()["incorrect"] == 1
    assert statistics.json()["accuracy_percent"] == 50


def test_quiz_submission_id_is_idempotent_and_exposes_adaptive_profile(
    store: SQLiteSessionStore,
) -> None:
    session = asyncio.run(store.create_session(title="Adaptive API"))
    sid = session["id"]
    answers = _quiz_answers()
    answers[0]["knowledge_points"] = ["geography"]
    answers[0]["source_refs"] = [{"type": "knowledge_base", "id": "atlas"}]

    with TestClient(_build_app(store)) as client:
        first = client.post(
            f"/api/v1/sessions/{sid}/quiz-results",
            json={
                "answers": answers,
                "turn_id": "turn-adaptive-api",
                "submission_id": "submission-1",
            },
        )
        duplicate = client.post(
            f"/api/v1/sessions/{sid}/quiz-results",
            json={
                "answers": answers,
                "turn_id": "turn-adaptive-api",
                "submission_id": "submission-1",
            },
        )
        profile = client.get("/api/v1/question-notebook/adaptive-profile")
        listing = client.get("/api/v1/question-notebook/entries").json()

    assert first.status_code == 200
    assert duplicate.status_code == 200
    assert duplicate.json()["duplicate_submission"] is True
    assert profile.status_code == 200
    assert profile.json()["attempt_count"] == 2
    q1 = next(item for item in listing["items"] if item["question_id"] == "q1")
    assert q1["attempt_count"] == 1
    assert q1["review_status"] == "due"
    assert q1["knowledge_points"] == ["geography"]
    assert q1["source_refs"] == [{"type": "knowledge_base", "id": "atlas"}]


def test_quiz_results_write_project_mistakes_and_reviews_once(
    store: SQLiteSessionStore, tmp_path: Path, monkeypatch
) -> None:
    project_store = LearningProjectStore(tmp_path / "learning-projects")
    project_store.create(
        LearningProject(
            id="quiz-learning-project",
            owner_id="learner-1",
            title="World geography",
            tasks=[
                LearningTask(
                    id="quiz-learning-task",
                    project_id="quiz-learning-project",
                    objective="Check geography understanding",
                    status="completed",
                )
            ],
        )
    )
    monkeypatch.setattr(
        "cognivoy.learning.project_storage.LearningProjectStore",
        lambda: project_store,
    )
    monkeypatch.setattr(
        "cognivoy.api.routers.sessions.get_current_user",
        lambda: type("User", (), {"id": "learner-1"})(),
    )
    session = asyncio.run(store.create_session(title="Project quiz"))
    sid = session["id"]
    asyncio.run(
        store.add_message(
            sid,
            "user",
            "Generate a quiz",
            metadata={
                "request_snapshot": {
                    "learningContext": {
                        "project_id": "quiz-learning-project",
                        "task_id": "quiz-learning-task",
                    }
                }
            },
        )
    )
    payload = {
        "answers": _quiz_answers(),
        "turn_id": "project-quiz-turn",
        "submission_id": "project-quiz-submission",
    }

    with TestClient(_build_app(store)) as client:
        first = client.post(f"/api/v1/sessions/{sid}/quiz-results", json=payload)
        duplicate = client.post(f"/api/v1/sessions/{sid}/quiz-results", json=payload)

    assert first.status_code == 200
    assert first.json()["learning_project_updated"] is True
    assert duplicate.json()["duplicate_submission"] is True
    saved = project_store.load("quiz-learning-project")
    assert saved is not None
    assert saved.due_review_count == 1
    assert len(saved.review_items) == 2
    assert [event.event_type for event in saved.events].count("quiz_completed") == 1
    with TestClient(_build_app(store)) as client:
        project_entries = client.get(
            "/api/v1/question-notebook/entries",
            params={"project_id": "quiz-learning-project"},
        ).json()
        unassigned_entries = client.get(
            "/api/v1/question-notebook/entries",
            params={"project_id": "__unassigned__"},
        ).json()
        project_stats = client.get(
            "/api/v1/question-notebook/statistics",
            params={"project_id": "quiz-learning-project"},
        ).json()

    assert project_entries["total"] == 2
    assert {item["learning_project_id"] for item in project_entries["items"]} == {
        "quiz-learning-project"
    }
    assert {item["learning_task_id"] for item in project_entries["items"]} == {"quiz-learning-task"}
    assert unassigned_entries["total"] == 0
    assert project_stats["total"] == 2


def test_quiz_results_upserts_on_retry(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    sid = session["id"]

    with TestClient(_build_app(store)) as client:
        first = client.post(
            f"/api/v1/sessions/{sid}/quiz-results",
            json={"answers": _quiz_answers(), "turn_id": "turn-quiz"},
        )
        updated = _quiz_answers()
        updated[0]["user_answer"] = "B"
        updated[0]["is_correct"] = True
        second = client.post(
            f"/api/v1/sessions/{sid}/quiz-results",
            json={"answers": updated, "turn_id": "turn-quiz"},
        )

        assert first.json()["history_message_created"] is True
        assert second.json()["history_message_created"] is False

        listing = client.get("/api/v1/question-notebook/entries").json()
        assert listing["total"] == 2
        q1 = next(e for e in listing["items"] if e["question_id"] == "q1")
        assert q1["is_correct"] is True
        assert q1["user_answer"] == "B"
        detail = asyncio.run(store.get_session_with_messages(sid))
        quiz_messages = [
            message for message in detail["messages"] if "[Quiz Performance]" in message["content"]
        ]
        assert len(quiz_messages) == 1


def test_bookmark_toggle(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [
                {
                    "question_id": "q1",
                    "question": "Q?",
                    "is_correct": False,
                }
            ],
        )
    )
    eid = asyncio.run(store.list_notebook_entries())["items"][0]["id"]

    with TestClient(_build_app(store)) as client:
        resp = client.patch(
            f"/api/v1/question-notebook/entries/{eid}",
            json={"bookmarked": True},
        )
        assert resp.status_code == 200

        bm = client.get("/api/v1/question-notebook/entries?bookmarked=true").json()
        assert bm["total"] == 1

        client.patch(f"/api/v1/question-notebook/entries/{eid}", json={"bookmarked": False})
        bm2 = client.get("/api/v1/question-notebook/entries?bookmarked=true").json()
        assert bm2["total"] == 0


def test_delete_entry(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [
                {
                    "question_id": "q1",
                    "question": "Q?",
                    "is_correct": False,
                }
            ],
        )
    )
    eid = asyncio.run(store.list_notebook_entries())["items"][0]["id"]

    with TestClient(_build_app(store)) as client:
        assert client.delete(f"/api/v1/question-notebook/entries/{eid}").status_code == 200
        assert client.delete(f"/api/v1/question-notebook/entries/{eid}").status_code == 404


def test_category_crud_and_association(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [
                {
                    "question_id": "q1",
                    "question": "Q?",
                    "is_correct": False,
                }
            ],
        )
    )
    eid = asyncio.run(store.list_notebook_entries())["items"][0]["id"]

    with TestClient(_build_app(store)) as client:
        cat_resp = client.post(
            "/api/v1/question-notebook/categories",
            json={"name": "Math"},
        )
        assert cat_resp.status_code == 201
        cat_id = cat_resp.json()["id"]

        cats = client.get("/api/v1/question-notebook/categories").json()
        assert len(cats) == 1
        assert cats[0]["name"] == "Math"

        add_resp = client.post(
            f"/api/v1/question-notebook/entries/{eid}/categories",
            json={"category_id": cat_id},
        )
        assert add_resp.status_code == 200

        by_cat = client.get(f"/api/v1/question-notebook/entries?category_id={cat_id}").json()
        assert by_cat["total"] == 1

        rm_resp = client.delete(f"/api/v1/question-notebook/entries/{eid}/categories/{cat_id}")
        assert rm_resp.status_code == 200
        by_cat2 = client.get(f"/api/v1/question-notebook/entries?category_id={cat_id}").json()
        assert by_cat2["total"] == 0

        client.patch(f"/api/v1/question-notebook/categories/{cat_id}", json={"name": "Algebra"})
        cats2 = client.get("/api/v1/question-notebook/categories").json()
        assert cats2[0]["name"] == "Algebra"

        client.delete(f"/api/v1/question-notebook/categories/{cat_id}")
        assert client.get("/api/v1/question-notebook/categories").json() == []


def test_lookup_entry_by_question(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [
                {
                    "question_id": "q1",
                    "question": "Q?",
                    "is_correct": False,
                }
            ],
        )
    )

    with TestClient(_build_app(store)) as client:
        resp = client.get(
            "/api/v1/question-notebook/entries/lookup/by-question",
            params={"session_id": session["id"], "question_id": "q1"},
        )
        assert resp.status_code == 200
        assert resp.json()["question_id"] == "q1"

        resp404 = client.get(
            "/api/v1/question-notebook/entries/lookup/by-question",
            params={"session_id": session["id"], "question_id": "nope"},
        )
        assert resp404.status_code == 404


def test_quiz_state_isolated_per_turn(store: SQLiteSessionStore) -> None:
    """Regression test for #487 — two quizzes in the same chat session must
    not share answer state, even when the positional ``question_id`` (e.g.
    ``q_1``) collides. The producing turn_id scopes notebook entries.
    """
    session = asyncio.run(store.create_session())
    sid = session["id"]

    with TestClient(_build_app(store)) as client:
        first = _quiz_answers()
        resp1 = client.post(
            f"/api/v1/sessions/{sid}/quiz-results",
            json={"answers": first, "turn_id": "turn_A"},
        )
        assert resp1.status_code == 200
        assert resp1.json()["notebook_count"] == 2

        second = _quiz_answers()
        second[0]["user_answer"] = ""
        second[0]["is_correct"] = False
        resp2 = client.post(
            f"/api/v1/sessions/{sid}/quiz-results",
            json={"answers": second, "turn_id": "turn_B"},
        )
        assert resp2.status_code == 200
        assert resp2.json()["notebook_count"] == 2

        listing = client.get("/api/v1/question-notebook/entries").json()
        assert listing["total"] == 4

        # Looking up q1 scoped to the first turn returns the first quiz's
        # answer, not the second.
        scoped_a = client.get(
            "/api/v1/question-notebook/entries/lookup/by-question",
            params={"session_id": sid, "question_id": "q1", "turn_id": "turn_A"},
        )
        assert scoped_a.status_code == 200
        assert scoped_a.json()["user_answer"] == "A"
        assert scoped_a.json()["turn_id"] == "turn_A"

        # The second turn has no recorded answer for q1.
        scoped_b = client.get(
            "/api/v1/question-notebook/entries/lookup/by-question",
            params={"session_id": sid, "question_id": "q1", "turn_id": "turn_B"},
        )
        assert scoped_b.status_code == 200
        assert scoped_b.json()["user_answer"] == ""
        assert scoped_b.json()["turn_id"] == "turn_B"


def test_lookup_without_turn_id_only_matches_legacy_namespace(
    store: SQLiteSessionStore,
) -> None:
    """Regression test for #677 — a lookup that doesn't pass turn_id must
    never see turn-scoped rows (positional ids like ``q_1`` repeat across
    quizzes, so a cross-turn fallback leaks the previous quiz's answers into
    a new quiz). It only matches the legacy namespace (turn_id='')."""
    session = asyncio.run(store.create_session())
    sid = session["id"]

    asyncio.run(
        store.upsert_notebook_entries(
            sid,
            [
                {
                    "turn_id": "turn_A",
                    "question_id": "q1",
                    "question": "Q?",
                    "user_answer": "A",
                    "is_correct": False,
                }
            ],
        )
    )

    with TestClient(_build_app(store)) as client:
        # Turn-scoped rows are invisible without their turn_id.
        resp = client.get(
            "/api/v1/question-notebook/entries/lookup/by-question",
            params={"session_id": sid, "question_id": "q1"},
        )
        assert resp.status_code == 404

        # Pre-turn-scoping rows (migrated with turn_id='') stay reachable.
        asyncio.run(
            store.upsert_notebook_entries(
                sid,
                [
                    {
                        "turn_id": "",
                        "question_id": "q1",
                        "question": "Q?",
                        "user_answer": "B",
                        "is_correct": True,
                    }
                ],
            )
        )
        legacy = client.get(
            "/api/v1/question-notebook/entries/lookup/by-question",
            params={"session_id": sid, "question_id": "q1"},
        )
        assert legacy.status_code == 200
        assert legacy.json()["turn_id"] == ""
        assert legacy.json()["user_answer"] == "B"


def test_lookup_missing_entry_returns_404_by_default(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    sid = session["id"]
    with TestClient(_build_app(store)) as client:
        resp = client.get(
            "/api/v1/question-notebook/entries/lookup/by-question",
            params={"session_id": sid, "question_id": "absent"},
        )
        assert resp.status_code == 404


def test_lookup_missing_entry_returns_204_when_missing_ok(store: SQLiteSessionStore) -> None:
    session = asyncio.run(store.create_session())
    sid = session["id"]
    with TestClient(_build_app(store)) as client:
        resp = client.get(
            "/api/v1/question-notebook/entries/lookup/by-question",
            params={"session_id": sid, "question_id": "absent", "missing_ok": "true"},
        )
        assert resp.status_code == 204
        assert resp.content == b""
