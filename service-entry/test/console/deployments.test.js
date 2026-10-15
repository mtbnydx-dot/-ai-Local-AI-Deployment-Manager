// CON-9 (07 §6.2): the pure parts of the Deployments pages, run in Node with
// the real catalogs and formatters. Rendering, Stop, Wake, the logs poll and
// the routing page are covered in a browser by
// tests/frontend/console/console-deployments.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { mergeI18nAreas } = require("../../lib/console-routes.js");
const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);

const FIXTURES = path.resolve(CONSOLE_DIR, "..", "..", "tests", "fixtures", "console", "deployments");
const NOW = Date.parse("2026-10-14T12:00:00Z");
const catalogs = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n")).catalogs;

const { createI18n } = await load("lib/i18n.js");
const { createFormatters } = await load("lib/format.js");
const model = await load("lib/deployments-model.js");
const schemas = await load("lib/schemas.js");
const { check } = await load("lib/guards.js");

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
function resolve(value) {
  if (typeof value === "string") {
    const match = /^@now(?:([-+])(\d+)([mhd]))?$/.exec(value);
    if (!match) return value;
    const offset = match[1] ? (match[1] === "-" ? -1 : 1) * Number(match[2]) * UNITS[match[3]] : 0;
    return new Date(NOW + offset).toISOString();
  }
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  return value;
}
const fixture = (name) => resolve(JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")));

function contexts(locale) {
  const i18n = createI18n({ locale, catalog: catalogs[locale] });
  return { i18n, fmt: createFormatters(locale), ctx: { t: i18n.t, fmt: createFormatters(locale) } };
}

const FEEDS = () => [
  { managerId: "vllm", instances: fixture("instances-vllm") },
  { managerId: "llama", instances: fixture("instances-llama") },
];

test("the fixtures pass the console guards", () => {
  assert.equal(check(schemas.FleetGuard, fixture("fleet")).ok, true);
  for (const name of ["instances-vllm", "instances-llama"]) {
    for (const instance of fixture(name).instances) assert.equal(check(schemas.InstanceGuard, instance).ok, true, `${name} ${instance.id}`);
  }
  assert.equal(check(schemas.InstanceMetricsGuard, fixture("metrics")).ok, true);
  for (const row of fixture("requests").rows) assert.equal(check(schemas.RequestRowGuard, row).ok, true);
});

test("the fleet and the managers' typed instances merge into one keyed row per instance", () => {
  const { rows, sleeping } = model.buildDeployments({ fleet: fixture("fleet"), managers: FEEDS(), live: fixture("telemetry-live"), requests: model.requestsByFleet(fixture("breakdown-fleet")), now: NOW });
  assert.deepEqual(rows.map((item) => item.key), ["vllm:primary", "llama:primary"]);
  const [ready, crashed] = rows;
  assert.equal(ready.state, "ready");
  assert.equal(ready.model, "qwen3-demo-32b");
  assert.equal(ready.engine, "sglang@0.5.17");
  assert.equal(ready.engineId, "sglang");
  assert.equal(ready.recipeId, "qwen38-flashnext-262k");
  assert.equal(ready.launchId, "lch_aaaaaaaaaaaaaaaaaaaa");
  assert.equal(ready.port, 8000);
  assert.equal(ready.context, 262144);
  assert.equal(ready.vramMb, 88000);
  assert.deepEqual(ready.gpus, ["0"]);
  assert.equal(ready.tps, 92.4);
  assert.equal(ready.requests1h, 57);
  assert.equal(ready.uptimeMs, 2 * UNITS.h);
  assert.equal(crashed.state, "crashed");
  assert.equal(crashed.engine, "llamacpp@b10630");
  assert.equal(crashed.tps, null);
  assert.equal(crashed.requests1h, null);
  assert.equal(crashed.uptimeMs, null);
  assert.equal(sleeping.length, 1);
  assert.equal(sleeping[0].state, "sleeping");
  assert.equal(sleeping[0].sleepId, "slp_demo000000000000000a");
  assert.equal(sleeping[0].fleetId, "vllm:slp_demo000000000000000a");
  assert.equal(sleeping[0].model, "demo-moe-30b");
  assert.equal(sleeping[0].wakeable, true);
  assert.equal(sleeping[0].sleptForMs, UNITS.h);
});

test("without the fleet the managers' instances still make rows; a manager-only instance is keyed by manager and id", () => {
  const { rows } = model.buildDeployments({ fleet: null, managers: FEEDS(), now: NOW });
  assert.deepEqual(rows.map((item) => item.key), ["vllm:primary", "llama:primary"]);
  assert.equal(rows[0].state, "ready");
  assert.equal(rows[0].model, "qwen3-demo-32b");
});

test("a loading instance shows its percent and phase; the manager's lifecycle beats the container status", () => {
  const instances = { instances: [{ id: "second", running: true, status: "Up 3 seconds", port: 8001, engineId: "vllm", lifecycle: { state: "loading", phase: "weights", percent: 42, since: "@now-1m", phaseHistory: [] }, models: [] }] };
  const { rows } = model.buildDeployments({ fleet: null, managers: [{ managerId: "vllm", instances: resolve(instances) }], now: NOW });
  assert.equal(rows[0].state, "loading");
  assert.equal(rows[0].percent, 42);
  assert.equal(rows[0].phase, "weights");
});

test("the idle-unload ledger supplies sleeping rows before 01, without duplicating typed records", () => {
  const idle = { ok: true, sleeping: [{ id: "slp_old0000000000000001", model: "old-model", name: "old", engine: "vllm", sleptAt: "2026-10-14T11:00:00Z", vramMb: 1000, hasConfig: true }] };
  const { sleeping } = model.buildDeployments({ managers: [{ managerId: "vllm", instances: { instances: [] }, idle }], now: NOW });
  assert.equal(sleeping.length, 1);
  assert.equal(sleeping[0].sleepId, "slp_old0000000000000001");
  assert.equal(sleeping[0].model, "old-model");
  assert.equal(sleeping[0].vramMb, 1000);
  const both = model.buildDeployments({ managers: [{ managerId: "vllm", instances: fixture("instances-vllm"), idle: { sleeping: [{ id: "slp_demo000000000000000a", model: "demo-moe-30b" }] } }], now: NOW });
  assert.equal(both.sleeping.length, 1);
});

test("filters and their options", () => {
  const { rows } = model.buildDeployments({ fleet: fixture("fleet"), managers: FEEDS(), now: NOW });
  assert.deepEqual(model.filterRows(rows, { manager: "llama" }).map((item) => item.key), ["llama:primary"]);
  assert.deepEqual(model.filterRows(rows, { engine: "sglang" }).map((item) => item.key), ["vllm:primary"]);
  assert.deepEqual(model.filterRows(rows, { state: "crashed" }).map((item) => item.key), ["llama:primary"]);
  assert.equal(model.filterRows(rows, { manager: "all", state: "" }).length, 2);
  assert.deepEqual(model.filterOptions(rows, [{ id: "vllm" }, { id: "llama" }]), { engines: ["llamacpp", "sglang"], managers: ["vllm", "llama"], states: ["ready", "crashed"] });
  assert.equal(model.cleanFilter("llama", ["vllm", "llama"]), "llama");
  assert.equal(model.cleanFilter("nope", ["vllm", "llama"]), "");
});

test("lifecycle steps take their durations from phaseHistory; without a history a ready instance has none", () => {
  const ready = fixture("instances-vllm").instances[0];
  const steps = model.lifecycleSteps(ready);
  assert.deepEqual(steps.map((step) => step.id), model.PHASES);
  const by = Object.fromEntries(steps.map((step) => [step.id, step]));
  assert.equal(by.pull.state, "skipped");
  assert.equal(by.pull.durationMs, undefined);
  assert.equal(by.weights.state, "done");
  assert.equal(by.weights.durationMs, 95000);
  assert.equal(by.ready.state, "done");
  assert.deepEqual(model.lifecycleSteps({ lifecycle: { state: "ready", phaseHistory: [] } }), []);
  const loading = model.lifecycleSteps({ lifecycle: { state: "loading", phase: "weights", percent: 40, phaseHistory: [{ phase: "pull", durationMs: 500 }, { phase: "admission", durationMs: 100 }, { phase: "container", durationMs: 2000 }] } });
  assert.deepEqual(loading.map((step) => step.state), ["done", "done", "done", "active", "pending", "pending", "pending", "pending", "pending"]);
  const crashed = model.lifecycleSteps({ lifecycle: { state: "crashed", phase: null, phaseHistory: [{ phase: "admission", durationMs: 10 }, { phase: "container", durationMs: 20 }] } });
  assert.equal(crashed.find((step) => step.id === "container").state, "error");
  assert.equal(crashed.find((step) => step.id === "admission").state, "done");
  assert.equal(crashed.find((step) => step.id === "weights").state, "pending");
});

test("endpoints: local, LAN, the manager's gateway path and the auto route; capability ids", () => {
  const fleetItem = fixture("fleet").instances[0];
  const endpoints = model.endpointsOf(fleetItem, { managerId: "vllm", origin: "https://console.example", autoPath: "/gateway/auto/openai/v1" });
  assert.deepEqual(endpoints.map((item) => item.id), ["local", "lan", "gateway", "auto"]);
  assert.equal(endpoints[2].url, "https://console.example/gateway/vllm/openai/v1");
  assert.deepEqual(model.endpointsOf({}, { managerId: "vllm", origin: "" }), []);
  assert.deepEqual(model.capabilityIds(fixture("instances-vllm").instances[0]), ["text", "tools", "reasoning"]);
  assert.deepEqual(model.capabilityIds(fleetItem), ["text", "tools"]);
});

test("metrics tiles: values, a histogram summary, unsupported keys and absent keys (never 0)", () => {
  const en = contexts("en-US");
  const tiles = model.metricsTiles(fixture("metrics"), en.ctx);
  assert.deepEqual(tiles.map((tile) => tile.id), ["kv", "running", "waiting", "ttftP50", "ttftP95"]);
  const by = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
  assert.equal(by.kv.value, "31.0%");
  assert.equal(by.kv.span, "now");
  assert.equal(by.running.value, "1");
  assert.equal(by.waiting.state, "unsupported");
  assert.equal(by.waiting.value, null);
  assert.equal(by.waiting.note, "Not reported by this engine");
  assert.equal(by.ttftP50.value, "310");
  assert.equal(by.ttftP50.unit, "ms");
  assert.equal(by.ttftP50.note, "912 requests");
  assert.equal(by.ttftP95.value, "1,200");
  assert.equal(by.ttftP95.span, "since process start");
  for (const tile of tiles) assert.ok(tile.span, `${tile.id} has a window`);

  const sparse = model.metricsTiles({ metrics: { kvUsageRatio: 0 }, unsupported: ["histograms.ttftSeconds"] }, en.ctx);
  const sparseBy = Object.fromEntries(sparse.map((tile) => [tile.id, tile]));
  assert.equal(sparseBy.kv.value, "0.0%", "a real zero stays a zero");
  assert.equal(sparseBy.running.state, "missing");
  assert.equal(sparseBy.running.value, null);
  assert.equal(sparseBy.ttftP50.state, "unsupported");
  assert.equal(sparseBy.ttftP95.state, "unsupported");

  const noSample = model.metricsTiles({ metrics: null, scrapeOk: false, errorCode: "no_sample", unsupported: [] }, en.ctx);
  assert.ok(noSample.every((tile) => tile.state === "missing" && tile.value === null));
  assert.equal(noSample[0].note, "No sample yet");

  const zh = contexts("zh-CN");
  assert.equal(model.metricsTiles(fixture("metrics"), zh.ctx)[2].note, "本引擎不提供");
});

test("a bare key and a family-qualified key both mark a metric unsupported", () => {
  const en = contexts("en-US");
  for (const unsupported of [["requestsRunning"], ["gauges.requestsRunning"]]) {
    const tile = model.metricsTiles({ metrics: { requestsRunning: 3 }, unsupported }, en.ctx).find((item) => item.id === "running");
    assert.equal(tile.state, "unsupported");
  }
});

test("chart series share one x axis in epoch seconds and keep gaps as null", () => {
  const chart = model.chartSeries(fixture("timeseries"), (item) => item.metric);
  assert.deepEqual(chart.x, [1760000000, 1760000300, 1760000600]);
  const kv = chart.series.find((item) => item.id === "rt.kv_usage");
  assert.deepEqual(kv.values, [0.2, 0.31, null]);
  assert.equal(chart.series.length, 6);
  assert.deepEqual(model.chartSeries(null), { x: [], series: [] });
});

test("wake: the refusals are told apart, the path carries the sleep record id", () => {
  assert.deepEqual(model.wakeProblem({ status: 409, code: "wake_would_replace_running", details: { runningModel: "Qwen3-Demo" } }), { kind: "replace", model: "Qwen3-Demo" });
  assert.deepEqual(model.wakeProblem({ status: 409, code: "wake_api_key_missing" }), { kind: "key", model: "" });
  assert.equal(model.wakeProblem({ status: 500, code: "http_500" }).kind, "other");
  assert.equal(model.wakeProblem({ status: 404, code: "wake_would_replace_running" }).kind, "other", "only a 409 asks");
  assert.equal(model.wakePath("vllm", "slp_demo000000000000000a"), "/api/m/vllm/idle-unload/slp_demo000000000000000a/wake");
});

test("relaunch and clone open the wizard's Review; nothing here starts a launch", () => {
  assert.equal(model.relaunchHref({ managerId: "vllm", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", instanceId: "primary" }), "/deployments/new?clone=lch_aaaaaaaaaaaaaaaaaaaa&manager=vllm&step=review&from=relaunch&instance=primary");
  assert.equal(model.relaunchHref({ managerId: "llama" }), "/deployments/new?manager=llama&step=review&from=relaunch");
  assert.equal(model.cloneHref({ managerId: "vllm", launchId: "lch_aaaaaaaaaaaaaaaaaaaa" }), "/deployments/new?clone=lch_aaaaaaaaaaaaaaaaaaaa&manager=vllm");
});

test("routing bodies match the classic console exactly", () => {
  assert.deepEqual(model.modeBody("multimodal"), { mode: "multimodal" });
  assert.equal(model.modeBody("turbo"), null);
  assert.deepEqual(model.policyBody({ maxUtilizationPct: "90.5", reserveGiB: "6.5" }), { maxUtilizationPct: 90.5, reserveMb: 6656 });
  assert.deepEqual(model.policyBody({ maxUtilizationPct: 85, reserveGiB: 8 }), { maxUtilizationPct: 85, reserveMb: 8192 });
  assert.equal(model.policyBody({ maxUtilizationPct: 9, reserveGiB: 1 }), null);
  assert.equal(model.policyBody({ maxUtilizationPct: 100, reserveGiB: 1 }), null);
  assert.equal(model.policyBody({ maxUtilizationPct: 85, reserveGiB: 300 }), null);
  assert.equal(model.policyBody({ maxUtilizationPct: "", reserveGiB: 1 }), null);
  assert.deepEqual(model.previewBody({ capability: "vision", model: " qwen3-demo-32b " }), { capability: "vision", engine: "auto", protocol: "openai", model: "qwen3-demo-32b" });
  assert.deepEqual(model.previewBody({ capability: "text", model: "" }), { capability: "text", engine: "auto", protocol: "openai" });
  assert.deepEqual(Object.keys(model.previewBody({ capability: "text", model: "x" })).sort(), ["capability", "engine", "model", "protocol"]);
  assert.equal(model.previewBody({ capability: "telepathy" }).capability, "text");
  assert.equal(model.gibOfMb(8192), "8");
  assert.equal(model.gibOfMb(6656), "6.5");
});

test("GPU headroom: the API's figure, the room inside the protect line, and the smaller of the two", () => {
  const head = model.gpuHeadroom(fixture("fleet"));
  assert.equal(head.totalMb, 97887);
  assert.equal(head.allocatableMb, 17070);
  assert.equal(head.protectPct, 85);
  assert.equal(head.protectHeadroomMb, Math.floor(97887 * 0.85) - 72625);
  assert.equal(head.recommendedMb, head.protectHeadroomMb);
  assert.equal(model.gpuHeadroom({ instances: [] }), null);
  assert.deepEqual(model.routableCounts(fixture("fleet")), { routable: 1, other: 1, total: 2 });
});

test("route preview outcomes: a target, an unroutable answer and a failed request", () => {
  const ok = model.previewOutcome({
    ok: true, capability: "text", reason: "generic_text", policy: { mode: "balanced" },
    manager: { id: "vllm", name: "vLLM Manager" }, instance: { id: "primary", instanceId: "primary" }, model: { id: "qwen3-demo-32b" },
  });
  assert.deepEqual(ok, { ok: true, model: "qwen3-demo-32b", manager: "vLLM Manager", instance: "primary", capability: "text", reason: "generic_text", policy: "balanced" });
  const none = model.previewOutcome({ ok: false, status: 503, error: "capability_not_available", message: "No running model provides the required vision capability.", capability: "vision" });
  assert.deepEqual(none, { ok: false, code: "capability_not_available", message: "No running model provides the required vision capability.", capability: "vision" });
  const failed = model.previewOutcome(Object.assign(new Error("boom"), { code: "network_error", details: null }), { capability: "text" });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "network_error");
  assert.equal(failed.capability, "text");
  const http = model.previewOutcome(Object.assign(new Error("capability_not_available"), { code: "http_503", details: { reason: "none running", capability: "audio" } }));
  assert.equal(http.code, "capability_not_available");
  assert.equal(http.message, "none running");
  assert.equal(http.capability, "audio");
});

test("log lines: a replayed boundary block is dropped, a single repeated line is kept, fresh lines append", () => {
  const have = ["a", "b", "c"];
  assert.deepEqual(model.newLogLines(have, ["b", "c", "d"]), ["d"]);
  assert.deepEqual(model.newLogLines(have, ["a", "b", "c"]), [], "a manager that ignores since replays the whole tail");
  assert.deepEqual(model.newLogLines(have, ["d", "e"]), ["d", "e"]);
  assert.deepEqual(model.newLogLines(have, ["c", "d"]), ["c", "d"], "one repeated line may be a real health-check line");
  assert.deepEqual(model.newLogLines([], ["x", "y"]), ["x", "y"]);
  assert.deepEqual(model.newLogLines(have, []), []);
  // Repeated health lines, polled again and again, are never swallowed.
  let shown = ["GET /health 200"];
  for (let poll = 0; poll < 3; poll += 1) shown = shown.concat(model.newLogLines(shown, ["GET /health 200"]));
  assert.equal(shown.length, 4);
  const window = Array.from({ length: 300 }, (_, index) => `line ${index}`);
  assert.deepEqual(model.newLogLines(window, window.slice(250).concat(["new"])), ["new"], "the compared tail is bounded but still finds the overlap");
});

test("log replies are read as lines, whatever the reply shape", () => {
  assert.deepEqual(model.logLinesOf({ ok: true, text: "a\r\nb\n" }), ["a", "b"]);
  assert.deepEqual(model.logLinesOf({ lines: ["x", "y"] }), ["x", "y"]);
  assert.deepEqual(model.logLinesOf({ text: "" }), []);
  assert.deepEqual(model.logLinesOf(null), []);
});

test("recent launches and profiles read from the managers' own shapes", () => {
  assert.deepEqual(model.recentEntries(fixture("recent-launches")).map((item) => [item.model, item.launchId]), [["qwen3-demo-32b", null]]);
  assert.deepEqual(model.recentEntries({ launches: [{ model: "p", name: "n", launchId: "lch_x" }] })[0].key, "lch_x");
  assert.deepEqual(model.profileEntries(fixture("profiles")), [
    { id: "my-fast", name: "My fast profile", builtin: false },
    { id: "balanced-demo", name: "Balanced demo", builtin: true },
  ]);
  assert.deepEqual(model.profileEntries(null), []);
});

test("every deploy.* catalog key used by the pages has both a zh and an en text", () => {
  for (const key of ["deploy.wake.replaceBody", "deploy.wake.keyBody", "deploy.routing.counts", "deploy.metrics.unsupported", "deploy.sleeping.title"]) {
    assert.ok(catalogs["zh-CN"][key], `${key} zh`);
    assert.ok(catalogs["en-US"][key], `${key} en`);
  }
  const en = contexts("en-US").i18n;
  assert.equal(en.t("deploy.wake.replaceBody", { model: "M" }), "Waking will stop and replace the running model \"M\". Continue?");
  const zh = contexts("zh-CN").i18n;
  assert.equal(zh.t("deploy.wake.replaceBody", { model: "M" }), "唤醒会停止并替换正在运行的「M」。确定继续？");
  assert.equal(zh.t("deploy.wake.keyBody"), "原 API Key 已不可用，请从启动页重新启动该模型。");
});
