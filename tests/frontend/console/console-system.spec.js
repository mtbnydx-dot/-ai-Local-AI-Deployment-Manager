// CON-24 browser checks (07 §6.13, 06 §11, §13.2 console-system part 1): the
// System components page, its supervisor banner, row actions, Logs drawer and
// Danger zone, the viewer's redacted table, the pre-platform degrade from
// GET /api/status, and the preferences page. The real service-entry serves the
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
const VIEWER_SESSION = { ok: true, role: "viewer", paired: false, csrfToken: null, pairCommand: "platform admin pair" };
const PLATFORM = { features: { platform: true } };
const NO_PLATFORM = { features: { platform: false } };

// Every 06 §5.2 state, one component each, labelled as the English catalog shows it.
const STATE_LABELS = {
  ready: "Ready", starting: "Starting", unhealthy: "Unhealthy", stopped: "Stopped", failed: "Failed", backoff: "Retrying",
  blocked: "Blocked", "not-installed": "Not installed", external: "External", unknown: "Unidentified", disabled: "Off",
};

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

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

const label = (en, zh) => ({ "en-US": en, "zh-CN": zh });

function component(id, state, extra = {}) {
  return {
    id, legacyId: id, kind: "node", profile: "core", label: label(`Comp ${id}`, `组件 ${id}`), desired: "running", state, owner: "supervisor",
    pid: 4000, ports: [{ name: "admin", port: 5000, bind: "127.0.0.1" }], uptimeSec: 7380, restarts: { count: 1, windowCount: 0 },
    lastExit: null, health: { live: true }, pendingRestart: null, message: null, ...extra,
  };
}

function platformStatus({ supervisorRunning = true, components } = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, "platform-status.json"), "utf8"));
  return {
    ...base,
    mode: supervisorRunning ? "supervised" : "probe",
    supervisor: supervisorRunning ? base.supervisor : { running: false },
    components: components || [
      component("entry", "ready", { label: label("Entry", "统一入口"), ports: [{ name: "admin", port: 5176, bind: "127.0.0.1" }] }),
      component("vllm-manager", "ready", { label: label("vLLM manager", "vLLM 管理器"), ports: [{ name: "admin", port: 5177, bind: "127.0.0.1" }], restarts: { count: 3, windowCount: 0 } }),
      component("llama-manager", "failed", {
        label: label("llama.cpp manager", "llama.cpp 管理器"), ports: [{ name: "admin", port: 5178, bind: "127.0.0.1" }], uptimeSec: null,
        lastExit: { at: new Date(Date.now() - 3_600_000).toISOString(), code: 1, reason: "max-restarts" },
      }),
      component("tts", "blocked", {
        label: label("TTS", "语音"), ports: [{ name: "admin", port: 5180, bind: "127.0.0.1" }], uptimeSec: null, reason: "port-conflict",
        blocked: { port: 5180, pid: 4242, imageName: "python.exe" },
      }),
      component("search", "stopped", { label: label("Search gateway", "搜索网关"), uptimeSec: null, pendingRestart: { id: "pr_1", reason: "deploy", queuedAt: new Date().toISOString() } }),
    ],
  };
}

// The viewer view (06 §10.1 redactStatusForViewer): no pid, ports, owner, exit or message.
function redacted(status) {
  return {
    ...status,
    supervisor: undefined,
    components: status.components.map(({ id, label: name, state, desired, profile, uptimeSec, restarts }) => ({ id, label: name, state, desired, profile, uptimeSec, restarts: { count: restarts.count } })),
  };
}

function baseApi(extra = {}) {
  return {
    "GET /api/status": JSON.parse(fs.readFileSync(path.join(FIXTURES, "status.json"), "utf8")),
    "GET /api/platform/status": platformStatus(),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/fleet": JSON.parse(fs.readFileSync(path.join(FIXTURES, "fleet.json"), "utf8")),
    ...extra,
  };
}

async function newPage(browser, { bootstrap = {}, role = OWNER, api = {}, size = SIZES.desktop, theme = "light", locale = "en-US" } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, { ...role, ...PLATFORM, ...bootstrap });
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, {
    ...(role === VIEWER ? { "GET /api/session": VIEWER_SESSION } : {}),
    ...baseApi(),
    ...api,
  });
  return { context, page, mock, failures };
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const confirmIn = (page, id) => byId(page, id).locator('[data-testid="dialog.confirm"]');
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const ready = (page) => expect(byId(page, "system.table")).toBeVisible();
const stateOf = (page, id) => byId(page, `system.state.${id}`);

// ---------------------------------------------------------------------------
// Component table

test("the table shows state, owner, port, uptime, restarts, last exit and the pending restart for each component", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await expect(page.locator("#main h1")).toHaveText("System");
    await expect(byId(page, "system.supervisor-banner")).toHaveCount(0);
    await expect(byId(page, "system.supervisor")).toContainText("core");

    await expect(stateOf(page, "entry")).toContainText("Ready");
    await expect(stateOf(page, "llama-manager")).toContainText("Failed");
    await expect(stateOf(page, "tts")).toContainText("Blocked");
    await expect(stateOf(page, "tts")).toContainText("Port 5180 is in use by python.exe (PID 4242).");
    await expect(stateOf(page, "search")).toContainText("Stopped");

    const vllm = byId(page, "system.table").locator("tr", { hasText: "vLLM manager" });
    await expect(vllm).toContainText("5177");
    await expect(vllm).toContainText("Supervisor");
    await expect(vllm).toContainText("2 hr");
    await expect(vllm).toContainText("3");
    const llama = byId(page, "system.table").locator("tr", { hasText: "llama.cpp manager" });
    await expect(llama).toContainText("code 1");
    await expect(llama).toContainText("1 hour ago");
    await expect(byId(page, "system.table").locator("tr", { hasText: "Search gateway" })).toContainText("Update deployed. Search gateway will restart when idle.");
    expect(mock.find("GET", "/api/platform/status").length).toBeGreaterThan(0);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
    await failures.expectNone();
  } finally {
    await context.close();
  }
});

test("every 06 state has its label; a state the console does not know reads as Unidentified, never as Ready", async ({ browser }) => {
  const components = [...Object.keys(STATE_LABELS).map((state) => component(`c-${state}`, state, { label: label(`Row ${state}`, `行 ${state}`) })), component("c-odd", "from-the-future", { label: label("Row odd", "行 odd") })];
  const { context, page } = await newPage(browser, { api: { "GET /api/platform/status": platformStatus({ components }) } });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    for (const [state, text] of Object.entries(STATE_LABELS)) await expect(stateOf(page, `c-${state}`).locator('[data-testid="system.state"]')).toHaveText(text);
    await expect(stateOf(page, "c-odd")).toContainText("Unidentified");
    await expect(page.locator("#main")).not.toHaveText(HAN);
  } finally {
    await context.close();
  }
});

test("the table follows the language: zh shows the Chinese labels and states", async ({ browser }) => {
  const { context, page } = await newPage(browser, { locale: "zh-CN" });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await expect(page.locator("#main h1")).toHaveText("系统");
    await expect(stateOf(page, "entry")).toContainText("就绪");
    await expect(stateOf(page, "llama-manager")).toContainText("失败");
    await expect(stateOf(page, "tts")).toContainText("端口 5180 被 python.exe（PID 4242）占用。");
    await expect(byId(page, "system.table")).toContainText("统一入口");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Supervisor banner

test("a missing supervisor shows the banner; Start supervisor asks first and posts to /api/platform/supervisor/start", async ({ browser }) => {
  let started = false;
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/platform/status": () => platformStatus({ supervisorRunning: started }),
      "POST /api/platform/supervisor/start": () => {
        started = true;
        return { status: 202, body: { ok: true } };
      },
    },
  });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await expect(byId(page, "system.supervisor-banner")).toContainText("The supervisor is not running, so crashed components will not be restarted.");
    await byId(page, "system.supervisor-start").click();
    await expect(byId(page, "system.supervisor-confirm")).toBeVisible();
    expect(mock.find("POST", "/api/platform/supervisor/start")).toHaveLength(0);
    await confirmIn(page, "system.supervisor-confirm").click();
    await expect(byId(page, "system.supervisor-banner")).toHaveCount(0);
    expect(mock.find("POST", "/api/platform/supervisor/start")).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("a supervisor_unavailable answer to a row action raises the banner", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: {
      "POST /api/platform/components/llama-manager/start": { status: 503, body: { ok: false, error: { code: "supervisor_unavailable", message: "no supervisor" }, action: { id: "start-supervisor" } } },
    },
  });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await expect(byId(page, "system.supervisor-banner")).toHaveCount(0);
    await byId(page, "system.actions.llama-manager").locator('[data-testid="system.action.start"]').click();
    await expect(byId(page, "system.supervisor-banner")).toBeVisible();
    expect(mock.find("POST", "/api/platform/components/llama-manager/start")[0].body).toEqual({});
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Row actions

test("each state offers its actions; Start posts an empty body", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { "POST /api/platform/components/search/start": { status: 202, body: { ok: true, opId: "op_1" } } } });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    const actions = (id) => byId(page, `system.actions.${id}`).locator('[data-testid^="system.action."]');
    await expect(actions("vllm-manager")).toHaveText(["Restart", "Restart when idle", "Stop", "Logs"]);
    await expect(actions("entry")).toHaveText(["Restart", "Restart when idle", "Logs"]);
    await expect(actions("llama-manager")).toHaveText(["Start", "Logs"]);
    await expect(actions("search")).toHaveText(["Start", "Logs"]);
    await byId(page, "system.actions.search").locator('[data-testid="system.action.start"]').click();
    await expect.poll(() => mock.find("POST", "/api/platform/components/search/start").length).toBe(1);
    expect(mock.find("POST", "/api/platform/components/search/start")[0].body).toEqual({});
  } finally {
    await context.close();
  }
});

test("Restart when idle sends {when:'idle'}", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { "POST /api/platform/components/vllm-manager/restart": { status: 202, body: { ok: true, opId: "op_2" } } } });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await byId(page, "system.actions.vllm-manager").locator('[data-testid="system.action.restartIdle"]').click();
    await expect.poll(() => mock.find("POST", "/api/platform/components/vllm-manager/restart").length).toBe(1);
    expect(mock.find("POST", "/api/platform/components/vllm-manager/restart")[0].body).toEqual({ when: "idle" });
  } finally {
    await context.close();
  }
});

test("a 409 component_busy lists its blockers and offers Restart when idle", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: {
      "POST /api/platform/components/vllm-manager/restart": (request) => {
        const body = JSON.parse(request.postData() || "{}");
        if (body.when === "idle") return { status: 202, body: { ok: true, opId: "op_3" } };
        return {
          status: 409,
          body: {
            ok: false, error: { code: "component_busy", message: "busy" },
            blockers: [{ kind: "download", source: "hub", id: "dl_1", title: "Qwen3 demo weights" }, { kind: "launch", source: "vllm", id: "job_1", title: "Launch primary" }],
          },
        };
      },
    },
  });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await byId(page, "system.actions.vllm-manager").locator('[data-testid="system.action.restart"]').click();
    const dialog = byId(page, "system.busy");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("2 downloads or launches are in progress. Restarting now would interrupt them.");
    await expect(dialog).toContainText("Qwen3 demo weights");
    await expect(dialog).toContainText("Launch primary");
    await confirmIn(page, "system.busy").click();
    await expect(dialog).toHaveCount(0);
    const calls = mock.find("POST", "/api/platform/components/vllm-manager/restart").map((call) => call.body);
    expect(calls).toEqual([{ when: "now" }, { when: "idle" }]);
  } finally {
    await context.close();
  }
});

test("Stop asks first and posts {confirm:true}", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { "POST /api/platform/components/vllm-manager/stop": { status: 202, body: { ok: true, opId: "op_4" } } } });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await byId(page, "system.actions.vllm-manager").locator('[data-testid="system.action.stop"]').click();
    await expect(byId(page, "system.stop-confirm")).toBeVisible();
    expect(mock.find("POST", "/api/platform/components/vllm-manager/stop")).toHaveLength(0);
    await confirmIn(page, "system.stop-confirm").click();
    await expect.poll(() => mock.find("POST", "/api/platform/components/vllm-manager/stop").length).toBe(1);
    expect(mock.find("POST", "/api/platform/components/vllm-manager/stop")[0].body).toEqual({ confirm: true });
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Logs

test("Logs open the component LogViewer, which polls the component's log and keeps ?drawer= for a reload", async ({ browser }) => {
  let polls = 0;
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/platform/components/vllm-manager/logs": () => {
        polls += 1;
        return { ok: true, lines: ["2026-10-14 08:00:00 listening on 5177", "2026-10-14 08:00:01 ready"] };
      },
    },
  });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await byId(page, "system.actions.vllm-manager").locator('[data-testid="system.action.logs"]').click();
    const drawer = byId(page, "system.logs");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Logs: vLLM manager");
    await expect(byId(page, "log-viewer.line").first()).toContainText("listening on 5177");
    await expect(byId(page, "log-viewer.line")).toHaveCount(2);
    expect(polls).toBeGreaterThan(0);
    expect(mock.find("GET", "/api/platform/components/vllm-manager/logs")[0].query).toMatchObject({ tail: expect.any(String) });
    expect(new URL(page.url()).searchParams.get("drawer")).toBe("logs:vllm-manager");
    await page.reload();
    await expect(byId(page, "system.logs")).toBeVisible();
    await expect(byId(page, "log-viewer.line").first()).toContainText("listening on 5177");
    await page.keyboard.press("Escape");
    await expect(byId(page, "system.logs")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("drawer")).toBeNull();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Danger zone

test("the Danger zone needs 'stop' typed, shows the accurate copy and posts /api/stop-all", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { "POST /api/stop-all": { ok: true } } });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await expect(byId(page, "system.danger")).toBeVisible();
    await byId(page, "system.stop-all").click();
    const dialog = byId(page, "system.stop-all-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("This stops the entry and both managers. Model containers keep running and keep their VRAM, but they cannot be reached through the gateway until the entry starts again. Type stop to confirm.");
    const confirm = confirmIn(page, "system.stop-all-confirm");
    await expect(confirm).toBeDisabled();
    await byId(page, "dialog.input").fill("Stop");
    await expect(confirm).toBeDisabled();
    await byId(page, "dialog.input").fill("stop");
    await expect(confirm).toBeEnabled();
    expect(mock.find("POST", "/api/stop-all")).toHaveLength(0);
    await confirm.click();
    await expect.poll(() => mock.find("POST", "/api/stop-all").length).toBe(1);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("cancelling the Danger zone dialog stops nothing", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await byId(page, "system.stop-all").click();
    await byId(page, "dialog.input").fill("stop");
    await byId(page, "system.stop-all-confirm").locator('[data-testid="dialog.cancel"]').click();
    await expect(byId(page, "system.stop-all-confirm")).toHaveCount(0);
    expect(mock.find("POST", "/api/stop-all")).toHaveLength(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Viewer

test("a viewer sees the redacted table with no actions, no Danger zone and no supervisor button", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    role: VIEWER,
    api: { "GET /api/platform/status": redacted(platformStatus({ supervisorRunning: false })) },
  });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await expect(byId(page, "system.viewer-note")).toBeVisible();
    await expect(stateOf(page, "vllm-manager")).toContainText("Ready");
    await expect(byId(page, "system.table")).toContainText("vLLM manager");
    await expect(byId(page, "system.table")).not.toContainText("5177");
    await expect(byId(page, "system.table")).not.toContainText("Supervisor");
    await expect(page.locator('[data-testid^="system.action"]')).toHaveCount(0);
    await expect(byId(page, "system.danger")).toHaveCount(0);
    await expect(byId(page, "system.supervisor-start")).toHaveCount(0);
    await expect(byId(page, "system.nav.doctor")).toHaveCount(0);
    await expect(byId(page, "system.nav.preferences")).toBeVisible();
    expect(mock.calls.filter((call) => call.method !== "GET")).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Pre-P6 degrade

test("without the platform backend the rows come from /api/status and offer the manager start and stop", async ({ browser }) => {
  const status = {
    ok: false,
    components: {
      total: 3, online: 1, offline: ["llama", "tts"],
      items: [
        { id: "vllm", name: "vLLM 管理器", kind: "manager", online: true, healthy: true, startable: true, startCommand: "platform start vllm-manager", error: "" },
        { id: "llama", name: "llama.cpp 管理器", kind: "manager", online: false, healthy: false, startable: true, startCommand: "platform start llama-manager", error: "" },
        { id: "tts", name: "TTS 语音平台", kind: "tts", online: false, healthy: false, startable: false, startCommand: "platform start tts", error: "" },
      ],
    },
  };
  const { context, page, mock } = await newPage(browser, {
    bootstrap: NO_PLATFORM,
    api: {
      "GET /api/status": status,
      "POST /api/managers/llama/start": { ok: true },
      "POST /api/managers/vllm/stop": { ok: true },
    },
  });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await expect(byId(page, "system.degraded")).toBeVisible();
    await expect(stateOf(page, "vllm")).toContainText("Ready");
    await expect(stateOf(page, "llama")).toContainText("Stopped");
    await expect(stateOf(page, "tts")).toContainText("platform start tts");
    await expect(byId(page, "system.supervisor-banner")).toHaveCount(0);
    await expect(byId(page, "system.actions.tts")).toHaveText("");
    expect(mock.find("GET", "/api/platform/status")).toHaveLength(0);
    await byId(page, "system.actions.llama").locator('[data-testid="system.action.start"]').click();
    await expect.poll(() => mock.find("POST", "/api/managers/llama/start").length).toBe(1);
    await byId(page, "system.actions.vllm").locator('[data-testid="system.action.stop"]').click();
    await confirmIn(page, "system.stop-confirm").click();
    await expect.poll(() => mock.find("POST", "/api/managers/vllm/stop").length).toBe(1);
  } finally {
    await context.close();
  }
});

test("a platform route that answers endpoint_unavailable falls back to /api/status", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: { "GET /api/platform/status": { status: 404, body: { ok: false, error: { code: "endpoint_unavailable", message: "not mounted" } } } },
  });
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    await expect(byId(page, "system.degraded")).toBeVisible();
    await expect(stateOf(page, "vllm")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a failing status call shows an error state with Retry, never an empty table", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: { "GET /api/platform/status": { status: 500, body: { ok: false, error: { code: "internal_error", message: "boom" } } } },
  });
  try {
    await page.goto(`${entry.url}system`);
    await expect(byId(page, "system.error")).toBeVisible();
    await expect(byId(page, "system.table")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Preferences

test("preferences apply at once and survive a reload; Reset returns the defaults", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await page.goto(`${entry.url}system/preferences`);
    await expect(byId(page, "prefs.root")).toBeVisible();
    await expect(page.locator("#main h1")).toHaveText("Preferences");
    const html = page.locator("html");
    await byId(page, "prefs.theme").selectOption("dark");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await byId(page, "prefs.density").selectOption("compact");
    await expect(html).toHaveAttribute("data-density", "compact");
    const reloads = [];
    page.on("framenavigated", (frame) => frame === page.mainFrame() && reloads.push(frame.url()));
    await page.waitForTimeout(300);
    expect(reloads, "theme and density change without a navigation").toEqual([]);

    await page.reload();
    await expect(byId(page, "prefs.root")).toBeVisible();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(html).toHaveAttribute("data-density", "compact");
    await expect(byId(page, "prefs.theme")).toHaveValue("dark");
    await expect(byId(page, "prefs.density")).toHaveValue("compact");

    await byId(page, "prefs.reset").click();
    await byId(page, "prefs.reset-confirm").locator('[data-testid="dialog.confirm"]').click();
    await expect(byId(page, "prefs.theme")).toHaveValue("auto");
    await expect(byId(page, "prefs.density")).toHaveValue("comfortable");
    await expect(html).toHaveAttribute("data-density", "comfortable");
  } finally {
    await context.close();
  }
});

test("changing the language reloads the page once in the new language", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await page.goto(`${entry.url}system/preferences`);
    await expect(page.locator("#main h1")).toHaveText("Preferences");
    await byId(page, "prefs.locale").selectOption("zh-CN");
    await expect(page.locator("#main h1")).toHaveText("偏好设置");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(byId(page, "prefs.locale")).toHaveValue("zh-CN");
  } finally {
    await context.close();
  }
});

test("a viewer may open the preferences", async ({ browser }) => {
  const { context, page } = await newPage(browser, { role: VIEWER });
  try {
    await page.goto(`${entry.url}system/preferences`);
    await expect(byId(page, "prefs.root")).toBeVisible();
    await byId(page, "prefs.theme").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(byId(page, "system.nav.doctor")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the browser notification switch explains itself when notifications are blocked", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await context.addInitScript(() => {
      class Fake {
        static permission = "denied";
        static requestPermission() {
          return Promise.resolve("denied");
        }
      }
      Object.defineProperty(window, "Notification", { value: Fake, configurable: true });
    });
    await page.goto(`${entry.url}system/preferences`);
    await expect(byId(page, "prefs.notify.hint")).toContainText("blocked");
    await expect(byId(page, "prefs.notify")).toBeDisabled();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Layout and accessibility

for (const [name, size] of Object.entries(SIZES)) {
  for (const theme of ["light", "dark"]) {
    test(`System and Preferences have no overflow and no axe violations (${name}, ${theme})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, { size, theme });
      try {
        await page.goto(`${entry.url}system`);
        await ready(page);
        await expectNoOverflow(page);
        await expectNoA11yViolations(page, { label: `system ${theme} ${name}` });
        await byId(page, "system.actions.vllm-manager").locator('[data-testid="system.action.logs"]').click();
        await expect(byId(page, "log-viewer.log")).toBeVisible();
        await expectNoOverflow(page);
        await page.keyboard.press("Escape");
        await page.goto(`${entry.url}system/preferences`);
        await expect(byId(page, "prefs.root")).toBeVisible();
        await expectNoOverflow(page);
        await expectNoA11yViolations(page, { label: `preferences ${theme} ${name}` });
      } finally {
        await context.close();
      }
    });
  }
}

test("English pages carry no Han characters outside the language names", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await page.goto(`${entry.url}system`);
    await ready(page);
    expect((await page.locator("#main").innerText()).match(HAN)).toBeNull();
    await page.goto(`${entry.url}system/preferences`);
    await expect(byId(page, "prefs.root")).toBeVisible();
    const text = (await byId(page, "prefs.root").innerText()).replace(/简体中文/g, "");
    expect(text.match(HAN)).toBeNull();
  } finally {
    await context.close();
  }
});
