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
