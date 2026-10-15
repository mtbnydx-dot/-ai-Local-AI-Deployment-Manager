"use strict";

// NativeProcessHost (01 §13, ENG-22): the RuntimeHost that runs a registered
// binary (llama-server.exe, a TabbyAPI venv) as a detached process instead of
// a container. It ships disabled: nothing here works unless platform.json
// engines.native.enabled is true, read through readSection("engines"), and the
// engine registry hides the "native" host kind while the flag is off.
//
// The binary comes from the runtime manifest (native:{path relative to
// AI_ROOT, sha256}) and its hash is verified before every spawn. A running
// instance is described by a state file under .runtime/native/<managerId>/, so
// it survives a manager restart the way a container does and adopt() finds it
// again (process.kill(pid, 0) plus a health GET). There is no rename
// checkpoint: replace mode stops the old instance and, when the new one fails,
// relaunches the old LaunchSpec (native_no_hot_rollback).

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { terminateProcessTree } = require("../../process-job-runner");

const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const LOG_TAIL_MAX_BYTES = 1024 * 1024;
const HEALTH_TIMEOUT_MS = 3000;
const STOP_WAIT_MS = 10_000;
const STOP_POLL_MS = 100;
const NO_HOT_ROLLBACK = "native_no_hot_rollback";
const OWNER_LABEL_KEY = "ai.manager";
const LAUNCH_ID_LABEL_KEY = "ai.manager.launch-id";
const INSTANCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MANAGER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// The only variables a native child inherits; secrets arrive through secretEnv.
const ENV_ALLOWLIST = Object.freeze([
  "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL",
  "CUDA_PATH", "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "LD_LIBRARY_PATH",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(value) {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}

function hostError(code, message, status = 500, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function defaultAiRoot() {
  return process.env.AI_ROOT || path.resolve(__dirname, "..", "..", "..");
}

function defaultReadSection(name, options) {
  return require("../../platform/config").readSection(name, options);
}

/**
 * The native flag from a readSection("engines") result or the engines section
 * values. Anything but a literal true (a missing section, an error, a string)
 * is off.
 */
function nativeEnabledFrom(input) {
  const values = isPlainObject(input?.values) ? input.values : isPlainObject(input?.value) ? input.value : input;
  return isPlainObject(values) && isPlainObject(values.native) && values.native.enabled === true;
}

/** engines.native.enabled through readSection("engines"); never throws. */
function isNativeEnabled(options = {}) {
  try {
    const readSection = typeof options.readSection === "function" ? options.readSection : defaultReadSection;
    return nativeEnabledFrom(readSection("engines", {
      ...(options.env ? { env: options.env } : {}),
      ...(options.aiRoot ? { aiRoot: options.aiRoot } : {}),
    }));
  } catch {
    return false;
  }
}

// A manifest native entry -> { path, sha256 } or null. The path must be
// relative to AI_ROOT and stay below it; the hash is lowercase hex.
function normalizeNativeSpec(spec) {
  if (!isPlainObject(spec)) return null;
  const relative = textOf(spec.path);
  const sha256 = textOf(spec.sha256).replace(/^sha256:/i, "").toLowerCase();
  if (!relative || !SHA256_PATTERN.test(sha256)) return null;
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /[\u0000-\u001f]/.test(relative)) return null;
  if (relative.split(/[\\/]+/).some((part) => part === ".." || part === "")) return null;
  return { path: relative.replace(/\\/g, "/"), sha256 };
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function redactArgv(argv, redactions) {
  const secrets = (Array.isArray(redactions) ? redactions : []).map(String).filter((value) => value.length >= 4);
  return argv.map((token) => secrets.reduce((text, secret) => text.split(secret).join("<redacted>"), String(token)));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function httpHealth(port, timeoutMs) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

/**
 * createNativeHost(options)
 *
 * options: managerId (state directory; "vllm" or "llama"), managerLabelValue
 * (the ai.manager label an instance gets when its command carries none),
 * aiRoot, stateDir, logDir, enabled (boolean or () => boolean; default reads
 * engines.native.enabled through readSection, so the flag follows platform.json
 * live), readSection, env (the child env base, default process.env), relaunch
 * ({launchId, labels, name, port}) => Promise used by a checkpoint rollback,
 * and the seams spawn, terminate (default terminateProcessTree, with killSpawn and
 * platform for tests), isAlive, healthCheck, delay, now, logMaxBytes,
 * stopWaitMs.
 */
function createNativeHost(options = {}) {
  const managerId = textOf(options.managerId) || "manager";
  if (!MANAGER_ID_PATTERN.test(managerId)) throw hostError("native_invalid_manager", "managerId is not a safe directory name.", 500);
  const aiRoot = path.resolve(options.aiRoot || defaultAiRoot());
  const stateDir = path.resolve(options.stateDir || path.join(aiRoot, ".runtime", "native", managerId));
  const logDir = path.resolve(options.logDir || path.join(aiRoot, `${managerId}-manager`, "logs", "native"));
  const managerLabelValue = textOf(options.managerLabelValue);
  const spawn = options.spawn || childProcess.spawn;
  const terminate = options.terminate || ((pid) => terminateProcessTree(pid, {
    ...(options.killSpawn ? { spawnCommand: options.killSpawn } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  }));
  const isAlive = options.isAlive || pidAlive;
  const healthCheck = options.healthCheck || ((port) => httpHealth(port, HEALTH_TIMEOUT_MS));
  const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || (() => new Date());
  const baseEnv = options.env || process.env;
  const logMaxBytes = Number.isFinite(options.logMaxBytes) ? options.logMaxBytes : LOG_ROTATE_BYTES;
  const stopWaitMs = Number.isFinite(options.stopWaitMs) ? options.stopWaitMs : STOP_WAIT_MS;
  const enabledSource = options.enabled;

  function enabled() {
    if (typeof enabledSource === "function") return Boolean(enabledSource());
    if (typeof enabledSource === "boolean") return enabledSource;
    return isNativeEnabled({ readSection: options.readSection, env: options.env, aiRoot: options.aiRoot });
  }

  function assertEnabled() {
    if (!enabled()) {
      throw hostError("native_host_disabled", "The native process host is disabled. Set engines.native.enabled=true in platform.json to use it.", 409);
    }
  }

  function instanceName(value) {
    const name = textOf(value);
    if (!INSTANCE_NAME_PATTERN.test(name)) throw hostError("native_invalid_name", "The instance name is not valid.", 400);
    return name;
  }

  const stateFile = (name) => path.join(stateDir, `${name}.json`);
  const logFile = (name) => path.join(logDir, `${name}.log`);

  function readState(name) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile(name), "utf8"));
      return isPlainObject(parsed) && Number.isInteger(parsed.pid) ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeState(name, state) {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = stateFile(name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  }

  function removeState(name) {
    try {
      fs.rmSync(stateFile(name), { force: true });
    } catch {
      // A leftover file is re-evaluated by the next adopt().
    }
  }

  // The manifest path resolved below AI_ROOT.
  function resolveBinary(spec) {
    const normalized = normalizeNativeSpec(spec);
    if (!normalized) throw hostError("native_binary_invalid", "The native binary needs a path relative to the platform root and a sha256.", 400);
    const file = path.resolve(aiRoot, normalized.path);
    const rel = path.relative(aiRoot, file);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw hostError("native_binary_invalid", "The native binary path leaves the platform root.", 400);
    }
    return { ...normalized, file };
  }

  /** Hash the binary and compare; throws native_binary_missing / native_binary_mismatch. A link may not lead out of AI_ROOT. */
  async function verifyBinary(spec) {
    const binary = resolveBinary(spec);
    let real;
    try {
      real = fs.realpathSync(binary.file);
    } catch {
      throw hostError("native_binary_missing", `The native binary ${binary.path} does not exist.`, 404, { details: { path: binary.path } });
    }
    const rel = path.relative(fs.realpathSync(aiRoot), real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw hostError("native_binary_invalid", "The native binary path leaves the platform root.", 400);
    }
    let actual;
    try {
      actual = await hashFile(real);
    } catch {
      throw hostError("native_binary_missing", `The native binary ${binary.path} could not be read.`, 404, { details: { path: binary.path } });
    }
    if (actual !== binary.sha256) {
      throw hostError("native_binary_mismatch", `The native binary ${binary.path} does not match the registered sha256, so it was not started.`, 409, {
        details: { path: binary.path, expected: binary.sha256, actual },
      });
    }
    return { ...binary, file: real };
  }

  function childEnv(extra, secretEnv) {
    const env = {};
    for (const name of ENV_ALLOWLIST) {
      if (typeof baseEnv[name] === "string") env[name] = baseEnv[name];
    }
    for (const source of [extra, secretEnv]) {
      if (!isPlainObject(source)) continue;
      for (const [name, value] of Object.entries(source)) {
        if (!ENV_NAME_PATTERN.test(name)) throw hostError("native_invalid_env", `"${name}" is not a valid environment variable name.`, 400);
        if (value !== undefined && value !== null) env[name] = String(value);
      }
    }
    return env;
  }

  function nativeSegment(cmd) {
    const segment = isPlainObject(cmd?.native) ? cmd.native : null;
    if (!segment) throw new TypeError("A LaunchCommand with a native segment ({ name, path, sha256, args, env, port }) is required.");
    return segment;
  }

  /** LaunchCommand -> { argv, redactedArgv }; argv[0] is the binary path under AI_ROOT. */
  function renderCommand(cmd) {
    const segment = nativeSegment(cmd);
    const binary = resolveBinary(segment);
    const args = (Array.isArray(segment.args) ? segment.args : []).map(String);
    return { argv: [binary.file, ...args], redactedArgv: redactArgv([binary.path, ...args], cmd?.redactions) };
  }

  // One log file per instance, rotated to .1 when it passes the limit.
  function openLog(name) {
    fs.mkdirSync(logDir, { recursive: true });
    const file = logFile(name);
    try {
      if (fs.statSync(file).size >= logMaxBytes) fs.renameSync(file, `${file}.1`);
    } catch {
      // No log yet.
    }
    return fs.openSync(file, "a");
  }

  async function ready() {
    if (!enabled()) return { ok: false, version: "", detail: "native_host_disabled", started: false };
    return { ok: true, version: "native", detail: "", started: false };
  }

  async function imagePresent(ref) {
    assertEnabled();
    try {
      await verifyBinary(ref);
      return true;
    } catch (error) {
      if (error.code === "native_binary_missing" || error.code === "native_binary_mismatch") return false;
      throw error;
    }
  }

  /** Verifies the binary; a native host never pulls. */
  async function ensureImage(ref) {
    assertEnabled();
    await verifyBinary(ref);
    return { ok: true, pulled: false };
  }

  async function pull() {
    throw hostError("native_no_pull", "A native runtime is installed by the operator; the platform does not download it.", 405);
  }

  async function stopInstance(name) {
    const state = readState(name);
    if (!state) return { removed: false, pid: null };
    if (isAlive(state.pid)) {
      terminate(state.pid);
      const deadline = Date.now() + stopWaitMs;
      while (isAlive(state.pid)) {
        if (Date.now() >= deadline) {
          throw hostError("native_stop_timeout", `Process ${state.pid} of ${name} is still running after the stop request.`, 504);
        }
        await delay(Math.min(STOP_POLL_MS, stopWaitMs));
      }
    }
    removeState(name);
    return { removed: true, pid: state.pid };
  }

  /**
   * Verify the binary, then spawn it detached with the env allowlist plus
   * secretEnv. A live instance under the same name is stopped first (the
   * docker name-conflict retry). Writes the state file and returns
   * { name, id, pid, port, startedAt }.
   */
  async function create(cmd, createOptions = {}) {
    assertEnabled();
    const segment = nativeSegment(cmd);
    const name = instanceName(createOptions.name || segment.name || cmd?.name);
    const port = Number(segment.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw hostError("native_invalid_port", "The native command needs a port between 1 and 65535.", 400);
    const binary = await verifyBinary(segment);
    const secretEnv = createOptions.secretEnv !== undefined ? createOptions.secretEnv : cmd?.secretEnv;
    const env = childEnv(segment.env, secretEnv);
    const args = (Array.isArray(segment.args) ? segment.args : []).map(String);
    if (readState(name)) {
      if (typeof createOptions.onRetry === "function") await createOptions.onRetry({ kind: "name-conflict", name });
      await stopInstance(name);
    }
    const labels = { ...(isPlainObject(cmd?.labels) ? cmd.labels : {}) };
    if (managerLabelValue && !labels[OWNER_LABEL_KEY]) labels[OWNER_LABEL_KEY] = managerLabelValue;
    const fd = openLog(name);
    let child;
    try {
      child = spawn(binary.file, args, {
        cwd: segment.cwd ? path.resolve(aiRoot, String(segment.cwd)) : path.dirname(binary.file),
        env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    if (child && typeof child.on === "function") child.on("error", () => {});
    const pid = child?.pid;
    if (!Number.isInteger(pid) || pid <= 0) {
      throw hostError("native_spawn_failed", `The native binary ${binary.path} did not start.`, 502, { details: { path: binary.path } });
    }
    if (typeof child.unref === "function") child.unref();
    const startedAt = now().toISOString();
    writeState(name, {
      schemaVersion: 1,
      name,
      pid,
      startedAt,
      binaryPath: binary.path,
      binarySha256: binary.sha256,
      port,
      labels,
      launchId: textOf(labels[LAUNCH_ID_LABEL_KEY] || cmd?.launchId),
    });
    return { name, id: String(pid), pid, port, startedAt, binarySha256: binary.sha256, labels };
  }

  function stateToInstance(state, running, healthy) {
    return {
      exists: true,
      id: String(state.pid),
      pid: state.pid,
      name: state.name,
      running,
      status: running ? (healthy === false ? "unhealthy" : "running") : "exited",
      labels: isPlainObject(state.labels) ? { ...state.labels } : {},
      image: textOf(state.binaryPath),
      imageId: textOf(state.binarySha256),
      ports: state.port ? `127.0.0.1:${state.port}` : "",
      port: state.port,
      launchId: textOf(state.launchId),
      createdAt: textOf(state.startedAt),
      startedAt: textOf(state.startedAt),
      exitCode: null,
    };
  }

  /** { exists, running, status, labels, image, imageId, ports, startedAt, exitCode } from the state file and a pid check. */
  async function inspect(name, { fresh = true } = {}) {
    void fresh;
    assertEnabled();
    const state = readState(instanceName(name));
    if (!state) return { exists: false, running: false, status: "missing", labels: {} };
    return stateToInstance(state, isAlive(state.pid), undefined);
  }

  function readAllStates() {
    let names;
    try {
      names = fs.readdirSync(stateDir).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
    } catch {
      return [];
    }
    return names.filter((name) => INSTANCE_NAME_PATTERN.test(name)).map((name) => readState(name)).filter(Boolean);
  }

  /** Every state file owned by ownerLabelValue (all owners when empty), alive or not. */
  async function list({ ownerLabelValue = managerLabelValue } = {}) {
    assertEnabled();
    const owner = textOf(ownerLabelValue);
    return readAllStates()
      .filter((state) => !owner || state.labels?.[OWNER_LABEL_KEY] === owner)
      .map((state) => stateToInstance(state, isAlive(state.pid), undefined));
  }

  /**
   * Manager start: a state file whose pid is alive and whose port answers the
   * health GET is adopted; a live pid that does not answer is reported
   * unhealthy and kept; a dead pid's state file is removed.
   * -> { adopted: InstanceState[], unhealthy: InstanceState[], stale: string[] }
   */
  async function adopt({ ownerLabelValue = managerLabelValue } = {}) {
    assertEnabled();
    const owner = textOf(ownerLabelValue);
    const adopted = [];
    const unhealthy = [];
    const stale = [];
    for (const state of readAllStates()) {
      if (owner && state.labels?.[OWNER_LABEL_KEY] !== owner) continue;
      if (!isAlive(state.pid)) {
        removeState(state.name);
        stale.push(state.name);
        continue;
      }
      const healthy = Number.isInteger(state.port) ? Boolean(await healthCheck(state.port)) : false;
      (healthy ? adopted : unhealthy).push(stateToInstance(state, true, healthy));
    }
    return { adopted, unhealthy, stale };
  }

  /**
   * Replace-mode rollback point. There is no rename: the old instance is
   * stopped now, and rollback(err) stops whatever the failed launch left under
   * that name and relaunches the old LaunchSpec through options.relaunch (or
   * checkpointOptions.relaunch). The result carries warning native_no_hot_rollback.
   */
  async function checkpoint(name, checkpointOptions = {}) {
    assertEnabled();
    const id = instanceName(name);
    const previous = readState(id);
    const relaunch = typeof checkpointOptions.relaunch === "function" ? checkpointOptions.relaunch : options.relaunch;
    const onEvent = typeof checkpointOptions.onEvent === "function" ? checkpointOptions.onEvent : () => {};
    if (previous) {
      await stopInstance(id);
      onEvent({ type: "native-stopped", name: id, pid: previous.pid });
    }
    return {
      warning: NO_HOT_ROLLBACK,
      previous: previous ? stateToInstance(previous, false, undefined) : null,
      async commit() {
        onEvent({ type: "committed", name: id });
        return { committed: true };
      },
      async rollback(error) {
        onEvent({ type: "rollback", name: id, message: error?.message || "" });
        await stopInstance(id).catch(() => {});
        if (!previous) return { restored: false, reason: "no_previous_instance" };
        if (typeof relaunch !== "function") return { restored: false, reason: "no_relaunch", launchId: previous.launchId };
        const result = await relaunch({ launchId: previous.launchId, labels: { ...previous.labels }, name: id, port: previous.port });
        return { restored: true, launchId: previous.launchId, result };
      },
    };
  }

  /** The tail of <logDir>/<name>.log (the caller redacts). */
  async function logs(name, { tail = 200 } = {}) {
    assertEnabled();
    const file = logFile(instanceName(name));
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, LOG_TAIL_MAX_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split(/\r?\n/);
      const count = Number(tail);
      return Number.isInteger(count) && count > 0 ? lines.slice(-count).join("\n") : lines.join("\n");
    } catch {
      return "";
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore.
        }
      }
    }
  }

  /** Stop through terminateProcessTree and drop the state file. */
  async function stop(name, { reason = "" } = {}) {
    void reason;
    assertEnabled();
    return stopInstance(instanceName(name));
  }

  return {
    kind: "native",
    id: "native",
    enabled,
    stateDir,
    logDir,
    verifyBinary,
    ready,
    imagePresent,
    ensureImage,
    pull,
    renderCommand,
    create,
    inspect,
    list,
    adopt,
    checkpoint,
    logs,
    stop,
  };
}

module.exports = {
  ENV_ALLOWLIST,
  LOG_ROTATE_BYTES,
  NO_HOT_ROLLBACK,
  createNativeHost,
  isNativeEnabled,
  nativeEnabledFrom,
  normalizeNativeSpec,
};
