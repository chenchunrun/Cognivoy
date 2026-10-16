const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

(async () => {
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  try {
  let savedCapability = "auto";
  let resetCount = 0;
  let restoredBackup = "";

  await page.route("**/api/v1/settings/reset**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname.endsWith("/reset/preview")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          scope: "interface",
          changed_keys: ["theme", "language", "default_capability"],
          changed_count: 3,
          backup_will_be_created: true,
          description: "Resets interface preferences without changing model credentials.",
        }),
      });
      return;
    }
    if (route.request().method() === "POST" && url.pathname.includes("/reset/backups/")) {
      restoredBackup = decodeURIComponent(url.pathname.split("/").at(-2));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          settings: { theme: "dark", language: "zh", default_capability: "deep_research" },
          restored_backup_id: restoredBackup,
          safety_backup_id: "interface-20260815T120001000000Z-deadbeef",
        }),
      });
      return;
    }
    if (route.request().method() === "POST" && url.pathname.endsWith("/reset")) {
      resetCount += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          settings: { theme: "snow", language: "en", default_capability: "auto" },
          backup_id: "interface-20260815T120000000000Z-cafebabe",
          backup_created_at: "2026-08-15T12:00:00Z",
          reset_keys: ["theme", "language", "default_capability"],
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.route("**/api/v1/system/status", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      backend: { status: "online", timestamp: "2026-08-15T12:00:00Z" },
      llm: { status: "configured", model: "test-llm" },
      embeddings: { status: "configured", model: "test-embedding" },
      search: { status: "not_configured" },
    }),
  }));
  await page.route("**/api/v1/system/dependencies", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      timestamp: "2026-08-15T12:00:00Z",
      dependencies: {
        parser: { status: "configured", engine: "text" },
        manim: { status: "unavailable", missing_dependencies: ["manim"], install_hint: "Install the math-animator extra in the application virtual environment." },
        agents: { status: "configured", available: 2, total: 6 },
        media: {
          tts: { status: "configured", profile: "voice-main", verification: "not_run", missing_configuration: [], setup_path: "/settings/tts" },
          stt: { status: "not_configured", verification: "not_run", missing_configuration: ["credentials"], setup_path: "/settings/stt" },
          imagegen: { status: "configured", profile: "image-main" },
          videogen: { status: "not_configured" },
        },
      },
    }),
  }));
  await page.route("**/api/v1/system/slo?**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      generated_at: "2026-08-15T12:00:00Z",
      window_seconds: 86400,
      targets: { availability_percent: 99.5, p95_ms: 1500, minimum_samples: 10 },
      requests: 100,
      successful_requests: 98,
      server_errors: 2,
      availability_percent: 98,
      latency_ms: { p50: 80, p95: 21000 },
      alerts: [
        { code: "availability_below_target", severity: "warning", actual: 98, target: 99.5 },
        { code: "p95_above_target", severity: "warning", actual: 21000, target: 1500 },
      ],
      business_metrics: { asset_saved: 4, learning_completed: 3, reference_clicked: 2, turn_recovered: 1 },
      route_groups: [
        { name: "book", requests: 10, server_errors: 0, availability_percent: 100, p95_ms: 21000 },
        { name: "sessions", requests: 90, server_errors: 2, availability_percent: 97.78, p95_ms: 100 },
      ],
    }),
  }));
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname !== "/settings") throw new Error("settings overview unexpectedly redirected");
  await page.getByRole("heading", { name: "System health" }).waitFor();
  await page.getByText("3 of 4 ready").waitFor();
  await page.getByRole("button", { name: "Review reset" }).click();
  await page.getByText("3 preferences will be reset").waitFor();
  await page.getByRole("button", { name: "Reset interface preferences" }).click();
  if (resetCount !== 1) throw new Error("settings reset request was not sent");
  await page.getByRole("button", { name: "Undo reset" }).click();
  await page.getByText("Interface preferences restored").waitFor();
  if (restoredBackup !== "interface-20260815T120000000000Z-cafebabe") throw new Error("settings backup was not restored");
  await page.goto(`${BASE}/settings/status`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Capability dependencies" }).waitFor();
  await page.getByText("Required by Math Animator").waitFor();
  await page.getByText("2 of 6 available").waitFor();
  const manimCard = page.getByText("Manim renderer").locator("..").locator("..");
  await manimCard.getByText("Unavailable").waitFor();
  await page.getByText("Install the math-animator extra in the application virtual environment.", { exact: true }).waitFor();
  await page.getByText("Missing configuration: Credentials", { exact: true }).waitFor();
  if (await page.getByText("Configuration check only. Complete media generation has not been verified.", { exact: true }).count() !== 2) {
    throw new Error("configuration-only media readiness was presented without the live-verification warning");
  }
  const voiceSetupLinks = page.getByRole("link", { name: "Configure", exact: true });
  const voiceSetupTargets = await voiceSetupLinks.evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  if (!voiceSetupTargets.includes("/settings/tts") || !voiceSetupTargets.includes("/settings/stt")) {
    throw new Error("missing media configuration has no actionable settings link");
  }
  await page.getByText("Includes long-running workflows").waitFor();
  const sessionsRow = page.getByRole("row").filter({ hasText: "sessions" });
  if (!(await sessionsRow.getByRole("cell").allTextContents()).includes("2")) {
    throw new Error("SLO route table did not attribute server errors to sessions");
  }

  const emptyService = () => ({ active_profile_id: null, active_model_id: null, profiles: [] });
  const searchSettingsRoute = async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        catalog: {
          version: 1,
          services: {
            llm: emptyService(),
            embedding: emptyService(),
            search: { active_profile_id: null, profiles: [] },
            tts: emptyService(),
            stt: emptyService(),
            imagegen: emptyService(),
            videogen: emptyService(),
          },
        },
        providers: {
          search: [
            { value: "none", label: "Disabled" },
            { value: "brave", label: "Brave Search" },
            { value: "duckduckgo", label: "DuckDuckGo" },
          ],
        },
      }),
    });
  };
  await page.route("**/api/v1/settings", searchSettingsRoute);
  await page.goto(`${BASE}/settings/search`, { waitUntil: "domcontentloaded" });
  await page.getByText("Built-in search is active").waitFor();
  await page.getByRole("button", { name: "Create custom configuration" }).click();
  if ((await page.getByLabel("Provider").inputValue()) !== "duckduckgo") {
    throw new Error("custom search configuration did not materialize DuckDuckGo");
  }
  await page.unroute("**/api/v1/settings", searchSettingsRoute);

  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          // Admin settings include the catalog. Omitting it makes the access
          // provider treat this fixture as an unassigned ordinary account.
          catalog: { version: 1, services: {} },
          ui: {
            chat_response_timeout: 180,
            voice_autoplay: false,
            default_capability: savedCapability,
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/v1/settings/chat-attachments", (route) => route.fulfill({ status: 403, contentType: "application/json", body: "{}" }));
  await page.route("**/api/v1/settings/ui", async (route) => {
    const body = route.request().postDataJSON();
    savedCapability = body.default_capability;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ default_capability: savedCapability }) });
  });
  await page.goto(`${BASE}/settings/chat`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Default capability").selectOption("deep_research");
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => localStorage.getItem("cognivoy.defaultCapability") === "deep_research");
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await page.getByText("Deep Research", { exact: true }).last().waitFor();

  let savedNetwork = {
    backend_port: 8001,
    frontend_port: 3783,
    public_api_base: "",
    cors_origins: [],
    external_network_enabled: true,
    external_request_timeout_seconds: 60,
    outbound_proxy: "",
  };
  await page.route("**/api/v1/settings/network", async (route) => {
    if (route.request().method() === "PUT") {
      savedNetwork = route.request().postDataJSON();
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        settings: savedNetwork,
        effective: {
          backend_url: "http://127.0.0.1:8001",
          frontend_url: "http://127.0.0.1:3783",
          browser_api_base: "same-origin",
          cors_mode: "permissive",
        },
        auth: {
          enabled: false,
          cookie_secure: false,
          cookie_samesite: "lax",
          cross_site_cookie_ready: false,
        },
        restart_required: true,
      }),
    });
  });
  await page.goto(`${BASE}/settings/network`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Outbound network policy" }).waitFor();
  await page.getByLabel("Allow external network access").click();
  await page.getByRole("button", { name: "Disable external network" }).click();
  await page.getByLabel("External request timeout").fill("75");
  await page.getByLabel("Outbound proxy").fill("http://proxy.example:8080");
  await page.getByRole("button", { name: "Save" }).click();
  if (savedNetwork.external_network_enabled !== false) throw new Error("network kill switch was not persisted");
  if (savedNetwork.external_request_timeout_seconds !== 75) throw new Error("network timeout was not persisted");
  if (savedNetwork.outbound_proxy !== "http://proxy.example:8080") throw new Error("network proxy was not persisted");

  let agentPolicy = {
    max_concurrent_runs: 2,
    max_queued_runs: 20,
    queue_timeout_seconds: 60,
    max_output_chars: 200000,
  };
  await page.route("**/api/v1/subagents/backends/options", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ backends: [] }),
  }));
  await page.route("**/api/v1/subagents/settings**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ consult_budget: 5, backends: {} }),
  }));
  await page.route("**/api/v1/settings/agent-runtime-policy", async (route) => {
    if (route.request().method() === "PUT") agentPolicy = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        policy: agentPolicy,
        runtime: {
          active_runs: 1,
          queued_runs: 2,
          completed_runs: 7,
          failed_runs: 1,
          timed_out_runs: 0,
          rejected_runs: 0,
          queue_timed_out_runs: 0,
          output_limited_runs: 0,
        },
      }),
    });
  });
  await page.goto(`${BASE}/settings/agents`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Deployment resource policy" }).waitFor();
  await page.getByLabel("Maximum concurrent runs").fill("4");
  await page.getByLabel("Queue capacity").fill("8");
  await page.getByLabel("Queue timeout").fill("90");
  await page.getByLabel("Maximum output characters").fill("300000");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Agent settings saved").waitFor();
  if (agentPolicy.max_concurrent_runs !== 4 || agentPolicy.max_queued_runs !== 8) throw new Error("Agent concurrency policy was not saved");
  if (agentPolicy.queue_timeout_seconds !== 90 || agentPolicy.max_output_chars !== 300000) throw new Error("Agent queue/output policy was not saved");
  await page.getByText("1 active · 2 queued").waitFor();

  const mcpServers = {};
  await page.route("**/api/v1/settings/mcp", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ servers: mcpServers, status: [] }) });
  });
  await page.route("**/api/v1/settings/mcp/servers/**", async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    if (route.request().method() === "PUT") mcpServers[name] = route.request().postDataJSON();
    if (route.request().method() === "DELETE") delete mcpServers[name];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ servers: mcpServers, status: [] }) });
  });
  await page.route("**/api/v1/settings/mcp/servers/*/test", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, tools: [{ name: "demo_tool", description: "demo" }], error: "" }) });
  });
  await page.goto(`${BASE}/settings/mcp`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Deployment registry" }).waitFor();
  await page.getByRole("button", { name: "Add deployment server" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("my-server").fill("local-demo");
  await dialog.locator("select").selectOption("stdio");
  await dialog.getByPlaceholder("npx").fill("npx");
  await dialog.getByPlaceholder("One argument per line").fill("trusted-mcp-server");
  await dialog.getByRole("button", { name: "Add server" }).click();
  await page.getByText("local-demo", { exact: true }).waitFor();
  if (mcpServers["local-demo"].command !== "npx") throw new Error("admin stdio MCP command was not persisted");
  await page.getByRole("button", { name: "Test" }).click();
  await page.getByText("Connection successful").waitFor();

  console.log("PASS settings overview, recoverable reset, search defaults, SLO diagnostics, dependency topology, chat defaults, network policy, Agent resource policy, and admin MCP E2E");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
