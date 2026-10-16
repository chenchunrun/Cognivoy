/* Recent-learning sidebar layout/navigation contract.
 * All browser business API/WS calls and external traffic are intercepted.
 * Run against an isolated frontend whose SSR API base is unreachable:
 * BASE_URL=http://127.0.0.1:3795 node scripts/e2e-sidebar-recent.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect: playwrightExpect } = require("@playwright/test");
const expect = playwrightExpect.configure({ timeout: 20_000 });
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3783").replace(/\/$/, "");
const origin = new URL(BASE);
assert(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Only test a local frontend");
assert(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password, "Use a credential-free HTTP(S) origin");
assert(origin.pathname === "/" && !origin.search && !origin.hash, "Use a plain local origin");
const OUTPUT = path.resolve(__dirname, "../test-results/sidebar-recent");
fs.mkdirSync(OUTPUT, { recursive: true });

const sessions = Array.from({ length: 8 }, (_, index) => ({
  id: `e2e-sidebar-${index + 1}`,
  session_id: `e2e-sidebar-${index + 1}`,
  title: `第 ${index + 1} 次学习：CISA 信息系统审计与智能学习伙伴的长标题测试 — ${"Learning journey ".repeat(5)}`,
  created_at: 1,
  updated_at: Math.floor(Date.now() / 1000) - index * 3600,
  message_count: 2,
  last_message: `Fixture response ${index + 1}`,
  status: "completed",
  preferences: { capability: "chat", tools: [], knowledge_bases: [] },
}));

function detail(id) {
  const summary = sessions.find((item) => item.session_id === id);
  assert(summary, `Unknown session fixture ${id}`);
  return {
    ...summary,
    active_turns: [],
    messages: [
      { id: 1, role: "user", content: `Fixture request ${id}`, capability: "chat", parent_message_id: null },
      { id: 2, role: "assistant", content: `Fixture response ${id}`, capability: "chat", parent_message_id: 1 },
    ],
  };
}

async function environment(browser, { viewport, mode = "normal", language = "en", theme = "light", authEnabled = true }) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 768, serviceWorkers: "block" });
  const writes = [], modelStarts = [], errors = [], unexpectedConsoleErrors = [], apiRequests = [], blockedExternal = [];
  let releaseLoading;
  let fixtureMode = mode;
  const loadingGate = new Promise((resolve) => { releaseLoading = resolve; });
  await context.addCookies([{ name: "cognivoy-lang", value: language, url: BASE }]);
  await context.addInitScript(({ language, theme }) => {
    if (window !== window.top) return;
    localStorage.setItem("cognivoy-language", language);
    localStorage.setItem("cognivoy-theme", theme);
    localStorage.setItem("cognivoy.sidebarCollapsed", "0");
  }, { language, theme });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== origin.origin) { blockedExternal.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith("/api/")) apiRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`);
      return json({ success: true });
    }
    if (url.pathname === "/api/v1/sessions") {
      const sidebarRequest = url.searchParams.get("limit") === "8";
      if (sidebarRequest && fixtureMode === "loading") await loadingGate;
      if (sidebarRequest && fixtureMode === "error") return json({ detail: "Fixture session-list failure" }, 503);
      return json({ sessions: sidebarRequest && fixtureMode === "empty" ? [] : sessions, total: sessions.length });
    }
    const match = url.pathname.match(/^\/api\/v1\/sessions\/(e2e-sidebar-[1-8])$/);
    if (match) return json(detail(match[1]));
    if (url.pathname === "/api/v1/auth/status") return json({ enabled: authEnabled, authenticated: true, is_admin: true, username: authEnabled ? "sidebar-fixture" : null });
    if (url.pathname === "/api/v1/settings") return json({ catalog: {}, ui: { voice_autoplay: false } });
    if (url.pathname === "/api/v1/settings/llm-options") return json({ active: { profile_id: "fixture", model_id: "fixture" }, options: [{ profile_id: "fixture", model_id: "fixture", profile_name: "Fixture", model_name: "No model calls", model: "fixture", provider: "openai", is_active_default: true }] });
    if (url.pathname === "/api/v1/learning/dashboard") return json({ active_projects: 0, recent_projects: [], next_action: null });
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return json({});
    return route.continue();
  });
  // Only the exact local Next dev HMR endpoint is permitted to connect.
  await context.routeWebSocket((url) => !(url.host === origin.host && url.pathname === "/_next/hmr"), (socket) => socket.onMessage((raw) => {
    let message; try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    if (["start_turn", "message", "regenerate"].includes(message.type)) modelStarts.push(message.type);
  }));
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (mode === "error" && /503 \(Service Unavailable\)/.test(message.text())) return;
    unexpectedConsoleErrors.push(message.text());
  });
  return {
    page, apiRequests, releaseLoading, setMode(nextMode) { fixtureMode = nextMode; },
    evidence: () => ({ errors, unexpectedConsoleErrors, writes, modelStarts, blockedExternal, apiRequests }),
    assertIsolation() {
      assert.deepEqual(errors, [], "Browser page errors occurred");
      assert.deepEqual(unexpectedConsoleErrors, [], "Unexpected browser console errors occurred");
      assert.deepEqual(writes, [], "Read-only sidebar test attempted a write");
      assert.deepEqual(modelStarts, [], "Sidebar test attempted a model call");
    },
    async close() { releaseLoading(); await context.close(); },
  };
}

async function openSidebar(page, authEnabled = true) {
  // The server-rendered Menu is visible before React's initial route effect.
  // Wait for the client-only authenticated fixture before interacting, so the
  // initial effect cannot close a just-opened drawer during hydration.
  if (authEnabled) await expect(page.getByTestId("sidebar-footer").getByText("sidebar-fixture", { exact: true })).toHaveCount(1);
  else await expect(page.getByTestId("sidebar-recent-list").locator("li")).toHaveCount(8);
  if (page.viewportSize().width < 768) await page.getByRole("button", { name: /^(Menu|菜单)$/ }).click();
  await expect.poll(() => page.getByTestId("sidebar").evaluate((element) => Math.round(element.getBoundingClientRect().x))).toBe(0);
}

async function footerAlignment(page, authEnabled = true) {
  const layout = await page.getByTestId("sidebar-footer").evaluate((footer) => {
    const byId = (id) => footer.querySelector(`[data-testid="${id}"]`);
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, centerX: rect.x + rect.width / 2 };
    };
    const navigation = byId("sidebar-footer-navigation"), controls = byId("sidebar-footer-controls");
    const user = byId("sidebar-user");
    const userButton = user?.matches("button") ? user : user?.querySelector("button");
    return {
      navigation: box(navigation), controls: box(controls),
      memory: box(navigation?.querySelector('a[href="/memory"]')),
      settings: box(navigation?.querySelector('a[href="/settings"]')),
      about: box(navigation?.querySelector('a[href="/about"]')),
      theme: box(byId("sidebar-theme")), language: box(byId("sidebar-language")), user: box(userButton),
      accountButtons: userButton ? 1 : 0,
      controlButtons: controls?.querySelectorAll("button").length ?? 0,
      overflowX: footer.scrollWidth - footer.clientWidth,
    };
  });
  assert(layout.navigation && layout.controls, "Footer must expose both rows sharing the same three columns");
  for (const [upper, lower] of [["memory", "theme"], ["settings", "language"]]) {
    assert(layout[upper] && layout[lower], `Missing footer ${upper}/${lower} control`);
    assert(Math.abs(layout[upper].centerX - layout[lower].centerX) <= 1, `${lower} center does not align with ${upper}: ${JSON.stringify(layout)}`);
  }
  assert.equal(layout.accountButtons, authEnabled ? 1 : 0, "Footer account avatar does not follow auth availability");
  assert.equal(layout.controlButtons, authEnabled ? 3 : 2, "Footer should contain only theme, language, and the optional account control");
  if (authEnabled) {
    assert(layout.about && layout.user, "Authenticated footer must have a third-column avatar");
    assert(Math.abs(layout.about.centerX - layout.user.centerX) <= 1, "Account avatar does not align with the third footer column");
    assert(layout.user.width <= layout.about.width + 1, "Account control stretches outside its footer column");
  }
  assert(layout.overflowX <= 1, "Footer controls create horizontal overflow");
  return layout;
}

async function dimensions(page, expectRows = true, authEnabled = true) {
  await expect(page.getByTestId("sidebar-all-conversations")).toBeVisible();
  const result = await page.getByTestId("sidebar").evaluate((sidebar, expectedTitles) => {
    const byId = (id) => sidebar.querySelector(`[data-testid="${id}"]`);
    const box = (element) => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right }; };
    const recent = byId("sidebar-recent"), list = byId("sidebar-recent-list"), navigation = byId("sidebar-navigation"), history = byId("sidebar-all-conversations"), footer = byId("sidebar-footer");
    const listBox = box(list);
    const completeRows = [...list.querySelectorAll("li")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top >= listBox.y - 1 && rect.bottom <= listBox.bottom + 1;
    }).length;
    const rows = [...list.querySelectorAll("li")].map((element, index) => {
      const link = element.querySelector("a"), title = link?.querySelector("span") ?? link;
      const rect = element.getBoundingClientRect(), titleRect = title?.getBoundingClientRect();
      const style = title ? getComputedStyle(title) : null;
      return { index, y: rect.y, height: rect.height, titleHeight: titleRect?.height ?? 0, lineHeight: Number.parseFloat(style?.lineHeight ?? ""), titleWhiteSpace: style?.whiteSpace, onlyTitleVisible: link?.innerText.trim() === expectedTitles[index]?.trim() };
    });
    return {
      sidebar: box(sidebar), recent: box(recent), list: listBox, navigation: box(navigation), history: box(history), footer: box(footer), completeRows,
      rows,
      listScrollHeight: list.scrollHeight, listClientHeight: list.clientHeight,
      navigationScrollHeight: navigation.scrollHeight, navigationClientHeight: navigation.clientHeight,
      historyOutsideList: !list.contains(history),
      documentOverflowX: document.documentElement.scrollWidth - innerWidth,
      sidebarOverflowX: sidebar.scrollWidth - sidebar.clientWidth,
      listOverflowX: list.scrollWidth - list.clientWidth,
      viewport: { width: innerWidth, height: innerHeight },
    };
  }, sessions.map((item) => item.title));
  console.log(`LAYOUT ${result.viewport.width}x${result.viewport.height}: navigation=${result.navigation.height.toFixed(1)}px recent=${result.recent.height.toFixed(1)}px list=${result.list.height.toFixed(1)}px completeRows=${result.completeRows} horizontalOverflow=${result.sidebarOverflowX}px`);
  assert(result.historyOutsideList, "View-all entry must be outside the scrolling recent list");
  assert(result.history.height >= 32, "View-all entry must remain a usable click target");
  assert(result.history.y >= 0 && result.history.bottom <= result.viewport.height + 1, "View-all entry is clipped outside the viewport");
  assert(result.footer.bottom <= result.viewport.height + 1, "Footer is clipped outside the viewport");
  assert(result.recent.bottom <= result.footer.y + 1, "Recent learning overlaps the footer");
  assert(result.list.bottom <= result.history.y + 1, "Recent rows overlap the view-all action");
  assert(result.navigation.bottom <= result.recent.y + 1, "Main navigation overlaps recent learning");
  for (const property of ["documentOverflowX", "sidebarOverflowX", "listOverflowX"]) assert(result[property] <= 1, `Horizontal overflow: ${property}=${result[property]}`);
  if (expectRows && result.viewport.height >= 600) assert(result.completeRows >= 3, `Recent learning shows only ${result.completeRows} complete rows`);
  for (const row of result.rows) {
    assert(row.height >= 35.5 && row.height <= 36.5, `Recent row ${row.index + 1} must be 36px, got ${row.height}`);
    assert(row.lineHeight > 0 && row.titleHeight <= row.lineHeight + 0.5 && row.titleWhiteSpace === "nowrap", `Recent row ${row.index + 1} title wraps or uses a second line`);
    assert(row.onlyTitleVisible, `Recent row ${row.index + 1} still shows timestamp/secondary text`);
    if (row.index > 0) assert(Math.abs(row.y - result.rows[row.index - 1].y - 40) <= 0.5, `Recent row ${row.index + 1} does not preserve a 4px gap / 40px title baseline`);
  }
  result.footerAlignment = await footerAlignment(page, authEnabled);
  return result;
}

async function fullListScroll(page) {
  const navigation = page.getByTestId("sidebar-navigation"), list = page.getByTestId("sidebar-recent-list");
  await list.focus();
  await expect(list).toBeFocused();
  const navBefore = await navigation.evaluate((element) => element.scrollTop);
  const historyBefore = await page.getByTestId("sidebar-all-conversations").boundingBox();
  await list.hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const lastLink = list.locator(`a[href="/home/${sessions[7].session_id}"]`);
  // Fractional CSS row heights can round the browser's integer scroll range
  // by half a pixel; require the entire target within the same 1px tolerance
  // as the layout bounds, instead of an exact IntersectionObserver ratio.
  await expect(lastLink).toBeInViewport({ ratio: 0.98 });
  const listBounds = await list.boundingBox(), lastBounds = await lastLink.boundingBox();
  assert(lastBounds.y >= listBounds.y - 1 && lastBounds.y + lastBounds.height <= listBounds.y + listBounds.height + 1, "The eighth recent row is clipped after scrolling to the end");
  assert.equal(await navigation.evaluate((element) => element.scrollTop), navBefore, "Recent-list scrolling moves the navigation");
  const historyAfter = await page.getByTestId("sidebar-all-conversations").boundingBox();
  assert(Math.abs(historyBefore.y - historyAfter.y) <= 1, "View-all entry moves with recent-list scrolling");
  const lastRow = list.locator("li").last();
  await lastRow.hover();
  const options = lastRow.getByRole("button", { name: /^(Session options|会话选项)$/ });
  const beforeMenuUrl = page.url();
  await options.focus();
  await options.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^(Rename|重命名)$/ })).toBeFocused();
  await expect(menu).toHaveCSS("opacity", "1");
  await expect(menu).toBeInViewport({ ratio: 1 });
  const menuGeometry = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const onTop = (x, y) => element.contains(document.elementFromPoint(x, y));
    return { bodyPortal: element.parentElement === document.body, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, viewportHeight: innerHeight, viewportWidth: innerWidth, fullyHitTestable: onTop(rect.left + rect.width / 2, rect.top + 8) && onTop(rect.left + rect.width / 2, rect.bottom - 8) };
  });
  assert(menuGeometry.bodyPortal, "Session menu remains inside its clipping scroll container");
  assert(menuGeometry.fullyHitTestable, "Session menu is obscured by another panel");
  assert.equal(page.url(), beforeMenuUrl, "Opening session options must not select the session");
  await page.screenshot({ path: path.join(OUTPUT, `${page.viewportSize().width}x${page.viewportSize().height}-last-row-menu.png`) });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(options).toBeFocused();
  await options.press("Enter");
  await expect(menu.getByRole("menuitem", { name: /^(Rename|重命名)$/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu.getByRole("menuitem", { name: /^(Delete|删除)$/ })).toBeFocused();
  await page.keyboard.press("Tab");
  const tabExitFocus = await page.evaluate(() => ({ activeTag: document.activeElement?.tagName, hasDocumentFocus: document.hasFocus(), focusedWithinMenu: Boolean(document.activeElement?.closest('[role="menu"]')) }));
  console.log(JSON.stringify({ check: "menu-tab-exit", viewport: page.viewportSize(), ...tabExitFocus }));
  await expect(menu).toHaveCount(0);
  assert.equal(page.url(), beforeMenuUrl, "Keyboard menu traversal must not select a conversation");
  await options.focus();
  await options.press("Enter");
  await expect(menu.getByRole("menuitem", { name: /^(Rename|重命名)$/ })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(menu).toHaveCount(0);
  await options.click();
  await page.getByRole("menuitem", { name: /^(Rename|重命名)$/ }).click();
  const rename = page.getByRole("dialog");
  await expect(rename).toBeVisible();
  await rename.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
  await expect(rename).toHaveCount(0);
  assert.equal(page.url(), beforeMenuUrl, "Rename/cancel must not navigate to the conversation");
  if (page.viewportSize().width < 768) await expect.poll(() => page.getByTestId("sidebar").evaluate((element) => Math.round(element.getBoundingClientRect().x))).toBe(0);
  await lastRow.hover();
  await options.click();
  await expect(menu).toBeVisible();
  await list.hover();
  await page.mouse.wheel(0, -150);
  await expect(menu).toHaveCount(0);
  await list.press("Home");
  // Native Home behavior differs when focus originated from mouse input.
  await list.evaluate((element) => { element.scrollTop = 0; });
  return { reachedEighthRow: true, independentScroll: true, keyboardFocusable: true, menuGeometry, keyboardMenuOpensWithFocus: true, menuEscapeRestoresFocus: true, tabLeavesAndClosesMenu: true, shiftTabLeavesAndClosesMenu: true, tabExitFocus, menuClosesOnScroll: true, renameCancelDoesNotNavigateOrWrite: true };
}

(async () => {
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  const results = [];
  let active;
  try {
    for (const viewport of [{ width: 787, height: 776 }, { width: 1280, height: 600 }, { width: 1440, height: 1000 }, { width: 390, height: 700 }]) {
      const name = `${viewport.width}x${viewport.height}`;
      active = await environment(browser, { viewport, language: viewport.width === 787 ? "zh" : "en", theme: viewport.width === 787 ? "dark" : "light" });
      const { page } = active;
      await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
      await openSidebar(page);
      const list = page.getByTestId("sidebar-recent-list");
      await expect(list.locator("li")).toHaveCount(8);
      if (viewport.width < 768) await expect(list.getByRole("button", { name: "Session options", exact: true }).first()).toHaveCSS("opacity", "1");
      const initial = await dimensions(page);
      await page.screenshot({ path: path.join(OUTPUT, `${name}-recent.png`) });
      const summary = page.getByTestId("sidebar-navigation").locator("summary");
      await summary.click();
      await expect(summary.locator("..")).toHaveAttribute("open", "");
      const expertOpen = await dimensions(page);
      const scrolling = await fullListScroll(page);
      await page.screenshot({ path: path.join(OUTPUT, `${name}-expert-open.png`) });
      await list.locator(`a[href="/home/${sessions[0].session_id}"]`).click();
      await expect(page).toHaveURL(`${BASE}/home/${sessions[0].session_id}`);
      await expect(page.getByRole("main").getByText(`Fixture response ${sessions[0].session_id}`, { exact: true })).toBeVisible();
      if (viewport.width < 768) {
        await expect.poll(() => page.getByTestId("sidebar").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
        await openSidebar(page);
        // Clicking the already-active recent item must close the drawer too,
        // without relying on a pathname-change effect.
        await page.getByTestId("sidebar-recent-list").locator(`a[href="/home/${sessions[0].session_id}"]`).click();
        await expect.poll(() => page.getByTestId("sidebar").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
        await openSidebar(page);
      }
      await page.getByTestId("sidebar-all-conversations").click();
      await expect(page).toHaveURL(`${BASE}/space/chat-history`);
      await expect(page.getByRole("main").getByRole("heading", { name: /^(Chat History|对话历史|聊天历史)$/ })).toBeVisible();
      if (viewport.width < 768) {
        await expect.poll(() => page.getByTestId("sidebar").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
        await openSidebar(page);
        await page.getByTestId("sidebar-all-conversations").click();
        await expect.poll(() => page.getByTestId("sidebar").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
      }
      assert(active.apiRequests.some((request) => request.includes("/sessions?limit=8")), "Sidebar did not request its eight recent sessions");
      assert(active.apiRequests.some((request) => request.includes("/sessions?limit=200")), "History navigation did not request full history");
      active.assertIsolation();
      results.push({ scenario: name, initial, expertOpen, scrolling, recentNavigation: true, fullHistoryNavigation: true, mobileDrawerClose: viewport.width < 768, touchOptionsVisibleWithoutHover: viewport.width < 768, ...active.evidence() });
      await active.close(); active = null;
    }
    for (const mode of ["loading", "empty", "error"]) {
      active = await environment(browser, { viewport: { width: 1280, height: 600 }, mode });
      const { page } = active;
      await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
      await openSidebar(page);
      if (mode === "loading") await expect(page.getByTestId("sidebar-recent-list").locator(".animate-pulse")).toHaveCount(3);
      else await expect(page.getByTestId("sidebar-recent-list").getByText(mode === "error" ? /could not be loaded|Unable to load|failed to load/i : "No recent activity found")).toBeVisible();
      const layout = await dimensions(page, false);
      await page.screenshot({ path: path.join(OUTPUT, `${mode}-recent.png`) });
      if (mode === "error") {
        active.setMode("normal");
        await page.getByTestId("sidebar-recent-list").getByRole("button", { name: "Retry", exact: true }).click();
        await expect(page.getByTestId("sidebar-recent-list").locator("li")).toHaveCount(8);
        await dimensions(page);
        await page.screenshot({ path: path.join(OUTPUT, "error-retry-recovered.png") });
      }
      await page.getByTestId("sidebar-all-conversations").click();
      await expect(page).toHaveURL(`${BASE}/space/chat-history`);
      await expect(page.getByRole("main").getByRole("heading", { name: "Chat History", exact: true })).toBeVisible();
      await expect(page.getByRole("main").getByText(sessions[0].title, { exact: true })).toBeVisible();
      active.assertIsolation();
      results.push({ scenario: mode, layout, fullHistoryNavigation: true, retryRecovery: mode === "error", ...active.evidence() });
      await active.close(); active = null;
    }
    for (const authEnabled of [true, false]) {
      for (const language of ["en", "zh"]) {
        for (const theme of ["light", "dark"]) {
          const name = `footer-${authEnabled ? "auth" : "no-auth"}-${language}-${theme}`;
          active = await environment(browser, { viewport: { width: 787, height: 776 }, authEnabled, language, theme });
          const { page } = active;
          await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
          await openSidebar(page, authEnabled);
          await expect(page.getByTestId("sidebar-recent-list").locator("li")).toHaveCount(8);
          await expect(page.getByTestId("sidebar-language")).toHaveText(language === "en" ? "中文" : "EN");
          await expect.poll(() => page.locator("html").evaluate((element) => element.classList.contains("dark"))).toBe(theme === "dark");
          const layout = await dimensions(page, true, authEnabled);
          await page.getByTestId("sidebar-footer").screenshot({ path: path.join(OUTPUT, `${name}.png`) });
          active.assertIsolation();
          results.push({ scenario: name, authEnabled, language, theme, layout, ...active.evidence() });
          await active.close(); active = null;
        }
      }
    }
    const report = { status: "PASS", testedOrigin: BASE, boundary: "Browser UI → intercepted browser session API fixtures → navigation and layout; all browser business API/WS requests are intercepted, with no browser writes or model calls", serverRenderingNote: "Server-side dashboard rendering is outside browser request interception and may read the configured backend unless the test frontend uses an unreachable SSR API base.", scenarios: results, screenshotDirectory: OUTPUT };
    fs.writeFileSync(path.join(OUTPUT, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    if (active) {
      await active.page.screenshot({ path: path.join(OUTPUT, "failure-diagnostic.png") });
      fs.writeFileSync(path.join(OUTPUT, "failure-report.json"), JSON.stringify({ status: "FAIL", message: error.message, url: active.page.url(), completed: results, ...active.evidence() }, null, 2));
    }
    throw error;
  } finally {
    if (active) await active.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
