/* Auth-enabled browser contracts: inline login throttling, editable profile,
 * and the real administrator user table (not only disabled/forbidden states). */
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};
const PRD_SCREENSHOT_DIR = path.join(__dirname, "..", "..", "docs", "prd", "screenshots", "pages");

async function capturePrdScreenshot(page, name) {
  if (process.env.UPDATE_PRD_SCREENSHOTS !== "1") return;
  fs.mkdirSync(PRD_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(PRD_SCREENSHOT_DIR, name) });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem("cognivoy-language", "en");
      localStorage.setItem("cognivoy-response-language", "en");
    });
    const page = await context.newPage();
    const browserErrors = [];
    let authenticated = false;
    let displayName = "Alice Admin";
    let bobDisabled = false;
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.route("**/api/v1/auth/status", (route) => route.fulfill({
      headers: { "Cache-Control": "no-store" },
      contentType: "application/json",
      body: JSON.stringify(authenticated
        ? {
            enabled: true,
            authenticated: true,
            user_id: "u_alice",
            username: "alice",
            display_name: displayName,
            role: "admin",
            is_admin: true,
            avatar: "",
          }
        : { enabled: true, authenticated: false, is_admin: false, avatar: "" }),
    }));
    await page.route("**/api/v1/auth/login", (route) => route.fulfill({
      status: 429,
      headers: { "Retry-After": "120" },
      contentType: "application/json",
      body: JSON.stringify({ detail: "Too many login attempts. Try again later." }),
    }));

    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Username").fill("alice");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText("Too many login attempts. Try again later.").waitFor();

    authenticated = true;
    await page.route("**/api/v1/auth/profile", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        if (body.display_name) displayName = body.display_name;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true, avatar: "", display_name: displayName }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "u_alice",
          username: "alice",
          display_name: displayName,
          role: "admin",
          created_at: "2026-08-16T00:00:00Z",
          disabled: false,
          avatar: "",
        }),
      });
    });
    await page.goto(`${BASE}/profile`, { waitUntil: "domcontentloaded" });
    const nameInput = page.getByLabel("Display name");
    await nameInput.waitFor();
    assert((await nameInput.inputValue()) === "Alice Admin", "display name did not load");
    await nameInput.fill("Alice Mentor");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Profile updated").waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await nameInput.waitFor();
    assert((await nameInput.inputValue()) === "Alice Mentor", "display name did not survive reload");
    await capturePrdScreenshot(page, "profile-authenticated.png");

    await page.route("**/api/v1/auth/users", (route) => route.fulfill({
      headers: { "Cache-Control": "no-store" },
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "u_alice",
          username: "alice",
          display_name: "Alice Mentor",
          role: "admin",
          created_at: "2026-08-16T00:00:00Z",
          disabled: false,
          avatar: "",
        },
        {
          id: "u_bob",
          username: "bob",
          display_name: "Bob Student",
          role: "user",
          created_at: "2026-08-16T01:00:00Z",
          disabled: bobDisabled,
          avatar: "",
        },
      ]),
    }));
    await page.route("**/api/v1/auth/users/bob/disabled", async (route) => {
      const body = route.request().postDataJSON();
      bobDisabled = body.disabled === true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, username: "bob", disabled: bobDisabled }),
      });
    });
    await page.route("**/api/v1/auth/users/bob/deletion-impact", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        username: "bob", user_id: "u_bob", workspace_exists: true, workspace_shared: false,
        resources: { knowledge_bases: 2, books: 3, documents: 4, notebooks: 5, memory_files: 6 },
        file_count: 42, total_bytes: 8192, policy: "preserve_workspace",
      }),
    }));
    const usersContract = await page.evaluate(() =>
      fetch("/api/v1/auth/users", { cache: "no-store" }).then((response) => response.json()),
    );
    assert(usersContract.length === 2, "authenticated user-list contract was not reachable");
    await page.goto(`${BASE}/admin/users`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "User Management" }).waitFor();
    if (await page.getByText("Admin only", { exact: true }).isVisible().catch(() => false)) {
      throw new Error("authenticated admin was incorrectly blocked by the page gate");
    }
    await page.getByText("2 users", { exact: true }).waitFor();
    if (!(await page.getByText("Alice Mentor", { exact: false }).first().isVisible().catch(() => false))) {
      throw new Error(`display names missing from admin table: ${(await page.locator("body").innerText()).slice(0, 1000)}`);
    }
    await page.getByText("@alice", { exact: true }).waitFor();
    await page.getByText("Bob Student", { exact: true }).waitFor();
    await capturePrdScreenshot(page, "admin-users-authenticated.png");
    await page.getByLabel("Search users").fill("student");
    assert(await page.getByText("Bob Student", { exact: true }).isVisible(), "display-name search failed");
    await page.getByLabel("Disable bob").click();
    await page.getByRole("button", { name: "Disable user", exact: true }).click();
    await page.getByText("Disabled", { exact: true }).waitFor();
    assert(bobDisabled, "disable request was not persisted");
    await page.getByLabel("Restore bob").click();
    await page.getByRole("button", { name: "Restore user", exact: true }).click();
    await page.getByText("Active", { exact: true }).last().waitFor();
    assert(!bobDisabled, "restore request was not persisted");
    await page.getByLabel("Delete bob").click();
    await page.getByText(/42 files, 8192 bytes; 2 knowledge bases, 3 books, 4 documents and 5 notebooks/).waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert(browserErrors.length === 0, `browser errors: ${browserErrors.slice(0, 3).join("; ")}`);

    console.log("PASS auth: throttled login + editable profile + disable/restore + deletion impact");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL auth profile E2E:", error);
  process.exit(1);
});
