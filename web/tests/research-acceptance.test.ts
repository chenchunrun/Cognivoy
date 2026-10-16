import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

// Load the same assertion used by the live browser gate, not a copied predicate.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertCompleteResearchResult } = require(join(process.cwd(), "scripts/research-acceptance.cjs"));
// Importing the helpers must not launch a browser or send provider requests.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readConfig, assertResumableSession, assertResumedResult } = require(join(process.cwd(), "scripts/e2e-research-resume.cjs"));

function completeResult(overrides: Record<string, unknown> = {}) {
  return { metadata: { metadata: {
    partial: false,
    failed_block_count: 0,
    block_count: 2,
    completed_block_count: 2,
    report_complete: true,
    incomplete_report_steps: [],
    timed_out_stages: [],
    checkpoint_resumable: false,
    citation_count: 2,
    evidence_coverage: {
      complete: true, expected: ["web_search", "paper_search"],
      observed: ["web_search", "paper_search"], missing: [],
    },
    ...overrides,
  } } };
}

test("complete research passes the live acceptance predicate", () => {
  assert.doesNotThrow(() => assertCompleteResearchResult(completeResult()));
});

test("2026-09-07 partial research regression is rejected despite complete evidence channels", () => {
  assert.throws(() => assertCompleteResearchResult(completeResult({
    partial: true, failed_block_count: 1, completed_block_count: 1,
    checkpoint_resumable: true,
  })), /partial report/);
});

test("research acceptance rejects missing, failed, timed-out, or inconsistent settlement", () => {
  assert.throws(() => assertCompleteResearchResult(undefined));
  for (const overrides of [
    { partial: undefined }, { failed_block_count: 1 }, { block_count: 0 },
    { completed_block_count: 1 }, { report_complete: false },
    { incomplete_report_steps: ["intro"] }, { incomplete_report_steps: undefined },
    { timed_out_stages: ["reporting"] }, { checkpoint_resumable: true },
    { citation_count: 0 },
    { evidence_coverage: { complete: true, missing: ["web_search"] } },
    { evidence_coverage: { complete: true, missing: [], expected: ["web_search"], observed: [] } },
  ]) {
    assert.throws(() => assertCompleteResearchResult(completeResult(overrides)));
  }
});

test("real research recovery requires explicit isolated loopback targets and one session", () => {
  const env = { BASE_URL: "http://127.0.0.1:38086", API_URL: "http://127.0.0.1:38085", SESSION_ID: "test-session" };
  assert.equal(readConfig(env).sessionId, "test-session");
  for (const value of [
    "http://127.0.0.1:8001", "http://localhost:8003", "http://[::1]:3784",
    "https://example.com:38086", "http://0.0.0.0:38086", "http://127.0.0.1",
    "http://user:password@127.0.0.1:38086", "http://127.0.0.1:38086/home",
  ]) {
    assert.throws(() => readConfig({ ...env, BASE_URL: value }));
    assert.throws(() => readConfig({ ...env, API_URL: value }));
  }
  assert.throws(() => readConfig({ ...env, BASE_URL: undefined }));
  assert.throws(() => readConfig({ ...env, API_URL: "http://localhost:38086" }));
  assert.throws(() => readConfig({ ...env, SESSION_ID: undefined }));
  assert.throws(() => readConfig({ ...env, SESSION_ID: "../another-session" }));
});

test("real research recovery refuses nonpartial, active, or unrelated sessions", () => {
  const result = {
    ...completeResult({ partial: true, checkpoint_resumable: true, research_checkpoint_id: "research_test" }),
    type: "result", source: "deep_research", turn_id: "original-turn",
  };
  const detail = { id: "test-session", status: "completed", active_turns: [], messages: [
    { role: "assistant", capability: "deep_research", events: [result] },
  ] };
  assert.equal(assertResumableSession(detail, "test-session").turn_id, "original-turn");
  assert.throws(() => assertResumableSession(detail, "other-session"));
  assert.throws(() => assertResumableSession({ ...detail, active_turns: [{}] }, "test-session"));
  assert.throws(() => assertResumableSession({ ...detail, active_turns: undefined }, "test-session"));
  assert.throws(() => assertResumableSession({ ...detail, status: "running" }, "test-session"));
  result.metadata.metadata.partial = false;
  assert.throws(() => assertResumableSession(detail, "test-session"));
});

test("real research recovery must complete a new turn from the same checkpoint", () => {
  const original = { ...completeResult({ research_checkpoint_id: "research_test" }), turn_id: "original-turn" };
  const resumed = { ...completeResult({ research_checkpoint_id: "research_test", resumed_from_checkpoint: true }), turn_id: "new-turn" };
  assert.doesNotThrow(() => assertResumedResult(original, resumed));
  assert.throws(() => assertResumedResult(original, { ...resumed, turn_id: "original-turn" }));
  for (const change of [
    { resumed_from_checkpoint: false }, { research_checkpoint_id: "other-checkpoint" }, { partial: true },
  ]) {
    assert.throws(() => assertResumedResult(original, {
      ...completeResult({ research_checkpoint_id: "research_test", resumed_from_checkpoint: true, ...change }), turn_id: "new-turn",
    }));
  }
});
