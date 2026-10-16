/* E2E contract: chat-history controls must send search, capability, and
 * relative-time filters to the REST API before rendering matching results. */
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
    const context = await browser.newContext();
    const page = await context.newPage();
    const sessionRequests = [];
    const browserErrors = [];

    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });

    await page.route("**/api/v1/sessions?**", (route) => {
      const url = new URL(route.request().url());
      sessionRequests.push(url);
      const filtered =
        url.searchParams.get("q") === "algebra" &&
        url.searchParams.get("capability") === "deep_solve" &&
        Boolean(url.searchParams.get("updated_from"));
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: filtered ? "filtered" : "initial",
              session_id: filtered ? "filtered" : "initial",
              title: filtered ? "Filtered algebra lesson" : "Initial lesson",
              created_at: 1,
              updated_at: Math.floor(Date.now() / 1000),
              message_count: 2,
              last_message: "A session result",
              preferences: { capability: filtered ? "deep_solve" : "chat" },
            },
          ],
        }),
      });
    });
    await page.route("**/api/v1/dashboard/recent**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) }),
    );

    await page.goto(`${BASE}/space/chat-history`, { waitUntil: "domcontentloaded" });
    const main = page.getByRole("main");
    await main.getByText("Initial lesson", { exact: true }).waitFor();

    await page.getByLabel("Search chat history").fill("algebra");
    await page.getByLabel("Filter by capability").selectOption("deep_solve");
    const beforeTimeSelection = Math.floor(Date.now() / 1000);
    await page.getByLabel("Filter by time").selectOption("7");
    await main.getByText("Filtered algebra lesson", { exact: true }).waitFor();

    const filteredRequest = [...sessionRequests].reverse().find((url) =>
      url.searchParams.get("q") === "algebra" &&
      url.searchParams.get("capability") === "deep_solve" &&
      url.searchParams.has("updated_from"),
    );
    assert(filteredRequest, "combined session filter request was not sent");
    assert(filteredRequest.searchParams.get("limit") === "200", "filter request lost limit");
    assert(filteredRequest.searchParams.get("offset") === "0", "filter request lost offset");
    const updatedFrom = Number(filteredRequest.searchParams.get("updated_from"));
    const sevenDays = 7 * 24 * 60 * 60;
    assert(
      updatedFrom >= beforeTimeSelection - sevenDays - 2 &&
        updatedFrom <= Math.floor(Date.now() / 1000) - sevenDays + 2,
      `unexpected relative time boundary: ${updatedFrom}`,
    );
    assert(browserErrors.length === 0, `browser errors: ${browserErrors.slice(0, 3).join("; ")}`);

    console.log("PASS session filters: search + capability + relative time → REST query");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL session filters:", error);
  process.exit(1);
});
