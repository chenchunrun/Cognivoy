import test from "node:test";
import assert from "node:assert/strict";

import { extractLearningResult } from "../lib/learning-result";
import type { StreamEvent } from "../lib/unified-ws";

function event(type: StreamEvent["type"], metadata: Record<string, unknown>): StreamEvent {
  return {
    type,
    source: "test",
    stage: "",
    content: "",
    metadata,
    timestamp: 1,
  };
}

test("extracts a verified learning result from the terminal event", () => {
  const result = extractLearningResult([
    event("content", {}),
    event("done", {
      learning_result: {
        project_id: "project-1",
        task_id: "task-1",
        objective: "Apply access-control evidence",
        mastery_before: 0.4,
        mastery_after: 0.8,
        evidence_confidence: "high",
        evidence_refs: ["session:s1", "learning-session:s1:t1:1:goal"],
        review_due_count: 2,
        next_review_at: 123,
        next_task: { id: "task-2", objective: "Evaluate a new case" },
      },
    }),
  ]);

  assert.equal(result?.projectId, "project-1");
  assert.equal(result?.evidenceRefs.length, 2);
  assert.equal(result?.nextTask?.id, "task-2");
});

test("rejects incomplete or non-high-confidence result metadata", () => {
  assert.equal(
    extractLearningResult([
      event("done", {
        learning_result: {
          project_id: "project-1",
          task_id: "task-1",
          objective: "Unverified",
          evidence_confidence: "low",
        },
      }),
    ]),
    null,
  );
});
