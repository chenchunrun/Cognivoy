/* Keep live-model acceptance separate from useful-but-partial output. */
const assert = require("node:assert/strict");

function assertCompleteResearchResult(result) {
  const meta = result?.metadata?.metadata;
  assert.ok(meta, "Deep Research final RESULT lacks research metadata");
  assert.equal(meta.partial, false, "Deep Research returned a partial report");
  assert.equal(meta.failed_block_count, 0, "Deep Research has failed research blocks");
  assert.ok(Number.isInteger(meta.block_count) && meta.block_count > 0,
    "Deep Research has no planned research blocks");
  assert.equal(meta.completed_block_count, meta.block_count,
    "Deep Research did not complete every planned block");
  assert.equal(meta.report_complete, true, "Deep Research reporting did not complete");
  assert.deepEqual(meta.incomplete_report_steps, [], "Deep Research has empty report sections");
  assert.deepEqual(meta.timed_out_stages, [], "Deep Research degraded after a stage timeout");
  assert.equal(meta.checkpoint_resumable, false, "Deep Research still needs recovery");
  const coverage = meta.evidence_coverage;
  assert.equal(coverage?.complete, true, "Deep Research lacks complete evidence coverage");
  assert.deepEqual(coverage.missing, [], "Deep Research is missing evidence channels");
  assert.ok(Array.isArray(coverage.expected) && Array.isArray(coverage.observed),
    "Deep Research lacks evidence channel lists");
  for (const channel of coverage.expected) {
    assert.ok(coverage.observed.includes(channel), `Deep Research did not cite ${channel}`);
  }
  if (coverage.expected.length) {
    assert.ok(Number.isInteger(meta.citation_count) && meta.citation_count > 0,
      "Deep Research has no collected citations");
  }
  return coverage;
}

module.exports = { assertCompleteResearchResult };
