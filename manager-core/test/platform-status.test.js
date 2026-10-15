"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const configApi = require("../platform/config");
const componentsApi = require("../platform/components");
const statusApi = require("../platform/status");
const { createFakeClock, createWorld } = require("./fixtures/platform/supervisor-world");

const GOLDEN_DIR = path.join(__dirname, "fixtures", "platform");
const SCHEMAS = path.join(__dirname, "..", "..", "service-entry", "console", "lib", "schemas.js");
const BUILD = { commit: "c0146a7d2f1e", contentHash: "3f9c2a1b7d0e" };
const OPS = { nightly: { ok: false, streak: 30, since: "2026-09-14" }, backup: { ageHours: 4.5, ok: true } };
const DOCTOR = {
  schemaVersion: 1, at: "2026-10-14T07:59:00.000Z", durationMs: 412, summary: { ok: 4, warn: 0, fail: 0, info: 0, skip: 0 },
  checks: [
    { id: "env.node-version", group: "env", status: "ok", data: {} },
    { id: "env.node-sqlite", group: "env", status: "ok", data: {} },
    { id: "runtime.docker-daemon", group: "runtime", status: "ok", data: { ready: true, version: "28.4.0" } },
    { id: "runtime.nvidia-driver", group: "runtime", status: "ok", data: { gpus: [{ driverVersion: "581.15", name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", computeCapability: "12.0", memoryMb: 97887 }] } },
  ],
};

// UPDATE_PLATFORM_STATUS_GOLDENS=1 rewrites the goldens; review the diff.
function matchGolden(name, actual) {
  const file = path.join(GOLDEN_DIR, name);
  if (process.env.UPDATE_PLATFORM_STATUS_GOLDENS === "1") fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(file, "utf8")));
}

async function consoleGuard() {
  const schemas = await import(pathToFileURL(SCHEMAS).href);
  return schemas.PlatformStatusGuard;
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("countServingInstances mirrors the console's routable rule", () => {
  const ready = { running: true, status: "running", models: [{ id: "qwen" }] };
  assert.equal(statusApi.countServingInstances([ready]), 1);
  assert.equal(statusApi.countServingInstances([{ ...ready, models: [] }]), 0, "ready without a model is degraded");
  assert.equal(statusApi.countServingInstances([{ ...ready, lifecycle: { state: "loading" } }]), 0);
  assert.equal(statusApi.countServingInstances([{ running: true, status: "Exited (1) 2 minutes ago", models: ["qwen"] }]), 0);
  assert.equal(statusApi.countServingInstances([{ lifecycle: { state: "ready" }, servedModels: ["qwen"] }]), 1, "manager /api/instances rows count too");
  assert.equal(statusApi.countServingInstances([{ running: false, models: ["qwen"] }]), 0);
  assert.equal(statusApi.countServingInstances(null), 0);
});

test("PlatformStatus matches the golden in supervised mode, including the listener row", async (t) => {
  const clock = createFakeClock();
  const world = createWorld(t, { clock, profile: "core", up: ["service-entry-public"] });
  fs.mkdirSync(path.join(world.aiRoot, ".runtime", "platform"), { recursive: true });
  fs.writeFileSync(path.join(world.aiRoot, ".runtime", "platform", "doctor-last.json"), JSON.stringify(DOCTOR));
  const supervisor = world.create({ readOps: () => OPS });
  await supervisor.start();
  await clock.advance(60000);
  const status = await supervisor.status();
  matchGolden("status-supervised.json", status);
  assert.equal(status.mode, "supervised");
  assert.equal(status.readiness.overall, "degraded");
  const listener = status.components.find((row) => row.id === "service-entry-public");
  assert.equal(listener.kind, "listener");
  assert.equal(listener.state, "ready");
  assert.equal(listener.pid, null, "a listener has no process of its own");
  const guard = await consoleGuard();
  assert.equal(guard(status).ok, true, JSON.stringify(guard(status)));
});

function probeWorld(t, { publicBaseUrl = "" } = {}) {
  const aiRoot = tempRoot(t);
  const config = configApi.loadPlatformConfig({ aiRoot, env: {}, runtimeOverrides: publicBaseUrl ? { "listeners.public.baseUrl": publicBaseUrl } : {} });
  const registry = componentsApi.loadComponentRegistry({ aiRoot, config });
  const components = registry.components.map((spec) => componentsApi.resolveComponent(spec, { aiRoot, config, runtime: { env: {} } }));
  const up = new Set([":5176/", ":5186/", ":5177/"]);
  const fetch = async (url) => {
    const text = String(url);
    if (text.endsWith(":5177/api/instances")) return Response.json({ instances: [{ id: "primary", running: true, status: "running", lifecycle: { state: "ready" }, servedModels: ["qwen3.8"] }] });
    if (text.includes(":5176/gateway/health")) return Response.json({ ok: true, service: "local-ai-gateway" });
    if (text.includes(":5177/api/manager/health")) return Response.json({ ok: true });
    if ([...up].some((needle) => text.includes(needle))) return new Response("ok", { status: 200 });
    throw new TypeError("fetch failed");
  };
  const listListeners = async () => [
    { protocol: "tcp", address: "127.0.0.1", port: 5176, pid: 5120, state: "LISTENING" },
    { protocol: "tcp", address: "127.0.0.1", port: 5186, pid: 5120, state: "LISTENING" },
    { protocol: "tcp", address: "127.0.0.1", port: 5177, pid: 5200, state: "LISTENING" },
  ];
  return {
    aiRoot, config, components, fetch, listListeners,
    run: (extra = {}) => statusApi.probePlatformStatus({
      aiRoot, components, config, fetch, listListeners, readDoctor: () => DOCTOR, build: BUILD, ops: OPS,
      execFile: (command, args, options, callback) => callback(null, "28.4.0\n", ""),
      now: () => Date.parse("2026-10-14T08:00:00.000Z"), ...extra,
    }),
  };
}

test("PlatformStatus matches the golden in probe mode, including the listener row", async (t) => {
  const world = probeWorld(t);
  const status = await world.run();
  matchGolden("status-probe.json", status);
  assert.equal(status.mode, "probe");
  assert.deepEqual(status.supervisor, { running: false });
  assert.ok(status.components.every((row) => row.desired === undefined && row.restarts === null), "probe mode has no desired state or restarts");
  assert.equal(status.components.find((row) => row.id === "service-entry-public").state, "ready");
  assert.equal(status.components.find((row) => row.id === "llama-manager").state, "stopped");
  assert.equal(status.models.serving, 1);
  const guard = await consoleGuard();
  assert.equal(guard(status).ok, true, JSON.stringify(guard(status)));
});

test("layer rules: overall down without the entry, exposure fail without keys and warn without the public listener", async (t) => {
  const base = { mode: "probe", config: { values: {} }, instances: [], components: [{ id: "entry", kind: "node", state: "stopped" }] };
  assert.equal(statusApi.buildPlatformStatus(base).readiness.overall, "down");
  const ready = { ...base, components: [{ id: "entry", kind: "node", state: "ready" }], doctor: DOCTOR, instances: [{ running: true, models: ["m"] }] };
  assert.equal(statusApi.buildPlatformStatus(ready).readiness.overall, "ok");
  const lan = statusApi.buildPlatformStatus({ ...ready, config: { values: { "listeners.admin.lan": true } }, keys: { activeKeys: 0 } });
  assert.deepEqual(lan.readiness.layers.find((layer) => layer.id === "exposure"), { id: "exposure", status: "fail", mode: "lan", code: "no_active_key" });
  assert.equal(lan.readiness.overall, "degraded");
  const publicMode = statusApi.buildPlatformStatus({
    ...ready, config: { values: { "listeners.public.baseUrl": "https://example.invalid" } }, keys: { activeKeys: 2 },
    components: [...ready.components, { id: "service-entry-public", kind: "listener", parent: "entry", state: "disabled" }],
  });
  assert.deepEqual(publicMode.readiness.layers.find((layer) => layer.id === "exposure"), { id: "exposure", status: "warn", mode: "public", code: "public_listener_not_ready" });
  const serving = statusApi.buildPlatformStatus({ ...ready, instances: [] }).readiness.layers.find((layer) => layer.id === "serving");
  assert.equal(serving.code, "no_model_serving");
  assert.deepEqual(serving.action, { id: "restore-models", label: { "zh-CN": "启动上次的模型", "en-US": "Start last used model" } });
  const docker = statusApi.buildPlatformStatus({ ...ready, components: [...ready.components, { id: "docker", kind: "external", state: "blocked" }] });
  assert.equal(docker.readiness.layers.find((layer) => layer.id === "runtime").code, "docker_unavailable");
});

test("probe mode reports a public listener that is not ready when a base URL is set", async (t) => {
  const world = probeWorld(t, { publicBaseUrl: "https://example.invalid" });
  const fetch = async (url) => (String(url).includes(":5186/") ? Promise.reject(new TypeError("fetch failed")) : world.fetch(url));
  const status = await world.run({ fetch, listListeners: async () => [{ protocol: "tcp", port: 5176, pid: 5120 }], keys: { activeKeys: 1 } });
  assert.equal(status.components.find((row) => row.id === "service-entry-public").state, "unhealthy");
  assert.equal(status.readiness.layers.find((layer) => layer.id === "exposure").code, "public_listener_not_ready");
});

test("readOpsSummary reads BOM nightly reports, computes the failing streak and the backup age", (t) => {
  const root = tempRoot(t);
  const nightly = path.join(root, "artifacts", "nightly");
  fs.mkdirSync(nightly, { recursive: true });
  const write = (name, ok) => fs.writeFileSync(path.join(nightly, name), `﻿${JSON.stringify({ ok, passed: 1, failed: ok ? 0 : 1 })}`);
  write("20261010-0300.json", true);
  write("20261011-0300.json", false);
  write("20261012-0300.json", false);
  write("20261013-0300.json", false);
  write("latest.json", false);
  const backup = path.join(root, "backups", "20261014-020000-000");
  fs.mkdirSync(backup, { recursive: true });
  const at = Date.parse("2026-10-14T02:00:00.000Z");
  fs.utimesSync(backup, at / 1000, at / 1000);
  const summary = statusApi.readOpsSummary({ aiRoot: root, now: () => Date.parse("2026-10-14T08:00:00.000Z") });
  assert.deepEqual(summary.nightly, { ok: false, streak: 3, since: "2026-10-11" });
  assert.deepEqual(summary.backup, { ageHours: 6, ok: true });
  assert.deepEqual(statusApi.readOpsSummary({ aiRoot: tempRoot(t) }), { nightly: { ok: null, streak: 0, since: null }, backup: { ageHours: null, ok: null } });
});

test("probeCheck covers http expectJson/expectStatus, command and failures without throwing", async () => {
  const fetch = async (url) => (String(url).includes("bad") ? Promise.reject(new TypeError("fetch failed")) : Response.json({ ok: true, service: "x", nested: { a: 1 } }));
  assert.equal((await statusApi.probeCheck({ http: "http://127.0.0.1:1/ok", expectJson: { service: "x", nested: { a: 1 } } }, { fetch })).ok, true);
  assert.equal((await statusApi.probeCheck({ http: "http://127.0.0.1:1/ok", expectJson: { service: "y" } }, { fetch })).reason, "unexpected-json");
  assert.equal((await statusApi.probeCheck({ http: "http://127.0.0.1:1/ok", expectStatus: 204 }, { fetch })).reason, "unexpected-status");
  assert.equal((await statusApi.probeCheck({ http: "http://127.0.0.1:1/bad" }, { fetch })).ok, false);
  const execFile = (command, args, options, callback) => callback(command === "docker.exe" ? null : new Error("no"), "28.4.0\n");
  assert.deepEqual(await statusApi.probeCheck({ command: ["docker.exe", "info"] }, { execFile }), { ok: true, output: "28.4.0" });
  assert.equal((await statusApi.probeCheck({ command: ["missing.exe"] }, { execFile })).ok, false);
  assert.equal((await statusApi.probeCheck(null)).ok, false);
});
