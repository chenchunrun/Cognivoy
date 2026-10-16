/* Browser contract: missing index prerequisites are visible and block creation. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
function assert(condition, message) { if (!condition) throw new Error(message); }

(async () => {
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  const failedPreflight = {
    ok: false,
    checks: [{
      key: "embedding",
      label: "Active embedding model",
      ok: false,
      detail: "Configure one under Settings → Embedding.",
      optional: false,
    }],
  };
  await page.addInitScript(() => localStorage.setItem("cognivoy-language", "en"));
  await page.route("**/api/v1/knowledge/list*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([{
      name: "failed-kb",
      status: "error",
      metadata: {
        rag_provider: "llamaindex",
        last_error: "No active embedding model is configured.",
        last_error_at: "2026-08-17T10:00:00",
      },
      progress: {
        stage: "error",
        error: "No active embedding model is configured.",
        task_id: "kb_init_test",
      },
      statistics: { raw_documents: 1, status: "error" },
    }]),
  }));
  await page.route("**/api/v1/knowledge/rag-providers", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ providers: [{
      id: "llamaindex",
      name: "LlamaIndex",
      description: "Local vector retrieval with hybrid BM25/vector fusion. Requires an active embedding model.",
      configured: true,
      ready: false,
      preflight: failedPreflight,
      requires_api_key: false,
      linkable: true,
    }] }),
  }));
  await page.route("**/api/v1/knowledge/rag-pipelines/llamaindex/preflight", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify(failedPreflight),
  }));
  await page.route("**/api/v1/knowledge/supported-file-types*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ extensions: [".txt"], accept: ".txt", max_file_size_bytes: 1048576 }),
  }));

  try {
    await page.goto(`${BASE}/knowledge`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.getByText("The last task failed", { exact: true }).waitFor();
    assert(
      await page.getByRole("link", { name: "Open embedding settings" }).first().getAttribute("href") === "/settings/embedding",
      "persisted failure did not expose the repair CTA after reload",
    );
    const createButton = page.getByRole("button", { name: "Create knowledge base" }).first();
    await createButton.waitFor();
    await createButton.click();
    const dialog = page.getByRole("dialog");
    await page.waitForTimeout(700);
    const dialogText = await dialog.innerText();
    assert(
      dialogText.includes("Complete the required setup before creating this knowledge base."),
      `required setup warning was not visible: ${dialogText}`,
    );
    const settingsLink = dialog.getByRole("link", { name: "Open embedding settings" });
    assert(await settingsLink.getAttribute("href") === "/settings/embedding", "repair CTA points to the wrong settings page");
    assert(!(await dialog.getByRole("button", { name: "Create", exact: true }).isEnabled()), "create remained enabled with a failed required preflight");
    console.log("PASS knowledge preflight: persisted failure → visible requirement → repair CTA → creation blocked");
  } finally {
    await page.close(); await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
