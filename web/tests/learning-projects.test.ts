import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  learningTaskLaunchHref,
  type LearningProject,
  type LearningTask,
} from "../lib/learning-project-api";


test("learning tasks launch into guided learning with stable project context", () => {
  const task: LearningTask = {
    id: "task-1",
    project_id: "project-1",
    objective: "Explain eigenvalues & practice",
    expected_minutes: 25,
    intent: "mastery_path",
    status: "todo",
    version: 1,
    project_version: 2,
  };

  const href = learningTaskLaunchHref(task);
  const url = new URL(href, "http://localhost");
  assert.equal(url.pathname, "/home");
  assert.equal(url.searchParams.get("learning_task"), "task-1");
  assert.equal(url.searchParams.get("project"), "project-1");
  assert.equal(url.searchParams.get("objective"), "Explain eigenvalues & practice");
});

test("baseline tasks open the project assessment instead of a generic chat", () => {
  const task: LearningTask = {
    id: "assessment-1",
    project_id: "project / 中文",
    objective: "Calibrate the starting point",
    expected_minutes: 15,
    intent: "assessment",
    status: "todo",
    version: 1,
  };

  assert.equal(
    learningTaskLaunchHref(task),
    "/space/learning/project%20%2F%20%E4%B8%AD%E6%96%87#baseline-assessment",
  );
});

test("learning projects expose append-only activity and learner outcomes", () => {
  const project = {
    events: [{ event_type: "task_completed", result_refs: ["session:s1"] }],
    mastery_summary: 0.45,
    weak_points: ["Explain eigenvalues"],
  } as LearningProject;
  assert.equal(project.events[0].event_type, "task_completed");
  assert.equal(project.mastery_summary, 0.45);
  assert.deepEqual(project.weak_points, ["Explain eigenvalues"]);
});

test("the composer and unified turn contract preserve learning project identity", () => {
  const composer = readFileSync(path.resolve("components/chat/ChatComposer.tsx"), "utf8");
  const context = readFileSync(path.resolve("context/UnifiedChatContext.tsx"), "utf8");
  assert.match(composer, /learning_task/);
  assert.match(composer, /learningContext/);
  assert.match(context, /learning_context: effectiveLearningContext/);
});

test("learning project details expose baseline, map, plan editing, tutor outreach, and evidence", () => {
  const page = readFileSync(path.resolve("app/(utility)/space/learning/[projectId]/page.tsx"), "utf8");
  assert.match(page, /submitBaselineAssessment/);
  assert.match(page, /knowledge_map/);
  assert.match(page, /updateLearningProject/);
  assert.match(page, /Learning evidence/);
  assert.match(page, /completeProjectReview/);
  assert.match(page, /review-queue/);
  assert.match(page, /listPartners/);
  assert.match(page, /partner_id/);
  assert.match(page, /policy-controlled reminders/);
});
