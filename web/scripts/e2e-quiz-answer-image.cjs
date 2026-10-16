/* Browser contract: handwritten answer image → judge → durable refresh. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVtQAAAAASUVORK5CYII=",
  "base64",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  let saved = null;
  let resultPosts = 0;
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    class MockJudgeWebSocket {
      static OPEN = 1;
      readyState = 0;
      constructor() {
        window.setTimeout(() => {
          this.readyState = 1;
          this.onopen?.({});
        }, 0);
      }
      send(raw) {
        window.__answerImageJudgePayload = JSON.parse(raw);
        const frames = [
          { type: "text", content: "✅ The handwritten derivation is correct." },
          {
            type: "done",
            assessment: {
              verdict: "correct",
              confidence: 0.95,
              score: 4,
              max_score: 4,
              review_recommended: false,
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
        return new MockJudgeWebSocket();
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

  const sessionBody = {
    id: "e2e-answer-image",
    session_id: "e2e-answer-image",
    title: "Handwritten answer",
    status: "completed",
    preferences: { capability: "deep_question", tools: [], knowledge_bases: [] },
    messages: [
      { id: 1, role: "user", content: "Solve it", capability: "deep_question" },
      {
        id: 2,
        role: "assistant",
        content: "",
        capability: "deep_question",
        events: [
          {
            type: "result",
            source: "deep_question",
            turn_id: "turn-answer-image",
            metadata: {
              summary: {
                results: [
                  {
                    qa_pair: {
                      question_id: "written-1",
                      question: "Show your derivation.",
                      question_type: "written",
                      correct_answer: "A valid derivation.",
                      explanation: "Steps should be justified.",
                      rubric: { max_score: 4 },
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
  };

  await page.route("**/api/v1/sessions/e2e-answer-image/quiz-results", async (route) => {
    resultPosts += 1;
    saved = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        recorded: true,
        history_message_created: resultPosts === 1,
        duplicate_submission: resultPosts > 1,
        proactive_job_ids: [],
      }),
    });
  });
  await page.route("**/api/v1/sessions/e2e-answer-image", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(sessionBody) }),
  );
  await page.route("**/api/v1/question-notebook/entries/lookup/by-question?**", (route) => {
    if (!saved) return route.fulfill({ status: 204, body: "" });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: 91,
        session_id: "e2e-answer-image",
        session_title: "Handwritten answer",
        turn_id: "turn-answer-image",
        question_id: "written-1",
        question: "Show your derivation.",
        question_type: "written",
        options: {},
        correct_answer: "A valid derivation.",
        explanation: "Steps should be justified.",
        difficulty: "medium",
        user_answer: "See my working",
        user_answer_images: [
          {
            id: "persisted-image",
            url: "/api/attachments/e2e-answer-image/persisted-image/working.png",
            filename: "working.png",
            mime_type: "image/png",
          },
        ],
        is_correct: true,
        bookmarked: false,
        followup_session_id: "",
        knowledge_points: [],
        source_refs: [],
        rubric: { max_score: 4 },
        attempt_count: 1,
        correct_streak: 1,
        incorrect_streak: 0,
        review_interval_days: 1,
        review_status: "scheduled",
        recommended_difficulty: "medium",
        created_at: 1,
        updated_at: 1,
        categories: [],
      }),
    });
  });
  await page.route("**/api/attachments/e2e-answer-image/**", (route) =>
    route.fulfill({ contentType: "image/png", body: PNG }),
  );
  await page.route("**/api/v1/question-notebook/categories", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/v1/dashboard/recent**", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"entries":[]}' }),
  );

  try {
    await page.goto(`${BASE}/home/e2e-answer-image`, { waitUntil: "domcontentloaded" });
    const viewer = page.locator('[data-testid="quiz-viewer"]');
    await viewer.waitFor({ state: "visible" });
    await viewer.getByRole("textbox", { name: "Your answer" }).fill("See my working");
    await viewer.getByLabel("Attach answer image").setInputFiles({
      name: "working.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await viewer.locator('[data-testid="quiz-answer-images"] img').waitFor();
    await viewer.locator('[data-testid="quiz-submit-answer"]').click();
    await viewer.getByText("Saved", { exact: false }).waitFor();

    const judgePayload = await page.evaluate(() => window.__answerImageJudgePayload);
    assert(judgePayload.user_answer_images.length === 1, "judge did not receive image");
    assert(Boolean(judgePayload.user_answer_images[0].base64), "judge image lost bytes");
    assert(saved.answers[0].user_answer_images.length === 1, "result did not persist image");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="quiz-answer-images"] img[alt="working.png"]').waitFor();
    await page.getByText("Correct", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    assert(resultPosts === 1, "refresh re-submitted an already durable quiz result");
    console.log("PASS quiz answer image: upload → multimodal judge → durable refresh");
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
