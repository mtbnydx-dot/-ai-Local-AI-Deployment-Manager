const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const {
  CATALOG_VERSION,
  PRICE_TEMPLATE_CATALOG,
} = require("../service-entry/lib/billing-price-templates");

const ROOT = path.resolve(__dirname, "..");
const BILLING_HTML = path.join(ROOT, "service-entry", "billing.html");
const LLAMA_INDEX_HTML = path.join(ROOT, "llama-manager", "public", "index.html");
const VLLM_INDEX_HTML = path.join(ROOT, "vllm-manager", "public", "index.html");
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const XSS_SENTINEL = '<img src=x onerror="window.__billingXss=1">XSS_SENTINEL';
const API_SECRET_SENTINEL = "sk-API_SECRET_SENTINEL";
const KEY_HASH_SENTINEL = "HASH_SENTINEL_SHOULD_NOT_RENDER";
const AUDIT_SECRET_SENTINEL = "AUDIT_SECRET_SENTINEL";
const FIXED_NOW = "2026-08-11T02:00:00.000Z";
// The legacy billing page lives at /billing/classic since 07 CON-2 (/billing is the console route).
// CON-27 ported the forms, CSRF retry, template, aggregate and overflow pins to
// tests/frontend/console/console-billing.spec.js; this file keeps what only the
// classic page can show (its sidebar, manager return context, outage state, embed mode).
const BILLING_PATH = "/billing/classic";

let html;
let server;
let baseUrl;
let scenario;
const diagnosticsByPage = new WeakMap();

function freshScenario() {
  const templates = PRICE_TEMPLATE_CATALOG.map((template) => ({
    ...template,
    rates: { ...template.rates },
    context: { ...template.context },
    notes: [...template.notes],
    // Unknown secret-shaped fields deliberately exercise the UI allowlists.
    keyHash: KEY_HASH_SENTINEL,
    apiKey: API_SECRET_SENTINEL,
  }));
  return {
    failAll: false,
    requests: [],
    // GET /api/session (05 §5.6): a paired owner whose CSRF token is "t".
    session: { ok: true, role: "owner", via: "session", paired: true, csrfToken: "t", autoPairAvailable: false, pairCommand: "platform admin pair" },
    sessionReads: 0,
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
      sourceCatalogVersion: null,
      sourceSnapshotDate: null,
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
    // GET /api/billing/usage/summary answers (TEL-14), keyed by groupBy. The
    // first row's projected sum is past 2^53 to prove the page keeps it exact.
    summaryRequests: [],
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
      estimatedUsageRequests: 1,
      shadowRequests: 0,
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
      estimatedUsageRequests: 0,
      shadowRequests: 1,
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
      estimatedUsageRequests: 0,
      shadowRequests: 0,
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
      estimatedUsageRequests: 1,
      shadowRequests: 1,
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
      details: {
        name: "seed",
        secret: AUDIT_SECRET_SENTINEL,
        keyHash: KEY_HASH_SENTINEL,
        token: API_SECRET_SENTINEL,
      },
      summary: `secret=${AUDIT_SECRET_SENTINEL}`,
    }],
    templates,
  };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function nextOverview() {
  const activeCustomers = scenario.customers.filter((item) => item.status === "active").length;
  const activeCredentials = scenario.credentials.filter((item) => item.active !== false).length;
  const availableMicrocredits = scenario.customers.reduce(
    (total, item) => total + BigInt(item.availableMicrocredits || "0"),
    0n,
  ).toString();
  const periodTokens = scenario.usage.reduce((total, item) => total + BigInt(item.totalTokens || "0"), 0n).toString();
  const periodCostMicrocredits = scenario.usage.reduce(
    (total, item) => total + BigInt(item.projectedMicrocredits || "0"),
    0n,
  ).toString();
  return {
    ok: true,
    activeCustomerCount: activeCustomers,
    activeCustomers,
    credentialCount: activeCredentials,
    activeCredentials,
    availableMicrocredits,
    periodTokens,
    periodCostMicrocredits,
    keyHash: KEY_HASH_SENTINEL,
    apiKey: API_SECRET_SENTINEL,
  };
}

function statusPayload() {
  return {
    managers: [{
      id: "vllm",
      clients: {
        clients: [{
          id: "vllm-public-client",
          name: "vLLM 公网客户端",
          enabled: true,
          keyPreview: "sk-…a1b2",
          keyHash: KEY_HASH_SENTINEL,
          apiKey: API_SECRET_SENTINEL,
        }],
      },
      exposure: { settings: { enabled: true, hasApiKey: true } },
    }, {
      id: "llama",
      clients: {
        clients: [{
          id: "llama-public-client",
          name: "llama 公网客户端",
          enabled: true,
          keyPreview: "sk-…c3d4",
          keyHash: KEY_HASH_SENTINEL,
          apiKey: API_SECRET_SENTINEL,
        }],
      },
      exposure: { settings: { enabled: true, hasApiKey: true } },
    }],
    keyHash: KEY_HASH_SENTINEL,
    secret: API_SECRET_SENTINEL,
  };
}

function usageSummaryPayload(url) {
  const groupBy = String(url.searchParams.get("groupBy") || "").split(",").filter(Boolean);
  scenario.summaryRequests.push({ groupBy: groupBy.join(","), tzOffsetMinutes: url.searchParams.get("tzOffsetMinutes") });
  const rows = groupBy.join(",") === "day" ? scenario.dailySummary : scenario.usageSummary;
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
      estimatedUsageRequests: Number(sum("estimatedUsageRequests")),
      shadowRequests: Number(sum("shadowRequests")),
    },
    truncated: false,
  };
}

async function handleApi(req, res, url) {
  if (scenario.failAll) {
    sendJson(res, 503, { ok: false, code: "mock_unavailable", message: "MOCK 计费后端暂不可用" });
    return;
  }

  const method = String(req.method || "GET").toUpperCase();
  const body = method === "GET" ? null : await readJson(req);
  scenario.requests.push({ method, path: url.pathname, body, csrf: req.headers["x-csrf-token"] || null });

  if (method === "GET" && url.pathname === "/api/status") return sendJson(res, 200, statusPayload());
  if (method === "GET" && url.pathname === "/api/billing/overview") return sendJson(res, 200, nextOverview());
  if (method === "GET" && url.pathname === "/api/billing/customers") return sendJson(res, 200, { ok: true, items: scenario.customers });
  if (method === "GET" && url.pathname === "/api/billing/plans") return sendJson(res, 200, { ok: true, items: scenario.plans });
  if (method === "GET" && url.pathname === "/api/billing/credentials") return sendJson(res, 200, { ok: true, items: scenario.credentials });
  if (method === "GET" && url.pathname === "/api/billing/prices") return sendJson(res, 200, { ok: true, items: scenario.prices });
  if (method === "GET" && url.pathname === "/api/billing/usage") return sendJson(res, 200, { ok: true, items: scenario.usage });
  if (method === "GET" && url.pathname === "/api/billing/usage/summary") return sendJson(res, 200, usageSummaryPayload(url));
  if (method === "GET" && url.pathname === "/api/billing/ledger") return sendJson(res, 200, { ok: true, items: scenario.ledger });
  if (method === "GET" && url.pathname === "/api/billing/audit-events") return sendJson(res, 200, { ok: true, items: scenario.auditEvents });
  if (method === "GET" && url.pathname === "/api/billing/templates") {
    return sendJson(res, 200, { ok: true, catalogVersion: CATALOG_VERSION, items: scenario.templates });
  }

  return sendJson(res, 404, { ok: false, code: "mock_unhandled_route", message: `${method} ${url.pathname} was not mocked` });
}

function startHarness() {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname === BILLING_PATH || url.pathname === `${BILLING_PATH}/`) {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(html),
            "cache-control": "no-store",
          });
          res.end(html);
          return;
        }
        if (url.pathname === "/favicon.ico") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (url.pathname === "/api/session") {
          scenario.sessionReads += 1;
          sendJson(res, 200, scenario.session);
          return;
        }
        if (url.pathname === "/api/status" || url.pathname.startsWith("/api/billing")) {
          await handleApi(req, res, url);
          return;
        }
        sendJson(res, 404, { ok: false, message: "not found" });
      } catch (error) {
        sendJson(res, 500, { ok: false, message: error.message });
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

function stopHarness() {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

// WCAG contrast ratio of a node's text colour on its own background (CON-22: contrast, not colour pins).
async function textContrast(locator) {
  return locator.evaluate((node) => {
    const channels = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = (rgb) => channels(rgb).map((value) => value / 255).map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    // The first mostly opaque background at or above the node (a highlighted link sits on its sidebar).
    let surface = node;
    const alpha = (rgb) => (rgb.match(/[\d.]+/g).length > 3 ? Number(rgb.match(/[\d.]+/g)[3]) : 1);
    while (surface.parentElement && (getComputedStyle(surface).backgroundColor === 'transparent' || alpha(getComputedStyle(surface).backgroundColor) < 0.5)) surface = surface.parentElement;
    const values = [luminance(getComputedStyle(node).color), luminance(getComputedStyle(surface).backgroundColor)].sort((a, b) => a - b);
    return (values[1] + 0.05) / (values[0] + 0.05);
  });
}

function attachDiagnostics(page) {
  const diagnostics = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  diagnosticsByPage.set(page, diagnostics);
}

async function loadBilling(page) {
  await page.goto(`${baseUrl}${BILLING_PATH}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#billingApiState")).toHaveText("仅本机管理 · API 正常");
  await expect(page.locator("#billingWorkbench")).toHaveAttribute("aria-busy", "false");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  html = await fs.readFile(BILLING_HTML, "utf8");
  await startHarness();
});

test.afterAll(async () => {
  await stopHarness();
});

test.beforeEach(async ({ page }) => {
  scenario = freshScenario();
  await page.addInitScript((fixedNow) => {
    const fixedNowMs = new Date(fixedNow).getTime();
    Date.now = () => fixedNowMs;
  }, FIXED_NOW);
  attachDiagnostics(page);
});

test.afterEach(async ({ page }) => {
  await page.waitForTimeout(50);
  const diagnostics = diagnosticsByPage.get(page);
  expect(diagnostics.pageErrors, "billing page emitted pageerror events").toEqual([]);
  expect(diagnostics.consoleErrors, "billing page emitted console errors").toEqual([]);
});

test("standalone page exposes five tabs and renders hostile API text without secrets or XSS", async ({ page }) => {
  await loadBilling(page);

  const managerNav = page.locator(".manager-nav");
  await expect(managerNav.getByRole("link")).toHaveCount(10);
  await expect(managerNav.getByRole("link", { name: "计费", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#billingManagerName")).toHaveText("llama.cpp Manager");
  await expect(page.locator("#billingManagerReturn")).toHaveAttribute("href", "http://127.0.0.1:5178/#service");
  await page.locator("#billingThemeMode").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await textContrast(page.locator(".manager-sidebar a[aria-current='page']")), "sidebar current link stays readable").toBeGreaterThanOrEqual(3);
  const primaryContrast = await page.locator("#billingRefreshBtn").evaluate((node) => {
    const style = getComputedStyle(node);
    const luminance = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
    return (values[1] + 0.05) / (values[0] + 0.05);
  });
  expect(primaryContrast, "primary action text should remain readable after theme changes").toBeGreaterThanOrEqual(4.5);

  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(5);
  const expectedTabs = ["总览", "客户与凭证", "套餐与价格", "用量与账本", "操作审计"];
  await expect(tabs).toHaveText(expectedTabs);
  for (const name of expectedTabs) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").filter({ visible: true })).toHaveCount(1);
  }

  const overviewTab = page.getByRole("tab", { name: "总览", exact: true });
  const pricesTab = page.getByRole("tab", { name: "套餐与价格", exact: true });
  await pricesTab.click();
  expect(await textContrast(pricesTab), "selected tab text is readable").toBeGreaterThanOrEqual(4.5);
  expect(await textContrast(overviewTab), "unselected tab text is readable").toBeGreaterThanOrEqual(3);
  const [selectedColor, unselectedColor] = await Promise.all([pricesTab, overviewTab].map((tab) => tab.evaluate((node) => getComputedStyle(node).color)));
  expect(selectedColor, "selected and unselected tabs differ").not.toBe(unselectedColor);
  const selectedTabStyle = await pricesTab.evaluate((node) => getComputedStyle(node).boxShadow);
  expect(selectedTabStyle, "selected tab keeps a visible inset indicator").toContain("inset");
  await expect(pricesTab).not.toHaveCSS("transition-property", /(^|, )(?:all|color|border|border-color|border-bottom-color)(, |$)/);

  await page.getByRole("tab", { name: "总览", exact: true }).click();
  // The usage API returns raw request rows, so the overview must not claim a monthly aggregate.
  await expect(page.locator("#overviewUsageHeading")).toHaveText("最近请求（原始记录，最多 100 条）");
  await expect(page.locator("table:has(#overviewUsageRows) thead th")).toHaveText(["时间", "客户", "管理器", "模型", "Tokens", "状态"]);
  await expect(page.locator("#overviewUsageRows")).toContainText("local/base-7b");
  await expect(page.locator("#overviewUsageRows")).toContainText("完成 · 200");
  await expect(page.locator("#overviewCustomerRows")).toContainText("XSS_SENTINEL");
  await expect(page.locator("#overviewCustomerRows img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__billingXss)).toBeUndefined();

  const allText = await page.locator("body").textContent();
  expect(allText).not.toContain(API_SECRET_SENTINEL);
  expect(allText).not.toContain(KEY_HASH_SENTINEL);
  expect(allText).not.toContain(AUDIT_SECRET_SENTINEL);
  await expect(page.locator("#billingAuditRows")).toContainText("[已脱敏]");
});

test("manager sidebars link to the local billing center and billing preserves the vLLM return context", async ({ page }) => {
  const [llamaIndex, vllmIndex] = await Promise.all([
    fs.readFile(LLAMA_INDEX_HTML, "utf8"),
    fs.readFile(VLLM_INDEX_HTML, "utf8"),
  ]);
  const llamaTag = llamaIndex.match(/<a[^>]+data-nav="billing"[^>]*>/)?.[0] || "";
  const vllmTag = vllmIndex.match(/<a[^>]+data-nav="billing"[^>]*>/)?.[0] || "";
  expect(llamaTag).toContain('href="http://127.0.0.1:5176/billing?manager=llama"');
  expect(vllmTag).toContain('href="http://127.0.0.1:5176/billing?manager=vllm"');
  for (const tag of [llamaTag, vllmTag]) {
    expect(tag).not.toContain("target=");
    expect(tag).toContain('rel="noopener noreferrer"');
    expect(tag).not.toContain("data-view=");
  }

  await page.goto(`${baseUrl}${BILLING_PATH}?manager=vllm`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#billingApiState")).toHaveText("仅本机管理 · API 正常");
  await expect(page.locator("#billingManagerName")).toHaveText("vLLM Manager");
  await expect(page.locator("#billingManagerContext")).toHaveText("vLLM · 5177");
  await expect(page.locator("#billingManagerReturn")).toHaveAttribute("href", "http://127.0.0.1:5177/#service");
  await expect(page.locator('[data-manager-view="stats"]')).toHaveAttribute("href", "http://127.0.0.1:5177/#stats");

  await page.locator("#billingThemeMode").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // Colours animate on a theme change, so the ratio is polled until the transition has settled.
  await expect.poll(() => textContrast(page.locator("#billingRefreshBtn")), { message: "dark primary action stays readable" }).toBeGreaterThanOrEqual(4.5);
  await expect.poll(() => textContrast(page.locator(".manager-sidebar a[aria-current='page']")), { message: "dark sidebar current link stays readable" }).toBeGreaterThanOrEqual(3);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#billingThemeMode")).toHaveValue("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("complete API outage has an explicit error state and recovers through refresh", async ({ page }) => {
  scenario.failAll = true;
  await page.goto(`${baseUrl}${BILLING_PATH}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#billingApiState")).toHaveText("计费接口不可用");
  await expect(page.locator("#billingNotice")).toBeVisible();
  await expect(page.locator("#billingNotice")).toContainText("后端接口尚未响应");
  await expect(page.locator("#billingWorkbench")).toHaveAttribute("aria-busy", "false");

  const diagnostics = diagnosticsByPage.get(page);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.consoleErrors.length).toBeGreaterThanOrEqual(10);
  expect(diagnostics.consoleErrors.every((message) => message.includes("503"))).toBe(true);
  // Resource errors are expected for the deliberate outage. The common
  // afterEach assertion remains strict for the recovery phase.
  diagnostics.consoleErrors.length = 0;

  scenario.failAll = false;
  await page.locator("#billingRefreshBtn").click();
  await expect(page.locator("#billingApiState")).toHaveText("仅本机管理 · API 正常");
  await expect(page.locator("#billingNotice")).toBeHidden();
});

test("embed mode hides the copied sidebar and theme select and follows ?theme= without storing it", async ({ page }) => {
  await page.goto(`${baseUrl}${BILLING_PATH}?embed=1&theme=dark`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#billingApiState")).toHaveText("仅本机管理 · API 正常");
  await expect(page.locator("html")).toHaveAttribute("data-embed", "1");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".manager-sidebar")).toBeHidden();
  await expect(page.locator("#billingThemeMode")).toBeHidden();
  // The manager refuses to be framed, so the return link leaves the iframe.
  await expect(page.locator("#billingManagerReturn")).toHaveAttribute("target", "_top");
  await expect(page.getByRole("tab")).toHaveCount(5);
  // The workbench takes the full width once the sidebar column is gone.
  const widths = await page.evaluate(() => ({
    main: document.querySelector(".billing-shell-main").getBoundingClientRect().width,
    viewport: document.documentElement.clientWidth,
  }));
  expect(widths.main).toBeGreaterThanOrEqual(widths.viewport - 1);
  expect(await page.evaluate(() => localStorage.getItem("billingThemeMode"))).toBeNull();

  // The console reloads the frame with the new theme.
  await page.goto(`${baseUrl}${BILLING_PATH}?embed=1&theme=light`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.goto(`${baseUrl}${BILLING_PATH}?embed=1`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);

  // Standalone, the page keeps its sidebar, its select and its own memory.
  await page.goto(`${baseUrl}${BILLING_PATH}?theme=dark`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).not.toHaveAttribute("data-embed", /.+/);
  await expect(page.locator(".manager-sidebar")).toBeVisible();
  await expect(page.locator("#billingThemeMode")).toHaveValue("dark");
  expect(await page.evaluate(() => localStorage.getItem("billingThemeMode"))).toBe("dark");
});
