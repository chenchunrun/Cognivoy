/* Release gate: every page component is audited with axe-core at desktop,
 * tablet, mobile and dark-theme desktop sizes. Dynamic pages use stable
 * placeholder ids so their loading/error surfaces are audited too. */
const { chromium } = require("@playwright/test");
const axe = require("axe-core");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

const ROUTES = [
  "/", "/about", "/admin/users", "/book", "/co-writer", "/co-writer/accessibility-audit",
  "/home", "/knowledge", "/login", "/memory", "/memory/conflicts", "/memory/graph",
  "/memory/l1", "/memory/l2", "/memory/l2/chat", "/memory/l3", "/memory/l3/profile",
  "/memory/resolve", "/memory/resources", "/memory/settings", "/notebook", "/partners",
  "/partners/accessibility-audit", "/partners/new", "/partners/reminders", "/playground",
  "/profile", "/question-notebook", "/register", "/settings", "/settings/agents",
  "/settings/agents/kimi", "/settings/appearance", "/settings/capabilities", "/settings/chat",
  "/settings/document-parsing", "/settings/embedding", "/settings/image", "/settings/llm",
  "/settings/mcp", "/settings/memory", "/settings/mineru", "/settings/network",
  "/settings/search", "/settings/status", "/settings/stt", "/settings/tools", "/settings/tts",
  "/settings/video", "/space", "/space/agents", "/space/chat-history", "/space/cli-apps",
  "/space/learning", "/space/learning/accessibility-audit", "/space/mcp", "/space/notebooks", "/space/personas", "/space/questions",
  "/space/skills",
];

const SCENARIOS = [
  { name: "desktop-light", viewport: { width: 1280, height: 800 }, theme: "light" },
  { name: "tablet-light", viewport: { width: 768, height: 1024 }, theme: "light" },
  { name: "mobile-light", viewport: { width: 390, height: 844 }, theme: "light" },
  { name: "desktop-dark", viewport: { width: 1280, height: 800 }, theme: "dark" },
];

function describeViolation(violation) {
  const nodes = violation.nodes.slice(0, 2).map((node) => node.target.join(" ")).join(", ");
  return `${violation.id} (${violation.impact || "unknown"}): ${nodes}`;
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  const failures = [];
  try {
    for (const scenario of SCENARIOS) {
      const context = await browser.newContext({
        viewport: scenario.viewport,
        reducedMotion: "reduce",
        colorScheme: scenario.theme,
      });
      await context.addInitScript({ content: axe.source });
      await context.addInitScript(({ theme }) => {
        localStorage.setItem("cognivoy-theme", theme);
      }, { theme: scenario.theme });

      for (const route of ROUTES) {
        const page = await context.newPage();
        const pageFailures = [];
        try {
          const response = await page.goto(BASE + route, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          if (!response || response.status() >= 500) {
            pageFailures.push(`document status ${response?.status() || "none"}`);
          }
          // Auth-disabled and already-authenticated runs redirect /login and
          // /register asynchronously after their status probe.  Auditing the
          // transient App Router document can observe a momentarily blank
          // title and make the release gate nondeterministic.  Wait for both
          // navigation quiescence and the global metadata title before axe.
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
          await page.waitForFunction(
            () => document.readyState !== "loading" && document.title.trim().length > 0,
            undefined,
            { timeout: 10_000 },
          );
          await page.waitForTimeout(100);
          const audit = await page.evaluate(async () => window.axe.run(document, {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
            },
            resultTypes: ["violations"],
          }));
          pageFailures.push(...audit.violations.map(describeViolation));
          const overflow = await page.evaluate(() => {
            const viewport = window.innerWidth;
            const offenders = Array.from(document.querySelectorAll("body *"))
              .map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                  selector: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${Array.from(element.classList).slice(0, 3).map((name) => `.${name}`).join("")}`,
                  left: Math.round(rect.left),
                  right: Math.round(rect.right),
                  width: Math.round(rect.width),
                  scrollWidth: element.scrollWidth,
                };
              })
              .filter((item) => item.right > viewport + 2 || item.left < -2 || item.scrollWidth > item.width + 2)
              .sort((a, b) => Math.max(b.right - viewport, b.scrollWidth - b.width) - Math.max(a.right - viewport, a.scrollWidth - a.width))
              .slice(0, 3);
            return {
              viewport,
              document: document.documentElement.scrollWidth,
              offenders,
            };
          });
          if (overflow.document > overflow.viewport + 2) {
            pageFailures.push(`horizontal overflow ${overflow.document}px > ${overflow.viewport}px: ${overflow.offenders.map((item) => `${item.selector}[${item.left},${item.right};${item.scrollWidth}/${item.width}]`).join(", ")}`);
          }
          let reachedControl = false;
          for (let index = 0; index < 5; index += 1) {
            await page.keyboard.press("Tab");
            reachedControl = reachedControl || await page.evaluate(() => {
              const active = document.activeElement;
              return Boolean(active && active !== document.body && active !== document.documentElement);
            });
          }
          if (!reachedControl) pageFailures.push("keyboard focus did not reach an interactive control");
        } catch (error) {
          pageFailures.push(error.message);
        }
        if (pageFailures.length) failures.push({ scenario: scenario.name, route, failures: pageFailures });
        console.log(`${pageFailures.length ? "FAIL" : "PASS"} ${scenario.name} ${route}${pageFailures.length ? ` — ${pageFailures.slice(0, 2).join("; ")}` : ""}`);
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${ROUTES.length * SCENARIOS.length - failures.length}/${ROUTES.length * SCENARIOS.length} accessibility surfaces passed`);
  process.exit(failures.length ? 1 : 0);
})().catch((error) => {
  console.error("FATAL accessibility audit:", error);
  process.exit(2);
});
