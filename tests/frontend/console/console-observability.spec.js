// CON-17 browser checks, part 1 (07 §6.7, §13.2 console-observability; 04 §19):
// every panel of Overview, Performance, Traffic, Errors, GPU & energy, Models &
// instances and Settings calls its listed endpoint with its listed parameters;
// the range, filters and auto-refresh round-trip through the URL; the chart
// table view and the annotations render; every 04 §19 edge state shows its
// copy (metric not reported, idle instance, collection gap, no price,
// read-only view); axe is clean. CON-18 adds the Requests explorer to this
// spec (brush to filter, request detail). The real service-entry serves the
// console and the API is mocked in the browser (helpers/console-harness.js).
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
const HAN = /\p{Script=Han}/u;
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = { role: "owner", auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" } };
const FULL = { features: { platform: true, telemetry: true, alerts: true } };
const NO_TELEMETRY = { features: { platform: true } };
const BASE = Date.parse("2026-10-14T11:00:00Z");

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

const json = (file) => JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));
const telemetry = (name) => json(`telemetry/${name}.json`);
const consoleFixture = (name) => json(`console/${name}.json`);

function merge(base, patch) {
  const next = { ...base, ...patch };
  for (const name of ["features", "auth", "access", "gateway"]) if (patch[name]) next[name] = { ...base[name], ...patch[name] };
  return next;
}

// Serves the console with the given bootstrap fields, embedded in the shell and on GET /api/console/bootstrap.
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
// Mocks

const UNIT = { "req.count": "requests", "req.errors": "requests", "req.error_rate": "ratio", "lat.ttft_p50": "ms", "lat.ttft_p95": "ms", "lat.ttft_p99": "ms", "tok.output_per_s": "tokens/s",
  "rt.output_tps": "tokens/s", "rt.running": "requests", "rt.waiting": "requests", "rt.kv_usage": "ratio", "rt.prefix_hit": "ratio", "rt.spec_accept": "ratio",
  "gpu.util": "%", "gpu.mem_used_mb": "MB", "gpu.temp_c": "°C", "gpu.power_w": "W", "gpu.sm_clock_mhz": "MHz", "gpu.throttle_seconds": "s" };
const GROUPS = {
  model: [{ model: "model-a" }, { model: "model-b" }],
  fleet: [{ fleet: "vllm:primary" }, { fleet: "llama:small" }],
  key: [{ key: "key_alpha" }, { other: true }],
  source: [{ source: "open-webui" }, { source: "curl" }],
  protocol: [{ protocol: "openai" }],
  status_class: [{ status_class: "2xx" }, { status_class: "5xx" }],
  error_class: [{ error_class: "upstream_timeout" }, { error_class: "auth_failed" }],
  gpu: [{ gpu: "0" }],
  reason: [{ reason: "power" }],
};

const params = (request) => Object.fromEntries(new URL(request.url()).searchParams);

// A timeseries answer for whatever metrics and groupBy were asked.
function timeseries(request, { annotations = [], gapAt = null, silent = [] } = {}) {
  const query = params(request);
  const metrics = String(query.metrics || "").split(",").filter(Boolean);
  if (metrics.includes("lat.ttft_hist")) {
    return {
      ok: true, from: query.from, to: query.to, step: 600, source: "rollup_1m", le: [100, 250, 500, 1000, 2500, 60000],
      series: [{ metric: "lat.ttft_hist", unit: "count", group: {}, points: [0, 1, 2, 3].map((i) => [BASE + i * 600000, [i, 5 + i, 12, 4, 1, 0]]) }],
      annotations: [], otherGroups: 0,
    };
  }
  const groups = query.groupBy ? GROUPS[query.groupBy] || [{}] : [{}];
  const series = [];
  for (const metric of metrics) {
    for (const [index, group] of groups.entries()) {
      const quiet = silent.includes(metric);
      series.push({
        metric,
        unit: UNIT[metric] || "",
        group,
        points: [0, 1, 2, 3, 4, 5].map((i) => [BASE + i * 600000, quiet || gapAt === i ? null : Math.round((10 + i * 3 + index * 4) * 100) / 100]),
      });
    }
  }
  return { ok: true, from: query.from, to: query.to, step: 600, source: "rollup_1m", tzOffsetMinutes: 0, series, annotations, otherGroups: 0 };
}

const ANNOTATIONS = [
  { at: BASE + 600000, type: "launch.ready", fleetId: "vllm:primary", title: "Launch ready: model-a", eventId: 1 },
  { at: BASE + 1200000, type: "config.changed", fleetId: "vllm:primary", title: "Config changed", eventId: 2 },
  { at: BASE + 1500000, type: "benchmark.finished", fleetId: "vllm:primary", title: "Benchmark finished", eventId: 3 },
  { at: BASE + 1800000, type: "container.restart", fleetId: "llama:small", title: "Container restarted", eventId: 4 },
  { at: BASE + 2400000, type: "alert.fired", fleetId: "vllm:primary", title: "Alert: GPU 0 temperature", eventId: 5 },
];

const LIVE = telemetry("live");
const LIVE_RICH = {
  ...LIVE,
  instances: [
    { ...LIVE.instances[0], latencySource: "gateway", vramReservationMb: 30000 },
    { fleetId: "llama:small", engineId: "llamacpp", model: "model-b", state: "ready", idle: true, running: 0, waiting: 0, kvUsage: null, outputTps: null, vramReservationMb: 12000, sampleAt: "2026-10-14T11:59:50.000Z", latencySource: "none" },
  ],
};

const ENERGY_DAY = { ok: true, rows: [{ key: "2026-10-13", energyWh: 1200, idleWh: 300, cost: 0.72, outputTokens: 400000, costPerMOutputTokens: 1.8 }, { key: "2026-10-14", energyWh: 800, idleWh: 200, cost: 0.48, outputTokens: 300000, costPerMOutputTokens: 1.6 }], currency: "CNY", tariffApplied: "current", priceConfigured: true };
const ENERGY_MODEL = { ok: true, rows: [{ key: "model-a", energyWh: 1500, idleWh: 400, cost: 0.9, outputTokens: 500000, costPerMOutputTokens: 1.8 }], currency: "CNY", tariffApplied: "current", priceConfigured: true };
const NO_PRICE = (body) => ({ ...body, priceConfigured: false, rows: body.rows.map((row) => ({ ...row, cost: null, costPerMOutputTokens: null })) });
const LIFECYCLE = { ok: true, instances: [
  { fleetId: "vllm:primary", model: "model-a", engineId: "sglang", intervals: [
    { from: new Date(Date.now() - 20 * 3600e3).toISOString(), to: new Date(Date.now() - 19 * 3600e3).toISOString(), state: "loading", launchId: "lch_1" },
    { from: new Date(Date.now() - 19 * 3600e3).toISOString(), to: new Date(Date.now() - 6 * 3600e3).toISOString(), state: "ready", launchId: "lch_1" },
    { from: new Date(Date.now() - 6 * 3600e3).toISOString(), to: new Date(Date.now() - 5 * 3600e3).toISOString(), state: "sleeping", launchId: "lch_1" },
    { from: new Date(Date.now() - 2 * 3600e3).toISOString(), to: null, state: "ready", launchId: "lch_2" },
  ] },
  { fleetId: "llama:small", model: "model-b", engineId: "llamacpp", intervals: [{ from: new Date(Date.now() - 3 * 3600e3).toISOString(), to: new Date(Date.now() - 2.5 * 3600e3).toISOString(), state: "crashed", launchId: "lch_3" }] },
] };
const LAUNCHES = { ok: true, rows: [
  { key: "model-a", started: 4, ready: 3, failed: 1, readyP50Seconds: 545, readyP95Seconds: 700, topFailures: [{ signature: "cuda_oom", count: 1 }] },
  { key: "model-b", started: 1, ready: 1, failed: 0, readyP50Seconds: 40, readyP95Seconds: 40, topFailures: [] },
] };
const TRUNCATION = { ok: true, dim: "model", rows: [{ key: "model-a", label: { zh: "model-a", en: "model-a" }, requests: 40, share: 0.8, lengthShare: 0.25 }, { key: "model-b", label: { zh: "model-b", en: "model-b" }, requests: 10, share: 0.2, lengthShare: 0 }], total: { requests: 50 } };
const BASELINE = { ok: true, rows: [{ managerId: "vllm", model: "model-a", firstSeen: "2026-01-02T00:00:00Z", lastSeen: "2026-09-30T00:00:00Z", promptTokens: 5000000, outputTokens: 900000, requests: 12000, source: "stats-ledger" }] };
const ERROR_CLASSES = { ok: true, dim: "error_class", rows: [
  { key: "none", requests: 300, share: 0.8 },
  { key: "upstream_timeout", label: { zh: "上游超时", en: "Upstream timed out" }, requests: 50, share: 0.13, firstSeen: "2026-10-14T11:02:00Z", lastSeen: "2026-10-14T11:59:00Z", sampleRequestIds: ["req_aaaaaaaaaaaaaaaaaaaa", "req_bbbbbbbbbbbbbbbbbbbb"] },
  { key: "auth_failed", requests: 22, share: 0.07, firstSeen: "2026-10-14T11:10:00Z", lastSeen: "2026-10-14T11:50:00Z", sampleRequestIds: ["req_cccccccccccccccccccc"] },
], total: { requests: 372 } };
const KEYS = { ok: true, dim: "key", rows: [
  { key: "key_alpha", label: { zh: "key_alpha", en: "key_alpha" }, requests: 120, share: 0.7, errorRate: 0.05, promptTokens: 9000, outputTokens: 3000, ttftP95Ms: 410, spark: [1, 2, 3, null, 5, 8] },
  { key: "key_beta", label: { zh: "key_beta", en: "key_beta" }, requests: 50, share: 0.3, errorRate: 0, promptTokens: 1000, outputTokens: 500, ttftP95Ms: null, spark: [0, 0, 1, 1, 0, 2] },
], total: { requests: 170 } };
const IPS = { ok: true, dim: "client_ip", rows: [{ key: "203.0.113.7", requests: 14, share: 0.7, firstSeen: "2026-10-14T11:00:00Z", lastSeen: "2026-10-14T11:40:00Z" }, { key: "203.0.113.9", requests: 6, share: 0.3, lastSeen: "2026-10-14T11:20:00Z" }], total: { requests: 20 } };
const BANS = { ok: true, rows: [{ id: 7, at: "2026-10-14T11:41:00Z", type: "security.ban", severity: "warning", source: "entry", title: "Banned 203.0.113.7 for 15 min", data: { ip: "203.0.113.7" } }], nextCursor: null };
const SETTINGS = {
  ok: true, etag: "etag-1", enabled: true, sampleIntervalMs: 10000, timezoneOffsetMinutes: 480, keepJsonlAccessLog: true, maxDbMb: 2048, exportMaxRows: 200000,
  retention: { requestsDays: 30, ipDays: 30, samplesHours: 48, minuteDays: 14, hourDays: 400, eventsDays: 400 },
  energy: { pricePerKwh: null, currency: "CNY", tariffs: [], hostBaselineWatts: 0 }, alerts: { webhooks: [] },
};
const STATUS = {
  ok: true, schemaVersion: 1, dbBytes: 5242880, walBytes: 0, rows: { requests: 100 },
  collectors: { recorder: { state: "ok", lastOkAt: "2026-10-14T11:59:00Z", lastError: null, intervalMs: null }, runtime: { state: "degraded", lastOkAt: "2026-10-14T11:00:00Z", lastError: "timeout", intervalMs: 10000 },
    gpu: { state: "ok", lastOkAt: "2026-10-14T11:59:30Z", lastError: null, intervalMs: 10000 }, events: { state: "ok", lastOkAt: null, lastError: null, intervalMs: null }, store: { state: "ok", lastOkAt: null, lastError: null, intervalMs: null } },
  recorder: { inflight: 0, buffered: 0, dropped: 3 }, rollup: { watermark1m: null, dirty: 0 }, retention: { lastRunAt: "2026-10-14T04:00:00Z", deleted: 10 }, imports: [], degraded: ["runtime_degraded"],
};

function telemetryApi(extra = {}) {
  return {
    "GET /api/telemetry/live": LIVE_RICH,
    "GET /api/telemetry/summary": telemetry("summary"),
    "GET /api/telemetry/timeseries": (request) => timeseries(request),
    "GET /api/telemetry/alerts": telemetry("alerts"),
    "GET /api/telemetry/breakdown": (request) => {
      const { dim } = params(request);
      if (dim === "error_class") return ERROR_CLASSES;
      if (dim === "key") return KEYS;
      if (dim === "client_ip") return IPS;
      return TRUNCATION;
    },
    "GET /api/telemetry/events": BANS,
    "GET /api/telemetry/energy": (request) => (params(request).groupBy === "day" ? ENERGY_DAY : ENERGY_MODEL),
    "GET /api/telemetry/lifecycle": LIFECYCLE,
    "GET /api/telemetry/launches": LAUNCHES,
    "GET /api/telemetry/baseline": BASELINE,
    "GET /api/telemetry/status": STATUS,
    "GET /api/telemetry/settings": SETTINGS,
    ...extra,
  };
}

async function newPage(browser, { bootstrap = FULL, role = OWNER, api = telemetryApi(), size = SIZES.desktop, theme = "light", locale = "en-US" } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, { ...role, ...bootstrap });
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, {
    "GET /api/status": consoleFixture("status"),
    "GET /api/platform/status": consoleFixture("platform-status"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/fleet": consoleFixture("fleet"),
    ...api,
  });
  return { context, page, mock, failures };
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const callsOf = (mock, endpoint) => mock.find("GET", `/api/telemetry/${endpoint}`);
const withParam = (calls, name, value) => calls.filter((call) => call.query[name] === value);
const open = async (page, route) => {
  await page.goto(`${entry.url}${route}`);
  await expect(page.locator("#main h1")).toBeVisible();
};
// Every panel of a page has loaded when the loading skeletons are gone.
const settled = async (page) => {
  await expect(byId(page, "obs.loading")).toHaveCount(0);
  await expect(byId(page, "obs.error")).toHaveCount(0);
};

// ---------------------------------------------------------------------------
// Overview

test("overview: each panel calls its 04 endpoint with its parameters, and every number shows its window", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await open(page, "observability?range=6h");
    await settled(page);
    await expect(page.locator("#main h1")).toHaveText("Overview");

    // KPI tiles: compare=previous over the chosen window, each tile with its window and a delta.
    const summary = callsOf(mock, "summary");
    expect(summary.length).toBeGreaterThanOrEqual(1);
    expect(summary[0].query).toMatchObject({ compare: "previous" });
    const span = Date.parse(summary[0].query.to) - Date.parse(summary[0].query.from);
    expect(span).toBe(6 * 3600 * 1000);
    const tiles = byId(page, "obs.tiles").locator(".stat-tile");
    await expect(tiles).toHaveCount(9);
    for (let index = 0; index < 9; index += 1) await expect(tiles.nth(index).locator("[data-window]")).toHaveAttribute("data-window", "Last 6 h");
    await expect(byId(page, "obs.tile.requests")).toContainText("17");
    await expect(byId(page, "obs.tile.errorRate")).toContainText("5.9%");
    await expect(byId(page, "obs.tile.ttftP95")).toContainText("194");
    // Sparklines come from one timeseries call with the four listed metrics.
    const sparks = withParam(callsOf(mock, "timeseries"), "metrics", "req.count,req.error_rate,lat.ttft_p95,tok.output_per_s");
    expect(sparks).toHaveLength(1);
    expect(sparks[0].query.groupBy).toBeUndefined();
    await expect(byId(page, "obs.tile.requests").locator("svg.stat-spark")).toHaveCount(1);
    // Requests by status class: stacked, grouped by status_class.
    const status = withParam(withParam(callsOf(mock, "timeseries"), "metrics", "req.count"), "groupBy", "status_class");
    expect(status).toHaveLength(1);
    await expect(byId(page, "obs.status.chart")).toHaveAttribute("data-stacked", "true");
    await expect(byId(page, "obs.status").locator("[data-window]").first()).toHaveAttribute("data-window", "Last 6 h");
    // Alert banner: GET alerts?state=firing, title and severity, link to the Alerts page.
    expect(callsOf(mock, "alerts")[0].query).toMatchObject({ state: "firing" });
    await expect(byId(page, "obs.alerts")).toContainText("GPU 0 temperature high");
    await expect(byId(page, "obs.alerts")).toContainText("Warning");
    await expect(byId(page, "obs.alerts.open")).toHaveAttribute("href", "/alerts");
    // Live strip: gateway tiles with their windows, instances, GPUs.
    await expect(byId(page, "obs.live.rpm").locator("[data-window]")).toHaveAttribute("data-window", "Last 60 s");
    await expect(byId(page, "obs.live.error").locator("[data-window]")).toHaveAttribute("data-window", "Last 5 min");
    await expect(byId(page, "obs.live.instance")).toHaveCount(2);
    await expect(byId(page, "obs.live.gpus")).toContainText("GPU 0");
    await expect(page.locator("[data-testid='stat-tile.root'], .stat-tile").first()).toBeVisible();
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a telemetry.live event replaces the live strip without another request", async ({ browser }) => {
  const live = { ...LIVE_RICH, gateway: { ...LIVE_RICH.gateway, requestsPerMin: 99 } };
  // The stream answers after the first GET /live, as a real push does.
  const stream = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const envelope = { type: "telemetry.live", at: new Date().toISOString(), source: "entry", data: live };
    return { status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: `retry: 3600000

id: 1
event: telemetry.live
data: ${JSON.stringify(envelope)}

` };
  };
  const { context, page, mock } = await newPage(browser, { api: telemetryApi({ "GET /api/events": stream }) });
  try {
    await open(page, "observability");
    await settled(page);
    await expect(byId(page, "obs.live.rpm")).toContainText("2");
    await expect(byId(page, "obs.live.rpm")).toContainText("99", { timeout: 8000 });
    expect(callsOf(mock, "live")).toHaveLength(1);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// URL state

test("the range, filters and auto-refresh live in the URL, survive a reload and carry to the other sub-pages", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await open(page, "observability");
    await settled(page);
    // Preset range.
    await byId(page, "time-range-picker.1h").click();
    await expect(page).toHaveURL(/[?&]range=1h(&|$)/);
    // Filters: committed on change; chips show them; the URL carries them.
    await byId(page, "obs.filters.toggle").click();
    await byId(page, "obs.filter.model").fill("model-a");
    await byId(page, "obs.filter.model").press("Tab");
    await expect(page).toHaveURL(/[?&]model=model-a(&|$)/);
    await expect(byId(page, "obs.chips")).toContainText("model-a");
    await byId(page, "obs.auto-refresh").check();
    await expect(page).toHaveURL(/[?&]refresh=1(&|$)/);
    // Every filtered call carries the filter; the live call does not.
    await expect.poll(() => withParam(callsOf(mock, "summary"), "model", "model-a").length).toBeGreaterThan(0);
    expect(callsOf(mock, "live").every((call) => call.query.model === undefined)).toBe(true);

    // A reload restores the same view from the URL alone.
    await page.reload();
    await settled(page);
    await expect(byId(page, "time-range-picker.1h")).toHaveAttribute("aria-pressed", "true");
    await expect(byId(page, "obs.chips")).toContainText("model-a");
    await expect(byId(page, "obs.auto-refresh")).toBeChecked();

    // The sub-page links carry the whole view.
    await byId(page, "obs.nav.performance").click();
    await expect(page).toHaveURL(/\/observability\/performance\?.*range=1h/);
    await expect(page).toHaveURL(/model=model-a/);
    await expect(page).toHaveURL(/refresh=1/);
    await expect(page.locator("#main h1")).toHaveText("Performance");
    await expect.poll(() => withParam(callsOf(mock, "timeseries"), "metrics", "lat.ttft_p50,lat.ttft_p95,lat.ttft_p99").length).toBeGreaterThan(0);
    const latency = withParam(callsOf(mock, "timeseries"), "metrics", "lat.ttft_p50,lat.ttft_p95,lat.ttft_p99");
    expect(latency.at(-1).query.model).toBe("model-a");
    // A removed chip leaves the URL and the next request.
    await byId(page, "obs.chip.remove").click();
    await expect(page).not.toHaveURL(/model=/);
    await expect(byId(page, "obs.chips")).toHaveCount(0);
    // A custom range round-trips as from/to.
    await page.goto(`${entry.url}observability/errors?from=2026-10-14T10:00:00Z&to=2026-10-14T11:00:00Z`);
    await settled(page);
    await expect(byId(page, "time-range-picker.custom")).toHaveAttribute("aria-pressed", "true");
    const classes = callsOf(mock, "breakdown").filter((call) => call.query.dim === "error_class");
    expect(classes.at(-1).query).toMatchObject({ from: "2026-10-14T10:00:00.000Z", to: "2026-10-14T11:00:00.000Z" });
  } finally {
    await context.close();
  }
});

test("an unusable range in the link says so and shows the default", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await open(page, "observability?range=9y");
    await expect(byId(page, "obs.range-invalid")).toBeVisible();
    await expect(byId(page, "time-range-picker.24h")).toHaveAttribute("aria-pressed", "true");
  } finally {
    await context.close();
  }
});

test("brushing a chart narrows the range to a custom window in the URL", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await open(page, "observability/errors");
    await settled(page);
    const canvas = byId(page, "obs.errors.chart").locator(".u-over");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(page).toHaveURL(/[?&]from=.*&to=|[?&]to=.*&from=/);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Performance

test("performance: latency by model with annotations, engine metrics by fleet with the latency source, the TTFT heatmap", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: telemetryApi({ "GET /api/telemetry/timeseries": (request) => timeseries(request, { annotations: ANNOTATIONS }) }) });
  try {
    await open(page, "observability/performance");
    await settled(page);
    const series = callsOf(mock, "timeseries");
    const latency = withParam(series, "metrics", "lat.ttft_p50,lat.ttft_p95,lat.ttft_p99");
    expect(latency).toHaveLength(1);
    expect(latency[0].query).toMatchObject({ groupBy: "model", annotate: "launch,config,benchmark,container" });
    const engine = withParam(series, "metrics", "rt.output_tps,rt.running,rt.waiting,rt.kv_usage,rt.prefix_hit,rt.spec_accept");
    expect(engine).toHaveLength(1);
    expect(engine[0].query.groupBy).toBe("fleet");
    expect(withParam(series, "metrics", "lat.ttft_hist")).toHaveLength(1);

    // Annotations: one per event, in four kinds, in the legend list under the chart.
    const marks = byId(page, "obs.latency").locator("[data-testid='time-series-chart.annotation']");
    await expect(marks).toHaveCount(5);
    expect(await marks.evaluateAll((nodes) => nodes.map((node) => node.dataset.kind))).toEqual(["launch", "config", "config", "restart", "alert"]);
    await expect(marks.first()).toContainText("Launch ready: model-a");
    // 3 percentiles x 2 models, labels in words, the raw model after a dot.
    await expect(byId(page, "obs.latency").locator("[data-testid='time-series-chart.legend-item']")).toHaveCount(6);
    await expect(byId(page, "obs.latency")).toContainText("Time to first token (p95) · model-b");
    // The table view exposes the same numbers.
    await byId(page, "obs.latency").locator("[data-testid='time-series-chart.toggle']").click();
    await expect(byId(page, "obs.latency").locator("[data-testid='time-series-chart.table'] tbody tr")).toHaveCount(6);
    // Engine panel: six small charts, one per metric, and a latency-source badge per fleet.
    await expect(byId(page, "obs.engine.grid").locator("[data-metric]")).toHaveCount(6);
    await expect(byId(page, "obs.latency-source").locator("[data-fleet='vllm:primary']")).toContainText("Measured at the gateway (engine has no histograms)");
    await expect(byId(page, "obs.latency-source").locator("[data-fleet='llama:small']")).toContainText("This engine does not report this metric");
    // Heatmap: SVG cells, a table view, the window.
    await expect(byId(page, "obs.heatmap-panel").locator("rect.heat-cell").first()).toBeVisible();
    await byId(page, "obs.heatmap.toggle").click();
    await expect(byId(page, "obs.heatmap.table").locator("tbody tr")).toHaveCount(4);
    await expect(byId(page, "obs.heatmap-panel").locator("[data-window]").first()).toHaveAttribute("data-window", "Last 24 h");
    expect(mock.unmocked).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Traffic and Errors

test("traffic: requests by key, source and protocol, the key table with sparklines, auth failures by IP with ban events", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await open(page, "observability/traffic");
    await settled(page);
    const series = withParam(callsOf(mock, "timeseries"), "metrics", "req.count");
    for (const group of ["key", "source", "protocol"]) expect(withParam(series, "groupBy", group)).toHaveLength(1);
    const breakdown = callsOf(mock, "breakdown");
    expect(withParam(withParam(breakdown, "dim", "key"), "spark", "1")).toHaveLength(1);
    const ips = withParam(breakdown, "dim", "client_ip");
    expect(ips).toHaveLength(1);
    expect(ips[0].query.error_class).toBe("auth_failed,auth_banned");
    expect(withParam(callsOf(mock, "events"), "type", "security.ban")).toHaveLength(1);

    const rows = byId(page, "obs.keys.row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("key_alpha");
    await expect(rows.first()).toContainText("5.0%");
    await expect(rows.first().locator("svg.stat-spark")).toHaveCount(1);
    await expect(byId(page, "obs.keys").locator("[data-window]").first()).toHaveAttribute("data-window", "Last 24 h");
    const attempts = byId(page, "obs.auth.row");
    await expect(attempts).toHaveCount(2);
    await expect(attempts.first()).toContainText("203.0.113.7");
    await expect(attempts.first()).toContainText("Yes");
    await expect(attempts.nth(1)).toContainText("No");
    await expect(byId(page, "obs.auth.bans")).toContainText("Banned 203.0.113.7 for 15 min");
  } finally {
    await context.close();
  }
});

test("errors: rate by class, and a class row opens Requests pre-filtered with the view kept", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await open(page, "observability/errors?range=7d&model=model-a");
    await settled(page);
    const rate = withParam(withParam(callsOf(mock, "timeseries"), "metrics", "req.errors"), "groupBy", "error_class");
    expect(rate).toHaveLength(1);
    expect(rate[0].query.model).toBe("model-a");
    await expect(byId(page, "obs.errors.chart")).toHaveAttribute("data-stacked", "true");
    expect(withParam(callsOf(mock, "breakdown"), "dim", "error_class")).toHaveLength(1);

    const rows = byId(page, "obs.classes.row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Upstream timed out");
    await expect(rows.first()).toContainText("req_aaaaaaaaaaaaaaaaaaaa");
    await expect(rows.first().locator("[data-testid='obs.classes.open']")).toHaveAttribute("href", /^\/observability\/requests\?.*error_class=upstream_timeout/);
    await rows.first().locator("td").nth(1).click();
    await expect(page).toHaveURL(/\/observability\/requests\?/);
    await expect(page).toHaveURL(/error_class=upstream_timeout/);
    await expect(page).toHaveURL(/range=7d/);
    await expect(page).toHaveURL(/model=model-a/);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// GPU and Models

test("gpu & energy: per-GPU charts, throttle reasons, VRAM as a reservation, energy by day and by model", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await open(page, "observability/gpu?model=model-a");
    await settled(page);
    const series = callsOf(mock, "timeseries");
    const gpu = withParam(series, "metrics", "gpu.util,gpu.mem_used_mb,gpu.temp_c,gpu.power_w,gpu.sm_clock_mhz");
    expect(gpu).toHaveLength(1);
    expect(gpu[0].query.groupBy).toBe("gpu");
    const throttle = withParam(series, "metrics", "gpu.throttle_seconds");
    expect(throttle).toHaveLength(1);
    expect(throttle[0].query.groupBy).toBe("reason");
    await expect(byId(page, "obs.gpu.grid").locator("[data-metric]")).toHaveCount(5);
    await expect(byId(page, "obs.gpu.grid")).toContainText("GPU temperature (°C)");
    // VRAM per instance is a reservation and says so.
    await expect(byId(page, "obs.vram.note")).toHaveText("VRAM reservation (not measured)");
    await expect(byId(page, "obs.vram.bar").locator("[data-testid='stacked-bar.part']")).toHaveCount(2);
    // Energy calls take the window only, never the filters.
    const energy = callsOf(mock, "energy");
    expect(energy.map((call) => call.query.groupBy).sort()).toEqual(["day", "model"]);
    for (const call of energy) {
      expect(Object.keys(call.query).sort()).toEqual(["from", "groupBy", "to"]);
    }
    await expect(byId(page, "obs.energy-day.row")).toHaveCount(2);
    await expect(byId(page, "obs.energy-day.row").first()).toContainText("1.2 kWh");
    await expect(byId(page, "obs.energy-day.row").first()).toContainText("0.72 CNY");
    await expect(byId(page, "obs.no-price")).toHaveCount(0);
    // The filter still narrows the GPU call.
    expect(gpu[0].query.model).toBe("model-a");
  } finally {
    await context.close();
  }
});

test("models & instances: lifecycle Gantt, launch reliability, truncation, imported totals (no parameters, never charted)", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await open(page, "observability/models?range=7d&model=model-a");
    await settled(page);
    expect(callsOf(mock, "lifecycle")).toHaveLength(1);
    expect(Object.keys(callsOf(mock, "lifecycle")[0].query).sort()).toEqual(["from", "to"]);
    expect(withParam(callsOf(mock, "launches"), "groupBy", "model")).toHaveLength(1);
    const truncation = withParam(callsOf(mock, "breakdown"), "dim", "model");
    expect(truncation).toHaveLength(1);
    expect(truncation[0].query.metrics).toBe("requests,lengthShare");
    const baseline = callsOf(mock, "baseline");
    expect(baseline).toHaveLength(1);
    expect(baseline[0].query).toEqual({});

    await expect(byId(page, "obs.gantt.row")).toHaveCount(2);
    await expect(byId(page, "obs.gantt.row").first().locator(".gantt-bar")).toHaveCount(4);
    expect(await byId(page, "obs.gantt.row").first().locator(".gantt-bar").evaluateAll((nodes) => nodes.map((node) => node.dataset.state))).toEqual(["loading", "ready", "sleeping", "ready"]);
    await expect(byId(page, "obs.gantt")).toContainText("Crashed");
    await expect(byId(page, "obs.launches.row").first()).toContainText("cuda_oom");
    await expect(byId(page, "obs.launches.row").first()).toContainText("9 min");
    await expect(byId(page, "obs.truncation.row").first().locator("progress")).toHaveAttribute("value", "0.25");
    await expect(byId(page, "obs.imported").locator("[data-window]").first()).toHaveAttribute("data-window", "Imported lifetime totals (no time breakdown)");
    await expect(byId(page, "obs.imported.row")).toHaveCount(1);
    await expect(byId(page, "obs.imported").locator("canvas, .u-over, svg.stat-spark")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("every panel on every chart page names the window of its numbers", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    for (const route of ["observability?range=7d", "observability/performance?range=7d", "observability/traffic?range=7d", "observability/errors?range=7d", "observability/gpu?range=7d", "observability/models?range=7d"]) {
      await open(page, route);
      await settled(page);
      const cards = await page.locator("#main section.card").evaluateAll((nodes) => nodes.map((node) => ({ title: node.querySelector(".card-title")?.textContent || "", window: node.querySelector("[data-window]")?.getAttribute("data-window") || "" })));
      expect(cards.length, route).toBeGreaterThan(1);
      for (const card of cards) expect(card.window, `${route}: ${card.title}`).not.toBe("");
      // Everything that is a time window says the chosen range; the other windows are explicit states.
      const windows = new Set(cards.map((card) => card.window));
      expect([...windows].every((value) => ["Last 7 d", "Right now", "Imported lifetime totals (no time breakdown)"].includes(value)), `${route}: ${[...windows].join(" | ")}`).toBe(true);
    }
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Settings

test("settings: status, a PUT with only the changed fields and If-Match, a stale etag, field errors, and import with a dry run first", async ({ browser }) => {
  const puts = [];
  let putMode = "ok";
  const imports = [];
  let runState = "running";
  const { context, page, mock } = await newPage(browser, {
    api: telemetryApi({
      "PUT /api/telemetry/settings": (request) => {
        puts.push({ body: JSON.parse(request.postData()), ifMatch: request.headers()["if-match"] });
        if (putMode === "stale") return { status: 409, body: { ok: false, error: { code: "etag_mismatch", message: "changed" }, etag: "etag-2" } };
        if (putMode === "invalid") return { status: 400, body: { ok: false, error: { code: "invalid_request", message: "not saved" }, errors: [{ field: "retention.hourDays", code: "out_of_range", message: "too long" }] } };
        return { ok: true, etag: "etag-2", changed: ["retention.requestsDays"], restartRequired: [] };
      },
      "POST /api/telemetry/import": (request) => {
        imports.push(JSON.parse(request.postData()));
        runState = "running";
        return { ok: true, runId: `run_${imports.length}` };
      },
      "GET /api/telemetry/import/run_1": () => ({ ok: true, runId: "run_1", state: runState, dryRun: true, sources: ["metrics-history", "stats-ledger", "access-logs", "service-usage", "jobs-ledger", "process-exit", "audit-manifests", "benchmarks", "mcp-audit"],
        progress: runState === "running" ? { source: "stats-ledger" } : null,
        report: runState === "done" ? { rowsIn: 120, rowsWritten: 100, rowsSkipped: { duplicate: 20 }, warnings: ["one file was empty"], reports: [{ source: "stats-ledger", files: 2, rowsIn: 120, rowsWritten: 100, rowsSkipped: { duplicate: 20 }, warnings: [] }] } : null }),
      "GET /api/telemetry/import/run_2": () => ({ ok: true, runId: "run_2", state: "done", dryRun: false, sources: ["metrics-history", "stats-ledger", "access-logs", "service-usage", "jobs-ledger", "process-exit", "audit-manifests", "benchmarks", "mcp-audit"], progress: null,
        report: { rowsIn: 120, rowsWritten: 100, rowsSkipped: {}, warnings: [], reports: [] } }),
    }),
  });
  try {
    await open(page, "observability/settings");
    await expect(byId(page, "obs.settings.form")).toBeVisible();
    // Collector status: states with words, last error, a degraded line.
    await expect(byId(page, "obs.collector")).toHaveCount(5);
    await expect(byId(page, "obs.collector").nth(1)).toContainText("Degraded");
    await expect(byId(page, "obs.status.degraded")).toContainText("runtime_degraded");
    // There is no time range here.
    await expect(byId(page, "obs.toolbar")).toHaveCount(0);
    // No price set: the copy says energy only.
    await expect(byId(page, "obs.settings.noPrice")).toContainText("No electricity price set; showing energy only");

    // A change sends only that field, with If-Match, CSRF and no webhook list.
    await expect(byId(page, "obs.settings.save")).toBeDisabled();
    await byId(page, "obs.set.retention.requestsDays").fill("45");
    await byId(page, "obs.set.retention.ipDays").fill("60");
    await expect(byId(page, "obs.set.retention.ipDays.field")).toContainText("IP retention cannot be longer");
    await expect(byId(page, "obs.settings.save")).toBeDisabled();
    await byId(page, "obs.set.retention.ipDays").fill("30");
    await byId(page, "obs.set.energy.pricePerKwh").fill("0.6");
    await byId(page, "obs.tariff.add").click();
    await byId(page, "obs.tariff.from").fill("23:00");
    await byId(page, "obs.tariff.to").fill("07:00");
    await byId(page, "obs.tariff.pricePerKwh").fill("0.3");
    await byId(page, "obs.settings.save").click();
    await expect(byId(page, "obs.settings.saved")).toBeVisible();
    expect(puts).toHaveLength(1);
    expect(puts[0].ifMatch).toBe("etag-1");
    expect(puts[0].body).toEqual({ retention: { requestsDays: 45 }, energy: { pricePerKwh: 0.6, tariffs: [{ from: "23:00", to: "07:00", pricePerKwh: 0.3 }] } });
    expect(mock.csrfViolations).toEqual([]);

    // A stale etag asks for a reload.
    putMode = "stale";
    await byId(page, "obs.set.maxDbMb").fill("4096");
    await byId(page, "obs.settings.save").click();
    await expect(byId(page, "obs.settings.conflict")).toBeVisible();
    await byId(page, "obs.settings.reload").click();
    // The writer's errors[] land under their fields.
    putMode = "invalid";
    await byId(page, "obs.set.retention.hourDays").fill("300");
    await byId(page, "obs.settings.save").click();
    await expect(byId(page, "obs.set.retention.hourDays.field")).toContainText("Outside the allowed range");
    await expect(byId(page, "obs.settings.problem")).toBeVisible();

    // Import: no live run before a dry run; the dry run is polled; then the live run asks first.
    await expect(byId(page, "obs.import.run")).toBeDisabled();
    await byId(page, "obs.import.dry").click();
    await expect(byId(page, "obs.import.running")).toBeVisible();
    runState = "done";
    await expect(byId(page, "obs.import.report")).toBeVisible({ timeout: 10_000 });
    await expect(byId(page, "obs.import.summary")).toContainText("Dry run finished. Nothing was written.");
    expect(imports).toHaveLength(1);
    expect(imports[0].dryRun).toBe(true);
    await expect(byId(page, "obs.import.run")).toBeEnabled();
    await byId(page, "obs.import.source.benchmarks").uncheck();
    await expect(byId(page, "obs.import.run")).toBeDisabled();
    await byId(page, "obs.import.source.benchmarks").check();
    await byId(page, "obs.import.dry").click();
    await expect(byId(page, "obs.import.run")).toBeEnabled({ timeout: 10_000 });
    await byId(page, "obs.import.run").click();
    await byId(page, "obs.import.confirm").getByRole("button", { name: "Import" }).click();
    await expect.poll(() => imports.length).toBe(3);
    expect(imports[2].dryRun).toBe(false);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 04 §19 edge states

test("edge: an engine without the metric reads 'does not report this metric', never an empty chart or zero", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: telemetryApi({ "GET /api/telemetry/timeseries": (request) => timeseries(request, { silent: ["rt.spec_accept"] }) }),
  });
  try {
    await open(page, "observability/performance");
    await settled(page);
    const spec = byId(page, "obs.engine.grid.rt.spec_accept");
    await expect(spec.locator("[data-testid='obs.engine.unsupported'], [data-testid='obs.metric.unsupported']")).toHaveText("This engine does not report this metric");
    await expect(spec.locator("[data-testid='time-series-chart.canvas']")).toHaveCount(0);
    await expect(byId(page, "obs.engine.grid.rt.running").locator("[data-testid='time-series-chart.canvas']")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("edge: a metric the answer lists as unsupported, and an engine latency metric of a fleet whose latency source is none", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: telemetryApi({
      "GET /api/telemetry/timeseries": (request) => {
        const answer = timeseries(request);
        if (params(request).metrics?.startsWith("lat.ttft_p50")) return { ...answer, unsupported: ["lat.ttft_p99"] };
        return answer;
      },
    }),
  });
  try {
    await open(page, "observability/performance");
    await settled(page);
    const note = byId(page, "obs.latency").locator("[data-testid='obs.unsupported']");
    await expect(note).toContainText("Time to first token (p99)");
    await expect(note).toContainText("This engine does not report this metric");
    await expect(byId(page, "obs.latency").locator("[data-testid='time-series-chart.legend-item']")).toHaveCount(4);
  } finally {
    await context.close();
  }
});

test("edge: an idle instance says idle; a collection gap is a break with its explanation; no price says energy only", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: telemetryApi({
      "GET /api/telemetry/timeseries": (request) => timeseries(request, { gapAt: 2 }),
      "GET /api/telemetry/energy": (request) => NO_PRICE(params(request).groupBy === "day" ? ENERGY_DAY : ENERGY_MODEL),
    }),
  });
  try {
    await open(page, "observability");
    await settled(page);
    const idle = page.locator("[data-testid='obs.live.instance'][data-idle='true']");
    await expect(idle).toHaveCount(1);
    await expect(idle).toContainText("Idle: no requests in this interval");
    await expect(page.locator("[data-testid='obs.live.instance'][data-idle='false']")).not.toContainText("Idle:");
    // The gap: a note, and the table view shows a dash (not zero) for the missing sample.
    await expect(byId(page, "obs.status").locator("[data-testid='obs.gap']")).toHaveText("Collection gap (service was not running)");
    await byId(page, "obs.status").locator("[data-testid='time-series-chart.toggle']").click();
    await expect(byId(page, "obs.status").locator("td[data-gap='true']").first()).toHaveText("—");
    // The cost tile has no value and names the reason.
    await expect(byId(page, "obs.tile.cost")).toContainText("No electricity price set; showing energy only");

    await open(page, "observability/gpu");
    await settled(page);
    await expect(byId(page, "obs.no-price")).toHaveCount(2);
    await expect(byId(page, "obs.energy-day.table")).not.toContainText("Cost");
    await expect(byId(page, "obs.energy-day.row").first()).toContainText("1.2 kWh");
  } finally {
    await context.close();
  }
});

test("edge: a read-only view (summary says viewer) shows the read-only copy and hides the owner-only filter", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: telemetryApi({ "GET /api/telemetry/summary": { ...telemetry("summary"), viewer: true } }),
  });
  try {
    await open(page, "observability");
    await settled(page);
    await expect(byId(page, "obs.read-only")).toHaveText("Read-only view: IPs, keys and request details are hidden");
    await byId(page, "obs.filters.toggle").click();
    await expect(byId(page, "obs.filter.key_id")).toHaveCount(0);
    await expect(byId(page, "obs.filter.model")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("before 04 the pages show one Legacy statistics card with an explicit window and draw no charts", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    bootstrap: NO_TELEMETRY,
    api: {
      "GET /api/gateway-access": { ok: true, totals: { requests: { total: 1240, success: 1200, error: 40, errorRate: 0.0322 }, tokens: { input: 1, output: 1, total: 2 }, latency: { p95Ms: 1 } }, recent: [] },
    },
  });
  try {
    await open(page, "observability/performance");
    const card = byId(page, "obs.legacy");
    await expect(card).toBeVisible();
    await expect(card.locator("h2")).toHaveText("Legacy statistics");
    await expect(byId(page, "obs.legacy.requests")).toContainText("1,240");
    await expect(byId(page, "obs.legacy.requests").locator("[data-window]")).toHaveAttribute("data-window", "Last 2,000 gateway log lines");
    expect(mock.find("GET", "/api/telemetry/timeseries")).toEqual([]);
    expect(mock.find("GET", "/api/telemetry/live")).toEqual([]);
    await expect(page.locator("[data-testid='time-series-chart.canvas']")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a failing panel shows its error with Retry and the other panels keep working", async ({ browser }) => {
  let failing = true;
  const { context, page } = await newPage(browser, {
    api: telemetryApi({
      "GET /api/telemetry/launches": () => (failing
        ? { status: 503, body: { ok: false, error: { code: "telemetry_unavailable", message: "Telemetry is not running" } } }
        : LAUNCHES),
    }),
  });
  try {
    await open(page, "observability/models");
    await expect(byId(page, "obs.launches").locator("[data-testid='obs.error']")).toBeVisible();
    await expect(byId(page, "obs.gantt.row").first()).toBeVisible();
    failing = false;
    await byId(page, "obs.launches").locator("[data-testid='obs.retry']").click();
    await expect(byId(page, "obs.launches.row").first()).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Language, access and layout

test("zh-CN: labels and metric names are Chinese; the English page has no Han outside user content", async ({ browser }) => {
  const zh = await newPage(browser, { locale: "zh-CN" });
  try {
    await open(zh.page, "observability/performance");
    await settled(zh.page);
    await expect(zh.page.locator("#main h1")).toHaveText("性能");
    await expect(byId(zh.page, "obs.latency")).toContainText("首字延迟");
    await expect(byId(zh.page, "obs.latency-source").locator("[data-fleet='vllm:primary']")).toContainText("由网关测得（引擎无直方图）");
    await expect(byId(zh.page, "obs.latency").locator("[data-window]").first()).toHaveAttribute("data-window", "过去 24 小时");
  } finally {
    await zh.context.close();
  }
  for (const route of ["observability", "observability/performance", "observability/traffic", "observability/errors", "observability/gpu", "observability/models", "observability/settings"]) {
    const en = await newPage(browser, { locale: "en-US" });
    try {
      await open(en.page, route);
      await settled(en.page);
      const han = await en.page.evaluate(() => {
        const found = [];
        const walker = document.createTreeWalker(document.querySelector("#main"), NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (/\p{Script=Han}/u.test(node.textContent) && !node.parentElement.closest("[data-user-content]")) found.push(node.textContent.trim().slice(0, 60));
        }
        return found;
      });
      expect(han, route).toEqual([]);
    } finally {
      await en.context.close();
    }
  }
});

test("the owner-only pages and panels stay away from a viewer", async ({ browser }) => {
  const viewer = { role: "viewer", auth: { mode: "session", session: { role: "viewer", via: "none", paired: false, autoPairAvailable: false }, csrf: null } };
  const { context, page, mock } = await newPage(browser, { role: viewer, api: telemetryApi({ "GET /api/session": { ok: true, role: "viewer", paired: false, csrfToken: null, pairCommand: "platform admin pair" } }) });
  try {
    await open(page, "observability/settings");
    await expect(page.locator("#main")).not.toContainText("Collector status");
    expect(mock.find("GET", "/api/telemetry/settings")).toEqual([]);
  } finally {
    await context.close();
  }
});

// The elements past the viewport's right edge that no scrolling container holds, for the failure message of an overflow.
async function noOverflow(page, label) {
  const wide = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const held = (node) => {
      for (let parent = node.parentElement; parent && parent.id !== "main"; parent = parent.parentElement) {
        if (/auto|scroll|hidden/.test(getComputedStyle(parent).overflowX) && parent.getBoundingClientRect().right <= limit + 1) return true;
      }
      return false;
    };
    return [...document.querySelectorAll("#main *")].filter((node) => node.getBoundingClientRect().right > limit + 1 && !held(node))
      .slice(0, 6).map((node) => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}[${node.dataset.testid || ""}] right=${Math.round(node.getBoundingClientRect().right)}`);
  });
  expect(wide, `${label}: elements past the right edge`).toEqual([]);
  await expectNoOverflow(page);
}

const PAGES = ["observability", "observability/performance", "observability/traffic", "observability/errors", "observability/gpu", "observability/models", "observability/settings"];

for (const theme of ["light", "dark"]) {
  for (const size of ["desktop", "phone"]) {
    test(`observability pages have no axe findings and no overflow, ${theme} at ${SIZES[size].width}`, async ({ browser }) => {
      test.setTimeout(240_000);
      const { context, page, failures } = await newPage(browser, { size: SIZES[size], theme, api: telemetryApi({ "GET /api/telemetry/timeseries": (request) => timeseries(request, { annotations: ANNOTATIONS, gapAt: 3 }) }) });
      try {
        for (const route of PAGES) {
          await open(page, route);
          await settled(page);
          if (route !== "observability/settings") await expect(page.locator("[data-testid='time-series-chart.canvas'], [data-testid='obs.gantt'], [data-testid='obs.classes']").first()).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expectNoA11yViolations(page, { label: `${route} ${theme} ${size}` });
          await noOverflow(page, `${route} ${theme} ${size}`);
        }
        expect(realFailures(failures)).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}
