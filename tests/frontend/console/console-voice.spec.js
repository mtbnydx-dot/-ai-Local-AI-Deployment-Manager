// CON-23 browser checks (07 §13.2 console-voice, §6.12): the engine cards come
// from /api/status, lifecycle actions POST with x-csrf-token and no key, Unload
// and Stop ask first, a 401 before `console-session` shows the pairing-or-key
// hint, and /gateway/tts/api/jobs is never requested. The real service-entry
// serves the console; the API is mocked in the browser (helpers/console-harness.js).
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { collectFailures, expectNoOverflow, mockConsoleApi, setPrefs, startEntry } = require("../helpers/console-harness.js");

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "console");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = { role: "owner", auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" } };
const VIEWER = { role: "viewer", auth: { mode: "session", session: { role: "viewer", via: "none", paired: false, autoPairAvailable: false }, csrf: null } };
const ACTION = "/gateway/tts/api/models/voxcpm2/actions";

const TTS = {
  online: true,
  listening: true,
  healthy: true,
  engines: [
    { id: "voxcpm2", name: "VoxCPM 2", type: "docker", available: false, detail: "Image not started" },
    { id: "cosyvoice", name: "CosyVoice", type: "local", available: true, detail: "Model loaded" },
    { id: "cloud-tts", name: "Cloud TTS", type: "api", available: true, detail: "" },
  ],
};

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

/** Serves the console with the given bootstrap fields (the page and GET /api/console/bootstrap). */
async function withBootstrap(context, patch) {
  const merge = (base) => {
    const next = { ...base, ...patch };
    for (const name of ["features", "auth", "access", "gateway"]) if (patch[name]) next[name] = { ...base[name], ...patch[name] };
    return next;
  };
  const guarded = (handler) => async (route) => {
    try {
      await handler(route);
    } catch (error) {
      if (!/disposed|closed|aborted/i.test(String(error?.message))) throw error;
    }
  };
  await context.route((url) => url.pathname === "/api/console/bootstrap", guarded(async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: JSON.stringify(merge(await response.json())) });
  }));
  await context.route((url) => !/^\/(api|c|gateway)\//.test(url.pathname), guarded(async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    const body = (await response.text()).replace(BOOTSTRAP_BLOCK, (match, open, json, close) => (
      `${open}${JSON.stringify(merge(JSON.parse(json))).replace(/</g, "\\u003c")}${close}`));
    return route.fulfill({ response, body });
  }));
}

async function openVoice(browser, { bootstrap = OWNER, api = {}, tts = TTS, locale = "en-US", size = { width: 1440, height: 960 } } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: "light", locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme: "light", locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, bootstrap);
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const requests = [];
  page.on("request", (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  const mock = await mockConsoleApi(page, {
    "GET /api/status": () => ({ ...fixture("status"), tts }),
    "GET /api/fleet": fixture("fleet"),
    ...api,
  });
  await page.goto(`${entry.url}voice`);
  return { context, page, mock, failures, requests };
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const card = (page, id) => byId(page, `voice.engine.${id}`);
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));

test("cards come from /api/status with the actions each engine state allows", async ({ browser }) => {
  const { context, page, failures } = await openVoice(browser);
  try {
    await expect(page.locator("#main h1")).toHaveText("Voice");
    await expect(page).toHaveTitle("Voice · Local AI Platform");
    await expect(page.locator('[data-testid^="voice.engine."]')).toHaveCount(3);
    await expect(card(page, "voxcpm2")).toContainText("VoxCPM 2");
    await expect(card(page, "voxcpm2")).toContainText("Offline");
    await expect(card(page, "voxcpm2")).toContainText("Image not started");
    await expect(card(page, "voxcpm2").locator('[data-testid^="voice.action."]')).toHaveText(["Install", "Start", "Wake"]);
    await expect(card(page, "cosyvoice")).toContainText("Online");
    await expect(card(page, "cosyvoice").locator('[data-testid^="voice.action."]')).toHaveText(["Wake", "Unload", "Stop"]);
    await expect(card(page, "cloud-tts").locator('[data-testid^="voice.action."]')).toHaveCount(0);
    const workbench = byId(page, "voice.workbench");
    await expect(workbench).toHaveAttribute("href", "/gateway/tts/");
    await expect(workbench).toHaveAttribute("target", "_blank");
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("an action POSTs with x-csrf-token and no key, and refreshes the status", async ({ browser }) => {
  const { context, page, mock } = await openVoice(browser, {
    api: { [`POST ${ACTION}/wake`]: { ok: true, operation: { status: "queued" } } },
  });
  try {
    await expect(card(page, "voxcpm2")).toBeVisible();
    const before = mock.find("GET", "/api/status").length;
    await card(page, "voxcpm2").locator('[data-testid="voice.action.wake"]').click();
    await expect(byId(page, "toast.root")).toContainText("Action started.");
    const posts = mock.find("POST", "/gateway/tts/");
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(`${ACTION}/wake`);
    expect(posts[0].headers["x-csrf-token"]).toBe("t");
    expect(posts[0].headers.authorization).toBeUndefined();
    expect(posts[0].headers["x-api-key"]).toBeUndefined();
    expect(posts[0].body).toBeNull();
    await expect.poll(() => mock.find("GET", "/api/status").length).toBeGreaterThan(before);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Unload and Stop ask first; cancel sends nothing, confirm sends once", async ({ browser }) => {
  const { context, page, mock } = await openVoice(browser, {
    api: {
      "POST /gateway/tts/api/models/cosyvoice/actions/unload": { ok: true },
      "POST /gateway/tts/api/models/cosyvoice/actions/stop": { ok: true },
    },
  });
  try {
    const row = card(page, "cosyvoice");
    await row.locator('[data-testid="voice.action.unload"]').click();
    const dialog = byId(page, "voice.confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Unload this voice model?");
    await expect(dialog).toContainText("CosyVoice");
    await byId(page, "dialog.cancel").click();
    await expect(dialog).toHaveCount(0);
    expect(mock.find("POST", "/gateway/tts/")).toHaveLength(0);

    await row.locator('[data-testid="voice.action.unload"]').click();
    await byId(page, "dialog.confirm").click();
    await expect(dialog).toHaveCount(0);
    expect(mock.find("POST", "/gateway/tts/").map((call) => call.path)).toEqual(["/gateway/tts/api/models/cosyvoice/actions/unload"]);

    await row.locator('[data-testid="voice.action.stop"]').click();
    await expect(byId(page, "voice.confirm")).toContainText("Stop this voice service?");
    expect(mock.find("POST", "/gateway/tts/")).toHaveLength(1);
    await byId(page, "dialog.confirm").click();
    await expect(byId(page, "voice.confirm")).toHaveCount(0);
    expect(mock.find("POST", "/gateway/tts/").map((call) => call.path.split("/").pop())).toEqual(["unload", "stop"]);
  } finally {
    await context.close();
  }
});

test("before console-session a 401 shows the pairing-or-key hint and the workbench link", async ({ browser }) => {
  const denied = { status: 401, body: { ok: false, error: { code: "api_key_required", message: "An API key is required." } } };
  const { context, page, mock } = await openVoice(browser, {
    bootstrap: { ...OWNER, gateway: { consoleSession: false } },
    api: { [`POST ${ACTION}/start`]: denied },
  });
  try {
    await card(page, "voxcpm2").locator('[data-testid="voice.action.start"]').click();
    const hint = byId(page, "voice.needs-auth");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("Needs pairing or an API key");
    await expect(hint.locator("a")).toHaveAttribute("href", "/gateway/tts/");
    expect(mock.find("POST", "/gateway/tts/")).toHaveLength(1);
    expect(mock.find("POST", "/gateway/tts/")[0].headers.authorization).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("with console-session on, a 401 is a plain error toast and no hint", async ({ browser }) => {
  const denied = { status: 401, body: { ok: false, error: { code: "api_key_required", message: "An API key is required." } } };
  const { context, page } = await openVoice(browser, {
    bootstrap: { ...OWNER, gateway: { consoleSession: true } },
    api: { [`POST ${ACTION}/start`]: denied },
  });
  try {
    await card(page, "voxcpm2").locator('[data-testid="voice.action.start"]').click();
    await expect(byId(page, "toast.root").first()).toContainText("An API key is required.");
    await expect(byId(page, "voice.needs-auth")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the page never requests /gateway/tts/api/jobs, even across status refreshes", async ({ browser }) => {
  const { context, page, requests, mock } = await openVoice(browser, {
    api: { [`POST ${ACTION}/wake`]: { ok: true } },
  });
  try {
    await expect(card(page, "voxcpm2")).toBeVisible();
    await card(page, "voxcpm2").locator('[data-testid="voice.action.wake"]').click();
    await expect.poll(() => mock.find("GET", "/api/status").length).toBeGreaterThan(1);
    expect(requests.filter((item) => item.includes("/gateway/tts/api/jobs"))).toEqual([]);
    expect(mock.calls.filter((call) => call.path.includes("/api/jobs"))).toEqual([]);
    expect(mock.unmocked.filter((item) => item.includes("/gateway/"))).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a viewer sees the cards but cannot act; a stopped TTS service shows its own empty state", async ({ browser }) => {
  const viewer = await openVoice(browser, { bootstrap: VIEWER });
  try {
    await expect(card(viewer.page, "voxcpm2")).toBeVisible();
    await expect(byId(viewer.page, "voice.viewer-note")).toBeVisible();
    await expect(card(viewer.page, "voxcpm2").locator('[data-testid="voice.action.wake"]')).toBeDisabled();
  } finally {
    await viewer.context.close();
  }
  const down = await openVoice(browser, { tts: { online: false, listening: false, healthy: false, engines: [], error: "TTS gateway is not listening on port 1." } });
  try {
    await expect(byId(down.page, "empty-state.root")).toContainText("The voice service is not running");
    await expect(byId(down.page, "empty-state.root")).toContainText("not listening");
    await expect(byId(down.page, "empty-state.action")).toHaveAttribute("href", "/gateway/tts/");
  } finally {
    await down.context.close();
  }
});

test("Chinese copy and the 390 px layout", async ({ browser }) => {
  const { context, page } = await openVoice(browser, { locale: "zh-CN", size: { width: 390, height: 844 } });
  try {
    await expect(page.locator("#main h1")).toHaveText("语音");
    await expect(byId(page, "voice.workbench")).toHaveText("打开语音工作台");
    await expect(card(page, "voxcpm2").locator('[data-testid^="voice.action."]')).toHaveText(["安装", "启动", "唤醒"]);
    await expect(card(page, "cosyvoice").locator('[data-testid="voice.action.unload"]')).toHaveText("卸载");
    await expectNoOverflow(page);
  } finally {
    await context.close();
  }
});
