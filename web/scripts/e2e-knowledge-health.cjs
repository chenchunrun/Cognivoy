/* Browser contract: a selected KB exposes a read-only, actionable retrieval health report. */
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
  const page = await browser.newPage();
  const errors = [];
  let healthRequested = false;
  let language = "en";
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(() => {
    const locale = document.cookie.split(";").some((part) => part.trim() === "cognivoy-lang=zh") ? "zh" : "en";
    localStorage.setItem("cognivoy-language", locale);
    localStorage.setItem("cognivoy-response-language", locale);
  });
  await page.context().addCookies([{ name: "cognivoy-lang", value: "en", url: BASE }]);
  await page.route("**/api/v1/settings/ui", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ language, response_language: language }) }),
  );

  const kb = {
    id: "user:kb:health-e2e",
    name: "health-e2e",
    status: "ready",
    is_default: true,
    metadata: { rag_provider: "llamaindex", last_indexed_at: "2026-08-20T08:00:00Z" },
    statistics: {
      raw_documents: 1,
      rag_provider: "llamaindex",
      rag_initialized: true,
      active_match: true,
      needs_reindex: false,
      active_signature: "healthy-signature",
      index_versions: [{ signature: "healthy-signature", model: "text-embedding", dimension: 1024, ready: true }],
    },
  };
  await page.route("**/api/v1/knowledge/list*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify([kb]) }),
  );
  await page.route("**/api/v1/knowledge/user%3Akb%3Ahealth-e2e/files*", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"files":[]}' }),
  );
  await page.route("**/api/v1/knowledge/health-e2e/files*", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"files":[]}' }),
  );
  await page.route("**/api/v1/knowledge/user%3Akb%3Ahealth-e2e/retrieval-health", (route) => {
    healthRequested = true;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        knowledge_base: "health-e2e",
        provider: "llamaindex",
        ready: false,
        checked_at: "2026-08-20T08:00:00Z",
        checks: [
          { key: "source_documents", label: "Source documents", ok: true, detail: "1 source document(s) found.", detail_key: "{{count}} source document(s) found.", parameters: { count: 1 }, optional: false },
          { key: "active_index", label: "Active index", ok: false, detail: "No queryable index matches the active retrieval configuration.", detail_key: "No queryable index matches the active retrieval configuration.", optional: false, action: { label: "Re-index", href: "/knowledge?kb=health-e2e" } },
        ],
      }),
    });
  });

  try {
    await page.goto(`${BASE}/knowledge?kb=user%3Akb%3Ahealth-e2e`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Index versions", exact: false }).waitFor();
    await page.getByText("Active version", { exact: true }).waitFor();
    const trigger = page.getByTestId("knowledge-retrieval-health");
    await trigger.waitFor();
    await trigger.click();
    await page.getByText("Retrieval needs attention", { exact: true }).waitFor();
    await page.getByText("1 source document(s) found.", { exact: true }).waitFor();
    const repair = page.getByRole("link", { name: "Re-index" });
    assert((await repair.getAttribute("href")) === "/knowledge?kb=health-e2e", "health repair action is not deep-linked");
    assert(healthRequested, "retrieval health endpoint was not called");

    // Rendering contracts use explicit API fixtures; the separate keyword gate
    // verifies a real index with no mocked retrieval or knowledge API calls.
    kb.statistics.retrieval_profile = "keyword";
    for (const locale of ["en", "zh"]) {
      language = locale;
      await page.context().addCookies([{ name: "cognivoy-lang", value: locale, url: BASE }]);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: locale === "en" ? "Keyword text index" : "关键词文本索引", exact: true }).waitFor();
      await page.getByTestId("knowledge-keyword-index-status").getByText(locale === "en" ? "Keyword index is ready" : "关键词索引已就绪", { exact: true }).waitFor();
      const history = page.getByTestId("knowledge-stored-vector-indexes");
      await history.locator("summary").click();
      await history.getByText("text-embedding", { exact: true }).waitFor();
      await history.getByText(locale === "en" ? "These indexes are preserved for vector modes and are not used by keyword retrieval." : "这些索引保留供向量模式使用，关键词检索不会调用它们。", { exact: true }).waitFor();
      assert(await history.getByText(locale === "en" ? "Active version" : "当前激活版本", { exact: true }).count() === 0, "A stored vector version was shown as active in keyword mode");
      await page.screenshot({ path: require("node:path").join(__dirname, "..", "test-results", `keyword-index-history-${locale}.png`), fullPage: true });
    }
    kb.statistics.index_versions = [];
    kb.statistics.rag_initialized = false;
    kb.statistics.active_match = false;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("knowledge-keyword-index-status").getByText("关键词索引尚未就绪", { exact: true }).waitFor();
    assert(await page.getByTestId("knowledge-stored-vector-indexes").count() === 0, "Empty vector history should not obscure keyword readiness");
    assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
    console.log("PASS knowledge health: selected KB → readiness checks → actionable repair link; keyword readiness + preserved vector history in EN/ZH");
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL knowledge health:", error);
  process.exit(1);
});
