// Public portal browser checks (05 §17.4, PUB-15: shell, status, models,
// announcements; PUB-16: docs; PUB-17: My Key and the playground). The real createPublicServer runs on an ephemeral loopback
// port with the real portal files, the real VENDOR.json tree and tokens.css,
// and stubbed data: /status.json, /catalog.json, /announcements.json,
// /portal-config.json, a fake /v1/models, the /v1/me family and a fake SSE
// /v1/chat/completions. Nothing here reaches a platform
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
let state = {
  status: null, catalog: null, announcements: null, keyModels: null, requests: [], failStatus: false,
  // PUB-17: the keys the stub accepts, the /v1/me documents and the fake chat upstream.
  validKeys: new Set(), me: null, usage: null, myRequests: null, csv: "", rotateTo: "", puts: [], posts: [],
  chatMode: "normal", chatBodies: [], chatHeaders: [], chatClosed: 0, release: null,
};

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

// The key goes into sessionStorage once per tab (window.name survives reloads), so a test can
// rotate, clear or replace it and reload without the init script undoing that.
const presetKey = (page, key = FAKE_KEY) => page.addInitScript((value) => {
  if (window.name === "pub17-preset") return;
  window.name = "pub17-preset";
  window.sessionStorage.setItem("portal.key", value);
}, key);

// ---- PUB-17 stubs: the /v1/me family and a fake SSE /v1/chat/completions -----------

const ROTATED_KEY = "sk-test-rotated0002";
const DAY_MS = 86_400_000;

const bearerOf = (req) => (/^Bearer (.+)$/.exec(req.headers.authorization || "") || [])[1] || "";
const pad2 = (value) => String(value).padStart(2, "0");
const dayKey = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const daysAgo = (count) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - count);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function meDoc(over = {}) {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    object: "key", id: "k_test", name: "Alice laptop", preview: "sk-te…0001", class: "friend", status: "active",
    created_at: new Date(now.getTime() - 20 * DAY_MS).toISOString(), expires_at: new Date(now.getTime() + 40 * DAY_MS).toISOString(),
    scopes: ["models.read", "chat", "messages", "audio.speech", "self.read", "self.rotate", "self.origins"],
    models: { patterns: ["qwen3.8-*"], available: ["qwen3.8-35b-a3b"] },
    limits: { rpm: 30, tpm: 100000, max_concurrent: 2, max_output_tokens: 8192, daily_tokens: 2000000, monthly_tokens: 30000000 },
    rate_limit: { requests: { limit: 30, remaining: 28, reset_seconds: 4 }, tokens: { limit: 100000, remaining: 93000, reset_seconds: 5 } },
    usage: {
      today: { requests: 41, input_tokens: 120345, cached_input_tokens: 80000, output_tokens: 30211, resets_at: tomorrow.toISOString() },
      month: { requests: 812, input_tokens: 2203345, cached_input_tokens: 1500000, output_tokens: 610211, resets_at: nextMonth.toISOString() },
    },
    quota: {
      daily_tokens: { limit: 2000000, used: 1500000, remaining: 500000, pace: "ahead", projected_exhaustion_at: new Date(now.getTime() + 30 * 60_000).toISOString() },
      monthly_tokens: { limit: 30000000, used: 900000, remaining: 29100000, pace: "ok", projected_exhaustion_at: null },
    },
    billing: { bound: true, mode: "shadow", balance_credits: "12.500000", period_spend_credits: "3.200000" },
    allowed_origins: [], self_service: { rotate: true, origins: true }, announcements: [], request_id: "req_me",
    ...over,
  };
}

// Six days with one day missing (a gap): two models on telemetry, plain totals on counters.
function usageDoc(source = "telemetry") {
  const rows = [];
  for (const back of [5, 4, 2, 1, 0]) {
    const date = dayKey(daysAgo(back));
    if (source === "telemetry") {
      rows.push({ date, model: "qwen3.8-35b-a3b", requests: 10 + back, input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 1000, errors: back === 1 ? 2 : 0 });
      rows.push({ date, model: "qwen3.8-flash", requests: 5, input_tokens: 1500, cached_input_tokens: 0, output_tokens: 500, errors: 0 });
    } else {
      rows.push({ date, requests: 15 + back, input_tokens: 5500, cached_input_tokens: 1000, output_tokens: 1500, errors: back === 1 ? 2 : 0 });
    }
  }
  return { object: "list", granularity: "day", data: rows, source };
}

function requestsDoc(source = "telemetry") {
  const now = Date.now();
  const rows = source === "telemetry" ? [
    { request_id: "req_aaaaaaaa1", at: new Date(now - 60_000).toISOString(), model: "qwen3.8-35b-a3b", endpoint: "/v1/chat/completions", stream: true, status: 200, error_code: null, input_tokens: 1000, cached_input_tokens: 500, output_tokens: 200, ttft_ms: 350, duration_ms: 2400 },
    { request_id: "req_bbbbbbbb2", at: new Date(now - 120_000).toISOString(), model: "qwen3.8-flash", endpoint: "/v1/messages", stream: false, status: 429, error_code: "rate_limit_exceeded", input_tokens: null, cached_input_tokens: null, output_tokens: null, ttft_ms: null, duration_ms: 12 },
    { request_id: "req_cccccccc3", at: new Date(now - 180_000).toISOString(), model: "qwen3.8-35b-a3b", endpoint: "/v1/chat/completions", stream: false, status: 200, error_code: null, input_tokens: 20, cached_input_tokens: 0, output_tokens: 5, ttft_ms: 1200, duration_ms: 1500 },
  ] : [];
  return { object: "list", data: rows, next_cursor: null, source };
}

const CSV_TEXT = "﻿date,requests,input_tokens\r\n2026-10-10,15,5500\r\n";

function resetKeyStubs() {
  // A previous page may close an unfinished stream after the next test starts.
  // Keep that response's callbacks on its old fixture, not this test's counters.
  state = { ...state };
  state.validKeys = new Set([FAKE_KEY]);
  state.me = meDoc();
  state.usage = usageDoc("telemetry");
  state.myRequests = requestsDoc("telemetry");
  state.puts = [];
  state.posts = [];
  state.chatMode = "normal";
  state.chatBodies = [];
  state.chatHeaders = [];
  state.chatClosed = 0;
  state.release = null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chatRoute(req, res) {
  const chatState = state;
  const body = JSON.parse((await readBody(req)) || "{}");
  chatState.chatBodies.push(body);
  chatState.chatHeaders.push({ authorization: req.headers.authorization || "", accept: req.headers.accept || "", contentType: req.headers["content-type"] || "" });
  if (!chatState.validKeys.has(bearerOf(req))) {
    return sendJson(res, 401, { error: { message: "invalid", type: "authentication_error", code: "invalid_api_key", param: null }, request_id: "req_pg401" });
  }
  if (chatState.chatMode === "limited") {
    return sendJson(res, 429, { error: { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded", param: null }, request_id: "req_pg429" });
  }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
  res.on("close", () => {
    if (!res.writableEnded) chatState.chatClosed += 1;
  });
  const send = (value) => res.write(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
  const delta = (content, extra = {}) => ({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }] });
  send(delta("", { role: "assistant" }));
  await delay(100);
  if (chatState.chatMode === "thinking") send(delta("", { reasoning_content: "Let me think." }));
  send(delta("Hello"));
  if (chatState.chatMode === "hang") {
    await new Promise((resolve) => res.on("close", resolve));
    return undefined;
  }
  if (chatState.chatMode === "gated") await new Promise((resolve) => { chatState.release = resolve; });
  await delay(150);
  send(delta(" world"));
  await delay(150);
  send({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  send({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 500 } } });
  res.write("data: [DONE]\n\n");
  res.end();
  return undefined;
}

// true when the request was answered here.
async function keyRoutes(req, res, url) {
  const path = url.pathname;
  if (path === "/v1/chat/completions" && req.method === "POST") {
    await chatRoute(req, res);
    return true;
  }
  if (!path.startsWith("/v1/me")) return false;
  const token = bearerOf(req);
  if (token === "sk-test-down") {
    sendJson(res, 503, { error: { message: "down", type: "server_error", code: "service_unavailable", param: null }, request_id: "req_down" });
    return true;
  }
  if (!state.validKeys.has(token)) {
    sendJson(res, 401, { error: { message: "invalid", type: "authentication_error", code: "invalid_api_key", param: null }, request_id: "req_me401" });
    return true;
  }
  if (path === "/v1/me" && req.method === "GET") sendJson(res, 200, state.me);
  else if (path === "/v1/me/usage" && req.method === "GET") sendJson(res, 200, state.usage);
  else if (path === "/v1/me/requests" && req.method === "GET") sendJson(res, 200, state.myRequests);
  else if (path === "/v1/me/usage.csv" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="usage-2026-10-10_2026-10-15.csv"', "cache-control": "no-store" });
    res.end(CSV_TEXT);
  } else if (path === "/v1/me/rotate" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    state.posts.push({ path, body, origin: req.headers.origin || "" });
    if (body.confirm !== true) {
      sendJson(res, 400, { error: { message: "confirm", type: "invalid_request_error", code: "invalid_request", param: "confirm" } });
      return true;
    }
    state.validKeys = new Set([ROTATED_KEY]);
    state.me = { ...state.me, preview: "sk-te…0002" };
    sendJson(res, 200, { key: ROTATED_KEY, preview: "sk-te…0002", rotated_at: new Date().toISOString(), previous_valid_until: null });
  } else if (path === "/v1/me/origins" && req.method === "PUT") {
    const body = JSON.parse((await readBody(req)) || "{}");
    state.puts.push({ path, body });
    state.me = { ...state.me, allowed_origins: body.origins };
    sendJson(res, 200, { allowed_origins: body.origins });
  } else sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error", code: "not_found", param: null } });
  return true;
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
  const gateway = async (req, res, url) => {
    state.requests.push({ path: `${url.pathname}${url.search}`, authorization: req.headers.authorization || "" });
    if (await keyRoutes(req, res, url)) return undefined;
    if (url.pathname !== "/v1/models") return sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error", code: "not_found", param: null } });
    if (req.headers.authorization === "Bearer sk-test-down") {
      return sendJson(res, 503, { error: { message: "down", type: "server_error", code: "service_unavailable", param: null }, request_id: "req_down" });
    }
    if (!state.validKeys.has(bearerOf(req))) {
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
  resetKeyStubs();
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
    test(`axe finds nothing blocking on the status, models, announcements and docs pages (${scheme}, ${lang})`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      state.announcements = ANNOUNCEMENTS;
      state.status = overall("degraded");
      for (const route of ["/status", "/models", "/models/qwen3.8-35b-a3b", "/announcements", "/docs", "/docs/quickstart", "/docs/errors", "/docs/clients"]) {
        await goto(page, `${route}?lang=${lang}`);
        await expect(page.locator("main")).not.toBeEmpty();
        await page.waitForLoadState("networkidle");
        await expectNoA11yViolations(page, { label: `${route} ${scheme} ${lang}`, route });
      }
      await context.close();
    });
  }
});

// PUB-16: docs, snippets and the errors page.
test.describe("docs", () => {
  const withSessionKey = (page) => page.addInitScript((key) => window.sessionStorage.setItem("portal.key", key), FAKE_KEY);

  test("the index lists every docs page and the nav reaches each one", async ({ page }) => {
    await goto(page, "/docs?lang=en");
    await expect(page.locator("h1")).toHaveText("Docs");
    await expect(page.locator(".docs-index a")).toHaveCount(10);
    await page.getByRole("link", { name: "Quick start" }).first().click();
    await expect(page).toHaveURL(/\/docs\/quickstart$/);
    await expect(page.locator("h1")).toHaveText("Quick start");
    await page.getByRole("navigation", { name: "Docs pages" }).getByRole("link", { name: "Privacy" }).click();
    await expect(page.locator("h1")).toHaveText("Privacy");
    await expect(page).toHaveTitle(/Privacy · Local Model Service/);
  });

  test("quickstart injects the configured base URLs, a catalog model and $API_KEY, never a key", async ({ page }) => {
    await withSessionKey(page);
    await goto(page, "/docs/quickstart?lang=en");
    const article = page.locator(".docs-article");
    await expect(article.locator("h1")).toHaveText("Quick start");
    await expect(article).toContainText(`${baseUrl}/v1`);
    await expect(article).toContainText(`${baseUrl}/anthropic`);
    await expect(article).toContainText("qwen3.8-35b-a3b");
    await expect(article).toContainText("$API_KEY");
    expect(await article.innerText()).not.toContain(FAKE_KEY);
    expect(await article.innerText()).not.toContain("{{");
  });

  test("client snippets carry the base URL and $API_KEY; the key appears only after the opt-in", async ({ page }) => {
    await withSessionKey(page);
    await goto(page, "/docs/clients?lang=en");
    const python = page.locator('[data-client="python-openai"]');
    await expect(python).toContainText(`base_url="${baseUrl}/v1"`);
    await expect(python).toContainText('api_key="$API_KEY"');
    await expect(page.locator('[data-client="claude-code"]')).toContainText(`ANTHROPIC_BASE_URL="${baseUrl}/anthropic"`);
    await expect(page.locator('[data-client="chatbox"]')).toContainText(baseUrl);
    await expect(page.locator('[data-client="nextchat"]')).toContainText("My Key");
    await expect(page.locator("[data-client]")).toHaveCount(17);
    await expect(page.locator(".docs-checked")).toContainText("Checked on");
    for (const entry of await page.locator("[data-client]").all()) await expect(entry).toContainText("Tested with");
    expect(await page.locator("main").innerText()).not.toContain(FAKE_KEY);

    await page.getByLabel("Insert my key").check();
    await expect(python).toContainText(`api_key="${FAKE_KEY}"`);
    await page.getByLabel("Insert my key").uncheck();
    await expect(python).toContainText('api_key="$API_KEY"');
    expect(await page.locator("main").innerText()).not.toContain(FAKE_KEY);
  });

  test("without a key the opt-in is disabled and the model field changes every snippet", async ({ page }) => {
    await goto(page, "/docs/clients?lang=en");
    await expect(page.getByLabel("Insert my key")).toBeDisabled();
    await page.getByLabel("Model in the examples").fill("my-model");
    await expect(page.locator('[data-client="curl-chat"]')).toContainText('"model": "my-model"');
    await expect(page.locator('[data-client="continue"]')).toContainText("model: my-model");
  });

  test("the errors page is generated from the taxonomy and /docs/errors#<code> lands on its entry", async ({ page }) => {
    const { PUBLIC_ERROR_TAXONOMY } = require("../service-entry/lib/public-errors");
    await goto(page, "/docs/errors?lang=en#rate_limit_exceeded");
    await expect(page.locator(".error-doc")).toHaveCount(PUBLIC_ERROR_TAXONOMY.length);
    const target = page.locator("#rate_limit_exceeded");
    await expect(target).toContainText("429");
    await expect(target).toContainText("rate_limit_error");
    await expect(target).toContainText("retry-after");
    await expect(target).toBeInViewport();
    await goto(page, "/docs/errors?lang=zh#missing_api_key");
    await expect(page.locator("#missing_api_key")).toContainText("需要 API 密钥");
    await expect(page.locator("#missing_api_key")).toContainText("HTTP 401");
  });

  test("the server-rendered error page links to the matching docs entry", async ({ page }) => {
    await goto(page, "/status");
    const response = await page.goto(`${baseUrl}/no-such-page`);
    expect(response.status()).toBe(404);
    const href = await page.locator('a[href^="/docs/errors#"]').getAttribute("href");
    expect(href).toBe("/docs/errors#not_found");
    await page.goto(`${baseUrl}/docs/errors?lang=en#${href.split("#")[1]}`);
    await expect(page.locator("#not_found")).toBeInViewport();
  });

  test("the privacy page lists the logged fields, the unlogged content and the audit notice", async ({ page }) => {
    await goto(page, "/docs/privacy?lang=en");
    const article = page.locator(".docs-article");
    await expect(article).toContainText("What is logged");
    for (const field of ["key id", "token counts", "timings", "network address"]) await expect(article).toContainText(field);
    await expect(article).toContainText("The prompt and the response of an API request are not stored");
    await expect(article).toContainText("30 days");
    await expect(article).toContainText("may audit them");
    await goto(page, "/docs/privacy?lang=zh");
    await expect(page.locator(".docs-article")).toContainText("提示词和回答内容不会被保存");
  });

  test("an unknown docs page says so; the footer privacy link works", async ({ page }) => {
    await goto(page, "/docs/no-such-page?lang=en");
    await expect(page.locator("h1")).toHaveText("Page not found");
    await goto(page, "/status?lang=en");
    await page.getByRole("contentinfo").getByRole("link", { name: "Privacy" }).click();
    await expect(page).toHaveURL(/\/docs\/privacy$/);
    await expect(page.locator("h1")).toHaveText("Privacy");
  });

  test("English docs show no Han text outside code, and nothing overflows at 390 px", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const failures = await collectFailures(page);
    for (const route of ["/docs", "/docs/quickstart", "/docs/api", "/docs/streaming", "/docs/tools", "/docs/vision", "/docs/tts", "/docs/errors", "/docs/limits", "/docs/privacy", "/docs/clients"]) {
      await goto(page, `${route}?lang=en`);
      await expect(page.locator("main")).not.toBeEmpty();
      await page.waitForLoadState("networkidle");
      await expect(page.locator("main .notice-loading")).toHaveCount(0);
      expect(await hanOutsideCode(page), route).toEqual([]);
      await expectNoOverflow(page);
    }
    await goto(page, "/docs/clients?lang=zh");
    await page.waitForLoadState("networkidle");
    await expectNoOverflow(page);
    await failures.expectNone();
    await context.close();
  });
});

// PUB-17: My Key and the playground.
const PLAYGROUND_MODELS = {
  object: "list",
  data: [
    {
      id: "qwen3.8-35b-a3b", object: "model", owned_by: "local", display_name: "Qwen3.8 35B A3B", aliases: ["qwen3.8"], context_length: 262144, max_output_tokens: 4096,
      capabilities: { chat: true, completions: true, responses: true, messages: true, embeddings: false, vision: true, tools: true, reasoning: true, audio_speech: false },
      controls: { reasoning_toggle: { on: { chat_template_kwargs: { enable_thinking: true } }, off: { chat_template_kwargs: { enable_thinking: false } } } },
      state: "ready", pricing: { unit: "credits_per_million_tokens", input: "0.25", cached_input: "0.02", output: "1.00" }, limits: { rpm: 12, tpm: 40000, max_output_tokens: 4096 },
    },
    {
      id: "qwen3.8-flash", object: "model", owned_by: "local", display_name: "qwen3.8-flash", aliases: [], context_length: 131072, max_output_tokens: 2048,
      capabilities: { chat: true, completions: true, responses: true, messages: true, embeddings: false, vision: false, tools: true, reasoning: false, audio_speech: false },
      state: "ready", limits: { rpm: 12, tpm: 40000, max_output_tokens: 2048 },
    },
    {
      id: "qwen3-embed", object: "model", owned_by: "local", display_name: "qwen3-embed", aliases: [], context_length: 8192, max_output_tokens: null,
      capabilities: { chat: false, completions: false, responses: false, messages: false, embeddings: true, vision: false, tools: false, reasoning: false, audio_speech: false },
      state: "ready", limits: { rpm: 12, tpm: 40000 },
    },
    {
      id: "tts-1", object: "model", owned_by: "local", display_name: "tts-1", aliases: [], context_length: null, max_output_tokens: null,
      capabilities: { chat: false, completions: false, responses: false, messages: false, embeddings: false, vision: false, tools: false, reasoning: false, audio_speech: true },
      state: "ready", limits: { rpm: 12, tpm: 40000 },
    },
  ],
};

test.describe("my key (PUB-17)", () => {
  const withKey = presetKey;
  const storage = (page) => page.evaluate(() => ({ session: { ...window.sessionStorage }, local: { ...window.localStorage }, cookie: document.cookie }));

  test("pasting a key stores it in sessionStorage only and sends it in the Authorization header only", async ({ page }) => {
    await goto(page, "/me?lang=en");
    await expect(page.getByRole("heading", { name: "Add your key" })).toBeVisible();
    expect((await storage(page)).session).toEqual({});
    // A wrong key is refused and never stored.
    await page.getByLabel("API key").fill("sk-test-wrong0000");
    await page.getByRole("button", { name: "Use this key" }).click();
    await expect(page.getByRole("alert")).toContainText("did not accept this key");
    expect((await storage(page)).session).toEqual({});
    // A string that cannot be a key is not even sent.
    await page.getByLabel("API key").fill("not a key");
    await page.getByRole("button", { name: "Use this key" }).click();
    await expect(page.getByRole("alert")).toContainText("does not look like an API key");
    state.requests = [];
    await page.getByLabel("API key").fill(`Bearer ${FAKE_KEY}`);
    await page.getByRole("button", { name: "Use this key" }).click();
    await expect(page.locator("#me-head-title")).toHaveText("Alice laptop");
    const kept = await storage(page);
    expect(kept.session).toEqual({ "portal.key": FAKE_KEY });
    expect(kept.local).toEqual({});
    expect(kept.cookie).toBe("");
    const keyed = state.requests.filter((item) => item.authorization);
    expect(keyed.length).toBeGreaterThan(2);
    expect(keyed.every((item) => item.authorization === `Bearer ${FAKE_KEY}` && item.path.startsWith("/v1/me"))).toBe(true);
    expect(state.requests.some((item) => item.path.includes(FAKE_KEY))).toBe(false);
    expect(page.url()).not.toContain("key");
    // Sign out clears it.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Add your key" })).toBeVisible();
    expect((await storage(page)).session).toEqual({});
  });

  test("a #key= share link is read once, stored for the session and stripped from the address", async ({ page }) => {
    await goto(page, `/me?lang=en#key=${FAKE_KEY}`);
    await expect(page.locator("#me-head-title")).toHaveText("Alice laptop");
    expect(page.url()).not.toContain("key=");
    expect(page.url()).not.toContain(FAKE_KEY);
    expect(await page.evaluate(() => window.location.hash)).toBe("");
    expect((await storage(page)).session["portal.key"]).toBe(FAKE_KEY);
    expect((await storage(page)).local).toEqual({});
    expect(state.requests.some((item) => item.path.includes(FAKE_KEY))).toBe(false);
  });

  test("the key header shows the status, the class and the expiry countdown (red under 7 days)", async ({ page }) => {
    await withKey(page);
    await goto(page, "/me?lang=en");
    await expect(page.locator("#me-head-title")).toHaveText("Alice laptop");
    await expect(page.locator(".me-head code")).toHaveText("sk-te…0001");
    await expect(page.locator(".me-head .badge")).toContainText("Active");
    await expect(page.locator(".me-head")).toContainText("Friend");
    await expect(page.getByTestId("me-expiry")).toHaveAttribute("data-urgent", "false");
    await expect(page.getByTestId("me-expiry")).toContainText(/39 d \d+ h left/);

    state.me = meDoc({ expires_at: new Date(Date.now() + 3 * DAY_MS + 5 * 3600_000).toISOString() });
    await page.reload();
    const expiry = page.getByTestId("me-expiry");
    await expect(expiry).toHaveAttribute("data-urgent", "true");
    await expect(expiry).toContainText(/Expires soon: 3 d [45] h left/);
    expect(await expiry.evaluate((element) => getComputedStyle(element).color)).toBe(await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }));

    state.me = meDoc({ expires_at: null, status: "revoked" });
    await page.reload();
    await expect(page.getByTestId("me-expiry")).toHaveText("Never expires");
    await expect(page.locator(".me-head .badge")).toContainText("Revoked");
  });

  test("scopes in plain words and the models the key may use", async ({ page }) => {
    await withKey(page);
    await goto(page, "/me?lang=en");
    const scopes = page.locator(".me-scopes");
    await expect(scopes).toContainText("Chat (OpenAI chat completions)");
    await expect(scopes).toContainText("Anthropic-style messages (Claude Code)");
    await expect(scopes).toContainText("Text to speech");
    await expect(scopes).not.toContainText("audio.speech");
    await expect(page.getByRole("heading", { name: "Allowed models" })).toBeVisible();
    await expect(page.locator(".card", { hasText: "What this key can do" }).locator("code").first()).toHaveText("qwen3.8-*");
    await expect(page.locator(".me-available a")).toHaveAttribute("href", "/models/qwen3.8-35b-a3b");
  });

  test("gauges, pace bars, balance, charts and the recent-requests table render from the stubs", async ({ page }) => {
    const failures = await collectFailures(page);
    await withKey(page);
    await goto(page, "/me?lang=en");
    await expect(page.locator("#me-head-title")).toBeVisible();

    // Live limits.
    const rpm = page.getByTestId("gauge-rpm");
    await expect(rpm).toHaveAttribute("role", "meter");
    await expect(rpm).toHaveAttribute("aria-valuenow", "28");
    await expect(rpm).toHaveAttribute("aria-valuemax", "30");
    await expect(rpm).toContainText("Refills in 4 s");
    await expect(page.getByTestId("gauge-tpm")).toHaveAttribute("aria-valuenow", "93000");
    await expect(page.getByTestId("gauge-tpm")).toContainText("93,000");
    const concurrency = page.getByTestId("gauge-concurrency");
    await expect(concurrency).toContainText("2");
    await expect(concurrency).toContainText("Most requests you can run at the same time");
    await expect(page.locator(".gauge-fill")).toHaveCount(2);

    // Quota pace: the daily bar is ahead, the monthly one on pace.
    const day = page.getByTestId("quota-day");
    await expect(day.locator(".pace")).toHaveAttribute("data-pace", "ahead");
    await expect(day).toContainText("1,500,000 of 2,000,000 tokens used (75%)");
    await expect(day).toContainText(/At this pace, runs out ~(\d|[A-Z][a-z]{2} \d)/);
    await expect(day).toContainText("Resets");
    const markerX = Number(await day.locator(".pace-marker").getAttribute("x1"));
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(Math.abs(markerX - ((Date.now() - midnight.getTime()) / DAY_MS) * 100)).toBeLessThan(3);
    expect(Number(await day.locator(".pace-fill").getAttribute("width"))).toBeCloseTo(75, 1);
    await expect(day.locator('[role="meter"]')).toHaveAttribute("aria-valuenow", "1500000");
    const month = page.getByTestId("quota-month");
    await expect(month.locator(".pace")).toHaveAttribute("data-pace", "ok");
    await expect(month).toContainText("On pace");
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    expect(Math.abs(Number(await month.locator(".pace-marker").getAttribute("x1")) - ((Date.now() - monthStart) / (monthEnd - monthStart)) * 100)).toBeLessThan(1.5);

    // Balance in shadow mode.
    await expect(page.getByTestId("balance")).toHaveText("12.5");
    await expect(page.getByText("Trial mode, not charged")).toBeVisible();

    // Charts: uPlot canvases, a legend per model, a hover tooltip and a table with the gap.
    const tokens = page.getByTestId("chart-tokens");
    await expect(tokens).toHaveAttribute("data-chart-status", "ready");
    await expect(tokens.locator(".uplot canvas")).toHaveCount(1);
    await expect(tokens.locator(".chart-legend li")).toHaveText(["qwen3.8-35b-a3b", "qwen3.8-flash"]);
    const over = tokens.locator(".u-over");
    await over.scrollIntoViewIfNeeded();
    const box = await over.boundingBox();
    await over.hover({ position: { x: box.width * 0.97, y: box.height / 2 } });
    const tip = tokens.locator(".chart-tip:not([hidden])");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("qwen3.8-35b-a3b: 5,000");
    await expect(tip).toContainText("qwen3.8-flash: 2,000");
    await tokens.getByText("View as table").click();
    const rows = tokens.locator("tbody tr");
    await expect(rows).toHaveCount(6);
    await expect(rows.nth(2)).toContainText("—");
    const requests = page.getByTestId("chart-requests");
    await expect(requests).toHaveAttribute("data-chart-status", "ready");
    await expect(requests.locator(".uplot canvas")).toHaveCount(1);
    await expect(requests.locator(".chart-legend li")).toHaveText(["Requests", "Errors"]);

    // Recent requests.
    const table = page.getByTestId("requests-table");
    await expect(table.locator("tbody tr")).toHaveCount(3);
    const first = table.locator("tbody tr").first();
    await expect(first).toContainText("qwen3.8-35b-a3b");
    await expect(first).toContainText("/v1/chat/completions");
    await expect(first).toContainText("1,000 / 500 / 200");
    await expect(first).toContainText("350 ms");
    await expect(first).toContainText("2.4 s");
    await expect(first).toContainText("req_aaaaaaaa1");
    const failed = table.locator("tbody tr").nth(1);
    await expect(failed).toContainText("429");
    await expect(failed).toContainText("rate_limit_exceeded");
    await expect(failed).toContainText("— / — / —");
    await expect(first.getByRole("button", { name: "Copy req_aaaaaaaa1" })).toBeVisible();
    await failures.expectNone();
  });

  test("the Chinese page uses the spec wording for the pace and the trial mode", async ({ page }) => {
    await withKey(page);
    await goto(page, "/me?lang=zh-CN");
    await expect(page.locator("h1")).toHaveText("我的密钥");
    await expect(page.getByTestId("quota-day")).toContainText(/按当前速度约 .+ 用完/);
    await expect(page.getByText("试运行，不扣费")).toBeVisible();
    await expect(page.getByTestId("gauge-rpm")).toContainText("本分钟剩余请求数");
  });

  test("the gauges refresh every 10 seconds while the tab is visible", async ({ page }) => {
    await withKey(page);
    await page.clock.install();
    await goto(page, "/me?lang=en");
    await expect(page.getByTestId("gauge-rpm")).toHaveAttribute("aria-valuenow", "28");
    state.me = meDoc({ rate_limit: { requests: { limit: 30, remaining: 5, reset_seconds: 9 }, tokens: { limit: 100000, remaining: 1000, reset_seconds: 9 } } });
    await page.clock.runFor(10_500);
    await expect(page.getByTestId("gauge-rpm")).toHaveAttribute("aria-valuenow", "5");
    await expect(page.getByTestId("gauge-rpm")).toHaveClass(/gauge-warn/);
    await expect(page.getByTestId("gauge-tpm")).toHaveClass(/gauge-bad|gauge-warn/);
  });

  test("an exhausted quota, a key without caps and a failing refresh are said in words", async ({ page }) => {
    await withKey(page);
    state.me = meDoc({
      quota: { daily_tokens: { limit: 1000, used: 1000, remaining: 0, pace: "exhausted", projected_exhaustion_at: null }, monthly_tokens: null },
      limits: { rpm: 30, tpm: null, max_concurrent: null, max_output_tokens: 8192, daily_tokens: 1000, monthly_tokens: null },
      rate_limit: { requests: { limit: 30, remaining: 0, reset_seconds: 30 }, tokens: null },
      billing: null,
    });
    await goto(page, "/me?lang=en");
    await expect(page.getByTestId("quota-day")).toContainText("Quota used up. It resets at");
    await expect(page.getByTestId("quota-day").locator(".pace")).toHaveAttribute("data-pace", "exhausted");
    await expect(page.getByTestId("quota-month")).toHaveCount(0);
    await expect(page.getByTestId("gauge-tpm")).toContainText("No limit");
    await expect(page.getByTestId("gauge-rpm")).toHaveClass(/gauge-bad/);
    await expect(page.getByTestId("balance")).toHaveCount(0);
  });

  test("charts and the request table explain an empty history", async ({ page }) => {
    await withKey(page);
    state.usage = { object: "list", granularity: "day", data: [], source: "counters" };
    state.myRequests = requestsDoc("counters");
    await goto(page, "/me?lang=en");
    await expect(page.getByTestId("chart-tokens")).toContainText("only daily totals are kept");
    await expect(page.getByTestId("chart-tokens").locator("canvas")).toHaveCount(0);
    await expect(page.getByText("No requests yet")).toBeVisible();
    await expect(page.getByText("Request history is not recorded on this service")).toBeVisible();
    // Counters without a model split: one total series and a note.
    state.usage = usageDoc("counters");
    await page.reload();
    await expect(page.getByTestId("chart-tokens")).toContainText("no split by model");
    await expect(page.getByTestId("chart-tokens").locator(".chart-legend li")).toHaveText(["All tokens"]);
    await expect(page.getByTestId("chart-tokens")).toHaveAttribute("data-chart-status", "ready");
  });

  test("rotate: confirm, then the new key is shown once and replaces the session key", async ({ page }) => {
    const failures = await collectFailures(page);
    await withKey(page);
    await goto(page, "/me?lang=en");
    await page.getByRole("button", { name: "Rotate key…" }).click();
    const dialog = page.getByRole("dialog", { name: "Rotate this key?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(state.posts).toEqual([]);

    await page.getByRole("button", { name: "Rotate key…" }).click();
    await dialog.getByRole("button", { name: "Rotate now" }).click();
    const fresh = page.getByTestId("fresh-key");
    await expect(fresh).toBeVisible();
    await expect(page.getByTestId("fresh-key-value")).toHaveText(ROTATED_KEY);
    expect(state.posts).toEqual([{ path: "/v1/me/rotate", body: { confirm: true }, origin: baseUrl }]);
    expect((await storage(page)).session["portal.key"]).toBe(ROTATED_KEY);
    // The page keeps working with the new key (the old one is refused now).
    await expect(page.locator(".me-head code")).toHaveText("sk-te…0002");
    expect(state.requests.some((item) => item.authorization === `Bearer ${ROTATED_KEY}` && item.path === "/v1/me")).toBe(true);
    await fresh.getByRole("button", { name: "I have saved it" }).click();
    await expect(fresh).toHaveCount(0);
    // Shown once: nowhere in the page any more, and not after a reload either.
    expect(await page.locator("body").innerText()).not.toContain(ROTATED_KEY);
    await page.reload();
    await expect(page.locator("#me-head-title")).toBeVisible();
    await expect(page.getByTestId("fresh-key")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain(ROTATED_KEY);
    expect(page.url()).not.toContain(ROTATED_KEY);
    await failures.expectNone();
  });

  test("a rate-limited rotation says so inside the dialog and keeps the old key", async ({ page }) => {
    await withKey(page);
    await page.route("**/v1/me/rotate", (route) => route.fulfill({
      status: 429, contentType: "application/json", headers: { "retry-after": "3600" },
      body: JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error", code: "rate_limit_exceeded", param: null }, request_id: "req_rot429" }),
    }));
    await goto(page, "/me?lang=en");
    await page.getByRole("button", { name: "Rotate key…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Rotate now" }).click();
    await expect(dialog.getByRole("alert")).toContainText("only a few times per hour");
    expect((await storage(page)).session["portal.key"]).toBe(FAKE_KEY);
    await expect(page.getByTestId("fresh-key")).toHaveCount(0);
  });

  test("a key without self.rotate or self.origins cannot rotate or edit origins", async ({ page }) => {
    await withKey(page);
    state.me = meDoc({ self_service: { rotate: false, origins: false }, allowed_origins: ["https://app.example.com"] });
    await goto(page, "/me?lang=en");
    await expect(page.getByRole("button", { name: "Rotate key…" })).toBeDisabled();
    await expect(page.getByText("This key cannot rotate itself")).toBeVisible();
    const editor = page.getByTestId("origins-editor");
    await expect(editor).toContainText("The service owner manages this list");
    await expect(editor.locator("code")).toHaveText("https://app.example.com");
    await expect(editor.getByRole("button")).toHaveCount(0);
  });

  test("the origins editor validates every entry before it saves", async ({ page }) => {
    await withKey(page);
    await goto(page, "/me?lang=en");
    const editor = page.getByTestId("origins-editor");
    await expect(editor).toContainText("No origins are allowed.");
    const input = editor.getByLabel("Add an origin");
    const problem = editor.locator("#origin-problem");
    const tryAdd = async (text) => {
      await input.fill(text);
      await editor.getByRole("button", { name: "Add", exact: true }).click();
    };
    for (const [text, message] of [
      ["", "Type an origin first"],
      ["*", "A wildcard (*) is not allowed"],
      ["https://*.example.com", "A wildcard (*) is not allowed"],
      ["https://app.example.com/app", "An origin has no path, query or fragment"],
      ["https://app.example.com?x=1", "An origin has no path, query or fragment"],
      ["http://app.example.com", "Only https:// origins are allowed"],
      ["ftp://app.example.com", "Only https:// origins are allowed"],
      ["app.example.com", "not a valid origin"],
      ["https://user:pass@app.example.com", "not a valid origin"],
    ]) {
      await tryAdd(text);
      await expect(problem, text).toContainText(message);
    }
    expect(state.puts).toEqual([]);
    await expect(editor.getByRole("button", { name: "Save origins" })).toBeDisabled();

    await tryAdd("https://app.example.com/");
    await expect(editor.locator(".origin-list code")).toHaveText(["https://app.example.com"]);
    await expect(problem).toHaveText("");
    await tryAdd("https://APP.example.com");
    await expect(problem).toContainText("already in the list");
    await tryAdd("http://localhost:3000");
    await tryAdd("http://127.0.0.1:8080");
    await expect(editor.locator(".origin-list code")).toHaveCount(3);
    // At most 10.
    for (let index = 0; index < 7; index += 1) await tryAdd(`https://site${index}.example.com`);
    await expect(editor.locator(".origin-list code")).toHaveCount(10);
    await tryAdd("https://one-too-many.example.com");
    await expect(problem).toContainText("At most 10 origins");
    // Remove one, save, and the server received exactly the list.
    await editor.getByRole("button", { name: "Remove https://site6.example.com" }).click();
    await editor.getByRole("button", { name: "Save origins" }).click();
    await expect(page.getByText("Origins saved")).toBeVisible();
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0].body.origins).toEqual([
      "https://app.example.com", "http://localhost:3000", "http://127.0.0.1:8080",
      "https://site0.example.com", "https://site1.example.com", "https://site2.example.com", "https://site3.example.com", "https://site4.example.com", "https://site5.example.com",
    ]);
    await expect(editor.getByRole("button", { name: "Save origins" })).toBeDisabled();
  });

  test("the usage CSV downloads through the key header", async ({ page }) => {
    await withKey(page);
    await goto(page, "/me?lang=en");
    await expect(page.locator("#me-head-title")).toBeVisible();
    state.requests = [];
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download usage CSV" }).click()]);
    expect(download.suggestedFilename()).toBe("usage-2026-10-10_2026-10-15.csv");
    const fs = require("node:fs");
    const text = fs.readFileSync(await download.path(), "utf8");
    expect(text).toBe(CSV_TEXT);
    const csv = state.requests.find((item) => item.path === "/v1/me/usage.csv");
    expect(csv.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  test("a stored key the server refuses is dropped and the sign-in form says why", async ({ page }) => {
    await withKey(page, "sk-test-wrong0000");
    await goto(page, "/me?lang=en");
    await expect(page.getByRole("heading", { name: "Add your key" })).toBeVisible();
    await expect(page.getByText("The saved key is not accepted any more")).toBeVisible();
    expect((await storage(page)).session).toEqual({});
  });

  test("a service that cannot answer shows a retry, not a wrong-key message", async ({ page }) => {
    await withKey(page, "sk-test-down");
    await goto(page, "/me?lang=en");
    await expect(page.getByRole("alert")).toContainText("unavailable");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    expect((await storage(page)).session["portal.key"]).toBe("sk-test-down");
  });
});

test.describe("playground (PUB-17)", () => {
  const withKey = presetKey;
  const answer = (page) => page.getByTestId("assistant-text");

  test.beforeEach(() => {
    state.keyModels = PLAYGROUND_MODELS;
  });

  async function send(page, text) {
    await page.getByLabel("Your message").fill(text);
    await page.getByRole("button", { name: "Send" }).click();
  }

  test("without a key it asks for one", async ({ page }) => {
    await goto(page, "/playground?lang=en");
    await expect(page.getByRole("heading", { name: "Add your key first" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Add a key under My Key" })).toHaveAttribute("href", "/me");
    expect(state.requests.some((item) => item.path.startsWith("/v1/"))).toBe(false);
  });

  test("the picker lists only the chat models of the key and ?model= preselects one", async ({ page }) => {
    await withKey(page);
    await goto(page, "/playground?lang=en");
    const picker = page.getByLabel("Model", { exact: true });
    await expect(picker.locator("option")).toHaveText(["Qwen3.8 35B A3B (qwen3.8-35b-a3b)", "qwen3.8-flash"]);
    await expect(picker).toHaveValue("qwen3.8-35b-a3b");
    await goto(page, "/playground?lang=en&model=qwen3.8-flash");
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("qwen3.8-flash");
    // An alias resolves to its model; an unknown name falls back to the first.
    await goto(page, "/playground?lang=en&model=qwen3.8");
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("qwen3.8-35b-a3b");
    await goto(page, "/playground?lang=en&model=nothing");
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("qwen3.8-35b-a3b");
  });

  test("a key the server refuses is pointed to My Key", async ({ page }) => {
    await withKey(page, "sk-test-wrong0000");
    await goto(page, "/playground?lang=en");
    await expect(page.getByRole("alert")).toContainText("The saved key was not accepted");
    await expect(page.getByRole("link", { name: "Manage your key" })).toHaveAttribute("href", "/me");
  });

  test("controls explain themselves, cap max_tokens and show the reasoning toggle only when the model has one", async ({ page }) => {
    await withKey(page);
    await goto(page, "/playground?lang=en");
    for (const label of ["System prompt", "Temperature", "Top-p", "Max output tokens", "Thinking"]) await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    await expect(page.getByText("Higher is more varied, lower is more predictable (0 to 2).")).toBeVisible();
    await expect(page.getByText("Longest answer to allow, up to 4,096 for this model.")).toBeVisible();
    await expect(page.getByLabel("Max output tokens")).toHaveAttribute("max", "4096");
    await page.getByLabel("Model", { exact: true }).selectOption("qwen3.8-flash");
    await expect(page.getByLabel("Thinking")).toHaveCount(0);
    await expect(page.getByLabel("Max output tokens")).toHaveAttribute("max", "2048");
    await expect(page.getByText("Nothing you type here is stored by this page")).toBeVisible();

    // A value above the cap is clamped in the request, never sent as typed.
    await page.getByLabel("Max output tokens").fill("99999");
    await page.getByLabel("Temperature").fill("5");
    await send(page, "Hi");
    await expect(answer(page)).toHaveText("Hello world");
    expect(state.chatBodies[0].max_tokens).toBe(2048);
    expect(state.chatBodies[0].temperature).toBe(2);
    expect(state.chatBodies[0].model).toBe("qwen3.8-flash");
  });

  test("it streams, shows TTFT, tokens per second and cost, and sends exactly what the form says", async ({ page }) => {
    const failures = await collectFailures(page);
    await withKey(page);
    state.chatMode = "gated";
    await goto(page, "/playground?lang=en");
    await page.getByLabel("System prompt").fill("Answer briefly.");
    await page.getByLabel("Temperature").fill("0.3");
    await page.getByLabel("Top-p").fill("0.9");
    await page.getByLabel("Max output tokens").fill("512");
    await send(page, "Say hello");
    // Mid-stream: the first piece is on screen, Stop is offered, Send is off.
    await expect(answer(page)).toHaveText("Hello");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(page.getByTestId("transcript")).toHaveAttribute("aria-busy", "true");
    state.release();
    await expect(answer(page)).toHaveText("Hello world");
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    const stats = page.getByTestId("msg-stats");
    await expect(stats.locator('[data-stat="tokens"]')).toHaveText("in 1,000 (500 cached) · out 200");
    await expect(stats.locator('[data-stat="ttft"]')).toHaveText(/^\d+ ms$|^\d(\.\d)? s$/);
    await expect(stats.locator('[data-stat="speed"]')).toHaveText(/^\d+(\.\d)? tokens\/s$/);
    // (500 uncached x 0.25 + 500 cached x 0.02 + 200 output x 1.00) / 1M
    await expect(stats.locator('[data-stat="cost"]')).toHaveText("0.000335 credits");

    expect(state.chatBodies).toHaveLength(1);
    expect(state.chatBodies[0]).toEqual({
      model: "qwen3.8-35b-a3b",
      messages: [{ role: "system", content: "Answer briefly." }, { role: "user", content: "Say hello" }],
      stream: true, stream_options: { include_usage: true }, temperature: 0.3, top_p: 0.9, max_tokens: 512,
    });
    expect(state.chatHeaders[0]).toEqual({ authorization: `Bearer ${FAKE_KEY}`, accept: "text/event-stream", contentType: "application/json" });

    // The second turn carries the history (without the stats).
    state.chatMode = "normal";
    await send(page, "And again");
    await expect(page.getByTestId("assistant-text")).toHaveCount(2);
    await expect(page.getByTestId("assistant-text").nth(1)).toHaveText("Hello world");
    expect(state.chatBodies[1].messages).toEqual([
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "Say hello" }, { role: "assistant", content: "Hello world" }, { role: "user", content: "And again" },
    ]);
    await failures.expectNone();
  });

  test("a late stream close cannot change the next test's chat fixture", async () => {
    const previous = state;
    previous.chatMode = "hang";
    let request;
    try {
      await new Promise((resolve, reject) => {
        request = http.request(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${FAKE_KEY}`, "content-type": "application/json" },
        }, (response) => {
          let text = "";
          response.on("error", reject);
          response.on("data", (chunk) => {
            text += chunk.toString();
            if (text.includes('"content":"Hello"')) resolve();
          });
        });
        request.on("error", reject);
        request.end(JSON.stringify({ model: "qwen3.8-flash", stream: true, messages: [{ role: "user", content: "old stream" }] }));
      });
      // Reproduce the ordering that page teardown can produce between tests:
      // reset first, then deliver the old response's close event.
      resetKeyStubs();
      request.destroy();
      await expect.poll(() => previous.chatClosed).toBe(1);
      expect(state.chatClosed).toBe(0);
      expect(state.chatBodies).toEqual([]);
    } finally {
      request?.destroy();
    }
  });

  test("Stop aborts the request, keeps the partial answer and frees the form", async ({ page }) => {
    await withKey(page);
    state.chatMode = "hang";
    await goto(page, "/playground?lang=en");
    await send(page, "Never ending");
    await expect(answer(page)).toHaveText("Hello");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByTestId("stopped-note")).toHaveText("Stopped before the answer finished.");
    await expect(answer(page)).toHaveText("Hello");
    await expect.poll(() => state.chatClosed).toBe(1);
    expect(state.chatBodies).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await page.getByLabel("Your message").fill("next");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    // A stopped answer has no usage: tokens are an estimate, the cost is unknown.
    const stats = page.getByTestId("msg-stats");
    await expect(stats.locator('[data-stat="tokens"]')).toContainText("out ≈ 1");
    await expect(stats.locator('[data-stat="cost"]')).toHaveText("—");
    await expect(stats.locator('[data-stat="ttft"]')).toHaveText(/(ms|s)$/);
  });

  test("the reasoning toggle patches the request from controls.reasoning_toggle and shows the thinking", async ({ page }) => {
    await withKey(page);
    state.chatMode = "thinking";
    await goto(page, "/playground?lang=en");
    await send(page, "one");
    await expect(answer(page)).toHaveText("Hello world");
    await expect(page.locator(".msg-reasoning")).toContainText("Let me think.");
    await page.getByLabel("Thinking", { exact: true }).selectOption("off");
    await send(page, "two");
    await expect(page.getByTestId("assistant-text")).toHaveCount(2);
    await page.getByLabel("Thinking", { exact: true }).selectOption("on");
    await send(page, "three");
    await expect(page.getByTestId("assistant-text")).toHaveCount(3);
    expect(state.chatBodies[0].chat_template_kwargs).toBeUndefined();
    expect(state.chatBodies[1].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(state.chatBodies[2].chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  // The command a reader copies, parsed back into the request it describes.
  function parseCurl(code) {
    const lines = code.split("\n");
    const url = /^curl -N "([^"]+)" \\$/.exec(lines[0])[1];
    const headers = {};
    for (const line of lines.slice(1)) {
      const match = /^ {2}-H "([^:]+): (.*)" \\$/.exec(line);
      if (match) headers[match[1].toLowerCase()] = match[2];
    }
    const start = code.indexOf("-d '") + 4;
    const body = JSON.parse(code.slice(start, code.lastIndexOf("'")).replace(/'\\''/g, "'"));
    return { url, headers, body };
  }

  test("Copy as curl equals the request that was sent, and the key is in it only when toggled", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    await withKey(page);
    await goto(page, "/playground?lang=en");
    const panel = page.getByTestId("copy-as");
    const codeOf = () => panel.locator("pre code").innerText();
    // Before anything is sent the panel previews the request that would go out.
    await expect(panel).toContainText("Shows the request that would be sent now.");
    expect(parseCurl(await codeOf()).body.model).toBe("qwen3.8-35b-a3b");

    await page.getByLabel("System prompt").fill("It's \"quoted\" and $HOME-safe");
    await page.getByLabel("Thinking", { exact: true }).selectOption("off");
    await page.getByLabel("Temperature").fill("0.2");
    await send(page, "What's 2 > 1? $(rm -rf /) `x`");
    await expect(answer(page)).toHaveText("Hello world");
    await expect(panel).toContainText("Shows the request that was sent last.");

    const sent = state.chatBodies[0];
    const copied = parseCurl(await codeOf());
    expect(copied.body).toEqual(sent);
    expect(copied.url).toBe(`${baseUrl}/v1/chat/completions`);
    expect(copied.headers).toEqual({ authorization: "Bearer $API_KEY", "content-type": "application/json", accept: "text/event-stream" });
    expect(await page.locator("body").innerText()).not.toContain(FAKE_KEY);

    // The Copy button puts the same text on the clipboard.
    await panel.getByRole("button", { name: "Copy as curl" }).click();
    // The clipboard of Windows hands back CRLF line ends.
    expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n")).toBe(await codeOf());

    // The key is included only after the toggle, and the warning appears.
    await panel.getByLabel("Include my key").check();
    await expect(panel).toContainText("The code now contains your real key");
    const withKeyText = parseCurl(await codeOf());
    expect(withKeyText.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(withKeyText.body).toEqual(sent);
    await panel.getByLabel("Include my key").uncheck();
    expect(await codeOf()).not.toContain(FAKE_KEY);

    // Python and Node send the same fields.
    await panel.getByRole("button", { name: "Python", exact: true }).click();
    const python = await codeOf();
    expect(python).toContain('api_key=os.environ["API_KEY"]');
    expect(python).toContain(`base_url="${baseUrl}/v1"`);
    expect(python).toContain('model="qwen3.8-35b-a3b"');
    expect(python).toContain('"enable_thinking": False');
    expect(python).toContain("stream_options={");
    expect(python).not.toContain(FAKE_KEY);
    await panel.getByRole("button", { name: "Node.js", exact: true }).click();
    const node = await codeOf();
    expect(node).toContain("apiKey: process.env.API_KEY");
    expect(JSON.parse(/create\(([\s\S]*)\);\nfor await/.exec(node)[1])).toEqual(sent);
    expect(node).not.toContain(FAKE_KEY);
    await panel.getByLabel("Include my key").check();
    expect(await codeOf()).toContain(`apiKey: "${FAKE_KEY}"`);
  });

  test("errors are explained in words with the request id, and a refused key points to My Key", async ({ page }) => {
    await withKey(page);
    state.chatMode = "limited";
    await goto(page, "/playground?lang=en");
    await send(page, "hello");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("The per-minute request limit is reached");
    await expect(alert).toContainText("req_pg429");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.getByLabel("Your message").fill("again");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    // The failed turn does not leak into the next request's history as an assistant message.
    state.chatMode = "normal";
    await page.getByRole("button", { name: "Send" }).click();
    await expect(answer(page)).toHaveText("Hello world");
    expect(state.chatBodies[1].messages.map((item) => item.role)).toEqual(["user", "user"]);

    // A key rotated elsewhere: the model list still loaded, the chat call is refused.
    state.validKeys = new Set([FAKE_KEY, "sk-test-temp0003"]);
    await page.evaluate(() => window.sessionStorage.setItem("portal.key", "sk-test-temp0003"));
    await page.reload();
    await expect(page.getByLabel("Your message")).toBeVisible();
    state.validKeys = new Set([FAKE_KEY]);
    await send(page, "refused");
    await expect(page.locator(".msg-assistant .notice-error")).toContainText("The key is wrong or has been rotated");
    await expect(page.locator(".msg-assistant").getByRole("link", { name: "Check your key under My Key" })).toHaveAttribute("href", "/me");
  });

  test("nothing is stored: a reload empties the conversation and only the key stays in the session", async ({ page }) => {
    await withKey(page);
    await goto(page, "/playground?lang=en");
    await send(page, "private words");
    await expect(answer(page)).toHaveText("Hello world");
    const stored = await page.evaluate(() => ({ session: { ...window.sessionStorage }, local: { ...window.localStorage }, cookie: document.cookie }));
    expect(stored).toEqual({ session: { "portal.key": FAKE_KEY }, local: {}, cookie: "" });
    await page.reload();
    await expect(page.getByText("No messages yet. Write something below.")).toBeVisible();
    await expect(page.getByTestId("assistant-text")).toHaveCount(0);
  });

  test("Clear empties the conversation and the copy panel returns to its preview", async ({ page }) => {
    await withKey(page);
    await goto(page, "/playground?lang=en");
    await send(page, "hello");
    await expect(answer(page)).toHaveText("Hello world");
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByTestId("assistant-text")).toHaveCount(0);
    await expect(page.getByTestId("copy-as")).toContainText("Shows the request that would be sent now.");
  });
});

test.describe("my key and playground: layout, language and accessibility (PUB-17)", () => {
  const withKey = presetKey;
  const settle = async (page, route) => {
    await page.goto(`${baseUrl}${route}`);
    await expect(page.locator("main h1")).toBeVisible();
    await page.waitForLoadState("networkidle");
  };

  test("English mode has no Han text outside code and pre", async ({ page }) => {
    await withKey(page);
    state.keyModels = PLAYGROUND_MODELS;
    await settle(page, "/me?lang=en");
    await expect(page.getByTestId("chart-tokens")).toHaveAttribute("data-chart-status", "ready");
    expect(await hanOutsideCode(page)).toEqual([]);
    await settle(page, "/playground?lang=en");
    await expect(page.getByLabel("Your message")).toBeVisible();
    expect(await hanOutsideCode(page)).toEqual([]);
    await page.getByLabel("Your message").fill("hi");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("msg-stats")).toBeVisible();
    expect(await hanOutsideCode(page)).toEqual([]);
    // The signed-out views too.
    await page.evaluate(() => window.sessionStorage.clear());
    await settle(page, "/me?lang=en");
    expect(await hanOutsideCode(page)).toEqual([]);
    await settle(page, "/playground?lang=en");
    expect(await hanOutsideCode(page)).toEqual([]);
  });

  for (const lang of ["zh-CN", "en"]) {
    for (const scheme of ["light", "dark"]) {
      test(`no horizontal overflow at 390 px (${lang}, ${scheme})`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
        const page = await context.newPage();
        await withKey(page);
        state.keyModels = PLAYGROUND_MODELS;
        state.me = meDoc({ allowed_origins: ["https://a-very-long-origin-name.subdomain.example.com:8443"] });
        await settle(page, `/me?lang=${lang}`);
        await expect(page.getByTestId("chart-tokens")).toHaveAttribute("data-chart-status", "ready");
        await expect(page.getByTestId("requests-table").locator("tbody tr")).toHaveCount(3);
        await expectNoOverflow(page);
        await settle(page, `/playground?lang=${lang}`);
        await expect(page.getByTestId("copy-as")).toBeVisible();
        await page.getByLabel(lang === "en" ? "Your message" : "你的消息").fill("hello");
        await page.getByRole("button", { name: lang === "en" ? "Send" : "发送" }).click();
        await expect(page.getByTestId("msg-stats")).toBeVisible();
        await expectNoOverflow(page);
        await settle(page, `/me?lang=${lang}`);
        await context.close();
      });
    }
  }

  for (const [scheme, lang] of [["light", "en"], ["dark", "zh-CN"]]) {
    test(`axe finds nothing blocking on My Key and the playground (${scheme}, ${lang})`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      state.keyModels = PLAYGROUND_MODELS;
      await settle(page, `/me?lang=${lang}`);
      await expectNoA11yViolations(page, { label: `/me signed out ${scheme} ${lang}`, route: "/me" });
      await settle(page, `/playground?lang=${lang}`);
      await expectNoA11yViolations(page, { label: `/playground signed out ${scheme} ${lang}`, route: "/playground" });
      await withKey(page);
      await settle(page, `/me?lang=${lang}`);
      await expect(page.getByTestId("chart-tokens")).toHaveAttribute("data-chart-status", "ready");
      await expect(page.getByTestId("requests-table").locator("tbody tr")).toHaveCount(3);
      await expectNoA11yViolations(page, { label: `/me ${scheme} ${lang}`, route: "/me" });
      await settle(page, `/playground?lang=${lang}`);
      await page.getByLabel(lang === "en" ? "Your message" : "你的消息").fill("hello");
      await page.getByRole("button", { name: lang === "en" ? "Send" : "发送" }).click();
      await expect(page.getByTestId("msg-stats")).toBeVisible();
      await expectNoA11yViolations(page, { label: `/playground ${scheme} ${lang}`, route: "/playground" });
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
