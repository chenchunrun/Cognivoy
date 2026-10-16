/* Browser contract: high-impact rebuild preview, cancel, then preserved state. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const book = {
  id: "b1",
  title: "Reliable Systems",
  description: "A test book",
  status: "ready",
  proposal: null,
  knowledge_bases: [],
  language: "en",
  page_count: 1,
  chapter_count: 1,
  created_at: 1,
  updated_at: 2,
  metadata: { page_chat_sessions: { p1: "chat-1" } },
  statistics: {
    chapter_count: 1,
    page_count: 1,
    ready_page_count: 1,
    block_count: 2,
    content_units: 10,
    code_line_count: 0,
    formula_count: 0,
    quiz_count: 0,
    interactive_count: 0,
    source_count: 0,
    estimated_reading_minutes: 1,
    visited_page_count: 1,
    reading_progress_percent: 100,
  },
};
const pageRecord = {
  id: "p1",
  book_id: "b1",
  chapter_id: "c1",
  title: "First chapter",
  learning_objectives: [],
  content_type: "theory",
  status: "ready",
  order: 0,
  blocks: [
    { id: "t1", type: "text", status: "ready", title: "", params: {}, payload: { text: "Generated content" }, source_anchors: [], metadata: {}, error: "", created_at: 1, updated_at: 1 },
    { id: "n1", type: "user_note", status: "ready", title: "", params: {}, payload: { body: "Keep this note" }, source_anchors: [], metadata: {}, error: "", created_at: 1, updated_at: 1 },
  ],
  links: [],
  parent_page_id: "",
  error: "",
  created_at: 1,
  updated_at: 1,
};
const detail = {
  book,
  spine: {
    book_id: "b1",
    chapters: [{ id: "c1", title: "Chapter one", learning_objectives: [], content_type: "theory", source_anchors: [], prerequisites: [], page_ids: ["p1"], summary: "", order: 0 }],
    version: 1,
    concept_graph: { nodes: [], edges: [] },
    exploration_summary: "",
    updated_at: 1,
  },
  pages: [pageRecord],
  progress: { book_id: "b1", current_page_id: "p1", visited_page_ids: ["p1"], bookmarked_page_ids: ["p1"], quiz_attempts: [], weak_chapters: [], score: 0, updated_at: 1 },
};

(async () => {
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  let rebuildPosts = 0;
  await page.route("**/api/v1/book/books/b1", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(detail) }),
  );
  await page.route("**/api/v1/book/books/rebuild-preview", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        book_id: "b1",
        page_count: 1,
        generated_block_count: 1,
        user_note_count: 1,
        visited_page_count: 1,
        bookmarked_page_count: 1,
        page_chat_count: 1,
        page_titles: ["First chapter"],
        preserves_user_notes: true,
        preserves_learning_state: true,
      }),
    }),
  );
  await page.route("**/api/v1/book/books/rebuild", (route) => {
    rebuildPosts += 1;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ pages: [pageRecord] }) });
  });
  const fulfillBooks = (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      books: [book], total: 1, limit: 24, offset: 0,
      summary: { total: 1, ready: 1, in_progress: 0, chapters: 1 },
    }),
  });
  await page.route("**/api/v1/book/books", fulfillBooks);
  await page.route("**/api/v1/book/books?*", fulfillBooks);
  await page.route("**/api/v1/dashboard/recent**", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"items":[]}' }),
  );

  try {
    await page.goto(`${BASE}/book`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("book-card").getByTestId("book-open").click();
    const rebuild = page.getByRole("button", { name: "Rebuild book" });
    await rebuild.waitFor();
    await rebuild.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(/1 pages and 1 generated blocks will be replaced/).waitFor();
    await dialog.getByText(/1 notes, reading progress, bookmarks, and page chats will be preserved/).waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    assert(rebuildPosts === 0, "cancel unexpectedly started a rebuild");

    await rebuild.click();
    await dialog.getByText(/1 pages and 1 generated blocks will be replaced/).waitFor();
    await dialog.getByRole("button", { name: "Rebuild", exact: true }).click();
    await page.getByText("Keep this note", { exact: true }).waitFor();
    assert(rebuildPosts === 1, "confirmed rebuild was not sent exactly once");
    console.log("PASS book rebuild: impact preview → cancel → confirm → user note retained");
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
