// CON-27 browser checks (07 §6.11 console-billing, §13.2): the native billing
// center. This is the port of tests/billing-page.spec.cjs, whose five-tab,
// hostile-text and immutable-debit assertions now run against the console's
// own tabs, forms and tables: five tabs over eight routes, API text rendered
// as text only and secret-shaped fields never shown, bounded mutations with
// the session's CSRF token, a stale token re-read once, the pairing screen for
// an unpaired write, template preview-then-apply, the outage state and its
// recovery, usage/summary aggregates (exact, zh and en, 390 px) and a
// type-to-confirm debit. The real service-entry serves the shell and the
// assets; the billing API is answered in the browser from the scenario below.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { collectFailures, expectNoA11yViolations, expectNoOverflow, mockConsoleApi, setPrefs, startEntry } = require("../helpers/console-harness.js");
const {
  CATALOG_VERSION,
  PRICE_TEMPLATE_CATALOG,
  previewPriceTemplateApplications,
} = require("../../../service-entry/lib/billing-price-templates");

const FIXTURES = path.resolve(__dirname, "..", "..", "fixtures", "console");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const BOOTSTRAP_BLOCK = /(<script type="application\/json" id="console-bootstrap">)([\s\S]*?)(<\/script>)/;
const OWNER = { role: "owner", auth: { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "t" } };
const VIEWER = { role: "viewer", auth: { mode: "session", session: { role: "viewer", via: "none", paired: false, autoPairAvailable: false }, csrf: null } };
const REMOTE_VIEWER = { ...VIEWER, access: { local: false } };
const SESSION_UNPAIRED = { ok: true, role: "viewer", via: "none", paired: false, csrfToken: null, autoPairAvailable: false, pairCommand: "platform admin pair" };

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_PLAN_ID = "44444444-4444-4444-8444-444444444444";
const XSS_SENTINEL = '<img src=x onerror="window.__billingXss=1">XSS_SENTINEL';
const API_SECRET_SENTINEL = "sk-API_SECRET_SENTINEL";
const KEY_HASH_SENTINEL = "HASH_SENTINEL_SHOULD_NOT_RENDER";
const AUDIT_SECRET_SENTINEL = "AUDIT_SECRET_SENTINEL";
const FIXED_NOW = "2026-08-11T02:00:00.000Z";

let entry;

test.beforeAll(async () => {
  entry = await startEntry();
});

test.afterAll(async () => {
  await entry?.stop();
});

// ---------------------------------------------------------------------------
// The scenario: what the billing API answers

function freshScenario() {
  const templates = PRICE_TEMPLATE_CATALOG.map((template) => ({
    ...template,
    rates: { ...template.rates },
    context: { ...template.context },
    notes: [...template.notes],
    // Unknown secret-shaped fields deliberately exercise the allowlists.
    keyHash: KEY_HASH_SENTINEL,
    apiKey: API_SECRET_SENTINEL,
  }));
  return {
    failAll: false,
    summaryShape: true,
    csrfRejectOnce: false,
    refuseNextWrite: false,
    requireSession: false,
    customers: [{
      customerId: CUSTOMER_ID,
      externalRef: "CRM-XSS",
      name: XSS_SENTINEL,
      status: "active",
      planId: PLAN_ID,
      enforcementMode: "hard",
      creditLimitMicrocredits: "200000000",
      monthlyTokenLimit: "5000000",
      monthlyRequestLimit: "10000",
      balanceMicrocredits: "50000000",
      reservedMicrocredits: "1000000",
      availableMicrocredits: "49000000",
      updatedAt: FIXED_NOW,
      keyHash: KEY_HASH_SENTINEL,
    }],
    plans: [{
      planId: PLAN_ID,
      code: "BASIC",
      name: "基础套餐",
      currency: "USD",
      monthlyPriceMicrocredits: "10000000",
      includedMicrocredits: "50000000",
      monthlyTokenLimit: "5000000",
      monthlyRequestLimit: "10000",
      enforcementMode: "hard",
      active: true,
      updatedAt: FIXED_NOW,
    }],
    credentials: [],
    prices: [{
      priceId: "55555555-5555-4555-8555-555555555555",
      planId: null,
      managerId: "vllm-manager",
      model: "local/base-*",
      inputPerMillionMicrocredits: "1000000",
      cachedInputPerMillionMicrocredits: "100000",
      outputPerMillionMicrocredits: "4000000",
      sourceTemplateId: null,
      effectiveFrom: FIXED_NOW,
      effectiveTo: null,
      active: true,
    }],
    usage: [{
      usageId: "66666666-6666-4666-8666-666666666666",
      at: FIXED_NOW,
      customerId: CUSTOMER_ID,
      managerId: "vllm-manager",
      model: "local/base-7b",
      requests: "1",
      inputTokens: "1200",
      outputTokens: "300",
      totalTokens: "1500",
      projectedMicrocredits: "1750000",
      chargedMicrocredits: "1500000",
      status: 200,
      ok: true,
      terminalState: "completed",
    }],
    // GET /api/billing/usage/summary (TEL-14), keyed by groupBy. The first
    // row's projected sum is past 2^53 to prove the page keeps it exact.
    usageSummary: [{
      customerId: CUSTOMER_ID,
      customerName: XSS_SENTINEL,
      model: "local/base-7b",
      month: "2026-08",
      requests: 3,
      ok: 2,
      inputTokens: 3600,
      cachedInputTokens: 600,
      outputTokens: 900,
      totalTokens: 4500,
      projectedMicrocredits: "9007199254740993",
      chargedMicrocredits: "4500000",
    }, {
      customerId: null,
      customerName: null,
      model: "local/tiny-1b",
      month: "2026-08",
      requests: 1,
      ok: 1,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      totalTokens: 15,
      projectedMicrocredits: "0",
      chargedMicrocredits: "0",
    }],
    dailySummary: [{
      day: "2026-08-10",
      requests: 1,
      ok: 1,
      inputTokens: 1200,
      cachedInputTokens: 0,
      outputTokens: 300,
      totalTokens: 1500,
      projectedMicrocredits: "1750000",
      chargedMicrocredits: "1500000",
    }, {
      day: "2026-08-11",
      requests: 3,
      ok: 2,
      inputTokens: 2410,
      cachedInputTokens: 600,
      outputTokens: 605,
      totalTokens: 3015,
      projectedMicrocredits: "9007199252990993",
      chargedMicrocredits: "3000000",
    }],
    ledger: [{
      entryId: "77777777-7777-4777-8777-777777777777",
      at: FIXED_NOW,
      customerId: CUSTOMER_ID,
      entryType: "credit",
      deltaMicrocredits: "50000000",
      requestId: null,
      idempotencyKey: "seed-credit",
      reason: "初始积分",
      actorId: "local-admin",
    }],
    auditEvents: [{
      auditId: "88888888-8888-4888-8888-888888888888",
      at: FIXED_NOW,
      actorId: "local-admin",
      action: "customer.create",
      targetType: "customer",
      targetId: CUSTOMER_ID,
      customerId: CUSTOMER_ID,
      details: { name: "seed", secret: AUDIT_SECRET_SENTINEL, keyHash: KEY_HASH_SENTINEL, token: API_SECRET_SENTINEL },
      summary: `secret=${AUDIT_SECRET_SENTINEL}`,
    }],
    templates,
    sessionReads: 0,
  };
}

function overviewPayload(s) {
  const sum = (items, key) => items.reduce((total, item) => total + BigInt(item[key] || "0"), 0n).toString();
  const active = s.customers.filter((item) => item.status === "active").length;
  return {
    ok: true,
    activeCustomerCount: active,
    credentialCount: s.credentials.filter((item) => item.active !== false).length,
    availableMicrocredits: sum(s.customers, "availableMicrocredits"),
    periodTokens: sum(s.usage, "totalTokens"),
    periodCostMicrocredits: sum(s.usage, "projectedMicrocredits"),
    keyHash: KEY_HASH_SENTINEL,
    apiKey: API_SECRET_SENTINEL,
  };
}

function statusPayload() {
  const client = (id, name, preview) => ({ id, name, enabled: true, keyPreview: preview, keyHash: KEY_HASH_SENTINEL, apiKey: API_SECRET_SENTINEL });
  return {
    ...fixture("status"),
    managers: [
      { id: "vllm", ok: true, clients: { clients: [client("vllm-public-client", "vLLM 公网客户端", "sk-…a1b2")] }, exposure: { settings: { enabled: true, hasApiKey: true } } },
      { id: "llama", ok: true, clients: { clients: [client("llama-public-client", "llama 公网客户端", "sk-…c3d4")] }, exposure: { settings: { enabled: true, hasApiKey: true } } },
    ],
  };
}

function summaryPayload(s, query) {
  const groupBy = String(query.groupBy || "").split(",").filter(Boolean);
  s.summaryRequests.push({ groupBy: groupBy.join(","), tzOffsetMinutes: query.tzOffsetMinutes });
  if (!s.summaryShape) return { ok: true, items: [] };
  const rows = groupBy.join(",") === "day" ? s.dailySummary : s.usageSummary;
  const sum = (key) => rows.reduce((total, row) => total + BigInt(row[key]), 0n);
  return {
    ok: true,
    kind: "llm",
    groupBy,
    // August 2026 at UTC+08:00, independent of the browser's own time zone.
    from: "2026-07-31T16:00:00.000Z",
    to: "2026-08-31T16:00:00.000Z",
    tzOffsetMinutes: 480,
    rows,
    totals: {
      requests: Number(sum("requests")),
      ok: Number(sum("ok")),
      inputTokens: Number(sum("inputTokens")),
      cachedInputTokens: Number(sum("cachedInputTokens")),
      outputTokens: Number(sum("outputTokens")),
      totalTokens: Number(sum("totalTokens")),
      projectedMicrocredits: sum("projectedMicrocredits").toString(),
      chargedMicrocredits: sum("chargedMicrocredits").toString(),
    },
    truncated: false,
  };
}

const previewTemplates = (body) => previewPriceTemplateApplications(body, { clock: () => new Date(FIXED_NOW) });

function appliedPrice(item) {
  return {
    priceId: "99999999-9999-4999-8999-999999999999",
    planId: item.planId,
    managerId: item.managerId,
    model: item.modelPattern,
    modelPattern: item.modelPattern,
    inputPerMillionMicrocredits: item.inputPerMillionMicrocredits,
    cachedInputPerMillionMicrocredits: item.cachedInputPerMillionMicrocredits,
    outputPerMillionMicrocredits: item.outputPerMillionMicrocredits,
    sourceTemplateId: item.templateId,
    sourceCatalogVersion: item.catalogVersion,
    sourceSnapshotDate: item.snapshotDate,
    sourceUrl: item.sourceUrl,
    effectiveFrom: item.effectiveAt || FIXED_NOW,
    effectiveTo: null,
    active: true,
  };
}

/** The routes mockConsoleApi serves. Every billing answer can be turned into a 503 with scenario.failAll. */
function billingApi(s) {
  const unavailable = { status: 503, body: { ok: false, code: "mock_unavailable", message: "MOCK billing backend unavailable" } };
  const guarded = (fn) => (...args) => (s.failAll ? unavailable : fn(...args));
  const write = (fn) => (request, route, record) => {
    if (s.requireSession) return { status: 401, body: { ok: false, error: { code: "admin_session_required", message: "Pair this browser first.", hint: "pair" } } };
    if (s.csrfRejectOnce) {
      s.csrfRejectOnce = false;
      return { status: 403, body: { ok: false, error: { code: "csrf_invalid", message: "Reload the page.", hint: "reload" } } };
    }
    if (s.refuseNextWrite) {
      s.refuseNextWrite = false;
      return { status: 409, body: { ok: false, error: { code: "ledger_conflict", message: "MOCK ledger refused the entry.", hint: "retry" } } };
    }
    return fn(request, route, record);
  };
  const patch = (list, id, body, field) => {
    const item = list.find((candidate) => candidate[field] === id);
    if (item) Object.assign(item, body, { updatedAt: FIXED_NOW });
    return item;
  };
  const routes = {
    "GET /api/status": () => statusPayload(),
    "GET /api/billing/overview": () => overviewPayload(s),
    "GET /api/billing/customers": () => ({ ok: true, items: s.customers }),
    "GET /api/billing/plans": () => ({ ok: true, items: s.plans }),
    "GET /api/billing/credentials": () => ({ ok: true, items: s.credentials }),
    "GET /api/billing/prices": () => ({ ok: true, items: s.prices }),
    "GET /api/billing/usage": () => ({ ok: true, items: s.usage, nextCursor: null }),
    "GET /api/billing/usage/summary": (request, route, record) => summaryPayload(s, record.query),
    "GET /api/billing/ledger": () => ({ ok: true, items: s.ledger }),
    "GET /api/billing/audit-events": () => ({ ok: true, items: s.auditEvents }),
    "GET /api/billing/templates": () => ({ ok: true, catalogVersion: CATALOG_VERSION, items: s.templates }),
    "POST /api/billing/customers": write((request, route, { body }) => {
      const customer = {
        customerId: CREATED_CUSTOMER_ID,
        externalRef: body.externalRef || "",
        name: body.name,
        status: "active",
        planId: body.planId || null,
        enforcementMode: body.enforcementMode,
        creditLimitMicrocredits: "0",
        monthlyTokenLimit: body.monthlyTokenLimit,
        monthlyRequestLimit: body.monthlyRequestLimit,
        balanceMicrocredits: "0",
        reservedMicrocredits: "0",
        availableMicrocredits: "0",
        updatedAt: FIXED_NOW,
      };
      s.customers.push(customer);
      return { status: 201, body: { ok: true, customer } };
    }),
    "POST /api/billing/plans": write((request, route, { body }) => {
      const plan = { planId: CREATED_PLAN_ID, ...body, monthlyPriceMicrocredits: "25000000", includedMicrocredits: "100000000", updatedAt: FIXED_NOW };
      s.plans.push(plan);
      return { status: 201, body: { ok: true, plan } };
    }),
    "POST /api/billing/credentials": write((request, route, { body }) => {
      const binding = { bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...body, label: "bound masked client", active: true, updatedAt: FIXED_NOW, keyHash: KEY_HASH_SENTINEL, apiKey: API_SECRET_SENTINEL };
      s.credentials.push(binding);
      return { status: 201, body: { ok: true, binding } };
    }),
    "POST /api/billing/prices": write((request, route, { body }) => {
      const price = {
        priceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ...body,
        model: body.modelPattern,
        inputPerMillionMicrocredits: body.inputMicrocreditsPerMillion,
        cachedInputPerMillionMicrocredits: body.cachedInputMicrocreditsPerMillion,
        outputPerMillionMicrocredits: body.outputMicrocreditsPerMillion,
        effectiveFrom: FIXED_NOW,
        effectiveTo: null,
      };
      s.prices.push(price);
      return { status: 201, body: { ok: true, price } };
    }),
    "POST /api/billing/ledger/adjustments": write((request, route, { body }) => {
      const negative = String(body.amountCredits).startsWith("-");
      const [whole, fraction = ""] = String(body.amountCredits).replace(/^-/, "").split(".");
      const micro = (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"))).toString();
      const entry = {
        entryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        at: FIXED_NOW,
        customerId: body.customerId,
        entryType: "manual_adjustment",
        deltaMicrocredits: negative ? `-${micro}` : micro,
        requestId: null,
        idempotencyKey: body.idempotencyKey,
        reason: body.reason,
        actorId: "local-admin",
      };
      s.ledger.unshift(entry);
      return { status: 201, body: { ok: true, entry } };
    }),
    [`PATCH /api/billing/customers/${CUSTOMER_ID}`]: write((request, route, { body }) => {
      const customer = patch(s.customers, CUSTOMER_ID, body, "customerId");
      return { status: 200, body: { ok: true, customer } };
    }),
    [`PATCH /api/billing/customers/${CUSTOMER_ID}/policy`]: write((request, route, { body }) => {
      const customer = patch(s.customers, CUSTOMER_ID, body, "customerId");
      return { status: 200, body: { ok: true, customer } };
    }),
    "POST /api/billing/templates/preview": write((request, route, { body }) => ({ ok: true, ...previewTemplates(body) })),
    "POST /api/billing/templates/apply": write((request, route, { body }) => {
      const prices = previewTemplates(body).items.map(appliedPrice);
      s.prices.unshift(...prices);
      return { ok: true, catalogVersion: CATALOG_VERSION, appliedAt: FIXED_NOW, items: prices };
    }),
  };
  return Object.fromEntries(Object.entries(routes).map(([key, handler]) => [key, key.startsWith("GET /api/billing") ? guarded(handler) : handler]));
}

// ---------------------------------------------------------------------------
// The page

function merge(base, patchValue) {
  const next = { ...base, ...patchValue };
  for (const name of ["features", "auth", "access", "gateway"]) if (patchValue[name]) next[name] = { ...base[name], ...patchValue[name] };
  return next;
}

// The real entry makes a loopback browser with no session a viewer, so each test states its role.
async function withBootstrap(context, patchValue) {
  const guarded = (handler) => async (route) => {
    try {
      await handler(route);
    } catch (error) {
      if (!/disposed|closed|aborted/i.test(String(error?.message))) throw error;
    }
  };
  await context.route((url) => url.pathname === "/api/console/bootstrap", guarded(async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: JSON.stringify(merge(await response.json(), patchValue)) });
  }));
  await context.route((url) => !/^\/(api|c|gateway)\//.test(url.pathname) && !url.pathname.startsWith("/billing/classic"), guarded(async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.fallback();
      return;
    }
    // The entry's admin guard answers /billing without a paired session with its static pairing
    // page, so the shell is fetched from /overview and served under /billing (the SPA reads
    // location.pathname). The server's own gate is covered by service-entry's console-routes tests.
    const asBilling = new URL(route.request().url()).pathname === "/billing";
    const response = await route.fetch(asBilling ? { url: `${entry.url}overview` } : undefined);
    const body = (await response.text()).replace(BOOTSTRAP_BLOCK, (match, open, json, close) => (
      `${open}${JSON.stringify(merge(JSON.parse(json), patchValue)).replace(/</g, "<")}${close}`));
    await route.fulfill({ response, body });
  }));
}

async function open(browser, { bootstrap = OWNER, theme = "light", locale = "en-US", size = { width: 1440, height: 960 }, scenario = freshScenario(), session } = {}) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme, locale, reducedMotion: "reduce" });
  await setPrefs(context, { theme, locale, density: "comfortable" }, { baseUrl: entry.url });
  await withBootstrap(context, { features: { platform: true }, ...bootstrap });
  // Date.now is pinned so the price catalog's "not yet effective" template is the same on any day.
  await context.addInitScript((fixedNow) => {
    const fixedMs = new Date(fixedNow).getTime();
    Date.now = () => fixedMs;
  }, FIXED_NOW);
  const page = await context.newPage();
  const failures = await collectFailures(page);
  scenario.summaryRequests = [];
  const mock = await mockConsoleApi(page, {
    "GET /api/platform/status": fixture("platform-status"),
    "GET /api/platform/version": { ok: true, version: "0.2.0-git-2ad10e5ffe68", build: { commit: "2ad10e5ffe68", contentHash: "3f9c2a1b7d0e" }, newerCommits: 0 },
    "GET /api/fleet": fixture("fleet"),
    "GET /api/session": () => {
      scenario.sessionReads += 1;
      return session || fixture("session");
    },
    ...billingApi(scenario),
  });
  return { context, page, failures, mock, scenario };
}

const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
const realFailures = (failures) => failures.failures.filter((item) => !/Failed to load resource/.test(item));
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const callsOf = (mock, method, pathName) => mock.calls.filter((call) => call.method === method && call.path === pathName);

async function load(page, route = "/billing", state = "Local-only management · API healthy") {
  await page.goto(`${entry.url}${route.replace(/^\//, "")}`);
  await expect(byId(page, "billing.api-state")).toHaveText(state);
  await expect(byId(page, "billing.workbench")).toHaveAttribute("aria-busy", "false");
}

// ---------------------------------------------------------------------------
// Five tabs, hostile text, secrets

test("five tabs over eight routes; hostile API text stays text and no secret is rendered", async ({ browser }) => {
  const { context, page, failures, scenario } = await open(browser, { locale: "zh-CN" });
  try {
    await load(page, "/billing", "仅本机管理 · API 正常");
    await expect(page.locator("#main h1")).toHaveText("计费");
    const names = ["总览", "客户与凭证", "套餐与价格", "用量与账本", "操作审计"];
    await expect(page.getByRole("tab")).toHaveText(names);
    for (const name of names) {
      await tab(page, name).click();
      await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toHaveCount(1);
    }
    // The tabs are routes: each one has a path of its own.
    await expect(page).toHaveURL(/\/billing\/audit$/);
    await expect(byId(page, "billing.audit")).toBeVisible();
    await expect(byId(page, "billing.audit")).toContainText("[已脱敏]");

    await tab(page, "总览").click();
    await expect(page).toHaveURL(/\/billing$/);
    const customers = byId(page, "billing.overview.customers");
    await expect(customers).toContainText("XSS_SENTINEL");
    await expect(customers).toContainText("CRM-XSS");
    await expect(customers.locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => window.__billingXss)).toBeUndefined();
    // The raw request table keeps its heading and columns; the status reads like the classic page.
    await expect(byId(page, "billing.recent.heading")).toHaveText("最近请求（原始记录，最多 100 条）");
    const recent = byId(page, "billing.recent");
    await expect(recent.locator("thead th")).toHaveText(["时间", "客户", "管理器", "模型", "Tokens", "状态"]);
    await expect(recent).toContainText("local/base-7b");
    await expect(recent).toContainText("完成 · 200");

    for (const name of names) await tab(page, name).click();
    const allText = await page.locator("body").textContent();
    for (const secret of [API_SECRET_SENTINEL, KEY_HASH_SENTINEL, AUDIT_SECRET_SENTINEL]) expect(allText).not.toContain(secret);
    expect(await page.evaluate(() => window.__billingXss)).toBeUndefined();
    expect(scenario.sessionReads).toBeGreaterThanOrEqual(0);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the deep-link routes land on their tab and section; the classic page stays one click away", async ({ browser }) => {
  const { context, page } = await open(browser);
  try {
    const cases = [
      ["/billing/customers", "Customers & credentials", "billing.customers"],
      ["/billing/credentials", "Customers & credentials", "billing.customers"],
      ["/billing/plans", "Plans & prices", "billing.prices"],
      ["/billing/prices", "Plans & prices", "billing.prices"],
      ["/billing/usage", "Usage & ledger", "billing.usage"],
      ["/billing/ledger", "Usage & ledger", "billing.usage"],
      ["/billing/audit", "Audit log", "billing.audit"],
    ];
    for (const [route, label, root] of cases) {
      await load(page, route);
      await expect(tab(page, label)).toHaveAttribute("aria-selected", "true");
      await expect(byId(page, root)).toBeVisible();
    }
    await load(page, "/billing/ledger");
    await expect(byId(page, "billing.ledger.card")).toBeInViewport();
    await expect(byId(page, "billing.classic")).toHaveAttribute("href", "/billing/classic");
    // A legacy manager link keeps its context: the forms start on that manager.
    await load(page, "/billing/customers?manager=llama");
    await expect(byId(page, "billing-credential-form.managerId")).toHaveValue("llama-manager");
  } finally {
    await context.close();
  }
});

test("a viewer or a remote browser gets an EmptyState or the pairing screen, and no billing request is made", async ({ browser }) => {
  for (const [bootstrap, locale, title] of [
    [{ ...OWNER, access: { local: false } }, "en-US", "Billing administration is local-only"],
    [{ ...OWNER, access: { local: false } }, "zh-CN", "计费管理仅限本机"],
  ]) {
    const { context, page, mock } = await open(browser, { bootstrap, locale });
    try {
      await page.goto(`${entry.url}billing`);
      await expect(byId(page, "billing.local-only").locator("h2")).toHaveText(title);
      expect(mock.calls.filter((call) => call.path.startsWith("/api/billing"))).toHaveLength(0);
    } finally {
      await context.close();
    }
  }
  const remote = await open(browser, { bootstrap: REMOTE_VIEWER });
  try {
    await remote.page.goto(`${entry.url}billing/usage`);
    await expect(byId(remote.page, "forbidden.root").locator('[data-testid="empty-state.title"]')).toHaveText("Owner only, on this machine");
    expect(remote.mock.calls.filter((call) => call.path.startsWith("/api/billing"))).toHaveLength(0);
  } finally {
    await remote.context.close();
  }
  const local = await open(browser, { bootstrap: VIEWER, session: SESSION_UNPAIRED });
  try {
    await local.page.goto(`${entry.url}billing/customers`);
    await expect(byId(local.page, "pairing-screen.root")).toBeVisible();
    expect(local.mock.calls.filter((call) => call.path.startsWith("/api/billing"))).toHaveLength(0);
  } finally {
    await local.context.close();
  }
});

// ---------------------------------------------------------------------------
// Writes

test("customer, plan, credential and balance forms send bounded bodies with the session token and refresh the tables", async ({ browser }) => {
  const { context, page, mock, failures } = await open(browser);
  try {
    await load(page);
    await byId(page, "billing-customer-form.name").fill("新客户 Alpha");
    await byId(page, "billing-customer-form.externalRef").fill("CRM-2002");
    await byId(page, "billing-customer-form.planId").selectOption(PLAN_ID);
    await byId(page, "billing-customer-form.enforcementMode").selectOption("hard");
    await byId(page, "billing-customer-form.creditLimit").fill("125.000001");
    await byId(page, "billing-customer-form.monthlyTokenLimit").fill("9000000");
    await byId(page, "billing-customer-form.monthlyRequestLimit").fill("12000");
    await byId(page, "billing-customer-form.submit").click();
    await expect(byId(page, "billing.overview.customers")).toContainText("新客户 Alpha");
    expect(callsOf(mock, "POST", "/api/billing/customers").at(-1).body).toEqual({
      name: "新客户 Alpha",
      externalRef: "CRM-2002",
      planId: PLAN_ID,
      enforcementMode: "hard",
      creditLimit: "125.000001",
      monthlyTokenLimit: "9000000",
      monthlyRequestLimit: "12000",
    });
    // The form is empty again for the next customer.
    await expect(byId(page, "billing-customer-form.name")).toHaveValue("");

    await tab(page, "Plans & prices").click();
    await byId(page, "billing-plan-form.code").fill("TEAM");
    await byId(page, "billing-plan-form.name").fill("团队套餐");
    await byId(page, "billing-plan-form.currency").fill("USD");
    await byId(page, "billing-plan-form.enforcementMode").selectOption("hard");
    await byId(page, "billing-plan-form.monthlyPrice").fill("25");
    await byId(page, "billing-plan-form.includedCredits").fill("100");
    await byId(page, "billing-plan-form.monthlyTokenLimit").fill("20000000");
    await byId(page, "billing-plan-form.monthlyRequestLimit").fill("30000");
    await byId(page, "billing-plan-form.submit").click();
    await expect(byId(page, "billing.plans.card")).toContainText("团队套餐");
    expect(callsOf(mock, "POST", "/api/billing/plans").at(-1).body).toMatchObject({ code: "TEAM", name: "团队套餐", currency: "USD", enforcementMode: "hard", monthlyPrice: "25", includedCredits: "100", monthlyTokenLimit: "20000000", monthlyRequestLimit: "30000", active: true });

    await tab(page, "Customers & credentials").click();
    await byId(page, "billing-credential-form.customerId").selectOption(CUSTOMER_ID);
    await byId(page, "billing-credential-form.managerId").selectOption("vllm-manager");
    await expect(byId(page, "billing-credential-form.serviceClientId")).toBeEnabled();
    await byId(page, "billing-credential-form.serviceClientId").selectOption("vllm-public-client");
    await byId(page, "billing-credential-form.submit").click();
    await expect(byId(page, "billing.credentials.card")).toContainText("vllm-public-client");
    expect(callsOf(mock, "POST", "/api/billing/credentials").at(-1).body).toEqual({ customerId: CUSTOMER_ID, managerId: "vllm-manager", serviceClientId: "vllm-public-client" });
    // Only the masked client name, id and preview come from /api/status.
    expect(await page.locator("body").textContent()).not.toContain(API_SECRET_SENTINEL);

    // A manual adjustment is immutable: a debit is confirmed with its amount typed back.
    await byId(page, "billing-adjustment-form.customerId").selectOption(CUSTOMER_ID);
    await byId(page, "billing-adjustment-form.amountCredits").fill("-10.500001");
    await byId(page, "billing-adjustment-form.reason").fill("退款差额调整");
    await byId(page, "billing-adjustment-form.submit").click();
    const dialog = byId(page, "billing.adjust.dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Irreversible debit record");
    await expect(dialog).toContainText("-10.500001");
    expect(callsOf(mock, "POST", "/api/billing/ledger/adjustments")).toHaveLength(0);
    await expect(byId(page, "dialog.confirm")).toBeDisabled();
    await byId(page, "dialog.input").fill("-10.5");
    await expect(byId(page, "dialog.confirm")).toBeDisabled();
    await byId(page, "dialog.input").fill("-10.500001");
    await byId(page, "dialog.confirm").click();
    await expect(dialog).toHaveCount(0);
    const adjustment = callsOf(mock, "POST", "/api/billing/ledger/adjustments").at(-1).body;
    expect(adjustment).toMatchObject({ customerId: CUSTOMER_ID, amountCredits: "-10.500001", reason: "退款差额调整" });
    expect(adjustment.idempotencyKey).toMatch(/^manual-[a-f0-9-]+$/i);

    await tab(page, "Usage & ledger").click();
    await expect(byId(page, "billing.ledger.card")).toContainText("退款差额调整");
    await expect(byId(page, "billing.ledger.card")).toContainText("-10.500001 credits");

    // Every write carried the session's CSRF token (05 §5.5).
    const writes = mock.calls.filter((call) => call.method !== "GET");
    expect(writes.length).toBeGreaterThanOrEqual(4);
    expect(writes.map((call) => call.headers["x-csrf-token"])).toEqual(writes.map(() => "t"));
    expect(mock.csrfViolations).toEqual([]);
    expect(mock.unmocked).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a credit adjustment asks without typing, a bad form shows field errors and sends nothing", async ({ browser }) => {
  const { context, page, mock, scenario } = await open(browser);
  try {
    await load(page, "/billing/customers");
    await byId(page, "billing-adjustment-form.submit").click();
    await expect(byId(page, "billing-adjustment-form.customerId.field").locator('[data-testid="form-field.error"]')).toBeVisible();
    await expect(byId(page, "billing-adjustment-form.reason.field").locator('[data-testid="form-field.error"]')).toBeVisible();
    await byId(page, "billing-adjustment-form.customerId").selectOption(CUSTOMER_ID);
    await byId(page, "billing-adjustment-form.amountCredits").fill("1.2345678");
    await byId(page, "billing-adjustment-form.reason").fill("ok reason");
    await byId(page, "billing-adjustment-form.submit").click();
    await expect(byId(page, "billing-adjustment-form.amountCredits.field").locator('[data-testid="form-field.error"]')).toContainText("6 fraction digits");
    await byId(page, "billing-adjustment-form.amountCredits").fill("0");
    await byId(page, "billing-adjustment-form.submit").click();
    await expect(byId(page, "billing-adjustment-form.amountCredits.field").locator('[data-testid="form-field.error"]')).toContainText("Must not be 0");
    await byId(page, "billing-adjustment-form.amountCredits").fill("25.5");
    await byId(page, "billing-adjustment-form.submit").click();
    const dialog = byId(page, "billing.adjust.dialog");
    await expect(dialog).toContainText("Write to the immutable credit ledger");
    await expect(dialog).not.toContainText("Irreversible debit record");
    await expect(byId(page, "dialog.input")).toHaveCount(0);
    await byId(page, "dialog.cancel").click();
    expect(callsOf(mock, "POST", "/api/billing/ledger/adjustments")).toHaveLength(0);
    // A server refusal stays on the form of the dialog.
    scenario.refuseNextWrite = true;
    await byId(page, "billing-adjustment-form.submit").click();
    await byId(page, "dialog.confirm").click();
    await expect(page.locator("[role=status]").filter({ hasText: "written to the ledger" })).toHaveCount(0);
    await expect.poll(() => callsOf(mock, "POST", "/api/billing/ledger/adjustments").length).toBe(1);
  } finally {
    await context.close();
  }
});

test("suspending and restoring a customer asks first and patches only the status", async ({ browser }) => {
  const { context, page, mock } = await open(browser);
  try {
    await load(page);
    const customers = byId(page, "billing.overview.customers");
    await customers.locator('[data-testid="billing.customer.toggle"]').click();
    await expect(byId(page, "billing.toggle.dialog")).toBeVisible();
    await byId(page, "dialog.cancel").click();
    expect(callsOf(mock, "PATCH", `/api/billing/customers/${CUSTOMER_ID}`)).toHaveLength(0);
    await customers.locator('[data-testid="billing.customer.toggle"]').click();
    await byId(page, "dialog.confirm").click();
    await expect(customers).toContainText("Suspended");
    expect(callsOf(mock, "PATCH", `/api/billing/customers/${CUSTOMER_ID}`).at(-1).body).toEqual({ status: "suspended" });
    await customers.locator('[data-testid="billing.customer.toggle"]').click();
    await byId(page, "dialog.confirm").click();
    await expect(customers).toContainText("Active");
  } finally {
    await context.close();
  }
});

test("the policy button fills the account policy form, which patches the policy route", async ({ browser }) => {
  const { context, page, mock } = await open(browser);
  try {
    await load(page);
    await byId(page, "billing.overview.customers").locator('[data-testid="billing.customer.edit"]').click();
    await expect(page).toHaveURL(new RegExp(`/billing/customers\\?edit=${CUSTOMER_ID}`));
    await expect(byId(page, "billing-policy-form.customerId")).toHaveValue(CUSTOMER_ID);
    await expect(byId(page, "billing-policy-form.enforcementMode")).toHaveValue("hard");
    await expect(byId(page, "billing-policy-form.monthlyTokenLimit")).toHaveValue("5000000");
    await byId(page, "billing-policy-form.enforcementMode").selectOption("shadow");
    await byId(page, "billing-policy-form.creditLimit").fill("300");
    await byId(page, "billing-policy-form.submit").click();
    await expect.poll(() => callsOf(mock, "PATCH", `/api/billing/customers/${CUSTOMER_ID}/policy`).length).toBe(1);
    expect(callsOf(mock, "PATCH", `/api/billing/customers/${CUSTOMER_ID}/policy`)[0].body).toEqual({
      planId: PLAN_ID, enforcementMode: "shadow", creditLimit: "300", monthlyTokenLimit: "5000000", monthlyRequestLimit: "10000",
    });
  } finally {
    await context.close();
  }
});

test("a stale CSRF token is re-read once and retried; an unpaired write shows the pairing screen", async ({ browser }) => {
  const { context, page, mock, scenario, failures } = await open(browser);
  try {
    await load(page);
    const create = async (name) => {
      await byId(page, "billing-customer-form.name").fill(name);
      await byId(page, "billing-customer-form.submit").click();
    };
    await create("首个客户");
    await expect(byId(page, "billing.overview.customers")).toContainText("首个客户");

    // One 403 csrf_invalid, one fresh GET /api/session, one retry.
    scenario.csrfRejectOnce = true;
    const readsBefore = callsOf(mock, "GET", "/api/session").length;
    await create("重试客户");
    await expect(byId(page, "billing.overview.customers")).toContainText("重试客户");
    expect(callsOf(mock, "POST", "/api/billing/customers").slice(-2).map((call) => call.body.name)).toEqual(["重试客户", "重试客户"]);
    expect(callsOf(mock, "GET", "/api/session").length - readsBefore).toBe(1);

    // No owner session: the pairing screen names the pairing command.
    scenario.requireSession = true;
    await create("未配对客户");
    const screen = byId(page, "pairing-screen.root");
    await expect(screen).toBeVisible();
    await expect(byId(page, "pairing-screen.command")).toContainText("platform admin pair");
    // Billing is an owner page: dismissing the overlay leaves the viewer on the route's own
    // pairing gate, never on the forms.
    await byId(page, "pairing-screen.dismiss").click();
    await expect(screen).toBeVisible();
    await expect(byId(page, "billing.root")).toHaveCount(0);
    expect(mock.csrfViolations).toEqual([]);
    expect(realFailures(failures)).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Price templates

test("template filters, the future-date guard, the exact preview, mapping and a confirmed apply work end to end", async ({ browser }) => {
  const { context, page, mock } = await open(browser);
  try {
    await load(page, "/billing/prices");
    const future = PRICE_TEMPLATE_CATALOG.find((template) => template.effectiveFrom && Date.parse(template.effectiveFrom) > Date.parse(FIXED_NOW));
    expect(future, "catalog fixture needs a future effectiveFrom template").toBeTruthy();
    const futureButton = page.locator(`[data-template-id="${future.id}"]`);
    await expect(futureButton).toBeDisabled();
    await expect(futureButton).toHaveAttribute("title", "Not yet effective");

    const catalog = byId(page, "billing.templates.catalog");
    await catalog.locator('[data-template-provider="Anthropic"]').click();
    await expect(catalog).toContainText("Claude Opus 5");
    await expect(catalog).not.toContainText("GPT-5.6 Terra");
    await catalog.locator('[data-template-provider=""]').click();
    await byId(page, "billing.templates.search").fill("GPT-5.6 Terra");

    const templateId = "openai:gpt-5.6-terra:standard:le-272k";
    await page.locator(`[data-template-id="${templateId}"]`).click();
    await byId(page, "billing-template-form.managerId").selectOption("llama-manager");
    await byId(page, "billing-template-form.planId").selectOption(PLAN_ID);
    await byId(page, "billing-template-form.modelPattern").fill("local/qwen3-terra-*");
    await byId(page, "billing-template-form.creditsPerUsd").fill("1.234567");
    await byId(page, "billing-template-form.markupBps").fill("12345");
    await expect(byId(page, "billing-template-form.apply")).toBeDisabled();
    await byId(page, "billing-template-form.submit").click();

    await expect.poll(() => callsOf(mock, "POST", "/api/billing/templates/preview").length).toBe(1);
    const previewRequest = callsOf(mock, "POST", "/api/billing/templates/preview")[0].body;
    expect(previewRequest).toEqual({
      items: [{ templateId, managerId: "llama-manager", modelPattern: "local/qwen3-terra-*", planId: PLAN_ID }],
      creditsPerUsd: "1.234567",
      markupBps: "12345",
    });
    const expected = previewTemplates(previewRequest).items[0];
    const previewText = (await byId(page, "billing.templates.preview").innerText()).replace(/[\s,]/g, "");
    expect(previewText).toContain(expected.inputPerMillionMicrocredits);
    expect(previewText).toContain(expected.cachedInputPerMillionMicrocredits);
    expect(previewText).toContain(expected.outputPerMillionMicrocredits);
    await expect(byId(page, "billing-template-form.apply")).toBeEnabled();

    // Any mapping or rate change invalidates the preview until it is made again.
    await byId(page, "billing-template-form.modelPattern").fill("local/qwen3-terra-changed-*");
    await expect(byId(page, "billing-template-form.apply")).toBeDisabled();
    await expect(byId(page, "billing.templates.preview")).toHaveCount(0);
    await byId(page, "billing-template-form.modelPattern").fill("local/qwen3-terra-*");
    await byId(page, "billing-template-form.submit").click();
    await expect(byId(page, "billing-template-form.apply")).toBeEnabled();

    expect(callsOf(mock, "POST", "/api/billing/templates/apply")).toHaveLength(0);
    await byId(page, "billing-template-form.apply").click();
    await expect(byId(page, "billing.templates.dialog")).toContainText("local/qwen3-terra-*");
    await byId(page, "dialog.confirm").click();
    await expect.poll(() => callsOf(mock, "POST", "/api/billing/templates/apply").length).toBe(1);
    expect(callsOf(mock, "POST", "/api/billing/templates/apply")[0].body).toEqual(previewRequest);
    const rules = byId(page, "billing.prices.card");
    await expect(rules).toContainText("local/qwen3-terra-*");
    await expect(rules).toContainText(templateId);
    await expect(byId(page, "billing.templates.preview")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Outage and recovery

test("a complete API outage has an explicit error state and recovers through refresh", async ({ browser }) => {
  const scenario = freshScenario();
  scenario.failAll = true;
  const { context, page } = await open(browser, { scenario });
  try {
    await page.goto(`${entry.url}billing`);
    await expect(byId(page, "billing.api-state")).toHaveText("Billing API unavailable");
    await expect(byId(page, "billing.notice")).toContainText("backend endpoints have not answered");
    await expect(byId(page, "billing.workbench")).toHaveAttribute("aria-busy", "false");
    await expect(byId(page, "billing.errors")).toBeVisible();

    scenario.failAll = false;
    await byId(page, "billing.refresh").click();
    await expect(byId(page, "billing.api-state")).toHaveText("Local-only management · API healthy");
    await expect(byId(page, "billing.notice")).toHaveCount(0);
    await expect(byId(page, "billing.overview.customers")).toContainText("XSS_SENTINEL");
  } finally {
    await context.close();
  }
});

test("one failing endpoint is a partial state that names it, and the rest stays usable", async ({ browser }) => {
  const scenario = freshScenario();
  const { context, page } = await open(browser, { scenario });
  try {
    await page.route("**/api/billing/audit-events**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, code: "boom", message: "audit store offline" }) }));
    await page.goto(`${entry.url}billing`);
    await expect(byId(page, "billing.api-state")).toHaveText("Some endpoints unavailable");
    await expect(byId(page, "billing.notice")).toContainText("Some data was not refreshed");
    await byId(page, "billing.errors").locator("summary").click();
    await expect(byId(page, "billing.errors")).toContainText("Audit");
    await expect(byId(page, "billing.overview.customers")).toContainText("XSS_SENTINEL");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Usage: aggregates, exact numbers, drill-down

const SUMMARY_COPY = {
  zh: {
    locale: "zh-CN",
    heading: "本期用量（按客户 × 模型 × 月汇总）",
    columns: ["客户", "模型", "月份", "请求", "成功", "输入 Tokens", "缓存 Tokens", "输出 Tokens", "预计消费", "已扣"],
    note: "统计区间 2026-08-01 至 2026-08-31（UTC+08:00）",
    unbound: "未绑定客户",
    projected: "9,007,199,254.740993 积分",
    charged: "4.5 积分",
    total: "合计",
    caption: "每日 Tokens（峰值 3,015）",
    bar: "2026-08-10：1 次请求 · 1,500 Tokens · 预计 1.75 积分",
  },
  en: {
    locale: "en-US",
    heading: "Usage this period (by customer × model × month)",
    columns: ["Customer", "Model", "Month", "Requests", "Succeeded", "Input tokens", "Cached tokens", "Output tokens", "Projected", "Charged"],
    note: "Period 2026-08-01 to 2026-08-31 (UTC+08:00)",
    unbound: "Unbound customer",
    projected: "9,007,199,254.740993 credits",
    charged: "4.5 credits",
    total: "Total",
    caption: "Daily tokens (peak 3,015)",
    bar: "2026-08-10 · requests 1 · tokens 1,500 · projected 1.75 credits",
  },
};

async function expectUsageSummary(page, copy) {
  const panel = byId(page, "billing.summary");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("lang", copy.locale);
  await expect(panel.locator("h2")).toHaveText(copy.heading);
  await expect(byId(page, "billing.summary.note")).toContainText(copy.note);
  await expect(panel.locator("thead th")).toHaveText(copy.columns);
  const rows = byId(page, "billing.summary.rows").locator("tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td")).toHaveText([XSS_SENTINEL, "local/base-7b", "2026-08", "3", "2", "3,600", "600", "900", copy.projected, copy.charged]);
  await expect(rows.nth(1).locator("td").first()).toHaveText(copy.unbound);
  await expect(byId(page, "billing.summary.totals").locator("td")).toHaveText([copy.total, "", "", "4", "3", "3,610", "600", "905", copy.projected, copy.charged]);
  await expect(panel.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__billingXss)).toBeUndefined();

  // The daily chart is inline SVG: one slot per day of August, a bar per day with usage.
  await expect(byId(page, "billing.summary.chart-caption")).toHaveText(copy.caption);
  await expect(byId(page, "billing.summary.chart-svg")).toHaveAttribute("viewBox", "0 0 310 100");
  const bars = page.locator('[data-testid="billing.summary.chart-svg"] rect.usage-chart-bar');
  await expect(bars).toHaveCount(2);
  expect(await bars.first().locator("title").textContent()).toBe(copy.bar);
  await expect(byId(page, "billing.summary.chart-axis").locator("span")).toHaveText(["08-01", "08-16", "08-31"]);

  // Measured until the layout settles: the lazy cards and the chart finish after the first paint.
  const measure = () => page.evaluate(() => {
    const summary = document.querySelector('[data-testid="billing.summary"]');
    const raw = document.querySelector('[data-testid="billing.recent"]');
    const box = summary.getBoundingClientRect();
    const chart = document.querySelector('[data-testid="billing.summary.chart-svg"]').getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    return {
      "the aggregate precedes the raw table": Boolean(summary.compareDocumentPosition(raw) & Node.DOCUMENT_POSITION_FOLLOWING),
      "the aggregate ends above the raw table": box.bottom <= raw.getBoundingClientRect().top,
      "the page does not scroll sideways": document.documentElement.scrollWidth <= width + 1,
      "the aggregate starts inside the page": box.left >= -1,
      "the aggregate ends inside the page": box.right <= width + 1,
      "the chart stays inside the aggregate": chart.right <= box.right + 1,
    };
  });
  await expect.poll(async () => Object.entries(await measure()).filter(([, ok]) => !ok).map(([name]) => name)).toEqual([]);
}

test("usage shows the usage/summary aggregates above the raw table, exact, in zh and en at 390 px", async ({ browser }) => {
  for (const copy of [SUMMARY_COPY.zh, SUMMARY_COPY.en]) {
    const { context, page, scenario } = await open(browser, { locale: copy.locale, size: { width: 390, height: 844 } });
    try {
      await page.goto(`${entry.url}billing`);
      await expect(byId(page, "billing.workbench")).toHaveAttribute("aria-busy", "false");
      await expect(byId(page, "billing.summary")).toBeVisible();
      expect(scenario.summaryRequests.map((request) => request.groupBy).sort()).toEqual(["customer,model,month", "day"]);
      expect(scenario.summaryRequests.every((request) => /^-?\d+$/.test(request.tzOffsetMinutes || ""))).toBe(true);
      await expectUsageSummary(page, copy);
      await expectNoOverflow(page);
    } finally {
      await context.close();
    }
  }
});

test("the Usage tab holds the aggregates; a customer cell drills into that customer's raw requests", async ({ browser }) => {
  const { context, page, mock } = await open(browser);
  try {
    await load(page, "/billing/usage");
    await expect(byId(page, "billing.summary")).toBeVisible();
    await expect(byId(page, "billing.usage.heading")).toHaveText("Recent requests (raw records)");
    await expect(byId(page, "billing.usage.card")).toContainText("local/base-7b");
    await byId(page, "billing.summary.rows").locator("button").first().click();
    await expect(byId(page, "billing.usage.filter-customer")).toBeVisible();
    await expect.poll(() => mock.calls.some((call) => call.path === "/api/billing/usage" && call.query.customerId === CUSTOMER_ID)).toBe(true);
    await byId(page, "billing.usage.filter-customer").click();
    await expect(byId(page, "billing.usage.filter-customer")).toHaveCount(0);
    // The overview's aggregate sends the drill to this tab.
    await load(page);
    await byId(page, "billing.summary.rows").locator("button").first().click();
    await expect(page).toHaveURL(new RegExp(`/billing/usage\\?customer=${CUSTOMER_ID}`));
    await expect(byId(page, "billing.usage.filter-customer")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("raw requests and the ledger page on: load more appends the next page by cursor and by offset", async ({ browser }) => {
  const scenario = freshScenario();
  const row = (n) => ({ ...scenario.usage[0], usageId: `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`, model: `local/page-${n}` });
  const apiOverrides = billingApi(scenario);
  const { context, page } = await open(browser, { scenario });
  const usageCursors = [];
  try {
    const firstUsage = Array.from({ length: 100 }, (_, index) => row(index));
    await page.route("**/api/billing/usage?**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/api/billing/usage") return route.fallback();
      const second = url.searchParams.get("cursor") === "CURSOR_2";
      usageCursors.push(url.searchParams.get("cursor"));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, items: second ? [row(1000)] : firstUsage, nextCursor: second ? null : "CURSOR_2" }) });
    });
    const firstLedger = Array.from({ length: 100 }, (_, index) => ({ ...scenario.ledger[0], entryId: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`, reason: `ledger-${index}` }));
    await page.route("**/api/billing/ledger?**", async (route) => {
      const url = new URL(route.request().url());
      const second = url.searchParams.get("offset") === "100";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, items: second ? [{ ...scenario.ledger[0], entryId: "77777777-7777-4777-8777-999999999999", reason: "ledger-last" }] : firstLedger }) });
    });
    expect(Object.keys(apiOverrides).length).toBeGreaterThan(5);
    await load(page, "/billing/usage");
    const raw = byId(page, "billing.usage.card");
    await expect(raw.locator('[data-testid="data-table.row"]')).toHaveCount(100);
    await raw.locator('[data-testid="data-table.load-more"]').click();
    await expect(raw.locator('[data-testid="data-table.row"]')).toHaveCount(101);
    await expect(raw).toContainText("local/page-1000");
    await expect(raw.locator('[data-testid="data-table.load-more"]')).toHaveCount(0);
    expect(usageCursors).toEqual([null, "CURSOR_2"]);
    const ledger = byId(page, "billing.ledger.card");
    await expect(ledger.locator('[data-testid="data-table.row"]')).toHaveCount(100);
    await ledger.locator('[data-testid="data-table.load-more"]').click();
    await expect(ledger).toContainText("ledger-last");
  } finally {
    await context.close();
  }
});

test("the aggregate panel stays hidden when the API answers without summary rows", async ({ browser }) => {
  const scenario = freshScenario();
  scenario.summaryShape = false;
  const { context, page } = await open(browser, { scenario });
  try {
    await load(page);
    await expect(byId(page, "billing.summary")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Usage this period");
    await expect(byId(page, "billing.recent")).toContainText("local/base-7b");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Layout and accessibility

test("390 px has no page-level horizontal overflow on any tab", async ({ browser }) => {
  const { context, page } = await open(browser, { size: { width: 390, height: 844 } });
  try {
    await load(page);
    for (const label of ["Overview", "Customers & credentials", "Plans & prices", "Usage & ledger", "Audit log"]) {
      await tab(page, label).click();
      await expect(tab(page, label)).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toBeVisible();
      await expectNoOverflow(page);
    }
    await tab(page, "Plans & prices").click();
    await expect(byId(page, "billing.templates.catalog")).toBeVisible();
    await expectNoOverflow(page);
  } finally {
    await context.close();
  }
});

for (const theme of ["light", "dark"]) {
  test(`every billing tab passes axe in the ${theme} theme`, async ({ browser }) => {
    const { context, page, failures } = await open(browser, { theme });
    try {
      await load(page);
      for (const [label, route] of [["Overview", "/billing"], ["Customers & credentials", "/billing/customers"], ["Plans & prices", "/billing/prices"], ["Usage & ledger", "/billing/usage"], ["Audit log", "/billing/audit"]]) {
        await tab(page, label).click();
        await expect(page).toHaveURL(new RegExp(`${route}$`));
        await expect(page.getByRole("tabpanel").locator("section, form").first()).toBeVisible();
        await expectNoA11yViolations(page, { label: `${route} ${theme}` });
      }
      expect(realFailures(failures)).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
