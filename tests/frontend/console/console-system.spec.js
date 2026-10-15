// CON-24 / CON-24b browser checks (07 §6.13, 06 §11, §13.2 console-system). Part 1: the
// System components page, its supervisor banner, row actions, Logs drawer and
// Danger zone, the viewer's redacted table, the pre-platform degrade from
// GET /api/status, and the preferences page. Part 2 (at the end): the doctor,
// settings, updates and ops pages. The real service-entry serves the console and
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

// ===========================================================================
// Part 2 (CON-24b, 07 §6.13, 06 §11): /system/doctor, /system/settings,
// /system/updates and /system/ops. The API is mocked in the browser.
// ===========================================================================

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const writes = (mock) => mock.calls.filter((call) => call.method !== "GET");
const toastWith = (page, text) => page.locator('[data-testid="toast.root"]').filter({ hasText: text });

// --- doctor ---------------------------------------------------------------

const FIX_DOCS = "/docs/troubleshooting.md";

function doctorCheck(id, status, title, detail, fix = null, extra = {}) {
  const head = id.split(".")[0];
  const group = { net: "network", sec: "security" }[head] || head;
  return { id, group, status, title, detail, data: {}, durationMs: 12, fix, actions: fix ? [fix.id] : [], ...extra };
}

function doctorFix(id, risk, en, zh, command, anchor) {
  return { id, risk, label: label(en, zh), command, docs: `${FIX_DOCS}#${anchor}` };
}

function doctorReport({ fixed = false } = {}) {
  return {
    schemaVersion: 1, at: iso(-60_000), durationMs: 912, summary: { ok: 2, warn: 3, fail: fixed ? 1 : 2, info: 0, skip: 0 },
    checks: [
      doctorCheck("env.node-version", "ok", label("Node.js version", "Node.js 版本"), "v24.1.0 satisfies ^24."),
      doctorCheck("env.deps.vllm-manager", "fail", label("Dependencies: vllm-manager", "依赖：vllm-manager"), "node_modules is out of date.",
        doctorFix("npm-ci", "confirm", "Reinstall dependencies", "重新安装依赖", "platform doctor --fix=env.deps.vllm-manager", "env")),
      fixed
        ? doctorCheck("storage.writable", "ok", label("Writable folders", "可写目录"), "config, logs and .runtime are writable.")
        : doctorCheck("storage.writable", "fail", label("Writable folders", "可写目录"), "logs is not writable.",
          doctorFix("mkdirs", "auto", "Create missing folders", "创建缺失的目录", "platform doctor --fix=storage.writable", "storage")),
      doctorCheck("runtime.wslconfig", "warn", label("WSL memory limit", "WSL 内存上限"), "memory is below the minimum.",
        doctorFix("runtime-docs", "manual", "Raise the WSL memory limit", "提高 WSL 内存上限", "notepad .wslconfig", "runtime")),
      doctorCheck("net.legacy-proxy", "warn", label("Legacy Claude proxy", "旧版 Claude 代理"), "backend text that the console replaces",
        doctorFix("legacy-proxy-docs", "manual", "Retire the legacy proxy", "停用旧版代理", "reg delete HKCU Run ClaudeVllmProxy", "network")),
      doctorCheck("sec.secret-store", "warn", label("Secret store", "密钥库"), "backend ACL text", null, { data: { protection: "acl-only" } }),
      doctorCheck("ops.backup", "ok", label("Backup", "备份"), "The newest backup is recent."),
    ],
  };
}

function operationApi(id, { running = 1, kind = "doctor-fix", failed = false } = {}) {
  let reads = 0;
  return {
    [`GET /api/platform/operations/${id}`]: () => {
      reads += 1;
      if (reads <= running) return { opId: id, kind, state: "running", progress: 0.4, log: ["step 1 of 2"], result: null };
      return failed
        ? { opId: id, kind, state: "failed", progress: 0.4, log: ["step 1 of 2"], result: { code: "fix_failed", message: "the fix could not finish" } }
        : { opId: id, kind, state: "ok", progress: 1, log: ["step 1 of 2", "step 2 of 2", "done"], result: null };
    },
  };
}

const fixBodies = (mock) => mock.find("POST", "/api/platform/doctor/fix").map((call) => call.body);
const check = (page, id) => page.locator(`[data-testid="doctor.check"][data-check="${id}"]`);

test("doctor: checks are grouped by category, failures first, with status, detail and the 06 copy for two special checks", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, { api: { "GET /api/platform/doctor": doctorReport() } });
  try {
    await page.goto(`${entry.url}system/doctor`);
    await expect(page.locator("#main h1")).toHaveText("System doctor");
    await expect(byId(page, "doctor.card.env")).toBeVisible();
    await expect(byId(page, "doctor.card.network")).toBeVisible();
    await expect(byId(page, "doctor.card.security")).toBeVisible();
    await expect(byId(page, "doctor.card.ops")).toBeVisible();
    const env = byId(page, "doctor.card.env").locator('[data-testid="doctor.check"]');
    await expect(env).toHaveCount(2);
    await expect(env.first()).toHaveAttribute("data-check", "env.deps.vllm-manager");
    await expect(env.first()).toContainText("node_modules is out of date.");
    await expect(env.first().locator('[data-testid="doctor.status"]')).toHaveText("Failed");
    await expect(byId(page, "doctor.count.fail")).toHaveText("2 Failed");
    await expect(byId(page, "doctor.count.ok")).toHaveText("2 OK");
    await expect(check(page, "net.legacy-proxy")).toContainText("Legacy Claude proxy detected on port 8001. It bypasses gateway authentication; consider retiring it.");
    await expect(check(page, "net.legacy-proxy")).not.toContainText("backend text that the console replaces");
    await expect(check(page, "sec.secret-store")).toContainText("Windows data protection (DPAPI) is unavailable, so secrets are protected by file permissions only.");
    expect(mock.unmocked).toEqual([]);
    expect(writes(mock)).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
    await failures.expectNone();
  } finally {
    await context.close();
  }
});

test("doctor: an auto fix runs at once, follows the operation and then checks again with fresh=1", async ({ browser }) => {
  let fixed = false;
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/platform/doctor": () => doctorReport({ fixed }),
      "POST /api/platform/doctor/fix": () => {
        fixed = true;
        return { status: 202, body: { ok: true, opId: "op_fix_auto" } };
      },
      ...operationApi("op_fix_auto"),
    },
  });
  try {
    await page.goto(`${entry.url}system/doctor`);
    await expect(check(page, "storage.writable")).toBeVisible();
    await check(page, "storage.writable").locator('[data-testid="doctor.fix"]').click();
    await expect(byId(page, "doctor.confirm")).toHaveCount(0);
    await expect.poll(() => fixBodies(mock).length).toBe(1);
    expect(fixBodies(mock)[0]).toEqual({ checkId: "storage.writable", fixId: "mkdirs" });
    const op = check(page, "storage.writable").locator('[data-testid="doctor.operation"]');
    await expect(op).toBeVisible();
    await expect(op.locator('[data-testid="operation.progress"]')).toBeVisible();
    await expect(op.locator('[data-testid="operation.state"]')).toHaveText("Done", { timeout: 8000 });
    await expect(op.locator('[data-testid="operation.log"]')).toContainText("step 2 of 2");
    await expect.poll(() => mock.find("GET", "/api/platform/doctor").some((call) => call.query.fresh === "1")).toBe(true);
    await expect(check(page, "storage.writable")).toHaveAttribute("data-status", "ok");
    await expect(check(page, "storage.writable").locator('[data-testid="doctor.fix"]')).toHaveCount(0);
    await op.locator('[data-testid="operation.dismiss"]').click();
    await expect(op).toHaveCount(0);
    expect(mock.unmocked).toEqual([]);
  } finally {
    await context.close();
  }
});

test("doctor: a confirm fix asks first, cancelling sends nothing, confirming posts confirm:true and follows the operation", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/platform/doctor": doctorReport(),
      "POST /api/platform/doctor/fix": { status: 202, body: { ok: true, opId: "op_fix_confirm" } },
      ...operationApi("op_fix_confirm", { running: 2 }),
    },
  });
  try {
    await page.goto(`${entry.url}system/doctor`);
    const button = check(page, "env.deps.vllm-manager").locator('[data-testid="doctor.fix"]');
    await expect(button).toHaveText("Reinstall dependencies");
    await button.click();
    const dialog = byId(page, "doctor.confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Run fix: Reinstall dependencies?");
    await expect(dialog).toContainText("never touches model containers");
    await expect(dialog).toContainText("Equivalent command: platform doctor --fix=env.deps.vllm-manager");
    expect(fixBodies(mock)).toEqual([]);
    await dialog.locator('[data-testid="dialog.cancel"]').click();
    await expect(dialog).toHaveCount(0);
    expect(fixBodies(mock)).toEqual([]);

    await button.click();
    await confirmIn(page, "doctor.confirm").click();
    await expect(dialog).toHaveCount(0);
    expect(fixBodies(mock)).toEqual([{ checkId: "env.deps.vllm-manager", fixId: "npm-ci", confirm: true }]);
    const op = check(page, "env.deps.vllm-manager").locator('[data-testid="doctor.operation"]');
    await expect(op.locator('[data-testid="operation.state"]')).toHaveText("Running");
    await expect(op.locator('[data-testid="operation.state"]')).toHaveText("Done", { timeout: 10_000 });
    expect(mock.find("GET", "/api/platform/operations/op_fix_confirm").length).toBeGreaterThanOrEqual(3);
  } finally {
    await context.close();
  }
});

test("doctor: a failing operation says so and keeps the log", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: {
      "GET /api/platform/doctor": doctorReport(),
      "POST /api/platform/doctor/fix": { status: 202, body: { ok: true, opId: "op_fix_fail" } },
      ...operationApi("op_fix_fail", { running: 0, failed: true }),
    },
  });
  try {
    await page.goto(`${entry.url}system/doctor`);
    await check(page, "storage.writable").locator('[data-testid="doctor.fix"]').click();
    const op = check(page, "storage.writable").locator('[data-testid="doctor.operation"]');
    await expect(op.locator('[data-testid="operation.state"]')).toHaveText("Failed");
    await expect(op.locator('[data-testid="operation.failure"]')).toContainText("fix_failed: the fix could not finish");
    await expect(op.locator('[data-testid="operation.log"]')).toContainText("step 1 of 2");
  } finally {
    await context.close();
  }
});

test("doctor: a manual fix shows the instruction, the command with Copy and Docs, and sends no request", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { "GET /api/platform/doctor": doctorReport() } });
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(entry.url).origin }).catch(() => undefined);
    await page.goto(`${entry.url}system/doctor`);
    const row = check(page, "runtime.wslconfig");
    await expect(row.locator('[data-testid="doctor.fix"]')).toHaveCount(0);
    await expect(row.locator('[data-testid="doctor.manual-note"]')).toHaveText("Run this yourself on this machine. Copy the command below:");
    await expect(row.locator('[data-testid="doctor.command"] code')).toHaveText("notepad .wslconfig");
    const docs = row.locator('[data-testid="doctor.docs"]');
    await expect(docs).toHaveText("Docs");
    await expect(docs).toHaveAttribute("href", `${FIX_DOCS}#runtime`);
    await expect(docs).toHaveAttribute("rel", /noopener/);
    await row.locator('[data-testid="code-block.copy"]').click();
    await expect(row.locator('[data-testid="code-block.status"]')).not.toHaveText("");
    expect(writes(mock)).toEqual([]);
    expect(mock.unmocked).toEqual([]);
  } finally {
    await context.close();
  }
});

test("doctor: a group filter asks for that group and Run again sends fresh=1", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { "GET /api/platform/doctor": doctorReport() } });
  try {
    await page.goto(`${entry.url}system/doctor`);
    await expect(byId(page, "doctor.card.env")).toBeVisible();
    await byId(page, "doctor.group.ops").click();
    await expect.poll(() => mock.find("GET", "/api/platform/doctor").some((call) => call.query.group === "ops")).toBe(true);
    await expect(page).toHaveURL(/[?&]group=ops/);
    await expect(byId(page, "doctor.group.ops")).toHaveAttribute("aria-pressed", "true");
    await byId(page, "doctor.run").click();
    await expect.poll(() => mock.find("GET", "/api/platform/doctor").some((call) => call.query.fresh === "1" && call.query.group === "ops")).toBe(true);
    await page.reload();
    await expect(byId(page, "doctor.group.ops")).toHaveAttribute("aria-pressed", "true");
  } finally {
    await context.close();
  }
});

test("doctor: the page follows the language", async ({ browser }) => {
  const { context, page } = await newPage(browser, { locale: "zh-CN", api: { "GET /api/platform/doctor": doctorReport() } });
  try {
    await page.goto(`${entry.url}system/doctor`);
    await expect(page.locator("#main h1")).toHaveText("系统检查");
    await expect(check(page, "env.deps.vllm-manager")).toContainText("依赖：vllm-manager");
    await expect(check(page, "env.deps.vllm-manager").locator('[data-testid="doctor.fix"]')).toHaveText("重新安装依赖");
    await expect(check(page, "runtime.wslconfig").locator('[data-testid="doctor.manual-note"]')).toHaveText("需要你在本机手动执行，复制下面的命令：");
  } finally {
    await context.close();
  }
});

test("doctor: a failing doctor call shows an error with Retry", async ({ browser }) => {
  let calls = 0;
  const { context, page } = await newPage(browser, {
    api: {
      "GET /api/platform/doctor": () => {
        calls += 1;
        return calls === 1 ? { status: 500, body: { ok: false, error: { code: "doctor_failed", message: "the doctor crashed" } } } : doctorReport();
      },
    },
  });
  try {
    await page.goto(`${entry.url}system/doctor`);
    await expect(byId(page, "doctor.error")).toContainText("the doctor crashed");
    await byId(page, "doctor.error").locator('[data-testid="empty-state.action"]').click();
    await expect(byId(page, "doctor.card.env")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("doctor: before the platform backend it renders each manager's tools/health with its remediation actions", async ({ browser }) => {
  const health = {
    ok: false, score: 60,
    checks: [
      {
        id: "docker", label: "Docker engine", status: "fail", detail: "Docker Desktop is not running.", actions: ["start-docker"],
        actionDetails: [{ id: "start-docker", kind: "api", method: "POST", path: "/api/docker/start", label: { zh: "启动 Docker", en: "Start Docker" } }],
      },
      {
        id: "image", label: "Runtime image", status: "warn", detail: "The image is not present.", actions: ["pull-image"],
        actionDetails: [{ id: "pull-image", kind: "command", command: "docker pull example/runtime:1", label: { zh: "复制拉取命令", en: "Copy pull command" } }],
      },
      { id: "gpu", label: "GPU", status: "ok", detail: "1 GPU", actions: [] },
    ],
  };
  const { context, page, mock } = await newPage(browser, {
    bootstrap: { ...NO_PLATFORM, managers: MANAGERS },
    api: {
      "GET /api/m/vllm/tools/health": health,
      "GET /api/m/llama/tools/health": { ok: true, score: 100, checks: [{ id: "gpu", label: "GPU", status: "ok", detail: "1 GPU", actions: [] }] },
      "POST /api/m/vllm/docker/start": { ok: true },
    },
  });
  try {
    await page.goto(`${entry.url}system/doctor`);
    await expect(byId(page, "doctor.degraded")).toContainText("Basic checks only");
    const vllm = byId(page, "doctor.legacy.vllm");
    await expect(vllm).toContainText("Docker Desktop is not running.");
    await expect(vllm.locator('[data-testid="doctor.legacy-command"] code')).toHaveText("docker pull example/runtime:1");
    await expect(byId(page, "doctor.legacy.llama")).toContainText("1 GPU");
    expect(mock.find("POST", "/api/m/vllm/docker/start")).toHaveLength(0);
    await vllm.locator('[data-testid="doctor.legacy-action"]').click();
    await expect.poll(() => mock.find("POST", "/api/m/vllm/docker/start").length).toBe(1);
    expect(mock.calls.filter((call) => call.path.startsWith("/api/platform/"))).toEqual([]);
    expect(mock.unmocked).toEqual([]);
  } finally {
    await context.close();
  }
});

// Both managers named in the bootstrap, so the pre-P6 doctor knows whom to ask.
const MANAGERS = [
  { id: "vllm", label: { zh: "vLLM / SGLang 管理器", en: "vLLM / SGLang manager" }, legacyUiPort: 5177 },
  { id: "llama", label: { zh: "llama.cpp 管理器", en: "llama.cpp manager" }, legacyUiPort: 5178 },
];

// --- settings -------------------------------------------------------------

function configItem(key, type, extra = {}) {
  return {
    key, type, source: "default", envNames: [], restartRequired: false, docs: "", owner: "06-ops",
    title: label(`Title of ${key}`, `${key} 的标题`), description: label(`About ${key}.`, `关于 ${key}。`), ...extra,
  };
}

function configDescription({ etag = "etag-one", port = 5176, portSource = "default", branch = "main", branchSource = "file", gateway = "serve" } = {}) {
  return {
    ok: true, schemaVersion: 1, etag, errors: [], warnings: [], overrideErrors: [],
    groups: [
      {
        id: "access", title: label("Access and network", "访问与网络"),
        items: [
          configItem("listeners.admin.lan", "boolean", { source: "file", value: false, default: false, restartRequired: ["entry"] }),
          configItem("listeners.admin.port", "integer", { source: portSource, value: port, default: 5176, envNames: ["SERVICE_ENTRY_PORT"], restartRequired: ["entry", "search"] }),
          configItem("admin.legacyProxyGateway", "string", { enum: ["serve", "reject"], source: "env", value: gateway, default: "serve", envNames: ["ADMIN_LEGACY_PROXY_GATEWAY"] }),
          configItem("admin.extraHosts", "array", { value: [], default: [] }),
        ],
      },
      {
        id: "supervisor", title: label("Supervisor", "守护进程"),
        items: [
          configItem("hf.token", "string", { restartRequired: ["vllm-manager"], secret: { set: true, source: "store" } }),
          configItem("platformMcp.apiKey", "string", { restartRequired: ["platform-mcp"], secret: { set: false, source: "unknown" } }),
          configItem("supervisor.pace", "integer", { source: "derived", value: 3, default: 3 }),
          configItem("cli.openBrowser", "boolean", { source: "runtime", value: true, default: true }),
        ],
      },
      { id: "updates", title: label("Updates", "更新"), items: [configItem("updates.branch", "string", { source: branchSource, value: branch, default: "main" })] },
    ],
  };
}

// A config API that remembers what was saved: GET answers the current state, PUT applies `set` and moves the etag.
function configApi({ put } = {}) {
  const state = { etag: "etag-one", port: 5176, portSource: "default", branch: "main", branchSource: "file", gateway: "serve" };
  const save = (body) => {
    if (body.set && "listeners.admin.port" in body.set) {
      state.port = body.set["listeners.admin.port"];
      state.portSource = "file";
    }
    if (body.unset?.includes("updates.branch")) {
      state.branch = "main";
      state.branchSource = "default";
    }
    state.etag = state.etag === "etag-one" ? "etag-two" : "etag-three";
    return { ok: true, etag: state.etag, changed: [...Object.keys(body.set || {}), ...(body.unset || []), ...Object.keys(body.secrets || {})], restartRequired: ["entry", "search"] };
  };
  return {
    state,
    api: {
      "GET /api/platform/config": () => configDescription(state),
      "PUT /api/platform/config": (request) => {
        const body = JSON.parse(request.postData() || "{}");
        return put ? put(body, state, save) : save(body);
      },
    },
  };
}

const field = (page, key) => page.locator(`[data-testid="schema-form.field"][data-field="${key}"]`);
const puts = (mock) => mock.find("PUT", "/api/platform/config");
const settingsReady = (page) => expect(byId(page, "settings.form")).toBeVisible();

test("settings: every leaf shows its source badge, restart requirement and secret state", async ({ browser }) => {
  const { api } = configApi();
  const { context, page, mock, failures } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}system/settings`);
    await settingsReady(page);
    await expect(page.locator("#main h1")).toHaveText("Platform settings");
    await expect(page.locator('[data-testid="schema-form.levels"]')).toHaveCount(0);
    await expect(field(page, "listeners.admin.port")).toHaveAttribute("data-source", "default");
    await expect(field(page, "listeners.admin.port")).toContainText("Default");
    await expect(field(page, "listeners.admin.lan")).toHaveAttribute("data-source", "file");
    await expect(field(page, "listeners.admin.lan")).toContainText("Config file");
    await expect(field(page, "admin.legacyProxyGateway")).toContainText("Environment");
    await expect(field(page, "supervisor.pace")).toContainText("Derived");
    await expect(field(page, "cli.openBrowser")).toContainText("This run");
    await expect(field(page, "listeners.admin.port").locator('[data-testid="settings.restart-badge"]')).toHaveText("Restart required after saving: Entry, Search gateway");
    await expect(field(page, "admin.extraHosts").locator('[data-testid="settings.restart-badge"]')).toHaveCount(0);
    await expect(field(page, "admin.legacyProxyGateway").locator('[data-testid="settings.env-badge"]')).toContainText("ADMIN_LEGACY_PROXY_GATEWAY");
    await expect(field(page, "listeners.admin.port").locator("input")).toHaveValue("5176");
    await expect(field(page, "hf.token").locator('[data-testid="schema-form.secret-state"]')).toHaveText("Set");
    await expect(field(page, "platformMcp.apiKey").locator('[data-testid="schema-form.secret-state"]')).toHaveText("Unchanged");
    await expect(field(page, "hf.token").locator("input[type=password]")).toHaveValue("");
    await expect(byId(page, "settings.save")).toBeDisabled();
    await expect(byId(page, "settings.count")).toHaveText("No unsaved changes");
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("settings: Save sends If-Match and only the changed leaves, then Apply defaults to when:'idle'", async ({ browser }) => {
  const { api } = configApi();
  const { context, page, mock } = await newPage(browser, {
    api: {
      ...api,
      "POST /api/platform/config/apply": {
        status: 202,
        body: { ok: true, opId: "op_apply", opIds: ["op_apply"], results: [{ id: "entry", opId: "op_apply" }, { id: "search", queued: true, blockers: [] }] },
      },
      ...operationApi("op_apply", { kind: "restart" }),
    },
  });
  try {
    await page.goto(`${entry.url}system/settings`);
    await settingsReady(page);
    await page.locator("#sf-listeners-admin-port").fill("6001");
    await expect(byId(page, "settings.count")).toHaveText("1 unsaved change");
    await expect(field(page, "listeners.admin.port").locator('[data-testid="form-field.changed"]')).toBeVisible();
    await expect(field(page, "listeners.admin.lan").locator('[data-testid="form-field.changed"]')).toHaveCount(0);
    await expect(byId(page, "settings.apply")).toBeDisabled();
    expect(puts(mock)).toHaveLength(0);
    await byId(page, "settings.save").click();
    await expect.poll(() => puts(mock).length).toBe(1);
    expect(puts(mock)[0].headers["if-match"]).toBe('"etag-one"');
    expect(puts(mock)[0].body).toEqual({ set: { "listeners.admin.port": 6001 } });
    await expect(toastWith(page, "Settings saved. Restart needed: Entry, Search gateway")).toBeVisible();
    await expect(field(page, "listeners.admin.port")).toHaveAttribute("data-source", "file");
    await expect(field(page, "listeners.admin.port").locator("input")).toHaveValue("6001");
    await expect(byId(page, "settings.pending")).toHaveText("Restart required after saving: Entry, Search gateway");

    await byId(page, "settings.apply").click();
    await expect.poll(() => mock.find("POST", "/api/platform/config/apply").length).toBe(1);
    expect(mock.find("POST", "/api/platform/config/apply")[0].body).toEqual({ restart: ["entry", "search"], when: "idle" });
    await expect(toastWith(page, "Queued: Search gateway will restart when the platform is idle.")).toBeVisible();
    const op = byId(page, "settings.operation");
    await expect(op).toBeVisible();
    await expect(op).toContainText("Restarting Entry");
    await expect(op.locator('[data-testid="operation.state"]')).toHaveText("Done", { timeout: 8000 });
    await expect(byId(page, "settings.pending-none")).toBeVisible();
    await expect(byId(page, "settings.apply")).toBeDisabled();
    expect(mock.unmocked).toEqual([]);
  } finally {
    await context.close();
  }
});

test("settings: Restart now asks first and posts when:'now'; restarting the entry says the console reconnects", async ({ browser }) => {
  const { api } = configApi();
  const { context, page, mock } = await newPage(browser, {
    api: {
      ...api,
      "POST /api/platform/config/apply": { status: 202, body: { ok: true, opId: "op_now", opIds: ["op_now"], results: [{ id: "entry", opId: "op_now" }, { id: "search", opId: "op_now" }] } },
      ...operationApi("op_now", { kind: "restart" }),
    },
  });
  try {
    await page.goto(`${entry.url}system/settings`);
    await settingsReady(page);
    await page.locator("#sf-listeners-admin-port").fill("6002");
    await byId(page, "settings.save").click();
    await expect(byId(page, "settings.pending")).toBeVisible();
    await byId(page, "settings.apply-now").click();
    const dialog = byId(page, "settings.apply-confirm");
    await expect(dialog).toContainText("Restart Entry, Search gateway now?");
    await expect(dialog).toContainText("Downloads or launches in progress may be interrupted.");
    expect(mock.find("POST", "/api/platform/config/apply")).toHaveLength(0);
    await confirmIn(page, "settings.apply-confirm").click();
    await expect.poll(() => mock.find("POST", "/api/platform/config/apply").length).toBe(1);
    expect(mock.find("POST", "/api/platform/config/apply")[0].body).toEqual({ restart: ["entry", "search"], when: "now" });
    await expect(byId(page, "settings.entry-note")).toContainText("reconnects");
  } finally {
    await context.close();
  }
});

test("settings: a secret is sent once in `secrets`, Clear sends null, and the value is never echoed or stored", async ({ browser }) => {
  const { api } = configApi();
  const secretText = "fake-token-value-123";
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}system/settings`);
    await settingsReady(page);
    const input = field(page, "platformMcp.apiKey").locator("input[type=password]");
    await input.fill(secretText);
    await expect(field(page, "platformMcp.apiKey").locator('[data-testid="schema-form.secret-state"]')).toHaveText("A new value will be sent");
    await expect(byId(page, "settings.count")).toHaveText("1 unsaved change");
    await byId(page, "settings.save").click();
    await expect.poll(() => puts(mock).length).toBe(1);
    expect(puts(mock)[0].body).toEqual({ secrets: { "platformMcp.apiKey": secretText } });
    expect(puts(mock)[0].path + JSON.stringify(puts(mock)[0].query)).not.toContain(secretText);
    await expect(input).toHaveValue("");
    await expect(page.locator("body")).not.toContainText(secretText);
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
    expect(stored).not.toContain(secretText);
    expect(JSON.stringify(mock.calls.filter((call) => call.method === "GET"))).not.toContain(secretText);

    await field(page, "hf.token").locator('[data-testid="schema-form.secret-clear"]').click();
    await expect(field(page, "hf.token").locator('[data-testid="schema-form.secret-state"]')).toHaveText("Will be cleared");
    await byId(page, "settings.save").click();
    await expect.poll(() => puts(mock).length).toBe(2);
    expect(puts(mock)[1].body).toEqual({ secrets: { "hf.token": null } });
  } finally {
    await context.close();
  }
});

test("settings: 'Use default' on a file value sends it in `unset`, and Undo takes it back", async ({ browser }) => {
  const { api } = configApi();
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}system/settings`);
    await settingsReady(page);
    await expect(field(page, "updates.branch").locator('[data-testid="settings.use-default"]')).toBeVisible();
    await expect(field(page, "listeners.admin.port").locator('[data-testid="settings.use-default"]')).toHaveCount(0);
    await field(page, "updates.branch").locator('[data-testid="settings.use-default"]').click();
    await expect(field(page, "updates.branch").locator('[data-testid="settings.reverting"]')).toHaveText("Will return to the default when saved");
    await expect(byId(page, "settings.count")).toHaveText("1 unsaved change");
    await field(page, "updates.branch").locator('[data-testid="settings.undo"]').click();
    await expect(byId(page, "settings.count")).toHaveText("No unsaved changes");
    await field(page, "updates.branch").locator('[data-testid="settings.use-default"]').click();
    await byId(page, "settings.save").click();
    await expect.poll(() => puts(mock).length).toBe(1);
    expect(puts(mock)[0].body).toEqual({ unset: ["updates.branch"] });
    await expect(field(page, "updates.branch")).toHaveAttribute("data-source", "default");
  } finally {
    await context.close();
  }
});

test("settings: 400 config_invalid puts each error on its field and keeps the edit", async ({ browser }) => {
  const { api } = configApi({
    put: () => ({
      status: 400,
      body: { ok: false, error: { code: "config_invalid", message: "The settings are not valid." }, errors: [{ field: "listeners.admin.port", code: "out_of_range", message: "The port must be between 1 and 65535." }] },
    }),
  });
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}system/settings`);
    await settingsReady(page);
    await page.locator("#sf-listeners-admin-port").fill("70000");
    await byId(page, "settings.save").click();
    await expect(field(page, "listeners.admin.port").locator('[data-testid="form-field.error"]')).toContainText("The port must be between 1 and 65535.");
    await expect(field(page, "listeners.admin.lan").locator('[data-testid="form-field.error"]')).toHaveCount(0);
    await expect(page.locator("#sf-listeners-admin-port")).toHaveValue("70000");
    await expect(toastWith(page, "The settings were not saved because a value is invalid.")).toBeVisible();
    await expect(byId(page, "settings.save")).toBeEnabled();
    await page.locator("#sf-listeners-admin-port").fill("7000");
    await expect(field(page, "listeners.admin.port").locator('[data-testid="form-field.error"]')).toHaveCount(0);
    expect(puts(mock)).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("settings: 409 config_conflict reloads, shows a DiffTable and saves again on the new etag", async ({ browser }) => {
  let first = true;
  const { api, state } = configApi({
    put: (body, current, save) => {
      if (first) {
        first = false;
        current.etag = "etag-two";
        current.port = 5200;
        current.portSource = "file";
        current.gateway = "reject";
        return { status: 409, body: { ok: false, error: { code: "config_conflict", message: "The settings changed." }, hint: "reload", errors: [], etag: "etag-two" } };
      }
      return save(body);
    },
  });
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}system/settings`);
    await settingsReady(page);
    await page.locator("#sf-listeners-admin-port").fill("6001");
    await byId(page, "settings.save").click();
    const conflict = byId(page, "settings.conflict");
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText("The settings changed elsewhere");
    const rows = byId(page, "settings.conflict-diff").locator('[data-testid="diff-table.row"]');
    await expect(rows).toHaveCount(2);
    const mine = rows.filter({ hasText: "Title of listeners.admin.port" });
    await expect(mine).toContainText("5200");
    await expect(mine).toContainText("6001");
    await expect(mine).toContainText("Your edit");
    const theirs = rows.filter({ hasText: "Title of admin.legacyProxyGateway" });
    await expect(theirs).toContainText("serve");
    await expect(theirs).toContainText("reject");
    await expect(theirs).toContainText("Changed elsewhere");
    expect(mock.find("GET", "/api/platform/config").length).toBeGreaterThanOrEqual(2);
    await expect(page.locator("#sf-listeners-admin-port")).toHaveValue("6001");
    await byId(page, "settings.conflict-save").click();
    await expect.poll(() => puts(mock).length).toBe(2);
    expect(puts(mock)[0].headers["if-match"]).toBe('"etag-one"');
    expect(puts(mock)[1].headers["if-match"]).toBe('"etag-two"');
    expect(puts(mock)[1].body).toEqual({ set: { "listeners.admin.port": 6001 } });
    await expect(conflict).toHaveCount(0);
    expect(state.port).toBe(6001);
  } finally {
    await context.close();
  }
});

test("settings: discarding after a conflict drops the edits", async ({ browser }) => {
  const { api } = configApi({ put: (body, current) => {
    current.etag = "etag-two";
    return { status: 409, body: { ok: false, error: { code: "config_conflict", message: "The settings changed." }, errors: [] } };
  } });
  const { context, page } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}system/settings`);
    await settingsReady(page);
    await page.locator("#sf-listeners-admin-port").fill("6001");
    await byId(page, "settings.save").click();
    await expect(byId(page, "settings.conflict")).toBeVisible();
    await byId(page, "settings.conflict-discard").click();
    await expect(byId(page, "settings.conflict")).toHaveCount(0);
    await expect(page.locator("#sf-listeners-admin-port")).toHaveValue("5176");
    await expect(byId(page, "settings.count")).toHaveText("No unsaved changes");
  } finally {
    await context.close();
  }
});

test("settings: 409 config_locked retries once after 2 s", async ({ browser }) => {
  const stamps = [];
  const { api } = configApi({
    put: (body, current, save) => {
      stamps.push(Date.now());
      if (stamps.length === 1) return { status: 409, body: { ok: false, error: { code: "config_locked", message: "locked" }, hint: "retry", errors: [] } };
      return save(body);
    },
  });
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}system/settings`);
    await settingsReady(page);
    await page.locator("#sf-listeners-admin-port").fill("6001");
    await byId(page, "settings.save").click();
    await expect.poll(() => puts(mock).length, { timeout: 8000 }).toBe(2);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(1800);
    await expect(toastWith(page, "Settings saved.")).toBeVisible();
    await expect(byId(page, "settings.pending")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("settings: a second config_locked is reported, not retried again", async ({ browser }) => {
  const { api } = configApi({ put: () => ({ status: 409, body: { ok: false, error: { code: "config_locked", message: "The config file is locked by another writer." }, errors: [] } }) });
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(`${entry.url}system/settings`);
    await settingsReady(page);
    await page.locator("#sf-listeners-admin-port").fill("6001");
    await byId(page, "settings.save").click();
    await expect.poll(() => puts(mock).length, { timeout: 8000 }).toBe(2);
    await expect(toastWith(page, "locked")).toBeVisible();
    await page.waitForTimeout(2500);
    expect(puts(mock)).toHaveLength(2);
    await expect(byId(page, "settings.save")).toBeEnabled();
  } finally {
    await context.close();
  }
});

// --- P6 gate and ownership -------------------------------------------------

for (const route of ["settings", "updates", "ops"]) {
  test(`${route}: before the platform backend the page shows the P6 EmptyState and calls nothing`, async ({ browser }) => {
    const { context, page, mock } = await newPage(browser, { bootstrap: NO_PLATFORM });
    try {
      await page.goto(`${entry.url}system/${route}`);
      await expect(byId(page, "system.p6")).toBeVisible();
      await expect(byId(page, "system.p6.empty")).toContainText("Requires backend component P6");
      await expect(byId(page, "system.p6.empty").locator('[data-testid="empty-state.action"]')).toHaveAttribute("href", "/system");
      await expect(byId(page, `system.nav.${route}`)).toHaveAttribute("aria-current", "page");
      expect(mock.calls.filter((call) => call.path.startsWith("/api/platform/"))).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("the P6 EmptyState also shows when the platform route answers endpoint_unavailable", async ({ browser }) => {
  const missing = { status: 404, body: { error: "Not found." } };
  const { context, page } = await newPage(browser, {
    api: { "GET /api/platform/config": missing, "GET /api/platform/version": missing, "GET /api/platform/schedules": missing, "GET /api/platform/doctor": missing, "GET /api/platform/deploys": missing, "GET /api/platform/pending-restarts": missing },
  });
  try {
    for (const route of ["settings", "updates", "ops"]) {
      await page.goto(`${entry.url}system/${route}`);
      await expect(byId(page, "system.p6.empty")).toContainText("Requires backend component P6");
    }
  } finally {
    await context.close();
  }
});

test("the P6 EmptyState speaks Chinese in zh", async ({ browser }) => {
  const { context, page } = await newPage(browser, { bootstrap: NO_PLATFORM, locale: "zh-CN" });
  try {
    await page.goto(`${entry.url}system/settings`);
    await expect(byId(page, "system.p6.empty")).toContainText("该功能需要后端组件 P6");
  } finally {
    await context.close();
  }
});

test("a viewer cannot open the owner-only System pages", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { role: VIEWER });
  try {
    for (const route of ["doctor", "settings", "updates", "ops"]) {
      await page.goto(`${entry.url}system/${route}`);
      await expect(byId(page, "pairing-screen.root")).toBeVisible();
    }
    expect(mock.calls.filter((call) => /\/api\/platform\/(doctor|config|schedules|deploys|pending-restarts)/.test(call.path))).toEqual([]);
  } finally {
    await context.close();
  }
});

// --- updates ---------------------------------------------------------------

function versionDocument(extra = {}) {
  return {
    ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, node: "v24.1.0",
    packages: [{ dir: "service-entry", version: "1.4.0" }, { dir: "vllm-manager", version: "2.0.1" }],
    newerCommits: { available: true, behind: 3, head: "9f8e7d6c5b4a3210", deployed: "2ad10e5ffe68aaaa", ref: "refs/heads/main" },
    drift: { count: 2, checkedAt: iso(-30_000) },
    ...extra,
  };
}

function deploysDocument() {
  return {
    deployments: [
      { stamp: "20261016-0100", commit: "2ad10e5ffe68", branch: "main", deployedAt: iso(-3_600_000), counts: { created: 2, updated: 14, unchanged: 300, pruned: 1 }, postDeploy: null },
      { stamp: "20261014-0900", commit: "11aa22bb33cc", branch: "main", deployedAt: iso(-170_000_000), counts: { created: 0, updated: 3, unchanged: 310, pruned: 0 }, postDeploy: null },
    ],
  };
}

test("updates: shows version, commit, contentHash, newer commits, drift, deploy history and pending restarts", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, {
    api: {
      "GET /api/platform/version": versionDocument(),
      "GET /api/platform/deploys": deploysDocument(),
      "GET /api/platform/pending-restarts": { pendingRestarts: [{ id: "search", reason: "deploy", queuedAt: iso(-120_000), deadline: iso(3_600_000) }] },
    },
  });
  try {
    await page.goto(`${entry.url}system/updates`);
    await expect(page.locator("#main h1")).toHaveText("Updates");
    await expect(byId(page, "updates.version-value")).toHaveText("0.2.0-git-2ad10e5ffe68");
    await expect(byId(page, "updates.commit")).toHaveText("2ad10e5ffe68");
    await expect(byId(page, "updates.content-hash")).toHaveText("3f9c2a1b7d0e");
    await expect(byId(page, "updates.node")).toHaveText("v24.1.0");
    await expect(byId(page, "updates.newer")).toContainText("3 newer commits have not been deployed.");
    await expect(byId(page, "updates.command")).toContainText("platform update");
    await expect(byId(page, "updates.drift")).toContainText("2 live files were edited by hand. The next deploy will refuse until they are ported.");
    await expect(byId(page, "updates.drift-review")).toHaveAttribute("href", "/system/doctor?group=ops");
    await expect(byId(page, "updates.packages")).toContainText("service-entry");
    const deploys = byId(page, "updates.deploys-table");
    await expect(deploys).toContainText("2ad10e5ffe68");
    await expect(deploys).toContainText("11aa22bb33cc");
    await expect(deploys.locator("tbody tr")).toHaveCount(2);
    const pending = byId(page, "updates.pending-table");
    await expect(pending).toContainText("search");
    await expect(pending).toContainText("Update deployed");
    expect(mock.find("GET", "/api/platform/deploys")[0].query.limit).toBe("20");
    expect(writes(mock)).toEqual([]);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("updates: up to date and no drift read as such; a bare newerCommits number still works", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: {
      "GET /api/platform/version": versionDocument({ newerCommits: 0, drift: { count: 0, checkedAt: null } }),
      "GET /api/platform/deploys": { deployments: [] },
      "GET /api/platform/pending-restarts": { pendingRestarts: [] },
    },
  });
  try {
    await page.goto(`${entry.url}system/updates`);
    await expect(byId(page, "updates.up-to-date")).toContainText("Up to date with the update branch");
    await expect(byId(page, "updates.no-drift")).toContainText("No live files were edited by hand");
    await expect(byId(page, "updates.newer")).toHaveCount(0);
    await expect(byId(page, "updates.pending-none")).toBeVisible();
    await expect(byId(page, "updates.deploys-empty")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("updates: a count that failed says why instead of claiming up to date", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: {
      "GET /api/platform/version": versionDocument({ newerCommits: { available: false, behind: null, error: { code: "repo_missing", message: "x" } }, drift: { count: 0, checkedAt: null } }),
      "GET /api/platform/deploys": { deployments: [] },
      "GET /api/platform/pending-restarts": { pendingRestarts: [] },
    },
  });
  try {
    await page.goto(`${entry.url}system/updates`);
    await expect(byId(page, "updates.newer-unknown")).toContainText("Newer commits could not be counted (repo_missing).");
    await expect(byId(page, "updates.up-to-date")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("updates: cancelling a pending restart asks first and sends DELETE", async ({ browser }) => {
  let pending = [{ id: "search", reason: "deploy", queuedAt: iso(-120_000), deadline: iso(3_600_000) }];
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/platform/version": versionDocument(),
      "GET /api/platform/deploys": deploysDocument(),
      "GET /api/platform/pending-restarts": () => ({ pendingRestarts: pending }),
      "DELETE /api/platform/pending-restarts/search": () => {
        pending = [];
        return { ok: true, removed: true };
      },
    },
  });
  try {
    await page.goto(`${entry.url}system/updates`);
    await byId(page, "updates.cancel").click();
    const dialog = byId(page, "updates.cancel-confirm");
    await expect(dialog).toContainText("Cancel the pending restart of search?");
    expect(mock.find("DELETE", "/api/platform/pending-restarts")).toHaveLength(0);
    await dialog.locator('[data-testid="dialog.cancel"]').click();
    expect(mock.find("DELETE", "/api/platform/pending-restarts")).toHaveLength(0);
    await byId(page, "updates.cancel").click();
    await confirmIn(page, "updates.cancel-confirm").click();
    await expect.poll(() => mock.find("DELETE", "/api/platform/pending-restarts/search").length).toBe(1);
    await expect(byId(page, "updates.pending-none")).toBeVisible();
  } finally {
    await context.close();
  }
});

// --- ops -------------------------------------------------------------------

function schedulesDocument() {
  const trend = Array.from({ length: 30 }, (_, index) => {
    const ok = index < 27;
    return { at: iso(-(30 - index) * 86_400_000), ok, passed: ok ? 40 : 33, failed: ok ? 0 : 7 };
  });
  return {
    nightly: { latest: { ok: false, passed: 33, failed: 7, at: iso(-86_400_000), ageHours: 24 }, trend, streak: 3, since: "2026-10-14" },
    backup: { latest: { stamp: "20261015-030000", at: iso(-20 * 3_600_000), format: "backup/v1", formatOk: true, warnings: 0 }, ageHours: 20, files: 12 },
    tasks: {
      autostart: { method: null, registered: false },
      nightly: { name: "LocalAIPlatformNightlyE2E", state: "Ready", lastRunTime: iso(-86_400_000), lastTaskResult: 0, nextRunTime: iso(3_600_000) },
      backup: null,
    },
  };
}

function opsDoctor() {
  return {
    schemaVersion: 1, at: iso(-1000), durationMs: 120, summary: { ok: 1, warn: 0, fail: 0, info: 1, skip: 0 },
    checks: [
      doctorCheck("ops.autostart", "info", label("Autostart", "开机自启动"), "Autostart is not registered.",
        doctorFix("autostart-docs", "manual", "Run platform autostart enable", "运行 platform autostart enable", "platform autostart enable", "ops"), { data: { method: null, registered: false } }),
      doctorCheck("ops.backup", "ok", label("Backup", "备份"), "The newest backup is recent and has the expected format."),
    ],
  };
}

test("ops: 30 nightly bars, the streak warning, backup age, tasks and the autostart command to copy; nothing is registered", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, { api: { "GET /api/platform/schedules": schedulesDocument(), "GET /api/platform/doctor": opsDoctor() } });
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(entry.url).origin }).catch(() => undefined);
    await page.goto(`${entry.url}system/ops`);
    await expect(page.locator("#main h1")).toHaveText("Operations");
    await expect(byId(page, "ops.bar")).toHaveCount(30);
    await expect(byId(page, "ops.bar").first()).toHaveAttribute("data-state", "pass");
    await expect(byId(page, "ops.bar").last()).toHaveAttribute("data-state", "fail");
    await expect(page.locator('[data-testid="ops.bar"][data-state="fail"]')).toHaveCount(3);
    await expect(byId(page, "ops.trend-bars")).toHaveAttribute("aria-label", /Last 30 nightly checks.*27 passed, 3 failed/);
    await expect(byId(page, "ops.nightly-failing")).toContainText("The nightly check has failed 3 nights in a row (since 2026-10-14).");
    await expect(byId(page, "ops.nightly-latest")).toContainText("33 passed, 7 failed");
    await expect(byId(page, "ops.backup-age")).toContainText("Newest backup is 20 h old");
    await expect(byId(page, "ops.tasks-table")).toContainText("Nightly check");
    await expect(byId(page, "ops.tasks-table")).toContainText("Not registered");
    await expect(byId(page, "ops.autostart-status")).toContainText("Not registered");
    await expect(byId(page, "ops.autostart-howto")).toHaveText("To start the platform at logon, run this on this machine: platform autostart enable");
    await expect(byId(page, "ops.autostart-command").locator("code")).toHaveText("platform autostart enable");
    await byId(page, "ops.autostart-command").locator('[data-testid="code-block.copy"]').click();
    await expect(byId(page, "ops.autostart-command").locator('[data-testid="code-block.status"]')).not.toHaveText("");
    await expect(page.locator('[data-testid="ops.check"]')).toHaveCount(2);
    expect(writes(mock)).toEqual([]);
    expect(mock.unmocked).toEqual([]);
    expect(mock.find("GET", "/api/platform/doctor")[0].query.group).toBe("ops");
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("ops: a registered autostart shows as registered; fewer than 30 reports still draw 30 slots; a quiet nightly shows no warning", async ({ browser }) => {
  const document = schedulesDocument();
  document.nightly = { latest: { ok: true, passed: 40, failed: 0, at: iso(-3_600_000), ageHours: 1 }, trend: document.nightly.trend.slice(0, 10).map((item) => ({ ...item, ok: true, passed: 40, failed: 0 })), streak: 0, since: null };
  document.tasks.autostart = { method: "task", registered: true, pathMatches: true, state: "Ready" };
  const report = opsDoctor();
  report.checks[0] = doctorCheck("ops.autostart", "ok", label("Autostart", "开机自启动"), "Autostart is registered (task) for this platform folder.", null, { data: { method: "task", registered: true, pathMatches: true, state: "Ready" } });
  const { context, page } = await newPage(browser, { api: { "GET /api/platform/schedules": document, "GET /api/platform/doctor": report } });
  try {
    await page.goto(`${entry.url}system/ops`);
    await expect(byId(page, "ops.bar")).toHaveCount(30);
    await expect(page.locator('[data-testid="ops.bar"][data-state="missing"]')).toHaveCount(20);
    await expect(byId(page, "ops.nightly-failing")).toHaveCount(0);
    await expect(byId(page, "ops.autostart-status")).toContainText("Registered");
    await expect(byId(page, "ops.autostart-command").locator("code")).toHaveText("platform autostart enable");
  } finally {
    await context.close();
  }
});

// --- layout, accessibility and language ------------------------------------

function systemApi() {
  return {
    "GET /api/platform/doctor": doctorReport(),
    ...configApi().api,
    "GET /api/platform/version": versionDocument(),
    "GET /api/platform/deploys": deploysDocument(),
    "GET /api/platform/pending-restarts": { pendingRestarts: [{ id: "search", reason: "deploy", queuedAt: iso(-120_000), deadline: iso(3_600_000) }] },
    "GET /api/platform/schedules": schedulesDocument(),
  };
}

for (const [name, size] of Object.entries(SIZES)) {
  for (const theme of ["light", "dark"]) {
    test(`doctor, settings, updates and ops have no overflow and no axe violations (${name}, ${theme})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, { size, theme, api: systemApi() });
      try {
        const pages = [
          ["doctor", "doctor.card.env"],
          ["settings", "settings.form"],
          ["updates", "updates.deploys-table"],
          ["ops", "ops.autostart"],
        ];
        for (const [route, marker] of pages) {
          await page.goto(`${entry.url}system/${route}`);
          await expect(byId(page, marker).first()).toBeVisible();
          await expectNoOverflow(page);
          await expectNoA11yViolations(page, { label: `system ${route} ${theme} ${name}` });
        }
        await page.goto(`${entry.url}system/doctor`);
        await check(page, "env.deps.vllm-manager").locator('[data-testid="doctor.fix"]').click();
        await expect(byId(page, "doctor.confirm")).toBeVisible();
        await expectNoA11yViolations(page, { label: `doctor confirm ${theme} ${name}` });
        await page.keyboard.press("Escape");
        await page.goto(`${entry.url}system/settings`);
        await expect(byId(page, "settings.form")).toBeVisible();
        await page.locator("#sf-listeners-admin-port").fill("6001");
        await expectNoOverflow(page);
      } finally {
        await context.close();
      }
    });
  }
}

test("English pages carry no Han characters on the four platform pages", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: systemApi() });
  try {
    for (const [route, marker] of [["doctor", "doctor.card.env"], ["settings", "settings.form"], ["updates", "updates.deploys-table"], ["ops", "ops.autostart"]]) {
      await page.goto(`${entry.url}system/${route}`);
      await expect(byId(page, marker).first()).toBeVisible();
      expect((await page.locator("#main").innerText()).match(HAN)).toBeNull();
    }
  } finally {
    await context.close();
  }
});
