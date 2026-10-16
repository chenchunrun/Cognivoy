/* Browser contract: KB PPTX file → layout-preserving slides → model-readable text. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
function assert(condition, message) { if (!condition) throw new Error(message); }

(async () => {
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => {
    localStorage.setItem("language", "en");
    localStorage.setItem("cognivoy.language", "en");
  });
  await page.route("**/api/v1/knowledge/list*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([{ name: "Presentation KB", status: "ready", is_default: true, metadata: { provider: "llamaindex" } }]),
  }));
  await page.route("**/api/v1/knowledge/rag-providers", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ providers: [{ id: "llamaindex", name: "LlamaIndex", configured: true }] }),
  }));
  await page.route("**/api/v1/knowledge/supported-file-types", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ extensions: [".pptx"], accept: ".pptx", max_file_size_bytes: 10485760 }),
  }));
  await page.route("**/api/v1/knowledge/Presentation%20KB/files", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ files: [{ name: "architecture.pptx", type: "file", size: 4096, mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }] }),
  }));
  await page.route("**/api/v1/knowledge/Presentation%20KB/file-preview-slides/architecture.pptx", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ filename: "architecture.pptx", width: 1600, height: 900, slide_count: 2, slides: [
      { number: 1, shapes: [{ kind: "text", text: "System architecture", x: 0.1, y: 0.1, width: 0.8, height: 0.2 }] },
      { number: 2, shapes: [{ kind: "text", text: "Delivery roadmap", x: 0.2, y: 0.3, width: 0.6, height: 0.2 }] },
    ] }),
  }));
  await page.route("**/api/v1/knowledge/Presentation%20KB/file-preview-text/architecture.pptx", (route) => route.fulfill({
    contentType: "text/plain", body: "--- Slide 1 ---\nSystem architecture\n--- Slide 2 ---\nDelivery roadmap",
  }));
  try {
    await page.goto(`${BASE}/knowledge?kb=Presentation%20KB`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "architecture.pptx" }).click();
    const preview = page.getByTestId("pptx-slide-preview");
    await preview.waitFor();
    assert(await preview.getByTestId("pptx-slide").count() === 2, "slide count was not preserved");
    await preview.getByText("System architecture", { exact: true }).waitFor();
    await preview.getByText("Delivery roadmap", { exact: true }).waitFor();
    await preview.getByText("Model-readable slide text").click();
    await preview.getByText("--- Slide 1 ---", { exact: false }).waitFor();
    assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
    console.log("PASS PPTX preview: KB file → geometry-preserving slides → model-readable text");
  } finally {
    await page.close(); await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
