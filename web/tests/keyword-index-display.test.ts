import assert from "node:assert/strict";
import test from "node:test";
import { kbKeywordIndexReady, kbUsesKeywordRetrieval, type KnowledgeBase } from "@/lib/knowledge-helpers";

const ready: KnowledgeBase = {
  name: "keyword-display", status: "ready",
  statistics: { rag_provider: "llamaindex", retrieval_profile: "keyword", rag_initialized: true, active_match: true, index_versions: [] },
};

test("keyword readiness uses the actual text index, independently of vector version count", () => {
  assert.equal(kbUsesKeywordRetrieval(ready), true);
  assert.equal(kbKeywordIndexReady(ready), true);
  assert.equal(kbKeywordIndexReady({ ...ready, statistics: { ...ready.statistics, index_versions: [{ signature: "preserved-vector", ready: true }] } }), true);
  assert.equal(kbKeywordIndexReady({ ...ready, statistics: { ...ready.statistics, rag_initialized: false, index_versions: [{ ready: true }] } }), false);
});

test("empty or unavailable vector indexes never imply keyword mode", () => {
  for (const retrieval_profile of [undefined, null, "hybrid", "vector"] as const) {
    const kb = { ...ready, statistics: { ...ready.statistics, retrieval_profile } };
    assert.equal(kbUsesKeywordRetrieval(kb), false);
    assert.equal(kbKeywordIndexReady(kb), false);
  }
  assert.equal(kbUsesKeywordRetrieval({ ...ready, statistics: { ...ready.statistics, rag_provider: "pageindex" } }), false);
});

test("keyword readiness never hides unfinished, failed, missing, or stale indexes", () => {
  for (const status of [undefined, "processing", "initializing", "error", "cancelled", "needs_reindex"]) {
    assert.equal(kbKeywordIndexReady({ ...ready, status }), false);
  }
  for (const statistics of [{ rag_initialized: false }, { rag_initialized: undefined }, { active_match: false }, { active_match: undefined }, { needs_reindex: true }]) {
    assert.equal(kbKeywordIndexReady({ ...ready, statistics: { ...ready.statistics, ...statistics } }), false);
  }
});
