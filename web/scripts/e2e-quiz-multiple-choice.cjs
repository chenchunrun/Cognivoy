/* Focused browser contract for true multi-select quiz grading and durable retry. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const submissions = [];
  let saveAttempt = 0;

  try {
    await page.route("**/api/v1/sessions/e2e-multiple-choice", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "e2e-multiple-choice",
          session_id: "e2e-multiple-choice",
          title: "Multiple choice set semantics",
          status: "completed",
          preferences: { capability: "deep_question", tools: [], knowledge_bases: [] },
          messages: [
            {
              id: 1,
              role: "user",
              content: "Select every prime number.",
              capability: "deep_question",
              parent_message_id: null,
            },
            {
              id: 2,
              role: "assistant",
              content: "",
              capability: "deep_question",
              parent_message_id: 1,
              events: [
                {
                  type: "result",
                  source: "deep_question",
                  stage: "generation",
                  content: "",
                  turn_id: "turn-multiple-choice",
                  timestamp: 1,
                  metadata: {
                    summary: {
                      results: [
                        {
                          qa_pair: {
                            question_id: "prime-set",
                            question: "Which values are prime numbers?",
                            question_type: "multiple_choice",
                            options: { A: "2", B: "4", C: "5", D: "9" },
                            correct_answer: "A,C",
                            explanation: "2 and 5 have exactly two positive divisors.",
                            difficulty: "easy",
                            knowledge_points: ["prime numbers"],
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
    await page.route("**/api/v1/sessions/e2e-multiple-choice/quiz-results", async (route) => {
      const payload = route.request().postDataJSON();
      submissions.push(payload);
      saveAttempt += 1;
      if (saveAttempt === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: "transient write failure" }),
        });
        return;
      }
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

    await page.goto(`${BASE}/home/e2e-multiple-choice`, { waitUntil: "domcontentloaded" });
    const viewer = page.locator('[data-testid="quiz-viewer"]');
    await viewer.waitFor({ state: "visible" });
    const choices = viewer.getByRole("checkbox");
    assert((await choices.count()) === 4, "multiple-choice question did not render four checkboxes");

    await choices.nth(0).click();
    assert((await choices.nth(0).getAttribute("aria-checked")) === "true", "A was not selected");
    assert((await choices.nth(1).getAttribute("aria-checked")) === "false", "B was unexpectedly selected");
    await viewer.getByText("Draft saved", { exact: false }).waitFor();

    await page.reload({ waitUntil: "domcontentloaded" });
    await viewer.waitFor({ state: "visible" });
    assert(
      (await choices.nth(0).getAttribute("aria-checked")) === "true",
      "unsubmitted answer draft was lost after refresh",
    );
    assert(
      (await choices.nth(2).getAttribute("aria-checked")) === "false",
      "refresh restored an option that the learner never selected",
    );
    await choices.nth(2).click();
    assert((await choices.nth(2).getAttribute("aria-checked")) === "true", "C was not selected");

    await viewer.locator('[data-testid="quiz-submit-answer"]').click();
    await viewer.getByText("Correct", { exact: true }).waitFor();
    await viewer.getByText("Save failed", { exact: false }).waitFor();

    await viewer.getByRole("button", { name: "Try again" }).click();
    await choices.nth(0).click();
    await choices.nth(2).click();
    await viewer.locator('[data-testid="quiz-submit-answer"]').click();
    await viewer.getByText("Saved", { exact: false }).waitFor();

    assert(submissions.length === 2, `expected two save attempts, got ${submissions.length}`);
    for (const payload of submissions) {
      assert(payload.turn_id === "turn-multiple-choice", "quiz result lost its producing turn");
      assert(payload.answers?.length === 1, "quiz result did not contain exactly one answer");
      assert(payload.answers[0].question_type === "multiple_choice", "question type collapsed to radio");
      assert(payload.answers[0].user_answer === "A,C", "selected answer set was not normalized");
      assert(payload.answers[0].is_correct === true, "exact answer set was not graded correct");
      assert(typeof payload.submission_id === "string" && payload.submission_id.length > 8, "missing submission id");
    }
    assert(
      submissions[0].submission_id === submissions[1].submission_id,
      "retry generated a new submission id instead of preserving idempotency",
    );
    // The first HTTP 503 is intentional and Chrome reports it as a console
    // resource error. Unhandled browser exceptions remain release failures.
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);

    console.log("PASS quiz multiple choice: draft refresh → set grading → failed write → idempotent retry");
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
