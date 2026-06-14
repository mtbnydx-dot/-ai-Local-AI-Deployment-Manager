const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const core = require("../manager-core");
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

const jobs = new Map();
const progressTimers = new Map();
const statsSamples = new Map();
const auditSessions = new Map();
const fileWriteQueues = new Map();
const serviceRateBuckets = new Map();
const serviceConcurrencyBuckets = new Map();
let statsLedgerWriteQueue = Promise.resolve();
let httpServer = null;
let isShuttingDown = false;
let automationSettingsCache = null;
let serviceExposureSettingsCache = null;
let serviceClientsCache = null;
let serviceUsageDb = null;
let automationMonitorTimer = null;
let jobsLedgerWriteQueue = Promise.resolve();
let jobsSaveTimer = null;
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
const AUDIT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUDIT_PASSWORD_FILE = process.env.AI_AUDIT_PASSWORD_FILE || path.join(CONFIG.auditRoot, "audit-admin-password.txt");
const AUDIT_LEGACY_PASSWORD_FILES = [
  path.join(__dirname, "logs", "audit-admin-password.txt"),
];
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
let auditPasswordCache = null;

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

app.use(managerSecurityGuard);
app.use(express.json({ limit: "32mb" }));
app.use(["/serve/v1", "/claude", "/v1/messages", "/v1/claude"], serviceGatewayMiddleware);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  const lanAddress = getLanAddress();
  res.json({
    ...CONFIG,
    managerHost: HOST,
    managerPort: PORT,
    lanAddress,
    hasHfToken: Boolean(process.env.HF_TOKEN),
  });
});

app.get("/api/service-exposure", async (_req, res) => {
  const settings = await getServiceExposureSettings();
  res.json(await buildServiceExposurePayload(settings));
});

app.post("/api/service-exposure", async (req, res) => {
  const current = await getServiceExposureSettings();
  const settings = await saveServiceExposureSettings(req.body || {}, current);
  res.json(await buildServiceExposurePayload(settings));
});

app.get("/api/service-clients", async (_req, res) => {
  res.json(redactServiceClientsLedger(await getServiceClientsLedger()));
});

app.post("/api/service-clients", async (req, res) => {
  const result = await createServiceClient(req.body || {});
  res.json(result);
});

app.patch("/api/service-clients/:id", async (req, res) => {
  res.json(await updateServiceClient(req.params.id, req.body || {}));
});

app.post("/api/service-clients/:id/rotate", async (req, res) => {
  res.json(await rotateServiceClientKey(req.params.id));
});

app.delete("/api/service-clients/:id", async (req, res) => {
  res.json(await deleteServiceClient(req.params.id));
});

app.post("/api/manager/shutdown", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "Shutdown is only available from localhost." });
  res.json({ ok: true, message: "Manager is shutting down. Model services are not touched." });
  const timer = setTimeout(() => {
    shutdownManager("api").catch((error) => {
      console.error(`Manager shutdown failed: ${error.message}`);
      if (require.main === module) process.exit(1);
    });
  }, 50);
  timer.unref?.();
});

app.get("/api/manager/health", async (_req, res) => {
  res.json(await buildManagerHealth("llama"));
});

app.get("/api/external-access", async (req, res) => {
  try {
    res.json(await collectExternalAccessStats({
      limit: req.query.limit,
      maxLines: req.query.maxLines,
    }));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/status", async (_req, res) => {
  const [docker, gpu, container, image] = await Promise.all([
    getDockerVersion(),
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
    getImageStatus(CONFIG.image),
  ]);
  const runtime = await getRunningModelSummary(container, gpu);
  const gpuPlan = buildLlamaGpuPlan(gpu, [], 0.92, "layer");
  const resources = await getManagerResourceSummary(gpu, container);

  res.json({
    docker,
    gpu,
    gpuPlan,
    resources,
    container,
    servedModels: runtime.servedModels,
    runningModels: runtime.models,
    endpoint: runtime.endpoint,
    image,
    jobs: Array.from(jobs.values()).slice(-10).reverse(),
  });
});

app.get("/api/resources", async (_req, res) => {
  const [gpu, container] = await Promise.all([
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
  ]);
  res.json(await getManagerResourceSummary(gpu, container));
});

app.post("/api/memory-estimate", (req, res) => {
  try {
    res.json(buildLlamaMemoryEstimate(req.body || {}));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/running-models", async (_req, res) => {
  const [gpu, container] = await Promise.all([
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
  ]);
  res.json(await getRunningModelSummary(container, gpu));
});

app.get("/api/gpu-plan", async (req, res) => {
  const gpu = await getGpuStatus();
  const gpuDeviceIds = normalizeGpuIds(req.query.gpuDeviceIds || req.query.devices || "");
  const utilization = Number(req.query.gpuMemoryUtilization || req.query.utilization || 0.92);
  const mode = normalizeLlamaSplitMode(req.query.multiGpuMode || req.query.splitMode || "layer");
  res.json(buildLlamaGpuPlan(gpu, gpuDeviceIds, utilization, mode, req.query.mainGpu));
});

app.get("/claude/models", handleClaudeModels);
app.get("/claude/v1/models", handleClaudeModels);
app.get("/v1/claude/models", handleClaudeModels);
app.post("/claude/messages", handleClaudeMessages);
app.post("/claude/v1/messages", handleClaudeMessages);
app.post("/v1/messages", handleClaudeMessages);
app.post("/claude/v1/messages/v1/messages", handleClaudeMessages);
app.post("/claude/messages/count_tokens", handleClaudeCountTokens);
app.post("/claude/v1/messages/count_tokens", handleClaudeCountTokens);
app.post("/v1/messages/count_tokens", handleClaudeCountTokens);
app.get("/serve/v1/models", handleOpenAiGatewayModels);
app.post("/serve/v1/chat/completions", handleOpenAiGatewayChatCompletions);
app.post("/serve/v1/completions", handleOpenAiGatewayCompletions);

app.get("/api/claude/setup", async (_req, res) => {
  try {
    const guide = await buildConnectionGuide();
    res.json({
      ok: true,
      manager: guide.manager,
      claude: guide.claude,
      ccswitch: guide.ccswitch,
      note: "Claude Desktop / ccswitch 使用 Claude 兼容地址；工具 schema 会桥接为 OpenAI tools。",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post("/api/claude/setup", async (_req, res) => {
  try {
    const guide = await buildConnectionGuide();
    res.json({
      ok: true,
      manager: guide.manager,
      claude: guide.claude,
      ccswitch: guide.ccswitch,
      note: "Claude Desktop / ccswitch 使用 Claude 兼容地址；工具 schema 会桥接为 OpenAI tools。",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/claude/context-compression", async (_req, res) => {
  try {
    res.json(await getClaudeCompressionSettings());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/claude/context-compression", async (req, res) => {
  try {
    res.json(await saveClaudeCompressionSettings(req.body || {}));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    res.json(await collectStats());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/models", async (_req, res) => {
  const [local, cached] = await Promise.all([
    listLocalModels(),
    listCachedModels(),
  ]);
  res.json({ local, cached });
});

app.get("/api/remote-models", async (req, res) => {
  try {
    const category = String(req.query.category || "popular");
    const search = String(req.query.search || "").trim();
    const limit = normalizeRemoteLimit(req.query.limit);
    const size = String(req.query.size || "").trim();
    const freshness = String(req.query.freshness || "auto").trim();
    const quant = normalizeRemoteQuantFilter(req.query.quant);
    const models = await searchHuggingFaceModels({ category, search, limit, size, freshness, quant });
    res.json({ source: "huggingface", category, search, limit, size, freshness, quant, models });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/jobs", (_req, res) => {
  res.json(Array.from(jobs.values()).reverse());
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.post("/api/jobs/:id/cancel", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.type !== "download") return res.status(400).json({ error: "只有下载任务支持取消。" });
  try {
    await cancelDownloadJob(job);
    res.json({ ok: true, id: job.id, status: job.status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/jobs/:id/pause", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.type !== "download") return res.status(400).json({ error: "只有下载任务支持暂停。" });
  try {
    pauseDownloadJob(job);
    res.json({ ok: true, id: job.id, status: job.status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/jobs/:id/resume", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.type !== "download") return res.status(400).json({ error: "只有下载任务支持继续。" });
  try {
    const resumed = resumeDownloadJob(job);
    res.json({ ok: true, id: resumed.id, status: resumed.status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/download", async (req, res) => {
  const requestedModel = cleanRequired(req.body.model, "model");
  const source = cleanDownloadSource(req.body.source || "huggingface");
  const reference = normalizeDownloadModelReference(requestedModel, req.body.precision);
  const model = reference.model;
  const precision = reference.precision;
  const outputName = safeOutputName(req.body.outputName || model.replace(/[\\/]/g, "__"));
  const localDir = path.join(CONFIG.modelsRoot, outputName);
  await ensureDirs(CONFIG.modelsRoot, CONFIG.hfCache, localDir);

  const env = buildDownloadEnv();
  if (req.body.hfToken) env.HF_TOKEN = String(req.body.hfToken);

  const download = buildDownloadCommand(source, model, localDir, { precision });
  const expected = source === "huggingface"
    ? await getHuggingFaceDownloadEstimate(model, precision).catch((error) => ({ error: error.message }))
    : null;
  const job = createProcessJob("download", download.command, download.args, {
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
  if (source === "modelscope") {
    appendLog(job, "ModelScope source uses the local modelscope CLI when available.");
  }
  if (download.includePatterns?.length) {
    appendLog(job, `Download include filter: ${download.includePatterns.join(", ")}`);
  }
  res.json({ job });
});

app.post("/api/resolve-model-link", async (req, res) => {
  try {
    const input = cleanRequired(req.body.url, "url");
    const reference = parseModelReference(input);
    if (reference.source === "huggingface") {
      const info = await getHuggingFaceModelInfo(reference.model);
      res.json({
        ...reference,
        ...info,
        outputName: safeOutputName(reference.model.replace(/[\\/]/g, "-")),
      });
      return;
    }
    res.json({
      ...reference,
      label: reference.model,
      url: reference.url,
      tags: [],
      downloads: null,
      likes: null,
      lastModified: null,
      summary: "已从 ModelScope 链接解析出模型 ID。下载时会使用 ModelScope 来源。",
      selection: inferModelSelection({
        id: reference.model,
        author: reference.model.split("/")[0],
        source: "modelscope",
      }),
      outputName: safeOutputName(reference.model.replace(/[\\/]/g, "-")),
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/start", async (req, res) => {
  const model = cleanRequired(req.body.model, "model");
  const name = String(req.body.name || deriveName(model));
  const port = Number(req.body.port || CONFIG.defaultPort);
  const maxModelLen = Number(req.body.maxModelLen || 8192);
  const maxNumSeqs = positiveInt(req.body.maxNumSeqs, 4);
  const gpuMemoryUtilization = Number(req.body.gpuMemoryUtilization || 0.92);
  const gpuLayers = normalizeGpuLayers(req.body.gpuLayers);
  const batchSize = positiveInt(req.body.batchSize, 2048);
  const ubatchSize = positiveInt(req.body.ubatchSize, 512);
  const cacheTypeK = normalizeLlamaCacheType(req.body.cacheTypeK || req.body.kvCacheDtype);
  const cacheTypeV = normalizeLlamaCacheType(req.body.cacheTypeV || req.body.kvCacheDtype);
  const flashAttention = normalizeOnOffAuto(req.body.flashAttention);
  const noMmap = Boolean(req.body.noMmap);
  const gpuSelection = await normalizeLaunchGpuSelection(normalizeGpuIds(req.body.gpuDeviceIds));
  const gpuDeviceIds = gpuSelection.gpuDeviceIds;
  const requestedMultiGpuMode = normalizeLlamaSplitMode(req.body.multiGpuMode || req.body.splitMode);
  const multiGpuMode = gpuSelection.selectedCount < 2 ? "none" : requestedMultiGpuMode;
  const visibleGpuCount = Math.max(1, gpuSelection.selectedCount || gpuDeviceIds.length || Number(req.body.gpuCount || 1));
  const tensorSplit = multiGpuMode === "none" ? "" : cleanOptionalLaunchArg(req.body.tensorSplit);
  const clientPreset = normalizeClientPreset(req.body.clientPreset);
  const reasoning = normalizeOnOffAuto(req.body.reasoning);
  const reasoningFormat = normalizeLlamaReasoningFormat(req.body.reasoningFormat || req.body.reasoningParser);
  const textOnlyMode = normalizeDefaultTrueBoolean(req.body.textOnlyMode, req.body.languageModelOnly);
  const networkAccess = normalizeNetworkAccess(req.body.networkAccess);
  const lanAddress = getLanAddress();
  const serviceHost = networkAccess === "lan" ? lanAddress : "127.0.0.1";
  const serviceUrl = `http://${serviceHost}:${port}/v1`;
  const gpu = await getGpuStatus().catch(() => ({ gpus: [] }));
  const gpuPlan = buildLlamaGpuPlan(gpu, gpuDeviceIds, gpuMemoryUtilization, multiGpuMode, req.body.mainGpu);
  const mainGpu = gpuPlan.mainGpu;
  const effectiveTensorSplit = tensorSplit || suggestTensorSplit(gpu.gpus || [], gpuDeviceIds, gpuMemoryUtilization, multiGpuMode);

  const job = createJob("serve", `Start ${name}`, {
    model,
    name,
    port,
    maxModelLen,
    maxNumSeqs,
    gpuMemoryUtilization,
    gpuLayers,
    batchSize,
    ubatchSize,
    cacheTypeK,
    cacheTypeV,
    flashAttention,
    noMmap,
    gpuDeviceIds,
    multiGpuMode,
    visibleGpuCount,
    tensorSplit: effectiveTensorSplit,
    mainGpu,
    mainGpuHostId: gpuPlan.mainGpuHostId,
    gpuPlan,
    gpuWarnings: gpuSelection.warnings,
    clientPreset,
    reasoning,
    reasoningFormat,
    textOnlyMode,
    languageModelOnly: textOnlyMode,
    networkAccess,
    serviceHost,
    serviceUrl,
  });

  runStartJob(job, {
    model,
    name,
    port,
    maxModelLen,
    maxNumSeqs,
    gpuMemoryUtilization,
    gpuLayers,
    batchSize,
    ubatchSize,
    cacheTypeK,
    cacheTypeV,
    flashAttention,
    noMmap,
    gpuDeviceIds,
    multiGpuMode,
    visibleGpuCount,
    tensorSplit: effectiveTensorSplit,
    mainGpu,
    mainGpuHostId: gpuPlan.mainGpuHostId,
    gpuPlan,
    gpuWarnings: gpuSelection.warnings,
    clientPreset,
    reasoning,
    reasoningFormat,
    textOnlyMode,
    languageModelOnly: textOnlyMode,
    networkAccess,
    serviceHost,
    serviceUrl,
  }).catch((error) => failJob(job, error));

  res.json({ job });
});

app.post("/api/docker/start", async (req, res) => {
  try {
    const running = await docker(["info", "--format", "{{.ServerVersion}}"], { rejectOnError: false });
    if (!running.error && running.stdout.trim()) {
      res.json({ ok: true, alreadyRunning: true, message: "Docker daemon 已经可用。" });
      return;
    }
    if (!CONFIG.dockerDesktopExe || !fs.existsSync(CONFIG.dockerDesktopExe)) {
      const error = new Error("没有找到 Docker Desktop.exe，请检查 Docker Desktop 安装路径。");
      error.status = 404;
      throw error;
    }
    if (String(req.query.dryRun || "") === "1") {
      res.json({
        ok: true,
        dryRun: true,
        exe: CONFIG.dockerDesktopExe,
        message: "Docker Desktop 可由管理器启动。",
      });
      return;
    }
    const child = spawn(CONFIG.dockerDesktopExe, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const readiness = await waitForDockerDaemon(90000);
    res.json({
      ok: readiness.ok,
      alreadyRunning: false,
      exe: CONFIG.dockerDesktopExe,
      ready: readiness.ok,
      serverVersion: readiness.version || null,
      message: "已请求启动 Docker Desktop。Docker 引擎通常需要几十秒完成初始化。",
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/stop", async (_req, res) => {
  try {
    const before = await getRunningModelSummary();
    const result = await stopVllmContainer();
    const audit = await exportOpenWebuiAudit("model-stop", {
      manager: "llama-manager",
      serviceContainer: CONFIG.containerName,
      previousModels: before.models,
      stopResult: result,
    }).catch((error) => ({ ok: false, error: error.message }));
    res.json({ ok: true, ...result, audit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/running-models/unload", async (req, res) => {
  try {
    const modelId = String(req.body.modelId || "").trim();
    const before = await getRunningModelSummary();
    const result = await stopVllmContainer();
    const audit = await exportOpenWebuiAudit("model-unload", {
      manager: "llama-manager",
      serviceContainer: CONFIG.containerName,
      requestedModelId: modelId || null,
      previousModels: before.models,
      unloadResult: result,
    }).catch((error) => ({ ok: false, error: error.message }));
    res.json({
      ok: true,
      modelId: modelId || null,
      unloaded: result.removed,
      containerName: CONFIG.containerName,
      previousModels: before.models,
      audit,
      note: "llama.cpp server does not hot-unload a model from the current server process; this stops only the llama.cpp container managed by this tool.",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/audit/status", async (_req, res) => {
  try {
    await getAuditPassword();
    const container = await getContainerStatus(CONFIG.openWebuiContainer);
    res.json({
      ok: true,
      auditRoot: CONFIG.auditRoot,
      passwordFile: AUDIT_PASSWORD_FILE,
      requiresPassword: true,
      openWebuiContainer: CONFIG.openWebuiContainer,
      container,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/audit/login", async (req, res) => {
  try {
    const valid = await verifyAuditPassword(String(req.body?.password || ""));
    if (!valid) {
      return res.status(401).json({ error: "审计密码不正确。" });
    }
    const session = createAuditSession();
    res.json({ ok: true, ...session });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/audit/logout", async (req, res) => {
  const auth = getAuditAuth(req);
  if (auth.token) auditSessions.delete(hashText(auth.token));
  res.json({ ok: true });
});

app.get("/api/audit/exports", async (req, res) => {
  const auth = requireAuditAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
  try {
    res.json({ ok: true, auditRoot: CONFIG.auditRoot, exports: await listAuditExports() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/audit/exports/:auditId/markdown", async (req, res) => {
  const auth = requireAuditAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
  try {
    const file = await getAuditMarkdownPath(req.params.auditId);
    res.type("text/markdown; charset=utf-8");
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/audit/export", async (req, res) => {
  const auth = requireAuditAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
  try {
    const audit = await exportOpenWebuiAudit("manual", {
      manager: "llama-manager",
      requestedBy: "local-admin",
      note: String(req.body?.note || ""),
    });
    res.json(audit);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/logs", async (req, res) => {
  const tail = String(req.query.tail || "200");
  try {
    const out = await docker(["logs", "--tail", tail, CONFIG.containerName], { rejectOnError: false });
    res.type("text/plain").send(`${out.stdout}${out.stderr}`);
  } catch (error) {
    res.status(500).type("text/plain").send(error.message);
  }
});

app.post("/api/test", async (req, res) => {
  const port = Number(req.body.port || CONFIG.defaultPort);
  const model = cleanRequired(req.body.model, "model");
  const prompt = String(req.body.prompt || "Reply with exactly: llama.cpp OK");
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 256,
      }),
    });
    const text = await response.text();
    res.status(response.status).type("application/json").send(text);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/tools/health", async (_req, res) => {
  try {
    res.json(await collectHealthReport());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/tools/profiles", async (_req, res) => {
  try {
    res.json(await getLaunchProfiles());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tools/profiles", async (req, res) => {
  try {
    res.json(await saveLaunchProfile(req.body || {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.delete("/api/tools/profiles/:id", async (req, res) => {
  try {
    res.json(await deleteLaunchProfile(req.params.id));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/tools/model-check", async (req, res) => {
  try {
    res.json(await checkModelCompatibility(req.body || {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/tools/log-summary", async (req, res) => {
  try {
    res.json(await summarizeRuntimeLogs({ tail: Number(req.query.tail || 420) }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/tools/automation-settings", async (_req, res) => {
  try {
    res.json(await getAutomationSettings());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tools/automation-settings", async (req, res) => {
  try {
    res.json(await saveAutomationSettings(req.body || {}));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tools/benchmark", async (req, res) => {
  try {
    const job = createJob("benchmark", "Benchmark local llama.cpp model", normalizeBenchmarkRequest(req.body || {}));
    runBenchmarkJob(job, job.meta).catch((error) => failJob(job, error));
    res.json({ job });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/download/verify", async (req, res) => {
  try {
    res.json(await verifyDownloadedModel(req.body || {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/connection-guide", async (_req, res) => {
  try {
    res.json(await buildConnectionGuide());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/claude/context-compression/insights", async (_req, res) => {
  try {
    res.json(await buildClaudeCompressionInsights());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/tools/model-notes", async (_req, res) => {
  try {
    res.json(await getModelNotes());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tools/model-notes", async (req, res) => {
  try {
    res.json(await saveModelNote(req.body || {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.delete("/api/tools/model-notes/:id", async (req, res) => {
  try {
    res.json(await deleteModelNote(req.params.id));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

async function startManager() {
  await ensureDirs(CONFIG.modelsRoot, CONFIG.hfCache, path.dirname(CONFIG.statsLedger), path.dirname(CONFIG.jobsLedger));
  await preparePidFile("llama.cpp Manager");
  await loadJobsLedgerIntoMemory();
  await writePidFile();
  startAutomationMonitor();
  httpServer = app.listen(PORT, HOST, () => {
    console.log(`llama.cpp Manager listening on http://${HOST}:${PORT}`);
  });
  return httpServer;
}

if (require.main === module) {
  startManager().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  process.once("SIGINT", () => shutdownManager("SIGINT").catch((error) => console.error(error)));
  process.once("SIGTERM", () => shutdownManager("SIGTERM").catch((error) => console.error(error)));
}

async function buildManagerHealth(engine) {
  const pidFilePid = await readPidFilePid(CONFIG.pidFile);
  return {
    ok: true,
    engine,
    managerId: CONFIG.managerId,
    host: HOST,
    port: PORT,
    currentPid: process.pid,
    pidFile: CONFIG.pidFile,
    pidFilePid,
    pidFileAlive: pidFilePid ? isProcessAlive(pidFilePid) : false,
    pidFileMatches: pidFilePid === process.pid,
    stalePidFile: Boolean(pidFilePid && pidFilePid !== process.pid && !isProcessAlive(pidFilePid)),
    uptimeSeconds: process.uptime(),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

async function preparePidFile(label) {
  await ensureDirs(path.dirname(CONFIG.pidFile));
  const pid = await readPidFilePid(CONFIG.pidFile);
  if (!pid) {
    await fsp.unlink(CONFIG.pidFile).catch(() => {});
    return;
  }
  if (pid !== process.pid && !isProcessAlive(pid)) {
    console.warn(`${label} removing stale pid file for dead process ${pid}.`);
    await fsp.unlink(CONFIG.pidFile).catch(() => {});
  }
}

async function writePidFile() {
  await ensureDirs(path.dirname(CONFIG.pidFile));
  await fsp.writeFile(CONFIG.pidFile, `${process.pid}\n`, "utf8");
}

async function readPidFilePid(file) {
  try {
    const text = (await fsp.readFile(file, "utf8")).trim();
    const pid = Number(text.split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function removePidFile() {
  try {
    const current = (await fsp.readFile(CONFIG.pidFile, "utf8")).trim();
    if (current === String(process.pid)) await fsp.unlink(CONFIG.pidFile);
  } catch {}
}

async function closeHttpServer() {
  if (!httpServer) return;
  await new Promise((resolve) => httpServer.close(resolve));
  httpServer = null;
}

async function shutdownManager(signal = "shutdown") {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`llama.cpp Manager shutting down (${signal})`);
  if (jobsSaveTimer) clearTimeout(jobsSaveTimer);
  if (automationMonitorTimer) clearInterval(automationMonitorTimer);
  for (const timer of progressTimers.values()) clearInterval(timer);
  progressTimers.clear();
  await saveJobsLedgerNow().catch((error) => console.warn(`Unable to save jobs ledger during shutdown: ${error.message}`));
  await Promise.allSettled([
    statsLedgerWriteQueue,
    jobsLedgerWriteQueue,
    ...Array.from(fileWriteQueues.values()),
  ]);
  await removePidFile();
  await closeHttpServer();
  if (require.main === module) process.exit(0);
}

function firstExisting(candidates) {
  const valid = candidates.filter(Boolean);
  for (const candidate of valid) {
    if (looksLikePath(candidate) && fs.existsSync(candidate)) return candidate;
  }
  return valid[valid.length - 1] || "";
}

function looksLikePath(value) {
  const text = String(value || "");
  if (!text) return false;
  return path.isAbsolute(text) || /[\\/]/.test(text);
}

function isLocalRequest(req) {
  const address = String(req?.socket?.remoteAddress || "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

let allowedHostnamesCache = { value: null, expiresAt: 0 };

function allowedRequestHostnames() {
  if (allowedHostnamesCache.value && allowedHostnamesCache.expiresAt > Date.now()) {
    return allowedHostnamesCache.value;
  }
  const names = new Set(["127.0.0.1", "localhost", "::1", String(HOST).toLowerCase()]);
  try {
    names.add(String(getLanAddress()).toLowerCase());
  } catch {}
  allowedHostnamesCache = { value: names, expiresAt: Date.now() + 60000 };
  return names;
}

function extractHostname(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
      .hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

function managerSecurityGuard(req, res, next) {
  const hostname = extractHostname(req.headers.host);
  if (!hostname || !allowedRequestHostnames().has(hostname)) {
    return res.status(403).json({ error: `请求的 Host 不在白名单内：${hostname || "(空)"}` });
  }
  const localRequest = isLocalRequest(req);
  if (!localRequest && getServiceGatewayKind(req)) {
    return next();
  }
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!mutating) return next();
  const origin = String(req.headers.origin || "").trim();
  if (origin) {
    const originHost = extractHostname(origin);
    if (origin === "null" || !originHost || !allowedRequestHostnames().has(originHost)) {
      return res.status(403).json({ error: "跨站请求被拒绝（Origin 校验失败）。" });
    }
  }
  if (!ALLOW_REMOTE_MANAGEMENT && !localRequest) {
    return res.status(403).json({
      error: "管理操作默认仅允许本机访问。如需远程管理，请设置环境变量 LLAMA_MANAGER_ALLOW_REMOTE=1。",
    });
  }
  next();
}

function isPinnedImageReference(image) {
  const text = String(image || "");
  if (/@sha256:[a-f0-9]{64}$/i.test(text)) return true;
  const tagMatch = text.match(/:([^:/@]+)$/);
  if (!tagMatch) return false;
  return !/^(latest|main|nightly|cuda|server|server-cuda)$/i.test(tagMatch[1]);
}

function defaultAiPath(...parts) {
  return path.join(DEFAULT_AI_ROOT, ...parts);
}

function defaultDevToolsPath(...parts) {
  return DEFAULT_DEVTOOLS_ROOT ? path.join(DEFAULT_DEVTOOLS_ROOT, ...parts) : "";
}

async function ensureDirs(...dirs) {
  await Promise.all(dirs.map((dir) => fsp.mkdir(dir, { recursive: true })));
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  return withFileWriteQueue(file, () => atomicWriteJsonFile(file, value));
}

function withFileWriteQueue(file, task) {
  const key = path.resolve(file);
  const previous = fileWriteQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  fileWriteQueues.set(key, next.finally(() => {
    if (fileWriteQueues.get(key) === next) fileWriteQueues.delete(key);
  }));
  return next;
}

async function atomicWriteJsonFile(file, value) {
  await ensureDirs(path.dirname(file));
  return withFileLock(file, async () => {
    const name = path.basename(file);
    const temp = path.join(path.dirname(file), `.${name}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsp.rename(temp, file);
    return value;
  });
}

async function withFileLock(file, task) {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      await fsp.mkdir(lockDir);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() > deadline) throw error;
      await removeStaleLock(lockDir, 30000);
      await delay(50);
    }
  }
  try {
    return await task();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function removeStaleLock(lockDir, maxAgeMs) {
  try {
    const stat = await fsp.stat(lockDir);
    if (Date.now() - stat.mtimeMs > maxAgeMs) await fsp.rm(lockDir, { recursive: true, force: true });
  } catch {}
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

function healthCheck(id, label, status, detail, actions = []) {
  return { id, label, status, detail: String(detail || ""), actions };
}

async function directoryHealth(id, label, dir) {
  try {
    await ensureDirs(dir);
    await fsp.access(dir, fs.constants.R_OK | fs.constants.W_OK);
    return healthCheck(id, label, "ok", dir);
  } catch (error) {
    return healthCheck(id, label, "fail", `${dir}: ${error.message}`);
  }
}

async function commandHealth(id, label, command, args = ["--help"], missingStatus = "fail") {
  if (!command) return healthCheck(id, label, missingStatus, "未配置命令路径");
  try {
    const out = await execFileAsync(command, args, { rejectOnError: false, timeout: 8000, maxBuffer: 256 * 1024 });
    const text = `${out.stdout}${out.stderr}`.trim().split(/\r?\n/)[0] || command;
    return healthCheck(id, label, out.error ? "warn" : "ok", text);
  } catch (error) {
    return healthCheck(id, label, missingStatus, error.message);
  }
}

async function getLaunchProfiles() {
  const saved = await readJsonFile(CONFIG.launchProfiles, { version: 1, profiles: [] });
  const userProfiles = Array.isArray(saved.profiles) ? saved.profiles.map(normalizeLaunchProfile).filter(Boolean) : [];
  return {
    version: 1,
    updatedAt: saved.updatedAt || null,
    builtin: defaultLaunchProfiles(),
    profiles: userProfiles,
  };
}

async function saveLaunchProfile(input) {
  const profile = normalizeLaunchProfile({
    ...input,
    id: input.id || safeProfileId(input.name || input.label || input.config?.name || "profile"),
    source: "user",
    updatedAt: new Date().toISOString(),
  });
  if (!profile) {
    const error = new Error("profile name is required");
    error.status = 400;
    throw error;
  }
  const ledger = await readJsonFile(CONFIG.launchProfiles, { version: 1, profiles: [] });
  const profiles = (Array.isArray(ledger.profiles) ? ledger.profiles : [])
    .map(normalizeLaunchProfile)
    .filter(Boolean)
    .filter((item) => item.id !== profile.id);
  profiles.unshift(profile);
  await writeJsonFile(CONFIG.launchProfiles, {
    version: 1,
    updatedAt: new Date().toISOString(),
    profiles: profiles.slice(0, 40),
  });
  return { ok: true, profile };
}

async function deleteLaunchProfile(id) {
  const target = String(id || "").trim();
  if (!target) {
    const error = new Error("profile id is required");
    error.status = 400;
    throw error;
  }
  const ledger = await readJsonFile(CONFIG.launchProfiles, { version: 1, profiles: [] });
  const before = Array.isArray(ledger.profiles) ? ledger.profiles.length : 0;
  const profiles = (Array.isArray(ledger.profiles) ? ledger.profiles : []).filter((item) => item?.id !== target);
  await writeJsonFile(CONFIG.launchProfiles, { version: 1, updatedAt: new Date().toISOString(), profiles });
  return { ok: true, removed: before - profiles.length, id: target };
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
  return [
    {
      id: "llama-96gb-single-256k",
      name: "96GB 单卡 256K",
      description: "RTX PRO 6000 / 80GB+ 单卡优先方案：不传 tensor-split，低并发长上下文，适合本地 Claude。",
      source: "builtin",
      config: normalizeLaunchConfig({
        maxModelLen: 262144,
        maxNumSeqs: 1,
        gpuMemoryUtilization: 0.9,
        cacheTypeK: "q4_0",
        cacheTypeV: "q4_0",
        clientPreset: "claude-cowork",
        reasoning: "auto",
        reasoningFormat: "deepseek",
        textOnlyMode: true,
        multiGpuMode: "none",
        gpuDeviceIds: ["0"],
        tensorSplit: "",
        mainGpu: 0,
      }),
    },
    {
      id: "llama-hetero-64k-safe",
      name: "Claude 64K 稳妥异构",
      description: "异构多卡本地 Claude 单路优先，layer 分层，速度和稳定性比较均衡。",
      source: "builtin",
      config: normalizeLaunchConfig({
        maxModelLen: 65536,
        maxNumSeqs: 2,
        gpuMemoryUtilization: 0.9,
        cacheTypeK: "q8_0",
        cacheTypeV: "q8_0",
        clientPreset: "claude-cowork",
        reasoning: "auto",
        reasoningFormat: "deepseek",
        textOnlyMode: true,
        multiGpuMode: "layer",
        gpuDeviceIds: ["0", "1"],
        tensorSplit: "22,8",
        mainGpu: 0,
      }),
    },
    {
      id: "llama-hetero-256k-max",
      name: "Claude 256K 极限上下文",
      description: "牺牲并发换上下文，KV cache 用 q4_0，建议先单路使用。",
      source: "builtin",
      config: normalizeLaunchConfig({
        maxModelLen: 262144,
        maxNumSeqs: 1,
        gpuMemoryUtilization: 0.94,
        cacheTypeK: "q4_0",
        cacheTypeV: "q4_0",
        clientPreset: "claude-cowork",
        reasoning: "auto",
        reasoningFormat: "deepseek",
        textOnlyMode: true,
        multiGpuMode: "layer",
        gpuDeviceIds: ["0", "1"],
        tensorSplit: "28,15",
        mainGpu: 0,
      }),
    },
    {
      id: "llama-openwebui-daily",
      name: "OpenWebUI 日常聊天",
      description: "适合网页聊天和轻并发，保留较好的响应速度。",
      source: "builtin",
      config: normalizeLaunchConfig({
        maxModelLen: 32768,
        maxNumSeqs: 4,
        gpuMemoryUtilization: 0.9,
        cacheTypeK: "q8_0",
        cacheTypeV: "q8_0",
        clientPreset: "openwebui",
        textOnlyMode: true,
        multiGpuMode: "layer",
      }),
    },
    {
      id: "llama-single-gpu-debug",
      name: "单卡排错模式",
      description: "启动失败时先用单卡验证模型、路径和 GGUF 文件。",
      source: "builtin",
      config: normalizeLaunchConfig({
        maxModelLen: 16384,
        maxNumSeqs: 1,
        gpuMemoryUtilization: 0.82,
        cacheTypeK: "q8_0",
        cacheTypeV: "q8_0",
        clientPreset: "generic",
        textOnlyMode: true,
        multiGpuMode: "none",
        gpuDeviceIds: ["0"],
        mainGpu: 0,
      }),
    },
  ];
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

  let remote = null;
  if (!local && /^[\w.-]+\/[\w.-]+/.test(model) && input.remote !== false) {
    remote = await getHuggingFaceModelInfo(model.split(":")[0]).catch((error) => ({ error: error.message }));
    if (remote?.error) findings.push(finding("warn", "远程元数据未取到", remote.error));
    else {
      findings.push(finding("ok", "Hugging Face 元数据可用", `${remote.label || model} · ${remote.lastModified || ""}`));
      if (remote.gated) findings.push(finding("warn", "gated 模型", "下载和启动前需要配置 HF_TOKEN。"));
      if (!remote.hasGguf && !looksLikeGgufReference(model)) findings.push(finding("warn", "未发现 GGUF 标记", "优先搜索该模型的 GGUF 量化分支再用 llama.cpp。"));
    }
  }

  const severityRank = { fail: 3, warn: 2, info: 1, ok: 0 };
  const worst = findings.reduce((current, item) => severityRank[item.severity] > severityRank[current] ? item.severity : current, "ok");
  return {
    ok: worst !== "fail",
    severity: worst,
    model,
    generatedAt: new Date().toISOString(),
    findings,
    recommendations,
    remote,
  };
}

function finding(severity, title, detail) {
  return { severity, title, detail: String(detail || "") };
}

function inferLlamaReasoningFormat(model) {
  const text = String(model || "").toLowerCase();
  if (text.includes("qwen") || text.includes("deepseek")) return "deepseek";
  return "none";
}

async function summarizeRuntimeLogs(options = {}) {
  const tail = String(Math.min(2000, Math.max(40, Number(options.tail || 420))));
  const out = await docker(["logs", "--tail", tail, CONFIG.containerName], { rejectOnError: false, maxBuffer: 8 * 1024 * 1024 });
  const text = `${out.stdout}${out.stderr}`;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const issues = extractLogIssues(text).map((message) => ({
    severity: /out of memory|traceback|fatal|runtimeerror|failed|exception|cuda error/i.test(message) ? "error" : "warn",
    message,
    hint: llamaLogIssueHint(message),
  }));
  const stage = detectLlamaLogStage(text);
  return {
    ok: !issues.some((item) => item.severity === "error"),
    generatedAt: new Date().toISOString(),
    stage,
    lineCount: lines.length,
    issues,
    recent: lines.slice(-12),
    suggestions: buildLlamaLogSuggestions(issues, stage),
  };
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

async function getAutomationSettings() {
  if (automationSettingsCache) return automationSettingsCache;
  automationSettingsCache = normalizeAutomationSettings(await readJsonFile(CONFIG.automationSettings, {}));
  return automationSettingsCache;
}

async function saveAutomationSettings(value) {
  automationSettingsCache = normalizeAutomationSettings(value);
  await writeJsonFile(CONFIG.automationSettings, automationSettingsCache);
  return automationSettingsCache;
}

function normalizeAutomationSettings(value = {}) {
  const item = value && typeof value === "object" ? value : {};
  return {
    idleUnloadEnabled: Boolean(item.idleUnloadEnabled),
    idleMinutes: Math.min(1440, Math.max(5, Number(item.idleMinutes || 30))),
    vramGuardEnabled: Boolean(item.vramGuardEnabled),
    vramPercent: Math.min(99, Math.max(70, Number(item.vramPercent || 94))),
    vramAction: new Set(["warn", "unload"]).has(String(item.vramAction || "")) ? String(item.vramAction) : "warn",
    updatedAt: new Date().toISOString(),
  };
}

async function getServiceExposureSettings() {
  if (serviceExposureSettingsCache) return serviceExposureSettingsCache;
  const raw = await readJsonFile(CONFIG.serviceExposureSettings, {});
  serviceExposureSettingsCache = normalizeServiceExposureSettings(raw);
  if (raw && typeof raw === "object" && raw.apiKey) {
    await writeJsonFile(CONFIG.serviceExposureSettings, serviceExposureSettingsCache).catch(() => {});
  }
  return serviceExposureSettingsCache;
}

async function saveServiceExposureSettings(value = {}, previous = {}) {
  serviceExposureSettingsCache = normalizeServiceExposureSettings(value, previous);
  await writeJsonFile(CONFIG.serviceExposureSettings, serviceExposureSettingsCache);
  return serviceExposureSettingsCache;
}

function normalizeServiceExposureSettings(value = {}, previous = {}) {
  const mode = normalizeExposureMode(value.exposureMode || value.mode || previous.exposureMode);
  const apiKeySecret = normalizeServiceExposureSecret(value, previous);
  return {
    version: 1,
    enabled: value.enabled !== undefined ? Boolean(value.enabled) : Boolean(previous.enabled),
    exposureMode: mode,
    requireApiKey: value.requireApiKey !== undefined ? Boolean(value.requireApiKey) : mode !== "local",
    apiKey: "",
    apiKeyHash: apiKeySecret.hash,
    apiKeyPreview: apiKeySecret.preview,
    exposeOpenAI: value.exposeOpenAI !== undefined ? Boolean(value.exposeOpenAI) : previous.exposeOpenAI !== false,
    exposeClaude: value.exposeClaude !== undefined ? Boolean(value.exposeClaude) : previous.exposeClaude !== false,
    exposeOpenCode: false,
    exposeMetrics: Boolean(value.exposeMetrics !== undefined ? value.exposeMetrics : previous.exposeMetrics),
    allowManagerRemote: Boolean(value.allowManagerRemote !== undefined ? value.allowManagerRemote : previous.allowManagerRemote),
    publicBaseUrl: normalizeUrlText(value.publicBaseUrl !== undefined ? value.publicBaseUrl : previous.publicBaseUrl),
    allowedOrigins: normalizeCsvList(value.allowedOrigins !== undefined ? value.allowedOrigins : previous.allowedOrigins).slice(0, 20),
    rateLimitRpm: clampNumber(value.rateLimitRpm !== undefined ? value.rateLimitRpm : previous.rateLimitRpm, 1, 5000, 120),
    maxConcurrentRequests: clampNumber(value.maxConcurrentRequests !== undefined ? value.maxConcurrentRequests : previous.maxConcurrentRequests, 1, 256, 4),
    requestTimeoutSeconds: clampNumber(value.requestTimeoutSeconds !== undefined ? value.requestTimeoutSeconds : previous.requestTimeoutSeconds, 10, 7200, 600),
    notes: String(value.notes !== undefined ? value.notes : previous.notes || "").slice(0, 2000),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeServiceExposureSecret(value = {}, previous = {}) {
  if (value.clearApiKey) return { hash: "", preview: "" };
  if (value.apiKey !== undefined) {
    const key = String(value.apiKey || "").trim();
    return key ? { hash: hashServiceApiKey(key), preview: previewServiceApiKey(key) } : { hash: "", preview: "" };
  }
  const previousHash = String(previous.apiKeyHash || "").trim();
  if (previousHash) return { hash: previousHash, preview: String(previous.apiKeyPreview || "") };
  const legacyKey = String(previous.apiKey || "").trim();
  return legacyKey ? { hash: hashServiceApiKey(legacyKey), preview: previewServiceApiKey(legacyKey) } : { hash: "", preview: "" };
}

function normalizeExposureMode(value) {
  const mode = String(value || "local").toLowerCase();
  return ["local", "lan", "reverse-proxy"].includes(mode) ? mode : "local";
}

function normalizeCsvList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
  return Array.from(new Set(raw.map((item) => String(item || "").trim()).filter(Boolean)));
}

function normalizeUrlText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.toString().replace(/\/$/, "") : "";
  } catch {
    return "";
  }
}

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
  return {
    settings: redactServiceExposureSettings(settings),
    actual: {
      manager: {
        localBaseUrl: `http://127.0.0.1:${PORT}`,
        lanBaseUrl: HOST === "127.0.0.1" ? null : `http://${getLanAddress()}:${PORT}`,
        host: HOST,
        port: PORT,
        remoteManagementAllowed: ALLOW_REMOTE_MANAGEMENT,
      },
      service: {
        running: Boolean(container.running),
        containerStatus: container.status || "",
        boundHost: endpoint.boundHost || "127.0.0.1",
        localHost: endpoint.localHost || "127.0.0.1",
        lanHost: endpoint.lanHost || null,
        dockerPublishedHosts: endpoint.publishedHosts || [],
        port: endpoint.port || CONFIG.defaultPort,
        openAiGatewayLocalBaseUrl: `http://127.0.0.1:${PORT}/serve/v1`,
        openAiGatewayLanBaseUrl: HOST === "127.0.0.1" ? null : `http://${getLanAddress()}:${PORT}/serve/v1`,
        openAiLocalBaseUrl: endpoint.compat?.openai?.baseUrl || endpoint.localUrl,
        openAiLanBaseUrl: endpoint.compat?.openai?.lanBaseUrl || null,
        claudeLocalMessagesUrl: endpoint.compat?.claude?.messagesUrl || `http://127.0.0.1:${PORT}/claude/messages`,
        claudePublicBaseUrl: endpoint.compat?.claude?.publicBaseUrl || null,
        openCodeBaseUrl: "",
        modelIds: (runtime.servedModels || []).map((model) => model.id).filter(Boolean),
        maxModelLen: runtime.servedModels?.[0]?.max_model_len || runtime.models?.[0]?.maxModelLen || null,
        apiKeyRequired: false,
        clients: {
          total: clientsLedger.clients?.length || 0,
          active: (clientsLedger.clients || []).filter((client) => client.enabled !== false).length,
        },
      },
      docker,
    },
    checks: buildServiceExposureChecks(settings, { docker, container, endpoint, clientsLedger }),
  };
}

function redactServiceExposureSettings(settings) {
  return {
    ...settings,
    apiKey: "",
    apiKeyHash: "",
    hasApiKey: hasGlobalServiceApiKey(settings),
    apiKeyPreview: String(settings.apiKeyPreview || ""),
  };
}

function buildServiceExposureChecks(settings, context) {
  const checks = [];
  const mode = settings.exposureMode;
  const serviceRunning = Boolean(context.container?.running);
  const lanBound = Boolean(context.endpoint?.lanUrl);
  const gatewayApiKeyActive = Boolean(settings.requireApiKey && (hasGlobalServiceApiKey(settings) || hasActiveServiceClients(context.clientsLedger || {})));
  checks.push(serviceCheck(serviceRunning ? "ok" : "warn", "模型服务状态", serviceRunning ? "模型服务正在运行。" : "当前没有运行中的模型服务，保存设置后仍需要启动模型。"));
  checks.push(serviceCheck(context.docker?.ok ? "ok" : "fail", "Docker", context.docker?.ok ? "Docker daemon 可用。" : "Docker 不可用，无法对外提供服务。"));
  if (mode === "local") {
    checks.push(serviceCheck(!lanBound ? "ok" : "warn", "网络绑定", lanBound ? `当前 Docker 容器已经发布到 ${context.endpoint?.lanHost || getLanAddress()}，局域网可访问。` : "当前只绑定本机，适合个人客户端。"));
  } else {
    checks.push(serviceCheck(lanBound ? "ok" : "warn", "局域网访问", lanBound ? `Docker 已把容器端口转发到本机地址 ${context.endpoint?.lanHost || getLanAddress()}。` : "需要在启动表单里把服务访问范围改为“局域网设备可访问”并重启模型。"));
    checks.push(serviceCheck(gatewayApiKeyActive ? "ok" : "fail", "API Key", gatewayApiKeyActive ? "管理器网关会强制 Bearer Token；对外推荐使用 /serve/v1 或 /claude。" : "计划对外提供服务，但尚未配置可执行的 API Key。"));
    if (lanBound) {
      checks.push(serviceCheck("warn", "直连容器端口", "llama.cpp 容器 LAN 端口不经过管理器网关鉴权；对外用户应连接管理器 /serve/v1，或放在反向代理鉴权后面。"));
    }
  }
  if (mode === "reverse-proxy") {
    checks.push(serviceCheck(settings.publicBaseUrl ? "ok" : "warn", "公网入口", settings.publicBaseUrl ? "已填写公网/反代地址。" : "反代模式需要填写 public base URL，建议由 Caddy/Nginx/Cloudflare Tunnel 处理 TLS 和鉴权。"));
  }
  if (settings.allowManagerRemote && !ALLOW_REMOTE_MANAGEMENT) {
    checks.push(serviceCheck("warn", "远程管理", "设置页计划开放管理器桥接，但当前进程未设置 LLAMA_MANAGER_ALLOW_REMOTE=1。"));
  }
  checks.push(serviceCheck(settings.rateLimitRpm <= 600 ? "ok" : "warn", "网关限流", `管理器网关强制 ${settings.rateLimitRpm} req/min、最大并发 ${settings.maxConcurrentRequests}；直连容器端口不受此限制。`));
  return checks;
}

function serviceCheck(status, title, detail) {
  return { status, title, detail };
}

async function getServiceClientsLedger() {
  if (serviceClientsCache) return serviceClientsCache;
  serviceClientsCache = normalizeServiceClientsLedger(await readJsonFile(CONFIG.serviceClients, {}));
  return serviceClientsCache;
}

async function saveServiceClientsLedger(ledger) {
  serviceClientsCache = normalizeServiceClientsLedger({
    ...ledger,
    updatedAt: new Date().toISOString(),
  });
  await writeJsonFile(CONFIG.serviceClients, serviceClientsCache);
  persistServiceClientsToSqlite(serviceClientsCache).catch(() => {});
  return serviceClientsCache;
}

function normalizeServiceClientsLedger(value = {}) {
  const item = value && typeof value === "object" ? value : {};
  const clients = Array.isArray(item.clients) ? item.clients.map(normalizeServiceClient).filter(Boolean) : [];
  return {
    version: 1,
    updatedAt: item.updatedAt || null,
    clients,
  };
}

function normalizeServiceClient(value = {}) {
  const item = value && typeof value === "object" ? value : {};
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id: clipText(id, 80),
    name: clipText(item.name || id, 80),
    enabled: item.enabled !== false,
    keyHash: String(item.keyHash || ""),
    keyPreview: String(item.keyPreview || ""),
    allowedModels: normalizeCsvList(item.allowedModels).slice(0, 24),
    rateLimitRpm: clampNumber(item.rateLimitRpm, 1, 5000, 120),
    maxConcurrentRequests: clampNumber(item.maxConcurrentRequests, 1, 256, 4),
    requestTimeoutSeconds: clampNumber(item.requestTimeoutSeconds, 10, 7200, 600),
    expiresAt: normalizeDateText(item.expiresAt),
    notes: clipText(item.notes || "", 500),
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    lastUsedAt: item.lastUsedAt || null,
    usage: normalizeServiceClientUsage(item.usage),
  };
}

function normalizeServiceClientUsage(value = {}) {
  const item = value && typeof value === "object" ? value : {};
  return {
    requests: {
      total: Number(item.requests?.total || 0),
      success: Number(item.requests?.success || 0),
      error: Number(item.requests?.error || 0),
    },
    tokens: {
      prompt: Number(item.tokens?.prompt || 0),
      generation: Number(item.tokens?.generation || 0),
      total: Number(item.tokens?.total || 0),
    },
    lastStatus: Number(item.lastStatus || 0),
    lastModel: item.lastModel || "",
    lastAt: item.lastAt || null,
  };
}

function redactServiceClientsLedger(ledger) {
  return {
    version: 1,
    updatedAt: ledger.updatedAt || null,
    clients: (ledger.clients || []).map(redactServiceClient),
  };
}

function redactServiceClient(client) {
  return {
    id: client.id,
    name: client.name,
    enabled: client.enabled,
    keyPreview: client.keyPreview,
    allowedModels: client.allowedModels || [],
    rateLimitRpm: client.rateLimitRpm,
    maxConcurrentRequests: client.maxConcurrentRequests,
    requestTimeoutSeconds: client.requestTimeoutSeconds,
    expiresAt: client.expiresAt || "",
    notes: client.notes || "",
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    lastUsedAt: client.lastUsedAt || null,
    usage: normalizeServiceClientUsage(client.usage),
  };
}

async function createServiceClient(input = {}) {
  const ledger = await getServiceClientsLedger();
  const now = new Date().toISOString();
  const apiKey = generateServiceClientSecret();
  const name = clipText(input.name || "Local service client", 80);
  const id = uniqueServiceClientId(ledger, input.id || name);
  const client = normalizeServiceClient({
    id,
    name,
    enabled: input.enabled !== false,
    keyHash: hashServiceApiKey(apiKey),
    keyPreview: previewServiceApiKey(apiKey),
    allowedModels: input.allowedModels || [],
    rateLimitRpm: input.rateLimitRpm,
    maxConcurrentRequests: input.maxConcurrentRequests,
    requestTimeoutSeconds: input.requestTimeoutSeconds,
    expiresAt: input.expiresAt,
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
  });
  ledger.clients.push(client);
  await saveServiceClientsLedger(ledger);
  return { ok: true, apiKey, client: redactServiceClient(client) };
}

async function updateServiceClient(id, input = {}) {
  const ledger = await getServiceClientsLedger();
  const index = ledger.clients.findIndex((client) => client.id === id);
  if (index < 0) {
    const error = new Error("Service client not found.");
    error.status = 404;
    throw error;
  }
  const previous = ledger.clients[index];
  const updated = normalizeServiceClient({
    ...previous,
    ...input,
    id: previous.id,
    keyHash: previous.keyHash,
    keyPreview: previous.keyPreview,
    updatedAt: new Date().toISOString(),
  });
  ledger.clients[index] = updated;
  await saveServiceClientsLedger(ledger);
  return { ok: true, client: redactServiceClient(updated) };
}

async function rotateServiceClientKey(id) {
  const ledger = await getServiceClientsLedger();
  const index = ledger.clients.findIndex((client) => client.id === id);
  if (index < 0) {
    const error = new Error("Service client not found.");
    error.status = 404;
    throw error;
  }
  const apiKey = generateServiceClientSecret();
  const updated = normalizeServiceClient({
    ...ledger.clients[index],
    keyHash: hashServiceApiKey(apiKey),
    keyPreview: previewServiceApiKey(apiKey),
    updatedAt: new Date().toISOString(),
  });
  ledger.clients[index] = updated;
  await saveServiceClientsLedger(ledger);
  return { ok: true, apiKey, client: redactServiceClient(updated) };
}

async function deleteServiceClient(id) {
  const ledger = await getServiceClientsLedger();
  const before = ledger.clients.length;
  ledger.clients = ledger.clients.filter((client) => client.id !== id);
  await saveServiceClientsLedger(ledger);
  deleteServiceClientFromSqlite(id).catch(() => {});
  return { ok: true, removed: before - ledger.clients.length, id };
}

function uniqueServiceClientId(ledger, value) {
  const base = safeOutputName(String(value || "client").toLowerCase().replace(/[^a-z0-9]+/g, "-")).replace(/^-+|-+$/g, "").slice(0, 40) || "client";
  const used = new Set((ledger.clients || []).map((client) => client.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

function generateServiceClientSecret() {
  const engine = CONFIG.managerId.includes("llama") ? "llama" : "vllm";
  return `sk-${engine}-${crypto.randomBytes(24).toString("base64url")}`;
}

function hashServiceApiKey(apiKey) {
  return crypto.createHash("sha256").update(String(apiKey || "")).digest("hex");
}

function previewServiceApiKey(apiKey) {
  const text = String(apiKey || "");
  return text ? `${text.slice(0, 7)}...${text.slice(-4)}` : "";
}

function normalizeDateText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

async function resolveServiceClientForApiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return null;
  const hash = hashServiceApiKey(key);
  const ledger = await getServiceClientsLedger();
  const client = (ledger.clients || []).find((item) => item.keyHash === hash);
  if (!client || client.enabled === false) return null;
  if (client.expiresAt && new Date(client.expiresAt).getTime() <= Date.now()) return null;
  return client;
}

function hasActiveServiceClients(ledger) {
  return (ledger.clients || []).some((client) => client.enabled !== false && (!client.expiresAt || new Date(client.expiresAt).getTime() > Date.now()));
}

function buildEffectiveServiceSettings(settings, client) {
  if (!client) return settings;
  return {
    ...settings,
    rateLimitRpm: client.rateLimitRpm || settings.rateLimitRpm,
    maxConcurrentRequests: client.maxConcurrentRequests || settings.maxConcurrentRequests,
    requestTimeoutSeconds: client.requestTimeoutSeconds || settings.requestTimeoutSeconds,
  };
}

function serviceClientAllowsModel(client, model) {
  if (!client) return true;
  const allowed = (client.allowedModels || []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  if (!allowed.length || allowed.includes("*")) return true;
  const value = String(model || "").toLowerCase();
  return allowed.some((item) => item === value);
}

async function recordServiceClientGatewayUsage(clientId, event = {}) {
  if (!clientId) return;
  const ledger = await getServiceClientsLedger();
  const index = ledger.clients.findIndex((client) => client.id === clientId);
  if (index < 0) return;
  const client = ledger.clients[index];
  const usage = normalizeServiceClientUsage(client.usage);
  const prompt = Number(event.usage?.prompt_tokens || event.usage?.input_tokens || 0);
  const generation = Number(event.usage?.completion_tokens || event.usage?.output_tokens || 0);
  usage.requests.total += 1;
  if (event.ok === false) usage.requests.error += 1;
  else usage.requests.success += 1;
  usage.tokens.prompt += prompt;
  usage.tokens.generation += generation;
  usage.tokens.total = usage.tokens.prompt + usage.tokens.generation;
  usage.lastStatus = Number(event.status || 0);
  usage.lastModel = String(event.model || "");
  usage.lastAt = new Date().toISOString();
  ledger.clients[index] = normalizeServiceClient({
    ...client,
    lastUsedAt: usage.lastAt,
    updatedAt: client.updatedAt,
    usage,
  });
  await saveServiceClientsLedger(ledger);
  persistServiceUsageEvent({
    clientId,
    model: usage.lastModel,
    status: usage.lastStatus,
    ok: event.ok !== false,
    promptTokens: prompt,
    generationTokens: generation,
    totalTokens: prompt + generation,
  }).catch(() => {});
}

async function persistServiceClientsToSqlite(ledger) {
  const db = getServiceUsageDb();
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO service_clients (client_id, name, enabled, key_preview, allowed_models, rate_limit_rpm, max_concurrent_requests, request_timeout_seconds, expires_at, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET
      name=excluded.name,
      enabled=excluded.enabled,
      key_preview=excluded.key_preview,
      allowed_models=excluded.allowed_models,
      rate_limit_rpm=excluded.rate_limit_rpm,
      max_concurrent_requests=excluded.max_concurrent_requests,
      request_timeout_seconds=excluded.request_timeout_seconds,
      expires_at=excluded.expires_at,
      notes=excluded.notes,
      updated_at=excluded.updated_at
  `);
  for (const client of ledger.clients || []) {
    stmt.run(
      client.id,
      client.name,
      client.enabled ? 1 : 0,
      client.keyPreview || "",
      JSON.stringify(client.allowedModels || []),
      client.rateLimitRpm,
      client.maxConcurrentRequests,
      client.requestTimeoutSeconds,
      client.expiresAt || "",
      client.notes || "",
      new Date().toISOString(),
    );
  }
}

async function persistServiceUsageEvent(event = {}) {
  const db = getServiceUsageDb();
  if (!db || !event.clientId) return;
  db.prepare(`
    INSERT INTO service_usage_events (event_id, at, manager, client_id, model, status, ok, prompt_tokens, generation_tokens, total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    new Date().toISOString(),
    CONFIG.managerId,
    String(event.clientId || ""),
    String(event.model || ""),
    Number(event.status || 0),
    event.ok === false ? 0 : 1,
    Number(event.promptTokens || 0),
    Number(event.generationTokens || 0),
    Number(event.totalTokens || 0),
  );
}

function getServiceUsageDb() {
  if (!DatabaseSync) return null;
  if (serviceUsageDb) return serviceUsageDb;
  fs.mkdirSync(path.dirname(CONFIG.serviceUsageDb), { recursive: true });
  serviceUsageDb = new DatabaseSync(CONFIG.serviceUsageDb);
  serviceUsageDb.exec(`
    CREATE TABLE IF NOT EXISTS service_clients (
      client_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      key_preview TEXT NOT NULL,
      allowed_models TEXT NOT NULL,
      rate_limit_rpm INTEGER NOT NULL,
      max_concurrent_requests INTEGER NOT NULL,
      request_timeout_seconds INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      notes TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS service_usage_events (
      event_id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      manager TEXT NOT NULL,
      client_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      generation_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_service_usage_client_at ON service_usage_events(client_id, at);
  `);
  return serviceUsageDb;
}

async function deleteServiceClientFromSqlite(id) {
  const db = getServiceUsageDb();
  if (!db) return;
  db.prepare("DELETE FROM service_clients WHERE client_id = ?").run(String(id || ""));
}

async function serviceGatewayMiddleware(req, res, next) {
  try {
    const settings = await getServiceExposureSettings();
    const kind = getServiceGatewayKind(req);
    if (!kind) return next();
    attachServiceGatewayAccessLog(req, res, kind);
    const cors = applyServiceCorsHeaders(req, res, settings);
    if (!cors.ok) return serviceGatewayReject(res, 403, "origin_not_allowed", cors.message);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!isServiceKindEnabled(settings, kind)) {
      return serviceGatewayReject(res, 404, "endpoint_disabled", `${kind} gateway is disabled by service exposure settings.`);
    }
    if (settings.enabled && settings.exposureMode === "local" && !isLocalRequester(req)) {
      return serviceGatewayReject(res, 403, "local_only", "Service exposure mode is local-only.");
    }
    const presentedKey = extractServiceApiKey(req);
    const clientsLedger = await getServiceClientsLedger();
    const serviceClient = await resolveServiceClientForApiKey(presentedKey);
    const globalKeyAccepted = isGlobalServiceApiKeyAccepted(presentedKey, settings);
    if (settings.enabled && settings.requireApiKey) {
      if (!hasGlobalServiceApiKey(settings) && !hasActiveServiceClients(clientsLedger)) {
        return serviceGatewayReject(res, 503, "api_key_not_configured", "API key is required, but no service API key is configured.");
      }
      if (!globalKeyAccepted && !serviceClient) {
        return serviceGatewayReject(res, 401, "unauthorized", "Missing or invalid service API key.", { "www-authenticate": "Bearer" });
      }
    }
    const effectiveSettings = buildEffectiveServiceSettings(settings, serviceClient);
    const clientKey = serviceClient?.id || serviceClientFingerprint(req, presentedKey);
    const rate = enterServiceRateLimit(effectiveSettings, clientKey, serviceRateBuckets);
    if (!rate.ok) {
      return serviceGatewayReject(res, 429, "rate_limit_exceeded", `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`, { "retry-after": String(rate.retryAfterSeconds) });
    }
    const concurrency = enterServiceConcurrency(effectiveSettings, clientKey, serviceConcurrencyBuckets);
    if (!concurrency.ok) {
      return serviceGatewayReject(res, 429, "concurrency_limit_exceeded", "Too many concurrent requests for this service key.");
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      concurrency.release();
    };
    res.once("finish", release);
    res.once("close", release);
    const timeoutMs = clampNumber(effectiveSettings.requestTimeoutSeconds, 10, 7200, 600) * 1000;
    req.serviceGateway = { kind, settings: effectiveSettings, baseSettings: settings, client: serviceClient, clientId: serviceClient?.id || "", clientKey, timeoutMs };
    res.setHeader("x-local-llm-gateway", "llama-manager");
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) res.status(504).json(openAiGatewayError("request_timeout", "Service gateway request timed out."));
      if (!res.writableEnded) res.end();
    });
    return next();
  } catch (error) {
    return serviceGatewayReject(res, 500, "gateway_error", error.message);
  }
}

function attachServiceGatewayAccessLog(req, res, kind) {
  const startedAt = Date.now();
  const authSource = serviceApiKeySource(req);
  res.once("finish", () => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const usage = req.serviceGatewayAccessUsage || {};
    const inputTokens = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
    const outputTokens = Number(usage.outputTokens ?? usage.generationTokens ?? 0);
    const entry = {
      at: new Date().toISOString(),
      remoteAddress: req.socket?.remoteAddress || req.ip || "",
      method: req.method,
      path: String(req.originalUrl || req.url || "").split("?")[0],
      kind,
      status: res.statusCode,
      model: typeof body.model === "string" ? body.model.slice(0, 160) : "",
      resolvedModel: String(usage.resolvedModel || "").slice(0, 220),
      stream: body.stream === true,
      authSource,
      clientId: req.serviceGateway?.clientId || "",
      durationMs: Date.now() - startedAt,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      stopReason: String(usage.stopReason || "").slice(0, 80),
      toolSchemaCount: Number(usage.toolSchemaCount || 0),
      toolUseCount: Number(usage.toolUseCount || 0),
      error: String(usage.error || "").slice(0, 240),
    };
    appendServiceGatewayAccessLog(entry).catch(() => {});
  });
}

async function appendServiceGatewayAccessLog(entry) {
  await ensureDirs(path.dirname(CONFIG.serviceGatewayAccessLog));
  await fsp.appendFile(CONFIG.serviceGatewayAccessLog, `${JSON.stringify(entry)}\n`, "utf8");
}

function serviceApiKeySource(req) {
  const headers = req.headers || {};
  const auth = String(headers.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return "authorization-bearer";
  if (auth) return "authorization-raw";
  if (headers["x-api-key"]) return "x-api-key";
  if (headers["anthropic-api-key"]) return "anthropic-api-key";
  if (headers["anthropic_api_key"]) return "anthropic_api_key";
  if (headers["api-key"]) return "api-key";
  return "";
}

function getServiceGatewayKind(req) {
  const pathname = String(req.originalUrl || req.url || "").split("?")[0];
  if (pathname.startsWith("/serve/v1/")) return "openai";
  if (pathname.startsWith("/claude/") || pathname.startsWith("/v1/messages") || pathname.startsWith("/v1/claude/")) return "claude";
  return "";
}

function isServiceKindEnabled(settings, kind) {
  if (!settings.enabled) return true;
  if (kind === "openai") return settings.exposeOpenAI !== false;
  if (kind === "claude") return settings.exposeClaude !== false;
  return true;
}

function applyServiceCorsHeaders(req, res, settings) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return { ok: true };
  if (!isServiceOriginAllowed(origin, settings.allowedOrigins || [])) {
    return { ok: false, message: `Origin is not allowed: ${origin}` };
  }
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", appendVaryHeader(res.getHeader("vary"), "Origin"));
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-api-key,x-requested-with");
  res.setHeader("access-control-max-age", "600");
  return { ok: true };
}

function isServiceOriginAllowed(origin, allowedOrigins = []) {
  const entries = allowedOrigins.map((item) => String(item || "").trim()).filter(Boolean);
  if (!entries.length) return true;
  if (entries.includes("*")) return true;
  return entries.some((entry) => entry === origin);
}

function appendVaryHeader(current, value) {
  const entries = String(current || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!entries.some((item) => item.toLowerCase() === value.toLowerCase())) entries.push(value);
  return entries.join(", ");
}

function extractServiceApiKey(req) {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return String(req.headers["x-api-key"] || "").trim();
}

function isServiceApiKeyAccepted(presented, expected) {
  const left = Buffer.from(String(presented || ""));
  const right = Buffer.from(String(expected || ""));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hasGlobalServiceApiKey(settings = {}) {
  return Boolean(settings.apiKeyHash || settings.apiKey);
}

function isGlobalServiceApiKeyAccepted(presented, settings = {}) {
  const key = String(presented || "").trim();
  if (!key) return false;
  if (settings.apiKeyHash) return hashServiceApiKey(key) === settings.apiKeyHash;
  return Boolean(settings.apiKey && isServiceApiKeyAccepted(key, settings.apiKey));
}

function serviceClientFingerprint(req, apiKey = "") {
  const raw = apiKey || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || req.ip || "unknown";
  return crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 24);
}

function enterServiceRateLimit(settings, clientKey, buckets = serviceRateBuckets, now = Date.now()) {
  const limit = clampNumber(settings.rateLimitRpm, 1, 5000, 120);
  const windowMs = 60 * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const previous = buckets.get(clientKey);
  const bucket = previous && previous.windowStart === windowStart ? previous : { windowStart, count: 0 };
  if (bucket.count >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
    };
  }
  bucket.count += 1;
  buckets.set(clientKey, bucket);
  if (buckets.size > 5000) pruneServiceRateBuckets(buckets, windowStart);
  return { ok: true, remaining: Math.max(0, limit - bucket.count) };
}

function pruneServiceRateBuckets(buckets, currentWindowStart) {
  for (const [key, bucket] of buckets.entries()) {
    if (!bucket || bucket.windowStart < currentWindowStart) buckets.delete(key);
  }
}

function enterServiceConcurrency(settings, clientKey, buckets = serviceConcurrencyBuckets) {
  const limit = clampNumber(settings.maxConcurrentRequests, 1, 256, 4);
  const current = Number(buckets.get(clientKey) || 0);
  if (current >= limit) return { ok: false };
  buckets.set(clientKey, current + 1);
  return {
    ok: true,
    release: () => {
      const next = Math.max(0, Number(buckets.get(clientKey) || 0) - 1);
      if (next) buckets.set(clientKey, next);
      else buckets.delete(clientKey);
    },
  };
}

function isLocalRequester(req) {
  const address = String(req.socket?.remoteAddress || req.ip || "").replace(/^::ffff:/, "");
  return ["127.0.0.1", "::1", "localhost", ""].includes(address);
}

function serviceGatewayReject(res, status, code, message, headers = {}) {
  if (res.headersSent) return res.end();
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  return res.status(status).json(openAiGatewayError(code, message));
}

function openAiGatewayError(code, message) {
  return {
    error: {
      message: String(message || "Service gateway error."),
      type: String(code || "gateway_error"),
      code: String(code || "gateway_error"),
    },
  };
}

function startAutomationMonitor() {
  if (automationMonitorTimer) return;
  automationMonitorTimer = setInterval(() => {
    inspectAutomationRules().catch((error) => console.warn(`automation monitor failed: ${error.message}`));
  }, 60 * 1000);
  automationMonitorTimer.unref?.();
}

async function inspectAutomationRules() {
  const settings = await getAutomationSettings();
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

function normalizeBenchmarkRequest(input = {}) {
  return {
    port: Number(input.port || CONFIG.defaultPort),
    model: String(input.model || "").trim(),
    requests: Math.min(5, Math.max(1, Number(input.requests || 3))),
    maxTokens: Math.min(1024, Math.max(16, Number(input.maxTokens || 160))),
    prompt: String(input.prompt || "用中文简要说明本地 llama.cpp 模型是否可以稳定完成工具调用、长上下文和代码任务。"),
  };
}

async function runBenchmarkJob(job, input) {
  const runtime = await getRunningModelSummary();
  const model = input.model || runtime.models?.[0]?.id;
  if (!runtime.container.running || !model) throw new Error("No running llama.cpp model is available for benchmark.");
  const port = Number(input.port || runtime.endpoint?.port || CONFIG.defaultPort);
  const samples = [];
  for (let index = 0; index < input.requests; index += 1) {
    setJobProgress(job, {
      percent: Math.round((index / input.requests) * 90),
      stage: `Benchmark ${index + 1}/${input.requests}`,
      detail: "Sending chat completion request to local llama.cpp.",
    });
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: input.prompt }],
        temperature: 0,
        max_tokens: input.maxTokens,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const text = await response.text();
    const elapsedMs = Date.now() - started;
    const data = parseJsonSafe(text, {});
    if (!response.ok) throw new Error(upstreamErrorMessage(data, text));
    const usage = data.usage || {};
    const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
    samples.push({
      elapsedMs,
      promptTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
      outputTokens,
      tokensPerSecond: outputTokens ? outputTokens / (elapsedMs / 1000) : 0,
      preview: String(data.choices?.[0]?.message?.content || "").slice(0, 240),
    });
    appendLog(job, `Run ${index + 1}: ${elapsedMs} ms, ${outputTokens} output tokens.`);
  }
  const avgMs = samples.reduce((sum, item) => sum + item.elapsedMs, 0) / samples.length;
  const avgTps = samples.reduce((sum, item) => sum + item.tokensPerSecond, 0) / samples.length;
  setJobProgress(job, { percent: 100, stage: "Benchmark complete", detail: `${avgTps.toFixed(2)} tok/s average`, state: "ok" });
  finishJob(job, {
    benchmark: {
      model,
      port,
      requests: input.requests,
      maxTokens: input.maxTokens,
      avgMs,
      avgTokensPerSecond: avgTps,
      samples,
    },
  });
}

async function verifyDownloadedModel(input = {}) {
  const outputName = String(input.outputName || "").trim();
  const localDir = input.localDir ? path.resolve(String(input.localDir)) : path.join(CONFIG.modelsRoot, safeOutputName(outputName));
  const root = path.resolve(CONFIG.modelsRoot);
  const resolved = path.resolve(localDir);
  if (path.relative(root, resolved).startsWith("..") || !resolved.startsWith(root)) {
    const error = new Error("download verification path must be inside models root");
    error.status = 400;
    throw error;
  }
  const exists = fs.existsSync(resolved);
  if (!exists) return { ok: false, status: "missing", path: resolved, issues: [finding("fail", "目录不存在", resolved)] };
  const stat = await fsp.stat(resolved);
  const files = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const itemStat = await fsp.stat(full).catch(() => null);
        files.push({ path: full, name: entry.name, size: itemStat?.size || 0 });
      }
      if (files.length > 5000) break;
    }
  }
  if (stat.isDirectory()) await walk(resolved);
  else files.push({ path: resolved, name: path.basename(resolved), size: stat.size });
  const lowerNames = files.map((item) => item.name.toLowerCase());
  const gguf = files.filter((item) => item.name.toLowerCase().endsWith(".gguf"));
  const hasConfig = lowerNames.includes("config.json") || lowerNames.includes("params.json");
  const hasTokenizer = lowerNames.some((name) => name.includes("tokenizer"));
  const issues = [];
  if (!gguf.length) issues.push(finding("fail", "未发现 GGUF", "llama.cpp 需要 .gguf 权重；普通 safetensors 目录请使用 vLLM 或先转换。"));
  if (hasConfig && !gguf.length) issues.push(finding("warn", "检测到 HF 配置", "这更像 vLLM/HF 目录，不是 llama.cpp 直接可跑的 GGUF。"));
  const size = files.reduce((sum, item) => sum + item.size, 0);
  return {
    ok: !issues.some((item) => item.severity === "fail"),
    status: issues.length ? "warn" : "ok",
    path: resolved,
    fileCount: files.length,
    size,
    hasConfig,
    hasTokenizer,
    gguf: gguf.length,
    largestFiles: files.sort((a, b) => b.size - a.size).slice(0, 8).map((item) => ({
      name: path.relative(resolved, item.path) || item.name,
      size: item.size,
    })),
    issues,
  };
}

async function buildConnectionGuide() {
  const [gpu, container] = await Promise.all([getGpuStatus(), getContainerStatus(CONFIG.containerName)]);
  const runtime = await getRunningModelSummary(container, gpu).catch(() => null);
  const endpoint = runtime?.endpoint || getContainerEndpoint(container);
  const managerLocal = `http://127.0.0.1:${PORT}`;
  const managerLan = HOST === "127.0.0.1" ? null : `http://${getLanAddress()}:${PORT}`;
  const openAiGatewayBase = `${managerLocal}/serve/v1`;
  const model = runtime?.models?.[0]?.id || "";
  return {
    ok: Boolean(runtime?.container?.running),
    generatedAt: new Date().toISOString(),
    manager: { local: managerLocal, lan: managerLan },
    model,
    openai: {
      baseUrl: openAiGatewayBase,
      chatCompletionsUrl: `${openAiGatewayBase}/chat/completions`,
      modelsUrl: `${openAiGatewayBase}/models`,
      directBaseUrl: endpoint.compat?.openai?.baseUrl || endpoint.localUrl,
      apiKey: "service-exposure-api-key",
      curl: `curl ${openAiGatewayBase}/models`,
    },
    claude: {
      ...(endpoint.compat?.claude || {}),
      modelAlias: CLAUDE_MODEL_ALIASES[0],
    },
    openwebui: {
      baseUrl: openAiGatewayBase,
      model: model || "local-current",
      note: "OpenWebUI 的 OpenAI API Base URL 建议填管理器 /serve/v1；API Key 使用对外服务页保存的密钥。",
    },
    ccswitch: {
      providerBaseUrl: `${managerLocal}/claude`,
      modelAlias: CLAUDE_MODEL_ALIASES[0],
      healthUrl: `${managerLocal}/api/tools/health`,
    },
  };
}

async function getClaudeCompressionSettings() {
  const saved = await readJsonFile(CONFIG.claudeCompressionSettings, {});
  return normalizeClaudeCompressionSettings(saved);
}

async function saveClaudeCompressionSettings(input = {}) {
  const settings = normalizeClaudeCompressionSettings(input);
  settings.updatedAt = new Date().toISOString();
  await writeJsonFile(CONFIG.claudeCompressionSettings, settings);
  return settings;
}

function normalizeClaudeCompressionSettings(value = {}) {
  const item = value && typeof value === "object" ? value : {};
  return {
    enabled: item.enabled !== false,
    mode: "cautious",
    triggerRatio: clampRatio(item.triggerRatio, 0.9),
    recentRatio: clampRatio(item.recentRatio, 0.2),
    summaryRatio: clampRatio(item.summaryRatio, 0.2),
    minMessages: Math.min(40, Math.max(4, Number(item.minMessages || 8))),
    updatedAt: item.updatedAt || null,
  };
}

function clampRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const ratio = number > 1 ? number / 100 : number;
  return Math.min(0.98, Math.max(0.05, ratio));
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

async function getModelNotes() {
  const ledger = await readJsonFile(CONFIG.modelNotes, { version: 1, notes: {} });
  return {
    version: 1,
    updatedAt: ledger.updatedAt || null,
    notes: ledger.notes && typeof ledger.notes === "object" ? ledger.notes : {},
  };
}

async function saveModelNote(input = {}) {
  const model = String(input.model || input.id || "").trim();
  if (!model) {
    const error = new Error("model is required");
    error.status = 400;
    throw error;
  }
  const key = modelNoteKey(model);
  const ledger = await getModelNotes();
  const note = {
    key,
    model,
    favorite: Boolean(input.favorite),
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => clipText(String(tag).trim(), 32)).filter(Boolean).slice(0, 12) : [],
    note: clipText(String(input.note || ""), 500),
    updatedAt: new Date().toISOString(),
  };
  ledger.notes[key] = note;
  await writeJsonFile(CONFIG.modelNotes, { version: 1, updatedAt: new Date().toISOString(), notes: ledger.notes });
  return { ok: true, note };
}

async function deleteModelNote(key) {
  const ledger = await getModelNotes();
  const id = String(key || "");
  const existed = Boolean(ledger.notes[id]);
  delete ledger.notes[id];
  await writeJsonFile(CONFIG.modelNotes, { version: 1, updatedAt: new Date().toISOString(), notes: ledger.notes });
  return { ok: true, removed: existed ? 1 : 0, id };
}

function modelNoteKey(model) {
  const hash = crypto.createHash("sha1").update(String(model)).digest("hex").slice(0, 10);
  return `${safeOutputName(String(model).replace(/[\\/]/g, "-")).slice(0, 48)}-${hash}`;
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
  if (body.system) parts.push(anthropicContentToText(body.system));
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    parts.push(anthropicContentToText(message.content));
  }
  res.json({ input_tokens: estimateTokenCount(parts.join("\n")) });
}

async function handleOpenAiGatewayModels(_req, res) {
  try {
    const runtime = await getRunningModelSummary();
    if (!runtime.container.running) {
      return res.status(503).json(openAiGatewayError("service_unavailable", "Model service is not running."));
    }
    const response = await fetch(`http://127.0.0.1:${runtime.endpoint.port}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    const data = parseJsonSafe(text, {});
    if (!response.ok) {
      return res.status(response.status).json(openAiGatewayError("upstream_error", upstreamErrorMessage(data, text)));
    }
    const models = Array.isArray(data.data) ? data.data : [];
    const fallback = models[0] || runtime.servedModels?.[0] || runtime.models?.[0] || {};
    const aliases = OPENAI_GATEWAY_MODEL_ALIASES.map((id) => ({
      id,
      object: "model",
      created: fallback.created || Math.floor(Date.now() / 1000),
      owned_by: "llama-manager",
      root: fallback.id || "",
      parent: fallback.id || null,
      max_model_len: fallback.max_model_len || fallback.maxModelLen || null,
    }));
    return res.json({ object: "list", data: uniqueModelsById([...aliases, ...models]) });
  } catch (error) {
    return res.status(500).json(openAiGatewayError("gateway_error", error.message));
  }
}

async function handleOpenAiGatewayChatCompletions(req, res) {
  return handleOpenAiGatewayCompletionProxy(req, res, "chat/completions");
}

async function handleOpenAiGatewayCompletions(req, res) {
  return handleOpenAiGatewayCompletionProxy(req, res, "completions");
}

async function handleOpenAiGatewayCompletionProxy(req, res, upstreamPath) {
  const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
  try {
    const runtime = await getRunningModelSummary();
    if (!runtime.container.running) {
      return res.status(503).json(openAiGatewayError("service_unavailable", "Model service is not running."));
    }
    const model = resolveOpenAiGatewayModel(String(body.model || ""), runtime);
    if (!model) {
      req.serviceGatewayAccessUsage = { error: "Configured model is not available on this local gateway." };
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 400, model: String(body.model || "") }).catch(() => {});
      return res.status(400).json(openAiGatewayError("model_not_available", "Configured model is not available on this local gateway."));
    }
    if (!serviceClientAllowsModel(req.serviceGateway?.client, model)) {
      req.serviceGatewayAccessUsage = { resolvedModel: model, error: "This service client is not allowed to use the requested model." };
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 403, model }).catch(() => {});
      return res.status(403).json(openAiGatewayError("model_forbidden", "This service client is not allowed to use the requested model."));
    }
    body.model = model;
    const stream = body.stream === true;
    const upstreamControl = createServiceUpstreamControl(req, res);
    try {
      const upstream = await fetch(`http://127.0.0.1:${runtime.endpoint.port}/v1/${upstreamPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: upstreamControl.signal,
      });
      if (stream) {
        return streamRawOpenAiGatewayResponse(upstream, res, upstreamControl, req, model);
      }
      const text = await upstream.text();
      upstreamControl.clear();
      const data = parseJsonSafe(text, null);
      req.serviceGatewayAccessUsage = {
        resolvedModel: model,
        inputTokens: Number(data?.usage?.prompt_tokens || data?.usage?.promptTokens || 0),
        outputTokens: Number(data?.usage?.completion_tokens || data?.usage?.completionTokens || 0),
      };
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, {
        ok: upstream.ok,
        status: upstream.status,
        model,
        usage: data?.usage,
      }).catch(() => {});
      res.status(upstream.status);
      res.type(upstream.headers.get("content-type") || "application/json");
      return res.send(text);
    } catch (error) {
      upstreamControl.clear();
      throw error;
    }
  } catch (error) {
    req.serviceGatewayAccessUsage = { error: error.message };
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const timedOut = error?.name === "AbortError";
    return res.status(timedOut ? 504 : 500).json(openAiGatewayError(timedOut ? "request_timeout" : "gateway_error", timedOut ? "Upstream request timed out." : error.message));
  }
}

function resolveOpenAiGatewayModel(requestedModel, runtime) {
  const served = (runtime.servedModels || runtime.models || []).map((item) => item?.id).filter(Boolean);
  const fallback = served[0] || "";
  const value = String(requestedModel || "").trim();
  if (!value) return fallback;
  const bareValue = value.split("/").pop();
  if (OPENAI_GATEWAY_MODEL_ALIASES.some((alias) => alias.toLowerCase() === value.toLowerCase() || alias.toLowerCase() === bareValue.toLowerCase())) return fallback;
  const exact = served.find((id) => id === value || id.toLowerCase() === value.toLowerCase());
  return exact || "";
}

function createServiceUpstreamControl(req, res) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(req.serviceGateway?.timeoutMs || 600000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortOnClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", abortOnClose);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      res.off?.("close", abortOnClose);
    },
  };
}

async function streamRawOpenAiGatewayResponse(upstream, res, upstreamControl, req = null, model = "") {
  res.status(upstream.status);
  res.setHeader("content-type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", upstream.headers.get("cache-control") || "no-cache");
  res.setHeader("connection", "keep-alive");
  let streamError = null;
  try {
    for await (const chunk of upstream.body) {
      if (!res.writableEnded) res.write(Buffer.from(chunk));
    }
  } catch (error) {
    streamError = error;
  } finally {
    upstreamControl.clear();
  }
  await recordServiceClientGatewayUsage(req?.serviceGateway?.clientId, {
    ok: upstream.ok && !streamError,
    status: streamError ? 499 : upstream.status,
    model,
  }).catch(() => {});
  if (req) {
    req.serviceGatewayAccessUsage = {
      resolvedModel: model,
      error: streamError ? streamError.message : "",
    };
  }
  if (streamError && !isExpectedStreamDisconnect(streamError, res) && !res.writableEnded) {
    res.write(`\ndata: ${JSON.stringify({ error: { message: `Upstream stream failed: ${streamError.message}`, type: "gateway_error" } })}\n\n`);
  }
  if (!res.writableEnded) res.end();
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
    if (!serviceClientAllowsModel(req.serviceGateway?.client, model)) {
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
      });
    }

    const text = await upstream.text();
    const data = parseJsonSafe(text, null);
    if (!upstream.ok) {
      req.serviceGatewayAccessUsage = { resolvedModel: model, error: upstreamErrorMessage(data, text), toolSchemaCount };
      return res.status(upstream.status).json(claudeError("api_error", upstreamErrorMessage(data, text)));
    }
    const claudeResponse = openAiResponseToClaude(data, model);
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
  const messages = anthropicMessagesToOpenAi(body);
  const tools = anthropicToolsToOpenAi(body.tools);
  const payload = {
    model,
    messages,
    max_tokens: Math.max(1, Number(body.max_tokens || body.maxTokens || 1024)),
  };
  if (tools.length) {
    payload.tools = tools;
    payload.tool_choice = anthropicToolChoiceToOpenAi(body.tool_choice, tools);
  }
  if (body.disable_parallel_tool_use === true) payload.parallel_tool_calls = false;
  for (const field of ["temperature", "top_p", "presence_penalty", "frequency_penalty"]) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== "") payload[field] = Number(body[field]);
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences;
  if (body.stream === true) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }
  return payload;
}

function applyClaudeContextCompression(body, runtime, model, settings) {
  const config = normalizeClaudeCompressionSettings(settings);
  const contextLimit = resolveClaudeContextLimit(runtime, model, body);
  const maxTokens = Math.max(1, Number(body.max_tokens || body.maxTokens || 1024));
  const originalPromptTokens = estimateClaudeBodyTokens(body);
  const triggerTokens = Math.floor(contextLimit * config.triggerRatio);
  const base = {
    applied: false,
    enabled: config.enabled,
    mode: config.mode,
    contextLimit,
    triggerTokens,
    originalPromptTokens,
    compressedPromptTokens: originalPromptTokens,
    savedTokens: 0,
    recentMessageCount: 0,
    summarizedMessageCount: 0,
    body,
  };
  if (!config.enabled || !Array.isArray(body.messages) || body.messages.length < config.minMessages || originalPromptTokens + maxTokens < triggerTokens) {
    return base;
  }
  const recentBudget = Math.max(512, Math.floor(contextLimit * config.recentRatio));
  const tokenCounts = body.messages.map((message) => estimateTokenCount(anthropicMessageToSummaryText(message)));
  const selected = new Set();
  let total = 0;
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const cost = Math.max(1, tokenCounts[index]);
    if (selected.size >= 4 && total + cost > recentBudget) break;
    selected.add(index);
    total += cost;
  }
  expandSelectedToolPairs(body.messages, selected);
  const recentMessages = body.messages.filter((_message, index) => selected.has(index));
  const summarizedMessages = body.messages.filter((_message, index) => !selected.has(index));
  if (!summarizedMessages.length) return base;
  const summaryText = buildClaudeCompressionSummaryText(summarizedMessages, {
    originalPromptTokens,
    contextLimit,
    triggerRatio: config.triggerRatio,
    recentRatio: config.recentRatio,
    summaryRatio: config.summaryRatio,
  });
  const compressedBody = {
    ...body,
    system: appendClaudeCompressionSummary(body.system, summaryText),
    messages: recentMessages,
  };
  const compressedPromptTokens = estimateClaudeBodyTokens(compressedBody);
  return {
    ...base,
    applied: compressedPromptTokens < originalPromptTokens,
    compressedPromptTokens,
    savedTokens: Math.max(0, originalPromptTokens - compressedPromptTokens),
    recentMessageCount: recentMessages.length,
    summarizedMessageCount: summarizedMessages.length,
    body: compressedPromptTokens < originalPromptTokens ? compressedBody : body,
  };
}

function resolveClaudeContextLimit(runtime, model, body) {
  const candidates = [];
  const served = [...(runtime?.servedModels || []), ...(runtime?.models || [])];
  for (const item of served) {
    const id = String(item?.id || "").toLowerCase();
    const root = String(item?.root || "").toLowerCase();
    if (!model || id === String(model).toLowerCase() || root === String(model).toLowerCase()) {
      candidates.push(item?.max_model_len, item?.maxModelLen, item?.contextCapacityTokens);
    }
  }
  candidates.push(body.max_model_len, body.maxModelLen, runtime?.models?.[0]?.maxModelLen, runtime?.servedModels?.[0]?.max_model_len);
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 1024) return Math.floor(number);
  }
  return 8192;
}

function estimateClaudeBodyTokens(body) {
  const parts = [];
  const system = anthropicContentToText(body.system);
  if (system) parts.push(system);
  if (Array.isArray(body.tools) && body.tools.length) parts.push(JSON.stringify(body.tools));
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    parts.push(message.role || "user");
    parts.push(anthropicMessageToSummaryText(message));
  }
  return estimateTokenCount(parts.join("\n"));
}

function anthropicMessageToSummaryText(message) {
  const blocks = normalizeAnthropicContentBlocks(message?.content);
  if (!blocks.length && typeof message?.content === "string") return message.content;
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return "";
    if (block.type === "text") return block.text || "";
    if (block.type === "tool_use") return `[tool_use ${block.name || "tool"} ${JSON.stringify(block.input || {})}]`;
    if (block.type === "tool_result") return `[tool_result ${block.tool_use_id || ""}] ${anthropicContentToText(block.content)}`;
    if (block.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function expandSelectedToolPairs(messages, selected) {
  const needToolUse = new Set();
  const needToolResult = new Set();
  for (const index of selected) {
    for (const block of normalizeAnthropicContentBlocks(messages[index]?.content)) {
      if (block.type === "tool_result" && (block.tool_use_id || block.toolUseId)) {
        needToolUse.add(String(block.tool_use_id || block.toolUseId));
      }
      if (block.type === "tool_use" && block.id) needToolResult.add(String(block.id));
    }
  }
  messages.forEach((message, index) => {
    for (const block of normalizeAnthropicContentBlocks(message?.content)) {
      if (block.type === "tool_use" && needToolUse.has(String(block.id || ""))) selected.add(index);
      if (block.type === "tool_result" && needToolResult.has(String(block.tool_use_id || block.toolUseId || ""))) selected.add(index);
    }
  });
}

function appendClaudeCompressionSummary(system, summaryText) {
  const block = `\n\n${summaryText}`;
  if (!system) return summaryText;
  if (typeof system === "string") return `${system}${block}`;
  if (Array.isArray(system)) return [...system, { type: "text", text: summaryText }];
  if (system && typeof system === "object") return [system, { type: "text", text: summaryText }];
  return summaryText;
}

function buildClaudeCompressionSummary(messages, options = {}) {
  const settings = normalizeCompressionSummarySettings(options);
  const summaryBudget = Number(options.summaryBudget || Math.max(512, Math.floor(settings.contextLimit * settings.summaryRatio)));
  const buckets = {
    goals: [],
    hardRules: [],
    errors: [],
    paths: [],
    commands: [],
    tools: [],
    progress: [],
    openIssues: [],
    snippets: [],
  };

  messages.forEach((message, index) => collectClaudeCompressionFacts(message, index, buckets));
  const protectedItems = Object.values(buckets).reduce((sum, items) => sum + items.length, 0);
  const header = [
    "[Automatic context compression summary]",
    "Purpose: preserve durable intent, hard instructions, errors, paths, configuration, and tool-call pairs while older low-priority chat is compressed.",
    "Conflict rule: recent original messages and explicit hard instructions override this summary.",
    `Compressed messages: ${messages.length}; trigger: ${(settings.triggerRatio * 100).toFixed(0)}%; recent raw window: ${(settings.recentRatio * 100).toFixed(0)}%; summary budget: ${(settings.summaryRatio * 100).toFixed(0)}%.`,
    `Before compression estimate: ${settings.originalPromptTokens} tokens; context limit: ${settings.contextLimit} tokens.`,
  ];

  const sections = [
    ["Current goals and user requests", buckets.goals],
    ["Hard rules and safety constraints", buckets.hardRules],
    ["Errors, failures, and risks", buckets.errors],
    ["Paths, addresses, ports, models, and configuration", buckets.paths],
    ["Commands, APIs, and operations", buckets.commands],
    ["Tool calls and results", buckets.tools],
    ["Completed work", buckets.progress],
    ["Open issues and next steps", buckets.openIssues],
  ];

  let importantText = [
    ...header,
    ...sections.flatMap(([title, items]) => renderClaudeCompressionSection(title, items, 12)),
  ].join("\n");

  let snippets = buckets.snippets.slice(0, 24);
  let text = renderClaudeCompressionText(importantText, snippets);
  while (estimateTokenCount(text) > summaryBudget && snippets.length) {
    snippets.pop();
    text = renderClaudeCompressionText(importantText, snippets);
  }
  if (estimateTokenCount(text) > summaryBudget) {
    importantText = clipCompressionToEstimatedTokens(importantText, summaryBudget);
    text = renderClaudeCompressionText(importantText, []);
  }

  return {
    text,
    tokens: estimateTokenCount(text),
    protectedItems,
  };
}

function buildClaudeCompressionSummaryText(messages, options = {}) {
  return buildClaudeCompressionSummary(messages, options).text;
}

function normalizeCompressionSummarySettings(options) {
  const settings = options.settings || options || {};
  return {
    triggerRatio: Number(settings.triggerRatio || 0.9),
    recentRatio: Number(settings.recentRatio || 0.2),
    summaryRatio: Number(settings.summaryRatio || 0.2),
    originalPromptTokens: Number(options.originalPromptTokens || settings.originalPromptTokens || 0),
    contextLimit: Number(options.contextLimit || settings.contextLimit || 8192),
  };
}

function renderClaudeCompressionText(importantText, snippets) {
  const snippetSection = snippets.length
    ? `\nOlder-message excerpts:\n${snippets.map((item) => `- ${item}`).join("\n")}`
    : "\nOlder-message excerpts: omitted low-priority chatter and repeated content.";
  return `${importantText}${snippetSection}\n[End automatic context compression summary]`;
}

function renderClaudeCompressionSection(title, items, limit) {
  const unique = uniqueCompressionStrings(items).slice(0, limit);
  if (!unique.length) return [`${title}:`, "- None detected."];
  return [`${title}:`, ...unique.map((item) => `- ${item}`)];
}

function collectClaudeCompressionFacts(message, index, buckets) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const blocks = normalizeAnthropicContentBlocks(message?.content);
  const text = anthropicMessageToSummaryText(message);
  const clipped = clipCompressionText(text.replace(/\s+/g, " ").trim(), 360);
  if (clipped) buckets.snippets.push(`#${index + 1} ${role}: ${clipped}`);

  for (const line of importantCompressionLines(text)) {
    const item = clipCompressionText(`${role}: ${line}`, 360);
    if (isHardInstructionLine(line)) buckets.hardRules.push(item);
    if (isGoalLine(line) || role === "user") buckets.goals.push(item);
    if (isErrorLine(line)) buckets.errors.push(item);
    if (isPathConfigLine(line)) buckets.paths.push(item);
    if (isCommandLine(line)) buckets.commands.push(item);
    if (isProgressLine(line)) buckets.progress.push(item);
    if (isOpenIssueLine(line)) buckets.openIssues.push(item);
  }

  for (const block of blocks) {
    if (block.type === "tool_use") {
      buckets.tools.push(clipCompressionText(`tool_use ${block.name || "tool"} id=${block.id || "-"} input=${JSON.stringify(block.input || {})}`, 420));
    } else if (block.type === "tool_result") {
      const resultText = anthropicContentToText(block.content);
      const keyLines = importantCompressionLines(resultText).slice(0, 8);
      const compactResult = (keyLines.join(" | ") || resultText).replace(/\s+/g, " ");
      buckets.tools.push(clipCompressionText(`tool_result ${block.tool_use_id || block.toolUseId || "-"}${block.is_error ? " ERROR" : ""}: ${compactResult}`, 520));
      if (block.is_error || isErrorLine(resultText)) {
        buckets.errors.push(clipCompressionText(`tool_result error ${block.tool_use_id || block.toolUseId || "-"}: ${compactResult}`, 520));
      }
    }
  }
}

function importantCompressionLines(text) {
  return String(text || "")
    .split(/\r?\n|(?<=[.!?;:\u3002\uff01\uff1f\uff1b\uff1a])\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => isHardInstructionLine(line) || isGoalLine(line) || isErrorLine(line) || isPathConfigLine(line) || isCommandLine(line) || isProgressLine(line) || isOpenIssueLine(line))
    .slice(0, 80);
}

function isHardInstructionLine(line) {
  return /\u5fc5\u987b|\u7edd\u5bf9|\u4e0d\u80fd|\u4e0d\u8981|\u5148\u522b|\u7981\u6b62|\u52a1\u5fc5|\u4e00\u5b9a|\u4fdd\u7559|\u9690\u79c1|\u5ba1\u8ba1|\u5bc6\u7801|\u89c4\u5219|must|never|do not|don't|keep|preserve|required/i.test(line);
}

function isGoalLine(line) {
  return /\u6211\u8981|\u6211\u60f3|\u9700\u8981|\u5e2e\u6211|\u8bf7|\u76ee\u6807|\u4efb\u52a1|\u65b9\u6848|\u5b9e\u73b0|\u4fee\u590d|\u52a0\u4e2a|\u505a\u4e2a|can you|please|need|goal|task|implement|fix|add/i.test(line);
}

function isErrorLine(line) {
  return /\u9519\u8bef|\u62a5\u9519|\u5931\u8d25|\u5f02\u5e38|\u5d29\u6e83|\u65e0\u6cd5|\u4e0d\u80fd|\u4e0d\u6b63\u786e|failed|error|exception|traceback|fatal|warning|warn|timeout|404|500|unauthorized|not available/i.test(line);
}

function isPathConfigLine(line) {
  return /[A-Za-z]:\\|\/[\w.-]+\/[\w.-]+|https?:\/\/|127\.0\.0\.1|localhost|:\d{2,5}\b|--[a-z0-9-]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|Qwen|DeepSeek|Claude|OpenWebUI|vLLM|llama|Docker|GPU|NVFP4|FP8|GGUF/i.test(line);
}

function isCommandLine(line) {
  return /^\s*(docker|node|npm|python|pip|hf|curl|Invoke-|Get-|Set-|Start-|Stop-|sqlite|git)\b/i.test(line) || /`[^`]+`|<Bash|tool_use|tool_result/i.test(line);
}

function isProgressLine(line) {
  return /\u5df2\u5b8c\u6210|\u5df2\u7ecf|\u65b0\u589e|\u4fee\u6539|\u9a8c\u8bc1|\u901a\u8fc7|\u91cd\u542f|\u542f\u52a8|\u5173\u95ed|\u4e0b\u8f7d|\u5378\u8f7d|configured|started|stopped|added|updated|verified/i.test(line);
}

function isOpenIssueLine(line) {
  return /\u5f85\u529e|\u4e0b\u4e00\u6b65|\u8fd8\u6ca1|\u9700\u8981\u7ee7\u7eed|\u672a\u89e3\u51b3|\u95ee\u9898|\u98ce\u9669|todo|next|pending|remaining|blocked/i.test(line);
}

function uniqueCompressionStrings(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const text = String(item || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function clipCompressionText(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 16)).trim()} ...[truncated]`;
}

function clipCompressionToEstimatedTokens(text, maxTokens) {
  const value = String(text || "");
  if (estimateTokenCount(value) <= maxTokens) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (estimateTokenCount(value.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, Math.max(0, low - 24)).trim()}\n...[summary truncated to fit budget]`;
}

function anthropicMessagesToOpenAi(body) {
  const messages = [];
  const system = anthropicContentToText(body.system);
  if (system) messages.push({ role: "system", content: system });
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    appendAnthropicMessageAsOpenAi(messages, message);
  }
  return messages;
}

function appendAnthropicMessageAsOpenAi(messages, message) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const blocks = normalizeAnthropicContentBlocks(message?.content);
  if (role === "assistant") {
    const text = [];
    const toolCalls = [];
    for (const block of blocks) {
      if (block.type === "text") text.push(String(block.text || ""));
      if (block.type === "tool_use") {
        toolCalls.push({
          id: String(block.id || `call_${crypto.randomUUID()}`),
          type: "function",
          function: {
            name: String(block.name || "tool"),
            arguments: JSON.stringify(block.input && typeof block.input === "object" ? block.input : {}),
          },
        });
      }
    }
    const openAiMessage = { role: "assistant", content: text.filter(Boolean).join("\n") || null };
    if (toolCalls.length) openAiMessage.tool_calls = toolCalls;
    if (openAiMessage.content || toolCalls.length) messages.push(openAiMessage);
    return;
  }

  let userParts = [];
  const flushUserParts = () => {
    if (!userParts.length) return;
    messages.push({ role: "user", content: openAiUserContentFromParts(userParts) });
    userParts = [];
  };
  for (const block of blocks) {
    if (block.type === "text") {
      userParts.push({ type: "text", text: String(block.text || "") });
    } else if (block.type === "image" && block.source) {
      const imageUrl = anthropicImageSourceToUrl(block.source);
      if (imageUrl) userParts.push({ type: "image_url", image_url: { url: imageUrl } });
    } else if (block.type === "tool_result") {
      flushUserParts();
      const toolCallId = String(block.tool_use_id || block.toolUseId || "");
      const content = anthropicContentToText(block.content);
      if (toolCallId) {
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: block.is_error ? `Error: ${content}` : content,
        });
      } else if (content) {
        userParts.push({ type: "text", text: content });
      }
    }
  }
  flushUserParts();
}

function normalizeAnthropicContentBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === "object");
  if (content && typeof content === "object") return [content];
  return [];
}

function openAiUserContentFromParts(parts) {
  const hasStructured = parts.some((part) => part.type !== "text");
  if (!hasStructured) return parts.map((part) => part.text || "").filter(Boolean).join("\n");
  return parts;
}

function anthropicToolsToOpenAi(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && typeof tool === "object" && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: String(tool.name),
        description: String(tool.description || ""),
        parameters: tool.input_schema || tool.inputSchema || tool.parameters || {
          type: "object",
          properties: {},
        },
      },
    }));
}

function anthropicToolChoiceToOpenAi(choice, tools) {
  if (!tools.length) return undefined;
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  const type = String(choice.type || "").toLowerCase();
  if (type === "none") return "none";
  if (type === "any" || type === "required") return "required";
  if (type === "tool" && choice.name) return { type: "function", function: { name: String(choice.name) } };
  return "auto";
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

function uniqueModelsById(models) {
  const seen = new Set();
  const results = [];
  for (const model of models) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    results.push(model);
  }
  return results;
}

function anthropicContentToOpenAi(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return anthropicContentToText(content);
  const parts = [];
  let structured = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      parts.push({ type: "text", text: String(block.text || "") });
    } else if (block.type === "image" && block.source) {
      const imageUrl = anthropicImageSourceToUrl(block.source);
      if (imageUrl) {
        structured = true;
        parts.push({ type: "image_url", image_url: { url: imageUrl } });
      }
    } else if (block.type === "tool_result") {
      parts.push({ type: "text", text: anthropicContentToText(block.content) });
    }
  }
  if (!structured) return parts.map((part) => part.text || "").filter(Boolean).join("\n");
  return parts;
}

function anthropicImageSourceToUrl(source) {
  if (source.type === "url" && source.url) return String(source.url);
  if (source.type === "base64" && source.data) {
    const mediaType = source.media_type || source.mediaType || "image/png";
    return `data:${mediaType};base64,${source.data}`;
  }
  return "";
}

function anthropicContentToText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return block.text || "";
      if (block.type === "tool_result") return anthropicContentToText(block.content);
      return "";
    }).filter(Boolean).join("\n");
  }
  if (typeof content === "object" && content.type === "text") return content.text || "";
  return "";
}

function openAiResponseToClaude(data, fallbackModel) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const content = openAiMessageToClaudeContent(message);
  const hasToolUse = content.some((block) => block.type === "tool_use");
  return {
    id: data?.id || `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: data?.model || fallbackModel,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: hasToolUse ? "tool_use" : mapOpenAiStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    },
  };
}

function openAiMessageToClaudeContent(message) {
  const content = [];
  const text = openAiMessageContentToText(message.content);
  if (text) content.push({ type: "text", text });
  for (const call of normalizeOpenAiToolCalls(message)) {
    content.push(openAiToolCallToClaudeBlock(call));
  }
  return content;
}

function normalizeOpenAiToolCalls(message) {
  const calls = Array.isArray(message?.tool_calls) ? [...message.tool_calls] : [];
  if (message?.function_call) {
    calls.push({
      id: `call_${crypto.randomUUID()}`,
      type: "function",
      function: message.function_call,
    });
  }
  return calls;
}

function openAiToolCallToClaudeBlock(call) {
  const fn = call?.function || {};
  return {
    type: "tool_use",
    id: String(call?.id || `toolu_${crypto.randomUUID()}`),
    name: String(fn.name || call?.name || "tool"),
    input: parseToolArguments(fn.arguments ?? call?.arguments),
  };
}

function parseToolArguments(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object") return value;
  const parsed = parseJsonSafe(String(value), null);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  if (parsed !== null) return { value: parsed };
  return { raw: String(value) };
}

function openAiMessageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

async function sendClaudeUpstreamError(res, upstream) {
  const text = await upstream.text().catch(() => "");
  const data = parseJsonSafe(text, null);
  return res.status(upstream.status).json(claudeError("api_error", upstreamErrorMessage(data, text)));
}

async function streamOpenAiAsClaude(upstream, res, fallbackModel, usageContext = {}) {
  const messageId = `msg_${crypto.randomUUID()}`;
  const model = fallbackModel || "local-model";
  let stopReason = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";
  let nextContentIndex = 0;
  let textBlockIndex = null;
  const toolCallDeltas = new Map();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  writeClaudeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  const ensureTextBlock = () => {
    if (textBlockIndex !== null) return textBlockIndex;
    textBlockIndex = nextContentIndex++;
    writeClaudeSse(res, "content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
    return textBlockIndex;
  };

  let streamError = null;
  try {
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body) {
      if (res.destroyed) break;
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          const data = parseJsonSafe(payload, null);
          if (!data) continue;
          if (data.usage) {
            inputTokens = data.usage.prompt_tokens || inputTokens;
            outputTokens = data.usage.completion_tokens || outputTokens;
          }
          const choice = data.choices?.[0] || {};
          const delta = choice.delta || {};
          const deltaText = delta.content || choice.message?.content || "";
          if (deltaText) {
            const index = ensureTextBlock();
            writeClaudeSse(res, "content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: deltaText },
            });
          }
          if (Array.isArray(delta.tool_calls)) mergeOpenAiToolCallDeltas(toolCallDeltas, delta.tool_calls);
          if (Array.isArray(choice.message?.tool_calls)) mergeOpenAiToolCallDeltas(toolCallDeltas, choice.message.tool_calls);
          if (choice.finish_reason) stopReason = mapOpenAiStopReason(choice.finish_reason);
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    streamError = error;
  }

  if (res.destroyed || isExpectedStreamDisconnect(streamError, res)) {
    await recordClaudeBridgeUsage({
      requestedModel: usageContext.requestedModel || "",
      model,
      ok: false,
      stream: true,
      error: streamError?.message || "Client disconnected mid-stream.",
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      latencyMs: Date.now() - Number(usageContext.startedAt || Date.now()),
      toolSchemaCount: Number(usageContext.toolSchemaCount || 0),
      compression: usageContext.compression,
    }).catch(() => {});
    if (!res.writableEnded) res.end();
    return;
  }

  if (streamError) {
    writeClaudeSse(res, "error", {
      type: "error",
      error: { type: "api_error", message: `Upstream stream failed: ${streamError.message}` },
    });
    await recordClaudeBridgeUsage({
      requestedModel: usageContext.requestedModel || "",
      model,
      ok: false,
      stream: true,
      error: streamError.message,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      latencyMs: Date.now() - Number(usageContext.startedAt || Date.now()),
      toolSchemaCount: Number(usageContext.toolSchemaCount || 0),
      compression: usageContext.compression,
    }).catch(() => {});
    res.end();
    return;
  }

  if (textBlockIndex !== null) {
    writeClaudeSse(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
  }
  const toolBlocks = Array.from(toolCallDeltas.values())
    .sort((a, b) => a.index - b.index)
    .map((call) => openAiToolCallToClaudeBlock({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  for (const block of toolBlocks) {
    const index = nextContentIndex++;
    writeClaudeSse(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    const partialJson = JSON.stringify(block.input || {});
    if (partialJson && partialJson !== "{}") {
      writeClaudeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: partialJson },
      });
    }
    writeClaudeSse(res, "content_block_stop", { type: "content_block_stop", index });
  }
  if (toolBlocks.length) stopReason = "tool_use";
  if (textBlockIndex === null && !toolBlocks.length) {
    const index = ensureTextBlock();
    writeClaudeSse(res, "content_block_stop", { type: "content_block_stop", index });
  }
  writeClaudeSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  writeClaudeSse(res, "message_stop", { type: "message_stop" });
  await recordClaudeBridgeUsage({
    requestedModel: usageContext.requestedModel || "",
    model,
    ok: true,
    stream: true,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    latencyMs: Date.now() - Number(usageContext.startedAt || Date.now()),
    toolSchemaCount: Number(usageContext.toolSchemaCount || 0),
    toolUseCount: toolBlocks.length,
    stopReason,
    compression: usageContext.compression,
  }).catch(() => {});
  res.end();
}

function mergeOpenAiToolCallDeltas(target, deltas) {
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : target.size;
    const current = target.get(index) || { index, id: "", name: "", arguments: "" };
    if (delta.id) current.id = String(delta.id);
    const fn = delta.function || {};
    if (fn.name) {
      const nextName = String(fn.name);
      current.name = current.name && nextName.startsWith(current.name) ? nextName : current.name + nextName;
    }
    if (fn.arguments) current.arguments += String(fn.arguments);
    if (delta.arguments) current.arguments += String(delta.arguments);
    if (delta.name && !current.name) current.name = String(delta.name);
    target.set(index, current);
  }
}

function writeClaudeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function mapOpenAiStopReason(reason) {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "content_filter") return "stop_sequence";
  return "end_turn";
}

function claudeError(type, message) {
  return {
    type: "error",
    error: {
      type,
      message: String(message || "Claude compatibility bridge error."),
    },
  };
}

function upstreamErrorMessage(data, text) {
  return data?.error?.message || data?.message || text || "Upstream model service returned an error.";
}

function isExpectedStreamDisconnect(error, res = null) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || error?.cause?.code || "");
  return Boolean(
    res?.destroyed ||
    res?.writableEnded ||
    error?.name === "AbortError" ||
    code === "UND_ERR_ABORTED" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    message === "terminated" ||
    message.includes("aborted") ||
    message.includes("premature close")
  );
}

function estimateTokenCount(text) {
  const value = String(text || "");
  const ascii = value.replace(/[^\x00-\x7F]/g, "");
  const nonAscii = value.length - ascii.length;
  return Math.max(1, Math.ceil(ascii.length / 4 + nonAscii * 1.6));
}

async function recordClaudeBridgeUsage(event = {}) {
  const ledger = await loadStatsLedger();
  const clients = ledger.clients && typeof ledger.clients === "object" ? ledger.clients : {};
  const claude = normalizeClientUsageCounters(clients.claude, "claude", "Claude 兼容桥");
  const usage = event.usage || {};
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const latencyMs = Math.max(0, Number(event.latencyMs || 0));
  const model = String(event.model || event.requestedModel || "unknown");
  claude.requests.total += 1;
  if (event.ok === false) claude.requests.error += 1;
  else claude.requests.success += 1;
  if (event.stream) claude.requests.streamed += 1;
  claude.tokens.prompt += inputTokens;
  claude.tokens.generation += outputTokens;
  claude.tokens.total = claude.tokens.prompt + claude.tokens.generation;
  claude.tools.schemas += Number(event.toolSchemaCount || 0);
  claude.tools.toolUse += Number(event.toolUseCount || 0);
  if (event.compression?.applied) {
    claude.compression.applied += 1;
    claude.compression.savedTokens += Number(event.compression.savedTokens || 0);
  }
  claude.latency.totalMs += latencyMs;
  claude.latency.maxMs = Math.max(claude.latency.maxMs || 0, latencyMs);
  claude.latency.avgMs = claude.requests.total ? claude.latency.totalMs / claude.requests.total : 0;
  claude.models[model] = mergeClientModelBucket(claude.models[model], {
    prompt: inputTokens,
    generation: outputTokens,
    ok: event.ok !== false,
    stream: Boolean(event.stream),
    toolSchemaCount: Number(event.toolSchemaCount || 0),
    toolUseCount: Number(event.toolUseCount || 0),
    compression: event.compression || {},
    latencyMs,
  });
  if (event.requestedModel) {
    claude.aliases[String(event.requestedModel)] = Number(claude.aliases[String(event.requestedModel)] || 0) + 1;
  }
  claude.compression.last = {
    applied: Boolean(event.compression?.applied),
    savedTokens: Number(event.compression?.savedTokens || 0),
    recentMessageCount: Number(event.compression?.recentMessageCount || 0),
    summarizedMessageCount: Number(event.compression?.summarizedMessageCount || 0),
    originalPromptTokens: Number(event.compression?.originalPromptTokens || 0),
    compressedPromptTokens: Number(event.compression?.compressedPromptTokens || 0),
    contextLimit: Number(event.compression?.contextLimit || 0),
  };
  claude.last = {
    at: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requestedModel: String(event.requestedModel || ""),
    model,
    ok: event.ok !== false,
    error: event.error || null,
    latencyMs,
    stream: Boolean(event.stream),
    stopReason: event.stopReason || null,
  };
  clients.claude = claude;
  ledger.clients = clients;
  ledger.updatedAt = new Date().toISOString();
  await saveStatsLedger(ledger);
  return claude;
}

function normalizeClientUsageCounters(value, id, label) {
  const item = value && typeof value === "object" ? value : {};
  const prompt = Number(item.tokens?.prompt || 0);
  const generation = Number(item.tokens?.generation || 0);
  const requestsTotal = Number(item.requests?.total || 0);
  const latencyTotal = Number(item.latency?.totalMs || 0);
  return {
    id: item.id || id,
    label: item.label || label,
    tokens: {
      prompt,
      generation,
      cachedPrompt: Number(item.tokens?.cachedPrompt || 0),
      total: Number(item.tokens?.total || prompt + generation),
    },
    requests: {
      total: requestsTotal,
      success: Number(item.requests?.success || 0),
      error: Number(item.requests?.error || 0),
      streamed: Number(item.requests?.streamed || 0),
    },
    tools: {
      schemas: Number(item.tools?.schemas ?? item.tools?.schemaCount ?? 0),
      toolUse: Number(item.tools?.toolUse ?? item.tools?.toolUseCount ?? 0),
    },
    compression: {
      applied: Number(item.compression?.applied || 0),
      savedTokens: Number(item.compression?.savedTokens || 0),
      last: item.compression?.last || {},
    },
    latency: {
      totalMs: latencyTotal,
      avgMs: Number(item.latency?.avgMs || (requestsTotal ? latencyTotal / requestsTotal : 0)),
      maxMs: Number(item.latency?.maxMs || 0),
    },
    models: item.models && typeof item.models === "object" ? item.models : {},
    aliases: item.aliases && typeof item.aliases === "object" ? item.aliases : {},
    last: item.last || {},
  };
}

function normalizeClientModelBucket(value) {
  const item = value && typeof value === "object" ? value : {};
  const prompt = Number(item.tokens?.prompt || 0);
  const generation = Number(item.tokens?.generation || 0);
  const requestsTotal = Number(item.requests?.total || 0);
  const latencyTotal = Number(item.latency?.totalMs || 0);
  return {
    tokens: {
      prompt,
      generation,
      total: Number(item.tokens?.total || prompt + generation),
    },
    requests: {
      total: requestsTotal,
      success: Number(item.requests?.success || 0),
      error: Number(item.requests?.error || 0),
      streamed: Number(item.requests?.streamed || 0),
    },
    tools: {
      schemas: Number(item.tools?.schemas || 0),
      toolUse: Number(item.tools?.toolUse || 0),
    },
    compression: {
      applied: Number(item.compression?.applied || 0),
      savedTokens: Number(item.compression?.savedTokens || 0),
    },
    latency: {
      totalMs: latencyTotal,
      avgMs: Number(item.latency?.avgMs || (requestsTotal ? latencyTotal / requestsTotal : 0)),
      maxMs: Number(item.latency?.maxMs || 0),
    },
  };
}

function mergeClientModelBucket(previous, delta) {
  const bucket = normalizeClientModelBucket(previous);
  const prompt = Number(delta.prompt || 0);
  const generation = Number(delta.generation || 0);
  const latencyMs = Math.max(0, Number(delta.latencyMs || 0));
  bucket.tokens.prompt += prompt;
  bucket.tokens.generation += generation;
  bucket.tokens.total = bucket.tokens.prompt + bucket.tokens.generation;
  bucket.requests.total += 1;
  if (delta.ok === false) bucket.requests.error += 1;
  else bucket.requests.success += 1;
  if (delta.stream) bucket.requests.streamed += 1;
  bucket.tools.schemas += Number(delta.toolSchemaCount || 0);
  bucket.tools.toolUse += Number(delta.toolUseCount || 0);
  if (delta.compression?.applied) {
    bucket.compression.applied += 1;
    bucket.compression.savedTokens += Number(delta.compression.savedTokens || 0);
  }
  bucket.latency.totalMs += latencyMs;
  bucket.latency.maxMs = Math.max(bucket.latency.maxMs || 0, latencyMs);
  bucket.latency.avgMs = bucket.requests.total ? bucket.latency.totalMs / bucket.requests.total : 0;
  return bucket;
}

async function verifyAuditPassword(candidate) {
  const entered = normalizeAuditPassword(candidate);
  const candidates = await getAuditPasswordCandidates();
  return candidates.some((expected) => timingSafeEqualText(entered, normalizeAuditPassword(expected)));
}

async function getAuditPassword() {
  const envPassword = normalizeAuditPassword(process.env.AI_AUDIT_ADMIN_PASSWORD || "");
  if (envPassword) return envPassword;
  if (auditPasswordCache) return auditPasswordCache;

  await ensureDirs(path.dirname(AUDIT_PASSWORD_FILE));
  try {
    const existing = normalizeAuditPassword(await fsp.readFile(AUDIT_PASSWORD_FILE, "utf8"));
    if (existing) {
      auditPasswordCache = existing;
      return existing;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const generated = crypto.randomBytes(24).toString("base64url");
  try {
    await fsp.writeFile(AUDIT_PASSWORD_FILE, generated, { encoding: "utf8", flag: "wx" });
    auditPasswordCache = generated;
    return generated;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = normalizeAuditPassword(await fsp.readFile(AUDIT_PASSWORD_FILE, "utf8"));
    if (!existing) throw new Error(`Audit password file is empty: ${AUDIT_PASSWORD_FILE}`);
    auditPasswordCache = existing;
    return existing;
  }
}

async function getAuditPasswordCandidates() {
  const candidates = [await getAuditPassword()];
  for (const file of AUDIT_LEGACY_PASSWORD_FILES) {
    if (path.resolve(file) === path.resolve(AUDIT_PASSWORD_FILE)) continue;
    const value = normalizeAuditPassword(await fsp.readFile(file, "utf8").catch(() => ""));
    if (value) candidates.push(value);
  }
  return Array.from(new Set(candidates));
}

function normalizeAuditPassword(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim();
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, Buffer.alloc(leftBuffer.length));
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createAuditSession() {
  cleanupAuditSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + AUDIT_SESSION_TTL_MS;
  auditSessions.set(hashText(token), { createdAt: Date.now(), expiresAt });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

function getAuditAuth(req) {
  const header = String(req.get("authorization") || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return { token: match ? match[1].trim() : "" };
}

function requireAuditAuth(req) {
  cleanupAuditSessions();
  const { token } = getAuditAuth(req);
  if (!token) return { ok: false, status: 401, message: "需要先输入审计密码。" };
  const key = hashText(token);
  const session = auditSessions.get(key);
  if (!session || session.expiresAt < Date.now()) {
    auditSessions.delete(key);
    return { ok: false, status: 401, message: "审计登录已过期，请重新输入密码。" };
  }
  session.expiresAt = Date.now() + AUDIT_SESSION_TTL_MS;
  return { ok: true };
}

function cleanupAuditSessions() {
  const now = Date.now();
  for (const [key, session] of auditSessions.entries()) {
    if (!session || session.expiresAt < now) auditSessions.delete(key);
  }
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

async function listAuditExports() {
  await ensureDirs(CONFIG.auditRoot);
  const entries = await fsp.readdir(CONFIG.auditRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const exports = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const auditId = entry.name;
    const auditDir = path.join(CONFIG.auditRoot, auditId);
    const manifest = parseJsonSafe(await fsp.readFile(path.join(auditDir, "manifest.json"), "utf8").catch(() => ""), {});
    const mdPath = path.join(auditDir, "openwebui-chats-full.md");
    const mdStat = await fsp.stat(mdPath).catch(() => null);
    exports.push({
      auditId,
      auditDir,
      reason: manifest.reason || "",
      manager: manifest.manager || "",
      createdAt: manifest.createdAt || mdStat?.mtime?.toISOString() || "",
      openWebuiContainer: manifest.openWebuiContainer || CONFIG.openWebuiContainer,
      serviceContainer: manifest.serviceContainer || "",
      chatCount: manifest.summary?.chat_count || manifest.chatCount || 0,
      messageCount: manifest.summary?.message_count || manifest.messageCount || 0,
      mdFile: mdStat ? "openwebui-chats-full.md" : "",
      mdBytes: mdStat?.size || 0,
      files: Array.isArray(manifest.summary?.files) ? manifest.summary.files : [],
    });
  }
  return exports.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function getAuditMarkdownPath(auditIdValue) {
  const auditId = cleanAuditId(auditIdValue);
  const root = path.resolve(CONFIG.auditRoot);
  const auditDir = path.resolve(root, auditId);
  if (!auditDir.startsWith(root + path.sep)) {
    const error = new Error("Invalid audit folder.");
    error.status = 400;
    throw error;
  }
  const file = path.join(auditDir, "openwebui-chats-full.md");
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) {
    const error = new Error("未找到该审计记录的 Markdown 文件。");
    error.status = 404;
    throw error;
  }
  return file;
}

function cleanAuditId(value) {
  const auditId = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(auditId)) {
    const error = new Error("Invalid audit id.");
    error.status = 400;
    throw error;
  }
  return auditId;
}

async function exportOpenWebuiAudit(reason = "manual", context = {}) {
  await ensureDirs(CONFIG.auditRoot);
  const container = await getContainerStatus(CONFIG.openWebuiContainer);
  if (!container.exists) {
    return {
      ok: false,
      skipped: true,
      reason: `Open WebUI container not found: ${CONFIG.openWebuiContainer}`,
      auditRoot: CONFIG.auditRoot,
    };
  }

  const stamp = compactTimestamp();
  const auditId = `${stamp}-${safeOutputName(reason)}-${safeOutputName(CONFIG.containerName)}`;
  const auditDir = path.join(CONFIG.auditRoot, auditId);
  await ensureDirs(auditDir);

  const scriptPath = path.join(auditDir, "openwebui_audit_export.py");
  const remoteScript = `/tmp/openwebui_audit_export_${auditId}.py`;
  const remoteDir = `/tmp/openwebui_audit_${auditId}`;
  await fsp.writeFile(scriptPath, OPENWEBUI_AUDIT_EXPORTER, "utf8");
  await docker(["cp", scriptPath, `${CONFIG.openWebuiContainer}:${remoteScript}`]);
  const run = await docker(["exec", CONFIG.openWebuiContainer, "python", remoteScript, remoteDir], { rejectOnError: false });
  if (run.error) {
    throw new Error(`Open WebUI audit export failed: ${run.stderr || run.stdout || run.error.message}`);
  }
  await docker(["cp", `${CONFIG.openWebuiContainer}:${remoteDir}/.`, auditDir]);
  await docker(["exec", CONFIG.openWebuiContainer, "sh", "-lc", `rm -rf ${shellQuote(remoteDir)} ${shellQuote(remoteScript)}`], { rejectOnError: false });

  const summary = parseJsonSafe(run.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1), {});
  const manifest = {
    ok: true,
    auditId,
    reason,
    manager: context.manager || "llama-manager",
    createdAt: new Date().toISOString(),
    auditDir,
    openWebuiContainer: CONFIG.openWebuiContainer,
    serviceContainer: CONFIG.containerName,
    context,
    summary,
    notice: "This folder may contain full Open WebUI conversation records. Keep it access-controlled and use it only for authorized audit or incident response.",
  };

  await fsp.writeFile(path.join(auditDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(auditDir, "README.txt"), [
    "Open WebUI audit export",
    "",
    "This folder may contain full conversation records and should be access-controlled.",
    "Files are generated locally for authorized audit or incident response.",
    "Do not publish or share raw contents unless you have the legal authority to do so.",
    "",
    `Created: ${manifest.createdAt}`,
    `Reason: ${reason}`,
  ].join("\n"), "utf8");
  const hashes = await hashFilesInDir(auditDir);
  await fsp.writeFile(path.join(auditDir, "SHA256SUMS.txt"), hashes.map((item) => `${item.sha256}  ${item.relative}`).join("\n") + "\n", "utf8");

  return {
    ok: true,
    auditId,
    auditDir,
    chatCount: summary.chat_count || 0,
    messageCount: summary.message_count || 0,
    files: hashes.map((item) => item.relative),
  };
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseJsonSafe(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function hashFilesInDir(dir) {
  const results = [];
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const relative = path.relative(dir, full).replace(/\\/g, "/");
        results.push({ relative, sha256: await sha256File(full) });
      }
    }
  }
  await walk(dir);
  return results.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const data = await fsp.readFile(file);
  hash.update(data);
  return hash.digest("hex");
}

const OPENWEBUI_AUDIT_EXPORTER = String.raw`
import datetime
import hashlib
import json
import os
import sqlite3
import sys

DB = "/app/backend/data/webui.db"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/openwebui_audit_export"
os.makedirs(OUT, exist_ok=True)

def ts(value):
    if value is None:
        return None
    try:
        number = float(value)
        if number > 1e12:
            number = number / 1000
        return datetime.datetime.fromtimestamp(number, datetime.timezone.utc).isoformat()
    except Exception:
        return str(value)

def load_json(value, fallback):
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return fallback

def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def extract_messages(chat_obj):
    messages = []
    seen = set()
    if not isinstance(chat_obj, dict):
        return messages
    root_messages = chat_obj.get("messages")
    if isinstance(root_messages, list):
        for index, msg in enumerate(root_messages):
            if isinstance(msg, dict):
                seen.add(id(msg))
                messages.append((str(msg.get("id") or index), msg))
    history = chat_obj.get("history") or {}
    hist_messages = history.get("messages") if isinstance(history, dict) else None
    if isinstance(hist_messages, dict):
        for key, msg in hist_messages.items():
            if isinstance(msg, dict) and id(msg) not in seen:
                messages.append((str(key), msg))
    elif isinstance(hist_messages, list):
        for index, msg in enumerate(hist_messages):
            if isinstance(msg, dict) and id(msg) not in seen:
                messages.append((f"history-{index}", msg))
    return messages

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
rows = con.execute("""
    select c.id, c.user_id, c.title, c.share_id, c.archived, c.created_at, c.updated_at,
           c.chat, c.pinned, c.meta, c.folder_id, c.tasks, c.summary, c.last_read_at,
           u.name as user_name, u.email as user_email, u.role as user_role
    from chat c
    left join user u on u.id = c.user_id
    order by c.updated_at desc
""").fetchall()

users = [dict(row) for row in con.execute("select id, name, email, role, created_at, updated_at, last_active_at from user order by created_at")]
export = {
    "exported_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "source": DB,
    "format": "openwebui-full-audit-v1",
    "chat_count": len(rows),
    "message_count": 0,
    "users": users,
    "chats": [],
}

markdown = [
    "# Open WebUI Full Conversation Audit Export",
    "",
    f"- Exported UTC: {export['exported_at_utc']}",
    f"- Chat count: {len(rows)}",
    "",
]

for row in rows:
    chat_obj = load_json(row["chat"], {})
    meta = load_json(row["meta"], {})
    tasks = load_json(row["tasks"], None)
    messages = []
    for msg_id, msg in extract_messages(chat_obj):
        content = msg.get("content")
        item = {
            "id": msg.get("id") or msg_id,
            "parent_id": msg.get("parentId") or msg.get("parent_id"),
            "role": msg.get("role"),
            "model": msg.get("model"),
            "timestamp": ts(msg.get("timestamp") or msg.get("created_at")),
            "content": content,
            "content_sha256": hashlib.sha256(str(content or "").encode("utf-8")).hexdigest(),
            "metadata": {k: v for k, v in msg.items() if k not in {"content"}},
        }
        messages.append(item)
    export["message_count"] += len(messages)
    chat_record = {
        "id": row["id"],
        "user_id": row["user_id"],
        "user_name": row["user_name"],
        "user_email": row["user_email"],
        "user_role": row["user_role"],
        "title": row["title"],
        "share_id": row["share_id"],
        "archived": bool(row["archived"]),
        "pinned": bool(row["pinned"]) if row["pinned"] is not None else False,
        "folder_id": row["folder_id"],
        "created_at": ts(row["created_at"]),
        "updated_at": ts(row["updated_at"]),
        "last_read_at": ts(row["last_read_at"]),
        "summary": row["summary"],
        "meta": meta,
        "tasks": tasks,
        "models": chat_obj.get("models") if isinstance(chat_obj, dict) else [],
        "params": chat_obj.get("params") if isinstance(chat_obj, dict) else {},
        "raw_chat": chat_obj,
        "message_count": len(messages),
        "messages": messages,
    }
    export["chats"].append(chat_record)
    markdown.append(f"## {row['title'] or '[untitled]'}")
    markdown.append("")
    markdown.append(f"- Chat ID: {row['id']}")
    markdown.append(f"- User ID: {row['user_id'] or '-'}")
    markdown.append(f"- User: {row['user_name'] or '-'} <{row['user_email'] or '-'}>")
    markdown.append(f"- Created: {chat_record['created_at']}")
    markdown.append(f"- Updated: {chat_record['updated_at']}")
    markdown.append(f"- Models: {', '.join(map(str, chat_record['models'] or [])) or '-'}")
    markdown.append(f"- Messages: {len(messages)}")
    markdown.append("")
    for msg in messages:
        markdown.append(f"### {msg.get('role') or 'unknown'}")
        markdown.append("")
        if msg.get("model"):
            markdown.append(f"_model: {msg['model']}_")
            markdown.append("")
        markdown.append(str(msg.get("content") or ""))
        markdown.append("")
    markdown.append("")

json_path = os.path.join(OUT, "openwebui-chats-full.json")
md_path = os.path.join(OUT, "openwebui-chats-full.md")
with open(json_path, "w", encoding="utf-8") as f:
    json.dump(export, f, ensure_ascii=False, indent=2)
with open(md_path, "w", encoding="utf-8") as f:
    f.write("\n".join(markdown))

db_hashes = {}
for name in ["webui.db", "webui.db-wal", "webui.db-shm"]:
    p = os.path.join("/app/backend/data", name)
    if os.path.exists(p):
        db_hashes[name] = {
            "sha256": file_hash(p),
            "size": os.path.getsize(p),
            "mtime_utc": datetime.datetime.fromtimestamp(os.path.getmtime(p), datetime.timezone.utc).isoformat(),
        }

summary = {
    "ok": True,
    "chat_count": export["chat_count"],
    "message_count": export["message_count"],
    "users": len(users),
    "files": [os.path.basename(json_path), os.path.basename(md_path)],
    "db_hashes": db_hashes,
}
with open(os.path.join(OUT, "openwebui-db-hashes.json"), "w", encoding="utf-8") as f:
    json.dump(db_hashes, f, ensure_ascii=False, indent=2)
print(json.dumps(summary, ensure_ascii=False))
`;

function cleanRequired(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name} is required`);
    error.status = 400;
    throw error;
  }
  return text;
}

function safeOutputName(name) {
  const cleaned = String(name || "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "-")
    .replace(/[\\/]+/g, "__")
    .replace(/\.\.+/g, ".")
    .trim();
  return cleaned || `model-${Date.now()}`;
}

function resolveModelsRootChild(target) {
  const root = path.resolve(CONFIG.modelsRoot);
  const resolved = path.resolve(String(target || ""));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const error = new Error("download path must be inside models root");
    error.status = 400;
    throw error;
  }
  return resolved;
}

function cleanDownloadSource(value) {
  const source = String(value || "huggingface").toLowerCase();
  if (source === "huggingface" || source === "modelscope") return source;
  const error = new Error(`Unsupported download source: ${source}`);
  error.status = 400;
  throw error;
}

function buildDownloadEnv() {
  return {
    ...process.env,
    HF_HOME: CONFIG.hfCache,
    HUGGINGFACE_HUB_CACHE: path.join(CONFIG.hfCache, "hub"),
    MODELSCOPE_CACHE: path.join(CONFIG.hfCache, "modelscope"),
  };
}

function cleanOptionalLaunchArg(value) {
  return String(value || "").trim();
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

function normalizeLlamaSplitMode(value) {
  const mode = String(value || "layer").trim().toLowerCase();
  if (mode === "single") return "none";
  if (mode === "pipeline") return "layer";
  if (mode === "data") return "layer";
  return new Set(["none", "layer", "tensor", "row"]).has(mode) ? mode : "layer";
}

function normalizeMainGpu(value, gpuDeviceIds = []) {
  const selected = (gpuDeviceIds || []).map(String);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  const asText = String(value).trim();
  const hostIndex = selected.indexOf(asText);
  if (hostIndex >= 0) return hostIndex;
  const ordinal = Math.floor(number);
  if (selected.length && ordinal >= selected.length) return 0;
  return ordinal;
}

function mainGpuHostId(mainGpu, gpuDeviceIds = []) {
  const selected = (gpuDeviceIds || []).map(String);
  return selected[mainGpu] ?? String(mainGpu || 0);
}

function suggestTensorSplit(gpus, gpuDeviceIds = [], utilization = 0.92, mode = "layer") {
  const plan = buildLlamaGpuPlan({ ok: true, gpus: gpus || [] }, gpuDeviceIds, utilization, mode);
  return plan.recommendedTensorSplit || "";
}

function buildLlamaGpuPlan(gpuStatus, gpuDeviceIds = [], utilization = 0.92, mode = "layer", mainGpuValue = null) {
  const allGpus = Array.isArray(gpuStatus?.gpus) ? gpuStatus.gpus : [];
  const selectedIds = normalizeGpuIds(gpuDeviceIds);
  const ratio = Math.min(0.98, Math.max(0.1, Number(utilization || 0.92)));
  const selected = selectPlanGpus(allGpus, selectedIds).map((gpu, visibleIndex) => normalizePlanGpu(gpu, visibleIndex, ratio));
  const selectedGpuIds = selected.map((gpu) => gpu.id);
  const splitMode = normalizeLlamaSplitMode(mode);
  const mainGpu = normalizeMainGpu(mainGpuValue, selectedGpuIds);
  const primary = selected[mainGpu] || selected[0] || null;
  const hetero = isHeterogeneousGpuSet(selected);

  if (selected.length < 2 || splitMode === "none") {
    return {
      ok: Boolean(selected.length),
      selectedGpuIds,
      selected,
      visibleCount: selected.length,
      hetero,
      recommendedMode: "none",
      recommendedTensorSplit: "",
      mainGpu,
      mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
      summary: selected.length
        ? `Single GPU mode on GPU ${primary?.id || mainGpu}`
        : "No NVIDIA GPU selected",
      profiles: selected.length ? buildSingleGpuProfiles(selected, mainGpu) : [],
      notes: selected.length
        ? ["只选择一张 GPU 时，llama.cpp 容器内 main-gpu 应为 0。"]
        : ["未检测到可用于规划的 NVIDIA GPU。"],
    };
  }

  const memorySplit = splitStringFromWeights(selected.map((gpu) => gpu.usableGb));
  const speedSplit = splitStringFromWeights(selected.map((gpu) => gpu.usableGb * gpu.performanceFactor));
  const lightOffloadSplit = buildLightOffloadSplit(selected);
  const recommendedTensorSplit = splitMode === "layer"
    ? lightOffloadSplit || speedSplit || memorySplit
    : splitMode === "row"
      ? memorySplit
      : speedSplit || memorySplit;
  const profiles = [
    {
      id: "hetero-layer-speed",
      label: "异构稳妥",
      mode: "layer",
      tensorSplit: lightOffloadSplit || speedSplit || memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
      description: `${shortGpuLabel(primary?.name, primary?.id)} 承担更多层，其它 GPU 轻量分担，通常更适合本地 Claude 单路交互。`,
    },
    {
      id: "hetero-layer-capacity",
      label: "长上下文",
      mode: "layer",
      tensorSplit: memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
      description: "按可用显存接近 2:1 分配，优先换更长上下文和更大 KV cache。",
    },
    {
      id: "row-balanced",
      label: "row 并行",
      mode: "row",
      tensorSplit: memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
      description: "行切分有并行收益，但 KV 和中间结果更依赖 main GPU，建议先做短测。",
    },
    {
      id: "tensor-experimental",
      label: "tensor 实验",
      mode: "tensor",
      tensorSplit: speedSplit || memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
      description: "张量切分可能提高吞吐，但异构卡更容易被慢卡拖住。",
    },
  ];

  return {
    ok: true,
    selectedGpuIds,
    selected,
    visibleCount: selected.length,
    hetero,
    recommendedMode: splitMode,
    recommendedTensorSplit,
    memoryTensorSplit: memorySplit,
    speedTensorSplit: speedSplit,
    lightOffloadTensorSplit: lightOffloadSplit,
    mainGpu,
    mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
    summary: hetero
      ? `${selected.length} 张异构 GPU：建议 main GPU ${primary?.id || 0}，${splitMode} split ${recommendedTensorSplit}`
      : `${selected.length} 张同级 GPU：建议 ${splitMode} split ${recommendedTensorSplit}`,
    profiles,
    notes: [
      "main-gpu 传给 llama.cpp 的是容器内可见序号，不是宿主机物理编号。",
      hetero
        ? "异构多卡优先 layer；小显存或较慢的卡适合轻量分担或长上下文扩容，不一定让单路速度翻倍。"
        : "同级多卡可以更积极尝试 row 或 tensor split。",
    ],
  };
}

function selectPlanGpus(gpus, selectedIds = []) {
  if (!Array.isArray(gpus) || !gpus.length) return [];
  const ids = (selectedIds || []).map(String);
  const selected = ids.length
    ? gpus.filter((gpu) => ids.includes(String(gpu.id)) || ids.includes(String(gpu.index)))
    : gpus;
  return selected.length ? selected : [gpus[0]];
}

function normalizePlanGpu(gpu, visibleIndex, utilization) {
  const totalMb = Number(gpu.totalMb || 0);
  const usedMb = Number(gpu.usedMb || 0);
  const freeMb = Math.max(0, totalMb - usedMb);
  const usableMb = Math.max(1024, Math.floor(Math.min(totalMb * utilization, Math.max(1024, freeMb - 1024))));
  const name = String(gpu.name || "NVIDIA GPU");
  return {
    id: String(gpu.id ?? gpu.index ?? visibleIndex),
    index: Number(gpu.index ?? gpu.id ?? visibleIndex),
    visibleIndex,
    name,
    totalMb,
    usedMb,
    freeMb,
    usableMb,
    totalGb: roundGb(totalMb),
    usedGb: roundGb(usedMb),
    freeGb: roundGb(freeMb),
    usableGb: roundGb(usableMb),
    utilization: Number(gpu.util || 0),
    temp: Number(gpu.temp || 0),
    performanceFactor: estimateGpuPerformanceFactor(name),
  };
}

function roundGb(mb) {
  return Math.round((Number(mb || 0) / 1024) * 10) / 10;
}

function estimateGpuPerformanceFactor(name) {
  const text = String(name || "").toLowerCase();
  if (text.includes("blackwell") || text.includes("rtx pro 6000") || text.includes("pro 6000")) return 1.55;
  if (text.includes("5090")) return 1.45;
  if (text.includes("5080")) return 1.18;
  if (text.includes("5070 ti")) return 0.86;
  if (text.includes("5070")) return 0.76;
  if (text.includes("4090")) return 1.1;
  if (text.includes("4080")) return 0.9;
  return 1;
}

function shortGpuLabel(name, fallbackId = "0") {
  const text = String(name || "").replace(/^NVIDIA\s+/i, "").trim();
  if (!text) return `GPU ${fallbackId}`;
  if (/RTX PRO 6000/i.test(text)) return "RTX PRO 6000";
  if (/RTX 6000/i.test(text)) return "RTX 6000";
  const match = text.match(/(RTX\s+\d{4}(?:\s*Ti)?|A100|H100|H200|B200|L40S)/i);
  return match ? match[1].replace(/\s+/g, " ") : `GPU ${fallbackId}`;
}

function isHeterogeneousGpuSet(gpus) {
  if (!gpus || gpus.length < 2) return false;
  const totals = gpus.map((gpu) => Number(gpu.totalMb || 0)).filter(Boolean);
  const names = new Set(gpus.map((gpu) => String(gpu.name || "").replace(/\s+/g, " ").trim().toLowerCase()));
  if (names.size > 1) return true;
  if (totals.length < 2) return false;
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  return min > 0 && max / min > 1.2;
}

function splitStringFromWeights(weights) {
  const clean = (weights || []).map((value) => Math.max(1, Number(value || 0)));
  if (clean.length < 2) return "";
  return clean.map((value) => String(Math.max(1, Math.round(value)))).join(",");
}

function buildLightOffloadSplit(gpus) {
  if (!gpus || gpus.length !== 2) return "";
  const [first, second] = gpus;
  const bigger = first.usableGb >= second.usableGb ? first : second;
  const smaller = bigger === first ? second : first;
  const memoryRatio = bigger.usableGb / Math.max(1, smaller.usableGb);
  if (memoryRatio < 1.35) return "";
  const bigShare = Math.max(1, Math.round(bigger.usableGb * 0.82));
  const smallShare = Math.max(1, Math.round(smaller.usableGb * 0.55));
  return gpus.map((gpu) => gpu === bigger ? bigShare : smallShare).join(",");
}

function buildSingleGpuProfiles(gpus, mainGpu) {
  return gpus.map((gpu) => ({
    id: `single-${gpu.id}`,
    label: `只用 GPU ${gpu.id}`,
    mode: "none",
    tensorSplit: "",
    mainGpu,
    mainGpuHostId: gpu.id,
    description: `${gpu.name} · 可用约 ${gpu.usableGb} GB。`,
  }));
}

function normalizeDownloadModelReference(model, precision) {
  const raw = String(model || "").trim();
  const match = raw.match(/^([^:\s]+\/[^:\s]+):([A-Za-z0-9_.+-]+)$/);
  if (!match) {
    return { model: raw, precision: normalizeRemoteQuantFilter(precision) };
  }
  return {
    model: match[1],
    precision: normalizeRemoteQuantFilter(precision) || normalizeRemoteQuantFilter(match[2]),
  };
}

function buildDownloadCommand(source, model, localDir, options = {}) {
  if (source === "modelscope") {
    return {
      command: CONFIG.modelScopeCli,
      args: ["download", "--model", model, "--local_dir", localDir],
      label: "ModelScope",
    };
  }
  const includePatterns = buildDownloadIncludePatterns(options.precision);
  const includeArgs = includePatterns.flatMap((pattern) => ["--include", pattern]);
  return {
    command: CONFIG.hfCli,
    args: ["download", model, ...includeArgs, "--local-dir", localDir],
    label: "Hugging Face",
    includePatterns,
  };
}

function buildDownloadSpecFromJob(job) {
  const meta = job.meta || {};
  const model = cleanRequired(meta.model, "model");
  const source = cleanDownloadSource(meta.source || "huggingface");
  const precision = String(meta.precision || "");
  const outputName = safeOutputName(meta.outputName || model.replace(/[\\/]/g, "__"));
  const localDir = resolveModelsRootChild(meta.localDir || path.join(CONFIG.modelsRoot, outputName));
  const download = buildDownloadCommand(source, model, localDir, { precision });
  return {
    command: download.command,
    args: download.args,
    options: {
      env: buildDownloadEnv(),
      title: job.title || `Download ${model} (${download.label})`,
      meta: {
        ...meta,
        model,
        source,
        precision,
        outputName,
        localDir,
      },
      progressDir: localDir,
      expectedBytes: meta.expectedBytes || null,
      countExistingProgress: true,
    },
  };
}

function buildDownloadIncludePatterns(precision) {
  const value = normalizeRemoteQuantFilter(precision);
  if (!value || value === "quantized") return [];
  if (value === "GGUF") return ["*.gguf"];
  if (value === "Q4") return ["*Q4*.gguf", "*IQ4*.gguf"];
  if (value === "IQ4") return ["*IQ4*.gguf"];
  if (/^I?Q[2-8](?:_[A-Z0-9]+)*$/.test(value)) return [`*${value}*.gguf`];
  return [];
}

function filterDownloadSiblings(siblings, precision) {
  const includePatterns = buildDownloadIncludePatterns(precision);
  if (!includePatterns.length) return siblings;
  const matched = siblings.filter((file) => matchesDownloadPrecisionFile(file.rfilename, precision));
  return matched.length ? matched : siblings;
}

function matchesDownloadPrecisionFile(filename, precision) {
  const name = String(filename || "");
  const normalizedName = name.replace(/[-.\s]+/g, "_").toUpperCase();
  const value = normalizeRemoteQuantFilter(precision);
  if (!value) return true;
  if (value === "GGUF") return name.toLowerCase().endsWith(".gguf");
  if (value === "Q4") return name.toLowerCase().endsWith(".gguf") && /(^|_)I?Q4/.test(normalizedName);
  if (value === "IQ4") return name.toLowerCase().endsWith(".gguf") && /(^|_)IQ4/.test(normalizedName);
  return name.toLowerCase().endsWith(".gguf") && normalizedName.includes(value);
}

function normalizeRemoteLimit(value) {
  const number = Number(value || 48);
  if (!Number.isFinite(number)) return 48;
  return Math.min(120, Math.max(12, Math.floor(number)));
}

function unique(values) {
  return Array.from(new Set(values));
}

function normalizeRemoteQuantFilter(value) {
  const raw = String(value || "").trim();
  if (!raw || ["all", "any", "auto"].includes(raw.toLowerCase())) return "";
  if (/原始|BF16\/FP16/i.test(raw)) return "";
  const upper = raw.replace(/\s+/g, "_").replace(/-/g, "_").toUpperCase();
  const aliases = {
    BASE: "",
    QUANT: "quantized",
    QUANTIZED: "quantized",
    "4BIT": "INT4",
    BNB_4BIT: "BNB-4bit",
    BNB4BIT: "BNB-4bit",
    MODEL_OPT_FP4: "NVFP4",
    MODELOPT_FP4: "NVFP4",
    NVFP4_FP4: "NVFP4",
    FP4_NVFP4: "NVFP4",
    NVFP4_MTP: "NVFP4",
    MTP_NVFP4: "NVFP4",
    MXFP4_MTP: "MXFP4",
    MTP_MXFP4: "MXFP4",
    FP8_MTP: "FP8",
    MTP_FP8: "FP8",
    MTP_GGUF: "GGUF",
    GGUF_MTP: "GGUF",
    AWQ_INT4: "AWQ",
    GPTQ_INT4: "GPTQ",
    Q4KM: "Q4_K_M",
    Q5KM: "Q5_K_M",
    Q8: "Q8_0",
    IQ4XS: "IQ4_XS",
  };
  return Object.prototype.hasOwnProperty.call(aliases, upper) ? aliases[upper] : upper;
}

function remoteSearchesWithQuant(searches, quantFilter) {
  const base = (searches || []).map((item) => String(item || "").trim());
  const term = remoteQuantSearchTerm(quantFilter);
  if (!term) return base;
  const hasSpecificSearch = base.some(Boolean);
  if (hasSpecificSearch) {
    return unique([
      ...base.map((item) => item ? `${item} ${term}` : term),
      ...base,
    ]);
  }
  return [term];
}

function remoteQuantSearchTerm(quantFilter) {
  const value = normalizeRemoteQuantFilter(quantFilter);
  if (!value || value === "quantized") return "";
  if (value === "Q4") return "Q4_K_M";
  if (value === "IQ4") return "IQ4_XS";
  return value;
}

async function searchHuggingFaceModels({ category, search, limit, size, freshness, quant }) {
  const profile = remoteSearchProfile(category, search, freshness);
  const quantFilter = normalizeRemoteQuantFilter(quant);
  const searches = remoteSearchesWithQuant(Array.isArray(profile.search) ? profile.search : [profile.search], quantFilter);
  const seen = new Set();
  const candidates = [];
  const requestLimit = Math.min(100, Math.max(48, limit));

  for (const query of searches) {
    const params = new URLSearchParams({
      sort: profile.sort,
      direction: "-1",
      limit: String(requestLimit),
      full: "true",
    });
    if (query) params.set("search", query);
    const data = await fetchJson(`https://huggingface.co/api/models?${params}`);
    for (const model of Array.isArray(data) ? data : []) {
      const id = model.modelId || model.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const summary = simplifyHuggingFaceModel(model);
      if (!isRemoteModelCandidate(summary, profile, size, quantFilter)) continue;
      candidates.push(summary);
    }
  }

  return rankAndLimitRemoteModels(candidates, profile, limit);
}

function remoteSearchProfile(category, search, freshness = "auto") {
  const rawQuery = String(search || "").trim();
  const query = rawQuery && /gguf/i.test(rawQuery) ? rawQuery : rawQuery ? `${rawQuery} GGUF` : "";
  const minLastModified = remoteFreshnessCutoff(freshness, category);
  if (query) {
    return {
      engine: "llama",
      category: "search",
      search: query,
      sort: "downloads",
      minLastModified,
      requireGguf: true,
    };
  }
  if (category === "latest") {
    return {
      engine: "llama",
      category,
      search: ["GGUF", "Qwen GGUF", "Llama GGUF", "DeepSeek GGUF", "Gemma GGUF", "Mistral GGUF"],
      sort: "lastModified",
      minLastModified,
      requireGguf: true,
    };
  }
  if (category === "distilled") {
    return {
      engine: "llama",
      category,
      search: ["GGUF distill", "GGUF distilled", "GGUF R1-Distill", "Qwen GGUF Distill", "DeepSeek GGUF Distill"],
      sort: "downloads",
      minLastModified,
      requireGguf: true,
    };
  }
  if (category === "uncensored") {
    return {
      engine: "llama",
      category,
      search: ["GGUF uncensored", "GGUF abliterated", "GGUF abliteration", "GGUF unfiltered", "GGUF no-filter", "GGUF nofilter", "GGUF uncens"],
      sort: "downloads",
      minLastModified,
      requireGguf: true,
    };
  }
  if (category === "quantized") {
    return {
      engine: "llama",
      category,
      search: ["GGUF", "Q4_K_M", "Q8_0", "Q5_K_M", "IQ4_XS"],
      sort: "downloads",
      minLastModified,
      requireGguf: true,
      requireQuantized: true,
    };
  }
  return {
    engine: "llama",
    category: "popular",
    search: ["GGUF", "Qwen GGUF", "Llama GGUF", "DeepSeek GGUF", "Gemma GGUF", "Mistral GGUF"],
    sort: "downloads",
    minLastModified,
    requireGguf: true,
  };
}

function remoteFreshnessCutoff(freshness, category) {
  const value = String(freshness || "auto").toLowerCase();
  if (value === "all" || value === "any" || value === "none") return null;
  if (value === "2026") return "2026-01-01";
  if (value === "2025") return "2025-01-01";
  if (value === "auto" && (category === "latest" || category === "quantized")) return "2025-01-01";
  return null;
}

async function getHuggingFaceModelInfo(modelId) {
  const data = await fetchJson(`https://huggingface.co/api/models/${encodeRepoId(modelId)}`);
  return simplifyHuggingFaceModel(data);
}

async function getHuggingFaceDownloadEstimate(modelId, precision = "") {
  const data = await fetchJson(`https://huggingface.co/api/models/${encodeRepoId(modelId)}?blobs=true`);
  const siblings = filterDownloadSiblings(Array.isArray(data.siblings) ? data.siblings : [], precision);
  const bytes = siblings.reduce((sum, file) => {
    const size = Number(file.size || file.lfs?.size || 0);
    return Number.isFinite(size) && size > 0 ? sum + size : sum;
  }, 0);
  return {
    bytes: bytes || null,
    fileCount: siblings.length,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "llama-manager/0.1",
      ...(process.env.HF_TOKEN ? { "authorization": `Bearer ${process.env.HF_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Remote request failed (${response.status}): ${text || response.statusText}`);
  }
  return response.json();
}

function simplifyHuggingFaceModel(model) {
  const id = model.modelId || model.id;
  const tags = Array.isArray(model.tags) ? model.tags : [];
  const siblings = Array.isArray(model.siblings) ? model.siblings : [];
  const author = model.author || id.split("/")[0];
  const lower = `${id} ${tags.join(" ")} ${siblings.map((item) => item.rfilename || "").join(" ")}`.toLowerCase();
  const quantFormats = inferRemoteQuantFormats({ id, tags, siblings });
  const selection = inferModelSelection({
    id,
    author,
    tags,
    siblings,
    source: "huggingface",
    quantFormats,
  });
  const paramsB = inferRemoteParamsB(`${id} ${siblings.map((item) => item.rfilename || "").join(" ")}`);
  const fileSizeBytes = siblings.reduce((sum, file) => {
    const size = Number(file.size || file.lfs?.size || 0);
    return Number.isFinite(size) && size > 0 ? sum + size : sum;
  }, 0);
  const largestFileBytes = siblings.reduce((max, file) => {
    const size = Number(file.size || file.lfs?.size || 0);
    return Number.isFinite(size) && size > max ? size : max;
  }, 0);
  const badges = [];
  if (lower.includes("distill")) badges.push("distilled");
  if (isUncensoredText(lower)) badges.push("uncensored");
  badges.push(...quantFormats.slice(0, 5));
  if (model.gated) badges.push("gated");
  return {
    source: "huggingface",
    model: id,
    id,
    label: id,
    author,
    url: `https://huggingface.co/${id}`,
    tags,
    badges,
    downloads: Number(model.downloads || 0),
    likes: Number(model.likes || 0),
    gated: Boolean(model.gated),
    pipelineTag: model.pipeline_tag || "",
    libraryName: model.library_name || "",
    lastModified: model.lastModified || model.createdAt || "",
    createdAt: model.createdAt || "",
    hasConfig: siblings.some((item) => item.rfilename === "config.json"),
    hasSafetensors: siblings.some((item) => String(item.rfilename || "").endsWith(".safetensors")),
    hasGguf: siblings.some((item) => String(item.rfilename || "").toLowerCase().endsWith(".gguf")),
    hasQuantizedFiles: hasQuantizedRemoteFiles(quantFormats),
    quantFormats,
    paramsB,
    sizeClass: remoteSizeClass(paramsB),
    fileSizeBytes: fileSizeBytes || null,
    largestFileBytes: largestFileBytes || null,
    fileCount: siblings.length,
    summary: model.cardData?.summary || model.cardData?.language || "",
    selection,
    outputName: safeOutputName(id.replace(/[\\/]/g, "-")),
  };
}

function isRemoteModelCandidate(model, profile, sizeFilter, quantFilter = "") {
  if (!model?.id) return false;
  if (!remotePipelineAllowed(model, profile.engine)) return false;
  if (profile.requireGguf && !model.hasGguf) return false;
  if (profile.requireQuantized && !model.hasQuantizedFiles) return false;
  if (profile.minLastModified && !isAfterDate(model.lastModified || model.createdAt, profile.minLastModified)) return false;
  if (sizeFilter && !matchesRemoteSizeFilter(model, sizeFilter)) return false;
  if (quantFilter && !matchesRemoteQuantFilter(model, quantFilter)) return false;
  return true;
}

function remotePipelineAllowed(model, engine) {
  const tag = String(model.pipelineTag || "").toLowerCase();
  const tags = (model.tags || []).map((item) => String(item).toLowerCase());
  const id = String(model.id || "").toLowerCase();
  if (/(^|[\/_.\-\s])(embed|embedding|rerank|reranker|ranker)/.test(id)) {
    return false;
  }
  if (["sentence-similarity", "text-ranking", "translation", "summarization", "question-answering", "fill-mask", "feature-extraction", "text-classification", "token-classification", "zero-shot-classification", "image-classification", "zero-shot-image-classification", "image-feature-extraction", "text-to-image", "image-to-image", "automatic-speech-recognition", "text-to-speech"].includes(tag)) {
    return false;
  }
  if (engine === "llama") return model.hasGguf;
  if (["text-generation", "image-text-to-text", "visual-question-answering", "image-to-text", "text2text-generation", "conversational"].includes(tag)) {
    return true;
  }
  if (!tag && (model.hasSafetensors || model.hasGguf || model.hasConfig)) return true;
  if (tags.some((item) => ["text-generation", "transformers", "safetensors", "gguf"].includes(item))) return true;
  return false;
}

function rankAndLimitRemoteModels(models, profile, limit) {
  const sorted = models
    .map((model) => ({ model, score: remoteModelScore(model, profile) }))
    .sort((a, b) => b.score - a.score || String(b.model.lastModified || "").localeCompare(String(a.model.lastModified || "")))
    .map((item) => item.model);
  if (profile.category !== "popular") return sorted.slice(0, limit);
  const familyCounts = new Map();
  const selected = [];
  const skipped = [];
  for (const model of sorted) {
    const key = remoteFamilyKey(model);
    const count = familyCounts.get(key) || 0;
    if (count >= 4) {
      skipped.push(model);
      continue;
    }
    familyCounts.set(key, count + 1);
    selected.push(model);
    if (selected.length >= limit) return selected;
  }
  return [...selected, ...skipped].slice(0, limit);
}

function remoteModelScore(model, profile) {
  const downloads = Math.log10(Number(model.downloads || 0) + 10) * 20;
  const likes = Math.log10(Number(model.likes || 0) + 10) * 5;
  const modified = new Date(model.lastModified || model.createdAt || 0).getTime();
  const recency = Number.isFinite(modified) ? Math.max(0, (modified - Date.UTC(2024, 0, 1)) / 86400000) / 80 : 0;
  const quant = model.hasQuantizedFiles ? 4 : 0;
  if (profile.sort === "lastModified") return (Number.isFinite(modified) ? modified / 86400000 : 0) + downloads / 100;
  return downloads + likes + recency + quant;
}

function remoteFamilyKey(model) {
  const repo = String(model.id || "").split("/").pop() || "";
  return repo.toLowerCase()
    .replace(/\b(?:awq|gptq|gguf|fp8|nvfp4|mxfp4|int4|int8|bf16|fp16|q\d(?:_[a-z0-9]+)*)\b/g, "")
    .replace(/[-_\s]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isAfterDate(value, cutoff) {
  const date = new Date(value || "");
  const threshold = new Date(cutoff);
  if (Number.isNaN(date.getTime()) || Number.isNaN(threshold.getTime())) return false;
  return date >= threshold;
}

function matchesRemoteSizeFilter(model, filter) {
  const params = Number(model.paramsB || 0);
  if (!params) return false;
  if (filter === "small") return params <= 8;
  if (filter === "medium") return params > 8 && params <= 14;
  if (filter === "large") return params > 14 && params <= 32;
  if (filter === "xlarge") return params > 32;
  return true;
}

function matchesRemoteQuantFilter(model, filter) {
  const value = normalizeRemoteQuantFilter(filter);
  if (!value) return true;
  if (value === "quantized") return Boolean(model.hasQuantizedFiles);
  if (value === "GGUF") return Boolean(model.hasGguf) || remoteQuantSet(model).has("GGUF");
  const formats = remoteQuantSet(model);
  if (formats.has(value)) return true;
  if (value === "Q4") return Array.from(formats).some((item) => item.startsWith("Q4") || item.startsWith("IQ4"));
  if (value === "IQ4") return Array.from(formats).some((item) => item.startsWith("IQ4"));
  if (value === "INT4") return Array.from(formats).some((item) => item.includes("INT4") || item.startsWith("Q4") || item.startsWith("IQ4") || item === "NF4" || item === "NVFP4" || item === "MXFP4");
  return false;
}

function remoteQuantSet(model) {
  return new Set((model.quantFormats || []).map((item) => normalizeRemoteQuantFilter(item)).filter(Boolean));
}

function inferRemoteQuantFormats({ id, tags = [], siblings = [] }) {
  const text = `${id} ${tags.join(" ")} ${siblings.map((item) => item.rfilename || "").join(" ")}`;
  const formats = new Set();
  for (const match of text.matchAll(/\bI?Q[2-8](?:_[A-Z0-9]+)*\b/gi)) formats.add(match[0].toUpperCase());
  const lower = text.toLowerCase();
  [
    ["gguf", "GGUF"],
    ["q4_k_m", "Q4_K_M"],
    ["q8_0", "Q8_0"],
    ["q5_k_m", "Q5_K_M"],
    ["iq4_xs", "IQ4_XS"],
    ["awq", "AWQ"],
    ["gptq", "GPTQ"],
    ["fp8", "FP8"],
    ["nf4", "NF4"],
    ["int4", "INT4"],
    ["int8", "INT8"],
    ["bf16", "BF16"],
    ["fp16", "FP16"],
  ].forEach(([needle, label]) => {
    if (lower.includes(needle)) formats.add(label);
  });
  return Array.from(formats);
}

function hasQuantizedRemoteFiles(formats) {
  return (formats || []).some((format) => !["BF16", "FP16"].includes(String(format).toUpperCase()));
}

function inferRemoteParamsB(text) {
  const matches = Array.from(String(text || "").matchAll(/(?:^|[-_\s])(?:A)?(\d+(?:\.\d+)?)([BM])(?:[-_\s]|$)/gi));
  if (!matches.length) return null;
  const values = matches.map((match) => {
    const value = Number(match[1]);
    return match[2].toUpperCase() === "M" ? value / 1000 : value;
  }).filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : null;
}

function remoteSizeClass(paramsB) {
  const params = Number(paramsB || 0);
  if (!params) return "";
  if (params <= 8) return "small";
  if (params <= 14) return "medium";
  if (params <= 32) return "large";
  return "xlarge";
}

function isUncensoredText(lower) {
  return /(uncensored|abliterat|unfiltered|no[-_\s]?filter|nofilter|uncens)/i.test(lower);
}

function inferModelSelection({ id, author, tags = [], siblings = [], source = "huggingface", quantFormats = [] }) {
  const owner = author || String(id || "").split("/")[0] || "custom";
  const repoName = String(id || "").split("/").filter(Boolean).pop() || String(id || "");
  const tokens = repoName.split(/[-_\s]+/).map((token) => token.trim()).filter(Boolean);
  const sizeIndex = tokens.findIndex(isSizeToken);
  const precisionTokens = collectPrecisionTokens(tokens);
  const tagPrecisionTokens = collectPrecisionTokens(tags.map(String));
  const fileText = siblings.map((item) => item.rfilename || "").join(" ");
  const lowerAll = `${id} ${tags.join(" ")} ${fileText}`.toLowerCase();

  const developer = prettyDeveloper(owner);
  const modelVersion = titleJoin(sizeIndex > 0
    ? tokens.slice(0, sizeIndex).filter((token) => !isPrecisionToken(token))
    : leadingVersionTokens(tokens));
  const spec = titleJoin(sizeIndex >= 0
    ? collectSpecTokens(tokens, sizeIndex)
    : []);
  const detectedPrecision = titleJoin([...precisionTokens, ...tagPrecisionTokens])
    || precisionFromText(lowerAll)
    || "原始 BF16/FP16";
  const precisionOptions = buildRemotePrecisionOptions(detectedPrecision, quantFormats);
  const precision = precisionOptions[0] || detectedPrecision;

  const result = {
    developer,
    modelVersion: modelVersion || repoName || String(id || ""),
    spec: spec || "未标注规格",
    precision,
    source,
  };

  return {
    ...result,
    options: {
      developers: [result.developer],
      modelVersions: [result.modelVersion],
      specs: [result.spec],
      precisions: precisionOptions,
    },
  };
}

function buildRemotePrecisionOptions(preferred, formats = []) {
  const normalized = unique([
    ...(formats || []).flatMap(remotePrecisionLabelsFromValue),
    ...remotePrecisionLabelsFromValue(preferred),
  ].filter(Boolean));
  const options = normalized.length ? normalized : ["原始 BF16/FP16"];
  const order = ["Q4_K_M", "Q5_K_M", "Q8_0", "IQ4_XS", "Q4", "IQ4", "Q6_K", "Q3_K_M", "Q2_K", "NVFP4", "MXFP4", "FP8", "AWQ", "GPTQ", "NF4", "INT4", "GGUF", "原始 BF16/FP16"];
  return options.sort((a, b) => remotePrecisionSortRank(a, order) - remotePrecisionSortRank(b, order) || a.localeCompare(b));
}

function remotePrecisionSortRank(value, order) {
  if (value === "GGUF") return 900;
  if (value === "原始 BF16/FP16") return 950;
  const explicit = order.indexOf(value);
  if (explicit >= 0) return explicit;
  if (/^Q8/.test(value)) return 80;
  if (/^Q6/.test(value)) return 90;
  if (/^Q5/.test(value)) return 100;
  if (/^Q4/.test(value) || /^IQ4/.test(value)) return 110;
  if (/^Q3/.test(value) || /^IQ3/.test(value)) return 120;
  if (/^Q2/.test(value) || /^IQ2/.test(value)) return 130;
  return 500;
}

function normalizeRemotePrecisionLabel(value) {
  return remotePrecisionLabelsFromValue(value)[0] || "";
}

function remotePrecisionLabelsFromValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (/原始|BF16\/FP16|base/i.test(raw)) return ["原始 BF16/FP16"];
  const lower = raw.toLowerCase();
  const labels = [];
  const add = (label) => {
    if (!label || label === "MTP") return;
    const normalized = normalizeRemoteQuantFilter(label);
    if (!normalized) return;
    if (normalized === "BF16" || normalized === "FP16" || normalized === "BASE") labels.push("原始 BF16/FP16");
    else labels.push(normalized);
  };
  for (const match of raw.matchAll(/\bI?Q[2-8](?:_[A-Z0-9]+)*\b/gi)) add(match[0]);
  [
    ["nvfp4", "NVFP4"],
    ["mxfp4", "MXFP4"],
    ["fp8", "FP8"],
    ["awq", "AWQ"],
    ["gptq", "GPTQ"],
    ["gguf", "GGUF"],
    ["nf4", "NF4"],
    ["int4", "INT4"],
    ["int8", "INT8"],
    ["bf16", "原始 BF16/FP16"],
    ["fp16", "原始 BF16/FP16"],
  ].forEach(([needle, label]) => {
    if (lower.includes(needle)) add(label);
  });
  if (!labels.length) add(raw);
  return unique(labels);
}

function prettyDeveloper(owner) {
  const value = String(owner || "").trim() || "custom";
  const normalized = value.toLowerCase();
  const known = {
    qwen: "Qwen",
    qwenlm: "Qwen",
    "deepseek-ai": "DeepSeek",
    "meta-llama": "Meta",
    google: "Google",
    mistralai: "Mistral",
    microsoft: "Microsoft",
    nvidia: "NVIDIA",
    openai: "OpenAI",
    "01-ai": "01.AI",
  };
  return known[normalized] || value;
}

function leadingVersionTokens(tokens) {
  const precisionIndex = tokens.findIndex(isPrecisionToken);
  const end = precisionIndex > 0 ? precisionIndex : Math.min(tokens.length, 4);
  return tokens.slice(0, end).filter((token) => !isPrecisionToken(token));
}

function collectSpecTokens(tokens, sizeIndex) {
  const spec = [tokens[sizeIndex]];
  for (let index = sizeIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isPrecisionToken(token)) break;
    if (isVersionSuffixToken(token) || isModelVariantToken(token) || isSizeToken(token)) {
      spec.push(token);
      continue;
    }
    if (/^\d{3,4}$/.test(token)) spec.push(token);
  }
  if (tokens[sizeIndex + 1] && /^A?\d+(?:\.\d+)?[BM]$/i.test(tokens[sizeIndex + 1])) {
    spec.push(tokens[sizeIndex + 1]);
  }
  return spec;
}

function collectPrecisionTokens(tokens) {
  const seen = new Set();
  return tokens
    .map((token) => normalizePrecisionToken(token))
    .filter(Boolean)
    .filter((token) => {
      const key = token.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function precisionFromText(lower) {
  if (lower.includes("nvfp4")) return "NVFP4";
  if (lower.includes("mxfp4")) return "MXFP4";
  if (lower.includes("fp8")) return "FP8";
  if (lower.includes("awq")) return "AWQ INT4";
  if (lower.includes("gptq")) return "GPTQ INT4";
  if (lower.includes("gguf")) return "GGUF";
  if (lower.includes("nf4")) return "NF4";
  if (lower.includes("int8")) return "INT8";
  if (lower.includes("int4")) return "INT4";
  return "";
}

function normalizePrecisionToken(token) {
  const clean = String(token || "").replace(/[^a-zA-Z0-9.]+/g, "").trim();
  if (!clean) return "";
  const upper = clean.toUpperCase();
  if (["AWQ", "GPTQ", "GGUF", "GGML", "EXL2", "EETQ", "HQQ", "AQLM", "NF4", "NVFP4", "MXFP4", "MTP"].includes(upper)) {
    return upper;
  }
  if (/^(?:BF|FP|INT)\d+$/i.test(clean)) return upper;
  if (/^Q\d(?:[A-Z0-9]+)?$/i.test(clean)) return upper;
  if (/^IQ\d(?:[A-Z0-9]+)?$/i.test(clean)) return upper;
  return "";
}

function isPrecisionToken(token) {
  return Boolean(normalizePrecisionToken(token));
}

function isSizeToken(token) {
  return /^\d+(?:\.\d+)?[BM]$/i.test(String(token || ""))
    || /^\d+(?:\.\d+)?x\d+(?:\.\d+)?[BM]$/i.test(String(token || ""));
}

function isModelVariantToken(token) {
  return /^(?:text|chat|instruct|coder|code|vl|vision|audio|base|it|math|reasoning|distill|distilled|sft|rl|reasoner|thinking)$/i.test(String(token || ""));
}

function isVersionSuffixToken(token) {
  return /^(?:a?\d+(?:\.\d+)?[bm]?|\d{3,4})$/i.test(String(token || ""));
}

function titleJoin(tokens) {
  return Array.from(new Set((tokens || []).filter(Boolean))).join(" ").trim();
}

function parseModelReference(input) {
  const text = String(input || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    if (/^[^/\s]+\/[^/\s]+$/.test(text)) {
      return {
        source: "huggingface",
        model: text,
        url: `https://huggingface.co/${text}`,
      };
    }
    const error = new Error("请输入 Hugging Face / ModelScope 模型介绍页链接，或 owner/model 形式的模型 ID。");
    error.status = 400;
    throw error;
  }

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "huggingface.co" || host.endsWith(".huggingface.co") || host === "hf-mirror.com") {
    const cleanParts = parts[0] === "models" ? parts.slice(1) : parts;
    if (cleanParts.length >= 2) {
      const model = `${cleanParts[0]}/${cleanParts[1]}`;
      return { source: "huggingface", model, url: `https://huggingface.co/${model}` };
    }
  }

  if (host.includes("modelscope.cn")) {
    const modelIndex = parts.indexOf("models");
    const cleanParts = modelIndex >= 0 ? parts.slice(modelIndex + 1) : parts;
    if (cleanParts.length >= 2) {
      const model = `${cleanParts[0]}/${cleanParts[1]}`;
      return { source: "modelscope", model, url: `https://modelscope.cn/models/${model}` };
    }
  }

  const error = new Error("没有从链接中识别出模型 ID。请使用模型介绍页地址，例如 https://huggingface.co/Qwen/Qwen3-8B。");
  error.status = 400;
  throw error;
}

function encodeRepoId(repoId) {
  return String(repoId).split("/").map(encodeURIComponent).join("/");
}

function deriveName(model) {
  const normalized = model.replace(/[\\/]+$/g, "");
  const leaf = normalized.split(/[\\/]/).filter(Boolean).pop() || "model";
  return leaf.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}

function normalizeGpuIds(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return Array.from(new Set(raw.map(String).filter((item) => /^\d+$/.test(item))));
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.max(1, Math.floor(number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function positiveTimeoutMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 60_000) return fallback;
  return Math.floor(number);
}

function normalizeNetworkAccess(value) {
  return String(value || "local").toLowerCase() === "lan" ? "lan" : "local";
}

function normalizeKvCacheDtype(value) {
  const dtype = String(value || "auto").toLowerCase();
  return new Set(["auto", "fp8", "fp8_e5m2", "fp8_e4m3"]).has(dtype) ? dtype : "auto";
}

function normalizeClientPreset(value) {
  const preset = String(value || "openwebui").trim().toLowerCase();
  return new Set(["openwebui", "claude-code", "claude-cowork", "generic"]).has(preset) ? preset : "generic";
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

function portPublishArg(port, networkAccess, serviceHost) {
  const args = dockerPublishArgs(port, networkAccess, serviceHost);
  return args[args.length - 1] || `127.0.0.1:${port}:8080`;
}

function dockerPublishArgs(port, networkAccess, serviceHost) {
  if (networkAccess !== "lan") return [`127.0.0.1:${port}:8080`];
  const lanHost = normalizeLanBindHost(serviceHost);
  if (isWildcardHost(lanHost)) return [`0.0.0.0:${port}:8080`];
  return [`127.0.0.1:${port}:8080`, `${lanHost}:${port}:8080`];
}

function publishArgsToDockerRunArgs(publishArgs) {
  return (publishArgs || []).flatMap((arg) => ["-p", arg]);
}

function replaceDockerPublishArgs(args, publishArgs) {
  const next = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-p" || args[index] === "--publish") {
      index += 1;
      continue;
    }
    next.push(args[index]);
  }
  const insertAt = Math.max(0, next.indexOf("--ipc=host") + 1);
  next.splice(insertAt, 0, ...publishArgsToDockerRunArgs(publishArgs));
  return next;
}

function isDockerPublishBindError(error) {
  const text = `${error?.stderr || ""}\n${error?.stdout || ""}\n${error?.message || ""}`.toLowerCase();
  return /bind|port is already allocated|cannot assign requested address|listen tcp|driver failed programming external connectivity|ports are not available/.test(text);
}

function normalizeLanBindHost(value) {
  const host = stripHostBrackets(value || getLanAddress());
  if (host && !isLoopbackHost(host) && !isWildcardHost(host)) return host;
  const detected = stripHostBrackets(getLanAddress());
  if (detected && !isLoopbackHost(detected) && !isWildcardHost(detected)) return detected;
  return "0.0.0.0";
}

function stripHostBrackets(value) {
  return String(value || "").trim().replace(/^\[|\]$/g, "");
}

function isLoopbackHost(host) {
  const value = stripHostBrackets(host).toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function isWildcardHost(host) {
  const value = stripHostBrackets(host).toLowerCase();
  return value === "0.0.0.0" || value === "::" || value === "";
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

function describeLocalModelPath(value) {
  if (!path.isAbsolute(value)) return null;
  const resolved = path.resolve(value);
  const root = path.resolve(CONFIG.modelsRoot);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(resolved)) return null;
  const stat = fs.statSync(resolved);
  return {
    path: resolved,
    stat,
    ggufFiles: stat.isDirectory() ? findGgufFilesSync(resolved, 20) : [],
  };
}

function hasRecognizedConfig(dir) {
  return fs.existsSync(path.join(dir, "config.json")) || fs.existsSync(path.join(dir, "params.json"));
}

function looksLikeGgufReference(value) {
  const lower = String(value || "").toLowerCase();
  return lower.endsWith(".gguf") || lower.includes("-gguf:") || /:[iq]?q\d(?:_[a-z0-9]+)*$/i.test(value);
}

function findGgufFilesSync(dir, limit = 20) {
  const results = [];
  const walk = (current) => {
    if (results.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".cache" || entry.name === ".git") continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
        let size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          size = 0;
        }
        results.push({ path: fullPath, name: path.relative(dir, fullPath), size });
      }
    }
  };
  walk(dir);
  return results.sort((a, b) => b.size - a.size);
}

function chooseGgufFile(files) {
  return [...files].sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error && options.rejectOnError !== false) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "", error });
    });
  });
}

function docker(args, options = {}) {
  return execFileAsync(CONFIG.dockerExe, args, options);
}

async function getDockerVersion() {
  try {
    const out = await docker(["--version"]);
    const cli = out.stdout.trim();
    const daemon = await checkDockerDaemon();
    return {
      ok: daemon.ok,
      cliOk: true,
      daemonOk: daemon.ok,
      text: daemon.ok ? `${cli} · daemon ${daemon.version}` : `${cli} · ${daemon.error}`,
      daemonError: daemon.ok ? null : daemon.raw || daemon.error,
    };
  } catch (error) {
    return { ok: false, cliOk: false, daemonOk: false, text: error.message };
  }
}

async function waitForDockerDaemon(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const out = await docker(["info", "--format", "{{.ServerVersion}}"], { rejectOnError: false, timeout: 8000 });
    const version = out.stdout.trim();
    if (!out.error && version) return { ok: true, version };
    lastError = out.stderr.trim() || out.error?.message || "Docker daemon is not ready.";
    await delay(2000);
  }
  return { ok: false, error: lastError };
}

async function checkDockerDaemon() {
  const out = await docker(["info", "--format", "{{.ServerVersion}}"], { rejectOnError: false, timeout: 8000 });
  const version = out.stdout.trim();
  if (!out.error && version) return { ok: true, version };
  const raw = out.stderr.trim() || out.error?.message || "Docker daemon is not ready.";
  return {
    ok: false,
    error: formatDockerDaemonError(raw),
    raw,
  };
}

function formatDockerDaemonError(raw) {
  const text = String(raw || "").trim();
  if (/dockerDesktopLinuxEngine|pipe/i.test(text)) {
    return "Docker Desktop 引擎未就绪。请先用页面的一键 Docker 按钮启动 Docker Desktop，等状态变为可用后再启动模型。";
  }
  if (/cannot connect|daemon|not ready/i.test(text)) {
    return `Docker daemon 未就绪：${text}`;
  }
  return text || "Docker daemon 未就绪。";
}

async function getImageStatus(image) {
  try {
    const out = await docker(["image", "inspect", image, "--format", "{{.Id}}\t{{.Size}}\t{{json .RepoTags}}\t{{json .RepoDigests}}"], { rejectOnError: false });
    const line = out.stdout.trim();
    if (out.error) {
      const raw = out.stderr.trim() || out.error.message;
      return { ok: false, text: formatDockerDaemonError(raw), reason: "docker-daemon", raw };
    }
    if (!line) return { ok: false, text: "missing" };
    const [id, size, tagsJson, digestsJson] = line.split("\t");
    const refs = [
      ...parseJsonSafe(tagsJson, []),
      ...parseJsonSafe(digestsJson, []),
    ].filter(Boolean);
    const display = refs.includes(image) ? image : refs[0] || image;
    return { ok: true, text: `${display}\t${formatBytes(Number(size) || 0)}`, id, refs };
  } catch (error) {
    return { ok: false, text: error.message };
  }
}

async function getGpuStatus() {
  try {
    const out = await execFileAsync("nvidia-smi", [
      "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
      "--format=csv,noheader,nounits",
    ]);
    const gpus = out.stdout.trim().split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [index, name, total, used, util, temp] = line.split(",").map((part) => part && part.trim());
        return {
          index: Number(index),
          id: String(index),
          name,
          totalMb: Number(total),
          usedMb: Number(used),
          util: Number(util),
          temp: Number(temp),
        };
      });
    if (!gpus.length) return { ok: false, text: "No NVIDIA GPU reported by nvidia-smi" };
    const totalMb = gpus.reduce((sum, gpu) => sum + gpu.totalMb, 0);
    const usedMb = gpus.reduce((sum, gpu) => sum + gpu.usedMb, 0);
    const avgUtil = Math.round(gpus.reduce((sum, gpu) => sum + gpu.util, 0) / gpus.length);
    return {
      ok: true,
      count: gpus.length,
      name: gpus.length === 1 ? gpus[0].name : `${gpus.length} GPUs`,
      totalMb,
      usedMb,
      util: avgUtil,
      temp: gpus[0].temp,
      gpus,
    };
  } catch (error) {
    return { ok: false, text: error.message };
  }
}

async function normalizeLaunchGpuSelection(requestedIds = []) {
  const requested = normalizeGpuIds(requestedIds);
  const warnings = [];
  const gpu = await getGpuStatus().catch((error) => ({ ok: false, text: error.message, gpus: [] }));
  const available = Array.isArray(gpu.gpus) ? gpu.gpus : [];
  if (!gpu.ok || !available.length) {
    return { gpuDeviceIds: requested, selectedCount: requested.length || 1, warnings };
  }
  if (!requested.length) {
    return { gpuDeviceIds: [], selectedCount: available.length, warnings };
  }
  const validIds = new Set(available.flatMap((item) => [String(item.id), String(item.index)]));
  const filtered = requested.filter((id) => validIds.has(String(id)));
  const dropped = requested.filter((id) => !validIds.has(String(id)));
  if (dropped.length) {
    warnings.push(`已忽略不存在的 GPU：${dropped.join(", ")}。当前可用 GPU：${available.map((item) => item.id).join(", ")}。`);
  }
  if (!filtered.length) {
    const fallback = String(available[0].id ?? available[0].index ?? "0");
    warnings.push(`所选 GPU 不存在，已回退到 GPU ${fallback}。`);
    filtered.push(fallback);
  }
  return { gpuDeviceIds: filtered, selectedCount: filtered.length, warnings };
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

function normalizeDockerContainerName(value) {
  return String(value || "")
    .split(",")[0]
    .replace(/^\//, "")
    .trim();
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

function normalizeDockerTimestamp(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("0001-")) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timestampToSeconds(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date.getTime() / 1000;
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
    .then((ledger) => ledgerToSummary(ledger))
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
  const managerLocalBase = `http://127.0.0.1:${PORT}`;
  const managerPublicHost = HOST === "0.0.0.0" || HOST === "::" || HOST === "[::]"
    ? getLanAddress()
    : HOST.replace(/^\[|\]$/g, "");
  const managerDisplayHost = managerPublicHost.includes(":") ? `[${managerPublicHost}]` : managerPublicHost;
  const managerPublicBase = `http://${managerDisplayHost}:${PORT}`;
  const openAiLocalBase = `http://127.0.0.1:${servicePort}/v1`;
  const openAiServiceBase = `http://${displayHost}:${servicePort}/v1`;
  const effectiveLanHost = lanHost || (isWildcardHost(boundHost) ? getLanAddress() : (!isLoopbackHost(boundHost) ? stripHostBrackets(boundHost) : null));
  const openAiLanBase = effectiveLanHost ? `http://${effectiveLanHost.includes(":") ? `[${effectiveLanHost}]` : effectiveLanHost}:${servicePort}/v1` : null;
  return {
    openai: {
      baseUrl: openAiLocalBase,
      serviceBaseUrl: openAiServiceBase,
      lanBaseUrl: openAiLanBase,
      chatCompletionsUrl: `${openAiLocalBase}/chat/completions`,
      modelsUrl: `${openAiLocalBase}/models`,
    },
    claude: {
      baseUrl: `${managerLocalBase}/claude`,
      messagesUrl: `${managerLocalBase}/claude/v1/messages`,
      countTokensUrl: `${managerLocalBase}/claude/v1/messages/count_tokens`,
      modelsUrl: `${managerLocalBase}/claude/v1/models`,
      publicBaseUrl: managerPublicBase === managerLocalBase ? null : `${managerPublicBase}/claude`,
    },
  };
}

function parseDockerPortPublish(ports) {
  const text = String(ports || "");
  const exact = collectDockerPortBindings(text, 8080);
  const bindings = exact.length ? exact : collectDockerPortBindings(text, null);
  if (!bindings.length) return null;
  const local = bindings.find((item) => isLoopbackHost(item.host));
  const wildcard = bindings.find((item) => isWildcardHost(item.host));
  const lan = bindings.find((item) => !isLoopbackHost(item.host) && !isWildcardHost(item.host));
  const primary = lan || wildcard || local || bindings[0];
  return {
    host: primary.host,
    port: primary.port,
    localHost: local?.host || (wildcard ? "127.0.0.1" : null),
    lanHost: lan?.host || (wildcard ? getLanAddress() : null),
    bindings,
  };
}

function collectDockerPortBindings(text, containerPort) {
  const host = String.raw`(\d{1,3}(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::\]|\[::1\]|::1|localhost)`;
  const target = containerPort ? String(containerPort) : String.raw`\d+`;
  const regex = new RegExp(String.raw`(?:${host}:)?(\d+)->${target}\/tcp`, "g");
  const bindings = [];
  let match;
  while ((match = regex.exec(text))) {
    bindings.push({
      host: match[1] || "0.0.0.0",
      port: Number(match[2]),
    });
  }
  return bindings;
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
  const summary = mergeLiveAndLedger(liveSummary, ledger);
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
    historical: ledgerToSummary(ledger),
    clientUsage,
    costComparison,
  };
}

async function collectExternalAccessStats(options = {}) {
  const limit = Math.min(500, Math.max(20, Number(options.limit || 160)));
  const maxLines = Math.min(50000, Math.max(limit, Number(options.maxLines || 12000)));
  const now = Date.now();
  const lanAddress = getLanAddress();
  const [settings, container, events] = await Promise.all([
    getServiceExposureSettings().catch(() => normalizeServiceExposureSettings({})),
    getContainerStatus(CONFIG.containerName).catch(() => ({ running: false })),
    readServiceGatewayAccessEvents(maxLines),
  ]);
  const endpoint = getContainerEndpoint(container);
  const normalized = events
    .map((entry) => normalizeServiceGatewayAccessEvent(entry, lanAddress))
    .filter((entry) => entry.atMs > 0)
    .sort((a, b) => a.atMs - b.atMs);
  const external = normalized.filter((entry) => entry.external);
  const local = normalized.filter((entry) => !entry.external);
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    logPath: CONFIG.serviceGatewayAccessLog,
    maxLines,
    privacy: "只记录访问元数据：时间、来源 IP、路径、状态、模型名、认证头类型、延迟和 token 计数；不记录提示词或响应正文。",
    service: {
      managerLanBaseUrl: HOST === "127.0.0.1" ? null : `http://${lanAddress}:${PORT}`,
      claudeBaseUrl: HOST === "127.0.0.1" ? null : `http://${lanAddress}:${PORT}/claude/v1`,
      openAiGatewayBaseUrl: HOST === "127.0.0.1" ? null : `http://${lanAddress}:${PORT}/serve/v1`,
      openAiContainerBaseUrl: endpoint.lanUrl || null,
      exposureMode: settings.exposureMode,
      requireApiKey: Boolean(settings.requireApiKey),
      rateLimitRpm: Number(settings.rateLimitRpm || 0),
      maxConcurrentRequests: Number(settings.maxConcurrentRequests || 0),
      running: Boolean(container.running),
      containerStatus: container.status || "",
      lanAddress,
    },
    totals: summarizeAccessEvents(normalized, now),
    external: summarizeAccessEvents(external, now),
    local: summarizeAccessEvents(local, now),
    clients: groupAccessEvents(external, (entry) => entry.remoteAddress || "unknown", { limit: 40 }),
    paths: groupAccessEvents(normalized, (entry) => entry.path || "-", { limit: 30 }),
    models: groupAccessEvents(normalized.filter((entry) => entry.model || entry.resolvedModel), (entry) => entry.model || entry.resolvedModel || "-", { limit: 30 }),
    authSources: groupAccessEvents(normalized, (entry) => entry.authSource || "none", { limit: 20 }),
    kinds: groupAccessEvents(normalized, (entry) => entry.kind || "-", { limit: 10 }),
    statuses: groupAccessEvents(normalized, (entry) => String(entry.status || 0), { limit: 20 }),
    timeline: buildAccessTimeline(external, now),
    recent: normalized.slice(-limit).reverse(),
  };
}

async function readServiceGatewayAccessEvents(maxLines = 12000) {
  try {
    const text = await fsp.readFile(CONFIG.serviceGatewayAccessLog, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines)
      .map((line) => parseJsonSafe(line, null))
      .filter((entry) => entry && typeof entry === "object");
  } catch {
    return [];
  }
}

function normalizeServiceGatewayAccessEvent(entry, lanAddress = "") {
  const remoteAddress = normalizeAccessRemoteAddress(entry.remoteAddress);
  const status = Number(entry.status || 0);
  const inputTokens = Number(entry.inputTokens || 0);
  const outputTokens = Number(entry.outputTokens || 0);
  const totalTokens = Number(entry.totalTokens || inputTokens + outputTokens);
  const atMs = Date.parse(entry.at || "");
  return {
    at: entry.at || null,
    atMs: Number.isFinite(atMs) ? atMs : 0,
    remoteAddress,
    external: isExternalAccessRemoteAddress(remoteAddress, lanAddress),
    method: String(entry.method || "").toUpperCase(),
    path: String(entry.path || ""),
    kind: String(entry.kind || ""),
    status,
    ok: status >= 200 && status < 400,
    statusFamily: status ? `${Math.floor(status / 100)}xx` : "unknown",
    model: String(entry.model || ""),
    resolvedModel: String(entry.resolvedModel || ""),
    stream: Boolean(entry.stream),
    authSource: String(entry.authSource || ""),
    clientId: String(entry.clientId || ""),
    durationMs: Number(entry.durationMs || 0),
    inputTokens,
    outputTokens,
    totalTokens,
    stopReason: String(entry.stopReason || ""),
    toolSchemaCount: Number(entry.toolSchemaCount || 0),
    toolUseCount: Number(entry.toolUseCount || 0),
    error: String(entry.error || ""),
  };
}

function normalizeAccessRemoteAddress(value) {
  return String(value || "").trim().replace(/^::ffff:/, "").replace(/^\[|\]$/g, "") || "unknown";
}

function isExternalAccessRemoteAddress(remoteAddress, lanAddress = "") {
  const value = normalizeAccessRemoteAddress(remoteAddress).toLowerCase();
  const localLan = normalizeAccessRemoteAddress(lanAddress).toLowerCase();
  if (!value || value === "unknown") return false;
  if (value === "127.0.0.1" || value === "::1" || value === "localhost") return false;
  if (localLan && value === localLan) return false;
  return true;
}

function summarizeAccessEvents(events, now = Date.now()) {
  const total = events.length;
  const success = events.filter((entry) => entry.ok).length;
  const error = total - success;
  const durations = events.map((entry) => Number(entry.durationMs || 0)).filter((value) => value >= 0).sort((a, b) => a - b);
  const tokenTotals = events.reduce((acc, entry) => {
    acc.input += Number(entry.inputTokens || 0);
    acc.output += Number(entry.outputTokens || 0);
    acc.total += Number(entry.totalTokens || 0);
    return acc;
  }, { input: 0, output: 0, total: 0 });
  return {
    requests: {
      total,
      success,
      error,
      errorRate: total ? error / total : 0,
      streamed: events.filter((entry) => entry.stream).length,
      authFailures: events.filter((entry) => entry.status === 401 || entry.status === 403).length,
      rateLimited: events.filter((entry) => entry.status === 429).length,
      clientErrors: events.filter((entry) => entry.status >= 400 && entry.status < 500).length,
      serverErrors: events.filter((entry) => entry.status >= 500).length,
    },
    tokens: tokenTotals,
    clients: {
      unique: new Set(events.map((entry) => entry.remoteAddress).filter(Boolean)).size,
    },
    latency: {
      avgMs: total ? events.reduce((sum, entry) => sum + Number(entry.durationMs || 0), 0) / total : 0,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.at(-1) || 0,
    },
    windows: {
      m5: summarizeAccessWindow(events, now, 5 * 60 * 1000),
      m15: summarizeAccessWindow(events, now, 15 * 60 * 1000),
      h1: summarizeAccessWindow(events, now, 60 * 60 * 1000),
      h24: summarizeAccessWindow(events, now, 24 * 60 * 60 * 1000),
    },
    firstAt: events[0]?.at || null,
    lastAt: events.at(-1)?.at || null,
  };
}

function summarizeAccessWindow(events, now, windowMs) {
  const start = now - windowMs;
  const scoped = events.filter((entry) => entry.atMs >= start);
  const total = scoped.length;
  const success = scoped.filter((entry) => entry.ok).length;
  const error = total - success;
  const totalTokens = scoped.reduce((sum, entry) => sum + Number(entry.totalTokens || 0), 0);
  return {
    total,
    success,
    error,
    errorRate: total ? error / total : 0,
    uniqueClients: new Set(scoped.map((entry) => entry.remoteAddress).filter(Boolean)).size,
    requestsPerMinute: total / Math.max(1, windowMs / 60000),
    totalTokens,
  };
}

function groupAccessEvents(events, keyFn, options = {}) {
  const groups = new Map();
  for (const entry of events) {
    const key = String(keyFn(entry) || "-");
    const item = groups.get(key) || {
      key,
      label: key,
      count: 0,
      success: 0,
      error: 0,
      streamed: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      firstAt: entry.at,
      lastAt: entry.at,
      statuses: {},
      methods: {},
      kinds: {},
      paths: {},
      models: {},
      authSources: {},
      remoteAddresses: {},
    };
    item.count += 1;
    if (entry.ok) item.success += 1;
    else item.error += 1;
    if (entry.stream) item.streamed += 1;
    item.totalTokens += Number(entry.totalTokens || 0);
    item.inputTokens += Number(entry.inputTokens || 0);
    item.outputTokens += Number(entry.outputTokens || 0);
    item.totalDurationMs += Number(entry.durationMs || 0);
    item.maxDurationMs = Math.max(item.maxDurationMs, Number(entry.durationMs || 0));
    item.firstAt = !item.firstAt || entry.atMs < Date.parse(item.firstAt) ? entry.at : item.firstAt;
    item.lastAt = !item.lastAt || entry.atMs > Date.parse(item.lastAt) ? entry.at : item.lastAt;
    incrementCounter(item.statuses, String(entry.status || 0));
    incrementCounter(item.methods, entry.method || "-");
    incrementCounter(item.kinds, entry.kind || "-");
    incrementCounter(item.paths, entry.path || "-");
    incrementCounter(item.models, entry.model || entry.resolvedModel || "-");
    incrementCounter(item.authSources, entry.authSource || "none");
    incrementCounter(item.remoteAddresses, entry.remoteAddress || "-");
    groups.set(key, item);
  }
  return Array.from(groups.values())
    .map((item) => ({
      ...item,
      avgDurationMs: item.count ? item.totalDurationMs / item.count : 0,
      errorRate: item.count ? item.error / item.count : 0,
      topStatus: topCounterEntry(item.statuses),
      topPath: topCounterEntry(item.paths),
      topModel: topCounterEntry(item.models),
      topAuthSource: topCounterEntry(item.authSources),
    }))
    .sort((a, b) => b.count - a.count || String(b.lastAt || "").localeCompare(String(a.lastAt || "")))
    .slice(0, Number(options.limit || 30));
}

function incrementCounter(counter, key) {
  counter[key] = Number(counter[key] || 0) + 1;
}

function topCounterEntry(counter = {}) {
  return Object.entries(counter).sort((a, b) => Number(b[1]) - Number(a[1]))[0] || ["-", 0];
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * p) - 1));
  return sortedValues[index] || 0;
}

function buildAccessTimeline(events, now = Date.now()) {
  const bucketMs = 5 * 60 * 1000;
  const start = now - 2 * 60 * 60 * 1000;
  const buckets = new Map();
  for (let t = Math.floor(start / bucketMs) * bucketMs; t <= now; t += bucketMs) {
    buckets.set(t, { at: new Date(t).toISOString(), total: 0, success: 0, error: 0, totalTokens: 0, avgDurationMs: 0, durationTotalMs: 0 });
  }
  for (const entry of events) {
    if (entry.atMs < start) continue;
    const key = Math.floor(entry.atMs / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.total += 1;
    if (entry.ok) bucket.success += 1;
    else bucket.error += 1;
    bucket.totalTokens += Number(entry.totalTokens || 0);
    bucket.durationTotalMs += Number(entry.durationMs || 0);
  }
  return Array.from(buckets.values()).map((bucket) => ({
    ...bucket,
    avgDurationMs: bucket.total ? bucket.durationTotalMs / bucket.total : 0,
  }));
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
  const empty = emptyStatsSummary(container, endpoint);
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

async function updateStatsLedger(summary, reason = "collect") {
  const ledger = await loadStatsLedger();
  if (!summary?.processStartSeconds || !Array.isArray(summary.models) || !summary.models.length) {
    return ledger;
  }
  for (const model of summary.models) {
    const runtimeKey = `${summary.processStartSeconds}:${model.name}`;
    const previous = ledger.runtimes[runtimeKey] || emptyRuntimeCounters();
    const current = runtimeCountersFromModel(model);
    const monotonicCurrent = maxRuntimeCounters(current, previous);
    const delta = diffRuntimeCounters(monotonicCurrent, previous);
    mergeModelDelta(ledger, model, delta, summary, reason);
    ledger.runtimes[runtimeKey] = monotonicCurrent;
  }
  ledger.updatedAt = new Date().toISOString();
  ledger.version = 1;
  await saveStatsLedger(ledger);
  return ledger;
}

async function loadStatsLedger() {
  try {
    const text = await fsp.readFile(CONFIG.statsLedger, "utf8");
    const parsed = JSON.parse(text);
    return normalizeStatsLedger(parsed);
  } catch {
    return normalizeStatsLedger({});
  }
}

async function saveStatsLedger(ledger) {
  const previous = statsLedgerWriteQueue;
  let release;
  statsLedgerWriteQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    await writeJsonFile(CONFIG.statsLedger, ledger);
  } finally {
    release();
  }
}

function normalizeStatsLedger(value) {
  return {
    version: 1,
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: value.updatedAt || null,
    models: value.models && typeof value.models === "object" ? value.models : {},
    runtimes: value.runtimes && typeof value.runtimes === "object" ? value.runtimes : {},
    clients: value.clients && typeof value.clients === "object" ? value.clients : {},
  };
}

function emptyRuntimeCounters() {
  return {
    prompt: 0,
    generation: 0,
    cachedPrompt: 0,
    requests: 0,
    success: 0,
    error: 0,
    aborted: 0,
  };
}

function runtimeCountersFromModel(model) {
  return {
    prompt: Number(model.tokens?.prompt || 0),
    generation: Number(model.tokens?.generation || 0),
    cachedPrompt: Number(model.tokens?.cachedPrompt || 0),
    requests: Number(model.requests?.total || 0),
    success: Number(model.requests?.success || 0),
    error: Number(model.requests?.error || 0),
    aborted: Number(model.requests?.aborted || 0),
  };
}

function diffRuntimeCounters(current, previous) {
  const result = {};
  for (const key of Object.keys(current)) {
    result[key] = Math.max(0, Number(current[key] || 0) - Number(previous[key] || 0));
  }
  return result;
}

function maxRuntimeCounters(current, previous) {
  const result = {};
  for (const key of Object.keys(current)) {
    result[key] = Math.max(Number(current[key] || 0), Number(previous[key] || 0));
  }
  return result;
}

function mergeModelDelta(ledger, model, delta, summary, reason) {
  const existing = ledger.models[model.name] || {
    name: model.name,
    root: model.root || "",
    tokens: { prompt: 0, generation: 0, cachedPrompt: 0, total: 0 },
    requests: { total: 0, success: 0, error: 0, aborted: 0 },
    last: {},
  };
  existing.root = model.root || existing.root || "";
  existing.tokens.prompt += delta.prompt;
  existing.tokens.generation += delta.generation;
  existing.tokens.cachedPrompt += delta.cachedPrompt;
  existing.tokens.total = existing.tokens.prompt + existing.tokens.generation;
  existing.requests.total += delta.requests;
  existing.requests.success += delta.success;
  existing.requests.error += delta.error;
  existing.requests.aborted += delta.aborted;
  existing.last = {
    updatedAt: new Date().toISOString(),
    reason,
    processStartSeconds: summary.processStartSeconds,
    maxModelLen: model.maxModelLen || model.context?.maxModelLen || null,
    context: model.context || {},
    latency: model.latency || {},
    averages: model.averages || {},
    speed: model.speed || {},
    cache: model.cache || {},
    facts: summary.facts || {},
  };
  ledger.models[model.name] = existing;
}

function ledgerToSummary(ledger) {
  const models = Object.values(ledger.models || {}).map((item) => ledgerModelToStatsModel(item));
  return {
    source: "persistent ledger",
    processStartSeconds: null,
    uptimeSeconds: null,
    facts: {},
    totals: aggregateStats(models, null),
    models,
    modelsByName: Object.fromEntries(models.map((model) => [model.name, model])),
    rawMetricCount: 0,
    note: ledger.updatedAt
      ? `Historical usage persisted at ${ledger.updatedAt}.`
      : "No historical usage has been captured yet.",
  };
}

function ledgerModelToStatsModel(item) {
  return {
    name: item.name,
    root: item.root || "",
    maxModelLen: item.last?.maxModelLen || item.last?.context?.maxModelLen || null,
    tokens: {
      prompt: Number(item.tokens?.prompt || 0),
      generation: Number(item.tokens?.generation || 0),
      cachedPrompt: Number(item.tokens?.cachedPrompt || 0),
      total: Number(item.tokens?.total || 0),
      promptBySource: {},
    },
    requests: {
      total: Number(item.requests?.total || 0),
      success: Number(item.requests?.success || 0),
      error: Number(item.requests?.error || 0),
      aborted: Number(item.requests?.aborted || 0),
      byFinishReason: {},
      running: 0,
      waiting: 0,
    },
    latency: item.last?.latency || {},
    averages: item.last?.averages || {},
    speed: {
      recentPromptTokensPerSecond: 0,
      recentOutputTokensPerSecond: 0,
      recentRequestsPerMinute: 0,
      averageOutputTokensPerSecond: item.last?.speed?.averageOutputTokensPerSecond || 0,
      lifetimeTokensPerSecond: null,
    },
    cache: item.last?.cache || {},
    context: item.last?.context || { activeTokens: 0, capacityTokens: null, kvUsagePercent: 0 },
  };
}

function mergeLiveAndLedger(liveSummary, ledger) {
  const historical = ledgerToSummary(ledger);
  const liveModels = Array.isArray(liveSummary?.models) ? liveSummary.models : [];
  const liveByName = Object.fromEntries(liveModels.map((model) => [model.name, model]));
  const mergedModels = historical.models.map((model) => ({
    ...model,
    context: liveByName[model.name]?.context || model.context,
    latency: liveByName[model.name]?.latency || model.latency,
    averages: liveByName[model.name]?.averages || model.averages,
    speed: liveByName[model.name]?.speed || model.speed,
    cache: liveByName[model.name]?.cache || model.cache,
    requests: {
      ...model.requests,
      running: liveByName[model.name]?.requests?.running || 0,
      waiting: liveByName[model.name]?.requests?.waiting || 0,
    },
  }));
  for (const model of liveModels) {
    if (!mergedModels.some((item) => item.name === model.name)) mergedModels.push(model);
  }
  return {
    ...historical,
    source: liveSummary?.source || historical.source,
    processStartSeconds: liveSummary?.processStartSeconds || null,
    uptimeSeconds: liveSummary?.uptimeSeconds || null,
    facts: liveSummary?.facts || historical.facts,
    totals: aggregateStats(mergedModels, liveSummary?.uptimeSeconds || null),
    models: mergedModels.sort((a, b) => b.tokens.total - a.tokens.total),
    modelsByName: Object.fromEntries(mergedModels.map((model) => [model.name, model])),
    rawMetricCount: liveSummary?.rawMetricCount || 0,
    note: historical.note,
  };
}

function emptyStatsSummary(container, endpoint) {
  return {
    source: endpoint ? `http://127.0.0.1:${endpoint.port}/metrics` : null,
    processStartSeconds: null,
    uptimeSeconds: null,
    facts: {},
    totals: {
      tokens: { prompt: 0, generation: 0, cachedPrompt: 0, total: 0 },
      requests: { total: 0, success: 0, error: 0, aborted: 0 },
      speed: { recentPromptTokensPerSecond: 0, recentOutputTokensPerSecond: 0, recentRequestsPerMinute: 0, lifetimeTokensPerSecond: 0 },
      latency: {},
      context: { activeTokens: 0, capacityTokens: null, kvUsagePercent: 0 },
      shares: {},
    },
    models: [],
    modelsByName: {},
    rawMetricCount: 0,
    note: container?.exists ? "llama.cpp container is not running." : "No managed llama.cpp container is running.",
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
    const recent = calculateRecentRates(name, nowSeconds, {
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

function aggregateStats(models, uptimeSeconds) {
  const totalPrompt = models.reduce((sum, model) => sum + model.tokens.prompt, 0);
  const totalGeneration = models.reduce((sum, model) => sum + model.tokens.generation, 0);
  const totalCached = models.reduce((sum, model) => sum + model.tokens.cachedPrompt, 0);
  const totalRequests = models.reduce((sum, model) => sum + model.requests.total, 0);
  const totalErrors = models.reduce((sum, model) => sum + model.requests.error, 0);
  const totalAborted = models.reduce((sum, model) => sum + model.requests.aborted, 0);
  const totalTokens = totalPrompt + totalGeneration;
  const activeContext = models.reduce((sum, model) => sum + (model.context.activeTokens || 0), 0);
  const contextCapacity = models.reduce((sum, model) => sum + (model.context.capacityTokens || 0), 0) || null;

  return {
    tokens: {
      prompt: totalPrompt,
      generation: totalGeneration,
      cachedPrompt: totalCached,
      total: totalTokens,
    },
    requests: {
      total: totalRequests,
      success: Math.max(0, totalRequests - totalErrors - totalAborted),
      error: totalErrors,
      aborted: totalAborted,
    },
    speed: {
      recentPromptTokensPerSecond: models.reduce((sum, model) => sum + model.speed.recentPromptTokensPerSecond, 0),
      recentOutputTokensPerSecond: models.reduce((sum, model) => sum + model.speed.recentOutputTokensPerSecond, 0),
      recentRequestsPerMinute: models.reduce((sum, model) => sum + model.speed.recentRequestsPerMinute, 0),
      lifetimeTokensPerSecond: uptimeSeconds ? totalTokens / uptimeSeconds : 0,
    },
    latency: {
      avgE2eSeconds: weightedAverage(models, (model) => model.latency.avgE2eSeconds, (model) => model.requests.total),
      avgTtftSeconds: weightedAverage(models, (model) => model.latency.avgTtftSeconds, (model) => model.requests.total),
      avgTimePerOutputTokenSeconds: weightedAverage(models, (model) => model.latency.avgTimePerOutputTokenSeconds, (model) => model.requests.total),
    },
    context: {
      activeTokens: activeContext,
      capacityTokens: contextCapacity,
      kvUsagePercent: contextCapacity ? activeContext / contextCapacity : 0,
    },
  };
}

function buildClientUsageSummary(totals, ledger) {
  const claude = clientCountersToSummary(ledger.clients?.claude, {
    id: "claude",
    label: "Claude 兼容桥",
    description: "经管理器 /claude/v1/messages 进入本地 llama.cpp 的 Claude Desktop / Claude Code / Cowork 请求。",
  });
  const other = subtractClientFromTotals(totals, claude);
  const totalTokens = Math.max(1, Number(totals?.tokens?.total || 0));
  const totalRequests = Math.max(1, Number(totals?.requests?.total || 0));
  return {
    totals: {
      tokens: totals?.tokens || { prompt: 0, generation: 0, cachedPrompt: 0, total: 0 },
      requests: totals?.requests || { total: 0, success: 0, error: 0, aborted: 0 },
    },
    clients: [
      {
        ...claude,
        share: {
          tokens: Math.min(1, claude.tokens.total / totalTokens),
          requests: Math.min(1, claude.requests.total / totalRequests),
        },
      },
      {
        ...other,
        share: {
          tokens: Math.min(1, other.tokens.total / totalTokens),
          requests: Math.min(1, other.requests.total / totalRequests),
        },
      },
    ],
    note: "Claude 只统计通过管理器 Claude 兼容桥的请求；OpenWebUI 或直接访问 llama.cpp /v1 的请求会归入聊天/直连。",
  };
}

function clientCountersToSummary(counters, meta) {
  const item = normalizeClientUsageCounters(counters, meta.id, meta.label);
  const models = Object.entries(item.models || {})
    .map(([name, value]) => {
      const model = normalizeClientModelBucket(value);
      return { name, ...model };
    })
    .sort((a, b) => b.tokens.total - a.tokens.total);
  return {
    id: meta.id,
    label: meta.label,
    description: meta.description,
    tokens: item.tokens,
    requests: item.requests,
    tools: item.tools,
    compression: item.compression,
    latency: item.latency,
    models,
    aliases: item.aliases || {},
    last: item.last || {},
  };
}

function subtractClientFromTotals(totals, client) {
  const prompt = Math.max(0, Number(totals?.tokens?.prompt || 0) - Number(client.tokens?.prompt || 0));
  const generation = Math.max(0, Number(totals?.tokens?.generation || 0) - Number(client.tokens?.generation || 0));
  const cachedPrompt = Math.max(0, Number(totals?.tokens?.cachedPrompt || 0) - Number(client.tokens?.cachedPrompt || 0));
  const requests = Math.max(0, Number(totals?.requests?.total || 0) - Number(client.requests?.total || 0));
  const errors = Math.max(0, Number(totals?.requests?.error || 0) - Number(client.requests?.error || 0));
  return {
    id: "chat-direct",
    label: "OpenWebUI / 直连 API",
    description: "OpenAI 兼容接口、OpenWebUI 聊天和没有经过 Claude 桥的请求。",
    tokens: {
      prompt,
      generation,
      cachedPrompt,
      total: prompt + generation,
    },
    requests: {
      total: requests,
      success: Math.max(0, requests - errors),
      error: errors,
      streamed: 0,
    },
    tools: { schemas: 0, toolUse: 0 },
    compression: { applied: 0, savedTokens: 0 },
    latency: { avgMs: 0, maxMs: 0, totalMs: 0 },
    models: [],
    aliases: {},
    last: {},
  };
}

function calculateCost(tokens, profile) {
  const prompt = Number(tokens.prompt || 0);
  const output = Number(tokens.generation || 0);
  const cached = Math.min(prompt, Number(tokens.cachedPrompt || 0));
  const uncached = Math.max(0, prompt - cached);
  const standard = (prompt / 1_000_000) * profile.inputPerM
    + (output / 1_000_000) * profile.outputPerM;
  const cachedEquivalent = (uncached / 1_000_000) * profile.inputPerM
    + (cached / 1_000_000) * (profile.cachedInputPerM ?? profile.inputPerM)
    + (output / 1_000_000) * profile.outputPerM;
  return {
    ...profile,
    standardCost: standard,
    cachedEquivalentCost: cachedEquivalent,
  };
}

function parsePrometheusMetrics(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = line.match(/^([^\s{]+)(?:\{([^}]*)\})?\s+([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?|NaN|\+Inf|-Inf)/i);
      if (!match) return null;
      return {
        name: match[1],
        labels: parsePrometheusLabels(match[2] || ""),
        value: Number(match[3]),
      };
    })
    .filter((metric) => metric && Number.isFinite(metric.value));
}

function parsePrometheusLabels(text) {
  const labels = {};
  const regex = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = regex.exec(text))) {
    labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return labels;
}

function firstMetricValue(metrics, name, predicate = null) {
  const item = metrics.find((metric) => metric.name === name && (!predicate || predicate(metric)));
  return item ? item.value : null;
}

function sumMetric(metrics, name, predicate = null) {
  return metrics
    .filter((metric) => metric.name === name && (!predicate || predicate(metric)))
    .reduce((sum, metric) => sum + metric.value, 0);
}

function sumByLabel(metrics, name, label) {
  const result = {};
  for (const metric of metrics) {
    if (metric.name !== name) continue;
    const key = metric.labels[label] || "unknown";
    result[key] = (result[key] || 0) + metric.value;
  }
  return result;
}

function histogramAverage(metrics, baseName) {
  const sum = sumMetric(metrics, `${baseName}_sum`);
  const count = sumMetric(metrics, `${baseName}_count`);
  return count ? sum / count : null;
}

function tokensPerSecondFromSeconds(secondsPerToken) {
  return secondsPerToken ? 1 / secondsPerToken : 0;
}

function calculateRecentRates(modelName, nowSeconds, counters, updateSamples) {
  const previous = statsSamples.get(modelName);
  const current = { time: nowSeconds, ...counters };
  if (updateSamples) statsSamples.set(modelName, current);
  if (!previous || nowSeconds <= previous.time) {
    return {
      recentPromptTokensPerSecond: 0,
      recentOutputTokensPerSecond: 0,
      recentRequestsPerMinute: 0,
    };
  }
  const elapsed = nowSeconds - previous.time;
  return {
    recentPromptTokensPerSecond: Math.max(0, counters.promptTokens - previous.promptTokens) / elapsed,
    recentOutputTokensPerSecond: Math.max(0, counters.generationTokens - previous.generationTokens) / elapsed,
    recentRequestsPerMinute: Math.max(0, counters.requestCount - previous.requestCount) / elapsed * 60,
  };
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
  const needles = normalizeRuntimeFactHints(modelHints);
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

function normalizeRuntimeFactHints(hints) {
  return (Array.isArray(hints) ? hints : [hints])
    .map((hint) => String(hint || "").trim().toLowerCase())
    .filter(Boolean);
}

function jobMatchesRuntimeFactHints(job, needles) {
  const name = String(job.meta?.name || "").toLowerCase();
  const text = [
    job.meta?.model,
    job.meta?.name,
    job.meta?.servedModels ? JSON.stringify(job.meta.servedModels) : "",
  ].join("\n").toLowerCase();
  return needles.some((needle) => text.includes(needle) || (name && needle.includes(name)));
}

function lastIntegerMatch(text, regex) {
  const value = lastCapture(text, regex);
  return value ? Number(String(value).replace(/,/g, "")) : null;
}

function lastFloatMatch(text, regex) {
  const value = lastCapture(text, regex);
  return value ? Number(value) : null;
}

function lastCapture(text, regex) {
  let match;
  let value = null;
  while ((match = regex.exec(text))) value = match[1];
  return value;
}

function countUniqueCaptures(text, regex) {
  const values = new Set();
  let match;
  while ((match = regex.exec(text))) {
    if (match[1]) values.add(String(match[1]));
  }
  return values.size;
}

function averageCapture(text, regex, multiplier = 1) {
  let match;
  let total = 0;
  let count = 0;
  while ((match = regex.exec(text))) {
    const value = Number(String(match[1] || "").replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    total += value * multiplier;
    count += 1;
  }
  return count ? total / count : null;
}

function weightedAverage(items, valueFn, weightFn) {
  let total = 0;
  let weight = 0;
  for (const item of items) {
    const value = valueFn(item);
    const itemWeight = weightFn(item);
    if (value === null || value === undefined || !itemWeight) continue;
    total += value * itemWeight;
    weight += itemWeight;
  }
  return weight ? total / weight : null;
}

async function listLocalModels() {
  await ensureDirs(CONFIG.modelsRoot);
  const entries = await fsp.readdir(CONFIG.modelsRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  const models = [];
  for (const entry of dirs) {
    const fullPath = path.join(CONFIG.modelsRoot, entry.name);
    const stats = await fsp.stat(fullPath);
    const ggufFiles = findGgufFilesSync(fullPath, 12);
    models.push({
      kind: "local",
      id: entry.name,
      label: entry.name,
      path: fullPath,
      launchModel: fullPath,
      size: await dirSize(fullPath),
      modified: stats.mtime.toISOString(),
      hasConfig: hasRecognizedConfig(fullPath),
      hasGguf: ggufFiles.length > 0,
      ggufFiles,
    });
  }
  return models.sort((a, b) => b.modified.localeCompare(a.modified));
}

async function listCachedModels() {
  const hubRoot = path.join(CONFIG.hfCache, "hub");
  if (!fs.existsSync(hubRoot)) return [];
  const entries = await fsp.readdir(hubRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("models--"));
  const models = [];
  for (const entry of dirs) {
    const repoId = entry.name.replace(/^models--/, "").replace(/--/g, "/");
    const fullPath = path.join(hubRoot, entry.name);
    const stats = await fsp.stat(fullPath);
    models.push({
      kind: "cached",
      id: repoId,
      label: repoId,
      path: fullPath,
      launchModel: repoId,
      size: await dirSize(fullPath),
      modified: stats.mtime.toISOString(),
    });
  }
  return models.sort((a, b) => b.modified.localeCompare(a.modified));
}

async function dirSize(target) {
  let total = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) total += (await fsp.stat(full)).size;
      } catch {
        // Ignore files that change while scanning.
      }
    }
  }
  await walk(target);
  return total;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function loadJobsLedgerIntoMemory() {
  try {
    const text = await fsp.readFile(CONFIG.jobsLedger, "utf8");
    const parsed = JSON.parse(text);
    const loaded = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    for (const item of loaded.slice(-MAX_PERSISTED_JOBS)) {
      const job = normalizePersistedJob(item);
      if (!job?.id) continue;
      if (job.status === "running") {
        job.status = "interrupted";
        job.error = "Manager restarted while this job was running.";
        job.finishedAt = job.finishedAt || new Date().toISOString();
        job.logs = [...(job.logs || []), "Manager restarted; live process tracking was interrupted."].slice(-MAX_LOG_LINES);
      }
      jobs.set(job.id, job);
    }
    await saveJobsLedgerNow();
  } catch (error) {
    if (error.code === "ENOENT") {
      await saveJobsLedgerNow();
    } else {
      console.warn(`Unable to load jobs ledger: ${error.message}`);
    }
  }
}

function normalizePersistedJob(value) {
  if (!value || typeof value !== "object") return null;
  return {
    id: String(value.id || ""),
    type: String(value.type || "job"),
    title: String(value.title || value.type || "job"),
    status: String(value.status || "unknown"),
    logs: Array.isArray(value.logs) ? value.logs.map(String).slice(-MAX_LOG_LINES) : [],
    meta: value.meta && typeof value.meta === "object" ? value.meta : {},
    progress: value.progress && typeof value.progress === "object" ? value.progress : null,
    pid: value.pid || null,
    exitCode: value.exitCode ?? null,
    error: value.error || null,
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: value.updatedAt || value.createdAt || new Date().toISOString(),
    finishedAt: value.finishedAt || null,
  };
}

function persistableJob(job) {
  return normalizePersistedJob(job);
}

function scheduleJobsSave(delayMs = 600) {
  if (jobsSaveTimer) clearTimeout(jobsSaveTimer);
  jobsSaveTimer = setTimeout(() => {
    jobsSaveTimer = null;
    saveJobsLedgerNow().catch((error) => console.warn(`Unable to save jobs ledger: ${error.message}`));
  }, delayMs);
  jobsSaveTimer.unref?.();
}

async function saveJobsLedgerNow() {
  const previous = jobsLedgerWriteQueue;
  let release;
  jobsLedgerWriteQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    const allJobs = Array.from(jobs.values())
      .map(persistableJob)
      .filter(Boolean)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(-MAX_PERSISTED_JOBS);
    await writeJsonFile(CONFIG.jobsLedger, {
      version: 1,
      updatedAt: new Date().toISOString(),
      jobs: allJobs,
    });
  } finally {
    release();
  }
}

function createJob(type, title, meta = {}) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    type,
    title,
    status: "running",
    logs: [],
    meta,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  scheduleJobsSave(0);
  return job;
}

function appendLog(job, data) {
  const text = String(data || "").replace(/\r/g, "");
  for (const line of text.split("\n")) {
    if (!line) continue;
    job.logs.push(line);
  }
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  job.updatedAt = new Date().toISOString();
  scheduleJobsSave();
}

function finishJob(job, meta = {}) {
  if (job.status !== "running" && job.status !== "queued") return;
  job.status = "success";
  job.updatedAt = new Date().toISOString();
  job.finishedAt = job.updatedAt;
  job.meta = { ...job.meta, ...meta };
  stopProgressTracker(job);
  if (job.type === "serve") {
    setJobProgress(job, {
      percent: 100,
      stage: "服务已就绪",
      detail: "llama.cpp API 已返回模型列表。",
      state: "ok",
    });
  } else if (job.progress) {
    const totalBytes = Number(job.progress.totalBytes || job.meta.expectedBytes || 0);
    job.progress = {
      ...job.progress,
      downloadedBytes: Math.max(Number(job.progress.downloadedBytes || 0), totalBytes || 0),
      percent: totalBytes ? 100 : null,
      speedBytesPerSec: 0,
      etaSeconds: null,
      updatedAt: job.updatedAt,
    };
  }
  scheduleJobsSave(0);
}

function failJob(job, error) {
  if (job.status !== "running" && job.status !== "queued") return;
  job.status = "failed";
  job.updatedAt = new Date().toISOString();
  job.finishedAt = job.updatedAt;
  job.error = error.message || String(error);
  stopProgressTracker(job);
  if (job.type === "serve") {
    const existingIssues = Array.isArray(job.progress?.issues) ? job.progress.issues : [];
    setJobProgress(job, {
      percent: job.progress?.percent || 100,
      stage: job.progress?.stage || "启动失败",
      detail: job.progress?.detail || job.error,
      state: "fail",
      issues: existingIssues.length ? existingIssues : extractLogIssues(job.error),
    });
  }
  if (error.stdout) appendLog(job, error.stdout);
  if (error.stderr) appendLog(job, error.stderr);
  appendLog(job, `Error: ${job.error}`);
  scheduleJobsSave(0);
}

function setJobProgress(job, progress = {}) {
  const updatedAt = new Date().toISOString();
  job.progress = {
    kind: job.type,
    percent: progress.percent ?? job.progress?.percent ?? null,
    stage: progress.stage || job.progress?.stage || "",
    detail: progress.detail || job.progress?.detail || "",
    state: progress.state || job.progress?.state || "running",
    issues: progress.issues || job.progress?.issues || [],
    updatedAt,
  };
  job.updatedAt = updatedAt;
  scheduleJobsSave();
}

function extractLogIssues(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /(^|\s)(error|exception|traceback|failed|fatal)\b|out of memory|no such|cannot|not found|runtimeerror|valueerror|typeerror|validationerror|invalid repository|configuration file|config\.json|params\.json/i.test(line))
    .slice(-8);
}

function createProcessJob(type, command, args, options = {}) {
  const job = createJob(type, options.title || type, options.meta || {});
  spawnJobProcess(job, command, args, options);
  return job;
}

function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // process may have already exited
  }
}

function spawnJobProcess(job, command, args, options = {}) {
  job.status = "running";
  job.error = null;
  job.finishedAt = null;
  appendLog(job, `> ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    windowsHide: true,
    env: options.env || process.env,
  });
  job.pid = child.pid;
  scheduleJobsSave();
  if (options.progressDir) {
    startProgressTracker(job, options.progressDir, options.expectedBytes, {
      countExistingProgress: Boolean(options.countExistingProgress),
    });
  }
  child.stdout.on("data", (data) => appendLog(job, data));
  child.stderr.on("data", (data) => appendLog(job, data));
  child.on("error", (error) => failJob(job, error));
  child.on("close", (code) => {
    job.exitCode = code;
    Promise.resolve()
      .then(async () => {
        if (job.meta?.cancelRequested && job.type === "download") {
          if (job.meta.cancelAction === "pause") pauseDownloadJobAfterStop(job);
          else await finalizeDownloadCancel(job, { deletePartial: true });
        } else if (code === 0) {
          finishJob(job);
        } else {
          failJob(job, new Error(`Process exited with code ${code}`));
        }
      })
      .catch((error) => failJob(job, error));
  });
  job.cancel = (action = "cancel") => {
    job.meta = { ...job.meta, cancelRequested: true, cancelAction: action };
    scheduleJobsSave(0);
    terminateProcessTree(child.pid);
  };
  return job;
}

function isDownloadFinished(status) {
  return ["success", "cancelled"].includes(String(status || ""));
}

function pauseDownloadJob(job) {
  if (job.status === "paused") return job;
  if (job.status !== "running") {
    throw new Error("只有运行中的下载可以暂停。");
  }
  if (typeof job.cancel !== "function") throw new Error("当前下载任务无法暂停。");
  appendLog(job, "正在暂停下载，已下载的部分会保留用于继续。");
  job.cancel("pause");
  return job;
}

function pauseDownloadJobAfterStop(job) {
  if (job.status !== "running") return;
  stopProgressTracker(job);
  job.status = "paused";
  job.pid = null;
  job.updatedAt = new Date().toISOString();
  job.finishedAt = null;
  job.error = null;
  job.meta = {
    ...job.meta,
    cancelRequested: false,
    cancelAction: null,
  };
  if (job.progress) {
    job.progress = {
      ...job.progress,
      speedBytesPerSec: 0,
      etaSeconds: null,
      updatedAt: job.updatedAt,
    };
  }
  appendLog(job, "下载已暂停；点击继续会从本地已有文件续传。");
}

async function cancelDownloadJob(job) {
  if (job.status === "running") {
    if (typeof job.cancel !== "function") throw new Error("当前下载任务无法取消。");
    appendLog(job, "正在取消下载，完成后会删除本地部分文件。");
    job.cancel("cancel");
    return job;
  }
  if (job.type !== "download" || isDownloadFinished(job.status)) {
    throw new Error("该下载任务已结束。");
  }
  await finalizeDownloadCancel(job, { deletePartial: true });
  return job;
}

async function finalizeDownloadCancel(job, options = {}) {
  stopProgressTracker(job);
  job.status = "cancelled";
  job.pid = null;
  job.updatedAt = new Date().toISOString();
  job.finishedAt = job.updatedAt;
  job.error = null;
  job.meta = {
    ...job.meta,
    cancelRequested: false,
    cancelAction: null,
  };
  if (job.progress) {
    job.progress = {
      ...job.progress,
      speedBytesPerSec: 0,
      etaSeconds: null,
      updatedAt: job.updatedAt,
    };
  }
  appendLog(job, "下载已取消。");
  if (options.deletePartial !== false) {
    await deletePartialDownload(job);
  }
}

async function deletePartialDownload(job) {
  const localDir = job.meta?.localDir;
  if (!localDir) return;
  const resolved = resolveModelsRootChild(localDir);
  await fsp.rm(resolved, { recursive: true, force: true });
  appendLog(job, `已删除部分下载目录: ${resolved}`);
}

function resumeDownloadJob(job) {
  if (job.status === "running") return job;
  if (job.status === "success") throw new Error("该下载任务已完成，不需要继续。");
  const spec = buildDownloadSpecFromJob(job);
  job.meta = {
    ...(job.meta || {}),
    ...(spec.options.meta || {}),
    cancelRequested: false,
    cancelAction: null,
  };
  job.error = null;
  job.finishedAt = null;
  appendLog(job, "继续下载，尝试复用本地已有文件。");
  spawnJobProcess(job, spec.command, spec.args, spec.options);
  return job;
}

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
    stage: "Validate model",
    detail: "Checking model path and GGUF file before touching the running container.",
  });
  const launch = resolveLaunchModel(opts.model, "gguf");
  const modelArg = launch.modelArg;
  const remoteRepo = !path.isAbsolute(opts.model) && /^[^/\s]+\/[^/\s]+/.test(opts.model) && !String(opts.model).toLowerCase().endsWith(".gguf");
  if (remoteRepo) {
    appendLog(job, `Remote GGUF repo mode: ${opts.model}`);
  } else {
    appendLog(job, `GGUF model: using ${modelArg}`);
  }
  if (launch.selectedGgufFile && launch.ggufFiles.length > 1) {
    appendLog(job, `Multiple GGUF files found; selected largest file: ${path.basename(launch.selectedGgufFile)}`);
  }

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

  if (normalizeDefaultTrueBoolean(opts.textOnlyMode, opts.languageModelOnly)) {
    appendLog(job, "Text-only mode: no mmproj/projector will be loaded.");
  } else {
    appendLog(job, "Text-only mode is off, but this manager does not pass an mmproj/projector yet; llama.cpp will still launch as text unless a projector option is added later.");
  }
  if ((opts.gpuDeviceIds || []).length > 1) {
    appendLog(job, `Heterogeneous GPU split: mode=${opts.multiGpuMode}, tensor-split=${opts.tensorSplit || "auto"}, main-gpu=${opts.mainGpu}`);
    if (opts.gpuPlan?.summary) appendLog(job, `GPU plan: ${opts.gpuPlan.summary}`);
    if (opts.gpuPlan?.mainGpuHostId !== undefined) appendLog(job, `Host GPU ${opts.gpuPlan.mainGpuHostId} is visible as llama.cpp main-gpu ${opts.mainGpu}`);
  }
  let activePublishArgs = dockerPublishArgs(opts.port, opts.networkAccess, opts.serviceHost);
  appendLog(job, `Docker publish: ${activePublishArgs.map((arg) => `-p ${arg}`).join(" ")}`);
  const runArgs = [
    "run", "-d",
    "--name", CONFIG.containerName,
    "--label", `${MANAGER_LABEL_KEY}=${CONFIG.managerId}`,
    "--label", `${MANAGER_ENGINE_LABEL_KEY}=llama`,
    "--gpus", dockerGpuArg(opts.gpuDeviceIds || []),
    "--ipc=host",
    ...publishArgsToDockerRunArgs(activePublishArgs),
    "-v", `${CONFIG.hfCache}:/root/.cache/huggingface`,
    "-v", `${CONFIG.modelsRoot}:/models`,
  ];
  const gpuVisibility = normalizeGpuIds(opts.gpuDeviceIds).join(",");
  if (gpuVisibility) {
    runArgs.push(
      "-e", `NVIDIA_VISIBLE_DEVICES=${gpuVisibility}`,
      "-e", `CUDA_VISIBLE_DEVICES=${gpuVisibility}`,
      "-e", "NVIDIA_DRIVER_CAPABILITIES=compute,utility"
    );
  }
  if (process.env.HF_TOKEN) runArgs.push("-e", `HF_TOKEN=${process.env.HF_TOKEN}`);

  runArgs.push(CONFIG.image);
  if (remoteRepo) runArgs.push("--hf-repo", opts.model);
  else runArgs.push("--model", modelArg);
  runArgs.push(
    "--alias", opts.name,
    "--host", "0.0.0.0",
    "--port", "8080",
    "--ctx-size", String(opts.maxModelLen),
    "--parallel", String(opts.maxNumSeqs),
    "--batch-size", String(opts.batchSize),
    "--ubatch-size", String(opts.ubatchSize),
    "--n-gpu-layers", opts.gpuLayers,
    "--split-mode", opts.multiGpuMode,
    "--main-gpu", String(opts.mainGpu),
    "--cache-type-k", opts.cacheTypeK,
    "--cache-type-v", opts.cacheTypeV,
    "--flash-attn", opts.flashAttention,
    "--reasoning", opts.reasoning,
    "--reasoning-format", opts.reasoningFormat,
    "--metrics",
    "--jinja"
  );
  if (opts.tensorSplit && opts.multiGpuMode !== "none") runArgs.push("--tensor-split", opts.tensorSplit);
  if (opts.noMmap) runArgs.push("--no-mmap");

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
    appendLog(job, `Docker publish fallback: ${activePublishArgs.map((arg) => `-p ${arg}`).join(" ")}`);
    appendLog(job, `> docker ${retryArgs.join(" ")}`);
    launched = await docker(retryArgs);
  }
  appendLog(job, launched.stdout || launched.stderr);

  setJobProgress(job, {
    percent: 45,
    stage: "等待模型加载",
    detail: "容器已创建，正在等待 llama.cpp server 返回 /v1/models。",
  });
  appendLog(job, `Service URL: ${opts.serviceUrl}`);
  appendLog(job, `Waiting for http://127.0.0.1:${opts.port}/v1/models`);
  const started = Date.now();
  const startupTimeoutMs = CONFIG.startupTimeoutMs;
  appendLog(job, `Startup timeout budget: ${Math.round(startupTimeoutMs / 60_000)} minutes`);
  let lastLogCheck = 0;
  while (Date.now() - started < startupTimeoutMs) {
    const elapsed = Date.now() - started;
    setJobProgress(job, {
      percent: Math.min(94, 45 + (elapsed / startupTimeoutMs) * 49),
      stage: "等待模型加载",
      detail: "正在轮询 llama.cpp API，并读取容器日志检查错误。",
    });
    const served = await getServedModels(opts.port);
    if (served.length) {
      appendLog(job, "Ready.");
      setJobProgress(job, {
        percent: 100,
        stage: "服务已就绪",
        detail: `已加载模型：${served.map((item) => item.id).join(", ")}`,
        state: "ok",
      });
      finishJob(job, { servedModels: served });
      return;
    }
    const container = await getContainerStatus(CONFIG.containerName);
    if (!container.exists) {
      setJobProgress(job, {
        percent: job.progress?.percent,
        stage: "容器已消失",
        detail: `${CONFIG.containerName} 不存在，llama.cpp 启动进程已经结束或被移除。`,
        state: "fail",
        issues: [`No such container: ${CONFIG.containerName}`],
      });
      throw new Error(`${CONFIG.containerName} disappeared before llama.cpp became ready`);
    }
    if (!container.running) {
      await delay(1000);
      const logs = await docker(["logs", "--tail", "260", CONFIG.containerName], { rejectOnError: false });
      const logText = `${logs.stdout}${logs.stderr}`;
      appendLog(job, logText);
      const issues = extractLogIssues(logText);
      setJobProgress(job, {
        percent: job.progress?.percent,
        stage: "容器已退出",
        detail: issues[issues.length - 1] || container.status || "llama.cpp 容器已停止。",
        state: "fail",
        issues: issues.length ? issues : [container.status || "Container exited"],
      });
      throw new Error(`llama.cpp container exited before becoming ready: ${container.status || "stopped"}`);
    }
    if (Date.now() - lastLogCheck > 10000) {
      lastLogCheck = Date.now();
      const logs = await docker(["logs", "--tail", "30", CONFIG.containerName], { rejectOnError: false });
      const logText = `${logs.stdout}${logs.stderr}`;
      appendLog(job, logText);
      const issues = extractLogIssues(logText);
      if (issues.length) {
        setJobProgress(job, {
          percent: job.progress?.percent,
          stage: "日志发现错误",
          detail: issues[issues.length - 1],
          state: "warn",
          issues,
        });
      }
    }
    await delay(5000);
  }
  const servedAfterTimeout = await getServedModels(opts.port);
  if (servedAfterTimeout.length) {
    appendLog(job, "Ready after final timeout check.");
    setJobProgress(job, {
      percent: 100,
      stage: "服务已就绪",
      detail: `已加载模型：${servedAfterTimeout.map((item) => item.id).join(", ")}`,
      state: "ok",
    });
    finishJob(job, { servedModels: servedAfterTimeout });
    return;
  }
  const logs = await docker(["logs", "--tail", "180", CONFIG.containerName], { rejectOnError: false });
  const logText = `${logs.stdout}${logs.stderr}`;
  appendLog(job, logText);
  const issues = extractLogIssues(logText);
  if (issues.length) {
    setJobProgress(job, {
      percent: 96,
      stage: "启动超时，日志有错误",
      detail: issues[issues.length - 1],
      state: "fail",
      issues,
    });
  }
  throw new Error(`llama.cpp did not become ready within ${Math.round(startupTimeoutMs / 60_000)} minutes`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function memoryEstimateNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeMemoryEstimateArch(value = null) {
  if (!value || typeof value !== "object") return null;
  const layers = memoryEstimateNumber(value.layers ?? value.numHiddenLayers ?? value.num_hidden_layers, 0);
  const kvLayers = memoryEstimateNumber(value.kvLayers ?? value.numKvLayers ?? value.num_key_value_layers ?? layers, layers);
  const kvHeads = memoryEstimateNumber(value.kvHeads ?? value.numKeyValueHeads ?? value.num_key_value_heads, 0);
  const headDim = memoryEstimateNumber(value.headDim ?? value.head_dim, 0);
  if (!layers || !kvHeads || !headDim) return null;
  return {
    layers,
    kvLayers,
    kvHeads,
    headDim,
    label: value.label || value.modelType || value.model_type || "request config",
    source: value.source || "request",
  };
}

function normalizeMemoryEstimateGpus(value = []) {
  const list = Array.isArray(value) ? value : [];
  return list.map((gpu = {}, index) => {
    const totalMb = memoryEstimateNumber(gpu.totalMb ?? gpu.total_mib ?? gpu.memoryTotalMb, 0);
    const usedMb = memoryEstimateNumber(gpu.usedMb ?? gpu.used_mib ?? gpu.memoryUsedMb, 0);
    const freeMb = memoryEstimateNumber(gpu.freeMb ?? gpu.free_mib ?? gpu.memoryFreeMb, Math.max(0, totalMb - usedMb));
    const totalGb = memoryEstimateNumber(gpu.totalGb, totalMb / 1024);
    const usedGb = memoryEstimateNumber(gpu.usedGb, usedMb / 1024);
    const freeGb = memoryEstimateNumber(gpu.freeGb, freeMb / 1024);
    return {
      id: String(gpu.id ?? gpu.index ?? index),
      name: String(gpu.name || `GPU ${gpu.id ?? index}`),
      totalMb: totalGb ? totalGb * 1024 : totalMb,
      usedMb: usedGb ? usedGb * 1024 : usedMb,
      freeMb: freeGb ? freeGb * 1024 : freeMb,
      totalGb,
      usedGb,
      freeGb,
    };
  }).filter((gpu) => gpu.totalGb > 0 || gpu.totalMb > 0);
}

function parseMemoryEstimateWeights(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s:;]+/);
  return raw
    .map((item) => memoryEstimateNumber(item, NaN))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function buildLlamaMemoryEstimate(input = {}) {
  const selectedGpus = normalizeMemoryEstimateGpus(input.selectedGpus || input.gpus || []);
  const arch = normalizeMemoryEstimateArch(input.arch || input.modelConfig || input.config);
  const plan = core.estimateLlamaMemoryPlan({
    paramsB: memoryEstimateNumber(input.paramsB, 0),
    contextTokens: Math.max(1, memoryEstimateNumber(input.contextTokens ?? input.maxModelLen, 8192)),
    // GGUF usually has lower transient overhead than safetensors, so the default bytes/param is intentionally lower.
    bytesPerParam: Math.max(0.125, memoryEstimateNumber(input.bytesPerParam, 0.56)),
    kvBytes: Math.max(0.125, memoryEstimateNumber(input.kvBytes, 2)),
    arch,
    selectedGpus,
    utilization: memoryEstimateNumber(input.gpuMemoryUtilization ?? input.utilization, 0.9),
    gpuLayers: input.gpuLayers ?? input.nGpuLayers ?? "all",
    tensorSplitWeights: parseMemoryEstimateWeights(input.tensorSplitWeights ?? input.tensorSplit),
    multimodalReserveGb: Math.max(0, memoryEstimateNumber(input.multimodalReserveGb, input.arch?.isMultimodal ? 2 : 0)),
  });
  const suggestions = [];
  if (!plan.selectedGpus.length) {
    suggestions.push("没有传入 GPU 显存数据，只能给出模型本身的理论占用。");
  } else if (plan.status === "fail") {
    suggestions.push(`预计会溢出显存，建议把 GPU layers 降到 ${plan.recommendedGpuLayers}/${plan.totalLayers} 左右，让剩余层落到内存。`);
  } else if (plan.status === "warn") {
    suggestions.push("预计接近显存上限，建议降低 GPU layers、缩短上下文或调低可用显存比例。");
  } else {
    suggestions.push("当前配置预计可运行，并保留了基本运行时余量。");
  }
  if (selectedGpus.length > 1) {
    const suggestedSplit = selectedGpus.map((gpu) => Math.max(1, Math.round(gpu.freeGb || gpu.totalGb || 1))).join(",");
    suggestions.push(`异构多卡建议 tensor split 按可用显存近似填写：${suggestedSplit}。`);
  }
  return {
    ok: true,
    engine: "llama.cpp",
    plan,
    recommendations: {
      status: plan.status,
      summary: plan.status === "ok" ? "预计可运行" : plan.status === "warn" ? "预计接近显存上限" : "预计会显存不足",
      suggestions,
      recommendedGpuLayers: plan.recommendedGpuLayers,
      totalLayers: plan.totalLayers,
      peakGpuGb: plan.peakGpuGb,
      allocations: plan.allocations,
    },
  };
}

module.exports = {
  app,
  CONFIG,
  startManager,
  shutdownManager,
  firstExisting,
  parsePrometheusMetrics,
  parsePrometheusLabels,
  anthropicMessagesToOpenAi,
  anthropicToolsToOpenAi,
  anthropicToolChoiceToOpenAi,
  openAiResponseToClaude,
  openAiMessageToClaudeContent,
  buildClaudeCompressionSummary,
  buildClaudeCompressionSummaryText,
  parseToolArguments,
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
  isServiceApiKeyAccepted,
  enterServiceRateLimit,
  enterServiceConcurrency,
  resolveOpenAiGatewayModel,
  normalizeServiceClient,
  hashServiceApiKey,
  serviceClientAllowsModel,
  buildEffectiveServiceSettings,
  extractHostname,
  buildLlamaMemoryEstimate,
};
