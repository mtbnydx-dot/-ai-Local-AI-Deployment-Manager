// CON-8 (07 §6.1): the pure parts of the Overview page, run in Node with the
// real catalogs and formatters. Rendering, the readiness banner, the dry-run
// plan and axe are covered in a browser by tests/frontend/console/console-overview.spec.js.

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

const FIXTURES = path.resolve(CONSOLE_DIR, "..", "..", "tests", "fixtures", "console", "overview");
const NOW = Date.parse("2026-10-14T12:00:00Z");
const catalogs = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n")).catalogs;

const { createI18n } = await load("lib/i18n.js");
const { createFormatters } = await load("lib/format.js");
const model = await load("lib/overview-model.js");
const { gpuSummary } = await load("components/status-strip.js");

// "@now", "@now-2h", "@now+2d" in a fixture become ISO times around NOW.
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

test("degrade path: tiles 1 and 2 name the gateway log lines, tile 3 needs telemetry, every tile has a window", () => {
  const en = contexts("en-US");
  const tiles = model.buildTiles({ gateway: fixture("gateway-access"), fleet: fixture("fleet-serving") }, en.ctx);
  assert.deepEqual(tiles.map((tile) => tile.id), ["requests", "output", "ttft", "gpu"]);
  for (const tile of tiles) assert.ok(tile.span, `${tile.id} has a window`);
  const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
  assert.equal(byId.requests.span, "last 2,000 gateway log lines");
  assert.equal(byId.output.span, "last 2,000 gateway log lines");
  assert.equal(byId.requests.value, "1,240");
  assert.equal(byId.requests.note, "errors 40 (3.2%)");
  assert.equal(byId.output.value, "440,000");
  assert.equal(byId.ttft.value, null);
  assert.equal(byId.ttft.note, "Needs the telemetry backend");
  assert.equal(byId.ttft.span, "last 1 h");
  assert.equal(byId.gpu.value, "88", "the fleet's gpuMemory serves tile 4 without telemetry");
  assert.equal(byId.gpu.source, "fleet");
  const zh = contexts("zh-CN");
  const zhTiles = model.buildTiles({ gateway: fixture("gateway-access") }, zh.ctx);
  assert.equal(zhTiles[0].span, "最近 2,000 行网关日志");
  assert.equal(zhTiles[2].note, "需要遥测后端");
});

test("with telemetry: 24 h and 1 h windows, errors with their share, current tok/s, GPU used and total", () => {
  const en = contexts("en-US");
  const live = fixture("telemetry-live");
  const tiles = model.buildTiles({
    summary24: fixture("telemetry-summary-24h"), summary1h: fixture("telemetry-summary-1h"), live, gpu: gpuSummary(live), gateway: fixture("gateway-access"),
  }, en.ctx);
  const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
  assert.equal(byId.requests.span, "last 24 h", "telemetry wins over the gateway log");
  assert.equal(byId.requests.value, "1,240");
  assert.equal(byId.requests.note, "errors 37 (3.0%)");
  assert.equal(byId.output.note, "now 85.2 tok/s");
  assert.equal(byId.ttft.value, "640");
  assert.equal(byId.ttft.unit, "ms");
  assert.equal(byId.ttft.note, "57 requests");
  assert.equal(byId.gpu.value, "88");
  assert.deepEqual(byId.gpu.denominator, { value: "95.6", label: "GiB" });
  assert.equal(byId.gpu.note, "87% utilization");
  assert.equal(byId.gpu.span, "now");
});

test("tiles without any source show no figure and no invented note", () => {
  const tiles = model.buildTiles({}, contexts("en-US").ctx);
  assert.deepEqual(tiles.map((tile) => tile.value), [null, null, null, null]);
  assert.equal(tiles[0].note, null);
  assert.equal(tiles[3].denominator, undefined);
  for (const tile of tiles) assert.ok(tile.span);
});

test("needs attention: alerts, failed jobs and downloads of the last 24 h, failing checks, keys within 7 days", () => {
  const en = contexts("en-US");
  const managers = [{ id: "vllm", label: { zh: "vLLM 管理器", en: "vLLM manager" } }];
  const result = model.buildAttention({
    alerts: fixture("alerts-firing"),
    jobs: [{ managerId: "vllm", data: fixture("jobs-vllm") }],
    downloads: fixture("downloads-failed"),
    doctor: fixture("doctor"),
    keys: fixture("keys-expiring"),
    managers,
    now: NOW,
  }, en.i18n, en.fmt);
  assert.deepEqual(result.items.map((item) => item.kind), ["alert", "job", "download", "doctor", "key"]);
  assert.equal(result.more, 0);
  const [alert, job, download, doctor, key] = result.items;
  assert.equal(alert.text, "GPU temperature is high");
  assert.equal(alert.tone, "danger");
  assert.equal(alert.href, "/alerts");
  assert.equal(job.text, "Job failed: Launch demo-70b", "the 49 h old failure is left out");
  assert.equal(job.detail, "vLLM manager · Out of GPU memory");
  assert.equal(job.href, "/deployments?manager=vllm");
  assert.equal(download.text, "Download failed: demo/model-8b");
  assert.equal(download.detail, "Network interrupted");
  assert.equal(download.href, "/models/downloads");
  assert.equal(doctor.text, "Check failing: Docker engine", "warn and ok checks are not listed");
  assert.equal(doctor.href, "/system/doctor");
  assert.equal(key.text, "Key demo-client is about to expire");
  assert.equal(key.href, "/access/keys/key_a1");
  for (const item of result.items) assert.ok(item.action && item.href, `${item.kind} has an action link`);
});

test("needs attention: a key beyond 7 days or revoked is left out, an expired one is danger, and the list is capped", () => {
  const en = contexts("en-US");
  const keys = { items: [
    { id: "far", name: "far", status: "active", expiresAt: new Date(NOW + 9 * 86_400_000).toISOString() },
    { id: "gone", name: "gone", status: "revoked", expiresAt: new Date(NOW + 86_400_000).toISOString() },
    { id: "late", name: "late", status: "active", expiresAt: new Date(NOW - 3_600_000).toISOString() },
    { id: "none", name: "none", status: "active", expiresAt: null },
  ] };
  const one = model.buildAttention({ keys, now: NOW }, en.i18n, en.fmt);
  assert.deepEqual(one.items.map((item) => item.id), ["key:late"]);
  assert.equal(one.items[0].tone, "danger");
  assert.match(one.items[0].detail, /^expired /);

  const rows = Array.from({ length: 11 }, (_, index) => ({ ruleId: `r${index}`, scopeKey: "s", state: "firing", severity: "warn", title: `Alert ${index}` }));
  const capped = model.buildAttention({ alerts: { rows }, now: NOW }, en.i18n, en.fmt);
  assert.equal(capped.items.length, model.ATTENTION_MAX);
  assert.equal(capped.more, 3);
});

test("deployment rows: stopped instances are left out; engine@version, port, context and live tok/s are filled", () => {
  const rows = model.deploymentRows(fixture("fleet-serving"), fixture("telemetry-live"));
  assert.deepEqual(rows.map((row) => row.key), ["vllm:primary", "llama:second"]);
  const [ready, loading] = rows;
  assert.equal(ready.state, "ready");
  assert.equal(ready.managerId, "vllm");
  assert.equal(ready.instanceId, "primary");
  assert.equal(ready.engine, "sglang@0.5.17");
  assert.equal(ready.port, 8000);
  assert.equal(ready.context, 262144);
  assert.equal(ready.tps, 92.4);
  assert.equal(loading.state, "loading");
  assert.equal(loading.percent, 42);
  assert.equal(loading.context, null);
  assert.equal(loading.tps, null, "no live sample is shown as a dash, not 0");
  assert.deepEqual(model.deploymentRows({ instances: [] }), []);
  assert.deepEqual(model.deploymentRows(null), []);
});

test("deployment rows accept the legacy fleet shape where the id already carries the manager", () => {
  const rows = model.deploymentRows({ instances: [{ id: "vllm:primary", instanceId: "vllm:primary", engineId: "vllm", lifecycleState: "ready", running: true, models: [{ id: "m" }] }] });
  assert.equal(rows[0].fleetId, "vllm:primary");
  assert.equal(rows[0].managerId, "vllm");
  assert.equal(rows[0].instanceId, "primary", "the stop route takes the instance id without the manager prefix");
});

test("recent activity: newest first, one line per event, at most 20, from the event ring or from 04 rows", () => {
  const en = contexts("en-US");
  const managers = [{ id: "vllm", label: { zh: "vLLM 管理器", en: "vLLM manager" } }];
  const ring = model.buildActivity(fixture("events-recent"), en.i18n, { managers });
  assert.deepEqual(ring.map((row) => row.id), ["k3f9a2-4", "k3f9a2-3", "k3f9a2-2", "k3f9a2-1"]);
  assert.deepEqual(ring.map((row) => row.text), [
    "Last session's models are not running",
    "vLLM manager: instances changed (1)",
    "vLLM manager: Launch demo · running",
    "vLLM manager: manager came online",
  ]);
  const rows = model.buildActivity(fixture("telemetry-events"), en.i18n);
  assert.deepEqual(rows.map((row) => row.text), ["Launch ready in 545 s", "GPU temperature is high"]);
  const many = { events: Array.from({ length: 30 }, (_, index) => ({ id: `e${index}`, type: "status", at: new Date(NOW - index * 1000).toISOString(), data: { reason: "manager_up", managerId: "vllm" } })) };
  assert.equal(model.buildActivity(many, en.i18n).length, model.ACTIVITY_MAX);
  assert.deepEqual(model.buildActivity(null, en.i18n), []);
  const zh = contexts("zh-CN");
  assert.equal(model.buildActivity(fixture("events-recent"), zh.i18n, { managers })[0].text, "上次的模型尚未恢复");
});

test("an unknown status reason and job status stay readable instead of showing a raw key", () => {
  const en = contexts("en-US");
  const rows = model.buildActivity({ events: [
    { id: "a", type: "status", at: "@now", data: { reason: "something_new", managerId: "llama" } },
    { id: "b", type: "jobs", at: "@now", data: { managerId: "llama", jobs: [{ id: "j", status: "odd" }] } },
  ] }, en.i18n);
  for (const row of rows) assert.equal(/overview\./.test(row.text), false, row.text);
});

test("the overview fixtures hold no user names, machine names or absolute paths", () => {
  for (const file of fs.readdirSync(FIXTURES).filter((item) => item.endsWith(".json"))) {
    const text = fs.readFileSync(path.join(FIXTURES, file), "utf8");
    assert.equal(/[A-Za-z]:\\|\/Users\/|\/home\/|@[\w-]+\.[A-Za-z]{2,}/.test(text), false, `${file} names a path or an address`);
    JSON.parse(text);
  }
});
