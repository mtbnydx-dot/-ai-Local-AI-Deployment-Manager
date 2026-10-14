"use strict";

// EventCollector (docs/overhaul/04-telemetry.md §9). Runs in the entry and
// writes one `events` row per platform event through store.insertEvents.
//
// Sources:
// - The ENT-EV bus (service-entry/lib/events.js). The collector calls
//   events.subscribe() once for jobs, instances, status, downloads, security,
//   access and platform, and never publishes or touches the bus otherwise.
//   Manager `jobs` and `instances` arrive through ENT-EV's manager relay.
//   - Serve and start jobs become launch.started, one launch.phase per
//     meta.stageHistory entry, and launch.ready or launch.failed. The
//     failure message passes through secret-redactor.js and is cut to 300
//     characters. Times come from the job itself, so a late or replayed
//     job still lands at the right moment.
//   - `instances` triggers one read of the manager's /api/instances (through
//     `managers.get`). An instance with lifecycle.phase (01) gives
//     launch.phase with its launchId, and from then on that manager's job
//     stage history no longer produces phases. State changes give
//     instance.state.
//   - `status` manager_up/manager_down from the relay give
//     manager.reachable/manager.unreachable on edges only.
//   - `security` and `access` (05) and `platform` (06) are recorded by kind:
//     security.<kind>, config.keys or config.exposure, platform.component
//     and config.platform. Terminal downloads give download.<state>.
// - Docker: `docker events --filter label=ai.manager --format "{{json .}}"`
//   as one long-lived child (createDockerEventSource). die gives
//   container.exit {exitCode, oomKilled}, oom gives container.oom
//   (critical), health_status gives container.health, start gives
//   container.start. A failed or ended stream reconnects with backoff from
//   5 s to 5 min. Docker Desktop is never started, and a WSL distro is only
//   used while it is already running (`wsl --list --running`), because
//   `wsl -d <distro>` would boot it.
// - Incremental tails of process-exit.log (entry and each manager) and of
//   the platform-mcp audit log. Offsets live in collector_state, together
//   with the last process event per label, so a restart resumes where it
//   stopped and a `start` with no `exit` before it still gives
//   manager.hard_kill_suspected. A rotated process-exit.log (renamed to
//   .1 by process-exit-log.js) is read to its end first.
// - <AI_ROOT>/config/platform.json: a changed mtime gives config.platform
//   with the changed key names only. recordConfigChange() is the hook for
//   writers that know what they changed (fleet settings, writeSection).
// - Manager /api/benchmarks, polled every 5 min, gives benchmark.run.
//
// Every row with a natural identity carries a dedupe_key, so replays, a
// relay reconnect and a restart insert nothing twice (the store ignores a
// duplicate key). Event data is redacted with redactValue before it is
// queued; the store redacts and caps it again (16 KiB). Titles are English;
// data.i18nKey lets the console localise them.

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const readline = require("node:readline");
const { redactSecrets, redactValue } = require("../../secret-redactor");

const STATE_NAME = "collector.events";
const SUBSCRIBED_TYPES = Object.freeze(["jobs", "instances", "status", "downloads", "security", "access", "platform"]);
const LAUNCH_JOB_TYPES = new Set(["serve", "start"]);
const READY_STATES = new Set(["success", "succeeded", "ready", "completed"]);
const FAILED_STATES = new Set(["failed", "error", "interrupted", "cancelled", "canceled"]);
const DOWNLOAD_TERMINAL = Object.freeze({
  success: "completed",
  completed: "completed",
  done: "completed",
  failed: "failed",
  error: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
});
const CONFIG_SECTIONS = new Set(["fleet", "keys", "exposure", "telemetry", "alerts", "platform"]);
const SECURITY_WARNINGS = new Set(["ban", "internal_auth_failed", "admin_via_proxy", "direct_manager_gateway"]);
const PLATFORM_BAD_STATES = new Set(["unhealthy", "crashed", "failed", "error"]);
const CRASH_EVENTS = new Set(["uncaught-exception", "unhandled-rejection", "shutdown-error"]);

const MESSAGE_MAX_CHARS = 300;
const TITLE_MAX_CHARS = 200;
const MAX_CHANGED_KEYS = 100;
const MAX_PENDING_ROWS = 5000;
const SEEN_KEYS_MAX = 20_000;
const STOP_FLUSH_MS = 2000;

const DOCKER_MIN_BACKOFF_MS = 5000;
const DOCKER_MAX_BACKOFF_MS = 5 * 60_000;
// A stream that stayed up this long starts the next backoff from the bottom.
const DOCKER_STABLE_MS = 60_000;
// A reconnect replays at most this far back (docker events --since).
const DOCKER_REPLAY_MAX_MS = 24 * 3_600_000;
// docker sends oom just before die; this long an oom marks the die oomKilled.
const OOM_WINDOW_MS = 60_000;
const WSL_LIST_TIMEOUT_MS = 5000;
const STDERR_KEEP_CHARS = 500;

const TAIL_INTERVAL_MS = 5000;
const TAIL_READ_MAX_BYTES = 1024 * 1024;
const HEAD_BYTES = 64;
const CONFIG_CHECK_MS = 30_000;
const CONFIG_READ_MAX_BYTES = 1024 * 1024;
const BENCHMARK_INTERVAL_MS = 5 * 60_000;
const BENCHMARK_FIRST_DELAY_MS = 30_000;
const MAX_BENCHMARK_RUNS = 200;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampInt(value, min, max, fallback) {
  const number = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function toMs(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteOrNull(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function iso(ms) {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function text(value, max = 128) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

// Machine codes and slugs only; anything else is dropped rather than stored.
function slug(value, max = 64) {
  const candidate = text(value, max + 1);
  return /^[A-Za-z0-9_.:-]+$/.test(candidate) && candidate.length <= max ? candidate : "";
}

// A model reference can be a local path; titles and data keep its last
// segment, so no host path reaches a viewer.
function modelLabel(value) {
  const raw = text(value, 400);
  if (!raw) return "";
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return "";
  const looksLikePath = /^[A-Za-z]:[\\/]|^[\\/]|\\/.test(raw) || parts.length > 2;
  return (looksLikePath ? parts[parts.length - 1] : parts.join("/")).slice(0, 160);
}

// Redacted, single line, at most 300 characters.
function redactMessage(value) {
  const raw = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const cleaned = redactSecrets(raw).replace(/\s+/g, " ").trim();
  return cleaned.length > MESSAGE_MAX_CHARS ? `${cleaned.slice(0, MESSAGE_MAX_CHARS - 1)}…` : cleaned;
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).find((line) => line.trim()) || "";
}

function sourceFor(managerId) {
  return slug(managerId, 32) || "entry";
}

function normalizeLogger(logger) {
  const target = logger === undefined ? console : logger;
  return (level, message) => {
    if (!target) return;
    const line = redactSecrets(String(message));
    if (typeof target === "function") {
      target(level, line);
      return;
    }
    const method = typeof target[level] === "function" ? target[level] : target.log;
    if (typeof method === "function") method.call(target, line);
  };
}

// The row shape store.insertEvents takes (camelCase keys). data gets the
// console's i18n key and is redacted here as well as in the store.
function eventRow({ at, type, severity = "info", source, managerId = null, fleetId = null, launchId = null, requestId = null, title, data = null, dedupeKey = null }) {
  const payload = isPlainObject(data) ? { ...data, i18nKey: `obs.event.${type}` } : { i18nKey: `obs.event.${type}` };
  return {
    at: Math.floor(Number(at)),
    type,
    severity,
    source: text(source, 32) || "entry",
    managerId: text(managerId, 64) || null,
    fleetId: text(fleetId, 160) || null,
    launchId: text(launchId, 64) || null,
    requestId: text(requestId, 128) || null,
    title: redactSecrets(String(title || type)).slice(0, TITLE_MAX_CHARS),
    data: redactValue(payload),
    dedupeKey: dedupeKey ? String(dedupeKey).slice(0, 512) : null,
  };
}

// --- jobs ----------------------------------------------------------------

function jobIdOf(job) {
  const id = job?.id;
  if (typeof id === "string" && id) return id.slice(0, 128);
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return "";
}

// Manager jobs carry `status` today; a later `state` wins when present.
function jobState(job) {
  const value = typeof job?.state === "string" ? job.state : typeof job?.status === "string" ? job.status : "";
  return value.toLowerCase();
}

// Replace-mode launches serve the manager's primary instance; parallel ones
// their own id, which is the instance id /api/instances reports.
function fleetIdForJob(managerId, meta) {
  if (typeof meta.fleetId === "string" && /^[a-z][a-z0-9-]{0,31}:[^\s]{1,120}$/.test(meta.fleetId)) return meta.fleetId;
  const parallel = String(meta.instanceMode || "").toLowerCase() === "parallel";
  const instanceId = parallel ? text(meta.instanceId, 120) : "primary";
  return instanceId ? `${managerId}:${instanceId}` : null;
}

function stageList(history) {
  if (!Array.isArray(history)) return [];
  const stages = [];
  for (const entry of history) {
    const phase = text(entry?.stage ?? entry?.phase, 120);
    const at = toMs(entry?.at);
    if (phase && at !== null) stages.push({ phase, at });
  }
  return stages;
}

function errorSignatureOf(job, meta) {
  const error = isPlainObject(job.error) ? job.error : null;
  return slug(error?.signatureId) || slug(error?.code) || slug(meta.errorSignature) || slug(meta.errorCode)
    || (["interrupted", "cancelled", "canceled"].includes(jobState(job)) ? jobState(job).replace("canceled", "cancelled") : null);
}

function errorMessageOf(job) {
  const error = job.error;
  if (typeof error === "string") return error;
  if (isPlainObject(error)) return error.message || error.logExcerpt || error.code || "";
  return job.progress?.detail || "";
}

/**
 * The launch events of one serve/start job snapshot, as store rows. Pure:
 * the same job always yields the same rows and dedupe keys.
 * options: { now, skipStagePhases, launchId, gpuUsedBeforeMb, gpuUsedAfterMb }.
 */
function launchEventsFromJob(managerId, job, options = {}) {
  if (!isPlainObject(job) || !LAUNCH_JOB_TYPES.has(String(job.type || ""))) return [];
  const jobId = jobIdOf(job);
  const manager = slug(managerId, 32);
  if (!jobId || !manager) return [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const meta = isPlainObject(job.meta) ? job.meta : {};
  const status = jobState(job);
  const createdMs = toMs(job.createdAt) ?? toMs(job.updatedAt) ?? now;
  const terminal = READY_STATES.has(status) || FAILED_STATES.has(status);
  const endMs = toMs(job.finishedAt) ?? (terminal ? toMs(job.updatedAt) ?? now : null);
  const model = modelLabel(meta.name || meta.model);
  const engineId = slug(meta.engineId || meta.engine, 32) || null;
  const base = {
    source: sourceFor(manager),
    managerId: manager,
    fleetId: fleetIdForJob(manager, meta),
    launchId: text(meta.launchId, 64) || text(options.launchId, 64) || null,
  };
  const prefix = `job:${manager}:${jobId}`;
  const name = model || jobId;
  const stages = stageList(meta.stageHistory);
  const rows = [eventRow({
    ...base,
    at: createdMs,
    type: "launch.started",
    title: `Launch started: ${name}`,
    data: { jobId, model, engineId, instanceMode: text(meta.instanceMode, 16) || null },
    dedupeKey: `${prefix}:started`,
  })];
  if (!options.skipStagePhases) {
    stages.forEach((stage, index) => {
      const previous = stages[index - 1] || null;
      rows.push(eventRow({
        ...base,
        at: stage.at,
        type: "launch.phase",
        title: `Launch phase: ${stage.phase}`,
        data: {
          jobId,
          phase: stage.phase,
          prevPhase: previous ? previous.phase : null,
          prevDurationMs: previous ? Math.max(0, stage.at - previous.at) : null,
        },
        dedupeKey: `${prefix}:stage:${stage.at}`,
      }));
    });
  }
  const durationMs = endMs !== null ? Math.max(0, endMs - createdMs) : null;
  if (READY_STATES.has(status)) {
    const phases = stages.map((stage, index) => {
      const next = stages[index + 1];
      const until = next ? next.at : endMs;
      return { phase: stage.phase, durationMs: until === null ? null : Math.max(0, until - stage.at) };
    });
    rows.push(eventRow({
      ...base,
      at: endMs ?? now,
      type: "launch.ready",
      title: `Launch ready: ${name}`,
      data: {
        jobId,
        model,
        engineId,
        durationMs,
        phases,
        gpuUsedBeforeMb: finiteOrNull(meta.gpuUsedBeforeMb) ?? finiteOrNull(options.gpuUsedBeforeMb),
        gpuUsedAfterMb: finiteOrNull(meta.gpuUsedAfterMb) ?? finiteOrNull(options.gpuUsedAfterMb),
      },
      dedupeKey: `${prefix}:final`,
    }));
  } else if (FAILED_STATES.has(status)) {
    const error = isPlainObject(job.error) ? job.error : {};
    const phase = text(error.phase, 120) || text(job.progress?.stage, 120) || (stages.length ? stages[stages.length - 1].phase : "") || null;
    rows.push(eventRow({
      ...base,
      at: endMs ?? now,
      type: "launch.failed",
      severity: "warning",
      title: `Launch failed: ${name}`,
      data: {
        jobId,
        model,
        engineId,
        status,
        phase,
        errorSignature: errorSignatureOf(job, meta),
        message: redactMessage(errorMessageOf(job)),
        durationMs,
      },
      dedupeKey: `${prefix}:final`,
    }));
  }
  return rows;
}

// Legacy manager download jobs and hub download jobs, terminal states only.
function downloadEventFromJob(scope, job, now) {
  if (!isPlainObject(job)) return null;
  const jobId = jobIdOf(job);
  const state = DOWNLOAD_TERMINAL[jobState(job)];
  if (!jobId || !state) return null;
  const error = isPlainObject(job.error) ? job.error : {};
  const repo = text(job.repoId, 200) || text(job.repo, 200) || text(job.meta?.repoId, 200) || text(job.meta?.repo, 200);
  const at = toMs(job.finishedAt) ?? toMs(job.updatedAt) ?? now;
  return eventRow({
    at,
    type: `download.${state}`,
    severity: state === "failed" ? "warning" : "info",
    source: scope === "hub" ? "hub" : sourceFor(scope),
    managerId: scope === "hub" ? text(job.ownerManagerId, 32) || null : scope,
    title: `Download ${state}${repo ? `: ${modelLabel(repo)}` : ""}`,
    data: {
      jobId,
      state,
      repo: repo && !/^[A-Za-z]:[\\/]|^[\\/]/.test(repo) ? repo : modelLabel(repo) || null,
      errorCode: slug(error.code) || slug(job.errorCode) || slug(job.meta?.errorCode) || null,
    },
    dedupeKey: `dl:${scope}:${jobId}:${state}`,
  });
}

// --- docker events -------------------------------------------------------

function decodeCommandOutput(value) {
  if (value === undefined || value === null) return "";
  if (!Buffer.isBuffer(value)) return String(value);
  // wsl.exe prints UTF-16LE; every other byte of ASCII text is then zero.
  const zeros = value.subarray(0, 64).filter((byte) => byte === 0).length;
  const decoded = zeros > 4 ? value.toString("utf16le") : value.toString("utf8");
  return decoded.replace(/^﻿/, "").replace(/\u0000/g, "");
}

/**
 * The docker events stream as a child process, invoked the way the managers
 * run docker (DOCKER_WSL_DISTRO → `wsl.exe -d <distro> --exec docker`).
 * options: { dockerExe, argsPrefix, wslDistro, wslExe, spawn, execFile }.
 * It only ever runs `docker events` and, under WSL, `wsl --list --running
 * --quiet`; it never starts Docker Desktop or a distro.
 */
function createDockerEventSource(options = {}) {
  const spawnFn = typeof options.spawn === "function" ? options.spawn : childProcess.spawn;
  const execFileFn = typeof options.execFile === "function" ? options.execFile : childProcess.execFile;
  const wslDistro = /^[A-Za-z0-9._-]{1,64}$/.test(String(options.wslDistro || "")) ? String(options.wslDistro) : "";
  const wslExe = text(options.wslExe, 512) || "wsl.exe";
  const dockerExe = wslDistro ? wslExe : text(options.dockerExe, 512) || "docker";
  const argsPrefix = wslDistro
    ? ["-d", wslDistro, "--exec", "docker"]
    : (Array.isArray(options.argsPrefix) ? options.argsPrefix.map(String).filter(Boolean) : []);

  function eventArgs(sinceSeconds) {
    const args = [...argsPrefix, "events", "--filter", "label=ai.manager", "--format", "{{json .}}"];
    const since = Math.floor(Number(sinceSeconds));
    if (Number.isFinite(since) && since > 0) args.push("--since", String(since));
    return args;
  }

  // `wsl.exe -d <distro>` boots a stopped distro, so the stream opens only
  // while the distro already runs. Docker Desktop needs no check: the docker
  // CLI fails fast when its engine is down and never starts it.
  function precheck() {
    if (!wslDistro) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        execFileFn(wslExe, ["--list", "--running", "--quiet"], { windowsHide: true, timeout: WSL_LIST_TIMEOUT_MS, encoding: "buffer" }, (error, stdout) => {
          const names = decodeCommandOutput(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          if (names.some((name) => name.toLowerCase() === wslDistro.toLowerCase())) finish({ ok: true });
          else finish({ ok: false, reason: error && error.code === "ENOENT" ? "wsl_unavailable" : "wsl_distro_not_running" });
        });
      } catch {
        finish({ ok: false, reason: "wsl_unavailable" });
      }
    });
  }

  function open({ sinceSeconds } = {}) {
    return spawnFn(dockerExe, eventArgs(sinceSeconds), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  }

  return { command: dockerExe, wslDistro, eventArgs, precheck, open };
}

// The managers' docker settings from the environment (vllm-manager CONFIG).
function dockerEventSourceFromEnv(env = process.env, options = {}) {
  const distro = String(env.DOCKER_WSL_DISTRO || "").trim();
  if (distro && !/^[A-Za-z0-9._-]{1,64}$/.test(distro)) return null;
  return createDockerEventSource({
    ...options,
    wslDistro: distro,
    wslExe: env.WSL_EXE || "wsl.exe",
    dockerExe: env.DOCKER_EXE || "docker",
  });
}

function dockerManagerId(label) {
  const value = text(label, 64).toLowerCase();
  if (!value) return null;
  return slug(value.replace(/-manager$/, ""), 32) || null;
}

/**
 * One `docker events --format "{{json .}}"` line as an event row, or null.
 * ctx.oom is a Map(containerId → atMs) of recent oom events.
 */
function dockerEventFromLine(line, ctx = {}) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(event)) return null;
  const kind = String(event.Type || event.type || "").toLowerCase();
  if (kind && kind !== "container") return null;
  const action = String(event.Action || event.status || "");
  const actor = isPlainObject(event.Actor) ? event.Actor : {};
  const attrs = isPlainObject(actor.Attributes) ? actor.Attributes : {};
  const containerId = text(actor.ID || event.id, 128);
  if (!containerId || !action) return null;
  const timeNano = finiteOrNull(event.timeNano);
  const atMs = timeNano !== null ? Math.floor(timeNano / 1e6) : (finiteOrNull(event.time) ?? Date.now() / 1000) * 1000;
  const managerId = dockerManagerId(attrs["ai.manager"]);
  const parallel = String(attrs["ai.manager.instance-mode"] || "").toLowerCase() === "parallel";
  const instanceId = parallel ? text(attrs["ai.manager.instance"], 120) || text(attrs.name, 120) : "primary";
  const shortId = containerId.slice(0, 12);
  const name = text(attrs.name, 128);
  const base = {
    at: atMs,
    source: "docker",
    managerId,
    fleetId: managerId && instanceId ? `${managerId}:${instanceId}` : null,
    launchId: text(attrs["ai.manager.launch-id"], 64) || null,
    dedupeKey: `docker:${shortId}:${action.replace(/\s+/g, "")}:${timeNano !== null ? timeNano : atMs}`,
  };
  const data = {
    containerId: shortId,
    name,
    model: modelLabel(attrs["ai.manager.model"]) || null,
    engineId: slug(attrs["ai.manager.engine-id"] || attrs["ai.manager.engine"], 32) || null,
  };
  const label = name || shortId;
  const oom = ctx.oom instanceof Map ? ctx.oom : null;
  if (action === "oom") {
    oom?.set(containerId, atMs);
    return eventRow({ ...base, type: "container.oom", severity: "critical", title: `Container ran out of memory: ${label}`, data });
  }
  if (action === "die") {
    const exitCode = finiteOrNull(attrs.exitCode);
    const oomAt = oom?.get(containerId);
    const oomKilled = oomAt !== undefined && atMs - oomAt <= OOM_WINDOW_MS && atMs >= oomAt - 1000;
    if (oomAt !== undefined) oom.delete(containerId);
    return eventRow({
      ...base,
      type: "container.exit",
      severity: exitCode === 0 && !oomKilled ? "info" : "warning",
      title: `Container exited${exitCode === null ? "" : ` (code ${exitCode})`}: ${label}`,
      data: { ...data, exitCode, oomKilled },
    });
  }
  if (action.startsWith("health_status")) {
    const status = slug(action.split(":")[1] || attrs.health_status || "", 32) || "unknown";
    return eventRow({
      ...base,
      type: "container.health",
      severity: status === "unhealthy" ? "warning" : "info",
      title: `Container health ${status}: ${label}`,
      data: { ...data, status },
    });
  }
  if (action === "start") {
    return eventRow({ ...base, type: "container.start", title: `Container started: ${label}`, data });
  }
  return null;
}

// --- log tails -----------------------------------------------------------

/**
 * The rows for one process-exit.log line (manager-core/process-exit-log.js).
 * `labels` maps label → {event, pid, at} of the previous line and is
 * updated in place.
 */
function processExitRows(spec, labels, line, now) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isPlainObject(entry)) return [];
  const event = text(entry.event, 40);
  if (!event) return [];
  const label = text(entry.label, 80) || spec.managerId || "process";
  const pid = clampInt(entry.pid, 0, 2 ** 31, 0) || null;
  const at = toMs(entry.at) ?? now;
  const managerId = text(spec.managerId, 32) || null;
  const base = { at, source: managerId || "entry", managerId };
  const key = `pexit:${spec.id}:${pid ?? "-"}:${at}`;
  const previous = labels[label] || null;
  const rows = [];
  if (event === "start") {
    if (previous && previous.event !== "exit") {
      rows.push(eventRow({
        ...base,
        type: "manager.hard_kill_suspected",
        severity: "warning",
        title: `${label} started again without a clean exit`,
        data: { label, pid, previousPid: previous.pid ?? null, previousEvent: previous.event, previousAt: iso(previous.at) },
        dedupeKey: `${key}:hard_kill`,
      }));
    }
    rows.push(eventRow({ ...base, type: "manager.start", title: `${label} started`, data: { label, pid, node: text(entry.node, 32) || null }, dedupeKey: `${key}:start` }));
  } else if (event === "exit") {
    const code = finiteOrNull(entry.code);
    rows.push(eventRow({
      ...base,
      type: "manager.exit",
      severity: code === null || code === 0 ? "info" : "warning",
      title: `${label} exited${code === null ? "" : ` (code ${code})`}`,
      data: { label, pid, code, uptimeSeconds: finiteOrNull(entry.uptimeSeconds) },
      dedupeKey: `${key}:exit`,
    }));
  } else if (event === "signal") {
    const signal = slug(entry.signal, 16) || null;
    rows.push(eventRow({
      ...base,
      type: "manager.signal",
      title: `${label} received ${signal || "a signal"}`,
      data: { label, pid, signal, reason: text(entry.reason, 120) || null },
      dedupeKey: `${key}:signal`,
    }));
  } else if (CRASH_EVENTS.has(event)) {
    rows.push(eventRow({
      ...base,
      type: "manager.crash",
      severity: "critical",
      title: `${label} crashed (${event})`,
      data: { label, pid, kind: event, error: redactMessage(firstLine(entry.error)) },
      dedupeKey: `${key}:${event}`,
    }));
  }
  labels[label] = { event, pid, at };
  return rows;
}

// One platform-mcp audit line (platform-mcp/src/audit.ts). The client id is
// not recorded.
function mcpToolCallRow(spec, line, offset, now) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(entry)) return null;
  const tool = slug(entry.tool, 80) || "unknown";
  const requestId = slug(entry.requestId, 128);
  const ok = entry.ok === true;
  return eventRow({
    at: toMs(entry.timestamp) ?? now,
    type: "mcp.tool_call",
    severity: "info",
    source: "mcp",
    title: `MCP tool ${tool} ${ok ? "succeeded" : "failed"}`,
    data: { tool, ok, durationMs: finiteOrNull(entry.durationMs), errorCode: ok ? null : slug(entry.errorCode) || "unknown_error" },
    dedupeKey: requestId ? `mcp:${requestId}` : `mcp:${spec.id}:${offset}`,
  });
}

// --- config --------------------------------------------------------------

function flattenLeaves(value, prefix = "", out = new Map()) {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length && prefix) out.set(prefix, "{}");
    for (const key of keys) flattenLeaves(value[key], prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  if (prefix) out.set(prefix, JSON.stringify(value === undefined ? null : value));
  return out;
}

function cleanKeyList(keys) {
  const out = new Set();
  for (const key of Array.isArray(keys) ? keys : []) {
    const name = text(key, 128);
    if (name && /^[A-Za-z0-9_.\-[\]$]+$/.test(name)) out.add(name);
    if (out.size >= MAX_CHANGED_KEYS) break;
  }
  return [...out].sort();
}

/** The dotted key names whose values differ between two settings objects. */
function changedKeys(before, after) {
  const left = flattenLeaves(isPlainObject(before) ? before : {});
  const right = flattenLeaves(isPlainObject(after) ? after : {});
  const changed = [];
  for (const [key, value] of right) if (left.get(key) !== value) changed.push(key);
  for (const key of left.keys()) if (!right.has(key)) changed.push(key);
  return cleanKeyList(changed);
}

function valueHash(json) {
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 16);
}

// --- the collector -------------------------------------------------------

function normalizeTailFiles(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = text(item?.id, 64);
    const file = text(item?.file, 4096);
    const kind = item?.kind === "mcp" ? "mcp" : item?.kind === "process-exit" ? "process-exit" : "";
    if (!id || !file || !kind || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, file, kind, managerId: text(item.managerId, 32) || null });
  }
  return out;
}

function normalizeManagers(managers) {
  if (!managers) return { ids: [], get: null };
  const list = Array.isArray(managers) ? managers : Array.isArray(managers.ids) ? managers.ids : Array.isArray(managers.list) ? managers.list : [];
  const ids = [...new Set(list.map((item) => slug(typeof item === "string" ? item : item?.id, 32)).filter(Boolean))];
  const get = typeof managers.get === "function" ? managers.get.bind(managers) : null;
  return { ids, get };
}

function emptyState() {
  return { v: 1, tails: {}, docker: { since: null }, reach: {}, instances: {}, bench: {}, config: {} };
}

function loadedState(saved) {
  const state = emptyState();
  if (!isPlainObject(saved)) return state;
  for (const key of ["tails", "reach", "instances", "bench", "config"]) {
    if (isPlainObject(saved[key])) state[key] = saved[key];
  }
  if (isPlainObject(saved.docker)) state.docker = { since: finiteOrNull(saved.docker.since) };
  return state;
}

/**
 * options: { store, events, managers, dockerEvents, tailFiles, now, logger,
 * timers: { setTimeout, clearTimeout }, platformConfigFile, gpuUsedMb,
 * tailIntervalMs = 5000, benchmarkIntervalMs = 300000, configCheckMs = 30000,
 * stopFlushMs = 2000 }.
 * - events: the ENT-EV module; only events.subscribe(fn, {types}) is called.
 * - managers: { ids, get(managerId, target) → Promise<{ok, status, data}> }
 *   (the entry's manager client) or null.
 * - dockerEvents: createDockerEventSource() or null to skip docker.
 * - tailFiles: [{ id, kind: "process-exit" | "mcp", file, managerId? }].
 */
function createEventCollector(options = {}) {
  const store = options.store || null;
  const bus = options.events || null;
  const managers = normalizeManagers(options.managers);
  const dockerEvents = options.dockerEvents && typeof options.dockerEvents.open === "function" ? options.dockerEvents : null;
  const tails = normalizeTailFiles(options.tailFiles);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timers = options.timers && typeof options.timers.setTimeout === "function" ? options.timers : { setTimeout, clearTimeout };
  const log = normalizeLogger(options.logger);
  const platformConfigPath = text(options.platformConfigFile, 4096);
  const gpuUsedMb = typeof options.gpuUsedMb === "function" ? options.gpuUsedMb : null;
  const tailIntervalMs = clampInt(options.tailIntervalMs, 50, 600_000, TAIL_INTERVAL_MS);
  const benchmarkIntervalMs = clampInt(options.benchmarkIntervalMs, 1000, 24 * 3_600_000, BENCHMARK_INTERVAL_MS);
  const stopFlushMs = clampInt(options.stopFlushMs, 0, 60_000, STOP_FLUSH_MS);
  const configCheckMs = clampInt(options.configCheckMs, 0, 3_600_000, CONFIG_CHECK_MS);

  let running = false;
  let generation = 0;
  let state = emptyState();
  let stateLoaded = null;
  let stateDirty = false;
  let unsubscribe = null;
  // Bus envelopes are handled one at a time, in order, after the state loads.
  let inbox = Promise.resolve();
  const pending = [];
  let writing = null;
  const seenKeys = new Set();
  // gpu memory seen when a launch started, by job key (only with gpuUsedMb).
  const gpuAtStart = new Map();
  // Managers whose instances report lifecycle.phase (01): their phases come
  // from the instances, not from the job stage history.
  const lifecycleNative = new Set();
  const instanceLaunchIds = new Map();
  const instanceReads = new Map();
  const oomSeen = new Map();
  const counters = { received: 0, recorded: 0, duplicates: 0, rejected: 0, dropped: 0, storeErrors: 0, handlerErrors: 0 };
  const timersHeld = { tail: null, benchmark: null, docker: null };
  let tailRun = null;
  let lastConfigCheckAt = 0;
  const docker = { state: dockerEvents ? "idle" : "disabled", child: null, failures: 0, connectedAt: 0, lastError: null, nextRetryAt: null, logged: false, stderr: "" };
  const tailStatus = new Map(tails.map((spec) => [spec.id, { lastReadAt: null, lastError: null, bytesRead: 0 }]));

  function clock() {
    try {
      const value = Math.floor(Number(now()));
      if (Number.isFinite(value)) return value;
    } catch {
      // Fall through.
    }
    return Date.now();
  }

  function schedule(slot, fn, delayMs) {
    if (timersHeld[slot]) timers.clearTimeout(timersHeld[slot]);
    const run = generation;
    const handle = timers.setTimeout(() => {
      if (timersHeld[slot] === handle) timersHeld[slot] = null;
      if (!running || run !== generation) return;
      fn();
    }, Math.max(0, delayMs));
    handle?.unref?.();
    timersHeld[slot] = handle;
  }

  function clearTimers() {
    for (const slot of Object.keys(timersHeld)) {
      if (timersHeld[slot]) timers.clearTimeout(timersHeld[slot]);
      timersHeld[slot] = null;
    }
  }

  // --- writing -----------------------------------------------------------

  function enqueue(rows) {
    let added = 0;
    for (const row of rows) {
      if (!row) continue;
      if (row.dedupeKey) {
        if (seenKeys.has(row.dedupeKey)) continue;
        seenKeys.add(row.dedupeKey);
        if (seenKeys.size > SEEN_KEYS_MAX) seenKeys.delete(seenKeys.values().next().value);
      }
      pending.push(row);
      added += 1;
    }
    const overflow = pending.length - MAX_PENDING_ROWS;
    if (overflow > 0) {
      pending.splice(0, overflow);
      counters.dropped += overflow;
    }
    if (added) scheduleWrite();
    return added;
  }

  function forget(rows) {
    for (const row of rows) if (row.dedupeKey) seenKeys.delete(row.dedupeKey);
  }

  // Writes everything pending in batches of 500. Returns false when the
  // store said "not now" (busy, or its worker is restarting): those rows go
  // back to the front of the queue and wait for the next write, which the
  // next event or tail pass triggers.
  async function writePending() {
    if (!store || typeof store.insertEvents !== "function") {
      pending.length = 0;
      return true;
    }
    while (pending.length) {
      const batch = pending.splice(0, 500);
      let result;
      try {
        result = await store.insertEvents(batch);
      } catch (error) {
        counters.storeErrors += 1;
        if (error && error.retryable === true) {
          pending.unshift(...batch);
          return false;
        }
        counters.dropped += batch.length;
        forget(batch);
        continue;
      }
      if (result && result.retryable === true) {
        counters.storeErrors += 1;
        pending.unshift(...batch);
        return false;
      }
      counters.recorded += Number(result?.accepted) || 0;
      counters.duplicates += Number(result?.duplicates) || 0;
      counters.rejected += Number(result?.rejected) || 0;
      counters.dropped += Number(result?.dropped) || 0;
      // A batch the store dropped whole (disk full, I/O) may be offered again.
      if (result?.error) forget(batch);
    }
    return true;
  }

  // One writer at a time. Rows queued while it finishes are picked up by a
  // follow-up run, unless the store just asked to wait.
  function scheduleWrite() {
    if (writing) return writing;
    const current = writePending()
      .catch((error) => {
        counters.storeErrors += 1;
        log("warn", `Telemetry event write failed: ${error && error.message ? error.message : error}`);
        return false;
      })
      .then((progressed) => {
        writing = null;
        if (progressed && pending.length) return scheduleWrite();
        return undefined;
      });
    writing = current;
    return current;
  }

  async function saveState() {
    if (!stateDirty || !store || typeof store.setState !== "function") return;
    stateDirty = false;
    try {
      await store.setState(STATE_NAME, state);
    } catch {
      stateDirty = true;
    }
  }

  function loadState() {
    if (!stateLoaded) {
      stateLoaded = (async () => {
        if (!store || typeof store.getState !== "function") return;
        try {
          state = loadedState(await store.getState(STATE_NAME));
        } catch {
          state = emptyState();
        }
      })();
    }
    return stateLoaded;
  }

  // --- bus ---------------------------------------------------------------

  function onEnvelope(envelope) {
    if (!isPlainObject(envelope) || !SUBSCRIBED_TYPES.includes(envelope.type)) return;
    counters.received += 1;
    inbox = inbox.then(() => handleEnvelope(envelope)).catch((error) => {
      counters.handlerErrors += 1;
      log("warn", `Telemetry could not record a ${envelope.type} event: ${error && error.message ? error.message : error}`);
    });
  }

  async function handleEnvelope(envelope) {
    await loadState();
    const data = isPlainObject(envelope.data) ? envelope.data : {};
    const at = toMs(envelope.at) ?? clock();
    switch (envelope.type) {
      case "jobs": return onJobs(data, at);
      case "instances": return onInstances(data);
      case "status": return onStatus(data, at);
      case "downloads": return onDownloads(data, at);
      case "security": return onSecurity(envelope, data, at);
      case "access": return onAccess(envelope, data, at);
      case "platform": return onPlatform(envelope, data, at);
      default: return undefined;
    }
  }

  function onJobs(data, at) {
    const managerId = slug(data.managerId, 32);
    if (!managerId) return;
    const rows = [];
    for (const job of Array.isArray(data.jobs) ? data.jobs : []) {
      if (!isPlainObject(job)) continue;
      if (String(job.type) === "download") {
        rows.push(downloadEventFromJob(managerId, job, at));
        continue;
      }
      if (!LAUNCH_JOB_TYPES.has(String(job.type))) continue;
      const meta = isPlainObject(job.meta) ? job.meta : {};
      const key = `${managerId}:${jobIdOf(job)}`;
      const status = jobState(job);
      let gpuBefore = null;
      let gpuAfter = null;
      if (gpuUsedMb) {
        if (!gpuAtStart.has(key) && !READY_STATES.has(status) && !FAILED_STATES.has(status)) gpuAtStart.set(key, readGpuUsed());
        gpuBefore = gpuAtStart.get(key) ?? null;
        if (READY_STATES.has(status)) gpuAfter = readGpuUsed();
        if (READY_STATES.has(status) || FAILED_STATES.has(status)) gpuAtStart.delete(key);
      }
      rows.push(...launchEventsFromJob(managerId, job, {
        now: at,
        skipStagePhases: lifecycleNative.has(managerId),
        launchId: instanceLaunchIds.get(fleetIdForJob(managerId, meta)) || null,
        gpuUsedBeforeMb: gpuBefore,
        gpuUsedAfterMb: gpuAfter,
      }));
    }
    enqueue(rows);
  }

  function readGpuUsed() {
    try {
      return finiteOrNull(gpuUsedMb());
    } catch {
      return null;
    }
  }

  // One read per manager at a time; an event that arrives meanwhile reads
  // once more afterwards. Not part of the inbox, so a slow manager never
  // holds up the other sources.
  function onInstances(data) {
    const managerId = slug(data.managerId, 32);
    if (!managerId || !managers.get) return;
    const removed = Array.isArray(data.removed) ? data.removed.map((id) => text(id, 120)).filter(Boolean) : [];
    const current = instanceReads.get(managerId);
    if (current) {
      current.again = true;
      current.removed.push(...removed);
      return;
    }
    const read = { again: false, removed: [...removed], promise: null };
    instanceReads.set(managerId, read);
    read.promise = (async () => {
      try {
        do {
          read.again = false;
          const gone = read.removed.splice(0);
          await readInstances(managerId, gone);
        } while (read.again && running);
      } finally {
        instanceReads.delete(managerId);
      }
    })().catch((error) => {
      counters.handlerErrors += 1;
      log("warn", `Telemetry could not read the ${managerId} instances: ${error && error.message ? error.message : error}`);
    });
  }

  async function readInstances(managerId, removed) {
    let result = null;
    try {
      result = await managers.get(managerId, "instances");
    } catch {
      result = null;
    }
    const at = clock();
    const rows = [];
    const list = result?.ok
      ? (Array.isArray(result.data) ? result.data : Array.isArray(result.data?.instances) ? result.data.instances : null)
      : null;
    if (list) {
      for (const instance of list) {
        if (!isPlainObject(instance)) continue;
        const instanceId = text(instance.id ?? instance.instanceId ?? instance.containerName, 120);
        if (!instanceId) continue;
        rows.push(...instanceRows(managerId, instanceId, instance, at));
      }
    }
    for (const instanceId of removed) {
      const fleetId = `${managerId}:${instanceId}`;
      const previous = state.instances[fleetId];
      if (!previous) continue;
      rows.push(eventRow({
        at,
        type: "instance.removed",
        source: managerId,
        managerId,
        fleetId,
        launchId: previous.launchId || null,
        title: `Instance removed: ${fleetId}`,
        data: { prevState: previous.state || null },
        dedupeKey: `inst:${fleetId}:${previous.launchId || "-"}:removed:${previous.since || 0}`,
      }));
      delete state.instances[fleetId];
      instanceLaunchIds.delete(fleetId);
      stateDirty = true;
    }
    enqueue(rows);
  }

  function instanceRows(managerId, instanceId, instance, at) {
    const fleetId = `${managerId}:${instanceId}`;
    const lifecycle = isPlainObject(instance.lifecycle) ? instance.lifecycle : {};
    const launchId = text(instance.launchId ?? lifecycle.launchId, 64) || null;
    const phase = text(lifecycle.phase, 32);
    const stateName = text(lifecycle.state, 32) || (instance.running === true ? "running" : instance.running === false ? "stopped" : "");
    const since = toMs(lifecycle.since) ?? at;
    if (phase) lifecycleNative.add(managerId);
    if (launchId) instanceLaunchIds.set(fleetId, launchId);
    const previous = state.instances[fleetId] || null;
    const sameLaunch = previous && (previous.launchId || null) === launchId;
    const rows = [];
    const model = modelLabel(instance.model?.id || instance.model || instance.models?.[0]?.id || instance.models?.[0]) || null;
    const engineId = slug(instance.engineId || instance.engine, 32) || null;
    const base = { source: managerId, managerId, fleetId, launchId };
    const next = { state: stateName, phase, since, phaseSince: previous?.phaseSince ?? since, launchId };
    if (phase && (!sameLaunch || previous.phase !== phase)) {
      rows.push(eventRow({
        ...base,
        at: since,
        type: "launch.phase",
        title: `Launch phase: ${phase}`,
        data: {
          phase,
          prevPhase: sameLaunch && previous.phase ? previous.phase : null,
          prevDurationMs: sameLaunch && previous.phase ? Math.max(0, since - (previous.phaseSince ?? since)) : null,
          model,
          engineId,
        },
        dedupeKey: `inst:${fleetId}:${launchId || "-"}:phase:${phase}:${since}`,
      }));
      next.phaseSince = since;
    }
    if (stateName && (!previous || previous.state !== stateName || !sameLaunch)) {
      rows.push(eventRow({
        ...base,
        at: since,
        type: "instance.state",
        severity: stateName === "crashed" ? "warning" : "info",
        title: `Instance ${stateName}: ${fleetId}`,
        data: { state: stateName, prevState: previous?.state || null, phase: phase || null, model, engineId },
        dedupeKey: `inst:${fleetId}:${launchId || "-"}:state:${stateName}:${since}`,
      }));
    }
    if (!previous || previous.state !== next.state || previous.phase !== next.phase || previous.launchId !== next.launchId) {
      state.instances[fleetId] = next;
      stateDirty = true;
    }
    return rows;
  }

  function onStatus(data, at) {
    const managerId = slug(data.managerId, 32);
    const reason = text(data.reason, 40);
    if (!managerId || (reason !== "manager_up" && reason !== "manager_down")) return;
    const next = reason === "manager_up" ? "up" : "down";
    if (state.reach[managerId] === next) return;
    state.reach[managerId] = next;
    stateDirty = true;
    enqueue([eventRow({
      at,
      type: next === "up" ? "manager.reachable" : "manager.unreachable",
      severity: next === "up" ? "info" : "warning",
      source: "entry",
      managerId,
      title: next === "up" ? `${managerId} manager is reachable` : `${managerId} manager is unreachable`,
      data: { managerId },
      dedupeKey: `reach:${managerId}:${next}:${at}`,
    })]);
  }

  function onDownloads(data, at) {
    const rows = [];
    for (const job of Array.isArray(data.jobs) ? data.jobs : []) rows.push(downloadEventFromJob("hub", job, at));
    enqueue(rows);
  }

  function onSecurity(envelope, data, at) {
    const kind = slug(data.kind, 40) || "other";
    const { kind: _kind, ...rest } = data;
    enqueue([eventRow({
      at,
      type: `security.${kind}`,
      severity: SECURITY_WARNINGS.has(kind) ? "warning" : "info",
      source: text(envelope.source, 32) || "entry",
      managerId: slug(data.managerId, 32) || null,
      requestId: slug(data.requestId, 128) || null,
      title: `Security: ${kind.replace(/_/g, " ")}`,
      data: rest,
      dedupeKey: envelope.id ? `bus:${envelope.id}` : null,
    })]);
  }

  // 05 access events: key changes are config.keys, the rest config.exposure.
  // Only the action, the key id and changed key names are kept.
  function onAccess(envelope, data, at) {
    const action = slug(data.kind || data.action, 40) || "changed";
    const section = /^key/.test(action) ? "keys" : "exposure";
    const keyId = slug(data.keyId || data.id, 64) || null;
    recordConfig(section, cleanKeyList(data.changed), {
      at,
      action,
      keyId,
      source: text(envelope.source, 32) || "entry",
      dedupeKey: envelope.id ? `bus:${envelope.id}` : null,
      always: true,
    });
  }

  function onPlatform(envelope, data, at) {
    const kind = text(data.kind, 40);
    if (kind === "component") {
      const id = slug(data.id, 64);
      const componentState = slug(data.state, 32);
      if (!id || !componentState) return;
      enqueue([eventRow({
        at,
        type: "platform.component",
        severity: PLATFORM_BAD_STATES.has(componentState) ? "warning" : "info",
        source: "platform",
        title: `Component ${id} is ${componentState}`,
        data: { id, state: componentState, prev: slug(data.prev, 32) || null, reason: text(data.reason, 120) || null },
        dedupeKey: envelope.id ? `bus:${envelope.id}` : null,
      })]);
    } else if (kind === "config") {
      recordConfig("platform", cleanKeyList(data.changed), { at, source: "platform", dedupeKey: envelope.id ? `bus:${envelope.id}` : null });
    }
  }

  // --- config changes ------------------------------------------------------

  function recordConfig(section, keys, extra = {}) {
    if (!keys.length && !extra.always) return null;
    const data = { changed: keys };
    if (extra.action) data.action = extra.action;
    if (extra.keyId) data.keyId = extra.keyId;
    if (extra.actor) data.actor = extra.actor;
    const row = eventRow({
      at: Number.isFinite(extra.at) ? extra.at : clock(),
      type: `config.${section}`,
      source: extra.source || "entry",
      title: `Configuration changed: ${section}${extra.action ? ` (${extra.action.replace(/_/g, " ")})` : ""}`,
      data,
      dedupeKey: extra.dedupeKey || null,
    });
    enqueue([row]);
    return row;
  }

  /**
   * Hook for writers that know what they changed. `change` is a list of key
   * names, {changed: [...]}, or {before, after} (only the names of the keys
   * that differ are kept). Values are never recorded.
   */
  function recordConfigChange(section, change, extra = {}) {
    const name = text(section, 32);
    if (!CONFIG_SECTIONS.has(name)) return null;
    let keys = [];
    if (Array.isArray(change)) keys = cleanKeyList(change);
    else if (isPlainObject(change) && ("before" in change || "after" in change)) keys = changedKeys(change.before, change.after);
    else if (isPlainObject(change)) keys = cleanKeyList(change.changed);
    try {
      return recordConfig(name, keys, {
        at: toMs(extra.at) ?? clock(),
        source: text(extra.source, 32) || "entry",
        actor: slug(extra.actor, 80) || null,
      });
    } catch {
      // A config writer must never fail because telemetry could not record.
      return null;
    }
  }

  async function checkPlatformConfig() {
    if (!platformConfigPath) return;
    const at = clock();
    if (lastConfigCheckAt && at - lastConfigCheckAt < configCheckMs) return;
    lastConfigCheckAt = at;
    let stat;
    try {
      stat = await fsp.stat(platformConfigPath);
    } catch {
      return;
    }
    const saved = isPlainObject(state.config.platform) ? state.config.platform : null;
    if (saved && saved.mtimeMs === stat.mtimeMs && saved.size === stat.size) return;
    if (stat.size > CONFIG_READ_MAX_BYTES) return;
    let parsed;
    try {
      parsed = JSON.parse((await fsp.readFile(platformConfigPath, "utf8")).replace(/^﻿/, ""));
    } catch {
      return;
    }
    if (!isPlainObject(parsed)) return;
    const hashes = {};
    for (const [key, json] of flattenLeaves(parsed)) hashes[key] = valueHash(json);
    if (saved && isPlainObject(saved.hashes)) {
      const changed = [];
      for (const [key, hash] of Object.entries(hashes)) if (saved.hashes[key] !== hash) changed.push(key);
      for (const key of Object.keys(saved.hashes)) if (!(key in hashes)) changed.push(key);
      recordConfig("platform", cleanKeyList(changed), { at: Math.floor(stat.mtimeMs) || at, source: "platform" });
    }
    state.config.platform = { mtimeMs: stat.mtimeMs, size: stat.size, hashes };
    stateDirty = true;
  }

  // --- tails ---------------------------------------------------------------

  async function readHead(file, length) {
    if (length <= 0) return "";
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString("base64");
    } finally {
      await handle.close();
    }
  }

  // Reads complete lines from `from` (at most TAIL_READ_MAX_BYTES per call)
  // and returns the offset after the last complete line.
  async function consume(spec, tail, file, from, to) {
    const length = Math.min(to - from, TAIL_READ_MAX_BYTES);
    if (length <= 0) return from;
    const handle = await fsp.open(file, "r");
    let buffer;
    try {
      buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      buffer = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    let end = buffer.lastIndexOf(0x0a);
    if (end < 0) {
      // One line longer than a whole read is skipped, not retried forever.
      if (buffer.length >= TAIL_READ_MAX_BYTES) return from + buffer.length;
      return from;
    }
    end += 1;
    const status = tailStatus.get(spec.id);
    if (status) status.bytesRead += end;
    const at = clock();
    const rows = [];
    let lineStart = 0;
    for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
      const lineOffset = from + lineStart;
      lineStart += Buffer.byteLength(line, "utf8") + 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (spec.kind === "process-exit") {
        if (!isPlainObject(tail.labels)) tail.labels = {};
        rows.push(...processExitRows(spec, tail.labels, trimmed, at));
      } else {
        rows.push(mcpToolCallRow(spec, trimmed, lineOffset, at));
      }
    }
    enqueue(rows);
    return from + end;
  }

  async function tailFile(spec) {
    const tail = isPlainObject(state.tails[spec.id]) ? state.tails[spec.id] : { offset: 0, head: "", headLen: 0, labels: {} };
    state.tails[spec.id] = tail;
    const status = tailStatus.get(spec.id);
    let stat;
    try {
      stat = await fsp.stat(spec.file);
    } catch (error) {
      if (error && error.code !== "ENOENT" && status) status.lastError = error.code || "stat_failed";
      return;
    }
    const before = JSON.stringify([tail.offset, tail.head, tail.headLen]);
    const offset = clampInt(tail.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    if (offset > 0) {
      const headLen = clampInt(tail.headLen, 0, HEAD_BYTES, 0);
      const head = headLen ? await readHead(spec.file, Math.min(headLen, stat.size)) : "";
      if (stat.size < offset || !headLen || head !== tail.head) {
        // Rotated (process-exit-log.js renames it to .1) or truncated: read
        // what is left of the old file when .1 is the one we were reading.
        try {
          const rotated = `${spec.file}.1`;
          const rotatedStat = await fsp.stat(rotated);
          if (headLen && (await readHead(rotated, headLen)) === tail.head) {
            let position = offset;
            while (position < rotatedStat.size) {
              const next = await consume(spec, tail, rotated, position, rotatedStat.size);
              if (next <= position) break;
              position = next;
            }
          }
        } catch {
          // No rotated copy: the file was truncated or replaced.
        }
        tail.offset = 0;
        tail.head = "";
        tail.headLen = 0;
      }
    }
    if (stat.size > 0 && tail.headLen < HEAD_BYTES) {
      // The identifying head grows with the file until HEAD_BYTES. The check
      // above already matched the shorter one, or reset the offset to 0.
      const length = Math.min(HEAD_BYTES, stat.size);
      tail.head = await readHead(spec.file, length);
      tail.headLen = length;
    }
    let position = clampInt(tail.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    while (position < stat.size) {
      const next = await consume(spec, tail, spec.file, position, stat.size);
      if (next <= position) break;
      position = next;
    }
    tail.offset = position;
    if (status) {
      status.lastReadAt = clock();
      status.lastError = null;
    }
    if (JSON.stringify([tail.offset, tail.head, tail.headLen]) !== before) stateDirty = true;
  }

  // One pass over every tail and platform.json; the rows are written before
  // the new offsets are saved, so a crash in between re-reads (and the
  // dedupe keys drop) rather than loses lines.
  function tick() {
    if (!tailRun) {
      tailRun = (async () => {
        await loadState();
        for (const spec of tails) {
          try {
            await tailFile(spec);
          } catch (error) {
            const status = tailStatus.get(spec.id);
            if (status) status.lastError = error && error.code ? error.code : "read_failed";
          }
        }
        try {
          await checkPlatformConfig();
        } catch {
          // Checked again next time.
        }
        await scheduleWrite();
        if (!pending.length) await saveState();
      })().finally(() => {
        tailRun = null;
      });
    }
    return tailRun;
  }

  function scheduleTick(delayMs) {
    schedule("tail", async () => {
      try {
        await tick();
      } finally {
        if (running) scheduleTick(tailIntervalMs);
      }
    }, delayMs);
  }

  // --- benchmarks ------------------------------------------------------------

  async function pollBenchmarks() {
    if (!managers.get) return;
    await loadState();
    for (const managerId of managers.ids) {
      let result = null;
      try {
        result = await managers.get(managerId, "benchmarks");
      } catch {
        result = null;
      }
      if (!result?.ok || !isPlainObject(result.data)) continue;
      const updatedAt = text(result.data.updatedAt, 64);
      if (updatedAt && state.bench[managerId] === updatedAt) continue;
      const rows = [];
      for (const run of (Array.isArray(result.data.runs) ? result.data.runs : []).slice(0, MAX_BENCHMARK_RUNS)) {
        const id = slug(run?.id, 64);
        const at = toMs(run?.at);
        if (!id || at === null) continue;
        const model = modelLabel(run.model);
        rows.push(eventRow({
          at,
          type: "benchmark.run",
          source: managerId,
          managerId,
          title: `Benchmark run: ${model || id}`,
          data: {
            runId: id,
            model,
            engineId: slug(run.engine, 32) || null,
            label: text(run.label, 120) || null,
            load: isPlainObject(run.load) ? run.load : null,
            metrics: isPlainObject(run.metrics) ? run.metrics : null,
          },
          dedupeKey: `bench:${managerId}:${id}`,
        }));
      }
      enqueue(rows);
      if (updatedAt) {
        state.bench[managerId] = updatedAt;
        stateDirty = true;
      }
    }
    await scheduleWrite();
    if (!pending.length) await saveState();
  }

  function scheduleBenchmarks(delayMs) {
    if (!managers.get || !managers.ids.length) return;
    schedule("benchmark", async () => {
      try {
        await pollBenchmarks();
      } catch (error) {
        log("warn", `Telemetry could not read benchmarks: ${error && error.message ? error.message : error}`);
      } finally {
        if (running) scheduleBenchmarks(benchmarkIntervalMs);
      }
    }, delayMs);
  }

  // --- docker ----------------------------------------------------------------

  function dockerBackoff(reason, detail = "") {
    const at = clock();
    if (docker.connectedAt && at - docker.connectedAt >= DOCKER_STABLE_MS) docker.failures = 0;
    docker.connectedAt = 0;
    docker.child = null;
    if (!running) return;
    const delay = Math.min(DOCKER_MAX_BACKOFF_MS, DOCKER_MIN_BACKOFF_MS * 2 ** Math.min(docker.failures, 16));
    docker.failures += 1;
    docker.state = "backoff";
    docker.lastError = { code: reason, message: redactMessage(detail) || null, at };
    docker.nextRetryAt = at + delay;
    if (!docker.logged) {
      docker.logged = true;
      log("warn", `Docker events unavailable (${reason}); retrying with backoff up to ${Math.round(DOCKER_MAX_BACKOFF_MS / 1000)} s. Telemetry never starts Docker or a WSL distro; later retries are not logged until the stream is back.`);
    }
    schedule("docker", () => {
      connectDocker().catch(() => {});
    }, delay);
  }

  function dockerSince() {
    const since = finiteOrNull(state.docker?.since);
    if (since === null) return null;
    return Math.max(since, Math.floor((clock() - DOCKER_REPLAY_MAX_MS) / 1000));
  }

  async function connectDocker() {
    if (!running || !dockerEvents || docker.child) return;
    const run = generation;
    docker.state = "connecting";
    docker.nextRetryAt = null;
    await loadState();
    let check;
    try {
      check = await dockerEvents.precheck?.() ?? { ok: true };
    } catch {
      check = { ok: false, reason: "precheck_failed" };
    }
    if (!running || run !== generation) return;
    if (!check?.ok) {
      dockerBackoff(check?.reason || "docker_unavailable");
      return;
    }
    let child;
    try {
      child = dockerEvents.open({ sinceSeconds: dockerSince() });
    } catch (error) {
      dockerBackoff(error && error.code === "ENOENT" ? "docker_cli_missing" : "spawn_failed", error && error.message);
      return;
    }
    if (!child) {
      dockerBackoff("spawn_failed");
      return;
    }
    docker.child = child;
    docker.connectedAt = clock();
    docker.stderr = "";
    docker.state = "connected";
    let ended = false;
    const end = (reason, detail) => {
      if (ended) return;
      ended = true;
      if (docker.child !== child) return;
      dockerBackoff(reason, detail);
    };
    child.on?.("error", (error) => end(error && error.code === "ENOENT" ? "docker_cli_missing" : "stream_error", error && error.message));
    // `close` comes after the process exited and its pipes drained, so the
    // stderr text that says why is complete by then.
    child.on?.("close", (code) => end(code === 0 ? "stream_ended" : "docker_unavailable", docker.stderr));
    child.stderr?.on?.("data", (chunk) => {
      docker.stderr = `${docker.stderr}${String(chunk)}`.slice(-STDERR_KEEP_CHARS);
    });
    if (child.stdout) {
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        if (docker.child !== child) return;
        if (docker.logged) {
          docker.logged = false;
          log("log", "Docker events stream is back.");
        }
        handleDockerLine(line);
      });
    }
  }

  function handleDockerLine(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return;
    const row = dockerEventFromLine(trimmed, { oom: oomSeen });
    if (!row) return;
    // Event time, not the wall clock: a replay after a restart is old.
    for (const [id, at] of oomSeen) if (row.at - at > OOM_WINDOW_MS) oomSeen.delete(id);
    const seconds = Math.floor(row.at / 1000);
    if (!(finiteOrNull(state.docker.since) >= seconds)) {
      state.docker.since = seconds;
      stateDirty = true;
    }
    enqueue([row]);
  }

  // --- lifecycle -------------------------------------------------------------

  function start() {
    if (running) return api;
    running = true;
    generation += 1;
    if (bus && typeof bus.subscribe === "function" && !unsubscribe) {
      unsubscribe = bus.subscribe(onEnvelope, { types: [...SUBSCRIBED_TYPES] });
    }
    loadState();
    if (tails.length || platformConfigPath) scheduleTick(0);
    scheduleBenchmarks(Math.min(BENCHMARK_FIRST_DELAY_MS, benchmarkIntervalMs));
    if (dockerEvents) connectDocker().catch(() => {});
    return api;
  }

  // Waits for queued work, then writes what is pending and the state, for at
  // most stopFlushMs, so a wedged store cannot hold up the entry's shutdown.
  async function stop() {
    const wasRunning = running || Boolean(unsubscribe);
    running = false;
    generation += 1;
    clearTimers();
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // Already gone.
      }
      unsubscribe = null;
    }
    const child = docker.child;
    docker.child = null;
    docker.state = dockerEvents ? "stopped" : "disabled";
    if (child) {
      try {
        child.kill?.();
      } catch {
        // Already exited.
      }
    }
    if (!wasRunning && !pending.length && !stateDirty && !tailRun && !writing) return;
    let guard = null;
    await Promise.race([
      flush(),
      new Promise((resolve) => {
        guard = setTimeout(resolve, stopFlushMs);
        guard.unref?.();
      }),
    ]);
    clearTimeout(guard);
  }

  // Resolves once every received event, tail pass and instance read has been
  // handled and written, and the state saved.
  async function flush() {
    await loadState();
    for (let round = 0; round < 5; round += 1) {
      await inbox;
      if (tailRun) await tailRun;
      await Promise.all([...instanceReads.values()].map((read) => read.promise));
      if (writing) await writing;
      await scheduleWrite();
      if (!pending.length && !instanceReads.size && !tailRun) break;
    }
    if (!pending.length) await saveState();
  }

  function status() {
    const dockerState = docker.state;
    const tailErrors = [...tailStatus.values()].some((item) => item.lastError);
    return {
      name: "events",
      state: !running ? "stopped" : dockerState === "backoff" || tailErrors ? "degraded" : "ok",
      subscribed: Boolean(unsubscribe),
      types: [...SUBSCRIBED_TYPES],
      pending: pending.length,
      ...counters,
      docker: {
        state: dockerState,
        command: dockerEvents?.command || null,
        wslDistro: dockerEvents?.wslDistro || null,
        failures: docker.failures,
        nextRetryAt: docker.nextRetryAt ? iso(docker.nextRetryAt) : null,
        lastError: docker.lastError ? { ...docker.lastError, at: iso(docker.lastError.at) } : null,
        since: finiteOrNull(state.docker?.since),
      },
      tails: Object.fromEntries(tails.map((spec) => {
        const item = tailStatus.get(spec.id) || {};
        const saved = state.tails[spec.id] || {};
        return [spec.id, {
          kind: spec.kind,
          offset: finiteOrNull(saved.offset) ?? 0,
          bytesRead: item.bytesRead || 0,
          lastReadAt: item.lastReadAt ? iso(item.lastReadAt) : null,
          lastError: item.lastError || null,
        }];
      })),
    };
  }

  const api = {
    start,
    stop,
    flush,
    tick,
    pollBenchmarks,
    recordConfigChange,
    status,
  };
  return api;
}

module.exports = {
  STATE_NAME,
  SUBSCRIBED_TYPES,
  DOCKER_MIN_BACKOFF_MS,
  DOCKER_MAX_BACKOFF_MS,
  changedKeys,
  createDockerEventSource,
  createEventCollector,
  dockerEventFromLine,
  dockerEventSourceFromEnv,
  launchEventsFromJob,
  mcpToolCallRow,
  modelLabel,
  processExitRows,
};
