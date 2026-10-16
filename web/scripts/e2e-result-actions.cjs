/* Browser contract: capability results expose actionable learning workflows. */
const { chromium } = require("@playwright/test");
const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {};
function assert(condition, message) { if (!condition) throw new Error(message); }

function session(id, capability, content, metadata = {}) {
  return { id, session_id: id, title: id, status: "completed", preferences: { capability }, active_turns: [], messages: [
    { id: 1, role: "user", content: "Original request", capability, parent_message_id: null },
    { id: 2, role: "assistant", content, capability, parent_message_id: 1, events: [{ type: "result", source: capability, stage: "writing", content: "", timestamp: 1, metadata }] },
  ] };
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();
  await context.addInitScript(() => { localStorage.setItem("language", "en"); localStorage.setItem("cognivoy.language", "en"); });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const sessions = {
    "e2e-solve-actions": session("e2e-solve-actions", "deep_solve", "Step 1: factor the polynomial. Verification: substitute the roots."),
    "e2e-research-actions": session("e2e-research-actions", "deep_research", "# Evidence report\n\nA cited conclusion."),
    "e2e-math-captions": session("e2e-math-captions", "math_animator", "Animation ready", {
      response: "Animation ready", output_mode: "video", timings: { render: 1 },
      code: { language: "python", content: "class Scene: pass" },
      artifacts: [{ type: "video", url: "/api/outputs/test.mp4", filename: "test.mp4" }],
      render: { quality: "medium", subtitles_url: "/api/outputs/captions.vtt", subtitles_language: "en" },
    }),
  };
  await page.route("**/api/v1/sessions/e2e-**", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(sessions[id]) });
  });
  const researchDocument = { id: "research-doc", title: "Research report", content: "# Evidence report", revision: 1, created_at: 1, updated_at: 1 };
  await page.route("**/api/v1/co_writer/documents", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(researchDocument) }));
  // The handoff is not complete at navigation alone: the destination editor
  // must be able to load the document returned by the creation request.
  await page.route("**/api/v1/co_writer/documents/research-doc", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(researchDocument) }));
  await page.route("**/api/outputs/test.mp4", (route) => route.fulfill({ contentType: "video/mp4", body: "" }));
  await page.route("**/api/outputs/captions.vtt", (route) => route.fulfill({ contentType: "text/vtt", body: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nExplain the equation" }));
  try {
    await page.goto(`${BASE}/home/e2e-solve-actions`, { waitUntil: "domcontentloaded" });
    const solve = page.getByTestId("deep-solve-actions");
    await solve.waitFor();
    assert(await solve.getByRole("button").count() === 5, "deep solve actions are incomplete");
    await solve.getByRole("button", { name: "Ask about a step" }).click();
    assert((await page.getByLabel("Ask anything…").inputValue()).startsWith("I have a question"), "step follow-up did not prefill composer");
    await solve.getByRole("button", { name: "Visualize solution" }).click();
    assert((await page.getByLabel("Ask anything…").inputValue()).includes("Visualize this solution"), "visualize did not preserve solution context");

    await page.goto(`${BASE}/home/e2e-research-actions`, { waitUntil: "domcontentloaded" });
    const research = page.getByTestId("deep-research-actions");
    await research.waitFor();
    assert(await research.getByRole("button").count() === 5, "research actions are incomplete");
    await research.getByRole("button", { name: "Create book" }).click();
    await page.waitForURL(/\/book\?create=book-draft%3Adeep_research/, { timeout: 10000 });
    const bookIntent = page.getByLabel("What should this book teach?");
    await bookIntent.waitFor({ timeout: 10000 });
    assert((await bookIntent.inputValue()).includes("# Evidence report"), "research report did not prefill the reviewed book creator");

    await page.goto(`${BASE}/home/e2e-research-actions`, { waitUntil: "domcontentloaded" });
    const researchAgain = page.getByTestId("deep-research-actions");
    await researchAgain.waitFor();
    await researchAgain.getByRole("button", { name: "Continue in Co-Writer" }).click();
    await page.waitForURL("**/co-writer/research-doc");

    await page.goto(`${BASE}/home/e2e-math-captions`, { waitUntil: "domcontentloaded" });
    const captions = page.getByRole("button", { name: "Hide captions" });
    await captions.waitFor();
    assert((await page.locator('track[kind="captions"]').getAttribute("src"))?.includes("captions.vtt"), "caption track was not attached");
    await captions.click();
    await page.getByRole("button", { name: "Show captions" }).waitFor();
    assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
    console.log("PASS result actions: solve workflows → research handoff → math captions");
  } finally { await page.close(); await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
