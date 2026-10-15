// CON-20 browser checks (07 §13.2 console-access, part 1; 05 §13.7): the keys
// page (table, filters, attention strip, create drawer with presets, the
// one-time ShareCard, revoke, rotate and bulk revoke), a key's detail page
// (limits editor, usage, telemetry), the Customers and Audit tabs, the client
// guides, the legacy per-engine degrade path, CSRF on every write, a viewer
// seeing the PairingScreen, English without Han and no overflow at 390 px.
// The real service-entry serves the console; the API is mocked in the browser.
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
const SIZES = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = { role: "owner", auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" }, features: { access: true, public: true, session: true, telemetry: true } };
const VIEWER = { role: "viewer", auth: { mode: "session", session: { role: "viewer", via: "none", paired: false, autoPairAvailable: false }, csrf: null }, features: { access: true } };
const SESSION_UNPAIRED = { ok: true, role: "viewer", via: "none", paired: false, csrfToken: null, autoPairAvailable: false, pairCommand: "platform admin pair" };

const KEYS = fixture("access-keys");
const PRESETS = fixture("access-presets");
const CREATED = fixture("access-key-created");
const ALICE = KEYS.items[0];
const SECRET = CREATED.secret;
const CUSTOMER_ID = "3f0c2b1e-8a47-4d6e-9b1a-5c2d7e9f0a11";

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
    const body = (await response.text()).replace(BOOTSTRAP_BLOCK, (match, open, json, close) => `${open}${JSON.stringify(merge(JSON.parse(json), patch)).replace(/</g, "\\u003c")}${close}`);
    await route.fulfill({ response, body });
  }));
}

const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

function accessApi(extra = {}) {
  const hour = 3_600_000;
  const t0 = Math.floor((Date.now() - 24 * hour) / hour) * hour;
  const points = (values) => values.map((value, index) => [t0 + index * hour, value]);
  const detail = (key) => ({
    ok: true,
    key,
    usage: {
      day: { period: "d:2026-10-14", requests: 42, inputTokens: 1200, cachedInputTokens: 0, outputTokens: 800, errors: 1 },
      month: { period: "m:2026-10", requests: 900, inputTokens: 50000, cachedInputTokens: 0, outputTokens: 30000, errors: 7 },
      dayResetsAt: "2099-01-01T00:00:00.000Z",
      monthResetsAt: "2099-02-01T00:00:00.000Z",
    },
  });
  const routes = {
    "GET /api/status": fixture("status"),
    "GET /api/platform/status": fixture("platform-status"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/fleet": { updatedAt: "2026-10-14T08:00:00.000Z", instances: [{ id: "vllm:primary", instanceId: "vllm:primary", engineId: "vllm", running: true, models: ["qwen3.8-flash", "qwen3.8-dspark", "llama-8b"] }], settings: {} },
    "GET /api/access/keys": KEYS,
    "GET /api/access/presets": PRESETS,
    "GET /api/access/migration": { ok: true, report: null },
    "GET /api/access/audit": { ok: true, items: [{ id: 3, at: "2026-10-14T08:00:00.000Z", actor: "session:3f2a", actorIp: "127.0.0.1", action: "key.create", targetType: "key", targetId: ALICE.id, details: { preset: "friend" } }, { id: 2, at: "2026-10-13T08:00:00.000Z", actor: "migration", actorIp: null, action: "key.import", targetType: "key", targetId: "vllm.desk", details: {} }], nextCursor: null },
    "GET /api/billing/customers": { ok: true, items: [{ customerId: CUSTOMER_ID, externalRef: "acme", name: "Acme Co", status: "active", planId: "plan-basic", balanceMicrocredits: "2500000" }] },
    "GET /api/telemetry/live": { ok: true, at: "2026-10-14T08:00:05Z", windowSeconds: 60, gateway: {}, instances: [], gpus: [], alerts: { firing: 0, critical: 0 }, collectors: {} },
    "GET /api/telemetry/breakdown": { ok: true, dim: "key", rows: [{ key: ALICE.id, requests: 42, promptTokens: 1200, outputTokens: 800 }], total: { requests: 42 } },
    "GET /api/telemetry/timeseries": {
      ok: true,
      step: 3600,
      series: [
        { metric: "req.count", unit: "requests", group: null, points: points([3, 5, 0, 2, 8, 1]) },
        { metric: "tok.prompt", unit: "tokens", group: null, points: points([300, 500, 0, 200, 800, 100]) },
        { metric: "tok.output", unit: "tokens", group: null, points: points([100, 250, 0, 90, 300, 60]) },
      ],
      annotations: [],
    },
    "GET /api/telemetry/requests": { ok: true, rows: [{ requestId: "req_AAAAAAAAAAAAAAAAAAAA", receivedAt: isoAgo(300_000), status: 200, terminalState: "completed", modelResolved: "qwen3.8-flash", durationMs: 1840, ttftMs: 320, promptTokens: 120, outputTokens: 80, clientIp: "198.51.100.7", clientCountry: "DE" }], nextCursor: null },
    "POST /api/access/keys": CREATED,
    "POST /api/access/keys/bulk-revoke": (request) => ({ ok: true, revoked: JSON.parse(request.postData()).keyIds.length }),
    ...extra,
  };
  for (const key of KEYS.items) {
    routes[`GET /api/access/keys/${key.id}`] = routes[`GET /api/access/keys/${key.id}`] || detail(key);
    routes[`POST /api/access/keys/${key.id}/revoke`] = routes[`POST /api/access/keys/${key.id}/revoke`] || { ok: true, key: { ...key, status: "revoked" } };
    routes[`POST /api/access/keys/${key.id}/rotate`] = routes[`POST /api/access/keys/${key.id}/rotate`] || { ok: true, key, secret: "sk-plat-ROTATEDFAKEKEY00000000000000000000000" };
    routes[`PATCH /api/access/keys/${key.id}`] = routes[`PATCH /api/access/keys/${key.id}`] || ((request) => ({ ok: true, key: { ...key, ...JSON.parse(request.postData()) } }));
  }
  return routes;
}

async function newPage(browser, { bootstrap = OWNER, api = accessApi(), size = SIZES.desktop, theme = "light", locale = "en-US", session } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, bootstrap);
  const page = await context.newPage();
  const failures = await collectFailures(page);
  const mock = await mockConsoleApi(page, { ...api, ...(session ? { session } : {}) });
  return { context, page, mock, failures };
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const rowOf = (page, name) => page.locator('[data-testid="data-table.row"]', { hasText: name });
const urlOf = (path_) => `${entry.url}${path_.replace(/^\//, "")}`;
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));

async function hanOutsideUserContent(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#app").cloneNode(true);
    root.querySelectorAll("[data-user-content]").forEach((node) => node.remove());
    return root.textContent.match(/\p{Script=Han}+/gu) || [];
  });
}

async function noHorizontalOverflowInside(page, selector) {
  const sizes = await page.locator(selector).first().evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
  expect(sizes.scroll, `${selector} is ${sizes.scroll}px wide in ${sizes.client}px`).toBeLessThanOrEqual(sizes.client + 1);
}

async function openCreate(page) {
  await byId(page, "keys.create").click();
  await expect(byId(page, "key-drawer.root")).toBeVisible();
  await expect(byId(page, "key-form.preset.friend")).toBeVisible();
}

// ---------------------------------------------------------------------------
// The keys table

test("the key table lists keys with status, limits, tokens today, last use with country and expiry", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await page.goto(urlOf("/access/keys"));
    await expect(page.locator("#main h1")).toHaveText("Keys");
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(4);
    const alice = rowOf(page, "Alice laptop");
    await expect(alice).toContainText("Friend");
    await expect(alice).toContainText("Active");
    await expect(alice).toContainText("30 / 100,000");
    await expect(alice.locator('[data-testid="keys.today"]')).toHaveText("2,000");
    await expect(alice).toContainText("DE");
    await expect(alice).toContainText("sk-plat-Q…9xZk");
    await expect(rowOf(page, "Bob trial")).toContainText("Expired");
    await expect(rowOf(page, "Dave revoked")).toContainText("Revoked");
    await expect(rowOf(page, "Dave revoked").locator('[data-testid="keys.select"]')).toHaveCount(0);
    // The attention strip counts the expired key and the one nobody ever used; a click filters the table.
    await expect(byId(page, "keys.attention.expired")).toContainText("1");
    await expect(byId(page, "keys.attention.unused")).toContainText("1");
    await byId(page, "keys.attention.unused").click();
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="data-table.row"]')).toContainText("Carol app");
    await byId(page, "keys.attention.unused").click();
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(4);
    // Filters go to the server.
    await byId(page, "keys.filter-status").selectOption("active");
    await expect.poll(() => mock.calls.some((call) => call.path === "/api/access/keys" && call.query.status === "active")).toBe(true);
    await byId(page, "keys.search").fill("alice");
    await expect.poll(() => mock.calls.some((call) => call.path === "/api/access/keys" && call.query.q === "alice")).toBe(true);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Create and the one-time ShareCard (05 §13.7 CON-20)

test("a preset create shows the ShareCard once with QR and invite text; closing it leaves no secret anywhere", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await page.goto(urlOf("/access/keys"));
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(4);
    await openCreate(page);
    // The friend preset is the start: its limits and scopes are in the form.
    await expect(byId(page, "key-form.limit.rpm")).toHaveValue("30");
    await expect(byId(page, "key-form.limit.tpm")).toHaveValue("100000");
    await expect(byId(page, "key-form.limit.dailyTokens")).toHaveValue("2000000");
    await expect(byId(page, "key-form.scope.chat").locator("input")).toBeChecked();
    await expect(byId(page, "key-form.scope.mcp").locator("input")).not.toBeChecked();
    await expect(byId(page, "key-form.matches-count")).toHaveText("Matches 3 of 3 models");
    // The name is required.
    await byId(page, "key-drawer.submit").click();
    await expect(byId(page, "key-form.field.name")).toContainText("This field is required.");
    expect(mock.find("POST", "/api/access/keys")).toHaveLength(0);
    await byId(page, "key-form.name").fill("Frank friend");
    await byId(page, "key-form.holder").fill("Frank");
    await byId(page, "key-drawer.submit").click();

    const card = byId(page, "share-card.root");
    await expect(card).toBeVisible();
    const post = mock.find("POST", "/api/access/keys")[0];
    expect(post.headers["x-csrf-token"]).toBe("t");
    expect(post.body).toMatchObject({ preset: "friend", name: "Frank friend", holder: "Frank", class: "friend", models: ["*"], listeners: ["public"] });
    expect(post.body.limits).toMatchObject({ rpm: 30, tpm: 100000, maxConcurrent: 2, dailyTokens: 2000000, maxOutputTokens: 8192, monthlyTokens: null });
    expect(typeof post.body.expiresAt).toBe("string");
    expect(mock.csrfViolations).toEqual([]);

    await expect(byId(page, "share-card.warning")).toContainText("This key is shown only once");
    await expect(byId(page, "share-card.key.value")).toHaveValue(SECRET);
    await expect(byId(page, "share-card.openai.value")).toHaveValue("https://ai.example.test/v1");
    await expect(byId(page, "share-card.anthropic.value")).toHaveValue("https://ai.example.test/anthropic");
    await expect(byId(page, "share-card.curl")).toContainText("qwen3.8-flash");
    await expect(byId(page, "share-card.portal-link.value")).toHaveValue(`https://ai.example.test/me#key=${SECRET}`);
    await expect(byId(page, "share-card.qr").locator("svg[role='img']")).toBeVisible();
    await expect(byId(page, "share-card.qr").locator("svg path.qr-ink")).toHaveCount(1);
    const invite = byId(page, "share-card.invite-text");
    await expect(invite).toContainText("Hi Frank!");
    await expect(invite).toContainText(SECRET);
    await expect(invite).toContainText("https://ai.example.test/v1");
    await expect(invite).toContainText("Recommended model: qwen3.8-flash");
    // The invite can be copied in the other language (its catalog loads on demand).
    await byId(page, "share-card.lang-other").click();
    await expect(invite).toContainText("OpenAI 兼容地址");
    await expect(invite).toContainText(SECRET);

    // The card cannot be dismissed before the key is acknowledged.
    await expect(byId(page, "share-card.close")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(card).toBeVisible();
    await byId(page, "share-card.saved").check();
    await expect(byId(page, "share-card.close")).toBeEnabled();
    await byId(page, "share-card.close").click();
    await expect(card).toHaveCount(0);

    // Nothing of the secret is left: not in the DOM, the URL, the storages or the cookies.
    expect(await page.content()).not.toContain(SECRET);
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain("TESTONLYFAKEKEY");
    expect(page.url()).not.toContain("TESTONLYFAKEKEY");
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage, cookie: document.cookie }))).not.toContain("TESTONLYFAKEKEY");
    // There is no way back to it: the create button opens a fresh form.
    await openCreate(page);
    expect(await page.content()).not.toContain("TESTONLYFAKEKEY");
    await expect(byId(page, "share-card.root")).toHaveCount(0);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a 403 csrf_invalid on a write re-reads /api/session once and retries once", async ({ browser }) => {
  let attempts = 0;
  const api = accessApi({
    "POST /api/access/keys": () => {
      attempts += 1;
      return attempts === 1 ? { status: 403, body: { ok: false, error: { code: "csrf_invalid", message: "The session check failed." } } } : CREATED;
    },
  });
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(urlOf("/access/keys"));
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(4);
    const sessionReads = () => mock.calls.filter((call) => call.method === "GET" && call.path === "/api/session").length;
    const before = sessionReads();
    await openCreate(page);
    await byId(page, "key-form.name").fill("Frank friend");
    await byId(page, "key-drawer.submit").click();
    await expect(byId(page, "share-card.root")).toBeVisible();
    expect(attempts).toBe(2);
    expect(sessionReads() - before).toBe(1);
    expect(mock.find("POST", "/api/access/keys")).toHaveLength(2);
  } finally {
    await context.close();
  }
});

test("the paid preset needs a billing customer; a custom key can pick scopes and see which models match", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await page.goto(urlOf("/access/keys"));
    await openCreate(page);
    await byId(page, "key-form.preset.paid").click();
    await expect(byId(page, "key-form.class")).toHaveValue("customer");
    await expect(byId(page, "key-form.limit.rpm")).toHaveValue("60");
    await byId(page, "key-form.name").fill("Grace paid");
    await byId(page, "key-drawer.submit").click();
    await expect(byId(page, "key-form.field.customerId")).toContainText("This field is required.");
    await byId(page, "key-form.customerId").selectOption(CUSTOMER_ID);
    // Model patterns: a glob and an exclude, with the live match count.
    await byId(page, "key-form.models").fill("qwen*\n!qwen3.8-dspark");
    await expect(byId(page, "key-form.matches-count")).toHaveText("Matches 1 of 3 models");
    await expect(byId(page, "key-form.matches")).toContainText("qwen3.8-flash");
    await byId(page, "key-form.scope.audio.clone").locator("input").check();
    await byId(page, "key-form.limit.rpm").fill("0");
    await byId(page, "key-drawer.submit").click();
    await expect(byId(page, "key-form.field.rpm")).toContainText("outside the allowed range");
    await byId(page, "key-form.limit.rpm").fill("45");
    await byId(page, "key-drawer.submit").click();
    await expect(byId(page, "share-card.root")).toBeVisible();
    const body = mock.find("POST", "/api/access/keys")[0].body;
    expect(body).toMatchObject({ preset: "paid", customerId: CUSTOMER_ID, models: ["qwen*", "!qwen3.8-dspark"], class: "customer" });
    expect(body.scopes).toContain("audio.clone");
    expect(body.limits.rpm).toBe(45);
  } finally {
    await context.close();
  }
});

test("a server field error lands next to its field", async ({ browser }) => {
  const api = accessApi({ "POST /api/access/keys": { status: 400, body: { ok: false, error: { code: "invalid_field", message: "bad" }, errors: [{ field: "limits.tpm", code: "out_of_range", message: "tpm too large" }] } } });
  const { context, page } = await newPage(browser, { api });
  try {
    await page.goto(urlOf("/access/keys"));
    await openCreate(page);
    await byId(page, "key-form.name").fill("Hank");
    await byId(page, "key-drawer.submit").click();
    await expect(byId(page, "key-form.field.tpm")).toContainText("outside the allowed range");
    await expect(byId(page, "key-drawer.error")).toContainText("Fix the highlighted problems first.");
    await expect(byId(page, "share-card.root")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Field help in zh and en

test("every field has help from the access catalog in English and in Chinese", async ({ browser }) => {
  for (const [locale, rpm, label] of [
    ["en-US", "Maximum requests per minute. Beyond it the API returns 429; clients should wait for Retry-After.", "Requests per minute"],
    ["zh-CN", "每分钟最多请求数。超出返回 429，客户端应按 Retry-After 等待后重试。", "每分钟请求数"],
  ]) {
    const { context, page } = await newPage(browser, { locale });
    try {
      await page.goto(urlOf("/access/keys"));
      await byId(page, "keys.create").click();
      await expect(byId(page, "key-drawer.root")).toBeVisible();
      await expect(byId(page, "key-form.field.rpm")).toContainText(label);
      const fields = ["name", "holder", "class", "customerId", "notes", "models", "listeners", "rpm", "tpm", "maxConcurrent", "maxQueued", "queueTimeoutSeconds", "requestTimeoutSeconds", "dailyTokens", "monthlyTokens", "dailyRequests", "maxOutputTokens", "allowedOrigins", "allowedIps", "expires"];
      for (const field of fields) {
        const trigger = page.locator(`[data-testid="key-form.field.${field}"] [data-testid="help-popover.trigger"]`);
        await expect(trigger, `${locale} ${field} has a help button`).toHaveCount(1);
      }
      await page.locator('[data-testid="key-form.field.rpm"] [data-testid="help-popover.trigger"]').click();
      const panel = byId(page, "help-popover.panel");
      await expect(panel).toContainText(rpm);
      await expect(panel).toContainText("limits.rpm");
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(byId(page, "key-drawer.root")).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Revoke, rotate, bulk revoke

test("revoke needs the key name typed back and sends it as confirmName", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await page.goto(urlOf("/access/keys"));
    await rowOf(page, "Alice laptop").locator('[data-testid="keys.revoke"]').click();
    const dialog = byId(page, "key-dialog.revoke");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Revoke Alice laptop");
    await expect(dialog.locator('[data-testid="dialog.expected"]')).toHaveText("Alice laptop");
    const confirm = dialog.locator('[data-testid="dialog.confirm"]');
    await expect(confirm).toBeDisabled();
    await dialog.locator('[data-testid="dialog.input"]').fill("Alice");
    await expect(confirm).toBeDisabled();
    await dialog.locator('[data-testid="dialog.input"]').fill("Alice laptop");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    const post = mock.find("POST", `/api/access/keys/${ALICE.id}/revoke`)[0];
    expect(post.body).toEqual({ confirmName: "Alice laptop" });
    expect(post.headers["x-csrf-token"]).toBe("t");
    await expect(byId(page, "toast.root").first()).toContainText("Revoked Alice laptop");
  } finally {
    await context.close();
  }
});

test("bulk revoke needs REVOKE n for exactly the selected keys", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await page.goto(urlOf("/access/keys"));
    await rowOf(page, "Alice laptop").locator('[data-testid="keys.select"]').check();
    await rowOf(page, "Bob trial").locator('[data-testid="keys.select"]').check();
    await expect(byId(page, "keys.bulk-bar")).toContainText("2 keys selected");
    await byId(page, "keys.bulk-revoke").click();
    const dialog = byId(page, "key-dialog.bulk");
    await expect(dialog.locator('[data-testid="dialog.expected"]')).toHaveText("REVOKE 2");
    await expect(dialog).toContainText("Alice laptop");
    const confirm = dialog.locator('[data-testid="dialog.confirm"]');
    await dialog.locator('[data-testid="dialog.input"]').fill("REVOKE 3");
    await expect(confirm).toBeDisabled();
    await dialog.locator('[data-testid="dialog.input"]').fill("REVOKE 2");
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    const post = mock.find("POST", "/api/access/keys/bulk-revoke")[0];
    expect(post.body).toEqual({ keyIds: [ALICE.id, KEYS.items[1].id], confirm: "REVOKE 2" });
    expect(post.headers["x-csrf-token"]).toBe("t");
    await expect(byId(page, "keys.bulk-bar")).toHaveCount(0);
    // Select all skips the revoked key.
    await byId(page, "keys.select-all").check();
    await expect(byId(page, "keys.bulk-bar")).toContainText("3 keys selected");
  } finally {
    await context.close();
  }
});

test("rotate asks for the overlap and the key name, then shows the new key once", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await page.goto(urlOf("/access/keys"));
    await rowOf(page, "Alice laptop").locator('[data-testid="keys.rotate"]').click();
    const dialog = byId(page, "key-dialog.rotate");
    await expect(dialog.locator('[data-testid="key-dialog.overlap"] label')).toHaveText(["No overlap (stops at once)", "1 hour", "24 hours", "7 days"]);
    await byId(page, "key-dialog.overlap.86400").check();
    await dialog.locator('[data-testid="dialog.input"]').fill("Alice laptop");
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    const card = byId(page, "share-card.root");
    await expect(card).toBeVisible();
    await expect(card).toContainText("New key generated");
    await expect(byId(page, "share-card.key.value")).toHaveValue("sk-plat-ROTATEDFAKEKEY00000000000000000000000");
    await expect(card).toContainText("24 hours");
    const post = mock.find("POST", `/api/access/keys/${ALICE.id}/rotate`)[0];
    expect(post.body).toEqual({ overlapSeconds: 86400 });
    expect(post.headers["x-csrf-token"]).toBe("t");
    await byId(page, "share-card.saved").check();
    await byId(page, "share-card.close").click();
    expect(await page.content()).not.toContain("ROTATEDFAKEKEY");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Key detail

test("key detail shows the limits, usage of today and this month, a usage chart and recent requests", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser);
  try {
    await page.goto(urlOf(`/access/keys/${ALICE.id}`));
    await expect(page.locator("#main h1")).toHaveText("Alice laptop");
    await expect(byId(page, "key-detail.limit.rpm")).toHaveText("30 requests/min");
    await expect(byId(page, "key-detail.limit.monthlyTokens")).toHaveText("No cap");
    await expect(byId(page, "key-detail.limit.maxQueued")).toHaveText("Inherits the default");
    const requestsToday = byId(page, "key-detail.usage.day.requests");
    await expect(requestsToday.locator("data")).toHaveText("42");
    await expect(byId(page, "key-detail.usage.day.tokens").locator("data")).toHaveText("2,000");
    await expect(byId(page, "key-detail.usage.day.tokens")).toContainText("2,000,000");
    await expect(byId(page, "key-detail.usage.month.requests").locator("data")).toHaveText("900");
    // Telemetry: charts and the recent requests of this key only.
    await expect(byId(page, "key-usage.requests-chart")).toBeVisible();
    await expect(byId(page, "key-usage.tokens-chart")).toBeVisible();
    await expect(byId(page, "key-usage.requests")).toContainText("qwen3.8-flash");
    await expect(byId(page, "key-usage.requests")).toContainText("198.51.100.7 · DE");
    await expect(byId(page, "key-usage.request-link").first()).toHaveAttribute("href", "/observability/requests/req_AAAAAAAAAAAAAAAAAAAA");
    const series = mock.find("GET", "/api/telemetry/timeseries")[0];
    expect(series.query.key_id).toBe(ALICE.id);
    expect(series.query.metrics).toBe("req.count,tok.prompt,tok.output");
    expect(mock.find("GET", "/api/telemetry/requests")[0].query.key_id).toBe(ALICE.id);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the limits editor patches only what changed, and revoke from the detail page confirms by name", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await page.goto(urlOf(`/access/keys/${ALICE.id}`));
    await byId(page, "key-detail.edit-limits").click();
    const drawer = byId(page, "key-drawer.root");
    await expect(drawer).toBeVisible();
    await expect(byId(page, "key-form.name")).toHaveValue("Alice laptop");
    await expect(byId(page, "key-form.preset.friend")).toHaveCount(0);
    await byId(page, "key-form.limit.rpm").fill("45");
    await byId(page, "key-form.limit.dailyTokens").fill("");
    await byId(page, "key-drawer.submit").click();
    await expect(drawer).toHaveCount(0);
    const patch = mock.find("PATCH", `/api/access/keys/${ALICE.id}`)[0];
    expect(patch.body).toEqual({ limits: { rpm: 45, dailyTokens: null } });
    expect(patch.headers["x-csrf-token"]).toBe("t");

    await byId(page, "key-detail.revoke").click();
    const dialog = byId(page, "key-dialog.revoke");
    await dialog.locator('[data-testid="dialog.input"]').fill("Alice laptop");
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    await expect(dialog).toHaveCount(0);
    expect(mock.find("POST", `/api/access/keys/${ALICE.id}/revoke`)[0].body).toEqual({ confirmName: "Alice laptop" });
  } finally {
    await context.close();
  }
});

test("a missing key and a missing telemetry feature degrade to clear messages", async ({ browser }) => {
  const missing = accessApi({ "GET /api/access/keys/k_missing": { status: 404, body: { ok: false, error: { code: "key_not_found", message: "Key not found." } } } });
  const one = await newPage(browser, { api: missing });
  try {
    await one.page.goto(urlOf("/access/keys/k_missing"));
    await expect(one.page.locator("#main h1")).toHaveText("Key not found");
    await expect(byId(one.page, "empty-state.action")).toHaveAttribute("href", "/access/keys");
  } finally {
    await one.context.close();
  }
  const two = await newPage(browser, { bootstrap: { ...OWNER, features: { ...OWNER.features, telemetry: false } } });
  try {
    await two.page.goto(urlOf(`/access/keys/${ALICE.id}`));
    await expect(two.page.locator("#main")).toContainText("No telemetry available");
    expect(two.mock.find("GET", "/api/telemetry/")).toHaveLength(0);
    await two.page.goto(urlOf("/access/keys"));
    await expect(rowOf(two.page, "Alice laptop").locator('[data-testid="keys.today"]')).toHaveText("—");
  } finally {
    await two.context.close();
  }
});

// ---------------------------------------------------------------------------
// Customers and Audit tabs, the landing page

test("the Customers tab starts a Paid key for a customer, and the Audit tab lists the trail", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser);
  try {
    await page.goto(urlOf("/access/keys"));
    await page.getByRole("tab", { name: "Customers" }).click();
    await expect(byId(page, "customers.panel")).toContainText("Acme Co");
    await expect(byId(page, "customers.panel")).toContainText("2.5");
    await byId(page, "customers.new-key").click();
    await expect(byId(page, "key-drawer.root")).toBeVisible();
    await expect(byId(page, "key-form.customerId")).toHaveValue(CUSTOMER_ID);
    await expect(byId(page, "key-form.class")).toHaveValue("customer");
    await byId(page, "key-drawer.cancel").click();
    await expect(byId(page, "key-drawer.root")).toHaveCount(0);
    // "View keys" filters the key table by that customer.
    await byId(page, "customers.keys").click();
    await expect(page.getByRole("tab", { name: /Keys/ })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => mock.calls.some((call) => call.path === "/api/access/keys" && call.query.customer === CUSTOMER_ID)).toBe(true);
    await expect(byId(page, "keys.filter-customer")).toContainText("Acme Co");

    await page.getByRole("tab", { name: "Audit" }).click();
    await expect(byId(page, "audit.panel")).toContainText("Created a key");
    await expect(byId(page, "audit.panel")).toContainText("Imported legacy keys");
    await byId(page, "audit.filter-action").fill("key.create");
    await expect.poll(() => mock.calls.some((call) => call.path === "/api/access/audit" && call.query.action === "key.create")).toBe(true);
  } finally {
    await context.close();
  }
});

test("the access landing page shows its cards, the key counts and a migration banner with warnings", async ({ browser }) => {
  const api = accessApi({
    "GET /api/access/migration": { ok: true, report: { at: "2026-10-01T00:00:00.000Z", complete: true, counts: { planned: 3, inserted: 3, skipped: 0, warnings: 2 }, warnings: [{ code: "global_key_converted", managerId: "vllm" }, { code: "cors_open_not_migrated", managerId: "llama" }] } },
  });
  const { context, page } = await newPage(browser, { api });
  try {
    await page.goto(urlOf("/access"));
    await expect(page.locator("#main h1")).toHaveText("Access & keys");
    for (const id of ["keys", "public", "security", "clients", "sessions", "portal"]) await expect(byId(page, `access.card.${id}`)).toBeVisible();
    await expect(byId(page, "access.card.keys")).toHaveAttribute("href", "/access/keys");
    await expect(byId(page, "access.summary.keys")).toHaveText("3 active of 4");
    const banner = byId(page, "access.migration");
    await expect(banner).toContainText("3 keys were migrated, with 2 notes.");
    await expect(banner).toContainText("The global key of vllm was converted to a platform key.");
    await expect(byId(page, "access.migration-link")).toHaveAttribute("href", "/access/keys");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Client guides

test("client guides fill in the base URL and model, keep $API_KEY, and never show a key", async ({ browser }) => {
  const api = accessApi({ "GET /api/public/settings": { ok: true, config: { listeners: { public: { baseUrl: "https://ai.example.test" } } }, etag: "e" } });
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(urlOf("/access/clients"));
    await expect(page.locator("#main h1")).toHaveText("Client guides");
    const origin = new URL(entry.url).origin;
    await expect(byId(page, "clients.openai.value")).toHaveText(`${origin}/gateway/auto/openai/v1`);
    await expect(byId(page, "clients.anthropic.value")).toHaveText(`${origin}/gateway/auto/claude`);
    await byId(page, "clients.route.lan").click();
    await expect(byId(page, "clients.openai.value")).toContainText("<LAN-IP>");
    await expect(byId(page, "clients.lan-hint")).toBeVisible();
    await expect(byId(page, "clients.route.public")).toBeEnabled();
    await byId(page, "clients.route.public").click();
    await expect(byId(page, "clients.openai.value")).toHaveText("https://ai.example.test/v1");
    await expect(byId(page, "clients.anthropic.value")).toHaveText("https://ai.example.test/anthropic");

    // The seven guides, each with the right placeholders.
    await expect(page.getByRole("tab")).toHaveText(["Open WebUI", "Claude Code", "OpenCode", "Chatbox", "Cherry Studio", "curl", "Python"]);
    await expect(byId(page, "clients.guide.openwebui")).toContainText("OPENAI_API_BASE_URL=https://ai.example.test/v1");
    await expect(byId(page, "clients.guide.openwebui")).toContainText("OPENAI_API_KEY=$API_KEY");
    await byId(page, "clients.model").fill("qwen3.8-flash");
    await page.getByRole("tab", { name: "Claude Code" }).click();
    const claude = byId(page, "clients.snippet.claude-code.bash");
    await expect(claude).toContainText("export ANTHROPIC_BASE_URL=https://ai.example.test/anthropic");
    await expect(claude).toContainText("export ANTHROPIC_AUTH_TOKEN=$API_KEY");
    await expect(claude).toContainText("export ANTHROPIC_MODEL=qwen3.8-flash");
    await page.getByRole("tab", { name: "curl" }).click();
    await expect(byId(page, "clients.snippet.curl.openai")).toContainText("curl https://ai.example.test/v1/chat/completions");
    await expect(byId(page, "clients.snippet.curl.openai")).toContainText('"model": "qwen3.8-flash"');
    await expect(byId(page, "clients.snippet.curl.anthropic")).toContainText("x-api-key: $API_KEY");
    await page.getByRole("tab", { name: "Chatbox" }).click();
    await expect(byId(page, "clients.row.chatbox.baseUrl.value")).toHaveText("https://ai.example.test/v1");
    await expect(byId(page, "clients.row.chatbox.key.value")).toHaveText("$API_KEY");
    const text = await page.locator("#main").innerText();
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
    expect(mock.find("POST", "/")).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("without a public base URL the Public route is unavailable and says why", async ({ browser }) => {
  const api = accessApi({ "GET /api/public/settings": { ok: true, config: { listeners: { public: { baseUrl: "" } } }, etag: "e" } });
  const { context, page } = await newPage(browser, { api });
  try {
    await page.goto(urlOf("/access/clients"));
    await expect(byId(page, "clients.route.public")).toBeDisabled();
    await expect(byId(page, "clients.public-missing")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("owner-only pages show the PairingScreen to a viewer; the client guides stay readable", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { bootstrap: VIEWER, session: SESSION_UNPAIRED });
  try {
    for (const route of ["/access", "/access/keys", `/access/keys/${ALICE.id}`]) {
      await page.goto(urlOf(route));
      await expect(byId(page, "pairing-screen.root")).toBeVisible();
    }
    expect(mock.find("GET", "/api/access/")).toHaveLength(0);
    await page.goto(urlOf("/access/clients"));
    await expect(byId(page, "clients.root")).toBeVisible();
    await expect(byId(page, "pairing-screen.root")).toHaveCount(0);
    await expect(byId(page, "clients.openai.value")).toBeVisible();
    expect(mock.find("GET", "/api/public/settings")).toHaveLength(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// The legacy degrade path (before 05)

test("without the key store the page shows the legacy per-engine keys and manages them through the proxy", async ({ browser }) => {
  const legacy = {
    ok: true,
    keys: {
      clients: [
        { manager: "vllm", managerName: "vLLM", id: "desk", name: "Desk client", state: "active", createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, expiresAt: null, allowedModels: [], rateLimitRpm: 20, neverUsed: true, unused: false, expiringSoon: false },
        { manager: "llama", managerName: "llama.cpp", id: "old", name: "Old client", state: "expired", createdAt: "2025-01-01T00:00:00.000Z", lastUsedAt: "2025-02-01T00:00:00.000Z", expiresAt: "2025-03-01T00:00:00.000Z", allowedModels: ["a"], rateLimitRpm: null, neverUsed: false, unused: false, expiringSoon: false },
      ],
      perManager: [{ manager: "vllm", managerName: "vLLM", online: true }, { manager: "llama", managerName: "llama.cpp", online: true }],
    },
  };
  const api = {
    ...accessApi(),
    "GET /api/keys": legacy,
    "POST /api/m/vllm/service-clients": (request) => ({ ok: true, apiKey: "sk-legacy-TESTONLYFAKEKEY0000", client: { id: "new", name: JSON.parse(request.postData()).name } }),
    "POST /api/m/vllm/service-clients/desk/rotate": { ok: true, apiKey: "sk-legacy-ROTATEDFAKE00000", client: { id: "desk", name: "Desk client" } },
    "DELETE /api/m/llama/service-clients/old": { ok: true, removed: true, id: "old" },
  };
  const { context, page, mock } = await newPage(browser, { bootstrap: { ...OWNER, features: { access: false, telemetry: false } }, api });
  try {
    await page.goto(urlOf("/access/keys"));
    await expect(byId(page, "keys-legacy.banner")).toContainText("Legacy per-engine keys");
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(2);
    await expect(rowOf(page, "Desk client")).toContainText("vLLM");
    await expect(rowOf(page, "Old client")).toContainText("Expired");
    expect(mock.find("GET", "/api/access/")).toHaveLength(0);

    await byId(page, "legacy.create-open").click();
    await byId(page, "legacy.name").fill("New client");
    await byId(page, "legacy.rpm").fill("15");
    await byId(page, "legacy.submit").click();
    await expect(byId(page, "share-card.root")).toBeVisible();
    await expect(byId(page, "share-card.key.value")).toHaveValue("sk-legacy-TESTONLYFAKEKEY0000");
    await expect(byId(page, "share-card.portal")).toHaveCount(0);
    const create = mock.find("POST", "/api/m/vllm/service-clients")[0];
    expect(create.body).toEqual({ name: "New client", rateLimitRpm: 15 });
    expect(create.headers["x-csrf-token"]).toBe("t");
    await byId(page, "share-card.saved").check();
    await byId(page, "share-card.close").click();
    expect(await page.content()).not.toContain("TESTONLYFAKEKEY");

    await rowOf(page, "Desk client").locator('[data-testid="legacy.rotate"]').click();
    const rotate = byId(page, "legacy.rotate-dialog");
    await rotate.locator('[data-testid="dialog.input"]').fill("Desk client");
    await rotate.locator('[data-testid="dialog.confirm"]').click();
    await expect(byId(page, "share-card.key.value")).toHaveValue("sk-legacy-ROTATEDFAKE00000");
    await byId(page, "share-card.saved").check();
    await byId(page, "share-card.close").click();

    await rowOf(page, "Old client").locator('[data-testid="legacy.revoke"]').click();
    const remove = byId(page, "legacy.remove-dialog");
    await remove.locator('[data-testid="dialog.input"]').fill("Old client");
    await remove.locator('[data-testid="dialog.confirm"]').click();
    await expect(remove).toHaveCount(0);
    expect(mock.find("DELETE", "/api/m/llama/service-clients/old")).toHaveLength(1);
    expect(mock.csrfViolations).toEqual([]);

    await page.goto(urlOf("/access"));
    await expect(byId(page, "access.legacy-note")).toContainText("Legacy per-engine keys");
    await expect(byId(page, "access.summary.keys")).toHaveText("2 legacy per-engine keys");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// English without Han, 390 px, accessibility

test("English mode shows no Han text outside user content, on every access page and dialog", async ({ browser }) => {
  const { context, page } = await newPage(browser, { locale: "en-US" });
  try {
    await page.goto(urlOf("/access"));
    await expect(byId(page, "access.card.keys")).toBeVisible();
    expect(await hanOutsideUserContent(page)).toEqual([]);
    await page.goto(urlOf("/access/keys"));
    await expect(page.locator('[data-testid="data-table.row"]')).toHaveCount(4);
    expect(await hanOutsideUserContent(page)).toEqual([]);
    await openCreate(page);
    expect(await hanOutsideUserContent(page)).toEqual([]);
    await byId(page, "key-form.name").fill("Frank friend");
    await byId(page, "key-drawer.submit").click();
    await expect(byId(page, "share-card.root")).toBeVisible();
    expect(await hanOutsideUserContent(page)).toEqual([]);
    await byId(page, "share-card.saved").check();
    await byId(page, "share-card.close").click();
    for (const tab of ["Customers", "Audit"]) {
      await page.getByRole("tab", { name: tab }).click();
      expect(await hanOutsideUserContent(page)).toEqual([]);
    }
    await page.goto(urlOf(`/access/keys/${ALICE.id}`));
    await expect(byId(page, "key-usage.requests")).toBeVisible();
    expect(await hanOutsideUserContent(page)).toEqual([]);
    await page.goto(urlOf("/access/clients"));
    for (const name of ["Open WebUI", "Claude Code", "OpenCode", "Chatbox", "Cherry Studio", "curl", "Python"]) {
      await page.getByRole("tab", { name }).click();
      expect(await hanOutsideUserContent(page), name).toEqual([]);
    }
    // And the same pages in Chinese have no raw catalog keys.
  } finally {
    await context.close();
  }
  const zh = await newPage(browser, { locale: "zh-CN" });
  try {
    for (const route of ["/access", "/access/keys", `/access/keys/${ALICE.id}`, "/access/clients"]) {
      await zh.page.goto(urlOf(route));
      await expect(zh.page.locator("#main h1")).toBeVisible();
      const text = await zh.page.locator("#main").innerText();
      expect(text.match(/\baccess\.[a-z][A-Za-z.-]+/g) || [], route).toEqual([]);
    }
    await zh.page.goto(urlOf("/access/keys"));
    await openCreate(zh.page);
    expect((await zh.page.locator("#main").innerText()).match(/\baccess\.[a-z][A-Za-z.-]+/g) || []).toEqual([]);
    await byId(zh.page, "key-form.name").fill("小王");
    await byId(zh.page, "key-drawer.submit").click();
    await expect(byId(zh.page, "share-card.warning")).toHaveText("密钥只显示这一次，关闭后无法再次查看。");
    await expect(byId(zh.page, "share-card.saved")).toBeVisible();
    await expect(zh.page.getByText("我已保存密钥")).toBeVisible();
  } finally {
    await zh.context.close();
  }
});

test("no horizontal overflow at 390 px on the keys page, the drawer, the share card, the detail page and the guides", async ({ browser }) => {
  const { context, page, failures } = await newPage(browser, { size: SIZES.phone });
  try {
    await page.goto(urlOf("/access/keys"));
    await expect(byId(page, "keys.root")).toBeVisible();
    await expect(page.locator('[data-testid="data-table.card"]').first()).toBeVisible();
    await expectNoOverflow(page);
    await openCreate(page);
    await expectNoOverflow(page);
    await noHorizontalOverflowInside(page, '[data-testid="key-drawer.root"] .overlay-body');
    await byId(page, "key-form.name").fill("Frank friend");
    await byId(page, "key-drawer.submit").click();
    await expect(byId(page, "share-card.root")).toBeVisible();
    await expectNoOverflow(page);
    await noHorizontalOverflowInside(page, '[data-testid="share-card.root"]');
    await noHorizontalOverflowInside(page, '[data-testid="share-card.root"] .overlay-body');
    await byId(page, "share-card.saved").check();
    await byId(page, "share-card.close").click();
    for (const route of ["/access", `/access/keys/${ALICE.id}`, "/access/clients"]) {
      await page.goto(urlOf(route));
      await expect(page.locator("#main h1")).toBeVisible();
      await expectNoOverflow(page);
    }
    await page.getByRole("tab", { name: "curl" }).click();
    await expect(byId(page, "clients.snippet.curl.openai")).toBeVisible();
    await expectNoOverflow(page);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const [theme, size, label] of [["light", SIZES.desktop, "light 1440"], ["dark", SIZES.desktop, "dark 1440"], ["light", SIZES.phone, "light 390"], ["dark", SIZES.phone, "dark 390"]]) {
  test(`axe finds nothing on the access pages, the drawer and the share card (${label})`, async ({ browser }) => {
    const { context, page } = await newPage(browser, { theme, size });
    try {
      await page.goto(urlOf("/access"));
      await expect(byId(page, "access.card.keys")).toBeVisible();
      await expectNoA11yViolations(page, { label: `access ${label}` });
      await page.goto(urlOf("/access/keys"));
      await expect(page.locator('[data-testid="data-table.row"], [data-testid="data-table.card"]').first()).toBeVisible();
      await expectNoA11yViolations(page, { label: `keys ${label}` });
      await openCreate(page);
      await expectNoA11yViolations(page, { label: `drawer ${label}` });
      await byId(page, "key-form.name").fill("Frank friend");
      await byId(page, "key-drawer.submit").click();
      await expect(byId(page, "share-card.root")).toBeVisible();
      await expectNoA11yViolations(page, { label: `share card ${label}` });
      await byId(page, "share-card.saved").check();
      await byId(page, "share-card.close").click();
      await page.getByRole("tab", { name: "Customers" }).click();
      await expect(byId(page, "customers.panel")).toBeVisible();
      await expectNoA11yViolations(page, { label: `customers ${label}` });
      await page.getByRole("tab", { name: "Audit" }).click();
      await expect(byId(page, "audit.panel")).toBeVisible();
      await expectNoA11yViolations(page, { label: `audit ${label}` });
      await page.goto(urlOf(`/access/keys/${ALICE.id}`));
      await expect(byId(page, "key-usage.requests")).toBeVisible();
      await expectNoA11yViolations(page, { label: `detail ${label}` });
      await page.goto(urlOf("/access/clients"));
      await expect(byId(page, "clients.root")).toBeVisible();
      await expectNoA11yViolations(page, { label: `clients ${label}` });
    } finally {
      await context.close();
    }
  });
}

// ===========================================================================
// Part 2 (CON-21, 05 §13.7): the Public access wizard, the Security & audit
// page, the sessions page and the portal page. The API is mocked in the
// browser; the exposure report is the 05 scanner's own golden, the security
// overview was generated from the real module (tests/fixtures/console).
// ===========================================================================

const EXPOSURE = fixture("access-exposure");
const SECURITY = fixture("access-security");
const SESSIONS = fixture("access-sessions");
const CURRENT_SESSION = SESSIONS.items[0];
const OTHER_SESSION = SESSIONS.items[1];
const PAIR_CODE = "QX7M2KD9TF";

function settingsView(state) {
  return {
    ok: true,
    config: {
      listeners: { public: { baseUrl: state.baseUrl } },
      public: { managersGatewayOnly: state.gatewayOnly },
      admin: { legacyProxyGateway: state.legacy },
      trustedProxies: { cidrs: state.cidrs },
    },
    etag: `etag-${state.rev}`,
    issues: [],
  };
}

/** The Public access endpoints with the state a wizard run changes (saved address, enforced modes, trusted proxies). */
function publicApi({ baseUrl = "", keys, templatesExist = false, events } = {}) {
  const state = { baseUrl, gatewayOnly: "warn", legacy: "serve", cidrs: ["127.0.0.1/32"], rev: 1, patches: [] };
  const direct = events?.direct || [
    { id: 11, at: isoAgo(3_600_000), type: "security.direct_manager_gateway", severity: "warning", data: { kind: "service", path: "/v1/chat/completions", remoteAddress: "192.0.2.10", suppressed: 4 } },
    { id: 12, at: isoAgo(7_200_000), type: "security.direct_manager_gateway", severity: "warning", data: { kind: "legacy", path: "/v1/models", remoteAddress: "192.0.2.11", suppressed: 0 } },
    { id: 13, at: isoAgo(24 * 9 * 3_600_000), type: "security.direct_manager_gateway", severity: "warning", data: { kind: "service", path: "/old", remoteAddress: "192.0.2.99" } },
  ];
  const viaProxy = events?.viaProxy || [
    { id: 21, at: isoAgo(5_400_000), type: "security.admin_via_proxy", severity: "warning", data: { kind: "admin_via_proxy", pathClass: "gateway", outcome: "served", headers: ["x-forwarded-for"] } },
  ];
  const routes = {
    "GET /api/public/settings": () => settingsView(state),
    "PATCH /api/public/settings": (request, route, record) => {
      const body = record.body;
      state.patches.push({ body, ifMatch: record.headers["if-match"] });
      if (body.section === "listeners") state.baseUrl = body.patch.public.baseUrl;
      if (body.section === "public") state.gatewayOnly = body.patch.managersGatewayOnly;
      if (body.section === "admin") state.legacy = body.patch.legacyProxyGateway;
      if (body.section === "trustedProxies") state.cidrs = body.patch.cidrs;
      state.rev += 1;
      return { ok: true, etag: `etag-${state.rev}`, restartRequired: body.section === "listeners" ? ["service-entry"] : [], changed: [body.section] };
    },
    "GET /api/public/exposure": EXPOSURE,
    "POST /api/public/exposure/scan": EXPOSURE,
    "POST /api/public/probe": {
      ok: true,
      probe: {
        url: "https://api.example.invalid/status.json?probe=0123456789abcdef",
        at: "2026-10-15T12:00:30.000Z",
        status: 200,
        latencyMs: 180,
        nonceObserved: false,
        observed: { viaProxy: true, headerUsed: null, socketIp: "172.18.0.1", country: null, forwardedOnUntrusted: true },
        tls: { validTo: "2026-12-01T00:00:00.000Z", authorized: true },
        error: null,
      },
    },
    "GET /api/public/templates": (request) => {
      const topology = new URL(request.url()).searchParams.get("topology");
      return {
        ok: true,
        files: topology === "lan" ? [] : [
          { name: "cloudflared.compose.yaml", content: "services:\n  cloudflared:\n    image: cloudflare/cloudflared:2026.1.0\n" },
          { name: "cloudflared.env.example", content: "TUNNEL_TOKEN=\n" },
        ],
        commands: topology === "lan" ? ["cd <AI_ROOT>\\config\\public"] : ["cd <AI_ROOT>\\config\\public", "docker compose -f cloudflared.compose.yaml up -d"],
      };
    },
    "POST /api/public/templates/write": (request, route, record) => {
      if (templatesExist && !record.body.overwrite) {
        return { status: 409, body: { ok: false, error: { code: "template_exists", message: "Some files already exist, so nothing was written.", existing: ["cloudflared.env.example"] } } };
      }
      return { ok: true, written: ["config/public/cloudflared.compose.yaml", "config/public/cloudflared.env.example"] };
    },
    "GET /api/security/events": (request) => {
      const type = new URL(request.url()).searchParams.get("type");
      const items = type === "direct_manager_gateway" ? direct : type === "admin_via_proxy" ? viaProxy : [...direct, ...viaProxy];
      return { ok: true, items, nextCursor: null, source: "ring" };
    },
    ...(keys ? { "GET /api/access/keys": keys } : {}),
  };
  return { state, routes };
}

const stepOf = (page, id) => byId(page, `public.step.${id}`);
const next = (page) => byId(page, "public.next").click();

test("the wizard walks topology, address, files, keys, checks, map and go-live from a stubbed report", async ({ browser }) => {
  const api = publicApi();
  const { context, page, mock, failures } = await newPage(browser, { api: { ...accessApi(), ...api.routes } });
  try {
    await page.goto(urlOf("/access/public"));
    await expect(page.locator("#main h1")).toHaveText("Public access");

    // 1. Topology: three cards with their pros and cons; Cloudflare is recommended and chosen.
    await expect(stepOf(page, "topology")).toBeVisible();
    await expect(page.locator("label.pw-card")).toHaveCount(3);
    await expect(byId(page, "public.topology.cloudflared")).toContainText("Recommended");
    await expect(byId(page, "public.topology.cloudflared")).toContainText("Outbound only: no open ports, TLS and protection at the edge.");
    await expect(byId(page, "public.topology.caddy")).toContainText("Needs ports 80 and 443 forwarded on your router.");
    await expect(byId(page, "public.topology.lan")).toContainText("LAN only");
    await expect(byId(page, "public.topology.cloudflared").locator("input")).toBeChecked();
    await expect(byId(page, "public.steps").locator('[data-testid="stepper.step"]')).toHaveCount(7);
    await expect(byId(page, "public.steps").locator('[aria-current="step"]')).toContainText("Topology");
    await next(page);

    // 2. Address: https only; it is saved through PATCH /api/public/settings with the etag.
    await expect(stepOf(page, "baseUrl")).toBeVisible();
    await expect(byId(page, "public.baseurl.save")).toBeDisabled();
    await byId(page, "public.baseurl.input").fill("http://ai.example.com");
    await expect(byId(page, "public.baseurl.error")).toHaveText("The address must start with https://.");
    await expect(byId(page, "public.baseurl.save")).toBeDisabled();
    await byId(page, "public.baseurl.input").fill("https://ai.example.com/v1");
    await expect(byId(page, "public.baseurl.error")).toContainText("without a path");
    await byId(page, "public.baseurl.input").fill("https://ai.example.com");
    await expect(byId(page, "public.baseurl.error")).toHaveCount(0);
    expect(api.state.patches).toHaveLength(0);
    await byId(page, "public.baseurl.save").click();
    await expect(byId(page, "public.baseurl.saved")).toContainText("Saved.");
    await expect(byId(page, "public.baseurl.saved")).toContainText("Restart needed for: service-entry. The platform restarts nothing by itself.");
    expect(api.state.patches).toEqual([{ body: { section: "listeners", patch: { public: { baseUrl: "https://ai.example.com" } } }, ifMatch: "etag-1" }]);
    expect(mock.find("PATCH", "/api/public/settings")[0].headers["x-csrf-token"]).toBe("t");
    await next(page);

    // 3. Files: shown and copyable; nothing is written until the click, and then with overwrite:false.
    await expect(stepOf(page, "templates")).toBeVisible();
    await expect(byId(page, "public.templates.file")).toHaveCount(2);
    await expect(byId(page, "public.templates.commands")).toContainText("docker compose -f cloudflared.compose.yaml up -d");
    await expect(byId(page, "public.templates.commands").locator('[data-testid="code-block.copy"]')).toBeVisible();
    expect(mock.calls.some((call) => call.path === "/api/public/templates" && call.query.topology === "cloudflared-token")).toBe(true);
    expect(mock.find("POST", "/api/public/templates/write")).toHaveLength(0);
    await byId(page, "public.templates.write").click();
    await expect(byId(page, "public.templates.written")).toContainText("config/public/cloudflared.compose.yaml");
    const writes = mock.find("POST", "/api/public/templates/write");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ topology: "cloudflared-token", overwrite: false });
    expect(writes[0].headers["x-csrf-token"]).toBe("t");
    await next(page);

    // 4. Keys: the keys that can serve the public address (Alice and Carol; the expired and the revoked one do not count).
    await expect(stepOf(page, "keys")).toBeVisible();
    await expect(byId(page, "public.keys.ok")).toContainText("Active keys that can use the public address: 2");
    await next(page);

    // 5. Checks: the stubbed report, each failing check with its fix hint.
    await expect(stepOf(page, "checks")).toBeVisible();
    await expect(byId(page, "checks-list.item")).toHaveCount(18);
    await expect(byId(page, "checks-list.summary")).toHaveText("6 ok, 4 to review, 8 failing");
    const legacyProxy = page.locator('[data-check="legacy_proxy"]');
    await expect(legacyProxy).toHaveAttribute("data-state", "fail");
    await expect(legacyProxy).toContainText("No old public proxy is running");
    await expect(legacyProxy).toContainText("55177");
    await expect(legacyProxy.locator('[data-testid="checks-list.fix"]')).toContainText("Stop the old proxy yourself");
    await expect(page.locator('[data-check="public_listener"] [data-testid="checks-list.fix"]')).toHaveCount(0);
    await expect(page.locator('[data-check="upnp"]')).toHaveAttribute("data-state", "manual");
    await byId(page, "public.checks.rescan").click();
    await expect.poll(() => mock.find("POST", "/api/public/exposure/scan").length).toBe(1);
    await byId(page, "public.checks.probe").click();
    await expect(byId(page, "public.probe")).toContainText("Request not seen on the public listener");
    await expect(byId(page, "public.probe.socket")).toContainText("172.18.0.1");
    expect(mock.find("POST", "/api/public/probe")).toHaveLength(1);
    await next(page);

    // 6. Map: nodes and edges from the report, with the evidence.
    await expect(stepOf(page, "map")).toBeVisible();
    await expect(byId(page, "exposure-map.node")).toHaveCount(8);
    await expect(byId(page, "exposure-map.edge")).toHaveCount(11);
    await expect(byId(page, "exposure-map.row")).toHaveCount(11);
    await next(page);

    // 7. Go live: the callers that skipped the entry are listed before anything is enforced.
    await expect(stepOf(page, "golive")).toBeVisible();
    await expect(byId(page, "public.live.direct-row")).toHaveCount(2);
    await expect(byId(page, "public.live.warn")).toContainText("Callers that still skip the entry: 3 (last 7 days)");
    await expect(byId(page, "public.next")).toHaveCount(0);
    const patchesBefore = api.state.patches.length;
    await byId(page, "public.live.enforce").click();
    const confirm = byId(page, "public.live.confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Direct callers: 2");
    await confirm.locator('[data-testid="dialog.cancel"]').click();
    expect(api.state.patches).toHaveLength(patchesBefore);
    await byId(page, "public.live.enforce").click();
    await confirm.locator('[data-testid="dialog.confirm"]').click();
    await expect(byId(page, "public.live.done")).toBeVisible();
    expect(api.state.patches.slice(patchesBefore)).toEqual([
      { body: { section: "public", patch: { managersGatewayOnly: "enforce" } }, ifMatch: "etag-2" },
      { body: { section: "admin", patch: { legacyProxyGateway: "reject" } }, ifMatch: "etag-3" },
    ]);
    // The callers were listed (GET) before the first enforcing PATCH went out.
    const order = mock.calls.map((call) => `${call.method} ${call.path}${call.query.type ? `?${call.query.type}` : ""}`);
    const listed = order.indexOf("GET /api/security/events?direct_manager_gateway");
    const enforced = order.findIndex((entry, index) => entry === "PATCH /api/public/settings" && index > listed && mock.calls[index].body?.section === "public");
    expect(listed).toBeGreaterThan(-1);
    expect(enforced).toBeGreaterThan(listed);
    expect(mock.csrfViolations).toEqual([]);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("writing the templates never overwrites by itself: existing files are listed, and overwriting is a second, confirmed click", async ({ browser }) => {
  const api = publicApi({ baseUrl: "https://ai.example.com", templatesExist: true });
  const { context, page, mock, failures } = await newPage(browser, { api: { ...accessApi(), ...api.routes } });
  try {
    await page.goto(urlOf("/access/public?step=templates"));
    await expect(byId(page, "public.templates.file")).toHaveCount(2);
    await byId(page, "public.templates.write").click();
    await expect(byId(page, "public.templates.exists")).toContainText("cloudflared.env.example");
    await expect(byId(page, "public.templates.written")).toHaveCount(0);
    expect(mock.find("POST", "/api/public/templates/write").map((call) => call.body)).toEqual([{ topology: "cloudflared-token", overwrite: false }]);
    await byId(page, "public.templates.overwrite").click();
    const dialog = byId(page, "public.templates.overwrite-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("cloudflared.env.example");
    expect(mock.find("POST", "/api/public/templates/write")).toHaveLength(1);
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    await expect(byId(page, "public.templates.written")).toBeVisible();
    expect(mock.find("POST", "/api/public/templates/write").map((call) => call.body.overwrite)).toEqual([false, true]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the config-file mode asks for the other template, and a missing address blocks the files step", async ({ browser }) => {
  const api = publicApi();
  const { context, page, mock } = await newPage(browser, { api: { ...accessApi(), ...api.routes } });
  try {
    await page.goto(urlOf("/access/public?step=templates"));
    await expect(byId(page, "public.templates.blocked")).toContainText("Save the public address first.");
    expect(mock.find("GET", "/api/public/templates")).toHaveLength(0);
    await page.goto(urlOf("/access/public"));
    await byId(page, "public.topology.mode.config").check();
    await next(page);
    await byId(page, "public.baseurl.input").fill("https://ai.example.com");
    await byId(page, "public.baseurl.save").click();
    await expect(byId(page, "public.baseurl.saved")).toBeVisible();
    await next(page);
    await expect(byId(page, "public.templates.file")).toHaveCount(2);
    expect(mock.calls.some((call) => call.path === "/api/public/templates" && call.query.topology === "cloudflared-config")).toBe(true);
  } finally {
    await context.close();
  }
});

test("a LAN-only setup skips the address and needs no files", async ({ browser }) => {
  const api = publicApi();
  const { context, page, mock } = await newPage(browser, { api: { ...accessApi(), ...api.routes } });
  try {
    await page.goto(urlOf("/access/public"));
    await byId(page, "public.topology.lan").click();
    await next(page);
    await expect(byId(page, "public.baseurl.lan")).toContainText("needs no public address");
    await expect(byId(page, "public.baseurl.input")).toHaveCount(0);
    await next(page);
    await expect(byId(page, "public.templates.none")).toBeVisible();
    await expect(byId(page, "public.templates.write")).toHaveCount(0);
    expect(mock.calls.some((call) => call.path === "/api/public/templates" && call.query.topology === "lan")).toBe(true);
    await expect(byId(page, "public.steps").locator('[data-testid="stepper.step"]').nth(1)).toHaveAttribute("data-state", "skipped");
    expect(api.state.patches).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("a stale etag on saving the address reloads the settings and says so", async ({ browser }) => {
  const api = publicApi();
  api.routes["PATCH /api/public/settings"] = { status: 409, body: { ok: false, error: { code: "config_conflict", message: "stale" } } };
  const { context, page, mock } = await newPage(browser, { api: { ...accessApi(), ...api.routes } });
  try {
    await page.goto(urlOf("/access/public?step=baseUrl"));
    await byId(page, "public.baseurl.input").fill("https://ai.example.com");
    await byId(page, "public.baseurl.save").click();
    await expect(byId(page, "public.baseurl.failure")).toContainText("The settings changed elsewhere");
    await expect.poll(() => mock.find("GET", "/api/public/settings").length).toBeGreaterThan(1);
  } finally {
    await context.close();
  }
});

test("the keys step offers a quick create when no key can use the public address", async ({ browser }) => {
  const api = publicApi({ keys: { ok: true, items: [KEYS.items[1], KEYS.items[3]], nextCursor: null, counts: { total: 2, active: 1 } } });
  const { context, page, mock } = await newPage(browser, { api: { ...accessApi(), ...api.routes } });
  try {
    await page.goto(urlOf("/access/public?step=keys"));
    await expect(byId(page, "public.keys.none")).toContainText("No active key can use the public address yet.");
    await byId(page, "public.keys.create").click();
    await expect(byId(page, "key-drawer.root")).toBeVisible();
    await byId(page, "key-form.name").fill("Frank friend");
    await byId(page, "key-drawer.submit").click();
    await expect(byId(page, "share-card.root")).toBeVisible();
    expect(mock.find("POST", "/api/access/keys")[0].body).toMatchObject({ preset: "friend", listeners: ["public"] });
    await byId(page, "share-card.saved").check();
    await byId(page, "share-card.close").click();
    await expect(byId(page, "share-card.root")).toHaveCount(0);
    expect(await page.content()).not.toContain("TESTONLYFAKEKEY");
  } finally {
    await context.close();
  }
});

test("the checks list offers to trust the proxy the probe came from, behind a confirmation", async ({ browser }) => {
  const api = publicApi({ baseUrl: "https://api.example.invalid" });
  const { context, page, mock } = await newPage(browser, { api: { ...accessApi(), ...api.routes } });
  try {
    await page.goto(urlOf("/access/public?step=checks"));
    await expect(byId(page, "checks-list.item")).toHaveCount(18);
    // The report's own probe saw the connection come from 172.18.0.1, which is not in trustedProxies.cidrs.
    await expect(page.locator('[data-check="trusted_proxy_match"]')).toHaveAttribute("data-state", "fail");
    await expect(byId(page, "public.checks.trust")).toHaveText("Trust 172.18.0.1/32");
    await byId(page, "public.checks.trust").click();
    const dialog = byId(page, "public.trust-dialog");
    await expect(dialog).toBeVisible();
    expect(api.state.patches).toHaveLength(0);
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    await expect(dialog).toHaveCount(0);
    expect(api.state.patches).toEqual([{ body: { section: "trustedProxies", patch: { cidrs: ["127.0.0.1/32", "172.18.0.1/32"] } }, ifMatch: "etag-1" }]);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a server without the exposure scan says so instead of failing, and the probe needs an address", async ({ browser }) => {
  const api = publicApi();
  api.routes["GET /api/public/exposure"] = { status: 503, body: { ok: false, error: { code: "exposure_unavailable", message: "The exposure scan is not available." } } };
  api.routes["POST /api/public/probe"] = { status: 400, body: { ok: false, error: { code: "public_base_url_required", message: "Set the address first." } } };
  const { context, page } = await newPage(browser, { api: { ...accessApi(), ...api.routes } });
  try {
    await page.goto(urlOf("/access/public?step=checks"));
    await expect(byId(page, "public.checks.unavailable")).toContainText("not available on this server");
    await expect(byId(page, "public.checks.rescan")).toBeDisabled();
    const second = await newPage(browser, { api: { ...accessApi(), ...publicApi().routes, "POST /api/public/probe": api.routes["POST /api/public/probe"] } });
    try {
      await second.page.goto(urlOf("/access/public?step=checks"));
      await expect(byId(second.page, "checks-list.item")).toHaveCount(18);
      await byId(second.page, "public.checks.probe").click();
      await expect(byId(second.page, "public.checks.error")).toHaveText("Save the public address first; the probe calls that address.");
    } finally {
      await second.context.close();
    }
  } finally {
    await context.close();
  }
});

test("the map draws every node and edge of the report; each edge carries its state and evidence", async ({ browser }) => {
  const api = publicApi({ baseUrl: "https://api.example.invalid" });
  const { context, page, mock } = await newPage(browser, { api: { ...accessApi(), ...api.routes } });
  try {
    await page.goto(urlOf("/access/public?step=map"));
    await expect(byId(page, "exposure-map.svg")).toBeVisible();
    const report = EXPOSURE.report;
    await expect(byId(page, "exposure-map.node")).toHaveCount(report.map.nodes.length);
    await expect(byId(page, "exposure-map.edge")).toHaveCount(report.map.edges.length);
    for (const name of ["Internet", "Cloudflare / Caddy", "Public listener", "Admin listener", "Model managers", "Engines", "LAN", "This machine"]) {
      await expect(byId(page, "exposure-map.svg").getByText(name, { exact: true })).toBeVisible();
    }
    // States are drawn as classes and as glyphs, and the evidence is in the tooltip and in the table.
    const failing = report.map.edges.filter((edge) => edge.state === "fail");
    expect(failing.length).toBeGreaterThan(0);
    await expect(page.locator('[data-testid="exposure-map.edge"][data-state="fail"]')).toHaveCount(failing.length);
    await expect(page.locator('[data-testid="exposure-map.edge"][data-state="fail"] .xmap-glyph').first()).toHaveText("X");
    for (const edge of failing) {
      const row = page.locator('[data-testid="exposure-map.row"][data-state="fail"]', { hasText: edge.evidence.slice(0, 30) });
      await expect(row.first()).toBeVisible();
    }
    const tip = await page.locator('[data-testid="exposure-map.edge"][data-state="fail"] title').first().textContent();
    expect(tip).toContain("Failing");
    expect(tip).toContain(failing[0].evidence.slice(0, 20));
    await expect(byId(page, "exposure-map.svg")).toHaveAttribute("aria-label", `Exposure map: ${report.map.nodes.length} places and ${report.map.edges.length} connections`);
    expect(mock.unmocked).toEqual([]);
  } finally {
    await context.close();
  }
});

test("going live is already done when both modes are enforced, and a failed write keeps the dialog open", async ({ browser }) => {
  const done = publicApi({ baseUrl: "https://ai.example.com" });
  done.state.gatewayOnly = "enforce";
  done.state.legacy = "reject";
  const first = await newPage(browser, { api: { ...accessApi(), ...done.routes } });
  try {
    await first.page.goto(urlOf("/access/public?step=golive"));
    await expect(byId(first.page, "public.live.done")).toBeVisible();
    await expect(byId(first.page, "public.live.enforce")).toHaveCount(0);
    await expect(byId(first.page, "public.live.done")).toContainText("platform config set public.managersGatewayOnly warn");
  } finally {
    await first.context.close();
  }
  const broken = publicApi({ baseUrl: "https://ai.example.com", events: { direct: [], viaProxy: [] } });
  broken.routes["PATCH /api/public/settings"] = { status: 409, body: { ok: false, error: { code: "config_conflict", message: "stale" } } };
  const second = await newPage(browser, { api: { ...accessApi(), ...broken.routes } });
  try {
    await second.page.goto(urlOf("/access/public?step=golive"));
    await expect(byId(second.page, "public.live.none")).toContainText("No client skipped the entry in the last 7 days.");
    await byId(second.page, "public.live.enforce").click();
    await byId(second.page, "public.live.confirm").locator('[data-testid="dialog.confirm"]').click();
    await expect(byId(second.page, "public.live.confirm").locator('[data-testid="dialog.error"]')).toBeVisible();
    await expect(byId(second.page, "public.live.confirm")).toBeVisible();
  } finally {
    await second.context.close();
  }
});

// ---------------------------------------------------------------------------
// Security & audit (05 §13.6, §13.7)

function securityApi(extra = {}) {
  return {
    ...accessApi(),
    "GET /api/security/overview": SECURITY,
    "GET /api/security/bans": { ok: true, items: SECURITY.bans },
    "GET /api/security/events": { ok: true, items: [
      { id: 31, at: isoAgo(600_000), type: "security.ban", severity: "warning", source: "ring", data: { kind: "ban", subject: "203.0.113.9", banKind: "ip", source: "admin" } },
      { id: 30, at: isoAgo(900_000), type: "security.direct_manager_gateway", severity: "warning", source: "ring", data: { kind: "direct_manager_gateway", path: "/v1/models", remoteAddress: "192.0.2.10", suppressed: 0 } },
    ], nextCursor: null, source: "ring" },
    "GET /api/public/exposure": EXPOSURE,
    "POST /api/security/bans": (request, route, record) => ({ status: 201, body: { ok: true, ban: { subject: record.body.subject, kind: record.body.kind, active: true } } }),
    ...extra,
  };
}

const inCard = (page, id) => byId(page, id);
// A table row on a wide screen, a card on a phone.
const rowsIn = (page, id, text) => byId(page, id).locator('[data-testid="data-table.row"], [data-testid="data-table.card"]', text ? { hasText: text } : undefined);

test("the security page shows anomalies, failed sign-ins, top addresses, bans, busy keys, events and the audit trail", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, { api: securityApi() });
  try {
    await page.goto(urlOf("/access/security"));
    await expect(page.locator("#main h1")).toHaveText("Security & audit");
    // Anomalies: the four rules, the worst first, with their detail.
    const anomalies = byId(page, "security.anomaly");
    await expect(anomalies).toHaveCount(4);
    await expect(anomalies.first()).toHaveAttribute("data-rule", "auth_storm");
    await expect(anomalies.first()).toContainText("140 failed sign-ins in the last 10 minutes.");
    await expect(page.locator('[data-rule="tpm_spike"]')).toContainText("90,000 tokens in the last hour");
    await expect(page.locator('[data-rule="new_country"]')).toContainText("FR");
    await expect(page.locator('[data-rule="direct_manager_calls"]')).toContainText("7 direct calls");
    await expect(page.locator('[data-rule="tpm_spike"] [data-testid="security.anomaly.key"]')).toHaveAttribute("href", /\/access\/keys\/k_/);
    // Failed sign-ins over time and the top addresses with their ban state.
    await expect(inCard(page, "security.failures").locator('[role="img"]').first()).toBeVisible();
    await expect(rowsIn(page, "security.failures")).toHaveCount(2);
    await expect(rowsIn(page, "security.failures", "203.0.113.9")).toContainText("Banned");
    await expect(rowsIn(page, "security.failures", "203.0.113.9")).toContainText("DE");
    await expect(rowsIn(page, "security.failures", "192.0.2.44")).toContainText("Not banned");
    // Bans, busy keys, events, the audit trail.
    await expect(rowsIn(page, "security.bans")).toHaveCount(2);
    await expect(rowsIn(page, "security.bans", "198.51.100.0/24")).toContainText("Until lifted");
    await expect(rowsIn(page, "security.keys")).toHaveCount(1);
    await expect(rowsIn(page, "security.keys")).toContainText("91,000");
    await expect(rowsIn(page, "security.events")).toHaveCount(2);
    await expect(byId(page, "audit.panel")).toBeVisible();
    expect(mock.find("GET", "/api/security/overview")[0].query.from).toBeTruthy();
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("banning an address asks first, sends the audited request with CSRF, and an invalid address is refused in the dialog", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: securityApi() });
  try {
    await page.goto(urlOf("/access/security"));
    await expect(rowsIn(page, "security.failures")).toHaveCount(2);
    await rowsIn(page, "security.failures", "192.0.2.44").locator('[data-testid="security.ips.ban"]').click();
    const dialog = byId(page, "security.ban-dialog");
    await expect(dialog).toBeVisible();
    await expect(byId(page, "security.ban.subject")).toHaveValue("192.0.2.44");
    expect(mock.find("POST", "/api/security/bans")).toHaveLength(0);
    await dialog.locator('[data-testid="dialog.cancel"]').click();
    await expect(dialog).toHaveCount(0);
    expect(mock.find("POST", "/api/security/bans")).toHaveLength(0);

    await rowsIn(page, "security.failures", "192.0.2.44").locator('[data-testid="security.ips.ban"]').click();
    await byId(page, "security.ban.subject").fill("not an address");
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    await expect(dialog.locator('[data-testid="dialog.error"]')).toContainText("does not look like a valid value");
    expect(mock.find("POST", "/api/security/bans")).toHaveLength(0);
    await byId(page, "security.ban.subject").fill("192.0.2.44");
    await byId(page, "security.ban.reason").fill("password guessing");
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    await expect(dialog).toHaveCount(0);
    const posts = mock.find("POST", "/api/security/bans");
    expect(posts).toHaveLength(1);
    expect(posts[0].headers["x-csrf-token"]).toBe("t");
    expect(posts[0].body).toMatchObject({ subject: "192.0.2.44", kind: "ip", reason: "password guessing" });
    const hours = (Date.parse(posts[0].body.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
    // The bans and the overview are read again after a change.
    await expect.poll(() => mock.find("GET", "/api/security/bans").length).toBeGreaterThan(1);
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("lifting a ban asks first and deletes the exact subject; a ban that would lock the owner out shows the server's refusal", async ({ browser }) => {
  const api = securityApi({
    "DELETE /api/security/bans/198.51.100.0%2F24": { ok: true, removed: true, subject: "198.51.100.0/24" },
    "DELETE /api/security/bans/203.0.113.9": { ok: true, removed: true, subject: "203.0.113.9" },
    "POST /api/security/bans": { status: 400, body: { ok: false, error: { code: "cannot_ban_self", message: "That ban would cover the address you are using." } } },
  });
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(urlOf("/access/security"));
    await expect(rowsIn(page, "security.bans")).toHaveCount(2);
    await rowsIn(page, "security.bans", "198.51.100.0/24").locator('[data-testid="security.bans.unban"]').click();
    const dialog = byId(page, "security.unban-dialog");
    await expect(dialog).toContainText("198.51.100.0/24");
    expect(mock.find("DELETE", "/api/security/bans")).toHaveLength(0);
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    await expect(dialog).toHaveCount(0);
    const deletes = mock.find("DELETE", "/api/security/bans");
    expect(deletes).toHaveLength(1);
    expect(new URL(deletes[0].path, "http://x").pathname).toBe("/api/security/bans/198.51.100.0%2F24");
    expect(deletes[0].headers["x-csrf-token"]).toBe("t");
    // From the address table, a banned address offers the same.
    await rowsIn(page, "security.failures", "203.0.113.9").locator('[data-testid="security.ips.unban"]').click();
    await byId(page, "security.unban-dialog").locator('[data-testid="dialog.confirm"]').click();
    expect(mock.find("DELETE", "/api/security/bans/203.0.113.9")).toHaveLength(1);
    // The owner cannot ban the address in use.
    await byId(page, "security.bans.add").click();
    await byId(page, "security.ban.subject").fill("192.0.2.5");
    await byId(page, "security.ban-dialog").locator('[data-testid="dialog.confirm"]').click();
    await expect(byId(page, "security.ban-dialog").locator('[data-testid="dialog.error"]')).toHaveText("That ban would cut off the address you are using now.");
  } finally {
    await context.close();
  }
});

test("legacy findings offer copy only: the note, the evidence and the suggested command, and no delete control", async ({ browser }) => {
  const { context, page } = await newPage(browser, { api: securityApi() });
  try {
    await page.goto(urlOf("/access/security"));
    const card = byId(page, "security.legacy");
    await expect(byId(page, "security.legacy.note")).toHaveText("The platform never deletes or stops these; you decide.");
    const findings = EXPOSURE.report.legacy;
    expect(findings.length).toBeGreaterThan(0);
    await expect(card.locator('[data-testid="security.legacy.item"]')).toHaveCount(findings.length);
    for (const [index, finding] of findings.entries()) {
      const item = card.locator('[data-testid="security.legacy.item"]').nth(index);
      await expect(item).toContainText(finding.relPath);
      await expect(item).toContainText(finding.evidence.slice(0, 25));
      await expect(item.locator('[data-testid="security.legacy.command"]')).toContainText(finding.suggestedCommand.slice(0, 30));
    }
    await expect(card.locator('[data-testid="security.legacy.item"]').first()).toHaveAttribute("data-risk", /high|medium/);
    // Every button in the card is a copy button, and there is no form, link or menu that could act.
    const names = await card.getByRole("button").allInnerTexts();
    expect(names.length).toBe(findings.length);
    for (const name of names) expect(name).toMatch(/^Copy suggested command$/);
    await expect(card.locator("form, a[href], input, select")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the security page degrades when the telemetry source or the scan is missing", async ({ browser }) => {
  const api = securityApi({
    "GET /api/security/overview": { ...SECURITY, authFailures: { available: false, series: [], topIps: [] }, anomalies: [], topKeys: [] },
    "GET /api/public/exposure": { status: 503, body: { ok: false, error: { code: "exposure_unavailable", message: "no" } } },
  });
  const { context, page } = await newPage(browser, { api });
  try {
    await page.goto(urlOf("/access/security"));
    await expect(byId(page, "security.anomalies.none")).toBeVisible();
    await expect(byId(page, "security.failures.unavailable")).toContainText("telemetry store is not connected");
    await expect(byId(page, "security.legacy.unavailable")).toBeVisible();
    await expect(byId(page, "security.legacy.note")).toBeVisible();
    await expect(byId(page, "security.keys.empty")).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Sessions and pairing (05 §5.2, §5.6, §13.7)

function sessionsApi(extra = {}) {
  return {
    ...accessApi(),
    "GET /api/session/list": SESSIONS,
    [`DELETE /api/session/${OTHER_SESSION.id}`]: { ok: true },
    [`DELETE /api/session/${CURRENT_SESSION.id}`]: { ok: true },
    "POST /api/session/logout": { ok: true },
    "POST /api/session/pair-codes": () => ({ ok: true, code: PAIR_CODE, url: `http://192.0.2.5:5176/#pair=${PAIR_CODE}`, expiresAt: new Date(Date.now() + 120_000).toISOString() }),
    ...extra,
  };
}

test("the sessions page lists paired browsers with the current one marked", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: sessionsApi() });
  try {
    await page.goto(urlOf("/access/sessions"));
    await expect(page.locator("#main h1")).toHaveText("Sessions & paired devices");
    await expect(rowsIn(page, "sessions.list")).toHaveCount(2);
    await expect(rowsIn(page, "sessions.list", "192.0.2.10")).toContainText("This browser");
    await expect(rowsIn(page, "sessions.list", "192.0.2.10")).toContainText("Chrome / Windows");
    await expect(rowsIn(page, "sessions.list", "192.0.2.77")).toContainText("Safari / iOS");
    await expect(rowsIn(page, "sessions.list", "192.0.2.77")).not.toContainText("This browser");
    expect(mock.unmocked).toEqual([]);
  } finally {
    await context.close();
  }
});

test("revoking another session asks first; revoking the current one warns that this tab must pair again", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: sessionsApi() });
  try {
    await page.goto(urlOf("/access/sessions"));
    await rowsIn(page, "sessions.list", "192.0.2.77").locator('[data-testid="sessions.revoke"]').click();
    const other = byId(page, "sessions.revoke-dialog");
    await expect(other).toContainText("must pair again");
    await expect(other).not.toContainText("this tab");
    expect(mock.find("DELETE", "/api/session/")).toHaveLength(0);
    await other.locator('[data-testid="dialog.cancel"]').click();
    expect(mock.find("DELETE", "/api/session/")).toHaveLength(0);
    await rowsIn(page, "sessions.list", "192.0.2.77").locator('[data-testid="sessions.revoke"]').click();
    await other.locator('[data-testid="dialog.confirm"]').click();
    await expect(other).toHaveCount(0);
    expect(mock.find("DELETE", `/api/session/${OTHER_SESSION.id}`)).toHaveLength(1);
    await expect(byId(page, "pairing-screen.root")).toHaveCount(0);

    await rowsIn(page, "sessions.list", "192.0.2.10").locator('[data-testid="sessions.revoke"]').click();
    const current = byId(page, "sessions.revoke-current");
    await expect(current).toContainText("Revoke the session you are using?");
    await expect(current).toContainText("this tab must pair again");
    expect(mock.find("DELETE", `/api/session/${CURRENT_SESSION.id}`)).toHaveLength(0);
    await current.locator('[data-testid="dialog.confirm"]').click();
    expect(mock.find("DELETE", `/api/session/${CURRENT_SESSION.id}`)).toHaveLength(1);
    expect(mock.find("DELETE", `/api/session/${CURRENT_SESSION.id}`)[0].headers["x-csrf-token"]).toBe("t");
    await expect(byId(page, "pairing-screen.root")).toBeVisible();
    expect(mock.csrfViolations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("pair a device shows the code and QR, counts down, and forgets both when the dialog closes", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: sessionsApi() });
  try {
    await page.goto(urlOf("/access/sessions"));
    await expect(rowsIn(page, "sessions.list")).toHaveCount(2);
    await byId(page, "sessions.pair-open").click();
    const dialog = byId(page, "sessions.pair-dialog");
    await expect(byId(page, "sessions.pair.issued")).toBeVisible();
    await expect(byId(page, "sessions.pair.code")).toContainText(PAIR_CODE);
    await expect(byId(page, "sessions.pair.url")).toContainText(`#pair=${PAIR_CODE}`);
    await expect(byId(page, "sessions.pair.qr").locator("svg[role='img']")).toBeVisible();
    await expect(byId(page, "sessions.pair.qr").locator("svg path.qr-ink")).toHaveCount(1);
    await expect(byId(page, "sessions.pair.countdown")).toHaveText(/Expires in (\d+) s/);
    const seconds = Number(/(\d+)/.exec(await byId(page, "sessions.pair.countdown").innerText())[1]);
    expect(seconds).toBeGreaterThan(100);
    expect(seconds).toBeLessThanOrEqual(122);
    const issued = mock.find("POST", "/api/session/pair-codes");
    expect(issued).toHaveLength(1);
    expect(issued[0].body).toEqual({ ttlSeconds: 120 });
    expect(issued[0].headers["x-csrf-token"]).toBe("t");
    // A new code replaces the old one; closing the dialog leaves neither the code nor the address anywhere.
    await byId(page, "sessions.pair.renew").click();
    await expect.poll(() => mock.find("POST", "/api/session/pair-codes").length).toBe(2);
    await expect(byId(page, "sessions.pair.code")).toContainText(PAIR_CODE);
    await byId(page, "sessions.pair.close").click();
    await expect(dialog).toHaveCount(0);
    expect(await page.content()).not.toContain(PAIR_CODE);
    expect(page.url()).not.toContain(PAIR_CODE);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage, cookie: document.cookie }))).not.toContain(PAIR_CODE);
    await byId(page, "sessions.pair-open").click();
    await expect(byId(page, "sessions.pair.code")).toContainText(PAIR_CODE);
    await byId(page, "sessions.pair.close").click();
  } finally {
    await context.close();
  }
});

test("a pairing code stops showing when it expires, and the LAN code answers lan_owner_disabled inline", async ({ browser }) => {
  let calls = 0;
  const api = sessionsApi({
    "POST /api/session/pair-codes": (request, route, record) => {
      calls += 1;
      if (record.body.lan) return { status: 403, body: { ok: false, error: { code: "lan_owner_disabled", message: "A LAN pairing code needs listeners.admin.lan and admin.allowLanOwner." } } };
      return { ok: true, code: PAIR_CODE, url: `http://192.0.2.5:5176/#pair=${PAIR_CODE}`, expiresAt: new Date(Date.now() + 2200).toISOString() };
    },
  });
  const { context, page, mock } = await newPage(browser, { api });
  try {
    await page.goto(urlOf("/access/sessions"));
    await byId(page, "sessions.pair-open").click();
    await expect(byId(page, "sessions.pair.code")).toBeVisible();
    await expect(byId(page, "sessions.pair.expired")).toBeVisible({ timeout: 8000 });
    await expect(byId(page, "sessions.pair.code")).toHaveCount(0);
    expect(await byId(page, "sessions.pair-dialog").innerText()).not.toContain(PAIR_CODE);
    await byId(page, "sessions.pair.lan").check();
    await expect(byId(page, "sessions.pair.error")).toContainText("LAN pairing is off");
    expect(mock.find("POST", "/api/session/pair-codes").map((call) => Boolean(call.body.lan))).toEqual([false, true]);
    expect(calls).toBe(2);
  } finally {
    await context.close();
  }
});

test("signing out asks first and leaves the tab to pair again", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: sessionsApi() });
  try {
    await page.goto(urlOf("/access/sessions"));
    await byId(page, "sessions.signout").click();
    await expect(byId(page, "sessions.signout-dialog")).toBeVisible();
    expect(mock.find("POST", "/api/session/logout")).toHaveLength(0);
    await byId(page, "sessions.signout-dialog").locator('[data-testid="dialog.confirm"]').click();
    await expect.poll(() => mock.find("POST", "/api/session/logout").length).toBe(1);
    await expect(byId(page, "pairing-screen.root")).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Portal: announcements and model descriptions

const ANNOUNCEMENT = {
  id: "an_01",
  severity: "maintenance",
  title: { zh: "计划维护", en: "Planned maintenance" },
  body: { zh: "今晚 23 点", en: "Tonight at 23:00" },
  startsAt: "2026-10-14T00:00:00.000Z",
  endsAt: null,
  audience: "all",
  published: true,
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  createdBy: "session:3f2a",
};
const MODEL_META = { modelId: "qwen3.8-flash", displayName: { zh: "千问 Flash", en: "Qwen Flash" }, description: { zh: "快", en: "Fast" }, aliases: ["flash"], hidden: false, recommended: true, sort: 2, updatedAt: "2026-10-13T00:00:00.000Z" };

function portalApi(extra = {}) {
  return {
    ...accessApi(),
    "GET /api/public/announcements": { ok: true, items: [ANNOUNCEMENT] },
    "POST /api/public/announcements": (request, route, record) => ({ status: 201, body: { ok: true, announcement: { ...ANNOUNCEMENT, id: "an_02", ...record.body } } }),
    "PATCH /api/public/announcements/an_01": (request, route, record) => ({ ok: true, announcement: { ...ANNOUNCEMENT, ...record.body } }),
    "DELETE /api/public/announcements/an_01": { ok: true, removed: true, id: "an_01" },
    "GET /api/public/models/qwen3.8-flash/meta": { ok: true, modelId: "qwen3.8-flash", meta: MODEL_META },
    "GET /api/public/models/llama-8b/meta": { ok: true, modelId: "llama-8b", meta: null },
    "PUT /api/public/models/qwen3.8-flash/meta": (request, route, record) => ({ ok: true, meta: { ...MODEL_META, ...record.body } }),
    ...extra,
  };
}

test("announcements: create needs both titles, edit patches the whole draft, delete asks first", async ({ browser }) => {
  const { context, page, mock, failures } = await newPage(browser, { api: portalApi() });
  try {
    await page.goto(urlOf("/access/portal"));
    await expect(page.locator("#main h1")).toHaveText("Portal & announcements");
    await expect(rowsIn(page, "portal.announcements")).toHaveCount(1);
    await expect(rowsIn(page, "portal.announcements")).toContainText("Planned maintenance");
    await expect(rowsIn(page, "portal.announcements")).toContainText("Maintenance");

    await byId(page, "portal.announcement.new").click();
    await expect(byId(page, "portal.announcement-drawer")).toBeVisible();
    await byId(page, "portal.announcement.save").click();
    await expect(byId(page, "portal.announcement.title-zh.field")).toContainText("This field is required.");
    await expect(byId(page, "portal.announcement.title-en.field")).toContainText("This field is required.");
    expect(mock.find("POST", "/api/public/announcements")).toHaveLength(0);
    await byId(page, "portal.announcement.severity").selectOption("incident");
    await byId(page, "portal.announcement.title-zh").fill("故障");
    await byId(page, "portal.announcement.title-en").fill("Outage");
    await byId(page, "portal.announcement.body-en").fill("We are on it.");
    await byId(page, "portal.announcement.audience").selectOption("keys");
    await byId(page, "portal.announcement.published").check();
    await byId(page, "portal.announcement.save").click();
    await expect(byId(page, "portal.announcement-drawer")).toHaveCount(0);
    const created = mock.find("POST", "/api/public/announcements")[0];
    expect(created.headers["x-csrf-token"]).toBe("t");
    expect(created.body).toMatchObject({ severity: "incident", title: { zh: "故障", en: "Outage" }, body: { zh: "", en: "We are on it." }, audience: "keys", published: true, endsAt: null });
    expect(Number.isNaN(Date.parse(created.body.startsAt))).toBe(false);

    await rowsIn(page, "portal.announcements", "Planned maintenance").locator('[data-testid="portal.announcement.edit"]').click();
    await expect(byId(page, "portal.announcement.title-en")).toHaveValue("Planned maintenance");
    await byId(page, "portal.announcement.title-en").fill("Maintenance tonight");
    await byId(page, "portal.announcement.ends").fill("2099-01-01T10:00");
    await byId(page, "portal.announcement.save").click();
    await expect(byId(page, "portal.announcement-drawer")).toHaveCount(0);
    const patched = mock.find("PATCH", "/api/public/announcements/an_01")[0];
    expect(patched.body).toMatchObject({ title: { zh: "计划维护", en: "Maintenance tonight" }, severity: "maintenance", published: true });
    expect(patched.body.endsAt).toMatch(/^2099-/);

    await rowsIn(page, "portal.announcements", "Planned maintenance").locator('[data-testid="portal.announcement.delete"]').click();
    const dialog = byId(page, "portal.announcement.delete-dialog");
    await expect(dialog).toContainText("cannot be restored");
    expect(mock.find("DELETE", "/api/public/announcements/an_01")).toHaveLength(0);
    await dialog.locator('[data-testid="dialog.confirm"]').click();
    await expect(dialog).toHaveCount(0);
    expect(mock.find("DELETE", "/api/public/announcements/an_01")).toHaveLength(1);
    expect(mock.csrfViolations).toEqual([]);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a field error from the server lands next to the field in the announcement form", async ({ browser }) => {
  const api = portalApi({
    "POST /api/public/announcements": { status: 400, body: { ok: false, error: { code: "invalid_field", message: "Announcement fields are invalid." }, errors: [{ field: "title.en", code: "too_long", message: "too long" }] } },
  });
  const { context, page } = await newPage(browser, { api });
  try {
    await page.goto(urlOf("/access/portal"));
    await byId(page, "portal.announcement.new").click();
    await byId(page, "portal.announcement.title-zh").fill("a");
    await byId(page, "portal.announcement.title-en").fill("b");
    await byId(page, "portal.announcement.save").click();
    await expect(byId(page, "portal.announcement.title-en.field")).toContainText("This is too long.");
    await expect(byId(page, "portal.announcement-drawer")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("model descriptions load the current text and save it with PUT", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { api: portalApi() });
  try {
    await page.goto(urlOf("/access/portal"));
    await expect(byId(page, "portal.model")).toHaveCount(3);
    await page.locator('[data-testid="portal.model"]', { hasText: "qwen3.8-flash" }).locator('[data-testid="portal.model.edit"]').click();
    await expect(byId(page, "portal.meta-form")).toBeVisible();
    await expect(byId(page, "portal.meta.name-en")).toHaveValue("Qwen Flash");
    await expect(byId(page, "portal.meta.aliases")).toHaveValue("flash");
    await expect(byId(page, "portal.meta.recommended")).toBeChecked();
    expect(mock.find("PUT", "/api/public/models/")).toHaveLength(0);
    await byId(page, "portal.meta.description-en").fill("Fast and cheap");
    await byId(page, "portal.meta.aliases").fill("flash, qwen-flash");
    await byId(page, "portal.meta.sort").fill("abc");
    await byId(page, "portal.meta.save").click();
    await expect(byId(page, "portal.meta.sort.field")).toContainText("This value is not in a valid format.");
    expect(mock.find("PUT", "/api/public/models/")).toHaveLength(0);
    await byId(page, "portal.meta.sort").fill("1");
    await byId(page, "portal.meta.hidden").check();
    await byId(page, "portal.meta.save").click();
    await expect(byId(page, "portal.meta-drawer")).toHaveCount(0);
    const put = mock.find("PUT", "/api/public/models/qwen3.8-flash/meta")[0];
    expect(put.headers["x-csrf-token"]).toBe("t");
    expect(put.body).toEqual({
      displayName: { zh: "千问 Flash", en: "Qwen Flash" },
      description: { zh: "快", en: "Fast and cheap" },
      aliases: ["flash", "qwen-flash"],
      hidden: true,
      recommended: true,
      sort: 1,
    });
    // A model that has no description yet opens an empty form, and an id typed by hand works too.
    await byId(page, "portal.models.other").fill("llama-8b");
    await byId(page, "portal.models.other-edit").click();
    await expect(byId(page, "portal.meta.name-en")).toHaveValue("");
    await byId(page, "portal.meta.cancel").click();
    await expect(byId(page, "portal.meta-drawer")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Owner-only, languages, 390 px, accessibility

test("the public access, security, portal and sessions pages are owner-only: a viewer sees the PairingScreen and nothing is read", async ({ browser }) => {
  const { context, page, mock } = await newPage(browser, { bootstrap: VIEWER, session: SESSION_UNPAIRED, api: { ...securityApi(), ...sessionsApi(), ...portalApi(), ...publicApi().routes } });
  try {
    for (const route of ["/access/public", "/access/security", "/access/portal", "/access/sessions"]) {
      await page.goto(urlOf(route));
      await expect(byId(page, "pairing-screen.root")).toBeVisible();
    }
    for (const prefix of ["/api/access/", "/api/public/", "/api/security/", "/api/session/list"]) expect(mock.find("GET", prefix), prefix).toHaveLength(0);
  } finally {
    await context.close();
  }
});

async function openAllNewPages(page, visit) {
  await page.goto(urlOf("/access/public"));
  await expect(stepOf(page, "topology")).toBeVisible();
  await visit("public topology");
  for (const step of ["baseUrl", "templates", "keys", "checks", "map", "golive"]) {
    await next(page);
    await expect(stepOf(page, step)).toBeVisible();
    if (step === "checks") await expect(byId(page, "checks-list.item")).toHaveCount(18);
    if (step === "map") await expect(byId(page, "exposure-map.edge")).toHaveCount(11);
    if (step === "golive") await expect(byId(page, "public.live.direct")).toBeVisible();
    await visit(`public ${step}`);
  }
  await page.goto(urlOf("/access/security"));
  await expect(rowsIn(page, "security.bans")).toHaveCount(2);
  await expect(byId(page, "audit.panel")).toBeVisible();
  await expect(rowsIn(page, "security.events")).toHaveCount(2);
  await visit("security");
  await page.goto(urlOf("/access/sessions"));
  await expect(rowsIn(page, "sessions.list")).toHaveCount(2);
  await visit("sessions");
  await page.goto(urlOf("/access/portal"));
  await expect(rowsIn(page, "portal.announcements")).toHaveCount(1);
  await expect(byId(page, "portal.model")).toHaveCount(3);
  await visit("portal");
}

// The catalog keys of the Access area: none of them may show up as page text (a missing translation prints the key).
const ACCESS_KEYS = Object.keys(JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "service-entry", "console", "i18n", "access", "zh-CN.json"), "utf8"))).filter((key) => !key.startsWith("$"));

// Every endpoint of the new pages at once. The wizard reads the two caller kinds by type; the security page reads all events.
function everythingApi() {
  const pub = publicApi({ baseUrl: "https://api.example.invalid" });
  const security = securityApi();
  return {
    ...accessApi(),
    ...security,
    ...sessionsApi(),
    ...portalApi(),
    ...pub.routes,
    "GET /api/security/events": (request, route, record) => (record.query.type ? pub.routes["GET /api/security/events"](request, route, record) : security["GET /api/security/events"]),
  };
}

test("English mode shows no Han text outside user content on the new pages and dialogs; Chinese shows no raw catalog keys", async ({ browser }) => {
  const { context, page } = await newPage(browser, { locale: "en-US", api: everythingApi() });
  try {
    await openAllNewPages(page, async (label) => {
      expect(await hanOutsideUserContent(page), label).toEqual([]);
    });
    await page.goto(urlOf("/access/security"));
    await expect(rowsIn(page, "security.failures")).toHaveCount(2);
    await rowsIn(page, "security.failures", "192.0.2.44").locator('[data-testid="security.ips.ban"]').click();
    expect(await hanOutsideUserContent(page), "ban dialog").toEqual([]);
    await byId(page, "security.ban-dialog").locator('[data-testid="dialog.cancel"]').click();
    await page.goto(urlOf("/access/sessions"));
    await byId(page, "sessions.pair-open").click();
    await expect(byId(page, "sessions.pair.code")).toBeVisible();
    expect(await hanOutsideUserContent(page), "pair dialog").toEqual([]);
    await byId(page, "sessions.pair.close").click();
    await rowsIn(page, "sessions.list", "192.0.2.10").locator('[data-testid="sessions.revoke"]').click();
    expect(await hanOutsideUserContent(page), "revoke dialog").toEqual([]);
  } finally {
    await context.close();
  }
  const zh = await newPage(browser, { locale: "zh-CN", api: everythingApi() });
  try {
    await openAllNewPages(zh.page, async (label) => {
      const text = await zh.page.locator("#main").innerText();
      expect(ACCESS_KEYS.filter((key) => text.includes(key)), label).toEqual([]);
    });
    await zh.page.goto(urlOf("/access/security"));
    await expect(byId(zh.page, "security.legacy.note")).toHaveText("平台不会自动删除或停用这些文件，请自行决定。");
  } finally {
    await zh.context.close();
  }
});

test("no horizontal overflow at 390 px on the wizard steps, the security, sessions and portal pages and their dialogs", async ({ browser }) => {
  const { context, page, failures } = await newPage(browser, { size: SIZES.phone, api: everythingApi() });
  try {
    await openAllNewPages(page, async () => {
      await expectNoOverflow(page);
    });
    await page.goto(urlOf("/access/security"));
    await rowsIn(page, "security.bans").first().waitFor();
    await byId(page, "security.bans.add").click();
    await expectNoOverflow(page);
    await noHorizontalOverflowInside(page, '[data-testid="security.ban-dialog"] .overlay-body');
    await byId(page, "security.ban-dialog").locator('[data-testid="dialog.cancel"]').click();
    await page.goto(urlOf("/access/sessions"));
    await byId(page, "sessions.pair-open").click();
    await expect(byId(page, "sessions.pair.code")).toBeVisible();
    await expectNoOverflow(page);
    await noHorizontalOverflowInside(page, '[data-testid="sessions.pair-dialog"] .overlay-body');
    await byId(page, "sessions.pair.close").click();
    await page.goto(urlOf("/access/portal"));
    await byId(page, "portal.announcement.new").click();
    await expect(byId(page, "portal.announcement-form")).toBeVisible();
    await expectNoOverflow(page);
    await noHorizontalOverflowInside(page, '[data-testid="portal.announcement-drawer"] .overlay-body');
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const [theme, size, label] of [["light", SIZES.desktop, "light 1440"], ["dark", SIZES.desktop, "dark 1440"], ["light", SIZES.phone, "light 390"], ["dark", SIZES.phone, "dark 390"]]) {
  test(`axe finds nothing on the public access wizard, the security, sessions and portal pages and their dialogs (${label})`, async ({ browser }) => {
    test.setTimeout(150_000);
    const { context, page } = await newPage(browser, { theme, size, api: everythingApi() });
    try {
      await openAllNewPages(page, async (name) => {
        await expectNoA11yViolations(page, { label: `${name} ${label}` });
      });
      await page.goto(urlOf("/access/security"));
      await rowsIn(page, "security.failures", "192.0.2.44").locator('[data-testid="security.ips.ban"]').click();
      await expectNoA11yViolations(page, { label: `ban dialog ${label}` });
      await byId(page, "security.ban-dialog").locator('[data-testid="dialog.cancel"]').click();
      await page.goto(urlOf("/access/sessions"));
      await byId(page, "sessions.pair-open").click();
      await expect(byId(page, "sessions.pair.code")).toBeVisible();
      await expectNoA11yViolations(page, { label: `pair dialog ${label}` });
      await byId(page, "sessions.pair.close").click();
      await rowsIn(page, "sessions.list", "192.0.2.10").locator('[data-testid="sessions.revoke"]').click();
      await expectNoA11yViolations(page, { label: `revoke dialog ${label}` });
      await byId(page, "sessions.revoke-current").locator('[data-testid="dialog.cancel"]').click();
      await page.goto(urlOf("/access/portal"));
      await byId(page, "portal.announcement.new").click();
      await expect(byId(page, "portal.announcement-form")).toBeVisible();
      await expectNoA11yViolations(page, { label: `announcement drawer ${label}` });
    } finally {
      await context.close();
    }
  });
}
