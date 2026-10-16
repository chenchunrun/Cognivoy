import assert from "node:assert/strict";
import test from "node:test";

import { extractVisualizeResult, isManimResult } from "../lib/visualize-types";
import { hideLegacyVisualizeSuccessEvents } from "../lib/learner-trace";
import type { StreamEvent } from "../lib/unified-ws";

function decode(renderType: string, content: unknown, extras: Record<string, unknown> = {}) {
  const result = extractVisualizeResult({ render_type: renderType, code: { content }, ...extras });
  assert.ok(result && !isManimResult(result));
  return result;
}

function fallback(note: string) {
  return `<!DOCTYPE html><html><body><div class="card"><h1>Learning goal</h1><div class="summary">Some analysis</div><div class="note"><strong>Note:</strong><br>${note}</div></div></body></html>`;
}

test("legacy placeholder is failed even when review incorrectly passed local validation", () => {
  for (const note of ["Generation timed out; showing a safe fallback.", "The model did not return a renderable HTML document."]) {
    const result = decode("html", fallback(note), { review: { review_notes: "Passed local validation." } });
    assert.deepEqual(result.generation, { status: "failed", legacy_fallback: true });
  }
});

test("ordinary SVG, Chart.js, Mermaid and HTML stay renderable", () => {
  for (const [type, source] of [
    ["svg", '<svg viewBox="0 0 20 20"><text>fallback behavior</text></svg>'],
    ["chartjs", '{"type":"bar","data":{"labels":["timeout"],"datasets":[]}}'],
    ["mermaid", "graph LR; A[Timeout] --> B[Fallback]"],
    ["html", "<html><body><p>Generation timed out; showing a safe fallback.</p><svg></svg></body></html>"],
    ["html", fallback("An informational note.")],
    ["html", '<div class="note"><strong>Note:</strong><br>Generation timed out; showing a safe fallback.</div>'],
  ]) {
    assert.equal(decode(type, source).generation, undefined);
  }
});

test("new generation metadata preserves simplified retry outcome and original format", () => {
  const generation = { status: "completed", attempts: 2, simplified: true, requested_render_type: "svg" };
  assert.deepEqual(decode("svg", '<svg viewBox="0 0 10 10"/>', { generation }).generation, generation);
});

test("explicit failed or degraded result can show a recovery card without executable content", () => {
  for (const status of ["failed", "degraded"]) {
    const result = decode("html", "", { generation: { status } });
    assert.equal(result.generation?.status, status);
    assert.equal(result.code.content, "");
  }
  assert.equal(extractVisualizeResult({ render_type: "html", code: { content: "" }, generation: { status: "completed" } }), null);
});

test("malformed metadata is ignored and non-string code is never rendered", () => {
  assert.equal(extractVisualizeResult({ render_type: "html", code: { content: { html: "unsafe coercion" } } }), null);
  for (const generation of [null, [], "completed", { status: "unknown" }, { status: ["completed"] }]) {
    assert.equal(decode("svg", "<svg/>", { generation }).generation, undefined);
  }
  assert.deepEqual(decode("svg", "<svg/>", { generation: { status: "completed", attempts: -1, simplified: "true", requested_render_type: "unrecognized" } }).generation, { status: "completed" });
});

test("legacy trace hides only the known false success copy without mutating history", () => {
  const progress = (content: string, stage: string, source = "visualize"): StreamEvent => ({ type: "progress", content, stage, source, timestamp: 1, metadata: {} });
  const events = [
    progress("Code generated.", "generating"), progress("代码已生成。", "generating"),
    progress("Looks good — passed local checks.", "reviewing"), progress("通过本地校验，看起来没问题。", "reviewing"),
    progress("Generation took too long; using a safe fallback.", "generating"),
    progress("Code generated.", "generating", "chat"),
    progress("Code generated.", "other-stage"),
    progress("Some evidence passed local checks.", "reviewing"),
  ];
  assert.equal(hideLegacyVisualizeSuccessEvents(events, false), events);
  assert.equal(hideLegacyVisualizeSuccessEvents(undefined, true), undefined);
  assert.deepEqual(hideLegacyVisualizeSuccessEvents(events, true), events.slice(4));
  assert.equal(events.length, 8);
});
