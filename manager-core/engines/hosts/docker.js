"use strict";

// DockerHost (docs/overhaul/01-engines.md §13, ENG-9): the RuntimeHost for
// Docker Desktop and for docker inside a WSL distribution. Both are one
// implementation over docker-runtime.js, container-replacement.js and
// docker-utils.js; WSL differs only in the executable, the argv prefix
// ("wsl.exe -d <distro> --exec docker ...") and the daemon start command.
//
// createDockerHostConfig decides which one a manager talks to. Precedence:
// DOCKER_WSL_DISTRO env > platform.json docker.wslDistro (read through
// readSection("docker"); this module never writes platform.json) > Docker
// Desktop. Without the env var and without the platform.json key the config
// equals what vllm-manager built inline before, so nothing changes.
//
// Secrets reach `docker run` only through the child env (buildDockerChildEnv,
// with WSLENV NAME/u entries under WSL) and name-only `-e NAME` flags; every
// run attempt, retries included, gets the same env. No value is ever put in
// argv, a log line or an error message here.

const childProcess = require("node:child_process");
const { renderRunArgs } = require("../adapters/_docker-segments");
const { parseJsonSafe } = require("../../common-utils");
const {
  beginContainerReplacement,
  removeContainerIfPresent,
} = require("../../container-replacement");
const {
  buildDockerChildEnv,
  createDockerRuntime,
  dockerRunWithRetries,
  normalizeDockerContainerName,
  normalizeDockerTimestamp,
} = require("../../docker-runtime");
const {
  isContainerNameConflictError,
  isDockerPublishBindError,
  isLoopbackHost,
  isWildcardHost,
  parseDockerPsLabels,
  replaceDockerPublishArgs,
} = require("../../docker-utils");
const { firstExisting } = require("../../file-utils");
const { REDACTED, redactSecrets } = require("../../secret-redactor");

// server.js has validated the distro with this pattern since WSL support
// landed; platform-config.schema.json uses the same characters.
const WSL_DISTRO_PATTERN = /^[A-Za-z0-9._-]+$/;
const DESKTOP_RUNTIME_NAME = "Docker Desktop";
const DEFAULT_WSL_EXE = "wsl.exe";
const PULL_POLICIES = Object.freeze(["auto", "explicit"]);
// A value after one of these flags is a secret even when the caller did not
// list it in redactions (SGLang keeps --api-key in argv, 01 §18).
const SECRET_VALUE_FLAGS = new Set(["--api-key", "--hf-token", "--token", "--admin-api-key"]);
const LOCAL_BUILD_IMAGE = /^local\//i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function hostError(code, message, status, extra = {}) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  Object.assign(error, extra);
  return error;
}

function defaultReadSection(name, options) {
  // Lazy: a manager that never builds a DockerHost never loads the config module.
  return require("../../platform/config").readSection(name, options);
}

// readSection("docker") result, the docker section values themselves, or a
// whole config object with a `docker` key -> { values, sources, errors }.
function dockerSectionFrom(input) {
  if (!isPlainObject(input)) return { values: {}, sources: {}, errors: [] };
  if (isPlainObject(input.values)) {
    return {
      values: input.values,
      sources: isPlainObject(input.sources) ? input.sources : {},
      errors: Array.isArray(input.errors) ? input.errors : [],
    };
  }
  if (isPlainObject(input.docker)) return { values: input.docker, sources: {}, errors: [] };
  return { values: input, sources: {}, errors: [] };
}

function readDockerSection(env, platformConfig, options, warnings) {
  if (platformConfig !== undefined) return dockerSectionFrom(platformConfig);
  try {
    const readSection = typeof options.readSection === "function" ? options.readSection : defaultReadSection;
    return dockerSectionFrom(readSection("docker", { env, ...(options.aiRoot ? { aiRoot: options.aiRoot } : {}) }));
  } catch (error) {
    // platform.json problems never stop a manager (00 §2): Docker Desktop it is.
    warnings.push({ field: "docker", code: "config_unreadable", message: `The docker config section could not be read (${error?.code || error?.message || "error"}); Docker Desktop is used.` });
    return { values: {}, sources: {}, errors: [] };
  }
}

/**
 * Which Docker a manager talks to (01 §13).
 *
 * env            process.env-like; DOCKER_WSL_DISTRO, WSL_EXE, DOCKER_DESKTOP_EXE.
 * platformConfig readSection("docker") result or the docker section values;
 *                undefined reads readSection("docker") itself (never throws),
 *                null means no platform.json.
 * options        { dockerExeCandidates, desktopExeCandidates } in the managers'
 *                legacy firstExisting order (the configured desktopExe goes in
 *                front), plus aiRoot/readSection for the section read.
 *
 * An invalid DOCKER_WSL_DISTRO throws, as vllm-manager always did at startup;
 * an invalid platform.json value is a warning and leaves Docker Desktop.
 */
function createDockerHostConfig(env = process.env, platformConfig = undefined, options = {}) {
  const sourceEnv = env || {};
  const warnings = [];
  const section = readDockerSection(sourceEnv, platformConfig, options || {}, warnings);
  for (const error of section.errors) {
    if (String(error?.field || "").startsWith("docker.") || error?.field === "$file") {
      warnings.push({ field: error.field, code: error.code, message: error.message });
    }
  }

  const envDistro = textOf(sourceEnv.DOCKER_WSL_DISTRO);
  if (envDistro && !WSL_DISTRO_PATTERN.test(envDistro)) {
    throw hostError("invalid_docker_wsl_distro", "DOCKER_WSL_DISTRO contains unsupported characters.", 400);
  }
  let wslDistro = envDistro;
  let distroSource = envDistro ? "env" : "default";
  if (envDistro && textOf(section.values.wslDistro) === envDistro && section.sources["docker.wslDistro"]) {
    // The supervisor injects config-derived env; report the source it names.
    distroSource = section.sources["docker.wslDistro"];
  }
  if (!wslDistro) {
    const fileDistro = textOf(section.values.wslDistro);
    if (fileDistro && WSL_DISTRO_PATTERN.test(fileDistro)) {
      wslDistro = fileDistro;
      distroSource = section.sources["docker.wslDistro"] || "file";
    } else if (fileDistro) {
      warnings.push({ field: "docker.wslDistro", code: "invalid_value", message: "docker.wslDistro contains unsupported characters; Docker Desktop is used." });
    }
  }

  const configuredDesktopExe = textOf(sourceEnv.DOCKER_DESKTOP_EXE) || textOf(section.values.desktopExe);
  const pick = typeof options?.firstExisting === "function" ? options.firstExisting : firstExisting;
  const desktopExeCandidates = Array.isArray(options?.desktopExeCandidates) ? options.desktopExeCandidates : [];
  const dockerExeCandidates = Array.isArray(options?.dockerExeCandidates)
    ? options.dockerExeCandidates
    : [sourceEnv.DOCKER_EXE, "docker"];
  const dockerDesktopExe = pick([configuredDesktopExe, ...desktopExeCandidates]);
  const viaWsl = Boolean(wslDistro);
  const wslExe = textOf(sourceEnv.WSL_EXE) || DEFAULT_WSL_EXE;

  return Object.freeze({
    kind: "docker",
    id: viaWsl ? `docker-wsl:${wslDistro}` : "docker-desktop",
    wslDistro,
    viaWsl,
    dockerExe: viaWsl ? wslExe : pick(dockerExeCandidates),
    dockerArgsPrefix: Object.freeze(viaWsl ? ["-d", wslDistro, "--exec", "docker"] : []),
    runtimeName: viaWsl ? `WSL ${wslDistro}` : DESKTOP_RUNTIME_NAME,
    daemonStartFile: viaWsl ? wslExe : "",
    daemonStartArgs: Object.freeze(viaWsl ? ["-d", wslDistro, "--exec", "sleep", "infinity"] : []),
    dockerDesktopExe,
    sources: Object.freeze({ wslDistro: distroSource }),
    warnings: Object.freeze(warnings.map((warning) => Object.freeze(warning))),
  });
}

// ---------------------------------------------------------------------------
// Publish bindings ("host:port:containerPort")

function parsePublishBinding(value) {
  const text = textOf(value);
  const match = text.match(/^(?:(\[[^\]]*\]|[^:]+):)?(\d+):(\d+)(?:\/[a-z]+)?$/i);
  if (!match) return null;
  return { host: match[1] || "", port: Number(match[2]), containerPort: Number(match[3]) };
}

function isWildcardPublish(value) {
  const binding = parsePublishBinding(value);
  return Boolean(binding) && isWildcardHost(binding.host);
}

// A LAN launch publishes on a host address besides loopback; only then does a
// bind failure fall back to the wildcard address (server.js LAN retry).
function isLanPublish(publish) {
  return (Array.isArray(publish) ? publish : []).some((value) => {
    const binding = parsePublishBinding(value);
    return Boolean(binding) && !isLoopbackHost(binding.host) && !isWildcardHost(binding.host);
  });
}

function wildcardPublish(publish) {
  const binding = (Array.isArray(publish) ? publish : []).map(parsePublishBinding).find(Boolean);
  return binding ? [`0.0.0.0:${binding.port}:${binding.containerPort}`] : null;
}

function publishFromArgs(args) {
  const publish = [];
  const list = Array.isArray(args) ? args : [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = String(list[index]);
    if ((arg === "-p" || arg === "--publish") && index + 1 < list.length) {
      publish.push(String(list[index + 1]));
      index += 1;
    } else if (arg.startsWith("--publish=")) {
      publish.push(arg.slice("--publish=".length));
    }
  }
  return publish;
}

function containerNameFromArgs(args) {
  const list = Array.isArray(args) ? args : [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = String(list[index]);
    if (arg === "--name" && index + 1 < list.length) return String(list[index + 1]);
    if (arg.startsWith("--name=")) return arg.slice("--name=".length);
  }
  return "";
}

/** The argv with secret values replaced by "<redacted>" (secret-redactor). */
function redactRunArgs(argv, secrets = []) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const options = { secrets: secrets.map(String).filter(Boolean), minSecretLength: 6 };
  return list.map((arg, index) => (
    index > 0 && SECRET_VALUE_FLAGS.has(list[index - 1]) ? REDACTED : redactSecrets(arg, options)
  ));
}

function commandSecrets(cmd, secretEnv) {
  return [
    ...(Array.isArray(cmd?.redactions) ? cmd.redactions : []),
    ...Object.values(isPlainObject(secretEnv) ? secretEnv : {}),
  ].map((value) => textOf(value)).filter(Boolean);
}

function isLocalBuildImage(image) {
  return LOCAL_BUILD_IMAGE.test(textOf(image));
}

// ---------------------------------------------------------------------------
// docker pull progress (non-TTY output: one status line per layer change)

const LAYER_PROGRESS = Object.freeze([
  [/^already exists/i, 1],
  [/^pull complete/i, 1],
  [/^extracting/i, 0.75],
  [/^download complete/i, 0.5],
  [/^verifying checksum/i, 0.45],
  [/^downloading/i, 0.25],
  [/^(?:pulling fs layer|waiting|retrying)/i, 0],
]);

function createPullProgressTracker() {
  const layers = new Map();
  let digest = null;
  let status = "";
  return {
    update(line) {
      const text = textOf(line);
      if (!text) return false;
      const digestMatch = text.match(/^Digest:\s*(sha256:[a-f0-9]{64})/i);
      if (digestMatch) {
        digest = digestMatch[1].toLowerCase();
        return true;
      }
      if (/^Status:/i.test(text)) {
        status = text.replace(/^Status:\s*/i, "");
        return true;
      }
      const layer = text.match(/^([a-f0-9]{12,64}):\s*(.+)$/i);
      if (!layer) return false;
      const entry = LAYER_PROGRESS.find(([pattern]) => pattern.test(layer[2]));
      if (!entry) return false;
      const previous = layers.get(layer[1]) || 0;
      layers.set(layer[1], Math.max(previous, entry[1]));
      return true;
    },
    snapshot() {
      const values = [...layers.values()];
      const done = values.filter((value) => value >= 1).length;
      const percent = values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) : 0;
      return { percent, layersTotal: values.length, layersDone: done, digest, status };
    },
  };
}

/** docker pull output text -> { percent, layersTotal, layersDone, digest, status }. */
function parseDockerPullProgress(text) {
  const tracker = createPullProgressTracker();
  for (const line of String(text || "").split(/\r?\n/)) tracker.update(line);
  return tracker.snapshot();
}

// ---------------------------------------------------------------------------
// docker inspect -> InstanceState

function portsText(ports) {
  if (!isPlainObject(ports)) return "";
  const parts = [];
  for (const [containerPort, bindings] of Object.entries(ports)) {
    for (const binding of Array.isArray(bindings) ? bindings : []) {
      if (!binding?.HostPort) continue;
      parts.push(`${binding.HostIp || "0.0.0.0"}:${binding.HostPort}->${containerPort}`);
    }
  }
  return parts.join(", ");
}

function inspectState(info) {
  const state = isPlainObject(info?.State) ? info.State : {};
  return {
    exists: true,
    id: textOf(info?.Id),
    name: normalizeDockerContainerName(info?.Name),
    running: Boolean(state.Running),
    status: textOf(state.Status) || (state.Running ? "running" : "unknown"),
    labels: isPlainObject(info?.Config?.Labels) ? { ...info.Config.Labels } : {},
    image: textOf(info?.Config?.Image),
    imageId: textOf(info?.Image),
    ports: portsText(info?.NetworkSettings?.Ports),
    createdAt: normalizeDockerTimestamp(info?.Created),
    startedAt: normalizeDockerTimestamp(state.StartedAt),
    exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
  };
}

function dockerErrorText(result) {
  return textOf(result?.stderr || result?.stdout || result?.error?.message);
}

/**
 * RuntimeHost over Docker (01 §13).
 *
 * options: config (createDockerHostConfig result; built from env/platformConfig
 * when absent), runtime (an existing docker-runtime), managerLabelValue and
 * ownerLabelKey (checkpoint owner check and list filter), baseEnv (the child
 * env base, default process.env), and the test seams execFileCommand,
 * spawnCommand, fsExists, delay, parseJsonSafe, formatBytes, readTimeoutMs.
 */
function createDockerHost(options = {}) {
  const config = options.config || createDockerHostConfig(options.env || process.env, options.platformConfig, options);
  const runtime = options.runtime || createDockerRuntime({
    dockerExe: config.dockerExe,
    dockerArgsPrefix: config.dockerArgsPrefix,
    dockerDesktopExe: config.dockerDesktopExe,
    daemonStartFile: config.daemonStartFile,
    daemonStartArgs: config.daemonStartArgs,
    runtimeName: config.runtimeName,
    execFileCommand: options.execFileCommand,
    spawnCommand: options.spawnCommand,
    fsExists: options.fsExists,
    delay: options.delay,
    parseJsonSafe: options.parseJsonSafe,
    formatBytes: options.formatBytes,
    readTimeoutMs: options.readTimeoutMs,
  });
  const docker = runtime.docker;
  const spawnCommand = options.spawnCommand || childProcess.spawn;
  const parseJson = options.parseJsonSafe || parseJsonSafe;
  const baseEnv = options.baseEnv || process.env;
  const ownerLabelKey = textOf(options.ownerLabelKey) || "ai.manager";
  const managerLabelValue = textOf(options.managerLabelValue);
  const viaWsl = Boolean(config.viaWsl);

  /** The docker child env for a run: the secrets plus WSLENV NAME/u under WSL. */
  function childEnv(secretEnv = {}) {
    return buildDockerChildEnv(secretEnv, { viaWsl, baseEnv });
  }

  async function ready({ autoStart = false, timeoutMs = 120000 } = {}) {
    const current = await runtime.checkDockerDaemon();
    if (current.ok) return { ok: true, version: current.version, detail: "", started: false };
    if (!autoStart) return { ok: false, version: null, detail: current.error, raw: current.raw, started: false };
    const readiness = await runtime.ensureDockerDaemonRunning(timeoutMs);
    return {
      ok: Boolean(readiness.ok),
      version: readiness.version || null,
      detail: readiness.ok ? "" : readiness.error,
      raw: readiness.raw,
      started: Boolean(readiness.ok && !readiness.alreadyRunning),
    };
  }

  /** Live image status (docker image inspect); never cached. */
  function imageStatus(ref) {
    return runtime.getImageStatus(ref);
  }

  // getImageStatus -> true | false | null: null means Docker could not answer.
  function presenceOf(status) {
    if (status?.ok) return true;
    if (status?.reason === "missing-image" || status?.text === "missing") return false;
    return null;
  }

  async function imagePresent(ref) {
    return presenceOf(await imageStatus(ref));
  }

  /**
   * Makes sure `ref` is present before anything is stopped (01 §14 stage 3).
   * policy "auto" pulls a missing image exactly as the managers did
   * (pullImageWithRetry; a Docker that cannot answer is also pulled, as before);
   * "explicit" never pulls and throws image_pull_required. onMissing({image,
   * status}) runs before the pull and may throw to refuse it.
   */
  async function ensureImage(ref, ensureOptions = {}) {
    const image = textOf(ref);
    const policy = ensureOptions.policy === undefined ? "auto" : ensureOptions.policy;
    if (!PULL_POLICIES.includes(policy)) {
      throw hostError("invalid_pull_policy", `Unknown image pull policy: ${String(policy)}.`, 400);
    }
    const status = await imageStatus(image);
    const present = presenceOf(status);
    if (present === true) return { ok: true, pulled: false, image, status };
    if (policy === "explicit") {
      if (present === null) {
        throw hostError("docker_unavailable", status?.text || "Docker did not answer the image check.", 503, { image });
      }
      throw hostError("image_pull_required", `Image ${image} is not present; pull it explicitly before launching.`, 409, { image });
    }
    if (typeof ensureOptions.onMissing === "function") await ensureOptions.onMissing({ image, status, present });
    const pullOptions = {};
    for (const key of ["attempts", "initialDelayMs", "platform", "onAttempt", "onFailure", "dockerOptions"]) {
      if (ensureOptions[key] !== undefined) pullOptions[key] = ensureOptions[key];
    }
    const result = await runtime.pullImageWithRetry(image, pullOptions);
    return { ok: true, pulled: true, image, status, result };
  }

  /**
   * The pull job's pull (01 §14): docker pull with layer progress parsed from
   * its output into onProgress({percent, layersTotal, layersDone, digest,
   * status}). Local builds (local/...) cannot be pulled: 422 image_local_build.
   */
  function pull(ref, { platform = "", onProgress } = {}) {
    const image = textOf(ref);
    if (!image) return Promise.reject(hostError("image_required", "An image reference is required.", 400));
    if (isLocalBuildImage(image)) {
      return Promise.reject(hostError("image_local_build", `${image} is a local build; build it on this machine instead of pulling.`, 422, { image }));
    }
    const args = [...config.dockerArgsPrefix, "pull", ...(textOf(platform) ? ["--platform", textOf(platform)] : []), image];
    const tracker = createPullProgressTracker();
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnCommand(config.dockerExe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      let pending = "";
      let settled = false;
      const consume = (text, flush = false) => {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = flush ? "" : lines.pop();
        let changed = false;
        for (const line of lines) changed = tracker.update(line) || changed;
        if (changed && typeof onProgress === "function") {
          try { onProgress(tracker.snapshot()); } catch {}
        }
      };
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        consume(text);
      });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        consume("", true);
        if (code === 0) {
          const progress = { ...tracker.snapshot(), percent: 100 };
          if (typeof onProgress === "function") {
            try { onProgress(progress); } catch {}
          }
          resolve({ ok: true, image, digest: progress.digest, status: progress.status, stdout, stderr });
          return;
        }
        reject(hostError("image_pull_failed", textOf(stderr) || textOf(stdout) || `docker pull exited with code ${code}`, 502, { image, exitCode: code }));
      });
    });
  }

  /** LaunchCommand -> { argv, redactedArgv } through the one renderer (01 §7). */
  function renderCommand(cmd) {
    const argv = renderRunArgs(cmd);
    return { argv, redactedArgv: redactRunArgs(argv, commandSecrets(cmd, cmd?.secretEnv)) };
  }

  /**
   * docker run -d for a LaunchCommand, or for argv a legacy caller already
   * rendered ({ runArgs, publish?, name? }). Every attempt gets the same child
   * env. A name conflict removes the leftover container and retries once; a
   * bind failure of a LAN publish retries once with the wildcard address
   * (bindRetryPublish(error, publish) may supply the legacy publish list).
   * onRetry({kind:"name-conflict"|"lan-bind", ...}) reports each retry.
   */
  async function create(cmd, createOptions = {}) {
    const runArgs = Array.isArray(cmd?.runArgs) ? cmd.runArgs.map(String) : renderRunArgs(cmd);
    const name = textOf(createOptions.name || cmd?.name || containerNameFromArgs(runArgs));
    const secretEnv = createOptions.secretEnv !== undefined ? createOptions.secretEnv : cmd?.secretEnv;
    let publish = Array.isArray(createOptions.publish)
      ? createOptions.publish.map(String)
      : Array.isArray(cmd?.publish) ? cmd.publish.map(String) : publishFromArgs(runArgs);
    const lanFallback = createOptions.lanFallback === undefined ? isLanPublish(publish) : Boolean(createOptions.lanFallback);
    const onRetry = typeof createOptions.onRetry === "function" ? createOptions.onRetry : null;
    let finalArgs = runArgs;
    let attempts = 1;
    const result = await dockerRunWithRetries({
      docker,
      runArgs,
      dockerOptions: { env: childEnv(secretEnv) },
      isNameConflictError: isContainerNameConflictError,
      onNameConflict: async (error) => {
        attempts += 1;
        if (onRetry) await onRetry({ kind: "name-conflict", error, name });
        if (name) await removeContainerIfPresent(docker, name);
      },
      getBindRetryArgs: (error) => {
        if (!lanFallback || !isDockerPublishBindError(error) || publish.some(isWildcardPublish)) return null;
        const next = typeof createOptions.bindRetryPublish === "function"
          ? createOptions.bindRetryPublish(error, publish.slice())
          : wildcardPublish(publish);
        if (!Array.isArray(next) || !next.length) return null;
        attempts += 1;
        publish = next.map(String);
        finalArgs = replaceDockerPublishArgs(runArgs, publish);
        if (onRetry) onRetry({ kind: "lan-bind", error, publish: publish.slice(), runArgs: finalArgs.slice() });
        return finalArgs;
      },
    });
    const stdout = String(result?.stdout || "");
    return {
      name,
      id: stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "",
      stdout,
      stderr: String(result?.stderr || ""),
      runArgs: finalArgs,
      publish,
      attempts,
    };
  }

  /**
   * docker inspect -> { exists, running, status, labels, image, imageId,
   * ports, startedAt, exitCode, ... }. There is no cache, so every call is
   * fresh (`fresh` is accepted for the interface). A Docker failure is
   * { exists:false, error } and never a "missing" container.
   */
  async function inspect(name, { fresh = true } = {}) {
    void fresh;
    const out = await docker(["inspect", textOf(name), "--format", "{{json .}}"], { rejectOnError: false, maxBuffer: 8 * 1024 * 1024 });
    const text = textOf(out.stdout);
    if (out.error || !text) {
      const detail = dockerErrorText(out);
      if (!out.error || /no such (?:object|container)/i.test(detail)) {
        return { exists: false, running: false, status: "missing", labels: {} };
      }
      return { exists: false, running: false, status: "unknown", labels: {}, error: detail || `Unable to inspect ${textOf(name)}.` };
    }
    const parsed = parseJson(text, null);
    const info = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!isPlainObject(info)) {
      return { exists: false, running: false, status: "unknown", labels: {}, error: `Docker returned invalid inspect data for ${textOf(name)}.` };
    }
    return inspectState(info);
  }

  /** Every container carrying <ownerLabelKey>=<ownerLabelValue> (all owners when empty). */
  async function list({ ownerLabelValue = managerLabelValue } = {}) {
    const owner = textOf(ownerLabelValue);
    const filter = owner ? `label=${ownerLabelKey}=${owner}` : `label=${ownerLabelKey}`;
    const out = await docker(["ps", "-a", "--filter", filter, "--format", "{{json .}}"], { rejectOnError: false, maxBuffer: 8 * 1024 * 1024 });
    if (out.error) throw hostError("docker_list_failed", dockerErrorText(out) || "docker ps failed.", 503);
    const rows = [];
    for (const line of String(out.stdout || "").split(/\r?\n/)) {
      const row = parseJson(line.trim(), null);
      if (!isPlainObject(row)) continue;
      const state = textOf(row.State).toLowerCase();
      rows.push({
        exists: true,
        id: textOf(row.ID),
        name: normalizeDockerContainerName(row.Names),
        running: state === "running",
        state,
        status: textOf(row.Status),
        labels: parseDockerPsLabels(row),
        image: textOf(row.Image),
        ports: textOf(row.Ports),
        createdAt: normalizeDockerTimestamp(row.CreatedAt),
      });
    }
    return rows;
  }

  /** Rollback point for a replace launch: container-replacement's checkpoint. */
  function checkpoint(name, checkpointOptions = {}) {
    return beginContainerReplacement({
      docker,
      containerName: name,
      managerId: checkpointOptions.managerId !== undefined ? checkpointOptions.managerId : managerLabelValue,
      ownerLabelKey: checkpointOptions.ownerLabelKey || ownerLabelKey,
      stopTimeoutSeconds: checkpointOptions.stopTimeoutSeconds,
      onEvent: checkpointOptions.onEvent,
    });
  }

  /** docker logs text (stdout + stderr); the caller redacts. */
  async function logs(name, { tail = 200, sinceIso = "" } = {}) {
    const args = ["logs"];
    if (tail !== undefined && tail !== null && tail !== "") args.push("--tail", String(tail));
    if (textOf(sinceIso)) args.push("--since", textOf(sinceIso));
    args.push(textOf(name));
    const out = await docker(args, { rejectOnError: false });
    return `${out.stdout || ""}${out.stderr || ""}`;
  }

  /** docker rm -f, as the managers stop today. `reason` is for the caller's log. */
  async function stop(name, { reason = "" } = {}) {
    void reason;
    return { removed: await removeContainerIfPresent(docker, textOf(name)) };
  }

  return {
    kind: "docker",
    id: config.id,
    config,
    runtime,
    docker,
    viaWsl,
    childEnv,
    ready,
    imageStatus,
    imagePresent,
    ensureImage,
    pull,
    renderCommand,
    create,
    inspect,
    list,
    checkpoint,
    logs,
    stop,
  };
}

module.exports = {
  WSL_DISTRO_PATTERN,
  PULL_POLICIES,
  createDockerHostConfig,
  createDockerHost,
  createPullProgressTracker,
  parseDockerPullProgress,
  containerNameFromArgs,
  publishFromArgs,
  isLanPublish,
  isLocalBuildImage,
  redactRunArgs,
};
