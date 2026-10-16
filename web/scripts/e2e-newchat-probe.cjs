/* E2E: clicking "New chat" must cancel the active turn, clear the
 * transcript, and bind the next message to a different backend session. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const API = process.env.API_URL || "http://127.0.0.1:8002";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
const STOP = 'button[aria-label="Stop generating"]';

function monitorApiFailures(page) {
  const failures = [];
  page.on("response", (response) => {
    const url = response.url();
    if (url.startsWith(BASE) && new URL(url).pathname.startsWith("/api/") && response.status() >= 400) {
      failures.push(`${response.request().method()} ${new URL(url).pathname} → ${response.status()}`);
    }
  });
  return failures;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sessionIdFromUrl(url) {
  const match = new URL(url).pathname.match(/^\/home\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await (await browser.newContext()).newPage();
    const apiFailures = monitorApiFailures(page);

    await page.goto(BASE + "/home", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);

    async function sendAndWaitForSession(text) {
      const ta = page.locator("textarea").first();
      await ta.click();
      await ta.fill(text);
      await page.keyboard.press("Enter");
      await page.waitForSelector(STOP, { timeout: 15_000 });
      await page.waitForFunction(
        () => /^\/home\/[^/]+$/.test(window.location.pathname),
        null,
        { timeout: 15_000, polling: 100 },
      );
      const sessionId = sessionIdFromUrl(page.url());
      assert(sessionId, `message did not bind to a backend session: ${page.url()}`);
      return sessionId;
    }

    const firstSessionId = await sendAndWaitForSession(
      "Write a detailed explanation of the history of algebra in at least 1500 words.",
    );

    await page.getByRole("button", { name: "New chat" }).click();
    await page.waitForFunction(
      () =>
        window.location.pathname === "/home" &&
        !document.querySelector("main .prose-cognivoy") &&
        !document.querySelector('button[aria-label="Stop generating"]'),
      null,
      { timeout: 10_000, polling: 100 },
    );

    let firstStatus = "";
    const cancelDeadline = Date.now() + 10_000;
    while (Date.now() < cancelDeadline) {
      const response = await fetch(
        `${API}/api/v1/sessions/${encodeURIComponent(firstSessionId)}`,
      );
      assert(response.ok, `session lookup failed: HTTP ${response.status}`);
      firstStatus = (await response.json()).status || "";
      if (firstStatus === "cancelled") break;
      await page.waitForTimeout(200);
    }
    assert(
      firstStatus === "cancelled",
      `old turn was not cancelled after New chat (status=${firstStatus || "unknown"})`,
    );

    const secondSessionId = await sendAndWaitForSession(
      "Say the word BRAVO and nothing else.",
    );
    assert(
      secondSessionId !== firstSessionId,
      `New chat reused backend session ${firstSessionId}`,
    );

    const stop = page.locator(STOP);
    if (await stop.isVisible()) {
      await stop.click();
      await stop.waitFor({ state: "hidden", timeout: 10_000 });
    }
    assert(apiFailures.length === 0, `API failures: ${apiFailures.slice(0, 5).join("; ")}`);

    console.log(
      `PASS new-chat isolation: ${firstSessionId} (cancelled) -> ${secondSessionId}`,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL new-chat isolation:", error);
  process.exit(1);
});
