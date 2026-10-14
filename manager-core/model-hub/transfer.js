"use strict";

// Transfer engine, phase 1 (03 §6): the CLI adapter. It turns a persisted
// DownloadJob into one `hf download` / `modelscope download` command (or a
// sequence of them when the include arguments do not fit one command line),
// runs it with a job-derived environment, and supervises the process: the
// model-storage lock, taskkill on stop, secret-free logs and the orphan check
// after a hub restart. Phase 2 plugs a different engine into the same
// interface:
//
//   engine.start(job, { onLine(stream, text), onExit({ code, signal, ... }),
//                       onSpawn({ pid, startedAt }), onBatch({ batchIndex, batches }) })
//     → { pid, stop(reason): Promise<void>, stderrTail(): string[] }
//   engine.findOrphans(jobs, { kill }) → Promise<[{ jobId, pid, alive, matches }]>
//
// The environment comes only from job.transfer.options (persisted at enqueue),
// so a resume or retry sees the options the job was planned with (finding F1).
// A token is only ever put in the child's env, never in argv, a log or a file.

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { buildDownloadEnv } = require("../download-utils");
const { createUtf8LogForwarder, terminateProcessTree } = require("../process-job-runner");
const { createSecretRedactor } = require("../secret-redactor");
const { HubError } = require("./errors");
const { escapeFnmatch } = require("./fnmatch");

const SOURCES = new Set(["huggingface", "hf-mirror", "modelscope"]);
const CREDENTIAL_MODES = new Set(["temp-token", "cached-login", "none"]);
const XET_MODES = new Set(["high-performance", "default", "off"]);
// Variables the child never inherits (03 §6.2): they come from the options.
const STRIPPED_ENV_KEYS = new Set([
  "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_ENDPOINT", "HF_HUB_DISABLE_IMPLICIT_TOKEN",
  "HF_XET_HIGH_PERFORMANCE", "HF_HUB_DISABLE_XET",
]);
const DEFAULT_HF_ENDPOINT = "https://huggingface.co";
const DEFAULT_MIRROR_ENDPOINT = "https://hf-mirror.com";
// States whose job may have a live download process (03 §7.1).
const IN_PROCESS_STATES = new Set(["resolving", "downloading", "materializing", "verifying"]);
const ARGV_BUDGET = 24000;
const INCLUDE_ARG_OVERHEAD = 12;
const STDERR_RING_LINES = 200;
const MAX_LINE_LENGTH = 4000;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
const LOG_FLUSH_MS = 250;
const STOP_WAIT_MS = 15000;
const CIM_TIMEOUT_MS = 15000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function hostOf(endpoint) {
  try {
    return new URL(String(endpoint)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isHuggingFaceHost(host) {
  return host === "huggingface.co" || host.endsWith(".huggingface.co");
}

function stripEndpoint(value, fallback) {
  const text = nonEmpty(value) ? value.trim() : fallback;
  return text.replace(/\/+$/, "");
}

/** The options of a job, defaults applied and validated. Never a token. */
function optionsOf(job) {
  const raw = job?.transfer?.options;
  if (!isPlainObject(raw)) {
    throw new HubError("invalid_transfer_options", "The job has no transfer options.", { status: 500 });
  }
  const source = raw.source === undefined ? "huggingface" : String(raw.source);
  if (!SOURCES.has(source)) {
    throw new HubError("invalid_transfer_options", `Unsupported transfer source: ${source}`, { status: 422 });
  }
  const xet = raw.xet === undefined || raw.xet === null ? "default" : String(raw.xet);
  if (!XET_MODES.has(xet)) {
    throw new HubError("invalid_transfer_options", `Unsupported xet mode: ${xet}`, { status: 422 });
  }
  const credentialMode = raw.credentialMode === undefined || raw.credentialMode === null ? "cached-login" : String(raw.credentialMode);
  if (!CREDENTIAL_MODES.has(credentialMode)) {
    throw new HubError("invalid_transfer_options", `Unsupported credential mode: ${credentialMode}`, { status: 422 });
  }
  return {
    source,
    xet,
    credentialMode,
    endpoint: nonEmpty(raw.endpoint) ? raw.endpoint.trim() : null,
    tokenRef: nonEmpty(raw.tokenRef) ? raw.tokenRef.trim() : null,
  };
}

function safeFileName(value) {
  return String(value || "job").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "job";
}

// Include patterns split so no command exceeds the budget (03 §5 step 4).
function splitBatches(patterns, budget) {
  const batches = [];
  let current = [];
  let used = 0;
  for (const pattern of patterns) {
    const cost = INCLUDE_ARG_OVERHEAD + pattern.length;
    if (current.length && used + cost > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(pattern);
    used += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * The include batches of a job. `job.transfer.include` is what `plan` compiled
 * with selection.js#compileIncludePatterns: `{ mode: "all" }` or
 * `{ mode: "include", patterns, batches }`. A job without it (older record)
 * downloads exactly its `artifact.files`, by escaped exact names.
 * @returns {string[][]} one pattern list per command; `[[]]` = no --include
 */
function includeBatches(job, argvBudget) {
  const include = job?.transfer?.include;
  if (isPlainObject(include)) {
    if (include.mode === "all") return [[]];
    if (include.mode === "include") {
      const patterns = (Array.isArray(include.patterns) ? include.patterns : []).map(String).filter(Boolean);
      const batches = Array.isArray(include.batches) && include.batches.length
        ? include.batches.map((batch) => (Array.isArray(batch) ? batch.map(String).filter(Boolean) : []))
        : splitBatches(patterns, argvBudget);
      if (!batches.length || batches.some((batch) => !batch.length)) {
        throw new HubError("selection_compile_error", "The job has an empty include batch.", { status: 500 });
      }
      return batches;
    }
  }
  const files = (Array.isArray(job?.artifact?.files) ? job.artifact.files : [])
    .map((file) => (typeof file === "string" ? file : file?.path))
    .filter(nonEmpty);
  if (!files.length) return [[]];
  return splitBatches(Array.from(new Set(files)).sort().map(escapeFnmatch), argvBudget);
}

function parseCimOutput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    return isPlainObject(item) ? item : null;
  } catch {
    return null;
  }
}

function normalizeForMatch(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

/** A job's process is ours only when its command line has both `download` and the job's local dir. */
function commandLineMatches(commandLine, localDir) {
  const line = normalizeForMatch(commandLine);
  const dir = normalizeForMatch(localDir).replace(/\/+$/, "");
  if (!line || !dir) return false;
  return /\bdownload\b/.test(line) && line.includes(dir);
}

// Buffered, rotating job log: logs/<jobId>.log, 2 MB then one `.1` generation.
function createJobLogFile(logsDir, jobId) {
  const file = path.join(logsDir, `${safeFileName(jobId)}.log`);
  let pending = [];
  let timer = null;
  let size = null;
  let chain = Promise.resolve();

  async function flushNow() {
    if (!pending.length) return;
    const text = `${pending.join("\n")}\n`;
    pending = [];
    try {
      await fs.promises.mkdir(logsDir, { recursive: true });
      if (size === null) {
        try {
          size = (await fs.promises.stat(file)).size;
        } catch {
          size = 0;
        }
      }
      if (size + Buffer.byteLength(text) > LOG_ROTATE_BYTES && size > 0) {
        await fs.promises.rename(file, `${file}.1`).catch(() => {});
        size = 0;
      }
      await fs.promises.appendFile(file, text, "utf8");
      size += Buffer.byteLength(text);
    } catch {
      // A log that cannot be written must not stop the download.
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    chain = chain.then(flushNow);
    return chain;
  }

  return {
    file,
    write(line) {
      pending.push(line);
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, LOG_FLUSH_MS);
        timer.unref?.();
      }
    },
    flush,
  };
}

/**
 * createCliTransferEngine({ hfCli, modelScopeCli, hfHome, dataDir, spawnImpl,
 *   platform, tokens, redactor, modelStorage, env, clock, argvBudget }) → engine.
 * modelStorage (optional) is the shared model-storage instance whose
 * acquireOperation/trackChild/releaseOperation lock the target directory
 * around the process (03 §6.2, F10). Without a redactor one is built from
 * `tokens.values`.
 */
function createCliTransferEngine(options = {}) {
  const {
    hfCli,
    modelScopeCli,
    hfHome,
    dataDir,
    spawnImpl = childProcess.spawn,
    platform = process.platform,
    tokens = null,
    modelStorage = null,
    env: baseEnv = process.env,
    clock = Date,
    argvBudget = ARGV_BUDGET,
    stopWaitMs = STOP_WAIT_MS,
  } = options;
  const redactor = options.redactor
    || createSecretRedactor({ getSecrets: () => (tokens && typeof tokens.values === "function" ? tokens.values() : []) });
  const now = () => (clock && typeof clock.now === "function" ? clock.now() : Date.now());
  const logsDir = dataDir ? path.join(dataDir, "logs") : null;
  const terminate = options.terminate || ((pid) => terminateProcessTree(pid, { spawnCommand: spawnImpl, platform }));

  function supports(job) {
    const engine = job?.transfer?.engine;
    if (engine !== undefined && engine !== null && engine !== "cli") return false;
    return SOURCES.has(job?.transfer?.options?.source === undefined ? "huggingface" : job.transfer.options.source);
  }

  /** The environment of the child, from job.transfer.options only (03 §6.2). */
  function buildEnv(job) {
    const opts = optionsOf(job);
    const inherited = {};
    for (const [key, value] of Object.entries(baseEnv || {})) {
      if (value === undefined) continue;
      if (STRIPPED_ENV_KEYS.has(key.toUpperCase())) continue;
      inherited[key] = value;
    }
    const env = buildDownloadEnv(hfHome, inherited, { source: opts.source });
    if (opts.source === "modelscope") return env;

    if (opts.source === "hf-mirror") {
      if (opts.tokenRef || opts.credentialMode === "temp-token") {
        throw new HubError("token_not_allowed_on_mirror", "A mirror never receives a Hugging Face token.", { status: 422 });
      }
      env.HF_ENDPOINT = stripEndpoint(opts.endpoint, DEFAULT_MIRROR_ENDPOINT);
      env.HF_HUB_DISABLE_IMPLICIT_TOKEN = "1";
      env.HF_TOKEN_PATH = path.join(String(dataDir || ""), "no-token");
    } else {
      const endpoint = stripEndpoint(opts.endpoint, DEFAULT_HF_ENDPOINT);
      env.HF_ENDPOINT = endpoint;
      if (opts.credentialMode !== "none" && !isHuggingFaceHost(hostOf(endpoint))) {
        // The CLI sends its token to HF_ENDPOINT, so a credential never rides
        // along to a host that is not Hugging Face (03 §17).
        throw new HubError("credential_host_violation", "Hugging Face credentials are only used with huggingface.co.", { status: 422 });
      }
      if (opts.credentialMode === "temp-token") {
        const token = opts.tokenRef && tokens && typeof tokens.resolve === "function" ? tokens.resolve(opts.tokenRef) : null;
        if (!token) {
          throw new HubError("hf_token_expired", "The temporary token is no longer available.", { status: 409 });
        }
        env.HF_TOKEN = token;
      } else if (opts.credentialMode === "none") {
        env.HF_HUB_DISABLE_IMPLICIT_TOKEN = "1";
      }
    }
    if (opts.xet === "high-performance") env.HF_XET_HIGH_PERFORMANCE = "1";
    else if (opts.xet === "off") env.HF_HUB_DISABLE_XET = "1";
    return env;
  }

  /**
   * One command of the job. `batchIndex` picks the include batch (default: the
   * job's persisted batchIndex). Returns { command, args, label, display,
   * batches, batchIndex, cli }; `display` is the `> hf download …` log line.
   */
  function buildCommand(job, batchIndex) {
    const opts = optionsOf(job);
    const artifact = job?.artifact || {};
    const repo = String(artifact.repo || "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(repo)) {
      throw new HubError("invalid_transfer_options", "The repository id is not valid.", { status: 422 });
    }
    const revision = String(artifact.revisionSha || artifact.revision || "main");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(revision)) {
      throw new HubError("invalid_transfer_options", "The revision is not valid.", { status: 422 });
    }
    const localDir = String(job?.target?.localDir || "");
    if (!localDir || !path.isAbsolute(localDir)) {
      throw new HubError("invalid_transfer_options", "The job has no absolute target directory.", { status: 422 });
    }
    const batches = includeBatches(job, argvBudget);
    const index = Number.isInteger(batchIndex) ? batchIndex : Math.max(0, Number(job?.transfer?.batchIndex) || 0);
    if (index < 0 || index >= batches.length) {
      throw new HubError("invalid_transfer_options", "The batch index is out of range.", { status: 500 });
    }
    const patterns = batches[index];
    let command;
    let args;
    let label;
    if (opts.source === "modelscope") {
      command = modelScopeCli;
      label = "ModelScope";
      if (patterns.some((pattern) => pattern.startsWith("-"))) {
        throw new HubError("unsafe_path", "A file pattern may not start with a dash.", { status: 422 });
      }
      args = ["download", "--model", repo, "--revision", revision, "--local_dir", localDir, ...patterns.flatMap((pattern) => ["--include", pattern])];
    } else {
      command = hfCli;
      label = "Hugging Face";
      // --include=PAT, never a separate argv item: the CLI's argument parser
      // would expand globs against the working directory (download-utils.js).
      args = ["download", repo, "--revision", revision, ...patterns.map((pattern) => `--include=${pattern}`), "--local-dir", localDir];
    }
    if (!nonEmpty(command)) {
      throw new HubError("cli_missing", `The ${label} download CLI is not installed.`, { status: 503 });
    }
    return {
      command,
      args,
      label,
      cli: opts.source === "modelscope" ? "modelscope" : "hf",
      display: `${path.basename(String(command)).replace(/\.exe$/i, "")} ${args.join(" ")}`,
      batches: batches.length,
      batchIndex: index,
    };
  }

  function start(job, hooks = {}) {
    if (!supports(job)) {
      throw new HubError("invalid_transfer_options", "This engine cannot run the job.", { status: 422 });
    }
    // Everything that can fail on the job's own data fails before a lock is taken.
    const env = buildEnv(job);
    const first = buildCommand(job);
    const total = first.batches;
    const localDir = job.target.localDir;
    const logFile = logsDir && job.id ? createJobLogFile(logsDir, job.id) : null;
    const stderrRing = [];
    let lockId = null;
    if (modelStorage && typeof modelStorage.acquireOperation === "function") {
      lockId = modelStorage.acquireOperation([localDir], "download");
    }

    let child = null;
    let childAlive = false;
    let batchIndex = first.batchIndex;
    let stopReason = null;
    let finished = false;
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });

    const emit = (stream, rawLine) => {
      let line = redactor.redact(String(rawLine ?? ""));
      if (line.length > MAX_LINE_LENGTH) line = `${line.slice(0, MAX_LINE_LENGTH)}…`;
      if (stream === "stderr") {
        stderrRing.push(line);
        if (stderrRing.length > STDERR_RING_LINES) stderrRing.shift();
      }
      logFile?.write(line);
      try {
        hooks.onLine?.(stream, line);
      } catch {
        // A throwing observer must not break the supervision.
      }
    };

    async function finish(result) {
      if (finished) return;
      finished = true;
      try {
        await logFile?.flush();
      } finally {
        if (lockId) {
          try {
            modelStorage.releaseOperation(lockId);
          } catch {
            // The record is swept when this process is gone.
          }
        }
        resolveExit();
      }
      try {
        hooks.onExit?.({
          code: result.code ?? null,
          signal: result.signal ?? null,
          error: result.error || null,
          stopReason,
          batchIndex,
          batches: total,
          stderrTail: stderrRing.slice(),
        });
      } catch {
        // The queue owns its own error handling.
      }
    }

    function runBatch() {
      let spec;
      try {
        spec = buildCommand(job, batchIndex);
      } catch (error) {
        setImmediate(() => finish({ code: null, error }));
        return;
      }
      emit("system", `> ${spec.display}`);
      let current;
      try {
        current = spawnImpl(spec.command, spec.args, { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        setImmediate(() => finish({ code: null, error }));
        return;
      }
      child = current;
      childAlive = true;
      const startedAt = new Date(now()).toISOString();
      if (current?.pid && lockId) {
        try {
          modelStorage.trackChild(lockId, current.pid);
        } catch {
          // Tracking only improves the lock's liveness check.
        }
      }
      try {
        hooks.onSpawn?.({ pid: current?.pid ?? null, startedAt, batchIndex, batches: total });
      } catch {
        // See emit().
      }
      const outForwarder = createUtf8LogForwarder((line) => emit("stdout", line));
      const errForwarder = createUtf8LogForwarder((line) => emit("stderr", line));
      current.stdout?.on?.("data", outForwarder.write);
      current.stdout?.on?.("end", outForwarder.flush);
      current.stderr?.on?.("data", errForwarder.write);
      current.stderr?.on?.("end", errForwarder.flush);
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        childAlive = false;
        outForwarder.flush();
        errForwarder.flush();
        if (result.error || result.code !== 0 || stopReason) {
          finish(result);
          return;
        }
        if (batchIndex + 1 < total) {
          batchIndex += 1;
          try {
            hooks.onBatch?.({ batchIndex, batches: total });
          } catch {
            // See emit().
          }
          runBatch();
          return;
        }
        finish(result);
      };
      current.on?.("error", (error) => settle({ code: null, error }));
      current.on?.("close", (code, signal) => settle({ code: code ?? null, signal: signal ?? null }));
    }

    runBatch();

    return {
      get pid() {
        return child?.pid ?? null;
      },
      stderrTail: () => stderrRing.slice(),
      /** Kills the process tree and resolves once it has exited (or after a bounded wait). */
      stop(reason = "cancel") {
        if (finished) return Promise.resolve();
        stopReason = stopReason || reason;
        const pid = childAlive ? child?.pid : null;
        if (pid) {
          try {
            terminate(pid);
          } catch {
            // The process may already be gone.
          }
        }
        return Promise.race([
          exited,
          new Promise((resolve) => {
            const timer = setTimeout(resolve, stopWaitMs);
            timer.unref?.();
          }),
        ]);
      },
    };
  }

  // One Get-CimInstance query for one pid (03 §6.2). Resolves to the parsed
  // record, or null when the process does not exist.
  function queryProcess(pid) {
    const id = Math.trunc(Number(pid));
    if (!Number.isInteger(id) || id <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let child;
      let output = "";
      let timer = null;
      const done = (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      try {
        if (platform === "win32") {
          const script = `Get-CimInstance Win32_Process -Filter 'ProcessId=${id}' | Select ProcessId,CreationDate,CommandLine | ConvertTo-Json`;
          child = spawnImpl("powershell", ["-NoProfile", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        } else {
          child = spawnImpl("ps", ["-o", "pid=,args=", "-p", String(id)], { stdio: ["ignore", "pipe", "ignore"] });
        }
      } catch {
        done(null);
        return;
      }
      timer = setTimeout(() => {
        try {
          child.kill?.();
        } catch {
          // Already gone.
        }
        done(null);
      }, CIM_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.on?.("data", (chunk) => { output += String(chunk); });
      child.on?.("error", () => done(null));
      child.on?.("close", () => {
        if (platform === "win32") {
          done(parseCimOutput(output));
          return;
        }
        const match = /^\s*(\d+)\s+(.*)$/m.exec(output);
        done(match ? { ProcessId: Number(match[1]), CommandLine: match[2] } : null);
      });
    });
  }

  /**
   * At hub start: for every job that was in process with a recorded pid, ask
   * the OS what that pid is now. `matches` is true only when the command line
   * has both `download` and the job's localDir; with `{ kill: true }` exactly
   * those are terminated (`killed: true`). A reused pid never matches.
   */
  async function findOrphans(jobs, { kill = false } = {}) {
    const found = [];
    for (const job of jobs ? Array.from(jobs.values ? jobs.values() : jobs) : []) {
      const pid = Number(job?.transfer?.pid);
      if (!IN_PROCESS_STATES.has(String(job?.state || "")) || !Number.isInteger(pid) || pid <= 0) continue;
      const record = await queryProcess(pid);
      if (!record) continue;
      const matches = commandLineMatches(record.CommandLine, job?.target?.localDir);
      const entry = { jobId: job.id, pid, alive: true, matches };
      if (matches && kill) {
        try {
          terminate(pid);
          entry.killed = true;
        } catch {
          entry.killed = false;
        }
      }
      found.push(entry);
    }
    return found;
  }

  return { id: "cli", supports, buildCommand, buildEnv, start, findOrphans };
}

module.exports = {
  ARGV_BUDGET,
  IN_PROCESS_STATES,
  commandLineMatches,
  createCliTransferEngine,
  includeBatches,
};
