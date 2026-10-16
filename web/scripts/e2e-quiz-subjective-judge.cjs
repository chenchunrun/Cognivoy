/* Browser contract for structured subjective grading and review guidance. */
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
  const page = await browser.newPage();
  const diagnostics = [];
  const sessionRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/sessions")) sessionRequests.push(request.url());
  });
  page.on("pageerror", (error) => diagnostics.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });
  let saved = null;
  try {
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      class MockJudgeWebSocket {
        static OPEN = 1;
        readyState = 0;
        onopen = null;
        onmessage = null;
        onerror = null;
        onclose = null;
        constructor(url) {
          this.url = String(url);
          window.setTimeout(() => {
            this.readyState = 1;
            this.onopen?.({});
          }, 0);
        }
        send(raw) {
          window.__judgePayload = JSON.parse(raw);
          const frames = [
            { type: "started" },
            { type: "text", content: "⚠️ Partially correct — the method is sound but one justification is missing.\n" },
            { type: "text", content: "Add the definition that makes the final implication valid." },
            {
              type: "done",
              assessment: {
                verdict: "partial",
                confidence: 0.68,
                score: 2.5,
                max_score: 4,
                review_recommended: true,
              },
            },
          ];
          frames.forEach((frame, index) =>
            window.setTimeout(
              () => this.onmessage?.({ data: JSON.stringify(frame) }),
              index * 10,
            ),
          );
        }
        close() {
          this.readyState = 3;
        }
      }
      function SelectiveWebSocket(url, protocols) {
        if (String(url).includes("/api/v1/question/judge")) {
          return new MockJudgeWebSocket(url);
        }
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
    await page.route("**/api/v1/sessions/e2e-subjective-judge*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "e2e-subjective-judge",
          session_id: "e2e-subjective-judge",
          title: "Structured subjective judge",
          status: "completed",
          preferences: { capability: "deep_question", tools: [], knowledge_bases: [] },
          messages: [
            { id: 1, role: "user", content: "Prove the claim", capability: "deep_question" },
            {
              id: 2,
              role: "assistant",
              content: "",
              capability: "deep_question",
              events: [
                {
                  type: "result",
                  source: "deep_question",
                  stage: "generation",
                  content: "",
                  turn_id: "turn-subjective",
                  timestamp: 1,
                  metadata: {
                    summary: {
                      results: [
                        {
                          qa_pair: {
                            question_id: "proof-1",
                            question: "Explain why the implication holds.",
                            question_type: "written",
                            correct_answer: "Use the definition and show both required conditions.",
                            explanation: "A complete proof must cite the definition.",
                            difficulty: "hard",
                            knowledge_points: ["proof construction"],
                            rubric: {
                              max_score: 4,
                              criteria: ["correct definition", "valid implication"],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          ],
          active_turns: [],
        }),
      }),
    );
    await page.route("**/api/v1/sessions/e2e-subjective-judge/quiz-results", async (route) => {
      saved = route.request().postDataJSON();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          recorded: true,
          history_message_created: true,
          duplicate_submission: false,
          proactive_job_ids: [],
        }),
      });
    });
    await page.route("**/api/v1/question-notebook/categories", (route) =>
      route.fulfill({ contentType: "application/json", body: "[]" }),
    );
    await page.route("**/api/v1/question-notebook/entries/lookup/by-question?**", (route) =>
      route.fulfill({ status: 204, body: "" }),
    );
    await page.route("**/api/v1/dashboard/recent**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ entries: [] }) }),
    );

    await page.goto(`${BASE}/home/e2e-subjective-judge`, { waitUntil: "domcontentloaded" });
    const viewer = page.locator('[data-testid="quiz-viewer"]');
    try {
      await viewer.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      const main = await page.locator("main").innerText().catch(() => "(no main)");
      throw new Error(`quiz viewer missing; requests=${sessionRequests.join(",")}; ${diagnostics.join("; ")}; main=${main.slice(0, 500)}`);
    }
    await viewer.getByRole("textbox", { name: "Your answer" }).fill("The implication follows directly.");
    await viewer.locator('[data-testid="quiz-submit-answer"]').click();
    await viewer.getByText("AI assessment", { exact: true }).waitFor();
    await viewer.getByText("Confidence: 68%", { exact: true }).waitFor();
    await viewer.getByText("Score: 2.5/4", { exact: true }).waitFor();
    await viewer.getByText("Review recommended", { exact: true }).waitFor();
    await viewer.getByText("Saved", { exact: false }).waitFor();

    const judgePayload = await page.evaluate(() => window.__judgePayload);
    assert(judgePayload.rubric?.max_score === 4, "rubric was not sent to the judge");
    assert(saved?.answers?.[0]?.rubric?.max_score === 4, "rubric was not persisted with the result");
    assert(saved?.answers?.[0]?.is_correct === false, "partial verdict was incorrectly treated as correct");
    console.log("PASS subjective quiz: rubric → streamed assessment → confidence/review → persistence");
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
