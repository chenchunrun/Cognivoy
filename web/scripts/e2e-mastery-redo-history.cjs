/* E2E contract: a destructive mastery redo must remain auditable and the
 * learner must be able to restore the archived progress from the UI. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await (await browser.newContext()).newPage();
    let restoreCalls = 0;

    await page.route("**/api/v1/learning/progress", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          summaries: [{
            book_id: "path-1",
            name: "Algebra path",
            modules_count: 2,
            kp_count: 2,
            current_stage: "practice",
            avg_mastery_pct: 40,
            due_reviews: 0,
            evidence_count: 5,
            current_streak_days: 3,
            updated_at: 2,
          }],
          errors: [],
        }),
      }),
    );
    await page.route("**/api/v1/learning/progress/path-1/map", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          book_id: "path-1",
          next: {
            action: "practice",
            knowledge_point_name: "Linear equations",
            knowledge_point_type: "concept",
            status: "learning",
            mastery: 0.4,
            threshold: 0.8,
            reason: "Practice",
          },
          map: {
            counts: { mastered: 0, learning: 1, new: 1, total: 2 },
            due_reviews: 0,
            mastery_score_version: "v1-recency-gate",
            evidence_count: 5,
            current_streak_days: 3,
            edges: [{ from: "m1", to: "m2" }],
            complete: false,
            modules: [{
              id: "m1",
              name: "Module 1",
              order: 1,
              depends_on: [],
              locked: false,
              mastered: 0,
              total: 1,
              knowledge_points: [{
                id: "kp1",
                name: "Linear equations",
                type: "concept",
                status: "learning",
                mastery: 0.4,
                evidence_count: 5,
                recent_evidence: { hints_used: 1 },
                reason: "More evidence required",
              }],
            }, {
              id: "m2",
              name: "Quadratic equations",
              order: 2,
              depends_on: ["m1"],
              locked: true,
              mastered: 0,
              total: 1,
              knowledge_points: [{
                id: "kp2",
                name: "Quadratic formula",
                type: "procedure",
                status: "new",
                mastery: 0,
                evidence_count: 0,
                recent_evidence: null,
                reason: "More evidence required",
              }],
            }],
          },
        }),
      }),
    );
    await page.route("**/api/v1/learning/progress/path-1/redo-history", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          book_id: "path-1",
          items: [{
            id: "audit-1",
            book_id: "path-1",
            reason: "Start over",
            created_at: 1_784_000_000,
            source_version: 7,
            mastery_count: 3,
            attempt_count: 5,
            error_count: 2,
            restore_count: 0,
            last_restored_at: null,
          }],
        }),
      }),
    );
    await page.route("**/api/v1/learning/progress/path-1/redo/audit-1/restore", (route) => {
      restoreCalls += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "ok", audit_id: "audit-1", progress: {} }),
      });
    });
    await page.route("**/api/v1/dashboard/recent**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) }),
    );

    await page.goto(`${BASE}/space/learning`, { waitUntil: "domcontentloaded" });
    await page.getByText("Reset history", { exact: true }).waitFor();
    await page.getByText("3 day streak", { exact: true }).waitFor();
    await page.getByText("5 evidence records", { exact: true }).waitFor();
    await page.getByText("Prerequisites: Module 1", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Quadratic equations" }).waitFor();
    await page.getByText(/5 attempts/).waitFor();
    await page.getByRole("button", { name: "Restore this progress" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restore" }).click();
    await page.getByText("Progress restored", { exact: true }).waitFor();
    assert(restoreCalls === 1, `expected one restore request, got ${restoreCalls}`);

    console.log("PASS mastery redo history: archive summary → confirm → restore → refresh");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL mastery redo history:", error);
  process.exit(1);
});
