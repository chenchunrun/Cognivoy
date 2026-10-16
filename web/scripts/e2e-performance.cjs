/* Browser performance budgets for the high-frequency chat path.
 * Uses a deterministic 1,000-message/100-file session so results do not depend
 * on model or backend latency. Budgets cover input paint latency, Activity
 * reveal, scroll frame rate, and warm route readiness.
 */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const NATIVE_BASE = process.env.NATIVE_BASE_URL || "";
const REQUIRE_NATIVE = /^(1|true|yes)$/i.test(process.env.REQUIRE_NATIVE_BASELINE || "");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function assertMaximum(name, value, limit, unit = "ms") {
  const display = value.toFixed(1);
  if (value > limit) throw new Error(`${name}: ${display}${unit} exceeds ${limit}${unit}`);
  console.log(`PASS ${name}: ${display}${unit} (budget ${limit}${unit})`);
}

function assertMinimum(name, value, limit, unit) {
  const display = value.toFixed(1);
  if (value < limit) throw new Error(`${name}: ${display}${unit} is below ${limit}${unit}`);
  console.log(`PASS ${name}: ${display}${unit} (budget >= ${limit}${unit})`);
}

function makeSession() {
  const messages = [];
  for (let index = 0; index < 1_000; index += 1) {
    const assistant = index % 2 === 1;
    const attachment = index % 10 === 0
      ? [{
          id: `file-${index}`,
          type: "file",
          filename: `lesson-${index}.md`,
          mime_type: "text/markdown",
          url: `/api/outputs/perf/lesson-${index}.md`,
          extracted_text: `Preview ${index}`,
          generated: index % 20 === 0,
          size_bytes: 128,
        }]
      : [];
    messages.push({
      id: index + 1,
      role: assistant ? "assistant" : "user",
      content: `${assistant ? "Explanation" : "Question"} ${index}: ` + "Fourier transforms connect time and frequency domains. ".repeat(2),
      capability: "chat",
      parent_message_id: index === 0 ? null : index,
      attachments: attachment,
      events: assistant
        ? [{
            type: "tool_call",
            source: "chat",
            stage: "exploring",
            content: "read_source",
            metadata: { tool: `read_source_${index % 5}` },
            timestamp: index,
          }]
        : [],
    });
  }
  return {
    id: "e2e-performance",
    session_id: "e2e-performance",
    title: "Large session performance",
    status: "completed",
    preferences: { capability: "chat", tools: [], knowledge_bases: [] },
    messages,
    active_turns: [],
  };
}

(async () => {
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const session = makeSession();
  let performanceSocket = null;
  let resolveStartTurn;
  let startTurn = new Promise((resolve) => { resolveStartTurn = resolve; });

  await page.routeWebSocket("**/api/v1/ws", (socket) => {
    performanceSocket = socket;
    socket.onMessage((message) => {
      const payload = JSON.parse(String(message));
      if (payload.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      } else if (payload.type === "start_turn") {
        resolveStartTurn(payload);
      }
    });
  });

  await page.route("**/api/v1/sessions/e2e-performance**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(session) }),
  );

  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
  const routeStarted = Date.now();
  await page.goto(`${BASE}/home/e2e-performance`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Ask anything…").waitFor({ state: "visible", timeout: 10_000 });
  assertMaximum("warm chat route usable", Date.now() - routeStarted, 2_000);

  const historyStarted = performance.now();
  await page.locator('[data-chat-message="assistant"]').last().waitFor({ state: "attached" });
  const count = await page.locator("[data-chat-message]").count();
  if (count !== 20) throw new Error(`large session rendered ${count}/20 initial messages`);
  const loadEarlier = page.getByRole("button", { name: /Load 50 earlier messages/ });
  await loadEarlier.waitFor({
    state: "visible",
  });
  await loadEarlier.click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-chat-message]").length >= 70,
  );
  assertMaximum("1,000-message history restored", performance.now() - historyStarted, 2_000);

  const inputLatencies = await page.getByLabel("Ask anything…").evaluate(async (element) => {
    const textarea = element;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    const samples = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      setter.call(textarea, `${textarea.value}${index % 10}`);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(index % 10) }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(performance.now() - started);
    }
    return samples;
  });
  assertMaximum("composer input-to-paint p95", percentile(inputLatencies, 0.95), 100);

  const activityButton = page.getByRole("button", { name: "Activity" });
  const activityColdStarted = performance.now();
  await activityButton.click();
  await page.getByTestId("session-activity-panel").waitFor({ state: "visible" });
  assertMaximum("Activity first open with 100 files", performance.now() - activityColdStarted, 200);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const activityOpenMs = await activityButton.evaluate(async (button) => {
    const started = performance.now();
    button.click();
    while (!document.querySelector('[data-testid="session-activity-panel"]')) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return performance.now() - started;
  });
  assertMaximum("Activity warm open with 100 files", activityOpenMs, 200);

  await page.getByRole("button", { name: "Close", exact: true }).click();
  const scrollFps = await page.locator("[data-chat-message]").first().evaluate(async (firstMessage) => {
    const scroller = firstMessage.closest(".overflow-y-auto");
    if (!scroller) throw new Error("chat scroll container not found");
    scroller.scrollTop = 0;
    let frames = 0;
    const duration = 1_000;
    const started = performance.now();
    await new Promise((resolve) => {
      const frame = (now) => {
        frames += 1;
        const progress = Math.min(1, (now - started) / duration);
        scroller.scrollTop = progress * (scroller.scrollHeight - scroller.clientHeight);
        if (progress < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    return frames;
  });
  assertMinimum("long-session scroll", scrollFps, 50, "fps");

  const streamLatencies = [];
  const composer = page.getByLabel("Ask anything…");
  await composer.fill("Measure stream paint latency");
  await composer.press("Enter");
  await startTurn;
  if (!performanceSocket) throw new Error("performance WebSocket was not connected");
  performanceSocket.send(JSON.stringify({
    type: "session",
    source: "runtime",
    stage: "",
    content: "",
    metadata: { session_id: "e2e-performance", turn_id: "perf-turn" },
    session_id: "e2e-performance",
    turn_id: "perf-turn",
    seq: 1,
    timestamp: Date.now() / 1000,
  }));
  const streamingScroller = page.locator("[data-chat-scroll]");
  await streamingScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  for (let index = 0; index < 20; index += 1) {
    const marker = `paint-${index}-${Date.now()}`;
    const started = performance.now();
    performanceSocket.send(JSON.stringify({
      type: "content",
      source: "chat",
      stage: "responding",
      content: `${marker} `,
      metadata: {},
      session_id: "e2e-performance",
      turn_id: "perf-turn",
      seq: index + 2,
      timestamp: Date.now() / 1000,
    }));
    await page.waitForFunction(
      (text) => Array.from(document.querySelectorAll('[data-chat-message="assistant"]'))
        .some((element) => element.textContent?.includes(text)),
      marker,
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    streamLatencies.push(performance.now() - started);
  }
  assertMaximum("stream event-to-paint p95", percentile(streamLatencies, 0.95), 100);

  if (NATIVE_BASE) {
    const makeRoutePage = async (base) => {
      const samplePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await samplePage.route("**/api/v1/sessions?**", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            sessions: [{
              id: session.id,
              session_id: session.session_id,
              title: session.title,
              status: session.status,
              updated_at: Date.now() / 1000,
            }],
          }),
        }),
      );
      await samplePage.route("**/api/v1/sessions/e2e-performance**", (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(session) }),
      );
      await samplePage.goto(`${base}/settings`, { waitUntil: "domcontentloaded" });
      return samplePage;
    };
    const measureRoute = async (samplePage, base) => {
      if (!samplePage.url().startsWith(`${base}/settings`)) {
        await samplePage.locator('a[href="/settings"]').first().click();
        await samplePage.waitForURL(`${base}/settings`);
      }
      const sessionLink = samplePage.getByText(session.title, { exact: true }).first();
      await sessionLink.waitFor({ state: "visible", timeout: 10_000 });
      const started = performance.now();
      await sessionLink.click();
      await samplePage.waitForURL(`${base}/home/e2e-performance`);
      await samplePage.locator(
        'textarea[placeholder*="Ask anything"], textarea[placeholder*="How can I help"], textarea[placeholder*="随便问"], textarea[placeholder*="我能如何"]',
      ).first().waitFor({
        state: "visible",
        timeout: 10_000,
      });
      return performance.now() - started;
    };
    const nativePage = await makeRoutePage(NATIVE_BASE);
    const currentPage = await makeRoutePage(BASE);
    // Warm the exact client-navigation story on both implementations before
    // collecting samples. Loading /settings alone does not compile/cache the
    // chat route, so the first measured batch otherwise compares unrelated
    // cold-start work and makes the +10% release gate depend on run order.
    for (let warmup = 0; warmup < 3; warmup += 1) {
      if (warmup % 2 === 0) {
        await measureRoute(nativePage, NATIVE_BASE);
        await measureRoute(currentPage, BASE);
      } else {
        await measureRoute(currentPage, BASE);
        await measureRoute(nativePage, NATIVE_BASE);
      }
    }
    const nativeBatches = [];
    const currentBatches = [];
    for (let batch = 0; batch < 20; batch += 1) {
      const nativeSamples = [];
      const currentSamples = [];
      for (let index = 0; index < 5; index += 1) {
        // Alternate order to avoid systematically charging warm cache, GC,
        // or scheduler drift to one frontend. Five samples let each batch
        // median filter two local-navigation outliers; P95 is then taken
        // across batches without weakening the native +10% threshold.
        if ((batch + index) % 2 === 0) {
          nativeSamples.push(await measureRoute(nativePage, NATIVE_BASE));
          currentSamples.push(await measureRoute(currentPage, BASE));
        } else {
          currentSamples.push(await measureRoute(currentPage, BASE));
          nativeSamples.push(await measureRoute(nativePage, NATIVE_BASE));
        }
      }
      nativeBatches.push(percentile(nativeSamples, 0.5));
      currentBatches.push(percentile(currentSamples, 0.5));
    }
    await Promise.all([nativePage.close(), currentPage.close()]);
    const nativeP95 = percentile(nativeBatches, 0.95);
    const currentP95 = percentile(currentBatches, 0.95);
    console.log(
      `INFO route batch medians native=[${nativeBatches.map((value) => value.toFixed(1)).join(", ")}] ` +
      `current=[${currentBatches.map((value) => value.toFixed(1)).join(", ")}]`,
    );
    assertMaximum("route P95 versus native +10%", currentP95, nativeP95 * 1.1);
  } else if (REQUIRE_NATIVE) {
    throw new Error("NATIVE_BASE_URL is required for the native parity release gate");
  } else {
    console.log("SKIP native route comparison (set NATIVE_BASE_URL to enable it)");
  }

  await browser.close();
  console.log(`\n${NATIVE_BASE ? "8/8" : "7/7"} browser performance budgets passed`);
})().catch((error) => {
  console.error(`FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
});
