/* Browser-only recovery contract. No model calls or persisted writes.
 * BASE_URL=http://127.0.0.1:3789 node scripts/e2e-visualize-recovery.cjs
 * All HTTP writes and every WebSocket are intercepted; external requests are
 * blocked. Only local frontend assets and read-only shell metadata may load.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect: playwrightExpect } = require("@playwright/test");
const expect = playwrightExpect.configure({ timeout: 20_000 });
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3789").replace(/\/$/, "");
const origin = new URL(BASE);
assert(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Only test a local frontend");
assert(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password, "Use HTTP(S) without credentials");
assert(origin.pathname === "/" && !origin.search && !origin.hash, "Use a plain local origin");
const translations = { en: require("../locales/en/app.json"), zh: require("../locales/zh/app.json") };
const REQUEST = "Show the three learning loops as a diagram";
const OUTPUT = path.resolve(__dirname, "../test-results/visualize-recovery");
fs.mkdirSync(OUTPUT, { recursive: true });

function session(id, metadata, failed = false) {
  const event = failed ? {
    type: "error", content: "Visualization generation failed after two attempts.",
    metadata: { turn_terminal: true, reason: "capability_failed", status: "failed", retryable: true },
  } : { type: "result", content: "", metadata };
  return {
    id, session_id: id, title: id, status: failed ? "failed" : "completed", active_turns: [],
    preferences: { capability: "visualize", tools: [], knowledge_bases: [] },
    messages: [
      { id: 1, role: "user", content: REQUEST, capability: "visualize", parent_message_id: null,
        metadata: { request_snapshot: { content: REQUEST, capability: "visualize", enabledTools: [], knowledgeBases: [], language: "en", config: { render_mode: "auto" } } } },
      { id: 2, role: "assistant", content: failed ? "" : "Visualization result", capability: "visualize", parent_message_id: 1,
        events: [
          ...(id.endsWith("legacy") ? [
            { type: "progress", source: "visualize", stage: "generating", timestamp: 1, content: "Code generated.", metadata: {} },
            { type: "progress", source: "visualize", stage: "reviewing", timestamp: 1, content: "Looks good — passed local checks.", metadata: {} },
            { type: "progress", source: "visualize", stage: "generating", timestamp: 1, content: "Generation took too long; using a safe fallback.", metadata: { trace_kind: "warning" } },
          ] : []),
          { ...event, source: "visualize", stage: failed ? "generating" : "reviewing", timestamp: 1, turn_id: `${id}-turn` },
        ] },
    ],
  };
}

async function run(browser, language) {
  // Playwright's serviceWorkers:block init script accesses navigator.serviceWorker
  // in opaque sandbox iframes and itself raises a SecurityError. A fresh context
  // has no workers; prevent top-level registration without touching opaque frames.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const t = (key) => translations[language][key];
  const starts = [];
  const writes = [];
  const errors = [];
  await context.addCookies([{ name: "cognivoy-lang", value: language, url: BASE }]);
  await context.addInitScript((locale) => {
    if (window !== window.top) return;
    localStorage.setItem("cognivoy-language", locale);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register = () => Promise.reject(new Error("Service workers are disabled in this synthetic browser test"));
    }
  }, language);
  const fixtures = {
    legacy: { render_type: "html", analysis: { description: REQUEST, data_description: "Frontend, review, and maintenance loops." },
      review: { optimized_code: "", changed: false, review_notes: "Passed local validation." },
      code: { language: "html", content: '<!DOCTYPE html><html><body><div class="card"><h1>Learning loops</h1><div class="summary">Text only</div><div class="note"><strong>Note:</strong><br>Generation timed out; showing a safe fallback.</div></div></body></html>' } },
    svg: { render_type: "svg", code: { content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160"><rect x="10" y="10" width="300" height="140" fill="#fff"/><text x="30" y="80">Learning loops</text></svg>' }, generation: { status: "completed", attempts: 2, simplified: true, requested_render_type: "svg" } },
    chartjs: { render_type: "chartjs", code: { content: '{"type":"bar","data":{"labels":["Learn","Review"],"datasets":[{"label":"Steps","data":[2,3]}]},"options":{"animation":false}}' } },
    mermaid: { render_type: "mermaid", code: { content: "graph LR\nA[Learn] --> B[Review]" } },
    html: { render_type: "html", code: { content: '<!DOCTYPE html><html><body><p>Generation timed out; showing a safe fallback.</p><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="20"/></svg></body></html>' } },
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== origin.origin) return route.abort();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`);
      return json({ success: true });
    }
    const match = url.pathname.match(/^\/api\/v1\/sessions\/e2e-visualize-(legacy|svg|chartjs|mermaid|html|failed)$/);
    if (match) return json(session(`e2e-visualize-${match[1]}`, fixtures[match[1]], match[1] === "failed"));
    if (url.pathname === "/api/v1/sessions") return json({ sessions: [], total: 0 });
    if (url.pathname === "/api/v1/auth/status") return json({ enabled: false, authenticated: true, is_admin: false, username: "visualize-fixture" });
    if (url.pathname === "/api/v1/settings") return json({ catalog: {}, ui: { voice_autoplay: false } });
    if (url.pathname === "/api/v1/settings/llm-options") return json({ active: { profile_id: "fixture", model_id: "fixture" }, options: [{ profile_id: "fixture", model_id: "fixture", profile_name: "Synthetic", model_name: "No model calls", model: "fixture", provider: "openai", is_active_default: true }] });
    return route.continue();
  });
  await context.routeWebSocket(() => true, (socket) => {
    socket.onMessage((raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      if (["start_turn", "message", "regenerate"].includes(message.type)) starts.push(message);
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${BASE}/home/e2e-visualize-legacy`, { waitUntil: "domcontentloaded" });
    const failure = page.getByTestId("visualization-generation-failure");
    await expect(failure).toContainText(t("Visualization generation failed"));
    await expect(page.locator("[data-visualization-canvas]")).toHaveCount(0);
    await expect(page.getByTitle(t("HTML visualization"))).toHaveCount(0);
    await page.getByRole("button", { name: t("Learning progress"), exact: true }).click();
    await expect(page.getByText("Code generated.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Looks good — passed local checks.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Generation took too long; using a safe fallback.", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(OUTPUT, `${language}-legacy.png`), fullPage: true });
    await failure.getByRole("button", { name: t("Prepare visualization retry"), exact: true }).click();
    await expect(page.locator("textarea").first()).toHaveValue(new RegExp(REQUEST));
    await expect(page.locator("textarea").first()).toHaveValue(new RegExp(t("Regenerate this visualization as a simpler, readable diagram. Preserve the learning goal and key relationships; do not replace the diagram with a text-only placeholder.").slice(0, 20)));
    assert.equal(starts.length, 0, "Preparing a retry must not start a model call");

    for (const renderType of ["svg", "chartjs", "mermaid", "html"]) {
      await page.goto(`${BASE}/home/e2e-visualize-${renderType}`, { waitUntil: "domcontentloaded" });
      const viewer = page.locator(`[data-visualization-viewer="${renderType}"]`);
      await expect(viewer).toBeVisible();
      await expect(page.getByTestId("visualization-generation-failure")).toHaveCount(0);
      const renderedSelector = renderType === "chartjs" ? "canvas" : renderType === "html" ? "iframe" : "svg";
      await expect(viewer.locator(`[data-visualization-canvas] ${renderedSelector}`)).toHaveCount(1);
      if (renderType === "chartjs") {
        await expect.poll(() => viewer.locator("canvas").evaluate((canvas) => {
          const ctx = canvas.getContext("2d");
          if (!ctx || !canvas.width || !canvas.height) return false;
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
        })).toBe(true);
      } else if (renderType === "html") {
        await expect(viewer.frameLocator("iframe").locator("svg")).toBeVisible();
        await expect(viewer.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      } else {
        await expect(viewer.locator("[data-visualization-canvas] svg")).toBeVisible();
      }
      if (renderType === "svg") {
        await expect(page.getByTestId("visualization-simplified")).toContainText(t("Generated a simplified visualization after retrying."));
        await page.screenshot({ path: path.join(OUTPUT, `${language}-simplified.png`), fullPage: true });
      }
    }

    await page.goto(`${BASE}/home/e2e-visualize-failed`, { waitUntil: "domcontentloaded" });
    const recovery = page.getByTestId("turn-recovery");
    await expect(recovery).toBeVisible();
    await page.screenshot({ path: path.join(OUTPUT, `${language}-failed.png`), fullPage: true });
    await recovery.getByRole("button", { name: t("Retry"), exact: true }).click();
    await expect.poll(() => starts.length).toBe(1);
    assert.equal(starts[0].type, "regenerate", "Normal retry must use the server's original request");
    assert.equal(starts[0].session_id, "e2e-visualize-failed", "Retry targeted the wrong session");
    // Reload the original failed turn to independently verify the quick retry
    // path without synthesizing a fake successful backend turn.
    await page.goto(`${BASE}/home/e2e-visualize-failed`, { waitUntil: "domcontentloaded" });
    const quickRecovery = page.getByTestId("turn-recovery");
    await expect(quickRecovery).toBeVisible();
    await quickRecovery.getByRole("button", { name: t("Retry in faster mode"), exact: true }).click();
    await expect.poll(() => starts.length).toBe(2);
    assert.equal(starts[1].type, "start_turn");
    assert.equal(starts[1].capability, "visualize", "Quick retry changed the learning mode");
    assert.equal(starts[1].content, REQUEST, "Quick retry lost the original request");
    assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`);
    console.log(JSON.stringify({ language, legacyFallbackHidden: true, retryPrefillOnly: true, rendered: ["svg", "chartjs", "mermaid", "html"], failedTurnRetry: true, quickRetry: true, interceptedWrites: writes.length, interceptedModelStarts: starts.length, browserErrors: errors.length, screenshotDirectory: OUTPUT }));
  } catch (error) {
    await page.screenshot({ path: path.join(OUTPUT, `${language}-failure-diagnostic.png`), fullPage: true });
    console.error(JSON.stringify({ language, interceptedMessageTypes: starts.map((message) => message.type), writes, errors }));
    throw error;
  } finally {
    await page.close();
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  try { for (const language of ["zh", "en"]) await run(browser, language); }
  finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
