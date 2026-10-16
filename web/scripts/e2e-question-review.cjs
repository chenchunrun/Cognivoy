/* E2E contract: question-review dashboard links to a shareable real review
 * schedule, and combined notebook filters reach the backend unchanged. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const entry = {
  id: 1,
  session_id: "quiz-session",
  session_title: "Algebra practice",
  turn_id: "quiz-turn",
  question_id: "q1",
  question: "Solve x + 2 = 5",
  question_type: "short_answer",
  options: {},
  correct_answer: "x = 3",
  explanation: "Subtract two from both sides.",
  difficulty: "medium",
  user_answer: "x = 2",
  user_answer_images: [],
  is_correct: false,
  bookmarked: true,
  followup_session_id: "",
  ai_judgment: "",
  knowledge_points: ["linear equations"],
  source_refs: [{ type: "book", id: "page-1" }],
  rubric: { max_score: 2 },
  learning_project_id: "cisa-project",
  learning_task_id: "domain-1",
  attempt_count: 2,
  correct_streak: 0,
  incorrect_streak: 2,
  review_interval_days: 0,
  review_due_at: 1,
  last_reviewed_at: 1,
  review_status: "due",
  recommended_difficulty: "easy",
  created_at: 1,
  updated_at: 2,
  categories: [],
};

const statistics = {
  total: 3,
  correct: 1,
  incorrect: 2,
  bookmarked: 1,
  due_review: 1,
  accuracy_percent: 33,
  question_types: { short_answer: 2, choice: 1 },
  difficulties: { easy: 1, medium: 2 },
  recent_errors: [entry],
};

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.addCookies([
      { name: "cognivoy-lang", value: "en", url: BASE },
      {
        name: "dt_token",
        value: "e30.eyJleHAiOjk5OTk5OTk5OTl9.test",
        url: BASE,
      },
    ]);
    await context.addInitScript(() => {
      localStorage.setItem("cognivoy-language", "en");
      localStorage.setItem("cognivoy-response-language", "en");
    });
    const page = await context.newPage();
    const entryRequests = [];
    const allRequests = [];
    page.on("request", (request) => allRequests.push(request.url()));
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      class MockUnifiedWebSocket {
        readyState = 0;
        onopen = null;
        onmessage = null;
        onerror = null;
        onclose = null;
        constructor() {
          window.setTimeout(() => {
            this.readyState = 1;
            this.onopen?.({});
          }, 0);
        }
        send(raw) {
          const payload = JSON.parse(raw);
          if (payload.type !== "ping") window.__similarQuestionPayload = payload;
        }
        close() { this.readyState = 3; }
      }
      function SelectiveWebSocket(url, protocols) {
        window.__wsUrls = [...(window.__wsUrls || []), String(url)];
        if (String(url).includes("/api/v1/ws")) return new MockUnifiedWebSocket();
        return protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);
      }
      SelectiveWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
      SelectiveWebSocket.OPEN = NativeWebSocket.OPEN;
      SelectiveWebSocket.CLOSING = NativeWebSocket.CLOSING;
      SelectiveWebSocket.CLOSED = NativeWebSocket.CLOSED;
      SelectiveWebSocket.prototype = NativeWebSocket.prototype;
      window.WebSocket = SelectiveWebSocket;
    });

    // Keep shell-level API calls deterministic. Feature routes registered
    // below take precedence; unrelated authenticated endpoints must not turn
    // this focused journey into a login redirect.
    await page.route("**/api/v1/**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: [], total: 0 }),
      }),
    );
    await page.route(/\/api\/v1\/question-notebook\/statistics(?:\?.*)?$/, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(statistics) }),
    );
    await page.route("**/api/v1/auth/status**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ enabled: false, authenticated: true, user: null }),
      }),
    );
    await page.route("**/api/v1/question-notebook/categories", (route) =>
      route.fulfill({ contentType: "application/json", body: "[]" }),
    );
    await page.route("**/api/v1/question-notebook/entries**", (route) => {
      const url = new URL(route.request().url());
      entryRequests.push(url);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: [entry], total: 1 }),
      });
    });
    await page.route("**/api/v1/question-notebook/entries/1", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(entry) }),
    );
    await page.route("**/api/v1/dashboard/recent**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) }),
    );
    await page.route("**/api/v1/learning/projects", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            id: "cisa-project",
            title: "CISA certification",
            language: "zh",
            status: "active",
            tasks: [],
            events: [],
            knowledge_map: [],
            review_items: [],
            knowledge_base_ids: [],
            book_ids: [],
            notebook_ids: [],
            preferred_methods: [],
            weekly_plan: [],
          }],
        }),
      }),
    );

    await page.goto(`${BASE}/question-notebook?project_id=cisa-project&filter=due`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByText("Question Notebook", { exact: true }).waitFor();
    } catch {
      throw new Error(`question notebook missing at ${page.url()}: ${(await page.locator("body").innerText()).slice(0, 500)}`);
    }
    await page.getByText("Solve x + 2 = 5", { exact: true }).waitFor();
    const [mainBox, layoutBox] = await Promise.all([
      page.locator("main").boundingBox(),
      page.getByTestId("question-notebook-layout").boundingBox(),
    ]);
    assert(mainBox && layoutBox, "question notebook layout bounds are unavailable");
    assert(
      layoutBox.x - mainBox.x <= 40,
      `question notebook is not left aligned: ${layoutBox.x - mainBox.x}px inset`,
    );
    assert(
      layoutBox.width >= mainBox.width - 80,
      `question notebook does not fill the workspace: ${layoutBox.width}/${mainBox.width}px`,
    );
    await page.getByText("linear equations", { exact: true }).waitFor();
    await page.getByText("2 attempts", { exact: true }).waitFor();
    await page.getByLabel("Filter by learning plan").selectOption("cisa-project");
    await page.getByText("Learning plan practice", { exact: true }).waitFor();
    await page.getByText("CISA certification", { exact: true }).first().waitFor();

    await page.getByLabel("Search question notebook").fill("linear");
    await page.getByLabel("Filter by question type").selectOption("short_answer");
    await page.getByLabel("Filter by difficulty").selectOption("medium");
    await page.getByLabel("Filter by time").selectOption("30");
    await page.getByLabel("Filter by source").selectOption("book");
    let filtered;
    const filterDeadline = Date.now() + 8_000;
    while (!filtered && Date.now() < filterDeadline) {
      filtered = [...entryRequests].reverse().find((url) =>
        url.searchParams.get("q") === "linear" &&
        url.searchParams.get("question_type") === "short_answer" &&
        url.searchParams.get("difficulty") === "medium" &&
        url.searchParams.get("source_type") === "book" &&
        url.searchParams.get("review_status") === "due" &&
        url.searchParams.get("project_id") === "cisa-project" &&
        url.searchParams.has("updated_from"),
      );
      if (!filtered) await page.waitForTimeout(100);
    }
    assert(filtered, "combined due-review query was not sent to the backend");
    await page.getByRole("button", { name: "Generate similar question" }).click();
    try {
      await page.waitForFunction(() => Boolean(window.__similarQuestionPayload), undefined, { timeout: 8_000 });
    } catch {
      const details = await page.evaluate(() => ({
        url: location.href,
        wsUrls: window.__wsUrls || [],
        text: document.querySelector("main")?.textContent?.slice(0, 400) || "",
      }));
      throw new Error(`similar request missing: ${JSON.stringify(details)}; requests=${allRequests.filter((url) => url.includes("question-notebook")).join(",")}`);
    }
    const similar = await page.evaluate(() => window.__similarQuestionPayload);
    assert(similar.capability === "deep_question", "similar practice did not select deep_question");
    assert(similar.config?.num_questions === 1, "similar practice did not request exactly one question");
    assert(similar.config?.similar_to?.question === entry.question, "similar practice lost the source question");
    assert(similar.config?.similar_to?.source_refs?.[0]?.id === "page-1", "similar practice lost verified provenance");
    assert(similar.learning_context?.project_id === "cisa-project", "similar practice lost learning-project context");
    assert(browserErrors.length === 0, `browser errors: ${browserErrors.slice(0, 3).join("; ")}`);

    console.log("PASS question review: project context → filters → similar-question deep link");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL question review:", error);
  process.exit(1);
});
