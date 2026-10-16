/* Browser contract: owner configures the proactive tutor social policy, then
 * inspects and cancels a pending reminder with its audit trail preserved. */
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
  channels: { telegram: { enabled: true, token: "***" } },
  language: "zh",
  proactive_learning: false,
  proactive_review_delay_hours: 24,
  proactive_low_score_threshold: 0.6,
  proactive_goal: "",
  proactive_timezone: "Asia/Shanghai",
  proactive_allowed_start: "09:00",
  proactive_allowed_end: "21:00",
  proactive_allowed_weekdays: [0, 1, 2, 3, 4, 5, 6],
  proactive_frequency: "as_needed",
  proactive_preferred_channel: "telegram",
  proactive_paused_until: "",
  proactive_min_interval_hours: 24,
  proactive_max_per_day: 1,
  proactive_merge_window_hours: 6,
  running: false,
  started_at: null,
};

(async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await (await browser.newContext()).newPage();
    const pageErrors = [];
    const patches = [];
    let cancelled = false;
    let deliveryFailures = [
      { id: "dead-1", created_at: "2026-08-20T08:10:00+08:00", status: "pending", channel: "telegram", chat_id: "42", content: "Review limits", media: [], attempts: 3, error_type: "TimeoutError", error_message: "delivery timed out" },
      { id: "dead-2", created_at: "2026-08-20T08:11:00+08:00", status: "pending", channel: "telegram", chat_id: "43", content: "Practice derivatives", media: [], attempts: 3, error_type: "NetworkError", error_message: "network unavailable" },
    ];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route("**/api/v1/partners/tutor**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith("/channels/status")) {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ partner_id: "tutor", running: false, channels: { telegram: { enabled: true, status: "stopped", running: false, capabilities: { text: true, inbound_attachments: true, outbound_attachments: true, streaming: false } } } }),
        });
      }
      if (url.pathname.endsWith("/dead-letters") && request.method() === "GET") {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ partner_id: "tutor", records: deliveryFailures }) });
      }
      const deadLetterAction = url.pathname.match(/\/dead-letters\/([^/]+)\/(retry|discard)$/);
      if (deadLetterAction && request.method() === "POST") {
        const [, id, action] = deadLetterAction;
        const record = deliveryFailures.find((item) => item.id === id);
        deliveryFailures = deliveryFailures.filter((item) => item.id !== id);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...record, status: action === "retry" ? "replayed" : "discarded" }) });
      }
      if (url.pathname.endsWith("/proactive-reminders/job-1") && request.method() === "DELETE") {
        cancelled = true;
        return route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
      }
      if (url.pathname.endsWith("/proactive-reminders")) {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            pending: cancelled
              ? []
              : [{
                  id: "job-1",
                  name: "learning-review:tutor:e1",
                  message: "Review limits without revealing the answer first.",
                  scheduled_for: "2026-08-24T09:00:00+08:00",
                  channel: "telegram",
                  weak_questions: ["Limits"],
                  merged_events: 2,
                }],
            audit: [
              {
                at: "2026-08-20T08:00:00+08:00",
                event: "low_quiz_score",
                decision: "scheduled",
                job_id: "job-1",
                channel: "telegram",
              },
              ...(cancelled
                ? [{ at: "2026-08-20T08:05:00+08:00", event: "delivery", decision: "cancelled", job_id: "job-1" }]
                : []),
            ],
          }),
        });
      }
      if (request.method() === "PATCH") {
        const payload = request.postDataJSON();
        patches.push(payload);
        Object.assign(partner, payload);
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(partner) });
    });
    await page.route("**/api/v1/partners/tool-options", (route) =>
      route.fulfill({ contentType: "application/json", body: '{"tools":[],"builtin_tools":[],"mcp_tools":[]}' }),
    );
    await page.route("**/api/v1/partners/channels/schema", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ channels: { telegram: { label: "Telegram", fields: [], default_config: { enabled: true } } } }),
      }),
    );
    await page.route("**/api/v1/settings/llm-options**", (route) =>
      route.fulfill({ contentType: "application/json", body: '{"options":[]}' }),
    );

    await page.goto(`${BASE}/partners/tutor`, { waitUntil: "domcontentloaded" });
    const expectedTabs = ["Overview", "Chat", "Soul", "Resources", "Channels", "Sessions", "Proactive", "Activity"];
    await page.getByRole("tab", { name: "Overview", exact: true }).waitFor();
    for (const name of expectedTabs) {
      assert((await page.getByRole("tab", { name, exact: true }).count()) === 1, `missing ${name} tab`);
    }
    await page.getByRole("tab", { name: "Proactive" }).click();
    const section = page.locator("section").filter({ hasText: "Proactive learning" });
    await section.getByRole("checkbox").check();
    await section.getByPlaceholder("What long-term outcome should this tutor help achieve?").fill("Master calculus foundations");
    await section.locator("select").first().selectOption("daily");
    await section.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => document.body.textContent.includes("Proactive learning saved"));
    assert(patches.length === 1, "proactive settings were not persisted");
    assert(patches[0].proactive_goal === "Master calculus foundations", "learning goal missing from PATCH");
    assert(patches[0].proactive_timezone === "Asia/Shanghai", "timezone missing from PATCH");
    assert(patches[0].proactive_frequency === "daily", "frequency missing from PATCH");
    assert(Array.isArray(patches[0].proactive_allowed_weekdays), "allowed weekdays missing from PATCH");

    await page.getByText("Pending reminders").waitFor();
    assert((await page.getByText("Review limits without revealing the answer first.").count()) === 1, "pending reminder missing");
    assert((await page.getByText("telegram", { exact: true }).count()) >= 1, "delivery channel missing");
    await page.getByRole("button", { name: "Cancel reminder" }).click();
    await page.getByText("No pending reminders").waitFor();
    assert(cancelled, "cancel endpoint was not called");
    assert((await page.getByText("Cancelled", { exact: true }).count()) >= 1, "cancel audit entry missing");

    await page.getByRole("tab", { name: "Activity" }).click();
    await page.getByText("Channel health").waitFor();
    await page.getByText("Attachments supported", { exact: true }).waitFor();
    assert((await page.getByText("Attachments supported", { exact: true }).count()) === 1, "channel capability contract missing");
    const retryRow = page.locator("li").filter({ hasText: "Review limits" });
    await retryRow.getByRole("button", { name: "Retry" }).click();
    await page.getByText("Delivery retried successfully").waitFor();
    const discardRow = page.locator("li").filter({ hasText: "Practice derivatives" });
    await discardRow.getByRole("button", { name: "Discard" }).click();
    await page.getByText("No pending delivery failures").waitFor();
    assert(deliveryFailures.length === 0, "delivery failure actions did not consume records");
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);

    console.log("PASS partner proactive: policy + health + dead-letter recovery");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("FAIL partner proactive:", error);
  process.exit(1);
});
