"use strict";

// runtime-supervisor (01 §14): the one start pipeline both managers run.
//
//   preflight → plan → image → admission (+checkpoint in replace) → re-plan
//   → create → waitReady → probe → commit
//
// Every stage maps to an instance lifecycle phase (00 §4.1), job progress
// gains the additive fields phase, stageKey and stageText{zh,en}, and the job
// gains lifecycle:{phase, phaseHistory} (00 §9.17). Nothing that existed
// changes: the zh `stage` strings the legacy UIs translate stay byte for byte.
//
// A failed job keeps its legacy `error` string and gains
// job.failure = {code, signatureId, phase, hint, logExcerpt} (00 §9.11); the
// excerpt is the last 40 log lines, at most 4 KiB, redacted. signatureId and
// hint come from hooks.classifyFailure (02 MOD-12 wires the matcher), null
// until then.
//
// The pipeline runs serially per queue key: replace shares one key, parallel
// and add key on the container name. Mode `add` never touches a running
// container: an occupied slot fails with instance_conflict (or finishes as
// skipped with onConflict "skip") and there is no checkpoint.
//
// Progress and the final state go out on the manager's own event hub as
// `jobs` deltas ({managerId, jobs:[summary], full:false}) and container
// changes as `instances` ({managerId, changed, removed}); the entry relays
// both (00 §9.6). The legacy UIs only read the array-shaped `jobs` snapshot,
// so these objects pass them by.
//
// The supervisor is host-neutral: everything Docker-specific is the host's
// (hosts/docker.js) and everything engine-specific is the run context's.
// start({ job, run, source }) takes a resolved launch; run:
//   options          the legacy run options (LaunchStore.beginLaunch input)
//   mode             "replace" | "parallel" | "add" (default options.instanceMode)
//   onConflict       "fail" | "skip" (mode add)
//   containerName, instanceId (the /api/instances id; default the name),
//   port, gpuIds, warnings[]
//   engineId, engineName, apiLabel
//   buildCommand(job) → { runArgs, publish, image, secretEnv }; called again
//                      after admission when the admitted GPUs changed it
//   redactArgs(argv) → redacted argv for job.meta.launchCommand and the log
//   lanFallback, bindRetryPublish(error, publish)
//   imagePolicy      "auto" (default) | "explicit"; onMissingImage({image, status})
//   prepareAdmission(prepare) → checkpoint   caller-owned replace admission
//   admissionRequest, lease                  supervisor-owned admission
//   apiKeyRef, cleanup "supervisor" (default) | "caller"
//   wait: { apiKey, serviceUrl, loadingDetail, noLogIssue, extractLogIssues,
//           fetchServedModels, getContainerStatus, probe, startMs, stallMs,
//           readyProbeMs, probeRequestMs, timeoutBudgetLog }
//   plan, paramsKey, runtimeId, contentDigest   (afterReady context)

const { summarizeJob } = require("../job-routes");
const runtimeManifest = require("../runtime-manifest");
const { waitForRuntimeReady } = require("../runtime-wait");
const { createProgressInferer, extractLogFacts, mergeLogFacts } = require("./log-phases");
const { probeOpenAiGeneration } = require("../runtime-request-utils");
const { redactSecrets } = require("../secret-redactor");

const LIFECYCLE_PHASES = Object.freeze(["pull", "admission", "container", "weights", "kv", "graphs", "api", "probe", "ready"]);
const GATE_POLICIES = Object.freeze(["enforce", "warn"]);
const INSTANCE_MODES = Object.freeze(["replace", "parallel", "add"]);

// Stage key → lifecycle phase, progress band and the bilingual stage text.
const STAGES = Object.freeze({
  queued: Object.freeze({ phase: "pull", percent: 1, zh: "等待前一个启动任务", en: "Waiting for the previous launch" }),
  preflight: Object.freeze({ phase: "pull", percent: 2, zh: "启动前预检", en: "Preflight checks" }),
  plan: Object.freeze({ phase: "pull", percent: 8, zh: "生成启动命令", en: "Building the launch command" }),
  image: Object.freeze({ phase: "pull", percent: 8, zh: "检查运行时镜像", en: "Checking the runtime image" }),
  admission: Object.freeze({ phase: "admission", percent: 18, zh: "显存准入与回滚切换点", en: "VRAM admission and rollback checkpoint" }),
  replan: Object.freeze({ phase: "admission", percent: 30, zh: "按准入结果重建命令", en: "Rebuilding the command for the admitted GPUs" }),
  create: Object.freeze({ phase: "container", percent: 32, zh: "启动 Docker 容器", en: "Starting the container" }),
  waitReady: Object.freeze({ phase: "weights", percent: 45, zh: "等待模型加载", en: "Waiting for the model to load" }),
  probe: Object.freeze({ phase: "probe", percent: 96, zh: "生成自检", en: "Generation self-check" }),
  commit: Object.freeze({ phase: "ready", percent: 100, zh: "服务已就绪", en: "Ready" }),
});

// The failure code of a stage when the error carries none of its own.
const STAGE_FAILURE_CODES = Object.freeze({
  queued: "start_cancelled",
  preflight: "preflight_failed",
  plan: "plan_failed",
  image: "image_pull_failed",
  admission: "admission_failed",
  replan: "runtime_incompatible",
  create: "container_create_failed",
  waitReady: "ready_timeout",
  probe: "probe_failed",
  commit: "commit_failed",
});

const FACT_LOG_LINES = 2000;
const LOG_EXCERPT_LINES = 40;
const LOG_EXCERPT_BYTES = 4096;
const APIKEY_REF_LABEL = "ai.manager.api-key-ref";
const LEASE_LABEL = "ai.manager.gpu-admission-lease";
const RUNTIME_ID_LABEL = "ai.manager.runtime-id";
const DEFAULT_AFTER_READY_MS = 30000;

const DEFAULT_TEXTS = Object.freeze({
  queuedLog: "已有启动任务进行中，排队等待其完成后再启动，避免容器名冲突。",
  queuedDetail: "已有启动任务正在进行，排队等待其完成后再启动，避免容器名冲突。",
  prepareStage: "准备启动",
  prepareDetail: (run) => `正在准备 ${run.engineName} 启动任务。`,
  dockerCheckStage: "检查 Docker",
  dockerCheckDetail: "启动模型前先确认 Docker daemon 已经可用。",
  preflightStage: "启动前预检",
  preflightDetail: "正在校验端口、模型并生成完整 Docker 命令；此阶段不会停止当前模型。",
  checkpointStage: "创建可回滚切换点",
  createStage: "启动 Docker 容器",
  createDetail: "Docker run 已开始；旧模型容器已保留为回滚点。",
  createDetailAdd: "Docker run 已开始；新增实例不会停止任何现有容器。",
  loadingStage: "等待模型加载",
  loadingDetail: (run) => `容器已创建，正在等待 ${run.engineName} 返回 /v1/models。`,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function supervisorError(code, message, status, extra = {}) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  Object.assign(error, extra);
  return error;
}

/** `--label key=value` pairs of a docker argv → { key: value }. */
function labelsFromArgs(argv = []) {
  const labels = {};
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let index = 0; index < list.length; index += 1) {
    let value = null;
    if (list[index] === "--label" || list[index] === "-l") value = list[index + 1];
    else if (list[index].startsWith("--label=")) value = list[index].slice("--label=".length);
    if (typeof value !== "string") continue;
    const at = value.indexOf("=");
    if (at > 0) labels[value.slice(0, at)] = value.slice(at + 1);
  }
  return labels;
}

/** Host port of the first published mapping in a `docker ps` Ports text, or null. */
function publishedPortOf(portsText) {
  const match = String(portsText || "").match(/(?:^|[\s,])(?:\[[^\]]*\]|[0-9.]+)?:?(\d+)->\d+/);
  return match ? Number(match[1]) : null;
}

/** The last `lines` lines of text, at most `bytes` UTF-8 bytes, cut at a line start when possible. */
function tailExcerpt(text, { lines = LOG_EXCERPT_LINES, bytes = LOG_EXCERPT_BYTES } = {}) {
  const kept = String(text || "").split(/\r?\n/).filter((line) => line.trim()).slice(-lines);
  let excerpt = kept.join("\n");
  while (Buffer.byteLength(excerpt, "utf8") > bytes) {
    const cut = excerpt.indexOf("\n");
    if (cut >= 0) {
      excerpt = excerpt.slice(cut + 1);
      continue;
    }
    // One oversized line: keep its tail, dropping a split surrogate pair.
    const buffer = Buffer.from(excerpt, "utf8");
    excerpt = buffer.subarray(buffer.length - bytes).toString("utf8").replace(/^�+/, "");
  }
  return excerpt;
}

/** snake_case failure code for an error, or null when it carries none. */
function errorCodeOf(error) {
  const code = textOf(error?.code);
  if (!code) return null;
  if (code === "START_CANCELLED") return "start_cancelled";
  if (/^[a-z][a-z0-9_]*$/.test(code)) return code;
  if (/^[A-Z][A-Z0-9_]*$/.test(code)) return code.toLowerCase();
  return null;
}

// What runtime-wait's plain errors mean (its messages are a stable contract
// of runtime-wait.test.js).
function waitFailureCode(error) {
  const message = String(error?.message || "");
  if (/generation probe/i.test(message)) return { code: "probe_failed", stage: "probe" };
  if (/stalled/i.test(message)) return { code: "stalled", stage: "waitReady" };
  if (/exited before|disappeared before/i.test(message)) return { code: "container_exited", stage: "waitReady" };
  return { code: "ready_timeout", stage: "waitReady" };
}

// runtime-wait's zh stage → the lifecycle phase it is evidence of. Stages it
// does not know (warnings, failures) keep the phase in force.
function waitPhaseOf(stage) {
  const text = String(stage || "");
  if (/生成自检/.test(text)) return "probe";
  if (/启动收尾/.test(text)) return "api";
  if (/CUDA graphs?/i.test(text)) return "graphs";
  if (/KV/i.test(text)) return "kv";
  if (/加载权重|等待模型加载/.test(text)) return "weights";
  return null;
}

// ---- Runtime gate (generalised from vllm-manager runtime-compatibility.js) --

function compareVersions(left, right) {
  const parts = (value) => {
    const match = String(value || "").match(/\d+(?:\.\d+)*/);
    return match ? match[0].split(".").map(Number) : [];
  };
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function normalizeArchitecture(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["x64", "x86_64", "amd64"].includes(normalized)) return "amd64";
  if (["aarch64", "arm64"].includes(normalized)) return "arm64";
  return normalized;
}

function parseNvidiaCompatibilityCsv(stdout) {
  const gpus = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [index, name, computeCapability, driverVersion] = line.split(",").map((part) => String(part || "").trim());
    return { index: Number(index), id: String(index || "").trim(), name, computeCapability, driverVersion };
  }).filter((gpu) => Number.isInteger(gpu.index) && gpu.index >= 0);
  if (!gpus.length) return { ok: false, gpus: [], error: "nvidia-smi did not report an NVIDIA GPU." };
  return { ok: true, gpus, driverVersion: gpus[0].driverVersion, error: "" };
}

/** nvidia-smi compute capability and driver per GPU → { ok, gpus, driverVersion, error }. */
async function probeNvidiaCompatibility(execFileAsync) {
  if (typeof execFileAsync !== "function") return { ok: false, gpus: [], error: "nvidia-smi execution is not configured." };
  try {
    const result = await execFileAsync("nvidia-smi", [
      "--query-gpu=index,name,compute_cap,driver_version",
      "--format=csv,noheader,nounits",
    ]);
    return parseNvidiaCompatibilityCsv(result.stdout);
  } catch (error) {
    return { ok: false, gpus: [], error: error.message || "nvidia-smi compatibility query failed." };
  }
}

/**
 * The runtime gate (01 §14 stage 1): the selected GPUs against the runtime's
 * manifest release (minimumComputeCapability, minimumBlackwellCudaVersion,
 * minimumDriverVersions, platform). → { ok, status, findings, gpus, summary }.
 * Whether a failure blocks is the caller's policy (enforce | warn).
 */
function assessRuntimeGate(options = {}) {
  const probe = options.probe || {};
  const release = isPlainObject(options.release) ? options.release : null;
  const imageReference = textOf(options.imageReference);
  const engineLabel = textOf(options.engineLabel) || "The runtime";
  const hostPlatform = textOf(options.hostPlatform) || process.platform;
  const hostArch = normalizeArchitecture(options.hostArch || process.arch);
  const requested = Array.from(new Set((Array.isArray(options.selectedGpuIds) ? options.selectedGpuIds : [])
    .map((id) => textOf(id)).filter(Boolean)));
  const findings = [];
  const finding = (severity, title, detail) => findings.push({ severity, title, detail });
  const finalize = (gpus) => {
    const failures = findings.filter((item) => item.severity === "fail");
    const warnings = findings.filter((item) => item.severity === "warn");
    const gpuSummary = gpus.map((gpu) => `${gpu.name || `GPU ${gpu.index}`} (SM ${gpu.computeCapability || "?"}, driver ${gpu.driverVersion || "?"})`).join("; ");
    return {
      ok: failures.length === 0,
      status: failures.length ? "fail" : warnings.length ? "warn" : "ok",
      imageReference,
      release,
      gpus,
      findings,
      summary: `${release ? `${release.version || "known build"}` : "custom image metadata unknown"}; ${gpuSummary || "no compatible GPU"}`,
    };
  };

  if (!probe.ok || !Array.isArray(probe.gpus) || !probe.gpus.length) {
    finding("fail", "NVIDIA GPU probe", probe.error || `${engineLabel} requires an NVIDIA GPU, but none was detected.`);
    return finalize([]);
  }
  const selected = requested.length
    ? probe.gpus.filter((gpu) => requested.includes(String(gpu.id ?? gpu.index)))
    : probe.gpus;
  const missing = requested.filter((id) => !probe.gpus.some((gpu) => String(gpu.id ?? gpu.index) === id));
  if (missing.length) finding("fail", "GPU selection", `Selected GPU ${missing.join(", ")} is not reported by nvidia-smi.`);
  if (!selected.length) {
    finding("fail", "GPU selection", "No selected NVIDIA GPU remains after compatibility filtering.");
    return finalize(selected);
  }
  if (!release) {
    finding("warn", "Image metadata", `${imageReference || "The configured image"} is not in the runtime manifest; its CUDA and driver requirements cannot be verified automatically.`);
    return finalize(selected);
  }

  const minimumCompute = Number(release.minimumComputeCapability);
  if (Number.isFinite(minimumCompute) && minimumCompute > 0) {
    for (const gpu of selected) {
      const capability = Number(gpu.computeCapability);
      if (!Number.isFinite(capability)) {
        finding("warn", `GPU ${gpu.index} compute capability`, `${gpu.name || "NVIDIA GPU"} did not report compute capability; runtime support cannot be fully verified.`);
      } else if (capability < minimumCompute) {
        finding("fail", `GPU ${gpu.index} compute capability`, `${gpu.name || "NVIDIA GPU"} is SM ${gpu.computeCapability}; ${engineLabel} requires SM ${minimumCompute.toFixed(1)} or newer.`);
      } else {
        finding("ok", `GPU ${gpu.index} compute capability`, `${gpu.name || "NVIDIA GPU"} reports SM ${gpu.computeCapability}.`);
      }
    }
  }

  const imageArch = normalizeArchitecture(String(release.platform || "").split("/").at(-1));
  if (imageArch && hostArch && imageArch !== hostArch) {
    finding("fail", "Container architecture", `Image platform ${release.platform} does not match host architecture ${hostArch}.`);
  } else if (release.platform) {
    finding("ok", "Container architecture", `${release.platform} matches this host.`);
  }

  const blackwellMinimumCuda = textOf(release.minimumBlackwellCudaVersion);
  const blackwell = selected.filter((gpu) => Number(gpu.computeCapability) >= 10);
  if (blackwellMinimumCuda && blackwell.length) {
    const cudaVersion = textOf(release.cudaVersion);
    if (compareVersions(cudaVersion, blackwellMinimumCuda) < 0) {
      finding("fail", "Blackwell CUDA runtime", `SM ${blackwell.map((gpu) => gpu.computeCapability).join(", ")} requires CUDA ${blackwellMinimumCuda} or newer; the image declares CUDA ${cudaVersion || "unknown"}.`);
    } else {
      finding("ok", "Blackwell CUDA runtime", `CUDA ${cudaVersion} supports the selected Blackwell GPU(s).`);
    }
  }

  const requiredDriver = textOf(release.minimumDriverVersions?.[hostPlatform] || release.minimumDriverVersions?.linux);
  const driverVersions = Array.from(new Set(selected.map((gpu) => textOf(gpu.driverVersion || probe.driverVersion)).filter(Boolean)));
  if (!driverVersions.length) {
    finding("warn", "NVIDIA driver", "Driver version was not reported; CUDA runtime compatibility cannot be fully verified.");
  } else if (requiredDriver) {
    const unsupported = driverVersions.filter((version) => compareVersions(version, requiredDriver) < 0);
    if (unsupported.length) {
      finding("fail", "NVIDIA driver", `${engineLabel} requires driver ${requiredDriver} or newer on ${hostPlatform}; detected ${unsupported.join(", ")}.`);
    } else {
      finding("ok", "NVIDIA driver", `Driver ${driverVersions.join(", ")} satisfies the minimum (${requiredDriver}).`);
    }
  }
  return finalize(selected);
}

// ---- The supervisor ---------------------------------------------------------

function createRuntimeSupervisor(options = {}) {
  const managerId = textOf(options.managerId);
  if (!managerId) throw new TypeError("createRuntimeSupervisor needs a managerId.");
  const host = options.host || options.hosts?.docker;
  if (!host || typeof host.create !== "function") throw new TypeError("createRuntimeSupervisor needs a RuntimeHost.");
  const jobs = options.jobs || {};
  for (const name of ["appendLog", "setJobProgress", "finishJob"]) {
    if (typeof jobs[name] !== "function") throw new TypeError(`createRuntimeSupervisor needs jobs.${name}.`);
  }
  const runtimeGatePolicy = options.runtimeGatePolicy === undefined ? "enforce" : options.runtimeGatePolicy;
  if (!GATE_POLICIES.includes(runtimeGatePolicy)) throw new TypeError(`Unknown runtime gate policy: ${String(runtimeGatePolicy)}.`);
  const probes = options.probes || {};
  const hooks = options.hooks || {};
  const timeouts = options.timeouts || {};
  const texts = { ...DEFAULT_TEXTS, ...(options.texts || {}) };
  const launchStore = options.launchStore || null;
  // The engine registry whose descriptors carry logPhases and logFacts (01 §16.2).
  const registry = options.registry || null;
  const events = options.events || null;
  const secrets = options.secrets || null;
  const admission = options.admission || null;
  const redactor = options.redactor || null;
  const wait = options.waitForRuntimeReady || waitForRuntimeReady;
  const probeGeneration = options.probeGeneration || probeOpenAiGeneration;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const delayFn = options.delay || delay;
  const now = options.now || Date.now;
  const runtimeForImage = options.runtimeForImage || runtimeManifest.runtimeForImage;
  const publishedPort = options.publishedPort || publishedPortOf;
  const apiKeyRefLabel = options.apiKeyRefLabel || APIKEY_REF_LABEL;
  const leaseLabel = options.leaseLabel || LEASE_LABEL;
  const queues = new Map();
  // The last emitted fingerprint per job, so an unchanged progress tick is not re-sent.
  const emitted = new Map();

  const config = Object.freeze({
    managerId,
    ownerLabelValue: textOf(options.ownerLabelValue) || managerId,
    containerBaseName: textOf(options.containerBaseName),
    hostKind: host.kind || "docker",
    runtimeGatePolicy,
    getters: Object.freeze({
      containerStatus: options.getters?.containerStatus || null,
      servedModels: options.getters?.servedModels || null,
    }),
  });

  function log(job, text) {
    jobs.appendLog(job, text);
  }

  function safe(label, action) {
    try {
      return action();
    } catch (error) {
      console.warn(`[runtime-supervisor] ${label}: ${error.message}`);
      return null;
    }
  }

  function redact(text, extraSecrets = []) {
    let value = String(text || "");
    if (redactor && typeof redactor.redact === "function") value = redactor.redact(value);
    else if (typeof redactor === "function") value = redactor(value);
    return redactSecrets(value, { secrets: extraSecrets.filter(Boolean) });
  }

  // ---- events ----

  function emit(event, data) {
    if (!events || typeof events.broadcast !== "function") return;
    try {
      events.broadcast(event, data);
    } catch {
      // A broken hub never fails a launch.
    }
  }

  function emitJob(job, { force = false } = {}) {
    if (!job) return;
    const progress = job.progress || {};
    const fingerprint = [job.status, progress.stage, progress.state, progress.phase, Math.floor(Number(progress.percent) || 0)].join("|");
    if (!force && emitted.get(job.id) === fingerprint) return;
    emitted.set(job.id, fingerprint);
    if (!["running", "queued"].includes(job.status)) emitted.delete(job.id);
    emit("jobs", { managerId, jobs: [summarizeJob(job)], full: false });
  }

  function emitInstances({ changed = [], removed = [] } = {}) {
    const list = (values) => Array.from(new Set((Array.isArray(values) ? values : [values]).map(textOf).filter(Boolean)));
    emit("instances", { managerId, changed: list(changed), removed: list(removed) });
  }

  // ---- lifecycle and progress ----

  function enterPhase(job, phase) {
    if (!LIFECYCLE_PHASES.includes(phase)) return;
    const lifecycle = isPlainObject(job.lifecycle) ? job.lifecycle : { phase: null, phaseHistory: [] };
    if (!Array.isArray(lifecycle.phaseHistory)) lifecycle.phaseHistory = [];
    if (lifecycle.phase === phase) {
      job.lifecycle = lifecycle;
      return;
    }
    const at = now();
    closePhase(lifecycle, at);
    lifecycle.phase = phase;
    lifecycle.phaseHistory.push({ phase, at: new Date(at).toISOString(), durationMs: null });
    job.lifecycle = lifecycle;
  }

  function closePhase(lifecycle, at = now()) {
    const open = lifecycle?.phaseHistory?.at(-1);
    if (open && open.durationMs === null) open.durationMs = Math.max(0, at - Date.parse(open.at));
  }

  function progress(job, stageKey, patch = {}, { phase } = {}) {
    const stage = STAGES[stageKey];
    enterPhase(job, phase || stage.phase);
    jobs.setJobProgress(job, {
      ...patch,
      phase: job.lifecycle?.phase || stage.phase,
      stageKey,
      stageText: { zh: stage.zh, en: stage.en },
    });
    emitJob(job);
  }

  function defaultAssertActive(job) {
    if (job?.status === "running" && !job?.meta?.cancelRequested) return;
    throw supervisorError("START_CANCELLED", "启动任务已被取消，停止后续容器操作。");
  }

  function assertActive(job) {
    (typeof jobs.assertActive === "function" ? jobs.assertActive : defaultAssertActive)(job);
  }

  function saveSoon() {
    if (typeof jobs.scheduleJobsSave === "function") jobs.scheduleJobsSave(0);
  }

  // ---- failure ----

  async function buildFailure(job, error, state) {
    const waitStage = ["waitReady", "probe"].includes(state.stageKey) ? waitFailureCode(error) : null;
    const stageKey = waitStage?.stage || state.stageKey;
    const code = errorCodeOf(error) || waitStage?.code || STAGE_FAILURE_CODES[stageKey] || "start_failed";
    if (waitStage?.stage === "probe") enterPhase(job, "probe");
    const phase = job.lifecycle?.phase || STAGES[stageKey]?.phase || null;
    let logText = textOf(job.meta?.runtimeDiagnostics?.lastLogTail);
    if (!logText && state.containerCreated && typeof host.logs === "function") {
      logText = await host.logs(state.containerName, { tail: LOG_EXCERPT_LINES }).catch(() => "");
    }
    if (!textOf(logText)) logText = (Array.isArray(job.logs) ? job.logs : []).join("\n");
    const logExcerpt = tailExcerpt(redact(logText, state.secretValues));
    let classified = null;
    if (typeof hooks.classifyFailure === "function") {
      try {
        classified = await hooks.classifyFailure(logExcerpt, { engineId: state.engineId, phase, code, error: redact(error?.message, state.secretValues) });
      } catch (classifyError) {
        log(job, `Failure classification skipped: ${classifyError.message}`);
      }
    }
    const hint = isPlainObject(classified?.hint)
      ? { zh: textOf(classified.hint.zh) || null, en: textOf(classified.hint.en) || null }
      : null;
    return {
      code: textOf(classified?.code) || code,
      signatureId: textOf(classified?.signatureId) || null,
      phase,
      hint,
      logExcerpt,
    };
  }

  // ---- stages ----

  async function preflight(job, run, state) {
    state.stageKey = "preflight";
    progress(job, "preflight", { percent: 3, stage: texts.prepareStage, detail: texts.prepareDetail(run) });

    const managed = typeof host.list === "function"
      ? await host.list({ ownerLabelValue: "" }).catch(() => [])
      : [];
    const target = textOf(run.containerName).toLowerCase();
    const portConflict = managed.find((container) => (
      publishedPort(container.ports) === run.port && textOf(container.name).toLowerCase() !== target
    ));
    if (portConflict) {
      throw supervisorError("port_in_use", `端口 ${run.port} 已被托管容器 ${portConflict.name} 占用；并行实例必须使用独立端口。`, 409);
    }

    progress(job, "preflight", { percent: 4, stage: texts.dockerCheckStage, detail: texts.dockerCheckDetail });
    const runtimeName = textOf(host.config?.runtimeName) || "Docker";
    let ready = await host.ready({ autoStart: false });
    if (!ready.ok) {
      log(job, ready.raw || ready.detail);
      progress(job, "preflight", {
        percent: 4,
        stage: `启动 ${runtimeName}`,
        detail: `Docker daemon 未就绪，正在自动启动 ${runtimeName} 并等待引擎可用。`,
      });
      log(job, `Docker daemon is not ready; requesting ${runtimeName} startup.`);
      ready = await host.ready({ autoStart: true, timeoutMs: 120000 });
    }
    if (!ready.ok) {
      log(job, ready.raw || ready.detail);
      progress(job, "preflight", { percent: 4, stage: "Docker 未就绪", detail: ready.detail, state: "fail", issues: [ready.detail] });
      throw supervisorError("docker_unavailable", ready.detail || "Docker daemon is not ready.", 503);
    }
    log(job, ready.started ? `${runtimeName} started; daemon ready: ${ready.version}` : `Docker daemon ready: ${ready.version}`);
    for (const warning of run.warnings || []) log(job, `GPU selection warning: ${warning}`);

    if (run.mode === "add") {
      const slot = typeof host.inspect === "function" ? await host.inspect(run.containerName, { fresh: true }) : { exists: false };
      if (slot.exists || slot.error) {
        const detail = slot.exists
          ? `实例槽位 ${run.containerName} 已被占用；新增实例不会替换正在运行的容器。`
          : `无法确认实例槽位 ${run.containerName} 是否空闲：${slot.error}`;
        if (run.onConflict === "skip" && slot.exists) return { skipped: true, detail };
        throw supervisorError("instance_conflict", detail, 409, { containerName: run.containerName });
      }
    }
    return { skipped: false };
  }

  async function runtimeGate(job, run, command, { policy, label, stageKey, percent }) {
    if (typeof probes.nvidiaCompatibility !== "function") return null;
    const probe = await Promise.resolve().then(() => probes.nvidiaCompatibility()).catch((error) => ({ ok: false, gpus: [], error: error.message }));
    const release = run.runtimeRelease !== undefined ? run.runtimeRelease : (safe("runtime lookup", () => runtimeForImage(command.image)) || null)?.release || null;
    const assessment = assessRuntimeGate({
      probe,
      release,
      imageReference: command.image,
      engineLabel: run.engineName,
      selectedGpuIds: run.gpuIds,
    });
    for (const item of assessment.findings) log(job, `${label} [${item.severity}]: ${item.title}: ${item.detail}`);
    if (assessment.ok) return assessment;
    const issues = assessment.findings.filter((item) => item.severity === "fail").map((item) => item.detail);
    if (policy === "warn") {
      log(job, `Runtime gate (warn mode): ${issues.join("; ") || assessment.summary}; the launch continues.`);
      return assessment;
    }
    progress(job, stageKey, {
      percent,
      stage: `${run.engineName} 运行时不兼容`,
      detail: issues.join("；") || assessment.summary,
      state: "fail",
      issues,
    });
    throw supervisorError("runtime_incompatible", `${run.engineName} 运行时预检失败：${issues.join("；") || assessment.summary}`, 409, { findings: assessment.findings });
  }

  function buildCommand(job, run, state) {
    const command = run.buildCommand(job, state);
    if (!command || !Array.isArray(command.runArgs)) throw supervisorError("plan_failed", "The run context built no command.", 500);
    state.command = command;
    state.secretValues = [run.wait?.apiKey, ...Object.values(command.secretEnv || {})].map(textOf).filter(Boolean);
    if (launchStore && typeof launchStore.recordCommand === "function") {
      safe("launch store", () => launchStore.recordCommand(job.meta?.launchId, command.runArgs, { redact: (argv) => redactArgv(run, argv, state) }));
    }
    return command;
  }

  function redactArgv(run, argv, state) {
    const base = typeof run.redactArgs === "function" ? run.redactArgs(argv) : argv;
    return base.map((item) => redact(String(item), state.secretValues));
  }

  async function ensureImage(job, run, state) {
    state.stageKey = "image";
    const image = state.command.image;
    if (!image) return;
    const ensured = await host.ensureImage(image, {
      policy: run.imagePolicy || "auto",
      onMissing: async (missing) => {
        if (typeof run.onMissingImage === "function") await run.onMissingImage(missing);
        log(job, `Runtime image preflight: ${missing.status?.text || image}. Pulling before current model is stopped.`);
      },
      onAttempt: ({ attempt, attempts, image: pulling }) => log(job, `正在拉取镜像 ${pulling}（第 ${attempt}/${attempts} 次）`),
    });
    if (ensured.pulled) log(job, ensured.result?.stdout || ensured.result?.stderr || `Pulled ${image}.`);
  }

  async function prepareCheckpoint(job, run, state) {
    state.stageKey = "admission";
    if (run.mode === "add") {
      // No checkpoint: nothing existing is touched. Rollback removes only the
      // container this job created.
      return {
        hadPrevious: false,
        async commit() { return { committed: true, removedBackup: false }; },
        async rollback() {
          if (state.containerCreated && typeof host.stop === "function") {
            await host.stop(run.containerName, { reason: "add-rollback" });
          }
          return { rolledBack: true, restoredPrevious: false };
        },
      };
    }
    progress(job, "admission", {
      percent: 18,
      stage: texts.checkpointStage,
      detail: `正在保留 ${run.containerName} 的完整容器配置，若新实例失败会自动恢复。`,
    });
    const prepare = async (admissionRequest = run.admissionRequest) => {
      const previous = await host.inspect(run.containerName, { fresh: true });
      state.previousApiKeyRef = textOf(previous.labels?.[apiKeyRefLabel]);
      const previousLeaseId = textOf(previous.labels?.[leaseLabel]);
      if (admissionRequest && previousLeaseId) {
        admissionRequest.retireLeaseIds = Array.from(new Set([
          ...(Array.isArray(admissionRequest.retireLeaseIds) ? admissionRequest.retireLeaseIds : []),
          previousLeaseId,
        ]));
      }
      state.checkpointCalled = true;
      return host.checkpoint(run.containerName, {
        onEvent: (event) => {
          if (event.type === "backup-ready") log(job, `Rollback checkpoint ready: ${event.backupName}`);
        },
      });
    };
    if (typeof run.prepareAdmission === "function") {
      state.admitted = true;
      return run.prepareAdmission(prepare);
    }
    if (admission && typeof admission.acquireAfterPrepare === "function" && run.admissionRequest && !state.lease) {
      const prepared = await admission.acquireAfterPrepare(run.admissionRequest, prepare);
      state.lease = prepared?.lease || null;
      state.ownsLease = true;
      state.admitted = true;
      return prepared?.context;
    }
    return prepare();
  }

  async function create(job, run, state) {
    state.stageKey = "create";
    const command = state.command;
    let publish = Array.isArray(command.publish) ? command.publish : undefined;
    progress(job, "create", {
      percent: 32,
      stage: texts.createStage,
      detail: run.mode === "add" ? texts.createDetailAdd : texts.createDetail,
    });
    const launchCommand = `docker ${redactArgv(run, command.runArgs, state).join(" ")}`;
    job.meta = { ...(job.meta || {}), launchCommand, runtimeLaunchStarted: true, runtimeContainerCreated: false };
    saveSoon();
    log(job, `> ${launchCommand}`);
    assertActive(job);
    const launched = await host.create({ runArgs: command.runArgs, publish, name: run.containerName }, {
      secretEnv: command.secretEnv,
      lanFallback: run.lanFallback,
      bindRetryPublish: run.bindRetryPublish,
      onRetry: (retry) => {
        if (retry.kind === "name-conflict") {
          // A name taken after the add preflight is someone else's container.
          if (run.mode === "add") throw supervisorError("instance_conflict", `实例槽位 ${run.containerName} 在启动期间被占用；新增实例不会替换它。`, 409);
          log(job, `容器名冲突，清理本次残留容器后重试：${retry.error?.stderr || retry.error?.message}`);
          return;
        }
        publish = retry.publish;
        log(job, `Docker specific LAN IP publish failed; retrying with wildcard bind. Original error: ${retry.error?.stderr || retry.error?.message}`);
        if (typeof run.formatPublish === "function") log(job, `Docker publish fallback: ${run.formatPublish(retry.publish)}`);
        log(job, `> docker ${redactArgv(run, retry.runArgs || [], state).join(" ")}`);
      },
    });
    state.containerCreated = true;
    job.meta = { ...(job.meta || {}), runtimeContainerCreated: true };
    saveSoon();
    log(job, launched.stdout || launched.stderr || "");
    assertActive(job);
  }

  function descriptorOf(run) {
    try {
      return registry && run.engineId ? registry.get(run.engineId) : null;
    } catch {
      return null;
    }
  }

  // Folds the facts in a log window into state.logFacts (01 §16.2). A log read
  // is never fatal to the launch, so a bad pattern or an odd payload is dropped.
  function captureLogFacts(state, descriptor, logs) {
    if (!descriptor?.logFacts?.length) return;
    try {
      const text = typeof logs === "string" ? logs : logs && typeof logs === "object" ? `${logs.stdout || ""}${logs.stderr || ""}` : "";
      state.logFacts = mergeLogFacts(state.logFacts, extractLogFacts(descriptor, text));
    } catch {
      // facts are best-effort evidence
    }
  }

  async function waitReady(job, run, state) {
    state.stageKey = "waitReady";
    const waitOptions = run.wait || {};
    progress(job, "waitReady", {
      percent: 45,
      stage: texts.loadingStage,
      detail: textOf(waitOptions.loadingDetail) || texts.loadingDetail(run),
    });
    const descriptor = descriptorOf(run);
    const inferProgress = typeof waitOptions.inferProgress === "function"
      ? waitOptions.inferProgress
      : descriptor?.logPhases?.length ? createProgressInferer(descriptor) : undefined;
    const startupTimeoutMs = Number(waitOptions.startMs ?? timeouts.startMs) || 30 * 60 * 1000;
    const stallSource = waitOptions.stallMs ?? timeouts.stallMs;
    const stallTimeoutMs = typeof stallSource === "function" ? Number(stallSource(run)) || 0 : Number(stallSource) || 0;
    const readyProbeTimeoutMs = Number(waitOptions.readyProbeMs ?? timeouts.readyProbeMs) || 5 * 60 * 1000;
    const probeRequestMs = Number(waitOptions.probeRequestMs ?? timeouts.probeRequestMs) || 180000;
    const fetchServedModels = waitOptions.fetchServedModels || config.getters.servedModels;
    // Fresh getters (01 §14 stage 7): never a snapshot cache during a start.
    const getContainerStatus = waitOptions.getContainerStatus || config.getters.containerStatus
      || ((name) => host.inspect(name, { fresh: true }));
    const probeRuntime = typeof waitOptions.probe === "function"
      ? waitOptions.probe
      : ({ servedModels }) => probeGeneration({
        fetchImpl,
        servedModels,
        port: run.port,
        apiKey: waitOptions.apiKey,
        timeoutMs: probeRequestMs,
        maxTokens: 32,
      });
    let readyMeta = null;
    await wait({
      job,
      port: run.port,
      apiKey: waitOptions.apiKey,
      serviceUrl: waitOptions.serviceUrl,
      engineName: run.engineName,
      apiLabel: run.apiLabel || `${run.engineName} API`,
      containerName: run.containerName,
      startupTimeoutMs,
      stallTimeoutMs,
      finalReadyCheck: waitOptions.finalReadyCheck !== false,
      timeoutBudgetLog: waitOptions.timeoutBudgetLog === undefined
        ? `Startup timeout budget: ${Math.round(startupTimeoutMs / 60_000)} minutes`
        : waitOptions.timeoutBudgetLog,
      fetchServedModels: typeof fetchServedModels === "function"
        ? () => fetchServedModels(run.port, waitOptions.apiKey)
        : async () => [],
      getContainerStatus,
      readLogs: async (name, readOptions) => {
        const logs = await host.logs(name, readOptions);
        captureLogFacts(state, descriptor, logs);
        return logs;
      },
      inferProgress,
      extractLogIssues: waitOptions.extractLogIssues || (() => []),
      setJobProgress: (target, patch = {}) => {
        const phase = waitPhaseOf(patch.stage) || target.lifecycle?.phase || "weights";
        const stageKey = phase === "probe" ? "probe" : "waitReady";
        state.stageKey = stageKey;
        progress(target, stageKey, patch, { phase });
      },
      appendLog: jobs.appendLog,
      // The job finishes after the commit stage, not inside the wait.
      finishJob: (_target, meta = {}) => { readyMeta = meta; },
      delayFn,
      probeRuntime,
      readyProbeTimeoutMs,
      noLogIssue: waitOptions.noLogIssue,
      pollDetail: waitOptions.pollDetail,
    });
    // The wait only sees a short tail; one deeper read catches facts that
    // scrolled out between polls (weights and KV lines come early).
    if (descriptor?.logFacts?.length && typeof host.logs === "function") {
      captureLogFacts(state, descriptor, await Promise.resolve(host.logs(run.containerName, { tail: FACT_LOG_LINES })).catch(() => ""));
    }
    return readyMeta || {};
  }

  async function commit(job, run, state, checkpoint, readyMeta, source) {
    state.stageKey = "commit";
    const committed = await Promise.resolve(checkpoint?.commit?.()).catch((error) => {
      log(job, `新模型已就绪，但清理回滚快照失败：${error.message}`);
      return null;
    });
    if (state.lease && state.ownsLease) {
      await Promise.resolve(state.lease.commit?.({ jobId: job.id, containerName: run.containerName })).catch((error) => {
        log(job, `GPU admission lease warning: ${error.message}`);
      });
    }
    if (committed?.committed && state.previousApiKeyRef && state.previousApiKeyRef !== textOf(run.apiKeyRef) && secrets?.remove) {
      await Promise.resolve(secrets.remove(state.previousApiKeyRef)).catch(() => {});
    }
    const launchId = textOf(job.meta?.launchId);
    const labels = labelsFromArgs(state.command?.runArgs);
    if (launchStore && launchId && typeof launchStore.markStatus === "function") {
      safe("launch store", () => launchStore.markStatus(launchId, "running", {
        event: "ready",
        patch: { containerName: run.containerName, resolved: { logFacts: state.logFacts || {} } },
      }));
    }
    progress(job, "commit", { percent: 100 });
    closePhase(job.lifecycle);
    jobs.finishJob(job, readyMeta);
    if (typeof hooks.recordRecentLaunch === "function") {
      safe("recordRecentLaunch", () => hooks.recordRecentLaunch(job.meta, { job, source }));
    }
    if (typeof hooks.afterChange === "function") safe("afterChange", () => hooks.afterChange({ job, containerName: run.containerName }));
    emitJob(job, { force: true });
    emitInstances({ changed: [run.instanceId] });
    if (typeof hooks.afterReady === "function") {
      const context = {
        managerId,
        jobId: job.id,
        launchId: launchId || null,
        engineId: run.engineId || null,
        runtimeId: textOf(run.runtimeId) || labels[RUNTIME_ID_LABEL] || null,
        containerName: run.containerName,
        plan: run.plan || null,
        paramsKey: run.paramsKey || null,
        contentDigest: run.contentDigest || null,
        logFacts: state.logFacts || {},
        gpuUsedBeforeMb: state.gpuUsedBeforeMb ?? null,
      };
      const afterReadyMs = Number(timeouts.afterReadyMs) || DEFAULT_AFTER_READY_MS;
      let timer = null;
      const pending = Promise.resolve().then(() => hooks.afterReady(context));
      const bounded = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), afterReadyMs);
        timer.unref?.();
      });
      try {
        const outcome = await Promise.race([pending, bounded]);
        if (outcome?.timedOut) log(job, `afterReady hook still running after ${afterReadyMs} ms; not waiting for it.`);
      } catch (error) {
        log(job, `afterReady hook failed (ignored): ${error.message}`);
      } finally {
        clearTimeout(timer);
      }
      pending.catch(() => {});
    }
  }

  async function rollback(job, run, state, checkpoint, error) {
    if (checkpoint) {
      const outcome = await Promise.resolve(checkpoint.rollback?.(error)).catch((rollbackError) => ({ rollbackError }));
      if (outcome?.restoredPrevious) log(job, `新模型启动失败，已恢复原容器 ${run.containerName}。`);
      else if (outcome?.rollbackError) log(job, `自动回滚失败：${outcome.rollbackError.message}`);
    }
    if (state.lease && state.ownsLease) {
      await Promise.resolve(state.lease.release?.("start-failed")).catch((releaseError) => {
        log(job, `GPU admission lease warning: ${releaseError.message}`);
      });
    }
    if (run.cleanup !== "caller" && textOf(run.apiKeyRef) && secrets?.remove) {
      await Promise.resolve(secrets.remove(textOf(run.apiKeyRef))).catch(() => {});
    }
    if (state.containerCreated || state.checkpointCalled) {
      if (typeof hooks.afterChange === "function") safe("afterChange", () => hooks.afterChange({ job, containerName: run.containerName }));
      emitInstances({ changed: [run.instanceId] });
    }
  }

  async function gpuUsedMb(run) {
    if (typeof probes.gpuStatus !== "function") return null;
    const status = await Promise.resolve().then(() => probes.gpuStatus()).catch(() => null);
    const gpus = Array.isArray(status?.gpus) ? status.gpus : [];
    const ids = (run.gpuIds || []).map(textOf).filter(Boolean);
    const selected = ids.length ? gpus.filter((gpu) => ids.includes(String(gpu.id ?? gpu.index))) : gpus;
    const used = selected.map((gpu) => Number(gpu.usedMb)).filter(Number.isFinite);
    return used.length ? used.reduce((sum, value) => sum + value, 0) : null;
  }

  function normalizeRun(run = {}) {
    if (!isPlainObject(run) || typeof run.buildCommand !== "function") {
      throw new TypeError("supervisor.start needs run.buildCommand.");
    }
    const runOptions = isPlainObject(run.options) ? run.options : {};
    const mode = textOf(run.mode || runOptions.instanceMode || "replace");
    if (!INSTANCE_MODES.includes(mode)) throw supervisorError("invalid_instance_mode", `Unknown instance mode: ${mode}.`, 400);
    const containerName = textOf(run.containerName || runOptions.containerName || config.containerBaseName);
    if (!containerName) throw new TypeError("supervisor.start needs a container name.");
    return {
      ...run,
      options: runOptions,
      mode,
      onConflict: run.onConflict === "skip" ? "skip" : "fail",
      containerName,
      instanceId: textOf(run.instanceId) || containerName,
      port: Number(run.port ?? runOptions.port),
      gpuIds: Array.isArray(run.gpuIds) ? run.gpuIds : (Array.isArray(runOptions.gpuDeviceIds) ? runOptions.gpuDeviceIds : []),
      engineName: textOf(run.engineName) || textOf(run.engineId) || "runtime",
      apiKeyRef: textOf(run.apiKeyRef ?? runOptions.runtimeApiKeyRef),
      lanFallback: run.lanFallback === undefined ? runOptions.networkAccess === "lan" : Boolean(run.lanFallback),
    };
  }

  function queueKeyOf(run) {
    return run.mode === "replace" ? "replace" : `${run.mode === "add" ? "parallel" : run.mode}:${run.containerName}`;
  }

  async function runOnce(job, run, source) {
    // 排队期间任务可能已被用户取消（cancel -> failJob）。拿到锁后若已不在 running 态，直接放弃，
    // 避免给一个已取消的任务启动容器、再被 finishJob 复活。
    if (job.status !== "running") {
      log(job, `任务已不再运行（status=${job.status}），跳过启动。`);
      return { skipped: true };
    }
    const state = {
      stageKey: "preflight",
      containerName: run.containerName,
      engineId: run.engineId || null,
      command: null,
      secretValues: [textOf(run.wait?.apiKey)].filter(Boolean),
      lease: run.lease || null,
      // A lease handed in is the supervisor's to commit or release unless the
      // caller keeps the cleanup; one it acquires itself is always its own.
      ownsLease: Boolean(run.lease) && run.cleanup !== "caller",
      containerCreated: false,
      checkpointCalled: false,
      previousApiKeyRef: "",
      logFacts: {},
      gpuUsedBeforeMb: null,
    };
    if (launchStore && typeof launchStore.beginLaunch === "function") {
      safe("launch store", () => launchStore.beginLaunch(job, run.options, { source: source || "api" }));
    }
    let checkpoint = null;
    try {
      const pre = await preflight(job, run, state);
      if (pre.skipped) {
        log(job, pre.detail);
        enterPhase(job, "pull");
        closePhase(job.lifecycle);
        jobs.finishJob(job, { skipped: true, skipReason: "instance_conflict" });
        emitJob(job, { force: true });
        return { skipped: true };
      }
      assertActive(job);
      state.stageKey = "plan";
      progress(job, "plan", { percent: 8, stage: texts.preflightStage, detail: texts.preflightDetail });
      if (typeof probes.portStatus === "function") {
        const portStatus = await Promise.resolve().then(() => probes.portStatus(run.port, run.containerName)).catch(() => null);
        if (portStatus && !portStatus.available && !portStatus.isOwnContainer) {
          log(job, `Port check failed: ${portStatus.detail}`);
          progress(job, "plan", {
            percent: 18,
            stage: "端口被占用",
            detail: `${portStatus.detail} 请换一个端口或先停止占用方。`,
            state: "fail",
            issues: [portStatus.detail],
          });
          throw supervisorError("port_in_use", `端口 ${run.port} 不可用：${portStatus.detail}`, 409);
        }
      }
      const command = buildCommand(job, run, state);
      // The runtime gate runs on the built command's image. `enforce` fails
      // the job here; `warn` only logs (llama.cpp had no gate before).
      state.stageKey = "preflight";
      await runtimeGate(job, run, command, { policy: runtimeGatePolicy, label: "Runtime compatibility", stageKey: "preflight", percent: 8 });
      state.stageKey = "plan";
      assertActive(job);
      await ensureImage(job, run, state);
      assertActive(job);
      state.gpuUsedBeforeMb = await gpuUsedMb(run);
      if (typeof hooks.beforeStart === "function") {
        await Promise.resolve().then(() => hooks.beforeStart({ job, run })).catch(() => {});
      }
      checkpoint = await prepareCheckpoint(job, run, state);
      assertActive(job);
      if (state.admitted) {
        // Re-plan (stage 5): the admitted GPUs may differ from the request.
        state.stageKey = "replan";
        progress(job, "replan", { percent: 30, stage: texts.checkpointStage, detail: `已获得显存准入，正在按准入的 GPU 重建 ${run.engineName} 启动命令。` });
        const rebuilt = buildCommand(job, run, state);
        if (runtimeGatePolicy === "enforce") {
          await runtimeGate(job, run, rebuilt, { policy: "enforce", label: "Admitted GPU compatibility", stageKey: "replan", percent: 30 });
        }
        assertActive(job);
      }
      await create(job, run, state);
      const readyMeta = await waitReady(job, run, state);
      assertActive(job);
      await commit(job, run, state, checkpoint, readyMeta, source);
      return { ok: true };
    } catch (error) {
      try {
        job.failure = await buildFailure(job, error, state);
      } catch (failureError) {
        job.failure = { code: errorCodeOf(error) || "start_failed", signatureId: null, phase: job.lifecycle?.phase || null, hint: null, logExcerpt: "" };
        log(job, `Failure details unavailable: ${failureError.message}`);
      }
      closePhase(job.lifecycle);
      await rollback(job, run, state, checkpoint, error);
      if (typeof jobs.failJob === "function") jobs.failJob(job, error);
      emitJob(job, { force: true });
      throw error;
    }
  }

  /**
   * Runs one resolved launch through the pipeline, serially per queue key.
   * Resolves when the job has finished (success, skipped) and rejects with
   * the stage error after the job failed and everything was rolled back.
   */
  function start({ job, run, source = "api" } = {}) {
    if (!job || typeof job !== "object") throw new TypeError("supervisor.start needs a job.");
    const normalized = normalizeRun(run);
    const key = queueKeyOf(normalized);
    const queue = queues.get(key) || { chain: Promise.resolve(), busy: false };
    const queued = queue.busy;
    queue.busy = true;
    const result = queue.chain.then(() => runOnce(job, normalized, source));
    queue.chain = result.then(() => { queue.busy = false; }, () => { queue.busy = false; });
    queues.set(key, queue);
    if (queued) {
      log(job, texts.queuedLog);
      progress(job, "queued", { percent: 1, stage: STAGES.queued.zh, detail: texts.queuedDetail });
    }
    return result;
  }

  return {
    config,
    start,
    emitInstances,
    emitJob,
    assessRuntimeGate,
  };
}

module.exports = {
  LIFECYCLE_PHASES,
  GATE_POLICIES,
  INSTANCE_MODES,
  STAGES,
  STAGE_FAILURE_CODES,
  LOG_EXCERPT_LINES,
  LOG_EXCERPT_BYTES,
  createRuntimeSupervisor,
  assessRuntimeGate,
  probeNvidiaCompatibility,
  parseNvidiaCompatibilityCsv,
  labelsFromArgs,
  publishedPortOf,
  tailExcerpt,
};
