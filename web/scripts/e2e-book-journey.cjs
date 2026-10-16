/* Full Living Book browser story with deterministic backend contracts. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
function assert(condition, message) { if (!condition) throw new Error(message); }

const book = {
  id: "journey-book", title: "Linear Algebra Journey", description: "Learn vectors", status: "draft",
  proposal: null, knowledge_bases: [], language: "en", page_count: 0, chapter_count: 0,
  created_at: 1, updated_at: 1, metadata: {},
  statistics: { chapter_count: 0, page_count: 0, ready_page_count: 0, block_count: 0, content_units: 0, code_line_count: 0, formula_count: 0, quiz_count: 0, interactive_count: 0, source_count: 0, estimated_reading_minutes: 0, visited_page_count: 0, reading_progress_percent: 0 },
};
const proposal = { title: book.title, description: book.description, scope: "Vectors", target_level: "beginner", estimated_chapters: 2, rationale: "Build concepts progressively" };
const spine = {
  book_id: book.id, version: 1, updated_at: 1, exploration_summary: "",
  concept_graph: { nodes: [], edges: [] },
  chapters: [
    { id: "c1", title: "Vectors", learning_objectives: ["Understand vectors"], content_type: "theory", source_anchors: [], prerequisites: [], page_ids: ["p1"], summary: "Vector basics", order: 0 },
    { id: "c2", title: "Matrices", learning_objectives: ["Use matrices"], content_type: "theory", source_anchors: [], prerequisites: ["c1"], page_ids: ["p2"], summary: "Matrix basics", order: 1 },
  ],
};
const baseBlock = (id, type, payload) => ({ id, type, status: "ready", title: "", params: {}, payload, source_anchors: [], metadata: {}, error: "", created_at: 1, updated_at: 1 });
const pages = [
  { id: "p1", book_id: book.id, chapter_id: "c1", title: "Vectors", learning_objectives: ["Understand vectors"], content_type: "theory", status: "pending", order: 0, blocks: [], links: [], parent_page_id: "", error: "", created_at: 1, updated_at: 1 },
  { id: "p2", book_id: book.id, chapter_id: "c2", title: "Matrices", learning_objectives: ["Use matrices"], content_type: "theory", status: "pending", order: 1, blocks: [], links: [], parent_page_id: "", error: "", created_at: 1, updated_at: 1 },
];
const progress = { book_id: book.id, current_page_id: "p1", visited_page_ids: [], bookmarked_page_ids: [], quiz_attempts: [], weak_chapters: [], score: 0, updated_at: 1 };
let books = [];
let quizAttempts = 0;
let moves = 0;
let pageChatBindings = 0;
let pageChatPayload = null;

function compile(pageId) {
  const page = pages.find((item) => item.id === pageId);
  page.status = "ready";
  if (pageId === "p1") {
    page.blocks = [
      baseBlock("text-1", "text", { body: "A vector has magnitude and direction." }),
      baseBlock("quiz-1", "quiz", { questions: [{ question_id: "vq1", question: "Which is a vector?", question_type: "choice", options: { A: "Velocity", B: "Temperature" }, correct_answer: "A", explanation: "Velocity has direction." }] }),
    ];
  } else {
    page.blocks = [baseBlock("text-2", "text", { body: "Matrices represent linear maps." })];
  }
}

function detail() {
  book.page_count = pages.length;
  book.chapter_count = spine.chapters.length;
  book.statistics = { ...book.statistics, chapter_count: 2, page_count: 2, ready_page_count: pages.filter((p) => p.status === "ready").length, block_count: pages.reduce((n, p) => n + p.blocks.length, 0), content_units: 14, quiz_count: 1, estimated_reading_minutes: 2, visited_page_count: progress.visited_page_ids.length, reading_progress_percent: progress.visited_page_ids.length * 50 };
  return { book, spine, pages, progress };
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    class MockSocket {
      static OPEN = 1;
      readyState = 0;
      constructor(url) { this.url = String(url); setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
      send(raw) {
        const message = JSON.parse(raw);
        if (this.url.includes("/api/v1/book/ws")) {
          let frame;
          if (message.type === "create") frame = { type: "create_result", book: window.__journeyBook, proposal: window.__journeyProposal };
          else if (message.type === "confirm_proposal") frame = { type: "confirm_proposal_result", book: { ...window.__journeyBook, status: "spine_ready" }, spine: window.__journeySpine };
          else if (message.type === "compile_page") { window.__compiledPage = message.page_id; frame = { type: "compile_page_result", page: { id: message.page_id } }; }
          else if (message.type === "regenerate_block") { window.__regeneratedBlock = message.block_id; frame = { type: "regenerate_block_result", block: { id: message.block_id } }; }
          setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), 5);
          return;
        }
        window.__pageChatPayload = message;
        const frames = [
          { type: "session", metadata: { session_id: "page-chat-1" }, session_id: "page-chat-1" },
          { type: "content", content: "A vector combines magnitude and direction." },
          { type: "done" },
        ];
        frames.forEach((frame, index) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), index * 10));
      }
      close() { this.readyState = 3; this.onclose?.({}); }
    }
    function SelectiveWebSocket(url, protocols) {
      const target = String(url);
      if (target.includes("/api/v1/book/ws") || target.includes("/api/v1/ws")) {
        return new MockSocket(url);
      }
      return protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
    }
    Object.assign(SelectiveWebSocket, {
      CONNECTING: NativeWebSocket.CONNECTING,
      OPEN: NativeWebSocket.OPEN,
      CLOSING: NativeWebSocket.CLOSING,
      CLOSED: NativeWebSocket.CLOSED,
    });
    SelectiveWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = SelectiveWebSocket;
  });
  await page.addInitScript(({ book, proposal, spine }) => {
    window.__journeyBook = book; window.__journeyProposal = proposal; window.__journeySpine = spine;
  }, { book, proposal, spine });

  const fulfillBooks = (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        books, total: books.length, limit: 24, offset: 0,
        summary: {
          total: books.length,
          ready: books.filter((item) => item.status === "ready").length,
          in_progress: books.filter((item) => item.status !== "ready").length,
          chapters: books.reduce((sum, item) => sum + (item.chapter_count || 0), 0),
        },
      }),
    });
  };
  await page.route("**/api/v1/book/books", fulfillBooks);
  await page.route("**/api/v1/book/books?*", fulfillBooks);
  await page.route("**/api/v1/book/books/journey-book", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(detail()) }),
  );
  await page.route("**/api/v1/book/books/confirm-spine", (route) => {
    book.status = "compiling"; books = [book];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ pages }) });
  });
  await page.route("**/api/v1/book/books/quiz-attempt", (route) => {
    quizAttempts += 1; progress.quiz_attempts.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ progress }) });
  });
  await page.route("**/api/v1/book/books/insert-block", (route) => {
    const inserted = baseBlock("note-1", "user_note", { body: "Persistent learner note" });
    pages[0].blocks.push(inserted);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ block: inserted }) });
  });
  await page.route("**/api/v1/book/books/move-block", (route) => {
    moves += 1; const body = route.request().postDataJSON(); const p = pages.find((item) => item.id === body.page_id); const old = p.blocks.findIndex((item) => item.id === body.block_id); const [item] = p.blocks.splice(old, 1); p.blocks.splice(body.new_position, 0, item);
    return route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
  });
  await page.route("**/api/v1/book/books/page-chat-session", (route) => {
    pageChatBindings += 1; const body = route.request().postDataJSON(); book.metadata.page_chat_sessions = { ...(book.metadata.page_chat_sessions || {}), [body.page_id]: body.session_id };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ book }) });
  });
  await page.route("**/api/v1/book/books/supplement", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ block: baseBlock("supplement", "callout", { text: "Review vectors" }) }) }),
  );
  for (const pattern of ["**/api/v1/knowledge/list**", "**/api/v1/notebooks**", "**/api/v1/question-notebook/categories**", "**/api/v1/sessions/recent**", "**/api/v1/dashboard/recent**"]) {
    await page.route(pattern, (route) => route.fulfill({ contentType: "application/json", body: pattern.includes("knowledge") ? "[]" : pattern.includes("categories") ? "[]" : pattern.includes("sessions") ? '{"sessions":[]}' : pattern.includes("dashboard") ? '{"items":[]}' : '{"notebooks":[]}' }));
  }

  try {
    await page.goto(`${BASE}/book`, { waitUntil: "domcontentloaded" });
    const newBookButton = page.getByRole("button", { name: "New book" }).first();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "New book");
      return Boolean(button && Object.keys(button).some((key) => key.startsWith("__reactProps")));
    });
    await newBookButton.click();
    const intentInput = page.locator("#book-intent");
    try {
      await intentInput.waitFor({ timeout: 10_000 });
    } catch {
      throw new Error(`book creator did not open; ${browserErrors.join("; ")}: ${(await page.locator("body").innerText()).slice(0, 1200)}`);
    }
    await intentInput.fill("Teach linear algebra from vectors to matrices");
    await page.getByRole("button", { name: "Draft proposal" }).click();
    await page.getByLabel("Title").waitFor();
    books = [book];
    await page.getByRole("button", { name: "Confirm and build outline" }).click();
    await page.getByLabel("Chapter 1 title").waitFor();
    await page.getByRole("button", { name: "Confirm outline and compile" }).click();
    try {
      await page.getByRole("heading", { name: "Vectors", exact: true }).waitFor();
    } catch (error) {
      const diagnostic = await page.getByRole("heading", { name: "Vectors", exact: true }).evaluate((node) => {
        const chain = [];
        let current = node;
        while (current && chain.length < 8) {
          const style = getComputedStyle(current);
          const rect = current.getBoundingClientRect();
          chain.push({ tag: current.tagName, className: current.className, display: style.display, visibility: style.visibility, opacity: style.opacity, width: rect.width, height: rect.height });
          current = current.parentElement;
        }
        return chain;
      });
      throw new Error(`${error.message}; visibility diagnostic: ${JSON.stringify(diagnostic)}`);
    }
    compile("p1");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="book-card"]');
      return Boolean(card && Object.keys(card).some((key) => key.startsWith("__reactProps")));
    });
    await page.getByTestId("book-card").getByTestId("book-open").click();
    try {
      await page.getByText("A vector has magnitude and direction.").waitFor({ timeout: 10_000 });
    } catch {
      throw new Error(`compiled first page did not render: ${(await page.locator("body").innerText()).slice(-1600)}`);
    }

    await page.getByRole("button", { name: /A\. Velocity/ }).click();
    await page.getByRole("button", { name: "Reveal answer" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Answer: A"));
    assert(quizAttempts === 1, "quiz attempt was not recorded");

    await page.getByLabel("Insert block").selectOption("user_note");
    await page.getByText("Persistent learner note").waitFor();
    await page.getByRole("button", { name: "Move up" }).last().click();
    assert(moves === 1, "block move was not recorded");

    await page.getByRole("button", { name: "Page Chat" }).click();
    await page.getByPlaceholder("Ask about this page…").fill("What is a vector?");
    // The Next.js development indicator occupies the same bottom-right pixels
    // as this button. Submit the real form so React receives the same event
    // without routing the pointer through dev-only chrome.
    await page.getByPlaceholder("Ask about this page…").evaluate((input) => {
      input.closest("form")?.requestSubmit();
    });
    await page.waitForFunction(() => Boolean(window.__pageChatPayload));
    await page.getByText("A vector combines magnitude and direction.").waitFor();
    pageChatPayload = await page.evaluate(() => window.__pageChatPayload);
    assert(pageChatPayload.book_references?.[0]?.page_ids?.[0] === "p1", "page chat lost page reference");
    assert(pageChatBindings === 1, "page chat session was not persisted");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="book-card"]');
      return Boolean(card && Object.keys(card).some((key) => key.startsWith("__reactProps")));
    });
    await page.getByTestId("book-card").getByTestId("book-open").click();
    await page.getByText("Persistent learner note").waitFor();
    console.log("PASS book journey: create → proposal → outline → compile → quiz → insert/move → page chat → refresh");
  } finally {
    await page.close(); await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
