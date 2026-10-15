"use strict";

// The platform supervisor core (06 §5): component states, start ordering,
// readiness and liveness, restarts with backoff, adoption and reconcile, the
// idle gate with pending restarts, operations and events. Spawning, stop
// strategies and identity records belong to launcher.js, port and process
// facts to winproc.js, the pipe API to control.js and machine-signed entry
// calls to entry-client.js. Restore, toasts, the nightly watch and the full
// re-exec takeover are OPS-12; the hand-off here only leaves children alone.
//
// Every clock, process, probe and network boundary is injectable, so the
// tests drive the whole state machine on a fake clock. No code path here
// stops a model container unless the caller passes models:true and confirm.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const componentsApi = require("./components");
const configApi = require("./config");
const statusApi = require("./status");
const idleApi = require("./idle");
const logFiles = require("./logs");
const messages = require("./messages");
const winprocDefault = require("./winproc");
const { controlError } = require("./control");

const RECONCILE_MS = 10 * 1000;
const DOCKER_PROBE_MS = 30 * 1000;
const PENDING_CHECK_MS = 15 * 1000;
const COPY_TRUNCATE_MS = 60 * 1000;
const DOCTOR_MS = 30 * 60 * 1000;
const STATUS_DEBOUNCE_MS = 1000;
const INSTANCES_CACHE_MS = 5000;
const KEYS_CACHE_MS = 60 * 1000;
const PENDING_DEADLINE_MS = 6 * 60 * 60 * 1000;
const EVENTS_MAX_BYTES = 10 * 1024 * 1024;
const EVENTS_KEEP = 3;
const OPERATION_LOG_MAX = 500;
const OPERATIONS_KEEP = 50;
const STDERR_TAIL_LINES = 20;
const PORT_CONFLICT_PATTERN = /EADDRINUSE|端口\s*.*\s*已被占用/;
const LIVE_STATES = new Set(["starting", "ready", "unhealthy"]);
const NOT_RUNNING_STATES = new Set(["stopped", "failed", "blocked", "not-installed", "unknown", "backoff", "disabled"]);
const MANAGER_IDS = Object.freeze({ "vllm-manager": "vllm", "llama-manager": "llama" });

function realClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch { return fallback; }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function operationId() {
  return `op_${crypto.randomBytes(10).toString("hex")}`;
}

function zhEn(value) {
  return { zh: value["zh-CN"], en: value["en-US"] };
}

function labelOf(spec, language) {
  return spec?.label?.[language] || spec?.id || "";
}

function basename(value) {
  return path.win32.basename(String(value || "")).toLowerCase();
}

/**
 * createSupervisor(options) -> supervisor API used by control.js and the CLI.
 * options: { aiRoot, profile, env, config | loadConfig(runtimeOverrides),
 * registry | loadRegistry(config), launcher, winproc, probe(check, opts),
 * ensureDocker(spec, timeoutMs), collectBlockers({components}), entryClient,
 * fetch, runDoctor, readOps, getBuildId, loadHook, secrets, logs, redactor,
 * clock { now, setTimeout, clearTimeout }, pid, spawnSupervisor, waitForPipe,
 * closeControl, reopenControl, exit, log }.
 */
function createSupervisor(options = {}) {
  const aiRoot = path.resolve(options.aiRoot || path.join(__dirname, "../.."));
  const env = options.env || process.env;
  const clock = options.clock || realClock();
  const now = () => clock.now();
  const iso = (value = now()) => new Date(value).toISOString();
  const sleep = (ms) => new Promise((resolve) => clock.setTimeout(resolve, Math.max(0, ms)));
  const platformDir = path.join(aiRoot, ".runtime", "platform");
  const stateDir = path.join(platformDir, "state");
  const desiredFile = path.join(platformDir, "desired.json");
  const pendingFile = path.join(platformDir, "pending-restarts.json");
  const doctorFile = path.join(platformDir, "doctor-last.json");
  const eventsFile = path.join(aiRoot, "logs", "platform", "events.jsonl");
  const winproc = options.winproc || winprocDefault;
  const logs = options.logs || logFiles;
  const fetchImpl = options.fetch || ((...args) => fetch(...args));
  const probe = options.probe || ((check, probeOptions) => statusApi.probeCheck(check, { fetch: fetchImpl, ...probeOptions }));
  const log = typeof options.log === "function" ? options.log : () => {};
  const loadConfig = options.loadConfig || ((runtimeOverrides) => configApi.loadPlatformConfig({ aiRoot, env, runtimeOverrides }));
  const loadRegistry = options.loadRegistry || ((config) => componentsApi.loadComponentRegistry({ aiRoot, config }));
  let entryClient = options.entryClient || null;
  let launcher = options.launcher || null;
  let secrets = options.secrets || null;

  let profile = options.profile || "core";
  let runtimeOverrides = {};
  let config = options.config || loadConfig(runtimeOverrides);
  let registry = options.registry || loadRegistry(config);
  const records = new Map();
  const listeners = new Set();
  const operations = new Map();
  const timers = new Set();
  let closed = false;
  let started = false;
  let startedAt = null;
  let statusTimer = null;
  let doctorLast = readJsonFile(doctorFile, null);
  let instancesCache = { at: -Infinity, value: null };
  let keysCache = { at: -Infinity, value: null };
  let pending = (readJsonFile(pendingFile, []) || []).filter((item) => item && typeof item.id === "string");
  const desiredSaved = readJsonFile(desiredFile, {}) || {};

  function getEntryClient() {
    if (entryClient) return entryClient;
    const { createEntryClient } = require("./entry-client");
    const entry = registry.components.find((component) => component.id === "entry");
    const port = resolveSpec(entry)?.ports?.find((item) => item.name === "admin")?.port || 5176;
    entryClient = createEntryClient({ aiRoot, principal: "system:supervisor", baseUrl: `http://127.0.0.1:${port}`, fetch: fetchImpl, log: (line) => log(line) });
    return entryClient;
  }
  function getLauncher() {
    if (launcher) return launcher;
    const { createLauncher } = require("./launcher");
    launcher = createLauncher({ aiRoot, winproc, entryClient: getEntryClient(), appendLog: (line) => log(line), buildCommit: buildId().commit });
    return launcher;
  }
  function getSecrets() {
    if (secrets) return secrets;
    const { createSecretVault } = require("../secret-store");
    secrets = createSecretVault({ aiRoot });
    return secrets;
  }
  function buildId() {
    try { return (options.getBuildId || require("./version").getBuildId)({ aiRoot }); }
    catch { return { commit: null, contentHash: null }; }
  }

  function resolveSpec(spec) {
    if (!spec) return null;
    return componentsApi.resolveComponent(spec, { aiRoot, config, runtime: { env } });
  }

  function record(id) {
    const spec = componentsApi.getComponent(registry, id);
    if (!spec) throw controlError(404, "component_unknown", `Unknown component "${id}".`);
    if (!records.has(spec.id)) {
      records.set(spec.id, {
        id: spec.id, spec: resolveSpec(spec), state: "stopped", reason: null, blocked: null,
        desired: desiredSaved[spec.id] === "running" ? "running" : "stopped", owner: "none",
        pid: null, identity: null, child: null, generation: 0, startedAt: null, readyAt: null,
        restartTimes: [], restartCount: 0, lastExit: null, health: null, failures: 0,
        message: null, requestedStop: false, recovering: false, readyWaiters: [], timers: {},
      });
    }
    return records.get(spec.id);
  }
  for (const component of registry.components) record(component.id);

  // -------------------------------------------------------------------------
  // Timers, events and persistence

  function later(ms, fn) {
    const handle = { timer: null };
    handle.timer = clock.setTimeout(() => {
      timers.delete(handle);
      if (!closed) fn();
    }, ms);
    timers.add(handle);
    return handle;
  }
  function cancel(handle) {
    if (!handle) return;
    clock.clearTimeout(handle.timer);
    timers.delete(handle);
  }
  function every(ms, fn) {
    let running = false;
    const tick = () => {
      later(ms, async () => {
        if (!running) {
          running = true;
          try { await fn(); } catch (error) { log({ code: "supervisor_tick_failed", message: String(error?.message || error) }); }
          running = false;
        }
        tick();
      });
    };
    tick();
  }

  function appendEvent(event) {
    try {
      fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
      let size = 0;
      try { size = fs.statSync(eventsFile).size; } catch {}
      if (size > EVENTS_MAX_BYTES) {
        for (let index = EVENTS_KEEP - 1; index >= 1; index -= 1) {
          const from = index === 1 ? eventsFile : `${eventsFile}.${index - 1}`;
          try { fs.renameSync(from, `${eventsFile}.${index}`); } catch {}
        }
      }
      fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`);
    } catch (error) {
      log({ code: "events_append_failed", message: String(error?.code || error) });
    }
  }
  function emit(type, data) {
    const event = { type, at: iso(), data };
    appendEvent(event);
    for (const listener of listeners) {
      try { listener(event); } catch {}
    }
    return event;
  }
  // params.label may be a component spec, so each language gets its own label.
  function notify(kind, severity, key, params = {}, extra = {}) {
    const text = (part) => {
      const out = {};
      for (const language of ["zh-CN", "en-US"]) {
        const label = params.label && typeof params.label === "object" ? labelOf(params.label, language) : params.label;
        out[language] = messages.message(`notify.${key}.${part}`, language, { ...params, label });
      }
      return zhEn(out);
    };
    return emit("notification", { kind, severity, title: text("title"), body: text("body"), ...extra });
  }
  function scheduleStatus() {
    if (statusTimer || closed) return;
    statusTimer = later(STATUS_DEBOUNCE_MS, async () => {
      statusTimer = null;
      try { emit("status", { full: true, status: await status() }); } catch {}
    });
  }
  function setState(rec, state, extra = {}) {
    const prev = rec.state;
    const reason = extra.reason === undefined ? null : extra.reason;
    rec.state = state;
    rec.reason = reason;
    rec.blocked = state === "blocked" ? { reason, ...(extra.detail || {}) } : null;
    if (extra.message !== undefined) rec.message = extra.message;
    else if (state === "ready") rec.message = null;
    if (prev !== state || extra.reason !== undefined) {
      emit("component", { id: rec.id, state, prev, reason });
      scheduleStatus();
    }
    if (state !== "starting") {
      const waiters = rec.readyWaiters.splice(0);
      for (const resolve of waiters) resolve(state);
    }
  }
  function persistDesired() {
    const out = {};
    for (const rec of records.values()) out[rec.id] = rec.desired;
    try { writeJsonFile(desiredFile, out); } catch (error) { log({ code: "desired_write_failed", message: String(error?.code || error) }); }
  }
  function persistPending() {
    try { writeJsonFile(pendingFile, pending); } catch (error) { log({ code: "pending_write_failed", message: String(error?.code || error) }); }
  }

  function startOperation(kind, run) {
    const op = { opId: operationId(), kind, state: "running", progress: 0, log: [], result: null, startedAt: iso() };
    operations.set(op.opId, op);
    while (operations.size > OPERATIONS_KEEP) operations.delete(operations.keys().next().value);
    const line = (text) => {
      op.log.push(String(text));
      if (op.log.length > OPERATION_LOG_MAX) op.log.splice(0, op.log.length - OPERATION_LOG_MAX);
      emit("operation", { opId: op.opId, kind, state: op.state, progress: op.progress, line: String(text) });
    };
    op.done = Promise.resolve()
      .then(() => run({ line, progress: (value) => { op.progress = value; } }))
      .then((result) => {
        op.state = "ok";
        op.progress = 1;
        op.result = result ?? null;
        emit("operation", { opId: op.opId, kind, state: op.state, progress: 1, line: "done" });
        return result;
      }, (error) => {
        op.state = "failed";
        op.result = { code: error?.code || "operation_failed", message: String(error?.message || error) };
        emit("operation", { opId: op.opId, kind, state: op.state, progress: op.progress, line: op.result.code });
        return null;
      });
    return op;
  }
  function publicOperation(op) {
    return { opId: op.opId, kind: op.kind, state: op.state, progress: op.progress, log: op.log.slice(-OPERATION_LOG_MAX), result: op.result };
  }

  // -------------------------------------------------------------------------
  // Probes and helpers

  async function listListeners() {
    try { return await winproc.listListeners(); } catch { return []; }
  }
  function enabledPorts(spec) {
    return (spec?.ports || []).filter((port) => port.enabled !== false && Number(port.port) > 0);
  }
  function listenerChildren(id) {
    return [...records.values()].filter((rec) => rec.spec.kind === "listener" && rec.spec.parent === id);
  }
  function portOwner(list, ports) {
    for (const port of ports) {
      const found = list.find((item) => item.protocol !== "udp" && Number(item.port) === Number(port.port));
      if (found) return { ...found, portName: port.name };
    }
    return null;
  }
  async function imageName(pid) {
    try { return (await winproc.imageNames([pid]))?.[pid] || null; } catch { return null; }
  }
  function stderrTail(rec) {
    const file = rec.spec.logs?.err;
    if (!file) return [];
    try {
      const text = logs.tailLog(file, { lines: STDERR_TAIL_LINES, aiRoot, ...(options.redactor ? { redactor: options.redactor } : {}) });
      return text ? text.split("\n") : [];
    } catch { return []; }
  }
  function exitLogLine(rec) {
    if (!rec.spec.cwd || !rec.startedAt) return null;
    const file = path.join(rec.spec.cwd, "logs", "process-exit.log");
    try {
      if (fs.statSync(file).mtimeMs < rec.startedAt) return null;
      const lines = logs.tailLog(file, { lines: 1, aiRoot, ...(options.redactor ? { redactor: options.redactor } : {}) });
      return lines || null;
    } catch { return null; }
  }
  function waitForState(rec) {
    if (rec.state !== "starting") return Promise.resolve(rec.state);
    return new Promise((resolve) => rec.readyWaiters.push(resolve));
  }
  function looksLikePlatform(spec, info) {
    if (!info) return false;
    if (spec.kind === "node" && !/^node(\.exe)?$/.test(basename(info.exe))) return false;
    const script = (spec.args || []).find((arg) => /\.(c?js|mjs|ps1|py)$/i.test(arg));
    return !script || String(info.commandLine || "").toLowerCase().includes(basename(script));
  }

  // -------------------------------------------------------------------------
  // Start

  function expand(ids) {
    const requested = new Set(ids.map((id) => record(id).id));
    let inProfile = new Set();
    if (profile !== "none") {
      try { inProfile = new Set(componentsApi.selectProfile(registry, profile, { includeOnDemand: true })); } catch {}
    }
    const plan = new Set(requested);
    const queue = [...requested];
    while (queue.length) {
      const spec = record(queue.shift()).spec;
      // dependsOn is a hard requirement and always joins; `after` only orders
      // members that are in the profile or were asked for.
      for (const dep of spec.dependsOn || []) if (!plan.has(dep)) { plan.add(dep); queue.push(dep); }
      for (const dep of spec.after || []) if (!plan.has(dep) && (inProfile.has(dep) || requested.has(dep))) { plan.add(dep); queue.push(dep); }
    }
    // A listener follows its parent when it belongs to the run.
    for (const rec of records.values()) {
      if (rec.spec.kind === "listener" && plan.has(rec.spec.parent)) plan.add(rec.id);
    }
    return componentsApi.startOrder(registry, [...plan]);
  }

  async function ensureDocker(rec) {
    const spec = rec.spec;
    const mode = String(spec.ensure?.mode || "start");
    const timeoutMs = Math.max(1, Number(config.values?.["docker.waitTimeoutSec"]) || 120) * 1000;
    setState(rec, "starting");
    let ok = false;
    if (mode === "start") {
      try {
        ok = options.ensureDocker ? await options.ensureDocker(spec, timeoutMs) : await defaultEnsureDocker(spec, timeoutMs);
      } catch { ok = false; }
    } else if (mode === "wait") {
      const deadline = now() + timeoutMs;
      while (!closed) {
        ok = (await probe(spec.readiness)).ok;
        if (ok || now() >= deadline) break;
        await sleep(Number(spec.readiness?.intervalMs) || 3000);
      }
    } else {
      ok = (await probe(spec.readiness)).ok;
    }
    if (ok) setState(rec, "ready");
    else setState(rec, "blocked", { reason: "docker-unavailable" });
    return rec.state;
  }

  async function defaultEnsureDocker(spec, timeoutMs) {
    const argv = Array.isArray(spec.readiness?.command) ? spec.readiness.command : ["docker"];
    const infoAt = argv.indexOf("info");
    const docker = infoAt > 0 ? argv.slice(0, infoAt) : [argv[0]];
    const { createDockerRuntime } = require("../docker-runtime");
    const runtime = createDockerRuntime({ dockerExe: docker[0], dockerArgsPrefix: docker.slice(1), dockerDesktopExe: config.values?.["docker.desktopExe"] || "" });
    const result = await runtime.ensureDockerDaemonRunning(timeoutMs);
    return Boolean(result?.ok ?? result?.ready ?? result);
  }

  async function checkRequires(rec) {
    const files = rec.spec.requires?.files || [];
    const missing = files.filter((file) => !fs.existsSync(file));
    if (!missing.length) return true;
    if (rec.spec.requires.optional) setState(rec, "not-installed", { reason: "runtime-missing" });
    else setState(rec, "blocked", { reason: "requires-missing", detail: { fix: rec.spec.requires.doctor?.[0] || null } });
    return false;
  }

  async function adoptRecord(rec, identity, owner) {
    rec.identity = identity;
    rec.pid = identity.pid;
    rec.owner = owner;
    rec.child = null;
    rec.generation += 1;
    rec.startedAt = Date.parse(identity.startedAt) || now();
    const result = rec.spec.readiness ? await probe(rec.spec.readiness) : { ok: true };
    if (result.ok) markReady(rec, rec.generation);
    else {
      setState(rec, "starting");
      waitReady(rec, rec.generation);
    }
  }

  // The spawn step of one component; the returned promise settles when the
  // component leaves "starting" (or at once when nothing was spawned).
  async function spawnStep(rec) {
    const spec = rec.spec;
    if (closed) return rec.state;
    if (LIVE_STATES.has(rec.state) && rec.pid) return waitForState(rec);
    if (spec.blocked) {
      setState(rec, "blocked", { reason: spec.blocked.reason || "registry-invalid" });
      return rec.state;
    }
    if (!(await checkRequires(rec))) return rec.state;
    const ports = [...enabledPorts(spec), ...listenerChildren(rec.id).flatMap((child) => enabledPorts(child.spec))];
    if (ports.length) {
      const owner = portOwner(await listListeners(), ports);
      if (owner) {
        const adopted = await tryAdopt(rec, owner);
        if (adopted) return waitForState(rec);
        setState(rec, "blocked", { reason: "port-conflict", detail: { port: owner.port, pid: owner.pid, imageName: await imageName(owner.pid) } });
        return rec.state;
      }
    }
    let launchSpec = spec;
    if (spec.hook) {
      try {
        const hook = (options.loadHook || componentsApi.loadHook)(spec.hook);
        if (typeof hook.prepare === "function") {
          const prepared = await hook.prepare({ aiRoot, config, component: spec, secrets: getSecrets() });
          if (prepared?.blocked) {
            setState(rec, "blocked", { reason: prepared.blocked.reason || "hook-blocked", message: messages.bilingual(`blocked.${prepared.blocked.reason}`) });
            return rec.state;
          }
          launchSpec = { ...spec, env: { ...(spec.env || {}), ...(prepared?.env || {}) } };
        }
      } catch (error) {
        setState(rec, "blocked", { reason: "hook-failed", message: String(error?.code || error?.message || error) });
        return rec.state;
      }
    }
    rec.requestedStop = false;
    rec.generation += 1;
    const generation = rec.generation;
    setState(rec, "starting");
    let result;
    try {
      result = await getLauncher().start(launchSpec, { spawnedBy: "supervisor", keep: config.values?.["supervisor.logs.keep"], buildCommit: buildId().commit });
    } catch (error) {
      result = { ok: false, code: error?.code || "spawn_failed" };
    }
    if (generation !== rec.generation) return rec.state;
    if (!result?.ok) {
      if (result?.code === "identity_mismatch") setState(rec, "unknown", { reason: "identity-mismatch" });
      else setState(rec, "failed", { reason: result?.code || "spawn_failed" });
      return rec.state;
    }
    if (result.existing) {
      await adoptRecord(rec, result.identity, "supervisor");
      return waitForState(rec);
    }
    rec.identity = result.identity;
    rec.pid = result.identity?.pid ?? result.child?.pid ?? null;
    rec.owner = "supervisor";
    rec.child = result.child || null;
    rec.startedAt = now();
    rec.readyAt = null;
    if (rec.child && typeof rec.child.once === "function") {
      rec.child.once("exit", (code, signal) => { onExit(rec, generation, code, signal); });
    }
    waitReady(rec, generation);
    return waitForState(rec);
  }

  async function waitReady(rec, generation) {
    const readiness = rec.spec.readiness;
    if (!readiness) {
      markReady(rec, generation);
      return;
    }
    const deadline = now() + Math.max(1, Number(readiness.timeoutSec) || 30) * 1000;
    const interval = Math.max(10, Number(readiness.intervalMs) || 1000);
    while (!closed && rec.generation === generation && rec.state === "starting") {
      const result = await probe(readiness);
      if (rec.generation !== generation || rec.state !== "starting") return;
      if (result.ok) {
        markReady(rec, generation);
        return;
      }
      if (now() >= deadline) {
        await readinessTimeout(rec, generation);
        return;
      }
      await sleep(interval);
    }
  }

  function markReady(rec, generation) {
    if (rec.generation !== generation) return;
    const recovered = rec.recovering;
    rec.recovering = false;
    rec.readyAt = now();
    rec.failures = 0;
    rec.health = { live: true, checkedAt: iso() };
    setState(rec, "ready");
    if (recovered) notify("component.recovered", "info", "component.recovered", { label: rec.spec }, { dedupeKey: `component.recovered:${rec.id}` });
    cancel(rec.timers.stable);
    const stableMs = Math.max(1, Number(rec.spec.restartPolicy?.stableAfterSec) || 600) * 1000;
    rec.timers.stable = later(stableMs, () => {
      if (rec.generation === generation && rec.state === "ready") rec.restartTimes = [];
    });
    scheduleLiveness(rec, generation);
    afterReady(rec, generation);
    for (const child of listenerChildren(rec.id)) probeListener(child);
  }

  async function afterReady(rec, generation) {
    if (!rec.spec.hook) return;
    let hook;
    try { hook = (options.loadHook || componentsApi.loadHook)(rec.spec.hook); } catch { return; }
    if (typeof hook.afterReady !== "function") return;
    let result;
    try {
      result = await hook.afterReady({ aiRoot, config, component: rec.spec, pid: rec.pid, port: enabledPorts(rec.spec)[0]?.port, listListeners: () => listListeners() });
    } catch (error) {
      result = { ok: false, error: { code: "hook_failed", reason: String(error?.code || "hook_failed") } };
    }
    if (result?.ok !== false || rec.generation !== generation) return;
    if (result.kill) {
      rec.requestedStop = true;
      try { await getLauncher().stop({ ...rec.spec, stop: { strategy: "kill", tree: true } }, { identity: rec.identity }); } catch {}
      rec.generation += 1;
      rec.pid = null;
      rec.child = null;
    }
    rec.desired = "stopped";
    persistDesired();
    setState(rec, "failed", { reason: result.error?.reason || result.error?.code || "after-ready-failed" });
  }

  async function probeListener(rec) {
    const parent = records.get(rec.spec.parent);
    rec.desired = parent?.desired || "stopped";
    if (!parent || parent.state !== "ready") {
      setState(rec, "stopped");
      return rec.state;
    }
    if (!rec.spec.enabled) {
      setState(rec, "disabled");
      return rec.state;
    }
    const result = await probe(rec.spec.readiness);
    rec.health = { live: result.ok, checkedAt: iso() };
    setState(rec, result.ok ? "ready" : "unhealthy");
    if (result.ok) scheduleLiveness(rec, rec.generation);
    return rec.state;
  }

  async function readinessTimeout(rec, generation) {
    const tail = stderrTail(rec);
    rec.message = tail.length ? tail.join("\n") : null;
    rec.requestedStop = true;
    try { await getLauncher().stop(rec.spec, { identity: rec.identity }); } catch {}
    if (rec.generation !== generation) return;
    rec.generation += 1;
    rec.child = null;
    rec.pid = null;
    rec.lastExit = { at: iso(), code: null, signal: null, reason: "readiness-timeout", uptimeSec: Math.round((now() - (rec.startedAt || now())) / 1000), stderrTail: tail, exitLogLine: exitLogLine(rec) };
    applyRestartPolicy(rec, "readiness-timeout");
  }

  // -------------------------------------------------------------------------
  // Liveness

  function scheduleLiveness(rec, generation) {
    cancel(rec.timers.liveness);
    const liveness = rec.spec.liveness;
    if (!liveness) return;
    const interval = Math.max(1, Number(liveness.intervalSec) || 10) * 1000;
    rec.timers.liveness = later(interval, async () => {
      if (rec.generation !== generation || !["ready", "unhealthy"].includes(rec.state)) return;
      const result = await probe(liveness, { timeoutMs: liveness.timeoutMs });
      if (rec.generation !== generation || !["ready", "unhealthy"].includes(rec.state)) return;
      rec.health = { live: result.ok, checkedAt: iso() };
      if (result.ok) {
        rec.failures = 0;
        if (rec.state === "unhealthy") setState(rec, "ready");
      } else {
        rec.failures += 1;
        if (rec.failures >= Math.max(1, Number(liveness.failureThreshold) || 3) && rec.state === "ready") {
          setState(rec, "unhealthy", { reason: "liveness-failed" });
          if (liveness.onFailure === "restart" && rec.spec.kind !== "listener") {
            restart([rec.id], { when: "idle", reason: "liveness-failed" }).catch(() => {});
          }
        }
      }
      scheduleLiveness(rec, generation);
    });
  }

  // -------------------------------------------------------------------------
  // Exits and restarts

  async function onExit(rec, generation, code, signal) {
    if (rec.generation !== generation) return;
    rec.generation += 1;
    rec.child = null;
    cancel(rec.timers.liveness);
    cancel(rec.timers.stable);
    const uptimeSec = Math.max(0, Math.round((now() - (rec.startedAt || now())) / 1000));
    const tail = stderrTail(rec);
    const exitPid = rec.pid;
    rec.pid = null;
    const base = { at: iso(), code: code ?? null, signal: signal ?? null, uptimeSec, stderrTail: tail, exitLogLine: exitLogLine(rec) };
    if (rec.requestedStop) {
      rec.requestedStop = false;
      rec.lastExit = { ...base, reason: "requested" };
      setState(rec, "stopped");
      return;
    }
    let conflict = PORT_CONFLICT_PATTERN.test(tail.join("\n"));
    if (!conflict && enabledPorts(rec.spec).length) {
      const owner = portOwner(await listListeners(), enabledPorts(rec.spec));
      conflict = Boolean(owner && owner.pid !== exitPid);
    }
    if (conflict) {
      rec.lastExit = { ...base, reason: "port-conflict" };
      setState(rec, "blocked", { reason: "port-conflict" });
      return;
    }
    const mode = rec.spec.restartPolicy?.mode || "on-failure";
    if (code === 0 && mode !== "always") {
      // Someone asked the component itself to stop (for example a POST to
      // /api/manager/shutdown): respect it.
      rec.lastExit = { ...base, reason: "exit-clean" };
      rec.desired = "stopped";
      persistDesired();
      setState(rec, "stopped", { reason: "exit-clean" });
      return;
    }
    rec.lastExit = { ...base, reason: "crash" };
    applyRestartPolicy(rec, "crash");
  }

  function applyRestartPolicy(rec, reason) {
    const policy = rec.spec.restartPolicy || componentsApi.DEFAULT_RESTART_POLICY;
    const mode = policy.mode || "on-failure";
    if (mode === "never" || mode === "docker" || rec.desired !== "running" || closed) {
      setState(rec, "failed", { reason });
      return;
    }
    const windowMs = Math.max(1, Number(policy.windowSec) || 600) * 1000;
    const at = now();
    rec.restartTimes = rec.restartTimes.filter((time) => at - time < windowMs);
    const maxRestarts = Math.max(0, Number(policy.maxRestarts ?? 5));
    if (rec.restartTimes.length >= maxRestarts) {
      setState(rec, "failed", { reason: "max-restarts" });
      notify("component.failed", "error", "component.failed", {
        label: rec.spec, count: rec.restartTimes.length, windowMin: Math.round(windowMs / 60000), reason: rec.lastExit?.reason || reason,
      }, { dedupeKey: `component.failed:${rec.id}`, componentId: rec.id, lastExit: rec.lastExit ? { reason: rec.lastExit.reason, code: rec.lastExit.code, at: rec.lastExit.at } : null });
      return;
    }
    const backoff = Array.isArray(policy.backoffSec) && policy.backoffSec.length ? policy.backoffSec : componentsApi.DEFAULT_RESTART_POLICY.backoffSec;
    const delaySec = Number(backoff[Math.min(rec.restartTimes.length, backoff.length - 1)]) || 1;
    rec.restartTimes.push(at);
    rec.restartCount += 1;
    rec.recovering = true;
    setState(rec, "backoff", { reason });
    cancel(rec.timers.backoff);
    rec.timers.backoff = later(delaySec * 1000, () => {
      rec.timers.backoff = null;
      if (rec.state !== "backoff" || rec.desired !== "running") return;
      runStart([rec.id]).catch(() => {});
    });
  }

  function handleVanished(rec) {
    rec.generation += 1;
    rec.pid = null;
    rec.child = null;
    cancel(rec.timers.liveness);
    rec.lastExit = { at: iso(), code: null, signal: null, reason: "vanished", uptimeSec: Math.max(0, Math.round((now() - (rec.startedAt || now())) / 1000)), stderrTail: [], exitLogLine: exitLogLine(rec) };
    if (rec.desired === "running") applyRestartPolicy(rec, "vanished");
    else setState(rec, "stopped", { reason: "vanished" });
  }

  // -------------------------------------------------------------------------
  // Adoption and reconcile (§5.8)

  function archiveIdentity(id) {
    const active = getLauncher();
    if (typeof active.archiveIdentity === "function") return active.archiveIdentity(id);
    const file = path.join(stateDir, `${id}.json`);
    try { fs.renameSync(file, path.join(stateDir, `${id}.prev.json`)); } catch {}
    return undefined;
  }

  async function tryAdopt(rec, owner) {
    const active = getLauncher();
    let saved = null;
    try { saved = active.readIdentity(rec.id); } catch {}
    if (saved) {
      let info = null;
      try { info = await winproc.processInfo(saved.pid); } catch {}
      if (!info) {
        archiveIdentity(rec.id);
      } else if (Number(saved.pid) === Number(owner.pid) && winprocDefault.matchesIdentity(saved, info)) {
        await adoptRecord(rec, saved, "supervisor");
        return true;
      } else {
        // The record names a live process that is not the port owner, or the
        // PID was reused: never kill on a stale identity.
        setState(rec, "unknown", { reason: "identity-mismatch" });
        return true;
      }
    }
    let info = null;
    try { info = await winproc.processInfo(owner.pid); } catch {}
    if (!looksLikePlatform(rec.spec, info)) return false;
    const ready = rec.spec.readiness ? await probe(rec.spec.readiness) : { ok: false };
    if (!ready.ok) return false;
    const adopted = await active.adopt(rec.spec, info);
    if (!adopted?.ok) return false;
    await adoptRecord(rec, adopted.identity, "adopted");
    return true;
  }

  async function reconcile() {
    if (closed) return;
    const list = await listListeners();
    for (const rec of records.values()) {
      const spec = rec.spec;
      if (spec.kind === "listener" || spec.kind === "external" || spec.kind === "compose" || spec.kind === "group") continue;
      if (["starting", "stopping", "backoff"].includes(rec.state)) continue;
      if (rec.pid && (rec.owner === "supervisor" || rec.owner === "adopted")) {
        let info = null;
        try { info = await winproc.processInfo(rec.pid); } catch { continue; }
        if (!info) {
          // A child we spawned reports its own exit; this covers adopted
          // processes and missed exit events.
          if (!rec.child) handleVanished(rec);
        } else if (rec.identity && !winprocDefault.matchesIdentity(rec.identity, info)) {
          setState(rec, "unknown", { reason: "identity-mismatch" });
        }
        continue;
      }
      const ports = enabledPorts(spec);
      const owner = ports.length ? portOwner(list, ports) : null;
      if (owner) {
        if (rec.state === "unknown" && rec.reason === "identity-mismatch") continue;
        const adopted = await tryAdopt(rec, owner);
        if (!adopted && !["blocked", "unknown"].includes(rec.state)) setState(rec, "unknown", { reason: "unknown-owner", message: null });
      } else {
        let saved = null;
        try { saved = getLauncher().readIdentity(rec.id); } catch {}
        if (saved) {
          let info = null;
          try { info = await winproc.processInfo(saved.pid); } catch { continue; }
          if (!info) archiveIdentity(rec.id);
        }
        if (rec.state === "unknown") setState(rec, "stopped");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Run a start plan

  async function runStart(ids, { line = () => {} } = {}) {
    const order = expand(ids);
    const settled = new Map();
    for (const id of order) {
      const rec = record(id);
      const spec = rec.spec;
      if (spec.kind !== "listener" && !spec.detectOnly) rec.desired = "running";
      persistDesired();
      if (spec.kind === "external") {
        if (spec.ensure) settled.set(id, rec.state === "ready" ? Promise.resolve("ready") : ensureDocker(rec));
        else if (spec.detectOnly) {
          const owner = portOwner(await listListeners(), enabledPorts(spec));
          setState(rec, owner ? "external" : "stopped");
          settled.set(id, Promise.resolve(rec.state));
        }
        continue;
      }
      if (spec.kind === "listener") {
        settled.set(id, (settled.get(spec.parent) || Promise.resolve()).then(() => probeListener(rec)));
        continue;
      }
      // Dependents wait only on dependsOn; `after` members were spawned before.
      let blockedBy = null;
      for (const dep of spec.dependsOn || []) {
        const state = await (settled.get(dep) || Promise.resolve(record(dep).state));
        if (state !== "ready" && state !== "external") {
          blockedBy = { dep, state };
          break;
        }
      }
      if (blockedBy) {
        const reason = blockedBy.dep === "docker" ? "docker-unavailable" : "dependency-not-ready";
        setState(rec, "blocked", { reason, detail: { dependency: blockedBy.dep } });
        settled.set(id, Promise.resolve(rec.state));
        continue;
      }
      line(`${labelOf(spec, "en-US")}: starting`);
      settled.set(id, spawnStep(rec));
    }
    const results = {};
    for (const [id, promise] of settled) results[id] = await promise;
    for (const [id, state] of Object.entries(results)) line(`${labelOf(record(id).spec, "en-US")}: ${state}`);
    return results;
  }

  async function dockerTick() {
    const docker = records.get("docker");
    if (!docker || docker.desired !== "running") return;
    const result = await probe(docker.spec.readiness);
    if (result.ok && docker.state !== "ready") setState(docker, "ready");
    else if (!result.ok && docker.state === "ready") setState(docker, "blocked", { reason: "docker-unavailable" });
    if (docker.state !== "ready") return;
    const waiting = [...records.values()].filter((rec) => rec.state === "blocked" && rec.reason === "docker-unavailable" && rec.desired === "running").map((rec) => rec.id);
    if (waiting.length) await runStart(waiting);
  }

  // -------------------------------------------------------------------------
  // Stop

  function stoppable(rec) {
    const spec = rec.spec;
    return !(spec.detectOnly || spec.kind === "external" || spec.kind === "listener" || spec.stop?.strategy === "never");
  }

  async function stopOne(rec, { explicit = false, keepDesired = false } = {}) {
    if (!stoppable(rec)) throw controlError(400, "detect_only_component", `${rec.id} is detected only and is never stopped by the platform.`);
    if (!keepDesired) {
      rec.desired = "stopped";
      persistDesired();
    }
    cancel(rec.timers.backoff);
    cancel(rec.timers.liveness);
    cancel(rec.timers.stable);
    if (rec.spec.kind !== "compose" && !rec.pid && NOT_RUNNING_STATES.has(rec.state)) {
      if (rec.state === "backoff" || (rec.state === "unknown" && rec.reason !== "identity-mismatch")) setState(rec, "stopped");
      return { ok: true, stopped: true, state: rec.state };
    }
    rec.requestedStop = true;
    setState(rec, "stopping");
    let result;
    try {
      result = await getLauncher().stop(rec.spec, { identity: rec.identity, explicit });
    } catch (error) {
      result = { ok: false, code: error?.code || "stop_failed" };
    }
    for (const child of listenerChildren(rec.id)) setState(child, "stopped");
    if (!result?.ok) {
      rec.requestedStop = false;
      if (result?.reason === "identity-mismatch") setState(rec, "unknown", { reason: "identity-mismatch" });
      else setState(rec, rec.pid ? "unknown" : "stopped", { reason: result?.code || "stop_failed" });
      return { ok: false, code: result?.code || "stop_failed", state: rec.state, reason: rec.reason };
    }
    rec.generation += 1;
    rec.requestedStop = false;
    rec.child = null;
    rec.pid = null;
    rec.identity = null;
    const reason = result.reason === "killed-by-supervisor" ? "killed-by-supervisor" : "requested";
    rec.lastExit = { at: iso(), code: null, signal: null, reason, uptimeSec: Math.max(0, Math.round((now() - (rec.startedAt || now())) / 1000)), stderrTail: [], exitLogLine: null };
    setState(rec, "stopped");
    return { ok: true, stopped: true, state: rec.state, reason };
  }

  async function managerInstances(rec) {
    const origin = rec.spec.urls?.api;
    if (!origin) return [];
    const response = await fetchImpl(`${origin}/api/instances`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    return Array.isArray(body) ? body : Array.isArray(body?.instances) ? body.instances : [];
  }

  // Model containers are stopped only on an explicit, confirmed request.
  async function stopModels(recs, confirm) {
    const containers = [];
    for (const rec of recs.filter((item) => MANAGER_IDS[item.id] && LIVE_STATES.has(item.state))) {
      let list = [];
      try { list = await managerInstances(rec); } catch {}
      for (const instance of list) {
        if (instance?.running === false) continue;
        containers.push({ managerId: MANAGER_IDS[rec.id], componentId: rec.id, instanceId: String(instance.id || instance.instanceId || ""), name: instance.containerName || instance.name || null });
      }
    }
    if (!confirm) throw controlError(400, "confirm_required", "Stopping model containers needs confirm:true.", { containers });
    for (const container of containers) {
      const origin = record(container.componentId).spec.urls.api;
      try {
        await fetchImpl(`${origin}/api/instances/${encodeURIComponent(container.instanceId)}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30000) });
      } catch {}
    }
    return containers;
  }

  // -------------------------------------------------------------------------
  // Idle gate and pending restarts (§5.11)

  async function blockersFor(ids) {
    const running = [...records.values()].filter((rec) => LIVE_STATES.has(rec.state) && rec.spec.busy).map((rec) => rec.spec);
    const collect = options.collectBlockers || ((input) => idleApi.collectBlockers({ entryClient: getEntryClient(), fetch: fetchImpl, now, ...input }));
    const all = await collect({ components: running });
    if (!ids) return all;
    // Entry-side blockers (in-flight gateway streams, hub transfers, an
    // unreadable busy probe) hold every restart; a manager's own jobs hold
    // only that manager.
    return all.filter((blocker) => blocker.source === "entry" || ids.includes(blocker.source));
  }

  // explicit marks a user's request; compose members are only stopped then.
  async function restartNow(ids, line = () => {}, explicit = false) {
    const order = componentsApi.stopOrder(registry, ids);
    for (const id of order) {
      line(`${id}: stopping`);
      const stopped = await stopOne(record(id), { keepDesired: true, explicit });
      if (!stopped.ok) throw controlError(409, stopped.code || "stop_failed", `${id} could not be stopped (${stopped.reason || stopped.code}).`);
    }
    return runStart(ids, { line });
  }

  async function restart(ids, { when = "now", force = false, reason = "requested", explicit = false } = {}) {
    const list = ids.map((id) => record(id));
    for (const rec of list) if (!stoppable(rec)) throw controlError(400, "detect_only_component", `${rec.id} cannot be restarted by the platform.`);
    const names = list.map((rec) => rec.id);
    const blockers = force ? [] : await blockersFor(names);
    if (when === "idle" && blockers.length) {
      const queuedAt = iso();
      for (const id of names) {
        pending = pending.filter((item) => item.id !== id);
        pending.push({ id, reason, queuedAt, deadline: iso(now() + PENDING_DEADLINE_MS) });
      }
      persistPending();
      scheduleStatus();
      return { queued: names, blockers };
    }
    if (blockers.length) throw controlError(409, "component_busy", "The platform is busy; restart later, queue it for idle or force it.", { blockers });
    const op = startOperation("restart", ({ line }) => restartNow(names, line, explicit));
    return { opId: op.opId, done: op.done };
  }

  async function pendingTick() {
    if (!pending.length) return;
    for (const item of pending.slice()) {
      const blockers = await blockersFor([item.id]);
      if (!blockers.length) {
        pending = pending.filter((entry) => entry.id !== item.id);
        persistPending();
        const op = startOperation("restart", ({ line }) => restartNow([item.id], line));
        await op.done;
        notify("restart.executed", "info", "restart.executed", { label: record(item.id).spec }, { dedupeKey: `restart.executed:${item.id}` });
        continue;
      }
      if (!item.overdueNotifiedAt && now() > Date.parse(item.deadline)) {
        item.overdueNotifiedAt = iso();
        persistPending();
        notify("restart.overdue", "warn", "restart.overdue", {
          label: record(item.id).spec, hours: Math.round(PENDING_DEADLINE_MS / 3600000),
          blockers: [...new Set(blockers.map((blocker) => blocker.kind))].join(", "),
        }, { dedupeKey: `restart.overdue:${item.id}` });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Status

  async function fetchInstances() {
    if (now() - instancesCache.at < INSTANCES_CACHE_MS) return instancesCache.value;
    const managers = [...records.values()].filter((rec) => MANAGER_IDS[rec.id]);
    let reached = false;
    const out = [];
    for (const rec of managers) {
      if (!LIVE_STATES.has(rec.state)) continue;
      try {
        for (const instance of await managerInstances(rec)) out.push({ ...instance, managerId: MANAGER_IDS[rec.id] });
        reached = true;
      } catch {}
    }
    const value = reached ? out : managers.some((rec) => LIVE_STATES.has(rec.state)) ? null : [];
    instancesCache = { at: now(), value };
    return value;
  }

  async function keySummary() {
    if (statusApi.exposureMode(config.values) === "local") return null;
    if (now() - keysCache.at < KEYS_CACHE_MS) return keysCache.value;
    let value = null;
    if (typeof options.keySummary === "function") {
      try { value = await options.keySummary(); } catch {}
    } else if (records.get("entry")?.state === "ready") {
      try {
        const result = await getEntryClient().request("GET", "/api/status", { timeoutMs: 5000 });
        const store = result.json?.security?.keyStore;
        if (result.status === 200 && store && Number.isFinite(Number(store.activeKeys))) value = { activeKeys: Number(store.activeKeys) };
      } catch {}
    }
    keysCache = { at: now(), value };
    return value;
  }

  function componentRow(rec) {
    const windowMs = Math.max(1, Number(rec.spec.restartPolicy?.windowSec) || 600) * 1000;
    const pendingItem = pending.find((item) => item.id === rec.id) || null;
    const live = LIVE_STATES.has(rec.state) || rec.state === "stopping";
    return {
      id: rec.id, legacyId: rec.spec.legacyId, kind: rec.spec.kind, profile: rec.spec.profile, label: rec.spec.label, parent: rec.spec.parent,
      desired: rec.desired, state: rec.state, owner: rec.pid ? rec.owner : "none", pid: rec.pid,
      ports: rec.spec.ports || [],
      uptimeSec: live && rec.startedAt ? Math.max(0, Math.round((now() - rec.startedAt) / 1000)) : null,
      restarts: { count: rec.restartCount, windowCount: rec.restartTimes.filter((time) => now() - time < windowMs).length },
      lastExit: rec.lastExit, health: rec.health,
      pendingRestart: pendingItem ? { reason: pendingItem.reason, queuedAt: pendingItem.queuedAt, deadline: pendingItem.deadline } : null,
      message: rec.message, reason: rec.reason || undefined, blocked: rec.blocked || undefined,
      counted: rec.desired === "running" || rec.state === "ready",
    };
  }

  async function status() {
    const [instances, keys] = await Promise.all([fetchInstances(), keySummary()]);
    let ops = null;
    try { ops = options.readOps ? options.readOps() : statusApi.readOpsSummary({ aiRoot, now }); } catch {}
    return statusApi.buildPlatformStatus({
      mode: "supervised",
      at: iso(),
      build: buildId(),
      supervisor: { pid: options.pid ?? process.pid, startedAt: startedAt ? iso(startedAt) : null, profile },
      components: [...records.values()].map(componentRow),
      doctor: doctorLast,
      instances,
      config,
      keys,
      ops,
      pendingRestarts: pending.map((item) => ({ id: item.id, reason: item.reason, queuedAt: item.queuedAt, deadline: item.deadline })),
    });
  }

  async function runDoctorTick() {
    if (options.runDoctor === false) return;
    try {
      const run = options.runDoctor || require("./doctor").runDoctor;
      doctorLast = await run({ aiRoot, env, config, registry, groups: ["env", "runtime"] });
      writeJsonFile(doctorFile, doctorLast);
      scheduleStatus();
    } catch (error) {
      log({ code: "doctor_failed", message: String(error?.code || error?.message || error) });
    }
  }

  function copyTruncateTick() {
    const maxBytes = Number(config.values?.["supervisor.logs.maxBytes"]) || 20 * 1024 * 1024;
    const keep = Number(config.values?.["supervisor.logs.keep"]) || 5;
    for (const rec of records.values()) {
      if (!LIVE_STATES.has(rec.state) || !rec.spec.logs) continue;
      for (const file of [rec.spec.logs.out, rec.spec.logs.err]) {
        try { logs.maybeCopyTruncate(file, maxBytes, { keep }); } catch {}
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API

  function rowFor(id) {
    const rec = record(id);
    const row = componentRow(rec);
    delete row.counted;
    return JSON.parse(JSON.stringify(row));
  }

  function redactedSpec(spec) {
    const copy = JSON.parse(JSON.stringify(spec));
    if (copy.env) copy.env = Object.fromEntries(Object.keys(copy.env).sort().map((name) => [name, "<redacted>"]));
    if (Array.isArray(copy.members)) for (const member of copy.members) if (member.env) member.env = Object.fromEntries(Object.keys(member.env).sort().map((name) => [name, "<redacted>"]));
    return copy;
  }

  function logFilesFor(rec, legacy) {
    if (legacy) {
      const dir = rec.spec.cwd ? path.join(rec.spec.cwd, "logs") : null;
      return dir ? { out: path.join(dir, "manager.out.log"), err: path.join(dir, "manager.err.log") } : {};
    }
    return rec.spec.logs || {};
  }

  const api = {
    get profile() { return profile; },
    get records() { return records; },

    async start() {
      if (started) return;
      started = true;
      startedAt = now();
      await reconcile();
      let ids = [];
      try { ids = profile === "none" ? [] : componentsApi.selectProfile(registry, profile); } catch {}
      const desiredIds = [...records.values()].filter((rec) => rec.desired === "running").map((rec) => rec.id);
      const plan = [...new Set([...ids, ...desiredIds])];
      every(RECONCILE_MS, reconcile);
      every(DOCKER_PROBE_MS, dockerTick);
      every(PENDING_CHECK_MS, pendingTick);
      every(COPY_TRUNCATE_MS, copyTruncateTick);
      if (options.runDoctor !== false) {
        runDoctorTick();
        every(DOCTOR_MS, runDoctorTick);
      }
      if (plan.length) await runStart(plan);
    },

    status,
    reconcile,
    dockerTick,
    pendingTick,
    startComponents: (ids, { wait = false } = {}) => {
      const op = startOperation("start", ({ line }) => runStart(ids, { line }));
      return wait ? op.done.then((result) => ({ opId: op.opId, result })) : { opId: op.opId, done: op.done };
    },

    async listComponents() {
      return [...records.keys()].map(rowFor);
    },
    async describeComponent(id) {
      const rec = record(id);
      return { component: rowFor(rec.id), spec: redactedSpec(rec.spec) };
    },
    async startComponent(id, { wait = false } = {}) {
      const rec = record(id);
      if (rec.spec.detectOnly || rec.spec.kind === "listener") throw controlError(400, "detect_only_component", `${rec.id} is not started on its own.`);
      const op = startOperation("start", ({ line }) => runStart([rec.id], { line }));
      if (!wait) return { opId: op.opId };
      await op.done;
      return { opId: op.opId, component: rowFor(rec.id) };
    },
    async stopComponent(id, { wait = false, models = false, confirm = false } = {}) {
      const rec = record(id);
      if (!stoppable(rec)) throw controlError(400, "detect_only_component", `${rec.id} is detected only and is never stopped by the platform.`);
      if (models) await stopModels([rec], confirm);
      const op = startOperation("stop", () => stopOne(rec, { explicit: true }));
      if (!wait) return { opId: op.opId };
      await op.done;
      return { opId: op.opId, component: rowFor(rec.id) };
    },
    async restart(ids, restartOptions = {}) {
      const result = await restart(Array.isArray(ids) ? ids : [ids], { explicit: true, ...restartOptions });
      const { done, ...rest } = result;
      if (restartOptions.wait && done) await done;
      return rest;
    },
    async startProfile(name, { runtimeOverrides: overrides } = {}) {
      componentsApi.selectProfile(registry, name);
      if (overrides && typeof overrides === "object") {
        runtimeOverrides = { ...overrides };
        config = loadConfig(runtimeOverrides);
        registry = loadRegistry(config);
        for (const rec of records.values()) if (!LIVE_STATES.has(rec.state)) rec.spec = resolveSpec(componentsApi.getComponent(registry, rec.id));
      }
      profile = name === "all" ? "full" : name;
      const ids = componentsApi.selectProfile(registry, profile);
      const op = startOperation("start", ({ line }) => runStart(ids, { line }));
      return { opId: op.opId };
    },
    async stopScope({ scope = "all", models = false, confirm = false, exitSupervisor } = {}) {
      const ids = scope === "all" ? [...records.keys()] : componentsApi.selectProfile(registry, scope, { includeOnDemand: true });
      const order = componentsApi.stopOrder(registry, ids);
      const targets = order.map((id) => record(id));
      if (models) await stopModels(targets, confirm);
      const exit = exitSupervisor === undefined ? scope === "all" : exitSupervisor === true;
      const op = startOperation("stop", async ({ line }) => {
        for (const rec of targets) {
          line(`${rec.id}: stopping`);
          await stopOne(rec, { explicit: true });
        }
        if (exit) api.shutdown({ leaveChildren: true });
        return { stopped: targets.map((rec) => rec.id) };
      });
      return { opId: op.opId };
    },
    async componentLogs(id, { stream = "all", tail = 200, legacy = false } = {}) {
      const rec = record(id);
      const files = logFilesFor(rec, legacy);
      const lines = [];
      const listed = [];
      for (const name of stream === "all" ? ["out", "err"] : [stream]) {
        if (!files[name]) continue;
        listed.push(files[name]);
        const text = logs.tailLog(files[name], { lines: tail, aiRoot, ...(options.redactor ? { redactor: options.redactor } : {}) });
        for (const value of text ? text.split("\n") : []) lines.push({ stream: name, text: value });
      }
      return { lines, files: listed };
    },
    followLogs(id, { stream = "all" } = {}, onLine) {
      const rec = record(id);
      const files = logFilesFor(rec, false);
      const followers = (stream === "all" ? ["out", "err"] : [stream]).filter((name) => files[name]).map((name) => logs.followLog(files[name], {
        aiRoot, lines: 0, ...(options.redactor ? { redactor: options.redactor } : {}),
        onLine: (text) => onLine({ stream: name, text }),
      }));
      return () => followers.forEach((follower) => follower.close());
    },
    async idle() {
      const blockers = await blockersFor(null);
      return { idle: blockers.length === 0, blockers };
    },
    async pendingRestarts() {
      return pending.map((item) => ({ ...item }));
    },
    // POST /v1/doctor/fix (06 §7.3). prepare() rejects manual fixes and
    // unconfirmed confirm fixes before any operation exists; the fix itself
    // runs as a streamed "doctor-fix" operation.
    async runFix(body = {}) {
      const create = options.createFixRunner || require("./doctor-fix").createFixRunner;
      const runner = create({
        aiRoot, env, config, registry, supervisor: api, fetch: fetchImpl, winproc, now,
        ...(options.redactor ? { redactor: options.redactor } : {}),
        ...(options.fixOptions || {}),
      });
      const plan = await runner.prepare(body);
      const op = startOperation("doctor-fix", ({ line, progress }) => runner.execute(plan, { line, progress }));
      return { opId: op.opId };
    },
    async cancelPendingRestart(id) {
      const before = pending.length;
      pending = pending.filter((item) => item.id !== id);
      persistPending();
      scheduleStatus();
      return { ok: true, removed: before !== pending.length };
    },
    async operations() {
      return [...operations.values()].map(publicOperation);
    },
    async operation(opId) {
      const op = operations.get(opId);
      if (!op) throw controlError(404, "operation_unknown", `Unknown operation ${opId}.`);
      return publicOperation(op);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitNotification: (kind, severity, key, params, extra) => notify(kind, severity, key, params, extra),

    // §5.13 hand-off: close the pipe, start the successor, wait for its pipe,
    // exit. Children are never touched; the successor adopts them.
    async reexec() {
      const opId = operationId();
      later(50, async () => {
        try { await options.closeControl?.(); } catch {}
        let ok = false;
        try {
          await options.spawnSupervisor?.(["supervise", "--takeover", "--profile", profile]);
          ok = options.waitForPipe ? await options.waitForPipe(10000) : false;
        } catch { ok = false; }
        if (ok) {
          api.close();
          options.exit?.(0);
          return;
        }
        try { await options.reopenControl?.(); } catch {}
        emit("operation", { opId, kind: "reexec", state: "failed", progress: 1, line: "reexec_failed" });
      });
      return { opId };
    },
    async shutdown({ leaveChildren = true } = {}) {
      later(50, async () => {
        if (!leaveChildren) {
          for (const id of componentsApi.stopOrder(registry, [...records.keys()])) {
            try { await stopOne(record(id), { explicit: true }); } catch {}
          }
        }
        api.close();
        try { await options.closeControl?.(); } catch {}
        options.exit?.(0);
      });
      return { leaveChildren };
    },
    close() {
      closed = true;
      for (const handle of [...timers]) cancel(handle);
      for (const rec of records.values()) {
        const waiters = rec.readyWaiters.splice(0);
        for (const resolve of waiters) resolve(rec.state);
      }
    },
  };
  return api;
}

/**
 * The `platform supervise` process (06 §5.1): a fresh control token in the
 * secret store, the pipe server (EADDRINUSE -> { alreadyRunning: true }) and
 * the supervisor. options are passed to createSupervisor; tokenStore and
 * endpoint may be injected.
 */
async function startSupervisorProcess(options = {}) {
  const control = require("./control");
  const aiRoot = path.resolve(options.aiRoot || path.join(__dirname, "../.."));
  const endpoint = options.endpoint || control.controlEndpoint(aiRoot);
  const token = control.createControlToken();
  const tokenStore = options.tokenStore || control.createControlTokenStore({ aiRoot });
  let server = null;
  const supervisor = createSupervisor({
    ...options,
    aiRoot,
    closeControl: async () => { if (server) await server.close(); server = null; },
    reopenControl: async () => { server = await control.startControlServer({ endpoint, token, supervisor, log: options.log }); },
  });
  try {
    server = await control.startControlServer({ endpoint, token, supervisor, log: options.log });
  } catch (error) {
    supervisor.close();
    if (error.code === "EADDRINUSE") return { alreadyRunning: true, endpoint };
    throw error;
  }
  await tokenStore.write(token);
  await supervisor.start();
  return { alreadyRunning: false, endpoint, supervisor, close: async () => { supervisor.close(); if (server) await server.close(); } };
}

module.exports = { createSupervisor, startSupervisorProcess };
