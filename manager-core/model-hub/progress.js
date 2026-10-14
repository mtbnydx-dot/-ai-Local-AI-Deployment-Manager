"use strict";

// Progress monitor and phase-aware stall watchdog (03 §7.2, §7.3).
//
// One monitor lives for one transfer attempt. It never walks the tree: every
// tick it stats the manifest files (`<localDir>/<path>`) and reads the sizes of
// `.cache/huggingface/download/<path>.*.incomplete` (one readdir per distinct
// directory). From that it keeps the job's `progress` object up to date,
// infers `downloading` vs `materializing` (Xet) while the CLI runs, and tells
// the queue when a phase has stalled. The monitor never kills anything: it
// calls `onStall(...)`, and the queue stops the engine with reason "stall" and
// classifies the failure from the `signals` it gets (`stalled` → code `stall`,
// `resolveTimeout` → `network_timeout`).
//
//   monitor.start() / stop()          tick timer (2 s for 30 s, then 5 s)
//   monitor.tick()                    one sample, usable directly under a fake clock
//   monitor.noteLine(stream, text)    CLI output counts as activity
//   monitor.noteExit({ code })        exit 0 → phase "verifying"; final sample
//   monitor.setPhase(phase)           the queue sets resolving / verifying / ...
//   monitor.beginStep(label)/endStep()  an HTTP step of the resolving phase (60 s limit)
//   monitor.markFile(path, state, …)  "verified" / "bad" marks from the verifier
//   monitor.phase()                   current phase
//
// Hashing is not watched here; verify.js watches the worker's heartbeat.

const path = require("node:path");
const fsp = require("node:fs/promises");
const { createThroughputAdvisor, formatSlowDownloadHint } = require("../download-throughput");

const FAST_TICK_MS = 2000;
const FAST_WINDOW_MS = 30_000;
const SLOW_TICK_MS = 5000;
const SAMPLES_CAP = 60;
const EMA_ALPHA = 0.2;
const XET_SAMPLE_INTERVAL_MS = 30_000;
const XET_FLAT_SAMPLES = 2;
const RESOLVE_STEP_LIMIT_MS = 60_000;
const XET_WALK_LIMIT = 50_000;
const CACHE_DOWNLOAD_DIR = [".cache", "huggingface", "download"];
// ModelScope parks its partial downloads (random file names) here when
// downloading into --local_dir; only the directory's growth is used as a signal.
const MODELSCOPE_TEMP_DIR = "._____temp";

const FILE_STATES = Object.freeze(["pending", "partial", "done", "verified", "bad"]);
const WATCHED_CLI_PHASES = new Set(["downloading", "materializing"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Settings may be an object (nested or dotted keys) or a function returning one. */
function settingValue(settings, key, fallback) {
  const source = typeof settings === "function" ? settings() : settings;
  if (isPlainObject(source) && Object.hasOwn(source, key)) return source[key] ?? fallback;
  let current = source;
  for (const segment of key.split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return fallback;
    current = current[segment];
  }
  return current === undefined || current === null ? fallback : current;
}

function minutesSetting(settings, key, fallback) {
  const value = Number(settingValue(settings, key, fallback));
  return (Number.isFinite(value) && value > 0 ? value : fallback) * 60_000;
}

function nowOf(clock) {
  return typeof clock?.now === "function" ? clock.now() : Date.now();
}

function joinRel(root, rel) {
  return path.join(root, ...String(rel).split("/").filter(Boolean));
}

function sizeOf(file) {
  const size = Number(file?.size);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function incompleteDirOf(localDir, rel) {
  return path.join(localDir, ...CACHE_DOWNLOAD_DIR, ...path.posix.dirname(String(rel)).split("/").filter((part) => part && part !== "."));
}

function isIncompleteFor(name, base) {
  return name.startsWith(`${base}.`) && name.toLowerCase().endsWith(".incomplete");
}

/**
 * Sizes of the `.incomplete` fragments of the given relative paths.
 * @returns {Promise<Map<string, number>>} rel path → largest fragment size in bytes
 */
async function readIncompleteSizes(fs, localDir, relPaths) {
  const byDir = new Map();
  for (const rel of relPaths) {
    const dir = incompleteDirOf(localDir, rel);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(rel);
  }
  const result = new Map();
  for (const [dir, rels] of byDir) {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const rel of rels) {
      const base = path.posix.basename(String(rel));
      let best = null;
      for (const name of names) {
        if (!isIncompleteFor(String(name), base)) continue;
        const stat = await fs.stat(path.join(dir, String(name))).catch(() => null);
        if (stat && (best === null || stat.size > best)) best = stat.size;
      }
      if (best !== null) result.set(rel, best);
    }
  }
  return result;
}

/** Selected files that still have a `.incomplete` fragment (used after exit code 0). */
async function listIncompleteFiles({ fs = fsp, localDir, paths }) {
  const sizes = await readIncompleteSizes(fs, localDir, paths);
  return [...sizes].map(([rel, bytes]) => ({ path: rel, bytes }));
}

async function walkSize(fs, dir) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < XET_WALK_LIMIT) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null);
        if (stat) total += stat.size;
      }
    }
  }
  return total;
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}

function createTransferMonitor(job, options = {}) {
  const fs = options.fs || fsp;
  const clock = options.clock || Date;
  const hfHome = options.hfHome || "";
  const settings = options.settings || {};
  const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : () => {};
  const onStall = typeof options.onStall === "function" ? options.onStall : () => {};
  const onLog = typeof options.onLog === "function" ? options.onLog : () => {};
  const timers = options.timers || { setTimeout, clearTimeout };
  const measureXet = typeof options.measureDir === "function" ? options.measureDir : (dir) => walkSize(fs, dir);

  const localDir = path.resolve(String(job?.target?.localDir || ""));
  const manifest = (Array.isArray(job?.artifact?.files) ? job.artifact.files : [])
    .filter((file) => file && typeof file.path === "string" && file.path)
    .map((file) => ({ path: file.path, size: sizeOf(file) }));
  const bytesTotal = Number(job?.artifact?.totalBytes) > 0
    ? Number(job.artifact.totalBytes)
    : manifest.reduce((sum, file) => sum + file.size, 0);
  const transferOptions = job?.transfer?.options || {};
  const viaModelScope = transferOptions.source === "modelscope" || job?.transfer?.cli === "modelscope";
  const xetEnabled = transferOptions.xet !== "off" && !viaModelScope && Boolean(hfHome);
  // The extra cache whose growth counts as transfer activity while local bytes are flat.
  const cacheDir = xetEnabled ? path.join(hfHome, "xet") : viaModelScope ? path.join(localDir, MODELSCOPE_TEMP_DIR) : "";
  const advisor = createThroughputAdvisor({ now: () => nowOf(clock) });

  const startedAt = nowOf(clock);
  let basePhase = ["resolving", "downloading", "materializing", "verifying"].includes(job?.state) ? job.state : "downloading";
  let phaseEnteredAt = startedAt;
  let alive = true;
  let stopped = true;
  let stalledFired = false;
  let timer = null;
  let inflight = null;
  let lastBytes = null;
  let lastTickAt = null;
  let speedEma = null;
  let lastLocalGrowthAt = startedAt;
  let lastLineAt = startedAt;
  let lastActivityAt = startedAt;
  let lastGrowthAt = startedAt;
  let step = null;
  let xetBytes = null;
  let xetSampledAt = null;
  let xetGrew = false;
  let xetFlatSamples = 0;
  let materializing = false;
  let materializingSince = startedAt;
  let adviceGiven = false;
  const samples = Array.isArray(job?.progress?.samples) ? job.progress.samples.slice(-SAMPLES_CAP) : [];
  // path → { state, size, mtimeMs, sha256 } for files the verifier marked.
  const marks = new Map();
  for (const entry of Array.isArray(job?.progress?.files) ? job.progress.files : []) {
    if (entry?.state === "verified" && Number.isFinite(entry.size) && Number.isFinite(entry.mtimeMs)) {
      marks.set(entry.path, { state: "verified", size: entry.size, mtimeMs: entry.mtimeMs, sha256: entry.sha256 || null });
    }
  }

  function currentPhase() {
    if (WATCHED_CLI_PHASES.has(basePhase) && alive) return materializing ? "materializing" : "downloading";
    return basePhase;
  }

  function setPhase(phase) {
    if (!phase || phase === basePhase) return;
    basePhase = phase;
    phaseEnteredAt = nowOf(clock);
    materializing = phase === "materializing";
    materializingSince = phaseEnteredAt;
    stalledFired = false;
    lastActivityAt = phaseEnteredAt;
    lastLocalGrowthAt = phaseEnteredAt;
    lastLineAt = phaseEnteredAt;
  }

  async function sampleFiles() {
    const incomplete = await readIncompleteSizes(fs, localDir, manifest.map((file) => file.path));
    const files = [];
    for (const file of manifest) {
      const stat = await fs.stat(joinRel(localDir, file.path)).then((value) => (value.isFile() ? value : null)).catch(() => null);
      const partial = incomplete.get(file.path) ?? 0;
      const mark = marks.get(file.path);
      let state = "pending";
      let bytes = 0;
      if (stat) {
        const complete = file.size > 0 ? stat.size >= file.size : stat.size > 0;
        if (complete) {
          state = "done";
          bytes = file.size || stat.size;
        } else {
          state = stat.size > 0 ? "partial" : "pending";
          bytes = Math.max(stat.size, partial);
        }
      } else if (partial > 0) {
        state = "partial";
        bytes = partial;
      }
      if (file.size > 0) bytes = Math.min(bytes, file.size);
      const entry = { path: file.path, bytes, size: file.size, state };
      if (mark) {
        const unchanged = stat ? mark.size === stat.size && mark.mtimeMs === stat.mtimeMs : mark.state === "bad" && partial === 0;
        if (unchanged) {
          entry.state = mark.state;
          if (mark.state === "verified") {
            entry.mtimeMs = mark.mtimeMs;
            if (mark.sha256) entry.sha256 = mark.sha256;
            entry.bytes = file.size || stat.size;
          }
        } else {
          marks.delete(file.path);
        }
      }
      files.push(entry);
    }
    return files;
  }

  async function sampleXet(now, localFlat, first) {
    if (!cacheDir) return;
    if (!first && (!localFlat || now - xetSampledAt < XET_SAMPLE_INTERVAL_MS)) return;
    let size = null;
    try {
      size = Number(await measureXet(cacheDir));
    } catch {
      size = null;
    }
    if (!Number.isFinite(size)) return;
    const previous = xetBytes;
    xetBytes = size;
    xetSampledAt = now;
    if (first || previous === null) return;
    if (size > previous) {
      xetFlatSamples = 0;
      lastActivityAt = now;
      lastGrowthAt = now;
      if (xetEnabled) {
        xetGrew = true;
        if (materializing) materializing = false;
      }
    } else {
      xetFlatSamples += 1;
    }
  }

  function inferPhase(now) {
    if (!WATCHED_CLI_PHASES.has(basePhase) || !alive) return;
    // Xet fetched chunks earlier in this attempt and the cache has gone quiet
    // while the CLI is still working: files are being assembled.
    if (xetEnabled && xetGrew && xetFlatSamples >= XET_FLAT_SAMPLES && !materializing) {
      materializing = true;
      materializingSince = now;
    }
  }

  function evaluateWatchdog(now) {
    if (stalledFired || !alive) return;
    const phase = currentPhase();
    if (phase === "resolving") {
      if (step && now - step.startedAt > RESOLVE_STEP_LIMIT_MS) {
        fireStall({ phase, code: "network_timeout", signals: { resolveTimeout: true }, idleMs: now - step.startedAt, thresholdMs: RESOLVE_STEP_LIMIT_MS, step: step.label });
      }
    } else if (phase === "downloading") {
      const thresholdMs = minutesSetting(settings, "transfer.stallMinutes", 10);
      const idleMs = now - lastActivityAt;
      if (idleMs >= thresholdMs) fireStall({ phase, code: "stall", signals: { stalled: true }, idleMs, thresholdMs });
    } else if (phase === "materializing") {
      const thresholdMs = minutesSetting(settings, "transfer.materializeStallMinutes", 20);
      // Xet growth does not count here by definition; the window starts when
      // materializing was entered, so a long chunk fetch does not eat into it.
      const idleMs = now - Math.max(lastLocalGrowthAt, lastLineAt, materializingSince);
      if (idleMs >= thresholdMs) fireStall({ phase, code: "stall", signals: { stalled: true }, idleMs, thresholdMs });
    }
  }

  function fireStall(info) {
    stalledFired = true;
    try {
      onStall(info);
    } catch {
      // The queue's handler must not break the tick loop.
    }
  }

  function updateAdvice(bytesDone) {
    if (adviceGiven || currentPhase() !== "downloading") return;
    const advice = advisor.observe(bytesDone, nowOf(clock));
    if (!advice) return;
    adviceGiven = true;
    const source = transferOptions.source;
    const suggest = source === "huggingface" ? "hf-mirror" : source === "hf-mirror" ? "modelscope" : "huggingface";
    job.advice = { code: "slow_source", suggest };
    onLog(formatSlowDownloadHint(advice, { source, hfMirror: source === "hf-mirror" }));
  }

  async function runTick() {
    const now = nowOf(clock);
    let files = null;
    try {
      files = await sampleFiles();
    } catch {
      files = null;
    }
    if (files) {
      const bytesDone = files.reduce((sum, file) => sum + file.bytes, 0);
      const first = lastBytes === null;
      const localGrew = !first && bytesDone > lastBytes;
      if (localGrew) {
        lastLocalGrowthAt = now;
        lastActivityAt = now;
        lastGrowthAt = now;
      }
      await sampleXet(now, !first && !localGrew, xetBytes === null);
      const dt = lastTickAt === null ? 0 : (now - lastTickAt) / 1000;
      const speedBps = dt > 0 ? Math.max(0, bytesDone - lastBytes) / dt : 0;
      if (dt > 0) speedEma = speedEma === null ? speedBps : EMA_ALPHA * speedBps + (1 - EMA_ALPHA) * speedEma;
      lastBytes = bytesDone;
      lastTickAt = now;
      samples.push([now, bytesDone]);
      while (samples.length > SAMPLES_CAP) samples.shift();
      inferPhase(now);
      updateAdvice(bytesDone);

      const remaining = Math.max(0, bytesTotal - bytesDone);
      const filesDone = files.filter((file) => file.state === "done" || file.state === "verified").length;
      const capped = bytesTotal > 0 ? Math.min(99, roundPercent((bytesDone / bytesTotal) * 100)) : 0;
      const previous = isPlainObject(job.progress) ? job.progress : {};
      job.progress = {
        ...previous,
        bytesDone,
        bytesTotal,
        percent: job.state === "ready" ? 100 : capped,
        speedBps: Math.round(speedBps),
        speedEmaBps: Math.round(speedEma ?? 0),
        etaSeconds: speedEma > 0 && remaining > 0 ? Math.ceil(remaining / speedEma) : null,
        filesDone,
        filesTotal: manifest.length,
        files,
        verify: previous.verify || { filesDone: 0, filesTotal: manifest.length, bytesDone: 0 },
        samples: samples.map((pair) => [...pair]),
        lastGrowthAt: new Date(lastGrowthAt).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
    }
    evaluateWatchdog(now);
    try {
      onUpdate(job.progress, { phase: currentPhase(), advice: job.advice || null });
    } catch {
      // A broken subscriber must not stop sampling.
    }
    return job.progress;
  }

  function tick() {
    if (inflight) return inflight;
    inflight = runTick().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function schedule() {
    if (stopped) return;
    const delay = nowOf(clock) - startedAt < FAST_WINDOW_MS ? FAST_TICK_MS : SLOW_TICK_MS;
    timer = timers.setTimeout(async () => {
      timer = null;
      await tick();
      schedule();
    }, delay);
    timer?.unref?.();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    schedule();
  }

  async function stop() {
    stopped = true;
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (inflight) await inflight.catch(() => {});
  }

  function noteLine() {
    const now = nowOf(clock);
    lastLineAt = now;
    lastActivityAt = now;
  }

  async function noteExit({ code } = {}) {
    alive = false;
    await stop();
    if (code === 0) {
      materializing = false;
      setPhase("verifying");
    }
    await tick();
  }

  function markFile(rel, state, details = {}) {
    if (!FILE_STATES.includes(state)) throw new Error(`Unknown file state: ${state}`);
    if (state === "verified" || state === "bad") {
      marks.set(rel, { state, size: Number(details.size) || 0, mtimeMs: Number(details.mtimeMs) || 0, sha256: details.sha256 || null });
    } else {
      marks.delete(rel);
    }
  }

  function beginStep(label = "http") {
    step = { label, startedAt: nowOf(clock) };
  }

  function endStep() {
    step = null;
  }

  return {
    start,
    stop,
    tick,
    noteLine,
    noteExit,
    setPhase,
    markFile,
    beginStep,
    endStep,
    phase: currentPhase,
    stalled: () => stalledFired,
  };
}

module.exports = {
  FILE_STATES,
  createTransferMonitor,
  listIncompleteFiles,
  readIncompleteSizes,
  settingValue,
};
