import assert from "node:assert/strict";
import test from "node:test";
import { extractExplorationBudget } from "../lib/exploration-budget";
import { buildLearnerTraceItems } from "../lib/learner-trace";
import type { StreamEvent } from "../lib/unified-ws";

const budget = { used: 8, initial: 8, limit: 12, maximum: 16, settlement_rounds: 0, phase: "exploring", reason: "progress_extension" };
function event(type: StreamEvent["type"], metadata: Record<string, unknown>): StreamEvent {
  return { type, content: "", source: "chat", stage: "responding", timestamp: 0, metadata };
}

test("live round allowance updates without counting tool cards or context tokens", () => {
  const events = [event("progress", { trace_kind: "exploration_budget", exploration_budget: budget })];
  const { settlement_rounds: settlementRounds, ...rest } = budget;
  assert.deepEqual(extractExplorationBudget(events), { ...rest, settlementRounds });
});

test("completed result overrides live budget; telemetry is not a warning or trace row", () => {
  const events = [
    event("progress", { trace_kind: "exploration_budget", exploration_budget: budget }),
    event("result", { metadata: { exploration_budget: { ...budget, used: 9, phase: "complete" } } }),
  ];
  assert.equal(extractExplorationBudget(events)?.used, 9);
  assert.equal(extractExplorationBudget(events)?.phase, "complete");
  assert.deepEqual(buildLearnerTraceItems(events, false), []);
});

test("old and malformed round records are ignored", () => {
  assert.equal(extractExplorationBudget(undefined), null);
  assert.equal(extractExplorationBudget({ length: 3 } as unknown as StreamEvent[]), null);
  assert.equal(extractExplorationBudget([event("result", { rounds: 9 })]), null);
  for (const change of [{ used: -1 }, { used: 13 }, { used: "8" }, { limit: 0 }, { maximum: 7 }, { initial: NaN }, { settlement_rounds: 1.5 }]) {
    assert.equal(extractExplorationBudget([event("progress", { exploration_budget: { ...budget, ...change } })]), null);
  }
});
