"use strict";

// PlatformStatus (06 §5.15): the layered readiness plus the component, model
// and ops rows. buildPlatformStatus assembles it from plain inputs and does
// no I/O; the supervisor feeds it its own state (mode "supervised") and
// probePlatformStatus feeds it port listeners, readiness probes and the last
// doctor run when no supervisor is running (mode "probe", no desired state
// and no restarts). probeCheck is the one readiness/liveness prober, shared
// with the supervisor.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const childProcess = require("node:child_process");

const STATUS_SCHEMA_VERSION = 1;
const LAYER_IDS = Object.freeze(["environment", "runtime", "components", "serving", "exposure"]);
const READY_STATES = new Set(["ready"]);
// Components that count toward the "components" layer: everything the
// platform runs itself. Docker is the runtime layer, listeners follow their
// parent, detect-only entries are informational.
const SKIP_COMPONENT_LAYER = new Set(["external", "listener"]);
const NIGHTLY_REPORT = /^\d{8}-\d{4}\.json$/;
const BACKUP_STALE_HOURS = 36;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;

const RESTORE_ACTION = Object.freeze({
  id: "restore-models",
  label: Object.freeze({ "zh-CN": "启动上次的模型", "en-US": "Start last used model" }),
});

// ---------------------------------------------------------------------------
// Serving instances

const CRASHED = /crash|failed|failure|\berror\b|\bdead\b|out[ -]?of[ -]?memory|\boom\b/;
const CRASHED_EXIT = /exited\s*\(\s*(?!0\s*\))\d+\s*\)/;
const LOADING = /loading|starting|pending|initializ|warming|restarting|creat/;
const DEGRADED = /degraded|unhealthy|health:?[ -]?fail/;
const RUNNING_WORD = /(^|\s)(ready|running|healthy|serving)(\s|$)/;

function instanceModels(instance) {
  const raw = Array.isArray(instance?.models) ? instance.models : Array.isArray(instance?.servedModels) ? instance.servedModels : [];
  return raw.map((model) => (typeof model === "string" ? model : model?.id)).filter((id) => typeof id === "string" && id.trim());
}

// The console's fleetInstanceLifecycle (service-entry/console/lib/readiness.js,
// itself the classic index.html rule), read from a fleet instance or from a
// manager's /api/instances row (lifecycle.state, servedModels).
function instanceLifecycle(instance = {}) {
  const lifecycleState = String(instance?.lifecycleState || instance?.lifecycle?.state || instance?.state || "").trim();
  const rawStatus = String(instance?.status || instance?.container?.status || lifecycleState || "").trim();
  const stateText = `${lifecycleState} ${rawStatus}`.toLowerCase();
  const explicitlyRunning = instance?.running === true
    || instance?.container?.running === true
    || RUNNING_WORD.test(lifecycleState.toLowerCase())
    || RUNNING_WORD.test(rawStatus.toLowerCase())
    || /(^|\s)up(?:\s|$)/.test(rawStatus.toLowerCase());
  if (CRASHED.test(stateText) || CRASHED_EXIT.test(stateText)) return { key: "crashed", routable: false };
  if (LOADING.test(stateText)) return { key: "loading", routable: false };
  if (DEGRADED.test(stateText)) return { key: "degraded", routable: false };
  if (!explicitlyRunning || /stopped|exited\s*\(\s*0\s*\)/.test(stateText)) return { key: "stopped", routable: false };
  if (!instanceModels(instance).length) return { key: "degraded", routable: false };
  return { key: "ready", routable: true };
}

/** Instances that are ready and report at least one model (06 §5.15 serving). */
function countServingInstances(instances) {
  return (Array.isArray(instances) ? instances : []).filter((instance) => instanceLifecycle(instance).routable).length;
}

// ---------------------------------------------------------------------------
// Probes

function matchesExpected(actual, expected) {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((value, index) => matchesExpected(actual[index], value));
  return actual !== null && typeof actual === "object" && Object.entries(expected).every(([key, value]) => matchesExpected(actual[key], value));
}

async function probeHttp(url, check, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text().catch(() => "");
  const statusOk = check.expectStatus !== undefined ? response.status === Number(check.expectStatus) : response.ok;
  if (!statusOk) return { ok: false, status: response.status, reason: "unexpected-status" };
  if (check.expectJson !== undefined) {
    let json = null;
    try { json = JSON.parse(text); } catch { return { ok: false, status: response.status, reason: "invalid-json" }; }
    if (!matchesExpected(json, check.expectJson)) return { ok: false, status: response.status, reason: "unexpected-json" };
    return { ok: true, status: response.status, json };
  }
  return { ok: true, status: response.status };
}

function probeTcp(target, timeoutMs) {
  const [host, port] = String(target).includes(":") ? [String(target).slice(0, String(target).lastIndexOf(":")), Number(String(target).split(":").pop())] : ["127.0.0.1", Number(target)];
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok ? { ok: true } : { ok: false, reason: "connect-failed" }); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function probeCommand(argv, { execFile, timeoutMs }) {
  return new Promise((resolve) => {
    if (!Array.isArray(argv) || !argv.length) {
      resolve({ ok: false, reason: "invalid-command" });
      return;
    }
    execFile(argv[0], argv.slice(1), { windowsHide: true, encoding: "utf8", timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? { ok: false, reason: "command-failed" } : { ok: true, output: String(stdout || "").trim() });
    });
  });
}

/**
 * One readiness or liveness check: {http | tcp | command, expectStatus?,
 * expectJson?, timeoutMs?}. Never throws: -> {ok, status?, json?, output?, reason?}.
 */
async function probeCheck(check, options = {}) {
  if (!check || typeof check !== "object") return { ok: false, reason: "no-check" };
  const timeoutMs = Math.max(100, Number(options.timeoutMs || check.timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
  try {
    if (check.http) return await probeHttp(check.http, check, { fetchImpl: options.fetch || fetch, timeoutMs });
    if (check.tcp) return await probeTcp(check.tcp, timeoutMs);
    if (check.command) return await probeCommand(check.command, { execFile: options.execFile || childProcess.execFile, timeoutMs: Math.max(timeoutMs, 10000) });
  } catch (error) {
    return { ok: false, reason: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
  return { ok: false, reason: "no-check" };
}

// ---------------------------------------------------------------------------
// Ops rows (nightly reports, backups)

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch { return null; }
}

function reportDate(name) {
  const match = /^(\d{4})(\d{2})(\d{2})-/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * Nightly and backup freshness from <AI_ROOT>/artifacts/nightly (PS 5.1
 * reports carry a BOM) and <AI_ROOT>/backups/<stamp>. Missing data is null.
 */
function readOpsSummary({ aiRoot, now = Date.now } = {}) {
  const root = path.resolve(aiRoot || path.join(__dirname, "../.."));
  const nightlyDir = path.join(root, "artifacts", "nightly");
  let names = [];
  try { names = fs.readdirSync(nightlyDir).filter((name) => NIGHTLY_REPORT.test(name)).sort().reverse(); } catch {}
  const latest = readJson(path.join(nightlyDir, "latest.json")) || (names[0] ? readJson(path.join(nightlyDir, names[0])) : null);
  let streak = 0, since = null;
  for (const name of names) {
    const report = readJson(path.join(nightlyDir, name));
    if (!report || report.ok !== false) break;
    streak += 1;
    since = reportDate(name);
  }
  const nightly = latest ? { ok: latest.ok === true, streak, since } : { ok: null, streak: 0, since: null };
  let newest = 0;
  try {
    for (const entry of fs.readdirSync(path.join(root, "backups"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const stat = fs.statSync(path.join(root, "backups", entry.name));
      newest = Math.max(newest, stat.mtimeMs);
    }
  } catch {}
  const ageHours = newest ? Math.round(((now() - newest) / 3600000) * 10) / 10 : null;
  return { nightly, backup: { ageHours, ok: ageHours === null ? null : ageHours <= BACKUP_STALE_HOURS } };
}

// ---------------------------------------------------------------------------
// Layers

function doctorGroup(doctor, group) {
  const checks = Array.isArray(doctor?.checks) ? doctor.checks.filter((check) => check.group === group) : [];
  if (!checks.length) return null;
  if (checks.some((check) => check.status === "fail")) return { status: "fail", checks };
  if (checks.some((check) => check.status === "warn")) return { status: "warn", checks };
  return { status: "ok", checks };
}

function firstFailing(group) {
  return group?.checks.find((check) => check.status === group.status) || null;
}

function environmentLayer(doctor) {
  const group = doctorGroup(doctor, "env");
  if (!group) return { id: "environment", status: "unknown", code: "doctor_not_run" };
  const failing = group.status === "ok" ? null : firstFailing(group);
  return { id: "environment", status: group.status, ...(failing ? { code: "doctor_check", check: failing.id } : {}) };
}

function runtimeDetail(group) {
  const data = (id) => group?.checks.find((check) => check.id === id)?.data || {};
  const parts = [];
  const docker = String(data("runtime.docker-daemon").version || "").trim();
  if (docker) parts.push(`Docker ${docker}`);
  const gpu = Array.isArray(data("runtime.nvidia-driver").gpus) ? data("runtime.nvidia-driver").gpus[0] : null;
  if (gpu?.name) parts.push(String(gpu.name).replace(/^NVIDIA\s+/i, "").replace(/\s+(Blackwell\s+)?(Workstation|Max-Q|Server)\s+Edition$/i, ""));
  if (gpu?.driverVersion) parts.push(`driver ${gpu.driverVersion}`);
  return parts.join(" · ");
}

function runtimeLayer(doctor, docker) {
  const group = doctorGroup(doctor, "runtime");
  const detail = runtimeDetail(group);
  const dockerDown = docker && docker.state !== "ready" && docker.state !== "external";
  let status = group ? group.status : "unknown";
  let code = group && group.status !== "ok" ? "doctor_check" : null;
  if (dockerDown) {
    status = "fail";
    code = "docker_unavailable";
  } else if (!group && docker) {
    status = "ok";
  }
  return { id: "runtime", status, ...(detail ? { detail } : {}), ...(code ? { code } : {}) };
}

function componentsLayer(rows) {
  const counted = rows.filter((row) => !SKIP_COMPONENT_LAYER.has(row.kind) && row.counted !== false);
  const ready = counted.filter((row) => READY_STATES.has(row.state)).length;
  const total = counted.length;
  const problems = counted.filter((row) => !READY_STATES.has(row.state)).map((row) => row.id);
  let status = "ok";
  if (total && !ready) status = "fail";
  else if (problems.length) status = "warn";
  return {
    id: "components", status, detail: `${ready}/${total} ready`, counts: { ready, total },
    ...(problems.length ? { code: "components_not_ready", components: problems } : {}),
  };
}

function servingLayer(instances) {
  const list = Array.isArray(instances) ? instances : null;
  if (!list) return { id: "serving", status: "unknown", code: "fleet_unavailable" };
  const serving = countServingInstances(list);
  return serving
    ? { id: "serving", status: "ok", counts: { ready: serving, total: list.length } }
    : { id: "serving", status: "warn", code: "no_model_serving", counts: { ready: 0, total: list.length }, action: RESTORE_ACTION };
}

function exposureMode(values = {}) {
  if (String(values["listeners.public.baseUrl"] || "").trim()) return "public";
  if (values["listeners.admin.lan"] === true || values["listeners.public.lan"] === true) return "lan";
  return "local";
}

function exposureLayer(values, keys, publicRow) {
  const mode = exposureMode(values);
  if (mode === "local") return { id: "exposure", status: "ok", mode };
  const activeKeys = keys && Number.isFinite(Number(keys.activeKeys)) ? Number(keys.activeKeys) : null;
  if (activeKeys === 0) return { id: "exposure", status: "fail", mode, code: "no_active_key" };
  if (mode === "public" && publicRow?.state !== "ready") return { id: "exposure", status: "warn", mode, code: "public_listener_not_ready" };
  if (activeKeys === null) return { id: "exposure", status: "warn", mode, code: "key_summary_unavailable" };
  return { id: "exposure", status: "ok", mode };
}

// ---------------------------------------------------------------------------
// Assembly

function portRows(ports) {
  return (Array.isArray(ports) ? ports : []).map((port) => ({ name: port.name, port: Number(port.port), bind: port.bind }));
}

function componentRow(input, mode) {
  const row = {
    id: input.id,
    ...(input.legacyId ? { legacyId: input.legacyId } : {}),
    kind: input.kind,
    profile: input.profile,
    ...(input.label ? { label: input.label } : {}),
    ...(input.parent ? { parent: input.parent } : {}),
    ...(mode === "supervised" ? { desired: input.desired || "stopped" } : {}),
    state: input.state || "unknown",
    owner: mode === "supervised" ? input.owner || "none" : input.owner || "none",
    pid: Number.isInteger(input.pid) ? input.pid : null,
    ports: portRows(input.ports),
    uptimeSec: Number.isFinite(input.uptimeSec) ? input.uptimeSec : null,
    restarts: mode === "supervised" ? { count: input.restarts?.count || 0, windowCount: input.restarts?.windowCount || 0 } : null,
    lastExit: mode === "supervised" ? input.lastExit || null : null,
    health: input.health ? { live: input.health.live === true, checkedAt: input.health.checkedAt || null } : null,
    pendingRestart: mode === "supervised" ? input.pendingRestart || null : null,
    message: input.message || null,
  };
  if (input.reason) row.reason = input.reason;
  if (input.blocked && typeof input.blocked === "object") row.blocked = input.blocked;
  return row;
}

function modelInstances(instances) {
  return (Array.isArray(instances) ? instances : []).map((instance) => ({
    managerId: instance.managerId || null,
    instanceId: String(instance.instanceId || instance.id || ""),
    state: instanceLifecycle(instance).key,
    models: instanceModels(instance),
  }));
}

/**
 * Pure assembly (06 §5.15). input: { mode: "supervised" | "probe", at, build,
 * supervisor, components: [rows], doctor, instances (null = unknown),
 * config: { values }, keys: { activeKeys } | null, ops, pendingRestarts }.
 */
function buildPlatformStatus(input = {}) {
  const mode = input.mode === "supervised" ? "supervised" : "probe";
  const inputs = Array.isArray(input.components) ? input.components : [];
  const components = inputs.map((row) => componentRow(row, mode));
  const byId = new Map(components.map((row) => [row.id, row]));
  const values = input.config?.values || input.config || {};
  const layers = [
    environmentLayer(input.doctor),
    runtimeLayer(input.doctor, byId.get("docker") || null),
    componentsLayer(inputs),
    servingLayer(input.instances),
    exposureLayer(values, input.keys || null, byId.get("service-entry-public") || null),
  ];
  const entry = byId.get("entry");
  let overall = "ok";
  if (!entry || entry.state !== "ready") overall = "down";
  else if (layers.some((layer) => layer.status === "warn" || layer.status === "fail")) overall = "degraded";
  const instances = Array.isArray(input.instances) ? input.instances : [];
  const ops = input.ops || {};
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    at: input.at || new Date().toISOString(),
    build: input.build ? { commit: input.build.commit || null, contentHash: input.build.contentHash || null } : null,
    mode,
    supervisor: mode === "supervised"
      ? { running: true, pid: input.supervisor?.pid ?? null, startedAt: input.supervisor?.startedAt || null, profile: input.supervisor?.profile || null, endpoint: "pipe" }
      : { running: false },
    readiness: { overall, layers },
    components,
    models: { serving: countServingInstances(instances), instances: modelInstances(instances) },
    ops: {
      nightly: ops.nightly || { ok: null, streak: 0, since: null },
      backup: ops.backup || { ageHours: null, ok: null },
      pendingRestarts: Array.isArray(input.pendingRestarts) ? input.pendingRestarts : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Probe-only mode

function readDoctorLast(aiRoot) {
  return readJson(path.join(aiRoot, ".runtime", "platform", "doctor-last.json"));
}

function listenerForPorts(listeners, ports) {
  for (const port of ports.filter((item) => item.enabled !== false)) {
    const found = listeners.find((listener) => listener.protocol !== "udp" && Number(listener.port) === Number(port.port));
    if (found) return found;
  }
  return null;
}

async function fetchManagerInstances(registry, { fetchImpl, timeoutMs }) {
  const instances = [];
  let reached = false;
  for (const [managerId, componentId] of [["vllm", "vllm-manager"], ["llama", "llama-manager"]]) {
    const component = registry.find((item) => item.id === componentId);
    const origin = component?.urls?.api;
    if (!origin) continue;
    try {
      const response = await fetchImpl(`${origin}/api/instances`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) continue;
      const body = await response.json();
      const list = Array.isArray(body) ? body : Array.isArray(body?.instances) ? body.instances : [];
      reached = true;
      for (const instance of list) instances.push({ ...instance, managerId });
    } catch {}
  }
  return reached ? instances : null;
}

/**
 * Status without a supervisor (06 §5.15): port listeners, readiness URLs and
 * the last doctor run. options: { aiRoot, components (resolved specs),
 * config, listListeners, fetch, execFile, readDoctor, instances, keys, build,
 * ops, now }.
 */
async function probePlatformStatus(options = {}) {
  const aiRoot = path.resolve(options.aiRoot || path.join(__dirname, "../.."));
  const now = options.now || Date.now;
  const resolved = Array.isArray(options.components) ? options.components : [];
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS;
  let listeners = [];
  try { listeners = typeof options.listListeners === "function" ? await options.listListeners() : []; } catch {}
  const states = new Map();
  const rows = [];
  for (const component of resolved) {
    const row = { id: component.id, legacyId: component.legacyId, kind: component.kind, profile: component.profile, label: component.label, parent: component.parent, ports: component.ports, owner: "none" };
    if (component.kind === "listener") {
      rows.push(row);
      continue;
    }
    const owner = listenerForPorts(listeners, component.ports || []);
    if (owner) row.pid = owner.pid;
    if (component.kind === "external" && component.detectOnly) {
      row.state = owner ? "external" : "stopped";
    } else if (component.readiness && (owner || !(component.ports || []).length)) {
      const result = await probeCheck(component.readiness, { fetch: fetchImpl, execFile: options.execFile, timeoutMs });
      row.state = result.ok ? "ready" : owner ? "unknown" : "stopped";
      row.health = { live: result.ok, checkedAt: new Date(now()).toISOString() };
    } else {
      row.state = owner ? "unknown" : "stopped";
    }
    // Without a supervisor there is no desired state: the core profile counts
    // toward the components layer, anything else only while it runs.
    if (component.profile !== "core" || component.autostart === false || component.disabled) row.counted = row.state === "ready";
    states.set(component.id, row.state);
    rows.push(row);
  }
  for (const row of rows.filter((item) => item.kind === "listener")) {
    const component = resolved.find((item) => item.id === row.id);
    if (states.get(component.parent) !== "ready") row.state = "stopped";
    else if (!component.enabled) row.state = "disabled";
    else {
      const result = await probeCheck(component.readiness, { fetch: fetchImpl, timeoutMs });
      row.state = result.ok ? "ready" : "unhealthy";
      row.health = { live: result.ok, checkedAt: new Date(now()).toISOString() };
    }
  }
  const instances = options.instances !== undefined ? options.instances : await fetchManagerInstances(resolved, { fetchImpl, timeoutMs });
  return buildPlatformStatus({
    mode: "probe",
    at: new Date(now()).toISOString(),
    build: options.build || null,
    components: rows,
    doctor: options.readDoctor ? options.readDoctor() : readDoctorLast(aiRoot),
    instances,
    config: options.config,
    keys: options.keys || null,
    ops: options.ops || readOpsSummary({ aiRoot, now }),
    pendingRestarts: [],
  });
}

module.exports = {
  STATUS_SCHEMA_VERSION,
  LAYER_IDS,
  RESTORE_ACTION,
  countServingInstances,
  instanceLifecycle,
  probeCheck,
  matchesExpected,
  readOpsSummary,
  readDoctorLast,
  exposureMode,
  buildPlatformStatus,
  probePlatformStatus,
};
