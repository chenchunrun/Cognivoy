/* Browser contract: memory collection/partner policies persist, and soft
 * deletion stays recoverable until the user explicitly confirms a purge. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let settings = {
  collection: { enabled: true, auto_capture: true, retention_days: 365 },
  partner: { shared_owner_read: true, private_partner_write: true },
  update: { l2_budget: 20, l3_budget: 10 },
  audit: { l2_budget: 20, l3_budget: 10 },
  dedup: { iterations: 3, auto_after_update: true },
  merge: { auto_after_update: true, auto_after_audit: true, auto_after_dedup: true },
  chunking: { overlap_ratio: 0.1, boundary: "paragraph", min_chunk_chars: 1000, max_chunk_chars: 64000 },
  reference: { enforce_required: true, drop_invalid_refs: true },
};

let trash = [
  {
    layer: "L2",
    key: "chat",
    deleted_at: "2026-08-15T08:00:00Z",
    entry: {
      id: "m_01HZK1ABCDEFGHJKMNPQRSTVWX",
      section: "Preferences",
      text: "Restore this worked-example preference",
      refs: ["chat:turn-1"],
    },
  },
  {
    layer: "L3",
    key: "profile",
    deleted_at: "2026-08-15T09:00:00Z",
    entry: {
      id: "m_01HZK1ABCDEFGHJKMNPQRSTVWY",
      section: "Profile",
      text: "Purge this obsolete profile claim",
      refs: ["m_01HZK1ABCDEFGHJKMNPQRSTVWX"],
    },
  },
];

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await (await browser.newContext()).newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route("**/api/v1/memory/settings", async (route) => {
      if (route.request().method() === "PUT") {
        settings = route.request().postDataJSON();
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(settings),
      });
    });
    await page.route("**/api/v1/memory/trash**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const restore = path.match(/\/trash\/(L2|L3)\/[^/]+\/([^/]+)\/restore$/);
      if (restore && request.method() === "POST") {
        trash = trash.filter((item) => item.entry.id !== restore[2]);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ restored: restore[2] }) });
      }
      const purge = path.match(/\/trash\/(L2|L3)\/[^/]+\/([^/]+)$/);
      if (purge && request.method() === "DELETE") {
        trash = trash.filter((item) => item.entry.id !== purge[2]);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ permanently_deleted: purge[2] }) });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: trash, total: trash.length }),
      });
    });

    await page.goto(`${BASE}/memory/settings`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Memory collection" }).waitFor();
    await page.getByRole("switch", { name: "Capture useful activity automatically" }).click();
    await page.getByRole("switch", { name: "Allow partners to read shared owner memory" }).click();
    await page.getByRole("spinbutton", { name: "Raw trace retention (days)" }).fill("30");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Settings saved").waitFor();
    assert(settings.collection.auto_capture === false, "auto-capture policy was not persisted");
    assert(settings.collection.retention_days === 30, "retention policy was not persisted");
    assert(settings.partner.shared_owner_read === false, "partner sharing policy was not persisted");

    await page.getByText("Restore this worked-example preference").waitFor();
    await page
      .locator("li")
      .filter({ hasText: "Restore this worked-example preference" })
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await page.getByText("Memory restored").waitFor();
    assert(trash.length === 1, "restoring did not remove the tombstone");

    await page
      .locator("li")
      .filter({ hasText: "Purge this obsolete profile claim" })
      .getByRole("button", { name: "Delete forever", exact: true })
      .click();
    await page.getByRole("heading", { name: "Permanently delete this memory?" }).waitFor();
    await page.getByRole("button", { name: "Delete forever", exact: true }).last().click();
    await page.getByText("Memory permanently deleted").waitFor();
    await page.getByText("No recently deleted memories.").waitFor();
    assert(trash.length === 0, "confirmed purge did not clear the tombstone");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Memory collection" }).waitFor();
    assert(
      (await page.getByRole("switch", { name: "Capture useful activity automatically" }).getAttribute("aria-checked")) === "false",
      "saved collection policy did not survive reload",
    );
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);
    console.log("PASS memory lifecycle: policy save + restore + confirmed purge + reload");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL memory lifecycle:", error);
  process.exit(1);
});
