// Public portal browser checks (05 §17.4, PUB-15: shell, status, models,
// announcements). The real createPublicServer runs on an ephemeral loopback
// port with the real portal files, the real VENDOR.json tree and tokens.css,
// and stubbed data: /status.json, /catalog.json, /announcements.json,
// /portal-config.json and a fake /v1/models. Nothing here reaches a platform
// service, and the only key is an obviously fake one.
const { test, expect } = require("@playwright/test");
const crypto = require("node:crypto");
const http = require("node:http");
const { loadEntry } = require("../service-entry/test/helpers/entry-harness");
const { createPortalRoutes } = require("../service-entry/lib/portal-routes");
const { collectFailures, expectNoOverflow } = require("./frontend/helpers/console-harness");
const { expectNoA11yViolations } = require("./frontend/helpers/axe");

const BUILD_ID = "pubtest00001";
const FAKE_KEY = "sk-test-fake0001";
const LONG_ID = "example-org/a-very-long-model-name-with-quantization-nvfp4-and-262144-context-experimental-build";

// The build id the portal routes see; the stale-build test moves it.
const build = { hash: BUILD_ID };
const state = { status: null, catalog: null, announcements: null, keyModels: null, requests: [], failStatus: false };

function overall(kind, extra = {}) {
  const messages = {
    operational: { "zh-CN": "服务正常", "en-US": "All systems operational" },
    degraded: { "zh-CN": "部分服务降级", "en-US": "Some systems are degraded" },
    offline: { "zh-CN": "主机离线", "en-US": "The host is offline" },
    maintenance: { "zh-CN": "维护中", "en-US": "Scheduled maintenance" },
  };
  const now = Date.now();
  const hours = Array.from({ length: 168 }, (_, index) => ({ hour: new Date(now - (167 - index) * 3600_000).toISOString(), up: index < 20 ? null : index % 41 === 0 ? 0 : 1 }));
  return {
    schemaVersion: 1,
    status: kind,
    updated_at: new Date(now - 20_000).toISOString(),
    message: messages[kind],
    models: [
      { id: "qwen3.8-35b-a3b", display_name: "Qwen3.8 35B A3B", state: kind === "offline" ? "offline" : "ready", queue: "light", ttft_p50_ms: 350, tokens_per_second: 85 },
      { id: "qwen3.8-flash", display_name: "qwen3.8-flash", state: kind === "degraded" ? "loading" : kind === "offline" ? "offline" : "ready", queue: "idle" },
      { id: LONG_ID, display_name: LONG_ID, state: "ready", queue: "busy", ttft_p50_ms: 1200, tokens_per_second: 40 },
    ],
    uptime: { h24: 99.3, d7: 97.1, hours_7d: hours },
    announcements: [],
    ...extra,
  };
}

const CATALOG = {
  schemaVersion: 1,
  updated_at: new Date().toISOString(),
  models: [
    {
      id: "qwen3.8-35b-a3b", display_name: { "zh-CN": "通义 3.8 35B", "en-US": "Qwen3.8 35B A3B" },
      description: { "zh-CN": "通用对话与推理模型", "en-US": "General chat and reasoning model" },
      family: "qwen3.8", parameters: "35B", quantization: "FP8", modalities: ["text", "vision"], tools: true, reasoning: true,
      context: 262144, max_output: 8192, limits: { rpm: 30, tpm: 100000, concurrency: 2, max_output_tokens: 8192 },
      recommended: true, aliases: ["qwen3.8"], state: "ready", prices: { unit: "credits_per_million_tokens", input: "0.50", cached_input: "0.05", output: "2.00" },
    },
    {
      id: "qwen3.8-flash", display_name: { "zh-CN": "通义 3.8 极速", "en-US": "Qwen3.8 Flash" },
      description: { "zh-CN": "", "en-US": "" },
      family: "qwen3.8", parameters: "8B", quantization: "AWQ", modalities: ["text"], tools: true, reasoning: false,
      context: 131072, max_output: 4096, limits: { rpm: 60, tpm: 200000, concurrency: 4, max_output_tokens: 4096 },
      recommended: false, aliases: [], state: "ready",
    },
    {
      id: LONG_ID, display_name: { "zh-CN": LONG_ID, "en-US": LONG_ID },
      description: { "zh-CN": "", "en-US": "" },
      family: "example", parameters: "70B", quantization: "NVFP4", modalities: ["text"], tools: false, reasoning: false,
      context: 262144, max_output: 8192, limits: { rpm: 10, tpm: 50000, concurrency: 1, max_output_tokens: 8192 },
      recommended: false, aliases: [], state: "loading",
    },
  ],
};

const ANNOUNCEMENTS = {
  schemaVersion: 1,
  updated_at: new Date().toISOString(),
  announcements: [
    { id: "an_maint", severity: "maintenance", title: { "zh-CN": "周日凌晨维护", "en-US": "Sunday early-morning maintenance" }, body: { "zh-CN": "维护期间服务可能中断。", "en-US": "The service may be interrupted." }, starts_at: new Date(Date.now() - 3600_000).toISOString(), ends_at: new Date(Date.now() + 3600_000).toISOString(), active: true },
    { id: "an_next", severity: "info", title: { "zh-CN": "新模型即将上线", "en-US": "A new model is coming" }, body: { "zh-CN": "下周开放。", "en-US": "Next week." }, starts_at: new Date(Date.now() + 86400_000).toISOString(), ends_at: null, active: false },
  ],
};

const KEY_MODELS = {
  object: "list",
  data: [
    {
      id: "qwen3.8-35b-a3b", object: "model", owned_by: "local", display_name: "Qwen3.8 35B A3B", aliases: ["qwen3.8"], family: "qwen3.8", parameters: "35B", quantization: "fp8",
      context_length: 262144, max_output_tokens: 4096,
      capabilities: { chat: true, completions: true, responses: true, messages: true, embeddings: false, vision: true, tools: true, reasoning: true, audio_speech: false },
      state: "ready", pricing: { unit: "credits_per_million_tokens", input: "0.25", cached_input: "0.02", output: "1.00" }, limits: { rpm: 12, tpm: 40000, max_output_tokens: 4096 },
    },
  ],
};

let entry;
let server;
let baseUrl;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

test.beforeAll(async () => {
  entry = (await loadEntry()).entry;
  const portal = createPortalRoutes({ getBuildId: () => ({ commit: "0123456789abcdef", contentHash: build.hash }), logger: { warn() {}, log() {}, error() {} } });
  const data = {
    async respond(pathname, req) {
      state.requests.push({ path: pathname, authorization: req.headers.authorization || "" });
      if (pathname === "/portal-config.json") {
        const base = `http://${req.headers.host}`;
        return {
          baseUrl: base, openaiBase: `${base}/v1`, anthropicBase: `${base}/anthropic`,
          brand: { "zh-CN": "本地模型服务", "en-US": "Local Model Service" }, buildId: BUILD_ID, commit: "0123456789ab",
          features: { playground: true, showPrices: true, tts: true },
        };
      }
      if (pathname === "/status.json") {
        if (state.failStatus) throw new Error("status unavailable");
        return state.status;
      }
      if (pathname === "/catalog.json") return state.catalog;
      if (pathname === "/announcements.json") return state.announcements;
      return null;
    },
  };
  const gateway = (req, res, url) => {
    state.requests.push({ path: `${url.pathname}${url.search}`, authorization: req.headers.authorization || "" });
    if (url.pathname !== "/v1/models") return sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error", code: "not_found", param: null } });
    if (req.headers.authorization === "Bearer sk-test-down") {
      return sendJson(res, 503, { error: { message: "down", type: "server_error", code: "service_unavailable", param: null }, request_id: "req_down" });
    }
    if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) {
      return sendJson(res, 401, { error: { message: "invalid", type: "authentication_error", code: "invalid_api_key", param: null }, request_id: "req_test" });
    }
    return sendJson(res, 200, state.keyModels);
  };
  // The limiter is covered by limiter-gateway.test.js; one server serves the whole spec from 127.0.0.1 and would exhaust the per-IP burst.
  server = entry.createPublicServer({ portal, data, gateway, preAuth: null, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => {
    server?.closeAllConnections?.();
    server ? server.close(resolve) : resolve();
  });
});

test.beforeEach(() => {
  state.status = overall("operational");
  state.catalog = CATALOG;
  state.announcements = { ...ANNOUNCEMENTS, announcements: [] };
  state.keyModels = KEY_MODELS;
  state.requests = [];
  state.failStatus = false;
});

const goto = (page, route) => page.goto(`${baseUrl}${route}`);

// Han text a reader of the English page would see: text nodes and labels, minus
// code/pre and the elements that carry their own lang (the language names).
async function hanOutsideCode(page) {
  return page.evaluate(() => {
    const han = /[㐀-鿿]/;
    const skip = "code, pre, noscript, [lang=\"zh-CN\"], [lang=\"zh\"]";
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (han.test(node.nodeValue) && !node.parentElement.closest(skip)) found.push(`text: ${node.nodeValue.trim().slice(0, 60)}`);
    }
    for (const element of document.querySelectorAll("[aria-label], [title], [placeholder], [alt]")) {
      if (element.closest(skip)) continue;
      for (const name of ["aria-label", "title", "placeholder", "alt"]) {
        const value = element.getAttribute(name);
        if (value && han.test(value)) found.push(`${name}: ${value.slice(0, 60)}`);
      }
    }
    if (han.test(document.title)) found.push(`title: ${document.title}`);
    return found;
  });
}

test.describe("shell, CSP and assets", () => {
  test("the import map passes only through its hash and nothing else inline runs", async ({ page }) => {
    const failures = await collectFailures(page);
    const response = await goto(page, "/status?lang=en");
    const csp = response.headers()["content-security-policy"];
    const mapText = await page.evaluate(() => document.querySelector('script[type="importmap"]').textContent);
    const hash = crypto.createHash("sha256").update(mapText, "utf8").digest("base64");
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).not.toContain("unsafe");
    await expect(page.locator("h1")).toContainText("All systems operational");
    await failures.expectNone();

    const blocked = await page.evaluate(() => new Promise((resolve) => {
      document.addEventListener("securitypolicyviolation", (event) => resolve(event.violatedDirective), { once: true });
      const script = document.createElement("script");
      script.textContent = "window.__inline = 1";
      document.head.appendChild(script);
      setTimeout(() => resolve("none"), 800);
    }));
    expect(blocked).toContain("script-src");
    expect(await page.evaluate(() => window.__inline)).toBeUndefined();
  });

  test("vendor files and tokens come from the one vendor tree under the build id", async ({ page }) => {
    const urls = [];
    page.on("request", (request) => urls.push(request.url()));
    await goto(page, "/status?lang=en");
    await expect(page.locator("h1")).toBeVisible();
    const assets = urls.filter((url) => url.includes("/assets/"));
    expect(assets.some((url) => new RegExp(`/assets/${BUILD_ID}/vendor/preact/[0-9.]+/preact\\.module\\.js$`).test(url))).toBe(true);
    expect(assets.some((url) => new RegExp(`/assets/${BUILD_ID}/vendor/preact/[0-9.]+/hooks\\.module\\.js$`).test(url))).toBe(true);
    expect(assets.some((url) => new RegExp(`/assets/${BUILD_ID}/vendor/htm/[0-9.]+/htm\\.module\\.js$`).test(url))).toBe(true);
    expect(assets.some((url) => url.endsWith(`/assets/${BUILD_ID}/shared/styles/tokens.css`))).toBe(true);
    expect(assets.some((url) => url.endsWith(`/assets/${BUILD_ID}/styles/portal.css`))).toBe(true);
    // Everything came from this origin: no CDN, no font service.
    expect(urls.filter((url) => !url.startsWith(baseUrl))).toEqual([]);
    const token = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface-1").trim());
    expect(token).not.toBe("");
  });

  test("an old build id answers 410 and a made-up asset path 404", async ({ page }) => {
    const stale = await page.request.get(`${baseUrl}/assets/older000000/app.js`);
    expect(stale.status()).toBe(410);
    expect((await stale.json()).error.code).toBe("portal_stale");
    expect((await page.request.get(`${baseUrl}/assets/${BUILD_ID}/..%2f..%2fserver.js`)).status()).toBe(404);
    expect((await page.request.get(`${baseUrl}/assets/${BUILD_ID}/package.json`)).status()).toBe(404);
    expect((await page.request.get(`${baseUrl}/assets/${BUILD_ID}/app.js`)).status()).toBe(200);
  });

  test("an HTML 404 page is styled and offers a way out", async ({ page }) => {
    // Prime the snapshot so the error page can link the portal stylesheet.
    await goto(page, "/status");
    const response = await page.goto(`${baseUrl}/no-such-page`);
    expect(response.status()).toBe(404);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator('link[rel="stylesheet"][href$="/styles/portal.css"]')).toHaveCount(1);
    await expect(page.locator('a[href="/status"]')).toBeVisible();
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe("rgb(245, 247, 250)");
  });
});

test.describe("status page", () => {
  const CASES = [
    { kind: "operational", zh: "服务正常", en: "All systems operational", badgeZh: "服务正常", badgeEn: "Operational" },
    { kind: "degraded", zh: "部分服务降级", en: "Some systems are degraded", badgeZh: "部分降级", badgeEn: "Degraded" },
    { kind: "offline", zh: "主机离线", en: "The host is offline", badgeZh: "主机离线", badgeEn: "Offline" },
    { kind: "maintenance", zh: "维护中", en: "Scheduled maintenance", badgeZh: "维护中", badgeEn: "Maintenance" },
  ];
  for (const item of CASES) {
    test(`states ${item.kind} in Chinese and English`, async ({ page }) => {
      state.status = overall(item.kind);
      const failures = await collectFailures(page);
      await goto(page, "/status?lang=zh-CN");
      await expect(page.locator("h1")).toHaveText(item.zh);
      await expect(page.locator(".status-hero .badge")).toContainText(item.badgeZh);
      await expect(page.locator(".status-hero")).toHaveAttribute("data-state", item.kind);
      await goto(page, "/status?lang=en");
      await expect(page.locator("h1")).toHaveText(item.en);
      await expect(page.locator(".status-hero .badge")).toContainText(item.badgeEn);
      await failures.expectNone();
    });
  }

  test("shows each model, the uptime bar and the numbers", async ({ page }) => {
    await goto(page, "/status?lang=en");
    const cards = page.locator(".status-model");
    await expect(cards).toHaveCount(3);
    await expect(cards.first()).toContainText("Qwen3.8 35B A3B");
    await expect(cards.first()).toContainText("Ready");
    await expect(cards.first()).toContainText("350 ms");
    await expect(cards.first()).toContainText("85");
    await expect(cards.nth(2)).toContainText("Busy");
    await expect(cards.nth(2)).toContainText("1.2 s");
    await expect(page.locator(".uptime-bar rect")).toHaveCount(168);
    await expect(page.locator(".uptime-bar")).toHaveAttribute("aria-label", /h up.*h down.*h without data/);
    await expect(page.getByText("99.3%")).toBeVisible();
    await expect(page.getByText("97.1%")).toBeVisible();
    await expect(page.getByText(/Updated .*ago|Updated .*seconds? ago|Updated now/)).toBeVisible();
  });

  test("refreshes itself every 30 seconds", async ({ page }) => {
    await page.clock.install();
    // A route handler turns the browser HTTP cache off, which would otherwise answer from real time.
    await page.route("**/status.json", (route) => route.continue());
    await goto(page, "/status?lang=en");
    await expect(page.locator("h1")).toHaveText("All systems operational");
    state.status = overall("degraded");
    await page.clock.runFor(31_000);
    await expect(page.locator("h1")).toHaveText("Some systems are degraded");
  });

  test("a failing status endpoint shows a plain error with a retry, then recovers", async ({ page }) => {
    state.failStatus = true;
    await goto(page, "/status?lang=en");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("unavailable");
    expect(await hanOutsideCode(page)).toEqual([]);
    state.failStatus = false;
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("h1")).toHaveText("All systems operational");
  });

  test("the home page shows the base URLs and the way in", async ({ page }) => {
    await goto(page, "/?lang=en");
    await expect(page.locator(".get-started")).toContainText(`${baseUrl}/v1`);
    await expect(page.locator(".get-started")).toContainText(`${baseUrl}/anthropic`);
    await expect(page.getByRole("link", { name: "Browse models" })).toHaveAttribute("href", "/models");
    await expect(page.locator("footer")).toContainText("0123456789ab");
  });
});

test.describe("models pages", () => {
  test("without a key the page shows the public catalog and no key request is sent", async ({ page }) => {
    await goto(page, "/models?lang=en");
    const cards = page.locator(".model-card");
    await expect(cards).toHaveCount(3);
    await expect(cards.first()).toContainText("Qwen3.8 35B A3B");
    await expect(cards.first()).toContainText("General chat and reasoning model");
    await expect(cards.first()).toContainText("Vision");
    await expect(cards.first()).toContainText("Tool calling");
    await expect(cards.first()).toContainText("Reasoning");
    await expect(cards.first()).toContainText("256K");
    await expect(cards.first()).toContainText("Input 0.50");
    await expect(cards.first().getByRole("link", { name: "Try in playground" })).toHaveAttribute("href", "/playground?model=qwen3.8-35b-a3b");
    await expect(page.getByText("Available to your key")).toHaveCount(0);
    expect(state.requests.some((item) => item.path.startsWith("/v1/"))).toBe(false);
  });

  test("the Chinese page uses the Chinese names and descriptions", async ({ page }) => {
    await goto(page, "/models?lang=zh-CN");
    const first = page.locator(".model-card").first();
    await expect(first).toContainText("通义 3.8 35B");
    await expect(first).toContainText("通用对话与推理模型");
    await expect(first).toContainText("图像理解");
  });

  test("search and capability filters narrow the list", async ({ page }) => {
    await goto(page, "/models?lang=en");
    await page.getByLabel("Search models").fill("flash");
    await expect(page.locator(".model-card")).toHaveCount(1);
    await page.getByLabel("Search models").fill("");
    await page.getByRole("button", { name: "Vision" }).click();
    await expect(page.locator(".model-card")).toHaveCount(1);
    await page.getByRole("button", { name: "Vision" }).click();
    await page.getByRole("button", { name: "Reasoning" }).click();
    await expect(page.locator(".model-card")).toHaveCount(1);
    await page.getByLabel("Search models").fill("zzzz");
    await expect(page.getByText("No models match")).toBeVisible();
  });

  test("with a key in sessionStorage the page marks what the key can use and shows its limits", async ({ page }) => {
    await page.addInitScript((key) => window.sessionStorage.setItem("portal.key", key), FAKE_KEY);
    await goto(page, "/models?lang=en");
    const first = page.locator('.model-card[data-model-id="qwen3.8-35b-a3b"]');
    await expect(first).toContainText("Available to your key");
    await expect(first).toContainText("Your requests/min");
    await expect(first).toContainText("12");
    await expect(first).toContainText("Input 0.25");
    await expect(page.locator('.model-card[data-model-id="qwen3.8-flash"]')).toContainText("Not available to your key");
    await expect(page.getByText("Your key is active")).toBeVisible();
    await page.getByRole("button", { name: "Only mine" }).click();
    await expect(page.locator(".model-card")).toHaveCount(1);
    // The key travels in the Authorization header and nowhere else.
    expect(state.requests.filter((item) => item.authorization).map((item) => item.path)).toEqual(["/v1/models"]);
    expect(state.requests.some((item) => item.path.includes(FAKE_KEY))).toBe(false);
  });

  test("a key the server rejects falls back to the catalog with a note", async ({ page }) => {
    await page.addInitScript(() => window.sessionStorage.setItem("portal.key", "sk-test-wrong"));
    await goto(page, "/models?lang=en");
    await expect(page.getByText("The saved key was not accepted")).toBeVisible();
    await expect(page.locator(".model-card")).toHaveCount(3);
  });

  test("a key that cannot be checked right now is not called wrong", async ({ page }) => {
    await page.addInitScript(() => window.sessionStorage.setItem("portal.key", "sk-test-down"));
    await goto(page, "/models?lang=en");
    await expect(page.getByText("Could not load the models of your key right now")).toBeVisible();
    await expect(page.getByText("was not accepted")).toHaveCount(0);
    await expect(page.locator(".model-card")).toHaveCount(3);
  });

  test("a #key= share link is stored for the session and removed from the address", async ({ page }) => {
    await goto(page, `/models?lang=en#key=${FAKE_KEY}`);
    await expect(page.getByText("Your key is active")).toBeVisible();
    expect(page.url()).not.toContain("key=");
    expect(page.url()).not.toContain(FAKE_KEY);
    expect(await page.evaluate(() => window.sessionStorage.getItem("portal.key"))).toBe(FAKE_KEY);
    expect(await page.evaluate(() => window.localStorage.getItem("portal.key"))).toBeNull();
  });

  test("the model page shows facts, limits, prices and aliases", async ({ page }) => {
    await goto(page, "/models/qwen3.8-35b-a3b?lang=en");
    await expect(page.locator("h1")).toHaveText("Qwen3.8 35B A3B");
    await expect(page.getByText("Default limits")).toBeVisible();
    await expect(page.getByRole("row", { name: /Requests per minute 30/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Cached input 0.05/ })).toBeVisible();
    await expect(page.getByText("Unit: credits per million tokens")).toBeVisible();
    await expect(page.locator(".chips").last()).toContainText("qwen3.8");
    await expect(page.getByRole("link", { name: "Try in playground" })).toHaveAttribute("href", "/playground?model=qwen3.8-35b-a3b");
    // An alias resolves to the same page.
    await goto(page, "/models/qwen3.8?lang=en");
    await expect(page.locator("h1")).toHaveText("Qwen3.8 35B A3B");
    await goto(page, "/models/nothing-here?lang=en");
    await expect(page.getByText("We could not find that model")).toBeVisible();
    // ids that hold a slash travel encoded.
    await goto(page, `/models/${encodeURIComponent(LONG_ID)}?lang=en`);
    await expect(page.locator("h1")).toHaveText(LONG_ID);
  });

  test("the model page shows the key's own limits and prices", async ({ page }) => {
    await page.addInitScript((key) => window.sessionStorage.setItem("portal.key", key), FAKE_KEY);
    await goto(page, "/models/qwen3.8-35b-a3b?lang=en");
    await expect(page.getByText("Limits for your key")).toBeVisible();
    await expect(page.getByRole("row", { name: /Requests per minute 12/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /^Input 0.25/ })).toBeVisible();
  });

  test("clicking a card title navigates without a reload", async ({ page }) => {
    await goto(page, "/models?lang=en");
    await page.evaluate(() => { window.__marker = "same-document"; });
    await page.locator(".model-card").first().getByRole("link", { name: "Qwen3.8 35B A3B" }).click();
    await expect(page).toHaveURL(/\/models\/qwen3\.8-35b-a3b/);
    await expect(page.getByText("Specifications")).toBeVisible();
    expect(await page.evaluate(() => window.__marker)).toBe("same-document");
    await page.goBack();
    await expect(page.locator(".model-card")).toHaveCount(3);
  });
});

test.describe("announcements", () => {
  test("lists active and upcoming announcements and shows a banner on every page", async ({ page }) => {
    state.announcements = ANNOUNCEMENTS;
    await goto(page, "/announcements?lang=en");
    await expect(page.locator("#active-title")).toHaveText("Active now");
    await expect(page.locator("#upcoming-title")).toHaveText("Upcoming");
    await expect(page.locator(".announcement")).toHaveCount(2);
    await expect(page.locator(".announcement").first()).toContainText("Sunday early-morning maintenance");
    await expect(page.locator(".announcement").first()).toContainText("The service may be interrupted.");
    await expect(page.locator(".banner")).toContainText("Sunday early-morning maintenance");
    await goto(page, "/models?lang=en");
    await expect(page.locator(".banner")).toContainText("Sunday early-morning maintenance");
  });

  test("dismissing the banner is remembered per announcement id", async ({ page }) => {
    state.announcements = ANNOUNCEMENTS;
    await goto(page, "/status?lang=en");
    await expect(page.locator(".banner")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss this announcement" }).click();
    await expect(page.locator(".banner")).toHaveCount(0);
    expect(JSON.parse(await page.evaluate(() => window.localStorage.getItem("portal.dismissed")))).toEqual(["an_maint"]);
    await page.reload();
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator(".banner")).toHaveCount(0);
    // The page itself still lists it.
    await goto(page, "/announcements?lang=en");
    await expect(page.locator(".announcement")).toHaveCount(2);
  });

  test("an empty list says so", async ({ page }) => {
    await goto(page, "/announcements?lang=en");
    await expect(page.getByText("There are no announcements right now.")).toBeVisible();
  });
});

test.describe("language", () => {
  test("?lang= wins, the switch stores the choice, and the page follows it", async ({ page }) => {
    await goto(page, "/models?lang=en");
    await expect(page.locator("h1")).toHaveText("Models");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await page.getByRole("button", { name: "中文" }).click();
    await expect(page.locator("h1")).toHaveText("模型");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    expect(await page.evaluate(() => window.localStorage.getItem("portal.lang"))).toBe("zh-CN");
    expect(page.url()).not.toContain("lang=");
    await page.reload();
    await expect(page.locator("h1")).toHaveText("模型");
    await page.getByRole("button", { name: "English" }).click();
    await expect(page.locator("h1")).toHaveText("Models");
    await expect(page).toHaveTitle(/Models · Local Model Service/);
  });

  test("navigator.language decides when nothing else does", async ({ browser }) => {
    const context = await browser.newContext({ locale: "en-GB" });
    const page = await context.newPage();
    await goto(page, "/models");
    await expect(page.locator("h1")).toHaveText("Models");
    await context.close();
  });

  test("English mode shows no Han text outside code and pre", async ({ page }) => {
    state.announcements = ANNOUNCEMENTS;
    state.status = overall("degraded");
    for (const route of ["/", "/status", "/models", "/models/qwen3.8-35b-a3b", "/announcements", "/no-such-client-route"]) {
      await goto(page, `${route}?lang=en`);
      await expect(page.locator("main")).not.toBeEmpty();
      await page.waitForLoadState("networkidle");
      expect(await hanOutsideCode(page), route).toEqual([]);
    }
  });
});

test.describe("layout", () => {
  const ROUTES = ["/", "/status", "/models", "/models/qwen3.8-35b-a3b", `/models/${encodeURIComponent(LONG_ID)}`, "/announcements"];

  for (const lang of ["zh-CN", "en"]) {
    for (const scheme of ["light", "dark"]) {
      test(`no horizontal overflow at 390 px (${lang}, ${scheme})`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
        const page = await context.newPage();
        state.announcements = ANNOUNCEMENTS;
        for (const route of ROUTES) {
          await goto(page, `${route}?lang=${lang}`);
          await expect(page.locator("main")).not.toBeEmpty();
          await page.waitForLoadState("networkidle");
          await expectNoOverflow(page);
        }
        await context.close();
      });
    }
  }

  test("light and dark follow the OS preference through the shared tokens", async ({ browser }) => {
    const light = await browser.newContext({ colorScheme: "light" });
    const dark = await browser.newContext({ colorScheme: "dark" });
    const lightPage = await light.newPage();
    const darkPage = await dark.newPage();
    await goto(lightPage, "/status?lang=en");
    await goto(darkPage, "/status?lang=en");
    expect(await lightPage.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(245, 247, 250)");
    expect(await darkPage.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(11, 17, 24)");
    expect(await darkPage.evaluate(() => getComputedStyle(document.querySelector(".status-hero")).backgroundColor)).toBe("rgb(18, 26, 36)");
    await light.close();
    await dark.close();
  });

  test("the layout is one column below 720 px and wraps to several above", async ({ browser }) => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const wide = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const phonePage = await phone.newPage();
    const widePage = await wide.newPage();
    await goto(phonePage, "/models?lang=en");
    await goto(widePage, "/models?lang=en");
    await expect(phonePage.locator(".model-card")).toHaveCount(3);
    await expect(widePage.locator(".model-card")).toHaveCount(3);
    const columns = (page) => page.evaluate(() => getComputedStyle(document.querySelector(".grid-models")).gridTemplateColumns.split(" ").length);
    expect(await columns(phonePage)).toBe(1);
    expect(await columns(widePage)).toBeGreaterThan(1);
    const gutter = await phonePage.evaluate(() => getComputedStyle(document.querySelector("main")).paddingLeft);
    expect(gutter).toBe("16px");
    await phone.close();
    await wide.close();
  });
});

test.describe("keyboard and accessibility", () => {
  test("the skip link is first, focus rings are visible and every control has a name", async ({ page }) => {
    await goto(page, "/models?lang=en");
    await expect(page.locator(".model-card")).toHaveCount(3);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: /Local Model Service home/ })).toBeFocused();
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    expect(outline).toBe("solid");
    const unnamed = await page.evaluate(() => [...document.querySelectorAll("button, a[href], input, svg[role='img']")]
      .filter((element) => !(element.getAttribute("aria-label") || element.textContent.trim() || element.labels?.length))
      .map((element) => element.outerHTML.slice(0, 80)));
    expect(unnamed).toEqual([]);
  });

  for (const [scheme, lang] of [["light", "en"], ["dark", "zh-CN"]]) {
    test(`axe finds nothing blocking on the status and models pages (${scheme}, ${lang})`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      state.announcements = ANNOUNCEMENTS;
      state.status = overall("degraded");
      for (const route of ["/status", "/models", "/models/qwen3.8-35b-a3b", "/announcements"]) {
        await goto(page, `${route}?lang=${lang}`);
        await expect(page.locator("main")).not.toBeEmpty();
        await page.waitForLoadState("networkidle");
        await expectNoA11yViolations(page, { label: `${route} ${scheme} ${lang}`, route });
      }
      await context.close();
    });
  }
});

// Last on purpose: it moves the build id, which leaves the snapshot on a newer id.
test.describe("stale builds", () => {
  test("a tab on an older build reloads into the new one when it needs a page that is gone", async ({ page }) => {
    await goto(page, "/status?lang=en");
    await expect(page.locator("h1")).toHaveText("All systems operational");
    const first = await page.evaluate(() => document.querySelector("script[type=module]").getAttribute("src"));
    expect(first).toContain(`/assets/${BUILD_ID}/`);
    // Two deploys later the build of this tab is no longer served.
    build.hash = "pubtest00002";
    expect((await page.request.get(`${baseUrl}/status`)).status()).toBe(200);
    expect((await page.request.get(`${baseUrl}/assets/${BUILD_ID}/app.js`)).status()).toBe(200);
    build.hash = "pubtest00003";
    expect((await page.request.get(`${baseUrl}/status`)).status()).toBe(200);
    expect((await page.request.get(`${baseUrl}/assets/${BUILD_ID}/app.js`)).status()).toBe(410);
    // The open tab lazy-loads the models page from the old id, gets 410 and reloads once.
    await page.getByRole("navigation").getByRole("link", { name: "Models" }).click();
    await expect(page).toHaveURL(/\/models/);
    await expect(page.locator(".model-card")).toHaveCount(3);
    const now = await page.evaluate(() => document.querySelector("script[type=module]").getAttribute("src"));
    expect(now).toContain("/assets/pubtest00003/");
    build.hash = BUILD_ID;
  });
});
