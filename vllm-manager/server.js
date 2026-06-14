const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn, execFile } = require("child_process");
const core = require("../manager-core");
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {}

const app = express();
const PORT = Number(process.env.VLLM_MANAGER_PORT || 5177);
const HOST = process.env.VLLM_MANAGER_HOST || "127.0.0.1";
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

const jobs = new Map();
const progressTimers = new Map();
const statsSamples = new Map();
const auditSessions = new Map();
const fileWriteQueues = new Map();
const serviceRateBuckets = new Map();
const serviceConcurrencyBuckets = new Map();
let statsLedgerWriteQueue = Promise.resolve();
let jobsLedgerWriteQueue = Promise.resolve();
let jobsSaveTimer = null;
let httpServer = null;
let isShuttingDown = false;
let automationSettingsCache = null;
let serviceExposureSettingsCache = null;
let serviceClientsCache = null;
let serviceUsageDb = null;
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
let auditPasswordCache = null;
let claudeCompressionSettingsCache = null;

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
app.use(["/serve/v1", "/claude", "/v1/messages", "/v1/claude", "/opencode/v1"], serviceGatewayMiddleware);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  const lanAddress = getLanAddress();
  res.json({
    ...CONFIG,
    managerHost: HOST,
    managerPort: PORT,
    lanAddress,
    hasHfToken: Boolean(process.env.HF_TOKEN),
    defaultVllmImage: CONFIG.image,
    defaultVllmImagePinned: isPinnedImageReference(CONFIG.image),
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
  res.json(await buildManagerHealth("vllm"));
});

app.get("/api/status", async (_req, res) => {
  const [docker, gpu, container, image] = await Promise.all([
    getDockerVersion(),
    getGpuStatus(),
    getContainerStatus(CONFIG.containerName),
    getImageStatus(CONFIG.image),
  ]);
  const runtime = await getRunningModelSummary(container, gpu);
  const resources = await getManagerResourceSummary(gpu, container);

  res.json({
    docker,
    gpu,
    resources,
    container,
    servedModels: runtime.servedModels,
    runningModels: runtime.models,
    endpoint: runtime.endpoint,
    apiKeyRequired: runtime.apiKeyRequired,
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
    res.json(buildVllmMemoryEstimate(req.body || {}));
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

app.post("/api/claude/setup", async (_req, res) => {
  try {
    res.json(await setupClaudeBridge());
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

app.get("/claude/v1/models", handleClaudeModels);
app.get("/claude/models", handleClaudeModels);
app.get("/v1/claude/models", handleClaudeModels);
app.post("/claude/v1/messages", handleClaudeMessages);
app.post("/claude/messages", handleClaudeMessages);
app.post("/v1/messages", handleClaudeMessages);
app.post("/claude/v1/messages/v1/messages", handleClaudeMessages);
app.post("/claude/v1/messages/count_tokens", handleClaudeCountTokens);
app.post("/claude/messages/count_tokens", handleClaudeCountTokens);
app.post("/v1/messages/count_tokens", handleClaudeCountTokens);
app.get("/serve/v1/models", handleOpenAiGatewayModels);
app.post("/serve/v1/chat/completions", handleOpenAiGatewayChatCompletions);
app.post("/serve/v1/completions", handleOpenAiGatewayCompletions);
app.get("/opencode/v1/models", handleOpenCodeModels);
app.post("/opencode/v1/chat/completions", handleOpenCodeChatCompletions);

app.get("/api/stats", async (_req, res) => {
  try {
    res.json(await collectStats());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/external-access", async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(20, Number(req.query.limit || 160)));
    const maxLines = Math.min(50000, Math.max(limit, Number(req.query.maxLines || 12000)));
    res.json(await collectExternalAccessStats({ limit, maxLines }));
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

app.post("/api/models/delete-local", async (req, res) => {
  try {
    const name = cleanRequired(req.body.name, "name");
    const target = resolveModelsRootChild(path.join(CONFIG.modelsRoot, safeOutputName(name)));
    if (target === path.resolve(CONFIG.modelsRoot)) {
      return res.status(400).json({ error: "无法删除模型根目录。" });
    }
    if (!fs.existsSync(target)) {
      return res.status(404).json({ error: "本地模型目录不存在，可能已被删除。" });
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
      return res.status(409).json({ error: "该目录正在被下载任务使用，请先暂停或取消对应下载。" });
    }
    await fsp.rm(target, { recursive: true, force: true });
    res.json({ ok: true, name, path: target });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/remote-models", async (req, res) => {
  try {
    const source = cleanDownloadSource(req.query.source || "huggingface");
    const legacy = legacyRemoteCategoryParams(String(req.query.category || ""));
    const sort = normalizeRemoteSort(req.query.sort || legacy.sort);
    const task = normalizeRemoteTask(req.query.task || legacy.task);
    const feature = normalizeRemoteFeature(req.query.feature || legacy.feature);
    const search = String(req.query.search || "").trim();
    const limit = normalizeRemoteLimit(req.query.limit);
    const size = String(req.query.size || "").trim();
    const freshness = String(req.query.freshness || "auto").trim();
    const quant = normalizeRemoteQuantFilter(req.query.quant || legacy.quant);
    const models = source === "modelscope"
      ? await searchModelScopeModels({ sort, task, feature, search, limit, size, quant })
      : await searchHuggingFaceModels({ sort, task, feature, search, limit, size, freshness, quant });
    res.json({ source, sort, task, feature, search, limit, size, freshness, quant, models });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/jobs", (_req, res) => {
  healDownloadQueue();
  res.json(Array.from(jobs.values()).reverse());
});

app.get("/api/jobs/:id", (req, res) => {
  healDownloadQueue();
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.post("/api/jobs/:id/cancel", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.type === "download") {
    try {
      await cancelDownloadJob(job);
      res.json({ ok: true, id: job.id, status: job.status });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
    return;
  }
  if (job.status !== "running" && job.status !== "queued") return res.status(400).json({ error: "任务已结束，无法取消。" });
  try {
    if (typeof job.cancel === "function") {
      job.cancel();
    } else if (job.type === "serve") {
      job.meta = { ...job.meta, cancelRequested: true };
      await removeManagedContainer("cancel").catch(() => {});
      failJob(job, new Error("启动已被用户取消，容器已移除"));
    } else {
      return res.status(400).json({ error: "该任务类型不支持取消。" });
    }
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
  if (source === "modelscope") {
    appendLog(job, "ModelScope source uses the local modelscope CLI when available.");
  }
  if (download.includePatterns?.length) {
    appendLog(job, `Download include filter: ${download.includePatterns.join(", ")}`);
  }
  res.json({ job });
});

app.get("/api/download/estimate", async (req, res) => {
  try {
    const source = cleanDownloadSource(req.query.source || "huggingface");
    const reference = normalizeDownloadModelReference(req.query.model, req.query.precision);
    if (!reference.model) return res.status(400).json({ error: "model is required" });
    const diskFreeBytes = await getModelsDiskFreeBytes();
    if (source !== "huggingface") {
      // ModelScope 没有公开的体积估算 API
      return res.json({ source, model: reference.model, bytes: null, fileCount: null, supported: false, diskFreeBytes });
    }
    const estimate = await getHuggingFaceDownloadEstimate(reference.model, reference.precision);
    res.json({
      source,
      model: reference.model,
      precision: reference.precision || "",
      bytes: estimate.bytes,
      fileCount: estimate.fileCount,
      supported: true,
      diskFreeBytes,
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/model/config", async (req, res) => {
  try {
    const source = cleanDownloadSource(req.query.source || "huggingface");
    const model = String(req.query.model || "").trim();
    if (!model) return res.status(400).json({ error: "model is required" });
    res.json(await getModelConfig(model, source));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/model/readme", async (req, res) => {
  try {
    const model = String(req.query.model || "").trim();
    if (!model || !/^[^/\s]+\/[^/\s]+$/.test(model)) {
      return res.status(400).json({ error: "需要 owner/model 形式的 Hugging Face 仓库 ID。" });
    }
    res.json(await getModelReadme(model));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/port-check", async (req, res) => {
  try {
    const port = Number(req.query.port || 0);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "端口必须是 1-65535 的整数。" });
    }
    res.json(await checkPortAvailability(port));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/recent-launches", (_req, res) => {
  res.json({ launches: recentLaunches });
});

app.get("/api/download/settings", (_req, res) => {
  res.json({ queueMode: downloadQueueMode });
});

app.post("/api/download/settings", async (req, res) => {
  try {
    downloadQueueMode = Boolean(req.body.queueMode);
    await atomicWriteJsonFile(CONFIG.downloadSettings, { queueMode: downloadQueueMode });
    // 关掉队列模式时立即放行所有排队任务（不再排队就让它们都跑）
    if (!downloadQueueMode) {
      for (const job of Array.from(jobs.values())) {
        if (job.type !== "download" || job.status !== "queued" || !downloadSpecs.has(job.id)) continue;
        const spec = downloadSpecs.get(job.id);
        downloadSpecs.delete(job.id);
        appendLog(job, "下载队列已关闭，立即开始本任务。");
        spawnJobProcess(job, spec.command, spec.args, spec.options);
      }
    }
    res.json({ queueMode: downloadQueueMode });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
  const gpuMemoryUtilization = Number(req.body.gpuMemoryUtilization || 0.9);
  const cpuOffloadGb = nonNegativeNumber(req.body.cpuOffloadGb, 0);
  const kvOffloadingSize = nonNegativeNumber(req.body.kvOffloadingSize, 0);
  const mmProcessorCacheGb = optionalNonNegativeNumber(req.body.mmProcessorCacheGb);
  const dtype = normalizeDtype(req.body.dtype);
  const quantization = normalizeQuantization(req.body.quantization);
  const loadFormat = normalizeLoadFormat(req.body.loadFormat);
  const tokenizer = cleanOptionalLaunchArg(req.body.tokenizer);
  const hfConfigPath = cleanOptionalLaunchArg(req.body.hfConfigPath);
  const kvCacheDtype = normalizeKvCacheDtype(req.body.kvCacheDtype);
  const trustRemoteCode = Boolean(req.body.trustRemoteCode);
  const gpuSelection = await normalizeLaunchGpuSelection(normalizeGpuIds(req.body.gpuDeviceIds));
  const gpuDeviceIds = gpuSelection.gpuDeviceIds;
  const requestedMultiGpuMode = String(req.body.multiGpuMode || "single");
  const multiGpuMode = gpuSelection.selectedCount < 2 ? "single" : requestedMultiGpuMode;
  const visibleGpuCount = Math.max(1, gpuSelection.selectedCount || gpuDeviceIds.length || Number(req.body.gpuCount || 1));
  const tensorParallelSize = multiGpuMode === "tensor" ? positiveInt(req.body.tensorParallelSize, visibleGpuCount) : 1;
  const pipelineParallelSize = multiGpuMode === "pipeline" ? positiveInt(req.body.pipelineParallelSize, visibleGpuCount) : 1;
  const dataParallelSize = multiGpuMode === "data" ? positiveInt(req.body.dataParallelSize, visibleGpuCount) : 1;
  const distributedExecutorBackend = String(req.body.distributedExecutorBackend || "auto");
  const enableExpertParallel = Boolean(req.body.enableExpertParallel);
  const enablePrefixCaching = Boolean(req.body.enablePrefixCaching);
  const languageModelOnly = Boolean(req.body.languageModelOnly);
  const clientPreset = normalizeClientPreset(req.body.clientPreset);
  const reasoningParser = normalizeReasoningParser(req.body.reasoningParser);
  const requestedToolCallParser = normalizeToolCallParser(req.body.toolCallParser);
  const toolCallParser = requestedToolCallParser === "auto"
    ? inferToolCallParser(model, clientPreset)
    : requestedToolCallParser;
  const enableAutoToolChoice = Boolean(req.body.enableAutoToolChoice) && Boolean(toolCallParser);
  const networkAccess = normalizeNetworkAccess(req.body.networkAccess);
  const vllmApiKey = String(req.body.apiKey || "").trim();
  const lanAddress = getLanAddress();
  const serviceHost = networkAccess === "lan" ? lanAddress : "127.0.0.1";
  const serviceUrl = `http://${serviceHost}:${port}/v1`;

  const job = createJob("serve", `Start ${name}`, {
    model,
    name,
    port,
    maxModelLen,
    maxNumSeqs,
    gpuMemoryUtilization,
    cpuOffloadGb,
    kvOffloadingSize,
    mmProcessorCacheGb,
    dtype,
    quantization,
    loadFormat,
    tokenizer,
    hfConfigPath,
    kvCacheDtype,
    trustRemoteCode,
    gpuDeviceIds,
    multiGpuMode,
    tensorParallelSize,
    pipelineParallelSize,
    dataParallelSize,
    gpuWarnings: gpuSelection.warnings,
    distributedExecutorBackend,
    enableExpertParallel,
    enablePrefixCaching,
    languageModelOnly,
    clientPreset,
    reasoningParser,
    enableAutoToolChoice,
    toolCallParser,
    networkAccess,
    hasApiKey: Boolean(vllmApiKey),
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
    cpuOffloadGb,
    kvOffloadingSize,
    mmProcessorCacheGb,
    dtype,
    quantization,
    loadFormat,
    tokenizer,
    hfConfigPath,
    kvCacheDtype,
    trustRemoteCode,
    gpuDeviceIds,
    multiGpuMode,
    tensorParallelSize,
    pipelineParallelSize,
    dataParallelSize,
    gpuWarnings: gpuSelection.warnings,
    distributedExecutorBackend,
    enableExpertParallel,
    enablePrefixCaching,
    languageModelOnly,
    clientPreset,
    reasoningParser,
    enableAutoToolChoice,
    toolCallParser,
    networkAccess,
    vllmApiKey,
    serviceHost,
    serviceUrl,
  }).catch((error) => failJob(job, error));

  res.json({ job });
});

app.post("/api/docker/start", async (req, res) => {
  try {
    const current = await checkDockerDaemon();
    if (current.ok) {
      res.json({ ok: true, alreadyRunning: true, ready: true, serverVersion: current.version, message: "Docker daemon 已经可用。" });
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
    const readiness = await ensureDockerDaemonRunning(120000);
    res.json({
      ok: readiness.ok,
      alreadyRunning: Boolean(readiness.alreadyRunning),
      exe: CONFIG.dockerDesktopExe,
      ready: readiness.ok,
      serverVersion: readiness.version || null,
      error: readiness.ok ? null : readiness.error,
      message: readiness.ok
        ? readiness.alreadyRunning ? "Docker daemon 已经可用。" : "已启动 Docker Desktop，Docker 引擎已经可用。"
        : readiness.error,
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
      manager: "vllm-manager",
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
      manager: "vllm-manager",
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
      note: "vLLM does not hot-unload a model from the current server process; this stops only the vLLM container managed by this tool.",
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
      manager: "vllm-manager",
      requestedBy: "local-admin",
      note: String(req.body?.note || ""),
    });
    res.json(audit);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/logs", async (req, res) => {
  const tail = String(Math.min(2000, Math.max(1, Number(req.query.tail || 200) || 200)));
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
  const prompt = String(req.body.prompt || "Reply with exactly: vLLM OK");
  try {
    const apiKey = getVllmApiKey(await getContainerStatus(CONFIG.containerName));
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: vllmAuthHeaders(apiKey, { "content-type": "application/json" }),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 256,
      }),
      signal: AbortSignal.timeout(120000),
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
    const job = createJob("benchmark", "Benchmark local model", normalizeBenchmarkRequest(req.body || {}));
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

async function startManager() {
  await ensureDirs(CONFIG.modelsRoot, CONFIG.hfCache, path.dirname(CONFIG.jobsLedger));
  await preparePidFile("vLLM Manager");
  await loadJobsLedgerIntoMemory();
  await loadRecentLaunches().catch((error) => console.warn(`Unable to load recent launches: ${error.message}`));
  const downloadSettings = await readJsonFile(CONFIG.downloadSettings, { queueMode: false });
  downloadQueueMode = Boolean(downloadSettings?.queueMode);
  await writePidFile();
  startAutomationMonitor();
  httpServer = app.listen(PORT, HOST, () => {
    console.log(`vLLM Manager listening on http://${HOST}:${PORT}`);
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
  console.log(`vLLM Manager shutting down (${signal})`);
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

const ALLOW_REMOTE_MANAGEMENT = process.env.VLLM_MANAGER_ALLOW_REMOTE === "1";
let allowedHostnamesCache = { value: null, expiresAt: 0 };

function allowedRequestHostnames() {
  if (allowedHostnamesCache.value && allowedHostnamesCache.expiresAt > Date.now()) {
    return allowedHostnamesCache.value;
  }
  const names = new Set(["127.0.0.1", "localhost", "::1", String(HOST).toLowerCase()]);
  try {
    names.add(String(getLanAddress()).toLowerCase());
  } catch {
    // network interface enumeration failed; loopback names still apply
  }
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
  // Host allowlist blocks DNS-rebinding: a rebound hostname still carries the attacker domain in Host.
  const hostname = extractHostname(req.headers.host);
  if (!hostname || !allowedRequestHostnames().has(hostname)) {
    return res.status(403).json({ error: `请求的 Host 不在白名单内：${hostname || "(空)"}` });
  }
  const localRequest = isLocalRequest(req);
  if (!localRequest && getServiceGatewayKind(req)) {
    return next();
  }
  if (!localRequest && !ALLOW_REMOTE_MANAGEMENT) {
    return res.status(403).json({
      error: "管理后台默认仅允许本机访问；局域网设备只能访问带 API Key 的模型网关接口。",
    });
  }
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!mutating) return next();
  // Browsers attach Origin to cross-origin POSTs; reject anything not served by this console.
  const origin = String(req.headers.origin || "").trim();
  if (origin) {
    const originHost = extractHostname(origin);
    if (origin === "null" || !originHost || !allowedRequestHostnames().has(originHost)) {
      return res.status(403).json({ error: "跨站请求被拒绝（Origin 校验失败）。" });
    }
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
  return [
    {
      id: "blackwell-96gb-256k",
      name: "96GB 单卡 256K",
      description: "RTX PRO 6000 / 80GB+ 单卡优先方案：单路长上下文，保守显存占用，适合本地 Claude。",
      source: "builtin",
      config: normalizeLaunchConfig({
        maxModelLen: 262144,
        maxNumSeqs: 1,
        gpuMemoryUtilization: 0.9,
        kvCacheDtype: "fp8",
        gpuDeviceIds: ["0"],
        multiGpuMode: "single",
        clientPreset: "claude-cowork",
        reasoningParser: "qwen3",
        toolCallParser: "qwen3_coder",
        enableAutoToolChoice: true,
        enablePrefixCaching: true,
        languageModelOnly: true,
      }),
    },
    {
      id: "claude-long-context-64k",
      name: "Claude 长上下文 64K",
      description: "本地 Claude 单人使用，启动更稳，适合日常编码和工具调用。",
      source: "builtin",
      config: normalizeLaunchConfig({
        maxModelLen: 65536,
        maxNumSeqs: 2,
        gpuMemoryUtilization: 0.9,
        kvCacheDtype: "fp8",
        clientPreset: "claude-cowork",
        reasoningParser: "qwen3",
        toolCallParser: "qwen3_coder",
        enableAutoToolChoice: true,
        enablePrefixCaching: true,
      }),
    },
    {
      id: "claude-maximum-context",
      name: "Claude 极限上下文",
      description: "冲 128K/192K/256K 时使用，牺牲并发换上下文。",
      source: "builtin",
      config: normalizeLaunchConfig({
        maxModelLen: 262144,
        maxNumSeqs: 1,
        gpuMemoryUtilization: 0.94,
        kvCacheDtype: "fp8",
        clientPreset: "claude-cowork",
        reasoningParser: "qwen3",
        toolCallParser: "qwen3_coder",
        enableAutoToolChoice: true,
        enablePrefixCaching: true,
        languageModelOnly: true,
      }),
    },
    {
      id: "openwebui-chat",
      name: "OpenWebUI 日常聊天",
      description: "偏稳定和吞吐，适合 OpenWebUI 直接聊天。",
      source: "builtin",
      config: normalizeLaunchConfig({
        maxModelLen: 32768,
        maxNumSeqs: 4,
        gpuMemoryUtilization: 0.9,
        clientPreset: "openwebui",
        reasoningParser: "qwen3",
        enablePrefixCaching: true,
      }),
    },
    {
      id: "low-vram-safe",
      name: "低显存保守模式",
      description: "启动失败或显存吃紧时先用这个排查。",
      source: "builtin",
      config: normalizeLaunchConfig({
        maxModelLen: 16384,
        maxNumSeqs: 1,
        gpuMemoryUtilization: 0.82,
        kvCacheDtype: "fp8",
        clientPreset: "generic",
        languageModelOnly: true,
      }),
    },
  ];
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

  let remote = null;
  if (!local && /^[\w.-]+\/[\w.-]+/.test(model) && input.remote !== false) {
    remote = await getHuggingFaceModelInfo(model).catch((error) => ({ error: error.message }));
    if (remote?.error) findings.push(finding("warn", "远程元数据未取到", remote.error));
    else {
      findings.push(finding("ok", "Hugging Face 元数据可用", `${remote.label || model} · ${remote.lastModified || ""}`));
      if (remote.gated) findings.push(finding("warn", "gated 模型", "下载和启动前需要配置 HF_TOKEN。"));
      if (remote.hasGguf) recommendations.loadFormat = "gguf";
      if (remote.selection?.precision) recommendations.precision = remote.selection.precision;
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
  const tail = String(Math.min(2000, Math.max(40, Number(options.tail || 420))));
  const out = await docker(["logs", "--tail", tail, CONFIG.containerName], { rejectOnError: false, maxBuffer: 8 * 1024 * 1024 });
  const text = `${out.stdout}${out.stderr}`;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const issues = extractLogIssues(text).map((message) => ({
    severity: /out of memory|traceback|fatal|runtimeerror|failed|exception/i.test(message) ? "error" : "warn",
    message,
    hint: logIssueHint(message),
  }));
  const stage = detectLogStage(text);
  return {
    ok: !issues.some((item) => item.severity === "error"),
    generatedAt: new Date().toISOString(),
    stage,
    lineCount: lines.length,
    issues,
    recent: lines.slice(-12),
    suggestions: buildLogSuggestions(issues, stage),
  };
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
    exposeOpenCode: value.exposeOpenCode !== undefined ? Boolean(value.exposeOpenCode) : previous.exposeOpenCode !== false,
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
        claudeLocalMessagesUrl: endpoint.compat?.claude?.messagesUrl || `http://127.0.0.1:${PORT}/claude/v1/messages`,
        claudePublicBaseUrl: endpoint.compat?.claude?.publicBaseUrl || null,
        openCodeBaseUrl: `http://127.0.0.1:${PORT}/opencode/v1`,
        modelIds: (runtime.servedModels || []).map((model) => model.id).filter(Boolean),
        maxModelLen: runtime.servedModels?.[0]?.max_model_len || runtime.models?.[0]?.maxModelLen || null,
        apiKeyRequired: Boolean(runtime.apiKeyRequired),
        clients: {
          total: clientsLedger.clients?.length || 0,
          active: (clientsLedger.clients || []).filter((client) => client.enabled !== false).length,
        },
      },
      docker,
    },
    checks: buildServiceExposureChecks(settings, { docker, container, endpoint, runtime, clientsLedger }),
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
  const apiKeyActive = Boolean(context.runtime?.apiKeyRequired);
  const gatewayApiKeyActive = Boolean(settings.requireApiKey && (hasGlobalServiceApiKey(settings) || hasActiveServiceClients(context.clientsLedger || {})));
  checks.push(serviceCheck(serviceRunning ? "ok" : "warn", "模型服务状态", serviceRunning ? "模型服务正在运行。" : "当前没有运行中的模型服务，保存设置后仍需要启动模型。"));
  checks.push(serviceCheck(context.docker?.ok ? "ok" : "fail", "Docker", context.docker?.ok ? "Docker daemon 可用。" : "Docker 不可用，无法对外提供服务。"));
  if (mode === "local") {
    checks.push(serviceCheck(!lanBound ? "ok" : "warn", "网络绑定", lanBound ? `当前 Docker 容器已经发布到 ${context.endpoint?.lanHost || getLanAddress()}，局域网可访问。` : "当前只绑定本机，适合个人客户端。"));
  } else {
    checks.push(serviceCheck(lanBound ? "ok" : "warn", "局域网访问", lanBound ? `Docker 已把容器端口转发到本机地址 ${context.endpoint?.lanHost || getLanAddress()}。` : "需要在启动表单里把服务访问范围改为“局域网设备可访问”并重启模型。"));
    checks.push(serviceCheck(gatewayApiKeyActive || apiKeyActive ? "ok" : "fail", "API Key", gatewayApiKeyActive ? "管理器网关会强制 Bearer Token；对外推荐使用 /serve/v1、/claude 或 /opencode。" : apiKeyActive ? "运行中的 vLLM 容器已启用 Bearer Token。" : "计划对外提供服务，但尚未配置可执行的 API Key。"));
    if (lanBound && !apiKeyActive) {
      checks.push(serviceCheck("warn", "直连容器端口", "容器 LAN 端口不经过管理器网关；对外用户应连接管理器 /serve/v1，或重启 vLLM 时启用容器 API Key。"));
    }
  }
  if (settings.exposeClaude && settings.allowManagerRemote && !ALLOW_REMOTE_MANAGEMENT) {
    checks.push(serviceCheck("warn", "Claude 桥远程访问", "设置页计划开放管理器桥接，但当前进程未设置 VLLM_MANAGER_ALLOW_REMOTE=1。"));
  }
  if (mode === "reverse-proxy") {
    checks.push(serviceCheck(settings.publicBaseUrl ? "ok" : "warn", "公网入口", settings.publicBaseUrl ? "已填写公网/反代地址。" : "反代模式需要填写 public base URL，建议由 Caddy/Nginx/Cloudflare Tunnel 处理 TLS 和鉴权。"));
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

function serviceClientAllowsModel(client, model, runtime = null) {
  if (!client) return true;
  const allowed = (client.allowedModels || []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  if (!allowed.length || allowed.includes("*")) return true;
  const value = String(model || "").toLowerCase();
  const roots = getServedModelRootMappings(runtime || {}).filter((entry) => entry.id === model).map((entry) => String(entry.root || "").toLowerCase());
  return allowed.some((item) => item === value || roots.includes(item));
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
    res.setHeader("x-local-llm-gateway", "vllm-manager");
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
  if (pathname.startsWith("/opencode/v1/")) return "opencode";
  if (pathname.startsWith("/claude/") || pathname.startsWith("/v1/messages") || pathname.startsWith("/v1/claude/")) return "claude";
  return "";
}

function isServiceKindEnabled(settings, kind) {
  if (!settings.enabled) return true;
  if (kind === "openai") return settings.exposeOpenAI !== false;
  if (kind === "claude") return settings.exposeClaude !== false;
  if (kind === "opencode") return settings.exposeOpenCode !== false;
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
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-api-key,api-key,anthropic-api-key,anthropic_api_key,anthropic-version,x-requested-with");
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
  if (auth && !/^Bearer\s+/i.test(auth)) return auth.trim();
  return String(
    req.headers["x-api-key"]
    || req.headers["anthropic-api-key"]
    || req.headers["anthropic_api_key"]
    || req.headers["api-key"]
    || "",
  ).trim();
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

function normalizeBenchmarkRequest(input = {}) {
  return {
    port: Number(input.port || CONFIG.defaultPort),
    model: String(input.model || "").trim(),
    requests: Math.min(5, Math.max(1, Number(input.requests || 3))),
    maxTokens: Math.min(1024, Math.max(16, Number(input.maxTokens || 160))),
    prompt: String(input.prompt || "用中文简要说明本地模型是否可以稳定完成工具调用、长上下文和代码任务。"),
  };
}

async function runBenchmarkJob(job, input) {
  const runtime = await getRunningModelSummary();
  const model = input.model || runtime.models?.[0]?.id;
  if (!runtime.container.running || !model) throw new Error("No running vLLM model is available for benchmark.");
  const port = Number(input.port || runtime.endpoint?.port || CONFIG.defaultPort);
  const samples = [];
  for (let index = 0; index < input.requests; index += 1) {
    setJobProgress(job, {
      percent: Math.round((index / input.requests) * 90),
      stage: `Benchmark ${index + 1}/${input.requests}`,
      detail: "Sending chat completion request to local vLLM.",
    });
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: vllmAuthHeaders(runtime.vllmApiKey, { "content-type": "application/json" }),
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
  const issues = [];
  const hasConfig = lowerNames.includes("config.json") || lowerNames.includes("params.json");
  const hasTokenizer = lowerNames.some((name) => name.includes("tokenizer"));
  const safetensors = files.filter((item) => item.name.toLowerCase().endsWith(".safetensors"));
  const gguf = files.filter((item) => item.name.toLowerCase().endsWith(".gguf"));
  if (!hasConfig && !gguf.length) issues.push(finding("warn", "缺少模型配置", "没有 config.json/params.json；如果不是 GGUF，vLLM 可能无法启动。"));
  if (!hasTokenizer && !gguf.length) issues.push(finding("warn", "缺少 tokenizer", "未发现 tokenizer 文件；远程 repo 启动可能会补取，本地离线启动可能失败。"));
  if (!safetensors.length && !gguf.length) issues.push(finding("warn", "未发现权重文件", "没有 .safetensors 或 .gguf 文件。"));
  const size = files.reduce((sum, item) => sum + item.size, 0);
  return {
    ok: !issues.some((item) => item.severity === "fail"),
    status: issues.length ? "warn" : "ok",
    path: resolved,
    fileCount: files.length,
    size,
    hasConfig,
    hasTokenizer,
    safetensors: safetensors.length,
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
    claude: endpoint.compat?.claude || {},
    openwebui: {
      baseUrl: openAiGatewayBase,
      model: model || "local-current",
      note: "OpenWebUI 的 OpenAI API Base URL 建议填管理器 /serve/v1；API Key 使用对外服务页保存的密钥。",
    },
    ccswitch: {
      providerBaseUrl: `${managerLocal}/claude`,
      modelAlias: endpoint.compat?.claude?.modelAlias || CLAUDE_MODEL_ALIASES[0],
      healthUrl: `${managerLocal}/api/tools/health`,
    },
  };
}

async function buildClaudeCompressionInsights() {
  const settings = await getClaudeCompressionSettings();
  const ledger = await loadStatsLedger();
  const claude = normalizeClientCounters(ledger.clients?.claude, "claude", "Claude compatible bridge");
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
      headers: vllmAuthHeaders(runtime.vllmApiKey),
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
      owned_by: "vllm-manager",
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
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 400, model: String(body.model || "") }).catch(() => {});
      return res.status(400).json(openAiGatewayError("model_not_available", "Configured model is not available on this local gateway."));
    }
    if (!serviceClientAllowsModel(req.serviceGateway?.client, model, runtime)) {
      await recordServiceClientGatewayUsage(req.serviceGateway?.clientId, { ok: false, status: 403, model }).catch(() => {});
      return res.status(403).json(openAiGatewayError("model_forbidden", "This service client is not allowed to use the requested model."));
    }
    body.model = model;
    const stream = body.stream === true;
    const upstreamControl = createServiceUpstreamControl(req, res);
    try {
      const upstream = await fetch(`http://127.0.0.1:${runtime.endpoint.port}/v1/${upstreamPath}`, {
        method: "POST",
        headers: vllmAuthHeaders(runtime.vllmApiKey, { "content-type": "application/json" }),
        body: JSON.stringify(body),
        signal: upstreamControl.signal,
      });
      if (stream) {
        return streamRawOpenAiGatewayResponse(upstream, res, upstreamControl, req, model);
      }
      const text = await upstream.text();
      upstreamControl.clear();
      const data = parseJsonSafe(text, null);
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
  if (exact) return exact;
  const rootMatch = getServedModelRootMappings(runtime).find((entry) => entry.root === value || entry.root.toLowerCase() === value.toLowerCase());
  return rootMatch?.id || "";
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
  if (streamError && !isExpectedStreamDisconnect(streamError, res) && !res.writableEnded) {
    res.write(`\ndata: ${JSON.stringify({ error: { message: `Upstream stream failed: ${streamError.message}`, type: "gateway_error" } })}\n\n`);
  }
  if (!res.writableEnded) res.end();
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
    const claudeResponse = openAiResponseToClaude(data, model);
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
  const messages = anthropicMessagesToOpenAi(body);
  const tools = anthropicToolsToOpenAi(body.tools);
  const payload = {
    model,
    messages,
    max_tokens: claudeRequestedMaxTokens(body),
  };
  const chatTemplateKwargs = body.chat_template_kwargs && typeof body.chat_template_kwargs === "object" && !Array.isArray(body.chat_template_kwargs)
    ? { ...body.chat_template_kwargs }
    : {};
  if (/qwen/i.test(String(model || "")) && chatTemplateKwargs.enable_thinking === undefined) {
    chatTemplateKwargs.enable_thinking = false;
  }
  if (Object.keys(chatTemplateKwargs).length) payload.chat_template_kwargs = chatTemplateKwargs;
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
  const maxTokens = claudeRequestedMaxTokens(body);
  const originalPromptTokens = estimateClaudeBodyTokens(body);
  const triggerTokens = Math.floor(contextLimit * config.triggerRatio);
  const shouldCompress = config.enabled
    && contextLimit > 0
    && Array.isArray(body.messages)
    && body.messages.length >= config.minMessages
    && originalPromptTokens + maxTokens >= triggerTokens;

  const base = {
    applied: false,
    enabled: config.enabled,
    mode: config.mode,
    contextLimit,
    triggerRatio: config.triggerRatio,
    triggerTokens,
    recentRatio: config.recentRatio,
    summaryRatio: config.summaryRatio,
    originalPromptTokens,
    compressedPromptTokens: originalPromptTokens,
    savedTokens: 0,
    recentMessageCount: 0,
    summarizedMessageCount: 0,
    body,
  };
  if (!shouldCompress) return base;

  const recentBudget = Math.max(512, Math.floor(contextLimit * config.recentRatio));
  const summaryBudget = Math.max(512, Math.floor(contextLimit * config.summaryRatio));
  const { recentMessages, summarizedMessages } = splitClaudeMessagesForCompression(body.messages, recentBudget);
  if (!summarizedMessages.length) return base;

  const summary = buildClaudeCompressionSummary(summarizedMessages, {
    summaryBudget,
    originalPromptTokens,
    contextLimit,
    recentBudget,
    settings: config,
  });
  const compressedBody = {
    ...body,
    system: appendClaudeCompressionSummary(body.system, summary.text),
    messages: recentMessages,
  };
  const compressedPromptTokens = estimateClaudeBodyTokens(compressedBody);
  return {
    ...base,
    applied: compressedPromptTokens < originalPromptTokens,
    compressedPromptTokens,
    savedTokens: Math.max(0, originalPromptTokens - compressedPromptTokens),
    summaryTokens: summary.tokens,
    recentMessageCount: recentMessages.length,
    summarizedMessageCount: summarizedMessages.length,
    protectedItems: summary.protectedItems,
    body: compressedPromptTokens < originalPromptTokens ? compressedBody : body,
  };
}

function claudeRequestedMaxTokens(body = {}) {
  return Math.max(1, Number(body.max_tokens || body.maxTokens || CONFIG.claudeDefaultMaxTokens));
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
  const systemText = anthropicContentToText(body?.system);
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
    const text = anthropicMessageToSummaryText(message).trim();
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

function splitClaudeMessagesForCompression(messages, recentBudget) {
  const tokenCounts = messages.map((message) => estimateTokenCount(anthropicMessageToSummaryText(message)));
  const selected = new Set();
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = Math.max(1, tokenCounts[index]);
    if (selected.size >= 4 && total + cost > recentBudget) break;
    selected.add(index);
    total += cost;
  }
  expandSelectedToolPairs(messages, selected);
  const recentMessages = messages.filter((_message, index) => selected.has(index));
  const summarizedMessages = messages.filter((_message, index) => !selected.has(index));
  return { recentMessages, summarizedMessages };
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

function buildClaudeCompressionSummary(messages, options) {
  const summaryBudget = Number(options.summaryBudget || 2048);
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

  messages.forEach((message, index) => collectCompressionFacts(message, index, buckets));
  const protectedItems = Object.values(buckets).reduce((sum, items) => sum + items.length, 0);
  const header = [
    "[自动压缩上下文摘要]",
    "说明：这是 vLLM Manager 在 Claude 兼容桥里自动生成的谨慎压缩摘要。系统消息、最近原文窗口和工具调用配对会被优先保护；如摘要和最近原文冲突，以最近原文为准。",
    `压缩范围：${messages.length} 条较旧消息；触发阈值 ${(options.settings.triggerRatio * 100).toFixed(0)}%；最近原文保留 ${(options.settings.recentRatio * 100).toFixed(0)}%；摘要预算 ${(options.settings.summaryRatio * 100).toFixed(0)}%。`,
    `压缩前估算：${options.originalPromptTokens} tokens；模型上下文上限：${options.contextLimit} tokens。`,
  ];

  const sections = [
    ["当前目标和用户要求", buckets.goals],
    ["硬性约束/不要丢", buckets.hardRules],
    ["错误、失败和风险", buckets.errors],
    ["关键路径、地址、端口、模型和配置", buckets.paths],
    ["命令、接口和操作记录", buckets.commands],
    ["工具调用和结果", buckets.tools],
    ["已完成操作", buckets.progress],
    ["未完成事项", buckets.openIssues],
  ];

  let importantText = [
    ...header,
    ...sections.flatMap(([title, items]) => renderSummarySection(title, items, 12)),
  ].join("\n");

  let snippets = buckets.snippets.slice(0, 24);
  let text = renderCompressionSummaryText(importantText, snippets);
  while (estimateTokenCount(text) > summaryBudget && snippets.length) {
    snippets.pop();
    text = renderCompressionSummaryText(importantText, snippets);
  }
  if (estimateTokenCount(text) > summaryBudget) {
    importantText = clipToEstimatedTokens(importantText, summaryBudget);
    text = renderCompressionSummaryText(importantText, []);
  }

  return {
    text,
    tokens: estimateTokenCount(text),
    protectedItems,
  };
}

function renderCompressionSummaryText(importantText, snippets) {
  const snippetSection = snippets.length
    ? `\n旧对话原文摘录：\n${snippets.map((item) => `- ${item}`).join("\n")}`
    : "\n旧对话原文摘录：已省略低优先级闲聊和重复内容。";
  return `${importantText}${snippetSection}\n[自动压缩上下文摘要结束]`;
}

function renderSummarySection(title, items, limit) {
  const unique = uniqueStrings(items).slice(0, limit);
  if (!unique.length) return [`${title}：`, "- 未发现明确条目。"];
  return [`${title}：`, ...unique.map((item) => `- ${item}`)];
}

function collectCompressionFacts(message, index, buckets) {
  const role = message?.role || "user";
  const blocks = normalizeAnthropicContentBlocks(message?.content);
  const text = anthropicMessageToSummaryText(message);
  const prefix = role === "user" ? "用户" : "助手";
  const clipped = clipText(text.replace(/\s+/g, " ").trim(), 360);
  if (clipped) buckets.snippets.push(`#${index + 1} ${prefix}: ${clipped}`);

  for (const line of importantLines(text)) {
    const item = clipText(`${prefix}: ${line}`, 360);
    if (isHardInstruction(line)) buckets.hardRules.push(item);
    if (isGoalLine(line) || role === "user") buckets.goals.push(item);
    if (isErrorLine(line)) buckets.errors.push(item);
    if (isPathConfigLine(line)) buckets.paths.push(item);
    if (isCommandLine(line)) buckets.commands.push(item);
    if (isProgressLine(line)) buckets.progress.push(item);
    if (isOpenIssueLine(line)) buckets.openIssues.push(item);
  }

  for (const block of blocks) {
    if (block.type === "tool_use") {
      buckets.tools.push(clipText(`tool_use ${block.name || "tool"} id=${block.id || "-"} input=${JSON.stringify(block.input || {})}`, 420));
    } else if (block.type === "tool_result") {
      const resultText = anthropicContentToText(block.content);
      const keyLines = importantLines(resultText).slice(0, 8);
      buckets.tools.push(clipText(`tool_result ${block.tool_use_id || block.toolUseId || "-"}${block.is_error ? " ERROR" : ""}: ${(keyLines.join(" | ") || resultText).replace(/\s+/g, " ")}`, 520));
      if (block.is_error || isErrorLine(resultText)) buckets.errors.push(clipText(`工具结果错误 ${block.tool_use_id || block.toolUseId || "-"}: ${(keyLines.join(" | ") || resultText).replace(/\s+/g, " ")}`, 520));
    }
  }
}

function importantLines(text) {
  return String(text || "")
    .split(/\r?\n|(?<=[。！？.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => isHardInstruction(line) || isGoalLine(line) || isErrorLine(line) || isPathConfigLine(line) || isCommandLine(line) || isProgressLine(line) || isOpenIssueLine(line))
    .slice(0, 80);
}

function isHardInstruction(line) {
  return /必须|绝对|不能|不要|别|先别|禁止|务必|一定|记住|不要丢|保留|隐私|审计|密码|规则|must|never|do not|don't|keep|preserve|required/i.test(line);
}

function isGoalLine(line) {
  return /我要|我想|需要|帮我|请|目标|任务|方案|实现|修复|加个|做个|can you|please|need|goal|task|implement|fix|add/i.test(line);
}

function isErrorLine(line) {
  return /错误|报错|失败|异常|崩溃|无法|不能|不正确|failed|error|exception|traceback|fatal|warning|warn|timeout|404|500|unauthorized|not available/i.test(line);
}

function isPathConfigLine(line) {
  return /[A-Za-z]:\\|\/[\w.-]+\/[\w.-]+|https?:\/\/|127\.0\.0\.1|localhost|:\d{2,5}\b|--[a-z0-9-]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|Qwen|DeepSeek|Claude|OpenWebUI|vLLM|Docker|GPU|NVFP4|FP8|GGUF/i.test(line);
}

function isCommandLine(line) {
  return /^\s*(docker|node|npm|python|pip|hf|curl|Invoke-|Get-|Set-|Start-|Stop-|sqlite|git)\b/i.test(line) || /`[^`]+`|<Bash|tool_use|tool_result/i.test(line);
}

function isProgressLine(line) {
  return /已完成|已经|新增|修改|验证|通过|重启|启动|关闭|下载|卸载|configured|started|stopped|added|updated|verified/i.test(line);
}

function isOpenIssueLine(line) {
  return /待办|下一步|还没|需要继续|未解决|问题|风险|todo|next|pending|remaining|blocked/i.test(line);
}

function uniqueStrings(items) {
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

function clipText(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 16)).trim()} ...[截断]`;
}

function clipToEstimatedTokens(text, maxTokens) {
  const value = String(text || "");
  if (estimateTokenCount(value) <= maxTokens) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (estimateTokenCount(value.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, Math.max(0, low - 24)).trim()}\n...[摘要因预算截断]`;
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
  if (type === "tool" && choice.name) {
    return { type: "function", function: { name: String(choice.name) } };
  }
  return "auto";
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
  let activeToolIndex = null;
  let toolUseCount = 0;
  let streamError = null;
  const toolStates = new Map();

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

  // Anthropic 流协议要求内容块严格顺序：上一个块 stop 之后才能 start 下一个。
  const closeTextBlock = () => {
    if (textBlockIndex === null) return;
    writeClaudeSse(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
    textBlockIndex = null;
  };
  const finalizeActiveTool = () => {
    if (activeToolIndex === null) return;
    const state = toolStates.get(activeToolIndex);
    if (state?.started && !state.done) {
      writeClaudeSse(res, "content_block_stop", { type: "content_block_stop", index: state.blockIndex });
      state.done = true;
    }
    activeToolIndex = null;
  };
  const ensureTextBlock = () => {
    finalizeActiveTool();
    if (textBlockIndex !== null) return textBlockIndex;
    textBlockIndex = nextContentIndex++;
    writeClaudeSse(res, "content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
    return textBlockIndex;
  };
  const emitToolArgs = (state) => {
    const pending = state.arguments.slice(state.sentChars);
    if (!pending) return;
    state.sentChars = state.arguments.length;
    writeClaudeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: state.blockIndex,
      delta: { type: "input_json_delta", partial_json: pending },
    });
  };
  const handleToolDelta = (delta) => {
    const index = Number.isInteger(delta.index) ? delta.index : toolStates.size;
    let state = toolStates.get(index);
    if (!state) {
      state = { index, id: "", name: "", arguments: "", blockIndex: null, started: false, done: false, sentChars: 0 };
      toolStates.set(index, state);
    }
    if (delta.id) state.id = String(delta.id);
    const fn = delta.function || {};
    if (fn.name) {
      const nextName = String(fn.name);
      state.name = state.name && nextName.startsWith(state.name) ? nextName : state.name + nextName;
    }
    if (delta.name && !state.name) state.name = String(delta.name);
    if (fn.arguments) state.arguments += String(fn.arguments);
    if (delta.arguments) state.arguments += String(delta.arguments);
    if (state.done) return;
    if (!state.started) {
      if (!state.name) return; // 等 name 到齐再开块；迟迟不到的在流结束后兜底输出
      closeTextBlock();
      if (activeToolIndex !== null && activeToolIndex !== index) finalizeActiveTool();
      state.blockIndex = nextContentIndex++;
      state.started = true;
      activeToolIndex = index;
      writeClaudeSse(res, "content_block_start", {
        type: "content_block_start",
        index: state.blockIndex,
        content_block: { type: "tool_use", id: state.id || `call_${index}`, name: state.name, input: {} },
      });
    }
    emitToolArgs(state);
  };

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
          for (const toolDelta of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) handleToolDelta(toolDelta);
          for (const toolDelta of Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : []) handleToolDelta(toolDelta);
          if (choice.finish_reason) stopReason = mapOpenAiStopReason(choice.finish_reason);
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    streamError = error;
  }

  if (res.destroyed) {
    streamError = streamError || new Error("Client disconnected mid-stream.");
  } else if (streamError) {
    if (usageContext.req) {
      usageContext.req.serviceGatewayAccessUsage = {
        resolvedModel: model,
        inputTokens,
        outputTokens,
        stopReason,
        toolUseCount,
        error: streamError.message,
      };
    }
    writeClaudeSse(res, "error", {
      type: "error",
      error: { type: "api_error", message: `Upstream stream failed: ${streamError.message}` },
    });
    res.end();
  } else {
    finalizeActiveTool();
    closeTextBlock();
    // name 始终没到齐的 tool call 兜底为一次性完整块
    for (const state of Array.from(toolStates.values()).sort((a, b) => a.index - b.index)) {
      if (state.started || !(state.name || state.arguments)) continue;
      const block = openAiToolCallToClaudeBlock({
        id: state.id,
        type: "function",
        function: { name: state.name, arguments: state.arguments },
      });
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
      state.done = true;
    }
    toolUseCount = Array.from(toolStates.values()).filter((state) => state.done || state.started).length;
    if (toolUseCount) stopReason = "tool_use";
    if (!nextContentIndex) {
      const index = nextContentIndex++;
      writeClaudeSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      writeClaudeSse(res, "content_block_stop", { type: "content_block_stop", index });
    }
    writeClaudeSse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
    writeClaudeSse(res, "message_stop", { type: "message_stop" });
    if (usageContext.req) {
      usageContext.req.serviceGatewayAccessUsage = {
        resolvedModel: model,
        inputTokens,
        outputTokens,
        stopReason,
        toolSchemaCount: Number(usageContext.toolSchemaCount || 0),
        toolUseCount,
      };
    }
    res.end();
  }

  await recordClaudeBridgeUsage({
    requestedModel: usageContext.requestedModel || "",
    model,
    ok: !streamError,
    error: streamError ? streamError.message : undefined,
    stream: true,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    latencyMs: Date.now() - Number(usageContext.startedAt || Date.now()),
    toolSchemaCount: Number(usageContext.toolSchemaCount || 0),
    toolUseCount,
    stopReason,
    compression: usageContext.compression,
    session: usageContext.session,
  }).catch(() => {});
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
    manager: context.manager || "vllm-manager",
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
import pathlib
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

// 旧版单一「分类」参数混合了排序与属性两种维度；新接口拆成正交的
// sort（排序）× task（任务类型）× feature（模型特征），并保留旧参数映射。
function legacyRemoteCategoryParams(category) {
  const value = String(category || "").toLowerCase();
  if (value === "latest") return { sort: "lastModified" };
  if (value === "distilled") return { feature: "distilled" };
  if (value === "uncensored") return { feature: "uncensored" };
  if (value === "quantized") return { quant: "quantized" };
  return {};
}

function normalizeRemoteSort(value) {
  const sort = String(value || "trending").trim().toLowerCase();
  if (["downloads", "likes"].includes(sort)) return sort;
  if (["lastmodified", "latest", "updated"].includes(sort)) return "lastModified";
  return "trending";
}

function normalizeRemoteTask(value) {
  const task = String(value || "all").trim().toLowerCase();
  return ["text", "vision"].includes(task) ? task : "all";
}

function normalizeRemoteFeature(value) {
  const feature = String(value || "all").trim().toLowerCase();
  return ["distilled", "uncensored", "moe", "reasoning"].includes(feature) ? feature : "all";
}

// distilled/uncensored 等特征在 HF 上没有标准 tag，仍需关键词召回 + badge 过滤兜底
const REMOTE_FEATURE_SEARCHES = {
  distilled: ["distill", "distilled", "R1-Distill"],
  uncensored: ["uncensored", "abliterated", "abliteration"],
  moe: ["MoE", "A3B", "A22B"],
  reasoning: ["reasoning", "thinking", "R1"],
};

async function searchHuggingFaceModels({ sort, task, feature, search, limit, size, freshness, quant }) {
  const quantFilter = normalizeRemoteQuantFilter(quant);
  const profile = {
    engine: "vllm",
    sort,
    task,
    feature,
    minLastModified: remoteFreshnessCutoff(freshness, sort),
  };
  const query = String(search || "").trim();
  const featureSearches = REMOTE_FEATURE_SEARCHES[feature] || [""];
  const baseSearches = query
    ? (feature === "all" ? [query] : unique([...featureSearches.map((term) => `${query} ${term}`), query]))
    : featureSearches;
  const searches = remoteSearchesWithQuant(baseSearches, quantFilter);
  const hfSort = sort === "trending" ? "trendingScore" : sort;
  // HF 原生 pipeline_tag 过滤比关键词召回准确得多
  const pipelineTags = task === "text" ? ["text-generation"] : task === "vision" ? ["image-text-to-text"] : [""];
  const seen = new Set();
  const candidates = [];
  const requestLimit = Math.min(100, Math.max(48, limit));

  for (const pipelineTag of pipelineTags) {
    for (const term of searches) {
      const params = new URLSearchParams({
        sort: hfSort,
        direction: "-1",
        limit: String(requestLimit),
        full: "true",
      });
      if (term) params.set("search", term);
      if (pipelineTag) params.set("pipeline_tag", pipelineTag);
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
  }

  return rankAndLimitRemoteModels(candidates, profile, limit);
}

async function searchModelScopeModels({ sort, task, feature, search, limit, size, quant }) {
  const quantFilter = normalizeRemoteQuantFilter(quant);
  const profile = { engine: "vllm", sort, task, feature, minLastModified: null };
  const query = String(search || "").trim();
  const featureSearches = REMOTE_FEATURE_SEARCHES[feature] || [""];
  const baseSearches = query
    ? (feature === "all" ? [query] : unique([...featureSearches.map((term) => `${query} ${term}`), query]))
    : (feature === "all" ? ["Qwen", "DeepSeek", "GLM", "InternLM", ""] : featureSearches);
  const sortBy = sort === "downloads" ? "DownloadsCount" : sort === "likes" ? "StarsCount" : sort === "lastModified" ? "GmtModified" : "Default";
  const seen = new Set();
  const candidates = [];
  const requestLimit = Math.min(100, Math.max(40, limit));

  for (const term of baseSearches) {
    const body = {
      PageSize: requestLimit,
      PageNumber: 1,
      SortBy: sortBy,
      Name: term || "",
      Criterion: [],
      SingleCriterion: [],
      Target: "",
    };
    let data;
    try {
      data = await fetchJsonPost("https://www.modelscope.cn/api/v1/dolphin/models", body, "PUT");
    } catch (error) {
      if (candidates.length) break; // 已有结果就用，避免一次失败整体报错
      throw new Error(`ModelScope 查询失败：${error.message}`);
    }
    const list = data?.Data?.Model?.Models || data?.Data?.Models || data?.Data?.model?.Models || [];
    for (const raw of Array.isArray(list) ? list : []) {
      const summary = simplifyModelScopeModel(raw);
      if (!summary?.id || seen.has(summary.id)) continue;
      seen.add(summary.id);
      if (!isRemoteModelCandidate(summary, profile, size, quantFilter)) continue;
      candidates.push(summary);
    }
  }

  return rankAndLimitRemoteModels(candidates, profile, limit);
}

function simplifyModelScopeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const namespace = raw.Path || raw.Namespace || raw.Organization || raw.OrganizationName || (raw.Owner && (raw.Owner.Name || raw.Owner)) || "";
  const name = raw.Name || raw.ModelName || "";
  const id = String(raw.Id && raw.Id.includes && raw.Id.includes("/") ? raw.Id : (namespace && name ? `${namespace}/${name}` : (name || raw.Id || ""))).trim();
  if (!id) return null;
  const tags = []
    .concat(Array.isArray(raw.Tasks) ? raw.Tasks.map((item) => item?.Name || item) : [])
    .concat(Array.isArray(raw.Tags) ? raw.Tags : [])
    .map(String)
    .filter(Boolean);
  const lower = `${id} ${tags.join(" ")}`.toLowerCase();
  const quantFormats = inferRemoteQuantFormats({ id, tags, siblings: [] });
  const lastModifiedMs = Number(raw.LastUpdatedTime || raw.GmtModified || raw.LastModifiedTime || 0);
  const lastModified = lastModifiedMs ? new Date(lastModifiedMs * (lastModifiedMs < 1e12 ? 1000 : 1)).toISOString() : "";
  const paramsB = inferRemoteParamsB(id);
  const badges = [];
  if (lower.includes("distill")) badges.push("distilled");
  if (isUncensoredText(lower)) badges.push("uncensored");
  if (/vl|vision|multimodal|image/.test(lower)) badges.push("multimodal");
  badges.push(...quantFormats.slice(0, 5));
  return {
    source: "modelscope",
    model: id,
    id,
    label: id,
    author: namespace || id.split("/")[0],
    url: `https://modelscope.cn/models/${id}`,
    tags,
    badges,
    downloads: Number(raw.Downloads || raw.DownloadsCount || 0),
    likes: Number(raw.Stars || raw.StarsCount || raw.Likes || 0),
    gated: false,
    pipelineTag: Array.isArray(raw.Tasks) && raw.Tasks[0] ? String(raw.Tasks[0].Name || raw.Tasks[0]) : "",
    libraryName: "",
    lastModified,
    createdAt: "",
    hasConfig: true,
    hasSafetensors: true,
    hasGguf: /gguf/.test(lower),
    hasQuantizedFiles: hasQuantizedRemoteFiles(quantFormats),
    quantFormats,
    paramsB,
    sizeClass: remoteSizeClass(paramsB),
    fileSizeBytes: null,
    largestFileBytes: null,
    fileCount: null,
    summary: raw.ChineseName || raw.Description || "",
    selection: inferModelSelection({ id, author: namespace || id.split("/")[0], tags, source: "modelscope", quantFormats }),
    outputName: safeOutputName(id.replace(/[\\/]/g, "-")),
  };
}

async function fetchJsonPost(url, body, method = "POST") {
  const response = await fetch(url, {
    method,
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "user-agent": "vllm-manager/0.1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Remote request failed (${response.status}): ${text.slice(0, 200) || response.statusText}`);
  }
  return response.json();
}

function remoteFreshnessCutoff(freshness, sort) {
  const value = String(freshness || "auto").toLowerCase();
  if (value === "all" || value === "any" || value === "none") return null;
  if (value === "2026") return "2026-01-01";
  if (value === "2025") return "2025-01-01";
  // trendingScore 天然偏向近期模型；按下载/点赞/更新排序时默认过滤掉老模型，避免 gpt2 这类常年霸榜
  if (value === "auto" && sort !== "trending") return "2025-01-01";
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "vllm-manager/0.1",
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
  if (isMultimodalModel(model, lower)) badges.push("multimodal");
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
  if (profile.task && profile.task !== "all" && !matchesRemoteTask(model, profile.task)) return false;
  if (profile.feature && profile.feature !== "all" && !matchesRemoteFeature(model, profile.feature)) return false;
  if (sizeFilter && !matchesRemoteSizeFilter(model, sizeFilter)) return false;
  if (quantFilter && !matchesRemoteQuantFilter(model, quantFilter)) return false;
  return true;
}

function matchesRemoteTask(model, task) {
  const isVision = (model.badges || []).includes("multimodal")
    || ["image-text-to-text", "visual-question-answering", "image-to-text", "any-to-any"].includes(String(model.pipelineTag || "").toLowerCase());
  return task === "vision" ? isVision : !isVision;
}

function matchesRemoteFeature(model, feature) {
  const text = `${model.id} ${(model.tags || []).join(" ")}`.toLowerCase();
  if (feature === "distilled") return (model.badges || []).includes("distilled") || /distill/.test(text);
  if (feature === "uncensored") return (model.badges || []).includes("uncensored") || isUncensoredText(text);
  if (feature === "moe") return /\bmoe\b|mixture-of-expert|\ba\d{1,3}b\b|-a\d{1,3}b/.test(text);
  if (feature === "reasoning") return /reasoning|thinking|\br1\b|qwq|deepseek-r1|-think/.test(text);
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
  // 按更新时间排序时保留原始顺序；其它排序做同系列去重，避免一个系列刷屏
  if (profile.sort === "lastModified") return sorted.slice(0, limit);
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
  const multimodal = model.badges?.includes("multimodal") ? 5 : 0;
  const quant = model.hasQuantizedFiles ? 4 : 0;
  // HF 已按所选维度排序返回，这里主要做同分稳定化；仅在 likes 排序时让点赞主导
  if (profile.sort === "lastModified") return (Number.isFinite(modified) ? modified / 86400000 : 0) + downloads / 100;
  if (profile.sort === "likes") return likes * 4 + downloads / 4 + recency;
  if (profile.sort === "downloads") return downloads + likes / 2 + recency / 2;
  return downloads + likes + recency + multimodal + quant;
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
    ["nvfp4", "NVFP4"],
    ["mxfp4", "MXFP4"],
    ["fp8", "FP8"],
    ["awq", "AWQ"],
    ["gptq", "GPTQ"],
    ["gguf", "GGUF"],
    ["exl2", "EXL2"],
    ["nf4", "NF4"],
    ["bnb-4bit", "BNB-4bit"],
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

function isMultimodalModel(model, lower) {
  const tag = String(model.pipeline_tag || "").toLowerCase();
  return ["image-text-to-text", "visual-question-answering", "image-to-text"].includes(tag)
    || /\b(vl|vision|multimodal|omni|image|video)\b/i.test(lower);
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
  const order = ["NVFP4", "MXFP4", "FP8", "Q4_K_M", "Q5_K_M", "Q8_0", "IQ4_XS", "Q4", "IQ4", "AWQ", "GPTQ", "NF4", "INT4", "BNB-4bit", "GGUF", "原始 BF16/FP16"];
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

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return number;
}

function optionalNonNegativeNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  return nonNegativeNumber(value, 0);
}

function normalizeNetworkAccess(value) {
  return String(value || "local").toLowerCase() === "lan" ? "lan" : "local";
}

function normalizeKvCacheDtype(value) {
  const dtype = String(value || "auto").toLowerCase();
  return new Set(["auto", "fp8", "fp8_e5m2", "fp8_e4m3"]).has(dtype) ? dtype : "auto";
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

async function getClaudeCompressionSettings() {
  if (claudeCompressionSettingsCache) return claudeCompressionSettingsCache;
  try {
    const text = await fsp.readFile(CONFIG.claudeCompressionSettings, "utf8");
    claudeCompressionSettingsCache = normalizeClaudeCompressionSettings(JSON.parse(text));
  } catch {
    claudeCompressionSettingsCache = normalizeClaudeCompressionSettings({});
  }
  return claudeCompressionSettingsCache;
}

async function saveClaudeCompressionSettings(value) {
  const settings = normalizeClaudeCompressionSettings(value);
  await ensureDirs(path.dirname(CONFIG.claudeCompressionSettings));
  await fsp.writeFile(CONFIG.claudeCompressionSettings, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  claudeCompressionSettingsCache = settings;
  return settings;
}

function normalizeClaudeCompressionSettings(value = {}) {
  const envEnabled = process.env.AI_CLAUDE_CONTEXT_COMPRESSION;
  const enabledDefault = envEnabled === undefined ? true : !["0", "false", "off", "no"].includes(String(envEnabled).toLowerCase());
  const item = value && typeof value === "object" ? value : {};
  return {
    enabled: item.enabled === undefined ? enabledDefault : Boolean(item.enabled),
    mode: new Set(["cautious", "balanced", "aggressive"]).has(String(item.mode || "").toLowerCase())
      ? String(item.mode).toLowerCase()
      : "cautious",
    triggerRatio: normalizeRatio(item.triggerRatio ?? item.triggerPercent ?? process.env.AI_CLAUDE_CONTEXT_TRIGGER_PERCENT ?? 90, 0.9, 0.5, 0.99),
    recentRatio: normalizeRatio(item.recentRatio ?? item.recentPercent ?? process.env.AI_CLAUDE_CONTEXT_RECENT_PERCENT ?? 20, 0.2, 0.05, 0.5),
    summaryRatio: normalizeRatio(item.summaryRatio ?? item.summaryPercent ?? process.env.AI_CLAUDE_CONTEXT_SUMMARY_PERCENT ?? 20, 0.2, 0.05, 0.5),
    minMessages: positiveInt(item.minMessages || 8, 8),
  };
}

function normalizeRatio(value, fallback, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number > 1) number /= 100;
  return Math.min(max, Math.max(min, number));
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

function portPublishArg(port, networkAccess, serviceHost) {
  const args = dockerPublishArgs(port, networkAccess, serviceHost);
  return args[args.length - 1] || `127.0.0.1:${port}:8000`;
}

function dockerPublishArgs(port, networkAccess, serviceHost) {
  if (networkAccess !== "lan") return [`127.0.0.1:${port}:8000`];
  const lanHost = normalizeLanBindHost(serviceHost);
  if (isWildcardHost(lanHost)) return [`0.0.0.0:${port}:8000`];
  return [`127.0.0.1:${port}:8000`, `${lanHost}:${port}:8000`];
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

async function ensureDockerDaemonRunning(timeoutMs = 120000) {
  const current = await checkDockerDaemon();
  if (current.ok) return { ...current, alreadyRunning: true };
  if (!CONFIG.dockerDesktopExe || !fs.existsSync(CONFIG.dockerDesktopExe)) {
    return {
      ok: false,
      alreadyRunning: false,
      error: "Docker Desktop 未启动，且没有找到 Docker Desktop.exe，请检查 Docker Desktop 安装路径。",
      raw: current.raw || current.error,
    };
  }
  const child = spawn(CONFIG.dockerDesktopExe, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const readiness = await waitForDockerDaemon(timeoutMs);
  if (readiness.ok) {
    return {
      ok: true,
      alreadyRunning: false,
      exe: CONFIG.dockerDesktopExe,
      version: readiness.version,
    };
  }
  const raw = readiness.error || current.raw || current.error;
  return {
    ok: false,
    alreadyRunning: false,
    exe: CONFIG.dockerDesktopExe,
    error: formatDockerDaemonError(raw),
    raw,
  };
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
      modelAlias: CLAUDE_SETUP_ALIASES[0]?.name || CLAUDE_MODEL_ALIASES[0] || "",
      publicBaseUrl: managerPublicBase === managerLocalBase ? null : `${managerPublicBase}/claude`,
    },
  };
}

async function setupClaudeBridge() {
  const runtime = await getRunningModelSummary();
  if (!runtime.container.running) {
    throw new Error("vLLM service is not running. Start a model before configuring Claude.");
  }
  const config = await buildClaudeBridgeConfig(runtime);
  const profile = await writeClaudeDesktopProfile(config);
  const ccSwitch = await configureCcSwitchProvider(config).catch((error) => ({
    ok: false,
    error: error.message,
    dbPath: path.join(CONFIG.ccSwitchDir, "cc-switch.db"),
  }));
  const ccSwitchHealth = await getCcSwitchHealth();
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

async function configureCcSwitchProvider(config) {
  const dbPath = path.join(CONFIG.ccSwitchDir, "cc-switch.db");
  if (!fs.existsSync(dbPath)) {
    return { ok: false, skipped: true, reason: "cc-switch.db not found", dbPath };
  }
  const payload = Buffer.from(JSON.stringify({
    dbPath,
    baseUrl: config.baseUrl,
    messagesUrl: config.messagesUrl,
    apiKey: config.apiKey,
    aliases: config.aliases,
  }), "utf8").toString("base64");
  const script = String.raw`
import base64, json, pathlib, shutil, sqlite3, sys, time

def safe_json(value, fallback):
    try:
        return json.loads(value) if value else fallback
    except Exception:
        return fallback

cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
db = pathlib.Path(cfg["dbPath"])
backup_dir = db.parent / "backups"
backup_dir.mkdir(parents=True, exist_ok=True)
backup = backup_dir / ("db_backup_claude_setup_" + time.strftime("%Y%m%d_%H%M%S") + ".db")
shutil.copy2(db, backup)

con = sqlite3.connect(str(db), timeout=10)
con.row_factory = sqlite3.Row
provider = con.execute(
    "select * from providers where app_type='claude-desktop' and is_current=1 and id!='claude-desktop-official' limit 1"
).fetchone()
if provider is None:
    provider = con.execute(
        "select * from providers where app_type='claude-desktop' and id!='claude-desktop-official' order by sort_index is null, sort_index limit 1"
    ).fetchone()

now_ms = int(time.time() * 1000)
if provider is None:
    provider_id = "local-vllm-claude"
    con.execute(
        "insert or ignore into providers (id, app_type, name, settings_config, category, created_at, is_current, meta, provider_type) values (?, 'claude-desktop', 'Local vLLM Claude', '{}', 'custom', ?, 0, '{}', 'anthropic')",
        (provider_id, now_ms),
    )
    provider = con.execute("select * from providers where id=? and app_type='claude-desktop'", (provider_id,)).fetchone()

provider_id = provider["id"]
settings = safe_json(provider["settings_config"], {})
env = settings.setdefault("env", {})
env["ANTHROPIC_BASE_URL"] = cfg["baseUrl"]
env["ANTHROPIC_AUTH_TOKEN"] = cfg["apiKey"]

meta = safe_json(provider["meta"], {})
meta["claudeDesktopMode"] = "direct"
meta["apiFormat"] = "anthropic"
meta["claudeDesktopModelRoutes"] = {
    item["name"]: {"model": item["name"], "labelOverride": item.get("labelOverride") or "local"}
    for item in cfg["aliases"]
}

con.execute("update providers set is_current=0 where app_type='claude-desktop'")
con.execute(
    "update providers set name=?, settings_config=?, meta=?, provider_type='anthropic', is_current=1 where id=? and app_type='claude-desktop'",
    ("Local vLLM Claude", json.dumps(settings, ensure_ascii=False), json.dumps(meta, ensure_ascii=False), provider_id),
)
con.execute("delete from provider_endpoints where provider_id=? and app_type='claude-desktop'", (provider_id,))
con.execute(
    "insert into provider_endpoints (provider_id, app_type, url, added_at) values (?, 'claude-desktop', ?, ?)",
    (provider_id, cfg["messagesUrl"], now_ms),
)
con.execute(
    "insert into provider_health (provider_id, app_type, is_healthy, consecutive_failures, last_success_at, last_failure_at, last_error, updated_at) values (?, 'claude-desktop', 1, 0, datetime('now'), null, null, datetime('now')) on conflict(provider_id, app_type) do update set is_healthy=1, consecutive_failures=0, last_success_at=datetime('now'), last_failure_at=null, last_error=null, updated_at=datetime('now')",
    (provider_id,),
)
con.commit()
con.close()
print(json.dumps({"ok": True, "providerId": provider_id, "dbPath": str(db), "backupPath": str(backup), "endpoint": cfg["messagesUrl"]}, ensure_ascii=False))
`;
  const { stdout } = await execFileAsync(CONFIG.pythonExe, ["-c", script, payload], { timeout: 15000, maxBuffer: 1024 * 1024 });
  return parseJsonSafe(stdout.trim(), { ok: false, stdout: stdout.trim(), dbPath });
}

async function getCcSwitchHealth() {
  const url = "http://127.0.0.1:15721/health";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const text = await response.text();
    return { ok: response.ok, status: response.status, url, body: parseJsonSafe(text, text) };
  } catch (error) {
    return { ok: false, url, error: error.message };
  }
}

function parseDockerPortPublish(ports) {
  const text = String(ports || "");
  const exact = collectDockerPortBindings(text, 8000);
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
      claudeBaseUrl: HOST === "127.0.0.1" ? null : `http://${lanAddress}:${PORT}/claude`,
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
    clients: groupAccessEvents(external, (entry) => entry.remoteAddress || "unknown", { limit: 40, label: "remoteAddress" }),
    paths: groupAccessEvents(normalized, (entry) => entry.path || "-", { limit: 30, label: "path" }),
    models: groupAccessEvents(normalized.filter((entry) => entry.model || entry.resolvedModel), (entry) => entry.model || entry.resolvedModel || "-", { limit: 30, label: "model" }),
    resolvedModels: groupAccessEvents(normalized.filter((entry) => entry.resolvedModel), (entry) => entry.resolvedModel || "-", { limit: 20, label: "resolvedModel" }),
    authSources: groupAccessEvents(normalized, (entry) => entry.authSource || "none", { limit: 20, label: "authSource" }),
    kinds: groupAccessEvents(normalized, (entry) => entry.kind || "-", { limit: 10, label: "kind" }),
    statuses: groupAccessEvents(normalized, (entry) => String(entry.status || 0), { limit: 20, label: "status" }),
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
  const persistedFacts = await getPersistedRuntimeFacts(factModelHints).catch(() => ({}));
  let facts = mergeRuntimeFacts(persistedFacts, await getLatestRuntimeFacts(factModelHints).catch(() => ({})));
  if (!facts.kvCacheTokens && !facts.maxConcurrency) {
    facts = mergeRuntimeFacts(facts, await getLatestRuntimeFacts(factModelHints, {
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

async function updateStatsLedger(summary, reason = "collect") {
  return withStatsLedgerWrite(async () => {
    const ledger = await loadStatsLedger();
    if (!summary?.processStartSeconds || !Array.isArray(summary.models) || !summary.models.length) {
      return ledger;
    }
    for (const model of summary.models) {
      const runtimeKey = `${summary.processStartSeconds}:${model.name}`;
      const previous = ledger.runtimes[runtimeKey] || emptyRuntimeCounters();
      const current = runtimeCountersFromModel(model);
      const delta = diffRuntimeCounters(current, previous);
      mergeModelDelta(ledger, model, delta, summary, reason);
      mergeRuntimeFactsLedger(ledger, model, summary, reason);
      ledger.runtimes[runtimeKey] = current;
    }
    ledger.updatedAt = new Date().toISOString();
    ledger.version = 1;
    await saveStatsLedger(ledger);
    return ledger;
  });
}

async function withStatsLedgerWrite(task) {
  const previous = statsLedgerWriteQueue;
  let release;
  statsLedgerWriteQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
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
  await writeJsonFile(CONFIG.statsLedger, ledger);
}

function normalizeStatsLedger(value) {
  return {
    version: 1,
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: value.updatedAt || null,
    models: value.models && typeof value.models === "object" ? value.models : {},
    runtimes: value.runtimes && typeof value.runtimes === "object" ? value.runtimes : {},
    runtimeFacts: value.runtimeFacts && typeof value.runtimeFacts === "object" ? value.runtimeFacts : {},
    clients: normalizeClientLedger(value.clients),
  };
}

function normalizeClientLedger(value) {
  const clients = value && typeof value === "object" ? value : {};
  return {
    claude: normalizeClientCounters(clients.claude, "claude", "Claude 兼容桥"),
  };
}

function normalizeClientCounters(value, id, label) {
  const item = value && typeof value === "object" ? value : {};
  const prompt = Number(item.tokens?.prompt || 0);
  const generation = Number(item.tokens?.generation || 0);
  return {
    id,
    label,
    tokens: {
      prompt,
      generation,
      cachedPrompt: Number(item.tokens?.cachedPrompt || 0),
      total: Number(item.tokens?.total || prompt + generation),
    },
    requests: {
      total: Number(item.requests?.total || 0),
      success: Number(item.requests?.success || 0),
      error: Number(item.requests?.error || 0),
      aborted: Number(item.requests?.aborted || 0),
      streamed: Number(item.requests?.streamed || 0),
    },
    tools: {
      schemas: Number(item.tools?.schemas || 0),
      toolUse: Number(item.tools?.toolUse || 0),
    },
    compression: {
      applied: Number(item.compression?.applied || 0),
      originalPromptTokens: Number(item.compression?.originalPromptTokens || 0),
      compressedPromptTokens: Number(item.compression?.compressedPromptTokens || 0),
      savedTokens: Number(item.compression?.savedTokens || 0),
      summarizedMessages: Number(item.compression?.summarizedMessages || 0),
      recentMessages: Number(item.compression?.recentMessages || 0),
      last: item.compression?.last || {},
    },
    latency: {
      totalMs: Number(item.latency?.totalMs || 0),
      avgMs: Number(item.latency?.avgMs || 0),
      maxMs: Number(item.latency?.maxMs || 0),
    },
    models: item.models && typeof item.models === "object" ? item.models : {},
    aliases: item.aliases && typeof item.aliases === "object" ? item.aliases : {},
    session: normalizeClaudeClientSession(item.session),
    sessions: normalizeClaudeClientSessions(item.sessions),
    last: item.last || {},
  };
}

function normalizeClaudeClientSession(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    currentId: String(item.currentId || ""),
    currentLabel: String(item.currentLabel || ""),
    currentSource: String(item.currentSource || ""),
    currentFingerprint: String(item.currentFingerprint || ""),
    startedAt: item.startedAt || null,
    lastSeenAt: item.lastSeenAt || null,
    switches: Number(item.switches || 0),
    resets: Number(item.resets || 0),
    lastResetAt: item.lastResetAt || null,
    lastResetReason: item.lastResetReason || null,
    contextClearedAt: item.contextClearedAt || null,
  };
}

function normalizeClaudeClientSessions(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};
  for (const [id, bucket] of Object.entries(source)) {
    const normalized = normalizeClaudeClientSessionBucket(bucket, id);
    if (normalized.id) result[normalized.id] = normalized;
  }
  return result;
}

function normalizeClaudeClientSessionBucket(value, fallbackId = "") {
  const item = value && typeof value === "object" ? value : {};
  const prompt = Number(item.tokens?.prompt || 0);
  const generation = Number(item.tokens?.generation || 0);
  return {
    id: String(item.id || fallbackId || ""),
    label: String(item.label || ""),
    source: String(item.source || ""),
    fingerprint: String(item.fingerprint || ""),
    startedAt: item.startedAt || null,
    lastSeenAt: item.lastSeenAt || null,
    tokens: {
      prompt,
      generation,
      cachedPrompt: Number(item.tokens?.cachedPrompt || 0),
      total: Number(item.tokens?.total || prompt + generation),
    },
    requests: {
      total: Number(item.requests?.total || 0),
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
      summarizedMessages: Number(item.compression?.summarizedMessages || 0),
      recentMessages: Number(item.compression?.recentMessages || 0),
      last: item.compression?.last || {},
    },
    latency: {
      totalMs: Number(item.latency?.totalMs || 0),
      avgMs: Number(item.latency?.avgMs || 0),
      maxMs: Number(item.latency?.maxMs || 0),
    },
    models: item.models && typeof item.models === "object" ? item.models : {},
    last: item.last || {},
  };
}

async function recordClaudeBridgeUsage(entry = {}) {
  return withStatsLedgerWrite(async () => {
    const ledger = await loadStatsLedger();
    const client = ledger.clients.claude || normalizeClientCounters(null, "claude", "Claude 兼容桥");
    const prompt = Number(entry.usage?.input_tokens || entry.usage?.prompt_tokens || 0);
    const generation = Number(entry.usage?.output_tokens || entry.usage?.completion_tokens || 0);
    const model = String(entry.model || "unknown");
    const requestedModel = String(entry.requestedModel || "");
    const latencyMs = Math.max(0, Number(entry.latencyMs || 0));
    const session = normalizeClaudeTaskSession(entry.session);

    client.requests.total += 1;
    if (entry.ok) client.requests.success += 1;
    else client.requests.error += 1;
    if (entry.stream) client.requests.streamed += 1;
    client.tokens.prompt += prompt;
    client.tokens.generation += generation;
    client.tokens.total = client.tokens.prompt + client.tokens.generation;
    client.tools.schemas += Number(entry.toolSchemaCount || 0);
    client.tools.toolUse += Number(entry.toolUseCount || 0);
    if (entry.compression?.applied) {
      client.compression.applied += 1;
      client.compression.originalPromptTokens += Number(entry.compression.originalPromptTokens || 0);
      client.compression.compressedPromptTokens += Number(entry.compression.compressedPromptTokens || 0);
      client.compression.savedTokens += Number(entry.compression.savedTokens || 0);
      client.compression.summarizedMessages += Number(entry.compression.summarizedMessageCount || 0);
      client.compression.recentMessages += Number(entry.compression.recentMessageCount || 0);
      client.compression.last = {
        at: new Date().toISOString(),
        originalPromptTokens: Number(entry.compression.originalPromptTokens || 0),
        compressedPromptTokens: Number(entry.compression.compressedPromptTokens || 0),
        savedTokens: Number(entry.compression.savedTokens || 0),
        summarizedMessageCount: Number(entry.compression.summarizedMessageCount || 0),
        recentMessageCount: Number(entry.compression.recentMessageCount || 0),
        triggerRatio: Number(entry.compression.triggerRatio || 0),
      };
    }
    client.latency.totalMs += latencyMs;
    client.latency.maxMs = Math.max(client.latency.maxMs || 0, latencyMs);
    client.latency.avgMs = client.requests.total ? client.latency.totalMs / client.requests.total : 0;

    client.models[model] = mergeClientCounterBucket(client.models[model], {
      prompt,
      generation,
      ok: Boolean(entry.ok),
      stream: Boolean(entry.stream),
      toolSchemaCount: Number(entry.toolSchemaCount || 0),
      toolUseCount: Number(entry.toolUseCount || 0),
      compression: entry.compression || {},
      latencyMs,
    });
    updateClaudeClientSession(client, session, {
      prompt,
      generation,
      ok: Boolean(entry.ok),
      stream: Boolean(entry.stream),
      toolSchemaCount: Number(entry.toolSchemaCount || 0),
      toolUseCount: Number(entry.toolUseCount || 0),
      compression: entry.compression || {},
      latencyMs,
      model,
      requestedModel,
      stopReason: entry.stopReason || null,
      error: entry.error ? String(entry.error).slice(0, 300) : null,
    });
    if (requestedModel) {
      client.aliases[requestedModel] = Number(client.aliases[requestedModel] || 0) + 1;
    }
    client.last = {
      at: new Date().toISOString(),
      model,
      requestedModel,
      ok: Boolean(entry.ok),
      stream: Boolean(entry.stream),
      promptTokens: prompt,
      outputTokens: generation,
      toolSchemaCount: Number(entry.toolSchemaCount || 0),
      toolUseCount: Number(entry.toolUseCount || 0),
      compressionApplied: Boolean(entry.compression?.applied),
      compressionSavedTokens: Number(entry.compression?.savedTokens || 0),
      stopReason: entry.stopReason || null,
      error: entry.error ? String(entry.error).slice(0, 300) : null,
      latencyMs,
      sessionId: session?.id || null,
      sessionSource: session?.source || null,
    };

    ledger.clients.claude = client;
    ledger.updatedAt = new Date().toISOString();
    await saveStatsLedger(ledger);
  });
}

function normalizeClaudeTaskSession(session) {
  if (!session || typeof session !== "object") return null;
  const id = String(session.id || "").trim();
  if (!id) return null;
  return {
    id: clipText(id, 120),
    label: clipText(String(session.label || "Claude task").replace(/\s+/g, " ").trim(), 120),
    source: clipText(String(session.source || "unknown").trim(), 40),
    fingerprint: clipText(String(session.fingerprint || "").trim(), 128),
    explicit: Boolean(session.explicit),
  };
}

function updateClaudeClientSession(client, session, delta) {
  if (!session?.id) return;
  const now = new Date().toISOString();
  client.session = normalizeClaudeClientSession(client.session);
  client.sessions = normalizeClaudeClientSessions(client.sessions);

  const previousId = client.session.currentId;
  const switched = Boolean(previousId && previousId !== session.id);
  const firstSeen = !previousId;
  if (firstSeen || switched) {
    if (switched) client.session.switches += 1;
    client.session.resets += 1;
    client.session.lastResetAt = now;
    client.session.lastResetReason = firstSeen ? "initial-task" : "new-task-detected";
    client.session.contextClearedAt = now;
    client.session.startedAt = now;
  }

  client.session.currentId = session.id;
  client.session.currentLabel = session.label;
  client.session.currentSource = session.source;
  client.session.currentFingerprint = session.fingerprint;
  client.session.lastSeenAt = now;

  const bucket = normalizeClaudeClientSessionBucket(client.sessions[session.id], session.id);
  bucket.id = session.id;
  bucket.label = session.label || bucket.label;
  bucket.source = session.source || bucket.source;
  bucket.fingerprint = session.fingerprint || bucket.fingerprint;
  bucket.startedAt = bucket.startedAt || now;
  bucket.lastSeenAt = now;

  mergeClientCounterBucket(bucket, delta);
  if (delta.compression?.applied) {
    bucket.compression.summarizedMessages += Number(delta.compression.summarizedMessageCount || 0);
    bucket.compression.recentMessages += Number(delta.compression.recentMessageCount || 0);
    bucket.compression.last = {
      at: now,
      savedTokens: Number(delta.compression.savedTokens || 0),
      summarizedMessageCount: Number(delta.compression.summarizedMessageCount || 0),
      recentMessageCount: Number(delta.compression.recentMessageCount || 0),
      triggerRatio: Number(delta.compression.triggerRatio || 0),
    };
  }
  if (delta.model) {
    bucket.models[delta.model] = mergeClientCounterBucket(bucket.models[delta.model], delta);
  }
  bucket.last = {
    at: now,
    model: delta.model,
    requestedModel: delta.requestedModel,
    ok: Boolean(delta.ok),
    stream: Boolean(delta.stream),
    promptTokens: Number(delta.prompt || 0),
    outputTokens: Number(delta.generation || 0),
    toolSchemaCount: Number(delta.toolSchemaCount || 0),
    toolUseCount: Number(delta.toolUseCount || 0),
    compressionApplied: Boolean(delta.compression?.applied),
    compressionSavedTokens: Number(delta.compression?.savedTokens || 0),
    stopReason: delta.stopReason || null,
    error: delta.error || null,
    latencyMs: Number(delta.latencyMs || 0),
  };
  client.sessions[session.id] = bucket;
  trimClaudeClientSessions(client.sessions, session.id);
}

function trimClaudeClientSessions(sessions, keepId, limit = 30) {
  const entries = Object.entries(sessions || {})
    .sort((a, b) => Date.parse(b[1]?.lastSeenAt || 0) - Date.parse(a[1]?.lastSeenAt || 0));
  for (const [id] of entries.slice(limit)) {
    if (id !== keepId) delete sessions[id];
  }
}

function mergeClientCounterBucket(bucket, delta) {
  const item = bucket && typeof bucket === "object" ? bucket : {
    tokens: { prompt: 0, generation: 0, total: 0 },
    requests: { total: 0, success: 0, error: 0, streamed: 0 },
    tools: { schemas: 0, toolUse: 0 },
    compression: { applied: 0, savedTokens: 0, last: {} },
    latency: { totalMs: 0, avgMs: 0, maxMs: 0 },
  };
  item.tokens = item.tokens && typeof item.tokens === "object" ? item.tokens : { prompt: 0, generation: 0, total: 0 };
  item.requests = item.requests && typeof item.requests === "object" ? item.requests : { total: 0, success: 0, error: 0, streamed: 0 };
  item.tools = item.tools && typeof item.tools === "object" ? item.tools : { schemas: 0, toolUse: 0 };
  item.compression = item.compression && typeof item.compression === "object" ? item.compression : { applied: 0, savedTokens: 0, last: {} };
  item.latency = item.latency && typeof item.latency === "object" ? item.latency : { totalMs: 0, avgMs: 0, maxMs: 0 };
  item.tokens.prompt = Number(item.tokens?.prompt || 0) + delta.prompt;
  item.tokens.generation = Number(item.tokens?.generation || 0) + delta.generation;
  item.tokens.total = item.tokens.prompt + item.tokens.generation;
  item.requests.total = Number(item.requests?.total || 0) + 1;
  item.requests.success = Number(item.requests?.success || 0) + (delta.ok ? 1 : 0);
  item.requests.error = Number(item.requests?.error || 0) + (delta.ok ? 0 : 1);
  item.requests.streamed = Number(item.requests?.streamed || 0) + (delta.stream ? 1 : 0);
  item.tools.schemas = Number(item.tools?.schemas || 0) + delta.toolSchemaCount;
  item.tools.toolUse = Number(item.tools?.toolUse || 0) + delta.toolUseCount;
  item.compression.applied = Number(item.compression?.applied || 0) + (delta.compression?.applied ? 1 : 0);
  item.compression.savedTokens = Number(item.compression?.savedTokens || 0) + Number(delta.compression?.savedTokens || 0);
  item.latency.totalMs = Number(item.latency?.totalMs || 0) + delta.latencyMs;
  item.latency.maxMs = Math.max(Number(item.latency?.maxMs || 0), delta.latencyMs);
  item.latency.avgMs = item.requests.total ? item.latency.totalMs / item.requests.total : 0;
  return item;
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

function mergeRuntimeFactsLedger(ledger, model, summary, reason) {
  const facts = normalizeRuntimeFacts({
    ...(summary.facts || {}),
    maxModelLen: model.maxModelLen || model.context?.maxModelLen || null,
    kvCacheTokens: summary.facts?.kvCacheTokens || model.context?.capacityTokens || null,
    maxConcurrency: summary.facts?.maxConcurrency || model.context?.concurrencyAtMaxLen || null,
  });
  if (!hasRuntimeFacts(facts)) return;
  ledger.runtimeFacts = ledger.runtimeFacts && typeof ledger.runtimeFacts === "object" ? ledger.runtimeFacts : {};
  const existing = ledger.runtimeFacts[model.name] || {};
  ledger.runtimeFacts[model.name] = {
    ...existing,
    name: model.name,
    root: model.root || existing.root || "",
    updatedAt: new Date().toISOString(),
    reason,
    processStartSeconds: summary.processStartSeconds || existing.processStartSeconds || null,
    facts: mergeRuntimeFacts(existing.facts || {}, facts),
  };
}

async function getPersistedRuntimeFacts(modelHints = []) {
  const ledger = await loadStatsLedger();
  const needles = normalizeRuntimeFactHints(modelHints);
  const candidates = [];
  for (const item of Object.values(ledger.runtimeFacts || {})) {
    if (!item || typeof item !== "object") continue;
    if (needles.length && !runtimeFactItemMatches(item, needles)) continue;
    candidates.push({
      name: item.name,
      root: item.root || "",
      updatedAt: item.updatedAt || "",
      processStartSeconds: item.processStartSeconds || null,
      facts: item.facts || {},
    });
  }
  for (const item of Object.values(ledger.models || {})) {
    const facts = item?.last?.facts;
    if (!facts || typeof facts !== "object") continue;
    if (needles.length && !runtimeFactItemMatches(item, needles)) continue;
    candidates.push({
      name: item.name,
      root: item.root || "",
      updatedAt: item.last?.updatedAt || "",
      processStartSeconds: item.last?.processStartSeconds || null,
      facts: {
        ...facts,
        maxModelLen: item.last?.maxModelLen || item.last?.context?.maxModelLen || null,
        kvCacheTokens: facts.kvCacheTokens || item.last?.context?.capacityTokens || null,
        maxConcurrency: facts.maxConcurrency || item.last?.context?.concurrencyAtMaxLen || null,
      },
    });
  }
  candidates.sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));
  return candidates.reduce((facts, item) => mergeRuntimeFacts(facts, item.facts || {}), {});
}

function normalizeRuntimeFacts(value = {}) {
  return {
    kvCacheTokens: positiveFactNumber(value.kvCacheTokens),
    maxContextTokens: positiveFactNumber(value.maxContextTokens || value.maxModelLen),
    maxModelLen: positiveFactNumber(value.maxModelLen || value.maxContextTokens),
    maxConcurrency: positiveFactNumber(value.maxConcurrency),
    modelLoadMemoryGiB: positiveFactNumber(value.modelLoadMemoryGiB),
    modelLoadSeconds: positiveFactNumber(value.modelLoadSeconds),
    torchCompileSeconds: positiveFactNumber(value.torchCompileSeconds),
    warmupSeconds: positiveFactNumber(value.warmupSeconds),
    graphCaptureGiB: positiveFactNumber(value.graphCaptureGiB),
    engineInitSeconds: positiveFactNumber(value.engineInitSeconds),
  };
}

function mergeRuntimeFacts(base = {}, override = {}) {
  const left = normalizeRuntimeFacts(base);
  const right = normalizeRuntimeFacts(override);
  const merged = {};
  for (const key of Object.keys(left)) {
    merged[key] = right[key] ?? left[key] ?? null;
  }
  return merged;
}

function hasRuntimeFacts(facts = {}) {
  return Object.values(facts).some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
}

function positiveFactNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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
    context: liveByName[model.name]?.context || inactiveRuntimeContext(model.context),
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
  const totals = aggregateStats(mergedModels, liveSummary?.uptimeSeconds || null);
  if (liveSummary?.totals?.context) totals.context = liveSummary.totals.context;
  return {
    ...historical,
    source: liveSummary?.source || historical.source,
    processStartSeconds: liveSummary?.processStartSeconds || null,
    uptimeSeconds: liveSummary?.uptimeSeconds || null,
    facts: liveSummary?.facts || historical.facts,
    totals,
    models: mergedModels.sort((a, b) => b.tokens.total - a.tokens.total),
    modelsByName: Object.fromEntries(mergedModels.map((model) => [model.name, model])),
    rawMetricCount: liveSummary?.rawMetricCount || 0,
    note: historical.note,
  };
}

function inactiveRuntimeContext(context = {}) {
  const item = context && typeof context === "object" ? context : {};
  return {
    activeTokens: 0,
    capacityTokens: null,
    kvUsagePercent: 0,
    maxModelLen: item.maxModelLen || null,
    concurrencyAtMaxLen: null,
  };
}

function buildClientUsageSummary(totals, ledger) {
  const claude = clientCountersToSummary(ledger.clients?.claude, {
    id: "claude",
    label: "Claude 兼容桥",
    description: "经管理器 /claude/v1/messages 进入本地 vLLM 的 Claude Desktop / Claude Code / Cowork 请求。",
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
    note: "Claude 只统计通过管理器 Claude 兼容桥的请求；OpenWebUI 或直接访问 vLLM /v1 的请求会归入聊天/直连。",
  };
}

function clientCountersToSummary(counters, meta) {
  const item = normalizeClientCounters(counters, meta.id, meta.label);
  const models = Object.entries(item.models || {})
    .map(([name, value]) => {
      const prompt = Number(value.tokens?.prompt || 0);
      const generation = Number(value.tokens?.generation || 0);
      return {
        name,
        tokens: {
          prompt,
          generation,
          total: Number(value.tokens?.total || prompt + generation),
        },
        requests: {
          total: Number(value.requests?.total || 0),
          success: Number(value.requests?.success || 0),
          error: Number(value.requests?.error || 0),
          streamed: Number(value.requests?.streamed || 0),
        },
      tools: {
        schemas: Number(value.tools?.schemas || 0),
        toolUse: Number(value.tools?.toolUse || 0),
      },
      compression: {
        applied: Number(value.compression?.applied || 0),
        savedTokens: Number(value.compression?.savedTokens || 0),
      },
      latency: {
          avgMs: Number(value.latency?.avgMs || 0),
          maxMs: Number(value.latency?.maxMs || 0),
        },
      };
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
    session: item.session || {},
    sessions: clientSessionsToSummary(item.sessions),
    last: item.last || {},
  };
}

function clientSessionsToSummary(sessions) {
  return Object.values(normalizeClaudeClientSessions(sessions))
    .sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0))
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      label: item.label,
      source: item.source,
      startedAt: item.startedAt,
      lastSeenAt: item.lastSeenAt,
      tokens: item.tokens,
      requests: item.requests,
      tools: item.tools,
      compression: item.compression,
      latency: item.latency,
      last: item.last,
      modelCount: Object.keys(item.models || {}).length,
    }));
}

function subtractClientFromTotals(totals, client) {
  const prompt = Math.max(0, Number(totals?.tokens?.prompt || 0) - Number(client.tokens?.prompt || 0));
  const generation = Math.max(0, Number(totals?.tokens?.generation || 0) - Number(client.tokens?.generation || 0));
  const cachedPrompt = Math.max(0, Number(totals?.tokens?.cachedPrompt || 0) - Number(client.tokens?.cachedPrompt || 0));
  const totalRequests = Math.max(0, Number(totals?.requests?.total || 0) - Number(client.requests?.total || 0));
  const error = Math.max(0, Number(totals?.requests?.error || 0) - Number(client.requests?.error || 0));
  const aborted = Math.max(0, Number(totals?.requests?.aborted || 0) - Number(client.requests?.aborted || 0));
  return {
    id: "chat",
    label: "聊天 / 直连 OpenAI",
    description: "OpenWebUI、API Docs 测试页或其他直接访问 vLLM /v1 的请求。这里按 vLLM 总量减去 Claude 桥接量估算。",
    tokens: {
      prompt,
      generation,
      cachedPrompt,
      total: prompt + generation,
    },
    requests: {
      total: totalRequests,
      success: Math.max(0, totalRequests - error - aborted),
      error,
      aborted,
      streamed: 0,
    },
    tools: { schemas: 0, toolUse: 0 },
    compression: { applied: 0, savedTokens: 0, last: {} },
    latency: { totalMs: 0, avgMs: 0, maxMs: 0 },
    models: [],
    aliases: {},
    last: {},
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
    note: container?.exists ? "vLLM container is not running." : "No managed vLLM container is running.",
  };
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
    const recent = calculateRecentRates(name, nowSeconds, {
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
  const needles = normalizeRuntimeFactHints(modelHints);
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

function normalizeRuntimeFactHints(hints) {
  return (Array.isArray(hints) ? hints : [hints])
    .map((hint) => String(hint || "").trim().toLowerCase())
    .filter(Boolean);
}

function jobMatchesRuntimeFactHints(job, needles) {
  const values = [
    job.meta?.model,
    job.meta?.name,
    job.meta?.servedModels ? JSON.stringify(job.meta.servedModels) : "",
  ];
  return runtimeFactValuesMatch(values, needles);
}

function runtimeFactItemMatches(item, needles) {
  return runtimeFactValuesMatch([
    item?.name,
    item?.root,
    item?.id,
    item?.last?.root,
    item?.last?.model,
  ], needles);
}

function runtimeFactValuesMatch(values, needles) {
  const rawValues = values
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  const compactValues = rawValues
    .flatMap((value) => [value, path.basename(value.replace(/\\/g, "/"))])
    .map(normalizeRuntimeFactKey)
    .filter(Boolean);
  const rawText = rawValues.join("\n");
  return needles.some((needle) => {
    if (rawText.includes(needle)) return true;
    const compactNeedle = normalizeRuntimeFactKey(needle);
    if (!compactNeedle) return false;
    return compactValues.some((value) => (
      value.length >= 6
      && (value.includes(compactNeedle) || compactNeedle.includes(value))
    ));
  });
}

function normalizeRuntimeFactKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-z0-9]+/g, "");
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
      detail: "vLLM API 已返回模型列表。",
      state: "ok",
    });
    recordRecentLaunch(job.meta);
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
    .filter((line) => /(^|\s)(error|exception|traceback|failed|fatal)\b|out of memory|no such|cannot|not found|runtimeerror|valueerror|typeerror|validationerror|invalid repository|configuration file|config\.json|params\.json|engineDeadError|device-side assert|scattergatherkernel|uva is not available/i.test(line))
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
  if (options.progressDir) {
    startProgressTracker(job, options.progressDir, options.expectedBytes, {
      countExistingProgress: Boolean(options.countExistingProgress),
    });
  }
  child.stdout.on("data", (data) => appendLog(job, data));
  child.stderr.on("data", (data) => appendLog(job, data));
  const onDone = () => {
    if (job.type === "download") drainDownloadQueue();
  };
  child.on("error", (error) => { failJob(job, error); onDone(); });
  child.on("close", (code) => {
    job.exitCode = code;
    Promise.resolve()
      .then(async () => {
        if (job.meta?.cancelRequested && job.type === "download") {
          if (job.meta.cancelAction === "pause") pauseDownloadJobAfterStop(job);
          else await finalizeDownloadCancel(job, { deletePartial: true });
        } else if (job.meta?.cancelRequested) {
          failJob(job, new Error("任务已被用户取消"));
        } else if (code === 0) {
          finishJob(job);
        } else {
          failJob(job, new Error(`Process exited with code ${code}`));
        }
      })
      .catch((error) => {
        job.error = error.message || String(error);
        appendLog(job, `Error: ${job.error}`);
        scheduleJobsSave(0);
      })
      .finally(onDone);
  });
  job.cancel = (action = "cancel") => {
    job.meta = { ...job.meta, cancelRequested: true, cancelAction: action };
    terminateProcessTree(child.pid);
  };
}

// 下载队列：开启后，已有下载在跑时新任务排队，前一个结束再启动下一个
const downloadSpecs = new Map();
let downloadQueueMode = false;

function hasRunningDownload() {
  return Array.from(jobs.values()).some((job) => job.type === "download" && job.status === "running");
}

function isDownloadFinished(status) {
  return ["success", "cancelled"].includes(String(status || ""));
}

function enqueueOrStartDownload(command, args, options = {}) {
  healDownloadQueue();
  const shouldQueue = downloadQueueMode && hasRunningDownload();
  const job = createJob("download", options.title || "download", options.meta || {});
  if (shouldQueue) {
    job.status = "queued";
    downloadSpecs.set(job.id, { command, args, options });
    appendLog(job, "下载队列已开启，已有下载在进行，本任务排队等待。");
    job.cancel = () => {
      downloadSpecs.delete(job.id);
      job.meta = { ...job.meta, cancelRequested: true };
      failJob(job, new Error("任务已被用户取消"));
    };
    scheduleJobsSave(0);
  } else {
    spawnJobProcess(job, command, args, options);
  }
  healDownloadQueue();
  return job;
}

function pauseDownloadJob(job) {
  if (job.status === "paused") return job;
  if (job.status === "queued") {
    downloadSpecs.delete(job.id);
    pauseDownloadJobAfterStop(job);
    return job;
  }
  if (job.status !== "running") {
    throw new Error("只有运行中或排队中的下载可以暂停。");
  }
  if (typeof job.cancel !== "function") throw new Error("当前下载任务无法暂停。");
  appendLog(job, "正在暂停下载，已下载的部分会保留用于继续。");
  job.cancel("pause");
  return job;
}

function pauseDownloadJobAfterStop(job) {
  if (job.status !== "running" && job.status !== "queued") return;
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
  scheduleJobsSave(0);
}

async function cancelDownloadJob(job) {
  if (job.status === "queued") {
    downloadSpecs.delete(job.id);
    await finalizeDownloadCancel(job, { deletePartial: true });
    return job;
  }
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
  scheduleJobsSave(0);
}

async function deletePartialDownload(job) {
  const localDir = job.meta?.localDir;
  if (!localDir) return;
  const resolved = resolveModelsRootChild(localDir);
  await fsp.rm(resolved, { recursive: true, force: true });
  appendLog(job, `已删除部分下载目录: ${resolved}`);
}

function resumeDownloadJob(job) {
  if (job.status === "running" || job.status === "queued") return job;
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
  if (downloadQueueMode && hasRunningDownload()) {
    job.status = "queued";
    job.updatedAt = new Date().toISOString();
    downloadSpecs.set(job.id, spec);
    appendLog(job, "继续下载已加入队列。");
    scheduleJobsSave(0);
  } else {
    appendLog(job, "继续下载，尝试复用本地已有文件。");
    spawnJobProcess(job, spec.command, spec.args, spec.options);
  }
  return job;
}

function drainDownloadQueue() {
  healDownloadQueue({ skipDrain: true });
  if (hasRunningDownload()) return;
  const next = Array.from(jobs.values())
    .filter((job) => job.type === "download" && job.status === "queued" && downloadSpecs.has(job.id))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  if (!next) return;
  const spec = downloadSpecs.get(next.id);
  downloadSpecs.delete(next.id);
  appendLog(next, "前一个下载已结束，开始本任务。");
  spawnJobProcess(next, spec.command, spec.args, spec.options);
}

function healDownloadQueue(options = {}) {
  let changed = false;
  for (const job of jobs.values()) {
    if (job.type !== "download" || job.status !== "queued" || downloadSpecs.has(job.id)) continue;
    job.status = "failed";
    job.updatedAt = new Date().toISOString();
    job.finishedAt = job.updatedAt;
    job.error = "下载队列状态已过期，请重新提交下载任务。";
    appendLog(job, "下载队列状态已过期：管理器重启或队列参数丢失，请重新提交下载任务。");
    changed = true;
  }
  if (changed) scheduleJobsSave(0);
  if (!options.skipDrain && !hasRunningDownload()) {
    const hasQueuedWithSpec = Array.from(jobs.values()).some((job) => job.type === "download" && job.status === "queued" && downloadSpecs.has(job.id));
    if (hasQueuedWithSpec) setImmediate(drainDownloadQueue);
  }
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

  const launch = resolveLaunchModel(opts.model, opts.loadFormat);
  const modelArg = launch.modelArg;
  const quantization = effectiveLaunchQuantization(opts.quantization, launch);
  const runtimePreset = resolveVllmRuntimePreset(opts, launch);
  const runtimeImage = runtimePreset.image || CONFIG.image;
  const effectiveKvCacheDtype = runtimePreset.kvCacheDtype || opts.kvCacheDtype;
  const effectiveReasoningParser = runtimePreset.reasoningParser || opts.reasoningParser;
  const effectiveToolCallParser = runtimePreset.toolCallParser || opts.toolCallParser;
  const effectiveAutoToolChoice = Boolean(runtimePreset.enableAutoToolChoice || opts.enableAutoToolChoice);
  if (quantization.modelConfigMethod && opts.quantization && quantization.value !== opts.quantization) {
    appendLog(job, `Quantization override: model config declares "${quantization.modelConfigMethod}", ignoring requested "${opts.quantization}".`);
  }
  if (runtimePreset.id) {
    job.meta = {
      ...job.meta,
      runtimePreset: runtimePreset.id,
      runtimeImage,
      runtimeNotes: runtimePreset.notes || [],
      kvCacheDtype: effectiveKvCacheDtype,
      trustRemoteCode: Boolean(opts.trustRemoteCode || runtimePreset.forceTrustRemoteCode),
      enablePrefixCaching: Boolean(opts.enablePrefixCaching && !runtimePreset.disablePrefixCaching),
      languageModelOnly: Boolean(opts.languageModelOnly && !runtimePreset.disableLanguageModelOnly),
      enforceEager: Boolean(runtimePreset.enforceEager),
      reasoningParser: effectiveReasoningParser,
      toolCallParser: effectiveToolCallParser,
      enableAutoToolChoice: effectiveAutoToolChoice,
    };
    scheduleJobsSave();
    appendLog(job, `Runtime preset: ${runtimePreset.label || runtimePreset.id}; using image ${runtimeImage}.`);
    for (const note of runtimePreset.notes || []) appendLog(job, `Runtime preset note: ${note}`);
    if (runtimePreset.kvCacheDtype && runtimePreset.kvCacheDtype !== opts.kvCacheDtype) {
      appendLog(job, `KV cache dtype override: ${opts.kvCacheDtype || "auto"} -> ${runtimePreset.kvCacheDtype}.`);
    }
  }
  if (launch.effectiveLoadFormat === "gguf") {
    appendLog(job, `GGUF mode: using ${modelArg}`);
    if (launch.selectedGgufFile && launch.ggufFiles.length > 1) {
      appendLog(job, `Multiple GGUF files found; selected largest file: ${path.basename(launch.selectedGgufFile)}`);
    }
    if (!opts.tokenizer) {
      appendLog(job, "GGUF warning: tokenizer is empty. vLLM can try GGUF tokenizer conversion, but a base Hugging Face tokenizer is usually faster and more stable.");
    }
  }
  let activePublishArgs = dockerPublishArgs(opts.port, opts.networkAccess, opts.serviceHost);
  appendLog(job, `Docker publish: ${activePublishArgs.map((arg) => `-p ${arg}`).join(" ")}`);
  const runArgs = [
    "run", "-d",
    "--name", CONFIG.containerName,
    "--label", `${MANAGER_LABEL_KEY}=${CONFIG.managerId}`,
    "--label", `${MANAGER_ENGINE_LABEL_KEY}=vllm`,
    "--gpus", dockerGpuArg(opts.gpuDeviceIds || []),
    "--ipc=host",
    ...publishArgsToDockerRunArgs(activePublishArgs),
    "-v", `${CONFIG.hfCache}:/root/.cache/huggingface`,
    "-v", `${CONFIG.modelsRoot}:/models`,
  ];
  if (opts.vllmApiKey) {
    // Label lets the manager rediscover the key after a restart so health polling keeps working.
    runArgs.push("--label", `${MANAGER_APIKEY_LABEL_KEY}=${opts.vllmApiKey}`);
  }
  if (opts.networkAccess === "lan" && !opts.vllmApiKey) {
    appendLog(job, `安全警告：服务将通过 Docker 发布到 ${opts.serviceHost || getLanAddress()}（局域网可访问），但没有设置 API Key。同一网络内的任何设备都可以调用该模型。建议在启动参数中填写 API Key。`);
  }
  const selectedGpuIds = normalizeGpuIds(opts.gpuDeviceIds);
  if (selectedGpuIds.length) {
    // --gpus device=... already limits visibility; the container renumbers them from 0,
    // so do not also set CUDA_VISIBLE_DEVICES with host indices.
    appendLog(job, `GPU isolation: --gpus device=${selectedGpuIds.join(",")}`);
  }
  if (process.env.HF_TOKEN) runArgs.push("-e", `HF_TOKEN=${process.env.HF_TOKEN}`);
  for (const [key, value] of Object.entries(runtimePreset.env || {})) {
    if (value !== undefined && value !== null && value !== "") runArgs.push("-e", `${key}=${value}`);
  }

  runArgs.push(
    runtimeImage,
    "--model", modelArg,
    "--served-model-name", opts.name,
    "--dtype", opts.dtype,
    "--max-model-len", String(opts.maxModelLen),
    "--max-num-seqs", String(opts.maxNumSeqs),
    "--gpu-memory-utilization", String(opts.gpuMemoryUtilization)
  );
  if (quantization.value) runArgs.push("--quantization", quantization.value);
  if (launch.effectiveLoadFormat === "gguf") {
    if (opts.quantization || quantization.value) {
      appendLog(job, `Ignoring quantization "${opts.quantization || quantization.value}" because GGUF already contains quantized weights.`);
    }
    const quantIndex = runArgs.indexOf("--quantization");
    if (quantIndex >= 0) runArgs.splice(quantIndex, 2);
    runArgs.push("--load-format", "gguf");
  }
  if (opts.tokenizer) runArgs.push("--tokenizer", windowsPathToContainerPath(opts.tokenizer));
  if (opts.hfConfigPath) runArgs.push("--hf-config-path", windowsPathToContainerPath(opts.hfConfigPath));
  if (effectiveKvCacheDtype && effectiveKvCacheDtype !== "auto") runArgs.push("--kv-cache-dtype", effectiveKvCacheDtype);
  if (opts.cpuOffloadGb > 0) runArgs.push("--cpu-offload-gb", String(opts.cpuOffloadGb));
  if (opts.kvOffloadingSize > 0) runArgs.push("--kv-offloading-size", String(opts.kvOffloadingSize));
  if (opts.mmProcessorCacheGb !== null && opts.mmProcessorCacheGb !== undefined) {
    runArgs.push("--mm-processor-cache-gb", String(opts.mmProcessorCacheGb));
  }
  if (opts.enablePrefixCaching && runtimePreset.disablePrefixCaching) {
    appendLog(job, "Runtime preset disabled prefix caching for this architecture.");
  } else if (opts.enablePrefixCaching) {
    runArgs.push("--enable-prefix-caching");
  }
  if (opts.languageModelOnly && runtimePreset.disableLanguageModelOnly) {
    appendLog(job, "Runtime preset disabled --language-model-only because this architecture is not a plain language-only model.");
  } else if (opts.languageModelOnly) {
    runArgs.push("--language-model-only");
  }
  if (opts.trustRemoteCode || runtimePreset.forceTrustRemoteCode) runArgs.push("--trust-remote-code");
  if (opts.tensorParallelSize > 1) runArgs.push("--tensor-parallel-size", String(opts.tensorParallelSize));
  if (opts.pipelineParallelSize > 1) runArgs.push("--pipeline-parallel-size", String(opts.pipelineParallelSize));
  if (opts.dataParallelSize > 1) runArgs.push("--data-parallel-size", String(opts.dataParallelSize));
  if (opts.distributedExecutorBackend && opts.distributedExecutorBackend !== "auto") {
    runArgs.push("--distributed-executor-backend", opts.distributedExecutorBackend);
  }
  if (opts.enableExpertParallel) runArgs.push("--enable-expert-parallel");
  if (runtimePreset.enforceEager) runArgs.push("--enforce-eager");
  if (runtimePreset.attentionBackend) runArgs.push("--attention-backend", runtimePreset.attentionBackend);
  if (runtimePreset.overrideGenerationConfig) runArgs.push("--override-generation-config", runtimePreset.overrideGenerationConfig);
  if (runtimePreset.defaultChatTemplateKwargs) runArgs.push("--default-chat-template-kwargs", runtimePreset.defaultChatTemplateKwargs);
  if (effectiveReasoningParser && effectiveReasoningParser !== "auto") {
    runArgs.push("--reasoning-parser", effectiveReasoningParser);
  }
  if (effectiveAutoToolChoice && effectiveToolCallParser) {
    runArgs.push("--enable-auto-tool-choice", "--tool-call-parser", effectiveToolCallParser);
  }
  if (opts.vllmApiKey) runArgs.push("--api-key", opts.vllmApiKey);

  setJobProgress(job, {
    percent: 32,
    stage: "启动 Docker 容器",
    detail: "Docker run 已开始；如果镜像不存在，这一步会等待拉取镜像。",
  });
  const loggedArgs = opts.vllmApiKey
    ? runArgs.map((arg) => arg.includes(opts.vllmApiKey) ? arg.replaceAll(opts.vllmApiKey, "***") : arg)
    : runArgs;
  appendLog(job, `> docker ${loggedArgs.join(" ")}`);
  let launched;
  try {
    launched = await docker(runArgs);
  } catch (error) {
    if (opts.networkAccess !== "lan" || !isDockerPublishBindError(error) || activePublishArgs.some((arg) => arg.startsWith("0.0.0.0:"))) {
      throw error;
    }
    activePublishArgs = dockerPublishArgs(opts.port, "lan", "0.0.0.0");
    const retryArgs = replaceDockerPublishArgs(runArgs, activePublishArgs);
    const loggedRetryArgs = opts.vllmApiKey
      ? retryArgs.map((arg) => arg.includes(opts.vllmApiKey) ? arg.replaceAll(opts.vllmApiKey, "***") : arg)
      : retryArgs;
    appendLog(job, `Docker specific LAN IP publish failed; retrying with wildcard bind. Original error: ${error.stderr || error.message}`);
    appendLog(job, `Docker publish fallback: ${activePublishArgs.map((arg) => `-p ${arg}`).join(" ")}`);
    appendLog(job, `> docker ${loggedRetryArgs.join(" ")}`);
    launched = await docker(retryArgs);
  }
  appendLog(job, launched.stdout || launched.stderr);

  setJobProgress(job, {
    percent: 45,
    stage: "等待模型加载",
    detail: "容器已创建，正在等待 vLLM API 返回 /v1/models。",
  });
  appendLog(job, `Service URL: ${opts.serviceUrl}`);
  appendLog(job, `Waiting for http://127.0.0.1:${opts.port}/v1/models`);
  // 硬上限默认 60 分钟（容器内现拉权重的大模型可能很慢）；
  // 真正的失败判定靠「日志停滞」：日志持续无变化才认为卡死。
  const startTimeoutMs = Math.max(60000, Number(process.env.VLLM_START_TIMEOUT_MS || 60 * 60 * 1000));
  const stallTimeoutMs = Math.max(60000, Number(process.env.VLLM_START_STALL_TIMEOUT_MS || 10 * 60 * 1000));
  const started = Date.now();
  let lastLogCheck = 0;
  let lastLogSnapshot = "";
  let lastLogChangeAt = Date.now();
  const formatElapsed = (ms) => `${Math.floor(ms / 60000)} 分 ${Math.floor((ms % 60000) / 1000)} 秒`;
  while (Date.now() - started < startTimeoutMs) {
    const elapsed = Date.now() - started;
    setJobProgress(job, {
      percent: Math.min(94, 45 + (elapsed / startTimeoutMs) * 49),
      stage: "等待模型加载",
      detail: `已等待 ${formatElapsed(elapsed)}。正在轮询 vLLM API，并读取容器日志检查错误。`,
    });
    const served = await getServedModels(opts.port, opts.vllmApiKey);
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
        detail: `${CONFIG.containerName} 不存在，vLLM 启动进程已经结束或被移除。`,
        state: "fail",
        issues: [`No such container: ${CONFIG.containerName}`],
      });
      throw new Error(`${CONFIG.containerName} disappeared before vLLM became ready`);
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
        detail: issues[issues.length - 1] || container.status || "vLLM 容器已停止。",
        state: "fail",
        issues: issues.length ? issues : [container.status || "Container exited"],
      });
      throw new Error(`vLLM container exited before becoming ready: ${container.status || "stopped"}`);
    }
    if (Date.now() - lastLogCheck > 10000) {
      lastLogCheck = Date.now();
      const logs = await docker(["logs", "--tail", "30", CONFIG.containerName], { rejectOnError: false });
      const logText = `${logs.stdout}${logs.stderr}`;
      if (logText !== lastLogSnapshot) {
        lastLogSnapshot = logText;
        lastLogChangeAt = Date.now();
      }
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
      if (Date.now() - lastLogChangeAt > stallTimeoutMs) {
        setJobProgress(job, {
          percent: job.progress?.percent,
          stage: "启动停滞",
          detail: `容器日志已 ${formatElapsed(Date.now() - lastLogChangeAt)} 没有任何变化，判定启动卡死。`,
          state: "fail",
          issues: issues.length ? issues : ["vLLM 启动日志长时间无变化。"],
        });
        throw new Error(`vLLM start stalled: no log output for ${Math.round(stallTimeoutMs / 60000)} minutes`);
      }
    }
    await delay(5000);
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
  throw new Error(`vLLM did not become ready within ${Math.round(startTimeoutMs / 60000)} minutes`);
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

function buildVllmMemoryEstimate(input = {}) {
  const selectedGpus = normalizeMemoryEstimateGpus(input.selectedGpus || input.gpus || []);
  const mode = String(input.multiGpuMode || input.mode || "single").toLowerCase();
  const normalizedMode = mode === "none" ? "single" : mode;
  const arch = normalizeMemoryEstimateArch(input.arch || input.modelConfig || input.config);
  const plan = core.estimateVllmMemoryPlan({
    paramsB: memoryEstimateNumber(input.paramsB, 0),
    contextTokens: Math.max(1, memoryEstimateNumber(input.contextTokens ?? input.maxModelLen, 8192)),
    bytesPerParam: Math.max(0.125, memoryEstimateNumber(input.bytesPerParam, 2)),
    kvBytes: Math.max(0.125, memoryEstimateNumber(input.kvBytes, 2)),
    arch,
    selectedGpus,
    utilization: memoryEstimateNumber(input.gpuMemoryUtilization ?? input.utilization, 0.9),
    mode: normalizedMode,
    tensorParallelSize: Math.max(1, Math.floor(memoryEstimateNumber(input.tensorParallelSize ?? input.tpSize, normalizedMode === "tensor" ? selectedGpus.length || 1 : 1))),
    pipelineParallelSize: Math.max(1, Math.floor(memoryEstimateNumber(input.pipelineParallelSize ?? input.ppSize, normalizedMode === "pipeline" ? selectedGpus.length || 1 : 1))),
    cpuOffloadGb: Math.max(0, memoryEstimateNumber(input.cpuOffloadGb, 0)),
    kvOffloadGb: Math.max(0, memoryEstimateNumber(input.kvOffloadGb ?? input.kvOffloadingSize, 0)),
    multimodalReserveGb: Math.max(0, memoryEstimateNumber(input.multimodalReserveGb, input.arch?.isMultimodal ? 2 : 0)),
  });
  const suggestions = [];
  if (!plan.selectedGpus.length) {
    suggestions.push("没有传入 GPU 显存数据，只能给出模型本身的理论占用。");
  } else if (plan.status === "fail") {
    suggestions.push(`预计每卡超出约 ${plan.overflowPerGpuGb.toFixed(1)} GiB，可提高 CPU offload 或降低上下文。`);
  } else if (plan.status === "warn") {
    suggestions.push("预计接近可用显存上限，建议预留更低的 gpu-memory-utilization 或减少并发。");
  } else {
    suggestions.push("当前配置预计可运行，并保留了基本运行时余量。");
  }
  if (normalizedMode === "data" && plan.selectedGpus.length > 1) {
    suggestions.push("Data Parallel 会复制完整模型，不能降低单卡显存；长上下文优先考虑 Tensor/Pipeline 或 CPU offload。");
  }
  if (plan.recommendedCpuOffloadGb > plan.cpuOffloadPerGpuGb) {
    suggestions.push(`建议 CPU offload 至少设为 ${plan.recommendedCpuOffloadGb.toFixed(1)} GiB/卡。`);
  }
  if (plan.recommendedKvOffloadGb > plan.kvOffloadTotalGb) {
    suggestions.push(`权重已难以下放时，可尝试 KV offload 总量 ${plan.recommendedKvOffloadGb.toFixed(1)} GiB。`);
  }
  return {
    ok: true,
    engine: "vllm",
    plan,
    recommendations: {
      status: plan.status,
      summary: plan.status === "ok" ? "预计可运行" : plan.status === "warn" ? "预计接近显存上限" : "预计会显存不足",
      suggestions,
      cpuOffloadGb: plan.recommendedCpuOffloadGb,
      kvOffloadingSize: plan.recommendedKvOffloadGb,
      overflowPerGpuGb: plan.overflowPerGpuGb,
      memorySplitFactor: plan.memorySplitFactor,
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
  parseToolArguments,
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
  isServiceApiKeyAccepted,
  enterServiceRateLimit,
  enterServiceConcurrency,
  resolveOpenAiGatewayModel,
  normalizeServiceClient,
  hashServiceApiKey,
  serviceClientAllowsModel,
  buildEffectiveServiceSettings,
  extractHostname,
  streamOpenAiAsClaude,
  normalizeModelConfig,
  buildVllmMemoryEstimate,
};
