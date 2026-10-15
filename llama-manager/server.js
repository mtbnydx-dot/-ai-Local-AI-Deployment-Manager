const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const core = require("../manager-core");
const { describeDownloadError } = require("../manager-core/model-hub/errors");
const { createHfAuthService } = require("../manager-core/hf-auth");
const { createLlamaStartRuntimeRequest } = require("./lib/launch-request");
const { createLlamaDefaultLaunchProfiles } = require("./lib/default-profiles");
const { buildLlamaGpuPlan, normalizeLlamaSplitMode, suggestTensorSplit } = require("./lib/gpu-plan");
const { buildLlamaMemoryEstimate } = require("./lib/memory-estimate");
const { createLlamaRuntimeCommandBuilder } = require("./lib/runtime-command");
const { createLlamaRemoteModelService } = require("./lib/remote-models");
const { createCacheHitTracker } = require("./lib/cache-hit-tracker");
const {
  firstExisting,
  ensureDirs,
  readJsonFile,
  writeJsonFile,
  atomicWriteJsonFile,
  flushFileWriteQueues,
  parsePrometheusMetrics,
  parsePrometheusLabels,
  firstMetricValue,
  sumMetric,
  sumByLabel,
  histogramAverage,
  tokensPerSecondFromSeconds,
  aggregateStats,
  calculateCost,
  buildClientUsageSummary: buildCoreClientUsageSummary,
  parseJsonSafe,
  cleanRequired,
  cleanOptionalLaunchArg,
  claudeError,
  upstreamErrorMessage,
  sendClaudeUpstreamError,
  isExpectedStreamDisconnect,
  uniqueModelsById,
  estimateTokenCount,
  normalizeGpuIds,
  positiveInt,
  clampNumber,
  lastIntegerMatch,
  countUniqueCaptures,
  averageCapture,
  normalizeNetworkAccess,
  normalizeKvCacheDtype,
  normalizeClientPreset,
  formatBytes,
  markJobCancelRequested,
  normalizePersistedJob,
  createProcessJobRunner,
  extractLogIssues,
  safeOutputName,
  isPinnedImageReference,
  isLocalRequest,
  extractHostname,
  cleanDownloadSource,
  normalizeDownloadModelReference,
  deriveName,
} = core;
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {}

const app = express();
const PORT = Number(process.env.LLAMA_MANAGER_PORT || 5178);
const HOST = process.env.LLAMA_MANAGER_HOST || "127.0.0.1";
const SHARED_PUBLIC_JS_DIR = path.join(__dirname, "..", "shared-public", "js");
const ALLOW_REMOTE_MANAGEMENT = process.env.LLAMA_MANAGER_ALLOW_REMOTE === "1";
const DEFAULT_AI_ROOT = process.env.AI_ROOT || path.resolve(__dirname, "..");
const DEFAULT_DEVTOOLS_ROOT = process.env.DEVTOOLS_ROOT || "";
// Pinned llama.cpp images come from manager-core/data/runtime-manifest.json
// (config/ override supported); environment variables still win.
const LLAMA_RUNTIME_RELEASE = core.getRuntimeRelease("llama") || {};
const LLAMA_MUSE_RUNTIME_RELEASE = core.getRuntimeRelease("llamaMuse") || {};
const DEFAULT_LLAMA_IMAGE = process.env.LLAMA_IMAGE_DIGEST || core.runtimeImageReference("llama") || "ghcr.io/ggml-org/llama.cpp@sha256:3e847b7b8d616411d4dd8f3d1a79caf02cc7a66b6b92c8212156ea73835bf7f3";
const DEFAULT_LLAMA_IMAGE_BUILD = Number(LLAMA_RUNTIME_RELEASE.build || 10630);
const MUSE_GLIMMER_MINIMUM_LLAMA_REVISION = LLAMA_MUSE_RUNTIME_RELEASE.revision || "62bf73d25c53b8161f8a22894d4f90c4aebbd7d0";
const DEFAULT_MUSE_LLAMA_IMAGE = LLAMA_MUSE_RUNTIME_RELEASE.image || "local/llama.cpp:server-cuda-muse-62bf73d";
const MANAGER_LABEL_KEY = "ai.manager";
const MANAGER_ENGINE_LABEL_KEY = "ai.manager.engine";
const MANAGER_APIKEY_LABEL_KEY = "ai.manager.api-key";
const MANAGER_APIKEY_REF_LABEL_KEY = "ai.manager.api-key-ref";

// Docker Desktop or docker inside a WSL distro, shared with vllm-manager so both
// managers see the same containers (01-engines §13 and §28.4, ENG-9):
// DOCKER_WSL_DISTRO env > platform.json docker.wslDistro > Docker Desktop.
const DOCKER_HOST_CONFIG = core.engines.createDockerHostConfig(process.env, undefined, {
  dockerExeCandidates: [
    process.env.DOCKER_EXE,
    defaultDevToolsPath("Docker", "resources", "bin", "docker.exe"),
    "docker",
  ],
  // The configured docker.desktopExe (DOCKER_DESKTOP_EXE first) goes in front.
  desktopExeCandidates: [
    defaultDevToolsPath("Docker", "Docker Desktop.exe"),
    defaultDevToolsPath("Docker", "frontend", "Docker Desktop.exe"),
    "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
  ],
});

const CONFIG = {
  dockerWslDistro: DOCKER_HOST_CONFIG.wslDistro,
  dockerExe: DOCKER_HOST_CONFIG.dockerExe,
  dockerArgsPrefix: [...DOCKER_HOST_CONFIG.dockerArgsPrefix],
  dockerRuntimeName: DOCKER_HOST_CONFIG.runtimeName,
  dockerDaemonStartFile: DOCKER_HOST_CONFIG.daemonStartFile,
  dockerDaemonStartArgs: [...DOCKER_HOST_CONFIG.daemonStartArgs],
  dockerDesktopExe: DOCKER_HOST_CONFIG.dockerDesktopExe,
  hfCli: firstExisting([
    process.env.HF_CLI,
    defaultAiPath("venvs", "download-cli", "Scripts", "hf.exe"),
    defaultAiPath("venvs", "ai312", "Scripts", "hf.exe"),
    defaultAiPath("venvs", "ai311", "Scripts", "hf.exe"),
    "hf",
    defaultAiPath("venvs", "ai312", "Scripts", "huggingface-cli.exe"),
    defaultAiPath("venvs", "ai311", "Scripts", "huggingface-cli.exe"),
    "huggingface-cli",
  ]),
  modelScopeCli: firstExisting([
    process.env.MODELSCOPE_CLI,
    defaultAiPath("venvs", "download-cli", "Scripts", "modelscope.exe"),
    defaultAiPath("venvs", "ai312", "Scripts", "modelscope.exe"),
    defaultAiPath("venvs", "ai311", "Scripts", "modelscope.exe"),
    "modelscope",
  ]),
  modelsRoot: process.env.LLAMA_MODELS_ROOT || defaultAiPath("models"),
  hfCache: process.env.HF_HOME || defaultAiPath("cache", "huggingface"),
  image: process.env.LLAMA_IMAGE || DEFAULT_LLAMA_IMAGE,
  museImage: process.env.LLAMA_MUSE_IMAGE || DEFAULT_MUSE_LLAMA_IMAGE,
  containerName: process.env.LLAMA_CONTAINER_NAME || "llama-local",
  managerId: process.env.LLAMA_MANAGER_ID || "llama-manager",
  defaultPort: Number(process.env.LLAMA_PORT || 8080),
  startupTimeoutMs: positiveTimeoutMs(process.env.LLAMA_STARTUP_TIMEOUT_MS, 20 * 60 * 1000),
  pidFile: process.env.LLAMA_MANAGER_PID_FILE || path.join(__dirname, ".manager.pid"),
  statsLedger: path.join(__dirname, "logs", "stats-ledger.json"),
  cacheHitLedger: path.join(__dirname, "logs", "cache-hit-ledger.json"),
  metricsHistory: path.join(__dirname, "logs", "metrics-history.json"),
  benchmarkHistory: path.join(__dirname, "logs", "benchmark-history.json"),
  idleUnloadSettings: path.join(__dirname, "logs", "idle-unload-settings.json"),
  idleUnloadSleeping: path.join(__dirname, "logs", "idle-unload-sleeping.json"),
  managerBackups: path.join(__dirname, "logs", "backups"),
  jobsLedger: path.join(__dirname, "logs", "jobs-ledger.json"),
  downloadSettings: path.join(__dirname, "logs", "download-settings.json"),
  claudeCompressionSettings: path.join(__dirname, "logs", "claude-context-compression.json"),
  launchProfiles: path.join(__dirname, "logs", "launch-profiles.json"),
  recentLaunches: path.join(__dirname, "logs", "recent-launches.json"),
  launchStore: path.join(__dirname, "logs", "launch-store.json"),
  modelNotes: path.join(__dirname, "logs", "model-notes.json"),
  automationSettings: path.join(__dirname, "logs", "automation-settings.json"),
  serviceExposureSettings: path.join(__dirname, "logs", "service-exposure-settings.json"),
  serviceClients: path.join(__dirname, "logs", "service-clients.json"),
  serviceUsageDb: path.join(__dirname, "logs", "service-usage.sqlite"),
  serviceGatewayAccessLog: path.join(__dirname, "logs", "service-gateway-access.log"),
  runtimeApiKeys: path.join(__dirname, "logs", "runtime-api-keys.json"),
  auditRoot: process.env.AI_AUDIT_ROOT || defaultAiPath("audit-logs"),
  openWebuiContainer: process.env.OPEN_WEBUI_CONTAINER || "open-webui",
};

// Job logs, the ledger, /api/logs and API responses redact the exact runtime
// keys, the HF tokens of running downloads and the secret patterns (08 P0-5).
// The list is cached; set/remove through runtimeApiKeyStore and every change
// of the download-token map invalidate it.
const downloadTokens = createDownloadTokenStore({ onChange: () => runtimeSecretList.invalidate() });
const runtimeSecretList = core.createCachedSecretList({
  // DPAPI secret store (06 OPS-3b); the old plaintext file is migrated once.
  store: core.createRuntimeSecretStore({ file: CONFIG.runtimeApiKeys, namespace: "runtime.llama", aiRoot: DEFAULT_AI_ROOT }),
  sources: [() => process.env.HF_TOKEN, () => process.env.AI_CLAUDE_GATEWAY_API_KEY, () => downloadTokens.values()],
});
const runtimeApiKeyStore = runtimeSecretList.store;
const runtimeSecretRedactor = core.createSecretRedactor({ getSecrets: runtimeSecretList.getSecrets });
// LaunchStore (01 §15): one record per launch, linked to its container by the
// ai.manager.launch-id label. Idle wake reads it; containers started by older
// code are adopted. Store failures are logged and never fail a launch.
const launchStore = core.engines.createLaunchStore({
  file: CONFIG.launchStore,
  managerId: CONFIG.managerId,
  normalizeConfig: (config) => normalizeLaunchConfig(config),
  toContainerPath: (value) => windowsPathToContainerPath(value),
  secretValues: () => runtimeSecretList.getSecrets(),
  log: (message) => console.warn(`[launch-store] ${message}`),
});
function trackLaunch(action) {
  try {
    return action();
  } catch (error) {
    console.warn(`[launch-store] ${error.message}`);
    return null;
  }
}
const billingClient = core.createBillingClient({
  managerId: CONFIG.managerId,
  root: DEFAULT_AI_ROOT,
});
// 05 §6.8, §7.2 (PUB-10): the legacy key routes forward to the entry's key
// store, direct gateway calls follow public.managersGatewayOnly (read through
// OPS-3 at most every 10 s), and /api/manager/health advertises hop v2 so the
// entry stops forwarding API keys to this manager. The frontend smoke tests
// start real managers; they must not call the entry this computer runs, so
// there the key routes stay on this manager's legacy files.
const legacyKeyForwarder = process.env.AI_FRONTEND_SMOKE === "1" ? null : core.createLegacyKeyForwarder({
  managerId: CONFIG.managerId,
  root: DEFAULT_AI_ROOT,
});
const readGatewayOnlyMode = core.createGatewayOnlyModeReader({ aiRoot: DEFAULT_AI_ROOT });
const gatewayTrustHealth = () => ({ gatewayTrust: { version: core.GATEWAY_TRUST_VERSION, mode: readGatewayOnlyMode() } });
const logDirectGatewayCall = (event) => {
  const more = event.suppressed ? ` (+${event.suppressed} more in the last minute)` : "";
  console.warn(`[gateway] direct_manager_gateway: ${event.kind} ${event.path} from ${event.remoteAddress}${more}; use the platform endpoint instead.`);
};
const logBillingIntegrationIssue = ({ phase, requestId, code } = {}) => {
  if (["insufficient_quota", "request_limit_exceeded", "token_limit_exceeded", "spend_limit_exceeded", "customer_suspended"].includes(String(code || ""))) return;
  console.warn(`Billing ${String(phase || "request")} issue (${String(code || "unknown")}) for request ${String(requestId || "unknown")}.`);
};
const billingPendingQueue = core.createBillingPendingQueue({
  file: path.join(__dirname, "logs", "billing-pending.json"),
  readJsonFile,
  writeJsonFile,
  authorize: (...args) => billingClient.authorize(...args),
  settle: (...args) => billingClient.settle(...args),
});

// 状态热路径（docker CLI、nvidia-smi、容器 /metrics）统一走短 TTL 单飞缓存：
// 多个页面同时轮询时只保留一份真实探测，Windows 上省掉大量进程 spawn。
const RUNTIME_SNAPSHOT_CACHE_MS = Math.max(500, Number(process.env.MANAGER_STATUS_CACHE_MS || 2000));
const runtimeSnapshotCache = core.createSingleFlightCache({ ttlMs: RUNTIME_SNAPSHOT_CACHE_MS });

// DockerHost (01 §13) owns the docker runtime; the helpers destructured below
// are its runtime's, so every docker call keeps the WSL prefix when one is set.
const dockerHost = core.engines.createDockerHost({
  config: DOCKER_HOST_CONFIG,
  managerLabelValue: CONFIG.managerId,
  ownerLabelKey: MANAGER_LABEL_KEY,
  formatBytes,
  parseJsonSafe,
  delay,
});
const dockerRuntime = dockerHost.runtime;
const {
  execFileAsync,
  docker,
  getDockerVersion: getDockerVersionFresh,
  checkDockerDaemon,
  ensureDockerDaemonRunning,
  getImageStatus: getImageStatusFresh,
  normalizeDockerContainerName,
  normalizeDockerTimestamp,
  timestampToSeconds,
} = dockerRuntime;
const getDockerVersion = () => runtimeSnapshotCache.get("docker-version", getDockerVersionFresh, {
  ttlMs: Math.max(RUNTIME_SNAPSHOT_CACHE_MS, 5000),
});
const getImageStatus = (image) => runtimeSnapshotCache.get(`image:${image}`, () => getImageStatusFresh(image), {
  ttlMs: Math.max(RUNTIME_SNAPSHOT_CACHE_MS, 10000),
});
const {
  healthCheck,
  directoryHealth,
  commandHealth,
} = core.createHealthProbe({ execFileAsync });

const gpuRuntime = core.createGpuRuntime({ execFileAsync, normalizeGpuIds });
const {
  getGpuStatus: getGpuStatusFresh,
  normalizeLaunchGpuSelection,
} = gpuRuntime;
const getGpuStatus = () => runtimeSnapshotCache.get("gpu", getGpuStatusFresh);
const gpuAdmissionController = core.createGpuAdmissionController({
  root: process.env.MODEL_GPU_ADMISSION_ROOT,
  managerId: CONFIG.managerId,
  getGpuStatus,
});

const remoteModelService = createLlamaRemoteModelService();
const hfAuthService = createHfAuthService({ hfCli: CONFIG.hfCli, hfHome: CONFIG.hfCache });
const modelStorage = core.createModelStorage({
  modelsRoot: CONFIG.modelsRoot,
  file: process.env.MODEL_STORAGE_FILE || defaultAiPath("service-entry", "data", "model-storage.json"),
});
const storageBusyPaths = core.createStorageBusyPathProbe({ aiRoot: DEFAULT_AI_ROOT, getJobs: () => jobs.values() });
const modelMigration = core.createModelMigration({ storage: modelStorage, getBusyPaths: storageBusyPaths });
const modelFilesystemStore = core.createModelFilesystemStore({
  storage: modelStorage,
  modelsRoot: CONFIG.modelsRoot,
  hfCache: CONFIG.hfCache,
  listRoots: () => listModelStorageRoots(modelStorage),
});
const {
  chooseGgufFile,
  describeLocalModelPath,
  dirSize,
  findGgufFilesSync,
  hasRecognizedConfig,
  listCachedModels,
  listLocalModels,
  listModelCollections,
  looksLikeGgufReference,
  resolveGgufSelection,
  resolveModelsRootChild,
  scanDownloadProgress,
} = modelFilesystemStore;

const llamaImageBuildInfoCache = new Map();

function resolveConfiguredLlamaImageBuildInfo({
  museGlimmer = false,
  image = "",
  buildEnv = "",
  revisionEnv = "",
  imageInspectText = "",
} = {}) {
  let buildNumber = Number(buildEnv || 0) || null;
  let build = buildNumber ? `b${buildNumber}` : "";
  let revision = String(revisionEnv || "").trim();
  let source = buildNumber || revision ? "environment" : "image-label";
  const inspectText = String(imageInspectText || "").trim();
  const imagePresent = Boolean(inspectText);
  const labels = parseJsonSafe(inspectText, {});
  const labelBuild = String(labels?.["org.opencontainers.image.version"] || "");
  const labelRevision = String(labels?.["org.opencontainers.image.revision"] || "");
  const labelBuildNumber = Number(labelBuild.match(/\bb(\d+)\b/i)?.[1] || 0) || null;
  if (!buildNumber && labelBuildNumber) {
    buildNumber = labelBuildNumber;
    build = `b${buildNumber}`;
  }
  if (!revision && labelRevision) revision = labelRevision;
  if (!buildNumber && !museGlimmer && image === DEFAULT_LLAMA_IMAGE) {
    buildNumber = DEFAULT_LLAMA_IMAGE_BUILD;
    build = `b${buildNumber}`;
    source = "pinned-default";
  }
  return {
    image,
    build,
    buildNumber,
    revision,
    source,
    imagePresent,
  };
}

async function getConfiguredLlamaImageBuildInfo(architecture = "") {
  const museGlimmer = String(architecture || "").trim().toLowerCase() === "muse-glimmer";
  const image = museGlimmer ? CONFIG.museImage : CONFIG.image;
  const cacheKey = `${museGlimmer ? "muse" : "default"}:${image}`;
  const now = Date.now();
  const cached = llamaImageBuildInfoCache.get(cacheKey);
  if (cached?.value && cached.expiresAt > now) return cached.value;
  const buildEnv = museGlimmer ? process.env.LLAMA_MUSE_IMAGE_BUILD : process.env.LLAMA_IMAGE_BUILD;
  const revisionEnv = museGlimmer ? process.env.LLAMA_MUSE_IMAGE_REVISION : process.env.LLAMA_IMAGE_REVISION;
  const out = await docker([
    "image", "inspect", image,
    "--format", "{{json .Config.Labels}}",
  ], { rejectOnError: false }).catch(() => ({ stdout: "" }));
  const imageInspectText = String(out.stdout || "").trim();
  const value = resolveConfiguredLlamaImageBuildInfo({
    museGlimmer,
    image,
    buildEnv,
    revisionEnv,
    imageInspectText,
  });
  llamaImageBuildInfoCache.set(cacheKey, { expiresAt: now + 60_000, value });
  return value;
}

async function getLlamaArchitectureRuntimeCompatibility(architecture) {
  const normalized = String(architecture || "").trim().toLowerCase();
  const runtime = {
    ...await getConfiguredLlamaImageBuildInfo(normalized),
  };
  return evaluateLlamaArchitectureRuntimeCompatibility(normalized, runtime);
}

function evaluateLlamaArchitectureRuntimeCompatibility(architecture, runtime = {}) {
  const normalized = String(architecture || "").trim().toLowerCase();
  if (normalized === "muse-glimmer") {
    return {
      architecture: normalized,
      status: "unsupported",
      supported: false,
      runtime,
      capability: { id: "muse-glimmer", matchedBy: "gguf" },
      minimumRevision: MUSE_GLIMMER_MINIMUM_LLAMA_REVISION,
      message: "Muse Glimmer 已从本地栈弃用，llama-manager 不再启动该架构。现有模型与镜像只保留作回滚，不会由此检查删除。",
    };
  }
  // The families v2 knowledge (manager-core/data/knowledge/families.json) owns
  // per-architecture llama.cpp requirements; the GGUF general.architecture is
  // the declared identity (match.ggufArchitectures) here, so no name
  // heuristics are involved.
  const capability = core.models.compatibility.ggufArchitectureSupport(normalized);
  const llamaCapabilities = capability.llamacpp ? core.resolveEngineCapabilities({ llama: capability.llamacpp }, "llama", {}) : null;
  const summary = { id: capability.id, label: capability.label, matchedBy: capability.matchedBy };
  if (llamaCapabilities?.supported === false) {
    return {
      architecture: normalized,
      status: "unsupported",
      supported: false,
      runtime,
      capability: summary,
      message: llamaCapabilities.unsupportedReason || `${capability.label} 不支持在 llama.cpp 上启动。`,
    };
  }
  const minimumBuild = Number(llamaCapabilities?.minimumBuild || 0);
  if (minimumBuild > 0) {
    const buildNumber = Number(runtime.buildNumber || 0);
    if (buildNumber && buildNumber < minimumBuild) {
      return {
        architecture: normalized,
        status: "outdated",
        supported: false,
        runtime,
        capability: summary,
        minimumBuild,
        message: `${capability.label} 需要 llama.cpp b${minimumBuild} 或更新；当前镜像为 b${buildNumber}。`,
      };
    }
    return {
      architecture: normalized,
      status: buildNumber ? "ok" : "unverified",
      supported: true,
      runtime,
      capability: summary,
      minimumBuild,
      message: buildNumber
        ? `${capability.label} 需要 b${minimumBuild}，当前镜像 b${buildNumber} 满足。`
        : `${capability.label} 需要 llama.cpp b${minimumBuild}，但无法读取当前镜像版本。`,
    };
  }
  // An architecture the matrix does not list is unknown, never "compatible"
  // (00 §4.4, 08 P0-15). Launch still goes ahead; the start job logs this.
  if (normalized && !capability.family) {
    return {
      architecture: normalized,
      status: "unknown",
      supported: null,
      runtime,
      capability: summary,
      message: `${normalized} 不在已验证的架构列表中，能否运行取决于当前 llama.cpp 版本。 / ${normalized} is not in the verified architecture list. Whether it runs depends on the current llama.cpp build.`,
    };
  }
  return {
    architecture: normalized,
    status: "not-required",
    supported: true,
    runtime,
    capability: summary,
    speculative: llamaCapabilities?.speculative || null,
    message: normalized
      ? `${capability.label}：未配置额外的最低 llama.cpp 版本限制。`
      : "没有可检查的 GGUF architecture。",
  };
}

async function listModelCollectionsWithRuntimeCompatibility() {
  const collections = await listModelCollections();
  const compatibilityByArch = new Map();
  const getCompatibility = async (architecture) => {
    const key = String(architecture || "").toLowerCase();
    if (!compatibilityByArch.has(key)) compatibilityByArch.set(key, getLlamaArchitectureRuntimeCompatibility(key));
    return compatibilityByArch.get(key);
  };
  const local = [];
  for (const model of collections.local || []) {
    const variants = [];
    for (const variant of model.ggufVariants || []) {
      variants.push({
        ...variant,
        runtimeCompatibility: await getCompatibility(variant.architecture),
      });
    }
    const selectedPath = model.ggufInventory?.selectedModel?.path;
    const inventory = model.ggufInventory ? {
      ...model.ggufInventory,
      models: variants,
      selectedModel: variants.find((variant) => variant.path === selectedPath) || variants[0] || null,
    } : null;
    local.push({
      ...model,
      ggufVariants: variants,
      ggufInventory: inventory,
      runtimeCompatibility: inventory?.selectedModel?.runtimeCompatibility || null,
    });
  }
  return { ...collections, local };
}

const serviceUsageStore = core.createServiceUsageStore({
  DatabaseSync,
  file: CONFIG.serviceUsageDb,
  managerId: CONFIG.managerId,
});

const serviceClientsStore = core.createServiceClientsStore({
  file: CONFIG.serviceClients,
  managerId: CONFIG.managerId,
  readJsonFile,
  writeJsonFile,
  usageStore: serviceUsageStore,
});
const serviceExposureStore = core.createServiceExposureSettingsStore({
  file: CONFIG.serviceExposureSettings,
  readJsonFile,
  writeJsonFile,
  normalizeOptions: { allowExposeOpenCode: true, exposeOpenCodeDefault: true },
});
const {
  getServiceClientsLedger,
  saveServiceClientsLedger,
  redactServiceClientsLedger,
  resolveServiceClientForApiKey,
  recordServiceClientGatewayUsage,
} = serviceClientsStore;
const {
  getServiceExposureSettings,
  saveServiceExposureSettings,
  normalizeServiceExposureSettings,
  normalizeServiceExposureSecret,
  normalizeExposureMode,
  normalizeCsvList,
  normalizeUrlText,
  redactServiceExposureSettings,
} = serviceExposureStore;

const {
  portPublishArg,
  dockerPublishArgs,
  publishArgsToDockerRunArgs,
  stripHostBrackets,
  isLoopbackHost,
  isWildcardHost,
  parseDockerPortPublish,
} = core.createDockerPublishHelpers({ containerPort: 8080, getLanAddress });

const {
  buildLlamaRuntimeCommand,
  formatDockerPublishArgs,
  planLlamaLaunch,
  redactDockerArgs,
} = createLlamaRuntimeCommandBuilder({
  getModelMountArgs: () => modelStorage.dockerMountArgs(),
  CONFIG,
  MANAGER_LABEL_KEY,
  MANAGER_ENGINE_LABEL_KEY,
  MANAGER_APIKEY_REF_LABEL_KEY,
  appendLog,
  dockerGpuArg,
  dockerPublishArgs,
  publishArgsToDockerRunArgs,
  normalizeGpuIds,
  normalizeDefaultTrueBoolean,
  windowsPathToContainerPath,
  resolveLaunchModel,
});

const jobs = new Map();
const progressTimers = new Map();
const statsSamples = new Map();
const serviceRateBuckets = new Map();
const serviceConcurrencyBuckets = new Map();
const RUNTIME_INSTANCES_CACHE_MS = Math.max(0, Number(process.env.LLAMA_RUNTIME_INSTANCES_CACHE_MS || 5000));
let runtimeInstancesCache = { value: null, expiresAt: 0, promise: null };
let automationMonitorTimer = null;
let cacheHitMonitorTimer = null;
let cacheHitMonitorBusy = false;
let cacheHitRuntimeContext = { checkedAt: 0, container: null };
let cacheHitLastWarningAt = 0;
// Busy and total slots from the last /slots poll of the primary container.
let lastSlotOccupancy = null;
let recentLaunches = [];
const MAX_RECENT_LAUNCHES = 8;
let runtimeActivity = {
  initialized: false,
  lastActivityAt: null,
  lastSeenAt: null,
  lastWarnAt: null,
  lastRequestCount: null,
  lastTokenCount: null,
  unloading: false,
};
const MAX_LOG_LINES = 200;
const MAX_PERSISTED_JOBS = 60;
const jobsLedgerStore = core.createJobsLedgerStore({
  jobs,
  file: CONFIG.jobsLedger,
  readJsonFile,
  writeJsonFile,
  maxLogLines: MAX_LOG_LINES,
  maxPersistedJobs: MAX_PERSISTED_JOBS,
  redact: runtimeSecretRedactor,
  serveDetail: "llama.cpp API 已返回模型列表。",
  stopProgressTracker,
  onJobSuccess: (job) => {
    if (job.type === "serve" && !job.meta?.skipped) recordRecentLaunch(job.meta);
    if (job.type === "download") assessDownloadedModelFit(job).catch(() => {});
  },
  onJobsChanged: () => broadcastJobsSnapshot(),
  onError: (message) => console.warn(message),
});
const statsLedgerStore = core.createStatsLedgerStore({
  file: CONFIG.statsLedger,
  readJsonFile,
  writeJsonFile,
  monotonicRuntimeCounters: true,
  claudeUsageOptions: {
    id: "claude",
    label: "Claude 兼容桥",
    defaultOk: true,
    modelFallback: "requested",
    trackSessions: false,
    compressionLast: "always",
  },
});
const {
  loadStatsLedger,
  updateStatsLedger,
  previewStatsLedger,
  recordClaudeBridgeUsage,
  flushClaudeUsageWrites,
  waitForStatsLedgerWrites,
} = statsLedgerStore;
const cacheHitTracker = createCacheHitTracker({
  file: CONFIG.cacheHitLedger,
  readJsonFile,
  writeJsonFile,
  onError: (message) => console.warn(message),
});
const AUDIT_PASSWORD_FILE = process.env.AI_AUDIT_PASSWORD_FILE || path.join(CONFIG.auditRoot, "audit-admin-password.txt");
const launchProfilesStore = core.createLaunchProfilesStore({
  file: CONFIG.launchProfiles,
  // 01 §22: written as v2 entries (flat config kept); the v1 file is saved once.
  toV2: (profile) => core.engines.legacyProfileToV2(profile, { managerId: CONFIG.managerId }),
  readJsonFile,
  writeJsonFile,
  normalizeLaunchProfile,
  defaultLaunchProfiles,
  makeProfileId: safeProfileId,
});
const automationSettingsStore = core.createAutomationSettingsStore({
  file: CONFIG.automationSettings,
  readJsonFile,
  writeJsonFile,
});
const modelNotesStore = core.createModelNotesStore({
  file: CONFIG.modelNotes,
  readJsonFile,
  writeJsonFile,
});
const claudeCompressionSettingsStore = core.createClaudeCompressionSettingsStore({
  file: CONFIG.claudeCompressionSettings,
  readJsonFile,
  writeJsonFile,
  normalizeOptions: {
    useEnv: false,
    forceMode: "cautious",
    triggerMin: 0.05,
    triggerMax: 0.98,
    recentMin: 0.05,
    recentMax: 0.98,
    summaryMin: 0.05,
    summaryMax: 0.98,
    minMessagesMin: 4,
    minMessagesMax: 40,
    includeUpdatedAt: true,
  },
});
const {
  getClaudeCompressionSettings,
  saveClaudeCompressionSettings,
  normalizeClaudeCompressionSettings,
} = claudeCompressionSettingsStore;
const AUDIT_LEGACY_PASSWORD_FILES = [
  path.join(__dirname, "logs", "audit-admin-password.txt"),
];
const auditStore = core.createAuditStore({
  auditRoot: CONFIG.auditRoot,
  auditPasswordFile: AUDIT_PASSWORD_FILE,
  legacyPasswordFiles: AUDIT_LEGACY_PASSWORD_FILES,
  openWebuiContainer: CONFIG.openWebuiContainer,
  serviceContainer: CONFIG.containerName,
  managerName: "llama-manager",
  docker,
  getContainerStatus,
});
const {
  getAuditPassword,
  verifyAuditPassword,
  createAuditSession,
  getAuditAuth,
  requireAuditAuth,
  destroyAuditSession,
  listAuditExports,
  getAuditMarkdownPath,
  exportOpenWebuiAudit,
} = auditStore;
const CLAUDE_MODEL_ALIASES = (process.env.AI_CLAUDE_MODEL_ALIASES || [
  "claude-opus-4-7",
  "claude-opus-4.7",
  "claude-sonnet-4-6",
  "claude-sonnet-4.6",
  "claude-haiku-4-5",
  "claude-haiku-4.5",
].join(",")).split(",").map((item) => item.trim()).filter(Boolean);
const OPENAI_GATEWAY_MODEL_ALIASES = (process.env.AI_OPENAI_GATEWAY_MODEL_ALIASES || "local-current,current,auto,default")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
// Third-party pricing now lives in manager-core/data/model-pricing.json, with a
// user override under <AI_ROOT>/config/. See core.loadModelPricing.
function priceProfiles() {
  return core.loadModelPricing().profiles;
}

const serviceGatewayAccessLogStore = core.createServiceGatewayAccessLogStore({
  file: CONFIG.serviceGatewayAccessLog,
  host: HOST,
  port: PORT,
  getLanAddress,
  getServiceExposureSettings,
  normalizeServiceExposureSettings,
  getContainerStatus: () => getContainerStatus(CONFIG.containerName),
  getContainerEndpoint,
  claudeBasePath: "/claude",
  parseJsonSafe,
});
const {
  appendServiceGatewayAccessLog,
  collectExternalAccessStats,
  collectRecentAccessStats,
  searchServiceGatewayAccessLogs,
  exportServiceGatewayAccessLogs,
} = serviceGatewayAccessLogStore;

const metricsHistoryStore = core.createMetricsHistoryStore({
  file: CONFIG.metricsHistory,
  engine: "llama",
  readJsonFile,
  writeJsonFile,
});

// Background stats sampler (04 TEL-1): scrapes every running instance every
// STATS_SAMPLE_INTERVAL_MS, independent of the UI. GET /api/stats reads its
// newest sample, and the stats ledger and metrics history are written from it
// once a minute.
const statsSampler = core.telemetry.createStatsSampler({
  intervalMs: core.telemetry.resolveStatsSampleIntervalMs(process.env.STATS_SAMPLE_INTERVAL_MS),
  listInstances: listStatsSampleInstances,
  scrapeInstance: scrapeStatsSampleInstance,
  onPersist: persistStatsSample,
});

// Benchmark results outlive the job ledger here so that a configuration change
// can be compared against the run that preceded it.
const benchmarkHistoryStore = core.createBenchmarkHistoryStore({
  file: CONFIG.benchmarkHistory,
  engine: "llama",
  readJsonFile,
  writeJsonFile,
});

const managerBackupStore = core.createManagerBackupStore({
  managerId: CONFIG.managerId,
  backupDir: CONFIG.managerBackups,
  readJsonFile,
  writeJsonFile,
  files: {
    launchProfiles: CONFIG.launchProfiles,
    downloadSettings: CONFIG.downloadSettings,
    modelNotes: CONFIG.modelNotes,
    automationSettings: CONFIG.automationSettings,
    serviceExposureSettings: CONFIG.serviceExposureSettings,
    serviceClients: CONFIG.serviceClients,
    claudeCompressionSettings: CONFIG.claudeCompressionSettings,
  },
});

const serviceGatewayMiddleware = core.createServiceGatewayMiddleware({
  gatewayName: "llama-manager",
  supportedKinds: ["openai", "claude", "opencode"],
  getServiceExposureSettings,
  getServiceClientsLedger,
  resolveServiceClientForApiKey,
  rateBuckets: serviceRateBuckets,
  concurrencyBuckets: serviceConcurrencyBuckets,
  appendAccessLog: appendServiceGatewayAccessLog,
  corsAllowHeaders: "authorization,content-type,x-api-key,x-requested-with",
  getGatewayOnlyMode: readGatewayOnlyMode,
  verifyAccessKey: legacyKeyForwarder ? legacyKeyForwarder.verifyAccessKey : null,
  onDirectGatewayCall: logDirectGatewayCall,
});

const { managerSecurityGuard } = core.createManagerSecurityGuard({
  host: HOST,
  getLanAddress,
  isLocalRequest,
  gatewayKinds: ["openai", "claude", "opencode"],
  allowRemoteManagement: ALLOW_REMOTE_MANAGEMENT,
  blockRemoteReads: true,
  remoteManagementError: "管理后台默认仅允许本机访问；局域网设备只能访问带 API Key 的模型网关接口。",
});

const managerLifecycle = core.createManagerLifecycle({
  app,
  getHealthExtras: gatewayTrustHealth,
  host: HOST,
  port: PORT,
  label: "llama.cpp Manager",
  pidFile: CONFIG.pidFile,
  engine: "llama",
  managerId: CONFIG.managerId,
  listenMessage: `llama.cpp Manager listening on http://${HOST}:${PORT}`,
  beforeStart: async () => {
    await ensureDirs(CONFIG.modelsRoot, CONFIG.hfCache, path.dirname(CONFIG.statsLedger), path.dirname(CONFIG.jobsLedger));
  },
  afterPreparePid: async () => {
    await loadJobsLedgerIntoMemory();
    await loadRecentLaunches().catch((error) => console.warn(`Unable to load recent launches: ${error.message}`));
    const downloadSettings = await readJsonFile(CONFIG.downloadSettings, { queueMode: false, autoRetryCount: 2, autoRetryDelaySeconds: 10 });
    downloadJobController.applyDownloadSettings(downloadSettings || {});
  },
  beforeListen: async () => {
    await billingPendingQueue.load().catch(() => {});
    billingPendingQueue.start();
    billingPendingQueue.flush().catch(() => {});
    await core.sweepStaleRollbackContainers({ docker, managerId: CONFIG.managerId }).catch(() => {});
    startAutomationMonitor();
    startCacheHitMonitor();
    startInstanceMetricsSampler();
    startStatsSampler();
  },
  onShutdown: async () => {
    jobsLedgerStore.clearJobsSaveTimer();
    await statsSampler.stop();
    if (automationMonitorTimer) clearInterval(automationMonitorTimer);
    instanceMetricsSampler.stop();
    clearInterval(idleUnloadTimer);
    if (cacheHitMonitorTimer) clearInterval(cacheHitMonitorTimer);
    for (const timer of progressTimers.values()) clearInterval(timer);
    progressTimers.clear();
    sseHub.close();
    recipeWatcher?.close();
    core.interruptRunningDownloadJobs(jobs);
    await saveJobsLedgerNow().catch((error) => console.warn(`Unable to save jobs ledger during shutdown: ${error.message}`));
    await flushClaudeUsageWrites().catch((error) => console.warn(`Unable to save Claude usage during shutdown: ${error.message}`));
    await billingPendingQueue.stop().catch(() => {});
    await Promise.allSettled([
      waitForStatsLedgerWrites(),
      cacheHitTracker.flush(),
      jobsLedgerStore.waitForJobsLedgerWrites(),
      metricsHistoryStore.flushMetricsHistory(),
      flushFileWriteQueues(),
      core.flushAllAccessLogs(),
    ]);
    serviceUsageStore.close();
  },
  exitProcessOnShutdown: require.main === module,
});
const {
  startManager,
  shutdownManager,
  buildManagerHealth,
} = managerLifecycle;

// 进程退出留痕：Ctrl+C / 控制台关闭 / 未捕获异常都会写入 logs/process-exit.log，
// 并走正常的 shutdown 流程（保存任务账本、关闭 SSE）。
if (require.main === module) {
  core.installProcessExitLogging({
    label: "llama.cpp Manager",
    file: path.join(path.dirname(CONFIG.jobsLedger), "process-exit.log"),
    onSignal: (signal) => shutdownManager(signal),
  });
}

core.registerOpenAiBaseUrlHintRoutes(app, { openAiGatewayPath: "/serve/v1" });
core.registerReferenceDataRoutes(app);
app.use(managerSecurityGuard);
app.use(core.createManagerApiSecretRedactionMiddleware({
  getSecrets: runtimeSecretList.getSecrets,
}));
app.use(express.json({ limit: "32mb" }));
app.use(["/serve/v1", "/claude", "/v1/messages", "/v1/claude", "/opencode/v1"], serviceGatewayMiddleware);
app.use("/shared-js", express.static(SHARED_PUBLIC_JS_DIR));
app.use(express.static(path.join(__dirname, "public")));

const operationalSnapshotStore = core.createManagerOperationalSnapshotStore({
  ttlMs: Number(process.env.MANAGER_OPERATIONAL_SNAPSHOT_MS || 10000),
  containerName: CONFIG.containerName,
  image: CONFIG.image,
  getDockerVersion,
  getGpuStatus,
  getContainerStatus,
  getImageStatus,
  getRunningModelSummary: (container, gpu) => getRunningModelSummary(container, gpu).catch(() => ({
    container,
    endpoint: getContainerEndpoint(container),
    servedModels: [],
    models: [],
  })),
  getManagerResourceSummary,
});
const getOperationalSnapshot = (request) => operationalSnapshotStore.getSnapshot(request);

core.registerManagerRoutes(app, {
  aiRoot: DEFAULT_AI_ROOT,
  idleUnload: {
    listSleeping: () => idleUnloadController.listSleeping(),
    saveSettings: (body) => idleUnloadController.saveSettings(body),
    wake: (id, options) => idleUnloadController.wake(id, options),
    forget: (id) => idleUnloadController.forget(id),
  },
  listBenchmarkRuns: (query) => benchmarkHistoryStore.listBenchmarkRuns(query),
  compareBenchmarkRuns: (ids, options) => benchmarkHistoryStore.compareRuns(ids, options),
  deleteBenchmarkRun: (id) => benchmarkHistoryStore.deleteBenchmarkRun(id),
  config: CONFIG,
  host: HOST,
  port: PORT,
  engine: "llama",
  jobs,
  getLanAddress,
  isLocalRequest,
  shutdownManager,
  exitProcessOnShutdownError: require.main === module,
  buildManagerHealth,
  getDockerVersion: async () => (await getOperationalSnapshot()).docker,
  getGpuStatus: async () => (await getOperationalSnapshot()).gpu,
  getContainerStatus: async () => (await getOperationalSnapshot()).container,
  getImageStatus: async () => (await getOperationalSnapshot()).image,
  getRunningModelSummary: async () => (await getOperationalSnapshot()).runtime,
  getManagerResourceSummary: async () => (await getOperationalSnapshot()).resources,
  buildMemoryEstimate: (body) => buildLlamaMemoryEstimate(body, { resolveModelPath: core.models.storageResolver({ modelStorage, modelsRoot: CONFIG.modelsRoot }) }),
  buildStatusExtras: ({ gpu }) => ({
    gpuPlan: buildLlamaGpuPlan(gpu, [], 0.92, "layer"),
  }),
  collectStats,
  collectExternalAccessStats,
  searchAccessLogs: searchServiceGatewayAccessLogs,
  exportAccessLogs: exportServiceGatewayAccessLogs,
  buildExternalAccessOptions: (query) => ({
    limit: query.limit,
    maxLines: query.maxLines,
  }),
  formatExternalAccessError: (error) => ({ ok: false, error: error.message }),
  getClaudeCompressionSettings,
  saveClaudeCompressionSettings,
  ...managerBackupStore,
});

core.registerServicePolicyRoutes(app, {
  getServiceExposureSettings,
  saveServiceExposureSettings,
  buildServiceExposurePayload,
  redactServiceClientsLedger,
  // The keys live in the entry's store; the legacy shapes come back (§6.8).
  ...(legacyKeyForwarder
    ? {
      getServiceClientsLedger: legacyKeyForwarder.getServiceClientsLedger,
      createServiceClient: legacyKeyForwarder.createServiceClient,
      updateServiceClient: legacyKeyForwarder.updateServiceClient,
      rotateServiceClientKey: legacyKeyForwarder.rotateServiceClientKey,
      deleteServiceClient: legacyKeyForwarder.deleteServiceClient,
      forwardGlobalKey: legacyKeyForwarder.forwardGlobalKey,
    }
    : {
      getServiceClientsLedger,
      createServiceClient: serviceClientsStore.createServiceClient,
      updateServiceClient: serviceClientsStore.updateServiceClient,
      rotateServiceClientKey: serviceClientsStore.rotateServiceClientKey,
      deleteServiceClient: serviceClientsStore.deleteServiceClient,
    }),
});

core.registerIntegrationRoutes(app, {
  getGpuPlan: getLlamaGpuPlanRequest,
  getClaudeSetup: buildClaudeSetupGuideRequest,
  setupClaude: buildClaudeSetupGuideRequest,
});

core.registerClaudeRoutes(app, {
  models: handleClaudeModels,
  messages: handleClaudeMessages,
  countTokens: handleClaudeCountTokens,
});
const openAiGatewayHandlers = core.createOpenAiGatewayHandlers({
  aliases: OPENAI_GATEWAY_MODEL_ALIASES,
  owner: "llama-manager",
  getRunningModelSummary,
  listRunningModelSummaries: getRunningModelSummaries,
  getUpstreamHeaders: (runtime, headers = {}) => llamaAuthHeaders(runtime.llamaApiKey, headers),
  serviceClientAllowsModel: core.serviceClientAllowsModel,
  recordUsage: recordServiceClientGatewayUsage,
  authorizeBilling: billingClient.authorize,
  settleBilling: billingClient.settle,
  enqueuePendingBilling: (event) => billingPendingQueue.enqueue(event),
  onBillingError: logBillingIntegrationIssue,
  upstreamErrorMessage,
  isExpectedStreamDisconnect,
  setAccessUsage: (req, usage) => {
    if (req) req.serviceGatewayAccessUsage = usage;
  },
});
// llama.cpp already parses its launch labels for the stats view; reuse that so
// a benchmark records the context, slots and KV precision it actually ran with.
function benchmarkConfigFromRuntime(runtime = {}) {
  const labels = runtime.container?.labels || {};
  const facts = runtimeFactsFromContainerLabels(labels);
  return {
    engine: "llama.cpp",
    runtimeImage: runtime.container?.image || "",
    maxModelLen: facts.maxModelLen,
    maxNumSeqs: facts.maxNumSeqs,
    gpuLayers: facts.gpuLayers,
    tensorSplit: facts.tensorSplit,
    cacheTypeK: facts.cacheTypeK,
    cacheTypeV: facts.cacheTypeV,
    speculativeMode: facts.speculativeMode,
    gpuIds: String(labels["ai.manager.gpu-ids"] || "") || null,
    gpuMemoryUtilization: Number(labels["ai.manager.gpu-memory-utilization"]) || null,
  };
}

const benchmarkRunner = core.createBenchmarkRunner({
  defaultPort: CONFIG.defaultPort,
  defaultPrompt: "用中文简要说明本地 llama.cpp 模型是否可以稳定完成工具调用、长上下文和代码任务。",
  runtimeLabel: "llama.cpp",
  requestDetail: "Sending chat completion request to local llama.cpp.",
  getRunningModelSummary,
  getHeaders: (runtime) => llamaAuthHeaders(runtime.llamaApiKey),
  upstreamErrorMessage,
  appendLog,
  setJobProgress,
  finishJob,
  recordBenchmark: (benchmark, context) => benchmarkHistoryStore.recordBenchmarkRun(benchmark, {
    label: context.label,
    config: benchmarkConfigFromRuntime(context.runtime),
  }),
});
const {
  normalizeBenchmarkRequest,
  runBenchmarkJob,
} = benchmarkRunner;
app.get("/serve/v1/models", openAiGatewayHandlers.handleModels);
app.get("/serve/v1/props", openAiGatewayHandlers.handleProps);
app.post("/serve/v1/chat/completions", openAiGatewayHandlers.handleChatCompletions);
app.post("/serve/v1/completions", openAiGatewayHandlers.handleCompletions);
app.post("/serve/v1/responses", openAiGatewayHandlers.handleResponses);
app.post("/serve/v1/embeddings", openAiGatewayHandlers.handleEmbeddings);
app.post("/serve/v1/pooling", openAiGatewayHandlers.handlePooling);
app.post("/serve/v1/score", openAiGatewayHandlers.handleScore);
app.get("/opencode/v1/models", openAiGatewayHandlers.handleModels);
app.post("/opencode/v1/chat/completions", openAiGatewayHandlers.handleChatCompletions);
app.post("/serve/v1/rerank", openAiGatewayHandlers.handleRerank);
app.post("/serve/v1/classify", openAiGatewayHandlers.handleClassify);

core.registerModelStorageRoutes(app, { storage: modelStorage, migration: modelMigration, isLocalRequest, publicDir: path.join(__dirname, "..", "shared-public") });

core.registerModelRoutes(app, {
  listModels: listModelCollectionsWithRuntimeCompatibility,
  searchRemoteModels: remoteModelService.searchRemoteModelCatalog,
  startDownload: startDownloadRequest,
  estimateDownload: estimateDownloadRequest,
  checkPort: checkPortRequest,
  getRecentLaunches: () => ({ launches: recentLaunches }),
  getDownloadSettings: () => downloadJobController.getDownloadSettings(),
  saveDownloadSettings: saveDownloadSettingsRequest,
  resolveModelLink: remoteModelService.resolveModelLinkRequest,
  probeDownloadMirror: (body = {}) => core.probeHfMirrorSpeed({ model: body.model, token: process.env.HF_TOKEN }),
  getDiskUsage: () => runtimeSnapshotCache.get("disk-usage", () => modelFilesystemStore.getDiskUsage(), { ttlMs: 30_000 }),
  cleanupIncomplete: cleanupIncompleteRequest,
  checkModelUpstream: checkModelUpstreamRequest,
  precheckDownload: precheckDownloadRequest,
  listGgufVariants: listGgufVariantsRequest,
  listPrecisionVariants: listPrecisionVariantsRequest,
  describeCapabilityData: describeCapabilityDataRequest,
});

// 下载前预检：远端 config.json + 文件清单过一遍能力矩阵 / 运行时清单 / GPU。
async function precheckDownloadRequest(query = {}) {
  const source = cleanDownloadSource(query.source || "huggingface");
  const reference = normalizeDownloadModelReference(query.model, query.precision);
  if (!reference.model) {
    const error = new Error("model is required");
    error.status = 400;
    throw error;
  }
  const [estimate, remoteConfig, gpu] = await Promise.all([
    source === "huggingface"
      ? remoteModelService.getHuggingFaceDownloadEstimate(reference.model, reference.precision).catch((error) => ({ error: error.message }))
      : Promise.resolve(null),
    remoteModelService.fetchRemoteModelConfig(reference.model, source).catch((error) => ({ ok: false, reason: error.message })),
    getGpuStatus().catch(() => null),
  ]);
  const primaryGpu = gpu?.gpus?.[0] || null;
  // Every selected GPU is judged (query gpus=0,1), not only the first.
  const wantedGpus = String(query.gpus ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const selectedGpus = (gpu?.gpus || []).filter((item) => !wantedGpus.length || wantedGpus.includes(String(item.index ?? item.id)));
  const assessment = core.assessDownloadCompatibility({
    engine: "llama",
    model: reference.model,
    source,
    precision: reference.precision,
    config: remoteConfig?.ok ? remoteConfig.config : null,
    siblings: estimate?.siblings || [],
    bytes: estimate?.bytes || null,
    gated: Boolean(estimate?.gated),
    runtime: { ...LLAMA_RUNTIME_RELEASE, version: `b${DEFAULT_LLAMA_IMAGE_BUILD}`, build: DEFAULT_LLAMA_IMAGE_BUILD },
    gpu: primaryGpu ? { computeCap: primaryGpu.computeCap, totalMb: primaryGpu.totalMb } : null,
    gpus: selectedGpus.map((item) => ({ id: String(item.index ?? item.id ?? ""), computeCap: item.computeCap, totalMb: item.totalMb })),
  });
  return {
    ...assessment,
    source,
    remoteConfig: { ok: Boolean(remoteConfig?.ok), status: Number(remoteConfig?.status || 0), reason: remoteConfig?.reason || "" },
    estimateError: estimate?.error || "",
  };
}

async function listGgufVariantsRequest(query = {}) {
  const source = cleanDownloadSource(query.source || "huggingface");
  const reference = normalizeDownloadModelReference(query.model, query.precision);
  if (!reference.model) {
    const error = new Error("model is required");
    error.status = 400;
    throw error;
  }
  if (source !== "huggingface") return { model: reference.model, source, supported: false, variants: [], mmproj: [], drafts: [] };
  const [estimate, gpu] = await Promise.all([
    remoteModelService.getHuggingFaceDownloadEstimate(reference.model, ""),
    getGpuStatus().catch(() => null),
  ]);
  const listing = core.listGgufVariants(estimate.siblings || [], { gpuTotalMb: gpu?.gpus?.[0]?.totalMb || gpu?.totalMb || 0 });
  return {
    model: reference.model,
    source,
    supported: true,
    gated: Boolean(estimate.gated),
    selected: reference.precision || "",
    ...listing,
    variants: listing.variants.map((variant) => ({ ...variant, files: variant.files.slice(0, 12) })),
  };
}

async function listPrecisionVariantsRequest(query = {}) {
  const reference = normalizeDownloadModelReference(query.model, query.precision);
  if (!reference.model) {
    const error = new Error("model is required");
    error.status = 400;
    throw error;
  }
  const candidates = await remoteModelService.listHuggingFaceRepositories(core.baseNameOf(reference.model), 80).catch(() => []);
  return core.groupPrecisionVariants(reference.model, [{ id: reference.model }, ...candidates], {});
}

function describeCapabilityDataRequest() {
  const mirrors = core.loadRepoMirrors();
  return {
    runtimeManifest: core.describeRuntimeManifest(),
    capabilityMatrix: core.describeModelCapabilityMatrix(),
    repoMirrors: { asOf: mirrors.value?.asOf || "", source: mirrors.source, userPath: mirrors.userPath, freshness: mirrors.freshness },
  };
}

// The download requests live in createDownloadRequestHandlers below; these
// wrappers keep the hoisted names the routes were registered with.
async function inspectDownloadResumeRequest(job) {
  return downloadRequests.inspectDownloadResume(job);
}

async function cleanupIncompleteRequest(body = {}) {
  return downloadRequests.cleanupIncomplete(body);
}

async function checkModelUpstreamRequest(query = {}) {
  return downloadRequests.checkModelUpstream(query);
}

async function checkPortRequest(query = {}) {
  const port = Number(query.port || 0);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    const error = new Error("端口必须是 1024-65535 的整数。");
    error.status = 400;
    throw error;
  }
  return checkPortAvailability(port);
}

async function checkPortAvailability(port, targetContainerName = CONFIG.containerName) {
  const containers = await listManagedContainers().catch(() => []);
  const ownName = normalizeDockerContainerName(targetContainerName);
  const conflict = containers.find((container) => parseDockerPortPublish(container.ports)?.port === port);
  if (conflict) {
    return {
      port,
      available: false,
      reason: "container",
      detail: `端口已被托管容器 ${conflict.name}（${conflict.engine || conflict.manager || "未知引擎"}）占用。`,
      containerName: conflict.name,
      isOwnContainer: conflict.name === ownName,
    };
  }
  const osInUse = await isPortInUseOnHost(port);
  if (osInUse) return { port, available: false, reason: "os", detail: `端口 ${port} 已被本机其它进程占用。` };
  return { port, available: true, detail: `端口 ${port} 可用。` };
}

function isPortInUseOnHost(port) {
  const probe = (host) => new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", (error) => {
      tester.close();
      resolve(error.code === "EADDRINUSE" || error.code === "EACCES");
    });
    tester.once("listening", () => tester.close(() => resolve(false)));
    tester.listen(port, host);
  });
  return Promise.all([probe("127.0.0.1"), probe("0.0.0.0")]).then((results) => results.some(Boolean));
}

// 任务快照改推送：下载/启动进行中不再靠 1 秒一次的 /api/jobs 轮询。
const sseHub = core.createSseHub();
app.get("/api/events", (req, res) => sseHub.handleRequest(req, res));
function broadcastJobsSnapshot() {
  sseHub.broadcastThrottled("jobs", () => Array.from(jobs.values()).reverse().map(core.summarizeJob), 700);
}

core.registerJobRoutes(app, {
  jobs,
  beforeReadJobs: () => healDownloadQueue(),
  cancelDownloadJob: (job) => cancelDownloadJob(job),
  pauseDownloadJob: (job) => pauseDownloadJob(job),
  resumeDownloadJob: (job) => resumeDownloadJob(job),
  inspectDownloadResume: (job) => inspectDownloadResumeRequest(job),
  cancelNonDownloadJob: async (_req, res, job) => {
    if (job.status !== "running" && job.status !== "queued") return res.status(400).json({ error: "任务已结束，无法取消。" });
    try {
      if (typeof job.cancel === "function") {
        job.cancel();
      } else if (job.type === "serve") {
        markJobCancelRequested(job, "cancel");
        const targetContainerName = job.meta?.containerName || CONFIG.containerName;
        if (job.meta?.runtimeLaunchStarted) {
          await removeManagedContainer("cancel", targetContainerName, job.id).catch((error) => {
            appendLog(job, `取消时未删除容器：${error.message}`);
          });
        }
        failJob(job, new Error(job.meta?.runtimeLaunchStarted ? "启动已被用户取消" : "排队中的启动已被用户取消"));
      } else {
        return res.status(400).json({ error: "该任务类型不支持取消。" });
      }
      return res.json({ ok: true, id: job.id, status: job.status });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },
});

async function startDownloadRequest(body = {}) {
  return downloadRequests.startDownload(body);
}

// HF download tokens are memory-only (08 P0-9, 00 §9.4). A job records only
// meta.transfer.tokenRef; a manager restart forgets every token, so a gated
// resume then fails cleanly with hf_token_expired. Nothing here touches the
// runtime secret store or the disk.
function createDownloadTokenStore({ onChange = () => {}, randomBytes = crypto.randomBytes } = {}) {
  const tokens = new Map();
  return {
    register(token) {
      const ref = `dlt_${randomBytes(16).toString("hex")}`;
      tokens.set(ref, String(token));
      onChange();
      return ref;
    },
    resolve(ref) {
      return tokens.get(String(ref || "")) || null;
    },
    release(ref) {
      if (tokens.delete(String(ref || ""))) onChange();
    },
    values() {
      return tokens.values();
    },
    get size() {
      return tokens.size;
    },
  };
}

// Disk usage lists every configured root, default first (08 P0-11).
async function listModelStorageRoots(storage) {
  const snapshot = await storage.snapshot();
  return (snapshot.roots || []).map((root) => ({
    id: root.id,
    path: root.path,
    label: root.label || root.id,
    mode: root.mode,
    default: root.id === snapshot.defaultRootId,
    legacy: root.id === "legacy",
  }));
}

function createHfAccessError(model, status) {
  const error = new Error(`Hugging Face 授权检查未通过（${status}）。请登录 hf CLI，并在 https://huggingface.co/${model} 确认模型访问授权后重试。`);
  error.status = 409;
  error.code = `hf_${status}`;
  return error;
}

function filterNoMatchError(precision, totalFiles) {
  const { hint } = describeDownloadError("filter_no_match");
  const error = new Error(`${hint.zh} / ${hint.en}`);
  error.status = 422;
  error.code = "filter_no_match";
  error.details = { precision: precision || "", totalFiles: Number.isInteger(totalFiles) ? totalFiles : null };
  return error;
}

function pathOutsideRootsError() {
  const error = new Error("路径必须位于已登记的模型库内，且不能是模型库本身。 / The path must be inside a configured model library and must not be the library itself.");
  error.status = 400;
  error.code = "path_outside_roots";
  return error;
}

async function readDownloadMarker(localDir) {
  try {
    const text = await fsp.readFile(path.join(localDir, ".platform-download.json"), "utf8");
    const value = JSON.parse(text.replace(/^﻿/, ""));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// Download requests (08 P0-9, P0-10, P0-11), built from injected services so
// their rules can be tested with fake remote services and temp storage.
function createDownloadRequestHandlers(deps = {}) {
  const {
    modelsRoot,
    hfCache,
    modelStorage: storage,
    remoteModelService: remote,
    hfAuthService: hfAuth,
    downloadTokens,
    getJobs = () => [],
    getDownloadSettings = () => ({}),
    enqueueOrStartDownload: enqueue,
    buildDownloadCommand: buildCommand,
    getDiskFreeBytes = async () => null,
    cleanupIncompleteFiles,
    invalidateDiskUsage = () => {},
    appendLog: log = () => {},
    redact = (text) => text,
    createAccessError = createHfAccessError,
    ensureDirectories = ensureDirs,
    fileExists = fs.existsSync,
    readMarker = readDownloadMarker,
    statfs,
    env = process.env,
  } = deps;

  // A model directory named by `path` (inside any configured root) or by
  // `name` (a folder of the legacy models root, as before). Either must
  // resolve inside a root and must not be the root itself.
  function resolveModelDirectory(input = {}) {
    let target = String(input.path || "").trim();
    if (!target) {
      const name = cleanRequired(input.name, "name");
      target = path.isAbsolute(name) ? name : path.join(modelsRoot, safeOutputName(name));
    }
    try {
      return storage.resolvePath(target, { allowRoot: false });
    } catch (error) {
      // An offline library is not a bad path; it keeps its 503.
      if (Number(error?.status) === 503) throw error;
      throw pathOutsideRootsError();
    }
  }

  function findDownloadJob(localDir, statuses = null) {
    const key = core.normalizeLocalDirKey(localDir);
    return Array.from(getJobs())
      .filter((job) => job.type === "download"
        && (!statuses || statuses.includes(job.status))
        && core.normalizeLocalDirKey(job.meta?.localDir) === key)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
  }

  async function startDownload(body = {}) {
    const requestedModel = cleanRequired(body.model, "model");
    const source = cleanDownloadSource(body.source || "huggingface");
    const reference = normalizeDownloadModelReference(requestedModel, body.precision);
    const model = reference.model;
    const precision = reference.precision;
    const outputName = safeOutputName(body.outputName || model.replace(/[\\/]/g, "__"));
    const localDir = storage.downloadTarget(body.storageId, outputName);
    // An HF token is only for an HF download, which then uses the official endpoint.
    const hfToken = source === "huggingface" && body.hfToken ? String(body.hfToken) : "";

    const includeExtras = core.normalizeExtraIncludePatterns(body.includeExtras);
    // An unreachable huggingface.co must not block a download the mirror can
    // serve: a failed estimate only loses the size, disk and gated checks, and
    // a gated repository then fails with a classified hf_approval_required.
    const repository = source === "huggingface"
      ? await remote.getHuggingFaceDownloadEstimate(model, precision, includeExtras)
        .catch((error) => ({ error: redact(String(error?.message || error)) }))
      : null;
    // An include filter that matches nothing would "succeed" with no weights.
    if (repository?.filtered && repository.matchedFiles === 0) throw filterNoMatchError(precision, repository.totalFiles);
    await ensureDirectories(modelsRoot, hfCache);
    if (repository?.gated) {
      const access = await hfAuth.checkRepoAccess(model, {
        token: body.hfToken,
        probeFile: repository.probeFile,
      });
      if (!access.granted) throw createAccessError(model, access.status, repository.authorizationUrl);
    }

    const downloadSettings = getDownloadSettings() || {};
    const forceOfficialHf = source === "huggingface" && (Boolean(repository?.gated) || Boolean(hfToken));
    // Recorded once at enqueue, so resume and auto-retry keep this endpoint
    // and these flags; the token stays in the in-memory map.
    const transfer = core.normalizeDownloadTransfer({
      hfMirror: forceOfficialHf ? false : Boolean(downloadSettings.hfMirror),
      hfTransfer: Boolean(downloadSettings.hfTransfer),
      gated: Boolean(repository?.gated),
    });

    const download = buildCommand(source, model, localDir, { precision, extraIncludePatterns: includeExtras });
    if (!download.command || ((String(download.command).includes("/") || String(download.command).includes("\\")) && !fileExists(download.command))) {
      throw core.missingDownloadCliError(download.command, source);
    }
    const expected = repository;
    const diskFreeBytes = await getDiskFreeBytes(path.dirname(localDir));
    core.assertDownloadDiskSpace(expected?.bytes, diskFreeBytes, formatBytes);
    storage.assertUnlocked([localDir]);
    storage.prepareDownload(localDir, { model, source, precision });
    const tokenRef = hfToken ? downloadTokens.register(hfToken) : null;
    const downloadEnv = core.buildDownloadEnv(hfCache, env, {
      source,
      hfMirror: transfer.hfMirror,
      hfEndpoint: transfer.hfEndpoint,
      hfTransfer: transfer.hfTransfer,
      gated: transfer.gated,
      token: hfToken || null,
    });
    let job;
    try {
      job = enqueue(download.command, download.args, {
        env: downloadEnv,
        title: `Download ${model} (${download.label})`,
        meta: {
          model,
          outputName,
          localDir,
          source,
          precision,
          includeExtras: includeExtras.length ? includeExtras : undefined,
          priority: core.normalizeDownloadPriority(body.priority),
          expectedBytes: expected?.bytes || null,
          // 0 stays 0; null means unknown (the estimate failed or not HF).
          expectedFiles: Number.isInteger(expected?.fileCount) ? expected.fileCount : null,
          fileManifest: source === "huggingface" && Array.isArray(repository?.fileManifest) && repository.fileManifest.length
            ? repository.fileManifest
            : null,
          transfer: { ...transfer, tokenRef },
        },
        progressDir: localDir,
        expectedBytes: expected?.bytes || null,
      });
    } catch (error) {
      if (tokenRef) downloadTokens.release(tokenRef);
      throw error;
    }
    if (expected?.bytes) {
      log(job, `Estimated download size: ${formatBytes(expected.bytes)} across ${expected.fileCount} files.`);
    } else if (expected?.error) {
      log(job, `Download size estimate unavailable: ${expected.error}`);
    }
    if (source === "modelscope") log(job, "ModelScope source uses the local modelscope CLI with proxy env disabled.");
    if (download.includePatterns?.length) log(job, `Download include filter: ${download.includePatterns.join(", ")}`);
    return { job };
  }

  // 只清 .incomplete 残留；有仍会续传的下载任务（运行/排队/暂停）时拒绝。
  async function cleanupIncomplete(body = {}) {
    const localDir = resolveModelDirectory(body);
    const activeJob = findDownloadJob(localDir, ["running", "queued", "paused"]);
    if (activeJob) {
      const error = new Error(`任务 ${activeJob.id} 仍可能续传该目录（${activeJob.status}），暂不清理。`);
      error.status = 409;
      throw error;
    }
    const result = await cleanupIncompleteFiles(localDir);
    invalidateDiskUsage();
    return result;
  }

  // 对比本地下载记录与 Hugging Face 上游 lastModified，判断是否有更新。没有
  // 下载任务记录时，回退到 prepareDownload 写下的 .platform-download.json。
  async function checkModelUpstream(query = {}) {
    const localDir = resolveModelDirectory(query);
    const name = String(query.name || "").trim() || path.basename(localDir);
    const downloadJob = findDownloadJob(localDir);
    const marker = downloadJob ? null : await readMarker(localDir);
    const record = downloadJob
      ? { model: downloadJob.meta?.model, source: downloadJob.meta?.source, downloadedAt: downloadJob.finishedAt || downloadJob.updatedAt || null, recordSource: "job" }
      : marker
        ? { model: marker.model, source: marker.source, downloadedAt: marker.createdAt || null, recordSource: "marker" }
        : { recordSource: "request" };
    const repo = String(query.model || record.model || "").trim();
    if (!repo || !repo.includes("/")) {
      return { ok: false, name, path: localDir, reason: "unknown_source", message: "没有找到该目录的下载记录，无法确定上游仓库；可在请求中显式提供 model。" };
    }
    if (String(record.source || "huggingface") !== "huggingface") {
      return { ok: false, name, path: localDir, repo, reason: "unsupported_source", message: "上游更新检查目前只支持 Hugging Face 来源。" };
    }
    const info = await remote.getHuggingFaceModelInfo(repo);
    const downloadedAt = record.downloadedAt || null;
    const updateAvailable = info.lastModified && downloadedAt
      ? Date.parse(info.lastModified) > Date.parse(downloadedAt)
      : null;
    return {
      ok: true,
      name,
      path: localDir,
      repo,
      url: info.url,
      lastModified: info.lastModified || null,
      downloadedAt,
      recordSource: record.recordSource,
      updateAvailable,
      message: updateAvailable === null
        ? "缺少可比对的时间信息，仅显示上游最近更新时间。"
        : updateAvailable
          ? "上游仓库在本地下载之后有更新，可重新下载获取新版本。"
          : "本地已是最新：上游在下载之后没有更新。",
    };
  }

  // No diskFreeBytes: the check measures the disk that holds the job's own
  // directory, not the default root's.
  async function inspectDownloadResume(job) {
    return core.inspectDownloadResume({
      localDir: job.meta?.localDir,
      fileManifest: job.meta?.fileManifest || [],
      expectedBytes: job.meta?.expectedBytes || 0,
      ...(typeof statfs === "function" ? { statfs } : {}),
    });
  }

  return { startDownload, cleanupIncomplete, checkModelUpstream, inspectDownloadResume, resolveModelDirectory };
}

async function estimateDownloadRequest(query = {}) {
  const source = cleanDownloadSource(query.source || "huggingface");
  const reference = normalizeDownloadModelReference(query.model, query.precision);
  if (!reference.model) {
    const error = new Error("model is required");
    error.status = 400;
    throw error;
  }
  const diskFreeBytes = await getModelsDiskFreeBytes(path.dirname(modelStorage.downloadTarget(query.storageId, "estimate-target")));
  if (source !== "huggingface") {
    return { source, model: reference.model, bytes: null, fileCount: null, supported: false, diskFreeBytes };
  }
  const estimate = await remoteModelService.getHuggingFaceDownloadEstimate(reference.model, reference.precision, query.includeExtras);
  return {
    source,
    model: reference.model,
    precision: reference.precision || "",
    bytes: estimate.bytes,
    fileCount: estimate.fileCount,
    includePatterns: estimate.includePatterns || [],
    filtered: Boolean(estimate.filtered),
    matchedFiles: estimate.matchedFiles ?? estimate.fileCount ?? null,
    totalFiles: estimate.totalFiles ?? null,
    supported: true,
    diskFreeBytes,
  };
}

async function getModelsDiskFreeBytes(target = CONFIG.modelsRoot) {
  try {
    const stat = await fsp.statfs(target);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

async function saveDownloadSettingsRequest(body = {}) {
  return downloadJobController.saveDownloadSettings(body);
}

async function getLlamaGpuPlanRequest({ query = {} } = {}) {
  const gpu = await getGpuStatus();
  const gpuDeviceIds = normalizeGpuIds(query.gpuDeviceIds || query.devices || "");
  const utilization = Number(query.gpuMemoryUtilization || query.utilization || 0.92);
  const mode = normalizeLlamaSplitMode(query.multiGpuMode || query.splitMode || "layer");
  return buildLlamaGpuPlan(gpu, gpuDeviceIds, utilization, mode, query.mainGpu);
}

async function buildClaudeSetupGuideRequest() {
  const guide = await buildConnectionGuide();
  return {
    ok: true,
    manager: guide.manager,
    claude: guide.claude,
    ccswitch: guide.ccswitch,
    note: "Claude Desktop / ccswitch 使用 Claude 兼容地址；工具 schema 会桥接为 OpenAI tools。",
  };
}

const runtimeStopHandlers = core.createRuntimeStopHandlers({
  managerName: "llama-manager",
  containerName: CONFIG.containerName,
  getRunningModelSummary,
  stopRuntime: stopVllmContainer,
  exportAudit: exportOpenWebuiAudit,
  unloadNote: "llama.cpp server does not hot-unload a model from the current server process; this stops only the llama.cpp container managed by this tool.",
});
const {
  stopRuntimeRequest,
  unloadRunningModelRequest,
} = runtimeStopHandlers;

const runtimeRequestHandlers = core.createRuntimeRequestHandlers({
  dockerRuntime,
  docker,
  containerName: CONFIG.containerName,
  defaultPort: CONFIG.defaultPort,
  dockerStartTimeoutMs: 90000,
  defaultTail: 200,
  cleanRequired,
  prompt: "Reply with exactly: llama.cpp OK",
  // GET /api/logs?instance= reads only containers this manager owns (08 P0-3).
  resolveLogContainer: core.createOwnedRuntimeContainerResolver({
    primaryContainerName: CONFIG.containerName,
    managerId: CONFIG.managerId,
    ownerLabelKey: MANAGER_LABEL_KEY,
    isRuntimeContainer: (container) => instanceCatalog.isHosted(container),
    getContainerStatus: (name) => getContainerStatus(name),
    listManagedContainers: () => listManagedContainers(),
  }),
});
const {
  startDockerDesktopRequest,
  readRuntimeLogsRequest,
  testRuntimeCompletionRequest,
} = runtimeRequestHandlers;

const startRuntimeRequest = createLlamaStartRuntimeRequest({
  resolveRequestedModel: value => { const input = modelStorage.fromContainerPath(value); if (!path.isAbsolute(input)) return input; const resolved = modelStorage.resolvePath(input); modelStorage.assertUnlocked([resolved]); return resolved; },
  CONFIG,
  cleanRequired,
  deriveName,
  positiveInt,
  normalizeGpuLayers,
  normalizeLlamaCacheType,
  normalizeOnOffAuto,
  normalizeLaunchGpuSelection,
  normalizeGpuIds,
  normalizeLlamaSplitMode,
  cleanOptionalLaunchArg,
  normalizeClientPreset,
  normalizeLlamaReasoningFormat,
  normalizeLlamaReasoningEffort,
  normalizeLlamaReasoningBudget,
  normalizeLlamaMmprojDevice,
  normalizeDefaultTrueBoolean,
  normalizeNetworkAccess,
  getLanAddress,
  getGpuStatus,
  buildLlamaGpuPlan,
  suggestTensorSplit,
  createJob,
  runStartJob,
  failJob,
  acquireGpuAdmission: gpuAdmissionController.acquire,
  acquireGpuAdmissionAfterPrepare: gpuAdmissionController.acquireAfterPrepare,
  reportGpuAdmissionError: (job, error) => appendLog(job, `GPU admission lease warning: ${error.message}`),
  saveRuntimeApiKey: (apiKey) => runtimeApiKeyStore.set(apiKey),
  deleteRuntimeApiKey: (reference) => runtimeApiKeyStore.remove(reference),
  normalizeRuntimeInstanceMode: core.normalizeRuntimeInstanceMode,
  normalizeRuntimeInstanceId: core.normalizeRuntimeInstanceId,
  buildRuntimeContainerName: core.buildRuntimeContainerName,
  resolveLaunchModel,
  validateRuntimeCompatibility: getLlamaArchitectureRuntimeCompatibility,
  appendLog,
  // Launch plan (ENG-7): /api/start and POST /api/launch/plan resolve through the
  // same plan. The getters are read per request (the registry, the recipe store
  // and the engine routes are created further down).
  getEngineRegistry: () => engineRegistry,
  getRecipeStore: () => recipeStore,
  // The command preview: the adapter input runStartJob builds from these run
  // options; the plan carries the recipe the wrapper applied.
  prepareLaunchCommand: (runOptions, { jobId, prospective }) => {
    const { plan, ctx } = planLlamaLaunch({ id: jobId, meta: {} }, prospective ? { ...runOptions, prospective: true } : runOptions);
    return { adapter: core.engines.adapters.llamacpp, plan, ctx, recipe: plan.recipe || null };
  },
  getHostGpus: async () => {
    const status = await getGpuStatus();
    // runStartJob builds with the probe's GPU list the same way.
    return Array.isArray(status?.gpus) ? status.gpus : null;
  },
  imagePresence: (image) => engineRoutes?.presence?.present(image) ?? null,
  admissionPreview: (request, options) => gpuAdmissionController.evaluate(request, options),
  listContainers: () => listManagedContainers(),
  // fromLaunchId (ENG-26): the stored spec POST /api/launch replays.
  getLaunchSpec: (launchId) => launchStore.get(launchId),
  getIntrospection: async (runtime) => (await engineRoutes?.runtimeFacts?.get(runtime.runtimeId))?.flags || null,
  modelStorage,
  // 02 MOD-9b: modelFacts (artifact inputs for the plan's memory) and calibrationFor (null until MOD-10).
  ...core.models.managerHooks({ managerId: "llama", dataDir: path.join(__dirname, "data"), gpuStatus: getGpuStatus, modelStorage, modelsRoot: CONFIG.modelsRoot }),
});

// Idle runtimes hold their weights and KV pool for nothing. The controller
// releases them and keeps the launch configuration so the same runtime can be
// brought back; the recent-launch record is the fallback source for a
// configuration when an instance was started before this feature existed.
const idleUnloadController = core.createIdleUnloadController({
  settingsFile: CONFIG.idleUnloadSettings,
  sleepFile: CONFIG.idleUnloadSleeping,
  engine: "llama",
  readJsonFile,
  writeJsonFile,
  listInstances: async () => {
    const result = await listRuntimeInstancesRequest();
    return (result.instances || []).map((instance) => ({
      id: instance.id,
      containerName: instance.containerName,
      model: instance.models?.[0]?.id || "",
      name: instance.models?.[0]?.root || instance.id,
      engine: instance.engine,
      running: Boolean(instance.running),
      requestsTotal: Number(instance.requestsTotal || 0),
      activeRequests: Number(instance.activeRequests || 0),
      queuedRequests: Number(instance.queuedRequests || 0),
      vramReservationMb: Number(instance.vramReservationMb || 0),
      instanceMode: instance.instanceMode,
      launchConfig: null,
    }));
  },
  stopInstance: (instance) => stopRuntimeInstanceRequest({ id: instance.id }),
  readLegacySettings: () => automationSettingsStore.getAutomationSettings(),
  log: (message) => console.log(`[idle-unload] ${message}`),
  // Wake (08 P0-1): the launch record is matched by container, path, then
  // served name; the API key is kept across sleep in the runtime secret store;
  // a wake never replaces a running model without the explicit confirm.
  ...core.createIdleWakeHooks({
    managerId: CONFIG.managerId,
    primaryContainerName: CONFIG.containerName,
    managerLabelKey: MANAGER_LABEL_KEY,
    apiKeyRefLabelKey: MANAGER_APIKEY_REF_LABEL_KEY,
    apiKeyLabelKey: MANAGER_APIKEY_LABEL_KEY,
    listRecentLaunches: () => recentLaunches,
    // 01 ENG-8: the wake plan comes from LaunchStore (launch-id label first).
    launchStore,
    jobsLedgerLookup: (jobId) => jobs.get(jobId) || null,
    getContainerStatus: (containerName) => getContainerStatusFresh(containerName),
    secretStore: runtimeApiKeyStore,
    startRuntimeRequest: (request) => startRuntimeRequest(request),
    toContainerPath: (value) => windowsPathToContainerPath(value),
  }),
});

// One check a minute is enough resolution for a timeout measured in tens of
// minutes, and it keeps the Docker/metrics cost negligible.
const idleUnloadTimer = setInterval(() => {
  idleUnloadController.tick().catch((error) => console.warn(`[idle-unload] ${error.message}`));
}, 60_000);
idleUnloadTimer.unref?.();

core.registerRuntimeRoutes(app, {
  startRuntime: startRuntimeRequest,
  startDockerDesktop: startDockerDesktopRequest,
  stopRuntime: stopRuntimeRequest,
  unloadRunningModel: unloadRunningModelRequest,
  readRuntimeLogs: readRuntimeLogsRequest,
  redactLogs: runtimeSecretRedactor,
  testRuntimeCompletion: testRuntimeCompletionRequest,
  listRuntimeInstances: listRuntimeInstancesRequest,
  stopRuntimeInstance: stopRuntimeInstanceRequest,
});

// Engine registry (docs/overhaul/01-engines.md ENG-2): GET /api/engines lists the
// engines this manager hosts with their manifest runtimes, and the descriptor
// validator checks drafts without writing anything. Image presence uses the
// uncached inspect behind the route's own 60 s cache. GET /api/engines/:id/schema
// (ENG-3) serves the parameter catalog with host facts from the cached GPU probe.
const engineRegistry = core.engines.createEngineRegistry({ env: process.env });
// Recipes as data (ENG-6): the same bundled recipes and <AI_ROOT>/config/recipes
// the vllm manager loads; this manager runs the llama.cpp ones and its builtin
// launch profiles. POST /api/recipes/reload re-reads them and the watcher
// started with the manager picks up hand edits.
const recipeStore = core.engines.createRecipeStore({ registry: engineRegistry });
let recipeWatcher = null;
// Per-instance engine metrics (ENG-14): the sampler scrapes each running
// instance's /metrics every 10 s in the background, and
// GET /api/instances/:id/metrics serves its latest snapshot, so the route never
// scrapes an engine or calls Docker. /api/stats keeps its own scrape path.
// llama.cpp's derived inputs (descriptor metricsMap) come from the /slots
// poll the cache-hit monitor already runs: slot occupancy for kvUsageRatio
// and the tracker's cumulative cached tokens for cachedPromptTokensTotal.
const instanceMetricsSampler = core.engines.metrics.createInstanceMetricsSampler({
  registry: engineRegistry,
  managerId: "llama",
  ownerLabelValue: CONFIG.managerId,
  primaryContainerName: CONFIG.containerName,
  listContainers: listMetricsSamplerContainers,
  endpointFor: (container) => getContainerEndpoint(container),
  headersFor: (container) => llamaAuthHeaders(getLlamaApiKey(container)),
  getDerivedInputs: metricsDerivedInputs,
  adapterFor: core.engines.adapterFor,
});
// Typed instances (ENG-13): which containers are instances (registry.hostedBy, plus
// unknown engines, which stay listed and stoppable) and the 00 §4.1 fields.
const instanceCatalog = core.engines.createInstanceCatalog({
  registry: engineRegistry,
  managerId: "llama",
  launchStore,
  getJob: (jobId) => jobs.get(jobId) || null,
  listSleeping: () => idleUnloadController.listSleeping(),
});

// One instance of GET /api/instances by id, with its container and the state
// LaunchStore resolves records from. Running and stopped containers only.
async function findRuntimeInstance(id) {
  const summaries = await getRunningModelSummaries();
  for (const runtime of summaries) {
    const legacy = legacyRuntimeInstance(runtime);
    if (legacy.id !== id && legacy.containerName !== id) continue;
    const container = runtime.container || {};
    return { instance: { ...legacy, ...instanceCatalog.typed(legacy, container) }, container, state: instanceCatalog.stateOf(legacy, container) };
  }
  return null;
}

const engineRoutes = core.engines.registerEngineRoutes(app, {
  registry: engineRegistry,
  recipeStore,
  // GET /api/instances/:id/logs|launch and POST /api/instances/:id/relaunch (ENG-13).
  docker,
  resolveLogContainer: core.createOwnedRuntimeContainerResolver({
    primaryContainerName: CONFIG.containerName,
    managerId: CONFIG.managerId,
    ownerLabelKey: MANAGER_LABEL_KEY,
    isRuntimeContainer: (container) => instanceCatalog.isHosted(container),
    getContainerStatus: (name) => getContainerStatus(name),
    listManagedContainers: () => listManagedContainers(),
  }),
  redactLogs: runtimeSecretRedactor,
  launchStore,
  jobsLedgerLookup: (jobId) => jobs.get(jobId) || null,
  listRecentLaunches: () => recentLaunches,
  findInstance: findRuntimeInstance,
  apiKeyFor: (found) => getLlamaApiKey(found.container),
  startRuntime: startRuntimeRequest,
  stopInstance: stopRuntimeInstanceRequest,
  // POST /api/launch/plan (ENG-7): the plan /api/start would execute, side-effect free.
  planLaunch: (body) => startRuntimeRequest.planLaunch(body),
  // POST /api/launch (ENG-26): /api/start for a LaunchRequestV2 or {fromLaunchId}.
  startLaunch: ({ req, body }) => startRuntimeRequest({ req, body, v2Only: true }),
  managerId: "llama",
  ownerLabelValue: CONFIG.managerId,
  isLocalRequest,
  getImageStatus: getImageStatusFresh,
  listManagedContainers: () => listManagedContainers(),
  getGpuStatus,
  metricsSampler: instanceMetricsSampler,
  dockerConfig: DOCKER_HOST_CONFIG,
  createJob,
  appendLog,
  finishJob,
  failJob,
  // POST /api/runtimes/:runtimeId/pull (ENG-11): the supervisor's pull job.
  pullRuntime: (runtimeId, options) => runtimeSupervisor.pullRuntime(runtimeId, options),
});

// Model knowledge (docs/overhaul/02-models.md MOD-5): GET /api/knowledge/status lists the
// layers, files and invalid entries of the model knowledge, the engine descriptors and the
// launch parameter catalogs. The deps are what the probe (MOD-13) and the qualification
// suite (MOD-16) routes added to the same module need: the local-request gate, this
// manager's job functions, the docker runner, the instance lookup and its data directory.
core.registerModelInspectorRoutes(app, {
  managerId: "llama",
  isLocalRequest,
  jobs: { createJob, appendLog, finishJob, failJob, setJobProgress },
  docker,
  listInstances: listRuntimeInstancesRequest,
  dataDir: path.join(__dirname, "data"),
  registry: engineRegistry,
  paramCatalog: core.engines.getParamCatalog(),
});

core.registerAuditRoutes(app, {
  auditRoot: CONFIG.auditRoot,
  auditPasswordFile: AUDIT_PASSWORD_FILE,
  openWebuiContainer: CONFIG.openWebuiContainer,
  managerName: "llama-manager",
  getAuditPassword,
  getContainerStatus,
  verifyAuditPassword,
  createAuditSession,
  getAuditAuth,
  destroyAuditSession,
  requireAuditAuth,
  listAuditExports,
  getAuditMarkdownPath,
  exportOpenWebuiAudit,
});

core.registerToolsRoutes(app, {
  collectHealthReport,
  getLaunchProfiles: launchProfilesStore.getLaunchProfiles,
  saveLaunchProfile: launchProfilesStore.saveLaunchProfile,
  deleteLaunchProfile: launchProfilesStore.deleteLaunchProfile,
  checkModelCompatibility,
  summarizeRuntimeLogs,
  getAutomationSettings: automationSettingsStore.getAutomationSettings,
  saveAutomationSettings: automationSettingsStore.saveAutomationSettings,
  createJob,
  normalizeBenchmarkRequest,
  runBenchmarkJob,
  failJob,
  benchmarkTitle: "Benchmark local llama.cpp model",
  verifyDownloadedModel,
  buildConnectionGuide,
  buildClaudeCompressionInsights,
  getModelNotes: modelNotesStore.getModelNotes,
  saveModelNote: modelNotesStore.saveModelNote,
  deleteModelNote: modelNotesStore.deleteModelNote,
});

if (require.main === module) {
  recipeWatcher = core.engines.watchRecipeOverrides({ store: recipeStore, log: (line) => console.warn(line) });
  startManager().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  process.once("SIGINT", () => shutdownManager("SIGINT").catch((error) => console.error(error)));
  process.once("SIGTERM", () => shutdownManager("SIGTERM").catch((error) => console.error(error)));
}

function defaultAiPath(...parts) {
  return path.join(DEFAULT_AI_ROOT, ...parts);
}

function defaultDevToolsPath(...parts) {
  return DEFAULT_DEVTOOLS_ROOT ? path.join(DEFAULT_DEVTOOLS_ROOT, ...parts) : "";
}

async function loadRecentLaunches() {
  const data = await readJsonFile(CONFIG.recentLaunches, { launches: [] });
  recentLaunches = Array.isArray(data?.launches)
    ? data.launches.filter((item) => item && item.config && item.config.model).slice(0, MAX_RECENT_LAUNCHES)
    : [];
  // 01 §22: the file's entries enter LaunchStore once, as source "migration".
  trackLaunch(() => launchStore.importRecentLaunches(recentLaunches));
}

// Keep the successful llama.cpp launch presets available after a manager restart.
function recordRecentLaunch(meta) {
  if (!meta || !meta.model) return;
  // The LaunchStore record is marked running by the supervisor's commit stage.
  clearRuntimeInstancesCache();
  const config = normalizeLaunchConfig(meta);
  const entry = {
    model: config.model,
    name: config.name || deriveName(config.model),
    launchedAt: new Date().toISOString(),
    // Where the instance ran, so an idle wake puts it back in the same slot
    // (08 P0-1). The config shape itself is unchanged.
    ...(meta.instanceMode ? {
      containerName: String(meta.containerName || ""),
      instanceMode: meta.instanceMode === "parallel" ? "parallel" : "replace",
      instanceId: String(meta.instanceId || ""),
    } : {}),
    config,
  };
  const key = `${entry.model}::${entry.name}`;
  recentLaunches = [entry, ...recentLaunches.filter((item) => `${item.model}::${item.name}` !== key)]
    .slice(0, MAX_RECENT_LAUNCHES);
  atomicWriteJsonFile(CONFIG.recentLaunches, { launches: recentLaunches })
    .catch((error) => console.warn(`Unable to save recent launches: ${error.message}`));
}

async function collectHealthReport() {
  const [dockerStatus, gpu, container, image, logs] = await Promise.all([
    getDockerVersion(),
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
    getImageStatus(CONFIG.image),
    summarizeRuntimeLogs({ tail: 260 }).catch((error) => ({ ok: false, issues: [{ severity: "error", message: error.message }] })),
  ]);
  let runtimeError = null;
  const runtime = container.running ? await getRunningModelSummary(container, gpu).catch((error) => {
    runtimeError = error;
    return null;
  }) : null;
  let runtimeSecretValues = [];
  let runtimeSecretStoreError = null;
  try {
    runtimeSecretValues = runtimeApiKeyStore.values();
  } catch (error) {
    runtimeSecretStoreError = error;
  }
  const checks = [];
  // actionDetails (08 P0-23) describe the remediation of a failing check; the
  // string actions stay as they were.
  checks.push(healthCheck("docker", CONFIG.dockerWslDistro ? CONFIG.dockerRuntimeName : "Docker", dockerStatus.ok ? "ok" : "fail", dockerStatus.text || "Docker not available", ["start-docker"], dockerStatus.ok ? [] : core.healthActionDetails(["start-docker"])));
  checks.push(healthCheck("gpu", "GPU", gpu.ok ? "ok" : "warn", gpu.ok ? `${gpu.name} · ${gpu.usedMb}/${gpu.totalMb} MB · ${gpu.util}%` : gpu.text || "No NVIDIA GPU detected"));
  checks.push(healthCheck("image", "llama.cpp 镜像", image.ok ? "ok" : "warn", image.ok ? image.text : `${CONFIG.image} not found locally`, image.ok ? [] : ["pull-image"], image.ok ? [] : core.healthActionDetails(["pull-image"], { image: CONFIG.image })));
  checks.push(healthCheck("image-pin", "镜像版本", isPinnedImageReference(CONFIG.image) ? "ok" : "warn", CONFIG.image));
  checks.push(healthCheck("container", "llama.cpp 容器", container.running ? "ok" : container.exists ? "warn" : "warn", container.status || (container.exists ? "exists" : "not started")));
  checks.push(healthCheck("api", "OpenAI 兼容 API", runtime?.models?.length ? "ok" : runtimeError ? "fail" : "warn", runtime?.models?.length ? `${runtime.models.length} model(s) served at ${runtime.endpoint.localUrl}` : runtimeError?.message || "No served model reported yet"));
  checks.push(healthCheck("runtime-secret-store", "运行时密钥存储", runtimeSecretStoreError ? "fail" : "ok", runtimeSecretStoreError?.message || "可用（密钥仅保存在受限本地文件中）"));
  if (!process.env.VLLM_MODELS_ROOT && !process.env.LLAMA_MODELS_ROOT) {
    checks.push(healthCheck("shared-models-root", "共享模型库", "ok", "已启用共享目录登记与跨管理器文件操作锁；可在模型存储与迁移页面配置保存位置。"));
  }
  checks.push(await directoryHealth("models-root", "模型目录", CONFIG.modelsRoot));
  checks.push(await directoryHealth("hf-cache", "HF 缓存目录", CONFIG.hfCache));
  const hasHfLogin = Boolean(process.env.HF_TOKEN || hfAuthService.hasCachedToken());
  checks.push(healthCheck("hf-token", "Hugging Face 账号", hasHfLogin ? "ok" : "warn", hasHfLogin ? "本机已连接" : "下载 gated 模型前需要连接 Hugging Face 账号"));
  checks.push(await commandHealth("hf-cli", "Hugging Face CLI", CONFIG.hfCli, ["--help"], "warn", core.healthActionDetails(["install-download-cli"])));
  checks.push(await commandHealth("modelscope-cli", "ModelScope CLI", CONFIG.modelScopeCli, ["--help"], "warn"));
  checks.push(healthCheck("logs", "最近日志", logs.issues?.some((item) => item.severity === "error") ? "fail" : logs.issues?.length ? "warn" : "ok", logs.stage || "No recent llama.cpp log issues"));

  const score = checks.reduce((sum, item) => sum + (item.status === "ok" ? 1 : item.status === "warn" ? 0.5 : 0), 0);
  return {
    ok: checks.every((item) => item.status !== "fail"),
    score: Math.round((score / Math.max(1, checks.length)) * 100),
    generatedAt: new Date().toISOString(),
    checks,
    runtime: core.redactManagerSecrets(runtime, [process.env.HF_TOKEN, ...runtimeSecretValues]),
    logSummary: logs,
  };
}

function normalizeLaunchProfile(value) {
  if (!value || typeof value !== "object") return null;
  const name = String(value.name || value.label || "").trim();
  if (!name) return null;
  const config = value.config && typeof value.config === "object" ? value.config : {};
  return {
    id: safeProfileId(value.id || name),
    name: clipText(name, 80),
    description: clipText(String(value.description || ""), 180),
    source: value.source === "builtin" ? "builtin" : "user",
    updatedAt: value.updatedAt || new Date().toISOString(),
    config: normalizeLaunchConfig(config),
  };
}

function normalizeLaunchConfig(config = {}) {
  return {
    model: String(config.model || ""),
    name: String(config.name || ""),
    port: Number(config.port || CONFIG.defaultPort),
    maxModelLen: Number(config.maxModelLen || 8192),
    maxNumSeqs: positiveInt(config.maxNumSeqs, 4),
    gpuMemoryUtilization: Number(config.gpuMemoryUtilization || 0.92),
    gpuLayers: normalizeGpuLayers(config.gpuLayers),
    batchSize: positiveInt(config.batchSize, 2048),
    ubatchSize: positiveInt(config.ubatchSize, 512),
    cacheTypeK: normalizeLlamaCacheType(config.cacheTypeK || config.kvCacheDtype || "f16"),
    cacheTypeV: normalizeLlamaCacheType(config.cacheTypeV || config.kvCacheDtype || "f16"),
    flashAttention: normalizeOnOffAuto(config.flashAttention),
    loadFormat: normalizeLoadFormat(config.loadFormat),
    networkAccess: normalizeNetworkAccess(config.networkAccess),
    clientPreset: normalizeClientPreset(config.clientPreset),
    reasoning: normalizeOnOffAuto(config.reasoning),
    reasoningFormat: normalizeLlamaReasoningFormat(config.reasoningFormat || config.reasoningParser),
    reasoningEffort: normalizeLlamaReasoningEffort(config.reasoningEffort),
    reasoningBudget: normalizeLlamaReasoningBudget(config.reasoningBudget),
    textOnlyMode: normalizeDefaultTrueBoolean(config.textOnlyMode, config.languageModelOnly),
    languageModelOnly: normalizeDefaultTrueBoolean(config.textOnlyMode, config.languageModelOnly),
    multiGpuMode: normalizeLlamaSplitMode(config.multiGpuMode || config.splitMode || "layer"),
    gpuDeviceIds: normalizeGpuIds(config.gpuDeviceIds),
    tensorSplit: cleanOptionalLaunchArg(config.tensorSplit),
    mainGpu: Number(config.mainGpu || 0),
    noMmap: Boolean(config.noMmap),
    mmproj: cleanOptionalLaunchArg(config.mmproj),
    mmprojDevice: normalizeLlamaMmprojDevice(config.mmprojDevice),
    draftModel: cleanOptionalLaunchArg(config.draftModel || config.specDraftModel),
    speculativeMode: String(config.speculativeMode || "auto"),
    numSpeculativeTokens: positiveInt(config.numSpeculativeTokens, 3),
  };
}

function defaultLaunchProfiles() {
  return createLlamaDefaultLaunchProfiles(normalizeLaunchConfig);
}

function safeProfileId(value) {
  const base = String(value || "profile").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `profile-${Date.now().toString(36)}`;
}

function isLikelyMultimodalModel(value) {
  return /(?:\bvl\b|vision|visual|multimodal|multi-modal|mmproj|llava|bakllava|moondream|internvl|qwen\d*(?:\.\d+)?-vl|qwen-vl|gemma-3|omni|audio)/i.test(String(value || ""));
}

function applySafeGgufRuntimeRecommendations(recommendations, selectedGguf, inventory = {}) {
  if (selectedGguf?.contextLength) {
    recommendations.maxModelLen = selectedGguf.contextLength;
    if (Number(selectedGguf.contextLength) >= 131072) recommendations.maxNumSeqs = 1;
  }
  const projector = Array.isArray(inventory.mmproj) ? inventory.mmproj[0] : null;
  if (projector?.path) {
    recommendations.availableMmproj = projector.path;
    recommendations.mmproj = "";
    recommendations.textOnlyMode = true;
    recommendations.languageModelOnly = true;
  }
  return recommendations;
}

async function checkModelCompatibility(input = {}) {
  const model = cleanRequired(input.model, "model");
  const findings = [];
  const local = describeLocalModelPath(model);
  const ggufSelection = local ? resolveGgufSelection(model) : null;
  const selectedGguf = ggufSelection?.selectedModel || null;
  const lower = model.toLowerCase();
  const recommendations = normalizeLaunchConfig({
    model,
    name: deriveName(model),
    port: input.port || CONFIG.defaultPort,
    maxModelLen: input.maxModelLen || 32768,
    maxNumSeqs: input.maxNumSeqs || 2,
    gpuMemoryUtilization: input.gpuMemoryUtilization || 0.92,
    cacheTypeK: input.cacheTypeK || "q8_0",
    cacheTypeV: input.cacheTypeV || "q8_0",
    loadFormat: "gguf",
    clientPreset: input.clientPreset || "generic",
    reasoning: input.reasoning || "auto",
    reasoningFormat: inferLlamaReasoningFormat(model),
    textOnlyMode: normalizeDefaultTrueBoolean(input.textOnlyMode, input.languageModelOnly),
    multiGpuMode: input.multiGpuMode || "layer",
    gpuDeviceIds: input.gpuDeviceIds,
    tensorSplit: input.tensorSplit,
    mainGpu: input.mainGpu,
  });

  if (local) {
    findings.push(finding("ok", "本地路径可用", local.path));
    if (local.stat?.isFile() && !local.path.toLowerCase().endsWith(".gguf")) {
      findings.push(finding("fail", "非 GGUF 文件", "llama.cpp server 需要 .gguf 文件，safetensors/HF 目录请先转换或换 vLLM。"));
    }
    if (local.stat?.isDirectory()) {
      if (local.ggufFiles.length) {
        findings.push(finding("ok", "检测到 GGUF", `${local.ggufFiles.length} 个 GGUF 文件，启动时会排除 mmproj 并正确选择单文件或首个分片。`));
      } else {
        findings.push(finding("fail", "缺少 GGUF 文件", "目录内没有 .gguf；llama.cpp 无法直接加载 safetensors 目录。"));
      }
      if (local.ggufFiles.length > 1) {
        findings.push(finding("info", "GGUF inventory", `${local.ggufInventory.models.length} 个主模型变体、${local.ggufInventory.mmproj.length} 个 projector、${local.ggufInventory.drafts.length} 个 draft；当前主模型：${path.basename(selectedGguf?.path || chooseGgufFile(local.ggufFiles)?.path || "")}`));
      }
    }
  } else if (path.isAbsolute(model)) {
    findings.push(finding("fail", "本地路径不存在", model));
  } else if (looksLikeGgufReference(model)) {
    findings.push(finding("ok", "远程 GGUF 仓库", "会使用 llama.cpp --hf-repo 加载，模型名可写 owner/model:Q4_K_M。"));
  } else if (/^[\w.-]+\/[\w.-]+/.test(model)) {
    findings.push(finding("warn", "远程仓库可能不是 GGUF", "llama.cpp 远程加载最适合 *-GGUF 仓库；普通 HF safetensors 仓库通常不能直接跑。"));
  }

  if (/^(meta-llama|google|mistralai)\//i.test(model) && !process.env.HF_TOKEN) {
    findings.push(finding("warn", "可能需要授权", "这类模型经常需要 Hugging Face token 或提前接受 license。"));
  }
  if (/qwen/i.test(model)) {
    findings.push(finding("ok", "Qwen / Claude 桥", "建议 Claude 桥使用工具桥接模式；reasoning-format 可先用 deepseek，若客户端显示异常再切 none。"));
    recommendations.reasoningFormat = "deepseek";
  }
  if (/deepseek/i.test(model)) recommendations.reasoningFormat = "deepseek";
  if (/uncensored|abliterated|abliteration/i.test(model)) {
    findings.push(finding("info", "去审查/abliterated 标记", "建议配合审计导出和本机访问控制使用。"));
  }
  if (/q4|q5|iq4|gguf/i.test(model)) {
    findings.push(finding("ok", "量化权重", "GGUF 权重量化已经包含在文件中，启动时不用再设置 vLLM 那类 quantization。"));
  }
  if (selectedGguf) {
    applySafeGgufRuntimeRecommendations(recommendations, selectedGguf, ggufSelection.inventory);
    findings.push(finding(
      "ok",
      "GGUF 元数据",
      `${selectedGguf.architecture || "unknown"} · ${(selectedGguf.paramsB || 0).toFixed(2)}B · ${selectedGguf.layers || "?"} 层 · ${selectedGguf.kvHeads || "?"} KV heads · 原生上下文 ${(selectedGguf.contextLength || 0).toLocaleString()}`,
    ));
    recommendations.arch = {
      architecture: selectedGguf.architecture,
      layers: selectedGguf.layers,
      kvLayers: selectedGguf.kvLayers,
      kvHeads: selectedGguf.kvHeads,
      headDim: selectedGguf.headDim,
      keyLength: selectedGguf.keyLength,
      valueLength: selectedGguf.valueLength,
      contextLength: selectedGguf.contextLength,
      slidingWindow: selectedGguf.slidingWindow,
      slidingWindowPattern: selectedGguf.slidingWindowPattern,
      source: "gguf",
      label: selectedGguf.architecture || "GGUF metadata",
    };
    recommendations.paramsB = selectedGguf.paramsB;
    recommendations.bytesPerParam = selectedGguf.parameterCount > 0
      ? selectedGguf.fileBytes / selectedGguf.parameterCount
      : undefined;
    if (ggufSelection.inventory.drafts.length) {
      recommendations.draftModel = ggufSelection.inventory.drafts[0].path;
      recommendations.speculativeMode = "draft-dflash";
    }
    if (String(selectedGguf.architecture || "").toLowerCase() === "muse-glimmer") {
      recommendations.temperature = 1;
      recommendations.topP = 0.95;
      recommendations.topK = 64;
    }
  }
  if (isLikelyMultimodalModel(model) || ggufSelection?.inventory?.mmproj?.length) {
    const projector = ggufSelection?.inventory?.mmproj?.[0]
      || local?.ggufFiles?.find((item) => /(?:^|[\\/])mmproj[^\\/]*\.gguf$/i.test(String(item.path || item.name || "")));
    findings.push(finding(projector || input.mmproj || !local ? "ok" : "warn", "Multimodal projector", projector
      ? `已检测到可选视觉组件 ${path.basename(projector.path)}；推荐配置保持仅文本，关闭仅文本模式后才会自动加载。`
      : input.mmproj ? "会使用显式配置的 mmproj。" : "本地目录未检测到 mmproj；多模态启动前需要补充 projector。"));
  }
  if (!recommendations.speculativeMode) recommendations.speculativeMode = /(?:^|[-_/])mtp(?:$|[-_/])/i.test(model) ? "auto" : "off";
  recommendations.numSpeculativeTokens = 3;
  if (Number(input.maxNumSeqs || 1) > 1) {
    findings.push(finding("info", "llama.cpp 上下文预算", `每槽 ${Number(input.maxModelLen || 32768).toLocaleString()} × ${Number(input.maxNumSeqs)} 槽；启动时会把 --ctx-size 设为总 KV 预算。`));
  }
  const recommendedContext = Number(recommendations.maxModelLen || input.maxModelLen || 0);
  if (recommendedContext >= 131072) {
    recommendations.maxNumSeqs = 1;
    if (!/q4|q5|q8/i.test(String(recommendations.cacheTypeK || recommendations.cacheTypeV || ""))) {
      findings.push(finding("warn", "长上下文 KV 显存", "128K 以上建议 K/V cache 用 q8_0、q5_1 或 q4_0，并把并行槽数降到 1。"));
      recommendations.cacheTypeK = "q4_0";
      recommendations.cacheTypeV = "q4_0";
    }
  }

  const remote = await core.fetchRemoteCompatibilityInfo({
    model,
    local,
    findings,
    remoteEnabled: input.remote !== false,
    modelInfoId: model.split(":")[0],
    getHuggingFaceModelInfo: (id) => remoteModelService.getHuggingFaceModelInfo(id),
    onInfo: (remoteInfo) => {
      if (!remoteInfo.hasGguf && !looksLikeGgufReference(model)) {
        findings.push(finding("warn", "未发现 GGUF 标记", "优先搜索该模型的 GGUF 量化分支再用 llama.cpp。"));
      }
    },
  });
  const runtimeCompatibility = await getLlamaArchitectureRuntimeCompatibility(selectedGguf?.architecture || "");
  if (runtimeCompatibility.status === "unsupported") {
    findings.push(finding("fail", "llama.cpp 版本不支持该架构", runtimeCompatibility.message));
  } else if (runtimeCompatibility.status === "unknown") {
    findings.push(finding("warn", "llama.cpp 架构兼容性未知", runtimeCompatibility.message));
  } else if (runtimeCompatibility.status === "supported") {
    findings.push(finding("ok", "llama.cpp 架构兼容", runtimeCompatibility.message));
  }
  return {
    ...core.buildCompatibilityReport({
    model,
    recommendations,
    remote,
    findings,
    }),
    selectedGguf,
    ggufInventory: ggufSelection?.inventory || null,
    runtimeCompatibility,
  };
}

function finding(severity, title, detail) {
  return core.compatibilityFinding(severity, title, detail);
}

function inferLlamaReasoningFormat(model) {
  const text = String(model || "").toLowerCase();
  if (text.includes("qwen") || text.includes("deepseek")) return "deepseek";
  return "none";
}

async function summarizeRuntimeLogs(options = {}) {
  return core.summarizeDockerRuntimeLogs({
    docker,
    containerName: CONFIG.containerName,
    tail: options.tail,
    classifyIssue: (message) => /out of memory|traceback|fatal|runtimeerror|failed|exception|cuda error/i.test(message) ? "error" : "warn",
    issueHint: llamaLogIssueHint,
    detectStage: detectLlamaLogStage,
    buildSuggestions: buildLlamaLogSuggestions,
  });
}

function detectLlamaLogStage(text) {
  const lower = String(text || "").toLowerCase();
  if (/listening|server is listening|llama server listening|http server/i.test(text) && /8080|models/i.test(text)) return "API ready";
  if (lower.includes("kv self size") || lower.includes("kv cache")) return "KV cache allocated";
  if (lower.includes("cuda") && (lower.includes("buffer size") || lower.includes("offloading"))) return "GPU offload / layers";
  if (lower.includes("llama_model_load") || lower.includes("load_tensors") || lower.includes("loading model")) return "loading GGUF weights";
  if (lower.includes("gguf")) return "reading GGUF metadata";
  if (lower.includes("error") || lower.includes("traceback") || lower.includes("failed")) return "error";
  return text ? "starting / waiting" : "no container logs";
}

function llamaLogIssueHint(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("docker") && (text.includes("daemon") || text.includes("npipe") || text.includes("dockerdesktoplinuxengine"))) return "Docker Desktop 没有启动或 Linux Engine 管道不可用；可用管理器的一键启动 Docker 后重试。";
  if (text.includes("out of memory") || text.includes("cuda")) return "降低上下文、并行槽数或 KV cache 精度；异构双卡优先 layer 模式。";
  if (text.includes("no such") || text.includes("not found")) return "检查模型路径、Docker 挂载目录和 GGUF 文件名。";
  if (text.includes("token") || text.includes("gated") || text.includes("401")) return "检查 HF_TOKEN 和模型授权。";
  if (text.includes("gguf")) return "确认下载的是完整 GGUF 文件，远程 repo 建议使用 *-GGUF:Q4_K_M 这类格式。";
  if (text.includes("jinja") || text.includes("chat template")) return "聊天模板异常时可换官方 GGUF 或关闭复杂工具调用测试。";
  return "打开日志页查看完整上下文，必要时用单卡排错方案重试。";
}

function buildLlamaLogSuggestions(issues, stage) {
  const suggestions = [];
  if (issues.some((item) => /docker|daemon|npipe|dockerdesktoplinuxengine/i.test(item.message))) suggestions.push("Docker 未就绪：先点启动任务里的“启动 Docker”，或手动打开 Docker Desktop。");
  if (issues.some((item) => /out of memory|cuda/i.test(item.message))) suggestions.push("显存错误：先套用“单卡排错”或“64K 稳妥异构”，再逐步加上下文。");
  if (issues.some((item) => /no such|not found/i.test(item.message))) suggestions.push("路径错误：从模型库选择本地目录或 GGUF 文件填入启动表单。");
  if (issues.some((item) => /token|gated|401/i.test(item.message))) suggestions.push("授权错误：配置 HF_TOKEN 后重新下载或启动。");
  if (!suggestions.length && stage !== "API ready") suggestions.push("如果长时间停在加载权重，观察 GPU 利用率；首次读取大 GGUF 较慢是正常的。");
  if (!suggestions.length) suggestions.push("当前日志没有明显错误。");
  return suggestions;
}

const SERVICE_EXPOSURE_CHECK_OPTIONS = {
  warnDirectContainerWhen: "lan-bound",
  remoteEnvVar: "LLAMA_MANAGER_ALLOW_REMOTE=1",
  copy: {
    directContainerWarn: "llama.cpp 容器 LAN 端口不经过管理器网关鉴权；对外用户应连接管理器 /serve/v1，或放在反向代理鉴权后面。",
  },
};

// gatewayOnly (05 §7.2) rides along; the client list is the entry's, or
// this manager's legacy file while the entry is down.
async function buildServiceExposurePayload(settings) {
  return { ...(await buildServiceExposurePayloadSnapshot(settings)), gatewayOnly: readGatewayOnlyMode() };
}

async function buildServiceExposurePayloadSnapshot(settings) {
  const [snapshot, clientsLedger] = await Promise.all([
    getOperationalSnapshot(),
    (legacyKeyForwarder ? legacyKeyForwarder.getServiceClientsLedger() : getServiceClientsLedger())
      .catch(() => getServiceClientsLedger())
      .catch(() => ({ clients: [] })),
  ]);
  const { docker, container, runtime } = snapshot;
  const endpoint = runtime.endpoint || getContainerEndpoint(container);
  return core.buildServiceExposurePayloadSnapshot(settings, {
    docker,
    container,
    endpoint,
    runtime,
    clientsLedger,
  }, {
    managerHost: HOST,
    managerPort: PORT,
    lanAddress: getLanAddress(),
    remoteManagementAllowed: ALLOW_REMOTE_MANAGEMENT,
    defaultServicePort: CONFIG.defaultPort,
    claudeBasePath: "/claude",
    claudeMessagesPath: "/claude/v1/messages",
    openCodeBasePath: "/opencode/v1",
    runtimeApiKeySupported: true,
    checkOptions: SERVICE_EXPOSURE_CHECK_OPTIONS,
  });
}

function buildServiceExposureChecks(settings, context) {
  return core.buildServiceExposureChecks(settings, {
    ...context,
    lanAddress: getLanAddress(),
    remoteManagementAllowed: ALLOW_REMOTE_MANAGEMENT,
  }, SERVICE_EXPOSURE_CHECK_OPTIONS);
}

function startAutomationMonitor() {
  if (automationMonitorTimer) return;
  automationMonitorTimer = setInterval(() => {
    inspectAutomationRules().catch((error) => console.warn(`automation monitor failed: ${error.message}`));
  }, 60 * 1000);
  automationMonitorTimer.unref?.();
}

// Frontend smoke runs serve stubbed stats and must not scrape a runtime that
// happens to run on this host.
function startStatsSampler() {
  if (process.env.AI_FRONTEND_SMOKE === "1") return;
  statsSampler.start();
}

// The running instances the stats sampler scrapes, keyed as /api/instances
// keys them: the primary container and this manager's parallel containers.
async function listStatsSampleInstances() {
  const instances = [];
  const primary = await getContainerStatus(CONFIG.containerName);
  if (primary?.running) instances.push({ id: "primary", primary: true, container: primary });
  const managed = await listManagedContainers().catch(() => []);
  for (const item of managed) {
    if (!item.running || item.name === CONFIG.containerName) continue;
    if (item.manager !== CONFIG.managerId || !instanceCatalog.isKnownEngine(item)) continue;
    const container = await getContainerStatus(item.name);
    if (!container?.running) continue;
    instances.push({ id: item.labels?.["ai.manager.instance"] || item.name, primary: false, container });
  }
  return instances;
}

// One sampler scrape: the summary /api/stats serves, plus the text and the
// latency histograms of the same /metrics read.
async function scrapeStatsSampleInstance(instance) {
  const capture = {};
  const gpu = instance.primary ? await getGpuStatus().catch(() => null) : null;
  const summary = await collectVllmMetricsSummaryFresh(instance.container, gpu, { capture });
  const container = instance.container || {};
  return {
    summary,
    text: capture.text,
    scrapedAt: capture.scrapedAt,
    histograms: capture.histograms,
    // A failed read has no process start and must not look like a new runtime.
    runtimeKey: summary?.processStartSeconds ? `${container.id || container.name || ""}:${summary.processStartSeconds}` : "",
  };
}

// At most once a minute: the primary's newest sample goes into the stats
// ledger and the 24 h metrics history. snapshotCurrentStats still writes the
// ledger right before a stop or a start.
async function persistStatsSample(records, { at }) {
  const record = records.find((item) => item.instanceId === "primary");
  const container = record?.instance?.container;
  const live = record?.summary;
  if (!live || !container?.running) return;
  await updateStatsLedger(live).catch((error) => console.warn(`stats ledger update failed: ${error.message}`));
  await metricsHistoryStore.recordMetricsHistory({
    updatedAt: new Date(at).toISOString(),
    container,
    gpu: live.gpu,
    live,
    totals: live.totals,
    models: live.models,
  });
}

const CACHE_HIT_POLL_MS = clampNumber(Number(process.env.LLAMA_CACHE_HIT_POLL_MS || 2000), 1000, 10_000);
const CACHE_HIT_CONTAINER_REFRESH_MS = 15_000;

function cacheHitRuntimeId(container = {}) {
  return [
    container.name || CONFIG.containerName,
    container.startedAt || container.createdAt || "unknown-start",
    container.image || "unknown-image",
  ].join("|");
}

async function resolveCacheHitContainer(containerHint = null) {
  if (containerHint) {
    cacheHitRuntimeContext = { checkedAt: Date.now(), container: containerHint };
    return containerHint;
  }
  if (cacheHitRuntimeContext.container && Date.now() - cacheHitRuntimeContext.checkedAt < CACHE_HIT_CONTAINER_REFRESH_MS) {
    return cacheHitRuntimeContext.container;
  }
  const container = await getContainerStatus(CONFIG.containerName);
  cacheHitRuntimeContext = { checkedAt: Date.now(), container };
  return container;
}

async function sampleCacheHitStats(containerHint = null) {
  const container = await resolveCacheHitContainer(containerHint);
  if (!container?.running) {
    lastSlotOccupancy = null;
    await cacheHitTracker.clearActive();
    return cacheHitTracker.getSummary();
  }

  const endpoint = getContainerEndpoint(container);
  const source = `http://127.0.0.1:${endpoint.port}/slots`;
  const response = await fetch(source, {
    signal: AbortSignal.timeout(Math.min(1500, CACHE_HIT_POLL_MS)),
    headers: llamaAuthHeaders(getLlamaApiKey(container)),
  });
  if (!response.ok) throw new Error(`slots returned ${response.status}`);
  const slots = await response.json();
  lastSlotOccupancy = slotOccupancy(slots, container);
  return cacheHitTracker.observeSlots(slots, {
    runtimeId: cacheHitRuntimeId(container),
    model: String(container.labels?.["ai.manager.model"] || ""),
    source,
  });
}

function slotOccupancy(slots, container) {
  const list = Array.isArray(slots) ? slots : [];
  return {
    containerName: normalizeDockerContainerName(container?.name || CONFIG.containerName),
    busySlots: list.filter((slot) => slot?.is_processing).length,
    nSlots: list.length,
    observedAt: Date.now(),
  };
}

// Inputs for the llamacpp descriptor's derive sources. They describe the
// primary container only (the cache-hit monitor polls that one), and slot
// occupancy older than three polls counts as unknown.
async function metricsDerivedInputs(instance) {
  if (!instance?.primary) return null;
  const inputs = {};
  const occupancy = lastSlotOccupancy;
  if (occupancy && occupancy.containerName === instance.containerName && Date.now() - occupancy.observedAt <= 3 * CACHE_HIT_POLL_MS) {
    inputs.busySlots = occupancy.busySlots;
    inputs.nSlots = occupancy.nSlots;
  }
  const summary = await cacheHitTracker.getSummary().catch(() => null);
  if (summary?.cumulative && Number.isFinite(Number(summary.cumulative.cachedTokens))) {
    inputs.cacheHit = { cachedTokens: Number(summary.cumulative.cachedTokens) };
  }
  return inputs;
}

function startCacheHitMonitor() {
  if (cacheHitMonitorTimer || process.env.AI_FRONTEND_SMOKE === "1") return;
  const tick = async () => {
    if (cacheHitMonitorBusy) return;
    cacheHitMonitorBusy = true;
    try {
      await sampleCacheHitStats();
    } catch (error) {
      const now = Date.now();
      if (now - cacheHitLastWarningAt >= 60_000) {
        cacheHitLastWarningAt = now;
        console.warn(`cache-hit sample failed: ${error.message}`);
      }
      cacheHitRuntimeContext.checkedAt = 0;
    } finally {
      cacheHitMonitorBusy = false;
    }
  };
  cacheHitMonitorTimer = setInterval(tick, CACHE_HIT_POLL_MS);
  cacheHitMonitorTimer.unref?.();
  tick();
}

// GPU 温度 / 功耗墙告警：达到阈值时生成一条 automation 任务提醒，各自 10 分钟冷却，只警不动。
const gpuGuardState = {};
async function inspectGpuTemperatureGuard(settings) {
  if (!settings.tempGuardEnabled && !settings.powerGuardEnabled) return;
  const gpu = await getGpuStatus().catch(() => null);
  for (const finding of core.evaluateGpuGuards(gpu, settings, gpuGuardState)) {
    const job = createJob("automation", finding.title, finding.data);
    appendLog(job, finding.message);
    finishJob(job, { result: "warn-only" });
  }
}

async function inspectAutomationRules() {
  const settings = await automationSettingsStore.getAutomationSettings();
  await inspectGpuTemperatureGuard(settings).catch(() => {});
  if (!settings.vramGuardEnabled) return;
  if (runtimeActivity.unloading) return;
  const [gpu, container] = await Promise.all([getGpuStatus(), getContainerStatus(CONFIG.containerName)]);
  if (!container.running) {
    runtimeActivity = { ...runtimeActivity, initialized: false, lastRequestCount: null, lastTokenCount: null, unloading: false };
    return;
  }
  const summary = await collectVllmMetricsSummary(container, gpu).catch(() => null);
  const requestCount = Number(summary?.totals?.requests?.total || 0);
  const tokenCount = Number(summary?.totals?.tokens?.total || 0);
  const now = Date.now();
  if (!runtimeActivity.initialized || runtimeActivity.lastRequestCount !== requestCount || runtimeActivity.lastTokenCount !== tokenCount) {
    runtimeActivity.initialized = true;
    runtimeActivity.lastActivityAt = new Date(now).toISOString();
    runtimeActivity.lastRequestCount = requestCount;
    runtimeActivity.lastTokenCount = tokenCount;
  }
  runtimeActivity.lastSeenAt = new Date(now).toISOString();
  const idleMs = now - Date.parse(runtimeActivity.lastActivityAt || new Date(now).toISOString());
  const gpuPercent = gpu.ok && gpu.totalMb ? (gpu.usedMb / gpu.totalMb) * 100 : 0;
  const noActiveKv = Number(summary?.totals?.context?.activeTokens || 0) === 0;
  const shouldWarn = settings.vramGuardEnabled && settings.vramAction === "warn" && gpuPercent >= settings.vramPercent;
  const shouldVramUnload = settings.vramGuardEnabled && settings.vramAction === "unload" && gpuPercent >= settings.vramPercent && idleMs >= 2 * 60 * 1000 && noActiveKv;
  if (shouldWarn && now - Date.parse(runtimeActivity.lastWarnAt || 0) > 10 * 60 * 1000) {
    runtimeActivity.lastWarnAt = new Date(now).toISOString();
    const job = createJob("automation", "VRAM guard warning", { gpuPercent, threshold: settings.vramPercent });
    appendLog(job, `GPU memory usage ${gpuPercent.toFixed(1)}% exceeded ${settings.vramPercent}%.`);
    finishJob(job, { result: "warn-only" });
  }
  if (shouldVramUnload) {
    runtimeActivity.unloading = true;
    const reason = `VRAM ${gpuPercent.toFixed(1)}% exceeded ${settings.vramPercent}%`;
    const job = createJob("automation", "Auto unload llama.cpp", { reason, settings });
    try {
      appendLog(job, reason);
      await snapshotCurrentStats("automation-unload").catch(() => {});
      const result = await stopVllmContainer();
      finishJob(job, { result });
    } catch (error) {
      failJob(job, error);
    } finally {
      runtimeActivity.unloading = false;
    }
  }
}

async function verifyDownloadedModel(input = {}) {
  return modelFilesystemStore.verifyDownloadedModel(input, {
    buildIssues: (summary, makeFinding) => {
      const issues = [];
      if (!summary.gguf) issues.push(makeFinding("fail", "未发现 GGUF", "llama.cpp 需要 .gguf 权重；普通 safetensors 目录请使用 vLLM 或先转换。"));
      if (summary.hasConfig && !summary.gguf) issues.push(makeFinding("warn", "检测到 HF 配置", "这更像 vLLM/HF 目录，不是 llama.cpp 直接可跑的 GGUF。"));
      return issues;
    },
  });
}

async function buildConnectionGuide() {
  const [gpu, container, exposureSettings] = await Promise.all([
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
    getServiceExposureSettings(),
  ]);
  const runtime = await getRunningModelSummary(container, gpu).catch(() => null);
  const endpoint = runtime?.endpoint || getContainerEndpoint(container);
  const managerLocal = `http://127.0.0.1:${PORT}`;
  const managerLan = HOST === "127.0.0.1" ? null : `http://${getLanAddress()}:${PORT}`;
  return core.buildConnectionGuideSnapshot({
    runtime,
    endpoint,
    managerLocal,
    managerLan,
    claudeModelAliases: CLAUDE_MODEL_ALIASES,
    openAiModelAliases: OPENAI_GATEWAY_MODEL_ALIASES,
    apiKeyRequired: exposureSettings.enabled !== false && exposureSettings.requireApiKey === true,
    claude: { modelAlias: CLAUDE_MODEL_ALIASES[0] },
  });
}

async function buildClaudeCompressionInsights() {
  const settings = await getClaudeCompressionSettings();
  const ledger = await loadStatsLedger();
  const compression = ledger.clients?.claude?.compression || { applied: 0, savedTokens: 0, last: {} };
  return {
    ok: true,
    settings,
    totals: {
      applied: Number(compression.applied || 0),
      savedTokens: Number(compression.savedTokens || 0),
      last: compression.last || {},
    },
    last: compression.last || {},
    sessions: [],
    note: "这里只显示 Claude 桥上下文压缩统计，不返回原始对话正文。",
  };
}

function clipText(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 16)).trim()} ...[截断]`;
}

function serviceGatewaySelectedInstanceId(req) {
  return core.normalizeServiceEntryInstanceId(req?.serviceGateway?.selectedInstanceId);
}

function runtimeMatchesServiceGatewayInstance(runtime, requestedInstanceId) {
  const requested = core.normalizeServiceEntryInstanceId(requestedInstanceId).toLowerCase();
  if (!requested) return true;
  const container = runtime?.container || {};
  const labels = container.labels || {};
  const aliases = [
    container.name === CONFIG.containerName ? "primary" : "",
    labels["ai.manager.instance"],
    container.name,
  ].map((value) => core.normalizeServiceEntryInstanceId(value).toLowerCase()).filter(Boolean);
  return aliases.includes(requested);
}

async function getServiceGatewayRuntime(req) {
  const requestedInstanceId = serviceGatewaySelectedInstanceId(req);
  if (!requestedInstanceId) return getRunningModelSummary();
  const runtimes = (await getRunningModelSummaries()).filter((runtime) => runtime.container?.running);
  return runtimes.find((runtime) => runtimeMatchesServiceGatewayInstance(runtime, requestedInstanceId)) || null;
}

async function handleClaudeModels(req, res) {
  try {
    const requestedInstanceId = serviceGatewaySelectedInstanceId(req);
    const runtime = await getServiceGatewayRuntime(req);
    if (!runtime?.container?.running) {
      if (requestedInstanceId) {
        return res.status(503).json(claudeError("service_unavailable", `Selected runtime instance ${requestedInstanceId} is not available.`));
      }
      return res.status(503).json(claudeError("service_unavailable", "Model service is not running."));
    }
    const response = await fetch(`http://127.0.0.1:${runtime.endpoint.port}/v1/models`, {
      signal: AbortSignal.timeout(5000),
      headers: llamaAuthHeaders(runtime.llamaApiKey),
    });
    const text = await response.text();
    const data = parseJsonSafe(text, {});
    if (!response.ok) {
      return res.status(response.status).json(claudeError("api_error", upstreamErrorMessage(data, text)));
    }
    const models = Array.isArray(data.data) ? data.data : [];
    const aliasModels = getClaudeModelAliases(runtime, models).map((id) => ({
      id,
      object: "model",
      created: models[0]?.created || Math.floor(Date.now() / 1000),
    }));
    const allModels = uniqueModelsById([...aliasModels, ...models]);
    res.json({
      data: allModels.map((model) => ({
        type: "model",
        id: model.id,
        display_name: model.id,
        created_at: model.created ? new Date(Number(model.created) * 1000).toISOString() : null,
      })),
      has_more: false,
      first_id: allModels[0]?.id || null,
      last_id: allModels.at(-1)?.id || null,
    });
  } catch (error) {
    res.status(500).json(claudeError("api_error", error.message));
  }
}

async function handleClaudeCountTokens(req, res) {
  const body = req.body || {};
  const parts = [];
  if (body.system) parts.push(core.anthropicContentToText(body.system));
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    parts.push(core.anthropicContentToText(message.content));
  }
  res.json({ input_tokens: estimateTokenCount(parts.join("\n")) });
}

async function handleClaudeMessages(req, res) {
  const startedAt = Date.now();
  try {
    const requestedInstanceId = serviceGatewaySelectedInstanceId(req);
    const runtime = await getServiceGatewayRuntime(req);
    if (!runtime?.container?.running) {
      const unavailableMessage = requestedInstanceId
        ? `Selected runtime instance ${requestedInstanceId} is not available.`
        : "Model service is not running.";
      req.serviceGatewayAccessUsage = { error: unavailableMessage };
      return res.status(503).json(claudeError("service_unavailable", unavailableMessage));
    }
    const body = req.body || {};
    const fallbackModel = runtime.servedModels?.[0]?.id || runtime.models?.[0]?.id || "";
    const requestedModel = String(body.model || fallbackModel).trim();
    const model = resolveClaudeRequestedModel(requestedModel, runtime);
    if (!model) {
      req.serviceGatewayAccessUsage = { error: "model is required." };
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 400, model: requestedModel }).catch(() => {});
      return res.status(400).json(claudeError("invalid_request_error", "model is required."));
    }
    if (!core.serviceClientAllowsModel(req.serviceGateway?.client, model)) {
      req.serviceGatewayAccessUsage = { resolvedModel: model, error: "This service client is not allowed to use the requested model.", toolSchemaCount: Array.isArray(body.tools) ? body.tools.length : 0 };
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 403, model }).catch(() => {});
      return res.status(403).json(claudeError("permission_error", "This service client is not allowed to use the requested model."));
    }

    const compressionSettings = await getClaudeCompressionSettings();
    const compression = await applyClaudeContextCompression(body, runtime, model, compressionSettings);
    const effectiveBody = compression.body;
    const stream = body.stream === true;
    const toolSchemaCount = Array.isArray(body.tools) ? body.tools.length : 0;
    const openAiBody = buildOpenAiBodyFromClaude(effectiveBody, model);
    const upstreamAbort = new AbortController();
    if (stream) {
      res.once("close", () => {
        if (!res.writableEnded) upstreamAbort.abort();
      });
    }
    const fetchOptions = {
      method: "POST",
      headers: llamaAuthHeaders(runtime.llamaApiKey, { "content-type": "application/json" }),
      body: JSON.stringify(openAiBody),
      signal: stream ? upstreamAbort.signal : AbortSignal.timeout(Number(req.serviceGateway?.timeoutMs || 120000)),
    };
    const upstream = await fetch(`http://127.0.0.1:${runtime.endpoint.port}/v1/chat/completions`, fetchOptions);

    if (stream) {
      if (!upstream.ok) return sendClaudeUpstreamError(res, upstream);
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: true, status: 200, model }).catch(() => {});
      return streamOpenAiAsClaude(upstream, res, model, {
        requestedModel,
        startedAt,
        toolSchemaCount,
        compression,
        req,
      });
    }

    const text = await upstream.text();
    const data = parseJsonSafe(text, null);
    if (!upstream.ok) {
      req.serviceGatewayAccessUsage = { resolvedModel: model, error: upstreamErrorMessage(data, text), toolSchemaCount };
      return res.status(upstream.status).json(claudeError("api_error", upstreamErrorMessage(data, text)));
    }
    const claudeResponse = core.openAiResponseToClaude(data, model);
    req.serviceGatewayAccessUsage = {
      resolvedModel: model,
      inputTokens: Number(claudeResponse.usage?.input_tokens || 0),
      outputTokens: Number(claudeResponse.usage?.output_tokens || 0),
      stopReason: claudeResponse.stop_reason,
      toolSchemaCount,
      toolUseCount: claudeResponse.content.filter((block) => block.type === "tool_use").length,
    };
    await recordClaudeBridgeUsage({
      requestedModel,
      model,
      ok: true,
      usage: claudeResponse.usage,
      latencyMs: Date.now() - startedAt,
      toolSchemaCount,
      toolUseCount: claudeResponse.content.filter((block) => block.type === "tool_use").length,
      stopReason: claudeResponse.stop_reason,
      compression,
    }).catch(() => {});
    await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, {
      ok: true,
      status: 200,
      model,
      usage: claudeResponse.usage,
    }).catch(() => {});
    res.json(claudeResponse);
  } catch (error) {
    req.serviceGatewayAccessUsage = { error: error.message };
    await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 500 }).catch(() => {});
    res.status(500).json(claudeError("api_error", error.message));
  }
}

function buildOpenAiBodyFromClaude(body, model) {
  return core.buildOpenAiChatBodyFromClaude(body, model, { defaultMaxTokens: 1024, disableQwenThinking: false });
}

function applyClaudeContextCompression(body, runtime, model, settings) {
  return core.applyClaudeContextCompression(body, runtime, model, normalizeClaudeCompressionSettings(settings), {
    defaultMaxTokens: 1024,
    language: "en-US",
  });
}

function resolveClaudeRequestedModel(requestedModel, runtime) {
  const served = getServedModelIds(runtime);
  if (!served.length) return requestedModel || "";
  if (!requestedModel) return served[0];
  if (served.includes(requestedModel)) return requestedModel;
  if (getClaudeModelAliases(runtime).includes(requestedModel) || requestedModel.startsWith("claude-")) return served[0];
  return served[0];
}

function getClaudeModelAliases(runtime, models = []) {
  const served = getServedModelIds(runtime, models);
  if (!served.length) return [];
  return Array.from(new Set(CLAUDE_MODEL_ALIASES));
}

function getServedModelIds(runtime, models = []) {
  const ids = [
    ...models.map((model) => model.id),
    ...(runtime?.servedModels || []).map((model) => model.id),
    ...(runtime?.models || []).map((model) => model.id),
  ];
  return Array.from(new Set(ids.filter(Boolean)));
}

async function streamOpenAiAsClaude(upstream, res, fallbackModel, usageContext = {}) {
  return core.streamOpenAiAsClaude(upstream, res, fallbackModel, {
    ...usageContext,
    recordUsage: recordClaudeBridgeUsage,
    isExpectedStreamDisconnect,
  });
}

function normalizeLoadFormat(value) {
  const format = String(value || "auto").trim().toLowerCase();
  return new Set(["auto", "hf", "gguf"]).has(format) ? format : "auto";
}

function normalizeGpuLayers(value) {
  const text = String(value ?? "999").trim().toLowerCase();
  if (text === "auto") return "auto";
  if (text === "all") return "all";
  if (!text) return "999";
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) return "999";
  return String(Math.floor(number));
}

function normalizeLlamaCacheType(value) {
  const type = String(value || "f16").trim().toLowerCase();
  const allowed = new Set(["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"]);
  return allowed.has(type) ? type : "f16";
}

function normalizeOnOffAuto(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  return new Set(["auto", "on", "off"]).has(mode) ? mode : "auto";
}

function normalizeDefaultTrueBoolean(...values) {
  for (const value of values) {
    if (value === false || value === 0) return false;
    if (typeof value === "string" && /^(false|0|off|no)$/i.test(value.trim())) return false;
  }
  return true;
}

function normalizeLlamaReasoningFormat(value) {
  const format = String(value || "auto").trim().toLowerCase();
  return new Set(["auto", "none", "deepseek", "deepseek-legacy"]).has(format) ? format : "auto";
}

function normalizeLlamaReasoningEffort(value) {
  const effort = String(value || "default").trim().toLowerCase();
  return new Set(["default", "minimal", "low", "medium", "high", "xhigh", "max"]).has(effort) ? effort : "default";
}

function normalizeLlamaReasoningBudget(value) {
  const number = Number(value ?? -1);
  return Number.isInteger(number) && number >= -1 && number <= 4_194_304 ? number : -1;
}

function normalizeLlamaMmprojDevice(value) {
  return cleanOptionalLaunchArg(value) || "auto";
}

const downloadCommandBuilder = core.createDownloadCommandBuilder({
  hfCli: CONFIG.hfCli,
  modelScopeCli: CONFIG.modelScopeCli,
  hfCache: CONFIG.hfCache,
  modelsRoot: CONFIG.modelsRoot,
  env: process.env,
  cleanRequired,
  resolveModelPath: resolveModelsRootChild,
  safeOutputName,
});
const {
  buildDownloadCommand,
  buildDownloadSpecFromJob,
} = downloadCommandBuilder;

function positiveTimeoutMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 60_000) return fallback;
  return Math.floor(number);
}

function normalizeReasoningParser(value) {
  const parser = String(value || "").trim().toLowerCase();
  const allowed = new Set([
    "",
    "auto",
    "qwen3",
    "deepseek_r1",
    "deepseek_v3",
    "gptoss",
    "granite",
    "hunyuan_a13b",
    "kimi_k2",
    "mistral",
    "nemotron_v3",
    "olmo3",
    "step3",
    "step3p5",
    "identity",
  ]);
  return allowed.has(parser) ? parser : "";
}

// Delegates to manager-core so the manager, service-entry, and the Host
// whitelist all agree on which address is "the LAN address". The local version
// did not skip Docker/WSL/Hyper-V adapters and could fall back to any address,
// including a public one.
function getLanAddress() {
  return core.getLanAddress();
}

function dockerGpuArg(gpuDeviceIds) {
  const ids = normalizeGpuIds(gpuDeviceIds);
  return ids.length ? `device=${ids.join(",")}` : "all";
}

function windowsPathToContainerPath(value) {
  return modelStorage.toContainerPath(value);
}

function windowsPathToContainerModel(model) {
  return windowsPathToContainerPath(model);
}

function resolveLaunchModel(model, requestedLoadFormat = "auto") {
  const input = String(model || "").trim();
  const loadFormat = normalizeLoadFormat(requestedLoadFormat);
  const ggufSelection = resolveGgufSelection(input);
  const local = ggufSelection?.local || describeLocalModelPath(input);
  const hasGgufFile = local?.stat?.isFile() && input.toLowerCase().endsWith(".gguf");
  const hasGgufDir = Boolean(local?.stat?.isDirectory() && local.ggufFiles.length);
  const hasConfig = Boolean(local?.stat?.isDirectory() && hasRecognizedConfig(local.path));
  const autoGguf = loadFormat === "auto" && (hasGgufFile || (hasGgufDir && !hasConfig) || looksLikeGgufReference(input));
  const effectiveLoadFormat = loadFormat === "gguf" || autoGguf ? "gguf" : loadFormat === "hf" ? "hf" : "auto";

  if (effectiveLoadFormat !== "gguf") {
    return {
      modelArg: windowsPathToContainerModel(input),
      effectiveLoadFormat,
      selectedGgufFile: "",
      ggufFiles: local?.ggufFiles || [],
      selectedModel: null,
      mmprojFiles: local?.ggufInventory?.mmproj || [],
      draftFiles: local?.ggufInventory?.drafts || [],
    };
  }

  if (local?.stat?.isDirectory() || hasGgufFile) {
    if (!local.ggufFiles.length || !ggufSelection?.selectedModel) {
      throw new Error(`GGUF 模式需要目录里有 .gguf 文件：${input}`);
    }
    if (hasGgufFile) {
      const requested = local.ggufInventory.files.find((item) => path.resolve(item.path) === path.resolve(local.path));
      if (requested && requested.role !== "model") {
        throw new Error(`不能把 ${requested.role} 组件作为主模型启动：${input}`);
      }
    }
    const selected = ggufSelection.selectedModel;
    if (!selected.complete) throw new Error(`GGUF 主模型分片不完整：${selected.label}`);
    return {
      modelArg: windowsPathToContainerModel(selected.launchModel),
      effectiveLoadFormat,
      selectedGgufFile: selected.path,
      ggufFiles: local.ggufFiles,
      selectedModel: selected,
      modelFiles: selected.files,
      modelBytes: selected.fileBytes,
      mmprojFiles: ggufSelection.inventory.mmproj,
      draftFiles: ggufSelection.inventory.drafts,
      ggufInventory: ggufSelection.inventory,
    };
  }

  return {
    modelArg: windowsPathToContainerModel(input),
    effectiveLoadFormat,
    selectedGgufFile: hasGgufFile ? local.path : "",
    ggufFiles: hasGgufFile ? [{ path: local.path, size: local.stat.size }] : [],
    selectedModel: null,
    modelFiles: [],
    modelBytes: 0,
    mmprojFiles: [],
    draftFiles: [],
    ggufInventory: null,
  };
}

async function getContainerStatus(containerName) {
  return runtimeSnapshotCache.get(`container:${containerName}`, () => getContainerStatusFresh(containerName));
}

async function getContainerStatusFresh(containerName) {
  try {
    const out = await docker(["ps", "-a", "--filter", `name=^/${containerName}$`, "--format", "{{json .}}"]);
    const line = out.stdout.trim();
    if (!line) return { exists: false, running: false };
    const info = JSON.parse(line);
    const labels = core.parseDockerPsLabels(info);
    return {
      exists: true,
      running: String(info.State || "").toLowerCase() === "running",
      id: info.ID || "",
      name: info.Names,
      status: info.Status,
      ports: info.Ports,
      image: info.Image,
      labels,
      createdAt: normalizeDockerTimestamp(info.CreatedAt || info.Created),
      startedAt: normalizeDockerTimestamp(info.StartedAt || info.CreatedAt || info.Created),
    };
  } catch (error) {
    return { exists: false, running: false, error: error.message };
  }
}

async function getContainerLabels(containerName) {
  const out = await docker(["inspect", containerName, "--format", "{{json .Config.Labels}}"], { rejectOnError: false });
  if (out.error || !out.stdout.trim()) return {};
  return parseJsonSafe(out.stdout.trim(), {}) || {};
}

async function getManagerResourceSummary(gpu = null, ownContainer = null) {
  const managedContainers = await listManagedContainers().catch(() => []);
  const ownName = normalizeDockerContainerName(ownContainer?.name || CONFIG.containerName);
  const peerManagers = managedContainers.filter((container) => (
    container.name !== ownName || container.manager !== CONFIG.managerId
  ));
  const runningPeers = peerManagers.filter((container) => container.running);
  const totalMb = Number(gpu?.totalMb || 0);
  const usedMb = Number(gpu?.usedMb || 0);
  return {
    gpuMemory: {
      totalMb,
      usedMb,
      freeMb: Math.max(0, totalMb - usedMb),
      source: "nvidia-smi",
      note: "GPU free memory already includes memory used by the other manager and non-manager processes.",
    },
    managedContainers,
    peerManagers,
    peerRunningCount: runningPeers.length,
    hasPeerRunning: runningPeers.length > 0,
  };
}

// The containers the metrics sampler may scrape: this manager's labelled
// containers plus the primary one, with the container id and start time that
// docker ps -a --filter name= reports (the runtimeKey needs both). The sampler
// applies the ownership and engine rules itself.
async function listMetricsSamplerContainers() {
  const managed = await listManagedContainers();
  const names = new Set([CONFIG.containerName]);
  for (const container of managed) {
    if (container.manager === CONFIG.managerId) names.add(container.name);
  }
  const statuses = await Promise.all([...names].map((name) => getContainerStatus(name)));
  return statuses.filter((status) => status?.exists);
}

// The frontend smoke tests start real managers; they must not scrape the
// engines this computer is running.
function startInstanceMetricsSampler() {
  if (process.env.AI_FRONTEND_SMOKE === "1") return;
  instanceMetricsSampler.start();
}

async function listManagedContainers() {
  const out = await docker(["ps", "-a", "--filter", `label=${MANAGER_LABEL_KEY}`, "--format", "{{json .}}"], {
    rejectOnError: false,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (out.error || !out.stdout.trim()) return [];
  const lines = out.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const containers = [];
  for (const line of lines) {
    const info = parseJsonSafe(line, null);
    if (!info) continue;
    const name = normalizeDockerContainerName(info.Names);
    if (!name) continue;
    const labels = core.parseDockerPsLabels(info);
    containers.push({
      name,
      image: info.Image || "",
      status: info.Status || "",
      running: String(info.State || "").toLowerCase() === "running",
      ports: info.Ports || "",
      manager: labels[MANAGER_LABEL_KEY] || "",
      engine: labels[MANAGER_ENGINE_LABEL_KEY] || "",
      labels,
    });
  }
  return containers.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}

async function removeManagedContainer(reason = "replace", containerName = CONFIG.containerName, expectedJobId = "") {
  const targetContainerName = normalizeDockerContainerName(containerName || CONFIG.containerName);
  // 生命周期操作要看实时容器状态，绕过快照缓存。
  const container = await getContainerStatusFresh(targetContainerName);
  if (!container.exists) return { removed: false, containerName: targetContainerName };
  const owner = container.labels?.[MANAGER_LABEL_KEY] || "";
  const runtimeApiKeyRef = String(container.labels?.[MANAGER_APIKEY_REF_LABEL_KEY] || "");
  if (owner && owner !== CONFIG.managerId) {
    const error = new Error(`Refusing to remove ${targetContainerName}; it belongs to ${owner}.`);
    error.code = "CONTAINER_OWNED_BY_OTHER_MANAGER";
    error.status = 409;
    throw error;
  }
  const containerJobId = String(container.labels?.["ai.manager.job"] || "");
  if (expectedJobId && containerJobId !== String(expectedJobId)) {
    const error = new Error(`Refusing to remove ${targetContainerName}; it belongs to serve job ${containerJobId || "unknown"}, not ${expectedJobId}.`);
    error.code = "CONTAINER_OWNED_BY_OTHER_JOB";
    error.status = 409;
    throw error;
  }
  const leaseId = String(container.labels?.["ai.manager.gpu-admission-lease"] || "").trim();
  if (leaseId) await gpuAdmissionController.release(leaseId, reason || "container-stop").catch(() => {});
  await docker(["rm", "-f", targetContainerName]);
  if (runtimeApiKeyRef) await runtimeApiKeyStore.remove(runtimeApiKeyRef).catch(() => {});
  clearRuntimeInstancesCache();
  runtimeSupervisor.emitInstances({ removed: [llamaInstanceId(targetContainerName, container.labels)] });
  return { removed: true, containerName: targetContainerName, owner: owner || null, jobId: containerJobId || null, reason };
}

function getLlamaApiKey(container) {
  const reference = String(container?.labels?.[MANAGER_APIKEY_REF_LABEL_KEY] || "");
  if (reference) {
    const secret = runtimeApiKeyStore.get(reference);
    if (!secret) {
      const error = new Error("The runtime API-key reference cannot be resolved. Restore the protected runtime key store before managing this model.");
      error.code = "RUNTIME_API_KEY_UNAVAILABLE";
      error.status = 503;
      throw error;
    }
    return secret;
  }
  return String(container?.labels?.[MANAGER_APIKEY_LABEL_KEY] || "");
}

function llamaAuthHeaders(apiKey, base = {}) {
  return apiKey ? { ...base, authorization: `Bearer ${apiKey}` } : base;
}

async function getServedModels(port, apiKey = "") {
  return runtimeSnapshotCache.get(`served-models:${port}`, () => getServedModelsFresh(port, apiKey));
}

async function getServedModelsFresh(port, apiKey = "") {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(2500),
      headers: llamaAuthHeaders(apiKey),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.data) ? data.data : [];
  } catch {
    return [];
  }
}

function runtimeFactsFromContainerLabels(labels = {}) {
  const positive = (key) => {
    const value = Number(labels[key]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const enabled = (key) => String(labels[key] || "").toLowerCase() === "true";
  return {
    maxModelLen: positive("ai.manager.max-model-len"),
    maxNumSeqs: positive("ai.manager.max-num-seqs"),
    gpuLayers: String(labels["ai.manager.gpu-layers"] || "") || null,
    tensorSplit: String(labels["ai.manager.tensor-split"] || "") || null,
    cacheTypeK: String(labels["ai.manager.cache-type-k"] || "") || null,
    cacheTypeV: String(labels["ai.manager.cache-type-v"] || "") || null,
    speculativeMode: String(labels["ai.manager.speculative-mode"] || "") || null,
    reasoningEffort: String(labels["ai.manager.reasoning-effort"] || "") || null,
    reasoningBudget: Number.isFinite(Number(labels["ai.manager.reasoning-budget"])) ? Number(labels["ai.manager.reasoning-budget"]) : null,
    mmprojDevice: String(labels["ai.manager.mmproj-device"] || "") || null,
    textOnlyMode: enabled("ai.manager.text-only"),
    mmproj: enabled("ai.manager.mmproj"),
    dflash: enabled("ai.manager.draft-model"),
  };
}

async function getRunningModelSummary(container = null, gpu = null, options = {}) {
  const activeContainer = container || await getContainerStatus(CONFIG.containerName);
  const endpoint = getContainerEndpoint(activeContainer);
  const llamaApiKey = getLlamaApiKey(activeContainer);
  const servedModels = activeContainer.running ? await getServedModels(endpoint.port, llamaApiKey) : [];
  const includeMetrics = options.includeMetrics !== false;
  const runtimeStats = activeContainer.running && includeMetrics
    ? await collectVllmMetricsSummary(activeContainer, gpu).catch(() => null)
    : null;
  const historicalStats = includeMetrics
    ? await loadStatsLedger().then((ledger) => core.statsLedgerToSummary(ledger)).catch(() => null)
    : null;
  const gpuMemoryPercent = gpu?.ok && Number(gpu.totalMb) > 0
    ? (Number(gpu.usedMb || 0) / Number(gpu.totalMb)) * 100
    : 0;
  const gpuText = gpu?.ok
    ? `${gpu.usedMb}/${gpu.totalMb} MB (${gpuMemoryPercent.toFixed(1)}% VRAM · ${gpu.util}% util)`
    : "";
  const runtimeLabelFacts = runtimeFactsFromContainerLabels(activeContainer.labels || {});
  const models = servedModels.map((model) => {
    const createdSeconds = Number(model.created);
    const modelStats = runtimeStats?.modelsByName?.[model.id] || null;
    const historicalModelStats = historicalStats?.modelsByName?.[model.id] || null;
    return {
      id: model.id,
      object: model.object || "model",
      created: model.created || null,
      createdAt: Number.isFinite(createdSeconds) ? new Date(createdSeconds * 1000).toISOString() : null,
      ownedBy: model.owned_by || model.ownedBy || "",
      root: model.root || "",
      parent: model.parent || "",
      maxModelLen: model.max_model_len || model.maxModelLen || runtimeLabelFacts.maxModelLen || null,
      maxNumSeqs: runtimeLabelFacts.maxNumSeqs,
      gpuLayers: runtimeLabelFacts.gpuLayers,
      tensorSplit: runtimeLabelFacts.tensorSplit,
      cacheTypeK: runtimeLabelFacts.cacheTypeK,
      cacheTypeV: runtimeLabelFacts.cacheTypeV,
      speculativeMode: runtimeLabelFacts.speculativeMode,
      reasoningEffort: runtimeLabelFacts.reasoningEffort,
      reasoningBudget: runtimeLabelFacts.reasoningBudget,
      mmprojDevice: runtimeLabelFacts.mmprojDevice,
      textOnlyMode: runtimeLabelFacts.textOnlyMode,
      mmproj: runtimeLabelFacts.mmproj,
      dflash: runtimeLabelFacts.dflash,
      containerName: activeContainer.name || CONFIG.containerName,
      containerStatus: activeContainer.status || "",
      image: activeContainer.image || "",
      apiBaseUrl: endpoint.serviceUrl,
      localApiBaseUrl: endpoint.localUrl,
      port: endpoint.port,
      gpu: gpuText,
      contextUsedTokens: modelStats?.context?.activeTokens || 0,
      contextCapacityTokens: modelStats?.context?.capacityTokens || null,
      contextUsagePercent: modelStats?.context?.kvUsagePercent || 0,
      requests: Math.max(Number(modelStats?.requests?.total || 0), Number(historicalModelStats?.requests?.total || 0)),
      promptTokens: Math.max(Number(modelStats?.tokens?.prompt || 0), Number(historicalModelStats?.tokens?.prompt || 0)),
      outputTokens: Math.max(Number(modelStats?.tokens?.generation || 0), Number(historicalModelStats?.tokens?.generation || 0)),
      runningRequests: Number(modelStats?.requests?.running || 0),
      waitingRequests: Number(modelStats?.requests?.waiting || 0),
      canUnload: activeContainer.exists,
    };
  });

  return {
    container: activeContainer,
    endpoint,
    servedModels,
    models,
    llamaApiKey,
    apiKeyRequired: Boolean(llamaApiKey),
    canUnload: activeContainer.exists,
    unloadStopsContainer: true,
    note: "llama.cpp keeps one model resident in the server process. Unloading from this manager stops the managed llama.cpp container, but leaves the manager and other Docker services alone.",
  };
}

function clearRuntimeInstancesCache() {
  runtimeInstancesCache = { value: null, expiresAt: 0, promise: null };
}

async function getRunningModelSummaries() {
  const now = Date.now();
  if (runtimeInstancesCache.value) {
    if (runtimeInstancesCache.expiresAt <= now && !runtimeInstancesCache.promise) {
      getRunningModelSummariesFresh().catch(() => {});
    }
    return runtimeInstancesCache.value;
  }
  if (runtimeInstancesCache.promise) return runtimeInstancesCache.promise;
  return getRunningModelSummariesFresh();
}

function getRunningModelSummariesFresh() {
  runtimeInstancesCache.promise = Promise.resolve().then(async () => {
    const managed = (await listManagedContainers()).filter((container) => (
      container.manager === CONFIG.managerId && instanceCatalog.isHosted(container)
    ));
    const primary = await getContainerStatus(CONFIG.containerName);
    const primaryOwner = primary.labels?.[MANAGER_LABEL_KEY] || "";
    if (primary.exists && (!primaryOwner || primaryOwner === CONFIG.managerId) && !managed.some((item) => item.name === CONFIG.containerName)) {
      managed.unshift(primary);
    }
    const summaries = await Promise.all(managed.map(async (container) => {
      const status = await getContainerStatus(container.name);
      // 携带负载指标（running/waiting），统一网关据此做负载感知路由。
      return getRunningModelSummary(status, null, { includeMetrics: true });
    }));
    summaries.sort((a, b) => Number(b.container?.name === CONFIG.containerName) - Number(a.container?.name === CONFIG.containerName));
    runtimeInstancesCache.value = summaries;
    runtimeInstancesCache.expiresAt = Date.now() + RUNTIME_INSTANCES_CACHE_MS;
    return summaries;
  }).finally(() => {
    runtimeInstancesCache.promise = null;
  });
  return runtimeInstancesCache.promise;
}

function legacyRuntimeInstance(runtime) {
  const container = runtime.container || {};
  const labels = container.labels || {};
  const primary = container.name === CONFIG.containerName;
  const servedModels = Array.isArray(runtime.servedModels) ? runtime.servedModels : [];
  const enrichedModels = Array.isArray(runtime.models) && runtime.models.length ? runtime.models : servedModels;
  const lastKnownModel = String(labels["ai.manager.model"] || "").trim();
  const instanceModels = enrichedModels.length
    ? enrichedModels
    : lastKnownModel ? [{ id: lastKnownModel, lastKnown: true }] : [];
  return {
    id: llamaInstanceId(container.name, labels),
    instanceMode: primary ? "replace" : labels["ai.manager.instance-mode"] || "parallel",
    primary,
    containerName: container.name,
    running: Boolean(container.running),
    status: container.status || "",
    image: container.image || "",
    port: runtime.endpoint?.port || Number(labels["ai.manager.port"] || 0),
    gpuIds: normalizeGpuIds(labels["ai.manager.gpu-ids"] || ""),
    vramReservationMb: Number(labels["ai.manager.vram-reservation-mb"] || 0),
    gpuMemoryUtilization: Number(labels["ai.manager.gpu-memory-utilization"] || 0),
    localBaseUrl: runtime.endpoint?.localUrl || null,
    lanBaseUrl: runtime.endpoint?.lanUrl || null,
    requestsTotal: instanceModels.reduce((sum, model) => sum + Number(model.requests || 0), 0),
    activeRequests: instanceModels.reduce((sum, model) => sum + Number(model.runningRequests || 0), 0),
    queuedRequests: instanceModels.reduce((sum, model) => sum + Number(model.waitingRequests || 0), 0),
    models: instanceModels.map((model) => ({
      id: model.id,
      root: model.root || "",
      maxModelLen: model.max_model_len || model.maxModelLen || null,
      requestsTotal: Number.isFinite(Number(model.requests)) ? Number(model.requests) : 0,
      runningRequests: Number.isFinite(Number(model.runningRequests)) ? Number(model.runningRequests) : null,
      waitingRequests: Number.isFinite(Number(model.waitingRequests)) ? Number(model.waitingRequests) : null,
      lastKnown: Boolean(model.lastKnown),
    })),
  };
}

// GET /api/instances[?include=sleeping]: the legacy item plus the typed fields
// (01 §16.4). Sleeping records are listed only on request, so the default set
// is the set of containers, as before.
async function listRuntimeInstancesRequest({ query } = {}) {
  const summaries = await getRunningModelSummaries();
  const includeRaw = Array.isArray(query?.include) ? query.include.join(",") : String(query?.include || "");
  const includeSleeping = includeRaw.split(",").map((part) => part.trim().toLowerCase()).includes("sleeping");
  const instances = summaries.map((runtime) => {
    const legacy = legacyRuntimeInstance(runtime);
    return { ...legacy, ...instanceCatalog.typed(legacy, runtime.container || {}) };
  });
  if (includeSleeping) instances.push(...await instanceCatalog.sleeping());
  return {
    ok: true,
    primaryContainer: CONFIG.containerName,
    supportsParallel: true,
    instances,
  };
}

async function stopRuntimeInstanceRequest({ id } = {}) {
  const requested = decodeURIComponent(String(id || ""));
  if (requested === "primary") {
    const existing = await getContainerStatusFresh(CONFIG.containerName);
    if (!existing.exists) throw Object.assign(new Error("Runtime instance not found."), { status: 404 });
    await snapshotCurrentStats("before-stop").catch(() => {});
    await removeManagedContainer("instance-stop");
    return { ok: true, id: requested, containerName: CONFIG.containerName, stopped: true };
  }
  const managed = (await listManagedContainers()).filter((container) => (
    container.manager === CONFIG.managerId && instanceCatalog.isHosted(container)
  ));
  const target = managed.find((container) => (
    container.name === requested
    || container.labels?.["ai.manager.instance"] === requested
  ));
  if (!target) throw Object.assign(new Error("Runtime instance not found."), { status: 404 });
  const leaseId = String(target.labels?.["ai.manager.gpu-admission-lease"] || "").trim();
  if (leaseId) await gpuAdmissionController.release(leaseId, "instance-stop").catch(() => {});
  await docker(["rm", "-f", target.name]);
  const runtimeApiKeyRef = String(target.labels?.[MANAGER_APIKEY_REF_LABEL_KEY] || "");
  if (runtimeApiKeyRef) await runtimeApiKeyStore.remove(runtimeApiKeyRef).catch(() => {});
  clearRuntimeInstancesCache();
  runtimeSupervisor.emitInstances({ removed: [llamaInstanceId(target.name, target.labels)] });
  return { ok: true, id: requested, containerName: target.name, stopped: true };
}

function getContainerEndpoint(container) {
  const published = parseDockerPortPublish(container?.ports);
  const port = published?.port || CONFIG.defaultPort;
  const boundHost = published?.host || "127.0.0.1";
  const lanHost = published?.lanHost || (isWildcardHost(boundHost) ? getLanAddress() : (!isLoopbackHost(boundHost) ? stripHostBrackets(boundHost) : null));
  const publicHost = lanHost || stripHostBrackets(boundHost);
  const displayHost = publicHost.includes(":") ? `[${publicHost}]` : publicHost;
  return {
    port,
    boundHost,
    localHost: published?.localHost || "127.0.0.1",
    lanHost,
    publishedHosts: published?.bindings || [],
    host: publicHost,
    serviceUrl: `http://${displayHost}:${port}/v1`,
    localUrl: `http://127.0.0.1:${port}/v1`,
    lanUrl: lanHost ? `http://${lanHost.includes(":") ? `[${lanHost}]` : lanHost}:${port}/v1` : null,
    compat: getCompatibilityEndpoints(port, boundHost, displayHost, lanHost),
  };
}

function getCompatibilityEndpoints(servicePort, boundHost, displayHost, lanHost = null) {
  return core.buildCompatibilityEndpoints({
    servicePort,
    boundHost,
    displayHost,
    lanHost,
    managerPort: PORT,
    managerHost: HOST,
    getLanAddress,
  });
}

async function stopVllmContainer() {
  await snapshotCurrentStats("before-stop").catch(() => {});
  return removeManagedContainer("stop");
}

async function collectStats() {
  const [gpu, container] = await Promise.all([
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
  ]);
  // The stats sampler scrapes the engine every 10 s (04 TEL-1). A poll reads
  // its newest sample and never scrapes, and the ledger it merges is a
  // preview; the sampler writes the file at most once a minute. The cache-hit
  // monitor polls /slots every 2 s, so the poll reads its summary too.
  const { summary: liveSummary, latency } = core.telemetry.sampledStatsSummary(statsSampler, "primary", {
    container,
    gpu,
    empty: emptyRuntimeStatsSummary(container),
  });
  const ledger = await previewStatsLedger(liveSummary);
  const cacheHit = await cacheHitTracker.getSummary();
  const merged = core.mergeLiveAndStatsLedger(liveSummary, ledger);
  const summary = core.telemetry.applyStatsWindows(
    { ...merged, totals: withSpeedWindowSeconds(merged.totals, merged.models) },
    latency,
  );
  const pricing = core.loadModelPricing();
  const costComparison = priceProfiles().map((profile) => calculateCost(summary.totals.tokens, profile));
  const clientUsage = buildClientUsageSummary(summary.totals, ledger);
  const recentAccess = await collectRecentAccessStats({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    maxLines: 5000,
  }).catch((error) => ({ ok: false, error: error.message, sources: [] }));
  const response = {
    ok: true,
    updatedAt: new Date().toISOString(),
    container,
    endpoint: getContainerEndpoint(container),
    gpu,
    pricingAsOf: pricing.value?.asOf || "",
    pricingUnit: pricing.unit,
    pricingSources: pricing.sources,
    // Lets the stats view flag a comparison built on months-old prices.
    pricingFreshness: pricing.freshness,
    pricingSource: pricing.source,
    ...summary,
    live: core.telemetry.applyStatsWindows(liveSummary, latency),
    historical: core.statsLedgerToSummary(ledger),
    clientUsage,
    recentAccess,
    cacheHit,
    costComparison,
  };
  // The sampler records the history once a minute; trends only reads it.
  const trends = await metricsHistoryStore.getMetricsHistory({ hours: 24 }).catch(() => ({ hours: 24, samples: [] }));
  response.trends = { ...trends, samples: core.telemetry.downsampleTrendSamples(trends.samples) };
  return response;
}

async function snapshotCurrentStats(reason = "snapshot") {
  const [gpu, container] = await Promise.all([
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
  ]);
  if (!container?.running) return null;
  const summary = await collectVllmMetricsSummary(container, gpu);
  const ledger = await updateStatsLedger(summary, reason);
  return ledger;
}

async function collectVllmMetricsSummary(container, gpu, options = {}) {
  const cacheKey = `metrics-summary:${container?.name || container?.id || "none"}:${container?.running ? 1 : 0}`;
  return runtimeSnapshotCache.get(cacheKey, () => collectVllmMetricsSummaryFresh(container, gpu, options));
}

function emptyRuntimeStatsSummary(container) {
  return core.emptyStatsSummary(container, getContainerEndpoint(container), {
    stoppedNote: "llama.cpp container is not running.",
    missingNote: "No managed llama.cpp container is running.",
  });
}

// options.capture, when given, receives the raw /metrics text, its time and
// the latency histograms of this read for the stats sampler (04 TEL-1).
async function collectVllmMetricsSummaryFresh(container, gpu, options = {}) {
  const endpoint = getContainerEndpoint(container);
  const llamaApiKey = getLlamaApiKey(container);
  const empty = emptyRuntimeStatsSummary(container);
  if (!container?.running) return empty;

  let metricsText = "";
  let scrapedAt = "";
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/metrics`, {
      signal: AbortSignal.timeout(4000),
      headers: llamaAuthHeaders(llamaApiKey),
    });
    if (!response.ok) throw new Error(`metrics returned ${response.status}`);
    metricsText = await response.text();
    scrapedAt = new Date().toISOString();
  } catch (error) {
    return { ...empty, error: error.message };
  }

  const servedModels = await getServedModels(endpoint.port, llamaApiKey).catch(() => []);
  const factModelHints = Array.from(new Set(servedModels
    .flatMap((model) => [model.id, model.root])
    .filter(Boolean)));
  // Facts come from this container's logs and its own serve jobs (08 P0-3).
  const facts = await getLatestRuntimeFacts(factModelHints, { containerName: container.name }).catch(() => ({}));
  const servedById = Object.fromEntries(servedModels.map((model) => [model.id, model]));
  const metrics = parsePrometheusMetrics(metricsText);
  const processStartSeconds = firstMetricValue(metrics, "process_start_time_seconds")
    || timestampToSeconds(container.startedAt || container.createdAt)
    || null;
  const nowSeconds = Date.now() / 1000;
  const uptimeSeconds = processStartSeconds ? Math.max(0, nowSeconds - processStartSeconds) : null;
  const models = buildModelStats(metrics, servedById, facts, nowSeconds, {
    // A parallel container keeps its own recent-rate samples, so a model it
    // shares with the primary cannot reset the primary's window.
    sampleScope: container.name && container.name !== CONFIG.containerName ? container.name : "",
  });
  const totals = withSpeedWindowSeconds(aggregateStats(models, uptimeSeconds), models);
  const modelsByName = Object.fromEntries(models.map((model) => [model.name, model]));
  if (options.capture && typeof options.capture === "object") {
    options.capture.text = metricsText;
    options.capture.scrapedAt = scrapedAt;
    // llama.cpp series carry no model_name, so they all belong to the model.
    options.capture.histograms = core.telemetry.latencyHistogramsFromSeries(metrics, models.map((model) => model.name), {
      includeUnlabeled: true,
    });
  }

  return {
    source: `http://127.0.0.1:${endpoint.port}/metrics`,
    processStartSeconds,
    uptimeSeconds,
    facts,
    totals,
    models,
    modelsByName,
    gpu,
    rawMetricCount: metrics.length,
  };
}

function buildModelStats(metrics, servedById, facts, nowSeconds, options = {}) {
  const names = new Set(metrics.map((metric) => metric.labels.model_name).filter(Boolean));
  for (const name of Object.keys(servedById || {})) names.add(name);
  if (!names.size && metrics.some((metric) => metric.name?.startsWith("llamacpp:"))) {
    names.add(facts.modelName || "llama.cpp");
  }
  const llamaMetrics = metrics.some((metric) => metric.name?.startsWith("llamacpp:"));
  const models = [];
  for (const name of names) {
    const scoped = llamaMetrics ? metrics : metrics.filter((metric) => metric.labels.model_name === name);
    const promptTokens = sumMetric(scoped, "llamacpp:prompt_tokens_total") || sumMetric(scoped, "vllm:prompt_tokens_total");
    const generationTokens = sumMetric(scoped, "llamacpp:tokens_predicted_total") || sumMetric(scoped, "vllm:generation_tokens_total");
    const cachedPromptTokens = sumMetric(scoped, "vllm:prompt_tokens_cached_total");
    const successByReason = sumByLabel(scoped, "vllm:request_success_total", "finished_reason");
    const requestCount = Object.values(successByReason).reduce((sum, value) => sum + value, 0)
      || sumMetric(scoped, "vllm:request_prompt_tokens_count")
      || sumMetric(scoped, "llamacpp:requests_total")
      || facts.llamaCompletedRequests
      || 0;
    const errorCount = Number(successByReason.error || 0);
    const abortedCount = Number(successByReason.abort || 0);
    const runningCount = firstMetricValue(scoped, "vllm:num_requests_running")
      ?? firstMetricValue(scoped, "llamacpp:requests_processing")
      ?? 0;
    const waitingCount = firstMetricValue(scoped, "vllm:num_requests_waiting")
      ?? firstMetricValue(scoped, "llamacpp:requests_deferred")
      ?? 0;
    const kvUsagePercent = firstMetricValue(scoped, "llamacpp:kv_cache_usage_ratio")
      || firstMetricValue(scoped, "vllm:kv_cache_usage_perc")
      || 0;
    const capacityTokens = facts.kvCacheTokens || deriveKvCapacityTokens(scoped, servedById?.[name], facts);
    const activeTokens = firstMetricValue(scoped, "llamacpp:kv_cache_tokens")
      || (runningCount ? facts.llamaLastPromptTokens || firstMetricValue(scoped, "llamacpp:n_tokens_max") : null)
      || (capacityTokens ? Math.round(capacityTokens * kvUsagePercent) : null);
    const promptBySource = sumByLabel(scoped, "vllm:prompt_tokens_by_source_total", "source");
    const prefixQueries = sumMetric(scoped, "vllm:prefix_cache_queries_total");
    const prefixHits = sumMetric(scoped, "vllm:prefix_cache_hits_total");
    const sampleKey = options.sampleScope ? `${options.sampleScope}:${name}` : name;
    const recent = core.calculateRecentRates(statsSamples, sampleKey, nowSeconds, {
      promptTokens,
      generationTokens,
      requestCount,
    });
    const averagePromptGauge = firstMetricValue(scoped, "llamacpp:prompt_tokens_seconds");
    const averageOutputGauge = firstMetricValue(scoped, "llamacpp:predicted_tokens_seconds");

    models.push({
      name,
      root: servedById?.[name]?.root || "",
      maxModelLen: servedById?.[name]?.max_model_len
        || servedById?.[name]?.maxModelLen
        || servedById?.[name]?.meta?.n_ctx
        || null,
      tokens: {
        prompt: promptTokens,
        generation: generationTokens,
        cachedPrompt: cachedPromptTokens,
        total: promptTokens + generationTokens,
        promptBySource,
      },
      requests: {
        total: requestCount,
        success: Math.max(0, requestCount - errorCount - abortedCount),
        error: errorCount,
        aborted: abortedCount,
        byFinishReason: successByReason,
        running: runningCount,
        waiting: waitingCount,
      },
      latency: {
        avgE2eSeconds: histogramAverage(scoped, "vllm:e2e_request_latency_seconds") || facts.llamaAvgTotalSeconds,
        avgTtftSeconds: histogramAverage(scoped, "vllm:time_to_first_token_seconds") || facts.llamaAvgPromptEvalSeconds,
        avgInterTokenSeconds: histogramAverage(scoped, "vllm:inter_token_latency_seconds"),
        avgTimePerOutputTokenSeconds: histogramAverage(scoped, "vllm:request_time_per_output_token_seconds")
          || (facts.llamaAvgEvalSeconds && facts.llamaAvgOutputTokens ? facts.llamaAvgEvalSeconds / facts.llamaAvgOutputTokens : null),
        avgQueueSeconds: histogramAverage(scoped, "vllm:request_queue_time_seconds"),
      },
      averages: {
        promptTokensPerRequest: histogramAverage(scoped, "vllm:request_prompt_tokens")
          || facts.llamaAvgPromptTokens
          || (requestCount ? promptTokens / requestCount : null),
        outputTokensPerRequest: histogramAverage(scoped, "vllm:request_generation_tokens")
          || facts.llamaAvgOutputTokens
          || (requestCount ? generationTokens / requestCount : null),
        requestedMaxTokens: histogramAverage(scoped, "vllm:request_params_max_tokens"),
      },
      // llamacpp:*_tokens_seconds are averages since the server started, so
      // they only feed the averages; the recent rates come from the token
      // counters through the sampling window (08 P0-7).
      speed: {
        ...recent,
        windowSeconds: Number(recent.windowSeconds || 0),
        outputSource: "counter_window",
        outputObservedAt: null,
        averagePromptTokensPerSecond: averagePromptGauge || null,
        averageOutputTokensPerSecond: averageOutputGauge
          || tokensPerSecondFromSeconds(histogramAverage(scoped, "vllm:request_time_per_output_token_seconds")),
        // 04 TEL-1: says when an average above is a llama.cpp lifetime gauge.
        averageSource: averagePromptGauge || averageOutputGauge ? core.telemetry.AVERAGE_SOURCE_LIFETIME_GAUGE : null,
        lifetimeTokensPerSecond: null,
      },
      cache: {
        prefixQueries,
        prefixHits,
        prefixHitRate: prefixQueries ? prefixHits / prefixQueries : 0,
      },
      context: {
        activeTokens,
        capacityTokens,
        kvUsagePercent,
        maxModelLen: servedById?.[name]?.max_model_len
          || servedById?.[name]?.maxModelLen
          || servedById?.[name]?.meta?.n_ctx
          || null,
        concurrencyAtMaxLen: facts.maxConcurrency || null,
      },
    });
  }
  return models.sort((a, b) => b.tokens.total - a.tokens.total);
}

// aggregateStats keeps its shape; the totals also carry the longest per-model
// window so the summary can label its "{n} s average" (08 P0-7).
function withSpeedWindowSeconds(totals, models) {
  if (!totals?.speed) return totals;
  const windows = (models || [])
    .map((model) => Number(model?.speed?.windowSeconds || 0))
    .filter((value) => value > 0);
  return { ...totals, speed: { ...totals.speed, windowSeconds: windows.length ? Math.max(...windows) : 0 } };
}

function buildClientUsageSummary(totals, ledger) {
  return buildCoreClientUsageSummary(totals, ledger, {
    claude: {
      id: "claude",
      label: "Claude 兼容桥",
      description: "经管理器 /claude/v1/messages 进入本地 llama.cpp 的 Claude Desktop / Claude Code / Cowork 请求。",
    },
    other: {
      id: "chat-direct",
      label: "OpenWebUI / 直连 API",
      description: "OpenAI 兼容接口、OpenWebUI 聊天和没有经过 Claude 桥的请求。",
    },
    note: "Claude 只统计通过管理器 Claude 兼容桥的请求；OpenWebUI 或直接访问 llama.cpp /v1 的请求会归入聊天/直连。",
  });
}

function deriveKvCapacityTokens(metrics, servedModel, facts) {
  if (facts.maxContextTokens && facts.parallelSlots) {
    return Math.round(facts.maxContextTokens * facts.parallelSlots);
  }
  if (facts.maxContextTokens && facts.maxConcurrency) {
    return Math.round(facts.maxContextTokens * facts.maxConcurrency);
  }
  const servedContext = Number(servedModel?.max_model_len || servedModel?.maxModelLen || servedModel?.meta?.n_ctx || servedModel?.meta?.n_ctx_train || 0);
  if (servedContext) return Math.round(servedContext * Number(facts.parallelSlots || 1));
  const cacheInfo = metrics.find((metric) => metric.name === "vllm:cache_config_info");
  const hasMambaBlock = cacheInfo?.labels?.mamba_block_size && cacheInfo.labels.mamba_block_size !== "None";
  const blocks = Number(cacheInfo?.labels?.num_gpu_blocks || 0);
  const blockSize = Number(cacheInfo?.labels?.block_size || 0);
  if (!hasMambaBlock && blocks && blockSize) return blocks * blockSize;
  return null;
}

async function getLatestRuntimeFacts(modelHints = [], options = {}) {
  // Without containerName the primary container is read, as before.
  const containerName = String(options.containerName || CONFIG.containerName);
  const out = await docker(["logs", "--tail", "2000", containerName], { rejectOnError: false });
  const needles = core.normalizeRuntimeFactHints(modelHints);
  const containerServeJobs = core.serveJobsForContainer(jobs.values(), containerName, {
    primaryContainerName: CONFIG.containerName,
  });
  const jobText = containerServeJobs
    .filter((job) => !needles.length || jobMatchesRuntimeFactHints(job, needles))
    .map((job) => (job.logs || []).join("\n"))
    .join("\n");
  const latestServe = containerServeJobs.at(-1);
  const text = `${jobText}\n${out.stdout || ""}${out.stderr || ""}`;
  return {
    modelName: latestServe?.meta?.name || null,
    maxContextTokens: Number(latestServe?.meta?.maxModelLen || lastIntegerMatch(text, /(?:n_ctx|ctx-size|ctx_size)\s*[=:]\s*([\d,]+)/gi)) || null,
    parallelSlots: Number(latestServe?.meta?.maxNumSeqs || lastIntegerMatch(text, /(?:n_parallel|parallel)\s*[=:]\s*([\d,]+)/gi)) || null,
    splitMode: latestServe?.meta?.multiGpuMode || null,
    tensorSplit: latestServe?.meta?.tensorSplit || null,
    gpuLayers: latestServe?.meta?.gpuLayers || null,
    // Engine-measured load facts come from the llamacpp descriptor's logFacts
    // (01 §16.2), not from vLLM log patterns llama.cpp never prints.
    logFacts: core.engines.extractLogFacts(engineRegistry.get("llamacpp"), text),
    llamaCompletedRequests: countUniqueCaptures(text, /slot\s+print_timing:.*?\|\s*task\s+(\d+)\s*\|.*?total time\s*=/gi),
    llamaAvgPromptEvalSeconds: averageCapture(text, /prompt eval time\s*=\s*([\d.]+)\s*ms/gi, 0.001),
    llamaAvgEvalSeconds: averageCapture(text, /\beval time\s*=\s*([\d.]+)\s*ms/gi, 0.001),
    llamaAvgTotalSeconds: averageCapture(text, /total time\s*=\s*([\d.]+)\s*ms/gi, 0.001),
    llamaAvgPromptTokens: averageCapture(text, /prompt eval time\s*=\s*[\d.]+\s*ms\s*\/\s*([\d,]+)\s*tokens/gi, 1),
    llamaAvgOutputTokens: averageCapture(text, /\beval time\s*=\s*[\d.]+\s*ms\s*\/\s*([\d,]+)\s*tokens/gi, 1),
    llamaLastPromptTokens: lastIntegerMatch(text, /slot\.prompt\.tokens\.size\(\)\s*=\s*([\d,]+)/gi),
  };
}

function jobMatchesRuntimeFactHints(job, needles) {
  return core.jobMatchesRuntimeFactHints(job, needles);
}

async function loadJobsLedgerIntoMemory() {
  return jobsLedgerStore.loadJobsLedgerIntoMemory();
}

function scheduleJobsSave(delayMs = 600) {
  return jobsLedgerStore.scheduleJobsSave(delayMs);
}

async function saveJobsLedgerNow() {
  return jobsLedgerStore.saveJobsLedgerNow();
}

function createJob(type, title, meta = {}, options = {}) {
  return jobsLedgerStore.createJob(type, title, meta, options);
}

function appendLog(job, data) {
  return jobsLedgerStore.appendLog(job, data);
}

function finishJob(job, meta = {}) {
  return jobsLedgerStore.finishJob(job, meta);
}

function failJob(job, error) {
  // 下载失败要带上新鲜的 failedAt，否则自动续传会把它当成重启前的旧任务跳过。
  if (job?.type === "download" && job.meta) job.meta.failedAt = Date.now();
  // The supervisor fails a serve job itself; the caller's second failJob is a
  // no-op and must not add a second "failed" launch event.
  const wasActive = job?.status === "running" || job?.status === "queued";
  const result = jobsLedgerStore.failJob(job, error);
  if (wasActive && job?.type === "serve" && job.meta?.launchId) {
    trackLaunch(() => launchStore.markStatus(job.meta.launchId, "failed", { event: "failed", detail: job.error || "" }));
  }
  return result;
}

function setJobProgress(job, progress = {}) {
  return jobsLedgerStore.setJobProgress(job, progress);
}

function createProcessJob(type, command, args, options = {}) {
  const job = createJob(type, options.title || type, options.meta || {});
  spawnJobProcess(job, command, args, options);
  return job;
}

const spawnJobProcess = createProcessJobRunner({
  beforeStart: (job) => {
    if (job.type !== "download") return;
    const target = modelStorage.resolvePath(job.meta.localDir, { allowRoot: false });
    job.meta.storageLock = modelStorage.acquireOperation([target], "download");
  },
  afterStart: (job, child) => { if (job.type === "download") modelStorage.trackChild(job.meta.storageLock, child.pid); },
  appendLog,
  finishJob,
  failJob,
  scheduleSave: scheduleJobsSave,
  startProgressTracker,
  handleDownloadCancel: async (job) => {
    if (job.meta?.cancelAction === "pause") pauseDownloadJobAfterStop(job);
    else if (job.meta?.cancelAction === "stall") downloadJobController.handleDownloadStallAfterStop(job);
    else await finalizeDownloadCancel(job, { deletePartial: false });
  },
  handleProcessSuccess: async (job) => {
    if (job.type !== "download") return;
    const verification = await verifyDownloadedModel({ localDir: job.meta?.localDir }, { strictIncomplete: true });
    job.meta = {
      ...(job.meta || {}),
      verification: {
        ok: verification.ok,
        status: verification.status,
        modelFormat: verification.modelFormat,
        expectedWeightFiles: verification.expectedWeightFiles,
        missingWeightFiles: verification.missingWeightFiles,
        checkedAt: new Date().toISOString(),
      },
    };
    if (!verification.ok) {
      const detail = (verification.issues || [])
        .filter((item) => item.severity === "fail")
        .map((item) => `${item.title}: ${item.detail}`)
        .join("；");
      appendLog(job, `Download verification failed: ${detail}`);
      throw new Error(`下载命令已结束，但模型完整性校验失败：${detail || "模型文件不完整"}`);
    }
    appendLog(job, `Download verification passed: ${verification.modelFormat}; ${verification.expectedWeightFiles || verification.gguf || verification.safetensors} weight file(s).`);
    await runDownloadChecksumVerification(job);
    await appendDownloadFitSummary(job);
  },
  closeHandlerErrorMode: "fail",
  onDone: (job) => {
    if (job.type === "download") { modelStorage.releaseOperation(job.meta?.storageLock); drainDownloadQueue(); }
  },
});

const downloadSpecs = new Map();
let downloadQueueMode = false;
const downloadJobController = core.createDownloadJobController({
  jobs,
  downloadSpecs,
  createJob,
  spawnJobProcess,
  buildDownloadSpecFromJob,
  appendLog,
  failJob,
  scheduleSave: scheduleJobsSave,
  stopProgressTracker,
  getQueueMode: () => downloadQueueMode,
  setQueueMode: (value) => {
    downloadQueueMode = Boolean(value);
  },
  saveQueueMode: (settings) => atomicWriteJsonFile(CONFIG.downloadSettings, settings),
  resolvePartialPath: resolveModelsRootChild,
  resolveDownloadSecret: (ref) => downloadTokens.resolve(ref),
  releaseDownloadSecret: (ref) => downloadTokens.release(ref),
  // 「模型空闲时才下载」的忙碌判定：有请求在跑或排队即视为忙。
  isRuntimeBusy: async () => {
    const container = await getContainerStatus(CONFIG.containerName).catch(() => null);
    if (!container?.running) return false;
    const summary = await collectVllmMetricsSummary(container, null).catch(() => null);
    return (summary?.models || []).some((model) => Number(model?.requests?.running || 0) + Number(model?.requests?.waiting || 0) > 0);
  },
});
const {
  enqueueOrStartDownload,
  pauseDownloadJob,
  pauseDownloadJobAfterStop,
  cancelDownloadJob,
  finalizeDownloadCancel,
  resumeDownloadJob,
  drainDownloadQueue,
  healDownloadQueue,
} = downloadJobController;
const downloadRequests = createDownloadRequestHandlers({
  modelsRoot: CONFIG.modelsRoot,
  hfCache: CONFIG.hfCache,
  modelStorage,
  remoteModelService,
  hfAuthService,
  downloadTokens,
  getJobs: () => jobs.values(),
  getDownloadSettings: () => downloadJobController.getDownloadSettings(),
  enqueueOrStartDownload,
  buildDownloadCommand,
  getDiskFreeBytes: getModelsDiskFreeBytes,
  cleanupIncompleteFiles: (target) => modelFilesystemStore.cleanupIncompleteFiles(target),
  invalidateDiskUsage: () => runtimeSnapshotCache.invalidate("disk-usage"),
  appendLog,
  redact: (text) => runtimeSecretRedactor.redact(text),
});
// 下载完成后的显存粗评：权重体积 vs 本机显存，给「能不能直接加载」一个直观结论。
async function appendDownloadFitSummary(job) {
  try {
    const bytes = Number(job.progress?.downloadedBytes || job.meta?.expectedBytes || 0);
    if (!(bytes > 0)) return;
    const gpu = await getGpuStatus().catch(() => null);
    const totalMb = Number(gpu?.gpus?.[0]?.totalMb || gpu?.totalMb || 0);
    const fit = core.fitFor(bytes, { gpuTotalMb: totalMb });
    if (fit.status === "unknown") return;
    appendLog(job, `显存粗评：权重约 ${formatBytes(bytes)}，GPU 显存 ${formatBytes(totalMb * 1024 * 1024)}；${fit.note}`);
    job.meta = { ...(job.meta || {}), vramFit: { status: fit.status, ratio: fit.ratio, gpuTotalMb: totalMb, bytes } };
  } catch {
    // 粗评只是提示，失败不影响下载结果。
  }
}

const runDownloadChecksumVerification = core.createDownloadChecksumRunner({
  appendLog,
  getSettings: () => downloadJobController.getDownloadSettings(),
  formatBytes,
});

// 下载成功后的显存粗评：权重体积 + 15% 运行余量对比当前全部 GPU 合计空闲，
// 给「能不能直接启动」一个第一判断；精确估算仍在启动页。
async function assessDownloadedModelFit(job) {
  const localDir = job.meta?.localDir;
  if (!localDir) return;
  const [gpu, sizeBytes] = await Promise.all([
    getGpuStatus().catch(() => null),
    dirSize(localDir).catch(() => 0),
  ]);
  if (!gpu?.ok || !sizeBytes) return;
  const freeGb = Math.max(0, Number(gpu.totalMb || 0) - Number(gpu.usedMb || 0)) / 1024;
  const neededGb = (sizeBytes / 1024 ** 3) * 1.15 + 2;
  appendLog(job, neededGb <= freeGb
    ? `显存粗评：权重约 ${formatBytes(sizeBytes)}，全部 GPU 合计空闲 ${freeGb.toFixed(1)} GB，可直接尝试启动（估算含 15% 运行余量，不含长上下文 KV；GGUF 还可用 GPU layers 部分放显存）。`
    : `显存粗评：权重约 ${formatBytes(sizeBytes)}，全部 GPU 合计空闲 ${freeGb.toFixed(1)} GB，全量进显存可能不够；GGUF 可降低 GPU layers 让部分层落内存，或换更小量化。`);
  scheduleJobsSave();
}

// Xet 高性能下载把分块先写进 HF_HOME/xet 缓存、结束时才物化到 local-dir。
// 只量这个子目录（体量有界），别去扫整个 hub 缓存。
async function downloadAuxCacheBytes() {
  try {
    return await dirSize(path.join(CONFIG.hfCache, "xet"));
  } catch {
    return null;
  }
}

function startProgressTracker(job, targetDir, expectedBytes, options = {}) {
  const totalBytes = Number(expectedBytes || 0) || null;
  const stallTimeoutMs = Math.max(0, Number(process.env.MODEL_DOWNLOAD_STALL_TIMEOUT_MS ?? 5 * 60 * 1000));
  // 持续低速时提示换源（hf-mirror / ModelScope 同源仓），只提示一次，不动进程。
  const throughputAdvisor = core.createThroughputAdvisor({
    minSampleMs: Number(process.env.MODEL_DOWNLOAD_SLOW_SAMPLE_MS || 180_000),
    slowBytesPerSec: Number(process.env.MODEL_DOWNLOAD_SLOW_BYTES_PER_SEC || 1_000_000),
  });
  const tracker = {
    baseBytes: null,
    lastBytes: 0,
    lastRawBytes: 0,
    lastAuxBytes: null,
    lastGrowthAt: Date.now(),
    lastAt: Date.now(),
    scanning: false,
  };

  job.progress = {
    kind: "download",
    downloadedBytes: 0,
    totalBytes,
    percent: null,
    speedBytesPerSec: 0,
    etaSeconds: null,
    updatedAt: new Date().toISOString(),
  };

  const tick = async () => {
    if (tracker.scanning || job.status !== "running") return;
    tracker.scanning = true;
    try {
      const now = Date.now();
      const snapshot = await scanDownloadProgress(targetDir);
      const currentBytes = snapshot.downloadedBytes;
      if (tracker.baseBytes === null) tracker.baseBytes = options.countExistingProgress ? 0 : currentBytes;
      const rawDownloadedBytes = Math.max(0, currentBytes - tracker.baseBytes);
      const downloadedBytes = totalBytes ? Math.min(totalBytes, rawDownloadedBytes) : rawDownloadedBytes;
      const elapsed = Math.max(0.001, (now - tracker.lastAt) / 1000);
      const delta = Math.max(0, downloadedBytes - tracker.lastBytes);
      const speedBytesPerSec = delta / elapsed;
      const percent = totalBytes ? Math.min(99, (downloadedBytes / totalBytes) * 100) : null;
      const remainingBytes = totalBytes ? Math.max(0, totalBytes - downloadedBytes) : null;
      const etaSeconds = remainingBytes && speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : null;
      // 停滞判定用未封顶的目录字节；目录不动时再看 Xet 分块缓存是否在增长，
      // 避免 Xet 先写缓存后物化、以及续传校验阶段的误杀。
      if (rawDownloadedBytes > tracker.lastRawBytes) {
        tracker.lastGrowthAt = now;
      } else if (job.pid) {
        const auxBytes = await downloadAuxCacheBytes();
        if (auxBytes !== null && (tracker.lastAuxBytes === null || auxBytes > tracker.lastAuxBytes)) tracker.lastGrowthAt = now;
        if (auxBytes !== null) tracker.lastAuxBytes = auxBytes;
      }
      tracker.lastRawBytes = rawDownloadedBytes;
      const slowAdvice = job.pid ? throughputAdvisor.observe(rawDownloadedBytes, now) : null;
      if (slowAdvice) {
        appendLog(job, core.formatSlowDownloadHint(slowAdvice, {
          source: job.meta?.source,
          hfMirror: downloadJobController.getDownloadSettings().hfMirror,
          modelScopeRepo: job.meta?.source === "huggingface" ? (core.suggestModelScopeRepo(job.meta?.model).candidates[0] || "") : "",
          formatBytes,
        }));
      }
      if (stallTimeoutMs > 0 && job.pid && now - tracker.lastGrowthAt >= stallTimeoutMs) {
        appendLog(job, `下载进度已约 ${Math.max(1, Math.round((now - tracker.lastGrowthAt) / 60000))} 分钟无增长，终止下载进程；已下载文件保留，将按自动重试策略续传。`);
        job.cancel?.("stall");
        return;
      }
      const prevPct = Number(job.progress?.percent || 0);
      job.progress = {
        kind: "download",
        downloadedBytes,
        totalBytes,
        percent,
        speedBytesPerSec,
        etaSeconds,
        finalizedBytes: snapshot.finalizedBytes,
        partialBytes: snapshot.partialBytes,
        incompleteFiles: snapshot.incompleteFiles,
        updatedAt: new Date(now).toISOString(),
      };
      job.updatedAt = job.progress.updatedAt;
      tracker.lastBytes = downloadedBytes;
      tracker.lastAt = now;
      if (percent == null || Math.abs(percent - prevPct) >= 1) scheduleJobsSave();
      else broadcastJobsSnapshot();
    } catch (error) {
      job.progress = {
        ...job.progress,
        error: error.message,
        updatedAt: new Date().toISOString(),
      };
      job.updatedAt = job.progress.updatedAt;
      scheduleJobsSave();
    } finally {
      tracker.scanning = false;
    }
  };

  tick();
  const timer = setInterval(tick, Math.max(2500, Number(process.env.MODEL_DOWNLOAD_PROGRESS_INTERVAL_MS || 10000)));
  timer.unref?.();
  progressTimers.set(job.id, timer);
}

function stopProgressTracker(job) {
  const timer = progressTimers.get(job.id);
  if (!timer) return;
  clearInterval(timer);
  progressTimers.delete(job.id);
}

// runtime-supervisor (01 §14): the start pipeline (preflight, image, checkpoint,
// create, wait, probe, commit) with lifecycle phases, the job error object and
// jobs/instances events on this manager's hub. llama.cpp had no runtime gate,
// so it runs in warn mode: findings are logged and never fail a start.
const runtimeSupervisor = core.engines.createRuntimeSupervisor({
  managerId: CONFIG.managerId,
  ownerLabelValue: CONFIG.managerId,
  containerBaseName: CONFIG.containerName,
  host: dockerHost,
  launchStore,
  registry: engineRegistry,
  events: sseHub,
  secrets: runtimeApiKeyStore,
  redactor: runtimeSecretRedactor,
  runtimeGatePolicy: "warn",
  jobs: { createJob, appendLog, setJobProgress, scheduleJobsSave, finishJob, failJob, assertActive: assertStartJobActive },
  probes: {
    nvidiaCompatibility: () => core.engines.runtimeSupervisor.probeNvidiaCompatibility(execFileAsync),
    gpuStatus: getGpuStatusFresh,
    portStatus: checkPortAvailability,
  },
  // Fresh getters during a start (the vLLM fix, now for llama too): the
  // snapshot-cached getContainerStatus/getServedModels could report a
  // container or model list up to the cache TTL old.
  getters: { containerStatus: getContainerStatusFresh, servedModels: getServedModelsFresh },
  publishedPort: (ports) => parseDockerPortPublish(ports)?.port ?? null,
  resolveRuntime: (runtimeId) => core.engines.findHostedRuntime(engineRegistry, "llama", runtimeId),
  hooks: {
    beforeStart: () => snapshotCurrentStats("before-start"),
    afterChange: () => clearRuntimeInstancesCache(),
  },
  timeouts: {
    startMs: CONFIG.startupTimeoutMs,
    stallMs: () => Math.max(60000, Number(process.env.LLAMA_START_STALL_TIMEOUT_MS || 10 * 60 * 1000)),
    readyProbeMs: Math.max(60000, Number(process.env.LLAMA_READY_PROBE_TIMEOUT_MS || 5 * 60 * 1000)),
    probeRequestMs: Math.max(30000, Number(process.env.LLAMA_READY_PROBE_REQUEST_TIMEOUT_MS || 180000)),
  },
  fetchImpl: fetch,
  delay,
});

// The /api/instances id of a container: "primary" for the replace slot, else
// its instance label or name. jobs/instances events name instances by it.
function llamaInstanceId(containerName, labels = {}) {
  if (containerName === CONFIG.containerName) return "primary";
  return labels?.["ai.manager.instance"] || containerName;
}

async function runStartJob(job, opts) {
  return runtimeSupervisor.start({ job, run: llamaRunContext(opts), source: job.meta?.launchSource || opts.launchSource || "api" });
}

// The run context the supervisor needs: the legacy run options, the llama
// builder, and the llama-specific image refusal and wait details. The lease
// and the new API-key ref stay with launch-request.js (cleanup "caller").
function llamaRunContext(opts) {
  return {
    options: opts,
    engineId: "llamacpp",
    engineName: "llama.cpp",
    apiLabel: "llama.cpp API",
    // mode add / onConflict: the supervisor re-checks the slot at its preflight (01 §11, 00 §9.3).
    ...(opts.launchMode === "add" ? { mode: "add", onConflict: opts.onConflict === "skip" ? "skip" : "fail" } : {}),
    containerName: opts.containerName || CONFIG.containerName,
    instanceId: llamaInstanceId(opts.containerName || CONFIG.containerName, { "ai.manager.instance": opts.instanceId }),
    port: opts.port,
    gpuIds: opts.gpuDeviceIds,
    warnings: opts.gpuWarnings || [],
    apiKeyRef: opts.runtimeApiKeyRef,
    cleanup: "caller",
    admissionRequest: opts.gpuAdmissionRequest,
    prepareAdmission: typeof opts.prepareGpuAdmission === "function" ? opts.prepareGpuAdmission : undefined,
    lanFallback: opts.networkAccess === "lan",
    bindRetryPublish: () => dockerPublishArgs(opts.port, "lan", "0.0.0.0"),
    formatPublish: formatDockerPublishArgs,
    redactArgs: (argv) => redactDockerArgs(argv, opts),
    buildCommand: (job) => {
      const built = buildLlamaRuntimeCommand(job, opts);
      return { runArgs: built.runArgs, publish: built.activePublishArgs, image: built.runtimeImage, secretEnv: built.secretEnv };
    },
    imagePolicy: "auto",
    onMissingImage: ({ image }) => {
      const imageName = String(image || "");
      if (imageName.startsWith("local/") || imageName === CONFIG.museImage) {
        throw new Error(`本地运行时镜像不存在：${imageName}。请先运行 scripts/build-muse-runtime.ps1 构建镜像，不要对 local/ 前缀执行 docker pull。`);
      }
    },
    wait: {
      apiKey: opts.llamaApiKey,
      serviceUrl: opts.serviceUrl,
      loadingDetail: "容器已创建，正在等待 llama.cpp server 返回 /v1/models。",
      noLogIssue: "llama.cpp 启动日志长时间无变化。",
      extractLogIssues,
    },
  };
}

function assertStartJobActive(job) {
  if (job?.status === "running" && !job?.meta?.cancelRequested) return;
  const error = new Error("启动任务已被取消，停止后续容器操作。");
  error.code = "START_CANCELLED";
  throw error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  app,
  CONFIG,
  engineRegistry,
  instanceMetricsSampler,
  startManager,
  shutdownManager,
  firstExisting,
  parsePrometheusMetrics,
  parsePrometheusLabels,
  anthropicMessagesToOpenAi: core.anthropicMessagesToOpenAi,
  anthropicToolsToOpenAi: core.anthropicToolsToOpenAi,
  anthropicToolChoiceToOpenAi: core.anthropicToolChoiceToOpenAi,
  openAiResponseToClaude: core.openAiResponseToClaude,
  openAiMessageToClaudeContent: core.openAiMessageToClaudeContent,
  buildClaudeCompressionSummary: (messages, options = {}) => core.buildClaudeCompressionSummary(messages, { ...options, language: "en-US" }),
  buildClaudeCompressionSummaryText: (messages, options = {}) => core.buildClaudeCompressionSummaryText(messages, { ...options, language: "en-US" }),
  parseToolArguments: core.parseToolArguments,
  writeJsonFile,
  readJsonFile,
  normalizePersistedJob,
  saveJobsLedgerNow,
  portPublishArg,
  dockerPublishArgs,
  parseDockerPortPublish,
  normalizeServiceExposureSettings,
  redactServiceExposureSettings,
  buildServiceExposureChecks,
  isServiceApiKeyAccepted: core.isServiceApiKeyAccepted,
  enterServiceRateLimit: core.enterServiceRateLimit,
  enterServiceConcurrency: core.enterServiceConcurrency,
  resolveOpenAiGatewayModel: openAiGatewayHandlers.resolveModel,
  normalizeServiceClient: core.normalizeServiceClient,
  hashServiceApiKey: core.hashServiceApiKey,
  serviceClientAllowsModel: core.serviceClientAllowsModel,
  buildEffectiveServiceSettings: core.buildEffectiveServiceSettings,
  extractHostname,
  runtimeMatchesServiceGatewayInstance,
  buildLlamaMemoryEstimate,
  buildModelStats,
  withSpeedWindowSeconds,
  statsSampler,
  createDownloadRequestHandlers,
  createDownloadTokenStore,
  listModelStorageRoots,
  resolveLaunchModel,
  getLlamaArchitectureRuntimeCompatibility,
  evaluateLlamaArchitectureRuntimeCompatibility,
  resolveConfiguredLlamaImageBuildInfo,
  listModelCollectionsWithRuntimeCompatibility,
  normalizeLaunchConfig,
  checkModelCompatibility,
  applySafeGgufRuntimeRecommendations,
  runtimeFactsFromContainerLabels,
  runtimeSupervisor,
  llamaRunContext,
  getContainerStatusFresh,
  getServedModelsFresh,
};
