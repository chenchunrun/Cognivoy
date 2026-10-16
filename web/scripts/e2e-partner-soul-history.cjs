/* Browser contract: every distinct Soul save creates a revision and restoring
 * an older revision updates the editor without destroying the newer content. */
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const partner = {
  partner_id: "tutor",
  name: "Calculus Tutor",
  description: "Persistent study partner",
  channels: {},
  language: "en",
  running: false,
  started_at: null,
};

let currentSoul = "# Soul\nInitial teaching policy";
let versions = [
  { id: "v1", saved_at: "2026-08-15T08:00:00Z", content: currentSoul },
];

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await (await browser.newContext()).newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route("**/api/v1/partners/tutor**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (path.endsWith("/soul/versions")) {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ versions }),
        });
      }
      const restoreMatch = path.match(/\/soul\/versions\/([^/]+)\/restore$/);
      if (restoreMatch && request.method() === "POST") {
        const target = versions.find((version) => version.id === restoreMatch[1]);
        assert(target, "restore requested an unknown version");
        currentSoul = target.content;
        versions = [
          { id: `v${versions.length + 1}`, saved_at: "2026-08-15T10:00:00Z", content: currentSoul },
          ...versions,
        ];
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ content: currentSoul, restored: true }),
        });
      }
      if (path.endsWith("/soul")) {
        if (request.method() === "PUT") {
          currentSoul = request.postDataJSON().content;
          versions = [
            { id: "v2", saved_at: "2026-08-15T09:00:00Z", content: currentSoul },
            ...versions,
          ];
          return route.fulfill({ contentType: "application/json", body: '{"saved":true}' });
        }
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ content: currentSoul }),
        });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(partner) });
    });
    await page.route("**/api/v1/partners/tool-options", (route) =>
      route.fulfill({ contentType: "application/json", body: '{"tools":[],"builtin_tools":[],"mcp_tools":[]}' }),
    );
    await page.route("**/api/v1/partners/channels/schema", (route) =>
      route.fulfill({ contentType: "application/json", body: '{"channels":{}}' }),
    );
    await page.route("**/api/v1/settings/llm-options**", (route) =>
      route.fulfill({ contentType: "application/json", body: '{"options":[]}' }),
    );

    await page.goto(`${BASE}/partners/tutor`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Soul", exact: true }).click();
    const editor = page.getByPlaceholder(/# Soul/);
    await editor.waitFor();
    await editor.fill("# Soul\nRevised teaching policy");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Soul saved").waitFor();
    assert(versions.length === 2, "save did not create a Soul version");

    const restoreButtons = page.getByRole("button", { name: "Restore", exact: true });
    await restoreButtons.nth(1).click();
    await page.getByRole("button", { name: "Restore", exact: true }).last().click();
    await page.getByText("Soul version restored").waitFor();
    assert((await editor.inputValue()) === "# Soul\nInitial teaching policy", "editor did not receive restored Soul");
    assert(versions.length === 3, "rollback did not preserve a new reversible version");
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);

    console.log("PASS partner Soul history: save revision + reversible rollback");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL partner Soul history:", error);
  process.exit(1);
});
