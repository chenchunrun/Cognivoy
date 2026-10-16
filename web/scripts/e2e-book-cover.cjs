/* Browser contract: book without cover → generate → persistent cover card. */
const { chromium } = require("@playwright/test");
const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
function assert(condition, message) { if (!condition) throw new Error(message); }

(async () => {
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  let generated = false;
  let generateCalls = 0;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem("language", "en");
    localStorage.setItem("cognivoy.language", "en");
  });
  const book = () => ({
    id: "cover-e2e", title: "AI Systems", description: "A practical guide", status: "ready",
    proposal: null, knowledge_bases: [], language: "en", page_count: 2, chapter_count: 2,
    created_at: 1, updated_at: generated ? 3 : 2,
    metadata: generated ? { cover_url: "/api/v1/book/books/cover-e2e/cover" } : {},
    statistics: { chapter_count: 2, page_count: 2, ready_page_count: 2, block_count: 4, content_units: 1200, code_line_count: 0, formula_count: 0, quiz_count: 1, interactive_count: 0, source_count: 2, estimated_reading_minutes: 5, visited_page_count: 0, reading_progress_percent: 0 },
  });
  const fulfillBooks = (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      books: [book()], total: 1, limit: 24, offset: 0,
      summary: { total: 1, ready: 1, in_progress: 0, chapters: 2 },
    }),
  });
  await page.route("**/api/v1/book/books", fulfillBooks);
  await page.route("**/api/v1/book/books?*", fulfillBooks);
  await page.route("**/api/v1/book/books/cover-e2e/cover/generate", (route) => {
    generateCalls += 1; generated = true;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ cover_url: "/api/v1/book/books/cover-e2e/cover", mime_type: "image/svg+xml", source: "generated" }) });
  });
  await page.route("**/api/v1/book/books/cover-e2e/cover?*", (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#c65d32"/></svg>',
  }));
  await page.route("**/api/v1/book/books/cover-e2e/stage-reviews", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ book_id: "cover-e2e", version: 0, reviews: [] }),
  }));
  await page.route("**/api/v1/book/books/cover-e2e", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      book: book(),
      spine: { book_id: "cover-e2e", chapters: [{ id: "chapter-1", title: "Foundations", order: 0 }] },
      pages: [{
        id: "overview-1", book_id: "cover-e2e", chapter_id: "chapter-1",
        title: "Book overview", content_type: "overview", status: "ready",
        learning_objectives: ["Understand the book"], blocks: [], order: 0,
      }],
      progress: {
        book_id: "cover-e2e", current_page_id: "overview-1", visited_page_ids: [],
        bookmarked_page_ids: [], quiz_attempts: [], weak_chapters: [], score: 0, updated_at: 3,
      },
      statistics: book().statistics,
    }),
  }));
  await page.route("**/api/v1/book/books/page-visit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      progress: {
        book_id: "cover-e2e", current_page_id: "overview-1", visited_page_ids: ["overview-1"],
        bookmarked_page_ids: [], quiz_attempts: [], weak_chapters: [], score: 0, updated_at: 3,
      },
    }),
  }));
  try {
    await page.goto(`${BASE}/book`, { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("book-card").filter({ hasText: "AI Systems" });
    await card.waitFor();
    await card.getByRole("button", { name: "Generate cover for AI Systems" }).click();
    await card.getByTestId("book-library-cover").waitFor();
    assert((await card.getByTestId("book-library-cover").getAttribute("src"))?.endsWith("?v=3"), "library cover is not revisioned");
    await card.getByRole("button", { name: "View cover for AI Systems" }).click();
    const preview = page.getByTestId("book-cover-preview");
    await preview.waitFor();
    const dialog = page.getByRole("dialog");
    assert(
      await dialog.evaluate((element) => element.parentElement?.parentElement === document.body),
      "cover preview must be portaled outside the transformed book card",
    );
    const dialogBox = await dialog.boundingBox();
    assert(dialogBox && dialogBox.width >= 800, "cover dialog is still constrained by the book card");
    const previewBox = await preview.boundingBox();
    assert(previewBox && previewBox.height >= 500, "large cover preview is too small");
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
    await card.getByTestId("book-open").click();
    await page.getByTestId("book-sidebar-cover").waitFor();
    await page.getByTestId("book-overview-cover").waitFor();
    await page.getByRole("button", { name: "View cover for AI Systems" }).first().click();
    await page.getByTestId("book-cover-preview").waitFor();
    await page.getByRole("button", { name: "Close" }).click();
    assert(generateCalls === 1, "cover generation endpoint was not called once");
    assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
    console.log("PASS book cover: library → revision refresh → reader sidebar + overview");
  } finally {
    await page.close(); await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
