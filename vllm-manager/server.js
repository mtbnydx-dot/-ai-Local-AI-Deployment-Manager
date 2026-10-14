const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const core = require("../manager-core");
const { describeDownloadError } = require("../manager-core/model-hub/errors");
const { createCcSwitchProviderTools } = require("./lib/ccswitch-provider");
const { createVllmStartRuntimeRequest } = require("./lib/launch-request");
const { createVllmDefaultLaunchProfiles } = require("./lib/default-profiles");
const { PENNYROYAL_DEFAULTS, PENNYROYAL_TOKENIZER_SHA256, isPennyroyalImage,
  pennyroyalOptionErrors, createPennyroyalPreset } = require("./lib/pennyroyal");
const { buildVllmMemoryEstimate } = require("./lib/memory-estimate");
const { createVllmRuntimeCommandBuilder, normalizeRuntimeEngine } = require("./lib/runtime-command");
const { normalizeSpeculativeMode, resolveVllmModelCapabilities } = require("./lib/model-capabilities");
const { createVllmRemoteModelService } = require("./lib/remote-models");
const { createHfAuthService } = require("./lib/hf-auth");
const {
  DEFAULT_SGLANG_RELEASE,
  DEFAULT_VLLM_RELEASE,
  assessVllmRuntimeCompatibility,
  defaultVllmImageReference,
  probeNvidiaRuntimeCompatibility,
} = require("./lib/runtime-compatibility");
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
  clientSessionsToSummary,
  parseJsonSafe,
  cleanRequired,
  cleanOptionalLaunchArg,
  openAiGatewayError,
  claudeError,
  upstreamErrorMessage,
  sendClaudeUpstreamError,
  isExpectedStreamDisconnect,
  uniqueModelsById,
  estimateTokenCount,
  normalizeGpuIds,
  positiveInt,
  clampNumber,
  nonNegativeNumber,
  optionalNonNegativeNumber,
  lastIntegerMatch,
  lastFloatMatch,
  normalizeNetworkAccess,
  normalizeKvCacheDtype,
  normalizeClientPreset,
  formatBytes,
  markJobCancelRequested,
  createProcessJobRunner,
  extractLogIssues,
  safeOutputName,
  isPinnedImageReference,
  isLocalRequest,
  extractHostname,
  cleanDownloadSource,
  normalizeDownloadModelReference,
  encodeRepoId,
  deriveName,
  createDockerRuntime,
  isContainerNameConflictError,
} = core;
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {}

const app = express();
const PORT = Number(process.env.VLLM_MANAGER_PORT || 5177);
const HOST = process.env.VLLM_MANAGER_HOST || "127.0.0.1";
const SHARED_PUBLIC_JS_DIR = path.join(__dirname, "..", "shared-public", "js");
const ALLOW_REMOTE_MANAGEMENT = process.env.VLLM_MANAGER_ALLOW_REMOTE === "1";
const DEFAULT_VLLM_IMAGE = process.env.VLLM_IMAGE_VERSION
  ? `vllm/vllm-openai:${process.env.VLLM_IMAGE_VERSION}`
  : defaultVllmImageReference();
const DEFAULT_GEMMA_VLLM_IMAGE = "vllm/vllm-openai@sha256:9c719fc0c869092c7d0533f8357d6985a38d5ff03b20ffb6a4620c2b4806dd4b";
const DEFAULT_QWEN_MOE_VLLM_IMAGE = "vllm/vllm-openai@sha256:754a391fb40c6106327042b97f4d3e32ec00376f3f3542bbc9fa9f4f06a95fbb";
const DEFAULT_SGLANG_IMAGE = `${DEFAULT_SGLANG_RELEASE.repository}@${DEFAULT_SGLANG_RELEASE.platformDigest}`;
const DEFAULT_SGLANG_FLASH_NEXT_IMAGE = core.runtimeImageReference("sglangFlashNext");
const DEFAULT_AI_ROOT = process.env.AI_ROOT || path.resolve(__dirname, "..");
const DEFAULT_DEVTOOLS_ROOT = process.env.DEVTOOLS_ROOT || "";
const MANAGER_LABEL_KEY = "ai.manager";
const MANAGER_ENGINE_LABEL_KEY = "ai.manager.engine";
const MANAGER_APIKEY_LABEL_KEY = "ai.manager.api-key";
const MANAGER_APIKEY_REF_LABEL_KEY = "ai.manager.api-key-ref";
const DOCKER_WSL_DISTRO = String(process.env.DOCKER_WSL_DISTRO || "").trim();
if (DOCKER_WSL_DISTRO && !/^[A-Za-z0-9._-]+$/.test(DOCKER_WSL_DISTRO)) {
  throw new Error("DOCKER_WSL_DISTRO contains unsupported characters.");
}

const CONFIG = {
  dockerWslDistro: DOCKER_WSL_DISTRO,
  dockerExe: DOCKER_WSL_DISTRO ? (process.env.WSL_EXE || "wsl.exe") : firstExisting([
    process.env.DOCKER_EXE,
    defaultDevToolsPath("Docker", "resources", "bin", "docker.exe"),
    "docker",
  ]),
  dockerArgsPrefix: DOCKER_WSL_DISTRO ? ["-d", DOCKER_WSL_DISTRO, "--exec", "docker"] : [],
  dockerRuntimeName: DOCKER_WSL_DISTRO ? `WSL ${DOCKER_WSL_DISTRO}` : "Docker Desktop",
  dockerDaemonStartFile: DOCKER_WSL_DISTRO ? (process.env.WSL_EXE || "wsl.exe") : "",
  dockerDaemonStartArgs: DOCKER_WSL_DISTRO ? ["-d", DOCKER_WSL_DISTRO, "--exec", "sleep", "infinity"] : [],
  dockerDesktopExe: firstExisting([
    process.env.DOCKER_DESKTOP_EXE,
    defaultDevToolsPath("Docker", "Docker Desktop.exe"),
    defaultDevToolsPath("Docker", "frontend", "Docker Desktop.exe"),
    // Docker's CLI is normally <install>/resources/bin/docker.exe. Discover
    // relocated Desktop installations from PATH without a machine-specific root.
    ...(process.platform === "win32" ? String(process.env.PATH || "").split(path.delimiter)
      .filter(directory => directory && fs.existsSync(path.join(directory, "docker.exe")))
      .map(directory => path.resolve(directory, "..", "..", "Docker Desktop.exe")) : []),
    "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
  ]),
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
  pythonExe: firstExisting([
    process.env.PYTHON_EXE,
    defaultAiPath("venvs", "ai312", "Scripts", "python.exe"),
    defaultAiPath("venvs", "ai311", "Scripts", "python.exe"),
    "python",
  ]),
  ccSwitchDir: process.env.AI_CCSWITCH_DIR || path.join(os.homedir(), ".cc-switch"),
  claude3pConfigDir: process.env.AI_CLAUDE_3P_CONFIG_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Claude-3p", "configLibrary"),
  modelsRoot: process.env.VLLM_MODELS_ROOT || defaultAiPath("models"),
  hfCache: process.env.HF_HOME || defaultAiPath("cache", "huggingface"),
  vllmCache: process.env.VLLM_CACHE_ROOT || defaultAiPath("cache", "vllm-qwen38"),
  sglangCache: process.env.SGLANG_CACHE_ROOT || defaultAiPath("cache", "sglang-qwen38"),
  image: process.env.VLLM_IMAGE || DEFAULT_VLLM_IMAGE,
  imagePlatform: process.env.VLLM_IMAGE_PLATFORM || DEFAULT_VLLM_RELEASE.platform,
  gemmaImage: process.env.VLLM_GEMMA_IMAGE || DEFAULT_GEMMA_VLLM_IMAGE,
  qwenMoeImage: process.env.VLLM_QWEN_MOE_IMAGE || DEFAULT_QWEN_MOE_VLLM_IMAGE,
  sglangImage: process.env.SGLANG_IMAGE || DEFAULT_SGLANG_IMAGE,
  sglangFlashNextImage: process.env.SGLANG_FLASH_NEXT_IMAGE || DEFAULT_SGLANG_FLASH_NEXT_IMAGE,
  containerName: process.env.VLLM_CONTAINER_NAME || "vllm-local",
  managerId: process.env.VLLM_MANAGER_ID || "vllm-manager",
  defaultPort: Number(process.env.VLLM_PORT || 8000),
  pidFile: process.env.VLLM_MANAGER_PID_FILE || path.join(__dirname, ".manager.pid"),
  statsLedger: path.join(__dirname, "logs", "stats-ledger.json"),
  metricsHistory: path.join(__dirname, "logs", "metrics-history.json"),
  benchmarkHistory: path.join(__dirname, "logs", "benchmark-history.json"),
  idleUnloadSettings: path.join(__dirname, "logs", "idle-unload-settings.json"),
  idleUnloadSleeping: path.join(__dirname, "logs", "idle-unload-sleeping.json"),
  managerBackups: path.join(__dirname, "logs", "backups"),
  jobsLedger: path.join(__dirname, "logs", "jobs-ledger.json"),
  claudeCompressionSettings: path.join(__dirname, "logs", "claude-context-compression.json"),
  launchProfiles: path.join(__dirname, "logs", "launch-profiles.json"),
  recentLaunches: path.join(__dirname, "logs", "recent-launches.json"),
  downloadSettings: path.join(__dirname, "logs", "download-settings.json"),
  modelNotes: path.join(__dirname, "logs", "model-notes.json"),
  automationSettings: path.join(__dirname, "logs", "automation-settings.json"),
  serviceExposureSettings: path.join(__dirname, "logs", "service-exposure-settings.json"),
  serviceClients: path.join(__dirname, "logs", "service-clients.json"),
  serviceUsageDb: path.join(__dirname, "logs", "service-usage.sqlite"),
  serviceGatewayAccessLog: path.join(__dirname, "logs", "service-gateway-access.log"),
  runtimeApiKeys: path.join(__dirname, "logs", "runtime-api-keys.json"),
  auditRoot: process.env.AI_AUDIT_ROOT || defaultAiPath("audit-logs"),
  openWebuiContainer: process.env.OPEN_WEBUI_CONTAINER || "open-webui",
  claudeDefaultMaxTokens: Math.min(65536, Math.max(1024, positiveInt(process.env.VLLM_CLAUDE_DEFAULT_MAX_TOKENS || 8192, 8192))),
};

// Job logs, the ledger, /api/logs and API responses redact the exact runtime
// keys, the HF tokens of running downloads and the secret patterns (08 P0-5).
// The list is cached; set/remove through runtimeApiKeyStore and every change
// of the download-token map invalidate it.
const downloadTokens = createDownloadTokenStore({ onChange: () => runtimeSecretList.invalidate() });
const runtimeSecretList = core.createCachedSecretList({
  // DPAPI secret store (06 OPS-3b); the old plaintext file is migrated once.
  store: core.createRuntimeSecretStore({ file: CONFIG.runtimeApiKeys, namespace: "runtime.vllm", aiRoot: DEFAULT_AI_ROOT }),
  sources: [() => process.env.HF_TOKEN, () => process.env.AI_CLAUDE_GATEWAY_API_KEY, () => downloadTokens.values()],
});
const runtimeApiKeyStore = runtimeSecretList.store;
const runtimeSecretRedactor = core.createSecretRedactor({ getSecrets: runtimeSecretList.getSecrets });
const billingClient = core.createBillingClient({
  managerId: CONFIG.managerId,
  root: DEFAULT_AI_ROOT,
});
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

const dockerRuntime = createDockerRuntime({
  dockerExe: CONFIG.dockerExe,
  dockerArgsPrefix: CONFIG.dockerArgsPrefix,
  dockerDesktopExe: CONFIG.dockerDesktopExe,
  daemonStartFile: CONFIG.dockerDaemonStartFile,
  daemonStartArgs: CONFIG.dockerDaemonStartArgs,
  runtimeName: CONFIG.dockerRuntimeName,
  formatBytes,
  parseJsonSafe,
  delay,
});
const {
  execFileAsync,
  docker,
  getDockerVersion: getDockerVersionFresh,
  ensureDockerDaemonRunning,
  checkDockerDaemon,
  getImageStatus: getImageStatusFresh,
  pullImageWithRetry,
  normalizeDockerContainerName,
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

// /api/memory-estimate previews SGLang admission with the live admission
// policy. A body-supplied admissionPolicy is always replaced.
async function buildServerMemoryEstimate(body = {}) {
  const policy = await gpuAdmissionController.getPolicy().catch(() => ({
    reserveMb: gpuAdmissionController.reserveMb,
    maxUtilizationPct: gpuAdmissionController.maxUtilizationPct,
  }));
  return buildVllmMemoryEstimate({
    ...body,
    admissionPolicy: {
      reserveMb: policy.reserveMb,
      maxUtilizationPct: policy.maxUtilizationPct,
      startupMarginMb: gpuAdmissionController.startupMarginMb,
    },
  });
}

const remoteModelService = createVllmRemoteModelService();
const hfAuthService = createHfAuthService({
  hfCli: CONFIG.hfCli,
  hfHome: CONFIG.hfCache,
});
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
  resolveModelsRootChild,
  scanDownloadProgress,
} = modelFilesystemStore;

const ccSwitchTools = createCcSwitchProviderTools({
  ccSwitchDir: CONFIG.ccSwitchDir,
  pythonExe: CONFIG.pythonExe,
  execFileAsync,
  parseJsonSafe,
});

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
  createServiceClient,
  updateServiceClient,
  rotateServiceClientKey,
  deleteServiceClient,
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
  replaceDockerPublishArgs,
  isDockerPublishBindError,
  stripHostBrackets,
  isLoopbackHost,
  isWildcardHost,
  parseDockerPortPublish,
} = core.createDockerPublishHelpers({ containerPort: 8000, getLanAddress });

const {
  buildVllmRuntimeCommand,
  formatDockerPublishArgs,
  redactDockerArgs,
} = createVllmRuntimeCommandBuilder({
  getModelMountArgs: () => modelStorage.dockerMountArgs(),
  CONFIG,
  MANAGER_LABEL_KEY,
  MANAGER_ENGINE_LABEL_KEY,
  MANAGER_APIKEY_REF_LABEL_KEY,
  appendLog,
  scheduleJobsSave,
  dockerGpuArg,
  dockerPublishArgs,
  publishArgsToDockerRunArgs,
  windowsPathToContainerPath,
  normalizeGpuIds,
  getLanAddress,
  resolveLaunchModel,
  effectiveLaunchQuantization,
  resolveVllmRuntimePreset,
});

const jobs = new Map();
const progressTimers = new Map();
const statsSamples = new Map();
const serviceRateBuckets = new Map();
const serviceConcurrencyBuckets = new Map();
const GATEWAY_RUNTIME_CACHE_MS = Math.max(0, Number(process.env.VLLM_GATEWAY_RUNTIME_CACHE_MS || 5000));
let gatewayRuntimeCache = {
  value: null,
  expiresAt: 0,
  promise: null,
};
let runtimeInstancesCache = { value: null, expiresAt: 0, promise: null };
let automationMonitorTimer = null;
let recentLaunches = [];
const MAX_RECENT_LAUNCHES = 8;
// 启动任务串行化：同一管理器内同一时刻只允许一个 serve 启动流程在跑，
// 避免并发 docker run 竞争同一个容器名（vllm-local）造成 "container name already in use"。
// 第二个启动请求会排队等待前一个完成（成功或失败）后再执行，保留"启动即替换"语义。
const serveQueues = new Map();
function serializeServeJob(work, queueKey = "replace") {
  const key = String(queueKey || "replace");
  const state = serveQueues.get(key) || { chain: Promise.resolve(), busy: false };
  const queued = state.busy;
  state.busy = true;
  const result = state.chain.then(() => work());
  state.chain = result.then(() => { state.busy = false; }, () => { state.busy = false; });
  serveQueues.set(key, state);
  return { result, queued };
}
let runtimeActivity = {
  initialized: false,
  lastActivityAt: null,
  lastSeenAt: null,
  lastRequestCount: null,
  lastTokenCount: null,
  lastWarnAt: null,
  unloading: false,
};
const MAX_LOG_LINES = 1000;
const MAX_PERSISTED_JOBS = 60;
const jobsLedgerStore = core.createJobsLedgerStore({
  jobs,
  file: CONFIG.jobsLedger,
  readJsonFile,
  writeJsonFile,
  maxLogLines: MAX_LOG_LINES,
  maxPersistedJobs: MAX_PERSISTED_JOBS,
  redact: runtimeSecretRedactor,
  serveDetail: "运行时 API 与最小生成自检均已通过。",
  stopProgressTracker,
  onJobSuccess: (job) => {
    if (job.type === "serve") recordRecentLaunch(job.meta);
    if (job.type === "download") assessDownloadedModelFit(job).catch(() => {});
  },
  onJobsChanged: () => broadcastJobsSnapshot(),
  onError: (message) => console.warn(message),
});
const statsLedgerStore = core.createStatsLedgerStore({
  file: CONFIG.statsLedger,
  readJsonFile,
  writeJsonFile,
  normalizeClients: core.normalizeStatsClientLedger,
  persistRuntimeFacts: true,
  claudeUsageOptions: {
    id: "claude",
    label: "Claude 兼容桥",
    defaultOk: false,
    modelFallback: "unknown",
    trackSessions: true,
    compressionLast: "applied",
  },
});
const {
  loadStatsLedger,
  updateStatsLedger,
  recordClaudeBridgeUsage,
  flushClaudeUsageWrites,
  getPersistedRuntimeFacts,
  waitForStatsLedgerWrites,
} = statsLedgerStore;
const launchProfilesStore = core.createLaunchProfilesStore({
  file: CONFIG.launchProfiles,
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
  cache: true,
  normalizeOptions: {
    useEnv: true,
    minMessagesMin: 8,
  },
});
const {
  getClaudeCompressionSettings,
  saveClaudeCompressionSettings,
  normalizeClaudeCompressionSettings,
} = claudeCompressionSettingsStore;
const AUDIT_PASSWORD_FILE = process.env.AI_AUDIT_PASSWORD_FILE || path.join(CONFIG.auditRoot, "audit-admin-password.txt");
const AUDIT_LEGACY_PASSWORD_FILES = [
  path.join(__dirname, "logs", "audit-admin-password.txt"),
];
const auditStore = core.createAuditStore({
  auditRoot: CONFIG.auditRoot,
  auditPasswordFile: AUDIT_PASSWORD_FILE,
  legacyPasswordFiles: AUDIT_LEGACY_PASSWORD_FILES,
  openWebuiContainer: CONFIG.openWebuiContainer,
  serviceContainer: CONFIG.containerName,
  managerName: "vllm-manager",
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
const CLAUDE_LOCAL_MODEL_ALIASES = (process.env.AI_CLAUDE_LOCAL_MODEL_ALIASES || "local,local-current,current,auto,default")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const OPENCODE_MODEL_ALIASES = (process.env.AI_OPENCODE_MODEL_ALIASES || "local-current,current,auto,default")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const OPENAI_GATEWAY_MODEL_ALIASES = (process.env.AI_OPENAI_GATEWAY_MODEL_ALIASES || "local-current,current,auto,default")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const CLAUDE_PROFILE_ID = process.env.AI_CLAUDE_PROFILE_ID || "00000000-0000-4000-8000-000000157210";
const CLAUDE_SETUP_ALIASES = [
  { name: "claude-opus-4-7", labelOverride: "opus" },
  { name: "claude-sonnet-4-6", labelOverride: "sonnet" },
  { name: "claude-haiku-4-5", labelOverride: "haiku" },
];
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
  engine: "vllm",
  readJsonFile,
  writeJsonFile,
});

// Benchmark results outlive the job ledger here so that a configuration change
// can be compared against the run that preceded it.
const benchmarkHistoryStore = core.createBenchmarkHistoryStore({
  file: CONFIG.benchmarkHistory,
  engine: "vllm",
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
    recentLaunches: CONFIG.recentLaunches,
    downloadSettings: CONFIG.downloadSettings,
    modelNotes: CONFIG.modelNotes,
    automationSettings: CONFIG.automationSettings,
    serviceExposureSettings: CONFIG.serviceExposureSettings,
    serviceClients: CONFIG.serviceClients,
    claudeCompressionSettings: CONFIG.claudeCompressionSettings,
  },
});

const serviceGatewayMiddleware = core.createServiceGatewayMiddleware({
  gatewayName: "vllm-manager",
  supportedKinds: ["openai", "claude", "opencode"],
  getServiceExposureSettings,
  getServiceClientsLedger,
  resolveServiceClientForApiKey,
  rateBuckets: serviceRateBuckets,
  concurrencyBuckets: serviceConcurrencyBuckets,
  appendAccessLog: appendServiceGatewayAccessLog,
  acceptRawAuthorization: true,
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
  host: HOST,
  port: PORT,
  label: "vLLM Manager",
  pidFile: CONFIG.pidFile,
  engine: "vllm",
  managerId: CONFIG.managerId,
  listenMessage: `vLLM Manager listening on http://${HOST}:${PORT}`,
  beforeStart: async () => {
    await ensureDirs(CONFIG.modelsRoot, CONFIG.hfCache, CONFIG.vllmCache, CONFIG.sglangCache, path.dirname(CONFIG.jobsLedger));
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
  },
  onShutdown: async () => {
    jobsLedgerStore.clearJobsSaveTimer();
    if (automationMonitorTimer) clearInterval(automationMonitorTimer);
    clearInterval(idleUnloadTimer);
    for (const timer of progressTimers.values()) clearInterval(timer);
    progressTimers.clear();
    sseHub.close();
    core.interruptRunningDownloadJobs(jobs);
    await saveJobsLedgerNow().catch((error) => console.warn(`Unable to save jobs ledger during shutdown: ${error.message}`));
    await flushClaudeUsageWrites().catch((error) => console.warn(`Unable to save Claude usage during shutdown: ${error.message}`));
    await billingPendingQueue.stop().catch(() => {});
    await Promise.allSettled([
      waitForStatsLedgerWrites(),
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
    label: "vLLM Manager",
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
  engine: "vllm",
  jobs,
  getLanAddress,
  hasHfToken: () => Boolean(process.env.HF_TOKEN || hfAuthService.hasCachedToken()),
  getConfigExtras: () => ({
    defaultVllmImage: CONFIG.image,
    defaultVllmImagePinned: isPinnedImageReference(CONFIG.image),
    defaultVllmRelease: {
      version: DEFAULT_VLLM_RELEASE.version,
      image: defaultVllmImageReference(),
      manifestDigest: DEFAULT_VLLM_RELEASE.manifestDigest,
      platformDigest: DEFAULT_VLLM_RELEASE.platformDigest,
      platform: CONFIG.imagePlatform,
      cudaVersion: DEFAULT_VLLM_RELEASE.cudaVersion,
      torchVersion: DEFAULT_VLLM_RELEASE.torchVersion,
    },
    runtimeEngines: [
      { id: "vllm", label: "vLLM Qwen3.8", image: CONFIG.image, stable: true },
      { id: "sglang", label: "SGLang / Pennyroyal / DSpark", image: CONFIG.sglangImage, stable: false },
    ],
  }),
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
  buildStatusExtras: ({ runtime }) => ({
    engine: runtime.engine,
    runtimeVersion: runtime.runtimeVersion,
  }),
  buildMemoryEstimate: buildServerMemoryEstimate,
  collectStats,
  collectExternalAccessStats,
  searchAccessLogs: searchServiceGatewayAccessLogs,
  exportAccessLogs: exportServiceGatewayAccessLogs,
  buildExternalAccessOptions: (query) => {
    const limit = Math.min(500, Math.max(20, Number(query.limit || 160)));
    const maxLines = Math.min(50000, Math.max(limit, Number(query.maxLines || 12000)));
    return { limit, maxLines };
  },
  getClaudeCompressionSettings,
  saveClaudeCompressionSettings,
  ...managerBackupStore,
});

core.registerServicePolicyRoutes(app, {
  getServiceExposureSettings,
  saveServiceExposureSettings,
  buildServiceExposurePayload,
  getServiceClientsLedger,
  redactServiceClientsLedger,
  createServiceClient,
  updateServiceClient,
  rotateServiceClientKey,
  deleteServiceClient,
});

core.registerIntegrationRoutes(app, {
  setupClaude: setupClaudeBridge,
});

const openAiGatewayHandlers = core.createOpenAiGatewayHandlers({
  aliases: OPENAI_GATEWAY_MODEL_ALIASES,
  owner: "vllm-manager",
  getRunningModelSummary: getGatewayRunningModelSummary,
  listRunningModelSummaries: getRunningModelSummaries,
  getUpstreamHeaders: (runtime, headers = {}) => vllmAuthHeaders(runtime.vllmApiKey, headers),
  prepareRequestBody: applyVllmRequestDefaults,
  serviceClientAllowsModel,
  recordUsage: recordServiceClientGatewayUsage,
  authorizeBilling: billingClient.authorize,
  settleBilling: billingClient.settle,
  enqueuePendingBilling: (event) => billingPendingQueue.enqueue(event),
  onBillingError: logBillingIntegrationIssue,
  upstreamErrorMessage,
  isExpectedStreamDisconnect,
  getRootMappings: (runtime) => getServedModelRootMappings(runtime),
  setAccessUsage: (req, usage) => {
    if (req) req.serviceGatewayAccessUsage = usage;
  },
});
// What the running container was actually launched with. Labels are the only
// source that still reflects reality after a manager restart.
function benchmarkConfigFromRuntime(runtime = {}) {
  const labels = runtime.container?.labels || {};
  const positive = (key) => {
    const value = Number(labels[key]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    engine: runtime.engine || "vllm",
    runtimeImage: runtime.container?.image || runtime.runtimeVersion || "",
    maxModelLen: positive("ai.manager.max-model-len"),
    maxNumSeqs: positive("ai.manager.max-num-seqs"),
    maxNumBatchedTokens: positive("ai.manager.max-num-batched-tokens"),
    gpuMemoryUtilization: positive("ai.manager.gpu-memory-utilization"),
    gpuIds: String(labels["ai.manager.gpu-ids"] || "") || null,
    kvCacheDtype: String(labels["ai.sglang.kv-cache-dtype"] || "") || null,
    enablePrefixCaching: labels["ai.runtime.prefix-caching"] === undefined
      ? null
      : String(labels["ai.runtime.prefix-caching"]).toLowerCase() === "true",
    speculativeMode: String(labels["ai.runtime.speculative-mode"] || "") || null,
  };
}

const benchmarkRunner = core.createBenchmarkRunner({
  defaultPort: CONFIG.defaultPort,
  defaultPrompt: "用中文简要说明本地模型是否可以稳定完成工具调用、长上下文和代码任务。",
  runtimeLabel: "vLLM",
  requestDetail: "Sending chat completion request to local vLLM.",
  getRunningModelSummary,
  getHeaders: (runtime) => vllmAuthHeaders(runtime.vllmApiKey),
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

core.registerClaudeRoutes(app, {
  models: handleClaudeModels,
  messages: handleClaudeMessages,
  countTokens: handleClaudeCountTokens,
});
app.get("/serve/v1/models", openAiGatewayHandlers.handleModels);
app.get("/serve/v1/props", openAiGatewayHandlers.handleProps);
app.post("/serve/v1/chat/completions", openAiGatewayHandlers.handleChatCompletions);
app.post("/serve/v1/completions", openAiGatewayHandlers.handleCompletions);
app.post("/serve/v1/responses", openAiGatewayHandlers.handleResponses);
app.post("/serve/v1/embeddings", openAiGatewayHandlers.handleEmbeddings);
app.post("/serve/v1/pooling", openAiGatewayHandlers.handlePooling);
app.post("/serve/v1/score", openAiGatewayHandlers.handleScore);
app.post("/serve/v1/rerank", openAiGatewayHandlers.handleRerank);
app.post("/serve/v1/classify", openAiGatewayHandlers.handleClassify);
app.get("/opencode/v1/models", handleOpenCodeModels);
app.post("/opencode/v1/chat/completions", handleOpenCodeChatCompletions);

core.registerModelStorageRoutes(app, { storage: modelStorage, migration: modelMigration, isLocalRequest, publicDir: path.join(__dirname, "..", "shared-public") });

core.registerModelRoutes(app, {
  listModels: listVllmModelCollections,
  deleteLocalModel: deleteLocalModelRequest,
  searchRemoteModels: remoteModelService.searchRemoteModelCatalog,
  startDownload: startDownloadRequest,
  estimateDownload: estimateDownloadRequest,
  getHfAuthStatus: () => hfAuthService.getStatus(),
  launchHfLogin: () => hfAuthService.launchLogin(),
  checkHfAccess: checkHfAccessRequest,
  isLocalRequest,
  getModelConfig: getModelConfigRequest,
  getModelReadme: getModelReadmeRequest,
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
  const assessment = core.assessDownloadCompatibility({
    engine: "vllm",
    model: reference.model,
    source,
    precision: reference.precision,
    config: remoteConfig?.ok ? remoteConfig.config : null,
    siblings: estimate?.siblings || [],
    bytes: estimate?.bytes || null,
    gated: Boolean(estimate?.gated),
    runtime: knownRuntimeImageMetadata(CONFIG.image) || DEFAULT_VLLM_RELEASE,
    gpu: primaryGpu ? { computeCap: primaryGpu.computeCap, totalMb: primaryGpu.totalMb } : null,
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
  return core.groupPrecisionVariants(reference.model, [{ id: reference.model }, ...candidates], { vllmRuntime: DEFAULT_VLLM_RELEASE });
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

async function listVllmModelCollections() {
  const collections = await listModelCollections();
  const local = (collections.local || []).map((model) => {
    const config = readLocalModelConfig(model.path) || {};
    const capabilities = resolveVllmModelCapabilities({
      model: model.path,
      localPath: model.path,
      config,
      speculativeMode: "off",
    });
    const blockReason = capabilities.unsupportedReason
      || (isDiffusionGemmaModel(model.path, config) ? diffusionGemmaWindowsBlockReason() : "");
    if (!blockReason) return model;
    const issue = finding("fail", "vLLM 运行时不兼容", blockReason);
    return {
      ...model,
      runnable: false,
      verificationStatus: "fail",
      verificationIssues: [...(model.verificationIssues || []), issue],
    };
  });
  return { ...collections, local };
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
      res.json({ ok: true, id: job.id, status: job.status });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
});

async function deleteLocalModelRequest(body = {}) {
  const name = cleanRequired(body.name, "name");
  const target = resolveModelsRootChild(path.isAbsolute(name) ? name : path.join(CONFIG.modelsRoot, safeOutputName(name)));
  if (target === path.resolve(CONFIG.modelsRoot)) {
    const error = new Error("无法删除模型根目录。");
    error.status = 400;
    throw error;
  }
  if (!fs.existsSync(target)) {
    const error = new Error("本地模型目录不存在，可能已被删除。");
    error.status = 404;
    throw error;
  }
  const sameDir = (value) => {
    try {
      return path.resolve(String(value || "")).toLowerCase() === target.toLowerCase();
    } catch {
      return false;
    }
  };
  const busyJob = Array.from(jobs.values()).find((job) =>
    job.type === "download"
    && ["running", "queued"].includes(job.status)
    && sameDir(job.meta?.localDir));
  if (busyJob) {
    const error = new Error("该目录正在被下载任务使用，请先暂停或取消对应下载。");
    error.status = 409;
    throw error;
  }
  modelStorage.resolvePath(target, { allowRoot: false });
  modelStorage.assertUnlocked([target]);
  const mounted = (await storageBusyPaths()).find(item => core.overlapsPath(item.path, target));
  if (mounted) throw core.storageError(`目录仍被 ${mounted.label} 使用，已阻止删除。`);
  await fsp.rm(target, { recursive: true, force: true });
  return { ok: true, name, path: target };
}

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
    if (forceOfficialHf) log(job, "Gated/authenticated Hugging Face download uses the official endpoint instead of the configured mirror.");
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
    gated: Boolean(estimate.gated),
    gateMode: estimate.gateMode || false,
    authorizationUrl: estimate.authorizationUrl || null,
    supported: true,
    diskFreeBytes,
  };
}

async function checkHfAccessRequest(query = {}) {
  const reference = normalizeDownloadModelReference(query.model, query.precision);
  if (!reference.model) {
    const error = new Error("model is required");
    error.status = 400;
    throw error;
  }
  const estimate = await remoteModelService.getHuggingFaceDownloadEstimate(reference.model, reference.precision);
  if (!estimate.gated) {
    return {
      model: reference.model,
      gated: false,
      granted: true,
      status: "public",
      authorizationUrl: estimate.authorizationUrl,
    };
  }
  const access = await hfAuthService.checkRepoAccess(reference.model, { probeFile: estimate.probeFile });
  return {
    model: reference.model,
    gated: true,
    granted: access.granted,
    status: access.status,
    username: access.username,
    authorizationUrl: estimate.authorizationUrl,
  };
}

function createHfAccessError(model, status, authorizationUrl) {
  const messages = {
    login_required: "本机尚未连接 Hugging Face 账号。请先登录，再继续这个下载。",
    invalid_token: "Hugging Face 登录凭据无效或已过期，请重新登录。",
    approval_required: "当前 Hugging Face 账号尚未获得这个 gated 模型的文件访问权。请在官方模型页确认授权后重试。",
    not_found: "Hugging Face 仓库或授权探测文件不存在。",
    check_failed: "暂时无法验证 Hugging Face 仓库访问权，请稍后重试。",
  };
  const error = new Error(messages[status] || messages.check_failed);
  error.status = status === "not_found" ? 404 : 409;
  error.code = `hf_${status || "check_failed"}`;
  error.accessStatus = status || "check_failed";
  error.authorizationUrl = authorizationUrl || `https://huggingface.co/${String(model).split("/").map(encodeURIComponent).join("/")}`;
  return error;
}

async function getModelConfigRequest(query = {}) {
  const requestedSource = String(query.source || "huggingface").trim().toLowerCase();
  const source = requestedSource === "local" ? "local" : cleanDownloadSource(requestedSource);
  const model = String(query.model || "").trim();
  if (!model) {
    const error = new Error("model is required");
    error.status = 400;
    throw error;
  }
  return getModelConfig(model, source, String(query.quantization || "").trim());
}

async function getModelReadmeRequest(query = {}) {
  const model = String(query.model || "").trim();
  if (!model || !/^[^/\s]+\/[^/\s]+$/.test(model)) {
    const error = new Error("需要 owner/model 形式的 Hugging Face 仓库 ID。");
    error.status = 400;
    throw error;
  }
  return getModelReadme(model);
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

async function saveDownloadSettingsRequest(body = {}) {
  return downloadJobController.saveDownloadSettings(body);
}

const runtimeStopHandlers = core.createRuntimeStopHandlers({
  managerName: "vllm-manager",
  containerName: CONFIG.containerName,
  getRunningModelSummary,
  stopRuntime: stopVllmContainer,
  exportAudit: exportOpenWebuiAudit,
  unloadNote: "vLLM does not hot-unload a model from the current server process; this stops only the vLLM container managed by this tool.",
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
  dockerStartTimeoutMs: 120000,
  defaultTail: 200,
  cleanRequired,
  prompt: "Reply with exactly: vLLM OK",
  getApiKey: async () => getVllmApiKey(await getContainerStatus(CONFIG.containerName)),
  authHeaders: (apiKey) => vllmAuthHeaders(apiKey),
  // GET /api/logs?instance= reads only containers this manager owns (08 P0-3).
  resolveLogContainer: core.createOwnedRuntimeContainerResolver({
    primaryContainerName: CONFIG.containerName,
    managerId: CONFIG.managerId,
    ownerLabelKey: MANAGER_LABEL_KEY,
    engines: ["vllm", "sglang"],
    getContainerStatus: (name) => getContainerStatus(name),
    listManagedContainers: () => listManagedContainers(),
  }),
});
const {
  startDockerDesktopRequest,
  readRuntimeLogsRequest,
  testRuntimeCompletionRequest,
} = runtimeRequestHandlers;

const startRuntimeRequest = createVllmStartRuntimeRequest({
  resolveRequestedModel: value => { const input = modelStorage.fromContainerPath(value); if (!path.isAbsolute(input)) return input; const resolved = modelStorage.resolvePath(input); modelStorage.assertUnlocked([resolved]); return resolved; },
  CONFIG,
  cleanRequired,
  deriveName,
  positiveInt,
  nonNegativeNumber,
  optionalNonNegativeNumber,
  normalizeDtype,
  normalizeQuantization,
  normalizeLoadFormat,
  cleanOptionalLaunchArg,
  normalizeKvCacheDtype,
  normalizeLaunchGpuSelection,
  normalizeGpuIds,
  normalizeClientPreset,
  normalizeReasoningParser,
  normalizeToolCallParser,
  inferToolCallParser,
  normalizeNetworkAccess,
  normalizeSpeculativeMode,
  normalizeRuntimeEngine,
  checkModelCompatibility,
  getLanAddress,
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
});

// Idle runtimes hold their weights and KV pool for nothing. The controller
// releases them and keeps the launch configuration so the same runtime can be
// brought back; the recent-launch record is the fallback source for a
// configuration when an instance was started before this feature existed.
const idleUnloadController = core.createIdleUnloadController({
  settingsFile: CONFIG.idleUnloadSettings,
  sleepFile: CONFIG.idleUnloadSleeping,
  engine: "vllm",
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
// uncached inspect behind the route's own 60 s cache.
const engineRegistry = core.engines.createEngineRegistry({ env: process.env });
core.engines.registerEngineRoutes(app, {
  registry: engineRegistry,
  managerId: "vllm",
  ownerLabelValue: CONFIG.managerId,
  isLocalRequest,
  getImageStatus: getImageStatusFresh,
  listManagedContainers: () => listManagedContainers(),
});

core.registerAuditRoutes(app, {
  auditRoot: CONFIG.auditRoot,
  auditPasswordFile: AUDIT_PASSWORD_FILE,
  openWebuiContainer: CONFIG.openWebuiContainer,
  managerName: "vllm-manager",
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
  benchmarkTitle: "Benchmark local model",
  verifyDownloadedModel,
  buildConnectionGuide,
  buildClaudeCompressionInsights,
  getModelNotes: modelNotesStore.getModelNotes,
  saveModelNote: modelNotesStore.saveModelNote,
  deleteModelNote: modelNotesStore.deleteModelNote,
});

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = Number(error?.status || error?.statusCode || 500);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error?.message || "Unexpected manager error.",
    code: error?.code || null,
  });
});

if (require.main === module) {
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
}

// 启动成功后记录配置，按 model+name 去重，最新的排最前
function recordRecentLaunch(meta) {
  if (!meta || !meta.model) return;
  clearGatewayRuntimeCache();
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
  const [dockerStatus, gpu, container, image, logs, gpuCompatibilityProbe] = await Promise.all([
    getDockerVersion(),
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
    getImageStatus(CONFIG.image),
    summarizeRuntimeLogs({ tail: 260 }).catch((error) => ({ ok: false, issues: [{ severity: "error", message: error.message }] })),
    probeNvidiaRuntimeCompatibility(execFileAsync),
  ]);
  const runtimeCompatibility = assessVllmRuntimeCompatibility({
    probe: gpuCompatibilityProbe,
    imageReference: CONFIG.image,
    imageMetadata: knownRuntimeImageMetadata(CONFIG.image),
    hostPlatform: process.platform,
    hostArch: process.arch,
  });
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
  checks.push(healthCheck("docker", CONFIG.dockerRuntimeName, dockerStatus.ok ? "ok" : "fail", dockerStatus.text || "Docker not available", ["start-docker"], dockerStatus.ok ? [] : core.healthActionDetails(["start-docker"])));
  checks.push(healthCheck("gpu", "GPU", gpu.ok ? "ok" : "warn", gpu.ok ? `${gpu.name} · ${gpu.usedMb}/${gpu.totalMb} MB · ${gpu.util}%` : gpu.text || "No NVIDIA GPU detected"));
  checks.push(healthCheck("runtime-compatibility", "vLLM 运行时兼容性", runtimeCompatibility.status, runtimeCompatibility.summary));
  checks.push(healthCheck("image", "vLLM 镜像", image.ok ? "ok" : "warn", image.ok ? image.text : `${CONFIG.image} not found locally`, image.ok ? [] : ["pull-image"], image.ok ? [] : core.healthActionDetails(["pull-image"], { image: CONFIG.image, platform: CONFIG.imagePlatform })));
  checks.push(healthCheck("image-pin", "镜像版本", isPinnedImageReference(CONFIG.image) ? "ok" : "warn", CONFIG.image));
  checks.push(healthCheck("container", "推理容器", container.running ? "ok" : container.exists ? "warn" : "warn", container.status || (container.exists ? "exists" : "not started")));
  checks.push(healthCheck("api", "OpenAI 兼容 API", runtime?.models?.length ? "ok" : runtimeError ? "fail" : "warn", runtime?.models?.length ? `${runtime.models.length} model(s) served at ${runtime.endpoint.localUrl}` : runtimeError?.message || "No served model reported yet"));
  checks.push(healthCheck("runtime-secret-store", "运行时密钥存储", runtimeSecretStoreError ? "fail" : "ok", runtimeSecretStoreError?.message || "可用（密钥仅保存在受限本地文件中）"));
  if (!process.env.VLLM_MODELS_ROOT && !process.env.LLAMA_MODELS_ROOT) {
    checks.push(healthCheck("shared-models-root", "共享模型库", "ok", "已启用共享目录登记与跨管理器文件操作锁；可在模型存储与迁移页面配置保存位置。"));
  }
  checks.push(await directoryHealth("models-root", "模型目录", CONFIG.modelsRoot));
  checks.push(await directoryHealth("hf-cache", "HF 缓存目录", CONFIG.hfCache));
  const hasHfLogin = Boolean(process.env.HF_TOKEN || hfAuthService.hasCachedToken());
  checks.push(healthCheck("hf-token", "Hugging Face 账号", hasHfLogin ? "ok" : "warn", hasHfLogin ? "本机已连接" : "下载 gated 模型前需要连接 Hugging Face 账号"));
  checks.push(await commandHealth("hf-cli", "Hugging Face CLI", CONFIG.hfCli, ["--help"], "fail", core.healthActionDetails(["install-download-cli"])));
  checks.push(await commandHealth("modelscope-cli", "ModelScope CLI", CONFIG.modelScopeCli, ["--help"], "warn"));
  checks.push(healthCheck("logs", "最近日志", logs.issues?.some((item) => item.severity === "error") ? "fail" : logs.issues?.length ? "warn" : "ok", logs.stage || "No recent vLLM log issues"));

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

function knownRuntimeImageMetadata(imageReference) {
  const image = String(imageReference || "").trim().toLowerCase();
  const defaultReferences = new Set([
    defaultVllmImageReference().toLowerCase(),
    `${DEFAULT_VLLM_RELEASE.repository}@${DEFAULT_VLLM_RELEASE.manifestDigest}`.toLowerCase(),
    `${DEFAULT_VLLM_RELEASE.repository}:${DEFAULT_VLLM_RELEASE.version}`.toLowerCase(),
  ]);
  if (defaultReferences.has(image)) return DEFAULT_VLLM_RELEASE;
  const sglangReferences = new Set([
    DEFAULT_SGLANG_IMAGE.toLowerCase(),
    `${DEFAULT_SGLANG_RELEASE.repository}:${DEFAULT_SGLANG_RELEASE.version}`.toLowerCase(),
    "lmsysorg/sglang:latest-runtime",
  ]);
  if (sglangReferences.has(image)) return DEFAULT_SGLANG_RELEASE;
  if (image === DEFAULT_SGLANG_FLASH_NEXT_IMAGE.toLowerCase()) {
    const flashNext = core.getRuntimeRelease("sglangFlashNext") || {};
    return {
      ...DEFAULT_SGLANG_RELEASE,
      ...flashNext,
      manifestDigest: "",
      platformDigest: "",
    };
  }
  if (image === DEFAULT_QWEN_MOE_VLLM_IMAGE.toLowerCase()) {
    return {
      ...DEFAULT_VLLM_RELEASE,
      version: "nightly-a16dbd5b8572d4128be9f10b9dcff4999b594b25",
      manifestDigest: "",
      platformDigest: DEFAULT_QWEN_MOE_VLLM_IMAGE.split("@")[1],
      transformersVersion: "5.12.1",
    };
  }
  if (image === DEFAULT_GEMMA_VLLM_IMAGE.toLowerCase()) {
    return {
      ...DEFAULT_VLLM_RELEASE,
      version: "v74b5964f02c7e023fadd3004cfac8a61c52eef1f",
      manifestDigest: "",
      platformDigest: DEFAULT_GEMMA_VLLM_IMAGE.split("@")[1],
      transformersVersion: "5.10.2",
    };
  }
  return null;
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
    engine: normalizeRuntimeEngine(config.engine),
    name: String(config.name || ""),
    port: Number(config.port || CONFIG.defaultPort),
    maxModelLen: Number(config.maxModelLen || 8192),
    maxNumSeqs: Number(config.maxNumSeqs || 4),
    maxNumBatchedTokens: Math.max(0, Math.floor(Number(config.maxNumBatchedTokens || 0) || 0)),
    gpuMemoryUtilization: Number(config.gpuMemoryUtilization || 0.9),
    cpuOffloadGb: Number(config.cpuOffloadGb || 0),
    kvOffloadingSize: Number(config.kvOffloadingSize || 0),
    mmProcessorCacheGb: Number(config.mmProcessorCacheGb ?? 4),
    dtype: String(config.dtype || "auto"),
    quantization: String(config.quantization || ""),
    loadFormat: normalizeLoadFormat(config.loadFormat),
    tokenizer: cleanOptionalLaunchArg(config.tokenizer),
    hfConfigPath: cleanOptionalLaunchArg(config.hfConfigPath),
    kvCacheDtype: normalizeKvCacheDtype(config.kvCacheDtype),
    trustRemoteCode: Boolean(config.trustRemoteCode),
    enablePrefixCaching: Boolean(config.enablePrefixCaching),
    disablePrefixCaching: Boolean(config.disablePrefixCaching),
    languageModelOnly: Boolean(config.languageModelOnly),
    networkAccess: normalizeNetworkAccess(config.networkAccess),
    clientPreset: normalizeClientPreset(config.clientPreset),
    reasoningParser: normalizeReasoningParser(config.reasoningParser),
    enableAutoToolChoice: config.enableAutoToolChoice !== false,
    toolCallParser: normalizeToolCallParser(config.toolCallParser),
    multiGpuMode: String(config.multiGpuMode || "single"),
    gpuDeviceIds: Array.isArray(config.gpuDeviceIds) ? config.gpuDeviceIds.map(String) : [],
    tensorParallelSize: positiveInt(config.tensorParallelSize, 1),
    pipelineParallelSize: positiveInt(config.pipelineParallelSize, 1),
    dataParallelSize: positiveInt(config.dataParallelSize, 1),
    distributedExecutorBackend: String(config.distributedExecutorBackend || "auto"),
    enableExpertParallel: Boolean(config.enableExpertParallel),
    speculativeMode: normalizeSpeculativeMode(config.speculativeMode),
    numSpeculativeTokens: positiveInt(config.numSpeculativeTokens, 1),
    runtimeImage: String(config.runtimeImage || ""),
    draftModel: String(config.draftModel || ""),
    dsparkBlockSize: Math.min(32, Math.max(1, positiveInt(config.dsparkBlockSize, 7))),
    sglangMaxTotalTokens: Math.max(0, Math.floor(Number(config.sglangMaxTotalTokens || 0) || 0)),
    sglangPageSize: Math.max(0, Math.floor(Number(config.sglangPageSize || 0) || 0)),
    sglangChunkedPrefillSize: Math.max(0, Math.floor(Number(config.sglangChunkedPrefillSize || 0) || 0)),
    sglangFp4GemmBackend: String(config.sglangFp4GemmBackend || ""),
    sglangAttentionBackend: String(config.sglangAttentionBackend || ""),
    sglangPleOffloadEmbedding: Boolean(config.sglangPleOffloadEmbedding),
    sglangLinearAttnPrefillBackend: String(config.sglangLinearAttnPrefillBackend || ""),
    sglangLinearAttnDecodeBackend: String(config.sglangLinearAttnDecodeBackend || ""),
    sglangMambaSsmDtype: String(config.sglangMambaSsmDtype || ""),
    sglangMambaRadixCacheStrategy: String(config.sglangMambaRadixCacheStrategy || ""),
    sglangMambaTrackInterval: Math.max(0, Math.floor(Number(config.sglangMambaTrackInterval || 0) || 0)),
    sglangMaxMambaCacheSize: Math.max(0, Math.floor(Number(config.sglangMaxMambaCacheSize || 0) || 0)),
    sglangDisableThinkingByDefault: Boolean(config.sglangDisableThinkingByDefault),
  };
}

function defaultLaunchProfiles() {
  return createVllmDefaultLaunchProfiles(normalizeLaunchConfig);
}

function safeProfileId(value) {
  const base = String(value || "profile").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `profile-${Date.now().toString(36)}`;
}

async function checkModelCompatibility(input = {}) {
  const model = cleanRequired(input.model, "model");
  const loadFormat = normalizeLoadFormat(input.loadFormat || "auto");
  const clientPreset = normalizeClientPreset(input.clientPreset || "generic");
  const runtimeEngine = normalizeRuntimeEngine(input.engine);
  const findings = [];
  const recommendations = normalizeLaunchConfig({
    model,
    engine: runtimeEngine,
    name: deriveName(model),
    port: input.port || CONFIG.defaultPort,
    maxModelLen: input.maxModelLen || 32768,
    maxNumSeqs: input.maxNumSeqs || 2,
    gpuMemoryUtilization: input.gpuMemoryUtilization || 0.9,
    loadFormat,
    clientPreset,
    reasoningParser: inferReasoningParser(model),
    toolCallParser: inferToolCallParser(model, clientPreset),
    enableAutoToolChoice: true,
  });
  const local = describeLocalModelPath(model);
  const lower = model.toLowerCase();
  const looksGguf = looksLikeGgufReference(model) || local?.ggufFiles?.length || lower.endsWith(".gguf");
  const localConfig = local ? readLocalModelConfig(local.path) : null;
  const qwen38FlashNextNvfp4 = isQwen38FlashNextNvfp4Model(model, localConfig);
  const requestedRuntimeImage = String(input.runtimeImage || "").trim();
  const compatibilityRuntimeImage = requestedRuntimeImage || (runtimeEngine === "sglang"
    ? qwen38FlashNextNvfp4 ? CONFIG.sglangFlashNextImage : CONFIG.sglangImage
    : CONFIG.image);
  const pennyroyal = runtimeEngine === "sglang" && isPennyroyalImage(compatibilityRuntimeImage);
  const capabilities = resolveVllmModelCapabilities({
    model,
    localPath: local?.path,
    config: localConfig || {},
    quantization: input.quantization,
    speculativeMode: input.speculativeMode || "off",
    numSpeculativeTokens: input.numSpeculativeTokens,
    runtimeMetadata: knownRuntimeImageMetadata(compatibilityRuntimeImage),
    allowMuseGlimmer: envFlagEnabled(process.env.VLLM_ALLOW_MUSE_GLIMMER),
  });
  recommendations.speculativeMode = capabilities.speculativeConfig
    ? normalizeSpeculativeMode(input.speculativeMode, "off")
    : "off";
  recommendations.numSpeculativeTokens = capabilities.speculativeConfig?.num_speculative_tokens || 1;
  if (capabilities.capabilityEntry?.id) {
    findings.push(finding(capabilities.capabilityEntry.heuristic ? "warn" : "ok", "能力矩阵", capabilities.capabilityEntry.heuristic
      ? `${capabilities.capabilityEntry.label} 只按名称推断（模型目录缺 config.json 或架构未声明）；parser / 推测解码取自矩阵默认值。`
      : `${capabilities.capabilityEntry.label}（按 ${capabilities.capabilityEntry.matchedBy === "gguf" ? "GGUF 架构" : "config.json 声明"} 识别，置信度 ${capabilities.capabilityEntry.confidence}）。`));
  }
  if (capabilities.speculativeDecision) {
    findings.push(finding("ok", "推测解码决策", `${capabilities.speculativeDecision.method === "off" ? "关闭" : `${capabilities.speculativeDecision.method} × ${capabilities.speculativeDecision.tokens}`}：${capabilities.speculativeDecision.reason}`));
  }
  if (capabilities.reasoningParser) recommendations.reasoningParser = capabilities.reasoningParser;
  if (capabilities.toolCallParser) recommendations.toolCallParser = capabilities.toolCallParser;
  if (capabilities.enableAutoToolChoice) recommendations.enableAutoToolChoice = true;
  if (capabilities.nativeMtp.supported) {
    findings.push(finding("ok", "原生 MTP", capabilities.speculativeConfig
      ? `权重索引检出 ${capabilities.nativeMtp.tensorCount || "已打包"} 个 MTP 张量；本次将使用 ${capabilities.speculativeConfig.method} / ${capabilities.speculativeConfig.num_speculative_tokens} tokens。`
      : `权重索引检出 ${capabilities.nativeMtp.tensorCount || "已打包"} 个 MTP 张量，但当前档案关闭推测解码。${capabilities.notes[0] ? ` ${capabilities.notes[0]}` : ""}`));
  } else if (capabilities.nativeMtp.declared) {
    findings.push(finding("warn", "MTP 配置与权重不一致", "config.json 声明了 mtp_num_hidden_layers，但权重索引/头部没有检出 mtp.* 张量；自动 MTP 保持关闭。"));
  }
  if (["mtp", "qwen3_next_mtp"].includes(normalizeSpeculativeMode(input.speculativeMode)) && !capabilities.nativeMtp.supported) {
    findings.push(finding("fail", "MTP 权重缺失", "当前 checkpoint 没有可验证的 mtp.* 张量；为避免加载失败，管理器不会仅凭 config 字段启动原生 MTP。"));
  }
  if (capabilities.unsupportedReason) {
    findings.push(finding(
      "fail",
      capabilities.unsupportedCode === "muse_glimmer"
        ? "Muse Glimmer 已弃用"
        : capabilities.unsupportedCode === "bitsandbytes_plugin_missing"
          ? "BitsAndBytes 插件缺失"
          : "模型专用依赖缺失",
      capabilities.unsupportedReason,
    ));
  }
  if (capabilities.museGlimmerOverride) {
    findings.push(finding(
      "warn",
      "Muse Glimmer 高风险绕过已启用",
      capabilities.notes.find((note) => note.includes("VLLM_ALLOW_MUSE_GLIMMER=1"))
        || "VLLM_ALLOW_MUSE_GLIMMER=1 已绕过默认阻断；管理器无法保证该检查点与当前 vLLM/Transformers 运行时兼容。",
    ));
  }
  if (looksGguf) {
    findings.push(finding("warn", "GGUF 模型", "vLLM 的 GGUF 支持偏实验；如果是常规 llama.cpp GGUF，优先用 llama.cpp/llama-server。"));
    recommendations.loadFormat = "gguf";
    recommendations.quantization = "";
  }
  if (local) {
    findings.push(finding("ok", "本地路径可用", local.path));
    if (local.stat?.isDirectory()) {
      const verification = await modelFilesystemStore.verifyDownloadedModel({ localDir: local.path });
      for (const issue of verification.issues || []) {
        findings.push(finding(issue.severity, issue.title, issue.detail));
      }
      if (verification.ok) {
        findings.push(finding("ok", "模型文件完整性", `${verification.modelFormat || "unknown"} · ${verification.fileCount} 个有效文件 · 权重分片齐全`));
      }
    }
    const configQuantization = readLocalModelQuantizationMethod(local.path);
    if (configQuantization) {
      findings.push(finding("ok", "模型配置量化", `config.json 声明 ${configQuantization}，启动时应优先使用这个量化方法。`));
      recommendations.quantization = configQuantization;
    }
    if (local.stat?.isDirectory() && !hasRecognizedConfig(local.path) && !local.ggufFiles.length) {
      findings.push(finding("fail", "缺少配置文件", "没有识别到 config.json、params.json 或 GGUF 文件。"));
    }
    if (local.ggufFiles?.length) {
      findings.push(finding("warn", "检测到 GGUF", `${local.ggufFiles.length} 个 GGUF 文件，启动时会选择最大文件。`));
    }
  } else if (path.isAbsolute(model)) {
    findings.push(finding("fail", "本地路径不存在", model));
  }
  if (/^(meta-llama|google|mistralai)\//i.test(model) && !process.env.HF_TOKEN) {
    findings.push(finding("warn", "可能需要授权", "这类模型经常需要 Hugging Face token 或提前接受 license。"));
  }
  if (/nvfp4|fp4/i.test(model)) {
    findings.push(finding("ok", "NVFP4/FP4 权重", qwen38FlashNextNvfp4 && runtimeEngine === "sglang"
      ? "权重使用 NVFP4；Flash-Next QSA 当前必须保留 BF16 KV（界面选择 auto），不要启用 FP8 KV。"
      : "KV cache 可单独用 FP8；权重量化方法优先按模型 config.json 声明。"));
    if (!recommendations.quantization) recommendations.quantization = "modelopt_fp4";
    recommendations.kvCacheDtype = qwen38FlashNextNvfp4 && runtimeEngine === "sglang" ? "auto" : "fp8";
  } else if (/awq/i.test(model)) {
    recommendations.quantization = "awq";
  } else if (/gptq/i.test(model)) {
    recommendations.quantization = "gptq";
  } else if (/fp8/i.test(model)) {
    recommendations.quantization = "fp8";
  }
  if (/qwen3\.?6|qwen3/i.test(model)) {
    findings.push(finding("ok", "Qwen 工具调用", "推荐 --reasoning-parser qwen3 与 --tool-call-parser qwen3_coder。"));
    recommendations.reasoningParser = "qwen3";
    recommendations.toolCallParser = "qwen3_coder";
  }
  const qwen38 = isQwen38Model(model, localConfig);
  if (qwen38) {
    findings.push(finding("ok", "Qwen3.8 专用运行时", runtimeEngine === "sglang"
      ? qwen38FlashNextNvfp4
        ? pennyroyal ? "将使用固定 digest 的 Pennyroyal v2.5.1。" : `将使用 ${CONFIG.sglangFlashNextImage}，包含 SM120 QSA 完整修复。`
        : `将使用 SGLang ${DEFAULT_SGLANG_RELEASE.version} / FlashInfer / CPU feature transport。`
      : `将使用已验证的 Qwen3.8 vLLM ${DEFAULT_VLLM_RELEASE.version}。`));
    recommendations.engine = runtimeEngine;
    recommendations.maxModelLen = Number(input.maxModelLen || 262144);
    recommendations.maxNumSeqs = Number(input.maxNumSeqs || 4);
    recommendations.gpuMemoryUtilization = Number(input.gpuMemoryUtilization || 0.8);
    recommendations.kvCacheDtype = "auto";
    recommendations.languageModelOnly = runtimeEngine === "vllm";
    recommendations.enablePrefixCaching = true;
    recommendations.reasoningParser = "qwen3";
    recommendations.toolCallParser = "qwen3_coder";
  }
  if (pennyroyal) {
    Object.assign(recommendations, normalizeLaunchConfig({ ...PENNYROYAL_DEFAULTS, model,
      name: input.name || "pennyroyal", port: input.port || CONFIG.defaultPort,
      maxModelLen: input.maxModelLen || 524288,
      maxNumSeqs: input.maxNumSeqs || 4,
      sglangDisableThinkingByDefault: Boolean(input.sglangDisableThinkingByDefault),
    }));
    if (!qwen38FlashNextNvfp4) findings.push(finding("fail", "Pennyroyal 模型不匹配", "此预设仅用于 Qwen3.8 Flash-Next NVFP4 checkpoint。"));
    for (const detail of pennyroyalOptionErrors(input)) findings.push(finding("fail", "Pennyroyal 参数校验", detail));
    if (local?.path) {
      try {
        const tokenizer = await fsp.readFile(path.join(local.path, "tokenizer.json"));
        if (crypto.createHash("sha256").update(tokenizer).digest("hex") !== PENNYROYAL_TOKENIZER_SHA256) {
          findings.push(finding("fail", "FR-Spec tokenizer 不匹配", "本地 tokenizer 与固定 token map 不一致，禁止使用该 FR-Spec 预设。"));
        }
      } catch (error) {
        findings.push(finding("fail", "FR-Spec tokenizer 未验证", error.message));
      }
    }
    findings.push(finding("ok", "Pennyroyal WSL 路径", "NVFP4、Online FP8、FP8 KV、FR-Spec/NEXTN-3、RAM PLE；GPU radix 缓存开启，CPU HiCache/NIXL 关闭。"));
    findings.push(finding("warn", "容量与冷启动", "524288 tokens 为共享 KV 容量，不是 4 路各 524K；本机曾通过 500016-token 合成检索。F 盘冷加载约 16 分钟。"));
  } else if (qwen38FlashNextNvfp4 && runtimeEngine === "sglang") {
    findings.push(finding("ok", "Flash-Next 稳定路径", "PLE embedding 放入 CPU RAM；GDN prefill 使用 Triton、decode 使用 FlashInfer；Mamba state 使用 BF16。"));
    findings.push(finding("ok", "262K 单路档", "max Mamba cache 8 为 262K 稳定档保留显存，运行时有效并发为 1；需要并发时应单独做较短上下文 A/B。"));
    recommendations.runtimeImage = CONFIG.sglangFlashNextImage;
    recommendations.maxModelLen = Number(input.maxModelLen || 262144);
    recommendations.maxNumSeqs = 1;
    recommendations.gpuMemoryUtilization = Number(input.gpuMemoryUtilization || 0.995);
    recommendations.quantization = "modelopt_fp4";
    recommendations.kvCacheDtype = "auto";
    recommendations.trustRemoteCode = true;
    recommendations.speculativeMode = "off";
    recommendations.sglangMaxTotalTokens = Number(input.sglangMaxTotalTokens || 262144);
    recommendations.sglangPageSize = Number(input.sglangPageSize || 64);
    recommendations.sglangChunkedPrefillSize = Number(input.sglangChunkedPrefillSize || 4096);
    recommendations.sglangFp4GemmBackend = String(input.sglangFp4GemmBackend || "flashinfer_cutlass");
    recommendations.sglangAttentionBackend = String(input.sglangAttentionBackend || "triton");
    recommendations.sglangPleOffloadEmbedding = true;
    recommendations.sglangLinearAttnPrefillBackend = String(input.sglangLinearAttnPrefillBackend || "triton");
    recommendations.sglangLinearAttnDecodeBackend = String(input.sglangLinearAttnDecodeBackend || "flashinfer");
    recommendations.sglangMambaSsmDtype = String(input.sglangMambaSsmDtype || "bfloat16");
    recommendations.sglangMambaRadixCacheStrategy = String(input.sglangMambaRadixCacheStrategy || "extra_buffer");
    recommendations.sglangMambaTrackInterval = Number(input.sglangMambaTrackInterval || 64);
    recommendations.sglangMaxMambaCacheSize = Number(input.sglangMaxMambaCacheSize || 8);
    recommendations.sglangDisableThinkingByDefault = true;
    if (String(input.kvCacheDtype || "auto").toLowerCase() !== "auto") {
      findings.push(finding("fail", "Flash-Next FP8 KV 未开放", "QSA 路径仍有 query BF16 与 K/V FP8 dtype mismatch；请把 KV cache 精度设为 auto（当前会得到 BF16）。"));
    }
    const stableBackendRequirements = [
      ["sglangAttentionBackend", "triton", "QSA / attention backend"],
      ["sglangLinearAttnPrefillBackend", "triton", "Linear attention prefill"],
      ["sglangLinearAttnDecodeBackend", "flashinfer", "Linear attention decode"],
      ["sglangMambaSsmDtype", "bfloat16", "Mamba state dtype"],
    ];
    for (const [key, expected, label] of stableBackendRequirements) {
      const value = String(input[key] || "").toLowerCase();
      if (value && value !== expected) {
        findings.push(finding("fail", `${label} 不匹配`, `262K 稳定档要求 ${expected}，当前选择 ${value}。`));
      }
    }
    if (Object.hasOwn(input, "sglangPleOffloadEmbedding") && !input.sglangPleOffloadEmbedding) {
      findings.push(finding("fail", "PLE CPU offload 未启用", "该 checkpoint 的约 51GB PLE embedding 必须放入 128GB 系统内存；请启用 PLE embedding → CPU RAM。"));
    }
    if (normalizeSpeculativeMode(input.speculativeMode) !== "off") {
      findings.push(finding("fail", "Flash-Next 稳定档关闭推测解码", "当前已验证的 262K SGLang 档未启用 MTP/DSpark；请先使用 off，避免把未验证变量带入长上下文服务。"));
    }
    if (!input.sglangDisableThinkingByDefault && String(input.toolCallParser || "qwen3_coder") === "qwen3_coder") {
      findings.push(finding("warn", "Thinking + qwen3_coder 风险", "当前上游仍有 token-0 循环问题；建议勾选“默认关闭 thinking”，客户端确有需要时再逐请求开启。"));
    }
    if (requestedRuntimeImage && requestedRuntimeImage.toLowerCase() !== CONFIG.sglangFlashNextImage.toLowerCase()) {
      findings.push(finding("warn", "自定义 Flash-Next 镜像", `当前只验证了 ${CONFIG.sglangFlashNextImage}；自定义镜像必须确认含完整 SM120 QSA 修复。`));
    }
    if (Number(input.maxModelLen || 0) >= 229492 && Number(input.sglangMaxMambaCacheSize || 8) > 8) {
      findings.push(finding("warn", "极限上下文 Mamba cache 风险", "本机 max Mamba cache 24 在 229K 输入最后一个 prefill chunk OOM；262K 档请保持 8，较大值只用于单独的短上下文并发 A/B。"));
    }
  }
  if (normalizeSpeculativeMode(input.speculativeMode) === "dspark") {
    const draft = resolveDsparkDraftModel(input.draftModel);
    if (runtimeEngine !== "sglang") {
      findings.push(finding("fail", "vLLM DSpark 在本机不可用", "已实测 V2 runner 因 WSL UVA 失败，V1 会错误解析该 RadixArk checkpoint；请选择 SGLang。"));
    } else if (!qwen38) {
      findings.push(finding("fail", "DSpark 主模型不匹配", "当前 DSpark 档只对 Qwen3.8 主模型开放。"));
    } else if (!draft.ok) {
      findings.push(finding("fail", "DSpark 草稿模型不可用", draft.reason));
    } else {
      findings.push(finding("ok", "DSpark 草稿模型", `${draft.path} · block ${Math.min(32, Math.max(1, positiveInt(input.dsparkBlockSize, 7)))}`));
      recommendations.draftModel = draft.path;
      recommendations.dsparkBlockSize = Math.min(32, Math.max(1, positiveInt(input.dsparkBlockSize, 7)));
      recommendations.speculativeMode = "dspark";
    }
  } else if (runtimeEngine === "sglang" && !pennyroyal && normalizeSpeculativeMode(input.speculativeMode) !== "off") {
    findings.push(finding("fail", "SGLang 推测模式未开放", "SGLang 档当前只支持 off 或 dspark；请选择 DSpark 极速方案，或切回 vLLM 使用 MTP。"));
  }
  const qwen36MoeNvfp4 = !qwen38 && isQwen36MoeNvfp4Model(model, localConfig);
  const qwen36DenseNvfp4 = !qwen38 && isQwen36DenseNvfp4Model(model, localConfig);
  if (qwen36MoeNvfp4 || qwen36DenseNvfp4) {
    findings.push(finding("warn", "Qwen3.6 / NVFP4 运行时", `该模型卡建议使用 vLLM nightly，并设置 --max-num-batched-tokens 8192；固定旧版镜像可能在 ModelOpt 权重布局处失败（例如 scale 名称或维度不匹配）。管理器启动时会自动使用 ${CONFIG.qwenMoeImage} 并补齐这些专用参数。`));
    recommendations.quantization = "modelopt";
    recommendations.kvCacheDtype = qwen36MoeNvfp4 ? "fp8" : "auto";
    recommendations.reasoningParser = "qwen3";
    recommendations.toolCallParser = "qwen3_xml";
    recommendations.enableAutoToolChoice = true;
    recommendations.loadFormat = "auto";
    recommendations.maxNumBatchedTokens = 8192;
  }
  if (/deepseek/i.test(model)) {
    recommendations.reasoningParser = "deepseek_r1";
    recommendations.toolCallParser = "deepseek_v3";
  }
  if (isDiffusionGemmaModel(model, localConfig)) {
    const runnerMode = gemmaModelRunnerEnvValue() === "0" ? "V1 runner（Windows/WSL UVA fallback）" : "V2 runner";
    const windowsBlockReason = diffusionGemmaWindowsBlockReason();
    findings.push(finding("warn", "DiffusionGemma / Gemma4 专用启动", `该架构需要 Gemma 专用 vLLM 镜像；管理器会自动使用 ${CONFIG.gemmaImage}、${runnerMode}，并补齐 trust-remote-code、TRITON_ATTN、gemma4 parser。Windows/WSL fallback 只用于绕过 V2 UVA 初始化失败，不代表推理稳定。`));
    if (windowsBlockReason) {
      findings.push(finding("fail", "Windows Docker/WSL 不建议启动", windowsBlockReason));
    } else if (gemmaModelRunnerEnvValue() === "0") {
      findings.push(finding("warn", "Windows Docker/WSL 推理风险", "当前环境下 V2 runner 会因为 WSL 不支持 pinned memory / UVA 失败；V1 fallback 可以加载，但 DiffusionGemma NVFP4 在首个 chat 请求可能触发 CUDA device-side assert。建议在原生 Linux 上用 V2 runner，或改用常规 Qwen/Gemma 模型。"));
    }
    recommendations.trustRemoteCode = true;
    recommendations.reasoningParser = "gemma4";
    recommendations.toolCallParser = "gemma4";
    recommendations.enableAutoToolChoice = true;
    recommendations.kvCacheDtype = "fp8";
    recommendations.quantization = recommendations.quantization || "modelopt_fp4";
    recommendations.loadFormat = "auto";
    recommendations.maxNumSeqs = Math.min(Number(recommendations.maxNumSeqs || 4) || 4, 4);
    recommendations.languageModelOnly = false;
    recommendations.enablePrefixCaching = false;
  }
  if (/uncensored|abliterated|abliteration/i.test(model)) {
    findings.push(finding("info", "去审查/abliterated 标记", "适合本地测试，但建议在审计和访问控制上更谨慎。"));
  }

  const remote = await core.fetchRemoteCompatibilityInfo({
    model,
    local,
    findings,
    remoteEnabled: input.remote !== false,
    getHuggingFaceModelInfo: (id) => remoteModelService.getHuggingFaceModelInfo(id),
    onInfo: (remoteInfo) => {
      if (remoteInfo.hasGguf) recommendations.loadFormat = "gguf";
      if (remoteInfo.selection?.precision) recommendations.precision = remoteInfo.selection.precision;
    },
  });
  return core.buildCompatibilityReport({
    model,
    recommendations,
    remote,
    findings,
  });
}

function finding(severity, title, detail) {
  return core.compatibilityFinding(severity, title, detail);
}

function inferReasoningParser(model) {
  const text = String(model || "").toLowerCase();
  if (text.includes("nemotron-3-nano") || text.includes("nemotron_3_nano")) return "nano_v3";
  if (text.includes("diffusiongemma") || text.includes("diffusion_gemma") || text.includes("gemma4") || text.includes("gemma-4")) return "gemma4";
  if (text.includes("qwen3")) return "qwen3";
  if (text.includes("deepseek-r1") || text.includes("deepseek_r1")) return "deepseek_r1";
  if (text.includes("deepseek")) return "deepseek_v3";
  if (text.includes("gpt-oss") || text.includes("gptoss")) return "gptoss";
  if (text.includes("kimi")) return "kimi_k2";
  if (text.includes("mistral")) return "mistral";
  return "";
}

async function summarizeRuntimeLogs(options = {}) {
  return core.summarizeDockerRuntimeLogs({
    docker,
    containerName: CONFIG.containerName,
    tail: options.tail,
    classifyIssue: (message) => /out of memory|traceback|fatal|runtimeerror|failed|exception/i.test(message) ? "error" : "warn",
    issueHint: logIssueHint,
    detectStage: detectLogStage,
    buildSuggestions: buildLogSuggestions,
  });
}

function detectLogStage(text) {
  const lower = String(text || "").toLowerCase();
  if (/application startup complete|uvicorn running|api server/i.test(text) && /\/v1\/models|served model/i.test(text)) return "API ready";
  if (lower.includes("gpu kv cache size")) return "KV cache profiled";
  if (lower.includes("graph capturing finished")) return "CUDA graph captured";
  if (lower.includes("initial profiling") || lower.includes("warmup")) return "profiling / warmup";
  if (lower.includes("torch.compile")) return "torch.compile";
  if (lower.includes("loading weights") || lower.includes("model loading")) return "loading weights";
  if (lower.includes("error") || lower.includes("traceback")) return "error";
  return text ? "starting / waiting" : "no container logs";
}

function logIssueHint(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("mamba cache align") || text.includes("max_num_batched_tokens") || (text.includes("block_size") && text.includes("batched_tokens"))) return "这是 Qwen3.6 混合/Mamba cache align 下的调度 token 上限过低；把 --max-num-batched-tokens 提高到 8192 后重试。";
  if (text.includes("w2_input_scale") || text.includes("modelopt_mixed") || text.includes("exceeds dimension size")) return "这是 Qwen3.6/NVFP4 的 ModelOpt 权重布局与当前 vLLM 加载器不匹配；优先换 vllm/vllm-openai:nightly 或模型卡指定的 vLLM 版本。";
  if (text.includes("batchprefillwithpagedkvcache") || text.includes("illegal memory access")) return "这是 Qwen3.6/NVFP4 在 FlashInfer + FP8 KV prefill 路径上的 CUDA 崩溃风险；dense 模型改用 --attention-backend TRITON_ATTN，是否启用 thinking 由客户端请求决定。";
  if (text.includes("here's a thinking process") || text.includes("!!!!!!!!!!!!!!!!")) return "这是 Qwen3.6/NVFP4 thinking 或生成退化循环；dense 模型使用 TRITON_ATTN，SM12x MoE 使用 flashinfer_b12x + generation-config vllm；thinking 由客户端按需传 chat_template_kwargs.enable_thinking 控制。";
  if (text.includes("uva is not available")) return "这是 Windows Docker/WSL 的 pinned memory / UVA 限制；DiffusionGemma 的 V2 runner 需要 UVA，建议换原生 Linux 或使用非 DiffusionGemma 模型。";
  if (text.includes("scattergatherkernel") || text.includes("device-side assert")) return "这是推理期 CUDA kernel 断言，不是端口或显存占满；DiffusionGemma NVFP4 在 Windows Docker/WSL fallback 路径下可能无法稳定生成。";
  if (text.includes("out of memory") || text.includes("cuda")) return "降低 max_model_len / max_num_seqs，启用 FP8 KV cache，或降低 gpu-memory-utilization。";
  if (text.includes("no such") || text.includes("not found")) return "检查模型路径、Docker 挂载目录和文件名。";
  if (text.includes("trust_remote_code")) return "该模型可能需要开启 trust_remote_code。";
  if (text.includes("token") || text.includes("gated")) return "检查 HF_TOKEN 和模型授权。";
  if (text.includes("gguf")) return "GGUF 优先用 llama.cpp；若坚持 vLLM，确认 tokenizer/hf-config-path。";
  return "打开日志页查看完整上下文，必要时用保守 Profile 重试。";
}

function buildLogSuggestions(issues, stage) {
  const suggestions = [];
  if (issues.some((item) => /mamba cache align|max_num_batched_tokens|block_size .*batched_tokens/i.test(item.message))) {
    suggestions.push("Mamba cache align 断言：max_num_batched_tokens 太小，Qwen3.6 MoE/NVFP4 用 --max-num-batched-tokens 8192 后重试。");
  }
  if (issues.some((item) => /w2_input_scale|modelopt_mixed|qwen3_5\.py|exceeds dimension size/i.test(item.message))) {
    suggestions.push("Qwen3.6/NVFP4 加载失败：当前 vLLM 镜像可能不支持该 ModelOpt 权重布局，换 vllm/vllm-openai:nightly 或模型卡指定版本后重试。");
  }
  if (issues.some((item) => /BatchPrefillWithPagedKVCache|illegal memory access|Here's a thinking process|!{16,}/i.test(item.message))) {
    suggestions.push("Qwen3.6/NVFP4 推理退化或 FlashInfer prefill 崩溃：dense 模型使用 TRITON_ATTN，SM12x MoE 使用 flashinfer_b12x + generation-config vllm；thinking 开关应由客户端通过 chat_template_kwargs.enable_thinking 控制。");
  }
  if (issues.some((item) => /uva is not available|scattergatherkernel|device-side assert/i.test(item.message))) {
    suggestions.push("DiffusionGemma NVFP4 当前在 Windows Docker/WSL 路径不稳：优先换原生 Linux + V2 runner，或改跑常规 Qwen/Gemma 模型。");
  }
  if (issues.some((item) => /out of memory|cuda/i.test(item.message))) suggestions.push("显存错误：先切到低显存保守模式或把上下文减半。");
  if (issues.some((item) => /no such|not found/i.test(item.message))) suggestions.push("路径错误：从模型库选择本地模型并自动填入启动表单。");
  if (issues.some((item) => /token|gated/i.test(item.message))) suggestions.push("授权错误：配置 HF_TOKEN 后重新下载或启动。");
  if (!suggestions.length && stage !== "API ready") suggestions.push("如果长时间停在编译或 warmup，观察 GPU 利用率；首次启动慢通常正常。");
  if (!suggestions.length) suggestions.push("当前日志没有明显错误。");
  return suggestions;
}

const SERVICE_EXPOSURE_CHECK_OPTIONS = {
  allowRuntimeApiKey: true,
  warnDirectContainerWhen: "lan-bound-without-runtime-api-key",
  remoteRequiresClaudeExposure: true,
  remoteEnvVar: "VLLM_MANAGER_ALLOW_REMOTE=1",
  copy: {
    gatewayApiKeyOk: "管理器网关会强制 Bearer Token；对外推荐使用 /serve/v1、/claude 或 /opencode。",
    runtimeApiKeyOk: "运行中的 vLLM 容器已启用 Bearer Token。",
    directContainerWarn: "容器 LAN 端口不经过管理器网关；对外用户应连接管理器 /serve/v1，或重启 vLLM 时启用容器 API Key。",
    remoteTitle: "Claude 桥远程访问",
  },
};

async function buildServiceExposurePayload(settings) {
  const [snapshot, clientsLedger] = await Promise.all([
    getOperationalSnapshot(),
    getServiceClientsLedger().catch(() => ({ clients: [] })),
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

function serviceClientAllowsModel(client, model, runtime = null) {
  const roots = getServedModelRootMappings(runtime || {}).filter((entry) => entry.id === model).map((entry) => entry.root);
  return core.serviceClientAllowsModel(client, model, { roots });
}

function startAutomationMonitor() {
  if (automationMonitorTimer) return;
  automationMonitorTimer = setInterval(() => {
    sampleMetricsHistory().catch((error) => console.warn(`metrics history sample failed: ${error.message}`));
    inspectAutomationRules().catch((error) => console.warn(`automation monitor failed: ${error.message}`));
  }, 60 * 1000);
  automationMonitorTimer.unref?.();
  sampleMetricsHistory().catch((error) => console.warn(`initial metrics history sample failed: ${error.message}`));
}

async function sampleMetricsHistory() {
  const [gpu, container] = await Promise.all([getGpuStatus(), getContainerStatus(CONFIG.containerName)]);
  if (!container?.running) return null;
  const live = await collectVllmMetricsSummary(container, gpu, { updateSamples: false });
  return metricsHistoryStore.recordMetricsHistory({
    updatedAt: new Date().toISOString(),
    container,
    gpu,
    live,
    totals: live.totals,
    models: live.models,
  }, { engine: normalizeRuntimeEngine(container.labels?.[MANAGER_ENGINE_LABEL_KEY]) });
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
  const [gpu, container] = await Promise.all([
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
  ]);
  if (!container.running) {
    runtimeActivity = { ...runtimeActivity, initialized: false, lastRequestCount: null, lastTokenCount: null, unloading: false };
    return;
  }
  const summary = await collectVllmMetricsSummary(container, gpu, { updateSamples: false }).catch(() => null);
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
  const shouldVramUnload = settings.vramGuardEnabled && settings.vramAction === "unload" && gpuPercent >= settings.vramPercent && idleMs >= 2 * 60 * 1000 && noActiveKv;
  const shouldWarn = settings.vramGuardEnabled && settings.vramAction === "warn" && gpuPercent >= settings.vramPercent;
  if (shouldWarn && now - Date.parse(runtimeActivity.lastWarnAt || 0) > 10 * 60 * 1000) {
    runtimeActivity.lastWarnAt = new Date(now).toISOString();
    const job = createJob("automation", "VRAM guard warning", { gpuPercent, threshold: settings.vramPercent });
    appendLog(job, `GPU memory usage ${gpuPercent.toFixed(1)}% exceeded ${settings.vramPercent}%.`);
    finishJob(job, { result: "warn-only" });
  }
  if (shouldVramUnload) {
    runtimeActivity.unloading = true;
    const reason = `VRAM ${gpuPercent.toFixed(1)}% exceeded ${settings.vramPercent}%`;
    const job = createJob("automation", "Auto unload vLLM", { reason, settings });
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

async function verifyDownloadedModel(input = {}, options = {}) {
  return modelFilesystemStore.verifyDownloadedModel(input, options);
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
  });
}

async function buildClaudeCompressionInsights() {
  const settings = await getClaudeCompressionSettings();
  const ledger = await loadStatsLedger();
  const claude = core.normalizeClientUsageCounters(ledger.clients?.claude, "claude", "Claude compatible bridge");
  const last = claude.compression?.last || {};
  const sessions = clientSessionsToSummary(claude.sessions);
  return {
    ok: true,
    settings,
    totals: claude.compression,
    last,
    sessions: sessions.map((session) => ({
      id: session.id,
      label: session.label,
      source: session.source,
      lastSeenAt: session.lastSeenAt,
      tokens: session.tokens,
      requests: session.requests,
      compression: session.compression,
      last: session.last,
    })),
    note: "这里只显示压缩统计和最近会话摘要，不返回原始对话正文。",
  };
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

async function getServiceGatewayRuntimes(req) {
  const requestedInstanceId = serviceGatewaySelectedInstanceId(req);
  const runtimes = (await getRunningModelSummaries()).filter((runtime) => runtime.container?.running);
  return requestedInstanceId
    ? runtimes.filter((runtime) => runtimeMatchesServiceGatewayInstance(runtime, requestedInstanceId))
    : runtimes;
}

async function getServiceGatewayRuntime(req, fallbackGetter = getGatewayRunningModelSummary) {
  const requestedInstanceId = serviceGatewaySelectedInstanceId(req);
  if (!requestedInstanceId) return fallbackGetter();
  return (await getServiceGatewayRuntimes(req))[0] || null;
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
      headers: vllmAuthHeaders(runtime.vllmApiKey),
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

async function handleOpenCodeModels(req, res) {
  try {
    const requestedInstanceId = serviceGatewaySelectedInstanceId(req);
    const runtimes = await getServiceGatewayRuntimes(req);
    const runtime = runtimes[0];
    if (!runtime?.container?.running) {
      if (requestedInstanceId) {
        return res.status(503).json({ error: { message: `Selected runtime instance ${requestedInstanceId} is not available.`, type: "instance_not_available" } });
      }
      return res.status(503).json({ error: { message: "Model service is not running.", type: "service_unavailable" } });
    }
    const served = uniqueModelsById(runtimes.flatMap((item) => item.servedModels || []));
    const fallback = served[0] || runtime.models?.[0] || null;
    const created = fallback?.created || Math.floor(Date.now() / 1000);
    const aliases = OPENCODE_MODEL_ALIASES.map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "vllm-manager",
      root: fallback?.id || "",
      parent: fallback?.id || null,
      max_model_len: fallback?.max_model_len || fallback?.maxModelLen || null,
    }));
    res.json({
      object: "list",
      data: uniqueModelsById([...aliases, ...served]),
    });
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: "api_error" } });
  }
}

async function handleOpenCodeChatCompletions(req, res) {
  const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
  try {
    const runtime = await getOpenCodeRuntime(String(body.model || ""), req);
    if (!runtime?.container?.running) {
      const requestedInstanceId = serviceGatewaySelectedInstanceId(req);
      if (requestedInstanceId) {
        return res.status(503).json({ error: { message: `Selected runtime instance ${requestedInstanceId} is not available.`, type: "instance_not_available" } });
      }
      return res.status(503).json({ error: { message: "Model service is not running.", type: "service_unavailable" } });
    }
    const resolvedModel = resolveOpenCodeRequestedModel(String(body.model || ""), runtime);
    if (!resolvedModel) {
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 400, model: String(body.model || "") }).catch(() => {});
      return res.status(400).json({ error: { message: "No running vLLM model is available.", type: "invalid_request_error" } });
    }
    if (!serviceClientAllowsModel(req.serviceGateway?.client, resolvedModel, runtime)) {
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 403, model: resolvedModel }).catch(() => {});
      return res.status(403).json(openAiGatewayError("model_forbidden", "This service client is not allowed to use the requested model."));
    }
    body.model = resolvedModel;
    Object.assign(body, applyVllmRequestDefaults(body, runtime, resolvedModel, { upstreamPath: "chat/completions" }));
    const stream = body.stream === true;
    const upstreamAbort = new AbortController();
    if (stream) {
      res.once("close", () => {
        if (!res.writableEnded) upstreamAbort.abort();
      });
    }
    const upstream = await fetch(`http://127.0.0.1:${runtime.endpoint.port}/v1/chat/completions`, {
      method: "POST",
      headers: vllmAuthHeaders(runtime.vllmApiKey, { "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal: stream ? upstreamAbort.signal : AbortSignal.timeout(Number(req.serviceGateway?.timeoutMs || 10 * 60 * 1000)),
    });
    if (!stream) {
      const text = await upstream.text();
      const data = parseJsonSafe(text, null);
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, {
        ok: upstream.ok,
        status: upstream.status,
        model: resolvedModel,
        usage: data?.usage,
      }).catch(() => {});
      res.status(upstream.status);
      if (data && String(upstream.headers.get("content-type") || "").includes("json")) {
        res.type("application/json");
        return res.send(JSON.stringify(normalizeOpenCodeChatPayload(data)));
      }
      res.type(upstream.headers.get("content-type") || "application/json");
      return res.send(data ? JSON.stringify(normalizeOpenCodeChatPayload(data)) : text);
    }
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", upstream.headers.get("cache-control") || "no-cache");
    res.setHeader("connection", "keep-alive");
    await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: upstream.ok, status: upstream.status, model: resolvedModel }).catch(() => {});
    return streamOpenCodeChatPayload(upstream, res);
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(500).json({ error: { message: error.message, type: "api_error" } });
  }
}

async function getOpenCodeRuntime(requestedModel = "", req = null) {
  const runtimes = await getServiceGatewayRuntimes(req);
  if (!runtimes.length) return null;
  const value = String(requestedModel || "").trim().toLowerCase();
  const bare = value.split("/").pop();
  if (!value || OPENCODE_MODEL_ALIASES.some((alias) => [value, bare].includes(alias.toLowerCase()))) return runtimes[0];
  return runtimes.find((runtime) => (runtime.servedModels || []).some((model) => {
    const id = String(model.id || "").toLowerCase();
    const root = String(model.root || "").toLowerCase();
    return value === id || value === root || bare === id.split("/").pop();
  })) || runtimes[0];
}

function normalizeOpenCodeChatPayload(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.choices)) return data;
  for (const choice of data.choices) {
    const message = choice?.message;
    if (message && (message.content === null || message.content === undefined || message.content === "")) {
      const reasoning = message.reasoning_content || message.reasoning;
      if (reasoning) message.content = String(reasoning);
    }
    const delta = choice?.delta;
    if (delta && (delta.content === null || delta.content === undefined || delta.content === "")) {
      const reasoning = delta.reasoning_content || delta.reasoning;
      if (reasoning) delta.content = String(reasoning);
    }
  }
  return data;
}

async function streamOpenCodeChatPayload(upstream, res) {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!res.writableEnded) res.write(`${normalizeOpenCodeSseLine(line)}\n`);
      }
    }
    buffer += decoder.decode();
    if (buffer && !res.writableEnded) res.write(normalizeOpenCodeSseLine(buffer));
  } catch (error) {
    if (!isExpectedStreamDisconnect(error, res) && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: `Upstream stream failed: ${error.message}`, type: "api_error" } })}\n\n`);
    }
  }
  if (!res.writableEnded) res.end();
}

function normalizeOpenCodeSseLine(line) {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trimStart();
  if (!payload || payload === "[DONE]") return line;
  if (!payload.includes('"reasoning"') && !payload.includes('"reasoning_content"')) return line;
  const data = parseJsonSafe(payload, null);
  if (!data) return line;
  return `data: ${JSON.stringify(normalizeOpenCodeChatPayload(data))}`;
}

async function handleClaudeMessages(req, res) {
  const startedAt = Date.now();
  const body = req.body || {};
  let requestedModel = "";
  let resolvedModel = "";
  let toolSchemaCount = 0;
  let claudeSession = deriveClaudeTaskSession(req, body, String(body.model || ""));
  try {
    const requestedInstanceId = serviceGatewaySelectedInstanceId(req);
    const runtime = await getServiceGatewayRuntime(req);
    if (!runtime?.container?.running) {
      const unavailableMessage = requestedInstanceId
        ? `Selected runtime instance ${requestedInstanceId} is not available.`
        : "Model service is not running.";
      req.serviceGatewayAccessUsage = { error: unavailableMessage, toolSchemaCount };
      await recordClaudeBridgeUsage({
        requestedModel: String(body.model || ""),
        model: "",
        ok: false,
        error: unavailableMessage,
        latencyMs: Date.now() - startedAt,
        toolSchemaCount,
        session: claudeSession,
      }).catch(() => {});
      return res.status(503).json(claudeError("service_unavailable", unavailableMessage));
    }
    const fallbackModel = runtime.servedModels?.[0]?.id || runtime.models?.[0]?.id || "";
    requestedModel = String(body.model || fallbackModel).trim();
    claudeSession = deriveClaudeTaskSession(req, body, requestedModel);
    const model = resolveClaudeRequestedModel(requestedModel, runtime);
    resolvedModel = model;
    toolSchemaCount = Array.isArray(body.tools) ? body.tools.length : 0;
    if (!model) {
      req.serviceGatewayAccessUsage = { error: "model is required.", toolSchemaCount };
      await recordClaudeBridgeUsage({
        requestedModel,
        model: "",
        ok: false,
        error: "model is required.",
        latencyMs: Date.now() - startedAt,
        toolSchemaCount,
        session: claudeSession,
      }).catch(() => {});
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 400, model: requestedModel }).catch(() => {});
      return res.status(400).json(claudeError("invalid_request_error", "model is required."));
    }
    if (!serviceClientAllowsModel(req.serviceGateway?.client, model, runtime)) {
      req.serviceGatewayAccessUsage = { resolvedModel: model, error: "This service client is not allowed to use the requested model.", toolSchemaCount };
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 403, model }).catch(() => {});
      return res.status(403).json(claudeError("permission_error", "This service client is not allowed to use the requested model."));
    }

    const compressionSettings = await getClaudeCompressionSettings();
    const compression = await applyClaudeContextCompression(body, runtime, model, compressionSettings);
    const effectiveBody = compression.body;
    const stream = body.stream === true;
    const openAiBody = applyVllmRequestDefaults(
      buildOpenAiBodyFromClaude(effectiveBody, model),
      runtime,
      model,
      { upstreamPath: "chat/completions" },
    );
    const upstreamAbort = new AbortController();
    if (stream) {
      // If the client goes away mid-stream, stop consuming the vLLM response too.
      res.once("close", () => {
        if (!res.writableEnded) upstreamAbort.abort();
      });
    }
    const fetchOptions = {
      method: "POST",
      headers: vllmAuthHeaders(runtime.vllmApiKey, { "content-type": "application/json" }),
      body: JSON.stringify(openAiBody),
      signal: stream ? upstreamAbort.signal : AbortSignal.timeout(Number(req.serviceGateway?.timeoutMs || 120000)),
    };
    const upstream = await fetch(`http://127.0.0.1:${runtime.endpoint.port}/v1/chat/completions`, fetchOptions);

    if (stream) {
      if (!upstream.ok) {
        req.serviceGatewayAccessUsage = { resolvedModel: model, error: `Upstream returned ${upstream.status}`, toolSchemaCount };
        await recordClaudeBridgeUsage({
          requestedModel,
          model,
          ok: false,
          error: `Upstream returned ${upstream.status}`,
          latencyMs: Date.now() - startedAt,
          toolSchemaCount,
          stream: true,
          compression,
          session: claudeSession,
        }).catch(() => {});
        await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: upstream.status, model }).catch(() => {});
        return sendClaudeUpstreamError(res, upstream);
      }
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: true, status: 200, model }).catch(() => {});
      return streamOpenAiAsClaude(upstream, res, model, {
        requestedModel,
        startedAt,
        toolSchemaCount,
        compression,
        session: claudeSession,
        req,
      });
    }

    const text = await upstream.text();
    const data = parseJsonSafe(text, null);
    if (!upstream.ok) {
      req.serviceGatewayAccessUsage = { resolvedModel: model, error: upstreamErrorMessage(data, text), toolSchemaCount };
      await recordClaudeBridgeUsage({
        requestedModel,
        model,
        ok: false,
        error: upstreamErrorMessage(data, text),
        latencyMs: Date.now() - startedAt,
        toolSchemaCount,
        compression,
        session: claudeSession,
      }).catch(() => {});
      return res.status(upstream.status).json(claudeError("api_error", upstreamErrorMessage(data, text)));
    }
    const claudeResponse = core.openAiResponseToClaude(data, model);
    req.serviceGatewayAccessUsage = {
      resolvedModel: model,
      inputTokens: claudeResponse.usage?.input_tokens || 0,
      outputTokens: claudeResponse.usage?.output_tokens || 0,
      stopReason: claudeResponse.stop_reason || "",
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
      session: claudeSession,
    }).catch(() => {});
    await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, {
      ok: true,
      status: 200,
      model,
      usage: claudeResponse.usage,
    }).catch(() => {});
    res.json(claudeResponse);
  } catch (error) {
    req.serviceGatewayAccessUsage = { resolvedModel: resolvedModel || "", error: error.message, toolSchemaCount };
    await recordClaudeBridgeUsage({
      requestedModel,
      model: resolvedModel,
      ok: false,
      error: error.message,
      latencyMs: Date.now() - startedAt,
      toolSchemaCount,
      session: claudeSession,
    }).catch(() => {});
    await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 500, model: resolvedModel || requestedModel }).catch(() => {});
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(500).json(claudeError("api_error", error.message));
  }
}

function buildOpenAiBodyFromClaude(body, model) {
  return core.buildOpenAiChatBodyFromClaude(body, model, { defaultMaxTokens: CONFIG.claudeDefaultMaxTokens });
}

function applyClaudeContextCompression(body, runtime, model, settings) {
  return core.applyClaudeContextCompression(body, runtime, model, normalizeClaudeCompressionSettings(settings), {
    defaultMaxTokens: CONFIG.claudeDefaultMaxTokens,
    language: "zh-CN",
  });
}

function deriveClaudeTaskSession(req, body, requestedModel = "") {
  const metadata = body?.metadata && typeof body.metadata === "object" ? body.metadata : {};
  const explicit = firstNonEmpty(
    metadata.session_id,
    metadata.sessionId,
    metadata.task_id,
    metadata.taskId,
    metadata.conversation_id,
    metadata.conversationId,
    metadata.thread_id,
    metadata.threadId,
    getRequestHeader(req, "x-claude-session-id"),
    getRequestHeader(req, "x-session-id"),
    getRequestHeader(req, "x-conversation-id"),
    getRequestHeader(req, "x-task-id"),
    getRequestHeader(req, "anthropic-session-id"),
  );
  const firstUserText = firstClaudeUserMessageText(body?.messages);
  const systemText = core.anthropicContentToText(body?.system);
  const seed = explicit
    ? `explicit\n${explicit}`
    : [
        "content-fingerprint",
        requestedModel || body?.model || "",
        clipText(systemText, 2000),
        clipText(firstUserText, 4000),
      ].join("\n");
  const fingerprint = crypto.createHash("sha256").update(seed, "utf8").digest("hex");
  const source = explicit ? "explicit" : "content-fingerprint";
  // The label is persisted to stats-ledger.json and shown in the UI. It used to
  // be the first 96 characters of the user's prompt, which contradicted the
  // documented promise that no prompt text is recorded. Identify the session by
  // its model and fingerprint instead.
  const label = clipText(
    explicit
      ? `会话 ${explicit}`
      : `${requestedModel || body?.model || "Claude"} · ${fingerprint.slice(0, 8)}`,
    96,
  );
  return {
    id: `claude-${fingerprint.slice(0, 16)}`,
    fingerprint,
    source,
    label,
    explicit: Boolean(explicit),
  };
}

function firstClaudeUserMessageText(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (String(message?.role || "user") === "assistant") continue;
    const text = core.anthropicMessageToSummaryText(message).trim();
    if (text) return text;
  }
  return "";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function getRequestHeader(req, name) {
  if (!req || !name) return "";
  if (typeof req.get === "function") return String(req.get(name) || "").trim();
  return String(req.headers?.[String(name).toLowerCase()] || "").trim();
}

function clipText(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 16)).trim()} ...[截断]`;
}

function resolveClaudeRequestedModel(requestedModel, runtime) {
  const served = getServedModelIds(runtime);
  if (!served.length) return requestedModel || "";
  const value = String(requestedModel || "").trim();
  if (!value) return served[0];
  const bareValue = value.includes("/") ? value.split("/").at(-1) : value;
  const lowerValue = value.toLowerCase();
  const lowerBareValue = bareValue.toLowerCase();
  const exactServed = served.find((id) => id === value || id.toLowerCase() === lowerValue || id === bareValue || id.toLowerCase() === lowerBareValue);
  if (exactServed) return exactServed;
  const rootMatch = getServedModelRootMappings(runtime).find((entry) => entry.root === value || entry.root.toLowerCase() === lowerValue || entry.root === bareValue || entry.root.toLowerCase() === lowerBareValue);
  if (rootMatch) return rootMatch.id;
  if (getClaudeModelAliases(runtime).some((alias) => alias.toLowerCase() === lowerValue || alias.toLowerCase() === lowerBareValue) || lowerValue.startsWith("claude-")) return served[0];
  return served[0];
}

function resolveOpenCodeRequestedModel(requestedModel, runtime) {
  const served = getServedModelIds(runtime);
  if (!served.length) return requestedModel || "";
  const value = String(requestedModel || "").trim();
  if (!value) return served[0];
  const bareValue = value.includes("/") ? value.split("/").at(-1) : value;
  const exactServed = served.find((id) => id === value || id.toLowerCase() === value.toLowerCase() || id === bareValue || id.toLowerCase() === bareValue.toLowerCase());
  if (exactServed) return exactServed;
  const rootMatch = getServedModelRootMappings(runtime).find((entry) => entry.root === value || entry.root.toLowerCase() === value.toLowerCase());
  if (rootMatch) return rootMatch.id;
  if (OPENCODE_MODEL_ALIASES.some((alias) => alias.toLowerCase() === value.toLowerCase() || alias.toLowerCase() === bareValue.toLowerCase())) return served[0];
  return served[0];
}

function getClaudeModelAliases(runtime, models = []) {
  const served = getServedModelIds(runtime, models);
  if (!served.length) return [];
  const rootAliases = getServedModelRootMappings(runtime, models).map((entry) => entry.root);
  return Array.from(new Set([...CLAUDE_MODEL_ALIASES, ...CLAUDE_LOCAL_MODEL_ALIASES, ...rootAliases]));
}

function getServedModelIds(runtime, models = []) {
  const ids = [
    ...models.map((model) => model.id),
    ...(runtime?.servedModels || []).map((model) => model.id),
    ...(runtime?.models || []).map((model) => model.id),
  ];
  return Array.from(new Set(ids.filter(Boolean)));
}

function getServedModelRootMappings(runtime, models = []) {
  const entries = [
    ...models,
    ...(runtime?.servedModels || []),
    ...(runtime?.models || []),
  ];
  const mappings = [];
  const seen = new Set();
  for (const model of entries) {
    const id = String(model?.id || "").trim();
    const root = String(model?.root || "").trim();
    if (!id || !root || id === root) continue;
    const key = `${id}\n${root}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mappings.push({ id, root });
  }
  return mappings;
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

function normalizeRemoteLimit(value) {
  const number = Number(value || 48);
  if (!Number.isFinite(number)) return 48;
  return Math.min(120, Math.max(12, Math.floor(number)));
}

function unique(values) {
  return Array.from(new Set(values));
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

// 端口预检：先看是否被其它托管容器发布占用，再尝试在本机绑定该端口探测 OS 占用
async function checkPortAvailability(port, targetContainerName = CONFIG.containerName) {
  const containers = await listManagedContainers().catch(() => []);
  const ownName = normalizeDockerContainerName(targetContainerName);
  const conflict = containers.find((container) => {
    const published = parseDockerPortPublish(container.ports);
    return published?.port === port;
  });
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
  if (osInUse) {
    return { port, available: false, reason: "os", detail: `端口 ${port} 已被本机其它进程占用。` };
  }
  return { port, available: true, detail: `端口 ${port} 可用。` };
}

function isPortInUseOnHost(port) {
  // 分别探测 127.0.0.1 和 0.0.0.0：vLLM 容器按访问模式发布到其一，
  // 任一被占用都会导致 docker 端口映射失败（Windows 上两者可独立占用）。
  const probe = (host) => new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", (error) => {
      tester.close();
      resolve(error.code === "EADDRINUSE" || error.code === "EACCES");
    });
    tester.once("listening", () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, host);
  });
  return Promise.all([probe("127.0.0.1"), probe("0.0.0.0")]).then((results) => results.some(Boolean));
}

// 读取模型 config.json：本地模型从磁盘读，HF 从 resolve/main 拉。
// 用于精确显存估算（真实层数/头数/维度）与原生上下文长度提示。
async function getModelConfig(model, source = "huggingface", quantization = "") {
  const input = String(model || "").trim();
  const local = describeLocalModelPath(input);
  if (local?.stat?.isDirectory()) {
    const configPath = path.join(local.path, "config.json");
    if (fs.existsSync(configPath)) {
      const raw = parseJsonSafe(await fsp.readFile(configPath, "utf8"), null);
      if (raw) return { ...normalizeModelConfig(raw), ...summarizeModelConfigCapabilities(raw, input, local.path, quantization), source: "local", model: input, found: true };
    }
    return { source: "local", model: input, found: false, reason: "本地目录没有 config.json（可能是 GGUF）。" };
  }
  if (source !== "huggingface" || !/^[^/\s]+\/[^/\s]+$/.test(input)) {
    return { source, model: input, found: false, reason: "仅支持 Hugging Face 仓库或本地模型目录。" };
  }
  const url = `https://huggingface.co/${encodeRepoId(input)}/resolve/main/config.json`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "vllm-manager/0.1",
      ...(process.env.HF_TOKEN ? { authorization: `Bearer ${process.env.HF_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) {
    return { source: "huggingface", model: input, found: false, gated: true, hasToken: Boolean(process.env.HF_TOKEN), reason: "该仓库受限（gated/私有），需要配置 HF_TOKEN 才能读取。" };
  }
  if (response.status === 404) {
    return { source: "huggingface", model: input, found: false, reason: "未找到 config.json（可能是 GGUF 或非标准仓库）。" };
  }
  if (!response.ok) {
    const error = new Error(`读取 config.json 失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const raw = parseJsonSafe(await response.text(), null);
  if (!raw) return { source: "huggingface", model: input, found: false, reason: "config.json 解析失败。" };
  return { ...normalizeModelConfig(raw), ...summarizeModelConfigCapabilities(raw, input, "", quantization), source: "huggingface", model: input, found: true };
}

function summarizeModelConfigCapabilities(raw, model, localPath = "", quantization = "") {
  // Prefer the user's chosen quantization over whatever is baked into config.json:
  // the dropdown is what actually ships to vLLM, and the MTP/compat decision
  // (e.g. auto-off for Qwen3.5/3.6 + NVFP4) must match it, not a stale file value.
  const effectiveQuantization = String(quantization || "").trim()
    || raw?.quantization_config?.quant_method
    || "";
  const capabilities = resolveVllmModelCapabilities({
    model,
    localPath,
    config: raw || {},
    quantization: effectiveQuantization,
    speculativeMode: "auto",
    numSpeculativeTokens: 1,
  });
  return {
    speculative: {
      enabled: Boolean(capabilities.speculativeConfig),
      mode: capabilities.speculativeConfig?.method || "off",
      numSpeculativeTokens: capabilities.speculativeConfig?.num_speculative_tokens || 1,
      nativeMtp: Boolean(capabilities.nativeMtp?.supported),
      nativeMtpLayers: Number(capabilities.nativeMtp?.layers || 0),
      nativeMtpTensorCount: Number(capabilities.nativeMtp?.tensorCount || 0),
      nativeMtpEvidence: String(capabilities.nativeMtp?.evidence || ""),
      reason: capabilities.speculativeDecision?.reason
        || capabilities.notes.find((note) => /MTP|Speculative decoding/i.test(note))
        || "",
    },
    capabilityEntry: capabilities.capabilityEntry || null,
    recommendedReasoningParser: capabilities.reasoningParser || "",
    recommendedToolCallParser: capabilities.toolCallParser || "",
  };
}

function normalizeModelConfig(raw) {
  // 多模态模型的语言塔常嵌在 text_config / llm_config 下
  const text = raw.text_config || raw.llm_config || raw.language_config || {};
  const pick = (key) => raw[key] ?? text[key];
  const numHeads = Number(pick("num_attention_heads")) || 0;
  const hiddenSize = Number(pick("hidden_size")) || 0;
  const headDim = Number(pick("head_dim")) || (numHeads ? Math.round(hiddenSize / numHeads) : 0);
  const kvHeads = Number(pick("num_key_value_heads")) || numHeads || 0;
  const quant = raw.quantization_config || {};
  const numLayers = Number(pick("num_hidden_layers")) || null;
  // 混合架构（Qwen3.5/3.6、Qwen3-Next 等）只有 full_attention 层消耗 KV cache，
  // linear/mamba 层用常量状态缓存；KV 估算必须用注意力层数而非总层数
  const layerTypes = Array.isArray(raw.layer_types) ? raw.layer_types : (Array.isArray(text.layer_types) ? text.layer_types : []);
  const fullAttentionCount = layerTypes.filter((item) => /full_attention/i.test(String(item))).length;
  const attentionInterval = Number(pick("full_attention_interval"));
  const kvLayers = fullAttentionCount > 0
    ? fullAttentionCount
    : numLayers && Number.isFinite(attentionInterval) && attentionInterval > 0
      ? Math.max(1, Math.ceil(numLayers / attentionInterval))
      : null;
  return {
    architectures: Array.isArray(raw.architectures) ? raw.architectures : [],
    modelType: String(raw.model_type || text.model_type || ""),
    maxPositionEmbeddings: Number(pick("max_position_embeddings")) || null,
    ropeScaling: raw.rope_scaling || text.rope_scaling || null,
    numHiddenLayers: numLayers,
    numAttentionLayers: kvLayers,
    numAttentionHeads: numHeads || null,
    numKeyValueHeads: kvHeads || null,
    hiddenSize: hiddenSize || null,
    headDim: headDim || null,
    torchDtype: String(pick("torch_dtype") || ""),
    quantMethod: String(quant.quant_method || quant.quant_algo || "") || (raw.quantization_config ? "quantized" : ""),
    numExperts: Number(pick("num_experts") ?? pick("n_routed_experts")) || null,
    isMultimodal: Boolean(raw.vision_config || raw.text_config || raw.vision_tower || raw.image_token_id),
    mtpNumHiddenLayers: Number(pick("mtp_num_hidden_layers")) || 0,
  };
}

async function getModelReadme(model) {
  const url = `https://huggingface.co/${encodeRepoId(model)}/resolve/main/README.md`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "vllm-manager/0.1",
      ...(process.env.HF_TOKEN ? { authorization: `Bearer ${process.env.HF_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) {
    return { model, found: false, gated: true, reason: "仓库受限，需要 HF_TOKEN 才能读取 README。" };
  }
  if (!response.ok) {
    return { model, found: false, reason: `未找到 README（${response.status}）。` };
  }
  const raw = await response.text();
  return { model, found: true, ...summarizeReadme(raw) };
}

function summarizeReadme(raw) {
  let body = String(raw || "");
  // 去掉 YAML frontmatter（HF 模型卡的元数据头）
  body = body.replace(/^﻿/, "");
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) body = body.slice(body.indexOf("\n", end + 1) + 1);
  }
  // 去掉 HTML 注释、徽章图片、标题井号，压缩空行
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const summary = body.slice(0, 1200);
  return { summary, truncated: body.length > 1200 };
}

function normalizeDtype(value) {
  const dtype = String(value || "auto").trim().toLowerCase();
  if (new Set(["auto", "half", "float16", "bfloat16", "float", "float32"]).has(dtype)) return dtype;
  const error = new Error(`不支持的 dtype：${dtype}。可用值：auto, half, float16, bfloat16, float, float32。`);
  error.status = 400;
  throw error;
}

function normalizeQuantization(value) {
  const quant = String(value || "").trim().toLowerCase();
  if (!quant) return "";
  // vLLM quantization methods evolve quickly, so validate the charset instead of a fixed enum.
  if (/^[a-z0-9_.-]+$/.test(quant)) return quant;
  const error = new Error(`quantization 含有非法字符：${quant}`);
  error.status = 400;
  throw error;
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
    "gemma4",
    "granite",
    "hunyuan_a13b",
    "kimi_k2",
    "mistral",
    "nemotron_v3",
    "olmo3",
    "step3",
    "step3p5",
    "identity",
    "nano_v3",
  ]);
  return allowed.has(parser) ? parser : "";
}

function normalizeToolCallParser(value) {
  const parser = String(value || "").trim().toLowerCase();
  const allowed = new Set([
    "",
    "auto",
    "qwen3_coder",
    "qwen3_xml",
    "hermes",
    "deepseek_v3",
    "mistral",
    "llama3_json",
    "llama4_pythonic",
    "xlam",
    "gemma4",
    "pythonic",
    "granite",
    "minimax",
  ]);
  return allowed.has(parser) ? parser : "";
}

function inferToolCallParser(model, preset = "generic") {
  // 工具调用格式由模型的 chat template 决定；preset 只保留在签名里兼容调用点。
  const text = String(model || "").toLowerCase();
  if (text.includes("nemotron-3-nano") || text.includes("nemotron_3_nano")) return "qwen3_coder";
  if (text.includes("diffusiongemma") || text.includes("diffusion_gemma") || text.includes("gemma4") || text.includes("gemma-4")) {
    return "gemma4";
  }
  if (text.includes("qwen3.6") || text.includes("qwen3.8") || text.includes("qwen3-") || text.includes("qwen/qwen3") || text.includes("qwen3_coder") || text.includes("qwen3-coder")) {
    return "qwen3_coder";
  }
  if (text.includes("qwen2.5") || text.includes("qwq") || text.includes("qwen")) return "hermes";
  if (text.includes("deepseek")) return "deepseek_v3";
  if (text.includes("mistral")) return "mistral";
  if (text.includes("llama-3") || text.includes("llama3")) return "llama3_json";
  if (text.includes("xlam")) return "xlam";
  if (text.includes("granite")) return "granite";
  return "";
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
  const local = describeLocalModelPath(input);
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
      localPath: local?.path || "",
    };
  }

  if (local?.stat?.isDirectory()) {
    if (!local.ggufFiles.length) {
      throw new Error(`GGUF 模式需要目录里有 .gguf 文件：${input}`);
    }
    const selected = chooseGgufFile(local.ggufFiles);
    return {
      modelArg: windowsPathToContainerModel(selected.path),
      effectiveLoadFormat,
      selectedGgufFile: selected.path,
      ggufFiles: local.ggufFiles,
      localPath: local.path,
    };
  }

  return {
    modelArg: windowsPathToContainerModel(input),
    effectiveLoadFormat,
    selectedGgufFile: hasGgufFile ? local.path : "",
    ggufFiles: hasGgufFile ? [{ path: local.path, size: local.stat.size }] : [],
    localPath: local?.path || "",
  };
}

function readLocalModelQuantizationMethod(localPath) {
  const config = readLocalModelConfig(localPath);
  return normalizeQuantization(String(config?.quantization_config?.quant_method || ""));
}

function readLocalModelConfig(localPath) {
  if (!localPath) return null;
  const configPath = path.join(localPath, "config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function isDiffusionGemmaModel(model, config = null) {
  const text = String(model || "").toLowerCase();
  const modelType = String(config?.model_type || config?.text_config?.model_type || "").toLowerCase();
  const architectures = Array.isArray(config?.architectures) ? config.architectures.join(" ").toLowerCase() : "";
  return text.includes("diffusiongemma")
    || text.includes("diffusion_gemma")
    || modelType === "diffusion_gemma"
    || architectures.includes("diffusiongemma");
}

function qwen36Nvfp4ModelFlags(model, config = null) {
  const text = String(model || "").toLowerCase();
  const modelType = String(config?.model_type || config?.text_config?.model_type || "").toLowerCase();
  const architectures = Array.isArray(config?.architectures) ? config.architectures.join(" ").toLowerCase() : "";
  const quantization = JSON.stringify(config?.quantization_config || {}).toLowerCase();
  const hasQuantizationConfig = Boolean(config?.quantization_config);
  const qwen36Moe = text.includes("qwen3.6-35b-a3b")
    || text.includes("qwen3_5_moe")
    || modelType.includes("qwen3_5_moe")
    || architectures.includes("qwen3_5moe")
    || architectures.includes("qwen3_5_moe");
  const qwen36Hybrid = text.includes("qwen3.6")
    || text.includes("qwen3_6")
    || text.includes("qwen3-6")
    || modelType.includes("qwen3_5")
    || architectures.includes("qwen3_5");
  const modeloptNvfp4 = (!hasQuantizationConfig && text.includes("nvfp4"))
    || quantization.includes("nvfp4")
    || quantization.includes("w4a16_nvfp4")
    || (quantization.includes("mixed_precision") && quantization.includes("modelopt"))
    || (quantization.includes("modelopt") && quantization.includes("fp4"));
  return { qwen36Moe, qwen36Hybrid, modeloptNvfp4 };
}

function isQwen36MoeNvfp4Model(model, config = null) {
  const { qwen36Moe, modeloptNvfp4 } = qwen36Nvfp4ModelFlags(model, config);
  return qwen36Moe && modeloptNvfp4;
}

function isQwen36DenseNvfp4Model(model, config = null) {
  const { qwen36Moe, qwen36Hybrid, modeloptNvfp4 } = qwen36Nvfp4ModelFlags(model, config);
  return qwen36Hybrid && !qwen36Moe && modeloptNvfp4;
}

function isQwen38Model(model, config = null) {
  const text = String(model || "").toLowerCase();
  const architectures = Array.isArray(config?.architectures) ? config.architectures.join(" ").toLowerCase() : "";
  return /qwen3\.8(?:[^0-9]|$)/.test(text) || architectures.includes("qwen3_8");
}

function isQwen38Nvfp4Model(model, config = null) {
  if (!isQwen38Model(model, config)) return false;
  const quantization = JSON.stringify(config?.quantization_config || {}).toLowerCase();
  return /nvfp4|fp4/.test(String(model || "").toLowerCase())
    || quantization.includes("nvfp4")
    || quantization.includes("nvfp4-pack-quantized");
}

function isQwen38FlashNextNvfp4Model(model, config = null) {
  if (!isQwen38Nvfp4Model(model, config)) return false;
  return core.matchesCapabilityEntry("qwen3.8-flash-next", { model, config: config || {} });
}

function resolveDsparkDraftModel(value = "") {
  const requested = String(value || "").trim();
  const candidate = requested ? modelStorage.fromContainerPath(requested) : path.join(CONFIG.modelsRoot, "RadixArk-Qwen3.8-27B-DSpark");
  let resolved;
  try { resolved = modelStorage.resolvePath(path.isAbsolute(candidate) ? candidate : path.resolve(CONFIG.modelsRoot, candidate)); }
  catch (error) { return { path: candidate, ok: false, reason: error.message }; }
  const config = readLocalModelConfig(resolved);
  const architectures = Array.isArray(config?.architectures) ? config.architectures.map(String) : [];
  if (!fs.existsSync(resolved) || !config) {
    return { path: resolved, ok: false, reason: `未找到 DSpark 草稿模型或 config.json：${resolved}` };
  }
  if (!architectures.some((name) => /DSparkDraftModel/i.test(name))) {
    return { path: resolved, ok: false, reason: `草稿模型不是 DSparkDraftModel：${resolved}` };
  }
  return { path: resolved, ok: true, reason: "" };
}

function selectedHostGpus(opts = {}) {
  const gpus = Array.isArray(opts.hostGpus) ? opts.hostGpus : [];
  const selectedIds = new Set(normalizeGpuIds(opts.gpuDeviceIds || []).map(String));
  if (!selectedIds.size) return gpus;
  return gpus.filter((gpu) => selectedIds.has(String(gpu.id)) || selectedIds.has(String(gpu.index)));
}

function hasSm12Gpu(opts = {}) {
  return selectedHostGpus(opts).some((gpu) => {
    const computeCap = String(gpu.computeCap || gpu.compute_cap || "").trim();
    const name = String(gpu.name || "").toLowerCase();
    return computeCap.startsWith("12") || (name.includes("blackwell") && /rtx\s+pro\s+[56]000/.test(name));
  });
}

function qwenMoeNvfp4BackendValue(opts = {}) {
  const configured = String(process.env.VLLM_QWEN_MOE_BACKEND || "").trim().toLowerCase();
  const allowed = new Set([
    "auto",
    "cutlass",
    "emulation",
    "flashinfer_b12x",
    "flashinfer_cutedsl",
    "flashinfer_cutlass",
    "flashinfer_trtllm",
    "marlin",
    "triton",
    "triton_unfused",
  ]);
  if (configured && allowed.has(configured)) return configured;
  return hasSm12Gpu(opts) ? "flashinfer_b12x" : "marlin";
}

function resolveVllmRuntimePreset(opts = {}, launch = {}) {
  const runtimeEngine = normalizeRuntimeEngine(opts.engine);
  const localConfig = readLocalModelConfig(launch.localPath);
  const requestedRuntimeImage = String(opts.runtimeImage || "").trim();
  const baseRuntimeImage = requestedRuntimeImage || (runtimeEngine === "sglang" ? CONFIG.sglangImage : CONFIG.image);
  if (runtimeEngine === "sglang" && isPennyroyalImage(requestedRuntimeImage)) {
    const preset = createPennyroyalPreset(opts);
    if (!isQwen38FlashNextNvfp4Model(opts.model || launch.modelArg, localConfig)) {
      preset.unsupportedReason = "Pennyroyal FR-Spec 预设仅支持 Qwen3.8 Flash-Next NVFP4。";
    }
    return preset;
  }
  const capabilities = resolveVllmModelCapabilities({
    model: opts.model || launch.modelArg,
    localPath: launch.localPath,
    config: localConfig || {},
    quantization: opts.quantization,
    speculativeMode: opts.speculativeMode,
    numSpeculativeTokens: opts.numSpeculativeTokens,
    runtimeMetadata: knownRuntimeImageMetadata(baseRuntimeImage),
    allowMuseGlimmer: envFlagEnabled(process.env.VLLM_ALLOW_MUSE_GLIMMER),
  });
  const withCapabilities = (preset = {}) => {
    const hasCapabilityPreset = Boolean(
      capabilities.speculativeConfig
      || capabilities.reasoningParser
      || capabilities.toolCallParser
      || capabilities.reasoningParserPlugin
      || capabilities.unsupportedReason
      || Object.keys(capabilities.env || {}).length
    );
    return {
      ...preset,
      id: preset.id || (hasCapabilityPreset ? `model-${capabilities.modelType || "capabilities"}` : ""),
      label: preset.label || (hasCapabilityPreset ? `${capabilities.architecture || capabilities.modelType || "Model"} capability profile` : ""),
      env: { ...(capabilities.env || {}), ...(preset.env || {}) },
      forceTrustRemoteCode: Boolean(preset.forceTrustRemoteCode || capabilities.forceTrustRemoteCode),
      reasoningParser: preset.reasoningParser || capabilities.reasoningParser,
      reasoningParserPlugin: preset.reasoningParserPlugin || capabilities.reasoningParserPlugin,
      toolCallParser: preset.toolCallParser || capabilities.toolCallParser,
      enableAutoToolChoice: Boolean(preset.enableAutoToolChoice || capabilities.enableAutoToolChoice),
      speculativeConfig: preset.speculativeConfig || capabilities.speculativeConfig,
      unsupportedReason: preset.unsupportedReason || capabilities.unsupportedReason,
      notes: [...(preset.notes || []), ...(capabilities.notes || [])],
      capabilities,
    };
  };
  if (runtimeEngine === "sglang") {
    const sglangSpeculativeMode = normalizeSpeculativeMode(opts.speculativeMode);
    const dspark = sglangSpeculativeMode === "dspark";
    const draft = dspark ? resolveDsparkDraftModel(opts.draftModel) : { path: "", ok: true, reason: "" };
    const qwen38 = isQwen38Model(opts.model || launch.modelArg, localConfig);
    const flashNextNvfp4 = isQwen38FlashNextNvfp4Model(opts.model || launch.modelArg, localConfig);
    const image = requestedRuntimeImage || (flashNextNvfp4 ? CONFIG.sglangFlashNextImage : baseRuntimeImage);
    const maxMambaCacheSize = positiveInt(opts.sglangMaxMambaCacheSize, flashNextNvfp4 ? 8 : 0);
    const requestedMaxRunningRequests = positiveInt(opts.maxNumSeqs, 1);
    const effectiveMaxRunningRequests = flashNextNvfp4
      ? Math.min(requestedMaxRunningRequests, Math.max(1, Math.floor(maxMambaCacheSize / 5)))
      : requestedMaxRunningRequests;
    return withCapabilities({
      id: flashNextNvfp4 ? "qwen3.8-flash-next-sglang-sm120" : dspark ? "qwen3.8-sglang-dspark" : "sglang-openai-runtime",
      label: flashNextNvfp4 ? "Qwen3.8 Flash-Next / SGLang / SM120" : dspark ? "Qwen3.8 / SGLang / DSpark" : "SGLang OpenAI runtime",
      engine: "sglang",
      image,
      quantization: flashNextNvfp4 ? "modelopt_fp4" : "",
      forceTrustRemoteCode: qwen38,
      attentionBackend: String(opts.sglangAttentionBackend || (flashNextNvfp4 ? "triton" : qwen38 ? "flashinfer" : "")),
      reasoningParser: qwen38 ? "qwen3" : capabilities.reasoningParser,
      toolCallParser: qwen38 ? "qwen3_coder" : capabilities.toolCallParser,
      enableAutoToolChoice: Boolean(qwen38 || capabilities.enableAutoToolChoice),
      maxRunningRequests: effectiveMaxRunningRequests,
      effectiveMaxRunningRequests,
      maxTotalTokens: positiveInt(opts.sglangMaxTotalTokens, flashNextNvfp4 ? positiveInt(opts.maxModelLen, 262144) : 0),
      pageSize: positiveInt(opts.sglangPageSize, flashNextNvfp4 ? 64 : 0),
      chunkedPrefillSize: positiveInt(opts.sglangChunkedPrefillSize, flashNextNvfp4 ? 4096 : qwen38 ? 8192 : 8192),
      fp4GemmBackend: String(opts.sglangFp4GemmBackend || (flashNextNvfp4 ? "flashinfer_cutlass" : "")),
      pleOffloadEmbedding: Boolean(opts.sglangPleOffloadEmbedding || flashNextNvfp4),
      linearAttnPrefillBackend: String(opts.sglangLinearAttnPrefillBackend || (flashNextNvfp4 ? "triton" : "")),
      linearAttnDecodeBackend: String(opts.sglangLinearAttnDecodeBackend || (flashNextNvfp4 ? "flashinfer" : "")),
      mambaSsmDtype: String(opts.sglangMambaSsmDtype || (flashNextNvfp4 ? "bfloat16" : "")),
      mambaRadixCacheStrategy: String(opts.sglangMambaRadixCacheStrategy || (flashNextNvfp4 ? "extra_buffer" : "")),
      mambaTrackInterval: positiveInt(opts.sglangMambaTrackInterval, flashNextNvfp4 ? 64 : 0),
      maxMambaCacheSize,
      disableThinkingByDefault: Boolean(opts.sglangDisableThinkingByDefault),
      defaultChatTemplateKwargs: opts.sglangDisableThinkingByDefault
        ? JSON.stringify({ enable_thinking: false })
        : "",
      mambaSchedulerStrategy: qwen38 && !flashNextNvfp4 ? "extra_buffer" : "",
      disablePrefillCudaGraph: qwen38 && !flashNextNvfp4,
      mmFeatureTransport: qwen38 && !flashNextNvfp4 ? "cpu" : "",
      speculativeConfig: null,
      speculativeAlgorithm: dspark ? "DSPARK" : "",
      draftModel: draft.path,
      dsparkBlockSize: Math.min(32, Math.max(1, positiveInt(opts.dsparkBlockSize, 7))),
      draftModelQuantization: "unquant",
      unsupportedReason: flashNextNvfp4 && sglangSpeculativeMode !== "off"
        ? "Qwen3.8 Flash-Next 的已验证 262K SGLang 档当前要求关闭 MTP/DSpark。"
        : !["off", "dspark"].includes(sglangSpeculativeMode)
        ? `SGLang 档当前只开放 off 或 dspark，不会静默转换 ${sglangSpeculativeMode}。`
        : !qwen38 && dspark
        ? "当前 DSpark 档只对已验证的 Qwen3.8 主模型开放。"
        : draft.reason,
      notes: [
        ...(flashNextNvfp4 ? [
          "uses the Qwen3.8 Flash-Next day-0 image plus full SM120 QSA fix dac5523d",
          "keeps KV cache in BF16/auto; FP8 KV is intentionally blocked for the current QSA path",
          "offloads PLE embeddings to CPU RAM and uses Triton prefill plus FlashInfer decode for GDN",
          `uses Mamba cache ${maxMambaCacheSize}; effective max running requests is ${effectiveMaxRunningRequests}`,
        ] : ["uses SGLang 0.5.17 with the OpenAI-compatible API on container port 8000"]),
        ...(qwen38 && !flashNextNvfp4 ? ["uses FlashInfer on SM120; FA3 is not supported on this host", "uses CPU multimodal feature transport to avoid Docker Desktop/WSL CUDA IPC failures"] : []),
        ...(dspark ? ["uses the RadixArk Qwen3.8 DSpark draft checkpoint with block size 7 and overlap scheduling"] : []),
      ],
    });
  }
  if (normalizeSpeculativeMode(opts.speculativeMode) === "dspark") {
    return withCapabilities({
      id: "vllm-dspark-wsl-unsupported",
      label: "vLLM / DSpark",
      engine: "vllm",
      image: baseRuntimeImage,
      unsupportedReason: "本机的 RadixArk Qwen3.8 DSpark checkpoint 在 vLLM V2 runner 会因 WSL UVA 不可用失败，V1 又会按 DeepSeekV4 错误解析；请选择 SGLang + DSpark 档。",
      notes: [],
    });
  }
  if (isQwen38Model(opts.model || launch.modelArg, localConfig)) {
    const nvfp4 = isQwen38Nvfp4Model(opts.model || launch.modelArg, localConfig);
    return withCapabilities({
      id: nvfp4 ? "qwen3.8-vllm-nvfp4" : "qwen3.8-vllm-fp8",
      label: nvfp4 ? "Qwen3.8 / vLLM / NVFP4" : "Qwen3.8 / vLLM / FP8",
      engine: "vllm",
      image: baseRuntimeImage,
      positionalModel: true,
      reasoningParser: "qwen3",
      toolCallParser: "qwen3_coder",
      enableAutoToolChoice: true,
      disableQuantizationArg: nvfp4,
      disableKvCacheDtypeArg: nvfp4,
      safetensorsLoadStrategy: nvfp4 ? "prefetch" : "",
      notes: [
        `uses the Qwen3.8-compatible vLLM build ${DEFAULT_VLLM_RELEASE.version}`,
        "uses positional model syntax required by current vLLM serve CLI",
        "uses qwen3 reasoning and qwen3_coder tool parsing",
        ...(nvfp4 ? ["lets compressed-tensors auto-detect the NVFP4 layout and prefetches safetensors"] : ["keeps KV cache dtype auto for quality-first operation"]),
      ],
    });
  }
  if (isQwen36MoeNvfp4Model(opts.model || launch.modelArg, localConfig)) {
    const effectiveKvCacheDtype = !opts.kvCacheDtype || opts.kvCacheDtype === "auto" ? "fp8" : opts.kvCacheDtype;
    const moeBackend = qwenMoeNvfp4BackendValue(opts);
    return withCapabilities({
      id: "qwen3.6-moe-nvfp4",
      label: "Qwen3.6 MoE / NVFP4",
      image: CONFIG.qwenMoeImage,
      dtype: moeBackend === "flashinfer_b12x" ? "bfloat16" : undefined,
      forceTrustRemoteCode: true,
      attentionBackend: "flashinfer",
      moeBackend,
      generationConfig: "vllm",
      reasoningParser: "qwen3",
      toolCallParser: "qwen3_xml",
      enableAutoToolChoice: true,
      kvCacheDtype: effectiveKvCacheDtype,
      maxNumBatchedTokens: 8192,
      asyncScheduling: true,
      notes: [
        "uses vllm/vllm-openai:nightly because fixed release images can fail on Qwen3.6 ModelOpt NVFP4 weight layouts",
        "adds --trust-remote-code for the rapidly moving Qwen3.6 architecture support path",
        "adds --attention-backend flashinfer for the Qwen3.6 MoE path that previously validated locally",
        `uses --moe-backend ${moeBackend}${moeBackend === "flashinfer_b12x" ? " on SM12x Blackwell to avoid the Marlin NVFP4 output degeneration seen on this host" : ""}`,
        "uses --generation-config vllm because the checkpoint generation_config caused repeated ! output on this host",
        "uses FP8 KV cache for the Qwen3.6 MoE ModelOpt checkpoint unless the launch form explicitly selects another dtype",
        "adds --max-num-batched-tokens 8192 to satisfy Mamba cache align block sizing",
        "leaves thinking mode to request-level chat_template_kwargs from the client",
        "uses qwen3 reasoning parser and qwen3_xml tool parser from the NVIDIA launch guidance",
      ],
    });
  }
  if (isQwen36DenseNvfp4Model(opts.model || launch.modelArg, localConfig)) {
    return withCapabilities({
      id: "qwen3.6-dense-nvfp4",
      label: "Qwen3.6 Dense / NVFP4",
      image: CONFIG.qwenMoeImage,
      forceTrustRemoteCode: true,
      attentionBackend: "TRITON_ATTN",
      reasoningParser: "qwen3",
      toolCallParser: "qwen3_xml",
      enableAutoToolChoice: true,
      disableQuantizationArg: true,
      disableKvCacheDtypeArg: true,
      maxNumBatchedTokens: 8192,
      asyncScheduling: true,
      notes: [
        "uses vllm/vllm-openai:nightly because fixed release images can fail on Qwen3.6 ModelOpt NVFP4 weight layouts",
        "adds --trust-remote-code for the rapidly moving Qwen3.6 architecture support path",
        "lets vLLM auto-detect ModelOpt mixed quantization and KV cache dtype from the dense checkpoint",
        "uses --attention-backend TRITON_ATTN because FlashInfer can crash or degenerate with the dense Qwen3.6 NVFP4 FP8 KV prefill path",
        "adds --max-num-batched-tokens 8192 to satisfy Mamba cache align block sizing",
        "leaves thinking mode to request-level chat_template_kwargs from the client",
        "uses qwen3 reasoning parser and qwen3_xml tool parser from the NVIDIA launch guidance",
      ],
    });
  }
  if (!isDiffusionGemmaModel(opts.model || launch.modelArg, localConfig)) return withCapabilities({ id: "", env: {} });
  const effectiveKvCacheDtype = !opts.kvCacheDtype || opts.kvCacheDtype === "auto" ? "fp8" : opts.kvCacheDtype;
  const gemmaModelRunner = gemmaModelRunnerEnvValue();
  const gemmaMaxNewTokens = gemmaMaxNewTokensValue();
  const unsupportedReason = diffusionGemmaWindowsBlockReason();
  return withCapabilities({
    id: "diffusion-gemma",
    label: "DiffusionGemma / Gemma4",
    image: CONFIG.gemmaImage,
    unsupportedReason,
    env: { VLLM_USE_V2_MODEL_RUNNER: gemmaModelRunner },
    forceTrustRemoteCode: true,
    enforceEager: gemmaModelRunner === "0",
    attentionBackend: "TRITON_ATTN",
    reasoningParser: "gemma4",
    toolCallParser: "gemma4",
    enableAutoToolChoice: true,
    kvCacheDtype: effectiveKvCacheDtype,
    disablePrefixCaching: true,
    disableLanguageModelOnly: true,
    overrideGenerationConfig: JSON.stringify({ max_new_tokens: gemmaMaxNewTokens }),
    notes: [
      "uses vllm/vllm-openai:gemma-compatible runtime",
      `sets VLLM_USE_V2_MODEL_RUNNER=${gemmaModelRunner}${gemmaModelRunner === "0" ? " to avoid WSL UVA initialization failures" : ""}`,
      "adds --attention-backend TRITON_ATTN",
      ...(gemmaModelRunner === "0" ? ["adds --enforce-eager to avoid CUDA graph profiling assertion failures"] : []),
      `caps default generation to ${gemmaMaxNewTokens} tokens so clients that omit max_tokens do not request the full context window`,
      "leaves thinking mode to request-level chat_template_kwargs from the client",
      "uses gemma4 reasoning/tool parsers",
      ...(unsupportedReason ? [`blocked on this host: ${unsupportedReason}`] : []),
    ],
  });
}

function gemmaMaxNewTokensValue() {
  const configured = Number(process.env.VLLM_GEMMA_MAX_NEW_TOKENS || 0);
  if (Number.isFinite(configured) && configured >= 128) return Math.floor(configured);
  return 4096;
}

function gemmaModelRunnerEnvValue() {
  const configured = String(process.env.VLLM_GEMMA_USE_V2_MODEL_RUNNER || "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "v2"].includes(configured)) return "1";
  if (["0", "false", "no", "off", "v1"].includes(configured)) return "0";
  // Docker Desktop on Windows runs Linux containers through WSL2. vLLM disables
  // pinned memory there, so V2 Model Runner's UVA buffers fail during init.
  return process.platform === "win32" ? "0" : "1";
}

function envFlagEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function diffusionGemmaWindowsBlockReason(platform = process.platform, env = process.env) {
  if (platform !== "win32" || envFlagEnabled(env.VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA)) return "";
  return "DiffusionGemma NVFP4 在 Windows Docker/WSL 下当前不可稳定运行：V2 runner 会因 UVA 不可用启动失败，V1 fallback 可加载但首个 chat 请求可能触发 CUDA device-side assert。请改用常规 Gemma-4/Qwen，或在原生 Linux 上运行；确认要自行承担风险时设置 VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA=1。";
}

function previewVllmRuntimePreset(opts = {}) {
  const launch = resolveLaunchModel(opts.model, opts.loadFormat);
  return resolveVllmRuntimePreset(opts, launch);
}

function effectiveLaunchQuantization(requested, launch) {
  const requestedQuantization = normalizeQuantization(requested);
  if (launch?.effectiveLoadFormat === "gguf") return { value: "", modelConfigMethod: "" };
  const modelConfigMethod = readLocalModelQuantizationMethod(launch?.localPath);
  if (modelConfigMethod) {
    return { value: modelConfigMethod, modelConfigMethod };
  }
  return { value: requestedQuantization, modelConfigMethod: "" };
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
      createdAt: info.CreatedAt || "",
      labels,
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
  if (owner && owner !== CONFIG.managerId) {
    const error = new Error(`Refusing to remove ${targetContainerName}; it belongs to ${owner}.`);
    error.code = "CONTAINER_OWNED_BY_OTHER_MANAGER";
    error.status = 409;
    throw error;
  }
  const containerJobId = String(container.labels?.["ai.manager.job"] || "");
  const runtimeApiKeyRef = String(container.labels?.[MANAGER_APIKEY_REF_LABEL_KEY] || "");
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
  clearGatewayRuntimeCache();
  clearRuntimeInstancesCache();
  return { removed: true, containerName: targetContainerName, owner: owner || null, jobId: containerJobId || null, reason };
}

function getVllmApiKey(container) {
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

function vllmAuthHeaders(apiKey, base = {}) {
  return apiKey ? { ...base, authorization: `Bearer ${apiKey}` } : base;
}

function applyVllmRequestDefaults(body = {}, _runtime = null, model = "", context = {}) {
  if (context.upstreamPath && context.upstreamPath !== "chat/completions") return body;
  if (!/qwen3_(?:5|6|8)|qwen3\.(?:5|6|8)/i.test(String(model || body.model || ""))) return body;
  const next = { ...body };
  if (body.temperature === undefined || body.temperature === null || body.temperature === "") next.temperature = 1.0;
  if (body.top_p === undefined || body.top_p === null || body.top_p === "") next.top_p = 0.95;
  if (body.top_k === undefined || body.top_k === null || body.top_k === "") next.top_k = 20;
  return next;
}

async function getServedModels(port, apiKey = "") {
  return runtimeSnapshotCache.get(`served-models:${port}`, () => getServedModelsFresh(port, apiKey));
}

async function getServedModelsFresh(port, apiKey = "") {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(2500),
      headers: vllmAuthHeaders(apiKey),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.data) ? data.data : [];
  } catch {
    return [];
  }
}

async function getRuntimeVersion(port, apiKey = "", engine = "vllm", image = "") {
  return runtimeSnapshotCache.get(`runtime-version:${port}:${engine}`, () => getRuntimeVersionFresh(port, apiKey, engine, image), { ttlMs: 60_000 });
}

async function getRuntimeVersionFresh(port, apiKey = "", engine = "vllm", image = "") {
  const paths = engine === "sglang" ? ["/get_server_info", "/version"] : ["/version"];
  for (const endpointPath of paths) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
        signal: AbortSignal.timeout(2500),
        headers: vllmAuthHeaders(apiKey),
      });
      if (!response.ok) continue;
      const data = parseJsonSafe(await response.text(), {});
      const version = String(data.version || data.sglang_version || data.server_version || "").trim();
      if (version) return { engine, version, source: endpointPath };
    } catch {}
  }
  const metadata = knownRuntimeImageMetadata(image);
  return { engine, version: metadata?.version || "", source: metadata ? "image-metadata" : "" };
}

function clearGatewayRuntimeCache() {
  gatewayRuntimeCache = {
    value: null,
    expiresAt: 0,
    promise: null,
  };
}

async function getGatewayRunningModelSummary() {
  const now = Date.now();
  if (GATEWAY_RUNTIME_CACHE_MS > 0 && gatewayRuntimeCache.value) {
    if (gatewayRuntimeCache.expiresAt <= now && !gatewayRuntimeCache.promise) {
      getGatewayRunningModelSummaryFresh().catch(() => {});
    }
    return gatewayRuntimeCache.value;
  }
  if (gatewayRuntimeCache.promise) return gatewayRuntimeCache.promise;
  return getGatewayRunningModelSummaryFresh();
}

function getGatewayRunningModelSummaryFresh() {
  gatewayRuntimeCache.promise = getRunningModelSummary(null, null, { includeMetrics: false })
    .then((summary) => {
      gatewayRuntimeCache.value = summary;
      gatewayRuntimeCache.expiresAt = Date.now() + GATEWAY_RUNTIME_CACHE_MS;
      return summary;
    })
    .finally(() => {
      gatewayRuntimeCache.promise = null;
    });
  return gatewayRuntimeCache.promise;
}

async function getRunningModelSummary(container = null, gpu = null, options = {}) {
  const activeContainer = container || await getContainerStatus(CONFIG.containerName);
  const runtimeEngine = normalizeRuntimeEngine(activeContainer.labels?.[MANAGER_ENGINE_LABEL_KEY]);
  const endpoint = getContainerEndpoint(activeContainer);
  const vllmApiKey = getVllmApiKey(activeContainer);
  const [servedModels, runtimeVersion] = activeContainer.running
    ? await Promise.all([
      getServedModels(endpoint.port, vllmApiKey),
      getRuntimeVersion(endpoint.port, vllmApiKey, runtimeEngine, activeContainer.image),
    ])
    : [[], { engine: runtimeEngine, version: "", source: "" }];
  const includeMetrics = options.includeMetrics !== false;
  const runtimeStats = activeContainer.running && includeMetrics
    ? await collectVllmMetricsSummary(activeContainer, gpu, { updateSamples: false }).catch(() => null)
    : null;
  const gpuText = gpu?.ok
    ? `${gpu.usedMb}/${gpu.totalMb} MB (${gpu.util}%)`
    : "";
  const models = servedModels.map((model) => {
    const createdSeconds = Number(model.created);
    const modelStats = runtimeStats?.modelsByName?.[model.id] || null;
    return {
      id: model.id,
      object: model.object || "model",
      created: model.created || null,
      createdAt: Number.isFinite(createdSeconds) ? new Date(createdSeconds * 1000).toISOString() : null,
      ownedBy: model.owned_by || model.ownedBy || "",
      root: model.root || "",
      parent: model.parent || "",
      maxModelLen: model.max_model_len || model.maxModelLen || null,
      containerName: activeContainer.name || CONFIG.containerName,
      containerStatus: activeContainer.status || "",
      image: activeContainer.image || "",
      engine: runtimeEngine,
      runtimeVersion: runtimeVersion.version || "",
      apiBaseUrl: endpoint.serviceUrl,
      localApiBaseUrl: endpoint.localUrl,
      port: endpoint.port,
      gpu: gpuText,
      contextUsedTokens: modelStats?.context?.activeTokens || 0,
      contextCapacityTokens: modelStats?.context?.capacityTokens || null,
      contextUsagePercent: modelStats?.context?.kvUsagePercent || 0,
      requests: modelStats?.requests?.total || 0,
      promptTokens: modelStats?.tokens?.prompt || 0,
      outputTokens: modelStats?.tokens?.generation || 0,
      // 启动以来按「活跃时间」的平均输出速度：累计生成 token ÷ 实际生成耗时
      // = 1 / 平均每输出 token 耗时（来自 vLLM 直方图，覆盖整个启动周期，不含空闲）。
      lifetimeOutputTokensPerSecond: modelStats?.speed?.averageOutputTokensPerSecond || 0,
      // 推导出的活跃生成时长（秒）：累计生成 token × 平均每 token 耗时
      activeSeconds: (modelStats?.tokens?.generation || 0) > 0 && (modelStats?.latency?.avgTimePerOutputTokenSeconds || 0) > 0
        ? modelStats.tokens.generation * modelStats.latency.avgTimePerOutputTokenSeconds
        : 0,
      recentOutputTokensPerSecond: modelStats?.speed?.recentOutputTokensPerSecond || 0,
      runningRequests: modelStats?.requests?.running || 0,
      waitingRequests: modelStats?.requests?.waiting || 0,
      canUnload: activeContainer.exists,
    };
  });

  return {
    container: activeContainer,
    engine: runtimeEngine,
    runtimeVersion,
    endpoint,
    servedModels,
    models,
    vllmApiKey,
    apiKeyRequired: Boolean(vllmApiKey),
    canUnload: activeContainer.exists,
    unloadStopsContainer: true,
    note: `${runtimeEngine === "sglang" ? "SGLang" : "vLLM"} keeps the model resident in the server process. Unloading stops only the managed runtime container.`,
  };
}

function clearRuntimeInstancesCache() {
  runtimeInstancesCache = { value: null, expiresAt: 0, promise: null };
}

async function getRunningModelSummaries() {
  const now = Date.now();
  if (runtimeInstancesCache.value && runtimeInstancesCache.expiresAt > now) return runtimeInstancesCache.value;
  if (runtimeInstancesCache.promise) return runtimeInstancesCache.promise;
  runtimeInstancesCache.promise = Promise.resolve().then(async () => {
    const managed = (await listManagedContainers()).filter((container) => (
      container.manager === CONFIG.managerId && ["vllm", "sglang"].includes(container.engine)
    ));
    const primary = await getContainerStatus(CONFIG.containerName);
    const primaryOwner = primary.labels?.[MANAGER_LABEL_KEY] || "";
    if (primary.exists && (!primaryOwner || primaryOwner === CONFIG.managerId) && !managed.some((item) => item.name === CONFIG.containerName)) {
      managed.unshift(primary);
    }
    const summaries = await Promise.all(managed.map(async (container) => {
      const status = await getContainerStatus(container.name);
      // 携带负载指标（running/waiting），统一网关据此做负载感知路由；
      // metrics 摘要本身有 2 秒快照缓存，代价可控。
      return getRunningModelSummary(status, null, { includeMetrics: true });
    }));
    summaries.sort((a, b) => Number(b.container?.name === CONFIG.containerName) - Number(a.container?.name === CONFIG.containerName));
    runtimeInstancesCache.value = summaries;
    runtimeInstancesCache.expiresAt = Date.now() + GATEWAY_RUNTIME_CACHE_MS;
    return summaries;
  }).finally(() => {
    runtimeInstancesCache.promise = null;
  });
  return runtimeInstancesCache.promise;
}

async function listRuntimeInstancesRequest() {
  const summaries = await getRunningModelSummaries();
  return {
    ok: true,
    primaryContainer: CONFIG.containerName,
    supportsParallel: true,
    instances: summaries.map((runtime) => {
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
        id: primary ? "primary" : labels["ai.manager.instance"] || container.name,
        instanceMode: primary ? "replace" : labels["ai.manager.instance-mode"] || "parallel",
        primary,
        containerName: container.name,
        running: Boolean(container.running),
        status: container.status || "",
        image: container.image || "",
        engine: normalizeRuntimeEngine(labels[MANAGER_ENGINE_LABEL_KEY]),
        port: runtime.endpoint?.port || Number(labels["ai.manager.port"] || 0),
        gpuIds: normalizeGpuIds(labels["ai.manager.gpu-ids"] || ""),
        vramReservationMb: Number(labels["ai.manager.vram-reservation-mb"] || 0),
        gpuMemoryUtilization: Number(labels["ai.manager.gpu-memory-utilization"] || 0),
        maxNumBatchedTokens: Number(labels["ai.manager.max-num-batched-tokens"] || 0),
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
    }),
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
    container.manager === CONFIG.managerId && ["vllm", "sglang"].includes(container.engine)
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
  clearGatewayRuntimeCache();
  clearRuntimeInstancesCache();
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
    claudeModelAlias: CLAUDE_SETUP_ALIASES[0]?.name || CLAUDE_MODEL_ALIASES[0] || "",
  });
}

async function setupClaudeBridge() {
  const runtime = await getRunningModelSummary();
  if (!runtime.container.running) {
    throw new Error("vLLM service is not running. Start a model before configuring Claude.");
  }
  const config = await buildClaudeBridgeConfig(runtime);
  const profile = await writeClaudeDesktopProfile(config);
  const ccSwitch = await ccSwitchTools.configureCcSwitchProvider(config).catch((error) => ({
    ok: false,
    error: error.message,
    dbPath: ccSwitchTools.getCcSwitchDbPath(),
  }));
  const ccSwitchHealth = await ccSwitchTools.getCcSwitchHealth();
  return {
    ok: true,
    actualModel: config.actualModel,
    modelAlias: config.modelAlias,
    aliases: config.aliases.map((item) => item.name),
    claude: {
      baseUrl: config.baseUrl,
      messagesUrl: config.messagesUrl,
      modelsUrl: config.modelsUrl,
      auth: "Bearer token configured locally",
    },
    claudeDesktopProfile: profile,
    ccSwitch,
    ccSwitchHealth,
    note: "Use the model alias in Claude Desktop/ccswitch; the manager bridge maps it to the currently served vLLM model.",
  };
}

async function buildClaudeBridgeConfig(runtime) {
  const endpoint = runtime.endpoint || {};
  const port = endpoint.port || CONFIG.defaultPort;
  const compat = endpoint.compat?.claude || getCompatibilityEndpoints(port, endpoint.boundHost || "127.0.0.1", endpoint.host || "127.0.0.1").claude;
  const served = getServedModelIds(runtime);
  const actualModel = served[0] || "";
  if (!actualModel) throw new Error("No served model was reported by vLLM.");
  const aliases = CLAUDE_SETUP_ALIASES.filter((item) => CLAUDE_MODEL_ALIASES.includes(item.name));
  if (!aliases.length && CLAUDE_MODEL_ALIASES[0]) aliases.push({ name: CLAUDE_MODEL_ALIASES[0], labelOverride: "local" });
  const apiKey = process.env.AI_CLAUDE_GATEWAY_API_KEY || await readClaudeProfileApiKey() || "local-vllm";
  return {
    actualModel,
    modelAlias: aliases[0]?.name || actualModel,
    aliases,
    rootAliases: getServedModelRootMappings(runtime).map((entry) => entry.root),
    baseUrl: compat.baseUrl,
    messagesUrl: compat.messagesUrl,
    modelsUrl: compat.modelsUrl,
    apiKey,
  };
}

async function readClaudeProfileApiKey() {
  try {
    const profilePath = path.join(CONFIG.claude3pConfigDir, `${CLAUDE_PROFILE_ID}.json`);
    const profile = parseJsonSafe(await fsp.readFile(profilePath, "utf8"), {});
    return String(profile.inferenceGatewayApiKey || "").trim();
  } catch {
    return "";
  }
}

async function writeClaudeDesktopProfile(config) {
  await fsp.mkdir(CONFIG.claude3pConfigDir, { recursive: true });
  const profilePath = path.join(CONFIG.claude3pConfigDir, `${CLAUDE_PROFILE_ID}.json`);
  const metaPath = path.join(CONFIG.claude3pConfigDir, "_meta.json");
  const profile = {
    disableDeploymentModeChooser: true,
    inferenceGatewayApiKey: config.apiKey,
    inferenceGatewayAuthScheme: "bearer",
    inferenceGatewayBaseUrl: config.baseUrl,
    inferenceModels: config.aliases.map((item) => ({
      labelOverride: item.labelOverride,
      name: item.name,
    })),
    inferenceProvider: "gateway",
  };
  await fsp.writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  await fsp.writeFile(metaPath, `${JSON.stringify({
    appliedId: CLAUDE_PROFILE_ID,
    entries: [{ id: CLAUDE_PROFILE_ID, name: "CC Switch" }],
  }, null, 2)}\n`, "utf8");
  return { ok: true, profilePath, metaPath };
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
  const liveSummary = await collectVllmMetricsSummary(container, gpu, { updateSamples: true });
  const ledger = await updateStatsLedger(liveSummary);
  const merged = core.mergeLiveAndStatsLedgerInactive(liveSummary, ledger);
  const summary = { ...merged, totals: withSpeedWindowSeconds(merged.totals, merged.models) };
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
    live: liveSummary,
    historical: core.statsLedgerToSummary(ledger),
    clientUsage,
    recentAccess,
    costComparison,
  };
  await metricsHistoryStore.recordMetricsHistory(response, {
    engine: normalizeRuntimeEngine(container.labels?.[MANAGER_ENGINE_LABEL_KEY]),
  }).catch(() => {});
  response.trends = await metricsHistoryStore.getMetricsHistory({
    hours: 24,
    engine: response.live?.engine || "",
  }).catch(() => ({ hours: 24, samples: [] }));
  return response;
}

async function snapshotCurrentStats(reason = "snapshot") {
  const [gpu, container] = await Promise.all([
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
  ]);
  if (!container?.running) return null;
  const summary = await collectVllmMetricsSummary(container, gpu, { updateSamples: false });
  const ledger = await updateStatsLedger(summary, reason);
  return ledger;
}

async function collectVllmMetricsSummary(container, gpu, options = {}) {
  // updateSamples 会推进速度采样窗口，必须每次真实执行；只缓存只读快照。
  if (options.updateSamples) return collectVllmMetricsSummaryFresh(container, gpu, options);
  const cacheKey = `metrics-summary:${container?.name || container?.id || "none"}:${container?.running ? 1 : 0}`;
  return runtimeSnapshotCache.get(cacheKey, () => collectVllmMetricsSummaryFresh(container, gpu, options));
}

async function collectVllmMetricsSummaryFresh(container, gpu, options = {}) {
  const runtimeEngine = normalizeRuntimeEngine(container?.labels?.[MANAGER_ENGINE_LABEL_KEY]);
  const endpoint = getContainerEndpoint(container);
  const vllmApiKey = getVllmApiKey(container);
  const empty = core.emptyStatsSummary(container, endpoint, {
    stoppedNote: "vLLM container is not running.",
    missingNote: "No managed vLLM container is running.",
  });
  if (!container?.running) return empty;

  let metricsText = "";
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/metrics`, {
      signal: AbortSignal.timeout(4000),
      headers: vllmAuthHeaders(vllmApiKey),
    });
    if (!response.ok) throw new Error(`metrics returned ${response.status}`);
    metricsText = await response.text();
  } catch (error) {
    return { ...empty, error: error.message };
  }

  const [servedModels, runtimeVersion] = await Promise.all([
    getServedModels(endpoint.port, vllmApiKey).catch(() => []),
    getRuntimeVersion(endpoint.port, vllmApiKey, runtimeEngine, container.image).catch(() => ({ engine: runtimeEngine, version: "", source: "" })),
  ]);
  const factModelHints = Array.from(new Set(servedModels
    .flatMap((model) => [model.id, model.root])
    .filter(Boolean)));
  const persistedFacts = runtimeEngine === "sglang"
    ? {}
    : await getPersistedRuntimeFacts(factModelHints, { engine: runtimeEngine }).catch(() => ({}));
  // Facts come from this container's logs and its own serve jobs (08 P0-3).
  let facts = core.mergeRuntimeFacts(persistedFacts, await getLatestRuntimeFacts(factModelHints, {
    containerName: container.name,
  }).catch(() => ({})));
  if (!facts.kvCacheTokens && !facts.maxConcurrency) {
    facts = core.mergeRuntimeFacts(facts, await getLatestRuntimeFacts(factModelHints, {
      containerName: container.name,
      tail: process.env.VLLM_RUNTIME_FACT_LOG_TAIL || "20000",
    }).catch(() => ({})));
  }
  const servedById = Object.fromEntries(servedModels.map((model) => [model.id, model]));
  const metrics = parsePrometheusMetrics(metricsText);
  if (runtimeEngine === "sglang") {
    const sglangFacts = buildSglangRuntimeFacts(metrics, servedModels, container?.labels || {});
    facts = {
      ...core.mergeRuntimeFacts({}, sglangFacts),
      runtimeConfig: sglangFacts.runtimeConfig,
    };
  }
  const prometheusProcessStartSeconds = firstMetricValue(metrics, "process_start_time_seconds") || null;
  const containerProcessStartSeconds = parseDockerCreatedAtSeconds(container?.createdAt);
  const processStartSeconds = prometheusProcessStartSeconds || containerProcessStartSeconds || null;
  const processStartSource = prometheusProcessStartSeconds
    ? "prometheus"
    : containerProcessStartSeconds
      ? "container_created_at"
      : "unavailable";
  const nowSeconds = Date.now() / 1000;
  const uptimeSeconds = processStartSeconds ? Math.max(0, nowSeconds - processStartSeconds) : null;
  const models = buildModelStats(metrics, servedById, facts, nowSeconds, {
    ...options,
    engine: runtimeEngine,
    runtimeVersion: runtimeVersion.version || "",
    speculativeMode: facts.runtimeConfig?.speculativeMode,
  });
  const totals = withSpeedWindowSeconds(aggregateStats(models, uptimeSeconds), models);
  const modelsByName = Object.fromEntries(models.map((model) => [model.name, model]));

  return {
    engine: runtimeEngine,
    runtimeVersion,
    runtimeId: [runtimeEngine, container?.id || container?.name || "runtime", processStartSeconds || "unknown"].join(":"),
    source: `http://127.0.0.1:${endpoint.port}/metrics`,
    processStartSeconds,
    processStartSource,
    uptimeSeconds,
    facts,
    totals,
    models,
    modelsByName,
    gpu,
    rawMetricCount: metrics.length,
  };
}

function buildClientUsageSummary(totals, ledger) {
  return buildCoreClientUsageSummary(totals, ledger, {
    claude: {
      id: "claude",
      label: "Claude 兼容桥",
      description: "经管理器 /claude/v1/messages 进入本地 vLLM 的 Claude Desktop / Claude Code / Cowork 请求。",
    },
    other: {
      id: "chat",
      label: "聊天 / 直连 OpenAI",
      description: "OpenWebUI、API Docs 测试页或其他直接访问 vLLM /v1 的请求。这里按 vLLM 总量减去 Claude 桥接量估算。",
    },
    note: "Claude 只统计通过管理器 Claude 兼容桥的请求；OpenWebUI 或直接访问 vLLM /v1 的请求会归入聊天/直连。",
  });
}

function buildModelStats(metrics, servedById, facts, nowSeconds, options = {}) {
  const names = new Set(metrics.map((metric) => metric.labels.model_name).filter(Boolean));
  for (const name of Object.keys(servedById || {})) names.add(name);
  const models = [];
  for (const name of names) {
    const onlyServedModel = Object.keys(servedById || {}).length === 1;
    const scoped = metrics.filter((metric) => metric.labels.model_name === name || (onlyServedModel && !metric.labels.model_name));
    const promptTokens = firstNonZeroMetricSum(scoped, ["vllm:prompt_tokens_total", "sglang:prompt_tokens_total"]);
    const generationTokens = firstNonZeroMetricSum(scoped, ["vllm:generation_tokens_total", "sglang:generation_tokens_total"]);
    const cachedPromptTokens = firstNonZeroMetricSum(scoped, ["vllm:prompt_tokens_cached_total", "sglang:cached_tokens_total"]);
    const hasSglangMetrics = scoped.some((metric) => metric.name.startsWith("sglang:"));
    const successByReason = sumByLabel(scoped, "vllm:request_success_total", "finished_reason");
    const requestCount = Object.values(successByReason).reduce((sum, value) => sum + value, 0)
      || firstNonZeroMetricSum(scoped, ["vllm:request_prompt_tokens_count", "sglang:num_requests_total"]);
    const errorCount = Number(successByReason.error || 0);
    const abortedCount = Number(successByReason.abort || 0)
      || firstNonZeroMetricSum(scoped, ["sglang:num_aborted_requests_total"]);
    // New SGLang token_usage is max(KV, SWA, Mamba), not KV occupancy.
    // A genuine zero full-token usage must not fall back to nonzero Mamba use.
    const fullKvUsage = scoped.find(metric => metric.name === "sglang:full_token_usage");
    const kvUsagePercent = hasSglangMetrics && fullKvUsage
      ? Number(fullKvUsage.value || 0)
      : firstMetricValue(scoped, "vllm:kv_cache_usage_perc") || firstMetricValue(scoped, "sglang:token_usage") || 0;
    const derivedCapacityTokens = deriveKvCapacityTokens(scoped, servedById?.[name], facts);
    const capacityTokens = hasSglangMetrics
      ? derivedCapacityTokens || facts.kvCacheTokens
      : facts.kvCacheTokens || derivedCapacityTokens;
    const activeTokens = capacityTokens ? Math.round(capacityTokens * kvUsagePercent) : null;
    const promptBySource = sumByLabel(scoped, "vllm:prompt_tokens_by_source_total", "source");
    const nativePrefixQueries = firstNonZeroMetricSum(scoped, ["vllm:prefix_cache_queries_total"]);
    const nativePrefixHits = firstNonZeroMetricSum(scoped, ["vllm:prefix_cache_hits_total"]);
    const prefixQueries = nativePrefixQueries || (hasSglangMetrics ? promptTokens : 0);
    const prefixHits = nativePrefixQueries ? nativePrefixHits : (hasSglangMetrics ? cachedPromptTokens : 0);
    const directPrefixHitRate = firstMetricValue(scoped, "sglang:cache_hit_rate") || 0;
    const speculativeDraftCycles = firstNonZeroMetricSum(scoped, [
      "vllm:spec_decode_num_drafts_total",
      "vllm:spec_decode_num_drafts",
      "sglang:spec_verify_calls_total",
    ]);
    const speculativeDraftTokens = firstNonZeroMetricSum(scoped, [
      "vllm:spec_decode_num_draft_tokens_total",
      "vllm:spec_decode_draft_tokens_total",
    ]);
    const speculativeAcceptedTokens = firstNonZeroMetricSum(scoped, [
      "vllm:spec_decode_num_accepted_tokens_total",
      "vllm:spec_decode_num_accepted_tokens",
      "vllm:spec_decode_accepted_tokens_total",
    ]);
    const sglangSpecAcceptRate = firstMetricValue(scoped, "sglang:spec_accept_rate") || 0;
    const sglangSpecAcceptLength = firstMetricValue(scoped, "sglang:spec_accept_length") || 0;
    const sglangSpecCapLength = firstMetricValue(scoped, "sglang:spec_cap_length") || 0;
    const sglangSpecBlockAcceptLength = firstMetricValue(scoped, "sglang:spec_block_accept_length") || 0;
    const sglangSpecNumSteps = firstMetricValue(scoped, "sglang:spec_num_steps") || 0;
    const sglangSpecNumDraftTokens = firstMetricValue(scoped, "sglang:spec_num_draft_tokens") || 0;
    const cacheInfo = scoped.find((metric) => metric.name === "vllm:cache_config_info");
    const mambaBlockSize = positiveInt(cacheInfo?.labels?.mamba_block_size, 0);
    const attentionBlockSize = positiveInt(cacheInfo?.labels?.block_size, 0);
    const recent = core.calculateRecentRates(statsSamples, `${options.engine || "runtime"}:${name}`, nowSeconds, {
      promptTokens,
      generationTokens,
      requestCount,
    }, options.updateSamples !== false);
    const avgE2eSeconds = firstNonZeroHistogramAverage(scoped, ["vllm:e2e_request_latency_seconds", "sglang:e2e_request_latency_seconds"]);
    const avgTtftSeconds = firstNonZeroHistogramAverage(scoped, ["vllm:time_to_first_token_seconds", "sglang:time_to_first_token_seconds"]);
    const avgInterTokenSeconds = firstNonZeroHistogramAverage(scoped, ["vllm:inter_token_latency_seconds", "sglang:inter_token_latency_seconds"]);
    const avgTimePerOutputTokenSeconds = firstNonZeroHistogramAverage(scoped, ["vllm:request_time_per_output_token_seconds", "sglang:request_time_per_output_token_seconds"]);
    const sglangActiveAverage = tokensPerSecondFromSeconds(avgTimePerOutputTokenSeconds || avgInterTokenSeconds);
    const resolvedSglangThroughput = hasSglangMetrics
      ? resolveSglangOutputSpeed({
        gauge: firstMetricValue(scoped, "sglang:gen_throughput") || 0,
        running: firstMetricValue(scoped, "sglang:num_running_reqs") || 0,
        hasGenerationCounter: scoped.some((metric) => metric.name === "sglang:generation_tokens_total"),
        windowRate: recent.recentOutputTokensPerSecond,
        nowSeconds,
      })
      : null;
    const speculativeMode = hasSglangMetrics
      ? (sglangSpecAcceptLength > 0 || sglangSpecNumDraftTokens > 0
        ? String(options.speculativeMode || "nextn").trim().toLowerCase()
        : "off")
      : speculativeDraftTokens > 0 || speculativeDraftCycles > 0
        ? "mtp"
        : "off";

    models.push({
      name,
      engine: options.engine || (hasSglangMetrics ? "sglang" : "vllm"),
      runtimeVersion: String(options.runtimeVersion || ""),
      root: servedById?.[name]?.root || "",
      maxModelLen: servedById?.[name]?.max_model_len || null,
      tokens: {
        prompt: promptTokens,
        generation: generationTokens,
        cachedPrompt: cachedPromptTokens,
        total: promptTokens + generationTokens,
        promptBySource,
      },
      requests: {
        total: requestCount,
        success: requestCount - errorCount - abortedCount,
        error: errorCount,
        aborted: abortedCount,
        byFinishReason: successByReason,
        running: firstMetricValue(scoped, "vllm:num_requests_running") || firstMetricValue(scoped, "sglang:num_running_reqs") || 0,
        waiting: firstMetricValue(scoped, "vllm:num_requests_waiting") || firstMetricValue(scoped, "sglang:num_queue_reqs") || 0,
      },
      latency: {
        avgE2eSeconds,
        avgTtftSeconds,
        avgInterTokenSeconds,
        avgTimePerOutputTokenSeconds,
        avgQueueSeconds: firstNonZeroHistogramAverage(scoped, ["vllm:request_queue_time_seconds", "sglang:queue_time_seconds"]),
      },
      averages: {
        promptTokensPerRequest: firstNonZeroHistogramAverage(scoped, ["vllm:request_prompt_tokens", "sglang:prompt_tokens_histogram"]),
        outputTokensPerRequest: firstNonZeroHistogramAverage(scoped, ["vllm:request_generation_tokens", "sglang:generation_tokens_histogram"]),
        requestedMaxTokens: histogramAverage(scoped, "vllm:request_params_max_tokens"),
      },
      speed: {
        ...recent,
        windowSeconds: Number(recent.windowSeconds || 0),
        recentOutputTokensPerSecond: hasSglangMetrics
          ? resolvedSglangThroughput.value
          : recent.recentOutputTokensPerSecond,
        outputSource: hasSglangMetrics ? resolvedSglangThroughput.source : "counter_window",
        outputObservedAt: hasSglangMetrics ? resolvedSglangThroughput.observedAt : null,
        averageOutputTokensPerSecond: hasSglangMetrics
          ? sglangActiveAverage
          : tokensPerSecondFromSeconds(avgTimePerOutputTokenSeconds),
        lifetimeTokensPerSecond: null,
      },
      cache: {
        prefixQueries,
        prefixHits,
        prefixHitRate: prefixQueries ? prefixHits / prefixQueries : directPrefixHitRate,
        attentionBlockSize,
        mambaBlockSize,
        alignmentBlockSize: mambaBlockSize || attentionBlockSize || null,
        alignmentRequired: Boolean(mambaBlockSize),
        source: nativePrefixQueries ? "token_counters" : hasSglangMetrics && promptTokens ? "sglang_cached_token_counters" : directPrefixHitRate ? "sglang_latest_batch_gauge" : "unavailable",
      },
      speculative: {
        enabled: speculativeDraftTokens > 0 || speculativeDraftCycles > 0 || sglangSpecNumDraftTokens > 0 || sglangSpecAcceptLength > 0,
        mode: speculativeMode,
        draftCycles: speculativeDraftCycles,
        draftTokens: speculativeDraftTokens,
        acceptedTokens: speculativeAcceptedTokens,
        acceptanceRate: speculativeDraftTokens ? speculativeAcceptedTokens / speculativeDraftTokens : sglangSpecAcceptRate,
        acceptedTokensPerCycle: speculativeDraftCycles ? speculativeAcceptedTokens / speculativeDraftCycles : 0,
        draftTokensPerCycle: speculativeDraftCycles ? speculativeDraftTokens / speculativeDraftCycles : 0,
        meanAcceptLength: sglangSpecAcceptLength,
        capLength: sglangSpecCapLength,
        blockAcceptLength: sglangSpecBlockAcceptLength,
        configuredSteps: sglangSpecNumSteps,
        configuredDraftTokens: sglangSpecNumDraftTokens,
        source: hasSglangMetrics ? "sglang_gauges" : "vllm_counters",
      },
      context: {
        activeTokens,
        capacityTokens,
        kvUsagePercent,
        maxModelLen: servedById?.[name]?.max_model_len || null,
        concurrencyAtMaxLen: facts.maxConcurrency || null,
      },
    });
  }
  return models.sort((a, b) => b.tokens.total - a.tokens.total);
}

// SGLang output speed (08 P0-7). sglang:gen_throughput is a gauge the
// scheduler only updates while it decodes, so an idle engine keeps showing the
// last burst. The gauge counts only while requests run; otherwise the speed is
// the counter window, or 0 on a build that exports no generation counter.
function resolveSglangOutputSpeed({ gauge = 0, running = 0, hasGenerationCounter = false, windowRate = 0, nowSeconds = null } = {}) {
  const value = Math.max(0, Number(gauge || 0));
  if (Number(running || 0) > 0 && value > 0) {
    return { value, observedAt: nowSeconds, source: "sglang_gen_throughput_gauge" };
  }
  if (hasGenerationCounter) {
    return { value: Math.max(0, Number(windowRate || 0)), observedAt: null, source: "counter_window" };
  }
  return { value: 0, observedAt: null, source: "sglang_gen_throughput_gauge" };
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

function firstNonZeroMetricSum(metrics, names) {
  for (const name of names) {
    const value = sumMetric(metrics, name);
    if (value) return value;
  }
  return 0;
}

function firstNonZeroHistogramAverage(metrics, names) {
  for (const name of names) {
    const value = histogramAverage(metrics, name);
    if (value) return value;
  }
  return 0;
}

function deriveKvCapacityTokens(metrics, servedModel, facts) {
  const sglangCapacity = firstMetricValue(metrics, "sglang:max_total_num_tokens") || 0;
  if (sglangCapacity) return Math.round(sglangCapacity);
  if (facts.maxContextTokens && facts.maxConcurrency) {
    return Math.round(facts.maxContextTokens * facts.maxConcurrency);
  }
  const cacheInfo = metrics.find((metric) => metric.name === "vllm:cache_config_info");
  const hasMambaBlock = cacheInfo?.labels?.mamba_block_size && cacheInfo.labels.mamba_block_size !== "None";
  const blocks = Number(cacheInfo?.labels?.num_gpu_blocks || 0);
  const blockSize = Number(cacheInfo?.labels?.block_size || 0);
  if (!hasMambaBlock && blocks && blockSize) return blocks * blockSize;
  return null;
}

function buildSglangRuntimeFacts(metrics, servedModels = [], labels = {}) {
  const kvCacheTokens = firstMetricValue(metrics, "sglang:max_total_num_tokens") || null;
  const maxModelLen = Math.max(0, ...servedModels.map((model) => Number(model.max_model_len || 0))) || null;
  const startupMetrics = metrics.filter((metric) => metric.name === "sglang:startup_time_seconds");
  const phaseValue = (phase) => Number(startupMetrics.find((metric) => metric.labels?.phase === phase)?.value || 0) || null;
  const labelTokenCount = (name) => {
    const value = Number(labels[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  };
  const speculativeEnabled = firstMetricValue(metrics, "sglang:spec_num_draft_tokens") > 0
    || firstMetricValue(metrics, "sglang:spec_accept_length") > 0;
  const kvCacheDtype = String(labels["ai.runtime.kv-dtype"] || "").trim().toLowerCase();
  return {
    kvCacheTokens,
    maxContextTokens: maxModelLen,
    maxModelLen,
    maxConcurrency: kvCacheTokens && maxModelLen ? kvCacheTokens / maxModelLen : null,
    modelLoadSeconds: phaseValue("load_weight"),
    engineInitSeconds: phaseValue("scheduler_e2e") || phaseValue("tokenizer_e2e"),
    runtimeConfig: {
      kvCacheDtype,
      kvCacheQuantized: /^fp8/.test(kvCacheDtype),
      kvScaleMode: String(labels["ai.runtime.kv-scale"] || "").trim(),
      storageMode: String(labels["ai.runtime.storage"] || "").trim(),
      pleDtype: String(labels["ai.runtime.ple-dtype"] || "").trim().toLowerCase(),
      speculativeMode: String(labels["ai.runtime.speculative"] || (speculativeEnabled ? "nextn" : "off")).trim().toLowerCase(),
      thinkingMode: String(labels["ai.runtime.thinking"] || "").trim(),
      mambaDtype: String(labels["ai.runtime.mamba-dtype"] || "").trim(),
      linearAttention: String(labels["ai.runtime.linear-attn"] || "").trim(),
      cacheMode: String(labels["ai.runtime.cache"] || "").trim(),
      contextLength: labelTokenCount("ai.runtime.context-length") || maxModelLen,
      maxTotalTokens: labelTokenCount("ai.runtime.max-total-tokens") || kvCacheTokens,
      chunkedPrefillSize: labelTokenCount("ai.runtime.chunked-prefill"),
      fp4Backend: String(labels["ai.runtime.fp4-backend"] || "").trim(),
      moeBackend: String(labels["ai.runtime.moe-backend"] || "").trim(),
      validationState: String(labels["ai.runtime.validation"] || "").trim(),
      modelRevision: String(labels["ai.model-revision"] || "").trim(),
    },
  };
}

function parseDockerCreatedAtSeconds(value) {
  const normalized = String(value || "").trim().replace(/\s+[A-Z]{2,6}$/i, "");
  if (!normalized) return null;
  const parsedMs = Date.parse(normalized);
  return Number.isFinite(parsedMs) && parsedMs > 0 ? parsedMs / 1000 : null;
}

function getLatestRuntimeFacts(modelHints = [], options = {}) {
  const readRuntimeFacts = createLatestRuntimeFactsReader({
    docker,
    getJobs: () => jobs.values(),
    primaryContainerName: CONFIG.containerName,
  });
  return readRuntimeFacts(modelHints, options);
}

// Runtime facts of one container: its docker logs plus the logs of the serve
// jobs that launched it. Without containerName the primary container is read.
function createLatestRuntimeFactsReader({ docker: runDocker, getJobs, primaryContainerName }) {
  return async function readRuntimeFacts(modelHints = [], options = {}) {
    const containerName = String(options.containerName || primaryContainerName);
    const tail = String(options.tail || "2000");
    const out = await runDocker(["logs", "--tail", tail, containerName], {
      rejectOnError: false,
      maxBuffer: Number(options.maxBuffer || 32 * 1024 * 1024),
    });
    const needles = core.normalizeRuntimeFactHints(modelHints);
    const jobText = core.serveJobsForContainer(getJobs(), containerName, { primaryContainerName })
      .filter((job) => !needles.length || jobMatchesRuntimeFactHints(job, needles))
      .map((job) => (job.logs || []).join("\n"))
      .join("\n");
    return parseLatestRuntimeFactsText(`${jobText}\n${out.stdout || ""}${out.stderr || ""}`);
  };
}

function parseLatestRuntimeFactsText(text) {
  return {
    kvCacheTokens: lastIntegerMatch(text, /GPU KV cache size:\s*([\d,]+)\s*tokens/gi),
    maxContextTokens: lastIntegerMatch(text, /Maximum concurrency for\s*([\d,]+)\s*tokens per request/gi),
    maxConcurrency: lastFloatMatch(text, /Maximum concurrency for\s*[\d,]+\s*tokens per request:\s*([\d.]+)x/gi),
    modelLoadMemoryGiB: lastFloatMatch(text, /Model loading took\s*([\d.]+)\s*GiB memory/gi),
    modelLoadSeconds: lastFloatMatch(text, /Model loading took\s*[\d.]+\s*GiB memory and\s*([\d.]+)\s*seconds/gi),
    torchCompileSeconds: lastFloatMatch(text, /torch\.compile took\s*([\d.]+)\s*s/gi),
    warmupSeconds: lastFloatMatch(text, /Initial profiling\/warmup run took\s*([\d.]+)\s*s/gi),
    graphCaptureGiB: lastFloatMatch(text, /Graph capturing finished in\s*[\d.]+\s*secs,\s*took\s*([\d.]+)\s*GiB/gi),
    engineInitSeconds: lastFloatMatch(text, /init engine .* took\s*([\d.]+)\s*s/gi),
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

function createJob(type, title, meta = {}) {
  return jobsLedgerStore.createJob(type, title, meta);
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
  return jobsLedgerStore.failJob(job, error);
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
  cancelNonDownloadMessage: "任务已被用户取消",
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
    appendLog(job, `Download verification passed: ${verification.modelFormat}; ${verification.expectedWeightFiles || verification.safetensors || verification.gguf} weight file(s).`);
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
    const summary = await collectVllmMetricsSummary(container, null, { updateSamples: false }).catch(() => null);
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
    ? `显存粗评：权重约 ${formatBytes(sizeBytes)}，全部 GPU 合计空闲 ${freeGb.toFixed(1)} GB，可直接尝试启动（估算含 15% 运行余量，不含长上下文 KV）。`
    : `显存粗评：权重约 ${formatBytes(sizeBytes)}，全部 GPU 合计空闲 ${freeGb.toFixed(1)} GB，直接启动可能不够；可先卸载在跑模型、换更小量化，或在启动页做精确估算。`);
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
      const rawPercent = totalBytes ? (downloadedBytes / totalBytes) * 100 : null;
      // 运行中的进程永远不显示 100%；只有进程退出且完整性校验通过后 finishJob 才能置为 100%。
      const percent = rawPercent === null ? null : Math.min(99, rawPercent);
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

async function runStartJob(job, opts) {
  const queueKey = opts.instanceMode === "parallel" ? (opts.containerName || "parallel") : "replace";
  const { result, queued } = serializeServeJob(() => runStartJobOnce(job, opts), queueKey);
  if (queued) {
    appendLog(job, "已有启动任务进行中，排队等待其完成后再启动，避免容器名冲突。");
    setJobProgress(job, {
      percent: 1,
      stage: "等待前一个启动任务",
      detail: "已有启动任务正在进行，排队等待其完成后再启动，避免容器名冲突。",
    });
  }
  return result;
}

async function runStartJobOnce(job, opts) {
  // 排队期间任务可能已被用户取消（cancel -> failJob）。拿到锁后若已不在 running 态，直接放弃，
  // 避免给一个已取消的任务启动容器、再被 finishJob 复活。
  if (job.status !== "running") {
    appendLog(job, `任务已不再运行（status=${job.status}），跳过启动。`);
    return;
  }
  const compatibility = opts.modelCompatibility && typeof opts.modelCompatibility === "object"
    ? opts.modelCompatibility
    : await checkModelCompatibility({ ...opts, model: opts.model, remote: false });
  if (!compatibility.ok) {
    const issues = compatibility.findings.filter((item) => item.severity === "fail");
    const detail = issues.map((item) => `${item.title}: ${item.detail}`).join("；") || "模型文件或运行时不兼容";
    setJobProgress(job, {
      percent: 2,
      stage: "模型预检失败",
      detail,
      state: "fail",
      issues: issues.map((item) => item.detail),
    });
    const error = new Error(`模型启动前校验失败：${detail}`);
    error.code = issues.some((item) => /Muse Glimmer/i.test(`${item.title || ""} ${item.detail || ""}`))
      ? "muse_glimmer_vllm_unsupported"
      : "model_compatibility_failed";
    error.findings = compatibility.findings || [];
    throw error;
  }
  assertStartJobActive(job);
  setJobProgress(job, {
    percent: 3,
    stage: "检查 Docker",
    detail: "启动模型前先确认 Docker daemon 已经可用。",
  });
  let dockerReady = await checkDockerDaemon();
  if (!dockerReady.ok) {
    appendLog(job, dockerReady.raw || dockerReady.error);
    setJobProgress(job, {
      percent: 4,
      stage: `启动 ${CONFIG.dockerRuntimeName}`,
      detail: `Docker daemon 未就绪，正在自动启动 ${CONFIG.dockerRuntimeName} 并等待引擎可用。`,
    });
    appendLog(job, `Docker daemon is not ready; requesting ${CONFIG.dockerRuntimeName} startup.`);
    dockerReady = await ensureDockerDaemonRunning(120000);
  }
  if (!dockerReady.ok) {
    appendLog(job, dockerReady.raw || dockerReady.error);
    setJobProgress(job, {
      percent: 4,
      stage: "Docker 未就绪",
      detail: dockerReady.error,
      state: "fail",
      issues: [dockerReady.error],
    });
    throw new Error(dockerReady.error);
  }
  appendLog(job, dockerReady.alreadyRunning
    ? `Docker daemon ready: ${dockerReady.version}`
    : `${CONFIG.dockerRuntimeName} started; daemon ready: ${dockerReady.version}`);
  for (const warning of opts.gpuWarnings || []) appendLog(job, `GPU selection warning: ${warning}`);
  const gpuProbe = await getGpuStatus();
  if (!gpuProbe.ok) {
    appendLog(job, `GPU warning: 未检测到可用的 NVIDIA GPU（${gpuProbe.text || "nvidia-smi 不可用"}）。vLLM 官方镜像依赖 NVIDIA GPU，容器很可能启动失败。`);
  }
  let runtimeOpts = {
    ...opts,
    hostGpus: Array.isArray(gpuProbe.gpus) ? gpuProbe.gpus : [],
  };

  const runtimePreset = previewVllmRuntimePreset(runtimeOpts);
  const requestedEngine = normalizeRuntimeEngine(runtimePreset.engine || runtimeOpts.engine);
  const requestedEngineLabel = requestedEngine === "sglang" ? "SGLang" : "vLLM";
  if (runtimePreset.unsupportedReason) {
    appendLog(job, `Runtime preset blocked: ${runtimePreset.label || runtimePreset.id}`);
    appendLog(job, runtimePreset.unsupportedReason);
    setJobProgress(job, {
      percent: 8,
      stage: "当前环境不支持该模型",
      detail: runtimePreset.unsupportedReason,
      state: "fail",
      issues: [runtimePreset.unsupportedReason],
    });
    const error = new Error(runtimePreset.unsupportedReason);
    error.code = runtimePreset.capabilities?.unsupportedCode === "muse_glimmer"
      ? "muse_glimmer_vllm_unsupported"
      : "runtime_preset_unsupported";
    error.findings = [{
      severity: "fail",
      title: runtimePreset.label || "Runtime preset unsupported",
      detail: runtimePreset.unsupportedReason,
    }];
    throw error;
  }
  const runtimeImagePreview = runtimePreset.image || CONFIG.image;
  const gpuCompatibilityProbe = await probeNvidiaRuntimeCompatibility(execFileAsync);
  const runtimeCompatibility = assessVllmRuntimeCompatibility({
    probe: gpuCompatibilityProbe,
    selectedGpuIds: opts.gpuDeviceIds,
    imageReference: runtimeImagePreview,
    imageMetadata: knownRuntimeImageMetadata(runtimeImagePreview),
    hostPlatform: process.platform,
    hostArch: process.arch,
    allowAnyCompatibleGpu: opts.multiGpuMode === "single"
      && !opts.gpuSelectionExplicit
      && !opts.gpuAdmissionFinalized,
  });
  for (const item of runtimeCompatibility.findings) {
    appendLog(job, `Runtime compatibility [${item.severity}]: ${item.title}: ${item.detail}`);
  }
  if (!runtimeCompatibility.ok) {
    const issues = runtimeCompatibility.findings.filter((item) => item.severity === "fail").map((item) => item.detail);
    setJobProgress(job, {
      percent: 8,
      stage: `${requestedEngineLabel} 运行时不兼容`,
      detail: issues.join("；") || runtimeCompatibility.summary,
      state: "fail",
      issues,
    });
    const error = new Error(`${requestedEngineLabel} 运行时预检失败：${issues.join("；") || runtimeCompatibility.summary}`);
    error.code = "vllm_runtime_incompatible";
    error.findings = runtimeCompatibility.findings;
    throw error;
  }

  setJobProgress(job, {
    percent: 8,
    stage: "启动前预检",
    detail: "正在校验端口、模型档案并生成完整 Docker 命令；此阶段不会停止当前模型。",
  });
  const targetContainerName = opts.containerName || CONFIG.containerName;
  const portStatus = await checkPortAvailability(opts.port, targetContainerName).catch(() => null);
  if (portStatus && !portStatus.available && !portStatus.isOwnContainer) {
    appendLog(job, `Port check failed: ${portStatus.detail}`);
    setJobProgress(job, {
      percent: 18,
      stage: "端口被占用",
      detail: `${portStatus.detail} 请换一个端口或先停止占用方。`,
      state: "fail",
      issues: [portStatus.detail],
    });
    throw new Error(`端口 ${opts.port} 不可用：${portStatus.detail}`);
  }

  let { runArgs, activePublishArgs, runtimeImage, runtimeEngine, secretEnv } = buildVllmRuntimeCommand(job, runtimeOpts);
  // 启动预检要拿实时镜像状态，绕过快照缓存。
  const imageStatus = await getImageStatusFresh(runtimeImage);
  if (!imageStatus.ok) {
    appendLog(job, `Runtime image preflight: ${imageStatus.text || runtimeImage}. Pulling before current model is stopped.`);
    const pulled = await pullImageWithRetry(runtimeImage, {
      ...buildVllmImagePullOptions(),
      onAttempt: ({ attempt, attempts }) => appendLog(job, `Docker image pull attempt ${attempt}/${attempts}: ${runtimeImage}`),
      onFailure: ({ attempt, attempts, detail }) => appendLog(job, `Docker image pull ${attempt}/${attempts} failed: ${detail}`),
    });
    appendLog(job, pulled.stdout || pulled.stderr);
  }
  assertStartJobActive(job);

  await snapshotCurrentStats("before-start").catch(() => {});
  setJobProgress(job, {
    percent: 18,
    stage: "创建可回滚切换点",
    detail: `正在保留 ${targetContainerName} 的完整容器配置，若新实例失败会自动恢复。`,
  });
  let previousRuntimeApiKeyRef = "";
  const prepareReplacement = async (admissionRequest = opts.gpuAdmissionRequest) => {
    const previousContainer = await getContainerStatusFresh(targetContainerName);
    previousRuntimeApiKeyRef = String(previousContainer.labels?.[MANAGER_APIKEY_REF_LABEL_KEY] || "");
    const previousGpuAdmissionLeaseId = String(previousContainer.labels?.["ai.manager.gpu-admission-lease"] || "");
    if (admissionRequest && previousGpuAdmissionLeaseId) {
      admissionRequest.retireLeaseIds = Array.from(new Set([
        ...(Array.isArray(admissionRequest.retireLeaseIds) ? admissionRequest.retireLeaseIds : []),
        previousGpuAdmissionLeaseId,
      ]));
    }
    return core.beginContainerReplacement({
      docker,
      containerName: targetContainerName,
      managerId: CONFIG.managerId,
      ownerLabelKey: MANAGER_LABEL_KEY,
      onEvent: (event) => {
        if (event.type === "backup-ready") appendLog(job, `Rollback checkpoint ready: ${event.backupName}`);
      },
    });
  };
  const replacement = typeof opts.prepareGpuAdmission === "function"
    ? await opts.prepareGpuAdmission(prepareReplacement)
    : await prepareReplacement();

  try {
    if (typeof opts.prepareGpuAdmission === "function") {
      runtimeOpts = {
        ...opts,
        hostGpus: Array.isArray(gpuProbe.gpus) ? gpuProbe.gpus : [],
      };
      const admittedRuntimePreset = previewVllmRuntimePreset(runtimeOpts);
      const admittedRuntimeImage = admittedRuntimePreset.image || CONFIG.image;
      const admittedCompatibility = assessVllmRuntimeCompatibility({
        probe: gpuCompatibilityProbe,
        selectedGpuIds: runtimeOpts.gpuDeviceIds,
        imageReference: admittedRuntimeImage,
        imageMetadata: knownRuntimeImageMetadata(admittedRuntimeImage),
        hostPlatform: process.platform,
        hostArch: process.arch,
        allowAnyCompatibleGpu: false,
      });
      for (const item of admittedCompatibility.findings) {
        appendLog(job, `Admitted GPU compatibility [${item.severity}]: ${item.title}: ${item.detail}`);
      }
      if (!admittedCompatibility.ok) {
        const issues = admittedCompatibility.findings
          .filter((item) => item.severity === "fail")
          .map((item) => item.detail);
        setJobProgress(job, {
          percent: 30,
          stage: "最终 GPU 与 vLLM 运行时不兼容",
          detail: issues.join("；") || admittedCompatibility.summary,
          state: "fail",
          issues,
        });
        const error = new Error(`admission 选定的 GPU 未通过 vLLM 运行时硬校验：${issues.join("；") || admittedCompatibility.summary}`);
        error.code = "vllm_runtime_incompatible";
        error.findings = admittedCompatibility.findings;
        throw error;
      }
      ({ runArgs, activePublishArgs, runtimeImage, runtimeEngine, secretEnv } = buildVllmRuntimeCommand(job, runtimeOpts));
    }
    setJobProgress(job, {
      percent: 32,
      stage: "启动 Docker 容器",
      detail: "Docker run 已开始；旧模型容器已保留为回滚点。",
    });
    const redactedLaunchCommand = `docker ${redactDockerArgs(runArgs, opts).join(" ")}`;
    job.meta = {
      ...(job.meta || {}),
      launchCommand: redactedLaunchCommand,
      runtimeLaunchStarted: true,
      runtimeContainerCreated: false,
    };
    scheduleJobsSave(0);
    appendLog(job, `> ${redactedLaunchCommand}`);
    assertStartJobActive(job);
    // Every attempt, including both retries, gets the secret env (08 P0-4).
    const launched = await core.dockerRunWithRetries({
      docker,
      runArgs,
      dockerOptions: { env: core.buildDockerChildEnv(secretEnv, { viaWsl: Boolean(CONFIG.dockerWslDistro) }) },
      isNameConflictError: isContainerNameConflictError,
      onNameConflict: async (error) => {
        appendLog(job, `容器名冲突，清理本次残留容器后重试：${error.stderr || error.message}`);
        await core.removeContainerIfPresent(docker, targetContainerName);
      },
      getBindRetryArgs: (error) => {
        if (opts.networkAccess !== "lan" || !isDockerPublishBindError(error) || activePublishArgs.some((arg) => arg.startsWith("0.0.0.0:"))) {
          return null;
        }
        activePublishArgs = dockerPublishArgs(opts.port, "lan", "0.0.0.0");
        const retryArgs = replaceDockerPublishArgs(runArgs, activePublishArgs);
        appendLog(job, `Docker specific LAN IP publish failed; retrying with wildcard bind. Original error: ${error.stderr || error.message}`);
        appendLog(job, `Docker publish fallback: ${formatDockerPublishArgs(activePublishArgs)}`);
        appendLog(job, `> docker ${redactDockerArgs(retryArgs, opts).join(" ")}`);
        return retryArgs;
      },
    });
    job.meta = { ...(job.meta || {}), runtimeContainerCreated: true };
    scheduleJobsSave(0);
    assertStartJobActive(job);
    appendLog(job, launched.stdout || launched.stderr);

    setJobProgress(job, {
      percent: 45,
      stage: "等待模型加载",
      detail: `容器已创建，正在等待 ${runtimeEngine === "sglang" ? "SGLang" : "vLLM"} API 返回 /v1/models。`,
    });
    const startTimeoutMs = Math.max(60000, Number(process.env.VLLM_START_TIMEOUT_MS || 60 * 60 * 1000));
    // Large RAM-PLE checkpoints on Windows bind mounts can spend more than
    // ten minutes inside a quiet read. Keep the overall startup timeout and
    // dead-container checks, but do not apply the small-model quiet limit.
    const stallTimeoutMs = Math.max(60000, Number(process.env.VLLM_START_STALL_TIMEOUT_MS
      || (runtimePreset.pennyroyal ? 30 : 10) * 60 * 1000));
    const result = await core.waitForRuntimeReady({
      job,
      port: opts.port,
      apiKey: opts.vllmApiKey,
      serviceUrl: opts.serviceUrl,
      engineName: runtimeEngine === "sglang" ? "SGLang" : "vLLM",
      apiLabel: `${runtimeEngine === "sglang" ? "SGLang" : "vLLM"} API`,
      containerName: targetContainerName,
      startupTimeoutMs: startTimeoutMs,
      stallTimeoutMs,
      // Lifecycle readiness must bypass the short status cache: immediately
      // after `docker run`, a cached "missing" result would make rollback
      // kill the newly-created container before its first status refresh.
      fetchServedModels: () => getServedModelsFresh(opts.port, opts.vllmApiKey),
      getContainerStatus: getContainerStatusFresh,
      docker,
      extractLogIssues,
      setJobProgress,
      appendLog,
      finishJob,
      delayFn: delay,
      probeRuntime: ({ servedModels }) => core.probeOpenAiGeneration({
        fetchImpl: fetch,
        servedModels,
        port: opts.port,
        apiKey: opts.vllmApiKey,
        timeoutMs: Math.max(30000, Number(process.env.VLLM_READY_PROBE_REQUEST_TIMEOUT_MS || 180000)),
        maxTokens: 32,
      }),
      readyProbeTimeoutMs: Math.max(60000, Number(process.env.VLLM_READY_PROBE_TIMEOUT_MS || 5 * 60 * 1000)),
      noLogIssue: `${runtimeEngine === "sglang" ? "SGLang" : "vLLM"} 启动日志长时间无变化。`,
      pollDetail: ({ elapsed, formatElapsed }) => `已等待 ${formatElapsed(elapsed)}。正在轮询 ${runtimeEngine === "sglang" ? "SGLang" : "vLLM"} API，并读取容器日志检查错误。`,
    });
    const replacementCommit = await replacement.commit().catch((error) => {
      appendLog(job, `新模型已就绪，但清理回滚快照失败：${error.message}`);
      return null;
    });
    if (replacementCommit?.committed && previousRuntimeApiKeyRef && previousRuntimeApiKeyRef !== opts.runtimeApiKeyRef) {
      await runtimeApiKeyStore.remove(previousRuntimeApiKeyRef).catch(() => {});
    }
    clearGatewayRuntimeCache();
    clearRuntimeInstancesCache();
    return result;
  } catch (error) {
    const rollback = await replacement.rollback(error).catch((rollbackError) => ({ rollbackError }));
    if (rollback?.restoredPrevious) appendLog(job, `新模型启动失败，已恢复原容器 ${targetContainerName}。`);
    else if (rollback?.rollbackError) appendLog(job, `自动回滚失败：${rollback.rollbackError.message}`);
    throw error;
  }
}

function buildVllmImagePullOptions(env = process.env) {
  return {
    attempts: Math.max(1, Number(env.VLLM_IMAGE_PULL_RETRIES || 3)),
    initialDelayMs: Math.max(0, Number(env.VLLM_IMAGE_PULL_RETRY_DELAY_MS || 3000)),
    platform: CONFIG.imagePlatform,
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
  buildClaudeCompressionSummary: (messages, options = {}) => core.buildClaudeCompressionSummary(messages, { ...options, language: "zh-CN" }),
  parseToolArguments: core.parseToolArguments,
  writeJsonFile,
  readJsonFile,
  dockerGpuArg,
  portPublishArg,
  dockerPublishArgs,
  parseDockerPortPublish,
  normalizeDtype,
  normalizeQuantization,
  normalizeServiceExposureSettings,
  redactServiceExposureSettings,
  buildServiceExposureChecks,
  isServiceApiKeyAccepted: core.isServiceApiKeyAccepted,
  enterServiceRateLimit: core.enterServiceRateLimit,
  enterServiceConcurrency: core.enterServiceConcurrency,
  resolveOpenAiGatewayModel: openAiGatewayHandlers.resolveModel,
  normalizeServiceClient: core.normalizeServiceClient,
  hashServiceApiKey: core.hashServiceApiKey,
  serviceClientAllowsModel,
  buildEffectiveServiceSettings: core.buildEffectiveServiceSettings,
  extractHostname,
  runtimeMatchesServiceGatewayInstance,
  streamOpenAiAsClaude,
  applyVllmRequestDefaults,
  normalizeModelConfig,
  summarizeModelConfigCapabilities,
  buildModelStats,
  withSpeedWindowSeconds,
  createDownloadRequestHandlers,
  createDownloadTokenStore,
  listModelStorageRoots,
  buildSglangRuntimeFacts,
  createLatestRuntimeFactsReader,
  getModelConfigRequest,
  buildVllmMemoryEstimate,
  buildServerMemoryEstimate,
  buildVllmImagePullOptions,
  checkModelCompatibility,
  knownRuntimeImageMetadata,
  resolveVllmRuntimePreset,
  isDiffusionGemmaModel,
  isQwen36MoeNvfp4Model,
  isQwen36DenseNvfp4Model,
  isQwen38Model,
  isQwen38Nvfp4Model,
  isQwen38FlashNextNvfp4Model,
  resolveDsparkDraftModel,
  parseDockerCreatedAtSeconds,
  diffusionGemmaWindowsBlockReason,
};
