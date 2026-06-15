const state = {
  config: null,
  models: { local: [], cached: [] },
  status: null,
  stats: null,
  jobs: [],
  health: null,
  profiles: { builtin: [], profiles: [] },
  modelCheck: null,
  logSummary: null,
  automationSettings: null,
  serviceExposure: null,
  serviceClients: { clients: [] },
  externalAccess: null,
  connectionGuide: null,
  compressionInsights: null,
  modelNotes: { notes: {} },
  remoteModels: [],
  remoteError: "",
  downloadPrecisionOptions: [],
  auditToken: localStorage.getItem("auditToken") || "",
  auditStatus: null,
  auditExports: [],
  auditMarkdown: "",
  selectedAuditId: "",
  auditError: "",
  selectedGpuIds: new Set(),
  gpuSelectionTouched: false,
  gpuSignature: "",
  reasoningParserTouched: false,
  tensorSplitTouched: false,
  modelPickerOpen: false,
  modelPickerSource: "all",
  expandedJobLogs: new Set(),
  runnableOnly: localStorage.getItem("llamaRunnableOnly") === "1",
  uiPrefs: {
    theme: localStorage.getItem("llamaThemeMode") || "auto",
    language: localStorage.getItem("llamaLanguageMode") || "auto",
  },
};

let memoryEstimateTimer = null;
let memoryEstimateSeq = 0;
let downloadEstimateTimer = null;
let downloadEstimateSeq = 0;
let remoteSearchSeq = 0;

const $ = (selector) => document.querySelector(selector);
const { fmtBytes, fmtNumber, fmtTokens, fmtPct, fmtRate, fmtMoney, escapeHtml, escapeAttr } = window.LlamaFormat;
const { api, auditApi } = window.LlamaApi.create(() => state.auditToken);

const { DOWNLOAD_SOURCES, PRECISION_PRESETS, MODEL_PRESETS, DTYPE_BYTES, KV_DTYPE_BYTES, QUANTIZATION_PROFILES, ICON_FALLBACKS } = window.LlamaCatalog;
const {
  normalizedOptions,
  normalizedPrecisionOptions,
  chooseDownloadPrecision,
  normalizeDownloadQuantValue,
  inferDownloadSelection,
  normalizeSummary,
  inferModelQuantLabel,
  quantBytesForLabel,
  isManagerRunnableModelItem,
  isManagerRunnableRemoteModel,
  modelRemoteSizeMatches,
  modelRemoteQuantMatches,
  formatParamsB,
} = window.LlamaModelUtils;
const { jobStatusInfo, isDockerDaemonIssue, formatDuration } = window.LlamaJobUtils;
const { inferGpuGeneration } = window.GpuPlanningUtils;

const { EN_TEXT, ZH_TEXT } = window.LlamaI18n;
const { setButtonBusy, notify, reportActionError } = window.LlamaUiUtils.create({ $, escapeHtml, renderIcons: () => renderIcons(), showTestResult: (result) => showTestResult(result) });
const serviceClientRenderer = window.LocalAiServiceClients.create({
  $,
  state,
  escapeHtml,
  escapeAttr,
  fmtTokens,
  formatDateTime,
});
const profileRenderer = window.LocalAiProfileRenderer.create({
  $,
  state,
  escapeHtml,
  escapeAttr,
  fmtTokens,
  copy: {
    empty: "暂无配置方案。",
    builtin: "内置",
    noDescription: "无说明",
    apply: "套用",
    remove: "删除",
    noOptions: "暂无方案",
    defaultSummary: "常用参数可在这里快速套用；完整管理仍在工具页。",
  },
  metrics(profile) {
    const cfg = profile.config || {};
    return [
      `${fmtTokens(cfg.maxModelLen || 0)} 上下文`,
      `${fmtTokens(cfg.maxNumSeqs || 0)} 并行`,
      `${cfg.cacheTypeK || "f16"}/${cfg.cacheTypeV || "f16"} KV`,
      cfg.multiGpuMode || "layer",
      cfg.tensorSplit || "auto split",
      cfg.textOnlyMode === false || cfg.languageModelOnly === false ? "多模态预留" : "仅文本",
    ];
  },
  summaryParts(profile) {
    const cfg = profile.config || {};
    return [
      profile.description || "无说明",
      cfg.maxModelLen ? `${fmtTokens(cfg.maxModelLen)} 上下文` : "",
      cfg.multiGpuMode ? `${cfg.multiGpuMode} GPU` : "",
      cfg.tensorSplit ? `split ${cfg.tensorSplit}` : "",
    ];
  },
});
const externalAccessRenderer = window.LocalAiExternalAccess.create({
  $,
  escapeHtml,
  escapeAttr,
  fmtTokens,
  fmtPct,
  fmtRate,
  fmtMs,
  formatDateTime,
  statsMetric,
  miniStat,
  shareBar,
  renderIcons,
  endpointDetails: {
    claude: "给 Claude Desktop / CC Switch 使用，Base URL 填 /claude。",
    openai: "给 Chatbox、OpenWebUI 或 OpenAI SDK 使用，Base URL 填 /serve/v1。",
  },
});
const jobRenderer = window.LocalAiJobRenderer.create({
  $,
  state,
  escapeHtml,
  escapeAttr,
  fmtBytes,
  formatDuration,
  jobStatusInfo,
  renderServeProgress,
  renderBenchmarkProgress,
  renderAutomationJobProgress,
  showMeta: true,
  showLogActions: true,
  showVerifyActions: true,
});
const serviceExposureRenderer = window.LocalAiServiceExposureRenderer.create({
  $,
  state,
  escapeHtml,
  escapeAttr,
  fmtTokens,
  defaultServicePort: 8080,
});
const uiArchitecture = window.LocalAiUiArchitecture.create({ $, escapeHtml });
const runtimeStatusRenderer = window.LocalAiRuntimeStatusRenderer.create({
  $,
  state,
  escapeHtml,
  escapeAttr,
  fmtBytes,
  fmtNumber,
  fmtTokens,
  fmtPct,
  fmtRate,
  formatDuration,
  inferGpuGeneration,
  renderIcons: () => renderIcons(),
  setMetricState,
  getLiveTokensPerSecond,
  getVisibleGpus,
  updateParallelDefaults,
  updateMemoryEstimate,
  renderGpuPlan: () => renderHeteroPlan(),
  options: {
    subtitlePrefix: "llama.cpp",
    defaultContainerName: "llama-local",
    noRunningText: "当前没有运行中的 llama.cpp 模型。启动模型后，这里会显示服务名、API 地址和卸载按钮。",
    loadingTitle: "llama.cpp 容器正在运行",
    claudeDetail: "Anthropic Messages 桥接到 OpenAI chat completions；base URL 用当前 Claude 桥地址。",
    defaultGpuSelection: "all",
    contextWarnPct: 85,
    contextFailPct: 92,
    vramWarnPct: 92,
    vramFailPct: 96,
    onNoGpus: () => renderHeteroPlan(),
  },
});
const toolPanelRenderer = window.LocalAiToolPanelRenderer.create({
  $,
  state,
  escapeHtml,
  escapeAttr,
  fmtNumber,
  fmtTokens,
  formatDateTime,
  miniStat,
  renderIcons: () => renderIcons(),
  onApplyModelCheck: (result) => {
    applyLaunchProfile(result.recommendations || {});
    notify("已套用兼容性推荐", result.model, "success");
    showView("service");
  },
});
const statsSummaryRenderer = window.LocalAiStatsSummaryRenderer.create({
  $,
  state,
  statsMetric,
  fmtTokens,
  fmtRate,
  fmtPct,
  fmtSeconds,
  formatDuration,
  formatContextUsage,
});

function enhanceUiArchitecture() {
  ensureToastRoot();
  ensureServiceExposureUi();
  ensureStatusInsightMetrics();
  enhanceLaunchFormLayout();
  enhanceToolsPage();
}

function ensureServiceExposureUi() {
  uiArchitecture.ensureServiceExposureUi({
    navLabel: "对外服务",
    apiKeyLabel: "API Key 规划",
    formNote: "llama.cpp 对外服务建议优先放在 Caddy/Nginx/Cloudflare Tunnel 后面做 TLS、鉴权和限流。保存后如需改变局域网绑定，请应用到启动表单并重启模型。",
    clientDescription: "给 OpenWebUI、Claude 或局域网设备单独发 Key，并限制模型、速率和并发。",
  });
}

function ensureToastRoot() {
  if ($("#toastRoot")) return;
  const root = document.createElement("div");
  root.className = "toast-root";
  root.id = "toastRoot";
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-atomic", "false");
  document.body.appendChild(root);
}

function ensureStatusInsightMetrics() {
  const grid = document.querySelector(".status-grid");
  if (!grid || $("#vramStatus")) return;
  [
    ["VRAM", "vramStatus"],
    ["Context", "contextStatus"],
    ["Speed", "speedStatus"],
    ["Idle guard", "idleStatus"],
  ].forEach(([label, id]) => {
    const metric = document.createElement("div");
    metric.className = "metric metric-extra";
    metric.innerHTML = `<span>${label}</span><strong id="${id}">-</strong>`;
    grid.appendChild(metric);
  });
}

function enhanceLaunchFormLayout() {
  const form = $("#startForm");
  if (!form || form.dataset.enhancedLayout === "true") return;
  form.dataset.enhancedLayout = "true";
  ensureServiceProfileShortcut(form);
  groupContextControls();
  moveAdvancedFields(form);
}

function ensureServiceProfileShortcut(form) {
  if ($("#serviceProfileStrip")) return;
  const strip = document.createElement("div");
  strip.className = "service-profile-strip";
  strip.id = "serviceProfileStrip";
  strip.innerHTML = `
    <div class="service-profile-copy">
      <strong>启动方案</strong>
      <span id="serviceProfileSummary">常用参数可在这里快速套用；完整管理仍在工具页。</span>
    </div>
    <select id="serviceProfileSelect" aria-label="启动方案"><option value="">正在读取方案...</option></select>
    <button class="secondary-button compact-button" id="serviceProfileApply" type="button"><i data-lucide="check"></i><span>套用</span></button>
    <button class="ghost-mini-button" id="serviceProfileSave" type="button"><i data-lucide="save"></i><span>保存当前</span></button>
  `;
  form.insertBefore(strip, form.firstElementChild);
}

function groupContextControls() {
  const section = document.querySelector(".context-section");
  if (!section || section.dataset.grouped === "true") return;
  section.dataset.grouped = "true";
  const controls = document.createElement("div");
  controls.className = "context-control-grid context-control-grid-enhanced";
  const basic = createControlGroup("上下文大小", "日常启动优先调整这组：上下文、并行槽数、显存比例。", ["#maxModelLen", "#maxNumSeqs", "#gpuMemoryUtilization"]);
  controls.appendChild(basic);
  section.querySelector(".section-title")?.after(controls);
}

function createControlGroup(title, description, selectors) {
  const group = document.createElement("div");
  group.className = "control-group";
  group.innerHTML = `<div class="control-group-head"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div><div class="control-group-grid"></div>`;
  const body = group.querySelector(".control-group-grid");
  selectors.map(controlForSelector).filter(Boolean).forEach((node) => body.appendChild(node));
  return group;
}

function controlForSelector(selector) {
  const node = $(selector);
  return node?.closest("label, .form-section, .form-note, .parallel-size-grid, .wide-field") || null;
}

function moveAdvancedFields(form) {
  if ($("#launchAdvancedDetails")) return;
  const details = document.createElement("details");
  details.className = "form-disclosure launch-advanced";
  details.id = "launchAdvancedDetails";
  details.innerHTML = `
    <summary>
      <span>高级参数</span>
      <small>GGUF、batch/KV cache、reasoning、网络和 mmap。多数时候只需保留默认。</small>
    </summary>
    <div class="advanced-grid"></div>
  `;
  const body = details.querySelector(".advanced-grid");
  [
    "#ggufSection",
    "#gpuLayers",
    "#batchSize",
    "#ubatchSize",
    "#cacheTypeK",
    "#cacheTypeV",
    "#flashAttention",
    "#clientPreset",
    "#reasoningMode",
    "#reasoningParser",
    "#reasoningNote",
    "#networkAccess",
    "#networkNote",
    "[name='noMmap']",
  ].map(controlForSelector).filter(Boolean).forEach((node) => body.appendChild(node));
  const submit = form.querySelector(".primary-button[type='submit']");
  form.insertBefore(details, submit);
}

function enhanceToolsPage() {
  const page = $("#tools");
  if (!page || $("#toolTabs")) return;
  const hero = page.querySelector(".tool-hero-panel");
  const tabs = document.createElement("div");
  tabs.className = "tool-tabs";
  tabs.id = "toolTabs";
  tabs.innerHTML = `
    <button class="active" type="button" data-tool-group="diagnostics"><i data-lucide="activity"></i><span>诊断</span></button>
    <button type="button" data-tool-group="automation"><i data-lucide="timer-reset"></i><span>自动化</span></button>
    <button type="button" data-tool-group="utility"><i data-lucide="wrench"></i><span>实用</span></button>
  `;
  hero?.after(tabs);
  assignToolPanel("#healthGrid", "diagnostics");
  assignToolPanel("#modelCheckResult", "diagnostics");
  assignToolPanel("#logSummaryPanel", "diagnostics");
  assignToolPanel("#automationStatus", "automation");
  assignToolPanel("#compressionInsights", "automation");
  assignToolPanel("#profileList", "utility");
  assignToolPanel("#benchmarkForm", "utility");
  assignToolPanel("#connectionGuide", "utility");
  assignToolPanel("#modelNotesList", "utility");
  setToolGroup(localStorage.getItem("llamaToolGroup") || "diagnostics");
}

function assignToolPanel(selector, group) {
  const panel = $(selector)?.closest(".panel");
  if (panel) panel.dataset.toolGroup = group;
}

function handleToolTabClick(event) {
  const button = event.target.closest("[data-tool-group]");
  if (!button) return;
  setToolGroup(button.dataset.toolGroup || "diagnostics");
}

function setToolGroup(group) {
  localStorage.setItem("llamaToolGroup", group);
  document.querySelectorAll("#toolTabs [data-tool-group]").forEach((button) => {
    button.classList.toggle("active", button.dataset.toolGroup === group);
  });
  document.querySelectorAll("#tools .panel[data-tool-group]").forEach((panel) => {
    panel.classList.toggle("tool-panel-hidden", panel.dataset.toolGroup !== group);
  });
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(effectiveLanguage(), { hour12: false });
}

function fmtMs(value) {
  const number = Number(value || 0);
  if (number >= 1000) return `${(number / 1000).toFixed(2)} s`;
  return `${Math.round(number)} ms`;
}

function updateSidebarFoot() {
  if (!state.config) return;
  const localCount = (state.models?.local || []).length;
  const cachedCount = (state.models?.cached || []).length;
  const totalBytes = [...(state.models?.local || []), ...(state.models?.cached || [])]
    .reduce((sum, model) => sum + Number(model.size || 0), 0);
  if ($("#modelsRoot")) {
    $("#modelsRoot").textContent = `${state.config.modelsRoot || "-"}${localCount ? ` · ${localCount} models` : ""}`;
  }
  if ($("#hfCache")) {
    $("#hfCache").textContent = `${state.config.hfCache || "-"}${cachedCount ? ` · ${cachedCount} cache${totalBytes ? ` · ${fmtBytes(totalBytes)}` : ""}` : ""}`;
  }
}

async function init() {
  initUiPreferences();
  initDownloadSelectors();
  enhanceUiArchitecture();
  bindEvents();
  showView(location.hash.replace("#", "") || "service", false);
  try {
    state.config = await api("/api/config");
    $("#modelsRoot").textContent = state.config.modelsRoot;
    $("#hfCache").textContent = state.config.hfCache;
    updateSidebarFoot();
    await Promise.all([refreshStatus(), refreshModels(), refreshModelNotes(), refreshLogs(), refreshServiceExposure(), refreshServiceClients()]);
    refreshRemoteModels().catch((error) => {
      state.remoteError = error.message;
      renderRemoteModels();
    });
    refreshStats().catch(() => {});
    refreshExternalAccess().catch(() => {});
    refreshAuditStatus().catch(() => {});
    refreshProfiles().catch(() => renderServiceProfileOptions([]));
    loadDownloadSettings().catch(() => {});
    setInterval(refreshStatus, 5000);
    setInterval(refreshJobs, 3000);
    setInterval(() => {
      if (location.hash === "#stats") refreshStats().catch(() => {});
      if (location.hash === "#external-access") refreshExternalAccess().catch(() => {});
    }, 5000);
  } catch (error) {
    showTestResult({ error: error.message });
  }
  updateGgufModeState();
  updateReasoningNote();
  updateTextOnlyNote();
  renderModelPicker();
  renderHeteroPlan();
  renderIcons();
}

function bindEvents() {
  $("#themeMode")?.addEventListener("change", (event) => {
    state.uiPrefs.theme = event.currentTarget.value || "auto";
    localStorage.setItem("llamaThemeMode", state.uiPrefs.theme);
    applyThemeMode();
  });
  $("#languageMode")?.addEventListener("change", (event) => {
    state.uiPrefs.language = event.currentTarget.value || "auto";
    localStorage.setItem("llamaLanguageMode", state.uiPrefs.language);
    applyLanguageMode();
  });
  setInterval(syncUiPreferenceControls, 500);
  $("#modelPickerToggle")?.addEventListener("click", (event) => {
    event.preventDefault();
    toggleModelPicker();
  });
  $("#modelPickerRefresh")?.addEventListener("click", refreshModelPickerData);
  $("#modelPickerSearch")?.addEventListener("input", renderModelPicker);
  $("#modelPickerRunnableOnly")?.addEventListener("click", toggleRunnableOnly);
  $("#modelPickerTabs")?.addEventListener("click", handleModelPickerTabClick);
  $("#modelPickerList")?.addEventListener("click", handleModelPickerSelection);
  document.addEventListener("click", handleModelPickerOutsideClick);
  $("#heteroPresetButtons")?.addEventListener("click", handleHeteroPresetClick);
  document.querySelectorAll("[data-view]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      showView(link.dataset.view);
    });
  });
  window.addEventListener("hashchange", () => showView(location.hash.replace("#", "") || "service", false));
  $("#refreshBtn").addEventListener("click", () => Promise.all([refreshStatus(), refreshModels(), refreshLogs()]));
  $("#serviceExposureForm")?.addEventListener("submit", saveServiceExposure);
  $("#serviceExposureEndpoints")?.addEventListener("click", handleServiceExposureEndpointAction);
  $("#exposureMode")?.addEventListener("change", () => {
    renderServiceExposureEndpoints(state.serviceExposure);
    renderServiceExposureChecks(state.serviceExposure);
  });
  $("#refreshServiceExposureBtn")?.addEventListener("click", () => refreshServiceExposure().catch((error) => notify("服务化状态刷新失败", error.message, "error")));
  $("#serviceClientForm")?.addEventListener("submit", createServiceClient);
  $("#serviceClientList")?.addEventListener("click", handleServiceClientAction);
  $("#applyExposureToLaunchBtn")?.addEventListener("click", applyExposureToLaunchForm);
  $("#generateExposureApiKey")?.addEventListener("click", generateExposureApiKey);
  $("#reloadModelsBtn").addEventListener("click", refreshModels);
  $("#reloadRemoteModelsBtn").addEventListener("click", refreshRemoteModels);
  $("#remoteSearchBtn").addEventListener("click", refreshRemoteModels);
  $("#remoteSort")?.addEventListener("change", refreshRemoteModels);
  $("#remoteFeature")?.addEventListener("change", refreshRemoteModels);
  $("#remoteLimit")?.addEventListener("change", refreshRemoteModels);
  $("#remoteFreshness")?.addEventListener("change", refreshRemoteModels);
  $("#remoteQuantFilter")?.addEventListener("change", refreshRemoteModels);
  $("#remoteRunnableOnly")?.addEventListener("click", toggleRunnableOnly);
  $("#remoteSizeFilter")?.addEventListener("change", () => {
    renderRemoteModels();
    renderModelPicker();
  });
  $("#downloadRunnableModelsBtn")?.addEventListener("click", openRunnableRemoteModels);
  $("#remoteLoadMoreBtn")?.addEventListener("click", handleRemoteLoadMore);
  $("#remoteSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      refreshRemoteModels();
    }
  });
  $("#reloadLogsBtn").addEventListener("click", refreshLogs);
  $("#reloadStatsBtn").addEventListener("click", refreshStats);
  $("#reloadExternalAccessBtn")?.addEventListener("click", refreshExternalAccess);
  $("#refreshToolsBtn")?.addEventListener("click", refreshToolData);
  $("#runHealthBtn")?.addEventListener("click", refreshHealth);
  $("#saveProfileBtn")?.addEventListener("click", saveCurrentProfile);
  $("#serviceProfileApply")?.addEventListener("click", applySelectedServiceProfile);
  $("#serviceProfileSave")?.addEventListener("click", saveCurrentProfile);
  $("#serviceProfileSelect")?.addEventListener("change", renderServiceProfileSummary);
  $("#toolTabs")?.addEventListener("click", handleToolTabClick);
  $("#profileList")?.addEventListener("click", handleProfileAction);
  $("#runModelCheckBtn")?.addEventListener("click", runModelCheck);
  $("#runLogSummaryBtn")?.addEventListener("click", refreshLogSummary);
  $("#saveAutomationBtn")?.addEventListener("click", saveAutomationSettings);
  $("#benchmarkForm")?.addEventListener("submit", startBenchmark);
  $("#benchmarkJobList")?.addEventListener("click", handleBenchmarkJobAction);
  $("#reloadConnectionBtn")?.addEventListener("click", refreshConnectionGuide);
  $("#reloadCompressionInsightsBtn")?.addEventListener("click", refreshCompressionInsights);
  $("#saveModelNoteBtn")?.addEventListener("click", saveModelNote);
  $("#modelNotesList")?.addEventListener("click", handleModelNoteAction);
  $("#auditLoginForm").addEventListener("submit", loginAudit);
  $("#auditLogoutBtn").addEventListener("click", logoutAudit);
  $("#reloadAuditBtn").addEventListener("click", () => {
    refreshAuditStatus().catch(() => {});
    refreshAuditExports().catch((error) => {
      state.auditError = error.message;
      renderAudit();
    });
  });
  $("#manualAuditExportBtn").addEventListener("click", manualAuditExport);
  $("#auditList").addEventListener("click", handleAuditListAction);
  $("#stopBtn").addEventListener("click", stopService);
  $("#reloadRunningModelsBtn").addEventListener("click", refreshStatus);
  $("#runningModelList").addEventListener("click", handleRunningModelAction);
  $("#jobList").addEventListener("click", handleDownloadJobAction);
  $("#resolveModelLinkBtn").addEventListener("click", resolveModelLink);
  $("#downloadForm").addEventListener("submit", downloadModel);
  $("#downloadQuantFinder")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-quant-search]");
    if (!button) return;
    openQuantSearch(button.dataset.quantSearch, button.dataset.quantFilter);
  });
  $("#startForm").addEventListener("submit", startService);
  $("#serviceJobList").addEventListener("click", handleServiceJobAction);
  $("#testForm").addEventListener("submit", testService);
  $("#networkAccess").addEventListener("change", renderNetworkNote);
  $("#servicePort").addEventListener("input", renderNetworkNote);
  ["#startModel", "#maxModelLen", "#maxNumSeqs", "#gpuMemoryUtilization", "#gpuLayers", "#batchSize", "#ubatchSize", "#loadFormat", "#cacheTypeK", "#cacheTypeV", "#multiGpuMode", "#tensorSplit", "#mainGpu", "#textOnlyMode"].forEach((selector) => {
    const node = $(selector);
    if (!node) return;
    node.addEventListener("input", updateMemoryEstimate);
    node.addEventListener("change", updateMemoryEstimate);
  });
  $("#startModel").addEventListener("input", () => {
    updateGgufModeState();
    updateReasoningNote();
    updateTextOnlyNote();
  });
  $("#loadFormat").addEventListener("change", updateGgufModeState);
  $("#textOnlyMode")?.addEventListener("change", updateTextOnlyNote);
  $("#tensorSplit").addEventListener("input", () => {
    state.tensorSplitTouched = true;
    updateSplitPreview();
  });
  $("#clientPreset").addEventListener("change", () => {
    state.reasoningParserTouched = false;
    updateReasoningNote();
  });
  $("#reasoningParser").addEventListener("change", () => {
    state.reasoningParserTouched = $("#reasoningParser").value !== "auto";
    updateReasoningNote();
  });
  $("#contextPresetButtons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-context-preset]");
    if (!button) return;
    $("#maxModelLen").value = button.dataset.contextPreset;
    updateMemoryEstimate();
  });
  ["#downloadDeveloper", "#downloadVersion", "#downloadSpec", "#downloadPrecision", "#downloadSource"].forEach((selector) => {
    $(selector).addEventListener("change", updateDownloadPreset);
  });
  ["#downloadModel", "#downloadPrecision", "#downloadSource"].forEach((selector) => {
    $(selector)?.addEventListener("change", scheduleDownloadEstimate);
  });
  $("#downloadModel")?.addEventListener("input", scheduleDownloadEstimate);
  $("#downloadModel")?.addEventListener("input", syncDownloadOutputNameFromModel);
  $("#downloadOutputName")?.addEventListener("input", (event) => {
    if (event.currentTarget.value.trim()) {
      event.currentTarget.dataset.userEdited = "true";
    } else {
      delete event.currentTarget.dataset.userEdited;
      syncDownloadOutputNameFromModel();
    }
  });
  $("#downloadQueueMode")?.addEventListener("change", saveDownloadQueueMode);
  $("#multiGpuMode").addEventListener("change", () => {
    updateParallelDefaults();
    renderMultiGpuModeGuide();
  });
  $("#mainGpu").addEventListener("input", () => {
    renderHeteroPlan();
    updateMemoryEstimate();
  });
  $("#gpuMemoryUtilization").addEventListener("input", renderHeteroPlan);
  $("#gpuPicker").addEventListener("change", (event) => {
    if (event.target.name !== "gpuDeviceIds") return;
    state.gpuSelectionTouched = true;
    state.selectedGpuIds = new Set(getSelectedGpuIds());
    updateParallelDefaults();
  });
}

function syncUiPreferenceControls() {
  const themeValue = $("#themeMode")?.value;
  if (themeValue && themeValue !== state.uiPrefs.theme) {
    state.uiPrefs.theme = themeValue;
    localStorage.setItem("llamaThemeMode", themeValue);
    applyThemeMode();
  }
  const languageValue = $("#languageMode")?.value;
  if (languageValue && languageValue !== state.uiPrefs.language) {
    state.uiPrefs.language = languageValue;
    localStorage.setItem("llamaLanguageMode", languageValue);
    applyLanguageMode();
  }
}

function initUiPreferences() {
  const theme = ["auto", "light", "dark"].includes(state.uiPrefs.theme) ? state.uiPrefs.theme : "auto";
  const language = ["auto", "zh-CN", "en-US"].includes(state.uiPrefs.language) ? state.uiPrefs.language : "auto";
  state.uiPrefs.theme = theme;
  state.uiPrefs.language = language;
  if ($("#themeMode")) $("#themeMode").value = theme;
  if ($("#languageMode")) $("#languageMode").value = language;
  applyThemeMode();
  applyLanguageMode();
}

function applyThemeMode() {
  const mode = ["auto", "light", "dark"].includes(state.uiPrefs.theme) ? state.uiPrefs.theme : "auto";
  document.documentElement.dataset.theme = mode;
  if ($("#themeMode")) $("#themeMode").value = mode;
}

function effectiveLanguage() {
  if (state.uiPrefs.language === "zh-CN" || state.uiPrefs.language === "en-US") return state.uiPrefs.language;
  return String(navigator.language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

function applyLanguageMode() {
  const mode = effectiveLanguage();
  document.documentElement.lang = mode;
  document.body?.setAttribute("data-language", mode);
  if ($("#languageMode")) $("#languageMode").value = state.uiPrefs.language;
  translateVisibleText();
  translateUiAttributes();
  updateTextOnlyNote();
}

function translateVisibleText(root = document.body) {
  if (!root) return;
  const dictionary = effectiveLanguage() === "en-US" ? EN_TEXT : ZH_TEXT;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, code, pre, .logs-box, .audit-markdown, [data-no-i18n], i[data-lucide]")) {
        return NodeFilter.FILTER_REJECT;
      }
      return dictionary[node.nodeValue.trim()] ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    const raw = node.nodeValue;
    const leading = raw.match(/^\s*/)?.[0] || "";
    const trailing = raw.match(/\s*$/)?.[0] || "";
    const translated = dictionary[raw.trim()];
    if (translated) node.nodeValue = `${leading}${translated}${trailing}`;
  });
}

function translateUiAttributes() {
  const en = effectiveLanguage() === "en-US";
  const attrText = {
    modelPickerSearch: en ? "Search local, cached, or online models" : "搜索本地、缓存或在线模型",
    refreshBtn: en ? "Refresh" : "刷新",
    modelPickerRefresh: en ? "Refresh model list" : "刷新模型列表",
    runnableOnly: en ? "Only show GGUF models llama.cpp can launch directly" : "仅显示 llama.cpp 可直接启动的 GGUF 模型",
  };
  if ($("#modelPickerSearch")) $("#modelPickerSearch").placeholder = attrText.modelPickerSearch;
  if ($("#refreshBtn")) $("#refreshBtn").title = attrText.refreshBtn;
  if ($("#modelPickerRefresh")) $("#modelPickerRefresh").title = attrText.modelPickerRefresh;
  if ($("#modelPickerRunnableOnly")) $("#modelPickerRunnableOnly").title = attrText.runnableOnly;
  if ($("#remoteRunnableOnly")) $("#remoteRunnableOnly").title = attrText.runnableOnly;
  renderRunnableFilterToggles();
}

function showView(view, updateHash = true) {
  const known = new Set(["service", "models", "download", "exposure", "external-access", "tools", "stats", "audit", "logs"]);
  const next = known.has(view) ? view : "service";
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === next);
  });
  document.querySelectorAll("[data-view]").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === next);
  });
  if (updateHash && location.hash !== `#${next}`) {
    history.pushState(null, "", `#${next}`);
  }
  if (next === "models" && !state.remoteModels.length && !state.remoteError) {
    refreshRemoteModels().catch((error) => {
      state.remoteError = error.message;
      renderRemoteModels();
    });
  }
  if (next === "exposure") {
    refreshServiceExposure().catch(() => {});
    refreshServiceClients().catch(() => {});
  }
  if (next === "external-access") refreshExternalAccess().catch(() => {});
  if (next === "tools") refreshToolData().catch(() => {});
  if (next === "stats") refreshStats().catch(() => {});
  if (next === "audit") {
    refreshAuditStatus().catch(() => {});
    if (state.auditToken) refreshAuditExports().catch(() => {});
    renderAudit();
  }
}

function initDownloadSelectors() {
  setSelectOptions($("#downloadDeveloper"), unique(MODEL_PRESETS.map((item) => item.developer)));
  syncPresetSelects("developer");
  $("#downloadSource").value = "huggingface";
  updateDownloadPreset();
}

function syncPresetSelects(changedField) {
  const developer = $("#downloadDeveloper").value;
  const version = $("#downloadVersion").value;
  const spec = $("#downloadSpec").value;

  if (changedField === "developer") {
    const versions = unique(MODEL_PRESETS.filter((item) => item.developer === developer).map((item) => item.version));
    setSelectOptions($("#downloadVersion"), versions);
  }

  const activeVersion = $("#downloadVersion").value || version;
  if (changedField === "developer" || changedField === "version") {
    const specs = unique(MODEL_PRESETS
      .filter((item) => item.developer === developer && item.version === activeVersion)
      .map((item) => item.spec));
    setSelectOptions($("#downloadSpec"), specs);
  } else if (spec && !$("#downloadSpec").value) {
    $("#downloadSpec").value = spec;
  }

  setSelectOptions($("#downloadPrecision"), PRECISION_PRESETS.map((item) => item.label), PRECISION_PRESETS.map((item) => item.value));
}

function updateDownloadPreset(event) {
  const changedField = event?.target?.id || "";
  if (changedField === "downloadDeveloper") syncPresetSelects("developer");
  if (changedField === "downloadVersion") syncPresetSelects("version");

  const preset = getSelectedPreset();
  const presetSelectionChanged = !event || ["downloadDeveloper", "downloadVersion", "downloadSpec"].includes(changedField);
  if (presetSelectionChanged && preset?.precision && $("#downloadPrecision")) {
    $("#downloadPrecision").value = preset.precision;
  }
  const precision = getSelectedPrecision();
  const source = $("#downloadSource").value || "huggingface";
  const repo = preset ? preset.repo : "";
  if (presetSelectionChanged && repo) {
    $("#downloadModel").value = repo;
    setDownloadOutputName(deriveName(repo));
  }

  const sourceHint = DOWNLOAD_SOURCES[source]?.hint || "";
  const wantsQuant = precision.value !== "base" && Boolean(precision.quantFilter);
  const precisionHint = precision.value === "base"
    ? "原始仓库可能不是 GGUF；llama.cpp 建议优先选择 GGUF/Q 格式。"
    : wantsQuant
      ? `${precision.label} 会作为 HF 文件过滤或在线搜索条件；不会把基础仓库自动转换成量化仓库。`
      : `当前模型解析出的精度：${precision.label || precision.value}。`;
  const selectionHint = preset?.note || "当前下拉项来自已选择的在线模型；仍可手动修改模型 ID 和保存名称。";
  $("#downloadPresetHint").textContent = [sourceHint, precisionHint, selectionHint].filter(Boolean).join(" ");
  renderQuantFinder(preset, precision);
  scheduleDownloadEstimate();
}

function getSelectedPreset() {
  const developer = $("#downloadDeveloper").value;
  const version = $("#downloadVersion").value;
  const spec = $("#downloadSpec").value;
  return MODEL_PRESETS.find((item) => item.developer === developer && item.version === version && item.spec === spec);
}

function unique(values) {
  return Array.from(new Set(values));
}

function setSelectOptions(select, labels, values = labels) {
  const previous = select.value;
  select.innerHTML = labels.map((label, index) => `<option value="${escapeAttr(values[index])}">${escapeHtml(label)}</option>`).join("");
  if (values.includes(previous)) select.value = previous;
}

function getSelectedPrecision() {
  const value = $("#downloadPrecision").value;
  const known = PRECISION_PRESETS.find((item) => item.value === value);
  if (known) return known;
  const normalized = normalizeDownloadQuantValue(value);
  if (normalized === "BASE") {
    return {
      value: "base",
      label: selectedOptionLabel($("#downloadPrecision")) || "原始 BF16/FP16",
      quantFilter: "",
      launchQuantization: "",
    };
  }
  return {
    value,
    label: selectedOptionLabel($("#downloadPrecision")) || value || "未标注",
    quantFilter: normalized.toLowerCase(),
    launchQuantization: "",
  };
}

function selectedOptionLabel(select) {
  return select.options[select.selectedIndex]?.textContent?.trim() || "";
}

function setDownloadOutputName(name) {
  const input = $("#downloadOutputName");
  if (!input) return;
  input.value = name || "";
  delete input.dataset.userEdited;
}

function syncDownloadOutputNameFromModel() {
  const input = $("#downloadOutputName");
  if (!input || input.dataset.userEdited === "true") return;
  const model = $("#downloadModel").value.trim();
  input.value = model ? deriveName(model) : "";
}

function renderQuantFinder(preset, precision) {
  const finder = $("#downloadQuantFinder");
  if (!finder) return;
  const wantsQuant = precision && precision.value !== "base" && Boolean(precision.quantFilter);
  const repo = preset?.repo || $("#downloadModel")?.value.trim() || "";
  const leaf = repo.split("/").filter(Boolean).pop() || "";
  if (!wantsQuant || !leaf) {
    finder.hidden = true;
    finder.innerHTML = "";
    return;
  }
  finder.hidden = false;
  finder.innerHTML = `<button type="button" class="ghost-mini-button" data-quant-search="${escapeAttr(leaf)}" data-quant-filter="${escapeAttr(precision.quantFilter)}"><i data-lucide="search"></i><span>在线查找 ${escapeHtml(leaf)} 的 ${escapeHtml(precision.label)} GGUF</span></button>`;
  renderIcons();
}

function openQuantSearch(searchTerm, quantFilter) {
  const sizeFilter = $("#remoteSizeFilter");
  if (sizeFilter) sizeFilter.value = "";
  if ($("#remoteSearch")) $("#remoteSearch").value = searchTerm;
  if ($("#remoteQuantFilter")) $("#remoteQuantFilter").value = quantFilter || "gguf";
  if ($("#remoteFeature")) $("#remoteFeature").value = "quantized";
  if ($("#remoteSort")) $("#remoteSort").value = "downloads";
  showView("models");
  refreshRemoteModels().catch((error) => {
    state.remoteError = error.message;
    renderRemoteModels();
  });
}

function applyDownloadModelSelection(model) {
  const modelId = model.model || model.id || "";
  const inferred = inferDownloadSelection(modelId, model.author, model.source);
  const selection = { ...inferred, ...(model.selection || {}) };
  const options = selection.options || {};
  const developer = selection.developer || inferred.developer;
  const modelVersion = selection.modelVersion || inferred.modelVersion;
  const spec = selection.spec || inferred.spec;
  const precision = selection.precision || inferred.precision;

  setSelectOptions($("#downloadDeveloper"), normalizedOptions(options.developers, developer));
  setSelectOptions($("#downloadVersion"), normalizedOptions(options.modelVersions, modelVersion));
  setSelectOptions($("#downloadSpec"), normalizedOptions(options.specs, spec));
  const precisionOptions = normalizedPrecisionOptions([...(options.precisions || []), ...(model.quantFormats || [])], precision);
  const selectedPrecision = chooseDownloadPrecision(precision, precisionOptions, $("#remoteQuantFilter")?.value || "");
  state.downloadPrecisionOptions = precisionOptions;
  setSelectOptions($("#downloadPrecision"), precisionOptions);
  $("#downloadDeveloper").value = developer;
  $("#downloadVersion").value = modelVersion;
  $("#downloadSpec").value = spec;
  $("#downloadPrecision").value = selectedPrecision;
  $("#downloadSource").value = selection.source || model.source || "huggingface";

  const sourceHint = DOWNLOAD_SOURCES[$("#downloadSource").value]?.hint || "";
  const summary = normalizeSummary(model.summary);
  $("#downloadPresetHint").textContent = [
    `已按当前模型更新选择项：${developer} / ${modelVersion} / ${spec} / ${selectedPrecision}。`,
    precisionOptions.length > 1 ? `该仓库可选量化：${precisionOptions.join(" / ")}。` : "",
    model.gated ? "该仓库可能需要访问令牌。" : "",
    sourceHint,
    summary,
  ].filter(Boolean).join(" ");
  renderQuantFinder(null, getSelectedPrecision());
  scheduleDownloadEstimate();
}

function downloadIncludePatternsForPrecision(precision) {
  const value = normalizeDownloadQuantValue(precision);
  if (!value || value === "BASE" || value === "quantized") return [];
  if (value === "GGUF") return ["*.gguf"];
  if (value === "Q4") return ["*Q4*.gguf", "*IQ4*.gguf"];
  if (value === "IQ4") return ["*IQ4*.gguf"];
  if (/^I?Q[2-8](?:_[A-Z0-9]+)*$/.test(value)) return [`*${value}*.gguf`];
  return [];
}

function updateDownloadPlanPreview(extra = {}) {
  const root = $("#downloadPlanPreview");
  if (!root) return;
  const model = $("#downloadModel")?.value.trim() || "";
  if (!model) {
    root.innerHTML = "";
    root.hidden = true;
    return;
  }
  const source = $("#downloadSource")?.value || "huggingface";
  const precision = $("#downloadPrecision")?.value || "";
  const normalized = normalizeDownloadQuantValue(precision);
  const precisionLabel = selectedOptionLabel($("#downloadPrecision")) || normalized || "未指定";
  const includePatterns = Array.isArray(extra.includePatterns) ? extra.includePatterns : downloadIncludePatternsForPrecision(precision);
  const sourceLabel = DOWNLOAD_SOURCES[source]?.label || source;
  const outputName = $("#downloadOutputName")?.value.trim() || deriveName(model);
  let behavior = "";
  let stateClass = "info";
  if (source !== "huggingface") {
    behavior = "ModelScope CLI 暂不支持按精度过滤，管理器会下载该模型仓库到本地目录。";
  } else if (includePatterns.length) {
    const matched = Number(extra.matchedFiles);
    const total = Number(extra.totalFiles);
    const matchText = Number.isFinite(matched) && Number.isFinite(total)
      ? matched > 0
        ? `当前元数据匹配 ${matched}/${total} 个文件。`
        : `当前元数据没有匹配文件，请先确认仓库内真的存在 ${precisionLabel}。`
      : "下载时会给 hf CLI 附加 include 过滤。";
    stateClass = matched === 0 ? "warn" : "ok";
    behavior = `只下载匹配 ${includePatterns.join(", ")} 的文件。${matchText}`;
  } else if (normalized && normalized !== "BASE") {
    stateClass = "warn";
    behavior = `${precisionLabel} 不会自动改写仓库 ID，也没有安全的文件过滤规则；将下载整个仓库。建议先用在线列表选择真实 GGUF 量化仓库。`;
  } else {
    stateClass = "warn";
    behavior = "将下载整个仓库；如果这是 safetensors 原始权重，llama.cpp 不能直接启动，请优先选择 GGUF/Q 文件。";
  }
  root.hidden = false;
  root.dataset.state = stateClass;
  root.innerHTML = `
    <strong>下载预览</strong>
    <span>${escapeHtml(sourceLabel)} · ${escapeHtml(model)} → ${escapeHtml(outputName)}</span>
    <small>${escapeHtml(behavior)}</small>
  `;
}

function scheduleDownloadEstimate() {
  updateDownloadPlanPreview();
  if (downloadEstimateTimer) clearTimeout(downloadEstimateTimer);
  downloadEstimateTimer = setTimeout(requestDownloadEstimate, 450);
}

async function requestDownloadEstimate() {
  const box = $("#downloadEstimate");
  const textEl = $("#downloadEstimateText");
  if (!box || !textEl) return;
  const model = $("#downloadModel").value.trim();
  const source = $("#downloadSource").value || "huggingface";
  const precision = $("#downloadPrecision").value || "";
  if (!model || !model.includes("/")) {
    box.hidden = true;
    updateDownloadPlanPreview();
    return;
  }
  if (source !== "huggingface") {
    box.hidden = false;
    box.dataset.state = "info";
    textEl.textContent = "ModelScope 暂不支持下载体积预估，下载时会显示实际进度。";
    updateDownloadPlanPreview();
    return;
  }
  const seq = ++downloadEstimateSeq;
  box.hidden = false;
  box.dataset.state = "loading";
  textEl.textContent = "正在估算下载体积...";
  try {
    const params = new URLSearchParams({ model, source, precision });
    const result = await api(`/api/download/estimate?${params}`);
    if (seq !== downloadEstimateSeq) return;
    updateDownloadPlanPreview(result);
    const diskText = result.diskFreeBytes ? `模型盘剩余 ${fmtBytes(result.diskFreeBytes)}` : "";
    if (result.bytes) {
      const free = Number(result.diskFreeBytes || 0);
      const insufficient = free && result.bytes > free - Math.max(free * 0.05, 10 * 1024 ** 3);
      box.dataset.state = insufficient ? "warn" : "ok";
      const sizeText = `预计下载约 ${fmtBytes(result.bytes)}（${fmtNumber(result.fileCount || 0)} 个文件）`;
      textEl.textContent = insufficient
        ? `${sizeText}，但${diskText}，磁盘空间可能不足，请清理或换盘。`
        : `${sizeText}。${diskText ? diskText + "，空间充足。" : "请确认本地磁盘空间充足。"}`;
    } else {
      box.dataset.state = "info";
      const noMatch = Array.isArray(result.includePatterns) && result.includePatterns.length && Number(result.fileCount || 0) === 0
        ? `没有匹配 ${result.includePatterns.join(", ")} 的文件，请换真实 GGUF 仓库或改成下载整个仓库。`
        : "无法读取该仓库的文件体积（可能是 gated 或私有），下载时会显示实际进度。";
      textEl.textContent = noMatch + (diskText ? ` ${diskText}。` : "");
    }
  } catch (error) {
    if (seq !== downloadEstimateSeq) return;
    box.dataset.state = "warn";
    textEl.textContent = `体积预估失败：${error.message}`;
  }
}

async function refreshStatus() {
  state.status = await api("/api/status");
  renderStatus();
  renderNetworkNote();
  state.jobs = state.status.jobs || [];
  renderJobs();
  renderStatusInsights();
  updateSidebarFoot();
}

async function refreshServiceExposure() {
  state.serviceExposure = await api("/api/service-exposure");
  renderServiceExposure();
}

async function refreshServiceClients() {
  state.serviceClients = await api("/api/service-clients");
  renderServiceClients();
}

async function refreshJobs() {
  state.jobs = await api("/api/jobs");
  renderJobs();
}

async function loadDownloadSettings() {
  try {
    const data = await api("/api/download/settings");
    const toggle = $("#downloadQueueMode");
    if (toggle) toggle.checked = Boolean(data?.queueMode);
  } catch {
    // 设置读取失败不阻塞页面初始化
  }
}

async function saveDownloadQueueMode() {
  const toggle = $("#downloadQueueMode");
  if (!toggle) return;
  try {
    await api("/api/download/settings", {
      method: "POST",
      body: JSON.stringify({ queueMode: toggle.checked }),
    });
    notify("下载队列设置已更新", toggle.checked ? "新下载将排队顺序执行。" : "下载将并发执行。", "success");
    await refreshJobs();
  } catch (error) {
    reportActionError("保存下载队列设置失败", error);
  }
}

async function refreshModels() {
  state.models = await api("/api/models");
  renderModels();
  renderModelPicker();
  updateGgufModeState();
  updateTextOnlyNote();
  updateSidebarFoot();
}

async function refreshRemoteModels() {
  const seq = ++remoteSearchSeq;
  const root = $("#remoteModelList");
  root.innerHTML = `<div class="empty">正在联网查询模型...</div>`;
  state.remoteError = "";
  const params = new URLSearchParams({
    sort: $("#remoteSort")?.value || "downloads",
    feature: $("#remoteFeature")?.value || "all",
    search: $("#remoteSearch").value.trim(),
    limit: String(getRemoteLimit()),
    size: $("#remoteSizeFilter")?.value || "",
    quant: $("#remoteQuantFilter")?.value || "",
    freshness: $("#remoteFreshness")?.value || "auto",
  });
  try {
    const result = await api(`/api/remote-models?${params}`);
    if (seq !== remoteSearchSeq) return;
    state.remoteModels = result.models || [];
    state.remoteMeta = {
      limit: result.limit || getRemoteLimit(),
      source: result.source || "huggingface",
      sort: result.sort || $("#remoteSort")?.value || "downloads",
      feature: result.feature || $("#remoteFeature")?.value || "all",
      freshness: result.freshness || $("#remoteFreshness")?.value || "auto",
      quant: result.quant || $("#remoteQuantFilter")?.value || "",
    };
    renderRemoteModels();
    renderModelPicker();
  } catch (error) {
    if (seq !== remoteSearchSeq) return;
    state.remoteError = error.message;
    renderRemoteModels();
  }
}

function getRemoteLimit() {
  const input = $("#remoteLimit");
  const value = Number(input?.value || 48);
  const limit = Math.min(120, Math.max(12, Number.isFinite(value) ? Math.floor(value) : 48));
  if (input) input.value = String(limit);
  return limit;
}

function handleRemoteLoadMore() {
  const input = $("#remoteLimit");
  if (input) input.value = String(Math.min(120, getRemoteLimit() + 48));
  refreshRemoteModels();
}

function toggleRunnableOnly() {
  setRunnableOnly(!state.runnableOnly);
}

function setRunnableOnly(enabled) {
  state.runnableOnly = Boolean(enabled);
  localStorage.setItem("llamaRunnableOnly", state.runnableOnly ? "1" : "0");
  renderRunnableFilterToggles();
  renderRemoteModels();
  renderModelPicker();
}

function renderRunnableFilterToggles() {
  const en = effectiveLanguage() === "en-US";
  const title = en ? "Only show GGUF models llama.cpp can launch directly" : "仅显示 llama.cpp 可直接启动的 GGUF 模型";
  ["#modelPickerRunnableOnly", "#remoteRunnableOnly"].forEach((selector) => {
    const button = $(selector);
    if (!button) return;
    button.classList.toggle("active", state.runnableOnly);
    button.setAttribute("aria-pressed", state.runnableOnly ? "true" : "false");
    button.setAttribute("title", title);
  });
}

function openRunnableRemoteModels() {
  setRunnableOnly(true);
  showView("models");
  if (!state.remoteModels.length && !state.remoteError) {
    refreshRemoteModels().catch((error) => {
      state.remoteError = error.message;
      renderRemoteModels();
    });
  }
}

async function refreshModelPickerData(event) {
  const button = event?.currentTarget;
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = `<i data-lucide="refresh-cw"></i>`;
    renderIcons();
  }
  try {
    await Promise.allSettled([refreshModels(), refreshModelNotes(), refreshRemoteModels(), refreshStatus()]);
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
      renderIcons();
    }
    renderModelPicker();
  }
}

async function refreshLogs() {
  try {
    const response = await fetch("/api/logs?tail=220");
    const text = await response.text();
    $("#logsBox").textContent = text.trim() || "暂无日志";
  } catch (error) {
    $("#logsBox").textContent = error.message;
  }
}

async function refreshStats() {
  state.stats = await api("/api/stats");
  renderStats();
  renderStatusInsights();
}

async function refreshExternalAccess() {
  state.externalAccess = await api("/api/external-access?limit=220");
  renderExternalAccess();
}

async function refreshAuditStatus() {
  state.auditStatus = await api("/api/audit/status");
  renderAudit();
}

async function refreshAuditExports() {
  if (!state.auditToken) {
    renderAudit();
    return;
  }
  try {
    const result = await auditApi("/api/audit/exports");
    state.auditExports = result.exports || [];
    state.auditError = "";
    renderAudit();
  } catch (error) {
    if (error.status === 401) {
      state.auditToken = "";
      localStorage.removeItem("auditToken");
    }
    state.auditError = error.message;
    renderAudit();
    throw error;
  }
}

async function refreshToolData() {
  await Promise.all([
    refreshHealth().catch((error) => renderToolError("#healthGrid", error)),
    refreshProfiles().catch((error) => renderToolError("#profileList", error)),
    refreshAutomationSettings().catch((error) => renderToolError("#automationStatus", error)),
    refreshConnectionGuide().catch((error) => renderToolError("#connectionGuide", error)),
    refreshCompressionInsights().catch((error) => renderToolError("#compressionInsights", error)),
    refreshModelNotes().catch((error) => renderToolError("#modelNotesList", error)),
  ]);
  renderJobs();
}

function renderToolError(selector, error) {
  const root = $(selector);
  if (!root) return;
  root.innerHTML = `<div class="empty compact">读取失败：${escapeHtml(error?.message || String(error || ""))}</div>`;
}

async function refreshHealth(event) {
  const clearBusy = event?.currentTarget ? setButtonBusy(event.currentTarget, "检查中...") : () => {};
  try {
    state.health = await api("/api/tools/health");
    renderHealth();
  } finally {
    clearBusy();
  }
}

async function refreshProfiles() {
  state.profiles = await api("/api/tools/profiles");
  renderProfiles();
}

async function refreshAutomationSettings() {
  state.automationSettings = await api("/api/tools/automation-settings");
  renderAutomationSettings();
  renderStatusInsights();
}

async function refreshConnectionGuide(event) {
  const clearBusy = event?.currentTarget ? setButtonBusy(event.currentTarget, "刷新中...") : () => {};
  try {
    state.connectionGuide = await api("/api/connection-guide");
    renderConnectionGuide();
  } finally {
    clearBusy();
  }
}

async function refreshCompressionInsights(event) {
  const clearBusy = event?.currentTarget ? setButtonBusy(event.currentTarget, "刷新中...") : () => {};
  try {
    state.compressionInsights = await api("/api/claude/context-compression/insights");
    renderCompressionInsights();
  } finally {
    clearBusy();
  }
}

async function refreshModelNotes() {
  state.modelNotes = await api("/api/tools/model-notes");
  renderModelNotes();
  renderModelPicker();
}

function renderHealth() {
  toolPanelRenderer.renderHealth();
}

function renderProfiles() {
  profileRenderer.renderProfiles();
}

function renderServiceProfileOptions(profiles = [...(state.profiles.builtin || []), ...(state.profiles.profiles || [])]) {
  profileRenderer.renderServiceProfileOptions(profiles);
}

function renderServiceProfileSummary() {
  profileRenderer.renderServiceProfileSummary();
}

function applySelectedServiceProfile() {
  const select = $("#serviceProfileSelect");
  const profiles = [...(state.profiles.builtin || []), ...(state.profiles.profiles || [])];
  const profile = profiles.find((item) => item.id === select?.value);
  if (!profile) return;
  applyLaunchProfile(profile.config || {});
  notify("已套用启动方案", profile.name, "success");
}

async function saveCurrentProfile(event) {
  const clearBusy = setButtonBusy(event.currentTarget, "保存中...");
  try {
    const name = $("#profileNameInput").value.trim() || `启动方案 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    const description = $("#profileDescInput").value.trim();
    const result = await api("/api/tools/profiles", {
      method: "POST",
      body: JSON.stringify({ name, description, config: getLaunchFormConfig() }),
    });
    notify("启动方案已保存", result.profile?.name || name, "success");
    $("#profileNameInput").value = "";
    $("#profileDescInput").value = "";
    await refreshProfiles();
  } catch (error) {
    reportActionError("启动方案保存失败", error);
  } finally {
    clearBusy();
  }
}

async function handleProfileAction(event) {
  const button = event.target.closest("[data-profile-action]");
  if (!button) return;
  const profiles = [...(state.profiles.builtin || []), ...(state.profiles.profiles || [])];
  const profile = profiles.find((item) => item.id === button.dataset.profileId);
  if (!profile) return;
  if (button.dataset.profileAction === "apply") {
    applyLaunchProfile(profile.config || {});
    notify("已套用启动方案", profile.name, "success");
    showView("service");
    return;
  }
  const clearBusy = setButtonBusy(button, "删除中...");
  try {
    await api(`/api/tools/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
    notify("启动方案已删除", profile.name, "success");
    await refreshProfiles();
  } catch (error) {
    reportActionError("启动方案删除失败", error);
  } finally {
    clearBusy();
  }
}

function getLaunchFormConfig() {
  const form = new FormData($("#startForm"));
  const payload = Object.fromEntries(form.entries());
  payload.gpuDeviceIds = form.getAll("gpuDeviceIds");
  payload.noMmap = form.get("noMmap") === "on";
  payload.textOnlyMode = form.get("textOnlyMode") === "on";
  payload.languageModelOnly = payload.textOnlyMode;
  return payload;
}

function applyLaunchProfile(config = {}) {
  const set = (selector, value) => {
    const element = $(selector);
    if (element && value !== undefined && value !== null && value !== "") element.value = value;
  };
  set("#startModel", config.model);
  set("#servedName", config.name);
  set("#servicePort", config.port);
  set("#maxModelLen", config.maxModelLen);
  set("#maxNumSeqs", config.maxNumSeqs);
  set("#gpuMemoryUtilization", config.gpuMemoryUtilization);
  set("#gpuLayers", config.gpuLayers);
  set("#batchSize", config.batchSize);
  set("#ubatchSize", config.ubatchSize);
  set("#loadFormat", config.loadFormat);
  set("#cacheTypeK", config.cacheTypeK);
  set("#cacheTypeV", config.cacheTypeV);
  set("#flashAttention", config.flashAttention);
  set("#networkAccess", config.networkAccess);
  set("#clientPreset", config.clientPreset);
  set("#reasoningMode", config.reasoning);
  set("#reasoningParser", config.reasoningFormat);
  set("#multiGpuMode", config.multiGpuMode);
  set("#tensorSplit", config.tensorSplit);
  set("#mainGpu", config.mainGpu);
  const noMmap = $("#startForm [name='noMmap']");
  if (noMmap && config.noMmap !== undefined) noMmap.checked = Boolean(config.noMmap);
  const textOnlyMode = $("#textOnlyMode");
  if (textOnlyMode && (config.textOnlyMode !== undefined || config.languageModelOnly !== undefined)) {
    textOnlyMode.checked = config.textOnlyMode !== false && config.languageModelOnly !== false;
  }
  if (Array.isArray(config.gpuDeviceIds) && config.gpuDeviceIds.length) {
    state.selectedGpuIds = new Set(config.gpuDeviceIds.map(String));
    state.gpuSelectionTouched = true;
    renderGpuPicker();
  }
  updateGgufModeState();
  updateReasoningNote();
  updateTextOnlyNote();
  updateParallelDefaults();
  updateMemoryEstimate();
  renderNetworkNote();
  renderMultiGpuModeGuide();
}

async function runModelCheck(event) {
  const clearBusy = setButtonBusy(event.currentTarget, "检查中...");
  try {
    const model = $("#modelCheckInput").value.trim() || $("#startModel").value.trim();
    state.modelCheck = await api("/api/tools/model-check", {
      method: "POST",
      body: JSON.stringify({ ...getLaunchFormConfig(), model }),
    });
    renderModelCheck();
  } catch (error) {
    reportActionError("模型兼容性检查失败", error);
  } finally {
    clearBusy();
  }
}

function renderModelCheck() {
  toolPanelRenderer.renderModelCheck();
}

async function refreshLogSummary(event) {
  const clearBusy = event?.currentTarget ? setButtonBusy(event.currentTarget, "摘要中...") : () => {};
  try {
    state.logSummary = await api("/api/tools/log-summary?tail=420");
    renderLogSummary();
  } finally {
    clearBusy();
  }
}

function renderLogSummary() {
  toolPanelRenderer.renderLogSummary();
}

function renderAutomationSettings() {
  toolPanelRenderer.renderAutomationSettings();
}

async function saveAutomationSettings(event) {
  const clearBusy = setButtonBusy(event.currentTarget, "保存中...");
  try {
    state.automationSettings = await api("/api/tools/automation-settings", {
      method: "POST",
      body: JSON.stringify({
        idleUnloadEnabled: $("#idleUnloadEnabled").checked,
        idleMinutes: Number($("#idleMinutes").value || 30),
        vramGuardEnabled: $("#vramGuardEnabled").checked,
        vramPercent: Number($("#vramPercent").value || 94),
        vramAction: $("#vramAction").value,
      }),
    });
    renderAutomationSettings();
    notify("自动保护设置已保存", "后台监控会按新设置执行。", "success");
  } catch (error) {
    reportActionError("自动保护保存失败", error);
  } finally {
    clearBusy();
  }
}

async function startBenchmark(event) {
  event.preventDefault();
  const clearBusy = setButtonBusy(event.submitter, "创建测速...");
  try {
    const result = await api("/api/tools/benchmark", {
      method: "POST",
      body: JSON.stringify({
        model: $("#benchmarkModel").value.trim() || $("#testModel").value.trim(),
        requests: Number($("#benchmarkRequests").value || 3),
        maxTokens: Number($("#benchmarkMaxTokens").value || 160),
        prompt: $("#benchmarkPrompt").value,
        port: Number($("#servicePort").value || 8080),
      }),
    });
    notify("测速任务已创建", result.job?.title || "Benchmark", "success");
    await refreshJobs();
  } catch (error) {
    reportActionError("测速任务创建失败", error);
  } finally {
    clearBusy();
  }
}

function renderConnectionGuide() {
  toolPanelRenderer.renderConnectionGuide();
}

function renderCompressionInsights() {
  toolPanelRenderer.renderCompressionInsights();
}

function renderModelNotes() {
  toolPanelRenderer.renderModelNotes();
}

async function saveModelNote(event) {
  const clearBusy = setButtonBusy(event.currentTarget, "保存中...");
  try {
    const result = await api("/api/tools/model-notes", {
      method: "POST",
      body: JSON.stringify({
        model: $("#modelNoteModel").value.trim() || $("#startModel").value.trim(),
        tags: $("#modelNoteTags").value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
        favorite: $("#modelNoteFavorite").checked,
        note: $("#modelNoteText").value,
      }),
    });
    notify("模型标签已保存", result.note?.model || "", "success");
    await refreshModelNotes();
  } catch (error) {
    reportActionError("模型标签保存失败", error);
  } finally {
    clearBusy();
  }
}

async function handleModelNoteAction(event) {
  const button = event.target.closest("[data-note-action]");
  if (!button) return;
  if (button.dataset.noteAction === "use") {
    selectLaunchModel(button.dataset.model || "", { silent: false });
    return;
  }
  const clearBusy = setButtonBusy(button, "删除中...");
  try {
    await api(`/api/tools/model-notes/${encodeURIComponent(button.dataset.noteKey || "")}`, { method: "DELETE" });
    await refreshModelNotes();
  } catch (error) {
    reportActionError("模型标签删除失败", error);
  } finally {
    clearBusy();
  }
}

async function handleBenchmarkJobAction(event) {
  const button = event.target.closest("[data-benchmark-action]");
  if (!button) return;
  const job = state.jobs.find((item) => item.id === button.dataset.job);
  if (job?.meta?.benchmark) showTestResult(job.meta.benchmark);
}

function renderStatus() {
  runtimeStatusRenderer.renderStatusSummary();
  renderRunningModels();
  renderModelPicker();
  renderGpuPicker();
  updateSplitPreview();
  renderMultiGpuModeGuide();
  updateMemoryEstimate();
}

function renderStatusInsights() {
  runtimeStatusRenderer.renderStatusInsights();
}

function setMetricState(strongId, stateName) {
  const metric = $(`#${strongId}`)?.closest(".metric");
  if (!metric) return;
  metric.dataset.state = stateName;
}

function getLiveTokensPerSecond() {
  const totals = state.stats?.totals || {};
  const candidates = [
    totals.speed?.tokensPerSecond,
    totals.speed?.generationTokensPerSecond,
    totals.speed?.outputTokensPerSecond,
    state.stats?.live?.speed?.tokensPerSecond,
    state.stats?.live?.speed?.generationTokensPerSecond,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function renderRunningModels() {
  runtimeStatusRenderer.renderRunningModels();
}

function renderCompatEndpoints(endpoint) {
  return runtimeStatusRenderer.renderCompatEndpoints(endpoint);
}

function formatContextUsage(used, capacity, percent) {
  return runtimeStatusRenderer.formatContextUsage(used, capacity, percent);
}

function renderGpuPicker() {
  runtimeStatusRenderer.renderGpuPicker();
}

function getVisibleGpus() {
  const gpu = state.status?.gpu;
  if (!gpu?.ok) return [];
  if (Array.isArray(gpu.gpus) && gpu.gpus.length) return gpu.gpus.map((item) => ({ ...item, id: String(item.id ?? item.index) }));
  return [{ ...gpu, id: "0", index: 0 }];
}

function getSelectedGpuIds() {
  return Array.from(document.querySelectorAll("[name='gpuDeviceIds']:checked")).map((input) => input.value);
}

function getSelectedGpuObjects() {
  const gpus = getVisibleGpus();
  if (!gpus.length) return [];
  const selectedIds = getSelectedGpuIds();
  if (!selectedIds.length) return [gpus[0]];
  const selected = gpus.filter((gpu) => selectedIds.includes(String(gpu.id)));
  return selected.length ? selected : [gpus[0]];
}

function updateMemoryEstimate() {
  const root = $("#memoryEstimate");
  if (!root) return;

  const estimate = estimateMemoryUsage();
  updateContextPresetState(estimate.contextTokens);

  if (!estimate.paramsB) {
    root.innerHTML = `<div class="empty compact">没有从模型名里识别到 7B、14B、27B 这类规格。填入模型 ID 或本地路径后会自动估算。</div>`;
    $("#memoryGpuBars").innerHTML = "";
    $("#memoryEstimateNote").innerHTML = `
      <strong class="warn">等待模型规格</strong>
      <span>显存估算依赖参数量；如果模型名没有规格，可以把保存名称改成包含 27B、70B 这样的标记。</span>
    `;
    return;
  }

  renderLlamaMemoryEstimate(estimate);
  scheduleServerMemoryEstimate(estimate);
}

function renderLlamaMemoryEstimate(estimate) {
  const root = $("#memoryEstimate");
  if (!root) return;
  root.innerHTML = [
    { label: "模型规模", value: `${formatGbNumber(estimate.paramsB)}B`, detail: estimate.archLabel },
    { label: "GPU 权重", value: `${formatGbNumber(estimate.weightsGb)} GB`, detail: `${estimate.quantLabel} · 总 ${formatGbNumber(estimate.totalWeightsGb)} GB` },
    { label: "GPU KV cache", value: `${formatGbNumber(estimate.kvGb)} GB`, detail: `${fmtNumber(estimate.contextTokens)} tokens · ${estimate.kvLabel}` },
    { label: "GPU 分摊", value: estimate.gpuSummaryValue, detail: estimate.splitLabel },
    { label: "系统内存", value: `${formatGbNumber(estimate.systemMemoryResidentGb)} GB`, detail: estimate.systemMemoryResidentGb > 0 ? "未进显存的层/KV 会走 RAM，速度会下降" : "当前预计全量在 GPU" },
  ].map((item) => `
    <div class="estimate-item">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
      <small>${escapeHtml(item.detail)}</small>
    </div>
  `).join("");

  $("#memoryGpuBars").innerHTML = renderGpuMemoryBars(estimate);
  $("#memoryEstimateNote").innerHTML = renderMemoryEstimateNote(estimate);
}

function scheduleServerMemoryEstimate(estimate) {
  if (!estimate?.paramsB) return;
  if (memoryEstimateTimer) clearTimeout(memoryEstimateTimer);
  const requestId = ++memoryEstimateSeq;
  const payload = buildLlamaMemoryEstimatePayload(estimate);
  memoryEstimateTimer = setTimeout(async () => {
    try {
      const result = await api("/api/memory-estimate", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (requestId !== memoryEstimateSeq) return;
      renderLlamaMemoryEstimate(mergeLlamaServerMemoryEstimate(estimate, result));
    } catch {
      // Keep the immediate local estimate visible if the backend estimate is unavailable.
    }
  }, 250);
}

function buildLlamaMemoryEstimatePayload(estimate) {
  return {
    paramsB: estimate.paramsB,
    contextTokens: estimate.contextTokens,
    bytesPerParam: estimate.bytesPerParam,
    kvBytes: estimate.kvBytes,
    arch: estimate.arch,
    selectedGpus: estimate.selectedGpus,
    gpuMemoryUtilization: estimate.utilization,
    gpuLayers: $("#gpuLayers")?.value || "all",
    tensorSplit: $("#tensorSplit")?.value || "",
    multimodalReserveGb: estimate.multimodalReserveGb,
  };
}

function mergeLlamaServerMemoryEstimate(estimate, result) {
  const plan = result?.plan;
  if (!plan) return estimate;
  const allocations = Array.isArray(plan.allocations) && plan.allocations.length ? plan.allocations : estimate.gpuAllocations;
  const selectedGpus = Array.isArray(plan.selectedGpus) && plan.selectedGpus.length ? plan.selectedGpus : estimate.selectedGpus;
  return {
    ...estimate,
    serverBacked: true,
    serverRecommendations: result.recommendations || null,
    status: plan.status || estimate.status,
    totalWeightsGb: plan.totalWeightsGb ?? estimate.totalWeightsGb,
    weightsGb: plan.gpuWeightsGb ?? estimate.weightsGb,
    cpuWeightsGb: plan.cpuWeightsGb ?? estimate.cpuWeightsGb,
    totalKvGb: plan.totalKvGb ?? estimate.totalKvGb,
    kvGb: plan.gpuKvGb ?? plan.kvGb ?? estimate.kvGb,
    cpuKvGb: plan.cpuKvGb ?? estimate.cpuKvGb,
    overheadGb: plan.overheadGb ?? estimate.overheadGb,
    totalGb: plan.totalGpuGb ?? estimate.totalGb,
    perGpuGb: plan.peakGpuGb ?? estimate.perGpuGb,
    peakGpuGb: plan.peakGpuGb ?? estimate.peakGpuGb,
    gpuAllocations: allocations,
    selectedGpus,
    requestedGpuLayers: plan.requestedGpuLayers ?? estimate.requestedGpuLayers,
    totalLayers: plan.totalLayers ?? estimate.totalLayers,
    recommendedGpuLayers: plan.recommendedGpuLayers ?? estimate.recommendedGpuLayers,
    systemMemoryResidentGb: (plan.cpuWeightsGb || 0) + (plan.cpuKvGb || 0),
    splitLabel: `${estimate.splitLabel} · 后端校准`,
  };
}

function updateGgufModeState() {
  const section = $("#ggufSection");
  if (!section) return;

  const model = $("#startModel")?.value.trim() || "";
  const local = getLocalModelForInput(model);

  const selectedFile = local?.ggufFiles?.[0];
  const fileText = selectedFile
    ? `将自动使用 ${selectedFile.name || selectedFile.path}。`
    : model.toLowerCase().endsWith(".gguf")
      ? "将直接使用填入的 .gguf 文件。"
      : "远程 GGUF 仓库可以使用 owner/model:Q4_K_M 这类格式。";
  $("#ggufNote").innerHTML = `
    <strong>llama.cpp GGUF</strong>
    <span>${escapeHtml(fileText)} 本管理器会优先用本地 .gguf；非本地 owner/model 会走 llama.cpp 的 --hf-repo 下载与缓存。</span>
  `;
}

function updateTextOnlyNote() {
  const note = $("#textOnlyNote");
  if (!note) return;
  const model = $("#startModel")?.value.trim() || "";
  const enabled = $("#textOnlyMode")?.checked !== false;
  const en = effectiveLanguage() === "en-US";
  const multimodalHint = isLikelyMultimodalModel(model)
    ? en
      ? " The model name looks multimodal; image input would need a separate mmproj/projector later."
      : " 检测到模型名像多模态模型；如果以后要图片输入，需要单独接入 mmproj/projector。"
    : "";
  const title = enabled
    ? en ? "Text / tool calling" : "纯文本 / 工具调用"
    : en ? "Multimodal reserve not active" : "多模态预留未启用";
  const text = enabled
    ? en
      ? `Text-only mode is on: no mmproj/projector is loaded, which fits Claude, OpenWebUI, tool calling, and long context. The VRAM estimate does not reserve a vision module.${multimodalHint}`
      : `仅文本模式开启：不会加载 mmproj/projector，适合 Claude、OpenWebUI、工具调用和长上下文，显存估算不预留视觉模块。${multimodalHint}`
    : en
      ? `Text-only mode is off, but this manager has no mmproj field yet, so llama.cpp still launches as text. A future projector option would add VRAM use.${multimodalHint}`
      : `仅文本模式关闭：当前管理器仍未提供 mmproj 字段，llama.cpp 实际仍会按文本启动；后续接入 projector 时会额外占用显存。${multimodalHint}`;
  note.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span>`;
}

function isLikelyMultimodalModel(value) {
  return /(?:\bvl\b|vision|visual|multimodal|multi-modal|mmproj|llava|bakllava|moondream|internvl|qwen\d*(?:\.\d+)?-vl|qwen-vl|gemma-3|omni|audio)/i.test(String(value || ""));
}

function isGgufLaunchActive() {
  const format = $("#loadFormat")?.value || "auto";
  const model = $("#startModel")?.value.trim() || "";
  const local = getLocalModelForInput(model);
  return format === "gguf" || (format === "auto" && looksLikeGgufModelInput(model, local));
}

function looksLikeGgufModelInput(model, local) {
  const lower = String(model || "").toLowerCase();
  if (lower.endsWith(".gguf") || lower.includes("-gguf:") || /:[iq]?q\d(?:_[a-z0-9]+)*$/i.test(model)) return true;
  return Boolean(local?.hasGguf && !local?.hasConfig);
}

function getLocalModelForInput(model) {
  const key = normalizePathKey(model);
  if (!key) return null;
  return (state.models.local || []).find((item) => {
    return normalizePathKey(item.launchModel) === key
      || normalizePathKey(item.path) === key
      || normalizePathKey(item.label) === key
      || normalizePathKey(item.id) === key;
  }) || null;
}

function normalizePathKey(value) {
  return String(value || "").trim().replace(/\\/g, "/").toLowerCase();
}

function estimateMemoryUsage() {
  const model = $("#startModel")?.value.trim() || "";
  const contextTokens = Math.max(512, Number($("#maxModelLen")?.value || 8192));
  const textOnlyMode = $("#textOnlyMode")?.checked !== false;
  const paramsB = inferParamBillions(model);
  const dtype = "f16";
  const cacheTypeK = $("#cacheTypeK")?.value || "f16";
  const cacheTypeV = $("#cacheTypeV")?.value || "f16";
  const selectedQuant = getLaunchQuantizationProfile(model);
  const dtypeBytes = DTYPE_BYTES[dtype] || 2;
  const bytesPerParam = selectedQuant.bytesPerParam || dtypeBytes;
  const kvBytes = ((KV_DTYPE_BYTES[cacheTypeK] || dtypeBytes) + (KV_DTYPE_BYTES[cacheTypeV] || dtypeBytes)) / 2;
  const arch = estimateArchitecture(paramsB, model);
  const totalLayers = Math.max(1, Number(arch?.layers || 1));
  const requestedGpuLayers = parseGpuLayersForEstimate($("#gpuLayers")?.value || "all", totalLayers);
  const gpuLayerRatio = totalLayers ? Math.min(1, Math.max(0, requestedGpuLayers / totalLayers)) : 1;
  const totalWeightsGb = paramsB ? paramsB * 1_000_000_000 * bytesPerParam / 1024 ** 3 : 0;
  const weightsGb = totalWeightsGb * gpuLayerRatio;
  const cpuWeightsGb = Math.max(0, totalWeightsGb - weightsGb);
  const totalKvGb = paramsB && arch
    ? contextTokens * 2 * arch.layers * arch.kvHeads * arch.headDim * kvBytes / 1024 ** 3
    : 0;
  // In layer/offload mode the KV cache follows the layer placement; CPU layers keep their KV in system RAM.
  const kvGb = totalKvGb * gpuLayerRatio;
  const cpuKvGb = Math.max(0, totalKvGb - kvGb);
  const multimodalReserveGb = paramsB && !textOnlyMode && isLikelyMultimodalModel(model) ? 1.5 : 0;
  const overheadGb = paramsB ? Math.max(1.2, (weightsGb + kvGb) * 0.08) + multimodalReserveGb : 0;
  const totalGb = weightsGb + kvGb + overheadGb;
  const splitFactor = getParallelMemorySplitFactor();
  const selectedGpus = getSelectedGpuObjects();
  const utilization = Math.min(0.98, Math.max(0.1, Number($("#gpuMemoryUtilization")?.value || 0.9)));
  const gpuAllocations = calculateGpuAllocations(selectedGpus, totalGb, utilization);
  const peakGpuGb = gpuAllocations.length ? Math.max(...gpuAllocations.map((item) => item.allocatedGb)) : totalGb;
  const minUsableGb = gpuAllocations.length ? Math.min(...gpuAllocations.map((item) => item.usableGb)) : 0;
  const status = !gpuAllocations.length
    ? "warn"
    : gpuAllocations.every((item) => item.allocatedGb <= item.usableGb * 0.9)
      ? "ok"
      : gpuAllocations.every((item) => item.allocatedGb <= item.usableGb)
        ? "warn"
        : "fail";
  const recommendedGpuLayers = recommendGpuLayersForEstimate({
    totalLayers,
    totalWeightsGb,
    totalKvGb,
    multimodalReserveGb,
    allocations: gpuAllocations,
    utilization,
  });
  const systemMemoryResidentGb = cpuWeightsGb + cpuKvGb;
  const estimateConfidence = paramsB && arch ? "medium" : "low";

  return {
    model,
    contextTokens,
    textOnlyMode,
    multimodalReserveGb,
    paramsB,
    bytesPerParam,
    kvBytes,
    arch,
    dtype,
    kvCacheDtype: `${cacheTypeK}/${cacheTypeV}`,
    kvLabel: `K ${cacheTypeK} · V ${cacheTypeV}`,
    quantLabel: selectedQuant.label,
    quantValue: selectedQuant.value,
    quantNote: selectedQuant.note,
    totalWeightsGb,
    weightsGb,
    cpuWeightsGb,
    totalKvGb,
    kvGb,
    cpuKvGb,
    overheadGb,
    totalGb,
    splitFactor,
    perGpuGb: peakGpuGb,
    peakGpuGb,
    gpuAllocations,
    gpuSummaryValue: formatGpuSummaryValue(gpuAllocations, totalGb),
    selectedGpus,
    utilization,
    minUsableGb,
    requestedGpuLayers,
    totalLayers,
    gpuLayerRatio,
    recommendedGpuLayers,
    systemMemoryResidentGb,
    estimateConfidence,
    status,
    splitLabel: getParallelSplitLabel(splitFactor),
    archLabel: arch ? `${arch.layers} 层 · KV heads ${arch.kvHeads} · GPU layers ${requestedGpuLayers}/${totalLayers}` : "按模型名估算",
  };
}

function parseGpuLayersForEstimate(value, totalLayers) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text === "all" || text === "auto") return totalLayers;
  const number = Number(text);
  if (!Number.isFinite(number)) return totalLayers;
  return Math.min(totalLayers, Math.max(0, Math.floor(number)));
}

function recommendGpuLayersForEstimate({ totalLayers, totalWeightsGb, totalKvGb, multimodalReserveGb, allocations }) {
  if (!totalLayers || !allocations?.length || !totalWeightsGb) return totalLayers || 0;
  const totalUsableGb = allocations.reduce((sum, item) => sum + Math.max(0, Number(item.usableGb || 0)), 0);
  if (!totalUsableGb) return 0;
  const perLayerGb = (totalWeightsGb + totalKvGb) / totalLayers;
  if (!perLayerGb) return totalLayers;
  const budgetGb = Math.max(0, totalUsableGb * 0.88 - Math.max(1.2, totalKvGb * 0.02) - Math.max(0, multimodalReserveGb || 0));
  return Math.min(totalLayers, Math.max(0, Math.floor(budgetGb / perLayerGb)));
}

function renderGpuMemoryBars(estimate) {
  if (!estimate.gpuAllocations.length) {
    return `<div class="empty compact">未检测到 GPU，无法对照显存容量。</div>`;
  }
  return estimate.gpuAllocations.map((item) => {
    const gpu = item.gpu;
    const freeGb = item.freeGb ?? gpu.freeGb ?? 0;
    const weightLabel = item.weightLabel || formatSplitWeight(item.weight || 0);
    const percent = item.usableGb ? Math.min(100, Math.round((item.allocatedGb / item.usableGb) * 100)) : 0;
    const stateClass = percent > 100 ? "fail" : percent > 90 ? "warn" : "ok";
    return `
      <div class="gpu-bar">
        <div class="gpu-bar-head">
          <strong>GPU ${escapeHtml(gpu.id)} · ${escapeHtml(gpu.name || "NVIDIA")}</strong>
          <span>${formatGbNumber(item.allocatedGb)} / 可用 ${formatGbNumber(item.usableGb)} GB · 空闲 ${formatGbNumber(freeGb)} GB · 权重 ${escapeHtml(weightLabel)}</span>
        </div>
        <div class="gpu-bar-track">
          <div class="gpu-bar-fill ${stateClass}" style="width:${percent}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

function renderMemoryEstimateNote(estimate) {
  const statusText = {
    ok: "预计可运行",
    warn: "接近上限",
    fail: "预计超显存",
  }[estimate.status] || "需要确认";
  const note = estimate.status === "fail"
    ? "可以降低上下文长度、换更小的 GGUF 量化、调高 tensor split 给大显存卡，或减少并行槽数。"
    : estimate.status === "warn"
      ? "建议留出更多显存余量；llama.cpp 的 batch、KV cache 和并行槽数会增加峰值。"
      : "估算包含 GGUF 权重、KV cache 和运行余量；上下文长度或并行槽数增加时 KV cache 也会上升。";
  const longContextNote = estimate.contextTokens >= 196608
    ? " 192K/256K 属于超长上下文，主要消耗 KV cache；如果显存接近上限，优先把 K/V cache 调到 q8_0、q5_1 或 q4_0，并把并行槽数降到 1。"
    : estimate.contextTokens >= 131072
      ? " 128K 以上建议并行槽数先用 1-2，并观察 llama.cpp 启动日志里的实际 KV cache 分配。"
      : "";
  const textOnlyNote = estimate.textOnlyMode
    ? " 已开启仅文本模式，估算不预留视觉 projector。"
    : estimate.multimodalReserveGb > 0
      ? ` 已关闭仅文本模式，并为可能的多模态 projector 预留约 ${formatGbNumber(estimate.multimodalReserveGb)} GB。`
      : " 已关闭仅文本模式；当前未识别到多模态特征，暂不增加额外预留。";
  const confidenceLine = `<span class="memory-headroom">估算可信度：${estimate.estimateConfidence === "medium" ? "中：按参数量、GGUF 量化和常见层数/KV 结构估算" : "低：缺少参数量或架构信息"}。显存可用值按当前空闲显存减保护余量与利用率取较小值。</span>`;
  const ramLine = estimate.systemMemoryResidentGb > 0
    ? `<span class="memory-headroom">系统内存驻留约 ${formatGbNumber(estimate.systemMemoryResidentGb)} GB：这些权重/KV 未放入显存，会减少 OOM 风险但降低速度。</span>`
    : `<span class="memory-headroom">当前估算为全层 GPU offload；如果启动 OOM，可降低 GPU layers，让更多权重留在系统内存。</span>`;
  let fallbackLine = "";
  if (estimate.status === "fail" && estimate.recommendedGpuLayers < estimate.requestedGpuLayers) {
    fallbackLine = `<span class="memory-recommend warn">当前 GPU 分摊仍可能溢出。建议先把 GPU layers 从 ${fmtNumber(estimate.requestedGpuLayers)} 降到约 ${fmtNumber(estimate.recommendedGpuLayers)}，或用更小量化/KV 精度、降低上下文/parallel。</span>`;
  } else if (estimate.status === "warn" && estimate.recommendedGpuLayers < estimate.requestedGpuLayers) {
    fallbackLine = `<span class="memory-recommend">想留更多启动余量，可以把 GPU layers 调到约 ${fmtNumber(estimate.recommendedGpuLayers)}；代价是更多层在 RAM 上运行。</span>`;
  }
  const serverLine = estimate.serverBacked && estimate.serverRecommendations?.suggestions?.length
    ? `<span class="memory-headroom">后端校准：${escapeHtml(estimate.serverRecommendations.suggestions.join(" "))}</span>`
    : "";
  return `
    <strong class="${estimate.status}">${statusText}</strong>
    <span>${escapeHtml(note + longContextNote + textOnlyNote)} 权重量化：${escapeHtml(estimate.quantNote)}。</span>
    ${confidenceLine}
    ${serverLine}
    ${ramLine}
    ${fallbackLine}
  `;
}

function updateContextPresetState(contextTokens) {
  document.querySelectorAll("[data-context-preset]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.contextPreset) === Number(contextTokens));
  });
}

function getParallelMemorySplitFactor() {
  const mode = $("#multiGpuMode")?.value || "layer";
  const count = getSelectedGpuObjects().length || 1;
  if (mode === "none") return 1;
  return Math.max(1, count);
}

function calculateGpuAllocations(selectedGpus, totalGb, utilization) {
  if (!selectedGpus.length) return [];
  const mode = $("#multiGpuMode")?.value || "layer";
  const weights = getTensorSplitWeights(selectedGpus);
  const weightSum = weights.reduce((sum, value) => sum + value, 0) || selectedGpus.length;
  return selectedGpus.map((gpu, index) => {
    const total = Number(gpu.totalMb || 0) / 1024;
    const used = Number(gpu.usedMb || 0) / 1024;
    const free = Math.max(0, total - used);
    const usableGb = Math.max(1, Math.min(total * utilization, Math.max(1, free - 1)));
    const weight = mode === "none" ? (index === 0 ? 1 : 0) : (weights[index] || 1);
    const allocatedGb = mode === "none"
      ? (index === 0 ? totalGb : 0)
      : totalGb * weight / weightSum;
    return {
      gpu,
      weight,
      weightLabel: mode === "none" ? (index === 0 ? "1" : "0") : formatSplitWeight(weight),
      allocatedGb,
      usableGb,
      freeGb: free,
    };
  }).filter((item) => item.allocatedGb > 0 || mode !== "none");
}

function getTensorSplitWeights(selectedGpus) {
  if (selectedGpus.length < 2) return selectedGpus.map(() => 1);
  const mode = $("#multiGpuMode")?.value || "layer";
  if (mode === "none") return selectedGpus.map((_, index) => index === 0 ? 1 : 0);
  const explicit = parseTensorSplitWeights($("#tensorSplit")?.value || "", selectedGpus.length);
  if (explicit) return explicit;
  const suggested = parseTensorSplitWeights(buildFrontendGpuPlan().recommendedTensorSplit || "", selectedGpus.length);
  if (suggested) return suggested;
  return selectedGpus.map((gpu) => Math.max(1, Number(gpu.totalMb || 0) / 1024));
}

function parseTensorSplitWeights(value, expectedCount) {
  const parts = String(value || "")
    .trim()
    .split(/[,:，\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 0);
  if (parts.length !== expectedCount || !parts.some((item) => item > 0)) return null;
  return parts.map((item) => Math.max(0, item));
}

function formatSplitWeight(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function formatGpuSummaryValue(allocations, totalGb) {
  if (!allocations.length) return `${formatGbNumber(totalGb)} GB`;
  if (allocations.length === 1) return `${formatGbNumber(allocations[0].allocatedGb)} GB`;
  const peak = Math.max(...allocations.map((item) => item.allocatedGb));
  return `最高 ${formatGbNumber(peak)} GB`;
}

function getParallelSplitLabel(splitFactor) {
  const mode = $("#multiGpuMode")?.value || "layer";
  const split = $("#tensorSplit")?.value.trim() || suggestTensorSplitFromSelection();
  if (mode === "none") return "单卡或不切分";
  if (splitFactor > 1 && mode === "layer") return `layer 分层 · ${splitFactor} 卡 · split ${split || "auto"}`;
  if (splitFactor > 1 && mode === "row") return `row 行切分 · ${splitFactor} 卡 · split ${split || "auto"}`;
  if (splitFactor > 1 && mode === "tensor") return `tensor 切分 · ${splitFactor} 卡 · split ${split || "auto"}`;
  return "单卡或未分摊";
}

function getLaunchQuantizationProfile(model) {
  return detectGgufQuantizationProfile(model);
}

function detectGgufQuantizationProfile(model) {
  const lower = String(model || "").toLowerCase();
  const match = lower.match(/\b(?:i?q)?q([2-8])(?:_[a-z0-9]+)*/);
  const bits = match ? Number(match[1]) : 4;
  const bytesPerParam = {
    2: 0.34,
    3: 0.45,
    4: 0.56,
    5: 0.68,
    6: 0.8,
    8: 1.05,
  }[bits] || 0.56;
  return {
    label: `GGUF Q${bits}`,
    bytesPerParam,
    note: "GGUF 文件已预量化，llama.cpp 启动时不再叠加 AWQ/GPTQ/Compressed",
    value: "gguf",
  };
}

function detectQuantizationFromText(value) {
  const lower = String(value || "").toLowerCase();
  if (lower.includes("nvfp4") || lower.includes("mxfp4") || lower.includes("fp4")) return "modelopt_fp4";
  if (lower.includes("fp8")) return "fp8";
  if (lower.includes("awq")) return "awq";
  if (lower.includes("gptq")) return "gptq";
  if (lower.includes("nf4") || lower.includes("int4") || /\bq[2-6]_/.test(lower)) return "bitsandbytes";
  if (lower.includes("compressed")) return "compressed-tensors";
  return "";
}

function inferParamBillions(value) {
  const text = String(value || "");
  const moeMatch = text.match(/(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*([BM])\b/);
  if (moeMatch) {
    const unit = moeMatch[3].toUpperCase() === "M" ? 0.001 : 1;
    return Number(moeMatch[1]) * Number(moeMatch[2]) * unit;
  }
  const sizes = Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*([BM])\b/gi))
    .map((match) => Number(match[1]) * (match[2].toUpperCase() === "M" ? 0.001 : 1))
    .filter((size) => Number.isFinite(size) && size > 0);
  return sizes.length ? Math.max(...sizes) : 0;
}

function estimateArchitecture(paramsB, model) {
  if (!paramsB) return null;
  const lower = String(model || "").toLowerCase();
  const qwenLike = lower.includes("qwen");
  const llamaLike = lower.includes("llama") || lower.includes("aeon");
  if (paramsB <= 1) return { layers: qwenLike ? 28 : 24, kvHeads: 8, headDim: 128 };
  if (paramsB <= 4) return { layers: qwenLike ? 36 : 32, kvHeads: 8, headDim: 128 };
  if (paramsB <= 9) return { layers: 36, kvHeads: llamaLike ? 8 : 8, headDim: 128 };
  if (paramsB <= 15) return { layers: 48, kvHeads: 8, headDim: 128 };
  if (paramsB <= 35) return { layers: 64, kvHeads: 8, headDim: 128 };
  if (paramsB <= 80) return { layers: 80, kvHeads: 8, headDim: 128 };
  return { layers: 96, kvHeads: 8, headDim: 128 };
}

function formatGbNumber(value) {
  const number = Number(value || 0);
  if (number >= 100) return number.toFixed(0);
  if (number >= 10) return number.toFixed(1);
  return number.toFixed(2);
}

function setLaunchQuantizationFromModel(model) {
  updateGgufModeState();
  updateMemoryEstimate();
  updateReasoningNote();
  updateTextOnlyNote();
}

function updateParallelDefaults() {
  const selected = getSelectedGpuObjects();
  const selectedCount = Math.max(1, selected.length || state.selectedGpuIds.size || 1);
  $("#tensorParallelSize").value = selectedCount;
  $("#dataParallelSize").value = $("#maxNumSeqs")?.value || 4;
  const selectedIds = selected.map((gpu) => String(gpu.id));
  if (selected[0] && !selectedIds.includes(String($("#mainGpu").value))) {
    $("#mainGpu").value = selected[0].id;
  }
  updateSplitPreview();
  updateMemoryEstimate();
}

function updateSplitPreview() {
  const split = $("#tensorSplit");
  if (!split) return;
  const suggestion = suggestTensorSplitFromSelection();
  if (!split.value.trim()) split.placeholder = suggestion ? `自动建议：${suggestion}` : "例如 24,8；留空自动按推荐方案";
  renderHeteroPlan();
}

function suggestTensorSplitFromSelection() {
  return buildFrontendGpuPlan().recommendedTensorSplit || "";
}

function renderHeteroPlan() {
  const root = $("#heteroPlan");
  const actions = $("#heteroPresetButtons");
  if (!root || !actions) return;
  const plan = buildFrontendGpuPlan();
  if (!plan.selected.length) {
    root.innerHTML = `<div class="empty compact">未检测到 NVIDIA GPU；无法生成异构双卡方案。</div>`;
    actions.innerHTML = "";
    return;
  }

  const activeSplit = $("#tensorSplit")?.value.trim() || plan.recommendedTensorSplit || "单卡";
  const mode = $("#multiGpuMode")?.value || plan.recommendedMode;
  const selectedSummary = plan.selected.map((gpu) => `
    <div class="hetero-gpu">
      <strong>GPU ${escapeHtml(gpu.id)} · ${escapeHtml(gpu.name)}</strong>
      <span>可用约 ${formatGbNumber(gpu.usableGb)} GB · 已用 ${formatGbNumber(gpu.usedGb)} / ${formatGbNumber(gpu.totalGb)} GB · ${escapeHtml(gpu.util || 0)}%</span>
    </div>
  `).join("");

  root.innerHTML = `
    <div class="hetero-summary">
      <strong>${escapeHtml(plan.hetero ? "已检测到异构双卡" : plan.selected.length > 1 ? "多 GPU 方案" : "单 GPU 方案")}</strong>
      <span>${escapeHtml(plan.summary)}</span>
    </div>
    <div class="hetero-metrics">
      <div><span>启动模式</span><strong>${escapeHtml(mode)}</strong></div>
      <div><span>实际 split</span><strong>${escapeHtml(activeSplit)}</strong></div>
      <div><span>main GPU</span><strong>宿主 ${escapeHtml(plan.mainGpuHostId)} / 容器 ${escapeHtml(plan.mainGpu)}</strong></div>
    </div>
    <div class="hetero-gpu-grid">${selectedSummary}</div>
    <div class="hetero-note">${plan.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>
  `;

  actions.innerHTML = plan.profiles.map((profile) => `
    <button type="button" data-hetero-profile="${escapeAttr(profile.id)}" title="${escapeAttr(profile.description)}">
      <strong>${escapeHtml(profile.label)}</strong>
      <span>${escapeHtml(profile.mode)}${profile.tensorSplit ? ` · ${profile.tensorSplit}` : ""}</span>
    </button>
  `).join("");
  actions.dataset.plan = JSON.stringify(plan.profiles);
  renderMultiGpuModeGuide();
  renderIcons();
}

function handleHeteroPresetClick(event) {
  const button = event.target.closest("[data-hetero-profile]");
  if (!button) return;
  const plan = buildFrontendGpuPlan();
  const profile = plan.profiles.find((item) => item.id === button.dataset.heteroProfile);
  if (!profile) return;
  $("#multiGpuMode").value = profile.mode;
  $("#tensorSplit").value = profile.tensorSplit || "";
  $("#mainGpu").value = profile.mainGpuHostId ?? profile.mainGpu ?? 0;
  state.tensorSplitTouched = Boolean(profile.tensorSplit);
  updateSplitPreview();
  updateMemoryEstimate();
  renderMultiGpuModeGuide();
}

function renderMultiGpuModeGuide() {
  const root = $("#multiGpuModeGuide");
  if (!root) return;
  const mode = $("#multiGpuMode")?.value || "layer";
  const plan = buildFrontendGpuPlan();
  const primary = plan.selected?.find((gpu) => String(gpu.id) === String(plan.mainGpuHostId)) || plan.selected?.[0] || null;
  const primaryLabel = primary ? window.GpuPlanningUtils.shortGpuLabel(primary.name, primary.id) : "主 GPU";
  const heteroPrefix = plan.hetero ? "异构多卡" : "多卡";
  const tips = {
    layer: `推荐：${heteroPrefix}优先 layer。把更多层放到 ${primaryLabel}，其它 GPU 轻量分担，适合本地 Claude 单路长任务。`,
    row: "进阶：可能提升多路吞吐，但 KV 和部分计算更依赖 main GPU；建议先测速再长期用。",
    tensor: "实验：对同级多卡更友好；异构卡上可能被慢卡拖住，适合短测。",
    none: "排错：只用一张卡，最容易判断模型、路径、GGUF 文件是否正确。",
  };
  const split = $("#tensorSplit")?.value.trim() || plan.recommendedTensorSplit || "自动";
  root.innerHTML = `
    <strong>${escapeHtml(tips[mode] || tips.layer)}</strong>
    <span>当前选择 ${escapeHtml(plan.selected.length || 0)} 张 GPU，split ${escapeHtml(split)}，main GPU 宿主 ${escapeHtml(plan.mainGpuHostId || "0")} / 容器 ${escapeHtml(plan.mainGpu || 0)}。</span>
  `;
}

function buildFrontendGpuPlan() {
  const selected = getSelectedGpuObjects().map((gpu, visibleIndex) => normalizeFrontendPlanGpu(gpu, visibleIndex));
  const mode = $("#multiGpuMode")?.value || "layer";
  const selectedIds = selected.map((gpu) => String(gpu.id));
  const requestedMain = String($("#mainGpu")?.value ?? selectedIds[0] ?? "0");
  let mainGpu = selectedIds.indexOf(requestedMain);
  if (mainGpu < 0) {
    const ordinal = Number(requestedMain);
    mainGpu = Number.isFinite(ordinal) && ordinal >= 0 && ordinal < selected.length ? Math.floor(ordinal) : 0;
  }
  const primary = selected[mainGpu] || selected[0] || null;
  const hetero = window.GpuPlanningUtils.isHeterogeneous(selected);

  if (selected.length < 2 || mode === "none") {
    return {
      selected,
      hetero,
      recommendedMode: "none",
      recommendedTensorSplit: "",
      mainGpu,
      mainGpuHostId: primary?.id || "0",
      summary: primary ? `只使用 GPU ${primary.id}，main-gpu 会映射为容器内 ${mainGpu}。` : "没有选中的 GPU。",
      profiles: selected.map((gpu) => ({
        id: `single-${gpu.id}`,
        label: `只用 GPU ${gpu.id}`,
        mode: "none",
        tensorSplit: "",
        mainGpu: selected.indexOf(gpu),
        mainGpuHostId: gpu.id,
        description: `${gpu.name} · 可用约 ${formatGbNumber(gpu.usableGb)} GB。`,
      })),
      notes: [primary?.totalGb >= 80
        ? "80GB+ 大显存单卡建议先用 q8_0/q4_0 KV cache、parallel=1-2 逐步测试 256K/384K 上下文。"
        : "单卡模式不传 tensor-split；只勾选任意一张卡时，启动时 main-gpu 会自动映射为容器内 0。"],
    };
  }

  const memorySplit = window.GpuPlanningUtils.splitStringFromWeights(selected.map((gpu) => gpu.usableGb));
  const speedSplit = window.GpuPlanningUtils.splitStringFromWeights(selected.map((gpu) => gpu.usableGb * gpu.performanceFactor));
  const lightSplit = window.GpuPlanningUtils.buildLightSplit(selected);
  const recommendedTensorSplit = mode === "layer"
    ? lightSplit || speedSplit || memorySplit
    : mode === "row"
      ? memorySplit
      : speedSplit || memorySplit;
  const profiles = [
    {
      id: "hetero-layer-speed",
      label: "稳妥异构",
      mode: "layer",
      tensorSplit: lightSplit || speedSplit || memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || selected[0].id,
      description: `${window.GpuPlanningUtils.shortGpuLabel(primary?.name, primary?.id)} 多承担，其它 GPU 轻量分担，适合本地 Claude 单路任务。`,
    },
    {
      id: "hetero-layer-capacity",
      label: "长上下文",
      mode: "layer",
      tensorSplit: memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || selected[0].id,
      description: "按可用显存分配，优先争取更大 KV cache。",
    },
    {
      id: "row-balanced",
      label: "row 并行",
      mode: "row",
      tensorSplit: memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || selected[0].id,
      description: "可能提升吞吐，但 KV 和中间结果更依赖 main GPU。",
    },
    {
      id: "tensor-experimental",
      label: "tensor 实验",
      mode: "tensor",
      tensorSplit: speedSplit || memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || selected[0].id,
      description: "可能提高并发吞吐；异构卡单路延迟不一定更好。",
    },
  ];

  return {
    selected,
    hetero,
    recommendedMode: mode,
    recommendedTensorSplit,
    memoryTensorSplit: memorySplit,
    speedTensorSplit: speedSplit,
    lightOffloadTensorSplit: lightSplit,
    mainGpu,
    mainGpuHostId: primary?.id || selected[0].id,
    summary: `${selected.length} 张 GPU：建议 ${mode}，split ${recommendedTensorSplit}，main GPU 放在 ${primary?.name || "GPU 0"}。`,
    profiles,
    notes: [
      hetero ? "异构多卡推荐先用 layer；想冲吞吐再短测 row/tensor。" : "同级多卡可以更积极尝试 row/tensor。",
      "split 留空时后端会按同一套逻辑自动补齐；一键方案会把值写进输入框，方便复现实验。",
      hetero && selected.some((gpu) => gpu.totalGb >= 80) && selected.some((gpu) => gpu.totalGb < 40)
        ? "96GB 大卡 + 5090/5070Ti 这类组合建议用 layer：大卡承担主要层，小卡少量分担；OOM 时先降低 GPU layers，让剩余层回到系统内存。"
        : "显存溢出时，llama.cpp 最稳的回退是降低 GPU layers，让部分权重留在 RAM；速度会下降但更容易启动。",
    ],
  };
}

function normalizeFrontendPlanGpu(gpu, visibleIndex) {
  return window.GpuPlanningUtils.normalizeGpuForPlan(gpu, {
    visibleIndex,
    utilization: $("#gpuMemoryUtilization")?.value || 0.92,
    defaultUtilization: 0.92,
    minUsableMb: 1024,
    includePerformance: true,
  });
}

function updateReasoningNote() {
  const model = $("#startModel")?.value || "";
  const preset = $("#clientPreset")?.value || "openwebui";
  const select = $("#reasoningParser");
  if (!select) return;
  const suggested = inferReasoningParser(model, preset);
  if (!state.reasoningParserTouched) {
    select.value = suggested || "";
  }
  const active = select.value === "auto" ? suggested : select.value;
  const presetText = {
    openwebui: "Open WebUI 通常能读取 reasoning_content；deepseek 格式会把 <think> 内容拆到 reasoning_content。",
    "claude-code": "Claude Code 桥接到 OpenAI 兼容端时，deepseek 格式更容易被桥接器识别；不支持时选 none。",
    "claude-cowork": "Claude Cowork 若只读取正文，选 none 或 deepseek-legacy 更保守。",
    generic: "通用客户端兼容性优先；支持 reasoning_content 的客户端可用 deepseek，否则 none。",
  }[preset] || "";
  const parserText = active && active !== "none"
    ? `本次启动会使用 --reasoning-format ${active}。`
    : "本次启动会把思考留在正文，或交给模型模板自动处理。";
  $("#reasoningNote").innerHTML = `
    <strong>${escapeHtml(active || "auto")}</strong>
    <span>${escapeHtml(parserText)} ${escapeHtml(presetText)}</span>
  `;
}

function inferReasoningParser(model, preset) {
  const text = String(model || "").toLowerCase();
  if (text.includes("deepseek") || text.includes("qwen3") || text.includes("qwen-3") || text.includes("think")) return "deepseek";
  if (preset === "generic") return "none";
  return "auto";
}

function renderNetworkNote() {
  const lanAddress = state.config?.lanAddress || "127.0.0.1";
  const port = Number($("#servicePort")?.value || state.config?.defaultPort || 8080);
  const networkAccess = $("#networkAccess")?.value || "local";
  const localUrl = `http://127.0.0.1:${port}/v1`;
  const lanUrl = `http://${lanAddress}:${port}/v1`;
  const claudeUrl = `http://127.0.0.1:${state.config?.managerPort || 5178}/claude/v1/messages`;
  const text = networkAccess === "lan"
    ? `局域网访问已开启。Docker 会同时发布 ${localUrl} 和 ${lanUrl}；容器内仍监听 0.0.0.0，由 Docker 转发到本机 IP。Claude 兼容桥在管理器上：${claudeUrl}。`
    : `当前仅本机访问。OpenAI 兼容地址为 ${localUrl}；Claude 兼容地址为 ${claudeUrl}。`;
  $("#networkNote").innerHTML = `
    <strong>${networkAccess === "lan" ? "LAN API" : "Local API"}</strong>
    <span>${escapeHtml(text)}</span>
    ${networkAccess === "lan" ? `<code>${escapeHtml(lanUrl)}</code>` : ""}
  `;
  const docsBase = networkAccess === "lan" ? `http://${lanAddress}:${port}` : `http://127.0.0.1:${port}`;
  $("#apiDocsLink").href = `${docsBase}/docs`;
}

function renderServiceExposure() {
  serviceExposureRenderer.renderServiceExposure();
}

function renderServiceExposureEndpoints(payload) {
  serviceExposureRenderer.renderServiceExposureEndpoints(payload);
}

function renderServiceExposureChecks(payload) {
  serviceExposureRenderer.renderServiceExposureChecks(payload);
}

function buildServiceExposurePayload(overrides = {}) {
  const settings = state.serviceExposure?.settings || {};
  const payload = {
    enabled: Boolean(settings.enabled),
    exposureMode: settings.exposureMode || "local",
    requireApiKey: Boolean(settings.requireApiKey),
    publicBaseUrl: settings.publicBaseUrl || "",
    allowedOrigins: (settings.allowedOrigins || []).join("\n"),
    rateLimitRpm: Number(settings.rateLimitRpm || 120),
    maxConcurrentRequests: Number(settings.maxConcurrentRequests || 4),
    requestTimeoutSeconds: Number(settings.requestTimeoutSeconds || 600),
    exposeOpenAI: settings.exposeOpenAI !== false,
    exposeClaude: settings.exposeClaude !== false,
    exposeMetrics: Boolean(settings.exposeMetrics),
    allowManagerRemote: Boolean(settings.allowManagerRemote),
    notes: settings.notes || "",
  };
  if ("exposeOpenCode" in settings) payload.exposeOpenCode = settings.exposeOpenCode !== false;
  return { ...payload, ...overrides };
}

async function saveServiceExposure(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = form.elements;
  const payload = buildServiceExposurePayload({
    enabled: fields.enabled.checked,
    exposureMode: fields.exposureMode.value,
    requireApiKey: fields.requireApiKey.checked,
    apiKey: fields.apiKey.value.trim(),
    clearApiKey: fields.clearApiKey.checked,
    publicBaseUrl: fields.publicBaseUrl.value.trim(),
    allowedOrigins: fields.allowedOrigins.value,
    rateLimitRpm: Number(fields.rateLimitRpm.value || 120),
    maxConcurrentRequests: Number(fields.maxConcurrentRequests.value || 4),
    requestTimeoutSeconds: Number(fields.requestTimeoutSeconds.value || 600),
    exposeOpenAI: fields.exposeOpenAI.checked,
    exposeClaude: fields.exposeClaude.checked,
    exposeMetrics: fields.exposeMetrics.checked,
    allowManagerRemote: fields.allowManagerRemote.checked,
    notes: fields.notes.value,
  });
  const result = await api("/api/service-exposure", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.serviceExposure = result;
  renderServiceExposure();
  notify("服务化设置已保存", "网关开关、鉴权、限流和客户端 Key 已即时生效；只有容器端口绑定需下次启动。", "success");
}

async function handleServiceExposureEndpointAction(event) {
  const button = event.target.closest("[data-exposure-action='set']");
  if (!button) return;
  event.preventDefault();
  const field = button.dataset.exposureField || "";
  if (!["enabled", "exposeOpenAI", "exposeClaude", "exposeOpenCode", "requireApiKey", "exposureMode"].includes(field)) return;
  const rawValue = button.dataset.exposureValue || "";
  const value = field === "exposureMode" ? rawValue : rawValue === "true";
  const restoreButton = setButtonBusy(button, "保存中...");
  try {
    const result = await api("/api/service-exposure", {
      method: "POST",
      body: JSON.stringify(buildServiceExposurePayload({ [field]: value })),
    });
    state.serviceExposure = result;
    renderServiceExposure();
    await Promise.all([
      refreshConnectionGuide().catch(() => {}),
      refreshExternalAccess().catch(() => {}),
    ]);
    const labels = { enabled: "总开关", exposeOpenAI: "OpenAI", exposeClaude: "Claude", exposeOpenCode: "OpenCode", requireApiKey: "API Key", exposureMode: "访问模式" };
    notify("对外服务已更新", `${labels[field] || field} 已即时生效，不需要重启模型。`, "success");
  } catch (error) {
    reportActionError("更新对外服务失败", error);
  } finally {
    restoreButton();
  }
}

function applyExposureToLaunchForm() {
  const settings = state.serviceExposure?.settings || {};
  const mode = settings.exposureMode || "local";
  if ($("#networkAccess")) {
    $("#networkAccess").value = mode === "lan" ? "lan" : "local";
    renderNetworkNote();
  }
  notify("已应用到启动表单", mode === "lan" ? "下一次启动会发布到局域网；公网服务建议放在反向代理后。" : "下一次启动会保持本机绑定。", "success");
  showView("service");
}

function generateExposureApiKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if ($("#exposureApiKey")) $("#exposureApiKey").value = `sk-local-${token}`;
}

function renderServiceClients() {
  serviceClientRenderer.renderServiceClients();
}

async function createServiceClient(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = form.elements;
  const payload = {
    name: fields.name.value.trim(),
    allowedModels: fields.allowedModels.value,
    rateLimitRpm: Number(fields.rateLimitRpm.value || 120),
    maxConcurrentRequests: Number(fields.maxConcurrentRequests.value || 4),
    requestTimeoutSeconds: Number(fields.requestTimeoutSeconds.value || 600),
    expiresAt: fields.expiresAt.value,
    notes: fields.notes.value,
  };
  const result = await api("/api/service-clients", { method: "POST", body: JSON.stringify(payload) });
  showServiceClientSecret(result.apiKey, "客户端 Key 已创建");
  form.reset();
  await refreshServiceClients();
  notify("客户端 Key 已创建", "明文 Key 只显示一次，请立即保存到客户端。", "success");
}

async function handleServiceClientAction(event) {
  const button = event.target.closest("[data-client-action]");
  if (!button) return;
  const card = button.closest("[data-client-id]");
  const id = card?.dataset.clientId;
  if (!id) return;
  const action = button.dataset.clientAction;
  const client = (state.serviceClients?.clients || []).find((item) => item.id === id);
  if (action === "toggle") {
    await api(`/api/service-clients/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !client?.enabled }),
    });
    await refreshServiceClients();
    notify("客户端状态已更新", id, "success");
  } else if (action === "rotate") {
    const result = await api(`/api/service-clients/${encodeURIComponent(id)}/rotate`, { method: "POST" });
    showServiceClientSecret(result.apiKey, "客户端 Key 已轮换");
    await refreshServiceClients();
    notify("客户端 Key 已轮换", "旧 Key 已失效，新 Key 只显示一次。", "success");
  } else if (action === "delete") {
    await api(`/api/service-clients/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshServiceClients();
    notify("客户端 Key 已删除", id, "success");
  }
}

function showServiceClientSecret(apiKey, title) {
  serviceClientRenderer.showServiceClientSecret(apiKey, title);
}

function renderStats() {
  const stats = state.stats;
  if (!stats) return;
  statsSummaryRenderer.render(stats);
  renderStatsModels(stats);
  renderStatsClients(stats);
  renderStatsCosts(stats);
  renderStatsDetails(stats);
  renderIcons();
}

function renderAudit() {
  window.LocalAiAuditRenderer.render({
    state,
    getElement: $,
    escapeHtml,
    escapeAttr,
    formatDate,
    fmtTokens,
    fmtBytes,
    renderIcons,
  });
}

function statsMetric(label, value, detail) {
  return window.statsUiRenderer.statsMetric(label, value, detail, { escapeHtml, escapeAttr });
}

function renderExternalAccess() {
  externalAccessRenderer.renderExternalAccess(state.externalAccess);
}

function renderStatsModels(stats) {
  const en = effectiveLanguage() === "en-US";
  window.statsListRenderer.renderModels(stats, {
    root: $("#statsModelList"),
    escapeHtml,
    miniStat,
    shareBar,
    fmtPct,
    fmtTokens,
    fmtRate,
    formatContextUsage,
    labels: statsModelLabels(en),
  });
}

function renderStatsClients(stats) {
  const en = effectiveLanguage() === "en-US";
  window.statsListRenderer.renderClients(stats, {
    root: $("#statsClientBreakdown"),
    escapeHtml,
    miniStat,
    shareBar,
    fmtTokens,
    fmtMs,
    formatDateTime,
    labels: statsClientLabels(en),
  });
}

function renderStatsClientRow(client) {
  const en = effectiveLanguage() === "en-US";
  return window.statsListRenderer.renderClientRow(client, {
    escapeHtml,
    miniStat,
    shareBar,
    fmtTokens,
    fmtMs,
    formatDateTime,
    labels: statsClientLabels(en),
  });
}

function renderClientModelLine(client) {
  const en = effectiveLanguage() === "en-US";
  return window.statsListRenderer.renderClientModelLine(client, {
    escapeHtml,
    fmtTokens,
    labels: statsClientLabels(en),
  });
}

function statsModelLabels(en) {
  return en ? {
    modelEmpty: "No model stats yet. Start a model and send requests to see usage shares.",
    modelFallbackRoot: "llama.cpp model",
    tokenShare: "Token share",
    requestShare: "Request share",
    outputSpeed: "Output speed",
    activeKv: "Active KV",
    average: "average",
    avgInput: "average input",
  } : {
    modelEmpty: "暂无模型统计。启动模型并产生请求后这里会显示占比。",
    modelFallbackRoot: "llama.cpp model",
    tokenShare: "Token 占比",
    requestShare: "请求占比",
    outputSpeed: "输出速度",
    activeKv: "活跃 KV",
    average: "平均",
    avgInput: "平均输入",
  };
}

function statsClientLabels(en) {
  return en ? {
    clientsEmpty: "No client usage yet. Claude bridge calls will be separated from chat and direct API usage here.",
    clientsNote: "Claude statistics include only requests through the manager Claude-compatible bridge.",
    clientTokens: "Tokens",
    clientRequests: "Requests",
    clientTools: "Tools",
    clientCompression: "Context compression",
    clientLatency: "Average latency",
    input: "input",
    output: "output",
    success: "success",
    error: "errors",
    schemas: "schemas",
    streamed: "streamed",
    times: "times",
    saved: "tokens saved",
    last: "last",
    noLast: "No recent call",
    modelSeparator: ": ",
    modelRequests: "requests",
    detailSeparator: " · ",
  } : {
    clientsEmpty: "暂无调用来源统计。Claude 桥接产生请求后，这里会和聊天/直连分开显示。",
    clientsNote: "Claude 统计只包含经过管理器 Claude 兼容桥的请求。",
    clientTokens: "Tokens",
    clientRequests: "请求",
    clientTools: "工具",
    clientCompression: "上下文压缩",
    clientLatency: "平均耗时",
    input: "输入",
    output: "输出",
    success: "成功",
    error: "错误",
    schemas: "个 schema",
    streamed: "流式",
    times: "次",
    saved: "节省 tokens",
    last: "最后",
    noLast: "暂无最后调用",
    modelSeparator: "：",
    modelRequests: "请求",
    detailSeparator: " · ",
  };
}

function renderStatsCosts(stats) {
  window.statsUiRenderer.renderCosts(stats, {
    root: $("#statsCostTable"),
    managerName: "llama.cpp",
    escapeHtml,
    fmtMoney,
    labels: {
      empty: "暂无价格折算。",
      model: "模型",
      price: "输入/输出",
      standard: "标准等值",
      cached: "含缓存等值",
      priceAsOf: "价格按",
      publicPrice: "官方公开价估算",
      localPrefix: "本地",
      localNote: "不会产生这些 API 费用，仅用于对比价值。",
      priceSeparator: " · ",
    },
  });
}

function renderStatsDetails(stats) {
  window.statsUiRenderer.renderDetails(stats, {
    root: $("#statsDetailGrid"),
    miniStat,
    fmtSeconds,
    fmtTokens,
    labels: {
      endToEnd: "平均端到端",
      endToEndDetail: "请求完成平均耗时",
      ttft: "平均首 token",
      perOutputToken: "平均单输出 token",
      lowerIsBetter: "越低越快",
      gpu: "GPU",
      gpuMissing: "未检测到",
      kvCapacity: "KV cache 容量",
      maxConcurrency: "最大并发",
      loadWeights: "加载权重",
      loadStage: "模型载入阶段",
      torchCompile: "torch.compile",
      firstStartCost: "首次启动主要耗时之一",
      warmup: "warmup",
      warmupDetail: "profiling / warmup",
      cudaGraph: "CUDA graph",
      graphPool: "graph pool 实占",
      source: "采集源",
      separator: " · ",
      temperatureUnit: "°C",
    },
  });
}

function miniStat(label, value, detail) {
  return window.statsUiRenderer.miniStat(label, value, detail, { escapeHtml });
}

function shareBar(label, value) {
  return window.statsUiRenderer.shareBar(label, value, { escapeHtml });
}

function fmtSeconds(value) {
  const number = Number(value || 0);
  if (!number) return "-";
  if (number < 1) return `${(number * 1000).toFixed(0)} ms`;
  if (number < 10) return `${number.toFixed(2)} s`;
  return `${number.toFixed(1)} s`;
}

function toggleModelPicker(force) {
  state.modelPickerOpen = typeof force === "boolean" ? force : !state.modelPickerOpen;
  renderModelPicker();
  if (state.modelPickerOpen) window.setTimeout(() => $("#modelPickerSearch")?.focus(), 0);
}

function closeModelPicker() {
  if (!state.modelPickerOpen) return;
  state.modelPickerOpen = false;
  renderModelPicker();
}

function handleModelPickerOutsideClick(event) {
  if (!state.modelPickerOpen) return;
  const field = $(".model-picker-field");
  if (field?.contains(event.target)) return;
  closeModelPicker();
}

function handleModelPickerTabClick(event) {
  const button = event.target.closest("[data-model-source]");
  if (!button) return;
  state.modelPickerSource = button.dataset.modelSource || "all";
  renderModelPicker();
}

function handleModelPickerSelection(event) {
  const button = event.target.closest("[data-picker-model]");
  if (!button) return;
  selectLaunchModel(button.dataset.pickerModel || "", {
    name: button.dataset.pickerName || "",
    format: button.dataset.pickerFormat || "auto",
  });
}

function selectLaunchModel(model, options = {}) {
  const value = String(model || "").trim();
  if (!value) return;
  $("#startModel").value = value;
  $("#servedName").value = deriveName(options.name || value);
  $("#loadFormat").value = options.format || inferLaunchFormat(value);
  setLaunchQuantizationFromModel(value);
  closeModelPicker();
  showView("service");
}

function inferLaunchFormat(model) {
  const local = getLocalModelForInput(model);
  if (local?.hasGguf && !local?.hasConfig) return "gguf";
  if (looksLikeGgufModelInput(model, local)) return "gguf";
  return "auto";
}

function renderModelPicker() {
  const english = effectiveLanguage() === "en-US";
  window.modelPickerRenderer?.render({
    state,
    getElement: $,
    buildItems: buildModelPickerItems,
    isRunnableItem: isManagerRunnableModelItem,
    renderRunnableFilterToggles,
    renderIcons,
    escapeHtml,
    escapeAttr,
    fmtBytes,
    formatDate,
    estimateModelFit,
    favoriteLabel: "收藏",
    emptyMessage: "没有匹配的模型。可以换个关键词，或刷新本地/在线列表。",
    limitMessage: english ? "Showing first 80 models. Keep typing to narrow results." : "当前只显示前 80 个结果，继续输入关键词可以缩小范围。",
  });
}

function buildModelPickerItems() {
  const items = [];
  const seen = new Set();
  const notes = Object.values(state.modelNotes?.notes || {});
  const noteMap = new Map(notes.map((note) => [normalizePathKey(note.model), note]));
  const add = (item) => {
    const key = normalizePathKey(item.model);
    if (!key || seen.has(`${item.source}:${key}`)) return;
    seen.add(`${item.source}:${key}`);
    items.push({ ...item, badges: (item.badges || []).filter(Boolean) });
  };

  (state.status?.runningModels || []).forEach((model) => {
    const modelId = model.id || model.model || "";
    add({
      source: "running",
      sourceLabel: "运行中",
      label: modelId,
      model: modelId,
      detail: model.apiBaseUrl || "llama.cpp",
      format: "auto",
      contextTokens: model.maxModelLen || model.contextCapacityTokens || 0,
      runningSpeed: model.tokensPerSecond || model.outputTokensPerSecond || "",
      badges: ["运行中", model.maxModelLen ? `${fmtTokens(model.maxModelLen)} context` : ""],
    });
  });

  notes.filter((note) => note.favorite).forEach((note) => {
    add({
      source: "favorite",
      sourceLabel: "收藏",
      label: note.model,
      model: note.model,
      detail: note.note || (note.tags || []).join(", "),
      format: inferLaunchFormat(note.model),
      favorite: true,
      badges: ["收藏", ...(note.tags || []).slice(0, 3)],
    });
  });

  (state.models.local || []).forEach((model) => {
    const note = findModelNote(noteMap, model.launchModel, model.path, model.label, model.id);
    add({
      source: "local",
      sourceLabel: "本地",
      label: model.label || model.id || model.launchModel,
      model: model.launchModel || model.path || model.id,
      detail: model.path || "",
      format: model.hasGguf && !model.hasConfig ? "gguf" : "auto",
      sizeBytes: model.size || 0,
      quantLabel: inferModelQuantLabel([model.label, model.path, model.ggufFiles?.[0]?.name].filter(Boolean).join(" ")),
      favorite: Boolean(note?.favorite),
      badges: [
        "本地",
        model.size ? fmtBytes(model.size) : "",
        model.hasGguf ? "GGUF" : "",
        model.hasConfig ? "config" : "",
        model.ggufFiles?.[0]?.name || "",
        note?.favorite ? "收藏" : "",
      ],
    });
  });

  (state.models.cached || []).forEach((model) => {
    const note = findModelNote(noteMap, model.launchModel, model.path, model.label, model.id);
    add({
      source: "cached",
      sourceLabel: "缓存",
      label: model.label || model.id || model.launchModel,
      model: model.launchModel || model.id || model.path,
      detail: model.path || "",
      format: inferLaunchFormat(model.launchModel || model.id),
      sizeBytes: model.size || 0,
      quantLabel: inferModelQuantLabel([model.label, model.path, model.id].filter(Boolean).join(" ")),
      favorite: Boolean(note?.favorite),
      badges: ["缓存", model.size ? fmtBytes(model.size) : "", note?.favorite ? "收藏" : ""],
    });
  });

  getVisibleRemoteModels().forEach((model) => {
    add({
      source: "remote",
      sourceLabel: "在线",
      label: model.label || model.id,
      model: model.id,
      detail: [model.author || "Hugging Face", model.libraryName || model.pipelineTag || "", model.lastModified ? `更新 ${formatDate(model.lastModified)}` : ""].filter(Boolean).join(" / "),
      format: model.hasGguf ? "gguf" : "auto",
      sizeBytes: model.fileSizeBytes || model.largestFileBytes || 0,
      quantLabel: (model.quantFormats || [])[0] || inferModelQuantLabel([model.label, model.id, ...(model.badges || [])].join(" ")),
      updatedAt: model.lastModified || "",
      badges: [
        "在线",
        model.gated ? "需授权" : "",
        model.hasGguf ? "GGUF" : "",
        model.hasSafetensors ? "safetensors" : "",
        ...(model.badges || []).slice(0, 3),
      ],
    });
  });

  return items;
}

function findModelNote(noteMap, ...values) {
  for (const value of values) {
    const note = noteMap.get(normalizePathKey(value));
    if (note) return note;
  }
  return null;
}

function renderModelPickerItem(item) {
  return window.modelPickerRenderer?.renderItem(item, {
    escapeHtml,
    escapeAttr,
    fmtBytes,
    formatDate,
    estimateModelFit,
    favoriteLabel: "收藏",
  }) || "";
}

function estimateModelFit(item) {
  const selected = getSelectedGpuObjects();
  if (!selected.length) return null;
  const modelText = [item.model, item.label, item.detail, item.quantLabel].filter(Boolean).join(" ");
  const paramsB = inferParamBillions(modelText);
  const quant = item.quantLabel || inferModelQuantLabel(modelText);
  const bytesPerParam = quantBytesForLabel(quant);
  const modelGb = item.sizeBytes ? item.sizeBytes / 1024 ** 3 : paramsB ? paramsB * bytesPerParam * 0.93 : 0;
  if (!modelGb) return null;
  const selectedFreeGb = selected.map((gpu) => Math.max(0, Number(gpu.totalMb || 0) - Number(gpu.usedMb || 0)) / 1024);
  const maxFreeGb = Math.max(...selectedFreeGb);
  const totalFreeGb = selectedFreeGb.reduce((sum, value) => sum + value, 0);
  // GGUF/llama.cpp generally needs a little less runtime headroom than vLLM safetensors,
  // so keep this intentionally below the vLLM picker estimate instead of normalizing them.
  const headroomGb = Math.max(2, modelGb * 0.18);
  const peerSuffix = state.status?.resources?.hasPeerRunning ? "·已扣占用" : "";
  if (modelGb + headroomGb <= maxFreeGb) return { label: `单卡可跑${peerSuffix}`, state: "ok" };
  if (selected.length > 1 && modelGb + headroomGb <= totalFreeGb * 0.86) return { label: `需多卡${peerSuffix}`, state: "warn" };
  return { label: `偏紧${peerSuffix}`, state: "fail" };
}

function renderModels() {
  window.LocalAiLocalModelRenderer.render({
    state,
    root: $("#modelList"),
    escapeHtml,
    escapeAttr,
    fmtBytes,
    renderIcons,
    requireGgufForLocal: true,
    onUse: ({ model, name, format }) => {
      $("#startModel").value = model;
      $("#servedName").value = deriveName(name || model);
      $("#loadFormat").value = format || "auto";
      setLaunchQuantizationFromModel(model);
      showView("service");
    },
  });
}

function renderRemoteModels() {
  const root = $("#remoteModelList");
  if (state.remoteError) {
    window.remoteModelRenderer?.render({
      root,
      error: state.remoteError,
      errorMessage: `联网模型列表加载失败：${state.remoteError}`,
      escapeHtml,
    });
    return;
  }
  const models = getVisibleRemoteModels();
  const hint = $("#remoteHint");
  if (hint) {
    const limit = state.remoteMeta?.limit || getRemoteLimit();
    const sizeFilter = $("#remoteSizeFilter")?.selectedOptions?.[0]?.textContent || "全部规格";
    const quantFilter = $("#remoteQuantFilter")?.selectedOptions?.[0]?.textContent || "全部 GGUF";
    const unknownCount = (state.remoteModels || []).filter((model) => !Number(model.paramsB || 0)).length;
    const unknownHint = unknownCount ? ` · ${fmtNumber(unknownCount)} 个未知规格可单独筛选` : "";
    hint.textContent = `已返回 ${fmtNumber(state.remoteModels.length)} 个在线模型，当前显示 ${fmtNumber(models.length)} 个 · ${sizeFilter} · ${quantFilter} · 上限 ${limit}${unknownHint}。列表按公开元数据和 GGUF 文件名估算，gated 模型下载前需要配置 token。`;
  }
  $("#remoteLoadMoreBtn")?.toggleAttribute("disabled", getRemoteLimit() >= 120);
  const english = effectiveLanguage() === "en-US";
  window.remoteModelRenderer?.render({
    root,
    models,
    allModels: state.remoteModels,
    emptyMessage: english ? "No matching online models. Try another keyword." : "没有找到匹配的在线模型。换个关键词再试。",
    labels: {
      updated: english ? "Updated" : "更新",
      downloads: english ? "Downloads" : "下载",
      likes: english ? "Likes" : "喜欢",
      params: english ? "Params" : "参数",
      file: english ? "File" : "文件",
      largest: english ? "Largest" : "最大",
      runnableOk: english ? "llama runnable" : "llama 可运行",
      runnableWarn: english ? "Use another manager" : "需换管理器",
      downloadTitle: english ? "Use in download form" : "填入下载页",
      downloadLabel: english ? "Download" : "下载",
      startTitle: english ? "Use in launch form" : "填入启动表单",
      startLabel: english ? "Launch" : "启动",
      openTitle: english ? "Open model page" : "打开介绍页",
    },
    escapeHtml,
    escapeAttr,
    fmtNumber,
    fmtBytes,
    formatDate,
    formatParamsB,
    isRunnableRemoteModel: isManagerRunnableRemoteModel,
    renderIcons,
    onDownload: (selected, fallback) => {
      fillDownloadForm(selected ? {
        ...selected,
        source: selected.source || "huggingface",
        summary: selected.summary || "已从在线模型列表填入下载信息。",
      } : {
        ...fallback,
        summary: "已从在线模型列表填入下载信息。",
      });
      showView("download");
    },
    onStart: (modelId) => {
      $("#startModel").value = modelId;
      $("#servedName").value = deriveName(modelId);
      $("#loadFormat").value = "auto";
      setLaunchQuantizationFromModel(modelId);
      showView("service");
    },
  });
}

function getVisibleRemoteModels() {
  const size = $("#remoteSizeFilter")?.value || "";
  const quant = $("#remoteQuantFilter")?.value || "";
  return (state.remoteModels || []).filter((model) => {
    if (size && !modelRemoteSizeMatches(model, size)) return false;
    if (quant && !modelRemoteQuantMatches(model, quant)) return false;
    if (state.runnableOnly && !isManagerRunnableRemoteModel(model)) return false;
    return true;
  });
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleDateString("zh-CN");
}

function renderJobs() {
  jobRenderer.renderJobs();
}

function renderBenchmarkProgress(job) {
  const progress = job.progress || {};
  const benchmark = job.meta?.benchmark || {};
  const percent = Number(progress.percent ?? (job.status === "success" ? 100 : job.status === "failed" ? 100 : 0));
  const fillClass = job.status === "failed" ? "fail" : job.status === "success" ? "ok" : "";
  const detail = benchmark.avgTokensPerSecond
    ? `${benchmark.avgTokensPerSecond.toFixed(2)} tok/s · 平均 ${fmtMs(benchmark.avgMs)}`
    : progress.detail || "等待测速结果";
  return `
    <div class="job-progress">
      <div class="download-progress-track">
        <div class="download-progress-fill ${fillClass}" style="width:${Math.min(100, Math.max(0, percent))}%"></div>
      </div>
      <div class="download-progress-meta">
        <span>${escapeHtml(progress.stage || job.status)} · ${percent.toFixed(0)}%</span>
        <small>${escapeHtml(detail)}</small>
      </div>
      ${benchmark.avgTokensPerSecond ? `<div class="job-actions"><button type="button" class="job-action-button" data-benchmark-action="view" data-job="${escapeAttr(job.id)}">查看结果</button></div>` : ""}
    </div>
  `;
}

function renderAutomationJobProgress(job) {
  const progress = job.progress || {};
  return `
    <div class="job-progress">
      <div class="download-progress-meta">
        <span>${escapeHtml(progress.stage || job.status)}</span>
        <small>${escapeHtml(progress.detail || job.error || "自动保护记录")}</small>
      </div>
    </div>
  `;
}

function renderServeProgress(job) {
  const progress = job.progress || {};
  const percent = Number(progress.percent ?? (job.status === "success" ? 100 : job.status === "failed" ? 100 : 0));
  const fillClass = job.status === "failed"
    ? "fail"
    : job.status === "success"
      ? "ok"
      : progress.state === "warn"
        ? "warn"
        : "";
  const stage = progress.stage || (job.status === "running" ? "启动中" : job.status);
  const issue = Array.isArray(progress.issues) && progress.issues.length ? progress.issues[progress.issues.length - 1] : "";
  const detail = issue || progress.detail || (job.logs || []).slice(-1)[0] || "等待启动日志";
  const actions = renderServeActions(job);
  return `
    <div class="job-progress">
      <div class="download-progress-track">
        <div class="download-progress-fill ${fillClass}" style="width:${Math.min(100, Math.max(0, percent))}%"></div>
      </div>
      <div class="download-progress-meta">
        <span>${escapeHtml(stage)} · ${percent.toFixed(0)}%</span>
        <small>${escapeHtml(detail)}</small>
      </div>
      ${actions}
    </div>
  `;
}

function renderServeActions(job) {
  if (job.status === "running") return "";
  const canStartDocker = isDockerDaemonIssue(job);
  const retryButton = `<button type="button" class="job-action-button" data-service-action="retry-serve" data-job="${escapeAttr(job.id)}">重试模型</button>`;
  const dockerButton = canStartDocker
    ? `<button type="button" class="job-action-button primary" data-service-action="start-docker">启动 Docker</button>`
    : "";
  if (!dockerButton && job.status !== "failed") return "";
  return `<div class="job-actions">${dockerButton}${retryButton}</div>`;
}

function fillDownloadForm(model) {
  $("#downloadSource").value = model.source || "huggingface";
  $("#downloadModel").value = model.model || model.id || "";
  $("#downloadOutputName").value = model.outputName || deriveName(model.model || model.id || "model");
  applyDownloadModelSelection(model);
}

async function resolveModelLink() {
  const url = $("#modelPageUrl").value.trim();
  if (!url) return null;
  $("#linkResolveResult").textContent = "正在解析模型页面...";
  try {
    const result = await api("/api/resolve-model-link", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    fillDownloadForm(result);
    $("#linkResolveResult").innerHTML = `
      <strong>${escapeHtml(result.label || result.model)}</strong>
      <span>${escapeHtml(result.source === "modelscope" ? "ModelScope" : "Hugging Face")} · ${escapeHtml(result.summary || "已解析成功，可以开始下载。")}</span>
    `;
    return result;
  } catch (error) {
    $("#linkResolveResult").textContent = error.message;
    throw error;
  }
}

async function downloadModel(event) {
  event.preventDefault();
  const clearBusy = setButtonBusy(event.submitter || event.currentTarget.querySelector("button[type='submit']"), "创建下载...");
  const form = new FormData(event.currentTarget);
  try {
    let model = String(form.get("model") || "").trim();
    let outputName = String(form.get("outputName") || "").trim();
    let source = String(form.get("source") || "huggingface");
    let precision = String(form.get("precision") || "").trim();
    const hfToken = String(form.get("hfToken") || "").trim();
    if (!model && $("#modelPageUrl").value.trim()) {
      const resolved = await resolveModelLink();
      model = resolved?.model || "";
      outputName = resolved?.outputName || "";
      source = resolved?.source || source;
      precision = resolved?.selection?.precision || precision;
    }
    if (!model) {
      notify("没有可下载的模型 ID", "请选择预设、粘贴模型链接，或手动填写模型 ID。", "info");
      return;
    }
    await api("/api/download", {
      method: "POST",
      body: JSON.stringify({ model, outputName, source, precision, ...(hfToken ? { hfToken } : {}) }),
    });
    notify("下载任务已创建", model, "success");
    await refreshJobs();
  } catch (error) {
    reportActionError("下载任务创建失败", error);
  } finally {
    clearBusy();
  }
}

async function startService(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  payload.gpuDeviceIds = form.getAll("gpuDeviceIds");
  payload.noMmap = form.get("noMmap") === "on";
  payload.textOnlyMode = form.get("textOnlyMode") === "on";
  payload.languageModelOnly = payload.textOnlyMode;
  payload.networkAccess = String(payload.networkAccess || "local");
  payload.clientPreset = String(payload.clientPreset || "openwebui");
  payload.reasoningFormat = payload.reasoningFormat === "auto"
    ? inferReasoningParser(payload.model, payload.clientPreset)
    : String(payload.reasoningFormat || "auto");
  payload.reasoning = String(payload.reasoning || "auto");
  payload.cacheTypeK = String(payload.cacheTypeK || "f16");
  payload.cacheTypeV = String(payload.cacheTypeV || "f16");
  payload.flashAttention = String(payload.flashAttention || "auto");
  payload.gpuLayers = String(payload.gpuLayers || "all");
  payload.tensorSplit = String(payload.tensorSplit || "");
  payload.mainGpu = Number(payload.mainGpu || 0);
  payload.batchSize = Number(payload.batchSize || 2048);
  payload.ubatchSize = Number(payload.ubatchSize || 512);
  payload.port = Number(payload.port || 8080);
  payload.maxModelLen = Number(payload.maxModelLen || 8192);
  payload.maxNumSeqs = Number(payload.maxNumSeqs || 4);
  payload.gpuMemoryUtilization = Number(payload.gpuMemoryUtilization || 0.92);
  await api("/api/start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  await refreshJobs();
}

async function handleRunningModelAction(event) {
  const button = event.target.closest("[data-running-action]");
  if (!button) return;
  const action = button.dataset.runningAction;
  button.disabled = true;
  const originalHtml = button.innerHTML;
  try {
    if (action === "unload-model") {
      button.textContent = "卸载中...";
      const result = await api("/api/running-models/unload", {
        method: "POST",
        body: JSON.stringify({ modelId: button.dataset.model || "" }),
      });
      showTestResult({ unloaded: result.unloaded, audit: result.audit });
      await Promise.all([refreshStatus(), refreshLogs()]);
      if (state.auditToken) refreshAuditExports().catch(() => {});
    }
  } catch (error) {
    showTestResult({ error: error.message });
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
    renderIcons();
  }
}

async function handleDownloadJobAction(event) {
  const button = event.target.closest("[data-download-action]");
  if (!button) return;
  const job = state.jobs.find((item) => item.id === button.dataset.job);
  if (!job) return;
  const meta = job.meta || {};
  if (button.dataset.downloadAction === "logs") {
    if (state.expandedJobLogs.has(job.id)) state.expandedJobLogs.delete(job.id);
    else state.expandedJobLogs.add(job.id);
    renderJobs();
    return;
  }
  if (button.dataset.downloadAction === "pause") {
    const clearBusy = setButtonBusy(button, "暂停中...");
    try {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/pause`, { method: "POST", body: "{}" });
      notify("下载已暂停", meta.model || job.title, "success");
      await refreshJobs();
    } catch (error) {
      reportActionError("暂停下载失败", error);
    } finally {
      clearBusy();
    }
    return;
  }
  if (button.dataset.downloadAction === "resume") {
    const clearBusy = setButtonBusy(button, "继续中...");
    try {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/resume`, { method: "POST", body: "{}" });
      notify("下载已继续", meta.model || job.title, "success");
      await refreshJobs();
    } catch (error) {
      reportActionError("继续下载失败", error);
    } finally {
      clearBusy();
    }
    return;
  }
  if (button.dataset.downloadAction === "cancel") {
    const ok = window.confirm("取消下载会停止任务，并删除该模型已下载的部分文件。确定继续吗？");
    if (!ok) return;
    const clearBusy = setButtonBusy(button, "取消中...");
    try {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST", body: "{}" });
      notify("下载已取消并清理", meta.model || job.title, "success");
      await refreshJobs();
    } catch (error) {
      reportActionError("取消下载失败", error);
    } finally {
      clearBusy();
    }
    return;
  }
  if (button.dataset.downloadAction === "use-start") {
    const model = meta.localDir || meta.model || "";
    $("#startModel").value = model;
    $("#servedName").value = deriveName(meta.outputName || meta.model || model);
    $("#loadFormat").value = inferLaunchFormat(model);
    setLaunchQuantizationFromModel(model);
    showView("service");
    notify("已填入启动表单", meta.outputName || meta.model || model, "success");
    return;
  }
  if (button.dataset.downloadAction !== "verify") return;
  const clearBusy = setButtonBusy(button, "校验中...");
  try {
    const result = await api("/api/download/verify", {
      method: "POST",
      body: JSON.stringify({ outputName: meta.outputName, localDir: meta.localDir }),
    });
    notify(result.ok ? "模型文件校验完成" : "模型文件可能不完整", `${fmtBytes(result.size || 0)} · ${fmtTokens(result.fileCount || 0)} files`, result.ok ? "success" : "error");
    showTestResult(result);
  } catch (error) {
    reportActionError("模型文件校验失败", error);
  } finally {
    clearBusy();
  }
}

async function handleServiceJobAction(event) {
  const button = event.target.closest("[data-service-action]");
  if (!button) return;
  const action = button.dataset.serviceAction;
  button.disabled = true;
  const originalText = button.textContent;
  try {
    if (action === "start-docker") {
      button.textContent = "正在启动...";
      await api("/api/docker/start", { method: "POST", body: "{}" });
      await Promise.all([refreshStatus(), refreshJobs()]);
      return;
    }
    if (action === "retry-serve") {
      button.textContent = "正在重试...";
      const job = state.jobs.find((item) => item.id === button.dataset.job);
      if (!job?.meta) throw new Error("找不到可重试的启动参数。");
      const payload = {
        ...job.meta,
        gpuDeviceIds: Array.isArray(job.meta.gpuDeviceIds) ? job.meta.gpuDeviceIds : [],
        noMmap: Boolean(job.meta.noMmap),
      };
      await api("/api/start", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await refreshJobs();
    }
  } catch (error) {
    showTestResult({ error: error.message });
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function loginAudit(event) {
  event.preventDefault();
  const password = $("#auditPassword").value;
  state.auditError = "";
  try {
    const result = await api("/api/audit/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    state.auditToken = result.token;
    localStorage.setItem("auditToken", state.auditToken);
    $("#auditPassword").value = "";
    await refreshAuditExports();
  } catch (error) {
    state.auditError = error.message;
    renderAudit();
  }
}

async function logoutAudit() {
  if (state.auditToken) {
    await auditApi("/api/audit/logout", { method: "POST", body: "{}" }).catch(() => {});
  }
  state.auditToken = "";
  state.auditMarkdown = "";
  state.selectedAuditId = "";
  state.auditError = "";
  localStorage.removeItem("auditToken");
  renderAudit();
}

async function manualAuditExport(event) {
  const button = event.currentTarget;
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = "生成中...";
  state.auditError = "";
  try {
    const result = await auditApi("/api/audit/export", {
      method: "POST",
      body: JSON.stringify({ note: "manual export from manager UI" }),
    });
    state.selectedAuditId = result.auditId || "";
    state.auditMarkdown = "";
    showTestResult({ audit: result });
    await refreshAuditExports();
  } catch (error) {
    state.auditError = error.message;
    renderAudit();
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
    renderIcons();
  }
}

async function handleAuditListAction(event) {
  const button = event.target.closest("[data-audit-action]");
  if (!button) return;
  const auditId = button.dataset.auditId || "";
  if (button.dataset.auditAction !== "view-md" || !auditId) return;
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = "读取中...";
  state.auditError = "";
  state.selectedAuditId = auditId;
  state.auditMarkdown = "正在读取完整 Markdown...";
  renderAudit();
  try {
    const response = await fetch(`/api/audit/exports/${encodeURIComponent(auditId)}/markdown`, {
      headers: { authorization: `Bearer ${state.auditToken}` },
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text || response.statusText;
      try {
        message = JSON.parse(text).error || message;
      } catch {
        // Plain text error.
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    state.auditMarkdown = text;
    renderAudit();
  } catch (error) {
    if (error.status === 401) {
      state.auditToken = "";
      localStorage.removeItem("auditToken");
    }
    state.auditError = error.message;
    state.auditMarkdown = "";
    renderAudit();
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
    renderIcons();
  }
}

async function stopService() {
  const result = await api("/api/stop", { method: "POST", body: "{}" });
  showTestResult({ stopped: result.removed, audit: result.audit });
  await Promise.all([refreshStatus(), refreshLogs()]);
  if (state.auditToken) refreshAuditExports().catch(() => {});
}

async function testService(event) {
  event.preventDefault();
  $("#testResult").textContent = "请求中...";
  try {
    const result = await api("/api/test", {
      method: "POST",
      body: JSON.stringify({
        model: $("#testModel").value,
        prompt: $("#testPrompt").value,
        port: Number($("#servicePort").value || 8080),
      }),
    });
    showTestResult(result);
  } catch (error) {
    showTestResult({ error: error.message });
  }
}

function showTestResult(result) {
  const content = result?.choices?.[0]?.message?.content;
  $("#testResult").textContent = content || JSON.stringify(result, null, 2);
}

function deriveName(value) {
  const leaf = String(value).split(/[\\/]/).filter(Boolean).pop() || "model";
  return leaf.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}

function renderIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  } else {
    document.querySelectorAll("i[data-lucide]").forEach((icon) => {
      icon.textContent = ICON_FALLBACKS[icon.dataset.lucide] || "";
    });
  }
  translateVisibleText();
  translateUiAttributes();
}

init();

