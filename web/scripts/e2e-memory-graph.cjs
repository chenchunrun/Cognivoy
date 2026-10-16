/* Browser contract: the graph consumes one backend-structured snapshot and
 * offers searchable layer filters plus a keyboard-accessible list fallback. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const L2_ID = "m_01HZK1ABCDEFGHJKMNPQRSTVWX";
const L3_ID = "m_01HZK1ABCDEFGHJKMNPQRSTVWY";

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await (await browser.newContext()).newPage();
    const pageErrors = [];
    let graphRequests = 0;
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/v1/memory/graph", (route) => {
      graphRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: 1,
          generated_at: "2026-08-15T00:00:00Z",
          errors: [],
          l1: {
            chat: [{ id: "chat-1", label: "Calculus chat", ts: "2026-08-15T00:00:00Z", content: "Limits" }],
          },
          l2: {
            chat: { title: "Chat facts", entries: [{ id: L2_ID, section: "Style", text: "Prefers rigorous derivations", refs: ["chat:chat-1"] }] },
          },
          l3: {
            profile: { title: "Profile", entries: [{ id: L3_ID, section: "Learning", text: "Visual learner", refs: [L2_ID] }] },
            preferences: { title: "Preferences", entries: [] },
          },
        }),
      });
    });

    await page.goto(`${BASE}/memory/graph`, { waitUntil: "domcontentloaded" });
    const listViewButton = page.getByRole("button", { name: "List view" });
    // A production page can paint before React has attached the click handler.
    // Confirm the state transition instead of treating a swallowed early click
    // as an application failure.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await listViewButton.click();
      if ((await listViewButton.getAttribute("aria-pressed")) === "true") break;
      await page.waitForTimeout(250);
    }
    assert(
      (await listViewButton.getAttribute("aria-pressed")) === "true",
      "list view did not activate after hydration",
    );
    await page.getByRole("list", { name: "Memory node list" }).waitFor();
    // React Strict Mode may replay the mount effect once in development; both
    // calls must still target the single authoritative graph endpoint.
    assert(graphRequests >= 1 && graphRequests <= 2, `unexpected graph request count: ${graphRequests}`);
    assert((await page.getByText("Prefers rigorous derivations").count()) === 1, "L2 fact missing from list fallback");

    await page.getByRole("textbox", { name: "Search memory nodes" }).fill("rigorous");
    assert((await page.getByText("Visual learner").count()) === 0, "search did not filter non-matching L3 node");
    await page.getByRole("button", { name: "L2", exact: true }).click();
    await page.getByText("No matching memory").waitFor();
    await page.getByRole("button", { name: "L2", exact: true }).click();
    await page.getByText("Prefers rigorous derivations").waitFor();
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);
    console.log("PASS memory graph: backend snapshot + search/layers + list fallback");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL memory graph:", error);
  process.exit(1);
});
