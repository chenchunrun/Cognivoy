/* Browser contract: L3 conflicts expose evidence coverage, require an
 * explicit user decision, soft-delete through the server contract, and keep
 * a durable audit trail after reload. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const evidence = "m_01HZK1ABCDEFGHJKMNPQRSTVWX";
let conflicts = [
  {
    id: "L3:profile:m_left:m_right",
    layer: "L3",
    key: "profile",
    section: "Communication",
    reason: "shared_evidence_distinct_claims",
    shared_refs: [evidence],
    left: {
      id: "m_left",
      section: "Communication",
      text: "Prefers concise answers",
      refs: [evidence, "missing"],
      ref_count: 2,
      valid_ref_count: 1,
      confidence: 0.5,
    },
    right: {
      id: "m_right",
      section: "Communication",
      text: "Prefers detailed explanations",
      refs: [evidence],
      ref_count: 1,
      valid_ref_count: 1,
      confidence: 1,
    },
  },
  {
    id: "L3:knowledge:m_old_a:m_old_b",
    layer: "L3",
    key: "knowledge",
    section: "Topics",
    reason: "shared_evidence_distinct_claims",
    shared_refs: [evidence],
    left: {
      id: "m_old_a",
      section: "Topics",
      text: "Obsolete statement A",
      refs: [evidence],
      ref_count: 1,
      valid_ref_count: 1,
      confidence: 1,
    },
    right: {
      id: "m_old_b",
      section: "Topics",
      text: "Obsolete statement B",
      refs: [evidence],
      ref_count: 1,
      valid_ref_count: 1,
      confidence: 1,
    },
  },
];
let audit = [];
const resolutions = [];

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await (await browser.newContext()).newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route("**/api/v1/memory/conflicts**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/conflicts/resolve") && request.method() === "POST") {
        const payload = request.postDataJSON();
        resolutions.push(payload);
        conflicts = conflicts.filter((item) => item.id !== payload.conflict_id);
        const record = {
          id: `audit-${audit.length + 1}`,
          conflict_id: payload.conflict_id,
          resolved_at: "2026-08-15T10:00:00Z",
          layer: "L3",
          key: payload.key,
          section: payload.key === "profile" ? "Communication" : "Topics",
          action: payload.action,
          left_id: payload.left_id,
          right_id: payload.right_id,
          shared_refs: [evidence],
          kept_ids: payload.action === "merge" ? [payload.left_id] : [],
          deleted_ids: payload.action === "delete_both" ? [payload.left_id, payload.right_id] : [payload.right_id],
          reason: payload.reason || "",
        };
        audit.push(record);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(record) });
      }
      if (path.endsWith("/conflicts/audit")) {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ items: audit, total: audit.length }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ schema_version: 1, items: conflicts, total: conflicts.length }),
      });
    });

    await page.goto(`${BASE}/memory/conflicts`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Memory conflicts" }).waitFor();
    await page.getByText("50% evidence coverage").waitFor();
    await page.getByText("1 of 2 references resolve").waitFor();

    const first = page.locator("[data-conflict-id]").filter({ hasText: "Prefers concise answers" });
    await first.getByRole("button", { name: "Merge statements" }).click();
    await first.getByLabel("Reconciled statement").fill(
      "Prefers concise answers first, with details available on request",
    );
    await first.getByLabel("Decision note (optional)").fill("Learner confirmed this preference");
    await first.getByRole("button", { name: "Save merged statement" }).click();
    await page.getByText("Learner confirmed this preference").waitFor();
    assert(resolutions[0].action === "merge", "merge resolution was not sent");
    assert(resolutions[0].merged_text.includes("details available"), "merged statement was lost");

    const second = page.locator("[data-conflict-id]").filter({ hasText: "Obsolete statement A" });
    await second.getByRole("button", { name: "Delete both" }).click();
    await page.getByRole("heading", { name: "Delete both statements?" }).waitFor();
    await page.getByRole("button", { name: "Delete both", exact: true }).last().click();
    await page.getByText("No memory conflicts").waitFor();
    assert(resolutions[1].action === "delete_both", "delete-both resolution was not sent");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Memory conflicts" }).waitFor();
    await page.getByText("Learner confirmed this preference").waitFor();
    assert((await page.locator("[data-memory-conflict-audit] > *").count()) === 2, "audit did not survive reload");
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);
    console.log("PASS memory conflicts: evidence + merge + delete both + audit reload");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL memory conflicts:", error);
  process.exit(1);
});
