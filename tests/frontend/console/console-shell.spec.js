// CON-6 browser checks (07 §13.2 console-shell): navigation and deep links,
// legacy hashes, pairing (`#pair=` stripped, 401 -> PairingScreen, viewer locks),
// the StatusStrip from a PlatformStatus fixture and from the pre-06 derivation,
// the palette, notifications, the event stream (503 -> polling -> recovery,
// resync), the 410 update banner, preferences, English and Chinese passes, and
// the 390 px layout. The real service-entry serves the console; the API is
// mocked in the browser (helpers/console-harness.js).
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
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const HAN = /\p{Script=Han}/u;
const RAW_KEY = /\b(?:shell|platform|notify|pair|common|uikit)\.[a-z][A-Za-z.-]+/;
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;

const OWNER = { role: "owner", auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" } };
const VIEWER = { role: "viewer", auth: { mode: "session", session: { role: "viewer", via: "none", paired: false, autoPairAvailable: false }, csrf: null } };
const PLATFORM_ON = { features: { platform: true } };
const SESSION_UNPAIRED = { ok: true, role: "viewer", via: "none", paired: false, csrfToken: null, autoPairAvailable: false, pairCommand: "platform admin pair" };

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

/**
 * Serves the console with the given bootstrap fields, in the shell's embedded copy and on
 * GET /api/console/bootstrap. The real entry makes a loopback browser with no session a
 * viewer, so every spec states the role it tests. `patch` may be a function, read per request.
 */
async function withBootstrap(context, patch) {
  const read = () => (typeof patch === "function" ? patch() : patch);
  // A page that closes while a request is in flight disposes the response; that is not a failure.
  const guarded = (handler) => async (route) => {
    try {
      await handler(route);
    } catch (error) {
      if (!/disposed|closed|aborted/i.test(String(error?.message))) throw error;
    }
  };
  await context.route((url) => url.pathname === "/api/console/bootstrap", guarded(async (route) => {
    const response = await route.fetch();
    const patched = JSON.stringify(merge(await response.json(), read()));
    await route.fulfill({ response, body: patched });
  }));
  await context.route((url) => !/^\/(api|c|gateway)\//.test(url.pathname), guarded(async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.text()).replace(BOOTSTRAP_BLOCK, (match, open, json, close) => (
      `${open}${JSON.stringify(merge(JSON.parse(json), read())).replace(/</g, "\\u003c")}${close}`));
    await route.fulfill({ response, body });
  }));
}

async function newPage(browser, { prefs = {}, bootstrap = { ...OWNER, ...PLATFORM_ON }, api = {}, size = SIZES.desktop, theme = "light", locale = "en-US", javaScriptEnabled = true } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce", javaScriptEnabled });
  await setPrefs(context, { theme, locale, density: "comfortable", ...prefs }, { baseUrl: entry.url });
  await withBootstrap(context, bootstrap);
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, {
    "GET /api/status": fixture("status"),
    "GET /api/fleet": fixture("fleet"),
    "GET /api/platform/status": fixture("platform-status"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    ...api,
  });
  return { context, page, mock, failures };
}

// A page that is not in the build yet (every route but the ones CON-6 ships) logs a 404 for its module.
const realFailures = (failures) => failures.failures.filter((item) => !/\/routes\/|Failed to load resource/.test(item));
const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const nav = (page, name = "Main navigation") => page.getByRole("navigation", { name });
const mainText = (page) => page.locator("#app").innerText();

function sse(id, type, data) {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id, type, at: "2026-10-14T08:00:00.000Z", source: "entry", data })}\n\n`;
}

const STREAM_HEADERS = { "cache-control": "no-store" };

// ---------------------------------------------------------------------------
// Navigation

test("nav marks the current section, keeps one h1 focus and survives a deep-link reload", async ({ browser }) => {
  const { context, page, failures } = await newPage(browser);
  try {
    await page.goto(`${entry.url}deployments/vllm%3Aprimary`);
    const sidebar = nav(page);
    await expect(sidebar.getByRole("link", { name: "Deployments" })).toHaveAttribute("aria-current", "page");
    await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(sidebar.locator("a[data-nav]")).toHaveCount(12);
    await expect(sidebar.getByRole("list")).toHaveCount(4);
    await expect(page).toHaveTitle("Deployments · Local AI Platform");
    await expect(page.locator("#main h1")).toBeFocused();
    await expect(byId(page, "app-shell.live")).toHaveText("Deployments · Local AI Platform");

    await page.reload();
    await expect(nav(page).getByRole("link", { name: "Deployments" })).toHaveAttribute("aria-current", "page");
    expect(new URL(page.url()).pathname).toBe("/deployments/vllm%3Aprimary");

    // In-place navigation: no document load, the title and focus follow.
    await page.evaluate(() => {
      window.__marker = "kept";
    });
    await nav(page).getByRole("link", { name: "Voice" }).click();
    await expect(page).toHaveURL(/\/voice$/);
    await expect(nav(page).getByRole("link", { name: "Voice" })).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveTitle("Voice · Local AI Platform");
    expect(await page.evaluate(() => window.__marker)).toBe("kept");
    await page.goBack();
    await expect(page).toHaveURL(/\/deployments\/vllm%3Aprimary$/);
    expect(await page.evaluate(() => window.__marker)).toBe("kept");
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the skip link reaches the main landmark and a classic link leaves the console", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await page.goto(`${entry.url}overview`);
    // Focus follows the page heading after load, so the skip link is focused the way a keyboard user reaches it.
    await expect(page.locator("#main h1")).toBeFocused();
    await byId(page, "app-shell.skip").focus();
    await expect(byId(page, "app-shell.skip")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
    expect(new URL(page.url()).hash).toBe("#main");
    await expect(byId(page, "sidebar.classic")).toHaveAttribute("href", "/classic");
  } finally {
    await context.close();
  }
});

test("an unknown path under a console prefix shows the not-found page", async ({ browser }) => {
  const { context, page, failures } = await newPage(browser);
  try {
    await page.goto(`${entry.url}overview/nothing-here`);
    await expect(page.locator("#main h1")).toHaveText("Page not found");
    await expect(page).toHaveTitle("Page not found · Local AI Platform");
    await page.getByRole("link", { name: "Go to Overview" }).click();
    await expect(page).toHaveURL(/\/overview$/);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("legacy hashes redirect to clean paths and / opens the overview", async ({ browser }) => {
  const cases = [
    ["#models", /\/deployments$/],
    ["#tasks", /\/models\/downloads$/],
    ["#operations", /\/system$/],
    ["?from=vllm#download", /\/models\/discover$/],
    ["?from=llama#logs", /\/deployments\?manager=llama&tab=logs$/],
    ["", /\/overview$/],
  ];
  for (const [suffix, expected] of cases) {
    const { context, page } = await newPage(browser);
    try {
      await page.goto(`${entry.url}${suffix}`);
      await expect(page, suffix || "/").toHaveURL(expected);
      await expect(page.locator("#main h1")).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

test("a delivered page module loads inside the shell with no CSP violation", async ({ browser }) => {
  const { context, page, failures } = await newPage(browser);
  try {
    await page.goto(`${entry.url}system/ui-kit`);
    await expect(page.locator('#main [data-ready="true"]')).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "System" })).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveTitle("UI kit · Local AI Platform");
    await failures.expectNone();
  } finally {
    await context.close();
  }
});

test("a page that is not in the build shows the still-being-built page, and a redeploy shows the update banner instead", async ({ browser }) => {
  let redeployed = false;
  const { context, page } = await newPage(browser, { bootstrap: () => ({ ...OWNER, ...PLATFORM_ON, ...(redeployed ? { buildId: "ffffffffffff" } : {}) }) });
  try {
    await page.goto(`${entry.url}system/ui-kit`);
    await expect(page.locator('#main [data-ready="true"]')).toBeVisible();
    await nav(page).getByRole("link", { name: "Models", exact: true }).click();
    await expect(byId(page, "app-shell.pending")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the classic console" })).toHaveAttribute("href", "/classic");
    await expect(byId(page, "app-shell.update")).toHaveCount(0);

    redeployed = true;
    await nav(page).getByRole("link", { name: "Audit" }).click();
    await expect(byId(page, "app-shell.update")).toBeVisible();
    await expect(byId(page, "app-shell.update")).toContainText("The console was updated. Reload to use the new version.");
  } finally {
    await context.close();
  }
});

test("a 410 console_stale answer raises the update banner", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    api: { "GET /api/fleet": { status: 410, body: { ok: false, error: { code: "console_stale", message: "old build", hint: "reload" } } } },
  });
  try {
    await page.goto(`${entry.url}overview`);
    await expect(byId(page, "app-shell.update")).toBeVisible();
    await expect(byId(page, "app-shell.reload")).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Pairing and roles

test("#pair= is stripped before anything else and the code is sent once, in the POST body", async ({ browser }) => {
  const code = "abcd1234efgh5678";
  let paired = false;
  const { context, page } = await newPage(browser, { bootstrap: () => (paired ? { ...OWNER, ...PLATFORM_ON } : { ...VIEWER, ...PLATFORM_ON }) });
  const requests = [];
  const logs = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("console", (message) => logs.push(message.text()));
  let body = null;
  await page.route("**/api/session/pair", async (route) => {
    body = route.request().postDataJSON();
    // Held back, so the address bar can be checked while the pairing request is in flight.
    await new Promise((resolve) => setTimeout(resolve, 500));
    paired = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, csrfToken: "t" }) });
  });
  try {
    const sent = page.waitForRequest("**/api/session/pair");
    await page.goto(`${entry.url}overview#pair=${code}`);
    await sent;
    expect(new URL(page.url()).hash).toBe("");
    expect(page.url()).not.toContain(code);
    await expect.poll(() => body).toEqual({ code });
    await expect(nav(page).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await expect(byId(page, "app-shell.readonly")).toHaveCount(0);
    await expect(byId(page, "pairing-screen.root")).toHaveCount(0);
    expect(requests.filter((url) => url.includes(code) || url.includes("pair="))).toEqual([]);
    expect(logs.filter((line) => line.includes(code))).toEqual([]);
    const stored = await page.evaluate(() => ({ local: JSON.stringify({ ...window.localStorage }), session: JSON.stringify({ ...window.sessionStorage }), cookie: document.cookie, hash: location.hash }));
    expect(`${stored.local}${stored.session}${stored.cookie}${stored.hash}`).not.toContain(code);
  } finally {
    await context.close();
  }
});

test("an invalid pairing code shows the PairingScreen with the invalid message", async ({ browser }) => {
  const { context, page } = await newPage(browser, { bootstrap: { ...VIEWER, ...PLATFORM_ON }, api: { "GET /api/session": SESSION_UNPAIRED } });
  await page.route("**/api/session/pair", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "pair_code_invalid" } }) }));
  try {
    await page.goto(`${entry.url}overview#pair=zzzz9999`);
    await expect(byId(page, "pairing-screen.root")).toBeVisible();
    await expect(byId(page, "pairing-screen.problem")).toContainText("invalid or has already been used");
    expect(new URL(page.url()).hash).toBe("");
    await expect(byId(page, "pairing-screen.command")).toContainText("platform admin pair");
  } finally {
    await context.close();
  }
});

test("a 401 shows the PairingScreen over the page; Retry re-reads the session and reloads once paired", async ({ browser }) => {
  let paired = false;
  const { context, page } = await newPage(browser, {
    bootstrap: () => ({ ...OWNER, ...PLATFORM_ON }),
    api: {
      "GET /api/status": () => (paired ? fixture("status") : { status: 401, body: { ok: false, error: { code: "admin_session_required", message: "pair first" } } }),
      "GET /api/session": () => (paired ? fixture("session") : SESSION_UNPAIRED),
    },
  });
  try {
    await page.goto(`${entry.url}overview`);
    await expect(byId(page, "pairing-screen.root")).toBeVisible();
    await expect(byId(page, "pairing-screen.body")).toContainText("This browser is not paired with the console yet.");
    await expect(byId(page, "pairing-screen.body")).toContainText("platform admin pair");
    await expect(page.locator("#main h1")).toHaveText("This browser is not paired yet");
    // It never asks for a password or a code.
    await expect(page.locator("#main input")).toHaveCount(0);

    await byId(page, "pairing-screen.retry").click();
    await expect(byId(page, "pairing-screen.still")).toBeVisible();

    paired = true;
    const reloaded = page.waitForEvent("load");
    await byId(page, "pairing-screen.retry").click();
    await reloaded;
    await expect(nav(page).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await expect(byId(page, "pairing-screen.root")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a viewer sees read-only banners, locks and the PairingScreen on owner-only routes, and no write controls", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, {
    bootstrap: { ...VIEWER, ...PLATFORM_ON },
    api: { "GET /api/session": SESSION_UNPAIRED, events: fixture("events") },
  });
  try {
    await page.goto(`${entry.url}overview`);
    await expect(byId(page, "app-shell.readonly")).toContainText("Read-only: pair this browser to make changes");
    const locked = ["models", "engines", "observability", "audit", "alerts", "billing"];
    for (const id of locked) await expect(byId(page, `sidebar.link.${id}`)).toHaveAttribute("data-locked", "true");
    for (const id of ["overview", "deployments", "playground", "voice", "system"]) await expect(byId(page, `sidebar.link.${id}`)).not.toHaveAttribute("data-locked", "true");
    await expect(byId(page, "sidebar.link.models")).toContainText("Owner only");
    await expect(byId(page, "sidebar.link.access")).toHaveAttribute("href", "/access/clients");

    // Owner-only route: the PairingScreen instead of the page.
    await nav(page).getByRole("link", { name: "Models" }).click();
    await expect(byId(page, "pairing-screen.root")).toBeVisible();
    await expect(page.locator("#main h1")).toHaveText("This browser is not paired yet");

    // The strip shows its layers without actions.
    await byId(page, "status-strip.layer.serving").click();
    await expect(byId(page, "status-strip.layer.serving.panel")).toContainText("no model is serving yet");
    await expect(page.locator('[data-testid^="status-strip.action."]')).toHaveCount(0);
    await page.keyboard.press("Escape");

    // A viewer's stream carries no notification, so the bell stays empty.
    await expect(byId(page, "notification-center.bell")).toHaveAttribute("aria-label", "Notifications, 0 unread");
    await byId(page, "notification-center.bell").click();
    await expect(byId(page, "notification-center.empty")).toBeVisible();
    await expect(byId(page, "notification-center.run")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The palette lists pages, but no write action.
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("deploy");
    await expect(page.getByRole("option", { name: /Deployments/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /New deployment/ })).toHaveCount(0);
    expect(mock.csrfViolations).toEqual([]);
    expect(mock.find("POST", "/api")).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a viewer on another machine gets the no-access page on an owner-only route", async ({ browser }) => {
  const { context, page, failures } = await newPage(browser, { bootstrap: { ...VIEWER, access: { local: false, lanViewer: true, allowLanAdmin: false } } });
  try {
    await page.goto(`${entry.url}models`);
    await expect(page.locator("#main h1")).toHaveText("No access");
    await expect(page.getByText("This page can only be opened on the machine that runs the platform.")).toBeVisible();
    await expect(byId(page, "pairing-screen.root")).toHaveCount(0);
    await expect(byId(page, "app-shell.readonly-how")).toHaveCount(0);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// StatusStrip

test("the strip shows the no-model-serving state from a PlatformStatus fixture, with its action", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await page.goto(`${entry.url}overview`);
    const strip = byId(page, "status-strip.root");
    await expect(strip).toHaveAttribute("data-source", "platform");
    await expect(strip).toHaveAttribute("data-overall", "degraded");
    await expect(byId(page, "status-strip.overall")).toContainText("Needs attention");
    const serving = byId(page, "status-strip.layer.serving");
    await expect(serving).toContainText("Model serving");
    await expect(serving).toContainText("0");
    await expect(serving).toHaveAttribute("data-tone", "warn");
    for (const [id, label] of [["environment", "Environment"], ["runtime", "Runtime"], ["components", "Components"], ["exposure", "Exposure"]]) {
      await expect(byId(page, `status-strip.layer.${id}`)).toContainText(label);
      await expect(byId(page, `status-strip.layer.${id}`)).toHaveAttribute("data-tone", "ok");
    }
    await expect(byId(page, "status-strip.layer.exposure")).toContainText("Local");
    await expect(byId(page, "status-strip.layer.components")).toContainText("5/5");

    await serving.click();
    await expect(serving).toHaveAttribute("aria-expanded", "true");
    await expect(byId(page, "status-strip.layer.serving.panel")).toContainText("The platform is up, but no model is serving yet.");
    await expect(byId(page, "status-strip.action.restore-models")).toHaveText("Start last used model");
    await page.keyboard.press("Escape");
    await expect(byId(page, "status-strip.layer.serving.panel")).toHaveCount(0);
    await expect(serving).toBeFocused();
  } finally {
    await context.close();
  }
});

test("the strip derives the same five layers from /api/status and /api/fleet before 06 lands", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { bootstrap: { ...OWNER, features: { platform: false } } });
  try {
    await page.goto(`${entry.url}overview`);
    const strip = byId(page, "status-strip.root");
    await expect(strip).toHaveAttribute("data-source", "derived");
    await expect(strip).toHaveAttribute("data-overall", "degraded");
    const serving = byId(page, "status-strip.layer.serving");
    await expect(serving).toContainText("0");
    await serving.click();
    await expect(byId(page, "status-strip.layer.serving.panel")).toContainText("The platform is up, but no model is serving yet.");
    await expect(page.locator('[data-testid^="status-strip.action."]')).toHaveCount(0);
    expect(mock.find("GET", "/api/platform")).toEqual([]);
    await page.keyboard.press("Escape");

    // With a routable instance the same derivation turns green and counts it.
    await page.route("**/api/fleet", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      updatedAt: "2026-10-14T08:00:00.000Z",
      instances: [{ id: "vllm:primary", instanceId: "vllm:primary", lifecycleState: "ready", running: true, models: [{ id: "qwen3.8-flash" }] }],
    }) }));
    await page.reload();
    await expect(byId(page, "status-strip.layer.serving")).toContainText("1");
    await expect(byId(page, "status-strip.layer.serving")).toHaveAttribute("data-tone", "ok");
    await expect(strip).toHaveAttribute("data-overall", "ok");
    await expect(byId(page, "status-strip.overall")).toContainText("Platform ready");
  } finally {
    await context.close();
  }
});

test("an unreachable entry turns the strip red", async ({ browser }) => {
  const { context, page } = await newPage(browser, {
    bootstrap: { ...OWNER, features: { platform: false } },
    api: { "GET /api/status": { status: 500, body: { ok: false, error: { code: "boom" } } } },
  });
  try {
    await page.goto(`${entry.url}overview`);
    await expect(byId(page, "status-strip.root")).toHaveAttribute("data-overall", "down");
    await expect(byId(page, "status-strip.overall")).toContainText("Unavailable");
    await byId(page, "status-strip.layer.environment").click();
    await expect(byId(page, "status-strip.layer.environment.panel")).toContainText("The entry service does not answer.");
  } finally {
    await context.close();
  }
});

test("the strip adds a GPU chip from telemetry.live and marks the version chip when newer commits exist", async ({ browser }) => {
  const live = { ok: true, at: "2026-10-14T08:00:05Z", gpus: [{ index: 0, util: 61, memUsedMb: 59597, memTotalMb: 97894, tempC: 71 }], collectors: { gpu: "ok" } };
  const { context, page } = await newPage(browser, {
    bootstrap: { ...OWNER, features: { platform: true, telemetry: true } },
    api: {
      "GET /api/telemetry/live": live,
      "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 3 },
    },
  });
  try {
    await page.goto(`${entry.url}overview`);
    const gpu = byId(page, "status-strip.gpu");
    await expect(gpu).toContainText("GPU");
    await expect(gpu).toContainText("61% · 58.2/95.6 GiB");
    await gpu.click();
    await expect(byId(page, "status-strip.gpu.panel")).toContainText("GPU 0: 61%");
    await page.keyboard.press("Escape");

    const version = byId(page, "status-strip.version");
    await expect(version).toContainText("v0.2.0");
    await expect(version).not.toContainText("git");
    await expect(version.locator(".chip-dot")).toHaveCount(1);
    await version.click();
    await expect(byId(page, "status-strip.newer")).toContainText("3 newer commits have not been deployed.");
    await expect(byId(page, "status-strip.version.panel").getByRole("link", { name: "Open updates" })).toHaveAttribute("href", "/system/updates");
  } finally {
    await context.close();
  }
});

test("Start last used model shows the dry-run plan first and sends the request only after confirm", async ({ browser }) => {
  const plan = [{ managerId: "vllm", launchId: "lch_0123456789abcdefghij", model: "qwen3.8-flash", action: "launch" }, { managerId: "llama", model: "gemma", action: "skip-running" }];
  const { context, page, mock } = await newPage(browser, {
    api: { "POST /api/platform/restore-models": (request) => (request.postDataJSON()?.dryRun ? { ok: true, plan } : { status: 202, body: { ok: true, opId: "op_1", plan } }) },
  });
  try {
    await page.goto(`${entry.url}overview`);
    await byId(page, "status-strip.layer.serving").click();
    await byId(page, "status-strip.action.restore-models").click();
    const dialog = page.getByRole("dialog", { name: "Start last used model" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("vllm · qwen3.8-flash · will start");
    await expect(dialog).toContainText("llama · gemma · already running, skipped");
    await expect(dialog).toContainText("It never stops or replaces a running model.");
    const sent = () => mock.find("POST", "/api/platform/restore-models");
    expect(sent().map((call) => call.body)).toEqual([{ dryRun: true }]);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(sent()).toHaveLength(1);

    await byId(page, "status-strip.layer.serving").click();
    await byId(page, "status-strip.action.restore-models").click();
    await page.getByRole("dialog", { name: "Start last used model" }).getByTestId("dialog.confirm").click();
    await expect.poll(() => sent().length).toBe(3);
    expect(sent()[2].body).toEqual({});
    expect(sent()[2].headers["x-csrf-token"]).toBe("t");
    await expect(page.getByRole("status").filter({ hasText: "Request sent" })).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Notifications and writes

test("notifications from the stream: bell count, a warn toast, links, and an apiCall that runs only after confirm", async ({ browser }) => {
  const hostile = [
    { id: "k3f9a2-8", type: "notification", at: "2026-10-14T08:00:08.000Z", source: "entry", data: { kind: "x.href", severity: "error", title: { zh: "恶意链接", en: "Evil link" }, action: { label: { zh: "点击", en: "Click" }, href: "https://evil.example/" } } },
    { id: "k3f9a2-9", type: "notification", at: "2026-10-14T08:00:09.000Z", source: "entry", data: { kind: "x.api", severity: "error", title: { zh: "恶意调用", en: "Evil call" }, action: { label: { zh: "点击", en: "Click" }, apiCall: { method: "POST", path: "/gateway/auto/openai/v1", body: {} } } } },
  ];
  // The owner's bootstrap carries no CSRF token here: the first write answers 403 csrf_invalid, the client re-reads /api/session once and retries.
  const { context, page, mock } = await newPage(browser, {
    bootstrap: { ...OWNER, ...PLATFORM_ON, auth: { csrf: null } },
    api: { events: [...fixture("events"), ...hostile], "POST /api/platform/restore-models": { status: 202, body: { ok: true, opId: "op_2" } } },
  });
  try {
    await page.goto(`${entry.url}overview`);
    const bell = byId(page, "notification-center.bell");
    await expect(bell).toHaveAttribute("aria-label", "Notifications, 2 unread");
    await expect(page.getByText("A model was not restored")).toBeVisible();
    await expect(page.getByText("Evil")).toHaveCount(0);

    await bell.click();
    const drawer = page.getByRole("dialog", { name: "Notifications" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("notification-center.item")).toHaveCount(2);
    await expect(drawer).not.toContainText("Evil");
    await expect(drawer).toContainText("Last session's models are not running");
    await page.keyboard.press("Escape");
    await expect(bell).toHaveAttribute("aria-label", "Notifications, 0 unread");
    await expect(bell).toBeFocused();
    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("console.prefs.v1")));
    expect(typeof stored.notificationsReadAt).toBe("string");

    // The apiCall button only asks. Nothing is sent until Confirm.
    await bell.click();
    await drawer.getByRole("button", { name: "Start last used model" }).click();
    const confirm = page.getByRole("dialog", { name: "Run this action?" });
    await expect(confirm).toContainText("POST /api/platform/restore-models");
    expect(mock.find("POST", "/api/platform/restore-models")).toEqual([]);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    expect(mock.find("POST", "/api/platform/restore-models")).toEqual([]);

    await drawer.getByRole("button", { name: "Start last used model" }).click();
    await page.getByRole("dialog", { name: "Run this action?" }).getByTestId("dialog.confirm").click();
    await expect.poll(() => mock.find("POST", "/api/platform/restore-models").length).toBe(2);
    const calls = mock.find("POST", "/api/platform/restore-models");
    expect(calls[0].headers["x-csrf-token"]).toBeUndefined();
    expect(calls[1].headers["x-csrf-token"]).toBe("t");
    expect(mock.find("GET", "/api/session")).toHaveLength(1);
    expect(mock.csrfViolations).toHaveLength(1);

    // An href action navigates in place and closes the drawer.
    await page.evaluate(() => {
      window.__marker = "kept";
    });
    await drawer.getByRole("link", { name: "Replace manually" }).click();
    await expect(page).toHaveURL(/\/deployments\?manager=vllm$/);
    await expect(drawer).toHaveCount(0);
    expect(await page.evaluate(() => window.__marker)).toBe("kept");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Event stream

const RECENT_EVENT = { id: "k3f9a2-5", type: "status", at: "2026-10-14T08:00:05.000Z", source: "entry", data: { reason: "manager_up", managerId: "vllm" } };

test("SSE 503 falls back to polling via /recent, retries SSE with ?lastEventId= and resyncs on recovery", async ({ browser }) => {
  let sseUp = false;
  const streamQueries = [];
  const { context, page, mock } = await newPage(browser, {
    api: {
      "GET /api/events": (request) => {
        streamQueries.push(new URL(request.url()).searchParams);
        return sseUp
          ? { status: 200, contentType: "text/event-stream", headers: STREAM_HEADERS, body: `retry: 3600000\n\n${sse("k3f9a2-6", "resync", { reason: "gap" })}` }
          : { status: 503, body: { ok: false, error: { code: "too_many_streams" } } };
      },
      // Like the real endpoint, nothing newer than `since` comes back, so later polls replay no event.
      "GET /api/events/recent": (request) => ({ ok: true, bootId: "k3f9a2", events: new URL(request.url()).searchParams.get("since") ? [] : [RECENT_EVENT], lastId: "k3f9a2-5", gap: false }),
    },
  });
  try {
    await page.clock.install();
    await page.goto(`${entry.url}overview`);
    const banner = byId(page, "connection-banner.root");
    await expect(banner).toHaveAttribute("data-state", "polling");
    await expect(banner).toContainText("Live updates interrupted; refreshing on a timer");
    // The event client asks without a limit; the Overview's own activity list asks with limit=20.
    const recent = () => mock.find("GET", "/api/events/recent").filter((call) => !call.query.limit);
    await expect.poll(() => recent().length).toBeGreaterThanOrEqual(1);
    expect(recent()[0].query.since).toBeUndefined();

    await page.clock.fastForward(5000);
    await expect.poll(() => recent().length).toBeGreaterThanOrEqual(2);
    expect(recent().at(-1).query.since).toBe("k3f9a2-5");
    // While /recent answers, no per-key refetch timer runs: the status count stays put.
    const statusCalls = () => mock.find("GET", "/api/status").length;
    const before = statusCalls();
    await page.clock.fastForward(20000);
    expect(statusCalls()).toBe(before);

    sseUp = true;
    await page.clock.fastForward(60000);
    await expect(banner).toHaveCount(0);
    expect(streamQueries.at(-1).get("lastEventId")).toBe("k3f9a2-5");
    expect(streamQueries.at(-1).get("types")).toContain("notification");
    // The stream opened with `resync`: every evented key refetches once.
    await expect.poll(statusCalls).toBeGreaterThan(before);
  } finally {
    await context.close();
  }
});

test("with SSE and /recent both down the banner offers Retry, which opens a new stream", async ({ browser }) => {
  let up = false;
  const opened = [];
  const { context, page } = await newPage(browser, {
    api: {
      "GET /api/events": (request) => {
        opened.push(request.url());
        return up ? { status: 200, contentType: "text/event-stream", headers: STREAM_HEADERS, body: "retry: 3600000\n\n" } : { status: 503, body: { ok: false } };
      },
      "GET /api/events/recent": () => (up ? { ok: true, events: [], lastId: null, gap: false } : { status: 503, body: { ok: false } }),
    },
  });
  try {
    await page.goto(`${entry.url}overview`);
    const banner = byId(page, "connection-banner.root");
    await expect(banner).toHaveAttribute("data-state", "offline");
    await expect(banner).toHaveAttribute("role", "alert");
    await expect(banner).toContainText("Cannot reach the entry service (last update");
    const count = opened.length;
    up = true;
    await byId(page, "connection-banner.retry").click();
    await expect.poll(() => opened.length).toBeGreaterThan(count);
    await expect(banner).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Palette, preferences, language

test("the palette is a combobox over a listbox: keyboard, focus return and Enter navigation", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await page.goto(`${entry.url}overview`);
    await expect(byId(page, "topbar.root")).toBeVisible();
    const opener = byId(page, "topbar.palette");
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Search and commands" });
    await expect(dialog).toBeVisible();
    const input = page.getByRole("combobox");
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await expect(input).toHaveAttribute("aria-activedescendant", /.+/);
    await input.fill("depl");
    const options = page.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await expect(options.filter({ hasText: "Deployments" }).first()).toBeVisible();
    await expect(options.filter({ hasText: "New deployment" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    const active = await input.getAttribute("aria-activedescendant");
    await expect(page.locator(`#${active}`)).toHaveAttribute("aria-selected", "true");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(options.first()).toHaveAttribute("aria-selected", "false");
    await input.fill("deployments");
    await expect(options.first()).toContainText("Deployments");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/deployments$/);
    await expect(dialog).toHaveCount(0);
    // Focus moves to the new page's heading once it is on screen; only then is the opener reliable.
    await expect(page.locator("#main h1")).toBeFocused();

    await opener.click();
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();

    // Ctrl+K toggles it from anywhere.
    await page.keyboard.press("Control+k");
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.keyboard.press("Control+k");
    await dialog.getByRole("combobox").fill("zzzzqqqq");
    await expect(page.getByText("No matches")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the palette matches both languages: English words find Chinese labels", async ({ browser }) => {
  const { context, page } = await newPage(browser, { locale: "zh-CN", prefs: { locale: "zh-CN" } });
  try {
    await page.goto(`${entry.url}overview`);
    await expect(nav(page, "主导航").getByRole("link", { name: "总览" })).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("overview");
    await expect(page.getByRole("option").first()).toContainText("总览");
    await page.getByRole("combobox").fill("总览");
    await expect(page.getByRole("option").first()).toContainText("总览");
  } finally {
    await context.close();
  }
});

test("theme, language and density from the palette persist, and the server injects them with no flash", async ({ browser }) => {
  const { context, page } = await newPage(browser, { theme: "light", prefs: { theme: "light", density: "comfortable" } });
  try {
    await page.goto(`${entry.url}overview`);
    await expect(byId(page, "topbar.root")).toBeVisible();
    const runCommand = async (text) => {
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox").fill(text);
      await page.keyboard.press("Enter");
    };

    await runCommand("Switch theme");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    // Writing one preference stores what the page showed for the others.
    const stored = await page.evaluate(() => ({ prefs: JSON.parse(window.localStorage.getItem("console.prefs.v1")), cookie: document.cookie }));
    expect(stored.prefs).toMatchObject({ theme: "dark", locale: "en-US", density: "comfortable" });
    expect(stored.cookie).toContain("console_prefs=theme:dark|locale:en-US|density:comfortable");

    await runCommand("Switch density");
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--row-h").trim())).toBe("32px");

    // A reload keeps both; the HTML already carries them without any script.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    await expect(byId(page, "topbar.root")).toBeVisible();
    const cookies = await context.cookies(entry.url);
    const plain = await browser.newContext({ javaScriptEnabled: false });
    await plain.addCookies(cookies);
    const bare = await plain.newPage();
    await bare.goto(`${entry.url}overview`);
    await expect(bare.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(bare.locator("html")).toHaveAttribute("data-density", "compact");
    await expect(bare.locator("html")).toHaveAttribute("lang", "en-US");
    await plain.close();

    const reloaded = page.waitForEvent("load");
    await runCommand("Switch language");
    await reloaded;
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(nav(page, "主导航").getByRole("link", { name: "总览" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  } finally {
    await context.close();
  }
});

test("English pass: no Han text outside user content, and no catalog key shows through", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: { events: fixture("events"), "GET /api/session": SESSION_UNPAIRED } });
  try {
    await page.goto(`${entry.url}overview`);
    await expect(byId(page, "notification-center.bell")).toHaveAttribute("aria-label", /Notifications, \d+ unread/);
    const collect = async () => (await mainText(page)) + (await page.locator("dialog").allInnerTexts()).join("\n");
    const texts = [await collect()];
    await byId(page, "status-strip.overall").click();
    texts.push(await collect());
    await page.keyboard.press("Escape");
    await byId(page, "notification-center.bell").click();
    texts.push(await collect());
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    texts.push(await collect());
    await page.keyboard.press("Escape");
    for (const text of texts) {
      expect(text).not.toMatch(HAN);
      expect(text).not.toMatch(RAW_KEY);
    }
    await page.goto(`${entry.url}overview/missing`);
    const missing = await mainText(page);
    expect(missing).not.toMatch(HAN);
    expect(missing).not.toMatch(RAW_KEY);
  } finally {
    await context.close();
  }
});

test("Chinese pass: every shell string is translated and no catalog key shows through", async ({ browser }) => {
  const { context, page } = await newPage(browser, { locale: "zh-CN", prefs: { locale: "zh-CN" }, bootstrap: { ...VIEWER, ...PLATFORM_ON }, api: { events: fixture("events"), "GET /api/session": SESSION_UNPAIRED } });
  try {
    await page.goto(`${entry.url}models`);
    await expect(byId(page, "pairing-screen.root")).toBeVisible();
    const texts = [await mainText(page)];
    await byId(page, "status-strip.layer.serving").click();
    texts.push(await mainText(page));
    await page.keyboard.press("Escape");
    await byId(page, "notification-center.bell").click();
    texts.push((await page.locator("dialog").allInnerTexts()).join("\n"));
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    texts.push((await page.locator("dialog").allInnerTexts()).join("\n"));
    for (const text of texts) expect(text).not.toMatch(RAW_KEY);
    expect(texts[0]).toContain("此浏览器尚未配对");
    expect(texts[1]).toContain("平台已启动，但还没有模型在提供服务。");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Layout, collapse and accessibility

test("the sidebar collapses to icons, keeps accessible names and remembers it", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  try {
    await page.goto(`${entry.url}overview`);
    await expect(byId(page, "sidebar.toggle")).toHaveAttribute("aria-expanded", "true");
    await byId(page, "sidebar.toggle").click();
    await expect(byId(page, "sidebar.toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".app-shell")).toHaveAttribute("data-collapsed", "true");
    const link = byId(page, "sidebar.link.deployments");
    await expect(link).toHaveAttribute("title", "Deployments");
    await expect(nav(page).getByRole("link", { name: "Deployments" })).toBeVisible();
    await page.reload();
    await expect(page.locator(".app-shell")).toHaveAttribute("data-collapsed", "true");
  } finally {
    await context.close();
  }
});

test("at 390 px the sidebar is an off-canvas drawer, the strip is one chip and nothing overflows", async ({ browser }) => {
  const { context, page } = await newPage(browser, { size: SIZES.phone });
  try {
    await page.goto(`${entry.url}overview`);
    await expectNoOverflow(page);
    await expect(byId(page, "sidebar.root")).toBeHidden();
    await expect(byId(page, "status-strip.layer.serving")).toBeHidden();
    await expect(byId(page, "status-strip.overall")).toBeVisible();
    for (const id of ["topbar.menu", "topbar.palette", "notification-center.bell", "status-strip.overall"]) {
      const box = await byId(page, id).boundingBox();
      expect(box.height, `${id} tap target`).toBeGreaterThanOrEqual(40);
      expect(box.width, `${id} tap target`).toBeGreaterThanOrEqual(40);
    }

    await byId(page, "status-strip.overall").click();
    const panel = byId(page, "status-strip.overall.panel");
    await expect(panel).toContainText("Model serving");
    await expect(panel).toContainText("no model is serving yet");
    await expectNoOverflow(page);
    await page.keyboard.press("Escape");

    await byId(page, "topbar.menu").click();
    const drawer = page.getByRole("dialog", { name: "Menu" });
    await expect(drawer).toBeVisible();
    await expectNoOverflow(page);
    await drawer.getByRole("link", { name: "Voice" }).click();
    await expect(page).toHaveURL(/\/voice$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectNoOverflow(page);
  } finally {
    await context.close();
  }
});

for (const theme of ["light", "dark"]) {
  for (const size of ["desktop", "phone"]) {
    test(`the shell has no axe findings, ${theme} at ${SIZES[size].width}`, async ({ browser }) => {
      test.setTimeout(120_000);
      const { context, page } = await newPage(browser, { theme, size: SIZES[size], prefs: { theme }, api: { events: fixture("events") } });
      try {
        await page.goto(`${entry.url}overview`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(byId(page, "status-strip.overall")).toBeVisible();
        await expect(page.locator("#main h1")).toBeVisible();
        await expectNoA11yViolations(page, { label: `${theme} ${size} base` });
        await expectNoOverflow(page);

        await byId(page, "status-strip.overall").click();
        await expectNoA11yViolations(page, { label: `${theme} ${size} strip` });
        await page.keyboard.press("Escape");

        await byId(page, "notification-center.bell").click();
        await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
        await expectNoA11yViolations(page, { label: `${theme} ${size} notifications` });
        await page.keyboard.press("Escape");

        await byId(page, "topbar.palette").click();
        await expect(page.getByRole("combobox")).toBeFocused();
        await expectNoA11yViolations(page, { label: `${theme} ${size} palette` });
        await page.keyboard.press("Escape");
      } finally {
        await context.close();
      }
    });
  }
}

test("the PairingScreen has no axe findings and does not overflow at 390", async ({ browser }) => {
  test.setTimeout(120_000);
  for (const theme of ["light", "dark"]) {
    const { context, page } = await newPage(browser, { theme, prefs: { theme }, size: SIZES.phone, bootstrap: { ...VIEWER, ...PLATFORM_ON }, api: { "GET /api/session": SESSION_UNPAIRED } });
    try {
      await page.goto(`${entry.url}models`);
      await expect(byId(page, "pairing-screen.root")).toBeVisible();
      await expectNoA11yViolations(page, { label: `${theme} pairing` });
      await expectNoOverflow(page);
    } finally {
      await context.close();
    }
  }
});

test("role none renders only the PairingScreen", async ({ browser }) => {
  const { context, page } = await newPage(browser, { bootstrap: { role: "none", auth: { mode: "session", session: { role: "none", via: "none", paired: false, autoPairAvailable: false }, csrf: null } }, api: { "GET /api/session": SESSION_UNPAIRED } });
  try {
    await page.goto(`${entry.url}overview`);
    await expect(byId(page, "pairing-screen.root")).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(byId(page, "topbar.root")).toHaveCount(0);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("h1")).toBeFocused();
  } finally {
    await context.close();
  }
});
