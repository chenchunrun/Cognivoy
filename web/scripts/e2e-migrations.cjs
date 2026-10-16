/* Focused browser contracts for the native-frontend parity migration. */
const { chromium } = require("@playwright/test");
const fs = require("node:fs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

function monitorApiFailures(page) {
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
  return () => {
    if (failures.length) throw new Error(`API failures: ${failures.slice(0, 5).join("; ")}`);
  };
}

(async () => {
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const results = [];
  const run = async (name, fn) => {
    const started = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, seconds: ((Date.now() - started) / 1000).toFixed(1) });
    } catch (error) {
      results.push({ name, ok: false, seconds: ((Date.now() - started) / 1000).toFixed(1), error: error.message });
    }
  };

  await run("visualize advanced config", async () => {
    const page = await browser.newPage();
    const assertNoApiFailures = monitorApiFailures(page);
    await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Learning mode" }).click();
    await page.getByRole("menuitem", { name: "Visualize" }).click();
    await page.getByLabel("Render Mode").selectOption("manim_video");
    await page.getByLabel("Quality").selectOption("high");
    await page.getByLabel("Style Hint").fill("chalkboard");
    if ((await page.getByLabel("Quality").inputValue()) !== "high") throw new Error("quality did not persist");
    assertNoApiFailures();
    await page.close();
  });

  await run("sandboxed HTML visualization bridge", async () => {
    const page = await browser.newPage();
    await page.route("**/api/v1/sessions/e2e-html-visualize**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "e2e-html-visualize",
        session_id: "e2e-html-visualize",
        title: "HTML visualization",
        status: "completed",
        preferences: { capability: "visualize", tools: [], knowledge_bases: [] },
        messages: [{
          id: 1,
          role: "assistant",
          content: "",
          capability: "visualize",
          parent_message_id: null,
          events: [{
            type: "result",
            source: "visualize",
            stage: "reviewing",
            content: "",
            metadata: {
              render_type: "html",
              code: {
                language: "html",
                content: "<html><body style='height:720px'><button onclick=\"sendPrompt('Explain this chart')\">Ask</button></body></html>",
              },
            },
            timestamp: 1,
          }],
        }],
        active_turns: [],
      }),
    }));
    await page.goto(`${BASE}/home/e2e-html-visualize`, { waitUntil: "domcontentloaded" });
    const frame = page.frameLocator('iframe[title="HTML visualization"]').first();
    await frame.getByRole("button", { name: "Ask" }).waitFor({ state: "visible" });
    const composer = page.locator("textarea").first();
    await composer.waitFor({ state: "visible" });
    await frame.getByRole("button", { name: "Ask" }).click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("textarea")).some((element) => element.value === "Explain this chart"),
      undefined,
      { timeout: 5_000 },
    );
    const pagesBefore = page.context().pages().length;
    await page.getByRole("button", { name: "Fullscreen" }).click();
    await page.getByRole("dialog", { name: "HTML visualization" }).waitFor();
    if (page.context().pages().length !== pagesBefore) {
      throw new Error("HTML visualization escaped the sandbox into a new tab");
    }
    const inlineFrame = page.locator('iframe[title="HTML visualization"]').first();
    await page.waitForFunction(
      (element) => {
        if (!(element instanceof HTMLIFrameElement)) return false;
        const height = element.getBoundingClientRect().height;
        return height >= 700 && height <= 1_200;
      },
      await inlineFrame.elementHandle(),
      { timeout: 5_000 },
    );
    const inlineHeight = await inlineFrame.evaluate((element) => element.getBoundingClientRect().height);
    if (inlineHeight < 700 || inlineHeight > 1_200) throw new Error(`unexpected bridged iframe height ${inlineHeight}`);
    await page.close();
  });

  await run("visualization preview data, editing, repair, and downloads", async () => {
    const page = await browser.newPage();
    await page.route("**/api/v1/sessions/e2e-chart-visualize**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "e2e-chart-visualize",
        session_id: "e2e-chart-visualize",
        title: "Chart visualization",
        status: "completed",
        preferences: { capability: "visualize", tools: [], knowledge_bases: [] },
        messages: [{
          id: 1,
          role: "assistant",
          content: "",
          capability: "visualize",
          parent_message_id: null,
          events: [{
            type: "result",
            source: "visualize",
            stage: "reviewing",
            content: "",
            metadata: {
              render_type: "chartjs",
              code: {
                language: "json",
                content: JSON.stringify({
                  type: "bar",
                  data: { labels: ["A", "B"], datasets: [{ label: "Score", data: [3, 5] }] },
                }),
              },
            },
            timestamp: 1,
          }],
        }],
        active_turns: [],
      }),
    }));
    await page.goto(`${BASE}/home/e2e-chart-visualize`, { waitUntil: "domcontentloaded" });
    const viewer = page.locator('[data-visualization-viewer="chartjs"]');
    await viewer.locator("canvas").waitFor();
    await viewer.getByRole("button", { name: "Data table" }).click();
    await viewer.getByRole("cell", { name: "5", exact: true }).waitFor();

    await viewer.getByRole("button", { name: "Edit source" }).click();
    const source = viewer.getByLabel("Visualization source");
    await source.fill(JSON.stringify({
      type: "bar",
      data: { labels: ["A", "B"], datasets: [{ label: "Score", data: [8, 13] }] },
    }));
    await viewer.getByRole("button", { name: "Apply source" }).click();
    await viewer.getByRole("cell", { name: "13", exact: true }).waitFor();

    const jsonDownload = page.waitForEvent("download");
    await viewer.getByRole("button", { name: "Download JSON" }).click();
    if ((await jsonDownload).suggestedFilename() !== "visualization.json") {
      throw new Error("chart JSON download lost its portable filename");
    }

    await viewer.getByRole("button", { name: "Edit source" }).click();
    await source.fill("{not valid json");
    await viewer.getByRole("button", { name: "Apply source" }).click();
    await viewer.getByText("Visualization could not be rendered").waitFor();
    await viewer.getByRole("button", { name: "Auto repair" }).click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("textarea")).some((element) => element.value.includes("Repair this Chart.js visualization")),
      undefined,
      { timeout: 5_000 },
    );
    await page.close();
  });

  await run("SVG visualization exports source and PNG", async () => {
    const page = await browser.newPage();
    await page.route("**/api/v1/sessions/e2e-svg-visualize**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "e2e-svg-visualize",
        session_id: "e2e-svg-visualize",
        title: "SVG visualization",
        status: "completed",
        preferences: { capability: "visualize", tools: [], knowledge_bases: [] },
        messages: [{
          id: 1,
          role: "assistant",
          content: "",
          capability: "visualize",
          parent_message_id: null,
          events: [{
            type: "result",
            source: "visualize",
            stage: "reviewing",
            content: "",
            metadata: {
              render_type: "svg",
              code: {
                language: "svg",
                content: '<svg width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="orange"/></svg>',
              },
            },
            timestamp: 1,
          }],
        }],
        active_turns: [],
      }),
    }));
    await page.goto(`${BASE}/home/e2e-svg-visualize`, { waitUntil: "domcontentloaded" });
    const viewer = page.locator('[data-visualization-viewer="svg"]');
    await viewer.locator('[data-visualization-canvas="true"] svg').waitFor();
    const svgDownload = page.waitForEvent("download");
    await viewer.getByRole("button", { name: "Download SVG" }).click();
    if ((await svgDownload).suggestedFilename() !== "visualization.svg") {
      throw new Error("SVG source download lost its filename");
    }
    const pngDownload = page.waitForEvent("download");
    await viewer.getByRole("button", { name: "Download PNG" }).click();
    if ((await pngDownload).suggestedFilename() !== "visualization.png") {
      throw new Error("SVG PNG download lost its filename");
    }
    await page.close();
  });

  await run("math animator playback, captions, retry log, and downloads", async () => {
    const page = await browser.newPage();
    await page.route("**/api/v1/sessions/e2e-manim-viewer**", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "e2e-manim-viewer",
        session_id: "e2e-manim-viewer",
        title: "Math animation",
        status: "completed",
        preferences: { capability: "math_animator", tools: [], knowledge_bases: [] },
        messages: [{
          id: 1,
          role: "assistant",
          content: "",
          capability: "math_animator",
          parent_message_id: null,
          events: [{
            type: "result",
            turn_id: "turn-e2e-manim-1234",
            source: "math_animator",
            stage: "render_output",
            content: "",
            metadata: {
              output_mode: "video",
              code: { language: "python", content: "class Demo(Scene):\n    pass" },
              artifacts: [{ type: "video", url: "/api/outputs/e2e-demo.mp4", filename: "e2e-demo.mp4" }],
              timings: {},
              render: {
                quality: "medium",
                subtitles_url: "/api/outputs/e2e-demo.vtt",
                retry_history: [{ attempt: 1, error: "first render failed" }],
              },
            },
            timestamp: 1,
          }],
        }],
        active_turns: [],
      }),
    }));
    await page.route("**/api/outputs/e2e-demo.mp4", (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: "" }));
    await page.route("**/api/outputs/e2e-demo.vtt", (route) => route.fulfill({ status: 200, contentType: "text/vtt", body: "WEBVTT\n" }));
    let rerenderPayload = null;
    await page.route("**/api/v1/plugins/math-animator/rerender", async (route) => {
      rerenderPayload = route.request().postDataJSON();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          parent_turn_id: "turn-e2e-manim-1234",
          render_id: "rerender-e2e",
          output_mode: "video",
          code: { language: "python", content: rerenderPayload.code },
          artifacts: [{ type: "video", url: "/api/outputs/e2e-edited.mp4", filename: "e2e-edited.mp4" }],
          quality: "medium",
        }),
      });
    });
    await page.route("**/api/outputs/e2e-edited.mp4", (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: "" }));
    await page.goto(`${BASE}/home/e2e-manim-viewer`, { waitUntil: "domcontentloaded" });
    const viewer = page.locator('[data-math-animator-viewer="true"]');
    await viewer.getByLabel("Playback speed").selectOption("1.5");
    await viewer.getByRole("button", { name: "Loop" }).click();
    await viewer.getByRole("button", { name: "Mute" }).click();
    const video = viewer.locator("video");
    if (!(await video.evaluate((element) => element.loop))) throw new Error("video loop preference was not applied");
    if (!(await video.evaluate((element) => element.muted))) throw new Error("video mute preference was not applied");
    if ((await video.locator("track[kind=captions]").count()) !== 1) throw new Error("captions track missing");
    await viewer.getByText("Render retry log").click();
    await viewer.getByText(/first render failed/).waitFor();
    await viewer.getByText("View Manim Code").click();
    await viewer.getByText(/class Demo/).waitFor();
    const codeDownload = page.waitForEvent("download");
    await viewer.getByRole("button", { name: "Download code" }).click();
    if ((await codeDownload).suggestedFilename() !== "manim-scene.py") {
      throw new Error("Manim code download lost its filename");
    }
    await viewer.getByRole("button", { name: "Edit source" }).click();
    const editor = viewer.getByLabel("Manim source code");
    await editor.fill("class Edited(Scene):\n    pass");
    await viewer.getByRole("button", { name: "Render edited source" }).click();
    await viewer.locator('video[src*="e2e-edited.mp4"]').waitFor();
    if (rerenderPayload?.parent_turn_id !== "turn-e2e-manim-1234") {
      throw new Error("edited Manim source lost its parent turn identity");
    }
    await page.close();
  });

  await run("agents hub and backend settings", async () => {
    const page = await browser.newPage();
    const assertNoApiFailures = monitorApiFailures(page);
    await page.route("**/api/v1/subagents/connections", async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ response });
    });
    await page.goto(`${BASE}/space/agents`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "My Agents" }).waitFor();
    await page.getByText("Imported agents", { exact: true }).waitFor();
    await page.getByText("Connected agents", { exact: true }).waitFor();
    const connectedRegion = page.locator('[aria-busy="true"]').last();
    await connectedRegion.waitFor({ state: "attached" });
    if (await page.getByText("No connected agents. Configure an installed backend to start using one.").count()) {
      throw new Error("connected-agent empty state flashed while the request was pending");
    }
    await page.locator('[aria-busy="false"]').last().waitFor({ state: "attached" });
    await page.goto(`${BASE}/settings/agents/codex`, { waitUntil: "networkidle" });
    await page.getByText("Permissions", { exact: true }).waitFor();
    await page.getByText("Runtime limit (seconds)", { exact: true }).waitFor();
    await page.getByText("Network access", { exact: true }).waitFor();
    await page.goto(`${BASE}/settings/agents/not-a-real-backend`, { waitUntil: "networkidle" });
    await page.getByText("Agent backend not found", { exact: true }).waitFor();
    if (await page.getByRole("button", { name: "Save", exact: true }).count()) {
      throw new Error("unknown agent backend exposed a save action");
    }
    assertNoApiFailures();
    await page.close();
  });

  await run("file preview and voice action", async () => {
    const page = await browser.newPage();
    const assertNoApiFailures = monitorApiFailures(page);
    const sessionRequests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/sessions/")) sessionRequests.push(request.url());
    });
    await page.route("**/api/v1/knowledge/references/deleted", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ knowledge_bases: [{
        name: "old-kb", status: "deleted", deleted_at: "2026-08-16T00:00:00Z", impact: {},
      }] }),
    }));
    await page.route("**/api/v1/sessions/e2e-preview**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "e2e-preview",
          session_id: "e2e-preview",
          title: "Preview contract",
          status: "completed",
          preferences: { capability: "chat", tools: [], knowledge_bases: ["old-kb"] },
          messages: [
            { id: 1, role: "user", content: "Review this file", capability: "chat", parent_message_id: null, metadata: { request_snapshot: { content: "Review this file", capability: "chat", enabledTools: [], knowledgeBases: ["old-kb"], language: "en" } }, attachments: [{ type: "text", filename: "lesson.txt", mime_type: "text/plain", extracted_text: "Fourier preview content" }] },
            {
              id: 2,
              role: "assistant",
              content: "The file explains a Fourier transform.",
              capability: "chat",
              parent_message_id: 1,
              events: [{ type: "tool_call", source: "chat", stage: "exploring", content: "read_source", metadata: { tool: "read_source" }, timestamp: 1 }],
              attachments: [{
                id: "generated-1",
                type: "file",
                filename: "solution.md",
                mime_type: "text/markdown",
                url: "/api/outputs/e2e/solution.md",
                extracted_text: "Generated Fourier solution",
                generated: true,
                size_bytes: 26,
              }],
            },
          ],
          active_turns: [],
        }),
      });
    });
    // This journey exercises the session-level autoplay toggle.  The UI only
    // exposes that control when TTS is ready, so keep the fixture explicit
    // about the deployment capability it requires.
    await page.route("**/api/v1/system/dependencies", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          dependencies: { media: { tts: { status: "configured" } } },
        }),
      });
    });
    let ttsCalls = 0;
    await page.route("**/api/v1/voice/tts", async (route) => {
      ttsCalls += 1;
      await route.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from([0]) });
    });
    await page.route("**/api/outputs/e2e/solution.md", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/markdown",
        headers: { "Content-Disposition": 'attachment; filename="solution.md"' },
        body: "Generated Fourier solution",
      });
    });
    await page.route("**/api/v1/notebook/list", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ notebooks: [{ id: "e2e-notebook", name: "E2E Notebook", record_count: 0 }] }),
      });
    });
    let savedRecord = null;
    await page.route("**/api/v1/notebook/add_record", async (route) => {
      savedRecord = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ record: { id: "saved-1", type: "chat", title: savedRecord.title } }),
      });
    });
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = () => Promise.resolve();
      HTMLMediaElement.prototype.pause = () => undefined;
    });
    await page.goto(`${BASE}/home/e2e-preview`, { waitUntil: "domcontentloaded" });
    const autoplay = page.getByRole("button", { name: "Auto-play for this chat" });
    await autoplay.waitFor({ state: "visible", timeout: 8_000 });
    await autoplay.click();
    if ((await autoplay.getAttribute("aria-pressed")) !== "true") {
      throw new Error("session autoplay override did not turn on");
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    const restoredAutoplay = page.getByRole("button", { name: "Auto-play for this chat" });
    await restoredAutoplay.waitFor({ state: "visible", timeout: 8_000 });
    if ((await restoredAutoplay.getAttribute("aria-pressed")) !== "true") {
      throw new Error("session autoplay override did not persist");
    }
    const attachment = page.getByRole("button", { name: /lesson\.txt/ });
    try {
      await attachment.waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      const main = await page.locator("main").innerText().catch(() => "(no main)");
      throw new Error(`attachment absent; requests=${sessionRequests.join(",") || "none"}; main=${main.slice(0, 300)}`);
    }
    await attachment.click();
    await page.getByRole("dialog", { name: /File preview/ }).waitFor();
    await page.getByText("Fourier preview content").waitFor();
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Activity" }).click();
    const activity = page.locator('[data-testid="session-activity-panel"]');
    await activity.waitFor({ state: "visible" });
    await activity.locator('[aria-busy="false"]').waitFor({ state: "visible" });
    await activity.getByText("Generated files", { exact: true }).waitFor();
    await activity.getByText("Tools used", { exact: true }).waitFor();
    await activity.getByText("Deleted source", { exact: true }).waitFor();
    await activity.getByRole("button", { name: /solution\.md/ }).click();
    const generatedPreview = page.getByRole("dialog", { name: /File preview: solution\.md/ });
    await generatedPreview.getByText("Generated Fourier solution").waitFor();
    const downloadPromise = page.waitForEvent("download");
    await generatedPreview.getByRole("link", { name: "Download" }).click();
    const generatedDownload = await downloadPromise;
    if (generatedDownload.suggestedFilename() !== "solution.md") {
      throw new Error(`unexpected generated filename ${generatedDownload.suggestedFilename()}`);
    }
    await generatedPreview.getByRole("button", { name: "Close" }).click();
    await activity.getByRole("button", { name: "Close" }).click();

    const exportPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export Markdown" }).click();
    const exportDownload = await exportPromise;
    const exportPath = await exportDownload.path();
    const exportedMarkdown = fs.readFileSync(exportPath, "utf8");
    if (!exportedMarkdown.includes("Review this file") || !exportedMarkdown.includes("[solution.md](/api/outputs/e2e/solution.md)")) {
      throw new Error("Markdown export omitted conversation content or generated file link");
    }

    const assistant = page.locator('[data-chat-message="assistant"]').last();
    await assistant.hover();
    await assistant.getByRole("button", { name: "Save to notebook" }).click();
    const saveDialog = page.getByRole("dialog");
    await saveDialog.getByRole("combobox").selectOption("e2e-notebook");
    await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
    await saveDialog.waitFor({ state: "hidden" });
    if (savedRecord?.notebook_ids?.[0] !== "e2e-notebook" || savedRecord?.output !== "The file explains a Fourier transform.") {
      throw new Error(`unexpected saved notebook payload ${JSON.stringify(savedRecord)}`);
    }

    await assistant.hover();
    await assistant.getByRole("button", { name: "Play aloud" }).click();
    await page.waitForFunction(() => true, null, { timeout: 500 });
    if (ttsCalls !== 1) throw new Error(`expected one TTS request, got ${ttsCalls}`);
    await restoredAutoplay.click();
    assertNoApiFailures();
    await page.close();
  });

  await run("playground unavailable detail", async () => {
    const page = await browser.newPage();
    await page.route("**/api/v1/plugins/list", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tools: [],
        capabilities: [{
          name: "math_animator",
          description: "Render a Manim animation",
          stages: ["generating", "rendering"],
          tools_used: [],
          availability: {
            name: "math_animator",
            available: false,
            install_hint: "Install the math-animator extra and restart Cognivoy.",
          },
        }],
      }),
    }));
    await page.goto(`${BASE}/playground`, { waitUntil: "networkidle" });
    await page.getByText("Install the math-animator extra and restart Cognivoy.").waitFor();
    const runButton = page.getByRole("button", { name: "Run", exact: true });
    if (await runButton.isEnabled()) throw new Error("unavailable capability can still run");
    await page.close();
  });

  await run("unavailable capability lock", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const assertNoApiFailures = monitorApiFailures(page);
    await page.route("**/api/v1/settings", (route) => route.fulfill({ contentType: "application/json", body: "{}" }));
    await page.route("**/api/v1/settings/llm-options", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ active: null, options: [] }) }));
    await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Feature locked" }).waitFor({ timeout: 10_000 });
    assertNoApiFailures();
    await context.close();
  });

  await run("access service failure recovery", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let serviceAvailable = false;
    await page.route("**/api/v1/settings", (route) => route.fulfill(
      serviceAvailable
        ? { contentType: "application/json", body: JSON.stringify({ catalog: { llm: [] } }) }
        : { status: 500, contentType: "application/json", body: JSON.stringify({ detail: "temporary outage" }) },
    ));
    await page.goto(`${BASE}/home`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Could not verify feature access" }).waitFor({ timeout: 10_000 });
    const homeNav = page.getByRole("link", { name: "Home" });
    if (!(await homeNav.isVisible())) throw new Error("gated navigation disappeared during access outage");
    serviceAvailable = true;
    await page.getByRole("button", { name: "Retry access check" }).click();
    await page.getByLabel("Ask anything…").waitFor({ state: "visible", timeout: 10_000 });
    await context.close();
  });

  await run("access refresh ignores stale failures", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let calls = 0;
    let markFirstRequestStarted;
    const firstRequestStarted = new Promise((resolve) => {
      markFirstRequestStarted = resolve;
    });
    await page.route("**/api/v1/settings", async (route) => {
      calls += 1;
      if (calls === 1) {
        markFirstRequestStarted();
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
      } else {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ catalog: { llm: [] } }) });
      }
    });
    await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
    // A focus event fired before React installs the listener cannot start a
    // competing refresh. Wait until the initial access request proves the
    // provider is mounted, then trigger the newer request deterministically.
    await Promise.race([
      firstRequestStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("initial access request did not start")), 5_000)),
    ]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByLabel("Ask anything…").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(600);
    if (await page.getByRole("heading", { name: "Could not verify feature access" }).isVisible()) {
      throw new Error("stale access failure overwrote the newer successful refresh");
    }
    await context.close();
  });

  await browser.close();
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name} (${result.seconds}s)${result.error ? ` — ${result.error}` : ""}`);
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} migration flows passed`);
  process.exit(failed.length ? 1 : 0);
})();
