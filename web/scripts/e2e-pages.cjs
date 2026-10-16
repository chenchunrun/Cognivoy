/* E2E page-flow tests for the Cognivoy web app.
 * Covers: settings (theme/language), LLM profiles, notebook CRUD, co-writer,
 * book, memory, knowledge (graceful embedding error), space, partners,
 * playground, profile, and a mobile viewport smoke test.
 *
 * Does NOT touch /home chat sending (another agent owns that).
 * Usage: node web/scripts/e2e-pages.cjs
 */
const { chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const SHOTS = path.join(__dirname, "shots");
const RESULTS_DIR = path.join(__dirname, "..", "test-results");
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------------------
// Reporting plumbing
// ---------------------------------------------------------------------------
const results = []; // { flow, status, notes }
const consoleErrors = []; // { flow, kind, message }
const httpFailures = []; // { flow, kind, method, url, status/message }
const fatalFlows = new Set(); // flows with pageerror / React hydration errors
let currentFlow = "(boot)";
let expectingCoWriterConflict = false;

const FATAL_RE =
  /hydrat|did not match|Minified React error|Warning: React|Maximum update depth/i;

function attach(page) {
  page.on("pageerror", (e) => {
    const message = String(e && e.message ? e.message : e).slice(0, 400);
    consoleErrors.push({ flow: currentFlow, kind: "pageerror", message });
    fatalFlows.add(currentFlow);
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const message = msg.text().slice(0, 400);
    if (expectingCoWriterConflict && /status of 409 \(Conflict\)/i.test(message)) return;
    consoleErrors.push({ flow: currentFlow, kind: "console.error", message });
    if (FATAL_RE.test(message)) fatalFlows.add(currentFlow);
  });
  page.on("response", (response) => {
    const url = response.url();
    const status = response.status();
    if (!url.startsWith(BASE) || !new URL(url).pathname.startsWith("/api/") || status < 400) return;
    if (
      expectingCoWriterConflict &&
      status === 409 &&
      new URL(url).pathname.startsWith("/api/v1/co_writer/documents/")
    ) return;
    httpFailures.push({
      flow: currentFlow,
      kind: "http",
      method: response.request().method(),
      url,
      status,
    });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    const message = request.failure()?.errorText || "request failed";
    if (!url.startsWith(BASE) || !new URL(url).pathname.startsWith("/api/") || /ERR_ABORTED/i.test(message)) return;
    httpFailures.push({
      flow: currentFlow,
      kind: "requestfailed",
      method: request.method(),
      url,
      message,
    });
  });
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `page-${name}.png`) });
}

async function runFlow(name, page, fn) {
  currentFlow = name;
  const t0 = Date.now();
  let status = "PASS";
  let notes = "";
  const failureStart = httpFailures.length;
  try {
    notes = (await fn(page)) || "";
  } catch (err) {
    status = "FAIL";
    notes = (err && err.message ? err.message : String(err))
      .split("\n")
      .slice(0, 4)
      .join(" | ")
      .slice(0, 500);
    try {
      await shot(page, `${name}-FAIL`);
    } catch {}
  }
  if (fatalFlows.has(name) && status === "PASS") {
    status = "FAIL";
    notes = `${notes} [fatal console/page error]`.trim();
  }
  const flowHttpFailures = httpFailures.slice(failureStart);
  if (flowHttpFailures.length && status === "PASS") {
    status = "FAIL";
    notes = flowHttpFailures
      .slice(0, 3)
      .map((failure) => `${failure.method} ${new URL(failure.url).pathname} → ${failure.status || failure.message}`)
      .join("; ");
  }
  results.push({ flow: name, status, notes, ms: Date.now() - t0 });
  console.log(
    `${status === "PASS" ? "✅" : "❌"} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${notes ? " — " + notes : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function goto(page, url) {
  await page.goto(BASE + url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
}

async function bodyLen(page) {
  return (await page.locator("body").innerText()).trim().length;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function dialogButton(page, name) {
  const btn = page
    .locator('[role="dialog"]')
    .getByRole("button", { name, exact: true });
  await btn.waitFor({ timeout: 8000 });
  return btn;
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function flowEntryHeaders(page) {
  const routes = [
    "/co-writer",
    "/book",
    "/partners",
    "/playground",
    "/knowledge",
    "/memory",
    "/space",
  ];
  const measurements = [];

  for (const route of routes) {
    await goto(page, route);
    const header = page.getByTestId("page-entry-header");
    const title = page.getByTestId("page-entry-title");
    await header.waitFor({ timeout: 30000 });
    const geometry = await title.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x,
        y: rect.y,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
      };
    });
    const action = page.getByTestId("page-entry-actions");
    if (await action.count()) {
      const actionBox = await action.boundingBox();
      assert(actionBox, `${route}: header action is not visible`);
      assert(
        Math.abs(actionBox.y - geometry.y) <= 4,
        `${route}: header action is not aligned with title (${actionBox.y} vs ${geometry.y})`,
      );
    }
    measurements.push({ route, ...geometry });
  }

  const baseline = measurements[0];
  for (const measurement of measurements.slice(1)) {
    assert(
      Math.abs(measurement.x - baseline.x) <= 1.5,
      `${measurement.route}: title x=${measurement.x}, expected ${baseline.x}`,
    );
    assert(
      Math.abs(measurement.y - baseline.y) <= 1.5,
      `${measurement.route}: title y=${measurement.y}, expected ${baseline.y}`,
    );
    for (const property of [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "lineHeight",
    ]) {
      assert(
        measurement[property] === baseline[property],
        `${measurement.route}: ${property} differs from entry-page baseline`,
      );
    }
  }

  await shot(page, "entry-headers");
  return `${routes.length} entry headers share x/y and typography baselines`;
}

async function flowSettings(page) {
  const subpages = ["chat", "tools", "appearance", "network", "agents"];
  for (const sub of subpages) {
    await goto(page, `/settings/${sub}`);
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .first()
      .waitFor({ timeout: 45000 });
    await page.waitForTimeout(1200);
    const len = await bodyLen(page);
    assert(len > 150, `/settings/${sub} looks blank (body ${len} chars)`);
  }
  await shot(page, "settings");

  // --- theme: Paper -> Ink -> Paper ---
  await goto(page, "/settings/appearance");
  const ink = page.getByRole("radio", { name: /Ink/ });
  await ink.waitFor({ timeout: 15000 });
  await ink.click();
  await page.waitForFunction(
    () => document.documentElement.classList.contains("dark"),
    null,
    { timeout: 5000 },
  );
  const bg = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  const m = bg.match(/(\d+),\s*(\d+),\s*(\d+)/);
  assert(m, `could not parse body background: ${bg}`);
  const lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
  assert(lum < 100, `page did not turn dark (bg ${bg}, luminance ${lum})`);
  await shot(page, "settings-appearance-dark");
  await page.getByRole("radio", { name: /Paper/ }).click();
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("dark"),
    null,
    { timeout: 5000 },
  );

  // --- language: English -> 中文 -> English ---
  await page.getByRole("radio", { name: /Chinese/ }).click();
  await page
    .getByRole("heading", { name: "设置", exact: true })
    .first()
    .waitFor({ timeout: 10000 });
  const zhBody = await page.locator("body").innerText();
  assert(zhBody.includes("外观"), "appearance copy did not switch to Chinese");
  await shot(page, "settings-appearance-zh");
  await page.getByRole("radio", { name: /英语/ }).click();
  await page
    .getByRole("heading", { name: "Settings", exact: true })
    .first()
    .waitFor({ timeout: 10000 });
  return "5 subpages OK; Ink toggles .dark; zh/en switch OK";
}

async function flowLlmSettings(page) {
  await goto(page, "/settings/llm");
  await page.getByRole("heading", { name: "LLM", exact: true }).waitFor({ timeout: 30000 });
  // The preceding language test changes the persisted locale. Navigation can
  // briefly render either bundle while the client and SSR cookie converge, so
  // use the stable interaction contract instead of translated copy: an
  // existing profile is a radio option; an empty catalog exposes Add profile.
  await page.waitForFunction(() => {
    if (document.querySelector('[role="radio"]')) return true;
    return [...document.querySelectorAll("button")].some((button) =>
      /Add profile|添加配置/.test(button.textContent || ""),
    );
  });
  await page.waitForTimeout(800);
  const text = await page.locator("body").innerText();
  const hasProfileRadio = (await page.getByRole("radio").count()) > 0;
  const hasAddProfile = (await page.getByRole("button", { name: /Add profile|添加配置/ }).count()) > 0;
  assert(
    hasProfileRadio || hasAddProfile,
    `LLM profile state is not visible: ${text.slice(-500).replace(/\s+/g, " ")}`,
  );
  await shot(page, "settings-llm");
  const hasActive = /active/i.test(text);
  return `LLM profile state visible; active marker: ${hasActive}`;
}

async function flowNotebook(page) {
  const NB = `E2E Notebook ${Date.now() % 100000}`;
  await goto(page, "/notebook");
  await page
    .getByRole("heading", { name: "Notebooks", exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);

  // create
  await page.getByRole("button", { name: "New notebook" }).first().click();
  await page.getByLabel("Notebook name").fill(NB);
  await (await dialogButton(page, "Create")).click();
  await page.getByText(NB, { exact: true }).first().waitFor({ timeout: 10000 });

  // add a record
  await page
    .getByRole("button", { name: "Add record", exact: true })
    .first()
    .click();
  await page.getByLabel("Title", { exact: true }).fill("E2E record");
  await page.getByLabel("Content", { exact: true }).fill("hello from e2e");
  await (await dialogButton(page, "Add record")).click();
  await page
    .getByText("E2E record", { exact: true })
    .first()
    .waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
  await shot(page, "notebook");

  // cleanup: delete the notebook (it is selected, so the actions button shows)
  await page
    .getByRole("button", { name: "Notebook actions" })
    .first()
    .click({ force: true });
  await page
    .getByRole("menuitem", { name: "Delete" })
    .first()
    .click()
    .catch(async () => {
      await page.getByText("Delete", { exact: true }).last().click();
    });
  await (await dialogButton(page, "Delete")).click();
  await page
    .getByText(NB, { exact: true })
    .first()
    .waitFor({ state: "detached", timeout: 10000 })
    .catch(async () => {
      assert(
        !(await page.getByText(NB, { exact: true }).first().isVisible()),
        "notebook still visible after delete",
      );
    });
  return "create + add record + delete OK";
}

async function flowCoWriter(page) {
  const TITLE = `E2E Doc ${Date.now() % 100000}`;
  const SAVED_TITLE = `${TITLE} Saved`;
  const SAVED_CONTENT =
    "This is an explicitly saved E2E paragraph.\n\nIt verifies title and body persistence after refresh.";
  const TEMPLATE_TITLE = `E2E Template ${Date.now() % 100000}`;
  let savedDocumentRecord = null;
  await page.route("**/api/v1/notebook/list", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ notebooks: [{ id: "e2e-notebook", name: "E2E Notebook", record_count: 0 }] }),
  }));
  await page.route("**/api/v1/notebook/add_record", async (route) => {
    savedDocumentRecord = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ record: { id: "cowriter-record", revision: 1, ...savedDocumentRecord } }),
    });
  });
  await goto(page, "/co-writer");
  await page
    .getByRole("heading", { name: "Co-Writer", exact: true })
    .waitFor({ timeout: 30000 });
  // click with retry — dev-server hydration can swallow the first click
  const newDocBtn = page
    .getByRole("button", { name: "New document" })
    .first();
  const dlgInput = page.locator('[role="dialog"] input').first();
  for (let i = 0; ; i++) {
    await newDocBtn.click();
    try {
      await dlgInput.waitFor({ timeout: 6000 });
      break;
    } catch {
      if (i >= 2) throw new Error("create-document dialog never opened");
    }
  }
  await dlgInput.fill(TITLE);
  await (await dialogButton(page, "Create")).click();
  await page.waitForURL(/\/co-writer\/[^/]+$/, { timeout: 20000 });

  const ta = page.getByLabel("Document content");
  await ta.waitFor({ timeout: 20000 });
  await page.getByLabel("Document title").fill(SAVED_TITLE);
  await ta.fill(SAVED_CONTENT);
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page
    .getByText("Saved", { exact: true })
    .first()
    .waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Document title").waitFor({ timeout: 20000 });
  assert(
    (await page.getByLabel("Document title").inputValue()) === SAVED_TITLE,
    "explicitly saved document title did not survive refresh",
  );
  assert(
    (await page.getByLabel("Document content").inputValue()) === SAVED_CONTENT,
    "explicitly saved document content did not survive refresh",
  );
  await page.getByRole("button", { name: "Split view" }).click();
  const markdownPreview = page.getByRole("region", { name: "Markdown preview" });
  await markdownPreview.waitFor({ timeout: 10000 });
  await markdownPreview
    .getByText(/explicitly saved E2E paragraph/)
    .waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByLabel("Document content").waitFor({ state: "detached", timeout: 5000 });
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await page.getByLabel("Document content").waitFor({ timeout: 5000 });

  const currentUrl = new URL(page.url());
  const currentDocId = currentUrl.pathname.split("/").filter(Boolean).at(-1);
  let operationDecision = null;
  await page.route("**/api/v1/co_writer/history/e2e-edit-op/decision", async (route) => {
    operationDecision = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: "e2e-edit-op", document_id: currentDocId, ...operationDecision }),
    });
  });
  await page.route("**/api/v1/co_writer/history?**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ history: [{
      id: "e2e-edit-op", document_id: currentDocId, timestamp: new Date().toISOString(),
      action: "rewrite", source: "web", model: "e2e-model",
      decision: "accepted", partial: true,
      input: { instruction: "Refine this draft" },
      output: { edited_text: "Improved" },
    }], total: 1 }),
  }));
  await page.evaluate(async (docId) => {
    const current = await fetch(`/api/v1/co_writer/documents/${docId}`).then((response) => response.json());
    localStorage.setItem(
      `cognivoy:co-writer:draft:${encodeURIComponent(docId)}`,
      JSON.stringify({
        version: 1,
        documentId: docId,
        title: current.title,
        content: `${current.content}\n\nRecovered offline draft.`,
        baseRevision: current.revision,
        savedAt: Date.now(),
      }),
    );
  }, currentDocId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Document content").waitFor({ timeout: 20000 });
  assert(
    (await page.getByLabel("Document content").inputValue()).includes("Recovered offline draft."),
    "local recovery draft was not restored after reload",
  );
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByText("Saved", { exact: true }).first().waitFor({ timeout: 10000 });
  const externalRevision = await page.evaluate(async (docId) => {
    const current = await fetch(`/api/v1/co_writer/documents/${docId}`).then((response) => response.json());
    const response = await fetch(`/api/v1/co_writer/documents/${docId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `${current.title} external`, expected_revision: current.revision }),
    });
    if (!response.ok) throw new Error(`external revision setup failed: ${response.status}`);
    return response.json();
  }, currentDocId);
  assert(externalRevision.revision >= 2, "external edit did not advance the document revision");
  await page.getByLabel("Document content").fill(`${SAVED_CONTENT}\n\nLocal conflict draft.`);
  expectingCoWriterConflict = true;
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByText("A newer version exists", { exact: true }).waitFor({ timeout: 10000 });
  expectingCoWriterConflict = false;
  await page.getByRole("button", { name: "Keep my draft", exact: true }).click();
  await page.getByText("Saved", { exact: true }).first().waitFor({ timeout: 10000 });
  await page.route("**/api/v1/co_writer/edit", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        edited_text: `This is an improved E2E paragraph.\n\nIt verifies title and body persistence after refresh.\n\nAI refined draft.`,
        operation_id: "e2e-edit-op",
      }),
    });
  });
  await page.locator('textarea[aria-label="Instruction"]:visible').fill("Refine this draft");
  await page.getByRole("button", { name: "Edit full draft", exact: true }).click();
  const proposedChanges = page.getByLabel("Proposed changes");
  await proposedChanges.waitFor({ timeout: 10000 });
  assert((await proposedChanges.innerText()).includes("AI refined draft."), "AI proposal diff omitted added text");
  const proposalHunks = page.getByTestId("co-writer-proposal-hunks");
  await proposalHunks.waitFor({ timeout: 10000 });
  assert(await proposalHunks.locator("li, div").count() > 1, "AI proposal did not expose independent hunks");
  await proposalHunks.getByRole("button", { name: "Accept change", exact: true }).first().click();
  await proposalHunks.getByRole("button", { name: "Reject change", exact: true }).last().click();
  await page.getByRole("button", { name: "Apply selected changes", exact: true }).click();
  await page.waitForTimeout(100);
  assert(operationDecision?.decision === "accepted", "AI proposal disposition was not persisted");
  assert(operationDecision?.partial === true, "partial AI proposal acceptance was not audited");
  const selectivelyEdited = await page.getByLabel("Document content").inputValue();
  assert(selectivelyEdited.includes("improved E2E paragraph"), "accepted AI hunk was not applied");
  assert(selectivelyEdited.includes("Local conflict draft."), "rejected AI hunk changed the draft");
  assert(!selectivelyEdited.includes("AI refined draft."), "rejected AI hunk leaked into the draft");
  await page.getByRole("button", { name: "Undo last AI edit" }).click();
  assert((await page.getByLabel("Document content").inputValue()).includes("Local conflict draft."), "AI edit undo did not restore the prior draft");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByText("Saved", { exact: true }).first().waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  const versionHistory = page.getByTestId("co-writer-version-history");
  await versionHistory.waitFor({ timeout: 10000 });
  assert(await versionHistory.locator("li").count() >= 2, "saved document revisions were not listed");
  const operationHistory = page.getByTestId("co-writer-operation-history");
  await operationHistory.getByText("Partially accepted", { exact: true }).waitFor({ timeout: 10000 });
  await operationHistory.getByText("Refine this draft", { exact: true }).waitFor({ timeout: 10000 });
  await versionHistory.getByRole("button", { name: "Restore", exact: true }).first().click();
  await page.getByText("Version restored.", { exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Save document to notebook" }).click();
  const notebookDialog = page.getByRole("dialog");
  await notebookDialog.getByRole("combobox").selectOption("e2e-notebook");
  await notebookDialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved to notebook", { exact: true }).waitFor({ timeout: 10000 });
  assert(savedDocumentRecord?.record_type === "co_writer", "Co-Writer notebook save used the wrong record type");
  assert(savedDocumentRecord?.output?.includes("Local conflict draft."), "Co-Writer notebook save omitted the current document body");
  assert(savedDocumentRecord?.references?.[0]?.type === "co_writer", "Co-Writer notebook save omitted the document reference");
  await page.getByLabel("Document content").click();
  await page.getByLabel("Document content").press("ControlOrMeta+a");
  const selectionHighlight = page.getByTestId("co-writer-selection-highlight");
  const selectionTarget = page.locator('[data-testid="co-writer-selection-target"]:visible');
  await selectionHighlight.waitFor({ timeout: 5000 });
  await selectionTarget.waitFor({ timeout: 5000 });
  const highlightColor = await selectionHighlight.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  assert(
    highlightColor !== "rgba(0, 0, 0, 0)" && highlightColor !== "transparent",
    "selected passage does not have a persistent background",
  );
  assert(
    (await selectionTarget.innerText()).includes("This is an explic"),
    "AI assistant does not show the selected passage",
  );
  await page.locator('textarea[aria-label="Instruction"]:visible').focus();
  assert(
    await selectionHighlight.isVisible(),
    "selection highlight disappeared after focusing the AI instruction",
  );
  await shot(page, "co-writer-selection-target");
  await page.getByRole("button", { name: "Clear selection" }).click();
  await selectionHighlight.waitFor({ state: "detached", timeout: 5000 });
  const words = await page.locator("body").innerText();
  assert(/words/.test(words), "word counter not rendered");
  await shot(page, "co-writer");

  // Cleanup through the same UI path a user takes. This also guards against
  // dropdown events bubbling into the clickable document card.
  await goto(page, "/co-writer");
  const openDocument = page.getByRole("button", {
    name: `Open ${SAVED_TITLE}`,
    exact: true,
  });
  await openDocument.waitFor({ timeout: 10000 });
  const card = openDocument.locator("..");
  await card.hover();
  await card.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).first().click();
  const dlgDelete = page
    .locator('[role="dialog"]')
    .getByRole("button", { name: "Delete", exact: true });
  await dlgDelete.waitFor({ timeout: 5000 });
  await dlgDelete.click();
  await page.getByText(SAVED_TITLE, { exact: true }).waitFor({
    state: "detached",
    timeout: 10000,
  });

  // Native-parity template story: create a structured draft and verify the
  // selected template reaches the editor before cleaning it up through UI.
  await page.getByRole("button", { name: "From template" }).first().click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByRole("radio", { name: /Research report/ }).click();
  await createDialog.getByLabel("Document title").fill(TEMPLATE_TITLE);
  await createDialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/co-writer\/[^/]+$/, { timeout: 20000 });
  const templateContent = page.getByLabel("Document content");
  await templateContent.waitFor({ timeout: 20000 });
  assert((await templateContent.inputValue()).includes("## Research question"), "research template content missing");

  await goto(page, "/co-writer");
  const openTemplate = page.getByRole("button", {
    name: `Open ${TEMPLATE_TITLE}`,
    exact: true,
  });
  await openTemplate.waitFor({ timeout: 10000 });
  const templateCard = openTemplate.locator("..");
  await templateCard.hover();
  await templateCard.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).first().click();
  await (await dialogButton(page, "Delete")).click();
  await page.getByText(TEMPLATE_TITLE, { exact: true }).waitFor({ state: "detached", timeout: 10000 });
  return "save/refresh, live preview, revision recovery, AI diff/undo, template create, and UI cleanup OK";
}

async function flowBook(page) {
  await goto(page, "/book");
  await page.waitForTimeout(3000);
  const len = await bodyLen(page);
  assert(len > 80, `/book looks blank (body ${len} chars)`);
  await shot(page, "book");
  const text = await page.locator("body").innerText();
  const books = (text.match(/book/gi) || []).length;
  const readyBook = page.locator('[data-testid="book-card"][data-book-status="ready"]').first();
  if (await readyBook.isVisible().catch(() => false)) {
    // The open target is intentionally scoped to the cover/title header so it
    // cannot overlap cover-management controls elsewhere in the card.
    await readyBook.getByTestId("book-open").click();
    const overviewEntry = page.locator('[data-content-type="overview"]').first();
    await overviewEntry.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
      throw new Error("legacy and current ready books must expose the migrated overview page");
    });
    await overviewEntry.click();
    const statistics = page.getByTestId("book-overview-statistics");
    await statistics.waitFor({ timeout: 15000 });
    assert(
      (await statistics.getByTestId("book-primary-statistics").locator("dt").count()) === 4,
      "book overview should expose four primary metrics",
    );
    await statistics.getByText("Reading progress", { exact: true }).waitFor();
    await statistics.getByText("Chapter content distribution", { exact: true }).waitFor();
    await shot(page, "book-statistics");
    return `rendered; overview statistics, progress and chapter distribution visible`;
  }
  return `rendered, body ${len} chars, ~${books} 'book' mentions; no ready book for statistics probe`;
}

async function flowMemory(page) {
  await goto(page, "/memory");
  await page
    .getByRole("heading", { name: "Memory", exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  await page.getByText(/L1 · Workspace mirror/).first().waitFor({ timeout: 15000 });
  await page.getByText(/L2 · Per-surface summaries/).first().waitFor({ timeout: 15000 });
  await page.getByText(/L3 · Cross-surface knowledge/).first().waitFor({ timeout: 15000 });
  await shot(page, "memory");
  const sub = ["l1", "l2", "l3", "graph", "settings"];
  const ok = [];
  for (const s of sub) {
    await goto(page, `/memory/${s}`);
    await page.waitForTimeout(2000);
    const len = await bodyLen(page);
    if (len > 60) ok.push(s);
  }
  assert(ok.length === sub.length, `some memory subpages blank: ${sub.filter((s) => !ok.includes(s)).join(",")}`);
  return `hub cards OK; subpages OK: ${ok.join(",")}`;
}

async function flowKnowledge(page) {
  const KB = `e2e-kb-${Date.now() % 100000}`;
  await goto(page, "/knowledge");
  await page
    .getByRole("heading", { name: "Knowledge", exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await shot(page, "knowledge");

  await page.locator('[data-testid="advanced-engine-overview"] summary').click();
  const engineRegion = page.getByRole("region", { name: "Retrieval engines" });
  await engineRegion.waitFor({ timeout: 10000 });
  const engineNames = ["LlamaIndex", "PageIndex", "LightRAG", "LightRAG Server", "Tencent IMA"];
  for (const name of engineNames) {
    assert(
      await engineRegion.getByRole("heading", { name, exact: true }).isVisible(),
      `knowledge engine missing from overview: ${name}`,
    );
  }
  assert(
    await engineRegion.getByText(/of 5 ready/).isVisible(),
    "knowledge engine readiness summary missing",
  );

  assert(
    await engineRegion.getByRole("heading", { name: "GraphRAG", exact: true }).count() === 0,
    "disabled GraphRAG must not be offered in the engine overview",
  );

  // Keep the deterministic release gate independent from an optional local
  // Ollama process. Dedicated knowledge journey tests cover successful
  // creation and file preview; this page-flow probe verifies that an
  // unavailable embedding runtime is surfaced before a background task can
  // create a half-initialized knowledge base.
  await page.route("**/api/v1/knowledge/rag-pipelines/llamaindex/preflight", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: false,
      checks: [{
        key: "embedding",
        label: "Active embedding model",
        ok: false,
        detail: "The deterministic release test does not require a local embedding runtime.",
        optional: false,
      }],
    }),
  }));

  await page
    .getByRole("button", { name: "Create knowledge base" })
    .first()
    .click();
  const nameInput = page.locator(
    '[role="dialog"] input[placeholder*="project-papers"]',
  );
  await nameInput.waitFor({ timeout: 10000 });
  await nameInput.fill(KB);
  await page
    .locator('[role="dialog"] input[type="file"]')
    .setInputFiles({
      name: "note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Cognivoy E2E test document. Fourier transform basics."),
    });
  await page.waitForTimeout(800);
  const createAction = await dialogButton(page, "Create");
  const createAllowed = await createAction.isEnabled();
  let outcome = "unknown";
  if (!createAllowed) {
    const dialog = page.getByRole("dialog");
    await dialog
      .getByText("Complete the required setup before creating this knowledge base.")
      .waitFor({ timeout: 10000 });
    assert(
      (await dialog.getByRole("link", { name: "Open embedding settings" }).getAttribute("href")) === "/settings/embedding",
      "missing embedding preflight did not expose the repair settings link",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    outcome = "creation correctly blocked by engine preflight";
  } else {
    await createAction.click();

    // wait for an outcome: dialog error, toast, or dialog closes (created)
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const dialogVisible = await page
        .locator('[role="dialog"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (dialogVisible) {
        const errBox = await page
          .locator('[role="dialog"] .text-destructive pre')
          .first()
          .textContent()
          .catch(() => null);
        if (errBox && errBox.trim()) {
          outcome = `graceful dialog error: ${errBox.trim().slice(0, 160)}`;
          break;
        }
      } else {
        outcome = "dialog closed (KB created or redirected)";
        break;
      }
      const toast = await page
        .locator('[role="status"], [data-toast], .toast')
        .allTextContents()
        .catch(() => []);
      const errToast = toast.find((x) => /fail|error|embedding/i.test(x));
      if (errToast) {
        outcome = `toast: ${errToast.slice(0, 160)}`;
        break;
      }
      await page.waitForTimeout(1000);
    }
  }
  // page must still be alive (no white screen)
  const alive = await page
    .getByRole("heading", { name: "Knowledge", exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  assert(alive, "knowledge page crashed / white screen after create attempt");
  if (createAllowed) {
    const uploadedFile = page.getByRole("button", { name: "note.txt", exact: true }).first();
    await uploadedFile.waitFor({ timeout: 15000 });
    await uploadedFile.click();
    const filePreview = page.getByRole("dialog", { name: "File preview: note.txt" });
    await filePreview.waitFor({ timeout: 10000 });
    await filePreview.getByText(/Fourier transform basics/).waitFor({ timeout: 10000 });
    await filePreview.getByRole("button", { name: "Close" }).click();
    outcome += "; text file preview OK";
  }
  await shot(page, "knowledge-create");

  // cleanup: delete the KB via the API proxy (best effort)
  if (createAllowed) {
    try {
      const impact = await fetch(`${BASE}/api/v1/knowledge/${encodeURIComponent(KB)}/deletion-impact`).then((response) => response.json());
      const res = await fetch(`${BASE}/api/v1/knowledge/${encodeURIComponent(KB)}?confirmation_token=${encodeURIComponent(impact.confirmation_token)}`, {
        method: "DELETE",
      });
      outcome += `; cleanup DELETE -> ${res.status}`;
    } catch (e) {
      outcome += `; cleanup failed: ${String(e).slice(0, 80)}`;
    }
  }

  // Deterministic UI contract for a task restored after navigation: the
  // persisted task id must still expose Stop, call the cancel endpoint, then
  // settle into a retryable Cancelled state. Real task interruption is
  // covered by the backend API integration test.
  const cancelKb = "e2e-cancel-ui";
  const cancelTaskId = "task-cancel-ui";
  const listPattern = "**/api/v1/knowledge/list*";
  const filesPattern = `**/api/v1/knowledge/${cancelKb}/files`;
  const cancelPattern = `**/api/v1/knowledge/${cancelKb}/tasks/${cancelTaskId}/cancel`;
  let cancelRequested = false;
  const listHandler = async (route) => {
    const status = cancelRequested ? "cancelled" : "processing";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          name: cancelKb,
          status,
          progress: {
            stage: cancelRequested ? "cancelled" : "processing_documents",
            message: cancelRequested ? "Document indexing cancelled by user" : "Indexing note.txt",
            percent: 42,
            task_id: cancelTaskId,
          },
          statistics: {
            status,
            raw_documents: 1,
            rag_provider: "llamaindex",
          },
        },
      ]),
    });
  };
  const cancelHandler = async (route) => {
    cancelRequested = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        task_id: cancelTaskId,
        status: "cancelled",
        already_cancelled: false,
      }),
    });
  };
  await page.route(listPattern, listHandler);
  const filesHandler = (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  await page.route(filesPattern, filesHandler);
  await page.route(cancelPattern, cancelHandler);
  try {
    await goto(page, `/knowledge?kb=${cancelKb}`);
    const stopButton = page.getByRole("button", { name: "Stop indexing" });
    await stopButton.waitFor({ timeout: 10000 });
    await stopButton.click();
    await page.getByText("Cancelled", { exact: true }).first().waitFor({ timeout: 10000 });
    assert(cancelRequested, "knowledge cancel endpoint was not called");
    assert(
      await page.getByRole("button", { name: "Retry", exact: true }).isVisible(),
      "cancelled knowledge task did not become retryable",
    );
    outcome += "; restored task stop/cancel/retry UI OK";
  } finally {
    await page.unroute(listPattern, listHandler);
    await page.unroute(filesPattern, filesHandler);
    await page.unroute(cancelPattern, cancelHandler);
  }
  return outcome;
}

async function flowSpace(page) {
  await goto(page, "/space");
  await page
    .getByRole("heading", { name: "Learning Space", exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByText("Conversations & Materials").first().waitFor({ timeout: 15000 });
  await page.getByText("Preferences & Expert tools").first().waitFor({ timeout: 15000 });
  const cards = await page.locator("section a").count();
  assert(cards >= 8, `expected >=8 dashboard cards, got ${cards}`);
  await page.waitForTimeout(2500); // let counts settle
  await shot(page, "space");
  return `${cards} dashboard cards rendered`;
}

async function flowPersonas(page) {
  const NAME = `e2e-persona-${Date.now() % 100000}`;
  await goto(page, "/space/personas");
  await page.getByRole("heading", { name: "Personas", exact: true }).waitFor({ timeout: 30000 });
  const dialog = page.getByRole("dialog");
  const newPersona = page.getByRole("button", { name: "New persona", exact: true }).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await newPersona.click();
    if (await dialog.isVisible().catch(() => false)) break;
    await page.waitForTimeout(1000);
  }
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByPlaceholder("e.g. Socratic tutor").fill(NAME);
  await dialog.getByPlaceholder("What this persona is for").fill("Structured E2E persona");
  await dialog.getByPlaceholder("e.g. concise, warm, Socratic").fill("warm Socratic");
  const selects = dialog.locator("select");
  await selects.nth(0).selectOption("zh");
  await selects.nth(1).selectOption("graduation-cap");
  await dialog.locator("textarea").fill("Ask one guiding question at a time.");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const card = page.locator(".surface").filter({ hasText: NAME }).first();
  await card.waitFor({ timeout: 10000 });
  await card.getByText("ZH", { exact: true }).waitFor();
  await card.getByText("warm Socratic", { exact: true }).waitFor();
  await card.getByText("Icon: graduation-cap", { exact: true }).waitFor();
  const persisted = await page.evaluate(async (name) => {
    const response = await fetch(`/api/v1/personas/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`persona read failed: ${response.status}`);
    return response.json();
  }, NAME);
  assert(persisted.language === "zh", "persona language was not persisted");
  assert(persisted.style === "warm Socratic", "persona style was not persisted");
  assert(persisted.icon === "graduation-cap", "persona icon was not persisted");
  await page.evaluate(async (name) => {
    await fetch(`/api/v1/personas/${encodeURIComponent(name)}`, { method: "DELETE" });
  }, NAME);
  return "structured language/style/icon create → render → persist → cleanup OK";
}

async function flowPartners(page) {
  await goto(page, "/partners");
  await page
    .getByRole("heading", { name: "Tutors", exact: true })
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);
  await shot(page, "partners");
  return "partners page rendered";
}

async function flowPlayground(page) {
  await goto(page, "/playground");
  await page
    .getByRole("heading", { name: "Playground", exact: true })
    .waitFor({ timeout: 30000 });
  await page.waitForSelector("select option", {
    state: "attached",
    timeout: 30000,
  });
  const opts = await page.locator("select option").allTextContents();
  assert(opts.length > 0, "no tools/capabilities listed");
  const hasConfig = await page
    .getByText(/Config \(JSON\)|Parameters \(JSON\)/)
    .first()
    .isVisible()
    .catch(() => false);
  assert(hasConfig, "JSON config editor not rendered");
  await shot(page, "playground");
  return `config panel OK; plugins: ${opts.slice(0, 3).join("/")}… (${opts.length} total)`;
}

async function flowProfile(page) {
  await goto(page, "/profile");
  await page
    .getByRole("heading", { name: "Profile", exact: true })
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const len = await bodyLen(page);
  assert(len > 100, `profile looks blank (${len} chars)`);
  await shot(page, "profile");
  return "profile rendered";
}

async function flowMobile(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem("cognivoy-language", "en");
    window.localStorage.setItem("cognivoy-response-language", "en");
  });
  attach(page);
  try {
    await goto(page, "/home");
    assert((await page.title()).includes("Cognivoy"), "document title does not use Cognivoy");
    const initialBody = await page.locator("body").innerText();
    assert(initialBody.includes("Cognivoy"), "mobile header does not show Cognivoy");
    assert(!initialBody.includes("DeepTutor"), "retired brand is visible on mobile home");
    const menu = page.locator('button[aria-label="Menu"]');
    await menu.waitFor({ timeout: 45000 });
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    assert(overflow <= 376, `horizontal overflow: scrollWidth ${overflow}px`);
    await shot(page, "mobile-home");
    await menu.click();
    await page.waitForTimeout(1000);
    const drawerVisible = await page
      .locator("nav, aside")
      .first()
      .isVisible()
      .catch(() => false);
    assert(drawerVisible, "sidebar drawer did not open");
    const drawerText = await page.locator("body").innerText();
    assert(drawerText.includes("Cognivoy"), "sidebar does not show Cognivoy");
    assert(!drawerText.includes("DeepTutor"), "retired brand is visible in sidebar");
    await shot(page, "mobile-home-drawer");
  } finally {
    await ctx.close();
  }
  return "Cognivoy title/header/drawer OK; no h-overflow";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem("cognivoy-language", "en");
    window.localStorage.setItem("cognivoy-response-language", "en");
  });
  attach(page);

  const F = (name, fn) => runFlow(name, page, fn);
  const ONLY = process.env.FLOW || "";
  const maybe = async (name, fn) => {
    if (!ONLY || ONLY === name) await F(name, fn);
  };

  await maybe("entry-headers", flowEntryHeaders);
  await maybe("settings", flowSettings);
  await maybe("llm-settings", flowLlmSettings);
  await maybe("notebook", flowNotebook);
  await maybe("co-writer", flowCoWriter);
  await maybe("book", flowBook);
  await maybe("memory", flowMemory);
  await maybe("knowledge", flowKnowledge);
  await maybe("space", flowSpace);
  await maybe("personas", flowPersonas);
  await maybe("partners", flowPartners);
  await maybe("playground", flowPlayground);
  await maybe("profile", flowProfile);
  if (!ONLY || ONLY === "mobile-home")
    await runFlow("mobile-home", page, () => flowMobile(browser));

  await browser.close();

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("\n================ SUMMARY ================");
  for (const r of results) {
    console.log(
      `${r.status === "PASS" ? "PASS" : "FAIL"}  ${r.flow.padEnd(14)} ${(r.ms / 1000).toFixed(1)}s  ${r.notes}`,
    );
  }
  const pass = results.filter((r) => r.status === "PASS").length;
  console.log(`\n${pass}/${results.length} flows passed`);

  console.log("\n============ CONSOLE ERRORS =============");
  if (!consoleErrors.length) console.log("(none)");
  for (const e of consoleErrors) {
    console.log(`[${e.kind}] (${e.flow}) ${e.message}`);
  }
  console.log("\n============= HTTP FAILURES =============");
  if (!httpFailures.length) console.log("(none)");
  for (const failure of httpFailures) {
    console.log(`[${failure.kind}] (${failure.flow}) ${failure.method} ${failure.url} → ${failure.status || failure.message}`);
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS_DIR, "e2e-pages.json"),
    JSON.stringify({ baseUrl: BASE, results, consoleErrors, httpFailures }, null, 2) + "\n",
  );
  process.exit(results.every((r) => r.status === "PASS") ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
