/* E2E smoke: send a chat message, capture what renders (no LLM configured —
 * we expect a graceful backend error, which still exercises composer → WS →
 * session bind → event rendering → sidebar refresh). */
const { chromium } = require("@playwright/test");
const path = require("path");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

(async () => {
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const apiFailures = [];
  page.on("response", (response) => {
    const url = response.url();
    if (url.startsWith(BASE) && new URL(url).pathname.startsWith("/api/") && response.status() >= 400) {
      apiFailures.push(`${response.request().method()} ${new URL(url).pathname} → ${response.status()}`);
    }
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)));

  await page.goto(BASE + "/home", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const ta = page.locator("textarea").first();
  await ta.click();
  await ta.fill("Hello — what is 2+2?");
  await page.keyboard.press("Enter");

  // wait for the turn to settle (LLM configured — expect a streamed answer)
  await page.waitForTimeout(25000);

  const url = page.url();
  const bodyText = await page.locator("main").innerText();
  console.log("URL after send:", url);
  console.log("--- main text (first 1500 chars) ---");
  console.log(bodyText.slice(0, 1500));
  console.log("--- pageerrors:", errors.length ? errors : "none");

  await page.screenshot({ path: path.join(__dirname, "shots", "chat-after-send.png") });
  if (apiFailures.length) throw new Error(`API failures: ${apiFailures.slice(0, 5).join("; ")}`);
  await browser.close();
})();
