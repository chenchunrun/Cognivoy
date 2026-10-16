/* Browser contract: Home is always a fresh-chat entry point. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

(async () => {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem("language", "en");
    localStorage.setItem("cognivoy.language", "en");
  });
  const page = await context.newPage();
  const sessionId = "e2e-home-history";
  const oldReply = "THIS OLD SESSION MUST DISAPPEAR";

  await page.route(`**/api/v1/sessions/${sessionId}**`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: sessionId,
        session_id: sessionId,
        title: "Historical session",
        status: "completed",
        preferences: { capability: "chat", tools: [], knowledge_bases: [] },
        active_turns: [],
        messages: [
          {
            id: 1,
            role: "user",
            content: "Historical request",
            capability: "chat",
            parent_message_id: null,
          },
          {
            id: 2,
            role: "assistant",
            content: oldReply,
            capability: "chat",
            parent_message_id: 1,
          },
        ],
      }),
    }),
  );

  await page.goto(`${BASE}/home/${sessionId}`, { waitUntil: "networkidle" });
  await page.getByText(oldReply).waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.waitForURL(`${BASE}/home`);
  await page.getByRole("heading", {
    name: "How can I help you learn today?",
  }).waitFor({ state: "visible" });
  if (await page.getByText(oldReply).count()) {
    throw new Error("Home retained the historical transcript");
  }

  console.log("PASS home navigation opens a fresh conversation");
  await browser.close();
})().catch((error) => {
  console.error("FAIL home navigation:", error);
  process.exit(1);
});
