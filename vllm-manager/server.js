const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const core = require("../manager-core");
const { createCcSwitchProviderTools } = require("./lib/ccswitch-provider");
const { createVllmStartRuntimeRequest } = require("./lib/launch-request");
const { createVllmDefaultLaunchProfiles } = require("./lib/default-profiles");
const { buildVllmMemoryEstimate } = require("./lib/memory-estimate");
const { createVllmRuntimeCommandBuilder } = require("./lib/runtime-command");
const { createVllmRemoteModelService } = require("./lib/remote-models");
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
} = core;
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {}

const app = express();
const PORT = Number(process.env.VLLM_MANAGER_PORT || 5177);
const HOST = process.env.VLLM_MANAGER_HOST || "127.0.0.1";
const ALLOW_REMOTE_MANAGEMENT = process.env.VLLM_MANAGER_ALLOW_REMOTE === "1";
const DEFAULT_VLLM_IMAGE = `vllm/vllm-openai:${process.env.VLLM_IMAGE_VERSION || "v0.21.0"}`;
const DEFAULT_GEMMA_VLLM_IMAGE = "vllm/vllm-openai:gemma";
const DEFAULT_AI_ROOT = process.env.AI_ROOT || (process.platform === "win32" ? "D:\\AI" : path.join(os.homedir(), "AI"));
const DEFAULT_DEVTOOLS_ROOT = process.env.DEVTOOLS_ROOT || (process.platform === "win32" ? "D:\\DevTools" : "");
const MANAGER_LABEL_KEY = "ai.manager";
const MANAGER_ENGINE_LABEL_KEY = "ai.manager.engine";
const MANAGER_APIKEY_LABEL_KEY = "ai.manager.api-key";

const CONFIG = {
  dockerExe: firstExisting([
    process.env.DOCKER_EXE,
    defaultDevToolsPath("Docker", "resources", "bin", "docker.exe"),
    "docker",
  ]),
  dockerDesktopExe: firstExisting([
    process.env.DOCKER_DESKTOP_EXE,
    defaultDevToolsPath("Docker", "Docker Desktop.exe"),
    defaultDevToolsPath("Docker", "frontend", "Docker Desktop.exe"),
    "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
  ]),
  hfCli: firstExisting([
    process.env.HF_CLI,
    defaultAiPath("venvs", "ai311", "Scripts", "hf.exe"),
    "hf",
    defaultAiPath("venvs", "ai311", "Scripts", "huggingface-cli.exe"),
    "huggingface-cli",
  ]),
  modelScopeCli: firstExisting([
    process.env.MODELSCOPE_CLI,
    defaultAiPath("venvs", "ai311", "Scripts", "modelscope.exe"),
    "modelscope",
  ]),
  pythonExe: firstExisting([
    process.env.PYTHON_EXE,
    defaultAiPath("venvs", "ai311", "Scripts", "python.exe"),
    "python",
  ]),
  ccSwitchDir: process.env.AI_CCSWITCH_DIR || path.join(os.homedir(), ".cc-switch"),
  claude3pConfigDir: process.env.AI_CLAUDE_3P_CONFIG_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Claude-3p", "configLibrary"),
  modelsRoot: process.env.VLLM_MODELS_ROOT || defaultAiPath("models"),
  hfCache: process.env.HF_HOME || defaultAiPath("cache", "huggingface"),
  image: process.env.VLLM_IMAGE || DEFAULT_VLLM_IMAGE,
  gemmaImage: process.env.VLLM_GEMMA_IMAGE || DEFAULT_GEMMA_VLLM_IMAGE,
  containerName: process.env.VLLM_CONTAINER_NAME || "vllm-local",
  managerId: process.env.VLLM_MANAGER_ID || "vllm-manager",
  defaultPort: Number(process.env.VLLM_PORT || 8000),
  pidFile: path.join(__dirname, ".manager.pid"),
  statsLedger: path.join(__dirname, "logs", "stats-ledger.json"),
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
  auditRoot: process.env.AI_AUDIT_ROOT || defaultAiPath("audit-logs"),
  openWebuiContainer: process.env.OPEN_WEBUI_CONTAINER || "open-webui",
  claudeDefaultMaxTokens: Math.min(65536, Math.max(1024, positiveInt(process.env.VLLM_CLAUDE_DEFAULT_MAX_TOKENS || 8192, 8192))),
};

const dockerRuntime = createDockerRuntime({
  dockerExe: CONFIG.dockerExe,
  dockerDesktopExe: CONFIG.dockerDesktopExe,
  formatBytes,
  parseJsonSafe,
  delay,
});
const {
  execFileAsync,
  docker,
  getDockerVersion,
  ensureDockerDaemonRunning,
  checkDockerDaemon,
  getImageStatus,
  normalizeDockerContainerName,
} = dockerRuntime;
const {
  healthCheck,
  directoryHealth,
  commandHealth,
} = core.createHealthProbe({ execFileAsync });

const gpuRuntime = core.createGpuRuntime({ execFileAsync, normalizeGpuIds });
const {
  getGpuStatus,
  normalizeLaunchGpuSelection,
} = gpuRuntime;

const remoteModelService = createVllmRemoteModelService();
const modelFilesystemStore = core.createModelFilesystemStore({
  modelsRoot: CONFIG.modelsRoot,
  hfCache: CONFIG.hfCache,
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
  CONFIG,
  MANAGER_LABEL_KEY,
  MANAGER_ENGINE_LABEL_KEY,
  MANAGER_APIKEY_LABEL_KEY,
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
let automationMonitorTimer = null;
let recentLaunches = [];
const MAX_RECENT_LAUNCHES = 8;
let runtimeActivity = {
  initialized: false,
  lastActivityAt: null,
  lastSeenAt: null,
  lastRequestCount: null,
  lastTokenCount: null,
  lastWarnAt: null,
  unloading: false,
};
const MAX_LOG_LINES = 500;
const MAX_PERSISTED_JOBS = 100;
const jobsLedgerStore = core.createJobsLedgerStore({
  jobs,
  file: CONFIG.jobsLedger,
  readJsonFile,
  writeJsonFile,
  maxLogLines: MAX_LOG_LINES,
  maxPersistedJobs: MAX_PERSISTED_JOBS,
  serveDetail: "vLLM API 已返回模型列表。",
  stopProgressTracker,
  onJobSuccess: (job) => {
    if (job.type === "serve") recordRecentLaunch(job.meta);
  },
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
const PRICE_PROFILES = [
  { id: "openai:gpt-5.5", provider: "OpenAI", label: "GPT-5.5", inputPerM: 5, cachedInputPerM: 0.5, outputPerM: 30, source: "OpenAI API pricing" },
  { id: "openai:gpt-5.4", provider: "OpenAI", label: "GPT-5.4", inputPerM: 2.5, cachedInputPerM: 0.25, outputPerM: 15, source: "OpenAI API pricing" },
  { id: "openai:gpt-5.4-mini", provider: "OpenAI", label: "GPT-5.4 Mini", inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5, source: "OpenAI API pricing" },
  { id: "openai:gpt-5.3-codex", provider: "OpenAI", label: "GPT-5.3 Codex", inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14, source: "OpenAI API pricing" },
  { id: "openai:chatgpt-chat-latest", provider: "OpenAI", label: "ChatGPT chat-latest", inputPerM: 5, cachedInputPerM: 0.5, outputPerM: 30, source: "OpenAI API pricing" },
  { id: "anthropic:claude-opus-4.7", provider: "Anthropic", label: "Claude Opus 4.7", inputPerM: 5, cachedInputPerM: 0.5, outputPerM: 25, source: "Anthropic Claude pricing" },
  { id: "anthropic:claude-sonnet-4.6", provider: "Anthropic", label: "Claude Sonnet 4.6", inputPerM: 3, cachedInputPerM: 0.3, outputPerM: 15, source: "Anthropic Claude pricing" },
  { id: "anthropic:claude-haiku-4.5", provider: "Anthropic", label: "Claude Haiku 4.5", inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 5, source: "Anthropic Claude pricing" },
];

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
} = serviceGatewayAccessLogStore;

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
    await ensureDirs(CONFIG.modelsRoot, CONFIG.hfCache, path.dirname(CONFIG.jobsLedger));
  },
  afterPreparePid: async () => {
    await loadJobsLedgerIntoMemory();
    await loadRecentLaunches().catch((error) => console.warn(`Unable to load recent launches: ${error.message}`));
    const downloadSettings = await readJsonFile(CONFIG.downloadSettings, { queueMode: false });
    downloadQueueMode = Boolean(downloadSettings?.queueMode);
  },
  beforeListen: () => startAutomationMonitor(),
  onShutdown: async () => {
    jobsLedgerStore.clearJobsSaveTimer();
    if (automationMonitorTimer) clearInterval(automationMonitorTimer);
    for (const timer of progressTimers.values()) clearInterval(timer);
    progressTimers.clear();
    await saveJobsLedgerNow().catch((error) => console.warn(`Unable to save jobs ledger during shutdown: ${error.message}`));
    await Promise.allSettled([
      waitForStatsLedgerWrites(),
      jobsLedgerStore.waitForJobsLedgerWrites(),
      flushFileWriteQueues(),
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

core.registerOpenAiBaseUrlHintRoutes(app, { openAiGatewayPath: "/serve/v1" });
app.use(managerSecurityGuard);
app.use(express.json({ limit: "32mb" }));
app.use(["/serve/v1", "/claude", "/v1/messages", "/v1/claude", "/opencode/v1"], serviceGatewayMiddleware);
app.use(express.static(path.join(__dirname, "public")));

core.registerManagerRoutes(app, {
  config: CONFIG,
  host: HOST,
  port: PORT,
  engine: "vllm",
  jobs,
  getLanAddress,
  getConfigExtras: () => ({
    defaultVllmImage: CONFIG.image,
    defaultVllmImagePinned: isPinnedImageReference(CONFIG.image),
  }),
  isLocalRequest,
  shutdownManager,
  exitProcessOnShutdownError: require.main === module,
  buildManagerHealth,
  getDockerVersion,
  getGpuStatus,
  getContainerStatus,
  getImageStatus,
  getRunningModelSummary,
  getManagerResourceSummary,
  buildMemoryEstimate: buildVllmMemoryEstimate,
  collectStats,
  collectExternalAccessStats,
  buildExternalAccessOptions: (query) => {
    const limit = Math.min(500, Math.max(20, Number(query.limit || 160)));
    const maxLines = Math.min(50000, Math.max(limit, Number(query.maxLines || 12000)));
    return { limit, maxLines };
  },
  getClaudeCompressionSettings,
  saveClaudeCompressionSettings,
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
  getRunningModelSummary,
  getUpstreamHeaders: (runtime, headers = {}) => vllmAuthHeaders(runtime.vllmApiKey, headers),
  serviceClientAllowsModel,
  recordUsage: recordServiceClientGatewayUsage,
  upstreamErrorMessage,
  isExpectedStreamDisconnect,
  getRootMappings: (runtime) => getServedModelRootMappings(runtime),
  setAccessUsage: (req, usage) => {
    if (req) req.serviceGatewayAccessUsage = usage;
  },
});
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
app.post("/serve/v1/chat/completions", openAiGatewayHandlers.handleChatCompletions);
app.post("/serve/v1/completions", openAiGatewayHandlers.handleCompletions);
app.get("/opencode/v1/models", handleOpenCodeModels);
app.post("/opencode/v1/chat/completions", handleOpenCodeChatCompletions);

core.registerModelRoutes(app, {
  listModels: listModelCollections,
  deleteLocalModel: deleteLocalModelRequest,
  searchRemoteModels: remoteModelService.searchRemoteModelCatalog,
  startDownload: startDownloadRequest,
  estimateDownload: estimateDownloadRequest,
  getModelConfig: getModelConfigRequest,
  getModelReadme: getModelReadmeRequest,
  checkPort: checkPortRequest,
  getRecentLaunches: () => ({ launches: recentLaunches }),
  getDownloadSettings: () => downloadJobController.getDownloadSettings(),
  saveDownloadSettings: saveDownloadSettingsRequest,
  resolveModelLink: remoteModelService.resolveModelLinkRequest,
});

core.registerJobRoutes(app, {
  jobs,
  beforeReadJobs: () => healDownloadQueue(),
  cancelDownloadJob: (job) => cancelDownloadJob(job),
  pauseDownloadJob: (job) => pauseDownloadJob(job),
  resumeDownloadJob: (job) => resumeDownloadJob(job),
  cancelNonDownloadJob: async (_req, res, job) => {
    if (job.status !== "running" && job.status !== "queued") return res.status(400).json({ error: "任务已结束，无法取消。" });
    try {
      if (typeof job.cancel === "function") {
        job.cancel();
      } else if (job.type === "serve") {
        markJobCancelRequested(job, "cancel");
        await removeManagedContainer("cancel").catch(() => {});
        failJob(job, new Error("启动已被用户取消，容器已移除"));
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
  const target = resolveModelsRootChild(path.join(CONFIG.modelsRoot, safeOutputName(name)));
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
  await fsp.rm(target, { recursive: true, force: true });
  return { ok: true, name, path: target };
}

async function startDownloadRequest(body = {}) {
  const requestedModel = cleanRequired(body.model, "model");
  const source = cleanDownloadSource(body.source || "huggingface");
  const reference = normalizeDownloadModelReference(requestedModel, body.precision);
  const model = reference.model;
  const precision = reference.precision;
  const outputName = safeOutputName(body.outputName || model.replace(/[\\/]/g, "__"));
  const localDir = path.join(CONFIG.modelsRoot, outputName);
  await ensureDirs(CONFIG.modelsRoot, CONFIG.hfCache, localDir);

  const env = core.buildDownloadEnv(CONFIG.hfCache, process.env);
  if (body.hfToken) env.HF_TOKEN = String(body.hfToken);

  const download = buildDownloadCommand(source, model, localDir, { precision });
  const expected = source === "huggingface"
    ? await remoteModelService.getHuggingFaceDownloadEstimate(model, precision).catch((error) => ({ error: error.message }))
    : null;
  const job = enqueueOrStartDownload(download.command, download.args, {
    env,
    title: `Download ${model} (${download.label})`,
    meta: {
      model,
      outputName,
      localDir,
      source,
      precision,
      expectedBytes: expected?.bytes || null,
      expectedFiles: expected?.fileCount || null,
    },
    progressDir: localDir,
    expectedBytes: expected?.bytes || null,
  });
  if (expected?.bytes) {
    appendLog(job, `Estimated download size: ${formatBytes(expected.bytes)} across ${expected.fileCount} files.`);
  } else if (expected?.error) {
    appendLog(job, `Download size estimate unavailable: ${expected.error}`);
  }
  if (source === "modelscope") appendLog(job, "ModelScope source uses the local modelscope CLI when available.");
  if (download.includePatterns?.length) appendLog(job, `Download include filter: ${download.includePatterns.join(", ")}`);
  return { job };
}

async function estimateDownloadRequest(query = {}) {
  const source = cleanDownloadSource(query.source || "huggingface");
  const reference = normalizeDownloadModelReference(query.model, query.precision);
  if (!reference.model) {
    const error = new Error("model is required");
    error.status = 400;
    throw error;
  }
  const diskFreeBytes = await getModelsDiskFreeBytes();
  if (source !== "huggingface") {
    return { source, model: reference.model, bytes: null, fileCount: null, supported: false, diskFreeBytes };
  }
  const estimate = await remoteModelService.getHuggingFaceDownloadEstimate(reference.model, reference.precision);
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

async function getModelConfigRequest(query = {}) {
  const source = cleanDownloadSource(query.source || "huggingface");
  const model = String(query.model || "").trim();
  if (!model) {
    const error = new Error("model is required");
    error.status = 400;
    throw error;
  }
  return getModelConfig(model, source);
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
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error("端口必须是 1-65535 的整数。");
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
});
const {
  startDockerDesktopRequest,
  readRuntimeLogsRequest,
  testRuntimeCompletionRequest,
} = runtimeRequestHandlers;

const startRuntimeRequest = createVllmStartRuntimeRequest({
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
  getLanAddress,
  createJob,
  runStartJob,
  failJob,
});

core.registerRuntimeRoutes(app, {
  startRuntime: startRuntimeRequest,
  startDockerDesktop: startDockerDesktopRequest,
  stopRuntime: stopRuntimeRequest,
  unloadRunningModel: unloadRunningModelRequest,
  readRuntimeLogs: readRuntimeLogsRequest,
  testRuntimeCompletion: testRuntimeCompletionRequest,
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
  const config = normalizeLaunchConfig(meta);
  const entry = {
    model: config.model,
    name: config.name || deriveName(config.model),
    launchedAt: new Date().toISOString(),
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
  const runtime = container.running ? await getRunningModelSummary(container, gpu).catch(() => null) : null;
  const checks = [];
  checks.push(healthCheck("docker", "Docker", dockerStatus.ok ? "ok" : "fail", dockerStatus.text || "Docker not available", ["start-docker"]));
  checks.push(healthCheck("gpu", "GPU", gpu.ok ? "ok" : "warn", gpu.ok ? `${gpu.name} · ${gpu.usedMb}/${gpu.totalMb} MB · ${gpu.util}%` : gpu.text || "No NVIDIA GPU detected"));
  checks.push(healthCheck("image", "vLLM 镜像", image.ok ? "ok" : "warn", image.ok ? image.text : `${CONFIG.image} not found locally`, image.ok ? [] : ["pull-image"]));
  checks.push(healthCheck("image-pin", "镜像版本", isPinnedImageReference(CONFIG.image) ? "ok" : "warn", CONFIG.image));
  checks.push(healthCheck("container", "vLLM 容器", container.running ? "ok" : container.exists ? "warn" : "warn", container.status || (container.exists ? "exists" : "not started")));
  checks.push(healthCheck("api", "OpenAI 兼容 API", runtime?.models?.length ? "ok" : container.running ? "warn" : "warn", runtime?.models?.length ? `${runtime.models.length} model(s) served at ${runtime.endpoint.localUrl}` : "No served model reported yet"));
  checks.push(await directoryHealth("models-root", "模型目录", CONFIG.modelsRoot));
  checks.push(await directoryHealth("hf-cache", "HF 缓存目录", CONFIG.hfCache));
  checks.push(healthCheck("hf-token", "HF Token", process.env.HF_TOKEN ? "ok" : "warn", process.env.HF_TOKEN ? "已配置" : "下载 gated 模型前需要配置 HF_TOKEN"));
  checks.push(await commandHealth("hf-cli", "Hugging Face CLI", CONFIG.hfCli, ["--help"]));
  checks.push(await commandHealth("modelscope-cli", "ModelScope CLI", CONFIG.modelScopeCli, ["--help"], "warn"));
  checks.push(healthCheck("logs", "最近日志", logs.issues?.some((item) => item.severity === "error") ? "fail" : logs.issues?.length ? "warn" : "ok", logs.stage || "No recent vLLM log issues"));

  const score = checks.reduce((sum, item) => sum + (item.status === "ok" ? 1 : item.status === "warn" ? 0.5 : 0), 0);
  return {
    ok: checks.every((item) => item.status !== "fail"),
    score: Math.round((score / Math.max(1, checks.length)) * 100),
    generatedAt: new Date().toISOString(),
    checks,
    runtime,
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
    maxNumSeqs: Number(config.maxNumSeqs || 4),
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
  const findings = [];
  const recommendations = normalizeLaunchConfig({
    model,
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
  if (looksGguf) {
    findings.push(finding("warn", "GGUF 模型", "vLLM 的 GGUF 支持偏实验；如果是常规 llama.cpp GGUF，优先用 llama.cpp/llama-server。"));
    recommendations.loadFormat = "gguf";
    recommendations.quantization = "";
  }
  if (local) {
    findings.push(finding("ok", "本地路径可用", local.path));
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
    findings.push(finding("ok", "NVFP4/FP4 权重", "KV cache 可单独用 FP8；权重量化方法优先按模型 config.json 声明。"));
    if (!recommendations.quantization) recommendations.quantization = "modelopt_fp4";
    recommendations.kvCacheDtype = "fp8";
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
  if (/deepseek/i.test(model)) {
    recommendations.reasoningParser = "deepseek_r1";
    recommendations.toolCallParser = "deepseek_v3";
  }
  if (isDiffusionGemmaModel(model, localConfig)) {
    const runnerMode = gemmaModelRunnerEnvValue() === "0" ? "V1 runner（Windows/WSL UVA fallback）" : "V2 runner";
    findings.push(finding("warn", "DiffusionGemma / Gemma4 专用启动", `该架构需要 Gemma 专用 vLLM 镜像；管理器会自动使用 ${CONFIG.gemmaImage}、${runnerMode}，并补齐 trust-remote-code、TRITON_ATTN、gemma4 parser。Windows/WSL fallback 会启用 eager mode，避开 CUDA graph 断言。`));
    if (gemmaModelRunnerEnvValue() === "0") {
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
  const [docker, gpu, container, clientsLedger] = await Promise.all([
    getDockerVersion().catch((error) => ({ ok: false, text: "", error: error.message })),
    getGpuStatus().catch(() => ({ ok: false })),
    getContainerStatus(CONFIG.containerName),
    getServiceClientsLedger().catch(() => ({ clients: [] })),
  ]);
  const runtime = await getRunningModelSummary(container, gpu).catch(() => ({
    container,
    endpoint: getContainerEndpoint(container),
    servedModels: [],
    models: [],
  }));
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
    inspectAutomationRules().catch((error) => console.warn(`automation monitor failed: ${error.message}`));
  }, 60 * 1000);
  automationMonitorTimer.unref?.();
}

async function inspectAutomationRules() {
  const settings = await automationSettingsStore.getAutomationSettings();
  if (!settings.idleUnloadEnabled && !settings.vramGuardEnabled) return;
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
  const idleEnough = idleMs >= settings.idleMinutes * 60 * 1000;
  const gpuPercent = gpu.ok && gpu.totalMb ? (gpu.usedMb / gpu.totalMb) * 100 : 0;
  const noActiveKv = Number(summary?.totals?.context?.activeTokens || 0) === 0;
  const shouldIdleUnload = settings.idleUnloadEnabled && idleEnough;
  const shouldVramUnload = settings.vramGuardEnabled && settings.vramAction === "unload" && gpuPercent >= settings.vramPercent && idleMs >= 2 * 60 * 1000 && noActiveKv;
  const shouldWarn = settings.vramGuardEnabled && settings.vramAction === "warn" && gpuPercent >= settings.vramPercent;
  if (shouldWarn && now - Date.parse(runtimeActivity.lastWarnAt || 0) > 10 * 60 * 1000) {
    runtimeActivity.lastWarnAt = new Date(now).toISOString();
    const job = createJob("automation", "VRAM guard warning", { gpuPercent, threshold: settings.vramPercent });
    appendLog(job, `GPU memory usage ${gpuPercent.toFixed(1)}% exceeded ${settings.vramPercent}%.`);
    finishJob(job, { result: "warn-only" });
  }
  if (shouldIdleUnload || shouldVramUnload) {
    runtimeActivity.unloading = true;
    const reason = shouldIdleUnload ? `Idle for ${Math.round(idleMs / 60000)} minutes` : `VRAM ${gpuPercent.toFixed(1)}% exceeded ${settings.vramPercent}%`;
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

async function verifyDownloadedModel(input = {}) {
  return modelFilesystemStore.verifyDownloadedModel(input, {
    buildIssues: (summary, makeFinding) => {
      const issues = [];
      if (!summary.hasConfig && !summary.gguf) issues.push(makeFinding("warn", "缺少模型配置", "没有 config.json/params.json；如果不是 GGUF，vLLM 可能无法启动。"));
      if (!summary.hasTokenizer && !summary.gguf) issues.push(makeFinding("warn", "缺少 tokenizer", "未发现 tokenizer 文件；远程 repo 启动可能会补取，本地离线启动可能失败。"));
      if (!summary.safetensors && !summary.gguf) issues.push(makeFinding("warn", "未发现权重文件", "没有 .safetensors 或 .gguf 文件。"));
      return issues;
    },
  });
}

async function buildConnectionGuide() {
  const [gpu, container] = await Promise.all([getGpuStatus(), getContainerStatus(CONFIG.containerName)]);
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

async function handleClaudeModels(_req, res) {
  try {
    const runtime = await getRunningModelSummary();
    if (!runtime.container.running) {
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

async function handleOpenCodeModels(_req, res) {
  try {
    const runtime = await getRunningModelSummary();
    if (!runtime.container.running) {
      return res.status(503).json({ error: { message: "Model service is not running.", type: "service_unavailable" } });
    }
    const served = runtime.servedModels || [];
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
    const runtime = await getRunningModelSummary();
    if (!runtime.container.running) {
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
    if (shouldDisableThinkingForOpenCode(resolvedModel, runtime)) {
      const kwargs = body.chat_template_kwargs && typeof body.chat_template_kwargs === "object" && !Array.isArray(body.chat_template_kwargs)
        ? { ...body.chat_template_kwargs }
        : {};
      if (kwargs.enable_thinking === undefined) kwargs.enable_thinking = false;
      body.chat_template_kwargs = kwargs;
    }
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

function shouldDisableThinkingForOpenCode(model, runtime) {
  const root = getServedModelRootMappings(runtime).find((entry) => entry.id === model)?.root || "";
  return /qwen/i.test(`${model} ${root}`);
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
    const runtime = await getRunningModelSummary();
    if (!runtime.container.running) {
      req.serviceGatewayAccessUsage = { error: "Model service is not running.", toolSchemaCount };
      await recordClaudeBridgeUsage({
        requestedModel: String(body.model || ""),
        model: "",
        ok: false,
        error: "Model service is not running.",
        latencyMs: Date.now() - startedAt,
        toolSchemaCount,
        session: claudeSession,
      }).catch(() => {});
      return res.status(503).json(claudeError("service_unavailable", "Model service is not running."));
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
    const compression = applyClaudeContextCompression(body, runtime, model, compressionSettings);
    const effectiveBody = compression.body;
    const stream = body.stream === true;
    const openAiBody = buildOpenAiBodyFromClaude(effectiveBody, model);
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
  const label = clipText(firstUserText.replace(/\s+/g, " ").trim() || requestedModel || "Claude task", 96);
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
  return value;
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
  return value;
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

async function getModelsDiskFreeBytes() {
  try {
    const stat = await fsp.statfs(CONFIG.modelsRoot);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return Number.isFinite(free) && free > 0 ? free : null;
  } catch {
    return null;
  }
}

// 端口预检：先看是否被其它托管容器发布占用，再尝试在本机绑定该端口探测 OS 占用
async function checkPortAvailability(port) {
  const containers = await listManagedContainers().catch(() => []);
  const ownName = normalizeDockerContainerName(CONFIG.containerName);
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
async function getModelConfig(model, source = "huggingface") {
  const input = String(model || "").trim();
  const local = describeLocalModelPath(input);
  if (local?.stat?.isDirectory()) {
    const configPath = path.join(local.path, "config.json");
    if (fs.existsSync(configPath)) {
      const raw = parseJsonSafe(await fsp.readFile(configPath, "utf8"), null);
      if (raw) return { ...normalizeModelConfig(raw), source: "local", model: input, found: true };
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
  return { ...normalizeModelConfig(raw), source: "huggingface", model: input, found: true };
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
  return {
    architectures: Array.isArray(raw.architectures) ? raw.architectures : [],
    modelType: String(raw.model_type || text.model_type || ""),
    maxPositionEmbeddings: Number(pick("max_position_embeddings")) || null,
    ropeScaling: raw.rope_scaling || text.rope_scaling || null,
    numHiddenLayers: Number(pick("num_hidden_layers")) || null,
    numAttentionHeads: numHeads || null,
    numKeyValueHeads: kvHeads || null,
    hiddenSize: hiddenSize || null,
    headDim: headDim || null,
    torchDtype: String(pick("torch_dtype") || ""),
    quantMethod: String(quant.quant_method || quant.quant_algo || "") || (raw.quantization_config ? "quantized" : ""),
    numExperts: Number(pick("num_experts") ?? pick("n_routed_experts")) || null,
    isMultimodal: Boolean(raw.vision_config || raw.text_config || raw.vision_tower || raw.image_token_id),
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
  const text = `${model || ""} ${preset || ""}`.toLowerCase();
  if (text.includes("diffusiongemma") || text.includes("diffusion_gemma") || text.includes("gemma4") || text.includes("gemma-4")) {
    return "gemma4";
  }
  if (text.includes("qwen3.6") || text.includes("qwen3-") || text.includes("qwen/qwen3") || text.includes("qwen3_coder") || text.includes("qwen3-coder")) {
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

function getLanAddress() {
  const interfaces = os.networkInterfaces();
  const addresses = Object.values(interfaces)
    .flat()
    .filter(Boolean)
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  return addresses.find((address) => /^192\.168\./.test(address))
    || addresses.find((address) => /^10\./.test(address))
    || addresses.find((address) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(address))
    || addresses[0]
    || "127.0.0.1";
}

function dockerGpuArg(gpuDeviceIds) {
  const ids = normalizeGpuIds(gpuDeviceIds);
  return ids.length ? `device=${ids.join(",")}` : "all";
}

function windowsPathToContainerPath(value) {
  if (!path.isAbsolute(value)) return value;
  const resolved = path.resolve(value);
  const root = path.resolve(CONFIG.modelsRoot);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Local model path must be inside ${CONFIG.modelsRoot}`);
  }
  return `/models/${relative.split(path.sep).join("/")}`;
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

function resolveVllmRuntimePreset(opts = {}, launch = {}) {
  const localConfig = readLocalModelConfig(launch.localPath);
  if (!isDiffusionGemmaModel(opts.model || launch.modelArg, localConfig)) return { id: "", env: {} };
  const effectiveKvCacheDtype = !opts.kvCacheDtype || opts.kvCacheDtype === "auto" ? "fp8" : opts.kvCacheDtype;
  const gemmaModelRunner = gemmaModelRunnerEnvValue();
  const gemmaMaxNewTokens = gemmaMaxNewTokensValue();
  return {
    id: "diffusion-gemma",
    label: "DiffusionGemma / Gemma4",
    image: CONFIG.gemmaImage,
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
    defaultChatTemplateKwargs: JSON.stringify({ enable_thinking: true }),
    notes: [
      "uses vllm/vllm-openai:gemma-compatible runtime",
      `sets VLLM_USE_V2_MODEL_RUNNER=${gemmaModelRunner}${gemmaModelRunner === "0" ? " to avoid WSL UVA initialization failures" : ""}`,
      "adds --attention-backend TRITON_ATTN",
      ...(gemmaModelRunner === "0" ? ["adds --enforce-eager to avoid CUDA graph profiling assertion failures"] : []),
      `caps default generation to ${gemmaMaxNewTokens} tokens so clients that omit max_tokens do not request the full context window`,
      "uses gemma4 reasoning/tool parsers",
    ],
  };
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
  try {
    const out = await docker(["ps", "-a", "--filter", `name=^/${containerName}$`, "--format", "{{json .}}"]);
    const line = out.stdout.trim();
    if (!line) return { exists: false, running: false };
    const info = JSON.parse(line);
    const labels = await getContainerLabels(containerName);
    return {
      exists: true,
      running: String(info.State || "").toLowerCase() === "running",
      name: info.Names,
      status: info.Status,
      ports: info.Ports,
      image: info.Image,
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
    const labels = await getContainerLabels(name);
    containers.push({
      name,
      image: info.Image || "",
      status: info.Status || "",
      running: String(info.State || "").toLowerCase() === "running",
      ports: info.Ports || "",
      manager: labels[MANAGER_LABEL_KEY] || "",
      engine: labels[MANAGER_ENGINE_LABEL_KEY] || "",
    });
  }
  return containers.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}

async function removeManagedContainer(reason = "replace") {
  const container = await getContainerStatus(CONFIG.containerName);
  if (!container.exists) return { removed: false, containerName: CONFIG.containerName };
  const owner = container.labels?.[MANAGER_LABEL_KEY] || "";
  if (owner && owner !== CONFIG.managerId) {
    const error = new Error(`Refusing to remove ${CONFIG.containerName}; it belongs to ${owner}.`);
    error.code = "CONTAINER_OWNED_BY_OTHER_MANAGER";
    error.status = 409;
    throw error;
  }
  await docker(["rm", "-f", CONFIG.containerName]);
  return { removed: true, containerName: CONFIG.containerName, owner: owner || null, reason };
}

function getVllmApiKey(container) {
  return String(container?.labels?.[MANAGER_APIKEY_LABEL_KEY] || "");
}

function vllmAuthHeaders(apiKey, base = {}) {
  return apiKey ? { ...base, authorization: `Bearer ${apiKey}` } : base;
}

async function getServedModels(port, apiKey = "") {
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

async function getRunningModelSummary(container = null, gpu = null) {
  const activeContainer = container || await getContainerStatus(CONFIG.containerName);
  const endpoint = getContainerEndpoint(activeContainer);
  const vllmApiKey = getVllmApiKey(activeContainer);
  const servedModels = activeContainer.running ? await getServedModels(endpoint.port, vllmApiKey) : [];
  const runtimeStats = activeContainer.running
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
    endpoint,
    servedModels,
    models,
    vllmApiKey,
    apiKeyRequired: Boolean(vllmApiKey),
    canUnload: activeContainer.exists,
    unloadStopsContainer: true,
    note: "vLLM keeps one model resident in the server process. Unloading from this manager stops the managed vLLM container, but leaves the manager and other Docker services alone.",
  };
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
  const summary = core.mergeLiveAndStatsLedgerInactive(liveSummary, ledger);
  const costComparison = PRICE_PROFILES.map((profile) => calculateCost(summary.totals.tokens, profile));
  const clientUsage = buildClientUsageSummary(summary.totals, ledger);
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    container,
    endpoint: getContainerEndpoint(container),
    gpu,
    pricingAsOf: "2026-05-25",
    pricingUnit: "USD per 1M tokens",
    pricingSources: [
      { label: "OpenAI API pricing", url: "https://developers.openai.com/api/docs/pricing" },
      { label: "Anthropic Claude pricing", url: "https://platform.claude.com/docs/en/about-claude/pricing" },
    ],
    ...summary,
    live: liveSummary,
    historical: core.statsLedgerToSummary(ledger),
    clientUsage,
    costComparison,
  };
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
  const endpoint = getContainerEndpoint(container);
  const empty = core.emptyStatsSummary(container, endpoint, {
    stoppedNote: "vLLM container is not running.",
    missingNote: "No managed vLLM container is running.",
  });
  if (!container?.running) return empty;

  let metricsText = "";
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/metrics`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`metrics returned ${response.status}`);
    metricsText = await response.text();
  } catch (error) {
    return { ...empty, error: error.message };
  }

  const servedModels = await getServedModels(endpoint.port).catch(() => []);
  const factModelHints = Array.from(new Set(servedModels
    .flatMap((model) => [model.id, model.root])
    .filter(Boolean)));
  const persistedFacts = await getPersistedRuntimeFacts(factModelHints).catch(() => ({}));
  let facts = core.mergeRuntimeFacts(persistedFacts, await getLatestRuntimeFacts(factModelHints).catch(() => ({})));
  if (!facts.kvCacheTokens && !facts.maxConcurrency) {
    facts = core.mergeRuntimeFacts(facts, await getLatestRuntimeFacts(factModelHints, {
      tail: process.env.VLLM_RUNTIME_FACT_LOG_TAIL || "20000",
    }).catch(() => ({})));
  }
  const servedById = Object.fromEntries(servedModels.map((model) => [model.id, model]));
  const metrics = parsePrometheusMetrics(metricsText);
  const processStartSeconds = firstMetricValue(metrics, "process_start_time_seconds") || null;
  const nowSeconds = Date.now() / 1000;
  const uptimeSeconds = processStartSeconds ? Math.max(0, nowSeconds - processStartSeconds) : null;
  const models = buildModelStats(metrics, servedById, facts, nowSeconds, options);
  const totals = aggregateStats(models, uptimeSeconds);
  const modelsByName = Object.fromEntries(models.map((model) => [model.name, model]));

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
    const scoped = metrics.filter((metric) => metric.labels.model_name === name);
    const promptTokens = sumMetric(scoped, "vllm:prompt_tokens_total");
    const generationTokens = sumMetric(scoped, "vllm:generation_tokens_total");
    const cachedPromptTokens = sumMetric(scoped, "vllm:prompt_tokens_cached_total");
    const successByReason = sumByLabel(scoped, "vllm:request_success_total", "finished_reason");
    const requestCount = Object.values(successByReason).reduce((sum, value) => sum + value, 0)
      || sumMetric(scoped, "vllm:request_prompt_tokens_count");
    const errorCount = Number(successByReason.error || 0);
    const abortedCount = Number(successByReason.abort || 0);
    const kvUsagePercent = firstMetricValue(scoped, "vllm:kv_cache_usage_perc") || 0;
    const capacityTokens = facts.kvCacheTokens || deriveKvCapacityTokens(scoped, servedById?.[name], facts);
    const activeTokens = capacityTokens ? Math.round(capacityTokens * kvUsagePercent) : null;
    const promptBySource = sumByLabel(scoped, "vllm:prompt_tokens_by_source_total", "source");
    const prefixQueries = sumMetric(scoped, "vllm:prefix_cache_queries_total");
    const prefixHits = sumMetric(scoped, "vllm:prefix_cache_hits_total");
    const recent = core.calculateRecentRates(statsSamples, name, nowSeconds, {
      promptTokens,
      generationTokens,
      requestCount,
    }, options.updateSamples !== false);

    models.push({
      name,
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
        running: firstMetricValue(scoped, "vllm:num_requests_running") || 0,
        waiting: firstMetricValue(scoped, "vllm:num_requests_waiting") || 0,
      },
      latency: {
        avgE2eSeconds: histogramAverage(scoped, "vllm:e2e_request_latency_seconds"),
        avgTtftSeconds: histogramAverage(scoped, "vllm:time_to_first_token_seconds"),
        avgInterTokenSeconds: histogramAverage(scoped, "vllm:inter_token_latency_seconds"),
        avgTimePerOutputTokenSeconds: histogramAverage(scoped, "vllm:request_time_per_output_token_seconds"),
        avgQueueSeconds: histogramAverage(scoped, "vllm:request_queue_time_seconds"),
      },
      averages: {
        promptTokensPerRequest: histogramAverage(scoped, "vllm:request_prompt_tokens"),
        outputTokensPerRequest: histogramAverage(scoped, "vllm:request_generation_tokens"),
        requestedMaxTokens: histogramAverage(scoped, "vllm:request_params_max_tokens"),
      },
      speed: {
        ...recent,
        averageOutputTokensPerSecond: tokensPerSecondFromSeconds(histogramAverage(scoped, "vllm:request_time_per_output_token_seconds")),
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
        maxModelLen: servedById?.[name]?.max_model_len || null,
        concurrencyAtMaxLen: facts.maxConcurrency || null,
      },
    });
  }
  return models.sort((a, b) => b.tokens.total - a.tokens.total);
}

function deriveKvCapacityTokens(metrics, servedModel, facts) {
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

async function getLatestRuntimeFacts(modelHints = [], options = {}) {
  const tail = String(options.tail || "2000");
  const out = await docker(["logs", "--tail", tail, CONFIG.containerName], {
    rejectOnError: false,
    maxBuffer: Number(options.maxBuffer || 32 * 1024 * 1024),
  });
  const needles = core.normalizeRuntimeFactHints(modelHints);
  const jobText = Array.from(jobs.values())
    .filter((job) => job.type === "serve" && (!needles.length || jobMatchesRuntimeFactHints(job, needles)))
    .map((job) => (job.logs || []).join("\n"))
    .join("\n");
  const text = `${jobText}\n${out.stdout}${out.stderr}`;
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
  appendLog,
  finishJob,
  failJob,
  scheduleSave: scheduleJobsSave,
  startProgressTracker,
  handleDownloadCancel: async (job) => {
    if (job.meta?.cancelAction === "pause") pauseDownloadJobAfterStop(job);
    else await finalizeDownloadCancel(job, { deletePartial: true });
  },
  cancelNonDownloadMessage: "任务已被用户取消",
  closeHandlerErrorMode: "log",
  onDone: (job) => {
    if (job.type === "download") drainDownloadQueue();
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
  saveQueueMode: (queueMode) => atomicWriteJsonFile(CONFIG.downloadSettings, { queueMode }),
  resolvePartialPath: resolveModelsRootChild,
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

function startProgressTracker(job, targetDir, expectedBytes, options = {}) {
  const totalBytes = Number(expectedBytes || 0) || null;
  const tracker = {
    baseBytes: null,
    lastBytes: 0,
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
      const currentBytes = await dirSize(targetDir);
      if (tracker.baseBytes === null) tracker.baseBytes = options.countExistingProgress ? 0 : currentBytes;
      const downloadedBytes = Math.max(0, currentBytes - tracker.baseBytes);
      const elapsed = Math.max(0.001, (now - tracker.lastAt) / 1000);
      const delta = Math.max(0, downloadedBytes - tracker.lastBytes);
      const speedBytesPerSec = delta / elapsed;
      const percent = totalBytes ? Math.min(100, (downloadedBytes / totalBytes) * 100) : null;
      const remainingBytes = totalBytes ? Math.max(0, totalBytes - downloadedBytes) : null;
      const etaSeconds = remainingBytes && speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : null;
      job.progress = {
        kind: "download",
        downloadedBytes,
        totalBytes,
        percent,
        speedBytesPerSec,
        etaSeconds,
        updatedAt: new Date(now).toISOString(),
      };
      job.updatedAt = job.progress.updatedAt;
      tracker.lastBytes = downloadedBytes;
      tracker.lastAt = now;
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
  const timer = setInterval(tick, 2500);
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
      stage: "启动 Docker Desktop",
      detail: "Docker daemon 未就绪，正在自动启动 Docker Desktop 并等待引擎可用。",
    });
    appendLog(job, "Docker daemon is not ready; requesting Docker Desktop startup.");
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
    : `Docker Desktop started; daemon ready: ${dockerReady.version}`);
  for (const warning of opts.gpuWarnings || []) appendLog(job, `GPU selection warning: ${warning}`);
  const gpuProbe = await getGpuStatus();
  if (!gpuProbe.ok) {
    appendLog(job, `GPU warning: 未检测到可用的 NVIDIA GPU（${gpuProbe.text || "nvidia-smi 不可用"}）。vLLM 官方镜像依赖 NVIDIA GPU，容器很可能启动失败。`);
  }

  setJobProgress(job, {
    percent: 5,
    stage: "清理旧容器",
    detail: `正在停止并移除 ${CONFIG.containerName}`,
  });
  appendLog(job, `Stopping existing ${CONFIG.containerName}, if present`);
  await snapshotCurrentStats("before-start").catch(() => {});
  await removeManagedContainer("replace").catch((error) => {
    if (error.code === "CONTAINER_OWNED_BY_OTHER_MANAGER") throw error;
  });
  setJobProgress(job, {
    percent: 18,
    stage: "准备 Docker 参数",
    detail: "旧容器已处理，正在生成 vLLM 启动命令。",
  });

  // 旧容器已移除，此时端口若仍被占用，说明是别的进程/容器，docker run 会失败得很隐晦
  const portStatus = await checkPortAvailability(opts.port).catch(() => null);
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

  let { runArgs, activePublishArgs } = buildVllmRuntimeCommand(job, opts);

  setJobProgress(job, {
    percent: 32,
    stage: "启动 Docker 容器",
    detail: "Docker run 已开始；如果镜像不存在，这一步会等待拉取镜像。",
  });
  appendLog(job, `> docker ${redactDockerArgs(runArgs, opts).join(" ")}`);
  let launched;
  try {
    launched = await docker(runArgs);
  } catch (error) {
    if (opts.networkAccess !== "lan" || !isDockerPublishBindError(error) || activePublishArgs.some((arg) => arg.startsWith("0.0.0.0:"))) {
      throw error;
    }
    activePublishArgs = dockerPublishArgs(opts.port, "lan", "0.0.0.0");
    const retryArgs = replaceDockerPublishArgs(runArgs, activePublishArgs);
    appendLog(job, `Docker specific LAN IP publish failed; retrying with wildcard bind. Original error: ${error.stderr || error.message}`);
    appendLog(job, `Docker publish fallback: ${formatDockerPublishArgs(activePublishArgs)}`);
    appendLog(job, `> docker ${redactDockerArgs(retryArgs, opts).join(" ")}`);
    launched = await docker(retryArgs);
  }
  appendLog(job, launched.stdout || launched.stderr);

  setJobProgress(job, {
    percent: 45,
    stage: "等待模型加载",
    detail: "容器已创建，正在等待 vLLM API 返回 /v1/models。",
  });
  // 硬上限默认 60 分钟（容器内现拉权重的大模型可能很慢）；
  // 真正的失败判定靠「日志停滞」：日志持续无变化才认为卡死。
  const startTimeoutMs = Math.max(60000, Number(process.env.VLLM_START_TIMEOUT_MS || 60 * 60 * 1000));
  const stallTimeoutMs = Math.max(60000, Number(process.env.VLLM_START_STALL_TIMEOUT_MS || 10 * 60 * 1000));
  return core.waitForRuntimeReady({
    job,
    port: opts.port,
    apiKey: opts.vllmApiKey,
    serviceUrl: opts.serviceUrl,
    engineName: "vLLM",
    apiLabel: "vLLM API",
    containerName: CONFIG.containerName,
    startupTimeoutMs: startTimeoutMs,
    stallTimeoutMs,
    fetchServedModels: () => getServedModels(opts.port, opts.vllmApiKey),
    getContainerStatus,
    docker,
    extractLogIssues,
    setJobProgress,
    appendLog,
    finishJob,
    delayFn: delay,
    noLogIssue: "vLLM 启动日志长时间无变化。",
    pollDetail: ({ elapsed, formatElapsed }) => `已等待 ${formatElapsed(elapsed)}。正在轮询 vLLM API，并读取容器日志检查错误。`,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  app,
  CONFIG,
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
  streamOpenAiAsClaude,
  normalizeModelConfig,
  buildVllmMemoryEstimate,
};
