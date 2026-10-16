/* Browser contract for saving an answer without an existing notebook.
 *
 * BASE_URL=http://127.0.0.1:3783 node scripts/e2e-notebook-save.cjs
 * Uses synthetic sessions and in-memory notebook API fixtures. Every HTTP
 * mutation and application WebSocket is intercepted at context level, including popups;
 * no notebook, record, settings, or telemetry reaches the running backend.
 * This is a UI/API contract test, not a persistence or real-backend test.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect: playwrightExpect } = require("@playwright/test");
const expect = playwrightExpect.configure({ timeout: 20_000 });

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3783").replace(/\/$/, "");
const origin = new URL(BASE);
assert(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Only a local frontend is supported");
assert(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password, "Use a plain HTTP(S) origin");
assert.equal(origin.pathname, "/", "BASE_URL must not contain a path");
assert(!origin.search && !origin.hash, "BASE_URL must not contain a query or fragment");
const OUTPUT = path.resolve(__dirname, "../test-results/notebook-save");
const QUERY = "How should I organize my reusable learning notes?";
const ANSWER = "# Notebook acceptance fixture\n\nKeep this complete answer, including **formatting** and its source context.\n\n- Audit evidence\n- Review cadence";
const translations = {
  en: require("../locales/en/app.json"),
  zh: require("../locales/zh/app.json"),
};

function fixtureSession(id) {
  return {
    id, session_id: id, title: id, status: "completed",
    preferences: { capability: "deep_solve" }, active_turns: [],
    messages: [
      { id: 1, role: "user", content: QUERY, capability: "deep_solve", parent_message_id: null },
      {
        id: 2, role: "assistant", content: ANSWER, capability: "deep_solve", parent_message_id: 1,
        events: [{ type: "result", source: "deep_solve", stage: "writing", content: "", timestamp: 1, metadata: {} }],
      },
    ],
  };
}

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function notebook(id, name = id) {
  return { id, name, description: "Synthetic acceptance fixture", record_count: 0, created_at: 1, updated_at: 1 };
}

async function createHarness(browser, language, scenario, initial = []) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await context.addCookies([{ name: "cognivoy-lang", value: language, url: BASE }]);
  await context.addInitScript((locale) => {
    localStorage.setItem("cognivoy-language", locale);
    localStorage.setItem("cognivoy.sidebarCollapsed", "0");
  }, language);
  const state = {
    notebooks: [...initial], listFailure: false, createFailure: false, saveFailure: false,
    lists: 0, creates: [], saves: [], unexpectedWrites: [], errors: [], sessionReads: [], diagnostics: [],
    createGate: null, saveGate: null,
  };
  const sessionId = `e2e-notebook-save-${language}-${scenario}`;
  // Guard ALL requests, not only notebook URLs: no background preference save,
  // telemetry, unrelated form, or new-tab request may mutate the real service.
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname;
    const method = request.method();
    if (endpoint.startsWith("/api/v1/sessions/")) state.sessionReads.push(`${method} ${endpoint}`);
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    // Keep this browser-only fixture independent from the local deployment's
    // authentication, active LLM and voice settings.
    if (url.origin === origin.origin && method === "GET" && endpoint === "/api/v1/auth/status") {
      return json({ enabled: false, authenticated: true, is_admin: false, username: "notebook-save-fixture" });
    }
    if (url.origin === origin.origin && method === "GET" && endpoint === "/api/v1/settings") {
      return json({ catalog: {}, ui: { voice_autoplay: false } });
    }
    if (url.origin === origin.origin && method === "GET" && endpoint === "/api/v1/settings/llm-options") {
      return json({
        active: { profile_id: "fixture-profile", model_id: "fixture-model" },
        options: [{ profile_id: "fixture-profile", model_id: "fixture-model", profile_name: "Synthetic", model_name: "No model calls", model: "fixture", provider: "openai", context_window: 1_000_000, is_active_default: true }],
      });
    }
    if (url.origin === origin.origin && method === "GET" && endpoint === "/api/v1/sessions") {
      return json({ sessions: [], total: 0 });
    }
    if (url.origin === origin.origin && method === "GET" && endpoint === `/api/v1/sessions/${sessionId}`) {
      return json(fixtureSession(sessionId));
    }
    if (url.origin === origin.origin && method === "GET" && endpoint === "/api/v1/notebook/list") {
      state.lists += 1;
      return state.listFailure ? json({ detail: "Synthetic list failure" }, 503) : json({ notebooks: state.notebooks });
    }
    if (url.origin === origin.origin && method === "POST" && endpoint === "/api/v1/notebook/create") {
      const payload = request.postDataJSON();
      state.creates.push(payload);
      if (state.createGate) await state.createGate.promise;
      if (state.createFailure) return json({ detail: "Synthetic create failure" }, 503);
      const created = { ...notebook(`fixture-created-${state.creates.length}`, payload.name), description: payload.description };
      state.notebooks.push(created);
      return json({ notebook: created });
    }
    if (url.origin === origin.origin && method === "POST" && endpoint === "/api/v1/notebook/add_record") {
      const payload = request.postDataJSON();
      state.saves.push(payload);
      if (state.saveGate) await state.saveGate.promise;
      if (state.saveFailure) return json({ detail: "Synthetic save failure" }, 503);
      return json({ record: { id: `fixture-record-${state.saves.length}`, ...payload, type: payload.record_type } });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (url.origin === origin.origin && endpoint === "/api/v1/system/slo/events" && method === "POST") {
        return json({ success: true });
      }
      state.unexpectedWrites.push(`${method} ${endpoint}`);
      return json({ detail: "This acceptance test blocks all unmocked writes" }, 409);
    }
    return route.continue();
  });
  // Leave Next's development HMR transport alone; only application sockets
  // can execute turns or mutate product state.
  await context.routeWebSocket((url) => url.pathname.startsWith("/ws/") || url.pathname.startsWith("/api/"), (socket) => socket.close());
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => state.errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") state.diagnostics.push(message.text()); });
  page.on("requestfailed", (request) => state.diagnostics.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  const t = (key) => {
    const value = translations[language][key];
    assert.equal(typeof value, "string", `Missing ${language} translation: ${key}`);
    return value;
  };
  await page.goto(`${BASE}/home/${sessionId}`, { waitUntil: "domcontentloaded" });
  const actions = page.getByTestId("deep-solve-actions");
  try { await expect(actions).toBeVisible(); } catch (error) {
    console.error("Fixture session failed to render", { url: page.url(), sessionReads: state.sessionReads, errors: state.errors, diagnostics: state.diagnostics, writes: state.unexpectedWrites });
    await context.close();
    throw error;
  }
  const sidebarLink = page.locator("aside").getByRole("link", { name: t("Notebooks"), exact: true });
  await expect(sidebarLink).toBeVisible();
  await expect(sidebarLink).toHaveAttribute("href", "/notebook");

  async function open() {
    await actions.getByRole("button", { name: t("Save to notebook"), exact: true }).click();
    const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: t("Save to notebook"), exact: true }) });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(t("Title"), { exact: true })).toHaveValue(QUERY);
    const manage = dialog.getByRole("link", { name: new RegExp(t("Manage notebooks")) });
    await expect(manage).toHaveAttribute("href", "/notebook");
    await expect(manage).toHaveAttribute("target", "_blank");
    const rel = (await manage.getAttribute("rel")).split(/\s+/);
    assert(rel.includes("noopener") && rel.includes("noreferrer"), "Management link lacks opener/referrer protection");
    return dialog;
  }
  async function finish() {
    state.createGate?.release();
    state.saveGate?.release();
    await context.close();
    assert.deepEqual(state.unexpectedWrites, [], "An unexpected write was safely blocked; add an explicit fixture or fix the UI");
    assert.deepEqual(state.errors, [], "Unexpected browser runtime errors");
  }
  return { page, context, state, t, open, finish, sessionId };
}

function controls(dialog, t) {
  return {
    title: dialog.getByLabel(t("Title"), { exact: true }),
    select: dialog.getByRole("combobox", { name: t("Notebook"), exact: true }),
    save: dialog.getByRole("button", { name: t("Save"), exact: true }),
    create: dialog.getByRole("button", { name: t("Create and select"), exact: true }),
    newNotebook: dialog.getByRole("button", { name: t("New notebook"), exact: true }),
    refresh: dialog.getByRole("button", { name: t("Refresh notebooks"), exact: true }),
    name: dialog.getByLabel(t("Notebook name"), { exact: true }),
    description: dialog.getByRole("textbox", { name: t("Description (optional)"), exact: true }),
  };
}

async function assertViewport(dialog, page) {
  const dimensions = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, client: element.clientWidth, scroll: element.scrollWidth, width: innerWidth, height: innerHeight };
  });
  assert(dimensions.left >= 0 && dimensions.right <= dimensions.width + 1, "Dialog overflows the narrow viewport horizontally");
  assert(dimensions.top >= -1 && dimensions.bottom <= dimensions.height + 1, "Dialog is clipped outside the narrow viewport vertically");
  assert(dimensions.scroll <= dimensions.client + 1, "Dialog contents overflow horizontally");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Page has horizontal overflow");
}

function assertSaved(payload, id, title) {
  assert.deepEqual(payload.notebook_ids, [id], "Saved into the wrong notebook");
  assert.equal(payload.title, title, "Edited title was lost");
  assert.equal(payload.output, ANSWER, "Answer content/formatting was lost");
  assert.equal(payload.user_query, QUERY, "Original question was lost");
  assert.equal(payload.record_type, "chat");
  assert.equal(payload.idempotency_key, "chat-message:2");
  assert.deepEqual(payload.references, [{ type: "message", id: "2" }]);
  assert(payload.summary, "Saving must include a summary so it does not require an LLM");
}

async function emptyAndCreate(browser, language) {
  const h = await createHarness(browser, language, "empty");
  const { page, state, t } = h;
  try {
    const dialog = await h.open();
    const c = controls(dialog, t);
    await expect(dialog.getByRole("status")).toContainText(t("No notebooks yet"));
    await expect(c.save).toBeDisabled();
    const editedTitle = `${language}: retained title after creating a notebook`;
    await c.title.fill(editedTitle);
    await c.newNotebook.click();
    await expect(c.name).toBeFocused();
    await expect(c.create).toBeDisabled();
    await c.name.fill("   ");
    await expect(c.create).toBeDisabled();
    assert.equal(state.creates.length, 0, "Blank name sent a create request");
    await c.name.fill("  CISA learning notes  ");
    await c.description.fill("  My reusable audit evidence  ");
    await expect(c.save).toBeDisabled();
    await page.setViewportSize({ width: 375, height: 667 });
    await c.create.scrollIntoViewIfNeeded();
    await assertViewport(dialog, page);
    fs.mkdirSync(OUTPUT, { recursive: true });
    await page.screenshot({ path: path.join(OUTPUT, `${language}-inline-create-mobile.png`) });

    state.createFailure = true;
    state.createGate = gate();
    // Same-tick activation exercises the synchronous in-flight guard, not
    // only the disabled button after React commits its next render.
    await c.create.evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.creates.length).toBe(1);
    await expect(c.create).toBeDisabled();
    await expect(c.name).toBeDisabled();
    await expect(c.save).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    state.createGate.release();
    await expect(dialog.getByRole("alert")).toContainText(t("Failed to create notebook"));
    await expect(c.name).toHaveValue("  CISA learning notes  ");
    await expect(c.description).toHaveValue("  My reusable audit evidence  ");
    await expect(c.title).toHaveValue(editedTitle);
    assert.equal(state.creates.length, 1, "Create failure was silently retried");

    state.createFailure = false;
    state.createGate = null;
    await c.create.click();
    await expect(c.name).toHaveCount(0);
    await expect(c.select).toHaveValue("fixture-created-2");
    await expect(c.select).toBeFocused();
    await expect(c.title).toHaveValue(editedTitle);
    assert.equal(state.creates.length, 2);
    assert.equal(state.creates[1].name, "CISA learning notes");
    assert.equal(state.creates[1].description, "My reusable audit evidence");

    state.saveFailure = true;
    state.saveGate = gate();
    await c.save.evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => state.saves.length).toBe(1);
    await expect(c.save).toBeDisabled();
    await expect(c.newNotebook).toBeDisabled();
    await expect(c.title).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    state.saveGate.release();
    await expect(c.save).toBeEnabled();
    await expect(c.title).toHaveValue(editedTitle);
    await expect(c.select).toHaveValue("fixture-created-2");
    assert.equal(state.saves.length, 1, "Save failure was silently retried");
    state.saveFailure = false;
    state.saveGate = null;
    await c.save.click();
    await expect(dialog).toHaveCount(0);
    assert.equal(state.saves.length, 2);
    for (const payload of state.saves) assertSaved(payload, "fixture-created-2", editedTitle);
    console.log(`PASS ${language}: empty → inline create → failure/retry → automatic selection → save failure/retry; narrow screen and duplicate guards`);
  } finally { await h.finish(); }
}

async function listRecoveryAndRefresh(browser, language) {
  const h = await createHarness(browser, language, "list-recovery");
  const { state, t, page } = h;
  try {
    state.listFailure = true;
    const dialog = await h.open();
    const c = controls(dialog, t);
    await expect(dialog.getByRole("alert")).toContainText(t("Failed to load notebooks"));
    await expect(dialog.getByText(t("No notebooks yet"), { exact: false })).toHaveCount(0);
    await expect(c.save).toBeDisabled();
    const editedTitle = `${language}: keep title while refreshing notebook list`;
    await c.title.fill(editedTitle);
    state.listFailure = false;
    state.notebooks = [notebook("fixture-existing", "Existing notebook")];
    const previousLists = state.lists;
    await dialog.getByRole("button", { name: t("Retry"), exact: true }).click();
    await expect(c.select.getByRole("option", { name: "Existing notebook", exact: true })).toHaveCount(1);
    assert(state.lists > previousLists, "Retry did not reload the list");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await c.select.selectOption("fixture-existing");
    await expect(c.title).toHaveValue(editedTitle);

    // A notebook made in the management tab arrives on explicit Refresh;
    // keep the current answer/title and the original selection if still valid.
    state.notebooks.push(notebook("fixture-from-management", "Created in management"));
    await c.refresh.click();
    await expect(c.select.getByRole("option", { name: "Created in management", exact: true })).toHaveCount(1);
    await expect(c.select).toHaveValue("fixture-existing");
    await expect(c.title).toHaveValue(editedTitle);
    assert.equal(new URL(page.url()).pathname, `/home/${h.sessionId}`, "Refreshing navigated away and risked the answer draft");
    await c.select.selectOption("fixture-from-management");
    await c.save.click();
    await expect(dialog).toHaveCount(0);
    assert.equal(state.creates.length, 0);
    assert.equal(state.saves.length, 1);
    assertSaved(state.saves[0], "fixture-from-management", editedTitle);
    console.log(`PASS ${language}: list failure is not empty → Retry → management refresh → preserved title/selection → save`);
  } finally { await h.finish(); }
}

async function existingAndCancel(browser, language) {
  const h = await createHarness(browser, language, "cancel", [notebook("fixture-existing", "Existing notebook")]);
  const { state, t } = h;
  try {
    let dialog = await h.open();
    let c = controls(dialog, t);
    await expect(c.select).toBeEnabled();
    await expect(c.save).toBeDisabled();
    await c.select.selectOption("fixture-existing");
    await c.title.fill("Retained title during cancelled creation");
    await c.newNotebook.click();
    await c.name.fill("Do not create this notebook");
    await dialog.getByRole("button", { name: t("Cancel creation"), exact: true }).click();
    await expect(c.name).toHaveCount(0);
    await expect(c.title).toHaveValue("Retained title during cancelled creation");
    await expect(c.select).toHaveValue("fixture-existing");
    await expect(c.save).toBeEnabled();
    await dialog.getByRole("button", { name: t("Cancel"), exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(state.creates.length, 0, "Cancel created a notebook");
    assert.equal(state.saves.length, 0, "Cancel saved a record");

    dialog = await h.open();
    c = controls(dialog, t);
    await expect(c.select).toBeEnabled();
    await c.select.selectOption("fixture-existing");
    await c.title.fill("   ");
    await expect(c.save).toBeDisabled();
    await c.title.fill(QUERY);
    // The original selected notebook can disappear in management. A refresh
    // must clear stale selection instead of saving into a removed ID.
    state.notebooks = [];
    await c.refresh.click();
    await expect(c.select).toHaveValue("");
    await expect(c.save).toBeDisabled();
    await expect(c.title).toHaveValue(QUERY);
    await dialog.getByRole("button", { name: t("Cancel"), exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(state.creates.length + state.saves.length, 0);
    console.log(`PASS ${language}: existing notebook → cancel creation preserves selection/title → cancel writes nothing → refresh removes stale selection`);
  } finally { await h.finish(); }
}

async function main() {
  const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {};
  const browser = await chromium.launch(launchOptions);
  try {
    for (const language of ["en", "zh"]) {
      await emptyAndCreate(browser, language);
      await listRecoveryAndRefresh(browser, language);
      await existingAndCancel(browser, language);
    }
    console.log("PASS notebook save: 6 bilingual browser journeys; every write mocked, no production notebook data changed");
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
