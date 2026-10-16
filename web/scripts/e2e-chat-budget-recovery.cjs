/* Browser contract: completed turns expose their real context accounting and
 * a terminal timeout offers lossless retry plus a bounded faster mode. */
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
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem("language", "en");
      localStorage.setItem("cognivoy.language", "en");
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    // Keep the recovery contract independent from the developer's persisted
    // multi-user setting. Otherwise a fresh Playwright context can be sent to
    // /login before the mocked session is restored.
    await page.route("**/api/v1/auth/status**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          enabled: false,
          authenticated: true,
          is_admin: false,
          username: "budget-recovery-e2e",
          avatar: "",
        }),
      }),
    );
    await page.route("**/api/v1/knowledge/list**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([{ id: "physics", name: "physics", status: "ready" }]),
      }),
    );

    let resolveStart;
    const started = new Promise((resolve) => { resolveStart = resolve; });
    await page.routeWebSocket("**/api/v1/ws", (socket) => {
      socket.onMessage((raw) => {
        const payload = JSON.parse(String(raw));
        if (payload.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
        if (payload.type === "start_turn") resolveStart(payload);
      });
    });
    await page.route("**/api/v1/sessions/e2e-budget-recovery**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "e2e-budget-recovery",
          session_id: "e2e-budget-recovery",
          title: "Context recovery",
          status: "timed_out",
          preferences: { capability: "deep_research", tools: ["web_search"], knowledge_bases: ["physics"] },
          messages: [
            {
              id: 1,
              role: "user",
              content: "Research quantum sensing",
              capability: "deep_research",
              parent_message_id: null,
              metadata: {
                request_snapshot: {
                  content: "Research quantum sensing",
                  capability: "deep_research",
                  enabledTools: ["web_search"],
                  knowledgeBases: ["physics"],
                  language: "en",
                  config: { depth: "deep", max_sources: 80, report_format: "markdown" },
                },
              },
            },
            {
              id: 2,
              role: "assistant",
              content: "The evidence collected before the timeout is preserved.",
              capability: "deep_research",
              parent_message_id: 1,
              events: [
                {
                  type: "result",
                  source: "deep_research",
                  stage: "reporting",
                  content: "",
                  timestamp: 1,
                  metadata: {
                    metadata: {
                      context_budget: {
                        window: 128000,
                        window_estimated: false,
                        used_tokens: 32000,
                        free_tokens: 96000,
                        model: "test-model",
                        counter: "test",
                        deferred_tool_count: 2,
                        segments: [
                          { key: "messages", tokens: 20000 },
                          { key: "system_tools", tokens: 12000 },
                        ],
                      },
                    },
                  },
                },
                {
                  type: "error",
                  source: "client",
                  stage: "",
                  content: "The task timed out.",
                  timestamp: 2,
                  metadata: {
                    turn_terminal: true,
                    reason: "client_idle_timeout",
                    status: "timed_out",
                    retryable: true,
                    timeout_seconds: 180,
                  },
                },
              ],
            },
          ],
          active_turns: [],
        }),
      }),
    );

    await page.goto(`${BASE}/home/e2e-budget-recovery`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("composer-context-estimate").waitFor({ state: "visible" });
    const budget = page.getByTestId("context-budget");
    await budget.waitFor({ state: "visible" });
    await budget.locator("summary").click();
    await budget.getByText("25% used").waitFor();
    await budget.getByText("20,000", { exact: true }).waitFor();
    const recovery = page.getByTestId("turn-recovery");
    await recovery.waitFor({ state: "visible" });
    await recovery.getByRole("button", { name: "Retry in faster mode" }).click();
    const payload = await Promise.race([
      started,
      new Promise((_, reject) => setTimeout(() => reject(new Error("quick retry did not start")), 5_000)),
    ]);
    assert(payload.content === "Research quantum sensing", "quick retry changed the prompt");
    assert(payload.config?.depth === "quick", "quick retry did not lower research depth");
    assert(payload.config?.max_sources === 12, "quick retry did not bound sources");
    assert(payload.config?.report_format === "markdown", "quick retry dropped output format");
    assert(payload.knowledge_bases?.[0] === "physics", "quick retry dropped references");
    assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
    console.log("PASS chat context budget → preserved timeout output → bounded quick retry");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
