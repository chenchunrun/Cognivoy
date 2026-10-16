/* Read-only release sweep: every directly addressable app route must render
 * without same-origin API 4xx/5xx responses, failed requests, page errors, or
 * React/browser console errors. Dynamic routes are covered by e2e-pages. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

const ROUTES = [
  "/", "/about", "/admin/users", "/home", "/book", "/co-writer", "/knowledge", "/login", "/memory",
  "/memory/conflicts",
  "/memory/graph", "/memory/l1", "/memory/l2", "/memory/l3",
  "/memory/resolve", "/memory/resources", "/memory/settings", "/notebook", "/partners",
  "/partners/new", "/partners/reminders", "/playground", "/profile", "/question-notebook", "/register",
  "/settings", "/settings/agents", "/settings/appearance",
  "/settings/capabilities", "/settings/chat", "/settings/document-parsing",
  "/settings/embedding", "/settings/image", "/settings/llm", "/settings/mcp",
  "/settings/memory", "/settings/mineru", "/settings/network",
  "/settings/search", "/settings/status", "/settings/stt", "/settings/tools",
  "/settings/tts", "/settings/video", "/space", "/space/agents",
  "/space/chat-history", "/space/cli-apps", "/space/learning", "/space/mcp",
  "/space/notebooks", "/space/personas", "/space/questions", "/space/skills",
];

(async () => {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const results = [];

  for (const route of ROUTES) {
    const page = await context.newPage();
    const failures = [];
    page.on("response", (response) => {
      const url = response.url();
      if (url.startsWith(BASE) && new URL(url).pathname.startsWith("/api/") && response.status() >= 400) {
        failures.push(`${response.request().method()} ${new URL(url).pathname} → ${response.status()}`);
      }
    });
    page.on("requestfailed", (request) => {
      const url = request.url();
      const message = request.failure()?.errorText || "request failed";
      if (url.startsWith(BASE) && new URL(url).pathname.startsWith("/api/") && !/ERR_ABORTED/i.test(message)) {
        failures.push(`${request.method()} ${new URL(url).pathname} → ${message}`);
      }
    });
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`console.error: ${message.text()}`);
    });
    try {
      const response = await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (!response || response.status() >= 400) failures.push(`document ${route} → ${response?.status() || "no response"}`);
      await page.waitForTimeout(900);
      if ((await page.locator("body").innerText()).trim().length < 20) failures.push("page body is blank");
      const mermaidErrors = await page.locator("svg").evaluateAll((svgs) =>
        svgs.filter((svg) => /Syntax error in text/i.test(svg.textContent || "")).length,
      );
      if (mermaidErrors) failures.push(`${mermaidErrors} leaked Mermaid error diagram(s)`);
    } catch (error) {
      failures.push(error.message);
    }
    results.push({ route, failures });
    console.log(`${failures.length ? "FAIL" : "PASS"} ${route}${failures.length ? ` — ${failures.slice(0, 3).join("; ")}` : ""}`);
    await page.close();
  }

  await browser.close();
  const failed = results.filter((result) => result.failures.length);
  console.log(`\n${ROUTES.length - failed.length}/${ROUTES.length} routes passed; ${failed.reduce((sum, result) => sum + result.failures.length, 0)} failure(s)`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error("FATAL route sweep:", error);
  process.exit(2);
});
