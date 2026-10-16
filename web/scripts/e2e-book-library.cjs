/* E2E contract: book-library cards render authoritative statistics and the
 * user can combine status filtering with progress sorting. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function book(id, title, status, progress, minutes, updatedAt) {
  return {
    id,
    title,
    description: `${title} description`,
    status,
    proposal: null,
    knowledge_bases: [],
    language: "en",
    page_count: 4,
    chapter_count: 2,
    created_at: 1,
    updated_at: updatedAt,
    metadata: {},
    statistics: {
      chapter_count: 2,
      page_count: 4,
      ready_page_count: 4,
      block_count: 10,
      content_units: id === "b2" ? 1_200 : 800,
      code_line_count: 12,
      formula_count: 3,
      quiz_count: 4,
      interactive_count: 1,
      source_count: 6,
      estimated_reading_minutes: minutes,
      visited_page_count: Math.round((progress / 100) * 4),
      reading_progress_percent: progress,
    },
  };
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await (await browser.newContext()).newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });

    const allBooks = [
      book("b1", "Algebra Basics", "ready", 20, 8, 30),
      book("b2", "Advanced Geometry", "ready", 80, 20, 20),
      book("b3", "Draft Physics", "draft", 0, 0, 40),
    ];
    const browseRequests = [];
    const fulfillBooks = (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get("status") || "all";
      const sort = url.searchParams.get("sort") || "recent";
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 24);
      browseRequests.push({ status, sort, offset, limit });
      const filtered = allBooks.filter((item) => status === "all" || item.status === status);
      filtered.sort((left, right) => {
        if (sort === "progress") {
          return right.statistics.reading_progress_percent - left.statistics.reading_progress_percent;
        }
        return right.updated_at - left.updated_at;
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          books: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
          summary: {
            total: filtered.length,
            ready: filtered.filter((item) => item.status === "ready").length,
            in_progress: filtered.filter((item) => item.status !== "ready").length,
            chapters: filtered.reduce((sum, item) => sum + item.chapter_count, 0),
          },
        }),
      });
    };
    await page.route("**/api/v1/book/books", fulfillBooks);
    await page.route("**/api/v1/book/books?*", fulfillBooks);
    await page.route("**/api/v1/dashboard/recent**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) }),
    );

    await page.goto(`${BASE}/book`, { waitUntil: "domcontentloaded" });
    const cards = page.getByTestId("book-card");
    await cards.first().waitFor();
    assert(await cards.count() === 3, "expected all books before filtering");
    const algebra = page.locator('[data-book-id="b1"]');
    assert((await algebra.innerText()).includes("800 words / characters"), "content length missing");
    assert((await algebra.innerText()).includes("~8 min"), "reading time missing");
    assert((await algebra.innerText()).includes("4 quizzes"), "quiz count missing");
    assert((await algebra.innerText()).includes("6 sources"), "source count missing");
    assert((await algebra.getAttribute("aria-valuenow")) === null, "progress belongs on inner bar");
    assert(
      (await algebra.getByRole("progressbar").getAttribute("aria-valuenow")) === "20",
      "authoritative progress missing",
    );

    await page.getByLabel("Filter books by status").selectOption("ready");
    await page.getByLabel("Sort books").selectOption("progress");
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-testid="book-card"]')];
      return rows.length === 2 && rows[0]?.getAttribute("data-book-id") === "b2";
    });
    assert(await cards.count() === 2, "status filter did not hide draft books");
    assert(
      browseRequests.some((request) => request.status === "ready" && request.sort === "progress"),
      "filter and sort were not sent to the server",
    );
    assert(browserErrors.length === 0, `browser errors: ${browserErrors.slice(0, 3).join("; ")}`);

    console.log("PASS book library: authoritative stats + status filter + progress sort");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL book library:", error);
  process.exit(1);
});
