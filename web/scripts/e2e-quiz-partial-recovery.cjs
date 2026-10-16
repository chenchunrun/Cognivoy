/* Browser contract: keep successful quiz cards and regenerate only a failed one. */
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
  try {
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
          if (payload.type !== "ping") window.__quizRecoveryPayload = payload;
        }
        close() {
          this.readyState = 3;
        }
      }
      function SelectiveWebSocket(url, protocols) {
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
    await page.route("**/api/v1/sessions/e2e-partial-quiz*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "e2e-partial-quiz",
          session_id: "e2e-partial-quiz",
          title: "Partial quiz recovery",
          status: "completed",
          preferences: { capability: "deep_question", tools: [], knowledge_bases: [] },
          messages: [
            { id: 1, role: "user", content: "Make two questions", capability: "deep_question" },
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
                  turn_id: "turn-partial",
                  timestamp: 1,
                  metadata: {
                    summary: {
                      requested: 2,
                      completed: 1,
                      failed: 1,
                      results: [
                        {
                          qa_pair: {
                            question_id: "q-ok",
                            question: "What is 2 + 2?",
                            question_type: "choice",
                            options: { A: "3", B: "4" },
                            correct_answer: "B",
                            explanation: "2 + 2 = 4.",
                            difficulty: "easy",
                            concentration: "arithmetic",
                          },
                          metadata: {},
                        },
                        {
                          qa_pair: {
                            question_id: "q-missing",
                            question: "Question generation failed for: limits",
                            question_type: "written",
                            correct_answer: "N/A",
                            explanation: "Retry this quiz to regenerate the missing question.",
                            difficulty: "hard",
                            concentration: "limits",
                          },
                          metadata: {
                            error: "question_generation_timeout",
                            retryable: true,
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
    await page.route("**/api/v1/dashboard/recent**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ entries: [] }) }),
    );

    await page.goto(`${BASE}/home/e2e-partial-quiz`, { waitUntil: "domcontentloaded" });
    const viewer = page.locator('[data-testid="quiz-viewer"]');
    await viewer.getByRole("radio").nth(1).click();
    await viewer.locator('[data-testid="quiz-submit-answer"]').click();
    await viewer.getByText("Correct", { exact: true }).waitFor();
    await viewer.getByRole("button", { name: "Next question" }).click();
    await viewer.getByText("This question could not be generated", { exact: true }).waitFor();
    assert(await viewer.getByText("What is 2 + 2?", { exact: true }).count() === 0, "viewer did not advance to failed card");
    await viewer.getByRole("button", { name: "Regenerate missing question" }).click();
    await page.waitForFunction(() => Boolean(window.__quizRecoveryPayload));
    const payload = await page.evaluate(() => window.__quizRecoveryPayload);
    assert(payload.capability === "deep_question", "recovery did not use deep_question");
    assert(payload.config?.num_questions === 1, "recovery requested more than the missing question");
    assert(payload.config?.topic === "limits", "recovery lost the failed topic");
    assert(payload.config?.difficulty === "hard", "recovery lost the planned difficulty");
    assert(payload.config?.question_types?.[0] === "written", "recovery lost the planned type");
    console.log("PASS partial quiz: valid card retained → failed card isolated → one-question recovery");
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
