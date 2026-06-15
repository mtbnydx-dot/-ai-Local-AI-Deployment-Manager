const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const core = require("../manager-core");
const { createLlamaStartRuntimeRequest } = require("./lib/launch-request");
const { createLlamaDefaultLaunchProfiles } = require("./lib/default-profiles");
const { buildLlamaGpuPlan, normalizeLlamaSplitMode, suggestTensorSplit } = require("./lib/gpu-plan");
const { buildLlamaMemoryEstimate } = require("./lib/memory-estimate");
const { createLlamaRuntimeCommandBuilder } = require("./lib/runtime-command");
const { createLlamaRemoteModelService } = require("./lib/remote-models");
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
  lastFloatMatch,
  countUniqueCaptures,
  averageCapture,
  normalizeNetworkAccess,
  normalizeKvCacheDtype,
  normalizeClientPreset,
  formatBytes,
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
  createDockerRuntime,
} = core;
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {}

const app = express();
const PORT = Number(process.env.LLAMA_MANAGER_PORT || 5178);
const HOST = process.env.LLAMA_MANAGER_HOST || "127.0.0.1";
const ALLOW_REMOTE_MANAGEMENT = process.env.LLAMA_MANAGER_ALLOW_REMOTE === "1";
const DEFAULT_AI_ROOT = process.env.AI_ROOT || (process.platform === "win32" ? "D:\\AI" : path.join(os.homedir(), "AI"));
const DEFAULT_DEVTOOLS_ROOT = process.env.DEVTOOLS_ROOT || (process.platform === "win32" ? "D:\\DevTools" : "");
const DEFAULT_LLAMA_IMAGE = process.env.LLAMA_IMAGE_DIGEST || "ghcr.io/ggml-org/llama.cpp@sha256:e8d36f4dc2a72a1df323748f6219c9dd11f662f7cb3b06a6b2916c9bf3866d89";
const MANAGER_LABEL_KEY = "ai.manager";
const MANAGER_ENGINE_LABEL_KEY = "ai.manager.engine";

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
  modelsRoot: process.env.LLAMA_MODELS_ROOT || defaultAiPath("models"),
  hfCache: process.env.HF_HOME || defaultAiPath("cache", "huggingface"),
  image: process.env.LLAMA_IMAGE || DEFAULT_LLAMA_IMAGE,
  containerName: process.env.LLAMA_CONTAINER_NAME || "llama-local",
  managerId: process.env.LLAMA_MANAGER_ID || "llama-manager",
  defaultPort: Number(process.env.LLAMA_PORT || 8080),
  startupTimeoutMs: positiveTimeoutMs(process.env.LLAMA_STARTUP_TIMEOUT_MS, 20 * 60 * 1000),
  pidFile: path.join(__dirname, ".manager.pid"),
  statsLedger: path.join(__dirname, "logs", "stats-ledger.json"),
  jobsLedger: path.join(__dirname, "logs", "jobs-ledger.json"),
  downloadSettings: path.join(__dirname, "logs", "download-settings.json"),
  claudeCompressionSettings: path.join(__dirname, "logs", "claude-context-compression.json"),
  launchProfiles: path.join(__dirname, "logs", "launch-profiles.json"),
  modelNotes: path.join(__dirname, "logs", "model-notes.json"),
  automationSettings: path.join(__dirname, "logs", "automation-settings.json"),
  serviceExposureSettings: path.join(__dirname, "logs", "service-exposure-settings.json"),
  serviceClients: path.join(__dirname, "logs", "service-clients.json"),
  serviceUsageDb: path.join(__dirname, "logs", "service-usage.sqlite"),
  serviceGatewayAccessLog: path.join(__dirname, "logs", "service-gateway-access.log"),
  auditRoot: process.env.AI_AUDIT_ROOT || defaultAiPath("audit-logs"),
  openWebuiContainer: process.env.OPEN_WEBUI_CONTAINER || "open-webui",
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
  checkDockerDaemon,
  getImageStatus,
  normalizeDockerContainerName,
  normalizeDockerTimestamp,
  timestampToSeconds,
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

const remoteModelService = createLlamaRemoteModelService();
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
  normalizeOptions: { allowExposeOpenCode: false, exposeOpenCodeDefault: false },
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
} = core.createDockerPublishHelpers({ containerPort: 8080, getLanAddress });

const {
  buildLlamaRuntimeCommand,
  formatDockerPublishArgs,
} = createLlamaRuntimeCommandBuilder({
  CONFIG,
  MANAGER_LABEL_KEY,
  MANAGER_ENGINE_LABEL_KEY,
  appendLog,
  dockerGpuArg,
  dockerPublishArgs,
  publishArgsToDockerRunArgs,
  normalizeGpuIds,
  normalizeDefaultTrueBoolean,
  resolveLaunchModel,
});

const jobs = new Map();
const progressTimers = new Map();
const statsSamples = new Map();
const serviceRateBuckets = new Map();
const serviceConcurrencyBuckets = new Map();
let automationMonitorTimer = null;
let runtimeActivity = {
  initialized: false,
  lastActivityAt: null,
  lastSeenAt: null,
  lastWarnAt: null,
  lastRequestCount: null,
  lastTokenCount: null,
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
  serveDetail: "llama.cpp API 已返回模型列表。",
  stopProgressTracker,
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
  recordClaudeBridgeUsage,
  waitForStatsLedgerWrites,
} = statsLedgerStore;
const AUDIT_PASSWORD_FILE = process.env.AI_AUDIT_PASSWORD_FILE || path.join(CONFIG.auditRoot, "audit-admin-password.txt");
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
  gatewayName: "llama-manager",
  supportedKinds: ["openai", "claude"],
  getServiceExposureSettings,
  getServiceClientsLedger,
  resolveServiceClientForApiKey,
  rateBuckets: serviceRateBuckets,
  concurrencyBuckets: serviceConcurrencyBuckets,
  appendAccessLog: appendServiceGatewayAccessLog,
  corsAllowHeaders: "authorization,content-type,x-api-key,x-requested-with",
});

const { managerSecurityGuard } = core.createManagerSecurityGuard({
  host: HOST,
  getLanAddress,
  isLocalRequest,
  gatewayKinds: ["openai", "claude"],
  allowRemoteManagement: ALLOW_REMOTE_MANAGEMENT,
  blockRemoteReads: false,
  remoteManagementError: "管理操作默认仅允许本机访问。如需远程管理，请设置环境变量 LLAMA_MANAGER_ALLOW_REMOTE=1。",
});

const managerLifecycle = core.createManagerLifecycle({
  app,
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

app.use(managerSecurityGuard);
app.use(express.json({ limit: "32mb" }));
app.use(["/serve/v1", "/claude", "/v1/messages", "/v1/claude"], serviceGatewayMiddleware);
app.use(express.static(path.join(__dirname, "public")));

core.registerManagerRoutes(app, {
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
  getDockerVersion,
  getGpuStatus,
  getContainerStatus,
  getImageStatus,
  getRunningModelSummary,
  getManagerResourceSummary,
  buildMemoryEstimate: buildLlamaMemoryEstimate,
  buildStatusExtras: ({ gpu }) => ({
    gpuPlan: buildLlamaGpuPlan(gpu, [], 0.92, "layer"),
  }),
  collectStats,
  collectExternalAccessStats,
  buildExternalAccessOptions: (query) => ({
    limit: query.limit,
    maxLines: query.maxLines,
  }),
  formatExternalAccessError: (error) => ({ ok: false, error: error.message }),
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
  getUpstreamHeaders: (_runtime, headers = {}) => headers,
  serviceClientAllowsModel: core.serviceClientAllowsModel,
  recordUsage: recordServiceClientGatewayUsage,
  upstreamErrorMessage,
  isExpectedStreamDisconnect,
  setAccessUsage: (req, usage) => {
    if (req) req.serviceGatewayAccessUsage = usage;
  },
});
const benchmarkRunner = core.createBenchmarkRunner({
  defaultPort: CONFIG.defaultPort,
  defaultPrompt: "用中文简要说明本地 llama.cpp 模型是否可以稳定完成工具调用、长上下文和代码任务。",
  runtimeLabel: "llama.cpp",
  requestDetail: "Sending chat completion request to local llama.cpp.",
  getRunningModelSummary,
  upstreamErrorMessage,
  appendLog,
  setJobProgress,
  finishJob,
});
const {
  normalizeBenchmarkRequest,
  runBenchmarkJob,
} = benchmarkRunner;
app.get("/serve/v1/models", openAiGatewayHandlers.handleModels);
app.post("/serve/v1/chat/completions", openAiGatewayHandlers.handleChatCompletions);
app.post("/serve/v1/completions", openAiGatewayHandlers.handleCompletions);

core.registerModelRoutes(app, {
  listModels: listModelCollections,
  searchRemoteModels: remoteModelService.searchRemoteModelCatalog,
  startDownload: startDownloadRequest,
  estimateDownload: estimateDownloadRequest,
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
});

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

async function getModelsDiskFreeBytes() {
  try {
    const stat = await fsp.statfs(CONFIG.modelsRoot);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return Number.isFinite(free) && free > 0 ? free : null;
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
});
const {
  startDockerDesktopRequest,
  readRuntimeLogsRequest,
  testRuntimeCompletionRequest,
} = runtimeRequestHandlers;

const startRuntimeRequest = createLlamaStartRuntimeRequest({
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
  normalizeDefaultTrueBoolean,
  normalizeNetworkAccess,
  getLanAddress,
  getGpuStatus,
  buildLlamaGpuPlan,
  suggestTensorSplit,
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
  checks.push(healthCheck("image", "llama.cpp 镜像", image.ok ? "ok" : "warn", image.ok ? image.text : `${CONFIG.image} not found locally`, image.ok ? [] : ["pull-image"]));
  checks.push(healthCheck("image-pin", "镜像版本", isPinnedImageReference(CONFIG.image) ? "ok" : "warn", CONFIG.image));
  checks.push(healthCheck("container", "llama.cpp 容器", container.running ? "ok" : container.exists ? "warn" : "warn", container.status || (container.exists ? "exists" : "not started")));
  checks.push(healthCheck("api", "OpenAI 兼容 API", runtime?.models?.length ? "ok" : container.running ? "warn" : "warn", runtime?.models?.length ? `${runtime.models.length} model(s) served at ${runtime.endpoint.localUrl}` : "No served model reported yet"));
  checks.push(await directoryHealth("models-root", "模型目录", CONFIG.modelsRoot));
  checks.push(await directoryHealth("hf-cache", "HF 缓存目录", CONFIG.hfCache));
  checks.push(healthCheck("hf-token", "HF Token", process.env.HF_TOKEN ? "ok" : "warn", process.env.HF_TOKEN ? "已配置" : "下载 gated 模型前需要配置 HF_TOKEN"));
  checks.push(await commandHealth("hf-cli", "Hugging Face CLI", CONFIG.hfCli, ["--help"], "warn"));
  checks.push(await commandHealth("modelscope-cli", "ModelScope CLI", CONFIG.modelScopeCli, ["--help"], "warn"));
  checks.push(healthCheck("logs", "最近日志", logs.issues?.some((item) => item.severity === "error") ? "fail" : logs.issues?.length ? "warn" : "ok", logs.stage || "No recent llama.cpp log issues"));

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
    textOnlyMode: normalizeDefaultTrueBoolean(config.textOnlyMode, config.languageModelOnly),
    languageModelOnly: normalizeDefaultTrueBoolean(config.textOnlyMode, config.languageModelOnly),
    multiGpuMode: normalizeLlamaSplitMode(config.multiGpuMode || config.splitMode || "layer"),
    gpuDeviceIds: normalizeGpuIds(config.gpuDeviceIds),
    tensorSplit: cleanOptionalLaunchArg(config.tensorSplit),
    mainGpu: Number(config.mainGpu || 0),
    noMmap: Boolean(config.noMmap),
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

async function checkModelCompatibility(input = {}) {
  const model = cleanRequired(input.model, "model");
  const findings = [];
  const local = describeLocalModelPath(model);
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
        findings.push(finding("ok", "检测到 GGUF", `${local.ggufFiles.length} 个 GGUF 文件，启动时会自动选择最大文件。`));
      } else {
        findings.push(finding("fail", "缺少 GGUF 文件", "目录内没有 .gguf；llama.cpp 无法直接加载 safetensors 目录。"));
      }
      if (local.ggufFiles.length > 1) {
        findings.push(finding("warn", "多个 GGUF", `会优先选择最大文件：${path.basename(local.ggufFiles[0].path)}`));
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
  if (isLikelyMultimodalModel(model)) {
    findings.push(finding("info", "Text-only mode", "llama.cpp only processes images when an mmproj/projector is supplied. Text-only mode keeps this launch as pure text/tool-calling and avoids projector VRAM."));
  }
  if (Number(input.maxModelLen || 0) >= 131072 && !/q4|q5|q8/i.test(String(input.cacheTypeK || input.cacheTypeV || ""))) {
    findings.push(finding("warn", "长上下文 KV 显存", "128K 以上建议 K/V cache 用 q8_0、q5_1 或 q4_0，并把并行槽数降到 1。"));
    recommendations.maxNumSeqs = 1;
    recommendations.cacheTypeK = "q4_0";
    recommendations.cacheTypeV = "q4_0";
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
    runtimeApiKeySupported: false,
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

async function inspectAutomationRules() {
  const settings = await automationSettingsStore.getAutomationSettings();
  if (!settings.idleUnloadEnabled && !settings.vramGuardEnabled) return;
  if (runtimeActivity.unloading) return;
  const [gpu, container] = await Promise.all([getGpuStatus(), getContainerStatus(CONFIG.containerName)]);
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
  const shouldWarn = settings.vramGuardEnabled && settings.vramAction === "warn" && gpuPercent >= settings.vramPercent;
  const shouldIdleUnload = settings.idleUnloadEnabled && idleEnough;
  const shouldVramUnload = settings.vramGuardEnabled && settings.vramAction === "unload" && gpuPercent >= settings.vramPercent && idleMs >= 2 * 60 * 1000 && noActiveKv;
  if (shouldWarn && now - Date.parse(runtimeActivity.lastWarnAt || 0) > 10 * 60 * 1000) {
    runtimeActivity.lastWarnAt = new Date(now).toISOString();
    const job = createJob("automation", "VRAM guard warning", { gpuPercent, threshold: settings.vramPercent });
    appendLog(job, `GPU memory usage ${gpuPercent.toFixed(1)}% exceeded ${settings.vramPercent}%.`);
    finishJob(job, { result: "warn-only" });
  }
  if (shouldIdleUnload || shouldVramUnload) {
    runtimeActivity.unloading = true;
    const reason = shouldIdleUnload ? `Idle for ${Math.round(idleMs / 60000)} minutes` : `VRAM ${gpuPercent.toFixed(1)}% exceeded ${settings.vramPercent}%`;
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

async function handleClaudeModels(_req, res) {
  try {
    const runtime = await getRunningModelSummary();
    if (!runtime.container.running) {
      return res.status(503).json(claudeError("service_unavailable", "Model service is not running."));
    }
    const response = await fetch(`http://127.0.0.1:${runtime.endpoint.port}/v1/models`, {
      signal: AbortSignal.timeout(5000),
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
    const runtime = await getRunningModelSummary();
    if (!runtime.container.running) {
      return res.status(503).json(claudeError("service_unavailable", "Model service is not running."));
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
    const compression = applyClaudeContextCompression(body, runtime, model, compressionSettings);
    const effectiveBody = compression.body;
    const stream = body.stream === true;
    const toolSchemaCount = Array.isArray(body.tools) ? body.tools.length : 0;
    const openAiBody = buildOpenAiBodyFromClaude(effectiveBody, model);
    const fetchOptions = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(openAiBody),
    };
    if (!stream) fetchOptions.signal = AbortSignal.timeout(Number(req.serviceGateway?.timeoutMs || 120000));
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
  return requestedModel;
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
  if (!text || text === "auto" || text === "all") return "999";
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
  return "all";
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
    };
  }

  return {
    modelArg: windowsPathToContainerModel(input),
    effectiveLoadFormat,
    selectedGgufFile: hasGgufFile ? local.path : "",
    ggufFiles: hasGgufFile ? [{ path: local.path, size: local.stat.size }] : [],
  };
}

async function getContainerStatus(containerName) {
  try {
    const out = await docker(["ps", "-a", "--filter", `name=^/${containerName}$`, "--format", "{{json .}}"]);
    const line = out.stdout.trim();
    if (!line) return { exists: false, running: false };
    const info = JSON.parse(line);
    const labels = await getContainerLabels(containerName);
    let createdAt = null;
    let startedAt = null;
    try {
      const inspected = await docker(["inspect", containerName, "--format", "{{.Created}}|{{.State.StartedAt}}"], { rejectOnError: false });
      const [created, started] = inspected.stdout.trim().split("|");
      createdAt = normalizeDockerTimestamp(created);
      startedAt = normalizeDockerTimestamp(started);
    } catch {
      createdAt = null;
      startedAt = null;
    }
    return {
      exists: true,
      running: String(info.State || "").toLowerCase() === "running",
      name: info.Names,
      status: info.Status,
      ports: info.Ports,
      image: info.Image,
      labels,
      createdAt,
      startedAt,
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

async function getServedModels(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2500) });
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
  const servedModels = activeContainer.running ? await getServedModels(endpoint.port) : [];
  const runtimeStats = activeContainer.running
    ? await collectVllmMetricsSummary(activeContainer, gpu, { updateSamples: false }).catch(() => null)
    : null;
  const historicalStats = await loadStatsLedger()
    .then((ledger) => core.statsLedgerToSummary(ledger))
    .catch(() => null);
  const gpuText = gpu?.ok
    ? `${gpu.usedMb}/${gpu.totalMb} MB (${gpu.util}%)`
    : "";
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
      requests: Math.max(Number(modelStats?.requests?.total || 0), Number(historicalModelStats?.requests?.total || 0)),
      promptTokens: Math.max(Number(modelStats?.tokens?.prompt || 0), Number(historicalModelStats?.tokens?.prompt || 0)),
      outputTokens: Math.max(Number(modelStats?.tokens?.generation || 0), Number(historicalModelStats?.tokens?.generation || 0)),
      canUnload: activeContainer.exists,
    };
  });

  return {
    container: activeContainer,
    endpoint,
    servedModels,
    models,
    canUnload: activeContainer.exists,
    unloadStopsContainer: true,
    note: "llama.cpp keeps one model resident in the server process. Unloading from this manager stops the managed llama.cpp container, but leaves the manager and other Docker services alone.",
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
  const liveSummary = await collectVllmMetricsSummary(container, gpu, { updateSamples: true });
  const ledger = await updateStatsLedger(liveSummary);
  const summary = core.mergeLiveAndStatsLedger(liveSummary, ledger);
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
    stoppedNote: "llama.cpp container is not running.",
    missingNote: "No managed llama.cpp container is running.",
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
  const facts = await getLatestRuntimeFacts(factModelHints).catch(() => ({}));
  const servedById = Object.fromEntries(servedModels.map((model) => [model.id, model]));
  const metrics = parsePrometheusMetrics(metricsText);
  const processStartSeconds = firstMetricValue(metrics, "process_start_time_seconds")
    || timestampToSeconds(container.startedAt || container.createdAt)
    || null;
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
    const recent = core.calculateRecentRates(statsSamples, name, nowSeconds, {
      promptTokens,
      generationTokens,
      requestCount,
    }, options.updateSamples !== false);

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
      speed: {
        ...recent,
        recentPromptTokensPerSecond: firstMetricValue(scoped, "llamacpp:prompt_tokens_seconds") || recent.recentPromptTokensPerSecond,
        recentOutputTokensPerSecond: firstMetricValue(scoped, "llamacpp:predicted_tokens_seconds") || recent.recentOutputTokensPerSecond,
        averageOutputTokensPerSecond: firstMetricValue(scoped, "llamacpp:predicted_tokens_seconds")
          || tokensPerSecondFromSeconds(histogramAverage(scoped, "vllm:request_time_per_output_token_seconds")),
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

async function getLatestRuntimeFacts(modelHints = []) {
  const out = await docker(["logs", "--tail", "2000", CONFIG.containerName], { rejectOnError: false });
  const needles = core.normalizeRuntimeFactHints(modelHints);
  const jobText = Array.from(jobs.values())
    .filter((job) => job.type === "serve" && (!needles.length || jobMatchesRuntimeFactHints(job, needles)))
    .map((job) => (job.logs || []).join("\n"))
    .join("\n");
  const latestServe = Array.from(jobs.values()).filter((job) => job.type === "serve").at(-1);
  const text = `${jobText}\n${out.stdout}${out.stderr}`;
  return {
    modelName: latestServe?.meta?.name || null,
    maxContextTokens: Number(latestServe?.meta?.maxModelLen || lastIntegerMatch(text, /(?:n_ctx|ctx-size|ctx_size)\s*[=:]\s*([\d,]+)/gi)) || null,
    parallelSlots: Number(latestServe?.meta?.maxNumSeqs || lastIntegerMatch(text, /(?:n_parallel|parallel)\s*[=:]\s*([\d,]+)/gi)) || null,
    splitMode: latestServe?.meta?.multiGpuMode || null,
    tensorSplit: latestServe?.meta?.tensorSplit || null,
    gpuLayers: latestServe?.meta?.gpuLayers || null,
    kvCacheTokens: lastIntegerMatch(text, /GPU KV cache size:\s*([\d,]+)\s*tokens/gi),
    maxConcurrency: lastFloatMatch(text, /Maximum concurrency for\s*[\d,]+\s*tokens per request:\s*([\d.]+)x/gi),
    modelLoadMemoryGiB: lastFloatMatch(text, /Model loading took\s*([\d.]+)\s*GiB memory/gi),
    modelLoadSeconds: lastFloatMatch(text, /Model loading took\s*[\d.]+\s*GiB memory and\s*([\d.]+)\s*seconds/gi),
    torchCompileSeconds: lastFloatMatch(text, /torch\.compile took\s*([\d.]+)\s*s/gi),
    warmupSeconds: lastFloatMatch(text, /Initial profiling\/warmup run took\s*([\d.]+)\s*s/gi),
    graphCaptureGiB: lastFloatMatch(text, /Graph capturing finished in\s*[\d.]+\s*secs,\s*took\s*([\d.]+)\s*GiB/gi),
    engineInitSeconds: lastFloatMatch(text, /init engine .* took\s*([\d.]+)\s*s/gi),
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
      scheduleJobsSave();
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
    stage: "准备启动",
    detail: "正在准备 llama.cpp 启动任务。",
  });

  setJobProgress(job, {
    percent: 4,
    stage: "检查 Docker",
    detail: "启动模型前先确认 Docker daemon 已经可用。",
  });
  const dockerReady = await checkDockerDaemon();
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
  appendLog(job, `Docker daemon ready: ${dockerReady.version}`);
  for (const warning of opts.gpuWarnings || []) appendLog(job, `GPU selection warning: ${warning}`);

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
    detail: "旧容器已处理，正在生成 llama.cpp 启动命令。",
  });

  let { runArgs, activePublishArgs } = buildLlamaRuntimeCommand(job, opts);

  setJobProgress(job, {
    percent: 32,
    stage: "启动 Docker 容器",
    detail: "Docker run 已开始；如果镜像不存在，这一步会等待拉取镜像。",
  });
  appendLog(job, `> docker ${runArgs.join(" ")}`);
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
    appendLog(job, `> docker ${retryArgs.join(" ")}`);
    launched = await docker(retryArgs);
  }
  appendLog(job, launched.stdout || launched.stderr);

  setJobProgress(job, {
    percent: 45,
    stage: "等待模型加载",
    detail: "容器已创建，正在等待 llama.cpp server 返回 /v1/models。",
  });
  const startupTimeoutMs = CONFIG.startupTimeoutMs;
  return core.waitForRuntimeReady({
    job,
    port: opts.port,
    serviceUrl: opts.serviceUrl,
    engineName: "llama.cpp",
    apiLabel: "llama.cpp API",
    containerName: CONFIG.containerName,
    startupTimeoutMs,
    finalReadyCheck: true,
    timeoutBudgetLog: `Startup timeout budget: ${Math.round(startupTimeoutMs / 60_000)} minutes`,
    fetchServedModels: () => getServedModels(opts.port),
    getContainerStatus,
    docker,
    extractLogIssues,
    setJobProgress,
    appendLog,
    finishJob,
    delayFn: delay,
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
  buildLlamaMemoryEstimate,
};
