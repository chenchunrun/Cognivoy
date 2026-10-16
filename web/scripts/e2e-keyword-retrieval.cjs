/* Real, credential-free keyword RAG acceptance on an isolated deployment only.
 * No core API/WS response is mocked. Owns one uniquely named synthetic KB;
 * restores the retrieval profile and deletes only that KB in finally.
 *
 * BASE_URL=http://127.0.0.1:3789 API_URL=http://127.0.0.1:8009 \
 *   node scripts/e2e-keyword-retrieval.cjs
 * Start a fresh backend home with no embedding profile/credentials and enable
 * Playground execution for its real rag-tool endpoint before running this gate.
 */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, request } = require("@playwright/test");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3789").replace(/\/$/, "");
const API = (process.env.API_URL || "http://127.0.0.1:8009").replace(/\/$/, "");
const CONFIG = "/api/v1/knowledge/rag-pipelines/llamaindex/config";
const PREFIX = "/api/v1/knowledge";
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const KB = `e2e-keyword-${suffix}`;
const KB_PATH = `${PREFIX}/${encodeURIComponent(KB)}`;
const FIRST = `keystonenorth${suffix}`;
const SECOND = `coppermeadow${suffix}`;
const FIRST_FILE = "cisa-keyword-foundation.txt";
const SECOND_FILE = "cisa-keyword-incremental.txt";
const originalText = `CISA keyword-only acceptance notes.\n\n${FIRST} is the unique evidence marker for this synthetic document. Auditors examine access controls, audit evidence, and segregation of duties. This text is generated for software testing and is not official certification course material.`;
const incrementalText = `CISA incremental acceptance notes.\n\n${SECOND} is the unique evidence marker for the added document. Change management records identify approval, test evidence, and rollback instructions. This synthetic file verifies incremental keyword indexing without an embedding model.`;

function isolatedOrigin(value, label) {
  const url = new URL(value);
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), `${label} must be a loopback isolated instance`);
  assert(["http:", "https:"].includes(url.protocol), `${label} must use HTTP(S)`);
  assert(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", `${label} must be a plain origin`);
  assert(url.port && !["8001", "8003", "8100", "3782", "3784"].includes(url.port), `${label} points to a protected existing service port`);
  return url;
}

function assertNoCredentials(settings) {
  const catalog = settings.catalog;
  assert(catalog?.services, "Fresh admin-accessible model catalog is required");
  const embedding = catalog.services.embedding;
  assert(embedding && (!embedding.profiles || embedding.profiles.length === 0), "The test requires no embedding profiles, not merely a stopped model server");
  assert(!embedding.active_profile_id && !embedding.active_model_id, "An embedding model remains selected");
  function visit(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(api_key|apiKey|access_token|refresh_token|authorization)$/i.test(key)) {
        assert(!item || (typeof item === "string" && !item.trim()), "The isolated test catalog contains credentials; refusing to proceed");
      }
      if (item && typeof item === "object") visit(item);
    }
  }
  visit(catalog);
}

async function json(client, origin, endpoint, options = {}) {
  const response = await client.fetch(`${origin}${endpoint}`, { timeout: 60_000, ...options });
  assert(response.ok(), `${options.method || "GET"} ${endpoint} returned HTTP ${response.status()}`);
  return response.json();
}

function assertTaskComplete(stream, taskId) {
  assert(typeof taskId === "string" && taskId, "Knowledge indexing did not return a task identity");
  let terminal;
  for (const frame of stream.replaceAll("\r\n", "\n").split("\n\n")) {
    const lines = frame.split("\n");
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue; // SSE heartbeat comments carry no task state.
    const payload = JSON.parse(data);
    for (const identity of [payload.task_id, payload.context?.task_id]) {
      if (identity !== undefined) assert.equal(identity, taskId, "Knowledge task identity changed unexpectedly");
    }
    if (["complete", "failed", "cancelled"].includes(event)) {
      assert(!terminal, "Knowledge task returned multiple terminal events");
      assert.equal(payload.task_id, taskId, "Knowledge terminal event is missing the expected task identity");
      assert.equal(event, "complete", `Knowledge indexing terminated with ${event}`);
      terminal = event;
    }
  }
  assert.equal(terminal, "complete", "Knowledge task stream closed without a successful terminal event");
  return terminal;
}

function isReadySnapshot(kb, progress, taskId, terminal) {
  assert.equal(terminal, "complete", "A ready KB alone does not prove this task completed");
  assert(kb, "Created test KB disappeared during indexing");
  for (const state of [progress, kb.progress, kb]) {
    if (!state) continue;
    if (state.task_id !== undefined && state.task_id !== null) {
      assert.equal(state.task_id, taskId, "Knowledge task identity changed unexpectedly");
    }
    for (const status of [state.stage, state.status]) {
      assert(!["error", "failed", "cancelled"].includes(status), `Knowledge indexing terminated with ${status}`);
    }
  }
  return kb.status === "ready";
}

async function waitReady(client, taskId) {
  assert(typeof taskId === "string" && taskId, "Knowledge indexing did not return a task identity");
  const deadline = Date.now() + 120_000;
  // The task stream closes on a retained complete/failed/cancelled event. Unlike
  // /progress (a persisted snapshot), this proves this particular task settled.
  const response = await client.get(`${API}${PREFIX}/tasks/${encodeURIComponent(taskId)}/stream`, { timeout: 120_000 });
  assert(response.ok(), `Knowledge task stream returned HTTP ${response.status()}`);
  assert(response.headers()["content-type"]?.includes("text/event-stream"), "Knowledge task did not return an event stream");
  const terminal = assertTaskComplete(await response.text(), taskId);
  while (Date.now() < deadline) {
    const timeout = Math.max(1, deadline - Date.now());
    const progress = await json(client, API, `${KB_PATH}/progress`, { timeout });
    const list = await json(client, API, `${PREFIX}/list`, { timeout: Math.max(1, deadline - Date.now()) });
    const kb = list.find((item) => item.name === KB);
    if (isReadySnapshot(kb, progress, taskId, terminal)) return kb;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Knowledge indexing did not finish within 120 seconds");
}

async function fragments(client, marker) {
  return json(client, API, `${KB_PATH}/index-fragments`, { method: "POST", data: { query: marker, top_k: 5 } });
}

function hasSource(report, marker, filename) {
  assert(report.fragment_count > 0, "Real retrieval returned no fragments");
  assert(report.fragments.some((item) => item.content?.includes(marker) && item.source === filename), "Retrieval did not return the actual uploaded passage and source filename");
}

async function removeOwnedKb(client) {
  assert(/^e2e-keyword-[a-f0-9]{12}$/.test(KB), "Invalid cleanup target");
  const listing = await json(client, API, `${PREFIX}/list`);
  const kb = listing.find((item) => item.name === KB);
  if (!kb) return;
  if (["initializing", "processing", "queued"].includes(kb.status) && kb.progress?.task_id) {
    const taskId = encodeURIComponent(kb.progress.task_id);
    const cancelled = await client.post(`${API}${KB_PATH}/tasks/${taskId}/cancel`, { timeout: 15_000 });
    assert(cancelled.ok() || cancelled.status() === 409, "Could not stop the owned indexing task before cleanup");
  }
  const impact = await json(client, API, `${KB_PATH}/deletion-impact`);
  assert(impact.confirmation_token, "The owned KB has no deletion confirmation token");
  await json(client, API, `${KB_PATH}?confirmation_token=${encodeURIComponent(impact.confirmation_token)}`, { method: "DELETE" });
  const remaining = await json(client, API, `${PREFIX}/list`);
  assert(!remaining.some((item) => item.name === KB), "Owned KB remained after confirmed deletion");
}

async function main() {
  const apiUrl = isolatedOrigin(API, "API_URL");
  isolatedOrigin(BASE, "BASE_URL");
  const client = await request.newContext({ extraHTTPHeaders: { "X-Requested-With": "XMLHttpRequest" } });
  let browser;
  let originalProfile;
  let ownsKb = false;
  let profileChanged = false;
  const errors = [];
  try {
    // Read-only guards precede every test mutation. Check the proxy backend so
    // a test frontend accidentally pointing to the live backend cannot write it.
    for (const origin of [API, BASE]) {
      const topology = await json(client, origin, "/api/v1/settings/network");
      assert.equal(new URL(topology.effective.backend_url).port, apiUrl.port, "The frontend proxy/backend port does not match the isolated API_URL");
      assertNoCredentials(await json(client, origin, "/api/v1/settings"));
    }
    const original = await json(client, API, CONFIG);
    originalProfile = original.retrieval_profile;
    assert(["keyword", "hybrid", "vector"].includes(originalProfile), "Unexpected retrieval profile");
    await json(client, API, CONFIG, { method: "PUT", data: { retrieval_profile: "vector" } });
    profileChanged = true;

    const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {};
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext();
    await context.addCookies([{ name: "cognivoy-lang", value: "en", url: BASE }]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("cognivoy-language", "en");
      localStorage.setItem("cognivoy-response-language", "en");
    });
    await page.goto(`${BASE}/settings/embedding`, { waitUntil: "domcontentloaded" });
    const mode = page.locator("#retrieval-profile");
    await mode.waitFor();
    await page.waitForFunction(() => document.querySelector("#retrieval-profile")?.value === "vector");
    await mode.selectOption("keyword");
    const savedResponse = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === CONFIG);
    await page.locator('section[aria-labelledby="retrieval-mode-heading"]').getByRole("button", { name: "Save", exact: true }).click();
    assert((await savedResponse).ok(), "Browser retrieval profile save failed");
    const activeMessage = "Model-free retrieval is active. Embedding settings below are optional for vector modes.";
    await page.getByText(activeMessage, { exact: true }).waitFor();
    assert.equal((await json(client, API, CONFIG)).retrieval_profile, "keyword", "Browser save did not reach the isolated backend");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(activeMessage, { exact: true }).waitFor();
    assert.equal(await mode.inputValue(), "keyword", "Keyword retrieval did not survive page reload");
    assertNoCredentials(await json(client, API, "/api/v1/settings"));

    const before = await json(client, API, `${PREFIX}/list`);
    assert(!before.some((item) => item.name === KB), "Synthetic test KB name already exists");
    ownsKb = true;
    const created = await json(client, API, `${PREFIX}/create`, { method: "POST", multipart: {
      name: KB, rag_provider: "llamaindex",
      files: { name: FIRST_FILE, mimeType: "text/plain", buffer: Buffer.from(originalText) },
    } });
    assert(created.task_id, "Knowledge creation did not start an indexing task");
    const kb = await waitReady(client, created.task_id);
    hasSource(await fragments(client, FIRST), FIRST, FIRST_FILE);
    const rag = await json(client, API, "/api/v1/plugins/tools/rag/execute", { method: "POST", data: { params: { query: FIRST, kb_name: KB } } });
    assert.equal(rag.success, true, "The actual RAG tool reported failure");
    assert(rag.sources?.some((source) => source.source === FIRST_FILE && source.content?.includes(FIRST)), "RAG citations are missing or merely echo the query");

    // Inspect the actual retrieved passage in the browser and open its citation.
    await page.goto(`${BASE}/knowledge?kb=${encodeURIComponent(kb.id || KB)}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Keyword text index", exact: true }).waitFor();
    await page.getByTestId("knowledge-keyword-index-status").getByText("Keyword index is ready", { exact: true }).waitFor();
    assert.equal(await page.getByText("No index versions yet.", { exact: true }).count(), 0, "Zero vector versions must not imply the keyword index is missing");
    assert.equal(await page.getByTestId("knowledge-stored-vector-indexes").count(), 0, "Fresh model-free KB unexpectedly has vector index history");
    const workbench = page.getByTestId("knowledge-index-fragments");
    await workbench.getByRole("textbox").fill(FIRST);
    const inspectedResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/index-fragments"));
    await workbench.getByRole("button", { name: "Inspect", exact: true }).click();
    const actualFragments = await inspectedResponse;
    assert(actualFragments.ok(), "Browser real retrieval request failed");
    hasSource(await actualFragments.json(), FIRST, FIRST_FILE);
    await workbench.getByTestId("knowledge-fragment-open-source").first().click();
    const preview = page.getByRole("dialog", { name: `File preview: ${FIRST_FILE}` });
    await preview.waitFor();
    await preview.getByText(new RegExp(FIRST)).first().waitFor();
    await preview.getByRole("button", { name: "Close", exact: true }).click();

    const added = await json(client, API, `${KB_PATH}/upload`, { method: "POST", multipart: {
      files: { name: SECOND_FILE, mimeType: "text/plain", buffer: Buffer.from(incrementalText) },
    } });
    await waitReady(client, added.task_id);
    hasSource(await fragments(client, SECOND), SECOND, SECOND_FILE);
    hasSource(await fragments(client, FIRST), FIRST, FIRST_FILE);

    // Deletion of indexed source files requires the documented rebuild; prove
    // that rebuild also works without embedding config and removes stale hits.
    await json(client, API, `${KB_PATH}/files/${encodeURIComponent(SECOND_FILE)}`, { method: "DELETE" });
    const rebuilt = await json(client, API, `${KB_PATH}/reindex`, { method: "POST" });
    assert(!rebuilt.noop && rebuilt.task_id, "Keyword rebuild unexpectedly skipped changed sources");
    await waitReady(client, rebuilt.task_id);
    assert.equal((await fragments(client, SECOND)).fragment_count, 0, "Deleted source remains retrievable after rebuild");
    hasSource(await fragments(client, FIRST), FIRST, FIRST_FILE);
    assertNoCredentials(await json(client, API, "/api/v1/settings"));
    assert.equal(errors.length, 0, `Browser runtime errors: ${errors.join(" | ")}`);

    const evidenceDir = path.join(__dirname, "..", "test-results", "keyword-retrieval");
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDir, `${KB}.png`), fullPage: true });
  } finally {
    const cleanupErrors = [];
    if (ownsKb) {
      try { await removeOwnedKb(client); }
      catch (error) { cleanupErrors.push(`Owned KB cleanup failed (${KB}): ${error.message}`); }
    }
    if (profileChanged) {
      try { await json(client, API, CONFIG, { method: "PUT", data: { retrieval_profile: originalProfile } }); }
      catch (error) { cleanupErrors.push(`Retrieval-profile restoration failed: ${error.message}`); }
    }
    if (browser) await browser.close();
    await client.dispose();
    assert.equal(cleanupErrors.length, 0, cleanupErrors.join(" | "));
    if (ownsKb) console.log(`CLEANUP confirmed: removed only ${KB}; restored the original retrieval profile`);
  }
  console.log("PASS credential-free keyword retrieval: UI save + reload → TXT upload → indexing → actual RAG → source preview → incremental indexing → source deletion + rebuild");
}

module.exports = { assertTaskComplete, isReadySnapshot };

if (require.main === module) {
  main().catch((error) => {
    console.error("FAIL real keyword retrieval:", error.message);
    process.exitCode = 1;
  });
}
