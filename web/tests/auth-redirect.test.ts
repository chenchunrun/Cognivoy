import assert from "node:assert/strict";
import test from "node:test";

import { safeNextPath } from "../lib/auth-redirect";

test("post-login redirects remain on the application origin", () => {
  assert.equal(safeNextPath("/book?tab=ready#chapter-1"), "/book?tab=ready#chapter-1");
  assert.equal(safeNextPath(null), "/home");
  assert.equal(safeNextPath("https://evil.example"), "/home");
  assert.equal(safeNextPath("//evil.example"), "/home");
  assert.equal(safeNextPath("/\\evil.example"), "/home");
  assert.equal(safeNextPath("/book\u0000"), "/home");
});
