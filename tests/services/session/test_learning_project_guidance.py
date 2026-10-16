from __future__ import annotations

from cognivoy.learning.project_models import LearningProject, LearningTask
from cognivoy.learning.project_storage import LearningProjectStore
from cognivoy.services.session import turn_runtime


def test_learning_context_follows_session_across_capability_switches() -> None:
    saved = {
        "learning_context": {
            "project_id": "cisa-project",
            "task_id": "domain-2",
            "objective": "Align IT governance with business goals",
        }
    }

    inherited, explicit = turn_runtime._resolve_session_learning_context({}, saved)
    assert inherited == saved["learning_context"]
    assert explicit is False

    cleared, explicit = turn_runtime._resolve_session_learning_context(
        {"learning_context": {}}, saved
    )
    assert cleared == {}
    assert explicit is True

    replacement, explicit = turn_runtime._resolve_session_learning_context(
        {
            "learning_context": {
                "project_id": "new-project",
                "task_id": "new-task",
            }
        },
        saved,
    )
    assert replacement == {"project_id": "new-project", "task_id": "new-task"}
    assert explicit is True


def test_learning_project_guidance_is_personalized_and_owner_scoped(tmp_path, monkeypatch) -> None:
    store = LearningProjectStore(tmp_path / "projects")
    store.create(
        LearningProject(
            id="rag-project",
            owner_id="learner-1",
            title="Production RAG",
            current_level="beginner",
            target_level="practical",
            preferred_methods=["worked examples", "visual"],
            weak_points=["retrieval evaluation"],
            knowledge_base_ids=["rag-notes", "evaluation-paper"],
        )
    )
    monkeypatch.setattr(
        "cognivoy.learning.project_storage.LearningProjectStore",
        lambda: store,
    )

    guidance = turn_runtime._learning_project_guidance(
        {
            "learning_context": {
                "project_id": "rag-project",
                "task_id": "task-1",
                "objective": "Compare reranking strategies",
            }
        },
        owner_id="learner-1",
        language="en",
    )

    assert "Compare reranking strategies" in guidance
    assert "worked examples, visual" in guidance
    assert "retrieval evaluation" in guidance
    assert "visual_first" in guidance
    assert "foundation" in guidance
    assert "end with one concise understanding check" in guidance
    payload = {"knowledge_bases": ["manual-source", "rag-notes"]}
    project = turn_runtime._learning_project_for_turn(
        {"learning_context": {"project_id": "rag-project"}},
        owner_id="learner-1",
    )
    turn_runtime._mount_learning_project_knowledge(payload, project)
    assert payload["knowledge_bases"] == [
        "manual-source",
        "rag-notes",
        "evaluation-paper",
    ]
    assert (
        turn_runtime._learning_project_guidance(
            {"learning_context": {"project_id": "rag-project"}},
            owner_id="learner-2",
            language="en",
        )
        == ""
    )


def test_learning_project_guidance_raises_difficulty_only_from_saved_evidence() -> None:
    project = LearningProject(
        id="advanced-project",
        owner_id="learner-1",
        title="Distributed systems",
        mastery_summary=0.82,
        preferred_methods=["Socratic discussion"],
    )
    guidance = turn_runtime._learning_project_guidance(
        {"learning_context": {"project_id": project.id}},
        owner_id="learner-1",
        language="en",
        project=project,
    )
    assert "socratic" in guidance
    assert "challenge" in guidance

    project.weak_points = ["linearizability"]
    repaired = turn_runtime._learning_project_guidance(
        {"learning_context": {"project_id": project.id}},
        owner_id="learner-1",
        language="en",
        project=project,
    )
    assert "guided" in repaired


def test_trusted_learning_task_context_rejects_unknown_tasks_and_spoofed_objectives() -> None:
    project = LearningProject(
        id="owned-project",
        owner_id="owner-1",
        title="Owned plan",
        tasks=[
            LearningTask(
                id="owned-task",
                project_id="owned-project",
                objective="Server-authored objective",
            )
        ],
    )

    assert (
        turn_runtime._trusted_learning_task_context(
            project,
            {"task_id": "other-task", "objective": "spoofed"},
        )
        == {}
    )
    assert (
        turn_runtime._trusted_learning_task_context(
            None,
            {"task_id": "owned-task"},
        )
        == {}
    )
    assert turn_runtime._trusted_learning_task_context(
        project,
        {"task_id": "owned-task", "objective": "spoofed"},
    ) == {
        "project_id": "owned-project",
        "task_id": "owned-task",
        "objective": "Server-authored objective",
    }
