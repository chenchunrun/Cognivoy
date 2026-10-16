/* Streaming scroll regression (browser-only, no model or persisted data).
 *
 * BASE_URL=http://127.0.0.1:3783 node scripts/e2e-stream-scroll.cjs
 * Every application WebSocket and HTTP write is intercepted. The synthetic
 * transcript is supplied by this script; requests to other origins are blocked.
 * Frame measurements are observational: this test does not replace, suppress,
 * or repair the application's scrolling behavior.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect: playwrightExpect } = require("@playwright/test");
const expect = playwrightExpect.configure({ timeout: 20_000 });

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3783").replace(/\/$/, "");
const origin = new URL(BASE);
assert(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Use a local frontend only");
assert(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password, "Use a plain HTTP(S) origin");
assert.equal(origin.pathname, "/", "BASE_URL must not contain a path");
assert(!origin.search && !origin.hash, "BASE_URL must not contain a query or fragment");
const OUTPUT = path.resolve(__dirname, "../test-results/stream-scroll");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BUDGET = { window: 1_000_000, window_estimated: false, used_tokens: 53185, free_tokens: 946815, segments: [] };
const ROUND_BUDGET = { initial: 8, used: 0, limit: 8, maximum: 16, settlement_rounds: 0, phase: "exploring", reason: "" };
const SEED = ("已有说明：`consolidation_pass()` 与 **skills_ast_audit.py** 的职责不同。 Existing evidence remains readable.\n\n").repeat(18);
const translations = { en: require("../locales/en/app.json"), zh: require("../locales/zh/app.json") };

function paragraphs(label, count) {
  return Array.from({ length: count }, (_, i) =>
    `${label}-${i}: 进一步说明 \`consolidation_pass()\` 如何接收信息，并通过 **skills_ast_audit.py** 完成检查。 Preserve every streamed character and its order.\n\n`,
  ).join("");
}

function renderedText(markdown) {
  // This fixture only uses headings, paragraphs, bold and inline code. Compare
  // every resulting character, rather than merely checking the last token.
  return markdown.replace(/^#{1,6}\s+/gm, "").replace(/`|\*\*/g, "").replace(/\s+/g, "");
}

async function run(browser, language) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const sessionId = `e2e-stream-scroll-${language}`;
  const nextSessionId = `e2e-stream-scroll-next-${language}`;
  const nextSessionTitle = `Delayed second session ${language}`;
  const turnId = `synthetic-turn-${language}`;
  const state = { writes: [], socketStarts: 0, errors: [] };
  const t = (key) => translations[language][key];
  await context.addCookies([{ name: "cognivoy-lang", value: language, url: BASE }]);
  await context.addInitScript((locale) => {
    localStorage.setItem("cognivoy-language", locale);
  }, language);
  const session = {
    id: sessionId, session_id: sessionId, title: "Synthetic streaming scroll regression", status: "completed", active_turns: [],
    preferences: { capability: "chat", tools: [], knowledge_bases: [] },
    messages: [
      { id: 1, role: "user", content: "Synthetic scrolling fixture", parent_message_id: null },
      { id: 2, role: "assistant", content: SEED, parent_message_id: 1, capability: "chat", events: [
        { type: "result", source: "chat", stage: "responding", content: "", timestamp: 1, metadata: { context_budget: BUDGET } },
      ] },
    ],
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname;
    const json = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== origin.origin) return route.abort();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.writes.push(`${request.method()} ${endpoint}`);
      return json({ success: true });
    }
    if (endpoint === `/api/v1/sessions/${sessionId}`) return json(session);
    if (endpoint === `/api/v1/sessions/${nextSessionId}`) {
      // The next transcript arrives after the route/session selection changed.
      await wait(300);
      return json({ ...session, id: nextSessionId, session_id: nextSessionId, title: nextSessionTitle, messages: [
        { id: 101, role: "user", content: "Synthetic delayed session", parent_message_id: null },
        { ...session.messages[1], id: 102, parent_message_id: 101, content: `${SEED}\n\nDelayed second session end marker.` },
      ] });
    }
    if (endpoint === "/api/v1/sessions") return json({ sessions: [{ id: nextSessionId, session_id: nextSessionId, title: nextSessionTitle, created_at: 1, updated_at: 1, message_count: 2, last_message: "Synthetic fixture" }], total: 1 });
    if (endpoint === "/api/v1/auth/status") return json({ enabled: false, authenticated: true, is_admin: false, username: "stream-scroll-fixture" });
    // Prevent existing user settings from enabling voice playback or selecting
    // any tools/knowledge bases for this synthetic turn.
    if (endpoint === "/api/v1/settings") return json({ catalog: {}, ui: { voice_autoplay: false } });
    if (endpoint === "/api/v1/settings/llm-options") return json({
      active: { profile_id: "fixture-profile", model_id: "fixture-model" },
      options: [{ profile_id: "fixture-profile", model_id: "fixture-model", profile_name: "Synthetic", model_name: "No model calls", model: "fixture", provider: "openai", context_window: 1_000_000, is_active_default: true }],
    });
    return route.continue();
  });
  let socket;
  let started;
  const startPromise = new Promise((resolve) => { started = resolve; });
  // Do not connect application sockets to the server. Leave Next's development
  // HMR socket alone so this same test supports dev and production builds.
  await context.routeWebSocket((url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/"), (candidate) => {
    candidate.onMessage((raw) => {
      const payload = JSON.parse(String(raw));
      if (payload.type === "ping") candidate.send(JSON.stringify({ type: "pong" }));
      if (payload.type === "start_turn" || payload.type === "message") {
        state.socketStarts += 1;
        socket = candidate;
        started(payload);
      }
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => state.errors.push(error.message));
  let seq = 0;
  let completeAnswer = "";
  const send = (type, content = "", metadata = {}) => {
    socket.send(JSON.stringify({ type, content, metadata, source: "chat", stage: "responding", session_id: sessionId, turn_id: turnId, seq: ++seq, timestamp: Date.now() / 1000 }));
    if (type === "content") completeAnswer += content;
  };
  async function stream(text, interval = 8) {
    const chunks = text.match(/[\s\S]{1,9}/g) || [];
    for (const chunk of chunks) {
      send("content", chunk);
      await wait(interval);
    }
    return chunks.length;
  }
  const bottomGap = () => page.locator("[data-chat-scroll]").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const atBottom = () => expect.poll(bottomGap).toBeLessThanOrEqual(2);
  const scrollTop = () => page.locator("[data-chat-scroll]").evaluate((el) => el.scrollTop);
  async function assertCompleteText() {
    await expect.poll(async () => (await page.locator('[data-chat-message="assistant"]').last().locator(".prose-cognivoy").textContent()).replace(/\s+/g, "")).toBe(renderedText(completeAnswer));
  }
  try {
    await page.goto(`${BASE}/home/${sessionId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("context-budget")).toBeVisible();
    const composer = page.locator("textarea").first();
    await composer.fill("Synthetic stream only — do not call a model");
    await composer.press("Enter");
    let startTimer;
    try {
      await Promise.race([startPromise, new Promise((_, reject) => { startTimer = setTimeout(() => reject(new Error("No intercepted turn start")), 10_000); })]);
    } finally { clearTimeout(startTimer); }
    send("session", "", { session_id: sessionId, turn_id: turnId });
    send("stage_start");
    send("progress", "", { trace_kind: "exploration_budget", exploration_budget: ROUND_BUDGET });
    await expect(page.getByTestId("exploration-budget").last()).toContainText("0 / 8");
    send("content", `# Streaming fixture\n\n${SEED}`);
    await expect(page.locator('[data-chat-message="assistant"]')).toHaveCount(2);
    await assertCompleteText();
    await atBottom();
    // Let initial session restoration and row insertion finish before sampling
    // steady-state output; initial positioning is not streaming jitter.
    await wait(300);
    await page.evaluate(() => {
      const scroller = document.querySelector("[data-chat-scroll]");
      const row = [...document.querySelectorAll('[data-chat-message="assistant"]')].at(-1);
      const toolbar = row.lastElementChild;
      const ancestors = [];
      for (let el = scroller.parentElement; el; el = el.parentElement) ancestors.push(el);
      const initialOuter = ancestors.map((el) => [el.scrollLeft, el.scrollTop]);
      const probe = { frames: [], calls: 0, outerMoved: false, active: true, rowRemoved: false };
      window.__streamScrollProbe = probe;
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) {
        if (this.closest("[data-chat-scroll]")) probe.calls += 1;
        return original.apply(this, args);
      };
      new MutationObserver(() => { if (!row.isConnected) probe.rowRemoved = true; }).observe(scroller, { childList: true, subtree: true });
      function frame(now) {
        if (!probe.active) return;
        probe.frames.push({ at: now, toolbarTop: toolbar.getBoundingClientRect().top, gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight, top: scroller.scrollTop, height: scroller.scrollHeight });
        if (ancestors.some((el, i) => el.scrollLeft !== initialOuter[i][0] || el.scrollTop !== initialOuter[i][1])) probe.outerMoved = true;
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    const chunks = await stream(paragraphs("steady", 28));
    send("progress", "", { trace_kind: "exploration_budget", exploration_budget: { ...ROUND_BUDGET, used: 8, limit: 12, reason: "progress_extension" } });
    await expect(page.getByTestId("exploration-budget").last()).toContainText("8 / 12");
    await assertCompleteText();
    await atBottom();
    await wait(150);
    const metrics = await page.evaluate(() => {
      const probe = window.__streamScrollProbe;
      probe.active = false;
      const steps = probe.frames.slice(1).map((f, i) => Math.abs(f.toolbarTop - probe.frames[i].toolbarTop));
      return { frames: probe.frames.length, scrollIntoViewCalls: probe.calls, outerMoved: probe.outerMoved, rowRemoved: probe.rowRemoved,
        maxToolbarStep: Math.max(0, ...steps), stepsOver2px: steps.filter((step) => step > 2).length,
        maxBottomGap: Math.max(0, ...probe.frames.map((f) => f.gap)),
        contentGrowth: probe.frames.at(-1).height - probe.frames[0].height };
    });
    assert(metrics.frames >= 30, `Insufficient frame samples: ${JSON.stringify(metrics)}`);
    assert(metrics.contentGrowth > 300, "Fixture did not produce enough vertical growth to exercise stream following");
    assert.equal(metrics.scrollIntoViewCalls, 0, "Streaming must target the chat container, not scrollIntoView on its descendants");
    assert.equal(metrics.outerMoved, false, "Streaming scrolled an outer container");
    assert.equal(metrics.rowRemoved, false, "The streaming answer was remounted");
    assert(metrics.maxToolbarStep <= 2, `Visible toolbar jumped during steady streaming: ${JSON.stringify(metrics)}`);
    assert(metrics.maxBottomGap <= 2, `The stream left the bottom between frames: ${JSON.stringify(metrics)}`);

    // A real wheel event, even within the old 80 px bottom threshold, must
    // disengage follow mode before the next streamed content arrives.
    const scrollerBox = await page.locator("[data-chat-scroll]").boundingBox();
    await page.mouse.move(scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + scrollerBox.height / 2);
    const beforeWheel = await scrollTop();
    await page.mouse.wheel(0, -35);
    await expect.poll(async () => beforeWheel - await scrollTop()).toBeGreaterThan(20);
    const readingTop = await scrollTop();
    await stream(paragraphs("reading", 7));
    await assertCompleteText();
    assert(Math.abs(await scrollTop() - readingTop) <= 2, "Streaming pulled the reader back after a small upward scroll");
    const jump = page.getByRole("button", { name: t("Scroll to bottom"), exact: true });
    await expect(jump).toBeVisible();
    await jump.click();
    await atBottom();
    await expect(jump).toHaveCount(0);
    await stream(paragraphs("resumed", 5));
    await assertCompleteText();
    await atBottom();

    // Scrollbar-like movement has no wheel/touch intent event. Change the DOM
    // scroll position while WS packets are already in flight, so queued scroll
    // events cannot let an intervening React commit pull it back to the bottom.
    const movingStream = stream(paragraphs("scrollbar", 7));
    const draggedTop = await page.locator("[data-chat-scroll]").evaluate((el) => {
      el.scrollTop -= 220;
      return el.scrollTop;
    });
    await movingStream;
    await assertCompleteText();
    assert(Math.abs(await scrollTop() - draggedTop) <= 2, "A stream commit overrode scrollbar movement");
    await expect(jump).toBeVisible();
    await jump.click();
    await atBottom();

    // Delayed child layout without a React/WS update: equivalent to an image,
    // formula or visualization resolving after its parent has rendered.
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-chat-message="assistant"]')].at(-1);
      const image = document.createElement("img");
      image.dataset.streamLayoutFixture = "true";
      image.alt = "";
      image.style.display = "block";
      image.style.width = "240px";
      image.style.height = "0px";
      row.querySelector(".prose-cognivoy").append(image);
      setTimeout(() => {
        image.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='200'%3E%3Crect width='240' height='200' fill='gray'/%3E%3C/svg%3E";
        image.style.height = "200px";
      }, 50);
    });
    await expect(page.locator("[data-stream-layout-fixture]")).toHaveCSS("height", "200px");
    await atBottom();
    await page.setViewportSize({ width: 1440, height: 700 });
    await atBottom();
    await page.setViewportSize({ width: 1440, height: 950 });
    await atBottom();
    await page.locator("[data-stream-layout-fixture]").evaluate((el) => el.remove());
    await atBottom();
    await assertCompleteText();

    send("stage_end");
    send("result", "", { metadata: { context_budget: BUDGET, exploration_budget: { ...ROUND_BUDGET, used: 9, limit: 12, phase: "complete", reason: "progress_extension" } } });
    send("done", "", { status: "completed", user_message_id: 3, assistant_message_id: 4 });
    await expect(page.getByRole("button", { name: t("Stop generating"), exact: true })).toHaveCount(0);
    const finishedRow = page.locator('[data-chat-message="assistant"]').last();
    await expect(finishedRow.getByTestId("context-budget")).toBeVisible();
    await expect(finishedRow.getByTestId("exploration-budget")).toContainText("9 / 12");
    await atBottom();
    await assertCompleteText();
    assert.equal(state.socketStarts, 1, "Unexpected extra turn requested");
    assert.deepEqual(state.errors, [], "Browser runtime errors");
    fs.mkdirSync(OUTPUT, { recursive: true });
    await page.screenshot({ path: path.join(OUTPUT, `${language}-completed.png`) });

    // Leaving a session in scrollback must not carry its paused follow state
    // into a different session whose transcript loads asynchronously.
    const completedTop = await scrollTop();
    const finalBox = await page.locator("[data-chat-scroll]").boundingBox();
    await page.mouse.move(finalBox.x + finalBox.width / 2, finalBox.y + finalBox.height / 2);
    await page.mouse.wheel(0, -250);
    await expect.poll(async () => completedTop - await scrollTop()).toBeGreaterThan(100);
    await expect(jump).toBeVisible();
    await page.locator("aside").getByRole("link", { name: new RegExp(nextSessionTitle) }).click();
    await expect(page).toHaveURL(`${BASE}/home/${nextSessionId}`);
    await expect(page.locator('[data-chat-message="assistant"]').last().locator(".prose-cognivoy")).toContainText("Delayed second session end marker.");
    await atBottom();
    await expect(jump).toHaveCount(0);
    assert.deepEqual(state.errors, [], "Browser errors after switching sessions");
    const report = { language, chunks, ...metrics, interceptedWrites: [...new Set(state.writes)], browserErrors: state.errors };
    fs.writeFileSync(path.join(OUTPUT, `${language}-metrics.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PASS ${language}: stable streaming, reader/scrollbar protection, resume, delayed layout, viewport resize, terminal budget, delayed session switch; ${JSON.stringify(report)}`);
  } finally { await context.close(); }
}

async function historyPrepend(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const sessionId = "e2e-stream-scroll-history";
  const errors = [];
  const writes = [];
  const session = {
    id: sessionId, session_id: sessionId, title: "Synthetic history prepend", status: "completed", active_turns: [],
    preferences: { capability: "chat", tools: [], knowledge_bases: [] },
    messages: Array.from({ length: 80 }, (_, index) => ({
      id: index + 1, role: index % 2 === 0 ? "user" : "assistant", capability: "chat",
      parent_message_id: index === 0 ? null : index,
      content: `History marker ${index + 1}: a short synthetic learning note.`, events: [],
    })),
  };
  await context.addCookies([{ name: "cognivoy-lang", value: "en", url: BASE }]);
  await context.addInitScript(() => localStorage.setItem("cognivoy-language", "en"));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname;
    const json = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== origin.origin) return route.abort();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${endpoint}`);
      return json({ success: true });
    }
    if (endpoint === `/api/v1/sessions/${sessionId}`) return json(session);
    if (endpoint === "/api/v1/sessions") return json({ sessions: [], total: 0 });
    if (endpoint === "/api/v1/auth/status") return json({ enabled: false, authenticated: true, is_admin: false, username: "history-prepend-fixture" });
    if (endpoint === "/api/v1/settings") return json({ catalog: {}, ui: { voice_autoplay: false } });
    if (endpoint === "/api/v1/settings/llm-options") return json({ active: null, options: [] });
    return route.continue();
  });
  await context.routeWebSocket((url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/"), (socket) => socket.close());
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${BASE}/home/${sessionId}`, { waitUntil: "domcontentloaded" });
    const messages = page.locator("[data-chat-message]");
    await expect(messages).toHaveCount(20);
    const scroller = page.locator("[data-chat-scroll]");
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2);
    await wait(150);
    const before = await scroller.evaluate((el) => {
      // Set a nonzero position within the automatic history-load threshold.
      // Read the anchor in this same task, before the queued scroll event adds
      // older rows; Playwright must not scroll a locator into view for us.
      el.scrollTop = 40;
      const box = el.getBoundingClientRect();
      const anchor = [...el.querySelectorAll("[data-chat-message]")].find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= box.top + 10 && rect.bottom <= box.bottom;
      });
      if (!anchor) throw new Error("No fully visible history anchor");
      window.__historyScrollAnchor = anchor;
      return { top: el.scrollTop, height: el.scrollHeight, anchorTop: anchor.getBoundingClientRect().top, marker: anchor.textContent };
    });
    assert.equal(before.top, 40, "The fixture did not enter a nonzero scrollback position");
    await expect(messages).toHaveCount(70);
    await expect(page.getByRole("button", { name: "Load 10 earlier messages", exact: true })).toHaveCount(1);
    await wait(150);
    const after = await scroller.evaluate((el) => ({
      top: el.scrollTop, height: el.scrollHeight, gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      anchorTop: window.__historyScrollAnchor.getBoundingClientRect().top,
      anchorConnected: window.__historyScrollAnchor.isConnected,
      marker: window.__historyScrollAnchor.textContent,
    }));
    assert.equal(after.anchorConnected, true, "Prepending remounted the existing visible row");
    assert.equal(after.marker, before.marker, "Prepending changed the visible reading anchor");
    assert(after.height > before.height + 1000, "The test did not prepend a meaningful amount of history");
    assert(Math.abs(after.anchorTop - before.anchorTop) <= 2, `History prepend moved the reading anchor: ${JSON.stringify({ before, after })}`);
    assert(after.gap > 80, "Prepending unexpectedly jumped to the bottom");
    await expect(page.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeVisible();
    assert.deepEqual(errors, [], "History prepend browser errors");
    const report = { initialRows: 20, finalRows: 70, anchorShift: after.anchorTop - before.anchorTop, bottomGap: after.gap, interceptedWrites: [...new Set(writes)], browserErrors: errors };
    fs.mkdirSync(OUTPUT, { recursive: true });
    fs.writeFileSync(path.join(OUTPUT, "en-history-metrics.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PASS en: prepend preserves the reading anchor without jumping to bottom; ${JSON.stringify(report)}`);
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  try {
    for (const language of ["zh", "en"]) await run(browser, language);
    await historyPrepend(browser);
  }
  finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
