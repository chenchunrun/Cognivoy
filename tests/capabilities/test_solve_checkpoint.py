from __future__ import annotations

from cognivoy.capabilities.solve.checkpoint import DeepSolveCheckpointStore


def test_deep_solve_checkpoint_round_trips_solver_and_verification(tmp_path) -> None:
    store = DeepSolveCheckpointStore("turn-1", root=tmp_path)
    store.start(fingerprint="request-a")
    store.save_stage(
        "reasoning",
        {
            "solver_payload": {"response": "x = 2"},
            "session": {
                "analysis": "isolate x",
                "steps": [{"id": "S1", "goal": "solve", "done": True, "summary": "x=2"}],
                "replans": 0,
                "max_replans": 2,
            },
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "total_calls": 1,
            },
        },
    )
    store.save_stage(
        "verification",
        {"passed": True, "critique": "checked", "corrected_answer": ""},
    )

    reopened = DeepSolveCheckpointStore("turn-1", root=tmp_path)
    metadata = reopened.start(fingerprint="request-a")

    assert metadata["resume_count"] == 1
    assert reopened.load_stage("reasoning")["solver_payload"]["response"] == "x = 2"
    assert reopened.load_stage("verification")["passed"] is True


def test_deep_solve_checkpoint_rejects_stages_from_another_request(tmp_path) -> None:
    store = DeepSolveCheckpointStore("turn-1", root=tmp_path)
    store.start(fingerprint="request-a")
    store.save_stage("reasoning", {"solver_payload": {"response": "old"}})

    store.start(fingerprint="request-b")

    assert store.load_stage("reasoning") is None
    assert store.metadata()["fingerprint"] == "request-b"
