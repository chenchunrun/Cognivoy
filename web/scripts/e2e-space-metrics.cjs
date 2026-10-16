/* Browser contract: every Learning Space metric loads independently. A failed
 * source must expose an explicit unknown state and retry only its own request,
 * while successful cards keep their count and latest activity timestamp. */
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
    const pageErrors = [];
    let questionRequests = 0;
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route("**/api/v1/sessions/stats", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ total: 1, updated_at: 1_786_742_400 }),
      }),
    );
    await page.route("**/api/v1/imports/chat-history**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions: [] }) }),
    );
    await page.route("**/api/v1/subagents/connections", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [] }) }),
    );
    await page.route("**/api/v1/notebook/list", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          notebooks: [
            {
              id: "notebook-1",
              name: "Notes",
              description: "",
              color: "#c98a2d",
              icon: "book",
              record_count: 1,
              created_at: 1_786_700_000,
              updated_at: 1_786_740_000,
            },
          ],
        }),
      }),
    );
    await page.route("**/api/v1/question-notebook/entries*", (route) => {
      questionRequests += 1;
      if (questionRequests === 1) {
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: "temporary question store outage" }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [{ id: 7, question: "Recovered question", updated_at: 1_786_741_000 }],
          total: 7,
          limit: 1,
          offset: 0,
        }),
      });
    });
    await page.route("**/api/v1/learning/progress", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ summaries: [], errors: [] }),
      }),
    );
    await page.route("**/api/v1/personas/list", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ personas: [] }) }),
    );
    await page.route("**/api/v1/skills/list", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ skills: [] }) }),
    );
    await page.route("**/api/v1/space/mcp/servers", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ servers: {} }) }),
    );
    await page.route("**/api/v1/space/cli-apps/apps", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ apps: [] }) }),
    );

    await page.goto(`${BASE}/space`, { waitUntil: "domcontentloaded" });
    const chatCard = page.locator("article").filter({ hasText: "Chat History" });
    const questionCard = page.locator("article").filter({ hasText: "Question Bank" });

    await chatCard.getByText("1", { exact: true }).waitFor();
    await chatCard.getByText(/Last activity/).waitFor();
    await questionCard.getByText("Temporarily unable to load statistics").waitFor({ timeout: 5_000 }).catch(async () => {
      throw new Error(
        `question failure state missing after ${questionRequests} request(s): ${await questionCard.innerText()}`,
      );
    });
    assert(questionRequests === 1, `initial render made ${questionRequests} question requests`);
    assert(
      await chatCard.getByText("1", { exact: true }).isVisible(),
      "one failed metric erased a successful sibling",
    );

    await page.getByRole("button", { name: "Retry Question Bank statistics" }).click();
    await questionCard.getByText("7", { exact: true }).waitFor();
    await questionCard.getByText(/Last activity/).waitFor();
    assert(questionRequests === 2, `retry made ${questionRequests} question requests instead of 2`);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);

    console.log("PASS space metrics: isolated failure + explicit retry + latest activity");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL space metrics:", error);
  process.exit(1);
});
