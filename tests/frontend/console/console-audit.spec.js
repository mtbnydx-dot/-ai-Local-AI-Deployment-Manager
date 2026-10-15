// CON-18 browser checks, Audit (07 §6.8, §13.2 console-audit; 04 §16): the
// timeline, the export chain with baseline and incrementals, conversations
// behind the audit unlock, the access log with its verification and the audit
// settings. The unlock has two modes and both are checked: with 05's
// HttpOnly elevation cookie no token is visible to page code, and on the
// degrade path the token is only ever a request header. Neither web storage
// is ever written, Lock and expiry end the unlock, and hostile conversation
// Markdown stays inert text. The real service-entry serves the console and the
// API is mocked in the browser (helpers/console-harness.js).
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
const FULL = { features: { platform: true, telemetry: true, alerts: true, audit: true } };
const NO_AUDIT = { features: { platform: true, telemetry: true, audit: false } };
const TOKEN = "audit-token-fake-0123456789";
const PASSWORD = "fake-audit-password";

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

const params = (request) => Object.fromEntries(new URL(request.url()).searchParams);
const inMs = (ms) => new Date(Date.now() + ms).toISOString();

const STATUS = (() => {
  const status = telemetry("audit-status");
  return {
    ...status,
    chains: [{ ...status.chains[0], auditIds: ["20261013-inc", "20261010-inc", "20261001-full"], incrementals: 2, chats: 7, messages: 26, bytes: 4096 }],
    retention: {
      policy: status.retention.policy,
      plan: { remove: [{ auditId: "20261010-inc", reason: "empty-incremental" }], warnings: [{ code: "over_max_exports", message: "More exports are kept than the count limit." }], needsRebaseline: true },
    },
    index: { available: true, chats: 2, messages: 4, lastIndexedAt: "2026-10-14T12:00:00.000Z" },
  };
})();
const EXPORTS = {
  ok: true,
  lastHeartbeatAt: null,
  exports: [
    { auditId: "20261013-inc", mode: "incremental", createdAt: "2026-10-13T09:00:00.000Z", chatCount: 2, totalChatCount: 7, messageCount: 4, mdFile: "openwebui-chats-full.md", mdBytes: 2048, chainId: "20261001-full", skippedEmpty: false },
    { auditId: "20261010-inc", mode: "incremental", createdAt: "2026-10-10T09:00:00.000Z", chatCount: 0, totalChatCount: 7, messageCount: 0, mdFile: "", mdBytes: 0, chainId: "20261001-full", skippedEmpty: true },
    { auditId: "20261001-full", mode: "full", createdAt: "2026-10-01T04:00:00.000Z", chatCount: 7, totalChatCount: 7, messageCount: 26, mdFile: "openwebui-chats-full.md", mdBytes: 40960, chainId: "20261001-full", skippedEmpty: false },
  ],
};
const HOSTILE = [
  "# Plan <script>window.__pwned = 1</script>",
  "",
  "<img src=x onerror=\"window.__pwned = 2\"> <iframe src=\"https://audit-host.invalid/frame\"></iframe>",
  "",
  "[click me](javascript:window.__pwned=3) and [a site](https://audit-host.invalid/page)",
  "",
  "![tracker](https://audit-host.invalid/pixel.png)",
  "",
  "<a href=\"javascript:window.__pwned=4\" onclick=\"window.__pwned=5\">raw anchor</a>",
  "",
  "```html",
  "<b>bold?</b>",
  "```",
].join("\n");
const THREAD = {
  ok: true,
  chat: { chatId: "chat-1", title: "Planning notes", userName: "Fixture User", models: ["model-a"] },
  auditId: "20261013-inc",
  isLatest: true,
  messages: [
    { id: "m2", parentId: "m1", role: "assistant", model: "model-a", timestamp: 1791885900, content: "Here is **the plan**.\n\n- one\n- two", contentType: "markdown" },
    { id: "m1", parentId: null, role: "user", model: "", timestamp: 1791885600, content: HOSTILE, contentType: "markdown" },
  ],
};
const VERSIONS = { ok: true, versions: [{ auditId: "20261013-inc", createdAt: "2026-10-13T09:00:00.000Z", updatedAt: "2026-10-13T08:05:00.000Z", messageCount: 2 }, { auditId: "20261001-full", createdAt: "2026-10-01T04:00:00.000Z", updatedAt: "2026-10-01T03:00:00.000Z", messageCount: 1 }] };
const LOG_ROWS = [
  { seq: 9, at: "2026-10-14T11:00:00.000Z", atMs: 1791975600000, source: "entry", actor: "session:abc", session: "s1", clientIp: "192.0.2.10", userAgent: "fixture", action: "view_chat", target: "chat-1", outcome: "ok", detail: { auditId: "20261013-inc", messages: 2 }, prevHash: "a".repeat(64), hash: "b".repeat(64) },
  { seq: 8, at: "2026-10-14T10:59:00.000Z", atMs: 1791975540000, source: "entry", actor: "session:abc", session: "s1", clientIp: "192.0.2.10", userAgent: "fixture", action: "login_ok", target: null, outcome: "ok", detail: null, prevHash: "c".repeat(64), hash: "a".repeat(64) },
  { seq: 7, at: "2026-10-14T10:58:00.000Z", atMs: 1791975480000, source: "entry", actor: "session:abc", session: null, clientIp: "192.0.2.10", userAgent: "fixture", action: "login_failed", target: null, outcome: "denied", detail: { reason: "invalid_password" }, prevHash: "d".repeat(64), hash: "c".repeat(64) },
];
const EVENTS = {
  ok: true,
  rows: [
    { id: 3, at: "2026-10-14T11:30:00.000Z", type: "launch.ready", severity: "info", source: "entry", managerId: "vllm", fleetId: "vllm:primary", requestId: null, title: { zh: "启动完成", en: "Launch ready" }, data: {} },
    { id: 2, at: "2026-10-14T11:20:00.000Z", type: "security.ban", severity: "warning", source: "entry", managerId: null, fleetId: null, requestId: "req_aaaaaaaaaaaaaaaaaaar", title: "Banned a client", data: {} },
  ],
  nextCursor: null,
};
const SETTINGS = {
  ok: true,
  etag: "etag-a",
  schedule: { enabled: true, incrementalEveryMinutes: 60, fullAtLocal: "04:00" },
  retention: { maxExports: 30, maxAgeDays: 90, rebaselineDays: 7, maxChains: 8 },
  logQueryText: false,
};

// `mode`: "cookie" answers like 05's elevation (no token, an HttpOnly cookie); "token" is the degrade path.
function loginHandler(mode, { expiresIn = 3600_000 } = {}) {
  return (request) => {
    const body = JSON.parse(request.postData() || "{}");
    if (body.password !== PASSWORD) return { status: 401, body: { ok: false, error: { code: "audit_password_invalid", message: "The audit password is not correct." } } };
    const answer = { ok: true, expiresAt: inMs(expiresIn), ...(mode === "token" ? { token: TOKEN } : {}) };
    return mode === "cookie"
      ? { status: 200, body: answer, headers: { "set-cookie": "lai_elev=elevation-cookie-fake; Path=/api; HttpOnly; SameSite=Strict" } }
      : { status: 200, body: answer };
  };
}

function auditApi(extra = {}, { mode = "cookie", expiresIn } = {}) {
  return {
    "GET /api/telemetry/live": telemetry("live"),
    "GET /api/telemetry/events": EVENTS,
    "GET /api/audit/status": STATUS,
    "GET /api/audit/exports": EXPORTS,
    "POST /api/audit/login": loginHandler(mode, { expiresIn }),
    "POST /api/audit/logout": { ok: true },
    "GET /api/audit/chats": telemetry("audit-chats"),
    "GET /api/audit/chats/chat-1": THREAD,
    "GET /api/audit/chats/chat-1/versions": VERSIONS,
    "GET /api/audit/access-log": { ok: true, rows: LOG_ROWS, nextCursor: null },
    "GET /api/audit/access-log/verify": { ok: true, rows: 9, firstBrokenSeq: null },
    "GET /api/audit/settings": SETTINGS,
    "GET /api/telemetry/requests/req_aaaaaaaaaaaaaaaaaaar": telemetry("request-detail"),
    ...extra,
  };
}

async function newPage(browser, { bootstrap = FULL, role = OWNER, api = auditApi(), size = SIZES.desktop, theme = "light", locale = "en-US" } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, { ...role, ...bootstrap });
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const external = [];
  await page.route((url) => url.hostname === "audit-host.invalid", (route) => {
    external.push(route.request().url());
    return route.abort();
  });
  const mock = await mockConsoleApi(page, {
    "GET /api/status": consoleFixture("status"),
    "GET /api/platform/status": consoleFixture("platform-status"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/fleet": consoleFixture("fleet"),
    ...api,
  });
  return { context, page, mock, failures, external };
}

// The shell keeps its own preference markers in localStorage; nothing else may be stored, and no value may hold a secret.
const SHELL_STORAGE_KEYS = ["console.prefs.migrated", "console.prefs.v1"];
async function expectNothingStored(page) {
  const state = await page.evaluate(() => ({ local: { ...window.localStorage }, session: { ...window.sessionStorage } }));
  expect(Object.keys(state.local).filter((key) => !SHELL_STORAGE_KEYS.includes(key)), "localStorage").toEqual([]);
  expect(Object.keys(state.session), "sessionStorage").toEqual([]);
  const everything = JSON.stringify(state);
  for (const secret of [TOKEN, PASSWORD, "elevation-cookie-fake"]) expect(everything).not.toContain(secret);
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const audit = (mock, method, rest) => mock.find(method, `/api/audit/${rest}`);
const open = async (page, route) => {
  await page.goto(`${entry.url}${route}`);
  await expect(page.locator("#main h1")).toBeVisible();
};
async function unlock(page, password = PASSWORD) {
  await byId(page, "audit.password").fill(password);
  await byId(page, "audit.unlock-submit").click();
}

// ---------------------------------------------------------------------------
// Export chain

test("export chain: one full baseline and its incrementals, empty and removable ones marked, the retention plan and warnings in words", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await open(page, "audit/exports");
    await expect(byId(page, "audit.chain")).toHaveCount(1);
    await expect(byId(page, "audit.chain")).toContainText("Export chain: 1 full baseline + 2 incrementals");
    await expect(byId(page, "audit.chain")).toHaveAttribute("data-incrementals", "2");
    const rows = byId(page, "audit.export");
    await expect(rows).toHaveCount(3);
    // Baseline first, then the incrementals newest first.
    expect(await rows.evaluateAll((nodes) => nodes.map((node) => `${node.dataset.mode}:${node.dataset.auditId}`))).toEqual([
      "full:20261001-full", "incremental:20261013-inc", "incremental:20261010-inc",
    ]);
    await expect(rows.nth(2)).toContainText("Empty");
    await expect(rows.nth(2)).toContainText("Next cleanup removes it (empty)");
    await expect(rows.nth(0)).toContainText("Full");
    await expect(byId(page, "audit.rebaseline")).toContainText("A new full export is needed so history stays recoverable");
    await expect(byId(page, "audit.warning")).toHaveAttribute("data-code", "over_max_exports");
    await expect(byId(page, "audit.warning")).toContainText("More exports are kept than the limit");
    // The list needs the owner only: no audit session was asked for.
    expect(audit(mock, "GET", "exports")[0].headers["x-audit-session"]).toBeUndefined();
    // Markdown is content: locked until the audit is unlocked.
    await expect(rows.nth(0).locator("[data-testid='audit.export.open']")).toBeDisabled();
    await expect(byId(page, "audit.exports.locked")).toBeVisible();
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("export now: mode and note go in the body, the owner CSRF token rides along, and the chain reloads", async ({ browser }) => {
  let created = false;
  const { context, page, mock } = await newPage(browser, {
    api: auditApi({
      "POST /api/audit/export": () => {
        created = true;
        return { ok: true, mode: "full", auditId: "20261014-full" };
      },
    }),
  });
  try {
    await open(page, "audit/exports");
    await byId(page, "audit.export-now").click();
    await byId(page, "audit.export-mode.full").check();
    await byId(page, "audit.export-note").fill("before the upgrade");
    const reloads = audit(mock, "GET", "status").length;
    await page.getByRole("button", { name: "Export now" }).last().click();
    await expect.poll(() => created).toBe(true);
    const post = audit(mock, "POST", "export")[0];
    expect(post.body).toEqual({ mode: "full", note: "before the upgrade" });
    expect(post.headers["x-csrf-token"]).toBe("t");
    await expect.poll(() => audit(mock, "GET", "status").length).toBeGreaterThan(reloads);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("export now: a skipped export is said as skipped, a refused one keeps the dialog open with its error", async ({ browser }) => {
  let answer = { ok: true, mode: "incremental", skipped: true, reason: "export_in_progress" };
  const { context, page } = await newPage(browser, { api: auditApi({ "POST /api/audit/export": () => answer }) });
  try {
    await open(page, "audit/exports");
    await byId(page, "audit.export-now").click();
    await page.getByRole("button", { name: "Export now" }).last().click();
    await expect(page.locator("[data-testid='toast.root']").first()).toContainText("Export skipped: export_in_progress");
    answer = { status: 500, body: { ok: false, error: { code: "audit_export_failed", message: "The export failed on disk." } } };
    await byId(page, "audit.export-now").click();
    await page.getByRole("button", { name: "Export now" }).last().click();
    await expect(byId(page, "audit.export-dialog")).toContainText("The export failed on disk.");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Unlock: cookie mode and the degrade path

test("cookie mode: unlocking keeps no token in anything page code can see, sends no audit header, and leaves both storages empty", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await open(page, "audit/conversations");
    // Locked: the form, not the data.
    await expect(byId(page, "audit.unlock-card")).toBeVisible();
    expect(audit(mock, "GET", "chats")).toHaveLength(0);
    await expect(byId(page, "audit.lock-state")).toHaveAttribute("data-state", "locked");

    await byId(page, "audit.password").fill("a wrong password");
    await byId(page, "audit.unlock-submit").click();
    await expect(byId(page, "audit.unlock-error")).toContainText("The audit password is not correct.");
    await expect(byId(page, "audit.password")).toHaveValue("");

    await unlock(page);
    await expect(byId(page, "audit.chats")).toBeVisible();
    await expect(byId(page, "audit.lock-state")).toHaveAttribute("data-mode", "cookie");
    await expect(byId(page, "audit.lock-state")).toContainText("Unlocked until");
    // The password only ever travels in the login body, and the field is cleared.
    expect(audit(mock, "POST", "login").map((call) => call.body.password)).toEqual(["a wrong password", PASSWORD]);
    await expect(page.locator("#main")).not.toContainText(PASSWORD);

    // The elevation cookie is HttpOnly: the browser holds it, page code cannot read it.
    const cookies = await context.cookies(new URL("/api/audit/chats", entry.url).href);
    const elevation = cookies.find((cookie) => cookie.name === "lai_elev");
    expect(elevation?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain("lai_elev");
    // No audit token anywhere visible to script: not in globals, markup, storages or the URL.
    const visible = await page.evaluate(() => JSON.stringify({
      cookie: document.cookie, local: { ...localStorage }, session: { ...sessionStorage }, url: location.href, html: document.documentElement.outerHTML,
      globals: Object.keys(window).filter((name) => /audit|token|session/i.test(name)),
    }));
    expect(visible).not.toContain("elevation-cookie-fake");
    expect(visible).not.toContain(TOKEN);
    await expectNothingStored(page);

    // Content calls carry no audit header and no bearer.
    for (const call of [...audit(mock, "GET", "chats"), ...audit(mock, "GET", "status")]) {
      expect(call.headers["x-audit-session"]).toBeUndefined();
      expect(call.headers.authorization).toBeUndefined();
    }
    expect(mock.csrfViolations).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("degrade mode: the token is held in a closure and is only ever a request header", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: auditApi({}, { mode: "token" }) });
  try {
    await open(page, "audit/conversations");
    await unlock(page);
    await expect(byId(page, "audit.chats")).toBeVisible();
    await expect(byId(page, "audit.lock-state")).toHaveAttribute("data-mode", "token");
    const chats = audit(mock, "GET", "chats");
    expect(chats.length).toBeGreaterThan(0);
    for (const call of chats) expect(call.headers["x-audit-session"]).toBe(TOKEN);

    await byId(page, "audit.chat.open").filter({ hasText: "Planning notes" }).click();
    await expect(byId(page, "audit.thread")).toBeVisible();
    for (const call of [...audit(mock, "GET", "chats/chat-1"), ...audit(mock, "GET", "chats/chat-1/versions")]) expect(call.headers["x-audit-session"]).toBe(TOKEN);

    // The token is nowhere else: not in storages, cookies, the URL, the markup or page globals.
    const visible = await page.evaluate(() => JSON.stringify({
      cookie: document.cookie, local: { ...localStorage }, session: { ...sessionStorage }, url: location.href, html: document.documentElement.outerHTML,
    }));
    expect(visible).not.toContain(TOKEN);
    await expectNothingStored(page);
    expect(await page.evaluate((token) => Object.keys(window).some((name) => { try { return String(window[name]).includes(token); } catch { return false; } }), TOKEN)).toBe(false);
    // The login answer never reached the query cache or an error: the other pages' calls are unchanged.
    expect(audit(mock, "GET", "status").every((call) => call.headers["x-audit-session"] === undefined)).toBe(true);
  } finally {
    await context.close();
  }
});

test("degrade mode: the request detail gets the header while unlocked, the audit link resolves, and Lock takes it away", async ({ browser }) => {
  const linked = { ...telemetry("request-detail"), audit: { unlocked: true, linkable: true, chatId: "chat-1", candidates: [] } };
  const { context, page, mock } = await newPage(browser, { api: auditApi({ "GET /api/telemetry/requests/req_aaaaaaaaaaaaaaaaaaar": (request) => (request.headers()["x-audit-session"] === TOKEN ? linked : telemetry("request-detail")) }, { mode: "token" }) });
  try {
    await open(page, "audit/conversations");
    await unlock(page);
    await expect(byId(page, "audit.chats")).toBeVisible();
    // Client-side navigation keeps the closure: Timeline, then the request its security event names.
    await byId(page, "audit.nav.timeline").click();
    await page.locator("a[href='/observability/requests/req_aaaaaaaaaaaaaaaaaaar']").first().click();
    await expect(byId(page, "obs.req.audit.chat")).toHaveAttribute("href", "/audit/conversations?chat=chat-1");
    const detail = mock.find("GET", "/api/telemetry/requests/req_aaaaaaaaaaaaaaaaaaar");
    expect(detail.at(-1).headers["x-audit-session"]).toBe(TOKEN);
    expect(detail.at(-1).query).toEqual({});

    // Lock: the logout carries the header, the unlock is gone, the next detail request has none.
    await page.goBack();
    await byId(page, "audit.lock").click();
    await expect(byId(page, "audit.lock-state")).toHaveAttribute("data-state", "locked");
    expect(audit(mock, "POST", "logout")[0].headers["x-audit-session"]).toBe(TOKEN);
    await page.locator("a[href='/observability/requests/req_aaaaaaaaaaaaaaaaaaar']").first().click();
    await expect(byId(page, "obs.req.audit.locked")).toBeVisible();
    expect(mock.find("GET", "/api/telemetry/requests/req_aaaaaaaaaaaaaaaaaaar").at(-1).headers["x-audit-session"]).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("Lock ends the unlock and removes the conversation text from the page; a lost unlock (401) asks for the password again", async ({ browser }) => {
  let revoked = false;
  const { context, page, mock } = await newPage(browser, {
    api: auditApi({
      "GET /api/audit/chats": () => (revoked ? { status: 401, body: { ok: false, error: { code: "audit_session_required", message: "Enter the audit password first." } } } : telemetry("audit-chats")),
    }),
  });
  try {
    await open(page, "audit/conversations?chat=chat-1&auditId=20261013-inc");
    await unlock(page);
    await expect(byId(page, "audit.thread")).toBeVisible();
    await expect(page.locator("body")).toContainText("Here is the plan.");
    // The thread is a modal sheet: close it, then Lock.
    await page.keyboard.press("Escape");
    await byId(page, "audit.lock").click();
    await expect(byId(page, "audit.unlock-card")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Here is the plan.");
    expect(audit(mock, "POST", "logout")).toHaveLength(1);

    // The server forgets the session (restart, expiry): the next content call locks the page again.
    await unlock(page);
    await expect(byId(page, "audit.chats")).toBeVisible();
    revoked = true;
    await byId(page, "audit.search-submit").click();
    await expect(byId(page, "audit.unlock-card")).toBeVisible();
    await expect(byId(page, "audit.lock-state")).toHaveAttribute("data-state", "locked");
  } finally {
    await context.close();
  }
});

test("the unlock ends at its expiry without any other action", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: auditApi({}, { expiresIn: 2500 }) });
  try {
    await open(page, "audit/conversations");
    await unlock(page);
    await expect(byId(page, "audit.chats")).toBeVisible();
    await expect(byId(page, "audit.unlock-card")).toBeVisible({ timeout: 8000 });
    await expect(page.locator("body")).not.toContainText("Planning notes");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Conversations

test("conversations: filters become the documented query, results page with a cursor, and the thread shows versions", async ({ browser }) => {
  const second = { ok: true, rows: [{ ...telemetry("audit-chats").rows[0], chatId: "chat-9", title: "Older chat" }], nextCursor: null };
  const { context, page, mock } = await newPage(browser, {
    api: auditApi({ "GET /api/audit/chats": (request) => (params(request).cursor ? second : { ...telemetry("audit-chats"), nextCursor: "next-1", index: { building: true } }) }),
  });
  try {
    await open(page, "audit/conversations");
    await unlock(page);
    await expect(byId(page, "audit.chats")).toBeVisible();
    await expect(byId(page, "audit.index-building")).toContainText("still being built");
    const rows = byId(page, "audit.chats").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    expect(audit(mock, "GET", "chats")[0].query).toEqual({ limit: "50" });

    await byId(page, "audit.filter.q").fill("plan");
    await byId(page, "audit.filter.user").fill("Fixture User");
    await byId(page, "audit.filter.model").fill("model-a");
    await byId(page, "audit.filter.archived").selectOption("no");
    await byId(page, "audit.filter.from").fill("2026-10-01");
    await byId(page, "audit.filter.to").fill("2026-10-14");
    await byId(page, "audit.search-submit").click();
    await expect(page).toHaveURL(/q=plan/);
    await expect.poll(() => audit(mock, "GET", "chats").some((call) => call.query.q === "plan")).toBe(true);
    const query = audit(mock, "GET", "chats").find((call) => call.query.q === "plan").query;
    expect(query).toMatchObject({ q: "plan", user: "Fixture User", model: "model-a", archived: "false", limit: "50" });
    expect(Date.parse(query.from)).toBeLessThan(Date.parse(query.to));
    expect(Date.parse(query.to) - Date.parse(query.from)).toBeGreaterThan(13 * 86400e3);

    await byId(page, "data-table.load-more").click();
    await expect.poll(() => audit(mock, "GET", "chats").some((call) => call.query.cursor === "next-1")).toBe(true);
    await expect(rows).toHaveCount(3);

    // The thread: the chat id and audit id are in the URL, never the text; the other version is one call away.
    await rows.filter({ hasText: "Planning notes" }).locator("[data-testid='audit.chat.open']").click();
    await expect(page).toHaveURL(/chat=chat-1/);
    await expect(page).toHaveURL(/auditId=20261013-inc/);
    await expect(byId(page, "audit.message")).toHaveCount(2);
    // Oldest first, whatever order the answer used.
    expect(await byId(page, "audit.message").evaluateAll((nodes) => nodes.map((node) => node.dataset.role))).toEqual(["user", "assistant"]);
    expect(page.url()).not.toContain("Here");
    await byId(page, "audit.thread.versions").selectOption("20261001-full");
    await expect.poll(() => audit(mock, "GET", "chats/chat-1").some((call) => call.query.auditId === "20261001-full")).toBe(true);
    await page.keyboard.press("Escape");
    await expect(byId(page, "audit.thread")).toHaveCount(0);
    await expect(page).not.toHaveURL(/chat=/);
  } finally {
    await context.close();
  }
});

test("conversations: hostile Markdown is inert text; no script runs, no remote content is fetched, links are safe", async ({ browser }) => {
  const { context, page, external, failures } = await newPage(browser);
  try {
    await page.addInitScript(() => {
      window.__pwned = 0;
    });
    await open(page, "audit/conversations?chat=chat-1&auditId=20261013-inc");
    await unlock(page);
    const thread = byId(page, "audit.thread");
    await expect(thread).toBeVisible();
    await expect(page.locator("[data-testid='audit.message'][data-role='user']")).toBeVisible();
    // The markup is shown as text, not parsed.
    await expect(thread).toContainText("<script>window.__pwned = 1</script>");
    await expect(thread).toContainText("<iframe src=\"https://audit-host.invalid/frame\"></iframe>");
    await expect(thread).toContainText("<b>bold?</b>");
    const dom = await thread.evaluate((node) => ({
      scripts: node.querySelectorAll("script, iframe, object, embed, img, style, link").length,
      handlers: [...node.querySelectorAll("*")].filter((el) => [...el.attributes].some((attr) => /^on/i.test(attr.name))).length,
      hrefs: [...node.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
      external: [...node.querySelectorAll("a[href]")].filter((a) => a.getAttribute("href").startsWith("http")).map((a) => [a.rel, a.target]),
      bold: node.querySelectorAll("b").length,
      headings: node.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
    }));
    expect(dom.scripts).toBe(0);
    expect(dom.handlers).toBe(0);
    expect(dom.bold).toBe(0);
    // Untrusted headings do not shape the page outline.
    expect(dom.headings).toBe(0);
    await expect(thread).toContainText("Plan");
    expect(dom.hrefs.some((href) => /^\s*javascript:/i.test(href))).toBe(false);
    expect(dom.hrefs).toEqual(["https://audit-host.invalid/page"]);
    expect(dom.external).toEqual([["noopener noreferrer", "_blank"]]);
    expect(await page.evaluate(() => window.__pwned)).toBe(0);
    // The remote image became a placeholder and nothing was requested from the remote host.
    await expect(thread.locator("[data-testid='markdown.image-blocked']")).toHaveCount(1);
    expect(external).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
    // Clicking the safe-looking link text does not run script either.
    await thread.getByText("click me").click({ trial: true }).catch(() => undefined);
    expect(await page.evaluate(() => window.__pwned)).toBe(0);
  } finally {
    await context.close();
  }
});

test("conversations: an index that is not ready and an empty result each say what to do", async ({ browser }) => {
  let mode = "unavailable";
  const { context, page } = await newPage(browser, {
    api: auditApi({
      "GET /api/audit/chats": () => (mode === "unavailable"
        ? { status: 503, body: { ok: false, error: { code: "audit_index_unavailable", message: "not ready" } } }
        : { ok: true, rows: [], nextCursor: null }),
    }),
  });
  try {
    await open(page, "audit/conversations");
    await unlock(page);
    await expect(byId(page, "audit.error")).toContainText("The conversation index is not ready yet");
    mode = "empty";
    await byId(page, "audit.retry").click();
    await expect(byId(page, "audit.empty")).toContainText("No conversations match");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Export Markdown

test("an export's Markdown opens as a safe document and downloads as text, only while unlocked", async ({ browser }) => {
  const markdown = "# Export\n\n<script>window.__pwned = 9</script>\n\nA line.";
  const { context, page, mock } = await newPage(browser, {
    api: auditApi({ "GET /api/audit/exports/20261013-inc/markdown": { status: 200, contentType: "text/markdown", body: markdown } }, { mode: "token" }),
  });
  try {
    await open(page, "audit/conversations");
    await unlock(page);
    await expect(byId(page, "audit.chats")).toBeVisible();
    await byId(page, "audit.nav.exports").click();
    const row = byId(page, "audit.export").filter({ hasText: "20261013-inc" });
    await row.locator("[data-testid='audit.export.open']").click();
    await expect(byId(page, "audit.markdown.body")).toContainText("A line.");
    await expect(byId(page, "audit.markdown.body")).toContainText("<script>window.__pwned = 9</script>");
    expect(await byId(page, "audit.markdown.body").locator("script").count()).toBe(0);
    const call = audit(mock, "GET", "exports/20261013-inc/markdown")[0];
    expect(call.headers["x-audit-session"]).toBe(TOKEN);
    expect(call.headers.accept).toContain("text/markdown");
    const download = page.waitForEvent("download");
    await byId(page, "audit.markdown.download").click();
    expect((await download).suggestedFilename()).toBe("20261013-inc.md");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Access log

test("access log: needs the unlock, shows the append-only rows, and verification reports intact or the entry it breaks after", async ({ browser }) => {
  let broken = false;
  const { context, page, mock } = await newPage(browser, {
    api: auditApi({ "GET /api/audit/access-log/verify": () => (broken ? { ok: false, rows: 9, firstBrokenSeq: 7 } : { ok: true, rows: 9, firstBrokenSeq: null }) }),
  });
  try {
    await open(page, "audit/access-log?range=30d");
    await expect(byId(page, "audit.unlock-card")).toBeVisible();
    expect(audit(mock, "GET", "access-log")).toHaveLength(0);
    await unlock(page);
    await expect(byId(page, "audit.log.table")).toBeVisible();
    const call = audit(mock, "GET", "access-log")[0];
    expect(call.query.limit).toBe("100");
    expect(Date.parse(call.query.to) - Date.parse(call.query.from)).toBe(30 * 86400e3);
    const rows = byId(page, "audit.log.table").locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Opened a conversation");
    await expect(rows.nth(2)).toContainText("Unlock failed");
    await expect(rows.nth(2)).toContainText("Denied");
    await expect(byId(page, "audit.log")).toContainText("Audit access log (append-only)");

    await byId(page, "audit.verify-run").click();
    await expect(byId(page, "audit.verify-ok")).toContainText("9 entries checked");
    broken = true;
    await byId(page, "audit.verify-run").click();
    await expect(byId(page, "audit.verify-broken")).toContainText("Access log verification failed after entry 7");
    await expect(byId(page, "audit.verify-ok")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Timeline and settings

test("timeline: the four event families in the window with localized titles, links, a kind filter, and the export health line", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await open(page, "audit?range=7d");
    await expect(page.locator("#main h1")).toHaveText("Conversation audit");
    await expect(byId(page, "audit.timeline.table").locator("tbody tr")).toHaveCount(2);
    const events = mock.find("GET", "/api/telemetry/events");
    expect(events[0].query.type).toBe("launch.,alert.,access.,security.");
    expect(Date.parse(events[0].query.to) - Date.parse(events[0].query.from)).toBe(7 * 86400e3);
    await expect(byId(page, "audit.timeline.table")).toContainText("Launch ready");
    await expect(byId(page, "audit.timeline.table").locator("a[href='/deployments/vllm%3Aprimary']")).toBeVisible();
    await expect(byId(page, "audit.timeline.table").locator("a[href='/observability/requests/req_aaaaaaaaaaaaaaaaaaar']")).toBeVisible();
    // Health line: the chain and the schedule, no content and no audit session.
    await expect(byId(page, "audit.health.chain")).toContainText("1 full baseline + 2 incrementals");
    await expect(byId(page, "audit.rebaseline")).toBeVisible();
    // The kind filter narrows the type prefixes.
    await byId(page, "audit.family.alert").uncheck();
    await byId(page, "audit.family.access").uncheck();
    await expect.poll(() => mock.find("GET", "/api/telemetry/events").at(-1).query.type).toBe("launch.,security.");
    await expect(page).toHaveURL(/kind=launch%2Csecurity/);
  } finally {
    await context.close();
  }
});

test("settings: only the changed fields are sent with If-Match, invalid values never leave, a stale etag and field errors are said", async ({ browser }) => {
  let answer = { ok: true, etag: "etag-b", schedule: { enabled: true, incrementalEveryMinutes: 30, fullAtLocal: "04:00" }, retention: SETTINGS.retention, logQueryText: false, changed: ["audit.schedule.incrementalEveryMinutes"], restartRequired: [] };
  const { context, page, mock } = await newPage(browser, { api: auditApi({ "PUT /api/audit/settings": () => answer }) });
  try {
    await open(page, "audit/settings");
    await expect(byId(page, "audit.settings.form")).toBeVisible();
    await expect(byId(page, "audit.settings.save")).toBeDisabled();
    await expect(byId(page, "audit.set.schedule.incrementalEveryMinutes")).toHaveValue("60");

    // Invalid input never leaves the form.
    await byId(page, "audit.set.schedule.incrementalEveryMinutes").fill("5");
    await expect(byId(page, "audit.set.schedule.incrementalEveryMinutes.field")).toContainText("Enter a value from 15 to 1440.");
    await expect(byId(page, "audit.settings.save")).toBeDisabled();
    await byId(page, "audit.set.schedule.fullAtLocal").fill("25:00");
    await expect(byId(page, "audit.set.schedule.fullAtLocal.field")).toContainText("Use HH:MM");
    await byId(page, "audit.set.schedule.fullAtLocal").fill("04:00");

    await byId(page, "audit.set.schedule.incrementalEveryMinutes").fill("30");
    await byId(page, "audit.settings.save").click();
    await expect(byId(page, "audit.settings.saved")).toBeVisible();
    const put = audit(mock, "PUT", "settings")[0];
    expect(put.body).toEqual({ schedule: { incrementalEveryMinutes: 30 } });
    expect(put.headers["if-match"]).toBe("etag-a");
    expect(put.headers["x-csrf-token"]).toBe("t");

    // A stale etag asks for a reload.
    await byId(page, "audit.set.logQueryText").check();
    answer = { status: 409, body: { ok: false, error: { code: "etag_mismatch", message: "stale" } } };
    await byId(page, "audit.settings.save").click();
    await expect(byId(page, "audit.settings.conflict")).toBeVisible();
    // The writer's own field errors show under their fields.
    answer = { status: 400, body: { ok: false, error: { code: "config_invalid", message: "bad" }, errors: [{ field: "retention.maxChains", code: "out_of_range", message: "too many" }] } };
    await byId(page, "audit.set.retention.maxChains").fill("20");
    await byId(page, "audit.settings.save").click();
    await expect(byId(page, "audit.set.retention.maxChains.field")).toContainText("This value is not accepted.");
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("without the audit service the page says so instead of failing; a viewer never reaches it", async ({ browser }) => {
  const missing = await newPage(browser, { bootstrap: NO_AUDIT });
  try {
    await open(missing.page, "audit/exports");
    await expect(byId(missing.page, "audit.unavailable")).toContainText("The audit service is not available");
    expect(missing.mock.find("GET", "/api/audit/")).toEqual([]);
  } finally {
    await missing.context.close();
  }
  const viewer = { role: "viewer", auth: { mode: "session", session: { role: "viewer", via: "none", paired: false, autoPairAvailable: false }, csrf: null } };
  const blocked = await newPage(browser, { role: viewer, api: auditApi({ "GET /api/session": { ok: true, role: "viewer", paired: false, csrfToken: null, pairCommand: "platform admin pair" } }) });
  try {
    await open(blocked.page, "audit/conversations");
    await expect(byId(blocked.page, "audit.unlock-card")).toHaveCount(0);
    expect(blocked.mock.find("GET", "/api/audit/")).toEqual([]);
  } finally {
    await blocked.context.close();
  }
});

// ---------------------------------------------------------------------------
// Language and layout

test("zh-CN: the audit speaks Chinese, and the English pages have no Han outside user content", async ({ browser }) => {
  const zh = await newPage(browser, { locale: "zh-CN" });
  try {
    await open(zh.page, "audit/exports");
    await expect(zh.page.locator("#main h1")).toHaveText("会话审计");
    await expect(byId(zh.page, "audit.chain")).toContainText("导出链：1 个完整基线 + 2 个增量");
    await expect(byId(zh.page, "audit.rebaseline")).toContainText("需要重新做完整导出");
    await open(zh.page, "audit/conversations");
    await expect(byId(zh.page, "audit.unlock-card")).toContainText("输入审计密码以查看会话内容");
  } finally {
    await zh.context.close();
  }
  for (const route of ["audit", "audit/exports", "audit/settings", "audit/conversations"]) {
    const en = await newPage(browser, { locale: "en-US" });
    try {
      await open(en.page, route);
      if (route === "audit/conversations") await expect(byId(en.page, "audit.unlock-card")).toBeVisible();
      await expect(byId(en.page, "audit.loading")).toHaveCount(0);
      const han = await en.page.evaluate(() => {
        const found = [];
        const walker = document.createTreeWalker(document.querySelector("#main"), NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (/\p{Script=Han}/u.test(node.textContent) && !node.parentElement.closest("[data-user-content]")) found.push(node.textContent.trim().slice(0, 40));
        }
        return found;
      });
      expect(han, route).toEqual([]);
    } finally {
      await en.context.close();
    }
  }
});

for (const theme of ["light", "dark"]) {
  for (const size of ["desktop", "phone"]) {
    test(`audit pages have no axe findings and no overflow, ${theme} at ${SIZES[size].width}`, async ({ browser }) => {
      test.setTimeout(240_000);
      const { context, page, failures } = await newPage(browser, { size: SIZES[size], theme });
      try {
        const check = async (label) => {
          await expect(byId(page, "audit.loading")).toHaveCount(0);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expectNoA11yViolations(page, { label: `${label} ${theme} ${size}` });
          const wide = await page.evaluate(() => {
            const limit = document.documentElement.clientWidth;
            const held = (node) => {
              for (let parent = node.parentElement; parent && parent.id !== "main"; parent = parent.parentElement) {
                if (/auto|scroll|hidden/.test(getComputedStyle(parent).overflowX) && parent.getBoundingClientRect().right <= limit + 1) return true;
              }
              return false;
            };
            return [...document.querySelectorAll("#main *")].filter((node) => node.getBoundingClientRect().right > limit + 1 && !held(node)).slice(0, 5)
              .map((node) => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}[${node.dataset.testid || ""}]`);
          });
          expect(wide, `${label}: elements past the right edge`).toEqual([]);
          await expectNoOverflow(page);
        };
        // Locked pages first (each is a fresh load), then the unlocked ones by client-side navigation.
        for (const route of ["audit", "audit/exports", "audit/settings", "audit/conversations", "audit/access-log"]) {
          await open(page, route);
          await expect(page.locator("[data-testid='audit.timeline'], [data-testid='audit.exports'], [data-testid='audit.settings.form'], [data-testid='audit.unlock-card']").first()).toBeVisible();
          await check(route);
        }
        await open(page, "audit/conversations");
        await unlock(page);
        await expect(byId(page, "audit.chats")).toBeVisible();
        await byId(page, "audit.chat.open").filter({ hasText: "Planning notes" }).click();
        await expect(byId(page, "audit.message").first()).toBeVisible();
        await check("audit/conversations thread");
        await page.keyboard.press("Escape");
        await byId(page, "audit.nav.access-log").click();
        await expect(byId(page, "audit.log.table")).toBeVisible();
        await check("audit/access-log unlocked");
        await byId(page, "audit.nav.exports").click();
        await expect(byId(page, "audit.chain-card")).toBeVisible();
        await check("audit/exports unlocked");
        expect(realFailures(failures)).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}
