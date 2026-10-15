// CON-8 browser checks (07 §6.1, §13.2 console-overview): every tile carries
// its window; the readiness banner runs the layer's own action and shows the
// restore-models dry-run plan first; attention items link to where they are
// fixed; the degrade path (before 04) says what it measures; axe is clean at
// 1440 and 390 in both themes. The real service-entry serves the console and
// the API is mocked in the browser (helpers/console-harness.js).
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
const DEGRADED = { features: { platform: true } };
const FULL = { features: { platform: true, telemetry: true, alerts: true, hub: true, access: true } };
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

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
const fixture = (name, dir = "") => resolve(JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, `${name}.json`), "utf8")));
const overview = (name) => fixture(name, "overview");

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

// platform-status.json is the "no model serving" state; this one has every layer ok.
function platformOk() {
  const status = fixture("platform-status");
  status.readiness = { overall: "ok", layers: status.readiness.layers.map((layer) => ({ id: layer.id, status: "ok", ...(layer.mode ? { mode: layer.mode } : {}), ...(layer.counts ? { counts: layer.counts } : {}) })) };
  status.models = { serving: 1, instances: [] };
  return status;
}

const READY_FLEET = () => overview("fleet-serving");

// The mocks of the telemetry-backed page.
function telemetryApi(extra = {}) {
  return {
    "GET /api/fleet": READY_FLEET(),
    "GET /api/telemetry/live": overview("telemetry-live"),
    "GET /api/telemetry/summary": (request) => {
      const { from, to } = Object.fromEntries(new URL(request.url()).searchParams);
      return Date.parse(to) - Date.parse(from) <= 2 * UNITS.h ? overview("telemetry-summary-1h") : overview("telemetry-summary-24h");
    },
    "GET /api/telemetry/alerts": overview("alerts-firing"),
    "GET /api/telemetry/events": overview("telemetry-events"),
    "GET /api/hub/downloads": overview("downloads-failed"),
    "GET /api/access/keys": overview("keys-expiring"),
    "GET /api/platform/doctor": overview("doctor"),
    ...extra,
  };
}

// The pre-04 page: gateway log, event ring, no telemetry endpoints at all.
function degradedApi(extra = {}) {
  return {
    "GET /api/fleet": READY_FLEET(),
    "GET /api/gateway-access": overview("gateway-access"),
    "GET /api/events/recent": overview("events-recent"),
    "GET /api/platform/doctor": overview("doctor"),
    ...extra,
  };
}

async function newPage(browser, { bootstrap = {}, role = OWNER, api = {}, size = SIZES.desktop, theme = "light", locale = "en-US", permissions } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce", ...(permissions ? { permissions } : {}) });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, { ...role, ...DEGRADED, ...bootstrap });
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, {
    "GET /api/status": fixture("status"),
    "GET /api/platform/status": platformOk(),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/m/vllm/jobs": overview("jobs-vllm"),
    "GET /api/m/llama/jobs": { jobs: [] },
    "GET /api/m/vllm/recent-launches": overview("recent-launches"),
    "GET /api/m/llama/recent-launches": { launches: [] },
    ...api,
  });
  return { context, page, mock, failures };
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const tile = (page, id) => byId(page, `overview.tile.${id}`);
const ready = (page) => expect(byId(page, "overview.root")).toHaveAttribute("data-ready", "true");
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));

// ---------------------------------------------------------------------------
// Tiles and windows

test("with telemetry every tile has a window and its figure; the endpoints get their parameters", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, { bootstrap: FULL, api: telemetryApi() });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    await expect(page.locator("#main h1")).toHaveText("Overview");
    const tiles = byId(page, "overview.tiles").locator(".stat-tile");
    await expect(tiles).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) await expect(tiles.nth(index).locator("[data-window]")).toHaveCount(1);
    await expect(tile(page, "requests").locator("[data-window]")).toHaveAttribute("data-window", "last 24 h");
    await expect(tile(page, "requests")).toContainText("1,240");
    await expect(tile(page, "requests")).toContainText("errors 37 (3.0%)");
    await expect(tile(page, "output").locator("[data-window]")).toHaveAttribute("data-window", "last 24 h");
    await expect(tile(page, "output")).toContainText("440,000");
    await expect(tile(page, "output")).toContainText("now 85.2 tok/s");
    await expect(tile(page, "ttft").locator("[data-window]")).toHaveAttribute("data-window", "last 1 h");
    await expect(tile(page, "ttft")).toContainText("640");
    await expect(tile(page, "ttft")).toContainText("57 requests");
    await expect(tile(page, "gpu").locator("[data-window]")).toHaveAttribute("data-window", "now");
    await expect(tile(page, "gpu")).toContainText(/88\s*\/\s*95\.6\s*GiB/);
    await expect(tile(page, "gpu")).toContainText("87% utilization");

    const summaries = mock.find("GET", "/api/telemetry/summary");
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    for (const call of summaries) expect(call.query.compare).toBe("previous");
    const spans = summaries.map((call) => Math.round((Date.parse(call.query.to) - Date.parse(call.query.from)) / UNITS.h)).sort((a, b) => a - b);
    expect(spans[0]).toBe(1);
    expect(spans.at(-1)).toBe(24);
    expect(mock.find("GET", "/api/telemetry/alerts")[0].query).toMatchObject({ state: "firing" });
    expect(mock.find("GET", "/api/telemetry/events")[0].query).toMatchObject({ limit: "20" });
    expect(mock.find("GET", "/api/gateway-access")).toEqual([]);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("degrade path: tiles 1 and 2 name the gateway log lines, tile 3 needs telemetry, activity says since the entry started", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: degradedApi() });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    const tiles = byId(page, "overview.tiles").locator(".stat-tile");
    await expect(tiles).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) await expect(tiles.nth(index).locator("[data-window]")).toHaveCount(1);
    await expect(tile(page, "requests").locator("[data-window]")).toHaveAttribute("data-window", "last 2,000 gateway log lines");
    await expect(tile(page, "requests")).toContainText("1,240");
    await expect(tile(page, "requests")).toContainText("errors 40 (3.2%)");
    await expect(tile(page, "output").locator("[data-window]")).toHaveAttribute("data-window", "last 2,000 gateway log lines");
    await expect(tile(page, "output")).toContainText("440,000");
    await expect(tile(page, "ttft").locator("[data-testid='stat-tile.value']")).toHaveText("—");
    await expect(tile(page, "ttft")).toContainText("Needs the telemetry backend");
    await expect(tile(page, "gpu").locator("[data-window]")).toHaveAttribute("data-window", "now");
    await expect(byId(page, "overview.activity.window")).toHaveText("since the entry started");

    const access = mock.find("GET", "/api/gateway-access");
    expect(access[0].query.maxLines).toBe("2000");
    const recent = mock.find("GET", "/api/events/recent").find((call) => call.query.types);
    expect(recent.query).toMatchObject({ types: "jobs,instances,notification", limit: "20" });
    expect(mock.calls.filter((call) => call.path.startsWith("/api/telemetry/"))).toEqual([]);
    const lines = byId(page, "overview.activity").locator("[data-testid='overview.activity.item']");
    await expect(lines).toHaveCount(4);
    await expect(lines.first()).toContainText("Last session's models are not running");
    await expect(lines.nth(3)).toContainText("manager came online");
  } finally {
    await context.close();
  }
});

test("a Chinese page shows the Chinese windows and copy, and an English page has no Han text", async ({ browser }) => {
  const zh = await newPage(browser, { locale: "zh-CN", api: degradedApi() });
  try {
    await zh.page.goto(`${entry.url}overview`);
    await ready(zh.page);
    await expect(tile(zh.page, "requests").locator("[data-window]")).toHaveAttribute("data-window", "最近 2,000 行网关日志");
    await expect(tile(zh.page, "ttft")).toContainText("需要遥测后端");
    await expect(byId(zh.page, "overview.activity.window")).toHaveText("自本次服务启动");
    await expect(zh.page.locator("#main h1")).toHaveText("总览");
    expect(await zh.page.locator("#main").innerText()).not.toMatch(/\boverview\.[a-z]/i);
  } finally {
    await zh.context.close();
  }
  const en = await newPage(browser, { bootstrap: FULL, api: telemetryApi() });
  try {
    await en.page.goto(`${entry.url}overview`);
    await ready(en.page);
    await expect(byId(en.page, "overview.attention.item").first()).toBeVisible();
    const text = await en.page.evaluate(() => {
      const clone = document.querySelector("#main").cloneNode(true);
      clone.querySelectorAll("[data-user-content]").forEach((node) => node.remove());
      return clone.innerText;
    });
    expect(text).not.toMatch(HAN);
    expect(text).not.toMatch(/\b(?:overview|platform|common|shell)\.[a-z][A-Za-z.]+/);
  } finally {
    await en.context.close();
  }
});

// ---------------------------------------------------------------------------
// Readiness banner

test("the banner shows the first non-ok layer with its own action; restore-models shows the dry-run plan first", async ({ browser }) => {
  const plan = overview("restore-plan");
  const { context, page, mock } = await newPage(browser, {
    api: {
      ...degradedApi(),
      "GET /api/fleet": fixture("fleet"),
      "GET /api/platform/status": fixture("platform-status"),
      "POST /api/platform/restore-models": (request) => (request.postDataJSON()?.dryRun ? plan : { status: 202, body: { ok: true, opId: "op_1" } }),
    },
  });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    const banner = byId(page, "overview.banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-layer", "serving");
    await expect(banner).toContainText("Model serving");
    await expect(byId(page, "overview.banner.detail")).toHaveText("The platform is up, but no model is serving yet.");
    const action = byId(page, "overview.banner.action.restore-models");
    await expect(action).toHaveText("Start last used model");
    const sent = () => mock.find("POST", "/api/platform/restore-models");
    expect(sent()).toEqual([]);

    await action.click();
    const dialog = page.getByRole("dialog", { name: "Start last used model" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("vllm · qwen3-demo-32b · will start");
    await expect(dialog).toContainText("llama · demo-8b-q4 · already running, skipped");
    expect(sent().map((call) => call.body)).toEqual([{ dryRun: true }]);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(sent()).toHaveLength(1);

    await action.click();
    await page.getByRole("dialog", { name: "Start last used model" }).getByTestId("dialog.confirm").click();
    await expect.poll(() => sent().length).toBe(3);
    expect(sent()[2].body).toEqual({});
    expect(sent()[2].headers["x-csrf-token"]).toBe("t");
  } finally {
    await context.close();
  }
});

test("the banner is absent when readiness is ok; a viewer sees the banner without the action", async ({ browser }) => {
  const ok = await newPage(browser, { api: degradedApi() });
  try {
    await ok.page.goto(`${entry.url}overview`);
    await ready(ok.page);
    await expect(byId(ok.page, "overview.banner")).toHaveCount(0);
  } finally {
    await ok.context.close();
  }
  const viewer = await newPage(browser, {
    role: VIEWER,
    api: { ...degradedApi(), "GET /api/session": { ok: true, role: "viewer", via: "none", paired: false, csrfToken: null, autoPairAvailable: false }, "GET /api/platform/status": fixture("platform-status") },
  });
  try {
    await viewer.page.goto(`${entry.url}overview`);
    await ready(viewer.page);
    await expect(byId(viewer.page, "overview.banner")).toBeVisible();
    await expect(byId(viewer.page, "overview.banner").getByRole("button")).toHaveCount(0);
  } finally {
    await viewer.context.close();
  }
});

// ---------------------------------------------------------------------------
// Needs attention

test("needs attention lists alerts, failed jobs and downloads, failing checks and expiring keys, each with an action link", async ({ browser }) => {
  const { context, page } = await newPage(browser, { bootstrap: FULL, api: telemetryApi() });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    const items = byId(page, "overview.attention").locator("[data-testid='overview.attention.item']");
    await expect(items).toHaveCount(5);
    const expected = [
      ["alert", "GPU temperature is high", "/alerts"],
      ["job", "Job failed: Launch demo-70b", "/deployments?manager=vllm"],
      ["download", "Download failed: demo/model-8b", "/models/downloads"],
      ["doctor", "Check failing: Docker engine", "/system/doctor"],
      ["key", "Key demo-client is about to expire", "/access/keys/key_a1"],
    ];
    for (const [index, [kind, text, href]] of expected.entries()) {
      const item = items.nth(index);
      await expect(item).toHaveAttribute("data-kind", kind);
      await expect(item).toContainText(text);
      await expect(item.getByRole("link")).toHaveAttribute("href", href);
    }
    await expect(items.filter({ hasText: "Launch old" })).toHaveCount(0);
    await expect(items.nth(1)).toContainText("Out of GPU memory");

    await items.nth(0).getByRole("link").click();
    await expect(page).toHaveURL(`${entry.url}alerts`);
  } finally {
    await context.close();
  }
});

test("without anything to fix the attention card says so, and a viewer never asks for keys or the doctor", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    role: VIEWER,
    bootstrap: FULL,
    api: telemetryApi({
      "GET /api/session": { ok: true, role: "viewer", via: "none", paired: false, csrfToken: null, autoPairAvailable: false },
      "GET /api/telemetry/alerts": { rows: [] },
      "GET /api/hub/downloads": { ok: true, jobs: [] },
      "GET /api/m/vllm/jobs": { jobs: [] },
    }),
  });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    await expect(byId(page, "overview.attention.empty")).toHaveText("Nothing needs attention.");
    expect(mock.find("GET", "/api/access/keys")).toEqual([]);
    expect(mock.find("GET", "/api/platform/doctor")).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Running deployments and quick actions

test("running deployments list state, model, engine@version, port, context and tok/s; Stop asks first", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    bootstrap: FULL,
    api: telemetryApi({ "POST /api/m/vllm/instances/primary/stop": { ok: true } }),
  });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    const rows = byId(page, "overview.deployments").locator("tr[data-render-key]");
    await expect(rows).toHaveCount(2);
    const first = rows.nth(0);
    await expect(first).toHaveAttribute("data-render-key", "vllm:primary");
    await expect(first).toContainText("Ready");
    await expect(first).toContainText("qwen3-demo-32b");
    await expect(first).toContainText("sglang@0.5.17");
    await expect(first).toContainText("8000");
    await expect(first).toContainText("262,144 (256K)");
    await expect(first).toContainText("92.4");
    await expect(rows.nth(1)).toContainText("Loading 42%");
    await expect(rows.nth(1)).toContainText("—");
    await expect(first.getByRole("link", { name: "Playground: qwen3-demo-32b" })).toHaveAttribute("href", "/playground?model=qwen3-demo-32b");

    const stop = first.getByRole("button", { name: "Stop vllm:primary" });
    await stop.click();
    const dialog = page.getByRole("alertdialog", { name: "Stop vllm:primary?" });
    await expect(dialog).toContainText("In-flight requests are cut and clients get 503.");
    expect(mock.find("POST", "/api/m/vllm/instances")).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(mock.find("POST", "/api/m/vllm/instances")).toEqual([]);
    await expect(stop).toBeFocused();

    await stop.click();
    await page.getByRole("alertdialog", { name: "Stop vllm:primary?" }).getByTestId("dialog.confirm").click();
    await expect.poll(() => mock.find("POST", "/api/m/vllm/instances/primary/stop").length).toBe(1);
    expect(mock.find("POST", "/api/m/vllm/instances/primary/stop")[0].headers["x-csrf-token"]).toBe("t");
  } finally {
    await context.close();
  }
});

test("with nothing running the table gives way to an empty state that names the next action", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: degradedApi({ "GET /api/fleet": fixture("fleet") }) });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    const empty = byId(page, "overview.deployments.empty");
    await expect(empty).toContainText("No deployment is running");
    await expect(empty.getByRole("link", { name: "New deployment" })).toHaveAttribute("href", "/deployments/new");
  } finally {
    await context.close();
  }
});

test("quick actions: new deployment, start last used per manager, download, copy the gateway URL; a viewer only copies", async ({ browser }) => {
  const owner = await newPage(browser, { api: degradedApi(), permissions: ["clipboard-read", "clipboard-write"] });
  try {
    await owner.page.goto(`${entry.url}overview`);
    await ready(owner.page);
    const quick = byId(owner.page, "overview.quick");
    await expect(quick.getByRole("link", { name: "New deployment" })).toHaveAttribute("href", "/deployments/new");
    await expect(quick.getByRole("link", { name: /^Start last used/ })).toHaveCount(1);
    await expect(byId(owner.page, "overview.quick.last.vllm")).toHaveAttribute("href", "/deployments/new?manager=vllm&step=review&from=recent");
    await expect(quick.getByRole("link", { name: "Download model" })).toHaveAttribute("href", "/models/discover");
    await quick.getByRole("button", { name: "Copy gateway URL" }).click();
    await expect(owner.page.getByText("Gateway URL copied")).toBeVisible();
    expect(await owner.page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/gateway\/auto\/openai\/v1$/);
  } finally {
    await owner.context.close();
  }
  const viewer = await newPage(browser, {
    role: VIEWER,
    api: { ...degradedApi(), "GET /api/session": { ok: true, role: "viewer", via: "none", paired: false, csrfToken: null, autoPairAvailable: false } },
  });
  try {
    await viewer.page.goto(`${entry.url}overview`);
    await ready(viewer.page);
    const quick = byId(viewer.page, "overview.quick");
    await expect(quick.getByRole("link")).toHaveCount(0);
    await expect(quick.getByRole("button", { name: "Copy gateway URL" })).toBeVisible();
    await expect(byId(viewer.page, "overview.deployments").getByRole("button", { name: /^Stop/ })).toHaveCount(0);
    expect(viewer.mock.find("GET", "/api/m/vllm/recent-launches")).toEqual([]);
  } finally {
    await viewer.context.close();
  }
});

// ---------------------------------------------------------------------------
// Accessibility and layout

for (const theme of ["light", "dark"]) {
  for (const size of ["desktop", "phone"]) {
    test(`overview has no axe findings, ${theme} at ${SIZES[size].width}`, async ({ browser }) => {
      test.setTimeout(120_000);
      const states = [
        ["telemetry", { bootstrap: FULL, api: telemetryApi({ "GET /api/platform/status": fixture("platform-status"), "GET /api/fleet": READY_FLEET() }) }],
        ["degrade", { api: degradedApi({ "GET /api/platform/status": fixture("platform-status") }) }],
      ];
      for (const [name, options] of states) {
        const { context, page, failures } = await newPage(browser, { ...options, size: SIZES[size], theme });
        try {
          await page.goto(`${entry.url}overview`);
          await ready(page);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(byId(page, "overview.banner")).toBeVisible();
          await expect(byId(page, "overview.deployments").locator("tr[data-render-key]").first()).toBeVisible();
          await expectNoA11yViolations(page, { label: `overview ${name} ${theme} ${size}` });
          await expectNoOverflow(page);
          expect(realFailures(failures)).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }
}

test("on a phone the four tiles sit in two columns", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: degradedApi(), size: SIZES.phone });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    const boxes = await byId(page, "overview.tiles").locator(".stat-tile").evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top) };
    }));
    expect(new Set(boxes.map((box) => box.top)).size).toBe(2);
    expect(new Set(boxes.map((box) => box.left)).size).toBe(2);
  } finally {
    await context.close();
  }
});
