/* Fullscreen viewport, keyboard and sandbox regression. All browser business
 * API/WS traffic is mocked, including writes. No model calls or persisted changes.
 * BASE_URL=http://127.0.0.1:3795 node scripts/e2e-visualize-fullscreen.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect: playwrightExpect } = require("@playwright/test");
const expect = playwrightExpect.configure({ timeout: 20_000 });
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3795").replace(/\/$/, "");
const origin = new URL(BASE);
assert(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Only test a local frontend");
assert(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password, "Use a credential-free HTTP(S) origin");
assert(origin.pathname === "/" && !origin.search && !origin.hash, "Use a plain local origin");
const OUTPUT = path.resolve(__dirname, "../test-results/visualize-fullscreen");
fs.mkdirSync(OUTPUT, { recursive: true });

const fixtures = {
  html: { render_type: "html", code: { content: '<!DOCTYPE html><html><body><h1>Interactive diagram</h1><svg viewBox="0 0 800 160" style="width:100%;max-height:160px"><circle cx="400" cy="80" r="60" fill="teal"/></svg><button id="step" onclick="document.getElementById(\'state\').textContent=\'advanced\'">Advance</button><output id="state">initial</output><label>Timeline<input type="range" min="0" max="90" value="0"></label></body></html>' } },
  svg: { render_type: "svg", code: { content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 240"><rect width="800" height="240" fill="teal"/><text x="20" y="120">Diagram</text></svg>' } },
  chartjs: { render_type: "chartjs", code: { content: '{"type":"bar","data":{"labels":["Learn","Review"],"datasets":[{"label":"Steps","data":[2,3]}]},"options":{"animation":false}}' } },
  mermaid: { render_type: "mermaid", code: { content: "graph LR\nA[Learn] --> B[Review]" } },
};

function session(type) {
  const id = `e2e-visualize-fullscreen-${type}`;
  return { id, session_id: id, title: id, status: "completed", active_turns: [], preferences: { capability: "visualize", tools: [], knowledge_bases: [] }, messages: [
    { id: 1, role: "user", content: "Show an interactive diagram", capability: "visualize", parent_message_id: null },
    { id: 2, role: "assistant", content: "Visualization result", capability: "visualize", parent_message_id: 1, events: [{ type: "result", content: "", metadata: fixtures[type], source: "visualize", stage: "reviewing", timestamp: 1, turn_id: `${id}-turn` }] },
  ] };
}

async function assertViewportDialog(page) {
  const dialog = page.getByTestId("visualization-fullscreen");
  await expect(dialog).toBeVisible();
  const dimensions = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, bodyPortal: element.parentElement === document.body, modal: element.matches(":modal") };
  });
  assert(dimensions.bodyPortal && dimensions.modal, "Fullscreen must live in the body and modal top layer");
  assert(Math.abs(dimensions.x) <= 1 && Math.abs(dimensions.y) <= 1, "Fullscreen origin is clipped by its chat ancestor");
  assert(Math.abs(dimensions.width - dimensions.viewportWidth) <= 1, "Fullscreen width is constrained by its chat ancestor");
  assert(Math.abs(dimensions.height - dimensions.viewportHeight) <= 1, "Fullscreen height does not match the viewport");
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  return { dialog, dimensions };
}

(async () => {
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const writes = [], starts = [], errors = [], results = [], apiPaths = [];
  await context.addCookies([{ name: "cognivoy-lang", value: "en", url: BASE }]);
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("cognivoy-language", "en");
    if ("serviceWorker" in navigator) navigator.serviceWorker.register = () => Promise.reject(new Error("Disabled in isolated browser test"));
  });
  await context.route("**/*", (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) apiPaths.push(url.pathname);
    const json = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== origin.origin) return route.abort();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) { writes.push(`${request.method()} ${url.pathname}`); return json({ success: true }); }
    const match = url.pathname.match(/^\/api\/v1\/sessions\/e2e-visualize-fullscreen-(html|svg|chartjs|mermaid)$/);
    if (match) return json(session(match[1]));
    if (url.pathname === "/api/v1/sessions") return json({ sessions: [], total: 0 });
    if (url.pathname === "/api/v1/auth/status") return json({ enabled: false, authenticated: true, is_admin: false, username: "fullscreen-fixture" });
    if (url.pathname === "/api/v1/settings") return json({ catalog: {}, ui: { voice_autoplay: false } });
    if (url.pathname === "/api/v1/settings/llm-options") return json({ active: { profile_id: "fixture", model_id: "fixture" }, options: [{ profile_id: "fixture", model_id: "fixture", profile_name: "Fixture", model_name: "No model calls", model: "fixture", provider: "openai", is_active_default: true }] });
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return json({});
    return route.continue();
  });
  // Next's dev client waits for its HMR socket before hydration. Permit only
  // that local framework transport; every application socket stays mocked.
  await context.routeWebSocket((url) => !(url.host === origin.host && url.pathname === "/_next/hmr"), (socket) => socket.onMessage((raw) => {
    let message; try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    if (["start_turn", "message", "regenerate"].includes(message.type)) starts.push(message.type);
  }));
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    for (const type of ["html", "svg", "chartjs", "mermaid"]) {
      await page.goto(`${BASE}/home/e2e-visualize-fullscreen-${type}`, { waitUntil: "domcontentloaded" });
      const viewer = page.locator(`[data-visualization-viewer="${type}"]`);
      const opener = viewer.getByRole("button", { name: "Fullscreen", exact: true });
      await expect(opener).toBeVisible();
      const graphicalSelector = type === "html" ? "iframe" : type === "chartjs" ? "canvas" : "svg:not(.lucide)";
      await expect(viewer.locator(`[data-visualization-canvas] ${graphicalSelector}`)).toBeVisible();
      // Force both a transform and clipping to preserve the exact root cause,
      // even if future chat styling removes the current scale(1) ancestor.
      await viewer.evaluate((element) => { element.style.transform = "translateZ(0)"; element.style.overflow = "hidden"; });
      const previousOverflow = await page.evaluate(() => { document.body.style.overflow = "clip"; return document.body.style.overflow; });
      await opener.click();
      const { dialog, dimensions } = await assertViewportDialog(page);
      await expect(dialog.locator(graphicalSelector)).toBeVisible();
      if (type === "html") {
        const iframe = dialog.locator("iframe");
        await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
        const frameSize = await iframe.boundingBox();
        assert(frameSize.width > dimensions.viewportWidth * 0.9, "HTML preview does not fill the fullscreen width");
        const content = dialog.frameLocator("iframe");
        await content.getByRole("button", { name: "Advance", exact: true }).click();
        await expect(content.locator("#state")).toHaveText("advanced");
        await page.screenshot({ path: path.join(OUTPUT, "desktop-html-fullscreen.png") });
        // Cross-origin iframe key events do not bubble to document. The scoped
        // bridge must still close when Escape is pressed inside.
        await content.getByRole("button", { name: "Advance", exact: true }).press("Escape");
      } else {
        await page.keyboard.press("Tab");
        // Scrollable diagrams are keyboard-focusable in current Chromium.
        // Focus may enter that viewport, but must not reach the inert chat.
        await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
        await page.keyboard.press("Escape");
      }
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      assert.equal(await page.evaluate(() => document.body.style.overflow), previousOverflow, "Closing must restore the prior scroll style");
      // Reopen then use the explicit Close action, checking repeat lifecycle.
      await opener.click();
      await page.getByTestId("visualization-fullscreen").getByRole("button", { name: "Close", exact: true }).click();
      await expect(opener).toBeFocused();
      assert.equal(await page.evaluate(() => document.body.style.overflow), previousOverflow);
      results.push({ type, dimensions, keyboardClose: true, focusRestored: true, scrollRestored: true });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/home/e2e-visualize-fullscreen-html`, { waitUntil: "domcontentloaded" });
    const opener = page.locator('[data-visualization-viewer="html"]').getByRole("button", { name: "Fullscreen", exact: true });
    await opener.click();
    const { dialog, dimensions } = await assertViewportDialog(page);
    await expect(dialog.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
    await expect(dialog.frameLocator("iframe").getByRole("button", { name: "Advance", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(OUTPUT, "mobile-html-fullscreen.png") });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(opener).toBeFocused();
    results.push({ type: "html-mobile", dimensions });
    assert.deepEqual(errors, [], "Browser errors occurred");
    assert.deepEqual(writes, [], "Test must not persist writes");
    assert.deepEqual(starts, [], "Test must not start model calls");
    const report = { results, browserErrors: errors, writes, modelStarts: starts, screenshotDirectory: OUTPUT };
    fs.writeFileSync(path.join(OUTPUT, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    await page.screenshot({ path: path.join(OUTPUT, "failure-diagnostic.png") });
    console.error(JSON.stringify({ url: page.url(), errors, apiPaths, focused: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 500)) }));
    throw error;
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
