import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { apiFetch } from "../lib/api";

test("API gateway non-JSON 5xx becomes a safe error without replaying POST", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const status of [500, 502, 503, 504]) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response("<html>private backend URL and stack trace</html>", {
          status,
          headers: { "Content-Type": "text/html" },
        });
      }) as typeof fetch;
      const response = await apiFetch("/api/v1/plugins/tools/web_search/execute", {
        method: "POST",
        body: "{}",
      });
      const body = await response.json();
      assert.equal(response.status, status);
      assert.equal(response.headers.get("Content-Type"), "application/json");
      assert.equal(body.error, "backend_unavailable");
      assert.match(body.detail, /temporarily unavailable or timed out/);
      assert.doesNotMatch(JSON.stringify(body), /private|stack trace/);
      assert.equal(calls, 1);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("API errors retain backend JSON detail, trace ID and response identity", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const contentType of ["application/json; charset=utf-8", "application/problem+json"]) {
      const original = new Response(JSON.stringify({ detail: "Safe error", trace_id: "123" }), {
        status: 500,
        headers: { "Content-Type": contentType },
      });
      globalThis.fetch = (async () => original) as typeof fetch;
      const response = await apiFetch("/api/test");
      assert.equal(response, original);
      assert.deepEqual(await response.json(), { detail: "Safe error", trace_id: "123" });
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("API streaming success and cancellation retain native fetch semantics", async () => {
  const previousFetch = globalThis.fetch;
  try {
    const original = new Response("data: alive\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    globalThis.fetch = (async () => original) as typeof fetch;
    assert.equal(await apiFetch("/api/stream"), original);
    const abort = new DOMException("cancelled", "AbortError");
    globalThis.fetch = (async () => { throw abort; }) as typeof fetch;
    await assert.rejects(apiFetch("/api/stream"), (error) => error === abort);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Next rewrite ceiling covers maximum backend network and worker timeout", () => {
  const loadConfig = createRequire(path.join(process.cwd(), "next.config.js"));
  const config = loadConfig("./next.config.js");
  assert.equal(config.experimental.proxyTimeout, 660_000);
  assert.ok(config.experimental.proxyTimeout > (600 + 5) * 1000);
});
