/* E2E: exercise every capability chain through the real UI.
 *
 * For each case: guard against a lingering stream, open a fresh chat
 * (sidebar "New chat") and wait for the transcript to clear, pick the
 * capability from the composer's "Learning mode" dropdown, send the prompt,
 * confirm the user bubble landed, watch the streaming stage label advance,
 * wait for the turn to settle (Stop button disappears), then judge:
 *   pass = substantive assistant content (answer / chart / questions).
 *          A gracefully rendered error is still a failed capability chain.
 *
 * Configure BASE_URL and API_URL for an isolated installation with real
 * providers; the defaults are localhost ports 3783 and 8002.
 *
 * Usage: node scripts/e2e-capabilities.cjs   (from web/)
 */
const { chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const { assertCompleteResearchResult } = require("./research-acceptance.cjs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const API = process.env.API_URL || "http://127.0.0.1:8002";
const E2E_MODEL = process.env.E2E_MODEL || "";
const SHOTS = path.join(__dirname, "shots");
const RESULTS_DIR = path.join(__dirname, "..", "test-results");
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
fs.mkdirSync(SHOTS, { recursive: true });

const STOP_BTN = 'button[aria-label="Stop generating"]';

const ALL_CASES = [
  {
    name: "chat",
    menuLabel: "Chat",
    badge: null, // default chat shows no capability badge
    prompt: "What is the capital of France?",
    timeoutMs: 120_000,
    expectVisual: false,
  },
  {
    name: "deep_solve",
    menuLabel: "Deep Solve",
    badge: "Deep Solve",
    prompt: "Solve x^2 - 5x + 6 = 0",
    timeoutMs: 240_000,
    expectVisual: false,
  },
  {
    name: "visualize",
    menuLabel: "Visualize",
    badge: "Visualize",
    prompt: "Draw a bar chart of the populations of the 5 largest countries",
    timeoutMs: 240_000,
    expectVisual: true,
  },
  {
    name: "deep_question",
    menuLabel: "Practice Questions",
    badge: "Practice Questions",
    prompt: "Create practice questions about the Pythagorean theorem",
    timeoutMs: 300_000,
    expectVisual: false,
  },
  {
    name: "mastery_path",
    menuLabel: "Learning plan",
    badge: "Learning plan",
    prompt: "Teach me the quadratic formula",
    timeoutMs: 240_000,
    expectVisual: false,
  },
  {
    name: "deep_research",
    menuLabel: "Deep Research",
    badge: "Deep Research",
    prompt: "Research: what is retrieval-augmented generation?",
    // Includes the interactive planning turn plus the confirmed-outline
    // research/report turn. The client still enforces its independent
    // no-event timeout, so this larger story budget does not mask stalls.
    timeoutMs: 600_000,
    expectVisual: false,
    allowError: false,
  },
  {
    name: "math_animator",
    menuLabel: "Math Animator",
    badge: "Math Animator",
    prompt: "Animate the identity (a+b)^2 = a^2 + 2ab + b^2 with MathTex labels",
    timeoutMs: 600_000,
    expectVisual: true,
  },
];

const requestedCases = new Set(
  String(process.argv[2] || process.env.E2E_CAPABILITIES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const CASES = requestedCases.size
  ? ALL_CASES.filter((testCase) => requestedCases.has(testCase.name))
  : ALL_CASES;

if (requestedCases.size && CASES.length !== requestedCases.size) {
  const known = new Set(ALL_CASES.map((testCase) => testCase.name));
  const unknown = [...requestedCases].filter((name) => !known.has(name));
  throw new Error(`Unknown capability case(s): ${unknown.join(", ")}`);
}

/* ------------------------------------------------------------------ */

async function selectCapability(page, menuLabel) {
  await page.locator('button[aria-label="Learning mode"]').click();
  const item = page.getByRole("menuitem", { name: menuLabel });
  await item.waitFor({ state: "visible", timeout: 5000 });
  try {
    await item.click({ timeout: 8000 });
  } catch {
    // actionability flaked (observed on a cold page) — force the pick
    try {
      await item.click({ force: true, timeout: 5000 });
    } catch {
      await item.evaluate((el) => el.click());
    }
  }
}

/** Current streaming stage label, if the streaming row is on screen. */
async function readStage(page) {
  return page.evaluate(() => {
    for (const span of document.querySelectorAll("main span")) {
      const p = span.parentElement;
      if (!p) continue;
      // The streaming row: small muted div containing a spinning svg + label.
      if (
        p.classList.contains("text-muted-foreground") &&
        p.querySelector("svg.animate-spin")
      ) {
        return (span.textContent || "").trim() || null;
      }
    }
    return null;
  });
}

async function transcriptInfo(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return { text: "", hasVisual: false, badge: null };
    // Visualize/Manim results use a dedicated viewer and intentionally do
    // not render inside the Markdown `.prose-cognivoy` container. Anchor
    // all assertions to the last assistant message instead.
    const messages = [
      ...main.querySelectorAll('[data-chat-message="assistant"]'),
    ];
    const group = messages.length ? messages[messages.length - 1] : null;
    const last = group ? group.innerText : "";
    const hasVisual = !!group?.querySelector(
      '[data-visualization-viewer], [data-math-animator-viewer]',
    );
    const b = group
      ? group.querySelector("span.bg-primary-muted.rounded-full")
      : null;
    const badge = b ? (b.textContent || "").trim() : null;
    return { text: last, hasVisual, badge };
  });
}

async function backendDiagnostics() {
  try {
    const res = await fetch(`${API}/api/v1/sessions`);
    if (!res.ok) return `sessions API HTTP ${res.status}`;
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.sessions || data.items || [];
    const recent = list.slice(0, 2).map((s) =>
      JSON.stringify({
        id: s.id || s.session_id,
        title: s.title,
        updated_at: s.updated_at,
        status: s.status,
        last_turn_status: s.last_turn_status,
        error: s.error,
      }),
    );
    return recent.join("\n    ") || "(no sessions returned)";
  } catch (e) {
    return `sessions API unreachable: ${e.message}`;
  }
}

async function capabilityResultForSession(capability, sessionId) {
  if (!sessionId) throw new Error(`Current ${capability} session id is unavailable`);
  const response = await fetch(
    `${API}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) throw new Error(`session detail API HTTP ${response.status}`);
  const detail = await response.json();
  const resultEvents = (detail.messages || [])
    .filter((message) => message.capability === capability)
    .flatMap((message) => message.events || [])
    .filter((event) => event.type === "result");
  return { id: sessionId, resultEvents };
}

/** Resolve an inline ask_user pause with deterministic recommended/default
 * answers. This validates that a capability can pause and resume the same
 * turn instead of treating the intentional pause as a streaming timeout. */
async function answerPendingAskUser(page) {
  const card = page.locator('[data-ask-user-card="pending"]').last();
  if (!(await card.isVisible().catch(() => false))) return false;
  const questions = card.locator("[data-ask-user-question]");
  const count = await questions.count();
  for (let i = 0; i < count; i += 1) {
    const question = questions.nth(i);
    const option = question.locator("button").first();
    if (await option.isVisible().catch(() => false)) {
      await option.click();
    } else {
      const textarea = question.locator("textarea");
      if (await textarea.isVisible().catch(() => false)) {
        await textarea.fill("Use the recommended approach.");
      }
    }
  }
  const submit = card.getByRole("button", { name: "Submit" });
  await submit.click();
  await card.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  return true;
}

async function startPendingResearch(page) {
  const outline = page.locator('[data-research-outline="true"]').last();
  if (!(await outline.isVisible().catch(() => false))) return false;
  const start = outline.getByRole("button", { name: "Start Research" });
  if (!(await start.isEnabled().catch(() => false))) return false;
  await start.click();
  await page.waitForSelector(STOP_BTN, { timeout: 15_000 });
  return true;
}

/* ------------------------------------------------------------------ */

(async () => {
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  // Keep selectors deterministic regardless of the developer's persisted UI
  // language. Response-language behavior is covered separately by contracts.
  await page.addInitScript(() => {
    window.localStorage.setItem("cognivoy-language", "en");
    window.localStorage.setItem("cognivoy-response-language", "en");
  });

  const results = [];

  // The initial /home boot happens before the first case-specific listeners.
  // Guard it separately so auth/settings/catalog failures cannot be missed.
  const bootApiFailures = [];
  const onBootResponse = (response) => {
    const url = response.url();
    if (url.startsWith(BASE) && new URL(url).pathname.startsWith("/api/") && response.status() >= 400) {
      bootApiFailures.push(`${response.request().method()} ${new URL(url).pathname} → ${response.status()}`);
    }
  };
  const onBootRequestFailed = (request) => {
    const url = request.url();
    const message = request.failure()?.errorText || "request failed";
    if (url.startsWith(BASE) && new URL(url).pathname.startsWith("/api/") && !/ERR_ABORTED/i.test(message)) {
      bootApiFailures.push(`${request.method()} ${new URL(url).pathname} → ${message}`);
    }
  };
  page.on("response", onBootResponse);
  page.on("requestfailed", onBootRequestFailed);

  await page.goto(BASE + "/home", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  page.off("response", onBootResponse);
  page.off("requestfailed", onBootRequestFailed);
  if (bootApiFailures.length) {
    throw new Error(`Initial /home API failures: ${bootApiFailures.slice(0, 5).join("; ")}`);
  }

  if (E2E_MODEL) {
    const modelTrigger = page.locator("textarea").first().locator("xpath=..").locator("button").filter({ hasText: /GLM|GPT|Claude|Gemini/i }).first();
    await modelTrigger.click();
    const model = page.getByRole("menuitem", { name: new RegExp(`^${E2E_MODEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
    await model.waitFor({ state: "visible", timeout: 5_000 });
    await model.click();
  }

  for (const tc of CASES) {
    const startedAt = Date.now();
    const consoleErrors = [];
    const apiFailures = [];
    const stages = [];
    const onConsole = (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
    };
    const onPageError = (e) =>
      consoleErrors.push("pageerror: " + e.message.slice(0, 300));
    const onResponse = (response) => {
      const url = response.url();
      if (url.startsWith(BASE) && new URL(url).pathname.startsWith("/api/") && response.status() >= 400) {
        apiFailures.push(`${response.request().method()} ${new URL(url).pathname} → ${response.status()}`);
      }
    };
    const onRequestFailed = (request) => {
      const url = request.url();
      const message = request.failure()?.errorText || "request failed";
      if (url.startsWith(BASE) && new URL(url).pathname.startsWith("/api/") && !/ERR_ABORTED/i.test(message)) {
        apiFailures.push(`${request.method()} ${new URL(url).pathname} → ${message}`);
      }
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("response", onResponse);
    page.on("requestfailed", onRequestFailed);

    let outcome = "fail";
    let note = "";
    let timedOut = false;

    try {
      // guard: never start a case while a previous turn is still live
      if (await page.locator(STOP_BTN).isVisible().catch(() => false)) {
        note = "previous turn still streaming at case start; waited for it";
        await page
          .waitForFunction(
            () =>
              !document.querySelector('button[aria-label="Stop generating"]'),
            null,
            { timeout: 120_000, polling: 500 },
          )
          .catch(() => {
            note += " (still live after 120s — aborted case)";
            throw new Error("lingering stream");
          });
      }

      // Always start from a fresh conversation, including the first case:
      // /home may restore whichever persisted session was most recent.
      await page.getByRole("button", { name: "New chat" }).click();
      // wait until the transcript actually clears (no stale reads)
      await page.waitForFunction(
        () => !document.querySelector("main .prose-cognivoy"),
        null,
        { timeout: 10_000, polling: 200 },
      );
      await page.waitForTimeout(500);

      // pick the capability (explicit "Chat" too, in case state persisted)
      await selectCapability(page, tc.menuLabel);
      await page.waitForTimeout(300);

      if (tc.name === "deep_question") {
        const choiceOnly = page.getByRole("button", { name: "Multiple Choice" });
        if ((await choiceOnly.getAttribute("aria-pressed")) !== "true") {
          await choiceOnly.click();
        }
      }

      // composer badge confirms the selection took effect
      const composerBadgeOk = await page.evaluate((badge) => {
        const ta = document.querySelector("textarea");
        const composer = ta ? ta.closest("div.rounded-2xl") : null;
        if (!composer || !badge) return true;
        return composer.innerText.includes(badge);
      }, tc.badge);
      if (!composerBadgeOk) {
        throw new Error("composer capability badge did not update");
      }

      // send
      const ta = page.locator("textarea").first();
      await ta.click();
      await ta.fill(tc.prompt);
      await page.keyboard.press("Enter");

      // confirm the user bubble landed (send registered in this session)
      const bubbleOk = await page
        .waitForFunction(
          (prompt) => {
            const bubbles = document.querySelectorAll(
              "main .bg-primary-muted.rounded-2xl",
            );
            return [...bubbles].some((b) =>
              (b.textContent || "").includes(prompt.slice(0, 30)),
            );
          },
          tc.prompt,
          { timeout: 10_000, polling: 200 },
        )
        .then(() => true)
        .catch(() => false);
      if (!bubbleOk) throw new Error("user bubble did not appear within 10s");
      await page.waitForFunction(
        () => /^\/home\/[^/]+$/.test(window.location.pathname),
        null,
        { timeout: 10_000 },
      );
      const currentSessionId = new URL(page.url()).pathname
        .split("/")
        .filter(Boolean)
        .at(-1);
      let firstQuizCardMs = null;
      let firstQuizCardWatcher = null;
      if (tc.name === "deep_question") {
        firstQuizCardWatcher = page
          .locator('[data-testid="quiz-viewer"]')
          .last()
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(() => {
            firstQuizCardMs = Date.now() - startedAt;
          });
      }

      // wait for the turn to go live (stop button appears), then settle
      let wentLive = true;
      try {
        await page.waitForSelector(STOP_BTN, { timeout: 15_000 });
      } catch {
        wentLive = false;
      }

      if (wentLive) {
        // poll stage labels while streaming
        let lastStage = null;
        const poll = setInterval(async () => {
          try {
            const s = await readStage(page);
            if (s && s !== lastStage) {
              lastStage = s;
              stages.push(s);
            }
          } catch {}
        }, 1000);

        try {
          const deadline = Date.now() + tc.timeoutMs;
          let answeredCards = 0;
          let startedResearch = 0;
          let interactivePause = false;
          while (Date.now() < deadline) {
            const pendingAskUser = await page
              .locator('[data-ask-user-card="pending"]')
              .last()
              .isVisible()
              .catch(() => false);
            if (pendingAskUser) {
              if (tc.name === "deep_research") {
                if (await answerPendingAskUser(page)) answeredCards += 1;
                continue;
              }
              // Guided/mastery capabilities intentionally finish a teaching
              // step by pausing for the learner. Rendering the actionable
              // card is the expected terminal UI for this E2E story; cancel
              // only to release the backend turn before the next case.
              interactivePause = true;
              const stop = page.locator(STOP_BTN);
              if (await stop.isVisible().catch(() => false)) {
                await stop.click({ timeout: 5_000 });
                await stop.waitFor({ state: "hidden", timeout: 10_000 });
              }
              break;
            }
            if (startedResearch === 0 && (await startPendingResearch(page))) {
              startedResearch += 1;
              continue;
            }
            if (!(await page.locator(STOP_BTN).isVisible().catch(() => false))) {
              break;
            }
            await page.waitForTimeout(500);
          }
          if (await page.locator(STOP_BTN).isVisible().catch(() => false)) {
            throw new Error(`turn did not settle within ${tc.timeoutMs}ms`);
          }
          note = note ? note + "; turn settled" : "turn settled";
          if (answeredCards) note += `; answered ${answeredCards} ask_user card(s)`;
          if (startedResearch) note += `; started ${startedResearch} research turn(s)`;
          if (interactivePause) note += "; interactive learner prompt rendered";
        } catch (e) {
          timedOut = true;
          const msg = String(e && e.message ? e.message : e).split("\n")[0];
          note += `; settle wait ended: ${msg.slice(0, 120)}`;
          // Preserve the failure, but cancel the timed-out turn so it cannot
          // consume the next case's stream or leave a server task behind.
          const stop = page.locator(STOP_BTN);
          if (await stop.isVisible().catch(() => false)) {
            await stop.click().catch(() => {});
            await stop.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
          }
        } finally {
          clearInterval(poll);
          const s = await readStage(page).catch(() => null);
          if (s && s !== lastStage) stages.push(s);
        }
      } else {
        throw new Error("stop button never appeared");
      }

      await page.waitForTimeout(800); // let final render land

      if (tc.name === "deep_question") {
        await firstQuizCardWatcher;
        if (firstQuizCardMs == null || firstQuizCardMs > 15_000) {
          throw new Error(`first quiz card exceeded 15s (${firstQuizCardMs}ms)`);
        }
        note += `; first quiz card ${(firstQuizCardMs / 1000).toFixed(1)}s`;
        const viewer = page.locator('[data-testid="quiz-viewer"]').last();
        await viewer.waitFor({ state: "visible", timeout: 15_000 });
        let answered = 0;
        for (;;) {
          const option = viewer.getByRole("radio").first();
          if (await option.isVisible().catch(() => false)) {
            await option.click();
          } else {
            await viewer
              .getByRole("textbox", { name: "Your answer" })
              .fill("Test answer");
          }
          await viewer.locator('[data-testid="quiz-submit-answer"]').click();
          const answerResult = viewer.locator('[data-testid="quiz-answer-result"]');
          await answerResult.waitFor({ state: "visible" });
          // Subjective questions (including a recovery card)
          // are graded over a second real model stream. Do not advance while
          // that stream is pending: QuizViewer intentionally owns one judge
          // connection, so starting another answer early would cancel the
          // first judgment and leave the quiz permanently unsaveable.
          await answerResult
            .locator("svg.animate-spin")
            .waitFor({ state: "detached", timeout: 120_000 })
            .catch(() => {
              throw new Error("quiz answer grading did not settle within 120s");
            });
          answered += 1;
          const next = viewer.getByRole("button", { name: "Next question" });
          if (!(await next.isEnabled())) break;
          await next.click();
        }
        await viewer.getByText(/Saved/).waitFor({ state: "visible", timeout: 15_000 });
        note += `; answered, graded, and persisted ${answered} quiz question(s)`;
      }

      if (tc.name === "deep_solve") {
        const settled = await capabilityResultForSession("deep_solve", currentSessionId);
        if (!settled || settled.resultEvents.length !== 1) {
          throw new Error(`Deep Solve emitted ${settled?.resultEvents.length || 0} RESULT events`);
        }
        const result = settled.resultEvents[0];
        if (result.source !== "deep_solve" || !result.metadata?.verification) {
          throw new Error("Deep Solve final RESULT lacks verifier settlement");
        }
        note += "; verifier settled one authoritative result";
      }

      if (tc.name === "deep_research") {
        const settled = await capabilityResultForSession("deep_research", currentSessionId);
        const coverage = assertCompleteResearchResult(settled?.resultEvents.at(-1));
        note += `; evidence channels ${coverage.observed.join(",") || "none configured"}`;
      }

      const info = await transcriptInfo(page);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const hasContent = info.text.trim().length > 20;
      const looksLikeError =
        /error|failed|not configured|unavailable|couldn't/i.test(info.text) &&
        info.text.length < 800;

      if (timedOut) {
        outcome = "fail";
      } else if (tc.expectVisual && info.hasVisual) {
        outcome = "pass";
      } else if (hasContent && (!looksLikeError || tc.allowError)) {
        if (tc.expectVisual && !info.hasVisual) {
          outcome = "fail";
          note += "; content present but no svg/canvas visual found";
        } else {
          outcome = looksLikeError ? "error-rendered" : "pass";
        }
      } else if (looksLikeError && tc.allowError) {
        outcome = "error-rendered";
      } else {
        outcome = "fail";
        note +=
          `; assistant text len=${info.text.trim().length}` +
          (looksLikeError ? " (error text)" : "");
      }
      if (tc.badge && info.badge !== tc.badge) {
        outcome = "fail";
        note += `; message badge=${JSON.stringify(info.badge)} (expected ${tc.badge})`;
      }
      if (consoleErrors.length > 0) {
        outcome = "fail";
        note += `; ${consoleErrors.length} browser console/page error(s)`;
      }
      if (apiFailures.length > 0) {
        outcome = "fail";
        note += `; API failures: ${apiFailures.slice(0, 3).join("; ")}`;
      }

      // Native-parity story: every completed conversation exposes its
      // conversation-level activity index, including a deterministic empty
      // state for capabilities that did not call tools or produce files.
      const activityButton = page.getByRole("button", { name: "Activity" });
      await activityButton.waitFor({ state: "visible", timeout: 10_000 });
      await activityButton.click();
      const activityPanel = page.locator('[data-testid="session-activity-panel"]');
      await activityPanel.waitFor({ state: "visible", timeout: 10_000 });
      const activityText = (await activityPanel.innerText()).trim();
      if (!activityText) {
        outcome = "fail";
        note += "; session activity panel rendered empty";
      } else {
        note += "; session activity opened";
      }
      await activityPanel.getByRole("button", { name: "Close" }).click();
      await activityPanel.waitFor({ state: "hidden", timeout: 10_000 });

      results.push({
        name: tc.name,
        outcome,
        elapsed: `${elapsed}s`,
        stages: stages.length
          ? stages.join(" → ")
          : wentLive
            ? "(no label)"
            : "(never live)",
        answerPreview: info.text.replace(/\s+/g, " ").slice(0, 140),
        visual: info.hasVisual,
        consoleErrors,
        apiFailures,
        note,
      });

      if (outcome === "fail") {
        results[results.length - 1].backendDiag = await backendDiagnostics();
      }
    } catch (e) {
      results.push({
        name: tc.name,
        outcome: "fail",
        elapsed: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        stages: stages.join(" → ") || "-",
        answerPreview: "",
        visual: false,
        consoleErrors,
        apiFailures,
        note: `script-level error: ${String(e && e.message ? e.message : e).split("\n")[0].slice(0, 200)}`,
        backendDiag: await backendDiagnostics(),
      });
    }

    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
    await page.screenshot({
      path: path.join(SHOTS, `cap-${tc.name}.png`),
      fullPage: false,
    });
  }

  await browser.close();

  /* ------------------------------ report ------------------------------ */
  console.log("\n==================== E2E CAPABILITY REPORT ====================");
  for (const r of results) {
    console.log(`\n[${r.outcome.toUpperCase()}] ${r.name}  (${r.elapsed})`);
    console.log(`  stages : ${r.stages}`);
    console.log(`  answer : ${r.answerPreview || "(empty)"}`);
    if (r.visual) console.log(`  visual : svg/canvas rendered`);
    if (r.note) console.log(`  note   : ${r.note}`);
    if (r.backendDiag) console.log(`  backend: ${r.backendDiag}`);
    if (r.consoleErrors.length) {
      console.log(`  console errors (${r.consoleErrors.length}):`);
      for (const e of [...new Set(r.consoleErrors)]) console.log(`    - ${e}`);
    }
  }
  console.log("\n---------------- summary ----------------");
  console.log("case            outcome         elapsed   visual  stages");
  for (const r of results) {
    console.log(
      `${r.name.padEnd(15)} ${r.outcome.padEnd(15)} ${r.elapsed.padEnd(9)} ${String(r.visual).padEnd(7)} ${r.stages.slice(0, 60)}`,
    );
  }
  const failed = results.filter((r) => r.outcome === "fail").length;
  console.log(
    `\n${results.length - failed}/${results.length} cases OK (${failed} failed)`,
  );
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS_DIR, "e2e-capabilities.json"),
    JSON.stringify({ baseUrl: BASE, apiUrl: API, results }, null, 2) + "\n",
  );
  process.exit(failed ? 1 : 0);
})();
