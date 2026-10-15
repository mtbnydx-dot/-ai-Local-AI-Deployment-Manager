"use strict";

// Pre-launch dry probe (docs/overhaul/02-models.md section 12, MOD-13): asks a
// runtime image, in a sandboxed throw-away container, whether it can load a
// model, without a GPU, a running container, an admission lease or the network.
//
//   buildProbeCommand({engineId, runtime, modelDir, modelFile, allowRemoteCode}) -> {argv, name, timeoutMs, ...}
//   runProbe(cmd, {docker, runtimeFacts?, ...}) -> ProbeResult
//   startProbeJob(request, context) -> {job, done}   (POST /api/models/probe)
//
// Two container shapes (12.1, 12.2):
//   registry  vLLM / SGLang / docker-template images: hf_probe.py prints one
//             `@@PROBE@@ <json>` line (registries, Transformers config check);
//             `docker run --rm`, 90 s, `docker rm -f` on a timeout.
//   header    llama.cpp images: a header load with -ngl 0; the manager reads the
//             container log and stops it at the first terminal marker, 30 s.
//
// The sandbox is fixed here and asserted by probe.test.js: --network none,
// read-only mounts, --pull never, no --gpus, dropped capabilities, memory and
// pid caps, and the single label ai.probe=model-inspector (never an ai.manager*
// label, so instance discovery and stop-all never see a probe). A runtime image
// that is not present is 409 runtime_image_missing and is never pulled here.
//
// A probe writes exactly two things: the model result
// <AI_ROOT>/cache/model-probes/<contentDigest12>@<runtimeId>.json, and, for a
// python probe, the image's registries through engines.runtimeFacts.put(runtimeId,
// "registries", ...). It owns no runtime-facts file (01 section 17). An
// `inconclusive` result (timeout, Docker unavailable, a probe that could not
// run) never upgrades a compatibility row; only a `supported` result becomes
// supportEvidence (compatibility.js, rule probes).

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { redactSecrets } = require("../secret-redactor");
const { classifyFailure } = require("./root-cause");

const PROBE_MARKER = "@@PROBE@@";
const PROBE_LABEL = "ai.probe=model-inspector";
const PROBE_JOB_TYPE = "model-probe";
const NAME_PATTERN = /^ai-probe-[a-z2-7]{8}$/;
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}@[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,300}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const MODEL_FILE_PATTERN = /^[^\\/:*?"<>|\u0000-\u001f-][^\\/:*?"<>|\u0000-\u001f]{0,254}\.gguf$/i;
const CONTAINER_MODEL_DIR = "/probe/model";
const CONTAINER_BIN_DIR = "/probe/bin";

const PYTHON_TIMEOUT_MS = 90_000;
const LLAMA_TIMEOUT_MS = 30_000;
const LLAMA_WEAK_GRACE_MS = 6_000;
const LLAMA_POLL_MS = 500;
const START_TIMEOUT_MS = 30_000;
const GUARD_MS = 5_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_MARKER_BYTES = 512 * 1024;
const MAX_LOG_LINES = 2000;
const EXCERPT_CHARS = 4096;

const VERDICTS = Object.freeze(["supported", "unsupported", "needs-remote-code", "inconclusive"]);
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const DOCKER_UNAVAILABLE = /cannot connect to the docker daemon|error during connect|is the docker daemon running|docker daemon is not running|failed to connect to the docker api|dockerdesktoplinuxengine|docker_engine|error response from daemon: (?:dial|connect)/i;
const IMAGE_MISSING = /unable to find image|no such image|pull access denied|image .* not found/i;
const NO_SUCH_CONTAINER = /no such container/i;
const INVALID_FLAGS = /invalid argument|unknown argument|unrecognized (?:option|argument)|invalid parameter|error: unknown/i;
const ENTRYPOINT_MISSING = /executable file not found|no such file or directory|exec: .*(?:python3|not found)|OCI runtime create failed/i;

const LLAMA_FAILURE = /unknown model architecture|error loading model(?: hyperparameters)?|llama_model_load: error|failed to load model|llama_model_load_from_file_impl: failed|gguf_init_from_file: .*(?:failed|invalid|error)/i;
const LLAMA_STRONG = /load_tensors:.*buffer size|llm_load_tensors:.*buffer size|\bllama_context:|llama_kv_cache|server is listening|main: model loaded|llama_init_from_model/i;
const LLAMA_WEAK = /^(?:\S+\s+)?(?:print_info: arch\s*=|llm_load_print_meta: arch\s*=|load_tensors:|llm_load_tensors:)/m;

class ProbeError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ProbeError";
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function bilingual(zh, en) {
  return { zh, en };
}

function probeName(random = crypto.randomBytes) {
  let output = "";
  let bits = 0;
  let value = 0;
  for (const byte of random(5)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return `ai-probe-${output.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// The container command

function validateHostPath(value, label) {
  const input = text(value);
  if (!input) throw new ProbeError(400, "invalid_probe_path", `${label} is required.`);
  if (/[\u0000-\u001f"]/.test(input)) throw new ProbeError(400, "invalid_probe_path", `${label} contains unsupported characters.`);
  if (!path.win32.isAbsolute(input) && !path.posix.isAbsolute(input)) throw new ProbeError(400, "invalid_probe_path", `${label} must be an absolute path.`);
  // A colon outside the drive letter would end the bind-mount source early.
  if (/:/.test(input.replace(/^[A-Za-z]:(?=[\\/])/, ""))) throw new ProbeError(400, "invalid_probe_path", `${label} contains unsupported characters.`);
  return input.length > 3 ? input.replace(/[\\/]+$/, "") : input;
}

function probeImage(runtime, options) {
  const raw = text(options.image) || text(runtime?.imageId) || text(runtime?.image);
  if (!raw || !IMAGE_PATTERN.test(raw)) throw new ProbeError(400, "invalid_probe_image", "The runtime has no usable image reference.");
  return raw;
}

/**
 * The `docker run` argv (after "docker") of one probe container.
 *
 * runtime: {runtimeId, image, imageId?}. The image that runs is imageId when
 * known (the immutable ID the caller inspected, so a retag cannot change what
 * is probed), else image. allowRemoteCode only adds --trust-remote-code when it
 * is exactly true. The llama shape starts detached and is read through
 * `docker logs`, see runProbe.
 */
function buildProbeCommand(options = {}) {
  const engineId = text(options.engineId);
  if (!ENGINE_ID_PATTERN.test(engineId)) throw new ProbeError(400, "unknown_engine", `Unknown engine: ${engineId || "(none)"}.`);
  const runtime = isPlainObject(options.runtime) ? options.runtime : {};
  const runtimeId = text(runtime.runtimeId || options.runtimeId);
  if (runtimeId && !RUNTIME_ID_PATTERN.test(runtimeId)) throw new ProbeError(400, "invalid_runtime", `Invalid runtime id: ${runtimeId.slice(0, 80)}.`);
  const image = probeImage(runtime, options);
  const name = options.name === undefined ? probeName() : text(options.name);
  if (!NAME_PATTERN.test(name)) throw new ProbeError(400, "invalid_probe_name", "Invalid probe container name.");
  const kind = options.kind === "header" || options.kind === "registry" ? options.kind : (engineId === "llamacpp" ? "header" : "registry");
  const modelDir = validateHostPath(options.modelDir, "modelDir");
  const allowRemoteCode = options.allowRemoteCode === true && kind === "registry";
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.floor(requestedTimeout) : (kind === "header" ? LLAMA_TIMEOUT_MS : PYTHON_TIMEOUT_MS);

  let argv;
  let modelFile = null;
  if (kind === "registry") {
    const scriptsDir = validateHostPath(options.scriptsDir || path.join(__dirname, "probe-scripts"), "scriptsDir");
    argv = [
      "run", "--rm", "--name", name,
      "--pull", "never", "--network", "none", "--read-only",
      "--tmpfs", "/tmp:rw,size=256m",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", "8g", "--pids-limit", "256",
      "--label", PROBE_LABEL,
      "-e", "HF_HUB_OFFLINE=1", "-e", "TRANSFORMERS_OFFLINE=1", "-e", "PYTHONDONTWRITEBYTECODE=1",
      "-e", "HOME=/tmp", "-e", "HF_HOME=/tmp/hf",
      "-v", `${modelDir}:${CONTAINER_MODEL_DIR}:ro`,
      "-v", `${scriptsDir}:${CONTAINER_BIN_DIR}:ro`,
      "--entrypoint", "python3", image,
      "-I", `${CONTAINER_BIN_DIR}/hf_probe.py`, "--model", CONTAINER_MODEL_DIR, "--engine", engineId,
      ...(allowRemoteCode ? ["--trust-remote-code"] : []),
    ];
  } else {
    modelFile = text(options.modelFile);
    if (!MODEL_FILE_PATTERN.test(modelFile)) throw new ProbeError(400, "invalid_model_file", "A llama.cpp probe needs the name of a .gguf file in the model folder.");
    argv = [
      "run", "-d", "--name", name,
      "--pull", "never", "--network", "none", "--read-only",
      "--tmpfs", "/tmp:rw,size=64m",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", "4g", "--pids-limit", "256",
      "--label", PROBE_LABEL,
      "-v", `${modelDir}:${CONTAINER_MODEL_DIR}:ro`,
      image,
      "-m", `${CONTAINER_MODEL_DIR}/${modelFile}`,
      "--ctx-size", "256", "-ngl", "0", "--no-warmup", "--no-repack", "-t", "2",
      "--host", "127.0.0.1", "--port", "18080",
    ];
  }
  return Object.freeze({
    kind, engineId, runtimeId, image, imageId: IMAGE_ID_PATTERN.test(image) ? image.toLowerCase() : null,
    name, timeoutMs, allowRemoteCode, modelFile, argv: Object.freeze(argv),
  });
}

// ---------------------------------------------------------------------------
// Running docker through the manager's exec-style runner: docker(args, options)
// -> Promise<{stdout, stderr, error?}>; with rejectOnError:false it resolves,
// and a runner that rejects instead is accepted as well.

function errorText(error) {
  return [error?.message, error?.stderr].map((item) => String(item || "")).join("\n");
}

function isTimeout(error) {
  return Boolean(error) && (error.killed === true || error.code === "ETIMEDOUT" || error.signal === "SIGTERM");
}

async function execDocker(docker, args, { timeout, guardMs = GUARD_MS } = {}) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ stdout: "", stderr: "", error: Object.assign(new Error("docker call timed out"), { killed: true, code: "ETIMEDOUT" }), timedOut: true }), timeout + guardMs);
    timer.unref?.();
  });
  const call = Promise.resolve()
    .then(() => docker(args, { timeout, rejectOnError: false, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }))
    .then((value) => ({
      stdout: String(value?.stdout ?? ""), stderr: String(value?.stderr ?? ""), error: value?.error || null,
    }), (error) => ({ stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? ""), error }));
  call.catch(() => {});
  try {
    const result = await Promise.race([call, guard]);
    return { ...result, timedOut: result.timedOut === true || isTimeout(result.error) };
  } finally {
    clearTimeout(timer);
  }
}

function dockerUnavailable(result) {
  if (!result.error) return false;
  return result.error.code === "ENOENT" || DOCKER_UNAVAILABLE.test(`${errorText(result.error)}\n${result.stderr}`);
}

/** True when `docker` can reach a daemon (docker info); false otherwise. Never throws. */
async function checkDockerAvailable(docker) {
  if (typeof docker !== "function") return false;
  const result = await execDocker(docker, ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 });
  return !result.error && !result.timedOut;
}

async function removeContainer(docker, name) {
  if (!NAME_PATTERN.test(String(name))) return { removed: false, error: "refused: not a probe container name" };
  const result = await execDocker(docker, ["rm", "-f", name], { timeout: 15_000 });
  const message = `${errorText(result.error)}\n${result.stderr}`;
  const removed = !result.error || NO_SUCH_CONTAINER.test(message);
  return { removed, error: removed ? null : redactSecrets(message).trim().slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Results

function clip(value, max = EXCERPT_CHARS) {
  const redacted = redactSecrets(String(value ?? ""));
  return redacted.length > max ? redacted.slice(-max) : redacted;
}

function rootCauseOf(code, hint, excerpt = "", extra = {}) {
  return {
    code,
    signatureId: extra.signatureId ?? null,
    phase: extra.phase ?? "probe",
    hint,
    logExcerpt: clip(excerpt),
    ...(extra.suggestions ? { suggestions: extra.suggestions } : {}),
  };
}

function classify(logText, engineId) {
  try {
    return classifyFailure(logText, { engineId, phase: "probe" });
  } catch {
    return null;
  }
}

const TIMEOUT_CAUSE = (excerpt) => rootCauseOf("probe_timeout",
  bilingual("预检探针超时，容器已移除；稍后重试或检查磁盘速度。", "The dry probe timed out and its container was removed; retry later or check the disk speed."), excerpt);
const DOCKER_CAUSE = (excerpt) => rootCauseOf("docker_unavailable",
  bilingual("Docker 未运行，无法执行预检探针。请先启动 Docker。", "Docker is not running, so the dry probe cannot run. Start Docker first."), excerpt);

function listOrNull(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 4000) : null;
}

function boolOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value.slice(0, 120) : null;
}

/** The last `@@PROBE@@ <json>` line of a python probe's output -> normalized facts, or null. */
function parseProbeOutput(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const at = line.indexOf(PROBE_MARKER);
    if (at < 0) continue;
    const body = line.slice(at + PROBE_MARKER.length).trim();
    if (!body || body.length > MAX_MARKER_BYTES) return null;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;
    const config = isPlainObject(parsed.config) ? parsed.config : {};
    const plugins = isPlainObject(parsed.plugins) ? parsed.plugins : {};
    return {
      engineVersion: stringOrNull(parsed.engineVersion),
      transformersVersion: stringOrNull(parsed.transformersVersion),
      python: stringOrNull(parsed.python),
      config: {
        ok: config.ok === true,
        modelType: stringOrNull(config.modelType),
        architectures: listOrNull(config.architectures) || [],
        error: typeof config.error === "string" && config.error ? config.error.slice(0, 600) : null,
      },
      archSupported: boolOrNull(parsed.archSupported),
      needsRemoteCode: parsed.needsRemoteCode === true,
      registryArchitectures: listOrNull(parsed.registryArchitectures),
      modelTypes: listOrNull(parsed.modelTypes),
      toolParsers: listOrNull(parsed.toolParsers),
      reasoningParsers: listOrNull(parsed.reasoningParsers),
      quantMethods: listOrNull(parsed.quantMethods),
      kvCacheDtypes: listOrNull(parsed.kvCacheDtypes),
      plugins: { gguf: boolOrNull(plugins.gguf), bnb: boolOrNull(plugins.bnb) },
      errors: (Array.isArray(parsed.errors) ? parsed.errors : []).filter((item) => typeof item === "string").slice(0, 24).map((item) => item.slice(0, 300)),
    };
  }
  return null;
}

/** The registries section of the runtime facts (01 section 17), or null when the image gave no architecture list. */
function registriesSection(facts, now) {
  if (!facts || !Array.isArray(facts.registryArchitectures)) return null;
  return {
    capturedAt: new Date(now()).toISOString(),
    engineVersion: facts.engineVersion,
    transformersVersion: facts.transformersVersion,
    architectures: facts.registryArchitectures,
    modelTypes: facts.modelTypes,
    toolParsers: facts.toolParsers,
    reasoningParsers: facts.reasoningParsers,
    quantMethods: facts.quantMethods,
    kvCacheDtypes: facts.kvCacheDtypes,
    plugins: facts.plugins,
  };
}

// The result keeps the verdict-relevant facts; the registry lists live only in
// the runtime facts (counts here), so a model result stays small.
function resultFacts(facts) {
  const counts = {};
  for (const key of ["registryArchitectures", "modelTypes", "toolParsers", "reasoningParsers", "quantMethods", "kvCacheDtypes"]) {
    counts[key] = Array.isArray(facts[key]) ? facts[key].length : null;
  }
  const matched = facts.config.architectures.find((name) => (facts.registryArchitectures || []).some((item) => item.toLowerCase() === name.toLowerCase())) || null;
  return {
    kind: "registry",
    engineVersion: facts.engineVersion,
    transformersVersion: facts.transformersVersion,
    python: facts.python,
    config: facts.config,
    archSupported: facts.archSupported,
    matchedArchitecture: matched,
    needsRemoteCode: facts.needsRemoteCode,
    transformersKnowsModelType: facts.modelTypes && facts.config.modelType ? facts.modelTypes.includes(facts.config.modelType) : null,
    plugins: facts.plugins,
    registryCounts: counts,
    errors: facts.errors,
  };
}

function pythonVerdict(facts, allowRemoteCode, engineId) {
  const config = facts.config;
  const needsConsent = facts.needsRemoteCode && !allowRemoteCode;
  const consentCause = () => rootCauseOf("trust_remote_code_required",
    bilingual("该模型带有自定义代码，需要在探针中允许 trust_remote_code（会执行模型自带的 Python）。", "This model ships custom code; allow trust_remote_code for the probe (it runs the model's own Python)."),
    config.error || "", { signatureId: "trust-remote-code", phase: "weights", suggestions: [{ kind: "param", param: "trustRemoteCode", to: true, security: true }] });
  if (config.ok) {
    if (facts.archSupported === true) return { verdict: "supported", rootCause: null };
    if (needsConsent) return { verdict: "needs-remote-code", rootCause: consentCause() };
    if (facts.archSupported === false) {
      return {
        verdict: "unsupported",
        rootCause: rootCauseOf("arch_not_in_registry",
          bilingual(`该运行时镜像的模型注册表不含 ${config.architectures.join(", ") || config.modelType || "该架构"}；换用更新的镜像或其他引擎。`,
            `The model registry of this runtime image does not list ${config.architectures.join(", ") || config.modelType || "this architecture"}; use a newer image or another engine.`),
          "", { phase: "weights", suggestions: [{ kind: "runtime", action: "newer-image" }] }),
      };
    }
    return {
      verdict: "inconclusive",
      rootCause: rootCauseOf("registry_unavailable",
        bilingual("没有取得该镜像的模型注册表，无法确认支持情况。", "The image's model registry could not be read, so support cannot be confirmed."), facts.errors.join("\n")),
    };
  }
  if (needsConsent) return { verdict: "needs-remote-code", rootCause: consentCause() };
  if (/config\.json is (?:missing|unreadable|not an object)/.test(config.error || "")) {
    return {
      verdict: "inconclusive",
      rootCause: rootCauseOf("config_missing",
        bilingual("模型目录没有可读的 config.json，Python 探针无法检查它。", "The model folder has no readable config.json, so the Python probe cannot check it."), config.error),
    };
  }
  const hit = classify(config.error || "", engineId);
  const cause = hit && hit.signatureId ? hit : rootCauseOf("config_unsupported",
    bilingual("该镜像中的 Transformers 无法解析此模型的配置。", "Transformers in this image cannot parse the configuration of this model."), config.error || "", { phase: "weights" });
  return { verdict: "unsupported", rootCause: cause };
}

// ---------------------------------------------------------------------------
// llama.cpp header load

function logLines(raw) {
  return String(raw ?? "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, ""))
    .slice(-MAX_LOG_LINES);
}

const HPARAMS = Object.freeze({
  arch: "architecture", n_ctx_train: "nCtxTrain", n_embd: "nEmbd", n_layer: "nLayer", n_head: "nHead",
  n_head_kv: "nHeadKv", n_expert: "nExpert", n_expert_used: "nExpertUsed", "model type": "modelType",
  "model params": "modelParams", "file type": "fileType", "file format": "fileFormat", "vocab type": "vocabType",
});

function analyseLlamaLog(raw) {
  const lines = logLines(raw);
  const joined = lines.join("\n");
  const failed = LLAMA_FAILURE.test(joined);
  const hparams = {};
  for (const line of lines) {
    const match = /^print_info:\s+([A-Za-z_ ]+?)\s*=\s*(.+?)\s*$/.exec(line);
    const key = match && HPARAMS[match[1].trim()];
    if (key && !(key in hparams)) hparams[key] = match[2].slice(0, 80);
  }
  return {
    failed,
    strong: LLAMA_STRONG.test(joined),
    weak: LLAMA_WEAK.test(joined),
    invalidFlags: INVALID_FLAGS.test(joined) && !/print_info:|load_tensors:/.test(joined),
    hparams,
    text: joined,
  };
}

function llamaFacts(analysis) {
  return { kind: "header", hparams: analysis.hparams, markers: { architecture: analysis.weak || analysis.strong, tensors: analysis.strong } };
}

function llamaFailureCause(analysis) {
  const hit = classify(analysis.text, "llamacpp");
  if (hit && hit.signatureId) return hit;
  return rootCauseOf("llama_model_rejected",
    bilingual("llama.cpp 拒绝加载此模型的文件头，换用更新的 llama.cpp 镜像。", "llama.cpp rejected the model header; use a newer llama.cpp image."),
    analysis.text.split("\n").filter((line) => LLAMA_FAILURE.test(line)).slice(-6).join("\n"), { phase: "weights", suggestions: [{ kind: "runtime", action: "newer-image" }] });
}

async function readContainerLog(docker, name) {
  const result = await execDocker(docker, ["logs", "--tail", "1200", name], { timeout: 10_000 });
  return `${result.stdout}\n${result.stderr}`;
}

async function containerExited(docker, name) {
  const result = await execDocker(docker, ["inspect", "--format", "{{.State.Status}}", name], { timeout: 10_000 });
  if (result.error) return NO_SUCH_CONTAINER.test(`${errorText(result.error)}\n${result.stderr}`);
  return /^(exited|dead)$/.test(result.stdout.trim());
}

async function probeLlama(cmd, deps) {
  const { docker, now, sleep, log } = deps;
  const started = await execDocker(docker, cmd.argv, { timeout: START_TIMEOUT_MS });
  const message = `${errorText(started.error)}\n${started.stderr}`;
  if (started.error) {
    if (started.timedOut) return { verdict: "inconclusive", facts: {}, rootCause: TIMEOUT_CAUSE(message), created: true };
    if (dockerUnavailable(started)) return { verdict: "inconclusive", facts: {}, rootCause: DOCKER_CAUSE(message), created: false };
    if (IMAGE_MISSING.test(message)) {
      return { verdict: "inconclusive", facts: {}, created: false, rootCause: rootCauseOf("runtime_image_missing", bilingual("请先拉取镜像 / Pull the image first", "Pull the image first"), message) };
    }
    return { verdict: "inconclusive", facts: {}, created: true, rootCause: rootCauseOf("probe_start_failed", bilingual("预检容器没能启动。", "The probe container could not start."), message) };
  }
  log?.(`probe container ${cmd.name} started (llama.cpp header load)`);
  const begin = now();
  let weakSince = null;
  let analysis = analyseLlamaLog("");
  for (;;) {
    analysis = analyseLlamaLog(await readContainerLog(docker, cmd.name));
    if (analysis.failed) return { verdict: "unsupported", facts: llamaFacts(analysis), rootCause: llamaFailureCause(analysis), created: true };
    if (analysis.strong) return { verdict: "supported", facts: llamaFacts(analysis), rootCause: null, created: true };
    if (analysis.weak && weakSince === null) weakSince = now();
    if (weakSince !== null && now() - weakSince >= (deps.weakGraceMs ?? LLAMA_WEAK_GRACE_MS)) {
      return { verdict: "supported", facts: llamaFacts(analysis), rootCause: null, created: true };
    }
    if (await containerExited(docker, cmd.name)) {
      // One last read: the final lines land after the status flips.
      analysis = analyseLlamaLog(await readContainerLog(docker, cmd.name));
      if (analysis.failed) return { verdict: "unsupported", facts: llamaFacts(analysis), rootCause: llamaFailureCause(analysis), created: true };
      if (analysis.strong || analysis.weak) return { verdict: "supported", facts: llamaFacts(analysis), rootCause: null, created: true };
      if (analysis.invalidFlags) {
        return {
          verdict: "inconclusive", facts: llamaFacts(analysis), created: true,
          rootCause: rootCauseOf("probe_flags_unsupported", bilingual("该 llama.cpp 镜像不认识探针参数，无法做头部加载检查。", "This llama.cpp image does not know the probe flags, so the header load could not run."), analysis.text.split("\n").slice(-12).join("\n")),
        };
      }
      return {
        verdict: "inconclusive", facts: llamaFacts(analysis), created: true,
        rootCause: classify(analysis.text, "llamacpp") || rootCauseOf("probe_exited", bilingual("预检容器在得出结论前退出。", "The probe container exited before reaching a conclusion."), analysis.text.split("\n").slice(-12).join("\n")),
      };
    }
    if (now() - begin >= cmd.timeoutMs) {
      // The architecture line alone already shows the header was accepted.
      if (weakSince !== null) return { verdict: "supported", facts: llamaFacts(analysis), rootCause: null, created: true };
      return { verdict: "inconclusive", facts: llamaFacts(analysis), rootCause: TIMEOUT_CAUSE(analysis.text.split("\n").slice(-12).join("\n")), created: true };
    }
    await sleep(deps.pollMs ?? LLAMA_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Python registry probe

async function probePython(cmd, deps) {
  const { docker, now, log } = deps;
  const run = await execDocker(docker, cmd.argv, { timeout: cmd.timeoutMs, guardMs: deps.guardMs ?? GUARD_MS });
  const combined = `${run.stdout}\n${run.stderr}\n${run.error ? errorText(run.error) : ""}`;
  if (run.timedOut) return { verdict: "inconclusive", facts: {}, rootCause: TIMEOUT_CAUSE(run.stderr), created: true };
  const facts = parseProbeOutput(run.stdout);
  if (!facts) {
    if (dockerUnavailable(run)) return { verdict: "inconclusive", facts: {}, rootCause: DOCKER_CAUSE(combined), created: false };
    if (IMAGE_MISSING.test(combined)) {
      return { verdict: "inconclusive", facts: {}, created: false, rootCause: rootCauseOf("runtime_image_missing", bilingual("请先拉取镜像 / Pull the image first", "Pull the image first"), combined) };
    }
    if (ENTRYPOINT_MISSING.test(combined)) {
      return { verdict: "inconclusive", facts: {}, created: true, rootCause: rootCauseOf("probe_image_unsupported", bilingual("该镜像里没有 python3，无法运行 Python 探针。", "This image has no python3, so the Python probe cannot run."), combined) };
    }
    const hit = classify(run.stderr || combined, cmd.engineId);
    return { verdict: "inconclusive", facts: {}, created: true, rootCause: hit || rootCauseOf("probe_failed", bilingual("探针没有输出结果。", "The probe printed no result."), combined) };
  }
  log?.(`probe ${cmd.name} read ${facts.registryArchitectures ? facts.registryArchitectures.length : "no"} registered architectures`);
  const verdict = pythonVerdict(facts, cmd.allowRemoteCode, cmd.engineId);
  return { ...verdict, facts: resultFacts(facts), registries: registriesSection(facts, now), created: false };
}

async function writeRegistries(cmd, section, deps) {
  const store = deps.runtimeFacts || require("../engines/runtime-facts");
  await store.put(cmd.runtimeId, "registries", section, cmd.imageId ? { imageId: cmd.imageId } : undefined);
}

/**
 * Runs one probe command to a ProbeResult:
 *   {ok, verdict, engineId, runtimeId, kind, facts, rootCause, at, durationMs, container, warnings}
 * ok is true exactly for verdict "supported". deps: docker (required, the
 * manager's exec-style runner), runtimeFacts (default: core.engines.runtimeFacts),
 * log(line), and the test seams now, sleep, pollMs, weakGraceMs, guardMs.
 * Never throws for a probe that could not conclude: that is verdict
 * "inconclusive". The container is always removed.
 */
async function runProbe(cmd, deps = {}) {
  if (typeof deps.docker !== "function") throw new TypeError("runProbe needs a docker runner (args, options) => Promise<{stdout, stderr}>.");
  if (!cmd || !Array.isArray(cmd.argv) || !NAME_PATTERN.test(String(cmd.name))) throw new TypeError("runProbe needs a command built by buildProbeCommand.");
  const context = {
    ...deps,
    now: typeof deps.now === "function" ? deps.now : Date.now,
    sleep: typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const started = context.now();
  const warnings = [];
  let outcome;
  try {
    outcome = cmd.kind === "header" ? await probeLlama(cmd, context) : await probePython(cmd, context);
  } catch (error) {
    outcome = { verdict: "inconclusive", facts: {}, created: true, rootCause: rootCauseOf("probe_failed", bilingual("预检探针出错。", "The dry probe failed."), error?.message || String(error)) };
  }
  // A python probe that ended normally was removed by --rm; every other path
  // (timeout, error, the detached llama container) removes it explicitly.
  const needsRemoval = outcome.created !== false;
  let container = { name: cmd.name, removed: true };
  if (needsRemoval) {
    const removal = await removeContainer(deps.docker, cmd.name);
    container = { name: cmd.name, removed: removal.removed };
    if (!removal.removed) warnings.push({ code: "container_not_removed", message: removal.error || "docker rm -f failed" });
  }
  if (outcome.registries) {
    try {
      await writeRegistries(cmd, outcome.registries, context);
    } catch (error) {
      warnings.push({ code: error?.code || "registries_not_saved", message: String(error?.message || error).slice(0, 200) });
    }
  } else if (cmd.kind === "registry" && outcome.facts?.kind === "registry") {
    warnings.push({ code: "registries_unavailable", message: "The image gave no architecture list; runtime facts were left unchanged." });
  }
  const finished = context.now();
  return {
    ok: outcome.verdict === "supported",
    verdict: VERDICTS.includes(outcome.verdict) ? outcome.verdict : "inconclusive",
    engineId: cmd.engineId,
    runtimeId: cmd.runtimeId,
    kind: cmd.kind,
    facts: outcome.facts || {},
    rootCause: outcome.rootCause || null,
    at: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started),
    container,
    ...(warnings.length ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stored results: <AI_ROOT>/cache/model-probes/<contentDigest12>@<runtimeId>.json

function defaultProbeDir(env = process.env) {
  const root = env.AI_ROOT ? path.resolve(env.AI_ROOT) : path.resolve(__dirname, "..", "..");
  return path.join(root, "cache", "model-probes");
}

function digest12(contentDigest) {
  const hex = text(contentDigest).replace(/^sha256:/, "").toLowerCase();
  if (!/^[a-f0-9]{12,64}$/.test(hex)) throw new ProbeError(400, "invalid_content_digest", "A probe needs the content digest of the model.");
  return hex.slice(0, 12);
}

/** The compatibility.js lookup key: `<contentDigest12>@<runtimeId>`. */
function probeKey(contentDigest, runtimeId) {
  const id = text(runtimeId);
  if (!RUNTIME_ID_PATTERN.test(id)) throw new ProbeError(400, "invalid_runtime", `Invalid runtime id: ${id.slice(0, 80)}.`);
  return `${digest12(contentDigest)}@${id}`;
}

function probeFile(key, dir = defaultProbeDir()) {
  if (!/^[a-f0-9]{12}@[A-Za-z0-9._@-]+$/.test(key)) throw new ProbeError(400, "invalid_probe_key", "Invalid probe key.");
  return path.join(dir, `${key}.json`);
}

/** Atomically writes one result (adds contentDigest and key). Returns the stored file's key. */
async function writeProbeResult(result, { contentDigest, dir = defaultProbeDir() } = {}) {
  const key = probeKey(contentDigest, result.runtimeId);
  const file = probeFile(key, dir);
  const stored = { ...result, contentDigest, key };
  await fsp.mkdir(dir, { recursive: true });
  const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, { flag: "wx" });
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true });
  }
  return key;
}

function validStored(value) {
  return isPlainObject(value) && VERDICTS.includes(value.verdict) && typeof value.runtimeId === "string";
}

async function readProbeResult(contentDigest, runtimeId, { dir = defaultProbeDir() } = {}) {
  try {
    const value = JSON.parse(await fsp.readFile(probeFile(probeKey(contentDigest, runtimeId), dir), "utf8"));
    return validStored(value) ? value : null;
  } catch {
    return null;
  }
}

/** Every stored result (optionally one model's), for evaluateCompatibility({probes}). Corrupt files are skipped. */
async function listProbeResults({ dir = defaultProbeDir(), contentDigest = null } = {}) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const prefix = contentDigest ? `${digest12(contentDigest)}@` : "";
  const results = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || (prefix && !name.startsWith(prefix))) continue;
    try {
      const value = JSON.parse(await fsp.readFile(path.join(dir, name), "utf8"));
      if (validStored(value)) results.push(value);
    } catch {
      // a half-written or corrupt file is not evidence
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// POST /api/models/probe: validation, the job and the background run

const PULL_ACTION = (runtimeId) => ({
  kind: "pull-image",
  label: bilingual("拉取镜像", "Pull image"),
  method: "POST",
  path: `/api/runtimes/${encodeURIComponent(runtimeId)}/pull`,
});

function listGgufFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.gguf$/i.test(entry.name) && !/mmproj/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function modelTarget(target, engineId) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (stat.isFile()) return { modelDir: path.dirname(target), modelFile: path.basename(target) };
  if (!stat.isDirectory()) return null;
  if (engineId !== "llamacpp") return { modelDir: target, modelFile: null };
  const files = listGgufFiles(target);
  return files.length ? { modelDir: target, modelFile: files[0] } : { modelDir: target, modelFile: null };
}

function requestFields(body) {
  const input = isPlainObject(body) ? body : {};
  const model = isPlainObject(input.model) ? text(input.model.ref) : text(input.model);
  const engineId = text(input.engineId);
  const runtimeId = text(input.runtimeId);
  const errors = [];
  if (!model) errors.push({ field: "model", code: "required", message: "model is required." });
  if (!ENGINE_ID_PATTERN.test(engineId)) errors.push({ field: "engineId", code: engineId ? "invalid" : "required", message: "engineId is required." });
  if (input.allowRemoteCode !== undefined && typeof input.allowRemoteCode !== "boolean") errors.push({ field: "allowRemoteCode", code: "invalid", message: "allowRemoteCode must be true or false." });
  return { model, engineId, runtimeId, allowRemoteCode: input.allowRemoteCode === true, errors };
}

/**
 * Validates a probe request, creates the `model-probe` job and starts the run.
 * Throws ProbeError (400 unknown_engine / engine_not_hosted / invalid_request,
 * 404 model_not_found / unknown_runtime, 409 probe_running /
 * runtime_image_missing (with the Pull action), 422 not_a_model, 503
 * docker_unavailable / probe_unavailable) before any job exists. Returns
 * {job, done}: done resolves to the stored ProbeResult once the job is
 * finished and never rejects.
 *
 * context: {managerId, registry, docker, jobs:{createJob, appendLog, finishJob,
 * failJob}, resolveModelPath, inspect?, runtimeFacts?, probeDir?, inFlight (Map),
 * now?, sleep?, scriptsDir?, pollMs?, ...runProbe seams}.
 */
async function startProbeJob(body, context) {
  const fields = requestFields(body);
  if (fields.errors.length) throw new ProbeError(400, "invalid_request", "The probe request is incomplete.", { errors: fields.errors });
  const { registry, docker, jobs } = context;
  if (!registry || typeof docker !== "function" || !jobs || ["createJob", "appendLog", "finishJob", "failJob"].some((name) => typeof jobs[name] !== "function")) {
    throw new ProbeError(503, "probe_unavailable", "The dry probe is not available on this manager.");
  }
  let descriptor;
  try {
    descriptor = registry.require(fields.engineId);
  } catch (error) {
    throw new ProbeError(400, "unknown_engine", `Unknown engine: ${fields.engineId}.`);
  }
  if (typeof registry.hostedBy === "function" && !registry.hostedBy(context.managerId).includes(descriptor.id)) {
    throw new ProbeError(400, "engine_not_hosted", `Engine ${descriptor.id} is not hosted by this manager.`, { hint: "Send the probe to the manager that hosts the engine." });
  }
  let runtime;
  try {
    runtime = registry.resolveRuntime(descriptor.id, fields.runtimeId ? { runtimeId: fields.runtimeId } : {});
  } catch (error) {
    throw new ProbeError(error.status === 404 ? 404 : 400, error.code || "unknown_runtime", error.message || "Unknown runtime.");
  }

  // The model: a local folder or .gguf file in this manager's storage.
  const resolve = typeof context.resolveModelPath === "function" ? context.resolveModelPath : null;
  const target = resolve ? await resolve(fields.model) : null;
  if (!target) throw new ProbeError(404, "model_not_found", "The model is not on this manager's disk.", { hint: "Download or select a local model folder first; the probe never fetches files." });
  const located = modelTarget(String(target), descriptor.id);
  if (!located) throw new ProbeError(404, "model_not_found", "The model path is neither a folder nor a file.");
  if (descriptor.id === "llamacpp" && !located.modelFile) throw new ProbeError(422, "not_a_model", "No .gguf file was found for the llama.cpp probe.");
  const inspect = typeof context.inspect === "function" ? context.inspect : require("./inspect").inspectLocal;
  let card = null;
  try {
    card = await inspect(String(target), { depth: "full" });
  } catch {
    card = null;
  }
  if (!card || !card.contentDigest) throw new ProbeError(422, "not_a_model", "The model could not be identified.");

  if (!await checkDockerAvailable(docker)) throw new ProbeError(503, "docker_unavailable", "Docker is not running.", { hint: "Start Docker, then run the probe again." });
  const runtimeFacts = context.runtimeFacts || require("../engines/runtime-facts");
  const imageId = await runtimeFacts.imageId(runtime.image, { force: true });
  if (!imageId) {
    throw new ProbeError(409, "runtime_image_missing", "请先拉取镜像 / Pull the image first", {
      hint: "Pull the runtime image, then run the probe again. Nothing is pulled implicitly.",
      runtimeId: runtime.runtimeId,
      action: PULL_ACTION(runtime.runtimeId),
    });
  }

  const key = probeKey(card.contentDigest, runtime.runtimeId);
  const inFlight = context.inFlight instanceof Map ? context.inFlight : new Map();
  if (inFlight.has(key)) throw new ProbeError(409, "probe_running", "A probe of this model on this runtime is already running.", { jobId: inFlight.get(key) });

  const cmd = buildProbeCommand({
    engineId: descriptor.id,
    runtime: { runtimeId: runtime.runtimeId, image: runtime.image, imageId },
    modelDir: located.modelDir,
    modelFile: located.modelFile,
    allowRemoteCode: fields.allowRemoteCode,
    scriptsDir: context.scriptsDir,
    name: context.containerName,
    timeoutMs: context.timeoutMs,
  });
  const job = jobs.createJob(PROBE_JOB_TYPE, `预检探针 / Dry probe ${runtime.runtimeId}`, {
    engineId: descriptor.id,
    runtimeId: runtime.runtimeId,
    model: fields.model,
    cardId: card.cardId || null,
    contentDigest: card.contentDigest,
    probeKey: key,
    allowRemoteCode: cmd.allowRemoteCode,
  });
  inFlight.set(key, job.id);
  const done = executeProbeJob({ cmd, job, key, card, fields }, context).finally(() => {
    if (inFlight.get(key) === job.id) inFlight.delete(key);
  });
  return { job, done, key };
}

async function executeProbeJob({ cmd, job, key, card }, context) {
  const { jobs } = context;
  const log = (line) => { try { jobs.appendLog(job, `${line}\n`); } catch { /* the ledger is best effort */ } };
  try {
    log(`Dry probe ${cmd.kind} on ${cmd.runtimeId} (no GPU, no network, read-only model mount)`);
    if (cmd.allowRemoteCode) log("Remote code is allowed for this probe (explicit consent).");
    const result = await runProbe(cmd, { ...context, docker: context.docker, log });
    result.contentDigest = card.contentDigest;
    result.cardId = card.cardId || null;
    result.key = key;
    const dir = context.probeDir || defaultProbeDir();
    // An inconclusive result never replaces an earlier conclusive one.
    if (result.verdict !== "inconclusive" || !await readProbeResult(card.contentDigest, cmd.runtimeId, { dir })) {
      await writeProbeResult(result, { contentDigest: card.contentDigest, dir });
    }
    log(`Verdict: ${result.verdict}${result.rootCause ? ` (${result.rootCause.code})` : ""}, ${result.durationMs} ms`);
    const summary = { verdict: result.verdict, ok: result.ok, probeKey: key, durationMs: result.durationMs, rootCause: result.rootCause, containerRemoved: result.container.removed };
    if (result.rootCause) job.failure = result.rootCause;
    if (result.verdict === "inconclusive") {
      job.meta = { ...(job.meta || {}), ...summary };
      jobs.failJob(job, new Error(`inconclusive: ${result.rootCause?.code || "probe_failed"}`));
    } else {
      jobs.finishJob(job, summary);
    }
    return result;
  } catch (error) {
    try {
      job.meta = { ...(job.meta || {}), verdict: "inconclusive" };
      jobs.failJob(job, error);
    } catch { /* already finished */ }
    return null;
  }
}

module.exports = {
  CONTAINER_BIN_DIR,
  CONTAINER_MODEL_DIR,
  LLAMA_TIMEOUT_MS,
  PROBE_JOB_TYPE,
  PROBE_LABEL,
  PROBE_MARKER,
  PYTHON_TIMEOUT_MS,
  ProbeError,
  VERDICTS,
  analyseLlamaLog,
  buildProbeCommand,
  checkDockerAvailable,
  defaultProbeDir,
  listProbeResults,
  parseProbeOutput,
  probeFile,
  probeKey,
  probeName,
  readProbeResult,
  registriesSection,
  runProbe,
  startProbeJob,
  writeProbeResult,
};
