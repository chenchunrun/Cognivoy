/* Playground production contract: governed execution, safe stream results,
 * persistent bounded history, and request/result clipboard export. */
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
  try {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    await context.addInitScript(() => localStorage.setItem("cognivoy-language", "en"));
    const page = await context.newPage();
    let executionEnabled = true;
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.route("**/api/v1/plugins/list", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        execution_enabled: executionEnabled,
        capabilities: [],
        plugins: [],
        tools: [{
          name: "echo",
          description: "Echo a value",
          parameters: [{ name: "value", type: "string", required: true, default: "hello" }],
        }],
      }),
    }));
    await page.route("**/api/v1/plugins/tools/echo/execute-stream", (route) => route.fulfill({
      contentType: "text/event-stream",
      body: [
        "event: process_log",
        `data: ${JSON.stringify({ message: "starting echo" })}`,
        "",
        "event: result",
        `data: ${JSON.stringify({ success: true, content: "echoed", sources: [], metadata: { value: "hello" }, elapsed_ms: 4 })}`,
        "",
        "",
      ].join("\n"),
    }));
    await page.route("**/api/v1/tools", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        enabled_optional_tools: ["brainstorm"],
        tools: [{
          name: "brainstorm",
          description: "Generate ideas",
          parameters: [],
          toggleable: true,
          hints: {
            en: { short_description: "Generate ideas", when_to_use: "", input_format: "", guideline: "", note: "" },
            zh: { short_description: "生成想法", when_to_use: "", input_format: "", guideline: "", note: "" },
          },
        }],
      }),
    }));
    await page.route("**/api/v1/settings/playground-policy", async (route) => {
      if (route.request().method() === "PUT") {
        executionEnabled = Boolean(route.request().postDataJSON().execution_enabled);
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ execution_enabled: executionEnabled }),
      });
    });

    await page.goto(`${BASE}/playground`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const history = page.getByTestId("playground-history");
    await history.waitFor();
    await history.getByText("tool:echo", { exact: true }).waitFor();
    await history.getByRole("button", { name: "Copy request" }).click();
    const copiedRequest = await page.evaluate(() => navigator.clipboard.readText());
    assert(copiedRequest.includes('"value": "hello"'), "request clipboard export is incomplete");
    await history.getByRole("button", { name: "Copy result" }).click();
    const copiedResult = await page.evaluate(() => navigator.clipboard.readText());
    assert(copiedResult.includes('"content": "echoed"'), "result clipboard export is incomplete");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("playground-history").getByText("tool:echo", { exact: true }).waitFor();

    await page.goto(`${BASE}/settings/tools`, { waitUntil: "domcontentloaded" });
    const policyToggle = page.getByRole("switch", { name: "Allow direct execution" });
    await policyToggle.waitFor();
    assert(await policyToggle.isChecked(), "Playground policy did not load enabled");
    await policyToggle.click();
    await page.waitForFunction(() => {
      const toggle = document.querySelector('[role="switch"][aria-label="Allow direct execution"]');
      return toggle?.getAttribute("aria-checked") === "false";
    });

    await page.goto(`${BASE}/playground`, { waitUntil: "domcontentloaded" });
    await page.getByRole("alert").getByText(/disabled by an administrator/).waitFor();
    assert(await page.getByRole("button", { name: "Run", exact: true }).isDisabled(), "disabled policy still allowed a run");
    assert(browserErrors.length === 0, `browser errors: ${browserErrors.slice(0, 3).join("; ")}`);

    console.log("PASS Playground governance: history/copy + admin execution kill switch");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL Playground governance E2E:", error);
  process.exit(1);
});
