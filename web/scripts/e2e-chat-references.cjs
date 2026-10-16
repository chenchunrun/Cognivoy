/* E2E contract: the unified Chat reference picker must send real turn fields.
 * Uses a mocked WS and deterministic asset lists, so it exercises browser UI
 * → UnifiedChatContext → start_turn without invoking a model. */
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
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(() => {
      localStorage.setItem("cognivoy-language", "en");
      localStorage.setItem("cognivoy-response-language", "en");
    });
    const browserErrors = [];
    const failedResponses = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
    });
    let resolveTurn;
    const startedTurn = new Promise((resolve) => {
      resolveTurn = resolve;
    });

    await page.routeWebSocket("**/api/v1/ws", (socket) => {
      socket.onMessage((raw) => {
        const payload = JSON.parse(String(raw));
        if (payload.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
        if (payload.type === "start_turn") resolveTurn(payload);
      });
    });
    await page.route("**/api/v1/knowledge/list*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          { name: "Course KB", status: "ready", metadata: { type: "document" } },
          {
            name: "Broken KB",
            status: "error",
            metadata: { type: "document", last_error: "Embedding model is missing" },
            progress: { error: "Embedding model is missing" },
          },
          { name: "Claude Code", metadata: { type: "subagent" } },
        ]),
      }),
    );
    await page.route("**/api/v1/settings/llm-options", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ active: null, options: [] }),
      }),
    );
    await page.route("**/api/v1/settings", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ catalog: { llm: true } }),
      }),
    );
    await page.route("**/api/v1/auth/status", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          enabled: false,
          authenticated: true,
          is_admin: true,
          avatar: "",
        }),
      }),
    );
    await page.route("**/api/v1/learning/progress", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ summaries: [], errors: [] }),
      }),
    );
    await page.route("**/api/v1/settings/chat-attachments", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          max_file_mb: 20,
          max_total_mb: 25,
          max_chars_per_doc: 200000,
          max_chars_total: 150000,
        }),
      }),
    );
    await page.route("**/api/v1/plugins/list", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ capabilities: [] }),
      }),
    );
    await page.route("**/api/v1/personas/list", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ personas: [] }),
      }),
    );
    await page.route("**/api/v1/tools", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ enabled_optional_tools: [] }),
      }),
    );
    await page.route("**/api/v1/settings/enabled-tools", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "simulated save failure" }),
      }),
    );
    await page.route("**/api/v1/system/dependencies", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          dependencies: { media: { stt: { status: "not_configured" } } },
        }),
      }),
    );
    await page.route("**/api/v1/subagents/connections*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          connections: [{ name: "Claude Code", agent_kind: "claude_code", cwd: "/tmp/project" }],
        }),
      }),
    );
    await page.route("**/api/v1/sessions?**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [{
            id: "history-1",
            session_id: "history-1",
            title: "Old lesson",
            created_at: 1,
            updated_at: 2,
            message_count: 2,
            last_message: "Prior explanation",
          }],
        }),
      }),
    );
    await page.route("**/api/v1/notebook/list*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          notebooks: [{ id: "notes-1", name: "Study Notes", record_count: 2 }],
        }),
      }),
    );
    await page.route("**/api/v1/notebook/notes-1*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "notes-1",
          name: "Study Notes",
          records: [{ id: "record-1" }, { id: "record-2" }],
        }),
      }),
    );
    await page.route("**/api/v1/question-notebook/entries?**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          total: 1,
          items: [{ id: 7, question: "Why is the sky blue?", session_title: "Physics" }],
        }),
      }),
    );
    await page.route("**/api/v1/book/books", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          books: [{ id: "book-1", title: "Physics Book", page_count: 2, status: "ready" }],
        }),
      }),
    );
    await page.route("**/api/v1/book/books/book-1*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          book: { id: "book-1", title: "Physics Book" },
          spine: null,
          progress: {},
          pages: [{ id: "page-1" }, { id: "page-2" }],
        }),
      }),
    );

    await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Ask anything…").waitFor({ state: "visible" });
    await page.waitForTimeout(800);

    const modeTrigger = page.locator('button[aria-label="Learning mode"]');
    assert((await modeTrigger.count()) === 1, "Learning mode trigger was not rendered");
    await modeTrigger.click();
    assert((await modeTrigger.getAttribute("aria-expanded")) === "true", "Learning mode did not open");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Advanced options" }).click();
    for (const label of ["Knowledge bases", "Teaching preferences", "Advanced tools"]) {
      const trigger = page.locator(`button[aria-label="${label}"]`);
      assert((await trigger.count()) === 1, `${label} trigger was not rendered; url=${page.url()}; main=${(await page.locator("main").innerText()).slice(0, 500)}; buttons=${(await page.locator("button[aria-label]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).join(",")}`);
      assert((await trigger.getAttribute("aria-haspopup")) === "menu", `${label} trigger is missing aria-haspopup`);
      assert((await trigger.getAttribute("aria-expanded")) === "false", `${label} trigger did not start collapsed`);
      await trigger.click();
      assert((await trigger.getAttribute("aria-expanded")) === "true", `${label} trigger did not report its open state`);
      await page.keyboard.press("Escape");
      assert((await trigger.getAttribute("aria-expanded")) === "false", `${label} trigger did not report its closed state`);
    }

    const modelPicker = page.getByRole("button", { name: "Model", exact: true });
    await modelPicker.click();
    await page.getByText("Using the server default model. Add a model profile to choose explicitly.").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");

    const knowledgePicker = page.getByLabel("Knowledge bases", { exact: true });
    await knowledgePicker.click();
    assert(await page.getByRole("switch", { name: "Broken KB is unavailable" }).isDisabled(), "failed KB remained selectable");
    assert(!(await page.getByRole("switch", { name: "Course KB" }).isDisabled()), "ready KB was incorrectly disabled");
    await page.keyboard.press("Escape");

    const toolsPicker = page.getByLabel("Advanced tools", { exact: true });
    await toolsPicker.click();
    const brainstorm = page.getByRole("switch", { name: "Brainstorm" });
    await brainstorm.click();
    await page.getByText("Couldn't save tool settings").waitFor({ state: "visible" });
    assert((await brainstorm.getAttribute("aria-checked")) === "false", "failed tool save did not roll back the switch");
    browserErrors.length = 0;
    failedResponses.length = 0;
    await page.keyboard.press("Escape");

    await page.getByLabel("Voice input", { exact: true }).click();
    await page.getByText("Voice input is unavailable until speech-to-text is configured in Settings.").waitFor({ state: "visible" });

    const picker = page.getByTestId("chat-reference-picker");
    await picker.click();
    await page.waitForTimeout(200);
    if (!(await page.getByRole("menu").count())) await picker.click();
    await page.getByRole("menu").waitFor({ state: "visible" });
    await page.getByRole("switch", { name: "Claude Code" }).click();

    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.getByRole("switch", { name: "Old lesson" }).click();
    await page.getByRole("button", { name: "Notebooks", exact: true }).click();
    await page.getByRole("switch", { name: "Study Notes" }).click();
    await page.getByRole("button", { name: "Questions", exact: true }).click();
    await page.getByRole("switch", { name: "Why is the sky blue?" }).click();
    await page.getByRole("button", { name: "Books", exact: true }).click();
    await page.getByRole("switch", { name: "Physics Book" }).click();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await page.getByRole("switch", { name: "Learning summary" }).click();
    await picker.click();

    assert((await page.getByTestId("chat-reference-count").innerText()) === "7", "reference count did not include every selected record/page");
    assert((await picker.innerText()).includes("Claude Code"), "sticky Agent selection is not visible");

    await page.getByLabel("Ask anything…").fill("Use these references");
    await page.getByLabel("Ask anything…").press("Enter");
    const payload = await Promise.race([
      startedTurn,
      new Promise((_, reject) => setTimeout(() => reject(new Error("start_turn timeout")), 10_000)),
    ]);

    assert(JSON.stringify(payload.knowledge_bases) === JSON.stringify(["Claude Code"]), `unexpected knowledge_bases: ${JSON.stringify(payload.knowledge_bases)}`);
    assert(JSON.stringify(payload.history_references) === JSON.stringify(["history-1"]), "history reference missing");
    assert(JSON.stringify(payload.notebook_references) === JSON.stringify([{ notebook_id: "notes-1", record_ids: ["record-1", "record-2"] }]), "notebook references missing");
    assert(JSON.stringify(payload.question_notebook_references) === JSON.stringify([7]), "question reference missing");
    assert(JSON.stringify(payload.book_references) === JSON.stringify([{ book_id: "book-1", page_ids: ["page-1", "page-2"] }]), "book references missing");
    assert(JSON.stringify(payload.memory_references) === JSON.stringify(["summary"]), "memory reference missing");
    assert((await page.getByTestId("chat-reference-count").count()) === 0, "one-turn references were not cleared after send");
    assert((await picker.innerText()).includes("Claude Code"), "Agent selection was incorrectly cleared after send");
    assert(browserErrors.length === 0, `browser errors: ${browserErrors.slice(0, 3).join("; ")}; failed responses: ${failedResponses.slice(0, 8).join("; ")}`);

    console.log("PASS chat references: UI → start_turn + one-turn clear + sticky Agent");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL chat references:", error);
  process.exit(1);
});
