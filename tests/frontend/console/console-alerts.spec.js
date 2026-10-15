// CON-19 browser checks (07 §6.9, §13.2 console-alerts; 04 §13.4): Ack and
// Silence post the row's scopeKey; a builtin rule offers Disable and never
// Delete; the rule writer's validation errors show under their fields;
// `alerts` events refresh the list and `notification` events reach the bell;
// the channel test reports what the server answered; axe is clean. The real
// service-entry serves the console and the API is mocked in the browser
// (helpers/console-harness.js).
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const {
  collectFailures,
  expectNoA11yViolations,
  expectNoOverflow,
  mockConsoleApi,
  setPrefs,
  startEntry,
} = require("../helpers/console-harness.js");

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures");
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = { role: "owner", auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" } };
const FULL = { features: { platform: true, telemetry: true, alerts: true } };

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

const json = (file) => JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));
const consoleFixture = (name) => json(`console/${name}.json`);
const reply = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

function merge(base, patch) {
  const next = { ...base, ...patch };
  for (const name of ["features", "auth", "access", "gateway"]) if (patch[name]) next[name] = { ...base[name], ...patch[name] };
  return next;
}

async function withBootstrap(context, patch) {
  const guarded = (handler) => async (route) => {
    try {
      await handler(route);
    } catch (error) {
      if (!/disposed|closed|aborted/i.test(String(error?.message))) throw error;
    }
  };
  await context.route((url) => url.pathname === "/api/console/bootstrap", guarded(async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: JSON.stringify(merge(await response.json(), patch)) });
  }));
  await context.route((url) => !/^\/(api|c|gateway)\//.test(url.pathname), guarded(async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.text()).replace(BOOTSTRAP_BLOCK, (match, open, text, close) => (
      `${open}${JSON.stringify(merge(JSON.parse(text), patch)).replace(/</g, "\\u003c")}${close}`));
    await route.fulfill({ response, body });
  }));
}

// ---------------------------------------------------------------------------
// Mocks (04 §13.4 shapes)

const row = (ruleId, scopeKey, extra = {}) => ({
  ruleId, scopeKey, state: "firing", severity: "warning", title: { zh: `GPU ${scopeKey.split(":")[1]} 温度过高`, en: `GPU ${scopeKey.split(":")[1]} temperature high` },
  value: 91, threshold: 85, since: "2026-10-14T11:50:00.000Z", firedAt: "2026-10-14T11:50:00.000Z", resolvedAt: null, ackedAt: null, silencedUntil: null, ...extra,
});
const FIRING = [row("gpu_temp_high", "gpu:0"), row("gpu_temp_high", "gpu:1", { severity: "critical", value: 95 })];
const RESOLVED = row("upstream_errors", "fleet:vllm:primary", { state: "ok", title: { zh: "上游错误率偏高", en: "Upstream error rate is high" }, value: 0.01, threshold: 0.05, resolvedAt: "2026-10-14T11:30:00.000Z" });
const METRICS = [
  { id: "instance.down", unit: "bool", scopes: ["fleet:<fleetId>"], label: { zh: "实例无响应", en: "Instance down" }, filters: ["fleetId"] },
  { id: "gpu.temp_c", unit: "celsius", scopes: ["gpu:<i>"], label: { zh: "GPU 温度", en: "GPU temperature" }, filters: ["gpu"] },
];
const BUILTIN = {
  ruleId: "gpu_temp_high", builtin: true, enabled: true, metric: "gpu.temp_c", scope: {}, op: ">", threshold: 85, clearThreshold: null, windowS: 60, forS: 120, minSamples: 0,
  severity: "warning", channels: ["inapp", "toast"], cooldownS: 1800, titleZh: "GPU {id} 温度过高", titleEn: "GPU {id} temperature high", updatedAt: null, updatedBy: "system",
};
const CUSTOM = {
  ruleId: "custom_down", builtin: false, enabled: true, metric: "instance.down", scope: { fleetId: "vllm:primary" }, op: ">=", threshold: 1, clearThreshold: null, windowS: 30, forS: 30, minSamples: 0,
  severity: "critical", channels: ["inapp"], cooldownS: 1800, titleZh: "主实例无响应", titleEn: "Primary instance down", updatedAt: "2026-10-14T10:00:00.000Z", updatedBy: "owner",
};
const SETTINGS = {
  ok: true, etag: "etag-1", enabled: true, sampleIntervalMs: 10000, timezoneOffsetMinutes: 0, keepJsonlAccessLog: true, maxDbMb: 2048, exportMaxRows: 200000,
  retention: { requestsDays: 30, ipDays: 30, samplesHours: 48, minuteDays: 14, hourDays: 400, eventsDays: 400 },
  energy: { pricePerKwh: null, currency: "CNY", tariffs: [], hostBaselineWatts: 0 },
  alerts: { webhooks: [{ id: "ops", format: "slack", url: "https://hooks.example.test/…xyz", minSeverity: "warning", secret: { set: true } }] },
};
const EVENTS = { ok: true, rows: [{ id: 9, at: "2026-10-14T11:50:00.000Z", type: "alert.fired", severity: "warning", source: "entry", title: "Alert: GPU 0 temperature high", data: {} }], nextCursor: null };

function alertsApi({ firing = FIRING, extra = {} } = {}) {
  const state = { firing };
  const api = {
    "GET /api/telemetry/alerts": (request) => {
      const query = Object.fromEntries(new URL(request.url()).searchParams);
      return reply({ ok: true, rows: query.state === "all" ? [...state.firing, RESOLVED] : state.firing, toastChannel: "no_subscriber" });
    },
    "GET /api/telemetry/alert-rules": reply({ ok: true, rules: [BUILTIN, CUSTOM], metrics: METRICS, toastChannel: "no_subscriber" }),
    "GET /api/telemetry/live": json("telemetry/live.json"),
    "GET /api/telemetry/events": EVENTS,
    "GET /api/telemetry/settings": SETTINGS,
    "POST /api/telemetry/alerts/gpu_temp_high/ack": { ok: true },
    "POST /api/telemetry/alerts/gpu_temp_high/silence": { ok: true },
    ...extra,
  };
  return { api, state };
}

async function newPage(browser, { api, size = SIZES.desktop, theme = "light", locale = "en-US" } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, { ...OWNER, ...FULL });
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, {
    "GET /api/status": consoleFixture("status"),
    "GET /api/platform/status": consoleFixture("platform-status"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/fleet": consoleFixture("fleet"),
    ...(api || alertsApi().api),
  });
  return { context, page, mock, failures };
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const open = async (page, route) => {
  await page.goto(`${entry.url}${route}`);
  await expect(page.locator("#main h1")).toBeVisible();
};
const rowOf = (page, rule, scope) => page.locator(`[data-testid="alerts.firing.row"][data-rule="${rule}"][data-scope="${scope}"]`);
const callsTo = (mock, method, pathname) => mock.calls.filter((call) => call.method === method && call.path === pathname);

// ---------------------------------------------------------------------------
// Firing

test("firing: rows list critical first, and Ack and Silence post the row's scopeKey", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await open(page, "alerts");
    await expect(page.locator("#main h1")).toHaveText("Alerts");
    const rows = byId(page, "alerts.firing.row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute("data-scope", "gpu:1");
    await expect(rows.first()).toContainText("GPU 1 temperature high");
    await expect(rows.first()).toContainText("Critical");
    expect(mock.find("GET", "/api/telemetry/alerts")[0].query).toMatchObject({ state: "firing" });

    // Ack the second scope of the same rule: the body names gpu:1, not gpu:0.
    await rowOf(page, "gpu_temp_high", "gpu:1").locator("[data-testid='alerts.ack']").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/telemetry/alerts/gpu_temp_high/ack").length).toBe(1);
    expect(callsTo(mock, "POST", "/api/telemetry/alerts/gpu_temp_high/ack")[0].body).toEqual({ scopeKey: "gpu:1" });

    // Silence: 8 h preset, then the custom time must be in the future.
    await rowOf(page, "gpu_temp_high", "gpu:0").locator("[data-testid='alerts.silence']").click();
    const dialog = byId(page, "alerts.silence.dialog");
    await expect(dialog).toBeVisible();
    await byId(page, "alerts.silence.custom").check();
    await byId(page, "alerts.silence.until").fill("2020-01-01T00:00");
    await expect(dialog).toContainText("The end time must be in the future.");
    await expect(byId(page, "alerts.silence.confirm")).toBeDisabled();
    await byId(page, "alerts.silence.8h").check();
    const before = Date.now();
    await byId(page, "alerts.silence.confirm").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/telemetry/alerts/gpu_temp_high/silence").length).toBe(1);
    const sent = callsTo(mock, "POST", "/api/telemetry/alerts/gpu_temp_high/silence")[0].body;
    expect(sent.scopeKey).toBe("gpu:0");
    expect(Math.abs(Date.parse(sent.until) - (before + 8 * 3600 * 1000))).toBeLessThan(60_000);
    await expect(dialog).toHaveCount(0);
    expect(mock.csrfViolations).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("firing: an empty list names the next action", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: alertsApi({ firing: [] }).api });
  try {
    await open(page, "alerts");
    await expect(byId(page, "alerts.firing.empty")).toContainText("No alerts are firing");
    await expect(byId(page, "empty-state.action")).toHaveAttribute("href", "/alerts?tab=rules");
  } finally {
    await context.close();
  }
});

test("history lists every state and the alert events", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await open(page, "alerts?tab=history");
    await expect(byId(page, "alerts.history.row")).toHaveCount(3);
    await expect(byId(page, "alerts.history.table")).toContainText("Upstream error rate is high");
    await expect(byId(page, "alerts.event")).toContainText("Alert: GPU 0 temperature high");
    expect(mock.find("GET", "/api/telemetry/alerts").some((call) => call.query.state === "all" && call.query.limit === "200")).toBe(true);
    expect(mock.find("GET", "/api/telemetry/events")[0].query).toMatchObject({ type: "alert." });
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Rules

test("rules: a builtin rule offers Disable, never Delete; a custom rule offers Delete behind a confirmation", async ({ browser }) => {
  const extra = {
    "PUT /api/telemetry/alert-rules/gpu_temp_high": (request) => reply({ ok: true, rule: { ...BUILTIN, ...JSON.parse(request.postData() || "{}") } }),
    "DELETE /api/telemetry/alert-rules/custom_down": { ok: true, ruleId: "custom_down" },
  };
  const { context, page, mock, failures } = await newPage(browser, { api: alertsApi({ extra }).api });
  try {
    await open(page, "alerts?tab=rules");
    const builtin = page.locator("[data-testid='alerts.rule.row'][data-rule='gpu_temp_high']");
    const custom = page.locator("[data-testid='alerts.rule.row'][data-rule='custom_down']");
    await expect(builtin).toContainText("Built-in");
    await expect(builtin.locator("[data-testid='alerts.rule.delete']")).toHaveCount(0);
    await expect(builtin.locator("[data-testid='alerts.rule.disable']")).toBeVisible();
    await expect(custom.locator("[data-testid='alerts.rule.delete']")).toBeVisible();
    await expect(builtin).toContainText("GPU temperature > 85");

    await builtin.locator("[data-testid='alerts.rule.disable']").click();
    await expect.poll(() => callsTo(mock, "PUT", "/api/telemetry/alert-rules/gpu_temp_high").length).toBe(1);
    expect(callsTo(mock, "PUT", "/api/telemetry/alert-rules/gpu_temp_high")[0].body).toEqual({ enabled: false });

    await custom.locator("[data-testid='alerts.rule.delete']").click();
    const dialog = byId(page, "alerts.rule.delete-dialog");
    await expect(dialog).toBeVisible();
    expect(callsTo(mock, "DELETE", "/api/telemetry/alert-rules/custom_down")).toHaveLength(0);
    await byId(page, "dialog.confirm").click();
    await expect.poll(() => callsTo(mock, "DELETE", "/api/telemetry/alert-rules/custom_down").length).toBe(1);
    expect(mock.csrfViolations).toEqual([]);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("rules: editing a builtin rule locks what the server would refuse and sends only the changed fields", async ({ browser }) => {
  const extra = { "PUT /api/telemetry/alert-rules/gpu_temp_high": (request) => reply({ ok: true, rule: { ...BUILTIN, ...JSON.parse(request.postData() || "{}") } }) };
  const { context, page, mock } = await newPage(browser, { api: alertsApi({ extra }).api });
  try {
    await open(page, "alerts?tab=rules");
    await page.locator("[data-testid='alerts.rule.row'][data-rule='gpu_temp_high'] [data-testid='alerts.rule.edit']").click();
    await expect(byId(page, "alerts.rule.drawer")).toBeVisible();
    await expect(byId(page, "alerts.rule.builtin-note")).toBeVisible();
    await expect(byId(page, "alerts.rule.metric")).toBeDisabled();
    await expect(byId(page, "alerts.rule.titleEn")).toBeDisabled();
    await expect(byId(page, "alerts.rule.threshold")).toBeEnabled();
    await expect(byId(page, "alerts.rule.save")).toBeDisabled();
    await byId(page, "alerts.rule.threshold").fill("88");
    await byId(page, "alerts.rule.save").click();
    await expect.poll(() => callsTo(mock, "PUT", "/api/telemetry/alert-rules/gpu_temp_high").length).toBe(1);
    expect(callsTo(mock, "PUT", "/api/telemetry/alert-rules/gpu_temp_high")[0].body).toEqual({ threshold: 88 });
    await expect(byId(page, "alerts.rule.drawer")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("rules: the writer's validation errors show under their fields and the drawer stays open", async ({ browser }) => {
  const extra = {
    "POST /api/telemetry/alert-rules": reply({
      ok: false,
      error: { code: "invalid_request", message: "The rule was not saved because some values are not valid." },
      errors: [
        { field: "threshold", code: "out_of_range", message: "threshold must be between -1e12 and 1e12." },
        { field: "scope.fleetId", code: "invalid_format", message: "fleetId is not a valid identifier." },
        { field: "titleEn", code: "invalid_value", message: "titleEn must be 1 to 120 characters." },
      ],
    }, 400),
  };
  const { context, page, mock } = await newPage(browser, { api: alertsApi({ extra }).api });
  try {
    await open(page, "alerts?tab=rules");
    await byId(page, "alerts.rule.new").click();
    await expect(byId(page, "alerts.rule.drawer")).toBeVisible();
    await expect(byId(page, "alerts.rule.drawer").locator("[data-testid='alerts.rule.delete']")).toHaveCount(0);
    await byId(page, "alerts.rule.scope.fleetId").fill("bad id!");
    await byId(page, "alerts.rule.threshold").fill("1");
    await byId(page, "alerts.rule.titleZh").fill("测试");
    await byId(page, "alerts.rule.titleEn").fill("x");
    await byId(page, "alerts.rule.save").click();
    await expect.poll(() => callsTo(mock, "POST", "/api/telemetry/alert-rules").length).toBe(1);
    const body = callsTo(mock, "POST", "/api/telemetry/alert-rules")[0].body;
    expect(body).toMatchObject({ metric: "instance.down", op: ">", threshold: 1, titleEn: "x", scope: { fleetId: "bad id!" } });

    await expect(byId(page, "alerts.rule.drawer")).toBeVisible();
    await expect(byId(page, "alerts.rule.threshold.field")).toContainText("Out of the allowed range.");
    await expect(byId(page, "alerts.rule.threshold")).toHaveAttribute("aria-invalid", "true");
    await expect(byId(page, "alerts.rule.titleEn")).toHaveAttribute("aria-invalid", "true");
    await expect(byId(page, "alerts.rule.scope.error")).toContainText("fleetId");
    await expect(byId(page, "alerts.rule.problem")).toBeVisible();
    // Editing a field clears its own error.
    await byId(page, "alerts.rule.threshold").fill("2");
    await expect(byId(page, "alerts.rule.threshold")).not.toHaveAttribute("aria-invalid", "true");
    // A number that does not parse is caught before the request.
    await byId(page, "alerts.rule.windowS").fill("abc");
    await expect(byId(page, "alerts.rule.windowS.field")).toContainText("Not in the right format.");
    await expect(byId(page, "alerts.rule.save")).toBeDisabled();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Events

test("an alerts event refreshes the list and a notification event reaches the bell", async ({ browser }) => {
  const { api, state } = alertsApi();
  state.firing = [FIRING[0]];
  const stream = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    state.firing = FIRING;
    const at = new Date().toISOString();
    const alertEvent = { type: "alerts", at, source: "entry", data: { ruleId: "gpu_temp_high", scopeKey: "gpu:1", state: "firing" } };
    const note = { type: "notification", at, source: "entry", data: { kind: "alert.fired", severity: "warn", title: { zh: "GPU 1 温度过高", en: "GPU 1 temperature high" }, dedupeKey: "gpu_temp_high:gpu:1" } };
    return { status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: `retry: 3600000

id: 1
event: alerts
data: ${JSON.stringify(alertEvent)}

id: 2
event: notification
data: ${JSON.stringify(note)}

` };
  };
  const { context, page, mock } = await newPage(browser, { api: { ...api, "GET /api/events": stream } });
  try {
    await open(page, "alerts");
    await expect(byId(page, "alerts.firing.row")).toHaveCount(1);
    const firstCalls = mock.find("GET", "/api/telemetry/alerts").filter((call) => call.query.state === "firing").length;
    await expect(byId(page, "alerts.firing.row")).toHaveCount(2, { timeout: 10_000 });
    expect(mock.find("GET", "/api/telemetry/alerts").filter((call) => call.query.state === "firing").length).toBeGreaterThan(firstCalls);
    await expect(byId(page, "notification-center.bell")).toHaveAttribute("aria-label", "Notifications, 1 unread");
    await byId(page, "notification-center.bell").click();
    await expect(byId(page, "notification-center.title")).toHaveText("GPU 1 temperature high");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Channels

test("channels: the test button reports delivered, no listener and a webhook failure", async ({ browser }) => {
  const extra = {
    "POST /api/telemetry/alerts/test": (request) => {
      const body = JSON.parse(request.postData() || "{}");
      if (body.channel === "inapp") return reply({ ok: true, delivered: true });
      if (body.channel === "toast") return reply({ ok: true, delivered: false, error: "no_subscriber" });
      return reply({ ok: false, delivered: false, error: "timeout" });
    },
  };
  const { context, page, mock, failures } = await newPage(browser, { api: alertsApi({ extra }).api });
  try {
    await open(page, "alerts?tab=channels");
    // Masked URLs only, and the Windows toast channel says whether anything listens.
    await expect(byId(page, "alerts.hook")).toContainText("hooks.example.test/…xyz");
    await expect(byId(page, "alerts.hook")).toContainText("Slack");
    await expect(byId(page, "alerts.toast-channel")).toContainText("Windows toast unavailable");

    await byId(page, "alerts.test.inapp").click();
    await expect(page.locator("[data-channel='inapp'] [data-testid='alerts.test.result']")).toContainText("was delivered");
    await byId(page, "alerts.test.toast").click();
    await expect(page.locator("[data-channel='toast'] [data-testid='alerts.test.result']")).toContainText("nothing is listening");
    await byId(page, "alerts.test.webhook").click();
    const failed = page.locator("[data-hook='ops'] [data-testid='alerts.test.result']");
    await expect(failed).toContainText("Test failed: the connection timed out");
    await expect(failed).toHaveAttribute("role", "alert");

    const bodies = callsTo(mock, "POST", "/api/telemetry/alerts/test").map((call) => call.body);
    expect(bodies).toEqual([{ channel: "inapp" }, { channel: "toast" }, { channel: "webhook", webhookId: "ops" }]);
    expect(mock.csrfViolations).toEqual([]);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("channels: adding a webhook sends the whole list with If-Match, existing URLs still masked", async ({ browser }) => {
  const extra = { "PUT /api/telemetry/settings": { ok: true, etag: "etag-2" } };
  const { context, page, mock } = await newPage(browser, { api: alertsApi({ extra }).api });
  try {
    await open(page, "alerts?tab=channels");
    await byId(page, "alerts.hook.new").click();
    await byId(page, "alerts.hook.url").fill("https://chat.example.test/hook/abc");
    await byId(page, "alerts.hook.format").selectOption("feishu");
    await byId(page, "alerts.hook.save").click();
    await expect.poll(() => callsTo(mock, "PUT", "/api/telemetry/settings").length).toBe(1);
    const call = callsTo(mock, "PUT", "/api/telemetry/settings")[0];
    expect(call.headers["if-match"]).toBe("etag-1");
    expect(call.body.alerts.webhooks).toHaveLength(2);
    expect(call.body.alerts.webhooks[0]).toEqual({ id: "ops", url: "https://hooks.example.test/…xyz", format: "slack", minSeverity: "warning" });
    expect(call.body.alerts.webhooks[1]).toMatchObject({ url: "https://chat.example.test/hook/abc", format: "feishu", minSeverity: "warning" });
    expect(call.body.alerts.webhooks[1].id).toMatch(/^wh_[a-z0-9]+$/);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Accessibility and layout

for (const theme of ["light", "dark"]) {
  for (const [sizeName, size] of Object.entries(SIZES)) {
    test(`axe is clean and nothing overflows: every tab, ${theme}, ${sizeName}`, async ({ browser }) => {
      const { context, page } = await newPage(browser, { theme, size });
      try {
        for (const tab of ["firing", "history", "rules", "channels"]) {
          await open(page, `alerts?tab=${tab}`);
          await expect(byId(page, "alerts.loading")).toHaveCount(0);
          await expect(page.locator("[data-testid='tabs.tab'][aria-selected='true']")).toHaveCount(1);
          await expectNoA11yViolations(page, { label: `alerts ${tab} ${theme} ${sizeName}` });
          await expectNoOverflow(page);
        }
        await open(page, "alerts?tab=rules");
        await byId(page, "alerts.rule.new").click();
        await expect(byId(page, "alerts.rule.drawer")).toBeVisible();
        await expectNoA11yViolations(page, { label: `alerts rule drawer ${theme} ${sizeName}` });
      } finally {
        await context.close();
      }
    });
  }
}
