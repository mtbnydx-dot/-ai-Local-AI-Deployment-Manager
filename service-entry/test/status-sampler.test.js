"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { createKeysStore } = require("../lib/keys-store");
const { createPublicListener } = require("../lib/public-listener");
const sampler = require("../lib/status-sampler");

// Public status, catalog and announcements (05 §12.2, PUB-14). The golden file
// is /status.json for a fixed fleet, clock and sample history; regenerate it
// with UPDATE_GOLDEN=1 only when the document shape changes on purpose.
const GOLDEN_PATH = path.join(__dirname, "golden", "status-json.json");
const NOW = Date.parse("2026-10-14T12:30:20.000Z");

const CONFIG = Object.freeze({
  listeners: { public: { baseUrl: "https://api.example.com" } },
  public: {
    brand: { "zh-CN": "本地模型服务", "en-US": "Local Model Service" },
    catalog: { publish: ["*"], showPrices: true },
    defaults: { rpm: 60, tpm: 200000, maxConcurrent: 2, maxOutputTokens: 8192 },
    share: { maxConcurrent: 4, maxQueued: 16 },
    exposeTts: true,
  },
});

function withConfig(patch = {}) {
  return {
    ...CONFIG,
    public: { ...CONFIG.public, ...patch, catalog: { ...CONFIG.public.catalog, ...(patch.catalog || {}) } },
  };
}

function makeStore(t, clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-sampler-"));
  const store = createKeysStore({ file: path.join(dir, "platform-access.sqlite"), DatabaseSync, now: () => new Date(clock.ms), tzOffsetMinutes: 0 });
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

// A manager catalog as service-entry/server.js builds it, with the internals
// (ports, container names, manager and engine ids) that must never leak.
function instance(models, extra = {}) {
  return {
    id: "primary",
    instanceId: "primary",
    fleetId: "vllm-manager:primary",
    primary: true,
    running: true,
    status: "running",
    lifecycleState: "ready",
    containerName: "vllm-secret-container",
    port: 18000,
    localBaseUrl: "http://127.0.0.1:18000",
    manager_engine: "vllm-manager",
    engineId: "sglang",
    models: models.map((model) => (typeof model === "string" ? { id: model } : model)),
    ...extra,
  };
}

function catalog(instances, extra = {}) {
  return { manager: { id: "vllm-manager", name: "vllm-manager", port: 5177 }, listening: true, running: true, instances, ...extra };
}

const READY_FLEET = () => [catalog([instance([
  { id: "qwen3.8-35b-a3b", max_model_len: 131072, capabilities: ["text", "tools"] },
  { id: "embed-small", capabilities: ["embedding"] },
])])];

function telemetry(stats) {
  return { statusStats: async () => stats };
}

function setup(t, { catalogs = READY_FLEET, stats = null, config = CONFIG, shareQueue = null, start = NOW } = {}) {
  const clock = { ms: start };
  const store = makeStore(t, clock);
  const fleet = { catalogs: typeof catalogs === "function" ? catalogs() : catalogs, calls: 0 };
  const instanceSampler = sampler.startStatusSampler({
    getCatalogs: async () => {
      fleet.calls += 1;
      return fleet.catalogs;
    },
    telemetry: stats === null ? null : telemetry(stats),
    store,
    config,
    shareQueue,
    now: () => clock.ms,
    autoStart: false,
  });
  t.after(() => instanceSampler.stop());
  return { clock, store, fleet, sampler: instanceSampler };
}

function announce(store, input) {
  return store.announcements.create({ severity: "info", title: { zh: "公告", en: "Notice" }, startsAt: "2026-10-14T00:00:00.000Z", published: true, ...input }, { actor: "test" });
}

test("state rules: operational, degraded, offline and maintenance", async (t) => {
  // operational: every published model ready, no pressure
  let env = setup(t, { stats: { requests: 100, errors5xx: 2, models: {} } });
  assert.equal((await env.sampler.getStatus()).status, "operational");

  // degraded: a published model is not ready
  env = setup(t, { catalogs: [catalog([
    instance(["qwen3.8-35b-a3b"]),
    instance(["slow-loader"], { id: "second", instanceId: "second", lifecycleState: "loading", status: "starting" }),
  ])] });
  let doc = await env.sampler.getStatus();
  assert.equal(doc.status, "degraded");
  assert.deepEqual(doc.models.map((model) => [model.id, model.state]), [["qwen3.8-35b-a3b", "ready"], ["slow-loader", "loading"]]);

  // degraded: 5xx rate above 5 % over 5 min, but only with enough requests behind it
  env = setup(t, { stats: { requests: 100, errors5xx: 6, models: {} } });
  assert.equal((await env.sampler.getStatus()).status, "degraded");
  env = setup(t, { stats: { requests: 100, errors5xx: 5, models: {} } });
  assert.equal((await env.sampler.getStatus()).status, "operational", "exactly 5 % is not above 5 %");
  env = setup(t, { stats: { requests: 2, errors5xx: 2, models: {} } });
  assert.equal((await env.sampler.getStatus()).status, "operational", "two requests are no rate");

  // degraded: the share queue is at least half full
  env = setup(t, { shareQueue: () => ({ queued: 8, max: 16 }) });
  assert.equal((await env.sampler.getStatus()).status, "degraded");
  env = setup(t, { shareQueue: () => ({ queued: 7, max: 16 }) });
  assert.equal((await env.sampler.getStatus()).status, "operational");

  // offline: no published model is ready (nothing listed, or nothing ready)
  env = setup(t, { catalogs: [] });
  assert.equal((await env.sampler.getStatus()).status, "offline");
  env = setup(t, { catalogs: [catalog([instance(["qwen3.8-35b-a3b"], { running: false, status: "exited (1)", lifecycleState: "crashed" })], { running: false })] });
  doc = await env.sampler.getStatus();
  assert.equal(doc.status, "offline");
  assert.equal(doc.models.find((model) => model.id === "qwen3.8-35b-a3b").state, "offline");
  assert.deepEqual(doc.message, { "zh-CN": "主机离线", "en-US": "The host is offline" });

  // a throwing catalog source is an empty fleet, not a crash
  env = setup(t);
  env.sampler.stop();
  const failing = sampler.startStatusSampler({ getCatalogs: async () => { throw new Error("boom"); }, store: env.store, config: CONFIG, now: () => NOW, autoStart: false });
  assert.equal((await failing.getStatus()).status, "offline");

  // maintenance: an active, published maintenance announcement wins over everything
  env = setup(t, { catalogs: [] });
  announce(env.store, { severity: "maintenance", title: { zh: "维护", en: "Maintenance" }, endsAt: "2026-10-14T18:00:00.000Z" });
  doc = await env.sampler.getStatus();
  assert.equal(doc.status, "maintenance");
  assert.equal(doc.announcements.length, 1);
  assert.deepEqual(doc.message["en-US"], "Scheduled maintenance");

  // ... but not a draft, a future one, an expired one, a keys-only one, or an incident
  env = setup(t);
  announce(env.store, { severity: "maintenance", published: false });
  announce(env.store, { severity: "maintenance", startsAt: "2026-10-15T00:00:00.000Z" });
  announce(env.store, { severity: "maintenance", startsAt: "2026-10-13T00:00:00.000Z", endsAt: "2026-10-13T06:00:00.000Z" });
  announce(env.store, { severity: "maintenance", audience: "keys" });
  announce(env.store, { severity: "incident" });
  doc = await env.sampler.getStatus();
  assert.equal(doc.status, "operational");
  assert.deepEqual(doc.announcements.map((item) => item.severity), ["incident"], "only the active published public announcement is listed");
});

test("computeOverall orders maintenance, offline, degraded", () => {
  const ready = { state: "ready" };
  const loading = { state: "loading" };
  assert.equal(sampler.computeOverall({ models: [], announcements: [{ severity: "maintenance" }] }), "maintenance");
  assert.equal(sampler.computeOverall({ models: [loading] }), "offline");
  assert.equal(sampler.computeOverall({ models: [ready, loading] }), "degraded");
  assert.equal(sampler.computeOverall({ models: [ready], errorRate: 0.06, requests: 50 }), "degraded");
  assert.equal(sampler.computeOverall({ models: [ready], errorRate: 0.06, requests: 4 }), "operational");
  assert.equal(sampler.computeOverall({ models: [ready], shareQueue: { queued: 1, max: 2 } }), "degraded");
  assert.equal(sampler.computeOverall({ models: [ready], shareQueue: { queued: 5, max: 0 } }), "operational");
});

test("numbers are bucketed and omitted without telemetry", async (t) => {
  const models = {
    "qwen3.8-35b-a3b": { ttftP50Ms: 372, tokensPerSecond: 87.4, running: 2 },
    "embed-small": { ttftP50Ms: 12, tokensPerSecond: 0.4, waiting: 3 },
  };
  let env = setup(t, { stats: { requests: 50, errors5xx: 0, models } });
  let doc = await env.sampler.getStatus();
  const qwen = doc.models.find((model) => model.id === "qwen3.8-35b-a3b");
  const embed = doc.models.find((model) => model.id === "embed-small");
  assert.equal(qwen.ttft_p50_ms, 350);
  assert.equal(qwen.tokens_per_second, 85);
  assert.equal(qwen.queue, "light");
  assert.equal(embed.ttft_p50_ms, 50, "small values round up to the first bucket");
  assert.equal(embed.tokens_per_second, 5);
  assert.equal(embed.queue, "busy");
  for (const [raw, bucket] of [[374, 350], [376, 400], [1024, 1000], [1026, 1050]]) {
    env = setup(t, { stats: { requests: 1, errors5xx: 0, models: { "qwen3.8-35b-a3b": { ttftP50Ms: raw, tokensPerSecond: 91 } } } });
    doc = await env.sampler.getStatus();
    assert.equal(doc.models.find((model) => model.id === "qwen3.8-35b-a3b").ttft_p50_ms, bucket);
    assert.equal(doc.models.find((model) => model.id === "qwen3.8-35b-a3b").tokens_per_second, 90);
    assert.equal(doc.models.find((model) => model.id === "qwen3.8-35b-a3b").ttft_p50_ms % 50, 0);
    assert.equal(doc.models.find((model) => model.id === "qwen3.8-35b-a3b").tokens_per_second % 5, 0);
  }

  env = setup(t);
  doc = await env.sampler.getStatus();
  assert.equal(doc.models.length, 2);
  for (const model of doc.models) {
    assert.equal("ttft_p50_ms" in model, false);
    assert.equal("tokens_per_second" in model, false);
    assert.equal(model.queue, "idle");
  }

  // a telemetry source that throws is the same as none
  env.sampler.stop();
  const broken = sampler.startStatusSampler({
    getCatalogs: async () => READY_FLEET(),
    telemetry: { statusStats: async () => { throw new Error("store down"); } },
    store: env.store,
    config: CONFIG,
    now: () => NOW,
    autoStart: false,
  });
  doc = await broken.getStatus();
  assert.equal(doc.status, "operational");
  assert.equal("ttft_p50_ms" in doc.models[0], false);
});

test("uptime is a rounded percentage and the hourly bar has 168 entries", async (t) => {
  const env = setup(t, { start: Date.parse("2026-10-14T12:30:20.000Z") });
  // 60 minutes of samples in the 11:00 hour: 45 up, 15 offline; 12:00-12:29 all up
  for (let minute = 0; minute < 60; minute += 1) {
    env.store.putSample(`2026-10-14T11:${String(minute).padStart(2, "0")}`, { overall: minute < 45 ? "operational" : "offline", models: {} });
  }
  for (let minute = 0; minute < 30; minute += 1) {
    env.store.putSample(`2026-10-14T12:${String(minute).padStart(2, "0")}`, { overall: minute < 10 ? "degraded" : "operational", models: {} });
  }
  const doc = await env.sampler.getStatus();
  assert.equal(doc.uptime.hours_7d.length, 168);
  assert.deepEqual(doc.uptime.hours_7d.at(-1), { hour: "2026-10-14T12:00:00Z", up: 1 });
  assert.deepEqual(doc.uptime.hours_7d.at(-2), { hour: "2026-10-14T11:00:00Z", up: 1 });
  assert.equal(doc.uptime.hours_7d.at(-3).up, null, "an hour without samples is a gap");
  // 11:00-12:29 is 90 minutes, 75 of them up: 83.3 %
  assert.equal(doc.uptime.h24, 83.3);
  assert.equal(doc.uptime.d7, 83.3);

  // maintenance minutes leave the denominator; a hole in the samples counts as down
  const second = setup(t, { start: Date.parse("2026-10-14T12:10:20.000Z") });
  const put = (hour, minute, overall) => second.store.putSample(`2026-10-14T${hour}:${minute}`, { overall, models: {} });
  for (let minute = 0; minute < 10; minute += 1) put("12", `0${minute}`, "operational");
  for (let minute = 0; minute < 5; minute += 1) put("11", `5${minute}`, "maintenance");
  for (let minute = 55; minute < 60; minute += 1) put("11", String(minute), "operational");
  // slots 11:50..12:10 = 21, one (12:10) not sampled yet and ignored, 5 maintenance: 15 up of 15 sampled + 0 holes
  const doc2 = await second.sampler.getStatus();
  assert.equal(doc2.uptime.h24, 100);
  second.store.putSample("2026-10-14T12:10", { overall: "offline", models: {} });
  second.clock.ms += 20_000;
  second.sampler.stop();
  const fresh = sampler.startStatusSampler({ getCatalogs: async () => READY_FLEET(), store: second.store, config: CONFIG, now: () => second.clock.ms, autoStart: false });
  assert.equal((await fresh.getStatus()).uptime.h24, 93.8, "15 up of 16 non-maintenance minutes");

  const empty = setup(t);
  const emptyDoc = await empty.sampler.getStatus();
  assert.equal(emptyDoc.uptime.h24, null);
  assert.equal(emptyDoc.uptime.d7, null);
});

test("publish patterns and hidden models filter status and catalog", async (t) => {
  const catalogs = [catalog([instance([
    "qwen3.8-35b-a3b", "qwen3.8-flash", "private-research", "embed-small",
    { id: "/models/by-path/secret-weights" }, { id: "D:\\models\\local" },
  ])])];
  const env = setup(t, { catalogs, config: withConfig({ catalog: { publish: ["qwen*", "!qwen3.8-flash", "private-research", "/models/by-path/secret-weights", "D:\\models\\local"] } }) });
  env.store.modelMeta.upsert("private-research", { hidden: true, displayName: { zh: "内部", en: "Internal" } }, { actor: "test" });
  const doc = await env.sampler.getStatus();
  assert.deepEqual(doc.models.map((model) => model.id), ["qwen3.8-35b-a3b"], "pattern, exclusion, hidden flag and path-like ids");

  const data = sampler.createPublicData({ sampler: env.sampler, getCatalogs: async () => catalogs, store: env.store, config: withConfig({ catalog: { publish: ["qwen*"] } }), now: () => env.clock.ms });
  const published = await data.respond("/catalog.json", {});
  assert.deepEqual(published.models.map((model) => model.id), ["qwen3.8-35b-a3b", "qwen3.8-flash"]);

  // hiding a model through one of its aliases hides it as well
  env.store.modelMeta.upsert("qwen3.8-flash", { hidden: true }, { actor: "test" });
  env.store.modelMeta.upsert("alias-holder", { hidden: true, aliases: ["qwen3.8-35b-a3b"] }, { actor: "test" });
  const hidden = sampler.publishedModels(catalogs, { config: withConfig({ catalog: { publish: ["qwen*"] } }), store: env.store });
  assert.deepEqual(hidden, []);
});

test("catalog document carries display data, limits and optional prices", async (t) => {
  const env = setup(t);
  env.store.modelMeta.upsert("qwen3.8-35b-a3b", {
    displayName: { zh: "通义 35B", en: "Qwen3.8 35B A3B" }, description: { zh: "通用模型", en: "General model" }, recommended: true, sort: -1, aliases: ["default-chat"],
  }, { actor: "test" });
  const prices = (id) => (id === "qwen3.8-35b-a3b" ? { currency: "CNY", input_per_1m: 1, output_per_1m: 4 } : null);
  const make = (config) => sampler.createPublicData({ sampler: env.sampler, getCatalogs: async () => READY_FLEET(), store: env.store, config, getPrices: prices, now: () => env.clock.ms });
  const doc = await make(CONFIG).respond("/catalog.json", {});
  assert.equal(doc.schemaVersion, 1);
  const qwen = doc.models.find((model) => model.id === "qwen3.8-35b-a3b");
  const embed = doc.models.find((model) => model.id === "embed-small");
  assert.equal(qwen.id, "qwen3.8-35b-a3b");
  assert.deepEqual(qwen.display_name, { "zh-CN": "通义 35B", "en-US": "Qwen3.8 35B A3B" });
  assert.equal(qwen.family, "qwen3");
  assert.equal(qwen.parameters, "35B");
  assert.equal(qwen.context, 131072);
  assert.equal(qwen.max_output, 8192);
  assert.equal(qwen.tools, true);
  assert.equal(qwen.recommended, true);
  assert.deepEqual(qwen.aliases, ["default-chat"]);
  assert.deepEqual(qwen.limits, { rpm: 60, tpm: 200000, concurrency: 2, max_output_tokens: 8192 });
  assert.deepEqual(qwen.prices, { currency: "CNY", input_per_1m: 1, output_per_1m: 4 });
  assert.deepEqual(embed.modalities, ["embedding"]);
  assert.equal("prices" in embed, false);
  assert.equal(qwen.state, "ready");

  const hiddenPrices = await make(withConfig({ catalog: { showPrices: false } })).respond("/catalog.json", {});
  assert.equal("prices" in hiddenPrices.models[0], false);
});

test("announcements.json lists active and upcoming public announcements with bodies", async (t) => {
  const env = setup(t);
  announce(env.store, { title: { zh: "进行中", en: "Now" }, body: { zh: "正文", en: "Body" } });
  announce(env.store, { title: { zh: "即将", en: "Soon" }, startsAt: "2026-10-16T00:00:00.000Z" });
  announce(env.store, { title: { zh: "过期", en: "Old" }, startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-02T00:00:00.000Z" });
  announce(env.store, { title: { zh: "草稿", en: "Draft" }, published: false });
  announce(env.store, { title: { zh: "仅密钥", en: "Keys" }, audience: "keys" });
  const data = sampler.createPublicData({ sampler: env.sampler, getCatalogs: async () => [], store: env.store, config: CONFIG, now: () => env.clock.ms });
  const doc = await data.respond("/announcements.json", {});
  assert.deepEqual(doc.announcements.map((item) => [item.title["en-US"], item.active]), [["Soon", false], ["Now", true]]);
  assert.deepEqual(doc.announcements[1].body, { "zh-CN": "正文", "en-US": "Body" });
  assert.equal(await data.respond("/other.json", {}), null);
});

test("portal-config follows the configured base or the request Host", async (t) => {
  const env = setup(t);
  const make = (config) => sampler.createPublicData({
    sampler: env.sampler, getCatalogs: async () => [], store: env.store, config, getBuildId: () => ({ contentHash: "abc123" }), now: () => env.clock.ms,
  });
  const configured = await make(CONFIG).respond("/portal-config.json", { headers: { host: "ignored.example.com" } });
  assert.deepEqual(configured, {
    baseUrl: "https://api.example.com",
    openaiBase: "https://api.example.com/v1",
    anthropicBase: "https://api.example.com/anthropic",
    brand: { "zh-CN": "本地模型服务", "en-US": "Local Model Service" },
    buildId: "abc123",
    features: { playground: true, showPrices: true, tts: true },
  });
  const lan = await make({ ...CONFIG, listeners: { public: { baseUrl: "" } }, public: { ...CONFIG.public, exposeTts: false, catalog: { showPrices: false } } })
    .respond("/portal-config.json", { headers: { host: "192.168.1.20:5186" }, socket: {} });
  assert.equal(lan.baseUrl, "http://192.168.1.20:5186");
  assert.equal(lan.openaiBase, "http://192.168.1.20:5186/v1");
  assert.deepEqual(lan.features, { playground: true, showPrices: false, tts: false });
});

test("portal-config carries the short commit for the footer only when the build has one", async (t) => {
  const env = setup(t);
  const make = (getBuildId) => sampler.createPublicData({ sampler: env.sampler, getCatalogs: async () => [], store: env.store, config: CONFIG, getBuildId, now: () => env.clock.ms });
  const withCommit = await make(() => ({ contentHash: "abc123", commit: "0123456789abcdef0123" })).respond("/portal-config.json", { headers: { host: "x" } });
  assert.equal(withCommit.commit, "0123456789ab");
  for (const commit of [null, "", "not-a-hash", "<script>"]) {
    const doc = await make(() => ({ contentHash: "abc123", commit })).respond("/portal-config.json", { headers: { host: "x" } });
    assert.equal("commit" in doc, false, String(commit));
  }
  const failing = await make(() => { throw new Error("scan failed"); }).respond("/portal-config.json", { headers: { host: "x" } });
  assert.equal(failing.buildId, "");
  assert.equal("commit" in failing, false);
});

// Ports, paths, manager ids, container names, engine names and instance ids.
const INTERNALS_RE = /(?:[A-Za-z]:\\|\\\\|\/models\/|\/home\/|\/root\/|\/tmp\/|(?:^|[^\d])(?:127\.0\.0\.1|localhost)|[\w.\]]:\d{2,5}(?![\d-])|\b(?:5176|5177|5186|18000)\b|vllm|llama|sglang|manager|container|instance|fleet|primary|secret|SERVICE_ENTRY_)/i;

function withoutTimestamps(text) {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z/g, "T");
}

test("no internals appear in any public document", async (t) => {
  const env = setup(t, { stats: { requests: 10, errors5xx: 0, models: { "qwen3.8-35b-a3b": { ttftP50Ms: 412, tokensPerSecond: 61 } } } });
  announce(env.store, { title: { zh: "提示", en: "Heads up" }, body: { zh: "正文", en: "Body" } });
  const data = sampler.createPublicData({ sampler: env.sampler, getCatalogs: async () => READY_FLEET(), store: env.store, config: CONFIG, getBuildId: () => ({ contentHash: "abc123" }), now: () => env.clock.ms });
  for (const route of ["/status.json", "/catalog.json", "/announcements.json", "/portal-config.json"]) {
    const text = withoutTimestamps(JSON.stringify(await data.respond(route, { headers: { host: "api.example.com" } })));
    assert.doesNotMatch(text, INTERNALS_RE, `${route}: ${text.match(INTERNALS_RE)?.[0]}`);
    assert.ok(!text.includes("18000"), route);
  }
  // the regex really catches what it is for
  for (const bad of ["http://127.0.0.1:18000", "host:5177", "C:\\models", "vllm-manager", "sglang", "primary"]) assert.match(bad, INTERNALS_RE);
  // field allowlist of a model in /status.json
  const status = await env.sampler.getStatus();
  assert.deepEqual(Object.keys(status.models.find((model) => model.id === "qwen3.8-35b-a3b")).sort(), ["display_name", "id", "queue", "state", "tokens_per_second", "ttft_p50_ms"]);
  assert.deepEqual(Object.keys(status).sort(), ["announcements", "message", "models", "schemaVersion", "status", "updated_at", "uptime"]);
});

test("/status.json is cached for 15 s", async (t) => {
  const env = setup(t);
  const first = await env.sampler.getStatus();
  assert.equal(env.fleet.calls, 1);
  env.clock.ms += 14_000;
  assert.equal(await env.sampler.getStatus(), first, "the same document inside 15 s");
  assert.equal(env.fleet.calls, 1);
  env.fleet.catalogs = [];
  env.clock.ms += 1_000;
  const second = await env.sampler.getStatus();
  assert.equal(env.fleet.calls, 2, "rebuilt at 15 s");
  assert.equal(second.status, "offline");
  assert.notEqual(second, first);

  // concurrent readers share one build
  env.clock.ms += 20_000;
  const [a, b, c] = await Promise.all([env.sampler.getStatus(), env.sampler.getStatus(), env.sampler.getStatus()]);
  assert.equal(env.fleet.calls, 3);
  assert.ok(a === b && b === c);

  // the catalog is cached the same way
  const data = sampler.createPublicData({ sampler: env.sampler, getCatalogs: async () => { env.fleet.calls += 1; return READY_FLEET(); }, store: env.store, config: CONFIG, now: () => env.clock.ms });
  const calls = env.fleet.calls;
  const catalogA = await data.respond("/catalog.json", {});
  env.clock.ms += 10_000;
  assert.equal(await data.respond("/catalog.json", {}), catalogA);
  env.clock.ms += 6_000;
  assert.notEqual(await data.respond("/catalog.json", {}), catalogA);
  assert.equal(env.fleet.calls, calls + 2);
});

test("sampling writes one status_samples row per minute and prunes at 30 days", async (t) => {
  const env = setup(t);
  await env.sampler.sampleNow();
  assert.deepEqual(env.store.listSamples(), [{ minute: "2026-10-14T12:30", overall: "operational", models: { "qwen3.8-35b-a3b": "ready", "embed-small": "ready" } }]);
  env.clock.ms += 20_000; // same minute: the row is replaced, not duplicated
  env.fleet.catalogs = [];
  await env.sampler.sampleNow();
  const rows = env.store.listSamples();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].overall, "offline");

  // retention: 30 days. Rows older than that go, newer ones stay.
  const day = 24 * 3600_000;
  const minute = (offset) => new Date(env.clock.ms - offset).toISOString().slice(0, 16);
  env.store.putSample(minute(31 * day), { overall: "operational", models: {} });
  env.store.putSample(minute(30 * day + 5 * 60_000), { overall: "operational", models: {} });
  env.store.putSample(minute(29 * day), { overall: "operational", models: {} });
  env.store.putSample(minute(1 * day), { overall: "degraded", models: {} });
  assert.equal(env.sampler.pruneNow(), 2);
  assert.deepEqual(env.store.listSamples().map((row) => row.minute), [minute(29 * day), minute(1 * day), "2026-10-14T12:30"].sort());

  // sampleNow prunes by itself, at most once a day
  const ancient = minute(40 * day);
  env.store.putSample(ancient, { overall: "operational", models: {} });
  env.clock.ms += 60_000;
  await env.sampler.sampleNow();
  assert.equal(env.store.listSamples().some((row) => row.minute === ancient), true, "pruned within a day of the last prune");
  env.clock.ms += day;
  await env.sampler.sampleNow();
  assert.equal(env.store.listSamples().some((row) => row.minute < new Date(env.clock.ms - 30 * day).toISOString().slice(0, 16)), false, "pruned a day later");
});

test("the sampler timer samples at start and every interval, and stops", async (t) => {
  const clock = { ms: NOW };
  const store = makeStore(t, clock);
  let calls = 0;
  const running = sampler.startStatusSampler({
    getCatalogs: async () => { calls += 1; return READY_FLEET(); }, store, config: CONFIG, intervalMs: 20, now: () => clock.ms,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  running.stop();
  const seen = calls;
  assert.ok(seen >= 2, `sampled repeatedly (${seen})`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, seen, "no sample after stop");
  assert.throws(() => sampler.startStatusSampler({ store, config: CONFIG }), /getCatalogs/);
  assert.throws(() => sampler.startStatusSampler({ getCatalogs() {}, config: CONFIG }), /store/);
});

// ---- the PUBLIC listener serves the documents ------------------------------

async function serve(t, data) {
  const security = { publicHostnames: () => new Set(["127.0.0.1"]) };
  const listener = createPublicListener({ security, data, logger: { error() {} } });
  const server = http.createServer((req, res) => listener.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return (pathname, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: pathname, method: options.method || "GET", headers: { host: "127.0.0.1" } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("public-listener serves the four JSON routes with cache headers", async (t) => {
  const env = setup(t);
  const data = sampler.createPublicData({ sampler: env.sampler, getCatalogs: async () => READY_FLEET(), store: env.store, config: CONFIG, getBuildId: () => ({ contentHash: "abc123" }), now: () => env.clock.ms });
  const get = await serve(t, data);
  for (const route of ["/status.json", "/catalog.json", "/announcements.json"]) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers["content-type"], /^application\/json/);
    assert.equal(response.headers["cache-control"], "public, max-age=15");
    assert.equal(JSON.parse(response.text).schemaVersion, 1);
  }
  const portal = await get("/portal-config.json");
  assert.equal(portal.status, 200);
  assert.equal(portal.headers["cache-control"], "no-cache");
  assert.equal(JSON.parse(portal.text).buildId, "abc123");
  const head = await get("/status.json", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.equal((await get("/status.json?probe=abc")).status, 200);
  assert.equal((await get("/api/status.json")).status, 404);
  assert.equal((await get("/status.json", { method: "POST" })).status, 404);
});

test("a failing data source answers 503 without detail, and no data falls back to the portal handler", async (t) => {
  const failing = await serve(t, { respond: async () => { throw new Error("C:\\secret\\path exploded"); } });
  const response = await failing("/status.json");
  assert.equal(response.status, 503);
  assert.doesNotMatch(response.text, /secret|exploded/);

  const security = { publicHostnames: () => new Set(["127.0.0.1"]) };
  const portal = { handle: (req, res) => { res.end("portal"); return true; } };
  const listener = createPublicListener({ security, portal, logger: { error() {} } });
  const server = http.createServer((req, res) => listener.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const text = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: "/status.json", headers: { host: "127.0.0.1" } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    });
  });
  assert.equal(text, "portal");
});

// ---- golden ------------------------------------------------------------------

test("golden /status.json for a fixed fleet, clock and history", async (t) => {
  const catalogs = [catalog([
    instance([{ id: "qwen3.8-35b-a3b" }, { id: "qwen3.8-flash" }, { id: "hidden-eval" }]),
    instance(["slow-loader"], { id: "second", instanceId: "second", lifecycleState: "loading", status: "starting" }),
  ])];
  const env = setup(t, {
    catalogs,
    stats: { requests: 240, errors5xx: 3, models: { "qwen3.8-35b-a3b": { ttftP50Ms: 372, tokensPerSecond: 87.4, running: 1 }, "qwen3.8-flash": { ttftP50Ms: 118, tokensPerSecond: 212, waiting: 2 } } },
  });
  env.store.modelMeta.upsert("hidden-eval", { hidden: true }, { actor: "test" });
  env.store.modelMeta.upsert("qwen3.8-35b-a3b", { displayName: { zh: "通义 35B", en: "Qwen3.8 35B A3B" } }, { actor: "test" });
  announce(env.store, {
    severity: "info", title: { zh: "周末升级", en: "Weekend upgrade" }, startsAt: "2026-10-14T08:00:00.000Z", endsAt: "2026-10-16T08:00:00.000Z",
  });
  // two days of history: an offline stretch and a degraded stretch
  const start = Date.parse("2026-10-12T12:30:00.000Z");
  for (let minute = 0; minute < 48 * 60; minute += 1) {
    const at = start + minute * 60_000;
    const hour = new Date(at).getUTCHours();
    const day = new Date(at).getUTCDate();
    const overall = day === 13 && hour >= 3 && hour < 5 ? "offline" : day === 13 && hour === 20 ? "degraded" : "operational";
    env.store.putSample(new Date(at).toISOString().slice(0, 16), { overall, models: {} });
  }
  const live = await env.sampler.getStatus();
  // announcement ids are random; the golden pins everything else
  const doc = { ...live, announcements: live.announcements.map((item, index) => ({ ...item, id: `an_fixed${index}` })) };
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(GOLDEN_PATH, text);
  assert.deepEqual(doc, JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8")));
  assert.equal(doc.status, "degraded");
  assert.equal(doc.uptime.hours_7d.length, 168);
});
