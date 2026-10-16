/* Strict, opt-in real-provider recovery of ONE pre-existing partial research.
 *
 * From web/ (use the ports of your isolated test installation):
 * BASE_URL=http://127.0.0.1:38086 API_URL=http://127.0.0.1:38085 \
 *   SESSION_ID=<isolated-partial-session-id> node scripts/e2e-research-resume.cjs
 *
 * No defaults, credential copying, new research requests, or automatic retries.
 * The only generation action is one click on that session's Regenerate button.
 * Real provider calls may incur charges. Never point this at a personal session.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assertCompleteResearchResult } = require("./research-acceptance.cjs");

const RESERVED_PORTS = new Set(["8001", "8003", "3784"]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ACTIVE_STATUSES = new Set(["pending", "queued", "running", "waiting_for_input"]);

function isolatedOrigin(value, name) {
  assert.ok(value, `${name} is required; only an isolated loopback installation is allowed`);
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol), `${name} must use HTTP(S)`);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    `${name} must be loopback, not a remote or wildcard host`);
  assert.ok(url.port && Number(url.port) >= 1024, `${name} requires an explicit test port`);
  assert.ok(!RESERVED_PORTS.has(url.port), `${name} uses a protected service port`);
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/",
    `${name} must be an origin without credentials, path, query, or fragment`);
  return url.origin;
}

function readConfig(env) {
  const base = isolatedOrigin(env.BASE_URL, "BASE_URL");
  const api = isolatedOrigin(env.API_URL, "API_URL");
  assert.notEqual(new URL(base).port, new URL(api).port,
    "BASE_URL and API_URL must identify separate test frontend/backend ports");
  assert.ok(SAFE_ID.test(env.SESSION_ID || ""), "SESSION_ID is required and must be a safe session id");
  return { base, api, sessionId: env.SESSION_ID };
}

function lastResearchResult(detail) {
  const message = detail?.messages?.at(-1);
  if (message?.role !== "assistant" || message.capability !== "deep_research") return null;
  return (message.events || []).findLast((event) =>
    event.type === "result" && event.source === "deep_research") || null;
}

function assertResumableSession(detail, sessionId) {
  assert.equal(detail?.id, sessionId, "Session lookup returned a different session");
  assert.ok(Array.isArray(detail.active_turns) && detail.active_turns.length === 0,
    "Refusing to regenerate a session with active or unknown turns");
  assert.ok(!ACTIVE_STATUSES.has(detail.status), "Refusing to regenerate an active session");
  const result = lastResearchResult(detail);
  const meta = result?.metadata?.metadata;
  assert.ok(result && SAFE_ID.test(result.turn_id || ""),
    "The final assistant message must contain a settled Deep Research result");
  assert.equal(meta?.partial, true, "Refusing to repeat research that is not explicitly partial");
  assert.equal(meta.checkpoint_resumable, true, "Research has no resumable checkpoint");
  assert.ok(SAFE_ID.test(meta.research_checkpoint_id || ""), "Research checkpoint id is missing");
  return result;
}

function assertResumedResult(original, result) {
  assert.notEqual(result?.turn_id, original.turn_id, "The original result is not proof of a retry");
  assert.ok(SAFE_ID.test(result?.turn_id || ""), "Resumed result has no valid turn id");
  const coverage = assertCompleteResearchResult(result);
  const meta = result.metadata.metadata;
  assert.equal(meta.resumed_from_checkpoint, true, "Regenerate restarted research instead of resuming");
  assert.equal(meta.research_checkpoint_id, original.metadata.metadata.research_checkpoint_id,
    "Regenerate did not use the original checkpoint");
  return coverage;
}

async function sessionDetail(origin, sessionId) {
  const response = await fetch(`${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  assert.ok(response.ok, `Session lookup failed: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const { base, api, sessionId } = readConfig(process.env);
  // The frontend proxy must reach the same isolated session before we allow a
  // click. This also catches a test frontend accidentally targeting production.
  const original = assertResumableSession(await sessionDetail(api, sessionId), sessionId);
  const viaBrowserOrigin = assertResumableSession(await sessionDetail(base, sessionId), sessionId);
  assert.equal(viaBrowserOrigin.turn_id, original.turn_id, "Frontend/backend session targets differ");
  assert.equal(viaBrowserOrigin.metadata.metadata.research_checkpoint_id,
    original.metadata.metadata.research_checkpoint_id, "Frontend/backend checkpoints differ");

  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  let submitted = false;
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.localStorage.setItem("cognivoy-language", "en");
      window.localStorage.setItem("cognivoy-response-language", "en");
    });
    const page = await context.newPage();
    const generationFrames = [];
    let newTurnSeen = false;
    let lastStage = "";
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (frame.turn_id && frame.turn_id !== original.turn_id) {
            newTurnSeen = true;
            if (["rephrasing", "decomposing", "researching", "reporting"].includes(frame.stage)
              && frame.stage !== lastStage) {
              lastStage = frame.stage;
              console.log(`Research recovery stage: ${lastStage}`);
            }
          }
        } catch { /* Ignore non-JSON transport frames. */ }
      });
      socket.on("framesent", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (["regenerate", "message", "start_turn"].includes(frame.type)) {
            generationFrames.push(frame);
          }
        } catch { /* Ignore non-JSON transport frames. */ }
      });
    });
    await page.goto(`${base}/home/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator("textarea").first().waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(new URL(page.url()).pathname, `/home/${sessionId}`, "UI did not open the selected session");
    const retry = page.locator('[data-chat-message="assistant"]').last()
      .getByRole("button", { name: "Regenerate", exact: true });
    await retry.waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(await retry.isEnabled(), "Regenerate is disabled");
    assert.equal(assertResumableSession(await sessionDetail(api, sessionId), sessionId).turn_id,
      original.turn_id, "Session changed during preflight; refusing to regenerate");

    console.log(`Resuming one partial Deep Research session: ${sessionId}`);
    // Never repeat this click, including after a transport error or timeout.
    submitted = true;
    await retry.click({ timeout: 10_000 });
    const deadline = Date.now() + 480_000;
    let result = null;
    while (Date.now() < deadline) {
      const detail = await sessionDetail(api, sessionId);
      assert.equal(detail.id, sessionId);
      const candidate = lastResearchResult(detail);
      if (candidate && candidate.turn_id !== original.turn_id
        && Array.isArray(detail.active_turns) && detail.active_turns.length === 0) {
        result = candidate;
        break;
      }
      if (newTurnSeen && ["failed", "cancelled", "timed_out", "rejected"].includes(detail.status)
        && detail.active_turns?.length === 0) {
        throw new Error(`Research recovery ended with ${detail.status}; no automatic retry was made`);
      }
      if (generationFrames.length > 1) throw new Error("More than one generation request was sent");
      await page.waitForTimeout(1000);
    }
    assert.ok(result, "Research recovery did not settle within 480 seconds; no automatic retry was made");
    assert.equal(generationFrames.length, 1, "Expected exactly one UI generation request");
    assert.equal(generationFrames[0].type, "regenerate", "UI submitted a new research request");
    assert.equal(generationFrames[0].session_id, sessionId, "UI regenerated a different session");
    const coverage = assertResumedResult(original, result);
    await page.locator('button[aria-label="Stop generating"]').waitFor({ state: "hidden", timeout: 15_000 });
    const assistant = page.locator('[data-chat-message="assistant"]').last();
    assert.ok((await assistant.innerText()).trim().length > 20, "Resumed report did not render in the UI");
    const summary = {
      outcome: "pass", sessionId, originalTurnId: original.turn_id, resumedTurnId: result.turn_id,
      checkpointId: result.metadata.metadata.research_checkpoint_id,
      completedBlocks: result.metadata.metadata.completed_block_count,
      citationCount: result.metadata.metadata.citation_count,
      evidenceChannels: coverage.observed,
      // No prompts, source excerpts, provider profiles, tokens, or credentials.
    };
    const output = path.join(__dirname, "..", "test-results", `e2e-research-resume-${sessionId}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
    console.log(`PASS research recovery; evidence: ${output}`);
  } finally {
    await browser.close();
    if (submitted) {
      console.log("Exactly one Regenerate click was attempted. On failure, inspect this session before taking further action.");
    }
  }
}

module.exports = { readConfig, assertResumableSession, assertResumedResult };
if (require.main === module) {
  main().catch((error) => {
    // Assertion details can contain compared values; keep failures concise and
    // avoid dumping session contents or HTTP response bodies.
    console.error(`FAIL research recovery: ${String(error.message).split("\n")[0]}`);
    process.exitCode = 1;
  });
}
