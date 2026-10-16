/* Browser contract: ready KB → Chat selection → RAG provenance → cited answer. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
function assert(condition, message) { if (!condition) throw new Error(message); }

(async () => {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();
  await context.addCookies([{ name: "cognivoy-lang", value: "en", url: BASE }]);
  const page = await context.newPage();
  let payload = null;
  let turnStarted = false;
  await page.addInitScript(() => {
    localStorage.setItem("cognivoy-language", "en");
    localStorage.setItem("cognivoy-response-language", "en");
  });
  await page.routeWebSocket("**/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (message.type !== "start_turn") return;
      payload = message;
      turnStarted = true;
      const base = {
        source: "chat",
        stage: "exploring",
        session_id: "rag-e2e-session",
        turn_id: "rag-e2e-turn",
        timestamp: Date.now() / 1000,
      };
      const frames = [
        { ...base, type: "session", content: "", seq: 1, metadata: { session_id: "rag-e2e-session", turn_id: "rag-e2e-turn" } },
        { ...base, type: "tool_call", content: "", seq: 2, metadata: { tool_name: "rag", tool_call_id: "rag-call-1" } },
        { ...base, type: "tool_result", content: "", seq: 3, metadata: { tool_call_id: "rag-call-1" } },
        {
          ...base,
          type: "sources",
          content: "",
          seq: 4,
          metadata: {
            sources: [
              { type: "rag", kb_name: "Course KB", title: "Fourier notes · chunk 7", chunk_id: "chunk-7" },
              { type: "rag", kb_name: "Course KB", title: "Lecture handout", url: "https://example.test/fourier" },
            ],
          },
        },
        { ...base, type: "content", stage: "responding", content: "The Fourier transform maps a signal into frequency components [1].", seq: 5, metadata: {} },
        {
          ...base,
          type: "done",
          stage: "responding",
          content: "",
          seq: 6,
          metadata: {
            turn_terminal: true,
            status: "completed",
            user_message_id: 1,
            assistant_message_id: 2,
          },
        },
      ];
      frames.forEach((frame, index) => setTimeout(() => socket.send(JSON.stringify(frame)), index * 15));
    });
  });
  await page.route("**/api/v1/knowledge/list*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{ name: "Course KB", status: "ready", metadata: { type: "document" }, statistics: { raw_documents: 1, status: "ready" } }]),
    }),
  );
  await page.route("**/api/v1/settings/ui", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"language":"en","response_language":"en"}' }),
  );
  await page.route("**/api/v1/subagents/connections*", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"connections":[]}' }),
  );
  await page.route("**/api/v1/sessions/rag-e2e-session**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "rag-e2e-session",
        session_id: "rag-e2e-session",
        title: "Fourier notes",
        status: "completed",
        preferences: { capability: "chat", tools: [], knowledge_bases: turnStarted ? ["Course KB"] : [] },
        messages: turnStarted ? [
          { id: 1, role: "user", content: "Explain the Fourier transform using my notes", capability: "chat", parent_message_id: null },
          {
            id: 2,
            role: "assistant",
            content: "The Fourier transform maps a signal into frequency components [1].",
            capability: "chat",
            parent_message_id: 1,
            events: [{
              type: "sources",
              source: "chat",
              stage: "exploring",
              content: "",
              timestamp: Date.now() / 1000,
              metadata: {
                sources: [
                  { type: "rag", kb_name: "Course KB", title: "Fourier notes · chunk 7", chunk_id: "chunk-7" },
                  { type: "rag", kb_name: "Course KB", title: "Lecture handout", url: "https://example.test/fourier" },
                ],
              },
            }],
          },
        ] : [],
      }),
    }),
  );
  await page.route("**/api/v1/sessions?**", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"sessions":[]}' }),
  );
  await page.route("**/api/v1/notebook/list*", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"notebooks":[]}' }),
  );
  await page.route("**/api/v1/question-notebook/entries?**", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"items":[],"total":0}' }),
  );
  await page.route("**/api/v1/book/books", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"books":[]}' }),
  );

  try {
    await page.goto(`${BASE}/home/rag-e2e-session`, { waitUntil: "domcontentloaded" });
    const composer = page.getByLabel("Ask anything…");
    await composer.waitFor();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Advanced options" }).click();
    const picker = page.getByRole("button", { name: "Knowledge bases" });
    await picker.click();
    await page.getByRole("menu").waitFor();
    await page.getByRole("switch", { name: "Course KB" }).click();
    await picker.click();
    await composer.fill("Explain the Fourier transform using my notes");
    await composer.press("Enter");
    await page.getByText(/maps a signal into frequency components/).waitFor();

    assert(JSON.stringify(payload?.knowledge_bases) === '["Course KB"]', "selected KB was not sent to Chat");
    const progress = page.getByRole("button", { name: "Learning progress" }).last();
    await progress.waitFor();
    if ((await progress.getAttribute("aria-expanded")) !== "true") await progress.click();
    const sources = page.getByRole("list", { name: "Sources" });
    try {
      await sources.getByText("Fourier notes · chunk 7", { exact: true }).waitFor();
    } catch (error) {
      console.error("Rendered sources:", await sources.allInnerTexts().catch(() => []));
      await page.screenshot({ path: "scripts/shots/knowledge-rag-journey-FAIL.png", fullPage: true });
      throw error;
    }
    await sources.getByRole("link", { name: /Lecture handout/ }).waitFor();
    assert(await sources.locator("li").count() === 2, "retrieval provenance was incomplete");
    console.log("PASS knowledge RAG: ready KB → Chat reference → RAG → local + linked citations");
  } finally {
    await page.close(); await context.close(); await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
