/* Screenshot audit of web-next pages (light + dark) */
const { chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const OUT = path.join(__dirname, "shots");
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

const only = process.argv[2] ? process.argv[2].split(",") : null;

const pages = [
  ["home-empty", "/home"],
  ["playground", "/playground"],
  ["co-writer", "/co-writer"],
  ["book", "/book"],
  ["partners", "/partners"],
  ["knowledge", "/knowledge"],
  ["memory", "/memory"],
  ["memory-graph", "/memory/graph"],
  ["space", "/space"],
  ["notebook", "/notebook"],
  ["settings-llm", "/settings/llm"],
  ["settings-tools", "/settings/tools"],
  ["settings-appearance", "/settings/appearance"],
  ["settings-status", "/settings/status"],
  ["profile", "/profile"],
  ["about", "/about"],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(launchOptions);
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    for (const [name, url] of pages) {
      if (only && !only.includes(name)) continue;
      await page.goto(BASE + url, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`) });
    }
    await ctx.close();
  }
  await browser.close();
  console.log("done");
})();
