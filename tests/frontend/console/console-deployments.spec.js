// CON-9 browser checks (07 §6.2, §13.2 console-deployments): the Deployments
// list, the detail page and Routing. The fleet assertions of the classic
// console's smoke test are ported here: exact settings and preview bodies with
// no content fields, a keyed row and its focus kept across a refresh, and
// `aria-pressed` on the mode buttons. Also Stop behind a confirmation, logs
// that poll with `since` and append without repeating lines, Relaunch through
// Review, Wake with the `slp_` id and the 409 `wake_would_replace_running`
// confirmation, the metrics tiles with an `unsupported` key, and the phase
// durations from `lifecycle.phaseHistory`. The real service-entry serves the
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

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "console");
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const HAN = /\p{Script=Han}/u;
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = { role: "owner", auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" } };
const VIEWER = { role: "viewer", auth: { mode: "session", session: { role: "viewer", via: "none", paired: false, autoPairAvailable: false }, csrf: null } };
const ENGINES = { features: { engines: true } };
const WITH_TELEMETRY = { features: { engines: true, telemetry: true } };
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const SLEEP_ID = "slp_demo000000000000000a";

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

// "@now", "@now-2h" and "@now+2d" in a fixture become ISO times around the present.
function resolve(value) {
  if (typeof value === "string") {
    const match = /^@now(?:([-+])(\d+)([mhd]))?$/.exec(value);
    if (!match) return value;
    const offset = match[1] ? (match[1] === "-" ? -1 : 1) * Number(match[2]) * UNITS[match[3]] : 0;
    return new Date(Date.now() + offset).toISOString();
  }
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  return value;
}
const fixture = (name, dir = "deployments") => resolve(JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, `${name}.json`), "utf8")));

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
    const body = (await response.text()).replace(BOOTSTRAP_BLOCK, (match, open, json, close) => (
      `${open}${JSON.stringify(merge(JSON.parse(json), patch)).replace(/</g, "\\u003c")}${close}`));
    await route.fulfill({ response, body });
  }));
}

function baseApi(extra = {}) {
  return {
    "GET /api/status": JSON.parse(fs.readFileSync(path.join(FIXTURES, "status.json"), "utf8")),
    "GET /api/fleet": fixture("fleet"),
    "GET /api/m/vllm/instances": fixture("instances-vllm"),
    "GET /api/m/llama/instances": fixture("instances-llama"),
    "GET /api/m/vllm/recent-launches": fixture("recent-launches"),
    "GET /api/m/llama/recent-launches": { launches: [] },
    "GET /api/m/vllm/tools/profiles": fixture("profiles"),
    "GET /api/m/llama/tools/profiles": { builtin: [], profiles: [] },
    ...extra,
  };
}

function telemetryApi(extra = {}) {
  return baseApi({
    "GET /api/telemetry/live": fixture("telemetry-live"),
    "GET /api/telemetry/breakdown": fixture("breakdown-fleet"),
    "GET /api/telemetry/timeseries": fixture("timeseries"),
    "GET /api/telemetry/requests": fixture("requests"),
    "GET /api/telemetry/events": fixture("telemetry-events"),
    ...extra,
  });
}

async function newPage(browser, { bootstrap = {}, role = OWNER, api = {}, size = SIZES.desktop, theme = "light", locale = "en-US", withTelemetry = false } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, { ...role, ...(withTelemetry ? WITH_TELEMETRY : ENGINES), ...bootstrap });
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, {
    "GET /api/m/vllm/instances/primary/metrics": fixture("metrics"),
    "GET /api/m/vllm/instances/primary/launch": fixture("launch"),
    "GET /api/m/vllm/engines/sglang/schema": JSON.parse(fs.readFileSync(path.join(FIXTURES, "schema-sglang.json"), "utf8")),
    ...(withTelemetry ? telemetryApi() : baseApi()),
    ...api,
  });
  return { context, page, mock, failures };
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const listReady = (page) => expect(byId(page, "deploy.list.root")).toHaveAttribute("data-ready", "true");
const row = (page, key) => byId(page, "deploy.table").locator(`tr[data-render-key="${key}"]`);
const listRows = (page) => byId(page, "deploy.table").locator("tr[data-render-key]");
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const bodiesOf = (calls) => calls.map((call) => call.body);

// ---------------------------------------------------------------------------
// List

test("the list shows every instance with its state, model, engine@version, recipe, port, context, VRAM, GPUs, tok/s, requests and uptime", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, { withTelemetry: true });
  try {
    await page.goto(`${entry.url}deployments`);
    await listReady(page);
    await expect(page.locator("#main h1")).toHaveText("Deployments");
    const ready = row(page, "vllm:primary");
    await expect(ready).toBeVisible();
    await expect(ready).toContainText("Ready");
    await expect(ready).toContainText("qwen3-demo-32b");
    await expect(ready).toContainText("sglang@0.5.17");
    await expect(ready).toContainText("qwen38-flashnext-262k");
    await expect(ready).toContainText("8000");
    await expect(ready).toContainText("262,144");
    await expect(ready).toContainText("85.9 GiB");
    await expect(ready).toContainText("92.4");
    await expect(ready).toContainText("57");
    await expect(ready).toContainText("2 hr");
    const crashed = row(page, "llama:primary");
    await expect(crashed).toContainText("Crashed");
    await expect(crashed).toContainText("llamacpp@b10630");
    await expect(listRows(page)).toHaveCount(2);
    expect(mock.find("GET", "/api/telemetry/breakdown")[0].query).toMatchObject({ dim: "fleet" });
    expect(mock.find("GET", "/api/m/vllm/instances")[0].query).toMatchObject({ include: "sleeping" });
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("filters narrow the list by engine, manager and state; ?manager= pre-filters", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await page.goto(`${entry.url}deployments?manager=llama`);
    await listReady(page);
    await expect(listRows(page)).toHaveCount(1);
    await expect(row(page, "llama:primary")).toBeVisible();
    await expect(byId(page, "deploy.filter.manager")).toHaveValue("llama");
    await byId(page, "deploy.filter.manager").selectOption("");
    await expect(listRows(page)).toHaveCount(2);
    await byId(page, "deploy.filter.engine").selectOption("sglang");
    await expect(listRows(page)).toHaveCount(1);
    await expect(row(page, "vllm:primary")).toBeVisible();
    await byId(page, "deploy.filter.engine").selectOption("");
    await byId(page, "deploy.filter.state").selectOption("crashed");
    await expect(listRows(page)).toHaveCount(1);
    await expect(row(page, "llama:primary")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("state")).toBe("crashed");
  } finally {
    await context.close();
  }
});

test("a refresh keeps the keyed row, its buttons and the focus inside them", async ({ browser }) => {
  let reads = 0;
  const { context, page } = await newPage(browser, { api: { "GET /api/fleet": () => { reads += 1; return fixture("fleet"); } } });
  try {
    await page.goto(`${entry.url}deployments`);
    await listReady(page);
    const logs = row(page, "vllm:primary").locator('[data-testid="deploy.row.logs"]');
    await logs.focus();
    await page.evaluate(() => {
      window.__row = document.querySelector('tr[data-render-key="vllm:primary"]');
      window.__logs = window.__row.querySelector('[data-testid="deploy.row.logs"]');
    });
    const target = reads + 1;
    // A programmatic click refreshes without moving the focus, like the classic window.refresh().
    await page.evaluate(() => document.querySelector('[data-testid="deploy.list.refresh"]').click());
    await expect.poll(() => reads).toBeGreaterThanOrEqual(target);
    await expect(byId(page, "deploy.list.root")).toHaveAttribute("data-ready", "true");
    expect(await page.evaluate(() => (
      window.__row === document.querySelector('tr[data-render-key="vllm:primary"]')
      && window.__logs === document.querySelector('tr[data-render-key="vllm:primary"] [data-testid="deploy.row.logs"]')
      && document.activeElement === window.__logs
    )), "refresh should retain the keyed row, its button and the focus").toBe(true);
  } finally {
    await context.close();
  }
});

test("Stop asks first; Cancel sends nothing and OK posts the stop to the instance's manager", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { "POST /api/m/vllm/instances/primary/stop": { ok: true } } });
  try {
    await page.goto(`${entry.url}deployments`);
    await listReady(page);
    await row(page, "vllm:primary").getByRole("button", { name: "Stop vllm:primary" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Stop vllm:primary?");
    await expect(dialog).toContainText("In-flight requests are cut and clients get 503.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(mock.find("POST", "/api/m/vllm/instances")).toEqual([]);
    await row(page, "vllm:primary").getByRole("button", { name: "Stop vllm:primary" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => mock.find("POST", "/api/m/vllm/instances/primary/stop").length).toBe(1);
    expect(bodiesOf(mock.find("POST", "/api/m/vllm/instances/primary/stop"))).toEqual([{}]);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("sleeping records get their own section; Wake sends the slp_ id and no confirmation flag", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: { [`POST /api/m/vllm/idle-unload/${SLEEP_ID}/wake`]: { ok: true, id: SLEEP_ID, job: { id: "job_1" } } },
  });
  try {
    await page.goto(`${entry.url}deployments`);
    await listReady(page);
    const section = byId(page, "deploy.sleeping");
    await expect(section.getByRole("heading", { name: "Sleeping" })).toBeVisible();
    const sleeping = section.locator("tr[data-render-key]");
    await expect(sleeping).toHaveCount(1);
    await expect(sleeping).toContainText("demo-moe-30b");
    await expect(sleeping).toContainText("vllm@0.11.0");
    await sleeping.getByRole("button", { name: "Wake demo-moe-30b" }).click();
    await expect.poll(() => mock.find("POST", `/api/m/vllm/idle-unload/${SLEEP_ID}/wake`).length).toBe(1);
    expect(bodiesOf(mock.find("POST", "/api/m/vllm/idle-unload"))).toEqual([{}]);
    expect(mock.find("POST", "/api/m/vllm/idle-unload")[0].path).toContain(SLEEP_ID);
    expect(mock.find("POST", "/api/m/vllm/idle-unload")[0].path).not.toContain("/primary/");
  } finally {
    await context.close();
  }
});

test("a 409 wake_would_replace_running asks, and only OK re-sends {confirmReplace:true}", async ({ browser }) => {
  const wake = (request) => {
    const body = request.postDataJSON();
    if (body?.confirmReplace === true) return { ok: true, id: SLEEP_ID, job: { id: "job_2" } };
    return {
      status: 409,
      body: { ok: false, code: "wake_would_replace_running", error: "Waking would replace the running model Qwen3-Demo.", details: { runningModel: "Qwen3-Demo", runningContainer: "vllm-local" } },
    };
  };
  const { context, page, mock } = await newPage(browser, { api: { [`POST /api/m/vllm/idle-unload/${SLEEP_ID}/wake`]: wake } });
  try {
    await page.goto(`${entry.url}deployments`);
    await listReady(page);
    const button = byId(page, "deploy.sleeping").getByRole("button", { name: "Wake demo-moe-30b" });
    await button.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText('Waking will stop and replace the running model "Qwen3-Demo". Continue?');
    expect(bodiesOf(mock.find("POST", "/api/m/vllm/idle-unload"))).toEqual([{}]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(bodiesOf(mock.find("POST", "/api/m/vllm/idle-unload")), "Cancel must not re-send").toEqual([{}]);
    await button.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Replace and wake" }).click();
    await expect.poll(() => mock.find("POST", "/api/m/vllm/idle-unload").length).toBe(3);
    expect(bodiesOf(mock.find("POST", "/api/m/vllm/idle-unload"))).toEqual([{}, {}, { confirmReplace: true }]);
  } finally {
    await context.close();
  }
});

test("a 409 wake_api_key_missing shows the key copy and links to Relaunch (Review)", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: { [`POST /api/m/vllm/idle-unload/${SLEEP_ID}/wake`]: { status: 409, body: { ok: false, code: "wake_api_key_missing", error: "key gone" } } },
  });
  try {
    await page.goto(`${entry.url}deployments`);
    await listReady(page);
    await byId(page, "deploy.sleeping").getByRole("button", { name: "Wake demo-moe-30b" }).click();
    const dialog = page.getByRole("alertdialog, dialog").first();
    await expect(page.getByRole("dialog")).toContainText("The original API key is no longer available. Start the model again from the launch page.");
    await page.getByRole("dialog").getByRole("button", { name: "Relaunch" }).click();
    await expect(page).toHaveURL(/\/deployments\/new\?clone=lch_bbbbbbbbbbbbbbbbbbbb&manager=vllm&step=review&from=relaunch/);
    expect(bodiesOf(mock.find("POST", "/api/m/vllm/idle-unload"))).toEqual([{}]);
    expect(dialog).toBeTruthy();
  } finally {
    await context.close();
  }
});

test("recent launches and profiles per manager open Review and never start anything", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await page.goto(`${entry.url}deployments`);
    await listReady(page);
    const vllm = byId(page, "deploy.recent").locator('[data-manager="vllm"]');
    await expect(vllm).toContainText("qwen3-demo-32b");
    await expect(vllm).toContainText("My fast profile");
    await expect(vllm).toContainText("Balanced demo");
    const hrefs = await vllm.locator("a").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
    expect(hrefs).toContain("/deployments/new?manager=vllm&step=review&from=recent&recent=0");
    expect(hrefs).toContain("/deployments/new?manager=vllm&profile=my-fast&step=review");
    for (const href of hrefs) expect(href).toContain("step=review");
    await expect(byId(page, "deploy.recent").locator('[data-manager="llama"]')).toContainText("No recent launches or profiles yet.");
    expect(mock.calls.filter((call) => call.method !== "GET")).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a viewer sees the list without Stop, Wake or the recent launches", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { role: VIEWER, session: undefined });
  try {
    await page.goto(`${entry.url}deployments`);
    await listReady(page);
    await expect(listRows(page)).toHaveCount(2);
    await expect(byId(page, "deploy.row.stop")).toHaveCount(0);
    await expect(byId(page, "deploy.row.wake")).toHaveCount(0);
    await expect(byId(page, "deploy.recent")).toHaveCount(0);
    await expect(byId(page, "deploy.list.new")).toHaveCount(0);
    expect(mock.find("GET", "/api/m/vllm/recent-launches")).toEqual([]);
    expect(mock.find("GET", "/api/m/vllm/idle-unload")).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Detail

const detailUrl = (query = "") => `${entry.url}deployments/${encodeURIComponent("vllm:primary")}${query}`;

test("Overview: phase durations come from phaseHistory, endpoints copy, capability chips, image and memory", async ({ browser }) => {
  const { context, page } = await newPage(browser, { withTelemetry: true });
  try {
    await page.goto(detailUrl());
    await expect(byId(page, "deploy.detail.root")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("#main h1")).toHaveText("qwen3-demo-32b");
    const steps = byId(page, "deploy.stepper").locator("[data-testid='stepper.step']");
    await expect(steps).toHaveCount(9);
    const pull = steps.filter({ hasText: "Image pull" });
    await expect(pull).toHaveAttribute("data-state", "skipped");
    const weights = steps.filter({ hasText: "Weights" });
    await expect(weights).toHaveAttribute("data-state", "done");
    await expect(weights).toContainText("1 min 35 sec");
    await expect(steps.filter({ hasText: "Admission" })).toContainText("1 sec");
    const endpoints = byId(page, "deploy.endpoints").locator("[data-endpoint]");
    await expect(endpoints).toHaveCount(4);
    await expect(endpoints.nth(0)).toContainText("http://local-demo.invalid:8000/v1");
    await expect(byId(page, "deploy.endpoints").locator("[data-endpoint='gateway']")).toContainText("/gateway/vllm/openai/v1");
    await expect(page.locator("[data-testid='deploy.chip']")).toHaveText(["Text", "Tools", "Reasoning"]);
    await expect(byId(page, "deploy.fact.image")).toContainText("example/sglang:0.5.17@sha256:0123456789abcdef");
    await expect(byId(page, "deploy.facts")).toContainText("qwen38-flashnext-262k");
    await expect(byId(page, "deploy.facts")).toContainText("38.2");
    await expect(byId(page, "deploy.memory")).toBeVisible();
    await expect(byId(page, "deploy.memory").locator("[data-testid='gpu-memory-bar.table']")).toContainText("This deployment");
  } finally {
    await context.close();
  }
});

test("Metrics: tiles read metrics, an unsupported key says so and never shows 0, charts carry this fleetId", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { withTelemetry: true });
  try {
    await page.goto(detailUrl("?tab=metrics"));
    await expect(byId(page, "deploy.metrics.tiles")).toHaveAttribute("data-ready", "true");
    const tile = (id) => byId(page, `deploy.metric.${id}`);
    await expect(tile("kv")).toContainText("31.0%");
    await expect(tile("kv").locator("[data-window]")).toHaveAttribute("data-window", "now");
    await expect(tile("running")).toContainText("1");
    await expect(tile("waiting")).toHaveAttribute("data-state", "unsupported");
    await expect(tile("waiting")).toContainText("Not reported by this engine");
    await expect(tile("waiting").locator("[data-testid='stat-tile.value']")).toHaveText("—");
    await expect(tile("ttftP50")).toContainText("310");
    await expect(tile("ttftP50")).toContainText("912 requests");
    await expect(tile("ttftP95")).toContainText("1,200");
    await expect(tile("ttftP95").locator("[data-window]")).toHaveAttribute("data-window", "since process start");
    await expect(byId(page, "deploy.charts")).toBeVisible();
    await expect.poll(() => mock.find("GET", "/api/telemetry/timeseries").length).toBeGreaterThan(0);
    expect(mock.find("GET", "/api/telemetry/timeseries")[0].query).toMatchObject({ fleet_id: "vllm:primary" });
    expect(mock.find("GET", "/api/telemetry/timeseries")[0].query.metrics).toContain("rt.kv_usage");
  } finally {
    await context.close();
  }
});

test("Metrics without telemetry say the charts need it; missing keys are a dash, never 0", async ({ browser }) => {
  const sparse = { ...fixture("metrics"), metrics: { kvUsageRatio: 0 }, unsupported: [] };
  const { context, page } = await newPage(browser, { api: { "GET /api/m/vllm/instances/primary/metrics": sparse } });
  try {
    await page.goto(detailUrl("?tab=metrics"));
    await expect(byId(page, "deploy.metrics.tiles")).toHaveAttribute("data-ready", "true");
    await expect(byId(page, "deploy.charts.degraded")).toBeVisible();
    await expect(byId(page, "deploy.metric.kv")).toContainText("0.0%");
    await expect(byId(page, "deploy.metric.running")).toHaveAttribute("data-state", "missing");
    await expect(byId(page, "deploy.metric.running").locator("[data-testid='stat-tile.value']")).toHaveText("—");
    await expect(byId(page, "deploy.metric.running")).toContainText("No data yet");
  } finally {
    await context.close();
  }
});

test("Logs poll with since and append without repeating lines", async ({ browser }) => {
  test.setTimeout(60_000);
  const replies = [
    "line 1\nline 2\nline 3",
    // The boundary replays the end of the buffer once, as docker's inclusive --since can.
    "line 2\nline 3\nline 4",
    "line 5",
  ];
  const requests = [];
  const logs = (request) => {
    const query = Object.fromEntries(new URL(request.url()).searchParams);
    requests.push(query);
    const text = replies[Math.min(requests.length - 1, replies.length - 1)];
    return { ok: true, instanceId: "primary", containerName: "vllm-local", text: requests.length > replies.length ? "" : text, truncated: false, redacted: true };
  };
  const { context, page } = await newPage(browser, { api: { "GET /api/m/vllm/instances/primary/logs": logs } });
  try {
    await page.goto(detailUrl("?tab=logs"));
    const lines = page.locator("[data-testid='log-viewer.line']");
    await expect(lines).toHaveText(["line 1", "line 2", "line 3"]);
    await expect(lines).toHaveText(["line 1", "line 2", "line 3", "line 4", "line 5"], { timeout: 15_000 });
    expect(requests[0]).toEqual({ tail: "500" });
    expect(requests[1].since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(requests[1].tail).toBe("5000");
    expect(Date.parse(requests[1].since)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(requests[2].since)).toBeGreaterThanOrEqual(Date.parse(requests[1].since));
    await page.waitForTimeout(2500);
    await expect(lines).toHaveCount(5);
  } finally {
    await context.close();
  }
});

test("Config shows the stored launch as a read-only form and the redacted command; Clone opens the wizard", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await page.goto(detailUrl("?tab=config"));
    await expect(byId(page, "deploy.tab.config")).toBeVisible();
    await expect(byId(page, "deploy.config.values").locator('[data-field="contextLength"] input').first()).toHaveValue("262144");
    await expect(byId(page, "deploy.config.values").locator('input:not([disabled]):not([type="search"]), select:not([disabled])')).toHaveCount(0);
    await expect(byId(page, "deploy.config.command")).toContainText("API_KEY=<redacted>");
    const clone = byId(page, "deploy.config.clone");
    await expect(clone).toHaveAttribute("href", "/deployments/new?clone=lch_aaaaaaaaaaaaaaaaaaaa&manager=vllm");
    await expect(byId(page, "deploy.config.profile")).toHaveAttribute("href", /step=review&intent=profile$/);
    expect(mock.find("GET", "/api/m/vllm/engines/sglang/schema")[0].query).toMatchObject({ runtime: "sglang@0.5.17" });
  } finally {
    await context.close();
  }
});

test("Requests and Events tabs filter by this fleetId; before telemetry Events fall back to the event ring", async ({ browser }) => {
  const withTelemetry = await newPage(browser, { withTelemetry: true });
  try {
    await withTelemetry.page.goto(detailUrl("?tab=requests"));
    await expect(byId(withTelemetry.page, "deploy.requests.table")).toContainText("req_AAAAAAAAAAAAAAAAAAAA");
    await expect(byId(withTelemetry.page, "deploy.requests.table")).toContainText("client_abort");
    expect(withTelemetry.mock.find("GET", "/api/telemetry/requests")[0].query).toMatchObject({ fleet_id: "vllm:primary" });
    await withTelemetry.page.getByRole("tab", { name: "Events" }).click();
    await expect(byId(withTelemetry.page, "deploy.event")).toHaveCount(2);
    await expect(byId(withTelemetry.page, "deploy.tab.events")).toContainText("Launch ready in 545 s");
    expect(withTelemetry.mock.find("GET", "/api/telemetry/events")[0].query).toMatchObject({ fleet_id: "vllm:primary" });
  } finally {
    await withTelemetry.context.close();
  }
  const ring = { events: [
    { id: 5, type: "notification", at: new Date().toISOString(), data: { managerId: "vllm", severity: "info", title: { zh: "模型已就绪", en: "Model ready" } } },
    { id: 6, type: "notification", at: new Date().toISOString(), data: { managerId: "llama", severity: "info", title: { zh: "别的管理器", en: "Other manager" } } },
  ], lastId: 6, gap: false };
  const degraded = await newPage(browser, { api: { "GET /api/events/recent": ring } });
  try {
    await degraded.page.goto(detailUrl("?tab=events"));
    await expect(byId(degraded.page, "deploy.events.degraded")).toBeVisible();
    await expect(byId(degraded.page, "deploy.event")).toHaveCount(1);
    await expect(byId(degraded.page, "deploy.tab.events")).toContainText("Model ready");
    await expect(degraded.page.getByRole("tab", { name: "Requests" })).toBeDisabled();
  } finally {
    await degraded.context.close();
  }
});

test("Relaunch goes through Review and sends no relaunch request", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await page.goto(detailUrl());
    await expect(byId(page, "deploy.detail.root")).toHaveAttribute("data-ready", "true");
    await page.getByRole("link", { name: "Relaunch" }).click();
    await expect(page).toHaveURL(/\/deployments\/new\?clone=lch_aaaaaaaaaaaaaaaaaaaa&manager=vllm&step=review&from=relaunch&instance=primary$/);
    expect(mock.calls.filter((call) => call.method === "POST")).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the header Stop asks first, and Wake on a sleeping record sends the slp_ id", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: {
      "POST /api/m/vllm/instances/primary/stop": { ok: true },
      [`POST /api/m/vllm/idle-unload/${SLEEP_ID}/wake`]: { ok: true },
    },
  });
  try {
    await page.goto(detailUrl());
    await expect(byId(page, "deploy.detail.root")).toHaveAttribute("data-ready", "true");
    await byId(page, "deploy.action.stop").click();
    await expect(page.getByRole("alertdialog")).toContainText("Stop vllm:primary?");
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    expect(mock.find("POST", "/api/m/vllm/instances")).toEqual([]);
    await page.goto(`${entry.url}deployments/${encodeURIComponent(`vllm:${SLEEP_ID}`)}`);
    await expect(byId(page, "deploy.detail.root")).toHaveAttribute("data-state", "sleeping");
    await expect(page.getByRole("tab", { name: "Logs" })).toBeDisabled();
    await expect(byId(page, "deploy.action.stop")).toHaveCount(0);
    await byId(page, "deploy.action.wake").click();
    await expect.poll(() => mock.find("POST", `/api/m/vllm/idle-unload/${SLEEP_ID}/wake`).length).toBe(1);
    expect(bodiesOf(mock.find("POST", "/api/m/vllm/idle-unload"))).toEqual([{}]);
  } finally {
    await context.close();
  }
});

test("an unknown deployment says so and links back to the list; a viewer has no Logs or Config", async ({ browser }) => {
  const gone = await newPage(browser);
  try {
    await gone.page.goto(`${entry.url}deployments/${encodeURIComponent("vllm:nope")}`);
    await expect(byId(gone.page, "deploy.detail.notfound")).toContainText("Deployment not found");
    await expect(byId(gone.page, "deploy.detail.notfound").getByRole("link", { name: "Back to deployments" })).toHaveAttribute("href", "/deployments");
  } finally {
    await gone.context.close();
  }
  const viewer = await newPage(browser, { role: VIEWER });
  try {
    await viewer.page.goto(detailUrl());
    await expect(byId(viewer.page, "deploy.detail.root")).toHaveAttribute("data-ready", "true");
    await expect(viewer.page.getByRole("tab", { name: "Logs" })).toBeDisabled();
    await expect(viewer.page.getByRole("tab", { name: "Config" })).toBeDisabled();
    await expect(byId(viewer.page, "deploy.action.stop")).toHaveCount(0);
    await expect(viewer.page.getByRole("link", { name: "Relaunch" })).toHaveCount(0);
    expect(viewer.mock.find("GET", "/api/m/vllm/instances/primary/launch")).toEqual([]);
  } finally {
    await viewer.context.close();
  }
});

// ---------------------------------------------------------------------------
// Routing

function routingMock() {
  let settings = { mode: "balanced", reserveMb: 8192, maxUtilizationPct: 85, preferEngine: "auto" };
  const state = { reads: 0, delayNext: false, gate: null, started: null, settingsRequests: [], previewRequests: [] };
  const snapshot = () => ({ ...fixture("fleet"), settings: { ...settings }, routing: { mode: settings.mode, capabilityCounts: { text: 1, tools: 1 } } });
  const api = {
    "GET /api/fleet": async () => {
      state.reads += 1;
      const seen = snapshot();
      if (state.delayNext) {
        state.delayNext = false;
        state.started?.();
        await state.gate;
      }
      return seen;
    },
    "POST /api/fleet/settings": (request) => {
      const body = request.postDataJSON();
      state.settingsRequests.push(body);
      settings = { ...settings, ...body };
      return { ok: true, settings, fleet: snapshot() };
    },
    "POST /api/fleet/route-preview": (request) => {
      const body = request.postDataJSON();
      state.previewRequests.push(body);
      if (!["text", "tools"].includes(body.capability)) {
        return { ok: false, status: 503, error: "capability_not_available", message: `No running model provides the required ${body.capability} capability.`, capability: body.capability, reason: `No running model provides the required ${body.capability} capability.` };
      }
      return {
        ok: true, status: 200, capability: body.capability, reason: `generic_${body.capability}`, policy: { mode: settings.mode },
        manager: { id: "vllm", name: "vLLM Manager" }, instance: { id: "primary", instanceId: "primary", primary: true, status: "ready" },
        model: { id: "qwen3-demo-32b", capabilities: ["text", "tools"] },
      };
    },
  };
  return { api, state };
}

test("Routing: the mode buttons keep aria-pressed through a stale in-flight read and send exactly {mode}", async ({ browser }) => {
  test.setTimeout(60_000);
  const { api, state } = routingMock();
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}deployments/routing`);
    await expect(byId(page, "deploy.routing.root")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("#main h1")).toHaveText("Routing");
    const modes = byId(page, "deploy.mode.group").locator("button");
    await expect(modes).toHaveCount(3);
    await expect(byId(page, "deploy.mode.balanced")).toHaveAttribute("aria-pressed", "true");
    await expect(byId(page, "deploy.mode.multimodal")).toHaveAttribute("aria-pressed", "false");
    await expect(byId(page, "deploy.routing.counts")).toContainText("1 routable · 1 not routable · 2 instances");
    // A fleet read starts, then a mode is saved while it is still in flight.
    let release;
    state.gate = new Promise((resolveGate) => { release = resolveGate; });
    const started = new Promise((resolveStarted) => { state.started = resolveStarted; });
    state.delayNext = true;
    await byId(page, "deploy.routing.refresh").click();
    await started;
    await byId(page, "deploy.mode.multimodal").click();
    await expect(byId(page, "deploy.mode.multimodal")).toHaveAttribute("aria-pressed", "true");
    release();
    await expect.poll(() => state.reads).toBeGreaterThanOrEqual(3);
    await expect(byId(page, "deploy.mode.multimodal")).toHaveAttribute("aria-pressed", "true");
    await expect(byId(page, "deploy.mode.balanced")).toHaveAttribute("aria-pressed", "false");
    expect(state.settingsRequests).toEqual([{ mode: "multimodal" }]);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Routing: the VRAM policy sends {maxUtilizationPct, reserveMb} and the headroom follows", async ({ browser }) => {
  const { api, state } = routingMock();
  const { context, page } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}deployments/routing`);
    await expect(byId(page, "deploy.routing.root")).toHaveAttribute("data-ready", "true");
    await expect(byId(page, "deploy.policy.pct")).toHaveValue("85");
    await expect(byId(page, "deploy.policy.reserve")).toHaveValue("8");
    await expect(byId(page, "deploy.routing.allocatable")).toContainText("16.7 GiB");
    await expect(byId(page, "deploy.routing.headroom")).toContainText("10.3 GiB");
    await byId(page, "deploy.policy.pct").fill("90.5");
    await byId(page, "deploy.policy.reserve").fill("6.5");
    await byId(page, "deploy.policy.save").click();
    await expect.poll(() => state.settingsRequests.length).toBe(1);
    expect(state.settingsRequests).toEqual([{ maxUtilizationPct: 90.5, reserveMb: 6656 }]);
    await expect(byId(page, "toast.root").first()).toContainText("VRAM policy saved: protect line 90.5%, reserve 6.5 GiB");
    await expect(byId(page, "deploy.routing.headroom")).toContainText("15.6 GiB");
    await byId(page, "deploy.policy.pct").fill("120");
    await byId(page, "deploy.policy.save").click();
    await expect(byId(page, "deploy.policy.problem")).toBeVisible();
    expect(state.settingsRequests).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("Routing: the route preview sends capability, engine, protocol and the model name, never content", async ({ browser }) => {
  const { api, state } = routingMock();
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}deployments/routing`);
    await expect(byId(page, "deploy.routing.root")).toHaveAttribute("data-ready", "true");
    await byId(page, "deploy.preview.capability").selectOption("vision");
    await byId(page, "deploy.preview.model").fill("qwen3-demo-32b");
    await byId(page, "deploy.preview.submit").click();
    await expect(byId(page, "deploy.preview.result")).toContainText("capability_not_available");
    await byId(page, "deploy.preview.capability").selectOption("text");
    await byId(page, "deploy.preview.model").fill("");
    await byId(page, "deploy.preview.submit").click();
    await expect(byId(page, "deploy.preview.result")).toContainText("Routes to qwen3-demo-32b");
    await expect(byId(page, "deploy.preview.result")).toContainText("vLLM Manager");
    expect(state.previewRequests).toEqual([
      { capability: "vision", engine: "auto", protocol: "openai", model: "qwen3-demo-32b" },
      { capability: "text", engine: "auto", protocol: "openai" },
    ]);
    expect(JSON.stringify(state.previewRequests)).not.toMatch(/messages|prompt|content|image|audio_data/i);
    expect(mock.csrfViolations).toEqual([]);
    await expect(byId(page, "deploy.routing.gateway-url")).toHaveCount(4);
    await expect(byId(page, "deploy.routing.gateway")).toContainText("/gateway/llama/openai/v1");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Language, accessibility and layout

test("a Chinese page shows Chinese copy and an English page has no Han text outside user content", async ({ browser }) => {
  const zh = await newPage(browser, { locale: "zh-CN", withTelemetry: true });
  try {
    await zh.page.goto(`${entry.url}deployments`);
    await listReady(zh.page);
    await expect(zh.page.locator("#main h1")).toHaveText("部署");
    await expect(row(zh.page, "vllm:primary")).toContainText("就绪");
    await expect(byId(zh.page, "deploy.sleeping")).toContainText("已休眠");
    await zh.page.goto(`${entry.url}deployments/routing`);
    await expect(byId(zh.page, "deploy.routing.root")).toHaveAttribute("data-ready", "true");
    await expect(byId(zh.page, "deploy.mode.multimodal")).toHaveText("多模态优先");
  } finally {
    await zh.context.close();
  }
  const en = await newPage(browser, { withTelemetry: true });
  try {
    for (const url of [`${entry.url}deployments`, detailUrl(), detailUrl("?tab=metrics"), `${entry.url}deployments/routing`]) {
      await en.page.goto(url);
      await expect(en.page.locator("#main h1")).toBeVisible();
      await en.page.waitForTimeout(400);
      const text = await en.page.locator("#main").evaluate((node) => {
        const clone = node.cloneNode(true);
        clone.querySelectorAll("[data-user-content]").forEach((item) => item.remove());
        return clone.textContent;
      });
      expect(HAN.test(text), `${url} has Han text`).toBe(false);
    }
  } finally {
    await en.context.close();
  }
});

for (const theme of ["light", "dark"]) {
  for (const size of ["desktop", "phone"]) {
    test(`deployments pages have no axe findings and no overflow, ${theme} at ${SIZES[size].width}`, async ({ browser }) => {
      test.setTimeout(150_000);
      const pages = [
        ["list", `${entry.url}deployments`, (page) => listReady(page)],
        ["detail overview", detailUrl(), (page) => expect(byId(page, "deploy.stepper")).toBeVisible()],
        ["detail metrics", detailUrl("?tab=metrics"), (page) => expect(byId(page, "deploy.metrics.tiles")).toHaveAttribute("data-ready", "true")],
        ["detail config", detailUrl("?tab=config"), (page) => expect(byId(page, "deploy.config.command")).toBeVisible()],
        ["routing", `${entry.url}deployments/routing`, (page) => expect(byId(page, "deploy.routing.root")).toHaveAttribute("data-ready", "true")],
      ];
      const { context, page, failures } = await newPage(browser, { size: SIZES[size], theme, withTelemetry: true });
      try {
        for (const [name, url, wait] of pages) {
          await page.goto(url);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await wait(page);
          await expectNoA11yViolations(page, { label: `${name} ${theme} ${size}` });
          await expectNoOverflow(page);
        }
        expect(realFailures(failures)).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}

test("on a phone the list becomes cards with the state first", async ({ browser }) => {
  const { context, page } = await newPage(browser, { size: SIZES.phone });
  try {
    await page.goto(`${entry.url}deployments`);
    await listReady(page);
    await expect(byId(page, "deploy.table")).toHaveAttribute("data-mode", "cards");
    const first = byId(page, "data-table.card").first();
    await expect(first).toBeVisible();
    const labels = await first.locator("dt").allTextContents();
    expect(labels[0]).toBe("State");
    await expect(first.locator("dd").first()).toContainText(/Ready|Crashed/);
  } finally {
    await context.close();
  }
});
