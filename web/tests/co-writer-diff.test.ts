import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProposalHunkDecisions,
  buildProposalDiff,
  buildProposalHunks,
} from "@/lib/co-writer-diff";

test("co-writer proposal diff marks additions and removals", () => {
  const diff = buildProposalDiff("first\nold\nlast", "first\nnew\nlast");
  assert.deepEqual(diff, [
    { kind: "context", text: "first" },
    { kind: "add", text: "new" },
    { kind: "remove", text: "old" },
    { kind: "context", text: "last" },
  ]);
});

test("co-writer proposal diff stays bounded for large drafts", () => {
  const before = Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n");
  const after = before.replace("line 150", "changed line");
  const diff = buildProposalDiff(before, after);
  assert.ok(diff.some((line) => line.kind === "remove" && line.text === "line 150"));
  assert.ok(diff.some((line) => line.kind === "add" && line.text === "changed line"));
  assert.ok(diff.length < 10);
});

test("co-writer proposal hunks can be accepted independently", () => {
  const before = "Title\nold first\nkeep\nold second\nEnd";
  const after = "Title\nnew first\nkeep\nnew second\nEnd";

  const hunks = buildProposalHunks(before, after);

  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].before, ["old first"]);
  assert.deepEqual(hunks[0].after, ["new first"]);
  assert.equal(
    applyProposalHunkDecisions(before, after, { 0: true, 1: false }),
    "Title\nnew first\nkeep\nold second\nEnd",
  );
  assert.equal(
    applyProposalHunkDecisions(before, after, { 0: false, 1: true }),
    "Title\nold first\nkeep\nnew second\nEnd",
  );
});
