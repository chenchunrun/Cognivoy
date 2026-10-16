/* Browser contract: deletion requires fresh impact review and preserves stale-reference evidence. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
function assert(condition, message) { if (!condition) throw new Error(message); }

(async () => {
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  let deleteUrl = "";
  let deleted = false;
  await page.addInitScript(() => localStorage.setItem("cognivoy-language", "en"));
  await page.route("**/api/v1/knowledge/list*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(deleted ? [] : [{
      name: "course-kb", status: "ready", metadata: { type: "document" },
      statistics: { raw_documents: 1, status: "ready" },
    }]),
  }));
  await page.route("**/api/v1/knowledge/rag-providers*", (route) => route.fulfill({
    contentType: "application/json", body: '{"providers":[]}',
  }));
  await page.route("**/api/v1/knowledge/supported-file-types*", (route) => route.fulfill({
    contentType: "application/json", body: '{"extensions":[".md"],"max_file_size_bytes":1048576}',
  }));
  await page.route("**/api/v1/knowledge/course-kb/deletion-impact", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      knowledge_base: "course-kb",
      counts: { sessions: 2, notebook_records: 1, workspace_files: 1 },
      sessions: [{ session_id: "s1" }, { session_id: "s2" }],
      notebook_records: [{ notebook_id: "n1", record_id: "r1", title: "Notes" }],
      workspace_files: [{ path: "book/b1.json" }], total_references: 4,
      confirmation_token: "fresh-token",
    }),
  }));
  await page.route("**/api/v1/knowledge/course-kb?**", (route) => {
    deleteUrl = route.request().url(); deleted = true;
    return route.fulfill({ contentType: "application/json", body: '{"status":"deleted"}' });
  });

  try {
    await page.goto(`${BASE}/knowledge`, { waitUntil: "domcontentloaded" });
    await page.getByText("course-kb", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Delete", exact: true }).first().click();
    await page.getByText("This knowledge base is still referenced in 4 places.").waitFor();
    await page.getByText("2 sessions", { exact: true }).waitFor();
    await page.getByText("1 notebook records", { exact: true }).waitFor();
    await page.getByText("1 workspace files", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await page.waitForTimeout(150);
    assert(deleteUrl.includes("confirmation_token=fresh-token"), "delete did not carry the reviewed token");
    console.log("PASS knowledge deletion: impact review → token-bound delete → preserved reference warning");
  } finally {
    await page.close(); await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
