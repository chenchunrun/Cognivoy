/* Browser contract: learners can inspect source/confidence/influence metadata,
 * edit with optimistic versioning, soft-delete, restore, and export memories. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let resource = {
  id: "m_learning_goal",
  layer: "L3",
  key: "profile",
  section: "Learning goals",
  text: "The learner is studying production AI agents",
  refs: ["chat:turn-42"],
  source_count: 1,
  confidence: 0.8,
  created_at: "2026-08-18T08:00:00Z",
  updated_at: "2026-08-20T08:00:00Z",
  status: "active",
  version: "v1",
};
let exported = false;
let updatedPayload = null;
let deletePayload = null;

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await page.addInitScript(() => {
      localStorage.setItem("language", "en");
      localStorage.setItem("cognivoy.language", "en");
    });

    await page.route("**/api/v1/memory/resources/export**", async (route) => {
      exported = true;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ schema_version: 1, items: [resource] }),
      });
    });
    await page.route("**/api/v1/memory/resources/L3/profile/m_learning_goal", async (route) => {
      if (route.request().method() === "PUT") {
        updatedPayload = route.request().postDataJSON();
        resource = { ...resource, text: updatedPayload.text, section: updatedPayload.section, version: "v2" };
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ item: resource, version: "v2" }),
        });
      }
      if (route.request().method() === "DELETE") {
        deletePayload = route.request().postDataJSON();
        resource = { ...resource, status: "deleted", reason: deletePayload.reason };
        return route.fulfill({ contentType: "application/json", body: '{"deleted":true}' });
      }
      return route.fallback();
    });
    await page.route("**/api/v1/memory/trash/L3/profile/m_learning_goal/restore", async (route) => {
      resource = { ...resource, status: "active", reason: undefined, version: "v3" };
      return route.fulfill({ contentType: "application/json", body: '{"restored":true}' });
    });
    await page.route("**/api/v1/memory/resources?**", async (route) => {
      const status = new URL(route.request().url()).searchParams.get("status") || "active";
      const items = status === "all" || status === resource.status ? [resource] : [];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ schema_version: 1, items, total: items.length, cursor: null }),
      });
    });

    await page.goto(`${BASE}/memory/resources`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Memory details" }).waitFor();
    await page.getByText("The learner is studying production AI agents").waitFor();
    await page.getByText("chat:turn-42").waitFor();
    await page.getByText("80%").waitFor();
    await page.getByText("Tutor personalization and learning plans").waitFor();
    await page.getByText("8/18/2026", { exact: false }).waitFor();

    await page.getByTestId("memory-edit-m_learning_goal").click();
    await page.getByLabel("Memory text").fill("The learner is building reliable production AI agents");
    await page.getByTestId("memory-edit-save").click();
    await page.getByText("Memory updated").waitFor();
    assert(updatedPayload.expected_version === "v1", "edit did not carry the optimistic version");
    assert(resource.text.includes("reliable"), "edited memory was not reloaded");

    const download = page.waitForEvent("download");
    await page.getByTestId("memory-export").click();
    await download;
    assert(exported, "export endpoint was not called");

    await page.getByTestId("memory-delete-m_learning_goal").click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await page.getByText("Memory moved to Recently deleted").waitFor();
    assert(deletePayload.expected_version === "v2", "delete did not carry the current version");

    await page.getByLabel("Memory status").selectOption("deleted");
    await page.getByText("The learner is building reliable production AI agents").waitFor();
    await page.getByTestId("memory-restore-m_learning_goal").click();
    await page.getByText("Memory restored").waitFor();
    assert(resource.status === "active", "restore did not reactivate the memory");
    assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
    console.log("PASS memory transparency: inspect → edit/version → export → soft-delete → restore");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL memory transparency:", error);
  process.exit(1);
});
