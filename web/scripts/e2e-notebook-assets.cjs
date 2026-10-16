/* Browser contract: Notebook Markdown imports are explicit and recoverable,
 * while optimistic record edits surface the latest server revision before a
 * user retries. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let now = 1_786_742_400;
let records = [{
  id: "record-original", type: "chat", title: "Original note",
  summary: "Original summary", user_query: "Original prompt", output: "Original body",
  tags: ["baseline"], references: [{ type: "chat_message", session_id: "session-1" }],
  created_at: now - 100, updated_at: now - 100, revision: 1,
}];
let conflictPending = true;

function notebookSummary() {
  return {
    id: "notebook-1", name: "Research notebook", description: "Reusable research notes",
    color: "#c98a2d", icon: "book", record_count: records.length,
    created_at: now - 1000, updated_at: now,
  };
}

function markdownRecords(content, title) {
  return content.split(/^##\s+/m).map((part) => part.trim()).filter(Boolean).map((section, index) => {
    const [heading, ...body] = section.split(/\r?\n/);
    return {
      id: `markdown-${now}-${index}`, type: "chat", title: heading || title,
      summary: "", user_query: "", output: body.join("\n").trim() || heading || title,
      tags: ["markdown-import"], references: [], created_at: now, updated_at: now, revision: 1,
    };
  });
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await (await browser.newContext()).newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route("**/api/v1/notebook/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/v1/notebook/list" && request.method() === "GET") {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ notebooks: [notebookSummary()] }) });
      }
      if (path === "/api/v1/notebook/notebook-1/records" && request.method() === "GET") {
        const url = new URL(request.url());
        const query = (url.searchParams.get("q") || "").toLocaleLowerCase();
        const offset = Number(url.searchParams.get("offset") || 0);
        const limit = Number(url.searchParams.get("limit") || 50);
        const matches = records.filter((record) =>
          !query || `${record.title} ${record.summary} ${record.user_query} ${record.output}`.toLocaleLowerCase().includes(query),
        );
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({
          items: matches.slice(offset, offset + limit), total: matches.length, limit, offset,
          notebook: notebookSummary(),
        }) });
      }
      if (path === "/api/v1/notebook/notebook-1" && request.method() === "GET") {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...notebookSummary(), records }) });
      }
      if (path.endsWith("/import-markdown") && request.method() === "POST") {
        const payload = request.postDataJSON();
        now += 1;
        const imported = markdownRecords(payload.content, payload.title || "Imported note");
        const replacedCount = payload.mode === "replace" ? records.length : 0;
        records = payload.mode === "replace" ? imported : [...records, ...imported];
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ notebook_id: "notebook-1", mode: payload.mode,
            imported_count: imported.length, replaced_count: replacedCount,
            records: imported, updated_at: now }),
        });
      }
      const update = path.match(/\/notebook-1\/records\/([^/]+)$/);
      if (update && request.method() === "PUT") {
        const index = records.findIndex((record) => record.id === update[1]);
        assert(index >= 0, "edit targeted an unknown record");
        if (conflictPending) {
          conflictPending = false;
          records[index] = { ...records[index], title: "Remote title", output: "Remote body", revision: 2, updated_at: ++now };
          return route.fulfill({ status: 409, contentType: "application/json",
            body: JSON.stringify({ detail: { code: "revision_conflict", current: records[index] } }) });
        }
        const payload = request.postDataJSON();
        assert(payload.expected_revision === 2, "retry did not use the latest revision");
        records[index] = { ...records[index], ...payload, revision: 3, updated_at: ++now };
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ record: records[index] }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${BASE}/notebook`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Research notebook" }).waitFor();

    await page.getByRole("button", { name: "Import Markdown" }).click();
    await page.getByLabel("Markdown content").fill("## First imported\nAlpha\n\n## Second imported\nBeta");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("Markdown imported").waitFor();
    await page.locator("li").filter({ hasText: "First imported" }).waitFor();
    assert(records.length === 3, "append import replaced existing records");

    await page.getByRole("button", { name: "Import Markdown" }).click();
    await page.getByLabel("Import mode").selectOption("replace");
    await page.getByLabel("Markdown content").fill("## Replacement note\nReplacement body");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Replace all notebook records?" }).waitFor();
    await page.getByRole("button", { name: "Replace records", exact: true }).click();
    await page.locator("li").filter({ hasText: "Replacement note" }).waitFor();
    assert(records.length === 1 && records[0].title === "Replacement note", "replace import was not atomic");

    await page.getByRole("button", { name: "Edit record", exact: true }).click();
    const title = page.getByLabel("Title");
    await title.fill("My stale edit");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Record changed in another session").waitFor();
    assert((await title.inputValue()) === "Remote title", "conflict did not reload the latest title");
    await title.fill("Resolved title");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Record updated").waitFor();
    await page.getByText("Resolved title").waitFor();
    assert(records[0].revision === 3, "resolved edit did not advance the revision");
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);
    console.log("PASS notebook assets: append + confirmed replace + revision conflict recovery");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL notebook assets:", error);
  process.exit(1);
});
