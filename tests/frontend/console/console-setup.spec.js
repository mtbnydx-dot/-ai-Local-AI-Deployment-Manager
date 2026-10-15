// CON-25 browser checks (07 §6.14, 06 §8, §11): the first-run /setup page.
// The real service-entry serves the console and the API is mocked in the browser
// (helpers/console-harness.js). Covers the boot-step-8 auto-route (owner with an
// incomplete GET /api/platform/setup only), the ten steps with status and one
// primary action, a step POST followed through the operation and the image-pull
// jobs, the ops step that only shows commands, Skip that persists, the ?from=setup
// back bar and the pre-06 checklist.
const { test, expect } = require("@playwright/test");
const {
  collectFailures,
  expectNoA11yViolations,
  expectNoOverflow,
  mockConsoleApi,
  setPrefs,
  startEntry,
} = require("../helpers/console-harness.js");

const fs = require("node:fs");
const path = require("node:path");
const PLATFORM_STATUS = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "fixtures", "console", "platform-status.json"), "utf8"));
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const HAN = /\p{Script=Han}/u;
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = { role: "owner", auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" } };
const VIEWER = { role: "viewer", auth: { mode: "session", session: { role: "viewer", via: "none", paired: false, autoPairAvailable: false }, csrf: null } };
const VIEWER_SESSION = { ok: true, role: "viewer", paired: false, csrfToken: null, pairCommand: "platform admin pair" };
const SETUP_ON = { features: { platform: true, setup: true } };
const SETUP_OFF = { features: { platform: false, setup: false } };
const STEP_IDS = ["prereq", "deps", "download-cli", "storage", "images", "tts", "exposure", "ops", "start", "first-model"];
const TITLES = {
  prereq: ["检查环境", "Check prerequisites"], deps: ["安装依赖", "Install dependencies"], "download-cli": ["下载工具", "Download tool"],
  storage: ["存储位置", "Storage locations"], images: ["预拉取运行时", "Pre-pull runtimes"], tts: ["语音（可选）", "Voice (optional)"],
  exposure: ["访问范围", "Access"], ops: ["自动运行", "Automation"], start: ["启动平台", "Start the platform"], "first-model": ["部署第一个模型", "Deploy a first model"],
};
const OPTIONAL = new Set(["download-cli", "tts", "ops", "first-model"]);
const OPS_COMMANDS = ["platform autostart enable", "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\backup-platform.ps1 -Register", "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\nightly-e2e.ps1 -Register"];

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

function step(id, status = "todo", extra = {}) {
  const index = STEP_IDS.indexOf(id) + 1;
  return {
    id, index, title: { "zh-CN": TITLES[id][0], "en-US": TITLES[id][1] }, optional: OPTIONAL.has(id), status, detail: `${id} detail`,
    recorded: status === "skipped" ? { state: "skipped", at: "2026-10-16T01:00:00.000Z" } : null, ...extra,
  };
}

// The 06 §8 describeSetup() shape with prereq done and everything else open.
function setupBody(overrides = {}, patch = {}) {
  const steps = STEP_IDS.map((id) => {
    if (id === "prereq") return step(id, "done");
    if (id === "storage") return step(id, "todo", { data: { freeBytes: 250_000_000_000, checks: [] } });
    if (id === "images") return step(id, "todo", { data: { runtimes: [{ runtimeId: "vllm-default", engineId: "vllm", present: false, localBuild: false }, { runtimeId: "llama-default", engineId: "llama", present: true, localBuild: false }] } });
    if (id === "exposure") return step(id, "todo", { data: { mode: "local", lanKeys: null, firewall: { id: "open-firewall", risk: "confirm", command: "platform doctor --fix=net.firewall" } } });
    if (id === "ops") return step(id, "todo", { data: { commands: OPS_COMMANDS } });
    return step(id, "todo");
  }).map((item) => ({ ...item, ...(overrides[item.id] || {}) }));
  const current = steps.find((item) => item.status !== "done" && item.status !== "skipped");
  return { steps, completedAt: null, current: current ? current.id : null, ...patch };
}

async function newPage(browser, { bootstrap = SETUP_ON, role = OWNER, api = {}, size = SIZES.desktop, theme = "light", locale = "en-US", prefs = {} } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable", ...prefs }, { baseUrl: entry.url });
  if (prefs.dismissedSetup) {
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("console.prefs.v1", JSON.stringify({ theme: "light", locale: "en-US", density: "comfortable", dismissedSetup: true }));
      } catch {
        // Storage may be blocked; the test then fails on the redirect it expects not to happen.
      }
    });
  }
  await withBootstrap(context, { ...role, ...bootstrap });
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, {
    ...(role === VIEWER ? { "GET /api/session": VIEWER_SESSION } : {}),
    "GET /api/status": { ok: true, managers: [], components: { total: 0, offline: [], unhealthy: [], items: [] } },
    "GET /api/fleet": { updatedAt: new Date().toISOString(), instances: [], settings: {} },
    "GET /api/platform/status": PLATFORM_STATUS,
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/hub/library": { ok: true, entries: [], total: 0 },
    ...api,
  });
  return { context, page, mock, failures };
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const stepOf = (page, id) => byId(page, `setup.step.${id}`);
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const ready = (page) => expect(byId(page, "setup.steps")).toBeVisible();

// ---------------------------------------------------------------------------
// Auto-route

test("an owner with incomplete setup is routed from the landing page to /setup, and sees the ten steps", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, { api: { "GET /api/platform/setup": setupBody() } });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    expect(new URL(page.url()).pathname).toBe("/setup");
    await expect(page.locator("#main h1")).toHaveText("First-run setup");
    await expect(byId(page, "setup.progress")).toContainText("1 of 10 steps done or skipped");
    await expect(page.locator('[data-testid^="setup.step."]')).toHaveCount(10);
    for (const id of STEP_IDS) await expect(stepOf(page, id)).toContainText(TITLES[id][1]);
    await expect(stepOf(page, "prereq")).toHaveAttribute("data-status", "done");
    await expect(stepOf(page, "prereq").locator('[data-testid="setup.status"]')).toContainText("Done");
    await expect(stepOf(page, "deps")).toHaveAttribute("aria-current", "step");
    // One primary action per open step, none on the settled one.
    for (const id of STEP_IDS.filter((item) => item !== "prereq")) await expect(stepOf(page, id).locator("[data-testid^='setup.primary.']")).toHaveCount(1);
    await expect(stepOf(page, "prereq").locator("[data-testid^='setup.primary.']")).toHaveCount(0);
    await expect(stepOf(page, "tts")).toContainText("Optional");
    await expect(page.locator("#main")).not.toHaveText(HAN);
    expect(mock.find("GET", "/api/platform/setup").length).toBeGreaterThan(0);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the page follows the language: zh shows the Chinese step titles and copy", async ({ browser }) => {
  const { context, page } = await newPage(browser, { locale: "zh-CN", api: { "GET /api/platform/setup": setupBody() } });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    await expect(page.locator("#main h1")).toHaveText("首次设置");
    for (const id of STEP_IDS) await expect(stepOf(page, id)).toContainText(TITLES[id][0]);
    await expect(byId(page, "setup.later")).toHaveText("稍后");
    await expect(byId(page, "setup.skip-all")).toHaveText("跳过设置");
  } finally {
    await context.close();
  }
});

for (const [name, options, done] of [
  ["a viewer", { role: VIEWER }, (mock) => expect(mock.find("GET", "/api/platform/setup")).toHaveLength(0)],
  ["setup that is complete", { api: { "GET /api/platform/setup": setupBody({}, { completedAt: "2026-10-16T01:00:00.000Z" }) } }, (mock) => expect(mock.find("GET", "/api/platform/setup").length).toBeGreaterThan(0)],
  ["every step settled", { api: { "GET /api/platform/setup": { steps: STEP_IDS.map((id) => step(id, id === "tts" ? "skipped" : "done")), completedAt: null, current: null } } }, (mock) => expect(mock.find("GET", "/api/platform/setup").length).toBeGreaterThan(0)],
  ["a dismissed setup", { prefs: { dismissedSetup: true }, api: { "GET /api/platform/setup": setupBody() } }, (mock) => expect(mock.find("GET", "/api/platform/setup")).toHaveLength(0)],
  ["a build without the setup backend", { bootstrap: SETUP_OFF, api: { "GET /api/platform/setup": setupBody() } }, (mock) => expect(mock.find("GET", "/api/platform/setup")).toHaveLength(0)],
  ["a setup that cannot be read", { api: { "GET /api/platform/setup": { status: 501, body: { ok: false, error: { code: "setup_unavailable", message: "no" } } } } }, (mock) => expect(mock.find("GET", "/api/platform/setup").length).toBeGreaterThan(0)],
]) {
  test(`${name} stays on Overview`, async ({ browser }) => {
    const { context, page, mock } = await newPage(browser, options);
    try {
      await page.goto(`${entry.url}overview`);
      await expect(page.locator("#main h1")).toBeVisible();
      await page.waitForTimeout(400);
      expect(new URL(page.url()).pathname).toBe("/overview");
      done(mock);
    } finally {
      await context.close();
    }
  });
}

test("a bookmark to another page is not taken away", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: { "GET /api/platform/setup": setupBody() } });
  try {
    await page.goto(`${entry.url}system/preferences`);
    await expect(page.locator("#main h1")).toBeVisible();
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname).toBe("/system/preferences");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Steps and operations

test("a step POST shows the operation's progress from polling and platform events, plus the pull jobs' byte progress", async ({ browser }) => {
  let polls = 0;
  let pulled = false;
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/platform/setup": () => setupBody(pulled ? { images: { status: "done", detail: "pulled" } } : {}),
      "POST /api/platform/setup/images": { status: 202, body: { ok: true, opId: "op_images" } },
      "GET /api/platform/operations/op_images": () => {
        polls += 1;
        if (polls < 3) return { ok: true, operation: { opId: "op_images", kind: "setup", state: "running", progress: 0.4, log: ["vllm-default: pulling"], result: null } };
        pulled = true;
        return { ok: true, operation: { opId: "op_images", kind: "setup", state: "ok", progress: 1, log: ["vllm-default: pulled"], result: null } };
      },
      "GET /api/m/vllm/jobs": { jobs: [{ id: "dl_9", type: "image-pull", state: "running", progress: { percent: 25, bytesDone: 1_000_000_000, bytesTotal: 4_000_000_000 }, meta: { runtimeId: "vllm-default" } }] },
      "GET /api/m/llama/jobs": { jobs: [] },
    },
  });
  try {
    await page.goto(`${entry.url}setup`);
    await ready(page);
    await expect(stepOf(page, "images")).toContainText("vllm-default");
    await expect(byId(page, "setup.engine.vllm")).toBeChecked();
    await expect(byId(page, "setup.engine.llama")).not.toBeChecked();
    await byId(page, "setup.engine.llama").check();
    await byId(page, "setup.primary.images").click();
    await expect(byId(page, "setup.operation")).toBeVisible();
    await expect(byId(page, "setup.operation")).toContainText("Pull runtimes");
    await expect(byId(page, "setup.pull-job")).toContainText("Pulling vllm-default");
    await expect(byId(page, "setup.pull-job")).toContainText("953.7 MiB / 3.7 GiB");
    await expect.poll(() => mock.find("POST", "/api/platform/setup/images").length).toBe(1);
    expect(mock.find("POST", "/api/platform/setup/images")[0].body).toEqual({ engines: ["vllm", "llama"] });
    await expect(stepOf(page, "images")).toHaveAttribute("data-status", "done", { timeout: 15000 });
    await expect(byId(page, "setup.operation")).toHaveCount(0);
    expect(mock.find("GET", "/api/platform/operations/op_images").length).toBeGreaterThanOrEqual(3);
  } finally {
    await context.close();
  }
});

test("a platform event of the operation refreshes it without waiting for the poll", async ({ browser }) => {
  let reads = 0;
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/platform/setup": setupBody(),
      "POST /api/platform/setup/deps": { status: 202, body: { ok: true, opId: "op_deps" } },
      "GET /api/platform/operations/op_deps": () => {
        reads += 1;
        return { ok: true, operation: { opId: "op_deps", kind: "setup", state: "running", progress: 0.5, log: [], result: null } };
      },
    },
  });
  try {
    await page.goto(`${entry.url}setup`);
    await ready(page);
    await byId(page, "setup.primary.deps").click();
    await expect(byId(page, "setup.operation")).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(0);
    expect(mock.find("POST", "/api/platform/setup/deps")[0].body).toEqual({});
    await expect(byId(page, "setup.operation").locator('[role="progressbar"]')).toHaveAttribute("aria-valuenow", "50");
  } finally {
    await context.close();
  }
});

test("a failed step shows its error and a missing supervisor points to System", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: {
      "GET /api/platform/setup": setupBody(),
      "POST /api/platform/setup/start": { status: 503, body: { ok: false, error: { code: "supervisor_unavailable", message: "Starting the platform needs a running supervisor." } } },
      "POST /api/platform/setup/deps": { status: 202, body: { ok: true, opId: "op_bad" } },
      "GET /api/platform/operations/op_bad": { ok: true, operation: { opId: "op_bad", kind: "setup", state: "failed", progress: null, log: ["npm ci failed"], result: { code: "deps_failed", message: "npm ci exited 1" } } },
    },
  });
  try {
    await page.goto(`${entry.url}setup`);
    await ready(page);
    await byId(page, "setup.primary.start").click();
    await expect(byId(page, "setup.error")).toContainText("Start the supervisor on the System page");
    await expect(byId(page, "setup.error-system")).toHaveAttribute("href", "/system");
    await byId(page, "setup.error-dismiss").click();
    await expect(byId(page, "setup.error")).toHaveCount(0);

    await byId(page, "setup.primary.deps").click();
    await expect(byId(page, "operation.failure")).toContainText("deps_failed: npm ci exited 1");
    await expect(byId(page, "operation.log")).toContainText("npm ci failed");
  } finally {
    await context.close();
  }
});

test("a blocked prerequisite lists the manual fix with a copy button", async ({ browser }) => {
  const blocked = step("prereq", "blocked", { data: { blocking: [{ id: "runtime.docker-daemon", detail: "Docker is not running", fix: { id: "start-docker", risk: "manual", command: "Start Docker Desktop" } }] } });
  const { context, page } = await newPage(browser, { api: { "GET /api/platform/setup": setupBody({ prereq: blocked }) } });
  try {
    await page.goto(`${entry.url}setup`);
    await ready(page);
    await expect(stepOf(page, "prereq")).toHaveAttribute("data-status", "blocked");
    await expect(byId(page, "setup.blocking")).toContainText("runtime.docker-daemon");
    await expect(byId(page, "setup.blocking")).toContainText("Docker is not running");
    await expect(byId(page, "setup.blocking-command")).toContainText("Start Docker Desktop");
    await expect(stepOf(page, "prereq")).toHaveAttribute("aria-current", "step");
  } finally {
    await context.close();
  }
});

test("the ops step only shows its commands: nothing is posted until the owner says they ran them", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: { "GET /api/platform/setup": setupBody(), "POST /api/platform/setup/ops": { status: 202, body: { ok: true, opId: "op_ops" } }, "GET /api/platform/operations/op_ops": { ok: true, operation: { opId: "op_ops", kind: "setup", state: "ok", progress: 1, log: [], result: null } } },
  });
  try {
    await page.goto(`${entry.url}setup`);
    await ready(page);
    const commands = byId(page, "setup.ops-command");
    await expect(commands).toHaveCount(3);
    await expect(commands.first()).toContainText("platform autostart enable");
    await expect(stepOf(page, "ops")).toContainText("The console never installs scheduled tasks");
    expect(mock.find("POST", "/api/platform/setup")).toHaveLength(0);
    await byId(page, "setup.primary.ops").click();
    await expect.poll(() => mock.find("POST", "/api/platform/setup/ops").length).toBe(1);
    expect(mock.find("POST", "/api/platform/setup/ops")[0].body).toEqual({ done: true });
  } finally {
    await context.close();
  }
});

test("the exposure step sends the chosen mode, shows the LAN caution and the firewall command, and links to public go-live", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    api: { "GET /api/platform/setup": setupBody(), "POST /api/platform/setup/exposure": { status: 202, body: { ok: true, opId: "op_exp" } }, "GET /api/platform/operations/op_exp": { ok: true, operation: { opId: "op_exp", kind: "setup", state: "running", progress: null, log: [], result: null } } },
  });
  try {
    await page.goto(`${entry.url}setup`);
    await ready(page);
    await expect(byId(page, "setup.exposure.local")).toBeChecked();
    await expect(byId(page, "setup.exposure-lan")).toHaveCount(0);
    await expect(byId(page, "setup.public-link")).toHaveAttribute("href", "/access/public?from=setup");
    await byId(page, "setup.exposure.lan").check();
    await expect(byId(page, "setup.exposure-lan")).toContainText("needs an active API key");
    await expect(byId(page, "setup.firewall-command")).toContainText("platform doctor --fix=net.firewall");
    await byId(page, "setup.primary.exposure").click();
    await expect.poll(() => mock.find("POST", "/api/platform/setup/exposure").length).toBe(1);
    expect(mock.find("POST", "/api/platform/setup/exposure")[0].body).toEqual({ mode: "lan" });
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Skip

test("Skip this step posts {skip:true} and the step stays skipped on the next read", async ({ browser }) => {
  let skipped = false;
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/platform/setup": () => setupBody(skipped ? { tts: { status: "skipped", recorded: { state: "skipped", at: "2026-10-16T01:00:00.000Z" } } } : {}),
      "POST /api/platform/setup/tts": () => {
        skipped = true;
        return { status: 202, body: { ok: true, opId: "op_skip" } };
      },
      "GET /api/platform/operations/op_skip": { ok: true, operation: { opId: "op_skip", kind: "setup", state: "ok", progress: 1, log: [], result: null } },
    },
  });
  try {
    await page.goto(`${entry.url}setup`);
    await ready(page);
    await byId(page, "setup.skip.tts").click();
    await expect.poll(() => mock.find("POST", "/api/platform/setup/tts").length).toBe(1);
    expect(mock.find("POST", "/api/platform/setup/tts")[0].body).toEqual({ skip: true });
    await expect(stepOf(page, "tts")).toHaveAttribute("data-status", "skipped");
    await expect(byId(page, "setup.progress")).toContainText("2 of 10");
    await page.reload();
    await ready(page);
    await expect(stepOf(page, "tts")).toHaveAttribute("data-status", "skipped");
    await expect(stepOf(page, "tts").locator("[data-testid^='setup.primary.']")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("Skip setup asks first, posts to the all step and ends the wizard", async ({ browser }) => {
  let finished = false;
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/platform/setup": () => (finished
        ? { steps: STEP_IDS.map((id) => step(id, id === "prereq" ? "done" : "skipped")), completedAt: "2026-10-16T02:00:00.000Z", current: null }
        : setupBody()),
      "POST /api/platform/setup/all": () => {
        finished = true;
        return { status: 202, body: { ok: true, opId: "op_all" } };
      },
      "GET /api/platform/operations/op_all": { ok: true, operation: { opId: "op_all", kind: "setup", state: "ok", progress: 1, log: [], result: null } },
    },
  });
  try {
    await page.goto(`${entry.url}setup`);
    await ready(page);
    await byId(page, "setup.skip-all").click();
    await expect(byId(page, "setup.skip-all-dialog")).toBeVisible();
    expect(mock.find("POST", "/api/platform/setup/all")).toHaveLength(0);
    await byId(page, "setup.skip-all-dialog").locator('[data-testid="dialog.confirm"]').click();
    await expect(byId(page, "setup.complete")).toBeVisible();
    expect(mock.find("POST", "/api/platform/setup/all")[0].body).toEqual({ skip: true });
    await expect(byId(page, "setup.skip-all")).toHaveCount(0);
    // Done: opening the console no longer routes to /setup.
    await page.goto(`${entry.url}overview`);
    await expect(page.locator("#main h1")).toBeVisible();
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname).toBe("/overview");
  } finally {
    await context.close();
  }
});

test("Skip for now remembers the choice: the console opens on Overview next time", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: { "GET /api/platform/setup": setupBody() } });
  try {
    await page.goto(`${entry.url}overview`);
    await ready(page);
    await byId(page, "setup.later").click();
    await expect(page).toHaveURL(/\/overview$/);
    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("console.prefs.v1") || "{}"));
    expect(stored.dismissedSetup).toBe(true);
    const before = mock.find("GET", "/api/platform/setup").length;
    await page.goto(`${entry.url}overview`);
    await expect(page.locator("#main h1")).toBeVisible();
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname).toBe("/overview");
    expect(mock.find("GET", "/api/platform/setup").length).toBe(before);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Composition

test("storage and first-model hand off with ?from=setup, and the first model is seeded from the library", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    bootstrap: { features: { platform: true, setup: true, hub: true } },
    api: { "GET /api/platform/setup": setupBody(), "GET /api/hub/library": { ok: true, entries: [{ id: "lib_1", kind: "folder", path: "X:/models/Qwen3-8B", displayName: "Qwen3-8B" }], total: 1 } },
  });
  try {
    await page.goto(`${entry.url}setup`);
    await ready(page);
    await expect(byId(page, "setup.primary.storage")).toHaveAttribute("href", "/models/storage?from=setup");
    await expect(byId(page, "setup.free")).toContainText("Free space");
    await expect(byId(page, "setup.primary.first-model")).toHaveAttribute("href", `/deployments/new?model=${encodeURIComponent("X:/models/Qwen3-8B")}&from=setup`);
  } finally {
    await context.close();
  }
});

for (const [path, name] of [["system/preferences", "Preferences"], ["overview", "Overview"], ["deployments/new", "Deploy wizard"]]) {
  test(`?from=setup shows the back bar on ${name} and Back to setup returns`, async ({ browser }) => {
    const { context, page } = await newPage(browser, { bootstrap: { features: { platform: true, setup: true, engines: true } }, prefs: { dismissedSetup: true }, api: { "GET /api/platform/setup": setupBody() } });
    try {
      await page.goto(`${entry.url}${path}?from=setup`);
      await expect(byId(page, "setup-return-bar")).toBeVisible();
      await expect(byId(page, "setup-return-bar")).toContainText("Back to setup");
      await byId(page, "setup-return-bar.link").click();
      await ready(page);
      expect(new URL(page.url()).pathname).toBe("/setup");
      await expect(byId(page, "setup-return-bar")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

test("without ?from=setup there is no back bar, and the palette and the strip lead back to /setup", async ({ browser }) => {
  const { context, page } = await newPage(browser, { prefs: { dismissedSetup: true }, api: { "GET /api/platform/setup": setupBody() } });
  try {
    await page.goto(`${entry.url}overview`);
    await expect(page.locator("#main h1")).toBeVisible();
    await expect(byId(page, "setup-return-bar")).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("setup");
    await page.getByRole("option", { name: /First-run setup/ }).click();
    await ready(page);
    expect(new URL(page.url()).pathname).toBe("/setup");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Before 06

test("before P6 the page is a five-item checklist from status, fleet, library and keys, each linking to its page", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, {
    bootstrap: { features: { platform: false, setup: false, hub: true } },
    api: {
      "GET /api/status": { ok: true, managers: [{ id: "vllm", ok: true }], components: { total: 1, offline: [], unhealthy: [], items: [] } },
      "GET /api/fleet": { updatedAt: new Date().toISOString(), gpuMemory: { usedMb: 0, totalMb: 24000 }, instances: [{ id: "vllm:primary", lifecycleState: "stopped", running: false, models: [] }], settings: {} },
      "GET /api/hub/library": { ok: true, entries: [], total: 0 },
      "GET /api/keys": { ok: true, keys: { clients: [] } },
    },
  });
  try {
    await page.goto(`${entry.url}setup`);
    await expect(byId(page, "setup.checklist")).toBeVisible();
    await expect(page.locator("#main h1")).toHaveText("First-run setup");
    await expect(page.locator('[data-testid^="setup.check."]:not([data-testid^="setup.check-link"])')).toHaveCount(5);
    const state = (id) => byId(page, `setup.check.${id}`).getAttribute("data-state");
    expect(await Promise.all(["docker", "gpu", "model", "serving", "key"].map(state))).toEqual(["ok", "ok", "todo", "todo", "todo"]);
    await expect(byId(page, "setup.check-link.model")).toHaveAttribute("href", "/models/discover?from=setup");
    await expect(byId(page, "setup.check-link.serving")).toHaveAttribute("href", "/deployments/new?from=setup");
    await expect(byId(page, "setup.check-link.key")).toHaveAttribute("href", "/access?from=setup");
    await expect(byId(page, "setup.check-link.docker")).toHaveCount(0);
    expect(mock.find("GET", "/api/platform/setup")).toHaveLength(0);
    expect(mock.find("POST", "/api/platform")).toHaveLength(0);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
    // Not routed automatically before P6.
    await page.goto(`${entry.url}overview`);
    await expect(page.locator("#main h1")).toBeVisible();
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe("/overview");
  } finally {
    await context.close();
  }
});

test("the checklist degrades to unknown when a call fails, and never blocks the page", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    bootstrap: SETUP_OFF,
    api: { "GET /api/status": { status: 500, body: { ok: false, error: { code: "boom", message: "x" } } }, "GET /api/keys": { status: 500, body: { ok: false, error: { code: "boom", message: "x" } } } },
  });
  try {
    await page.goto(`${entry.url}setup`);
    await expect(byId(page, "setup.checklist")).toBeVisible();
    await expect(byId(page, "setup.check.docker")).toHaveAttribute("data-state", "unknown");
    await expect(byId(page, "setup.check.key")).toHaveAttribute("data-state", "unknown");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Layout and accessibility

for (const theme of ["light", "dark"]) {
  for (const [name, size] of Object.entries(SIZES)) {
    test(`the wizard has no overflow and no axe violations (${theme}, ${name})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, { size, theme, api: { "GET /api/platform/setup": setupBody() } });
      try {
        await page.goto(`${entry.url}setup`);
        await ready(page);
        await byId(page, "setup.exposure.lan").check();
        await expectNoOverflow(page);
        await expectNoA11yViolations(page, { label: `setup ${theme} ${name}` });
      } finally {
        await context.close();
      }
    });
  }
}

test("the checklist has no overflow and no axe violations at 390 px", async ({ browser }) => {
  const { context, page } = await newPage(browser, { size: SIZES.phone, bootstrap: SETUP_OFF });
  try {
    await page.goto(`${entry.url}setup`);
    await expect(byId(page, "setup.checklist")).toBeVisible();
    await expectNoOverflow(page);
    await expectNoA11yViolations(page, { label: "setup checklist phone" });
  } finally {
    await context.close();
  }
});
