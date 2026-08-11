const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const {
  CATALOG_VERSION,
  PRICE_TEMPLATE_CATALOG,
  previewPriceTemplateApplications,
} = require("../service-entry/lib/billing-price-templates");

const ROOT = path.resolve(__dirname, "..");
const BILLING_HTML = path.join(ROOT, "service-entry", "billing.html");
const LLAMA_INDEX_HTML = path.join(ROOT, "llama-manager", "public", "index.html");
const VLLM_INDEX_HTML = path.join(ROOT, "vllm-manager", "public", "index.html");
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_PLAN_ID = "44444444-4444-4444-8444-444444444444";
const XSS_SENTINEL = '<img src=x onerror="window.__billingXss=1">XSS_SENTINEL';
const API_SECRET_SENTINEL = "sk-API_SECRET_SENTINEL";
const KEY_HASH_SENTINEL = "HASH_SENTINEL_SHOULD_NOT_RENDER";
const AUDIT_SECRET_SENTINEL = "AUDIT_SECRET_SENTINEL";
const FIXED_NOW = "2026-08-11T02:00:00.000Z";

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

function previewTemplates(body) {
  return previewPriceTemplateApplications(body, { clock: () => new Date(FIXED_NOW) });
}

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

async function handleApi(req, res, url) {
  if (scenario.failAll) {
    sendJson(res, 503, { ok: false, code: "mock_unavailable", message: "MOCK 计费后端暂不可用" });
    return;
  }

  const method = String(req.method || "GET").toUpperCase();
  const body = method === "GET" ? null : await readJson(req);
  scenario.requests.push({ method, path: url.pathname, body });

  if (method === "GET" && url.pathname === "/api/status") return sendJson(res, 200, statusPayload());
  if (method === "GET" && url.pathname === "/api/billing/overview") return sendJson(res, 200, nextOverview());
  if (method === "GET" && url.pathname === "/api/billing/customers") return sendJson(res, 200, { ok: true, items: scenario.customers });
  if (method === "GET" && url.pathname === "/api/billing/plans") return sendJson(res, 200, { ok: true, items: scenario.plans });
  if (method === "GET" && url.pathname === "/api/billing/credentials") return sendJson(res, 200, { ok: true, items: scenario.credentials });
  if (method === "GET" && url.pathname === "/api/billing/prices") return sendJson(res, 200, { ok: true, items: scenario.prices });
  if (method === "GET" && url.pathname === "/api/billing/usage") return sendJson(res, 200, { ok: true, items: scenario.usage });
  if (method === "GET" && url.pathname === "/api/billing/ledger") return sendJson(res, 200, { ok: true, items: scenario.ledger });
  if (method === "GET" && url.pathname === "/api/billing/audit-events") return sendJson(res, 200, { ok: true, items: scenario.auditEvents });
  if (method === "GET" && url.pathname === "/api/billing/templates") {
    return sendJson(res, 200, { ok: true, catalogVersion: CATALOG_VERSION, items: scenario.templates });
  }

  if (method === "POST" && url.pathname === "/api/billing/customers") {
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
    scenario.customers.push(customer);
    return sendJson(res, 201, { ok: true, customer });
  }

  if (method === "POST" && url.pathname === "/api/billing/plans") {
    const plan = {
      planId: CREATED_PLAN_ID,
      code: body.code,
      name: body.name,
      currency: body.currency,
      monthlyPriceMicrocredits: "25000000",
      includedMicrocredits: "100000000",
      monthlyTokenLimit: body.monthlyTokenLimit,
      monthlyRequestLimit: body.monthlyRequestLimit,
      enforcementMode: body.enforcementMode,
      active: true,
      updatedAt: FIXED_NOW,
    };
    scenario.plans.push(plan);
    return sendJson(res, 201, { ok: true, plan });
  }

  if (method === "POST" && url.pathname === "/api/billing/credentials") {
    const binding = {
      bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      customerId: body.customerId,
      managerId: body.managerId,
      serviceClientId: body.serviceClientId,
      label: "已绑定的脱敏客户端",
      active: true,
      updatedAt: FIXED_NOW,
      keyHash: KEY_HASH_SENTINEL,
      apiKey: API_SECRET_SENTINEL,
    };
    scenario.credentials.push(binding);
    return sendJson(res, 201, { ok: true, binding });
  }

  if (method === "POST" && url.pathname === "/api/billing/prices") {
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
    scenario.prices.push(price);
    return sendJson(res, 201, { ok: true, price });
  }

  if (method === "POST" && url.pathname === "/api/billing/ledger/adjustments") {
    const negative = String(body.amountCredits).startsWith("-");
    const [whole, fraction = ""] = String(body.amountCredits).replace(/^-/, "").split(".");
    const deltaMicrocredits = (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"))).toString();
    const entry = {
      entryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      at: FIXED_NOW,
      customerId: body.customerId,
      entryType: "manual_adjustment",
      deltaMicrocredits: negative ? `-${deltaMicrocredits}` : deltaMicrocredits,
      requestId: null,
      idempotencyKey: body.idempotencyKey,
      reason: body.reason,
      actorId: "local-admin",
    };
    scenario.ledger.unshift(entry);
    return sendJson(res, 201, { ok: true, entry });
  }

  const policyMatch = url.pathname.match(/^\/api\/billing\/customers\/([^/]+)\/policy$/);
  const customerMatch = url.pathname.match(/^\/api\/billing\/customers\/([^/]+)$/);
  const planMatch = url.pathname.match(/^\/api\/billing\/plans\/([^/]+)$/);
  if (method === "PATCH" && policyMatch) {
    const customer = scenario.customers.find((item) => item.customerId === decodeURIComponent(policyMatch[1]));
    if (customer) Object.assign(customer, body, { updatedAt: FIXED_NOW });
    return sendJson(res, customer ? 200 : 404, customer ? { ok: true, customer } : { ok: false, message: "not found" });
  }
  if (method === "PATCH" && customerMatch) {
    const customer = scenario.customers.find((item) => item.customerId === decodeURIComponent(customerMatch[1]));
    if (customer) Object.assign(customer, body, { updatedAt: FIXED_NOW });
    return sendJson(res, customer ? 200 : 404, customer ? { ok: true, customer } : { ok: false, message: "not found" });
  }
  if (method === "PATCH" && planMatch) {
    const plan = scenario.plans.find((item) => item.planId === decodeURIComponent(planMatch[1]));
    if (plan) Object.assign(plan, body, { updatedAt: FIXED_NOW });
    return sendJson(res, plan ? 200 : 404, plan ? { ok: true, plan } : { ok: false, message: "not found" });
  }

  if (method === "POST" && url.pathname === "/api/billing/templates/preview") {
    try {
      return sendJson(res, 200, { ok: true, ...previewTemplates(body) });
    } catch (error) {
      return sendJson(res, error.status || 400, { ok: false, code: error.code || "mock_preview_error", message: error.message });
    }
  }

  if (method === "POST" && url.pathname === "/api/billing/templates/apply") {
    try {
      const preview = previewTemplates(body);
      const prices = preview.items.map(appliedPrice);
      scenario.prices.unshift(...prices);
      return sendJson(res, 200, { ok: true, catalogVersion: CATALOG_VERSION, appliedAt: FIXED_NOW, items: prices });
    } catch (error) {
      return sendJson(res, error.status || 400, { ok: false, code: error.code || "mock_apply_error", message: error.message });
    }
  }

  return sendJson(res, 404, { ok: false, code: "mock_unhandled_route", message: `${method} ${url.pathname} was not mocked` });
}

function startHarness() {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname === "/billing" || url.pathname === "/billing/") {
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

function attachDiagnostics(page) {
  const diagnostics = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  diagnosticsByPage.set(page, diagnostics);
}

async function loadBilling(page) {
  await page.goto(`${baseUrl}/billing/`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#billingApiState")).toHaveText("仅本机管理 · API 正常");
  await expect(page.locator("#billingWorkbench")).toHaveAttribute("aria-busy", "false");
}

async function openDetails(page, selector) {
  const opened = await page.locator(selector).evaluate((node) => {
    const details = node.matches("details") ? node : node.closest("details");
    if (!details) return false;
    details.open = true;
    return true;
  });
  expect(opened, `${selector} is not inside a details editor`).toBe(true);
}

function requestFor(method, requestPath) {
  return scenario.requests.findLast((request) => request.method === method && request.path === requestPath);
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
  await expect(page.locator(".manager-sidebar")).toHaveCSS("background-color", "rgb(16, 24, 32)");
  await expect(page.locator("#billingRefreshBtn")).toHaveCSS("background-color", "rgb(15, 159, 143)");

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
  await expect(pricesTab).toHaveCSS("color", "rgb(23, 32, 42)");
  await expect(pricesTab).toHaveCSS("background-color", "rgb(238, 243, 247)");
  await expect(overviewTab).toHaveCSS("color", "rgb(101, 114, 130)");
  const selectedTabStyle = await pricesTab.evaluate((node) => getComputedStyle(node).boxShadow);
  expect(selectedTabStyle).toContain("rgb(15, 159, 143)");
  await expect(pricesTab).not.toHaveCSS("transition-property", /(^|, )(?:all|color|border|border-color|border-bottom-color)(, |$)/);

  await page.getByRole("tab", { name: "总览", exact: true }).click();
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

  await page.goto(`${baseUrl}/billing/?manager=vllm`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#billingApiState")).toHaveText("仅本机管理 · API 正常");
  await expect(page.locator("#billingManagerName")).toHaveText("vLLM Manager");
  await expect(page.locator("#billingManagerContext")).toHaveText("vLLM · 5177");
  await expect(page.locator("#billingManagerReturn")).toHaveAttribute("href", "http://127.0.0.1:5177/#service");
  await expect(page.locator('[data-manager-view="stats"]')).toHaveAttribute("href", "http://127.0.0.1:5177/#stats");

  await page.locator("#billingThemeMode").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".manager-sidebar")).toHaveCSS("background-color", "rgb(8, 15, 22)");
  await expect(page.locator("#billingRefreshBtn")).toHaveCSS("background-color", "rgb(45, 212, 191)");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#billingThemeMode")).toHaveValue("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("customer, plan, credential, and balance forms issue bounded mutations and refresh the mock state", async ({ page }) => {
  await loadBilling(page);

  const customerForm = page.locator("#billingCustomerForm");
  await customerForm.locator('[name="name"]').fill("新客户 Alpha");
  await customerForm.locator('[name="externalRef"]').fill("CRM-2002");
  await customerForm.locator('[name="planId"]').selectOption(PLAN_ID);
  await customerForm.locator('[name="enforcementMode"]').selectOption("hard");
  await customerForm.locator('[name="creditLimit"]').fill("125.000001");
  await customerForm.locator('[name="monthlyTokenLimit"]').fill("9000000");
  await customerForm.locator('[name="monthlyRequestLimit"]').fill("12000");
  await customerForm.getByRole("button", { name: "创建客户" }).click();
  await expect.poll(() => requestFor("POST", "/api/billing/customers")).toBeTruthy();
  await expect(page.locator("#overviewCustomerRows")).toContainText("新客户 Alpha");
  expect(requestFor("POST", "/api/billing/customers").body).toEqual({
    name: "新客户 Alpha",
    externalRef: "CRM-2002",
    planId: PLAN_ID,
    enforcementMode: "hard",
    creditLimit: "125.000001",
    monthlyTokenLimit: "9000000",
    monthlyRequestLimit: "12000",
  });

  await page.getByRole("tab", { name: "套餐与价格", exact: true }).click();
  await openDetails(page, "#billingPlanForm");
  const planForm = page.locator("#billingPlanForm");
  await planForm.locator('[name="code"]').fill("TEAM");
  await planForm.locator('[name="name"]').fill("团队套餐");
  await planForm.locator('[name="currency"]').fill("USD");
  await planForm.locator('[name="enforcementMode"]').selectOption("hard");
  await planForm.locator('[name="monthlyPrice"]').fill("25");
  await planForm.locator('[name="includedCredits"]').fill("100");
  await planForm.locator('[name="monthlyTokenLimit"]').fill("20000000");
  await planForm.locator('[name="monthlyRequestLimit"]').fill("30000");
  await planForm.getByRole("button", { name: "创建套餐" }).click();
  await expect.poll(() => requestFor("POST", "/api/billing/plans")).toBeTruthy();
  await expect(page.locator("#billingPlanRows")).toContainText("团队套餐");

  await page.getByRole("tab", { name: "客户与凭证", exact: true }).click();
  await openDetails(page, "#billingCredentialEditor");
  const credentialForm = page.locator("#billingCredentialForm");
  await credentialForm.locator('[name="customerId"]').selectOption(CUSTOMER_ID);
  await credentialForm.locator('[name="managerId"]').selectOption("vllm-manager");
  await expect(credentialForm.locator('[name="serviceClientId"]')).toBeEnabled();
  await credentialForm.locator('[name="serviceClientId"]').selectOption("vllm-public-client");
  await credentialForm.getByRole("button", { name: "保存绑定" }).click();
  await expect.poll(() => requestFor("POST", "/api/billing/credentials")).toBeTruthy();
  await expect(page.locator("#billingCredentialRows")).toContainText("vllm-public-client");
  expect(requestFor("POST", "/api/billing/credentials").body).toEqual({
    customerId: CUSTOMER_ID,
    managerId: "vllm-manager",
    serviceClientId: "vllm-public-client",
  });

  const adjustmentForm = page.locator("#billingAdjustmentForm");
  await adjustmentForm.locator('[name="customerId"]').selectOption(CUSTOMER_ID);
  await adjustmentForm.locator('[name="amountCredits"]').fill("-10.500001");
  await adjustmentForm.locator('[name="reason"]').fill("退款差额调整");
  await adjustmentForm.getByRole("button", { name: "提交调整" }).click();
  await expect.poll(() => requestFor("POST", "/api/billing/ledger/adjustments")).toBeTruthy();
  const adjustment = requestFor("POST", "/api/billing/ledger/adjustments").body;
  expect(adjustment.customerId).toBe(CUSTOMER_ID);
  expect(adjustment.amountCredits).toBe("-10.500001");
  expect(adjustment.reason).toBe("退款差额调整");
  expect(adjustment.idempotencyKey).toMatch(/^manual-[a-f0-9-]+$/i);
  await page.getByRole("tab", { name: "用量与账本", exact: true }).click();
  await expect(page.locator("#billingLedgerRows")).toContainText("退款差额调整");
  await expect(page.locator("#billingLedgerRows")).toContainText("-10.500001 积分");
});

test("template filters, future-date guard, exact multiplier preview, mapping, and confirmed apply work end to end", async ({ page }) => {
  await loadBilling(page);
  await page.getByRole("tab", { name: "套餐与价格", exact: true }).click();

  const future = PRICE_TEMPLATE_CATALOG.find((template) => template.effectiveFrom && Date.parse(template.effectiveFrom) > Date.parse(FIXED_NOW));
  expect(future, "catalog fixture needs a future effectiveFrom template").toBeTruthy();
  const futureButton = page.locator(`[data-template-id="${future.id}"]`);
  await expect(futureButton).toBeDisabled();
  await expect(futureButton).toHaveAttribute("title", "未生效");

  await page.locator('[data-template-provider="Anthropic"]').click();
  await expect(page.locator("#billingTemplateRows")).toContainText("Claude Opus 5");
  await expect(page.locator("#billingTemplateRows")).not.toContainText("GPT-5.6 Terra");
  await page.locator('[data-template-provider=""]').click();
  await page.locator("#templateSearch").fill("GPT-5.6 Terra");

  const templateId = "openai:gpt-5.6-terra:standard:le-272k";
  await page.locator(`[data-template-id="${templateId}"]`).click();
  const form = page.locator("#billingTemplateApplyForm");
  await form.locator('[name="managerId"]').selectOption("llama-manager");
  await form.locator('[name="planId"]').selectOption(PLAN_ID);
  await form.locator('[name="modelPattern"]').fill("local/qwen3-terra-*");
  await form.locator('[name="creditsPerUsd"]').fill("1.234567");
  await form.locator('[name="markupBps"]').fill("12345");
  await form.getByRole("button", { name: "预览变更" }).click();

  await expect.poll(() => requestFor("POST", "/api/billing/templates/preview")).toBeTruthy();
  const previewRequest = requestFor("POST", "/api/billing/templates/preview");
  expect(previewRequest.body).toEqual({
    items: [{
      templateId,
      managerId: "llama-manager",
      modelPattern: "local/qwen3-terra-*",
      planId: PLAN_ID,
    }],
    creditsPerUsd: "1.234567",
    markupBps: "12345",
  });
  const expectedPreview = previewTemplates(previewRequest.body).items[0];
  const previewText = (await page.locator("#templatePreviewBox").innerText()).replace(/[\s,]/g, "");
  expect(previewText).toContain(expectedPreview.inputPerMillionMicrocredits);
  expect(previewText).toContain(expectedPreview.cachedInputPerMillionMicrocredits);
  expect(previewText).toContain(expectedPreview.outputPerMillionMicrocredits);
  await expect(page.locator("#templateApplyConfirmBtn")).toBeEnabled();

  // Any mapping/rate change invalidates the signed preview until previewed again.
  await form.locator('[name="modelPattern"]').fill("local/qwen3-terra-changed-*");
  await expect(page.locator("#templateApplyConfirmBtn")).toBeDisabled();
  await form.locator('[name="modelPattern"]').fill("local/qwen3-terra-*");
  await form.getByRole("button", { name: "预览变更" }).click();
  await expect(page.locator("#templateApplyConfirmBtn")).toBeEnabled();

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#templateApplyConfirmBtn").click();
  await expect.poll(() => requestFor("POST", "/api/billing/templates/apply")).toBeTruthy();
  expect(requestFor("POST", "/api/billing/templates/apply").body).toEqual(previewRequest.body);
  await expect(page.locator("#billingPriceRows")).toContainText("local/qwen3-terra-*");
  await expect(page.locator("#billingPriceRows")).toContainText(templateId);
});

test("complete API outage has an explicit error state and recovers through refresh", async ({ page }) => {
  scenario.failAll = true;
  await page.goto(`${baseUrl}/billing/`, { waitUntil: "domcontentloaded" });
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

test("390px viewport has no page-level horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadBilling(page);
  await page.getByRole("tab", { name: "套餐与价格", exact: true }).click();

  const dimensions = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    managerNav: document.querySelector(".manager-nav")?.getBoundingClientRect().toJSON(),
    activeBilling: document.querySelector(".manager-nav a.active")?.getBoundingClientRect().toJSON(),
  }));
  expect(dimensions.innerWidth).toBe(390);
  expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  expect(dimensions.bodyScrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  expect(dimensions.activeBilling.left).toBeGreaterThanOrEqual(dimensions.managerNav.left - 1);
  expect(dimensions.activeBilling.right).toBeLessThanOrEqual(dimensions.managerNav.right + 1);
  await expect(page.locator("#billingTemplateRows")).toBeVisible();
});
