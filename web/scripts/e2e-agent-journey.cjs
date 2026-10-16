/* Browser journey for local CLI agents: detect → connect → Chat selection →
 * direct streamed success/timeout/cancel → disconnect.  The real subprocess
 * lifecycle is covered by tests/services/test_subagent_fake_cli_journey.py. */
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
    const browserErrors = [];
    const connections = [];
    const importedSessions = [];
    let resolveTurn;
    const startedTurn = new Promise((resolve) => { resolveTurn = resolve; });

    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.routeWebSocket("**/api/v1/ws", (socket) => {
      socket.onMessage((raw) => {
        const payload = JSON.parse(String(raw));
        if (payload.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
        if (payload.type === "start_turn") resolveTurn(payload);
      });
    });
    await page.route("**/api/v1/subagents/detect", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        backends: [{
          kind: "claude_code",
          display_name: "Fake Claude",
          available: true,
          version: "fake-claude 1.0",
          detail: "",
        }],
      }),
    }));
    await page.route("**/api/v1/subagents/connections**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      const messageMatch = url.pathname.match(/\/connections\/([^/]+)\/message$/);
      if (messageMatch) {
        const body = route.request().postDataJSON();
        if (body.message === "cancel this run") {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          return route.fulfill({ contentType: "application/x-ndjson", body: "" });
        }
        const lines = body.message === "timeout please"
          ? [
              { channel: "user_question", text: body.message },
              { channel: "error", text: "runtime limit", code: "subagent_timeout", retryable: true, timeout_seconds: 30 },
              { done: true, success: false, reason: "timeout", retryable: true },
            ]
          : [
              { channel: "user_question", text: body.message },
              { channel: "text", text: "fake answer", merge_id: "side:txt:m1:0" },
              { done: true, success: true, session_id: "fake-session-1" },
            ];
        return route.fulfill({
          contentType: "application/x-ndjson",
          body: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
        });
      }
      const connectionMatch = url.pathname.match(/\/connections\/([^/]+)$/);
      if (method === "DELETE" && connectionMatch) {
        const name = decodeURIComponent(connectionMatch[1]);
        const index = connections.findIndex((item) => item.name === name);
        if (index >= 0) connections.splice(index, 1);
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ status: "disconnected", name }),
        });
      }
      if (method === "POST") {
        const body = route.request().postDataJSON();
        const item = { ...body, description: "Fake process-backed CLI" };
        connections.push(item);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(item) });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ connections }),
      });
    });
    await page.route("**/api/v1/imports/chat-history**", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        const outcomes = body.sessions.map((session) => {
          importedSessions.push({
            id: `imported_codex_${session.external_id}`,
            session_id: `imported_codex_${session.external_id}`,
            title: session.title,
            status: "completed",
            updated_at: session.updated_at,
            message_count: session.messages.length,
            preferences: {
              import: {
                source: body.source,
                external_id: session.external_id,
                source_cwd: session.source_cwd,
                agent_id: body.agent_id,
                agent_name: body.agent_name,
              },
            },
          });
          return {
            external_id: session.external_id,
            session_id: `imported_codex_${session.external_id}`,
            imported: true,
          };
        });
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ imported: outcomes.length, skipped: 0, sessions: outcomes }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ sessions: importedSessions }),
      });
    });
    await page.route("**/api/v1/imports/sessions**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ sessions: [], total: 0 }),
    }));
    await page.route("**/api/v1/knowledge/list**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(connections.map((item) => ({
        name: item.name,
        metadata: { type: "subagent" },
      }))),
    }));

    await page.goto(`${BASE}/space/agents`, { waitUntil: "domcontentloaded" });
    await page.getByText(/Fake Claude.*Installed/).waitFor();

    // Use an origin-private FileSystemDirectoryHandle so the browser exercises
    // the real scan/parser/IndexedDB path without reading a developer's private
    // CLI history from disk.
    await page.evaluate(async () => {
      const storage = await navigator.storage.getDirectory();
      const codex = await storage.getDirectoryHandle(".codex", { create: true });
      const sessions = await codex.getDirectoryHandle("sessions", { create: true });
      const year = await sessions.getDirectoryHandle("2026", { create: true });
      const month = await year.getDirectoryHandle("08", { create: true });
      const day = await month.getDirectoryHandle("17", { create: true });
      for (const [index, id] of ["import-one", "import-two"].entries()) {
        const file = await day.getFileHandle(`rollout-${id}.jsonl`, { create: true });
        const writable = await file.createWritable();
        await writable.write([
          JSON.stringify({ timestamp: "2026-08-17T00:00:00Z", type: "session_meta", payload: { id, cwd: "/tmp/import-project", thread_source: "user" } }),
          JSON.stringify({ timestamp: "2026-08-17T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: `question ${index + 1}` } }),
          JSON.stringify({ timestamp: "2026-08-17T00:00:02Z", type: "event_msg", payload: { type: "agent_message", message: `answer ${index + 1}` } }),
        ].join("\n"));
        await writable.close();
      }
      window.showDirectoryPicker = async () => codex;
    });
    await page.getByRole("button", { name: "Import history" }).click();
    const importDialog = page.getByRole("dialog");
    await importDialog.getByRole("button", { name: "Choose folder" }).click();
    await importDialog.getByText(/2 conversations.*source data/).waitFor();
    await importDialog.getByRole("button", { name: "Import and save" }).click();
    await page.getByRole("heading", { name: "Codex", exact: true }).first().waitFor();
    assert(importedSessions.length === 2, "Codex history was not parsed and uploaded");

    await page.getByRole("button", { name: "Connect CLI agent" }).click();
    const connectDialog = page.getByRole("dialog");
    await connectDialog.getByLabel("Connection name").fill("Fake Claude Agent");
    await connectDialog.getByLabel("Working directory").fill("/tmp/fake-agent");
    await connectDialog.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("Fake Claude Agent", { exact: true }).waitFor();
    const listedAfterConnect = await page.evaluate(() =>
      fetch("/api/v1/subagents/connections", { cache: "no-store" }).then((response) => response.json()),
    );
    assert(listedAfterConnect.connections?.[0]?.name === "Fake Claude Agent", "connected Agent was not persisted by the UI journey");

    await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Ask anything…").waitFor();
    await page.waitForTimeout(800);
    const picker = page.getByTestId("chat-reference-picker");
    await picker.click();
    await page.getByRole("menu").waitFor();
    await page.getByRole("switch", { name: "Fake Claude Agent" }).click();
    await picker.click();
    await page.getByLabel("Ask anything…").fill("Consult my connected agent");
    await page.getByLabel("Ask anything…").press("Enter");
    const turn = await Promise.race([
      startedTurn,
      new Promise((_, reject) => setTimeout(() => reject(new Error("start_turn timeout")), 10_000)),
    ]);
    assert(JSON.stringify(turn.knowledge_bases) === JSON.stringify(["Fake Claude Agent"]), "connected Agent was not sent to Chat");

    const streamChecks = await page.evaluate(async () => {
      const read = async (message) => {
        const response = await fetch("/api/v1/subagents/connections/Fake%20Claude%20Agent/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_session_id: "journey", message }),
        });
        return response.text();
      };
      const success = await read("answer normally");
      const timeout = await read("timeout please");
      const controller = new AbortController();
      const cancelled = fetch("/api/v1/subagents/connections/Fake%20Claude%20Agent/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_session_id: "journey", message: "cancel this run" }),
        signal: controller.signal,
      }).then(() => false, (error) => error.name === "AbortError");
      setTimeout(() => controller.abort(), 30);
      return { success, timeout, cancelled: await cancelled };
    });
    assert(streamChecks.success.includes("fake answer"), "successful Agent stream was lost");
    assert(streamChecks.timeout.includes("subagent_timeout"), "timeout stream was not structured");
    assert(streamChecks.cancelled, "browser cancellation did not abort the Agent request");

    await page.goto(`${BASE}/space/agents`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Disconnect Fake Claude Agent").click();
    await page.getByRole("dialog").getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByText("No connected agents.", { exact: false }).waitFor();
    assert(browserErrors.length === 0, `browser errors: ${browserErrors.slice(0, 3).join("; ")}`);

    console.log("PASS Agent journey: detect → connect → Chat → stream/timeout/cancel → disconnect");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL Agent journey:", error);
  process.exit(1);
});
