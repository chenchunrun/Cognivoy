/* Browser contract: an enabled channel with missing credentials is blocked in
 * the client and never sends a PATCH capable of poisoning server startup. */
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
    const pageErrors = [];
    const patches = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route("**/api/v1/partners/tutor**", async (route) => {
      if (route.request().method() === "PATCH") patches.push(route.request().postDataJSON());
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          partner_id: "tutor",
          name: "Channel Safety Tutor",
          description: "",
          channels: {},
          language: "en",
          running: false,
          started_at: null,
        }),
      });
    });
    await page.route("**/api/v1/partners/tool-options", (route) =>
      route.fulfill({ contentType: "application/json", body: '{"tools":[],"builtin_tools":[],"mcp_tools":[]}' }),
    );
    await page.route("**/api/v1/partners/channels/schema", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          channels: {
            telegram: {
              name: "telegram",
              display_name: "Telegram",
              available: true,
              default_config: { enabled: false, token: "", allow_from: [] },
              secret_fields: ["token"],
              required_when_enabled: ["token", "allow_from"],
              json_schema: {
                type: "object",
                properties: {
                  enabled: { type: "boolean", title: "Enabled", default: false },
                  token: { type: "string", title: "Token", default: "" },
                  allow_from: { type: "array", title: "Allow From", items: { type: "string" } },
                },
              },
            },
          },
        }),
      }),
    );
    await page.route("**/api/v1/settings/llm-options**", (route) =>
      route.fulfill({ contentType: "application/json", body: '{"options":[]}' }),
    );

    await page.goto(`${BASE}/partners/tutor`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Channels", exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Complete required channel settings").waitFor();

    assert(patches.length === 0, "invalid channel form sent a PATCH request");
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);
    console.log("PASS partner channel safety: invalid credentials blocked before PATCH");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL partner channel safety:", error);
  process.exit(1);
});
