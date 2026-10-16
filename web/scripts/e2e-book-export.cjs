/* Browser contract: the reader prepares every chapter in a body-level,
 * print-only document and invokes the native print/PDF flow. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const statistics = {
  chapter_count: 2, page_count: 2, ready_page_count: 2, block_count: 2,
  content_units: 1200, code_line_count: 8, formula_count: 0, quiz_count: 0,
  interactive_count: 0, source_count: 0, estimated_reading_minutes: 6,
  visited_page_count: 0, reading_progress_percent: 0,
};

const book = {
  id: "print-e2e", title: "Agent Engineering", description: "From design to production",
  status: "ready", proposal: null, knowledge_bases: [], language: "en",
  page_count: 2, chapter_count: 2, created_at: 1, updated_at: 2,
  metadata: {}, statistics,
};

function pageData(id, title, order) {
  return {
    id, book_id: book.id, chapter_id: `chapter-${order}`, title,
    learning_objectives: [`Understand ${title}`], content_type: "theory",
    status: "ready", order, links: [], parent_page_id: "", error: "",
    created_at: 1, updated_at: 2,
    blocks: [{
      id: `block-${order}`, type: "text", status: "ready", title: "",
      params: {}, payload: { body: `Complete printable content for ${title}.` },
      source_anchors: [], metadata: {}, error: "", created_at: 1, updated_at: 2,
    }],
  };
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem("language", "en");
    localStorage.setItem("cognivoy.language", "en");
    window.print = () => { window.__bookPrintCalled = true; };
  });

  const pages = [pageData("page-1", "Foundations", 1), pageData("page-2", "Production", 2)];
  const requestedPortableFormats = [];
  const fulfillBooks = (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ books: [book], total: 1, limit: 24, offset: 0,
      summary: { total: 1, ready: 1, in_progress: 0, chapters: 2 } }),
  });
  await page.route("**/api/v1/book/books", fulfillBooks);
  await page.route("**/api/v1/book/books?*", fulfillBooks);
  await page.route("**/api/v1/book/books/print-e2e/export?*", (route) => {
    const format = new URL(route.request().url()).searchParams.get("format");
    requestedPortableFormats.push(format);
    const isEpub = format === "epub";
    return route.fulfill({
      status: 200,
      contentType: isEpub ? "application/epub+zip" : "text/markdown; charset=utf-8",
      headers: {
        "Content-Disposition": `attachment; filename*=UTF-8''Agent-Engineering.${isEpub ? "epub" : "md"}`,
      },
      body: isEpub ? Buffer.from("PK\u0003\u0004portable-edition") : "# Agent Engineering\n\nComplete edition\n",
    });
  });
  await page.route("**/api/v1/book/books/print-e2e", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      book,
      spine: { book_id: book.id, version: 1, updated_at: 2, chapters: [
        { id: "chapter-1", title: "Foundations", learning_objectives: [], content_type: "theory", source_anchors: [], prerequisites: [], page_ids: ["page-1"], summary: "", order: 1 },
        { id: "chapter-2", title: "Production", learning_objectives: [], content_type: "theory", source_anchors: [], prerequisites: [], page_ids: ["page-2"], summary: "", order: 2 },
      ] },
      pages,
      progress: { book_id: book.id, current_page_id: "page-1", visited_page_ids: [], bookmarked_page_ids: [], quiz_attempts: [], weak_chapters: [], score: 0, updated_at: 2 },
      statistics,
    }),
  }));
  await page.route("**/api/v1/book/books/page-visit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      progress: { book_id: book.id, current_page_id: "page-1", visited_page_ids: ["page-1"], bookmarked_page_ids: [], quiz_attempts: [], weak_chapters: [], score: 0, updated_at: 3 },
    }),
  }));

  try {
    await page.goto(`${BASE}/book`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("book-open").click();
    const reader = page.locator("article.book-reading");
    await reader.waitFor();
    const readerStyle = await reader.locator(".prose-cognivoy").first().evaluate((element) => ({
      fontSize: getComputedStyle(element).fontSize,
      lineHeight: getComputedStyle(element).lineHeight,
    }));
    assert(Number.parseFloat(readerStyle.fontSize) >= 17, "book body typography is still chat-sized");
    assert(Number.parseFloat(readerStyle.lineHeight) >= 30, "book body line height is too tight");

    await page.getByTestId("book-export-pdf").click();
    const exportDialog = page.getByRole("dialog");
    await exportDialog.getByRole("heading", { name: "PDF export settings" }).waitFor();
    await exportDialog.getByLabel("Edition").selectOption("print");
    await exportDialog.getByLabel("Paper size").selectOption("A4");
    await exportDialog.getByLabel("Body font").selectOption("serif");
    await exportDialog.getByLabel("Page header").fill("Cognivoy Learning Edition");
    await exportDialog.getByLabel("Page footer").fill("Agent Engineering");
    await exportDialog.getByRole("button", { name: "Open print dialog" }).click();
    await page.waitForFunction(() => window.__bookPrintCalled === true);
    const printDocument = page.getByTestId("book-print-document");
    assert(await printDocument.count() === 1, "print document was not mounted under body");
    assert(
      await printDocument.evaluate((element) => element.parentElement === document.body),
      "print document is constrained by the workspace shell",
    );
    const printableText = await printDocument.innerText();
    assert(printableText.includes("Foundations"), "first chapter is missing from PDF");
    assert(printableText.includes("Production"), "last chapter is missing from PDF");
    assert(printableText.includes("Contents"), "PDF table of contents is missing");

    const [epubDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("book-export-epub").click(),
    ]);
    assert(epubDownload.suggestedFilename() === "Agent-Engineering.epub", "EPUB filename is incorrect");
    const [markdownDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("book-export-markdown").click(),
    ]);
    assert(markdownDownload.suggestedFilename() === "Agent-Engineering.md", "Markdown filename is incorrect");
    assert(
      requestedPortableFormats.join(",") === "epub,markdown",
      `portable export requests are incorrect: ${requestedPortableFormats.join(",")}`,
    );

    await page.emulateMedia({ media: "print" });
    assert(
      (await page.locator(".book-print-portal").evaluate((element) => getComputedStyle(element).display)) === "block",
      "print portal is not visible in print media",
    );
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    assert(pdf.subarray(0, 5).toString() === "%PDF-", "browser did not produce a valid PDF");
    assert(pdf.length > 10_000, "generated PDF is unexpectedly empty");
    assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
    console.log("PASS book export: complete PDF + EPUB + Markdown editions, readable typography, print CSS");
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL book export:", error);
  process.exit(1);
});
