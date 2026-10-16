import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

// Importing live-gate predicates must never launch a browser or mutate a KB.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertTaskComplete, isReadySnapshot } = require(join(process.cwd(), "scripts/e2e-keyword-retrieval.cjs"));

const taskId = "keyword-owned-task";
const terminal = (event = "complete", identity: string | undefined = taskId) =>
  `event: ${event}\ndata: ${JSON.stringify({ task_id: identity })}\n\n`;

test("keyword acceptance requires a successful terminal event for the owned task", () => {
  assert.equal(assertTaskComplete(`: heartbeat\n\n${terminal()}`, taskId), "complete");
  assert.equal(assertTaskComplete(terminal().replaceAll("\n", "\r\n"), taskId), "complete");
  for (const stream of ["", terminal("failed"), terminal("cancelled"), terminal("complete", "unrelated-task"), terminal() + terminal()]) {
    assert.throws(() => assertTaskComplete(stream, taskId));
  }
  assert.throws(() => assertTaskComplete("event: complete\ndata: {}\n\n", taskId));
  assert.throws(() => assertTaskComplete(terminal(), undefined));
  assert.throws(() => assertTaskComplete(`event: process_log\ndata: {"context":{"task_id":"unrelated-task"}}\n\n${terminal()}`, taskId));
});

test("keyword acceptance tolerates stale nonterminal progress only after task completion", () => {
  for (const stage of ["idle", "processing_documents", "completed"]) {
    assert.equal(isReadySnapshot({ status: "ready", progress: { task_id: taskId, stage: "completed" } }, { task_id: taskId, stage }, taskId, "complete"), true);
  }
  assert.equal(isReadySnapshot({ status: "processing" }, { stage: "idle" }, taskId, "complete"), false);
  assert.throws(() => isReadySnapshot({ status: "ready" }, {}, taskId, undefined));
});

test("keyword acceptance does not hide task identity changes or failed snapshots", () => {
  assert.throws(() => isReadySnapshot(undefined, {}, taskId, "complete"));
  for (const stage of ["error", "failed", "cancelled"]) {
    assert.throws(() => isReadySnapshot({ status: "ready" }, { stage }, taskId, "complete"));
    assert.throws(() => isReadySnapshot({ status: stage }, {}, taskId, "complete"));
    assert.throws(() => isReadySnapshot({ status: "ready", progress: { stage } }, {}, taskId, "complete"));
  }
  assert.throws(() => isReadySnapshot({ status: "ready" }, { task_id: "other" }, taskId, "complete"));
  assert.throws(() => isReadySnapshot({ status: "ready", progress: { task_id: "other" } }, {}, taskId, "complete"));
});
