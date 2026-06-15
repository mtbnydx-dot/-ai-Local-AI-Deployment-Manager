const state = {
  config: null,
  models: { local: [], cached: [] },
  status: null,
  stats: null,
  jobs: [],
  remoteModels: [],
  remoteError: "",
  downloadPrecisionOptions: [],
  auditToken: localStorage.getItem("auditToken") || "",
  auditStatus: null,
  auditExports: [],
  auditMarkdown: "",
  selectedAuditId: "",
  auditError: "",
  claudeCompression: null,
  selectedGpuIds: new Set(),
  gpuSelectionTouched: false,
  gpuSignature: "",
  reasoningParserTouched: false,
  toolCallParserTouched: false,
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
  modelConfig: { key: "", data: null, loading: false },
  recentLaunches: [],
  statsHistory: [],
  statsRuntimeKey: "",
  modelPickerOpen: false,
  modelPickerSource: "all",
  expandedJobLogs: new Set(),
  runnableOnly: localStorage.getItem("vllmRunnableOnly") === "1",
  uiPrefs: {
    theme: localStorage.getItem("themeMode") || "auto",
    language: localStorage.getItem("languageMode") || "auto",
  },
};

const $ = (selector) => document.querySelector(selector);
const { fmtBytes, fmtNumber, fmtTokens, fmtPct, fmtRate, fmtMoney, escapeHtml, escapeAttr } = window.VllmFormat;
const { api, auditApi } = window.VllmApi.create(() => state.auditToken);
const { DOWNLOAD_SOURCES, PRECISION_PRESETS, MODEL_PRESETS, DTYPE_BYTES, KV_DTYPE_BYTES, QUANTIZATION_PROFILES, ICON_FALLBACKS } = window.VllmCatalog;
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
} = window.VllmModelUtils;
const { jobStatusInfo, jobTypeLabel, isDockerDaemonIssue, formatDuration } = window.VllmJobUtils;
const { inferGpuGeneration } = window.GpuPlanningUtils;

const { UI_COPY, UI_TEXT_TRANSLATIONS, UI_TRANSLATION_PATTERNS, UI_PARTIAL_TRANSLATIONS } = window.VllmI18n;
const { notify, setButtonBusy, reportActionError } = window.VllmUiUtils.create({ $, escapeHtml, renderIcons: () => renderIcons() });
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
      `${fmtTokens(cfg.maxNumSeqs || 0)} 并发`,
      `${cfg.kvCacheDtype || "auto"} KV`,
      cfg.clientPreset || "generic",
    ];
  },
  summaryParts(profile) {
    const cfg = profile.config || {};
    return [
      profile.description || "无说明",
      cfg.maxModelLen ? `${fmtTokens(cfg.maxModelLen)} 上下文` : "",
      cfg.multiGpuMode ? `${cfg.multiGpuMode} GPU` : "",
      cfg.clientPreset || "",
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
  sparkline,
  renderIcons,
  summaryHeroClass: "stats-metric-hero",
  endpointDetails: {
    claude: "给 Claude Desktop / CC Switch 使用，客户端再拼 /v1/messages。",
    openai: "给 OpenWebUI、OpenCode 或 OpenAI SDK 使用，路径为 /v1/chat/completions。",
  },
});
const jobRenderer = window.LocalAiJobRenderer.create({
  $,
  state,
  escapeHtml,
  escapeAttr,
  fmtBytes,
  formatDuration,
  formatDateTime,
  jobStatusInfo,
  jobTypeLabel,
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
  defaultServicePort: 8000,
  includeOpenCode: true,
  apiKeySummary: (service) => (service.apiKeyRequired ? "运行中已启用" : "运行中未启用"),
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
  renderGpuPlan: () => renderVllmGpuPlan(),
  renderRuntimeFacts: (status) => renderRuntimeFacts(status),
  options: {
    subtitlePrefix: "vLLM",
    defaultContainerName: "vllm-local",
    noRunningText: "当前没有运行中的 vLLM 模型。启动模型后，这里会显示服务名、API 地址和卸载按钮。",
    loadingTitle: "vLLM 容器正在运行",
    includeApiKeyBadge: true,
    includeClaudeModelAlias: true,
    showSpeed: true,
    showKvBar: true,
    defaultGpuSelection: "first",
    contextWarnPct: 85,
    vramWarnPct: 92,
    syncTestModelFromRunning: true,
    onGpuPickerStable: () => renderVllmGpuPlan(),
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
  options: {
    showCompressionSessions: true,
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
  options: {
    totalTokensLabel: "累计 tokens",
    heroFirstMetric: true,
    includeRuntimeModels: true,
    includePrefixCache: true,
  },
});

const originalTextNodes = new WeakMap();
const originalAttributes = new WeakMap();
let languageObserver = null;
let languageTranslationScheduled = false;

function effectiveLanguage() {
  const mode = state.uiPrefs.language || "auto";
  if (mode === "zh-CN" || mode === "en-US") return mode;
  return String(navigator.language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

function t(key) {
  const lang = effectiveLanguage();
  return UI_COPY[lang]?.[key] || UI_COPY["zh-CN"][key] || key;
}

function initUiPreferences() {
  const theme = ["auto", "light", "dark"].includes(state.uiPrefs.theme) ? state.uiPrefs.theme : "auto";
  const language = ["auto", "zh-CN", "en-US"].includes(state.uiPrefs.language) ? state.uiPrefs.language : "auto";
  state.uiPrefs.theme = theme;
  state.uiPrefs.language = language;
  if ($("#themeMode")) $("#themeMode").value = theme;
  if ($("#languageMode")) $("#languageMode").value = language;
  initLanguageObserver();
  applyThemeMode();
  applyLanguageMode();
}

function applyThemeMode() {
  const mode = ["auto", "light", "dark"].includes(state.uiPrefs.theme) ? state.uiPrefs.theme : "auto";
  document.documentElement.dataset.theme = mode;
}

function applyLanguageMode() {
  const lang = effectiveLanguage();
  document.documentElement.lang = lang;
  document.title = `vLLM Manager - ${t("app.title")}`;
  setText(".brand p", t("brand.subtitle"));
  setText(".topbar h2", t("app.title"));
  setText("[data-view='service'] span", t("nav.service"));
  setText("[data-view='models'] span", t("nav.models"));
  setText("[data-view='download'] span", t("nav.download"));
  setText("[data-view='exposure'] span", t("nav.exposure"));
  setText("[data-view='external-access'] span", t("nav.externalAccess"));
  setText("[data-view='tools'] span", t("nav.tools"));
  setText("[data-view='stats'] span", t("nav.stats"));
  setText("[data-view='audit'] span", t("nav.audit"));
  setText("[data-view='logs'] span", t("nav.logs"));
  setText("#modelPickerToggle span", t("modelPicker.toggle"));
  setText(".model-picker-field > span", t("modelPicker.label"));
  setAttr("#refreshBtn", "title", t("refresh"));
  setAttr("#modelPickerRefresh", "title", t("modelPicker.refresh"));
  setAttr("#modelPickerSearch", "placeholder", t("modelPicker.search"));
  setText("#modelPickerRunnableOnly span", t("modelPicker.runnableOnly"));
  setAttr("#modelPickerRunnableOnly", "title", t("modelPicker.runnableTitle"));
  setText("#remoteRunnableOnly span", t("remote.runnableOnly"));
  setAttr("#remoteRunnableOnly", "title", t("remote.runnableTitle"));
  setText("#downloadRunnableModelsBtn span", t("download.runnableModels"));
  setOptionTexts("#themeMode", {
    auto: t("theme.auto"),
    light: t("theme.light"),
    dark: t("theme.dark"),
  });
  setOptionTexts("#languageMode", {
    auto: t("language.auto"),
    "zh-CN": t("language.zh"),
    "en-US": t("language.en"),
  });
  setPickerTabText("all", t("modelPicker.all"));
  setPickerTabText("favorite", t("modelPicker.favorite"));
  setPickerTabText("local", t("modelPicker.local"));
  setPickerTabText("cached", t("modelPicker.cached"));
  setPickerTabText("remote", t("modelPicker.remote"));
  renderRunnableFilterToggles();
  renderModelPicker();
  translatePageText();
}

function setText(selector, text) {
  const node = $(selector);
  if (node) node.textContent = text;
}

function setAttr(selector, attr, value) {
  const node = $(selector);
  if (node) node.setAttribute(attr, value);
}

function setOptionTexts(selector, labelsByValue) {
  const select = $(selector);
  if (!select) return;
  Array.from(select.options).forEach((option) => {
    if (Object.prototype.hasOwnProperty.call(labelsByValue, option.value)) {
      option.textContent = labelsByValue[option.value];
    }
  });
}

function setPickerTabText(source, text) {
  const button = $(`#modelPickerTabs [data-model-source='${source}']`);
  if (button) button.textContent = text;
}

function initLanguageObserver() {
  if (languageObserver || !document.body) return;
  languageObserver = new MutationObserver(() => {
    scheduleLanguageTranslation();
  });
  languageObserver.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function scheduleLanguageTranslation() {
  if (effectiveLanguage() !== "en-US" || languageTranslationScheduled) return;
  languageTranslationScheduled = true;
  window.setTimeout(() => {
    languageTranslationScheduled = false;
    translatePageText();
  }, 0);
}

function translatePageText(root = document.body) {
  if (!root) return;
  const lang = effectiveLanguage();
  translateTextNodes(root, lang);
  translateAttributes(root, lang);
  translateDefaultFormValues(lang);
}

function translateTextNodes(root, lang) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || shouldSkipTranslation(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    const original = originalTextNodes.get(node) || node.nodeValue;
    if (lang === "en-US") {
      originalTextNodes.set(node, original);
      const translated = translateUiTextPreservingSpace(original);
      if (node.nodeValue !== translated) node.nodeValue = translated;
    } else if (originalTextNodes.has(node) && node.nodeValue !== original) {
      node.nodeValue = original;
    }
  });
}

function translateAttributes(root, lang) {
  const attrs = ["title", "placeholder", "aria-label"];
  const elements = [root, ...Array.from(root.querySelectorAll ? root.querySelectorAll("*") : [])]
    .filter((item) => item instanceof Element && !shouldSkipTranslation(item));
  elements.forEach((element) => {
    attrs.forEach((attr) => {
      if (!element.hasAttribute(attr)) return;
      const map = originalAttributes.get(element) || {};
      const original = map[attr] || element.getAttribute(attr) || "";
      if (lang === "en-US") {
        originalAttributes.set(element, { ...map, [attr]: original });
        const translated = translateUiText(original);
        if (translated !== original) element.setAttribute(attr, translated);
      } else if (map[attr]) {
        element.setAttribute(attr, map[attr]);
      }
    });
  });
}

function translateDefaultFormValues(lang) {
  const valueIds = ["testPrompt", "benchmarkPrompt"];
  valueIds.forEach((id) => {
    const element = document.getElementById(id);
    if (!element || element.dataset.userEdited === "true") return;
    if (!element.dataset.originalValue) element.dataset.originalValue = element.value || element.textContent || "";
    const original = element.dataset.originalValue;
    const next = lang === "en-US" ? translateUiText(original) : original;
    if ("value" in element && element.value !== next) element.value = next;
    if (!("value" in element) && element.textContent !== next) element.textContent = next;
  });
}

function shouldSkipTranslation(element) {
  return Boolean(element.closest("script, style, code, .logs-box, .audit-markdown, [data-no-i18n]"));
}

function translateUiTextPreservingSpace(value) {
  const leading = value.match(/^\s*/)?.[0] || "";
  const trailing = value.match(/\s*$/)?.[0] || "";
  const core = value.trim().replace(/\s+/g, " ");
  if (!core) return value;
  const translated = translateUiText(core);
  return translated === core ? value : `${leading}${translated}${trailing}`;
}

function translateUiText(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return value;
  if (UI_TEXT_TRANSLATIONS[text]) return applyPartialTranslations(UI_TEXT_TRANSLATIONS[text]);
  for (const [pattern, replacement] of UI_TRANSLATION_PATTERNS) {
    if (pattern.test(text)) return applyPartialTranslations(text.replace(pattern, replacement));
  }
  if (/\p{Script=Han}/u.test(text)) {
    const translated = applyPartialTranslations(text);
    if (translated !== text) return translated;
  }
  return value;
}

function applyPartialTranslations(value) {
  let translated = String(value || "");
  UI_PARTIAL_TRANSLATIONS.forEach(([pattern, replacement]) => {
    translated = translated.replace(pattern, replacement);
  });
  return translated;
}

function enhanceUiArchitecture() {
  ensureServiceExposureUi();
  ensureModelPickerRunningTab();
  ensureStatusInsightMetrics();
  enhanceLaunchFormLayout();
  enhanceToolsPage();
}

function ensureServiceExposureUi() {
  uiArchitecture.ensureServiceExposureUi({
    navLabel: t("nav.exposure"),
    includeOpenCode: true,
    formNote: "局域网或公网服务建议同时使用 API Key、固定模型别名、日志统计和反向代理限流。保存后如需生效到容器，请点“应用到启动表单”并重启模型。",
    clientDescription: "给 OpenWebUI、Claude、OpenCode 或局域网设备单独发 Key，并限制模型、速率和并发。",
  });
}

function ensureModelPickerRunningTab() {
  const tabs = $("#modelPickerTabs");
  if (!tabs || tabs.querySelector("[data-model-source='running']")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.modelSource = "running";
  button.textContent = t("modelPicker.running");
  tabs.appendChild(button);
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
  ensureVllmGpuPlanner();
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
  const grid = section?.querySelector(".context-control-grid");
  if (!section || !grid || grid.dataset.grouped === "true") return;
  grid.dataset.grouped = "true";
  grid.classList.add("context-control-grid-enhanced");
  const basic = createControlGroup("上下文大小", "决定最大输入窗口和本地 Claude 单路并发。", ["#maxModelLen", "#maxNumSeqs"]);
  const kv = createControlGroup("显存与 KV cache", "显存占用比例决定 KV cache 池大小；KV 精度选 FP8 更省显存。", ["#gpuMemoryUtilization", "#kvCacheDtype"]);
  const offload = createControlDisclosure("显存 offload 与多模态预留", "CPU offload 是每卡权重回退，KV offload 是总 KV 缓冲；能救容量但会拖慢。", ["#cpuOffloadGb", "#kvOffloadingSize", "#mmProcessorCacheGb", "#enablePrefixCaching", "#languageModelOnly"]);
  grid.replaceChildren(basic, kv, offload);
}

function createControlGroup(title, description, selectors) {
  const group = document.createElement("div");
  group.className = "control-group";
  group.innerHTML = `<div class="control-group-head"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div><div class="control-group-grid"></div>`;
  const body = group.querySelector(".control-group-grid");
  selectors.map(controlForSelector).filter(Boolean).forEach((node) => body.appendChild(node));
  return group;
}

function createControlDisclosure(title, description, selectors) {
  const details = document.createElement("details");
  details.className = "control-disclosure";
  details.innerHTML = `<summary><span>${escapeHtml(title)}</span><small>${escapeHtml(description)}</small></summary><div class="control-group-grid"></div>`;
  const body = details.querySelector(".control-group-grid");
  selectors.map(controlForSelector).filter(Boolean).forEach((node) => body.appendChild(node));
  return details;
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
      <small>量化、加载格式、工具解析、Claude 压缩、网络和执行后端。</small>
    </summary>
    <div class="advanced-grid"></div>
  `;
  const body = details.querySelector(".advanced-grid");
  [
    "#launchDtype",
    "#launchQuantization",
    "#loadFormat",
    "#ggufSection",
    "#clientPreset",
    "#reasoningParser",
    "#reasoningNote",
    ".tool-section",
    ".compression-section",
    "#networkAccess",
    "#vllmApiKey",
    "#networkNote",
    "[name='distributedExecutorBackend']",
    ".parallel-size-grid",
    "#parallelHintNote",
    "[name='enableExpertParallel']",
    "[name='trustRemoteCode']",
  ].map(controlForSelector).filter(Boolean).forEach((node) => body.appendChild(node));
  const submit = form.querySelector(".primary-button[type='submit']");
  form.insertBefore(details, submit);
}

function ensureVllmGpuPlanner() {
  const gpuSection = document.querySelector(".gpu-section");
  if (!gpuSection || $("#vllmGpuPlan")) return;
  const plan = document.createElement("div");
  plan.className = "hetero-plan vllm-gpu-plan";
  plan.id = "vllmGpuPlan";
  plan.innerHTML = `<div class="empty compact">选择 GPU 后会显示 vLLM 并行建议。</div>`;
  const actions = document.createElement("div");
  actions.className = "hetero-actions";
  actions.id = "vllmGpuPresetButtons";
  const guide = document.createElement("div");
  guide.className = "selection-hint multi-gpu-mode-guide";
  guide.id = "multiGpuModeGuide";
  guide.textContent = "本地 Claude 单路优先单卡或 pipeline；Tensor Parallel 更适合同规格多卡，异构卡会被慢卡拖住。";
  gpuSection.append(plan, actions, guide);
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
  setToolGroup(localStorage.getItem("vllmToolGroup") || "diagnostics");
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
  localStorage.setItem("vllmToolGroup", group);
  document.querySelectorAll("#toolTabs [data-tool-group]").forEach((button) => {
    button.classList.toggle("active", button.dataset.toolGroup === group);
  });
  document.querySelectorAll("#tools .panel[data-tool-group]").forEach((panel) => {
    panel.classList.toggle("tool-panel-hidden", panel.dataset.toolGroup !== group);
  });
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
    await Promise.all([refreshStatus(), refreshModels(), refreshLogs(), refreshServiceExposure(), refreshServiceClients()]);
    refreshRemoteModels().catch((error) => {
      state.remoteError = error.message;
      renderRemoteModels();
    });
    refreshStats().catch(() => {});
    refreshAuditStatus().catch(() => {});
    refreshClaudeCompression().catch(() => {});
    refreshToolData().catch(() => {});
    // 页面在后台时跳过轮询，避免无谓请求
    setInterval(() => {
      if (!document.hidden) refreshStatus().catch(() => {});
    }, 5000);
    setInterval(() => {
      if (!document.hidden) refreshJobs().catch(() => {});
    }, 3000);
    setInterval(() => {
      if (!document.hidden && location.hash === "#stats") refreshStats().catch(() => {});
    }, 5000);
    setInterval(() => {
      if (!document.hidden && location.hash === "#external-access") refreshExternalAccess().catch(() => {});
    }, 5000);
  } catch (error) {
    notify("管理器初始化失败", error.message, "error");
    showTestResult({ error: error.message });
  }
  updateGgufModeState();
  updateReasoningNote();
  updateToolCallNote();
  scheduleModelConfigFetch();
  refreshRecentLaunches().catch(() => {});
  loadDownloadSettings().catch(() => {});
  runPortCheck();
  renderIcons();
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      showView(link.dataset.view);
    });
  });
  window.addEventListener("hashchange", () => showView(location.hash.replace("#", "") || "service", false));
  $("#themeMode").addEventListener("change", (event) => {
    state.uiPrefs.theme = event.currentTarget.value || "auto";
    localStorage.setItem("themeMode", state.uiPrefs.theme);
    applyThemeMode();
  });
  $("#languageMode").addEventListener("change", (event) => {
    state.uiPrefs.language = event.currentTarget.value || "auto";
    localStorage.setItem("languageMode", state.uiPrefs.language);
    applyLanguageMode();
  });
  $("#modelPickerToggle").addEventListener("click", (event) => {
    event.preventDefault();
    toggleModelPicker();
  });
  $("#modelPickerRefresh").addEventListener("click", refreshModelPickerData);
  $("#modelPickerSearch").addEventListener("input", renderModelPicker);
  $("#modelPickerRunnableOnly")?.addEventListener("click", toggleRunnableOnly);
  $("#modelPickerTabs").addEventListener("click", handleModelPickerTabClick);
  $("#modelPickerList").addEventListener("click", handleModelPickerSelection);
  document.addEventListener("click", handleModelPickerOutsideClick);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModelPicker();
  });
  $("#refreshBtn").addEventListener("click", () => Promise.all([refreshStatus(), refreshModels(), refreshLogs()]));
  $("#serviceExposureForm")?.addEventListener("submit", saveServiceExposure);
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
  $("#remoteTask")?.addEventListener("change", refreshRemoteModels);
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
  $("#refreshToolsBtn").addEventListener("click", refreshToolData);
  $("#runHealthBtn").addEventListener("click", refreshHealth);
  $("#saveProfileBtn").addEventListener("click", saveCurrentProfile);
  $("#runModelCheckBtn").addEventListener("click", runModelCheck);
  $("#runLogSummaryBtn").addEventListener("click", refreshLogSummary);
  $("#saveAutomationBtn").addEventListener("click", saveAutomationSettings);
  $("#benchmarkForm").addEventListener("submit", startBenchmark);
  $("#reloadConnectionBtn").addEventListener("click", refreshConnectionGuide);
  $("#reloadCompressionInsightsBtn").addEventListener("click", refreshCompressionInsights);
  $("#saveModelNoteBtn").addEventListener("click", saveModelNote);
  $("#profileList").addEventListener("click", handleProfileAction);
  $("#serviceProfileApply")?.addEventListener("click", applySelectedServiceProfile);
  $("#serviceProfileSave")?.addEventListener("click", saveCurrentProfile);
  $("#serviceProfileSelect")?.addEventListener("change", renderServiceProfileSummary);
  $("#toolTabs")?.addEventListener("click", handleToolTabClick);
  $("#vllmGpuPresetButtons")?.addEventListener("click", handleVllmGpuPresetClick);
  $("#modelNotesList").addEventListener("click", handleModelNoteAction);
  $("#benchmarkJobList").addEventListener("click", handleBenchmarkJobAction);
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
  $("#claudeSetupBtn").addEventListener("click", setupClaudeBridge);
  $("#saveClaudeCompressionBtn").addEventListener("click", saveClaudeCompression);
  ["#claudeCompressionEnabled", "#claudeCompressionTrigger", "#claudeCompressionRecent", "#claudeCompressionSummary"].forEach((selector) => {
    $(selector).addEventListener("input", updateClaudeCompressionNote);
    $(selector).addEventListener("change", updateClaudeCompressionNote);
  });
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
  ["#testPrompt", "#benchmarkPrompt", "#testModel"].forEach((selector) => {
    const element = $(selector);
    if (element) element.addEventListener("input", () => { element.dataset.userEdited = "true"; });
  });
  $("#networkAccess").addEventListener("change", renderNetworkNote);
  $("#servicePort").addEventListener("input", renderNetworkNote);
  $("#servicePort").addEventListener("input", schedulePortCheck);
  $("#vllmApiKey")?.addEventListener("input", renderNetworkNote);
  $("#autoTuneBtn")?.addEventListener("click", autoTuneLaunch);
  $("#recentLaunches")?.addEventListener("click", handleRecentLaunchAction);
  $("#downloadQueueMode")?.addEventListener("change", saveDownloadQueueMode);
  $("#remoteSource")?.addEventListener("change", refreshRemoteModels);
  ["#startModel", "#maxModelLen", "#maxNumSeqs", "#gpuMemoryUtilization", "#cpuOffloadGb", "#kvOffloadingSize", "#mmProcessorCacheGb", "#launchDtype", "#launchQuantization", "#loadFormat", "#kvCacheDtype", "#tensorParallelSize", "#pipelineParallelSize", "#dataParallelSize", "#languageModelOnly"].forEach((selector) => {
    $(selector).addEventListener("input", updateMemoryEstimate);
    $(selector).addEventListener("change", updateMemoryEstimate);
  });
  $("#startModel").addEventListener("input", () => {
    updateGgufModeState();
    updateReasoningNote();
    updateToolCallNote();
    scheduleModelConfigFetch();
  });
  $("#startModel").addEventListener("change", scheduleModelConfigFetch);
  $("#loadFormat").addEventListener("change", updateGgufModeState);
  $("#clientPreset").addEventListener("change", () => {
    state.reasoningParserTouched = false;
    state.toolCallParserTouched = false;
    updateReasoningNote();
    updateToolCallNote();
  });
  $("#reasoningParser").addEventListener("change", () => {
    state.reasoningParserTouched = $("#reasoningParser").value !== "auto";
    updateReasoningNote();
  });
  $("#toolCallParser").addEventListener("change", () => {
    state.toolCallParserTouched = $("#toolCallParser").value !== "auto";
    updateToolCallNote();
  });
  $("#enableAutoToolChoice").addEventListener("change", updateToolCallNote);
  $("#contextPresetButtons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-context-preset]");
    if (!button) return;
    $("#maxModelLen").value = button.dataset.contextPreset;
    updateMemoryEstimate();
  });
  $("#memoryEstimateNote")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-apply-context]");
    if (!button) return;
    $("#maxModelLen").value = button.dataset.applyContext;
    updateMemoryEstimate();
    notify("已应用推荐上下文", `${fmtTokens(Number(button.dataset.applyContext))} tokens`, "success");
  });
  ["#downloadDeveloper", "#downloadVersion", "#downloadSpec", "#downloadPrecision", "#downloadSource"].forEach((selector) => {
    $(selector).addEventListener("change", updateDownloadPreset);
  });
  ["#downloadModel", "#downloadPrecision", "#downloadSource"].forEach((selector) => {
    $(selector)?.addEventListener("change", scheduleDownloadEstimate);
  });
  $("#downloadModel")?.addEventListener("input", scheduleDownloadEstimate);
  // 模型 ID 变化时自动同步保存名，避免下载进上一个模型的目录；手动改过保存名则不再覆盖
  $("#downloadModel")?.addEventListener("input", syncDownloadOutputNameFromModel);
  $("#downloadOutputName")?.addEventListener("input", (event) => {
    if (event.currentTarget.value.trim()) {
      event.currentTarget.dataset.userEdited = "true";
    } else {
      delete event.currentTarget.dataset.userEdited;
      syncDownloadOutputNameFromModel();
    }
  });
  $("#multiGpuMode").addEventListener("change", updateParallelDefaults);
  $("#gpuPicker").addEventListener("change", (event) => {
    if (event.target.name !== "gpuDeviceIds") return;
    state.gpuSelectionTouched = true;
    state.selectedGpuIds = new Set(getSelectedGpuIds());
    updateParallelDefaults();
  });
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
  if (next === "service") refreshRecentLaunches().catch(() => {});
  if (next === "exposure") {
    refreshServiceExposure().catch(() => {});
    refreshServiceClients().catch(() => {});
  }
  if (next === "stats") refreshStats().catch(() => {});
  if (next === "external-access") refreshExternalAccess().catch(() => {});
  if (next === "tools") refreshToolData().catch(() => {});
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
  // 始终用原始仓库 ID；量化版仓库名不固定，由「在线查找」引导用户找真实仓库。
  // 只有初始化或切换 开发商/版本/规格 时才回填模型 ID，改精度/来源不能覆盖手填内容。
  const repo = preset ? preset.repo : "";
  if (presetSelectionChanged && repo) {
    $("#downloadModel").value = repo;
    setDownloadOutputName(deriveName(repo));
  }

  const sourceHint = DOWNLOAD_SOURCES[source]?.hint || "";
  const wantsQuant = precision.value !== "base" && Boolean(precision.quantFilter);
  const precisionHint = precision.value === "base"
    ? "已填入原始权重仓库，质量最好、显存占用也最高。"
    : wantsQuant
      ? `已填入原始仓库 ID。${precision.label} 量化版通常由第三方发布、仓库名不固定，点下方「在线查找」按真实仓库筛选更稳妥。`
      : "";
  const selectionHint = preset?.note || "当前下拉项来自已选择的在线模型；仍可手动修改模型 ID 和保存名称。";
  $("#downloadPresetHint").textContent = [sourceHint, precisionHint, selectionHint].filter(Boolean).join(" ");
  renderQuantFinder(preset, precision);
  scheduleDownloadEstimate();
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
  finder.innerHTML = `<button type="button" class="ghost-mini-button" data-quant-search="${escapeAttr(leaf)}" data-quant-filter="${escapeAttr(precision.quantFilter)}"><i data-lucide="search"></i><span>在线查找 ${escapeHtml(leaf)} 的 ${escapeHtml(precision.label)} 版本</span></button>`;
  renderIcons();
}

function openQuantSearch(searchTerm, quantFilter) {
  const sizeFilter = $("#remoteSizeFilter");
  if (sizeFilter) sizeFilter.value = "";
  if ($("#remoteSource")) $("#remoteSource").value = "huggingface";
  if ($("#remoteSearch")) $("#remoteSearch").value = searchTerm;
  if ($("#remoteQuantFilter")) $("#remoteQuantFilter").value = quantFilter || "";
  if ($("#remoteSort")) $("#remoteSort").value = "downloads";
  showView("models");
  refreshRemoteModels().catch((error) => {
    state.remoteError = error.message;
    renderRemoteModels();
  });
}

function getSelectedPreset() {
  const developer = $("#downloadDeveloper").value;
  const version = $("#downloadVersion").value;
  const spec = $("#downloadSpec").value;
  return MODEL_PRESETS.find((item) => item.developer === developer && item.version === version && item.spec === spec);
}

let downloadEstimateTimer = null;
let downloadEstimateSeq = 0;
let remoteSearchSeq = 0;

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
    behavior = `${precisionLabel} 不会自动改写仓库 ID，也没有安全的文件过滤规则；将下载整个仓库。建议先用“在线查找”选择真实量化仓库。`;
  } else {
    behavior = "下载整个仓库，适合原始 BF16/FP16 或已经确认的量化仓库。";
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
    if (seq !== downloadEstimateSeq) return; // 已有更新的请求，丢弃过期结果
    updateDownloadPlanPreview(result);
    const diskText = result.diskFreeBytes ? `模型盘剩余 ${fmtBytes(result.diskFreeBytes)}` : "";
    if (result.bytes) {
      const free = Number(result.diskFreeBytes || 0);
      // 留 5% 或 10GB 余量再判断是否放得下
      const insufficient = free && result.bytes > free - Math.max(free * 0.05, 10 * 1024 ** 3);
      box.dataset.state = insufficient ? "warn" : "ok";
      const sizeText = `预计下载约 ${fmtBytes(result.bytes)}（${fmtNumber(result.fileCount || 0)} 个文件）`;
      textEl.textContent = insufficient
        ? `${sizeText}，但${diskText}，磁盘空间可能不足，请清理或换盘。`
        : `${sizeText}。${diskText ? diskText + "，空间充足。" : "请确认本地磁盘空间充足。"}`;
    } else {
      box.dataset.state = "info";
      const noMatch = Array.isArray(result.includePatterns) && result.includePatterns.length && Number(result.fileCount || 0) === 0
        ? `没有匹配 ${result.includePatterns.join(", ")} 的文件，请换真实量化仓库或改成下载整个仓库。`
        : "无法读取该仓库的文件体积（可能是 gated 或私有），下载时会显示实际进度。";
      textEl.textContent = noMatch
        + (diskText ? ` ${diskText}。` : "");
    }
  } catch (error) {
    if (seq !== downloadEstimateSeq) return;
    box.dataset.state = "warn";
    textEl.textContent = `体积预估失败：${error.message}`;
  }
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
  // 在线模型回填的“原始 BF16/FP16”等价于 base，不能给它生成量化查找入口
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

// 程序回填保存名时清掉“手动编辑”标记，让后续模型 ID 变化能继续自动同步
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
}

async function refreshStatus() {
  state.status = await api("/api/status");
  renderStatus();
  renderNetworkNote();
  state.jobs = state.status.jobs || [];
  renderJobs();
  renderModelPicker();
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

async function refreshModels() {
  state.models = await api("/api/models");
  renderModels();
  updateGgufModeState();
  renderModelPicker();
  updateSidebarFoot();
}

async function refreshRemoteModels() {
  const seq = ++remoteSearchSeq;
  const root = $("#remoteModelList");
  root.innerHTML = `<div class="empty">正在联网查询模型...</div>`;
  state.remoteError = "";
  const params = new URLSearchParams({
    source: $("#remoteSource")?.value || "huggingface",
    sort: $("#remoteSort")?.value || "trending",
    task: $("#remoteTask")?.value || "all",
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
      sort: result.sort || $("#remoteSort")?.value || "trending",
      task: result.task || $("#remoteTask")?.value || "all",
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
  localStorage.setItem("vllmRunnableOnly", state.runnableOnly ? "1" : "0");
  renderRunnableFilterToggles();
  renderRemoteModels();
  renderModelPicker();
}

function renderRunnableFilterToggles() {
  [
    ["#modelPickerRunnableOnly", t("modelPicker.runnableTitle")],
    ["#remoteRunnableOnly", t("remote.runnableTitle")],
  ].forEach(([selector, title]) => {
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

async function refreshClaudeCompression() {
  state.claudeCompression = await api("/api/claude/context-compression");
  renderClaudeCompressionSettings();
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
  const message = error?.message || String(error || "读取失败");
  if (root.tagName === "DIV") root.innerHTML = `<div class="empty compact">读取失败：${escapeHtml(message)}</div>`;
  else root.textContent = message;
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

async function refreshModelPickerData(event) {
  const clearBusy = event?.currentTarget ? setButtonBusy(event.currentTarget, t("modelPicker.refreshing")) : () => {};
  try {
    const results = await Promise.allSettled([
      refreshModels(),
      refreshModelNotes(),
      refreshRemoteModels(),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      const message = failed.reason?.message || String(failed.reason || "");
      state.remoteError = state.remoteError || message;
      renderRemoteModels();
      notify("模型列表刷新部分失败", message, "error");
    }
  } finally {
    clearBusy();
    renderModelPicker();
  }
}

function toggleModelPicker(force) {
  const next = typeof force === "boolean" ? force : !state.modelPickerOpen;
  state.modelPickerOpen = next;
  renderModelPicker();
  if (next) window.setTimeout(() => $("#modelPickerSearch")?.focus(), 0);
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
    silent: false,
  });
}

function selectLaunchModel(model, options = {}) {
  const value = String(model || "").trim();
  if (!value) return;
  $("#startModel").value = value;
  $("#servedName").value = deriveName(options.name || value);
  $("#loadFormat").value = options.format || inferLaunchFormat(value);
  setLaunchQuantizationFromModel(value);
  updateGgufModeState();
  updateMemoryEstimate();
  updateReasoningNote();
  updateToolCallNote();
  scheduleModelConfigFetch();
  closeModelPicker();
  if (!options.silent) notify(t("modelPicker.selected"), options.name || value, "success");
  showView("service");
}

function inferLaunchFormat(model) {
  const local = getLocalModelForInput(model);
  return local?.hasGguf && !local?.hasConfig ? "gguf" : "auto";
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
    favoriteLabel: t("modelPicker.favorite"),
    emptyMessage: t("modelPicker.empty"),
    limitMessage: english ? "Showing first 80 models. Keep typing to narrow results." : "当前只显示前 80 个结果，继续输入关键词可以缩小范围。",
  });
}

function buildModelPickerItems() {
  const items = [];
  const notes = Object.values(state.modelNotes?.notes || {});
  const noteMap = new Map(notes.map((note) => [normalizePathKey(note.model), note]));
  const add = (item) => {
    if (!item.model) return;
    items.push({
      ...item,
      badges: (item.badges || []).filter(Boolean),
    });
  };

  (state.status?.runningModels || []).forEach((model) => {
    const modelId = model.id || model.model || "";
    add({
      source: "running",
      sourceLabel: t("modelPicker.running"),
      label: modelId,
      model: modelId,
      detail: model.maxModelLen ? `${fmtTokens(model.maxModelLen)} context` : "vLLM",
      format: "auto",
      contextTokens: model.maxModelLen || model.contextCapacityTokens || 0,
      runningSpeed: model.tokensPerSecond || model.outputTokensPerSecond || "",
      badges: [t("modelPicker.running"), model.contextUsedTokens ? `${fmtTokens(model.contextUsedTokens)} used` : ""],
    });
  });

  notes.filter((note) => note.favorite).forEach((note) => {
    add({
      source: "favorite",
      sourceLabel: t("modelPicker.favorite"),
      label: note.model,
      model: note.model,
      detail: note.note || (note.tags || []).join(", "),
      format: inferLaunchFormat(note.model),
      favorite: true,
      badges: [t("modelPicker.favorite"), ...(note.tags || []).slice(0, 3)],
    });
  });

  (state.models.local || []).forEach((model) => {
    const note = findModelNote(noteMap, model.launchModel, model.path, model.label, model.id);
    add({
      source: "local",
      sourceLabel: t("modelPicker.local"),
      label: model.label || model.id || model.launchModel,
      model: model.launchModel || model.path || model.id,
      detail: model.path || "",
      format: model.hasGguf && !model.hasConfig ? "gguf" : "auto",
      sizeBytes: model.size || 0,
      quantLabel: inferModelQuantLabel([model.label, model.path, model.ggufFiles?.[0]?.name].filter(Boolean).join(" ")),
      favorite: Boolean(note?.favorite),
      badges: [
        t("modelPicker.local"),
        model.size ? fmtBytes(model.size) : "",
        model.hasConfig ? "config" : "",
        model.hasGguf ? "GGUF" : "",
        model.ggufFiles?.[0]?.name || "",
        note?.favorite ? t("modelPicker.favorite") : "",
      ],
    });
  });

  (state.models.cached || []).forEach((model) => {
    const note = findModelNote(noteMap, model.launchModel, model.path, model.label, model.id);
    add({
      source: "cached",
      sourceLabel: t("modelPicker.cached"),
      label: model.label || model.id || model.launchModel,
      model: model.launchModel || model.id || model.path,
      detail: model.path || "",
      format: inferLaunchFormat(model.launchModel || model.id),
      sizeBytes: model.size || 0,
      quantLabel: inferModelQuantLabel([model.label, model.path, model.id].filter(Boolean).join(" ")),
      favorite: Boolean(note?.favorite),
      badges: [
        t("modelPicker.cached"),
        model.size ? fmtBytes(model.size) : "",
        note?.favorite ? t("modelPicker.favorite") : "",
      ],
    });
  });

  getVisibleRemoteModels().forEach((model) => {
    add({
      source: "remote",
      sourceLabel: t("modelPicker.remote"),
      label: model.label || model.id,
      model: model.id,
      detail: [model.author || "Hugging Face", model.pipelineTag || model.libraryName || "", model.lastModified ? `${t("modelPicker.updated")} ${formatDate(model.lastModified)}` : ""].filter(Boolean).join(" / "),
      format: "auto",
      sizeBytes: model.fileSizeBytes || model.largestFileBytes || 0,
      quantLabel: (model.quantFormats || [])[0] || inferModelQuantLabel([model.label, model.id, ...(model.badges || [])].join(" ")),
      updatedAt: model.lastModified || "",
      favorite: false,
      badges: [
        t("modelPicker.remote"),
        model.gated ? t("modelPicker.gated") : "",
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
    favoriteLabel: t("modelPicker.favorite"),
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
  const headroomGb = Math.max(2, modelGb * 0.22);
  const peerSuffix = state.status?.resources?.hasPeerRunning ? "·已扣占用" : "";
  if (modelGb + headroomGb <= maxFreeGb) return { label: `单卡可跑${peerSuffix}`, state: "ok" };
  if (selected.length > 1 && modelGb + headroomGb <= totalFreeGb * 0.82) return { label: `需多卡${peerSuffix}`, state: "warn" };
  return { label: `偏紧${peerSuffix}`, state: "fail" };
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

function renderClaudeCompressionSettings() {
  const settings = state.claudeCompression || {};
  $("#claudeCompressionEnabled").checked = settings.enabled !== false;
  $("#claudeCompressionTrigger").value = ratioToPercent(settings.triggerRatio, 90);
  $("#claudeCompressionRecent").value = ratioToPercent(settings.recentRatio, 20);
  $("#claudeCompressionSummary").value = ratioToPercent(settings.summaryRatio, 20);
  updateClaudeCompressionNote();
}

function ratioToPercent(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number > 1 ? number : number * 100);
}

function readClaudeCompressionForm() {
  return {
    enabled: $("#claudeCompressionEnabled").checked,
    mode: "cautious",
    triggerRatio: Number($("#claudeCompressionTrigger").value || 90) / 100,
    recentRatio: Number($("#claudeCompressionRecent").value || 20) / 100,
    summaryRatio: Number($("#claudeCompressionSummary").value || 20) / 100,
    minMessages: 8,
  };
}

function updateClaudeCompressionNote() {
  const settings = readClaudeCompressionForm();
  const enabled = settings.enabled;
  const trigger = Math.round(settings.triggerRatio * 100);
  const recent = Math.round(settings.recentRatio * 100);
  const summary = Math.round(settings.summaryRatio * 100);
  const note = enabled
    ? `自动压缩已启用：估算 prompt + 输出预算达到上下文 ${trigger}% 时触发；最近 ${recent}% 原文不压缩，旧内容压成 ${summary}% 结构化摘要。`
    : "自动压缩已关闭：Claude 桥接会原样转发上下文。";
  $("#claudeCompressionNote").innerHTML = `
    <strong>${enabled ? "谨慎模式" : "关闭"}</strong>
    <span>${escapeHtml(note)} 错误、路径、模型名、端口、用户硬性要求和最近工具调用会优先保留。</span>
  `;
}

async function saveClaudeCompression(event) {
  const clearBusy = setButtonBusy(event.currentTarget, "保存中...");
  try {
    state.claudeCompression = await api("/api/claude/context-compression", {
      method: "POST",
      body: JSON.stringify(readClaudeCompressionForm()),
    });
    renderClaudeCompressionSettings();
    notify("上下文压缩设置已保存", "新的 Claude 桥接请求会使用这组阈值。", "success");
    showTestResult({ ok: true, claudeCompression: state.claudeCompression });
  } catch (error) {
    reportActionError("上下文压缩保存失败", error);
  } finally {
    clearBusy();
  }
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

function renderStatus() {
  runtimeStatusRenderer.renderStatusSummary();
  renderRunningModels();
  renderGpuPicker();
  updateMemoryEstimate();
}

function setMetricState(strongId, stateName) {
  const metric = $(`#${strongId}`)?.closest(".metric");
  if (metric) metric.dataset.state = stateName;
}

function renderStatusInsights() {
  runtimeStatusRenderer.renderStatusInsights();
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
  ["trustRemoteCode", "enableExpertParallel", "enablePrefixCaching", "languageModelOnly", "enableAutoToolChoice"].forEach((key) => {
    payload[key] = form.get(key) === "on";
  });
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
  set("#cpuOffloadGb", config.cpuOffloadGb);
  set("#kvOffloadingSize", config.kvOffloadingSize);
  set("#mmProcessorCacheGb", config.mmProcessorCacheGb);
  set("#launchDtype", config.dtype);
  set("#launchQuantization", config.quantization);
  set("#loadFormat", config.loadFormat);
  set("#ggufTokenizer", config.tokenizer);
  set("#ggufHfConfigPath", config.hfConfigPath);
  set("#kvCacheDtype", config.kvCacheDtype);
  set("#networkAccess", config.networkAccess);
  set("#clientPreset", config.clientPreset);
  set("#reasoningParser", config.reasoningParser);
  set("#toolCallParser", config.toolCallParser);
  set("#multiGpuMode", config.multiGpuMode);
  set("#tensorParallelSize", config.tensorParallelSize);
  set("#pipelineParallelSize", config.pipelineParallelSize);
  set("#dataParallelSize", config.dataParallelSize);
  const checks = {
    trustRemoteCode: "#startForm [name='trustRemoteCode']",
    enableExpertParallel: "#startForm [name='enableExpertParallel']",
    enablePrefixCaching: "#enablePrefixCaching",
    languageModelOnly: "#languageModelOnly",
    enableAutoToolChoice: "#enableAutoToolChoice",
  };
  Object.entries(checks).forEach(([key, selector]) => {
    const element = $(selector);
    if (element && config[key] !== undefined) element.checked = Boolean(config[key]);
  });
  updateGgufModeState();
  updateReasoningNote();
  updateToolCallNote();
  updateMemoryEstimate();
  renderNetworkNote();
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
        port: Number($("#servicePort").value || 8000),
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

function renderRunningModels() {
  runtimeStatusRenderer.renderRunningModels();
}

function renderRuntimeFacts(status = state.status) {
  window.VllmRuntimeInsights?.renderRuntimeFacts(status, {
    formatContextUsage: runtimeStatusRenderer.formatContextUsage,
    fmtTokens,
    escapeHtml,
  });
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

function renderVllmGpuPlan() {
  const root = $("#vllmGpuPlan");
  const actions = $("#vllmGpuPresetButtons");
  const guide = $("#multiGpuModeGuide");
  if (!root || !actions) return;
  const plan = buildVllmGpuPlan();
  if (!plan.selected.length) {
    root.innerHTML = `<div class="empty compact">未检测到 GPU；无法生成 vLLM 并行建议。</div>`;
    actions.innerHTML = "";
    if (guide) guide.textContent = "没有可用 GPU 信息。";
    return;
  }
  root.innerHTML = `
    <div class="hetero-summary ${plan.hetero ? "is-warn" : ""}">
      <strong>${escapeHtml(plan.title)}</strong>
      <span>${escapeHtml(plan.summary)}</span>
    </div>
    <div class="hetero-metrics">
      <div><span>当前模式</span><strong>${escapeHtml(plan.modeLabel)}</strong></div>
      <div><span>建议并行</span><strong>${escapeHtml(plan.recommended)}</strong></div>
      <div><span>可用显存</span><strong>${escapeHtml(plan.usableSummary)}</strong></div>
    </div>
    <div class="hetero-gpu-grid">
      ${plan.selected.map((gpu) => `
        <div class="hetero-gpu">
          <strong>GPU ${escapeHtml(gpu.id)} · ${escapeHtml(gpu.name)}</strong>
          <span>free ${formatGbNumber(gpu.freeGb)} GB · usable ${formatGbNumber(gpu.usableGb)} GB · ${escapeHtml(gpu.generation || "NVIDIA")}</span>
        </div>
      `).join("")}
    </div>
    <div class="hetero-note">${plan.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>
  `;
  actions.innerHTML = plan.presets.map((preset) => `
    <button type="button" data-vllm-gpu-preset="${escapeAttr(preset.id)}" title="${escapeAttr(preset.description)}">
      <strong>${escapeHtml(preset.label)}</strong>
      <span>${escapeHtml(preset.summary)}</span>
    </button>
  `).join("");
  actions.dataset.plan = JSON.stringify(plan.presets);
  if (guide) guide.innerHTML = `<strong>${escapeHtml(plan.guideTitle)}</strong><span>${escapeHtml(plan.guideText)}</span>`;
  renderIcons();
}

function buildVllmGpuPlan() {
  const selected = getSelectedGpuObjects().map(normalizeVllmPlanGpu);
  const mode = $("#multiGpuMode")?.value || "single";
  const hetero = window.GpuPlanningUtils.isHeterogeneous(selected);
  const count = Math.max(1, selected.length);
  const primary = selected[0] || null;
  const primaryLabel = primary ? window.GpuPlanningUtils.shortGpuLabel(primary.name, primary.id) : "当前 GPU";
  const modeLabel = {
    single: "单卡",
    tensor: `TP=${Math.max(1, Number($("#tensorParallelSize")?.value || count))}`,
    pipeline: `PP=${Math.max(1, Number($("#pipelineParallelSize")?.value || count))}`,
    data: `DP=${Math.max(1, Number($("#dataParallelSize")?.value || count))}`,
  }[mode] || mode;
  const usableSummary = selected.length
    ? selected.map((gpu) => `${gpu.id}:${formatGbNumber(gpu.usableGb)}GB`).join(" / ")
    : "-";
  const recommended = count < 2
    ? "单卡"
    : hetero
      ? `单卡 ${primaryLabel} 或 PP=${count}`
      : `TP=${count}`;
  const notes = [];
  if (count > 1 && hetero) {
    notes.push("检测到异构 GPU。vLLM Tensor Parallel 通常要求每张卡承担相近权重，慢卡/小显存卡会拖慢或限制上下文。");
    notes.push(`本地 Claude 单路长任务优先试 ${primaryLabel}；模型放不下时再试 Pipeline Parallel。`);
    if (selected.some((gpu) => gpu.totalGb >= 80) && selected.some((gpu) => gpu.totalGb < 40)) {
      notes.push("大显存卡 + 消费级小卡组合：vLLM 优先让 80GB+ 卡独跑长上下文，小卡更适合显示输出、OpenWebUI 或另起轻量模型。");
    }
  } else if (count > 1) {
    notes.push("同规格多卡可以优先试 Tensor Parallel；如果只是本地 Claude 单路，TP 未必提升单次输出速度。");
  } else {
    notes.push("单卡模式最稳定；提高上下文优先调 FP8 KV、降低 max_num_seqs 或开启 offload。");
    if (primary?.totalGb >= 80) {
      notes.push("检测到 80GB+ 大显存单卡：建议先用 max_num_seqs=1-2、gpu-memory-utilization 0.88-0.93 逐步测试 256K/384K 上下文。");
    }
  }
  notes.push("显存只差少量时，vLLM 可用 CPU offload 每卡 2-8GB 兜底；差很多时应优先换量化、降上下文或改并行方式。");
  return {
    selected,
    hetero,
    title: hetero ? "vLLM 异构多卡提醒" : count > 1 ? "vLLM 多卡规划" : "vLLM 单卡规划",
    summary: count > 1
      ? `${count} 张 GPU 已选：${selected.map((gpu) => `${gpu.id} ${gpu.name}`).join(" + ")}。`
      : `当前使用 GPU ${selected[0]?.id || 0}。`,
    modeLabel,
    recommended,
    usableSummary,
    notes,
    guideTitle: mode === "tensor" && hetero ? "TP 异构风险" : "模式建议",
    guideText: mode === "tensor" && hetero
      ? `异构 TP=${count} 可能让较慢或小显存 GPU 成为瓶颈；如果首 token 很慢或上下文上不去，改 PP=${count} 或单卡 ${primaryLabel}。`
      : "本地 Claude 单路建议 max_num_seqs=1-2；想提高并发吞吐再考虑 DP 或多个实例。",
    presets: [
      { id: "single", label: `单 ${primaryLabel}`, summary: "低延迟优先", description: "只用当前首张 GPU，最适合本地 Claude 单路。", mode: "single", tp: 1, pp: 1, dp: 1 },
      { id: "tp", label: `TP=${count}`, summary: "同规格多卡优先", description: "把模型切到多张 GPU；异构卡需短测。", mode: "tensor", tp: count, pp: 1, dp: 1 },
      { id: "pp", label: `PP=${count}`, summary: "容量/长上下文", description: "分层到多张 GPU，异构时比 TP 更稳。", mode: "pipeline", tp: 1, pp: count, dp: 1 },
      { id: "dp", label: `DP=${count}`, summary: "并发吞吐", description: "每张卡完整副本，适合多用户/多路请求。", mode: "data", tp: 1, pp: 1, dp: count },
    ],
  };
}

function normalizeVllmPlanGpu(gpu) {
  return window.GpuPlanningUtils.normalizeGpuForPlan(gpu, {
    utilization: $("#gpuMemoryUtilization")?.value || 0.9,
    defaultUtilization: 0.9,
    minUsableMb: 0,
  });
}

function handleVllmGpuPresetClick(event) {
  const button = event.target.closest("[data-vllm-gpu-preset]");
  if (!button) return;
  const plan = buildVllmGpuPlan();
  const preset = plan.presets.find((item) => item.id === button.dataset.vllmGpuPreset);
  if (!preset) return;
  $("#multiGpuMode").value = preset.mode;
  $("#tensorParallelSize").value = preset.tp;
  $("#pipelineParallelSize").value = preset.pp;
  $("#dataParallelSize").value = preset.dp;
  updateMemoryEstimate();
  renderVllmGpuPlan();
}

function updateMemoryEstimate() {
  const root = $("#memoryEstimate");
  if (!root) return;

  const estimate = estimateMemoryUsage();
  updateContextPresetState(estimate.contextTokens, estimate);

  if (!estimate.paramsB) {
    root.innerHTML = `<div class="empty compact">没有从模型名里识别到 7B、14B、27B 这类规格。填入模型 ID 或本地路径后会自动估算。</div>`;
    $("#memoryGpuBars").innerHTML = "";
    $("#memoryEstimateNote").innerHTML = `
      <strong class="warn">等待模型规格</strong>
      <span>显存估算依赖参数量；如果模型名没有规格，可以把保存名称改成包含 27B、70B 这样的标记。</span>
    `;
    return;
  }

  renderVllmMemoryEstimate(estimate);
  scheduleServerMemoryEstimate(estimate);
}

function renderVllmMemoryEstimate(estimate) {
  const root = $("#memoryEstimate");
  if (!root) return;
  root.innerHTML = [
    { label: "模型规模", value: `${formatGbNumber(estimate.paramsB)}B`, detail: estimate.archLabel },
    { label: "每卡权重", value: `${formatGbNumber(estimate.weightPerGpuGb)} GB`, detail: estimate.weightDetail },
    { label: "每卡 KV cache", value: `${formatGbNumber(estimate.kvPerGpuGb)} GB`, detail: estimate.kvDetail },
    { label: "每张 GPU", value: `${formatGbNumber(estimate.perGpuGb)} GB`, detail: estimate.splitLabel },
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
  const payload = buildVllmMemoryEstimatePayload(estimate);
  memoryEstimateTimer = setTimeout(async () => {
    try {
      const result = await api("/api/memory-estimate", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (requestId !== memoryEstimateSeq) return;
      renderVllmMemoryEstimate(mergeVllmServerMemoryEstimate(estimate, result));
    } catch {
      // The immediate in-browser estimate stays visible if the backend estimate is unavailable.
    }
  }, 250);
}

function buildVllmMemoryEstimatePayload(estimate) {
  return {
    paramsB: estimate.paramsB,
    contextTokens: estimate.contextTokens,
    bytesPerParam: estimate.bytesPerParam,
    kvBytes: estimate.kvBytes,
    arch: estimate.arch,
    selectedGpus: estimate.selectedGpus,
    gpuMemoryUtilization: estimate.utilization,
    multiGpuMode: $("#multiGpuMode")?.value || "single",
    tensorParallelSize: Number($("#tensorParallelSize")?.value || 1),
    pipelineParallelSize: Number($("#pipelineParallelSize")?.value || 1),
    cpuOffloadGb: estimate.cpuOffloadGb,
    kvOffloadingSize: estimate.kvOffloadingSize,
    multimodalReserveGb: estimate.languageModelOnly ? 0 : estimate.multimodalReserveGb,
  };
}

function mergeVllmServerMemoryEstimate(estimate, result) {
  const plan = result?.plan;
  if (!plan) return estimate;
  const selectedGpus = Array.isArray(plan.selectedGpus) && plan.selectedGpus.length ? plan.selectedGpus : estimate.selectedGpus;
  const minFreeGb = selectedGpus.length ? Math.min(...selectedGpus.map((gpu) => Number(gpu.freeGb || 0))) : 0;
  const memorySplitFactor = plan.memorySplitFactor || estimate.memorySplitFactor || 1;
  return {
    ...estimate,
    serverBacked: true,
    serverRecommendations: result.recommendations || null,
    status: plan.status || estimate.status,
    weightsGb: plan.weightsGb ?? estimate.weightsGb,
    kvGb: plan.kvGb ?? estimate.kvGb,
    totalGb: (plan.perGpuGb || estimate.perGpuGb) * memorySplitFactor,
    splitFactor: plan.splitFactor || estimate.splitFactor,
    memorySplitFactor,
    perGpuGb: plan.perGpuGb ?? estimate.perGpuGb,
    weightPerGpuBeforeOffloadGb: plan.weightPerGpuBeforeOffloadGb ?? estimate.weightPerGpuBeforeOffloadGb,
    kvPerGpuBeforeOffloadGb: plan.kvPerGpuBeforeOffloadGb ?? estimate.kvPerGpuBeforeOffloadGb,
    weightPerGpuGb: plan.weightPerGpuGb ?? estimate.weightPerGpuGb,
    kvPerGpuGb: plan.kvPerGpuGb ?? estimate.kvPerGpuGb,
    overheadGb: plan.overheadPerGpuGb ?? estimate.overheadGb,
    selectedGpus,
    minUsableGb: plan.minUsableGb ?? estimate.minUsableGb,
    minFreeGb: minFreeGb || estimate.minFreeGb,
    overflowPerGpuGb: plan.overflowPerGpuGb ?? estimate.overflowPerGpuGb,
    recommendedCpuOffloadGb: plan.recommendedCpuOffloadGb ?? estimate.recommendedCpuOffloadGb,
    recommendedKvOffloadingSize: plan.recommendedKvOffloadGb ?? estimate.recommendedKvOffloadingSize,
    systemMemoryAssistGb: (plan.cpuOffloadPerGpuGb || 0) * memorySplitFactor + (plan.kvOffloadTotalGb || 0),
    estimateConfidence: plan.arch?.source === "config" ? "high" : estimate.estimateConfidence,
    splitLabel: `${estimate.splitLabel} · 后端校准`,
  };
}

function updateGgufModeState() {
  const section = $("#ggufSection");
  const quantization = $("#launchQuantization");
  if (!section || !quantization) return;

  const model = $("#startModel")?.value.trim() || "";
  const local = getLocalModelForInput(model);
  const active = isGgufLaunchActive();
  section.hidden = !active;
  quantization.disabled = active;
  $("#ggufTokenizer").disabled = !active;
  $("#ggufHfConfigPath").disabled = !active;
  if (active) quantization.value = "";

  if (!active) return;

  const selectedFile = local?.ggufFiles?.[0];
  const fileText = selectedFile
    ? `将自动使用 ${selectedFile.name || selectedFile.path}。`
    : model.toLowerCase().endsWith(".gguf")
      ? "将直接使用填入的 .gguf 文件。"
      : "远程 GGUF 仓库建议使用 repo_id:Q4_K_M 这类格式。";
  $("#ggufNote").innerHTML = `
    <strong>GGUF 模式</strong>
    <span>${escapeHtml(fileText)} GGUF 已内置权重量化，启动时会忽略 AWQ/GPTQ/Compressed；tokenizer 最好填对应基础模型，hf config path 可在架构识别失败时填写。</span>
  `;
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

let modelConfigTimer = null;
let memoryEstimateTimer = null;
let memoryEstimateSeq = 0;

function scheduleModelConfigFetch() {
  if (modelConfigTimer) clearTimeout(modelConfigTimer);
  modelConfigTimer = setTimeout(fetchModelConfigForLaunch, 500);
}

async function fetchModelConfigForLaunch() {
  const model = $("#startModel")?.value.trim() || "";
  // GGUF 没有 config.json；本地路径和 HF 仓库才查
  if (!model || isGgufLaunchActive()) {
    state.modelConfig = { key: model, data: null, loading: false };
    updateMemoryEstimate();
    return;
  }
  if (state.modelConfig.key === model && state.modelConfig.data) return;
  state.modelConfig = { key: model, data: null, loading: true };
  try {
    const source = looksLikePathInput(model) ? "huggingface" : "huggingface";
    const data = await api(`/api/model/config?${new URLSearchParams({ model, source })}`);
    // 期间用户可能又改了模型名，丢弃过期结果
    if ($("#startModel")?.value.trim() !== model) return;
    state.modelConfig = { key: model, data, loading: false };
  } catch (error) {
    if ($("#startModel")?.value.trim() !== model) return;
    state.modelConfig = { key: model, data: { found: false, reason: error.message }, loading: false };
  }
  updateMemoryEstimate();
}

function looksLikePathInput(value) {
  return /[\\/]/.test(String(value || "")) && /^[a-zA-Z]:[\\/]|^[\\/]/.test(String(value || ""));
}

function getLaunchModelConfig() {
  const model = $("#startModel")?.value.trim() || "";
  if (state.modelConfig.key === model && state.modelConfig.data?.found) return state.modelConfig.data;
  return null;
}

function estimateMemoryUsage(contextOverride) {
  const model = $("#startModel")?.value.trim() || "";
  const contextTokens = contextOverride != null
    ? Math.max(512, Number(contextOverride))
    : Math.max(512, Number($("#maxModelLen")?.value || 8192));
  const paramsB = inferParamBillions(model);
  const dtype = $("#launchDtype")?.value || "auto";
  const kvCacheDtype = $("#kvCacheDtype")?.value || "auto";
  const cpuOffloadGb = Math.max(0, Number($("#cpuOffloadGb")?.value || 0));
  const kvOffloadingSize = Math.max(0, Number($("#kvOffloadingSize")?.value || 0));
  const mmProcessorCacheGb = Math.max(0, Number($("#mmProcessorCacheGb")?.value || 0));
  const languageModelOnly = $("#languageModelOnly")?.checked || false;
  const selectedQuant = getLaunchQuantizationProfile(model);
  const dtypeBytes = DTYPE_BYTES[dtype] || 2;
  const bytesPerParam = selectedQuant.bytesPerParam || dtypeBytes;
  const kvBytes = KV_DTYPE_BYTES[kvCacheDtype] || dtypeBytes;
  const cfg = getLaunchModelConfig();
  const rawCfg = state.modelConfig.key === model ? state.modelConfig.data : null;
  const configGated = Boolean(rawCfg && rawCfg.gated && !rawCfg.hasToken);
  // 有 config.json 时用真实层数/KV 头数/headDim，估算精度远高于按模型名猜
  const arch = (cfg && cfg.numHiddenLayers && cfg.numKeyValueHeads && cfg.headDim)
    ? {
        layers: cfg.numHiddenLayers,
        kvLayers: cfg.numHiddenLayers,
        kvHeads: cfg.numKeyValueHeads,
        headDim: cfg.headDim,
        weightMultiplier: 1,
        label: `${cfg.numHiddenLayers} 层 · KV heads ${cfg.numKeyValueHeads} · headDim ${cfg.headDim}（来自 config）`,
        fromConfig: true,
      }
    : estimateArchitecture(paramsB, model);
  const nativeMaxTokens = cfg?.maxPositionEmbeddings || null;
  const rawWeightsGb = paramsB ? paramsB * 1_000_000_000 * bytesPerParam / 1024 ** 3 : 0;
  const weightsGb = rawWeightsGb * (arch?.weightMultiplier || 1);
  const kvGb = paramsB && arch
    ? contextTokens * 2 * (arch.kvLayers || arch.layers) * arch.kvHeads * arch.headDim * kvBytes / 1024 ** 3
    : 0;
  const splitFactor = getParallelMemorySplitFactor();
  const memorySplitFactor = splitFactor;
  // vLLM defines cpu-offload-gb as a per-GPU budget. Apply it after TP/PP memory split.
  const weightPerGpuBeforeOffloadGb = weightsGb / memorySplitFactor;
  const kvPerGpuBeforeOffloadGb = kvGb / memorySplitFactor;
  const kvOffloadPerGpuGb = kvOffloadingSize / memorySplitFactor;
  const weightPerGpuGb = Math.max(0, weightPerGpuBeforeOffloadGb - cpuOffloadGb);
  const kvPerGpuGb = Math.max(0, kvPerGpuBeforeOffloadGb - kvOffloadPerGpuGb);
  const gpuWeightsGb = weightPerGpuGb * memorySplitFactor;
  const gpuKvGb = kvPerGpuGb * memorySplitFactor;
  const multimodalReserveGb = languageModelOnly ? 0 : Math.min(2, mmProcessorCacheGb * 0.25);
  const overheadGb = paramsB ? Math.max(1.2, (weightPerGpuGb + kvPerGpuGb) * 0.08) + multimodalReserveGb : 0;
  const perGpuGb = weightPerGpuGb + kvPerGpuGb + overheadGb;
  const totalGb = perGpuGb * memorySplitFactor;
  const utilization = Math.min(0.98, Math.max(0.1, Number($("#gpuMemoryUtilization")?.value || 0.9)));
  const selectedGpus = getSelectedGpuObjects().map(normalizeVllmPlanGpu);
  const minUsableGb = selectedGpus.length
    ? Math.min(...selectedGpus.map((gpu) => Number(gpu.usableGb || 0)))
    : 0;
  const minFreeGb = selectedGpus.length
    ? Math.min(...selectedGpus.map((gpu) => Number(gpu.freeGb || 0)))
    : 0;
  const status = !selectedGpus.length ? "warn" : perGpuGb <= minUsableGb * 0.9 ? "ok" : perGpuGb <= minUsableGb ? "warn" : "fail";
  const overflowPerGpuGb = selectedGpus.length ? Math.max(0, perGpuGb - minUsableGb) : 0;
  const remainingGpuWeightPerGpuGb = Math.max(0, weightPerGpuGb);
  const cpuFixPerGpuGb = Math.min(remainingGpuWeightPerGpuGb, overflowPerGpuGb > 0 ? overflowPerGpuGb + 2 : 0);
  const residualOverflowPerGpuGb = Math.max(0, overflowPerGpuGb - cpuFixPerGpuGb);
  const recommendedCpuOffloadGb = overflowPerGpuGb > 0
    ? Math.min(weightPerGpuBeforeOffloadGb, cpuOffloadGb + cpuFixPerGpuGb)
    : cpuOffloadGb;
  const recommendedKvOffloadingSize = residualOverflowPerGpuGb > 0
    ? kvOffloadingSize + residualOverflowPerGpuGb * memorySplitFactor + 2
    : kvOffloadingSize;
  const systemMemoryAssistGb = cpuOffloadGb * memorySplitFactor + kvOffloadingSize;
  const estimateConfidence = arch?.fromConfig ? "high" : cfg ? "medium" : paramsB ? "medium-low" : "low";

  // vLLM 把权重/overhead 之外的显存全部做成 KV 池；并发上限受池子能装多少 token 限制
  const maxNumSeqs = Math.max(1, Number($("#maxNumSeqs")?.value || 1));
  const kvPerTokenGb = paramsB && arch && contextTokens ? kvGb / contextTokens : 0;
  const totalBudgetGb = minUsableGb * memorySplitFactor;
  const kvPoolGb = Math.max(0, totalBudgetGb - gpuWeightsGb - overheadGb * memorySplitFactor);
  const kvPoolTokens = kvPerTokenGb ? Math.floor(kvPoolGb / kvPerTokenGb) : 0;
  const concurrentFullSeqs = contextTokens ? Math.floor(kvPoolTokens / contextTokens) : 0;

  return {
    model,
    contextTokens,
    maxNumSeqs,
    kvPoolTokens,
    concurrentFullSeqs,
    paramsB,
    bytesPerParam,
    kvBytes,
    arch,
    dtype,
    kvCacheDtype,
    kvLabel: kvCacheDtype === "auto" ? `${dtype} KV` : `${kvCacheDtype} KV`,
    quantLabel: selectedQuant.label,
    quantValue: selectedQuant.value,
    quantNote: selectedQuant.note,
    weightsGb,
    kvGb,
    gpuWeightsGb,
    gpuKvGb,
    cpuOffloadGb,
    kvOffloadingSize,
    mmProcessorCacheGb,
    languageModelOnly,
    multimodalReserveGb,
    overheadGb,
    totalGb,
    splitFactor,
    memorySplitFactor,
    perGpuGb,
    weightPerGpuBeforeOffloadGb,
    kvPerGpuBeforeOffloadGb,
    weightPerGpuGb,
    kvPerGpuGb,
    kvOffloadPerGpuGb,
    selectedGpus,
    utilization,
    minUsableGb,
    minFreeGb,
    overflowPerGpuGb,
    recommendedCpuOffloadGb,
    recommendedKvOffloadingSize,
    systemMemoryAssistGb,
    estimateConfidence,
    status,
    splitLabel: getParallelSplitLabel(splitFactor),
    archFromConfig: Boolean(arch?.fromConfig),
    nativeMaxTokens,
    configQuantMethod: cfg?.quantMethod || "",
    configGated,
    configLoading: state.modelConfig.loading && state.modelConfig.key === model,
    archLabel: arch ? arch.label || `${arch.layers} 层 · KV heads ${arch.kvHeads}` : "按模型名估算",
    weightDetail: cpuOffloadGb > 0 ? `${selectedQuant.label} · 每卡 CPU offload ${formatGbNumber(cpuOffloadGb)} GB` : selectedQuant.label,
    kvDetail: `${fmtNumber(contextTokens)} tokens · ${kvCacheDtype === "auto" ? `${dtype} KV` : `${kvCacheDtype} KV`}${kvOffloadingSize > 0 ? ` · KV offload 总 ${formatGbNumber(kvOffloadingSize)} GB` : ""}`,
  };
}

function renderGpuMemoryBars(estimate) {
  if (!estimate.selectedGpus.length) {
    return `<div class="empty compact">未检测到 GPU，无法对照显存容量。</div>`;
  }
  return estimate.selectedGpus.map((gpu) => {
    const totalGb = Number(gpu.totalGb || 0) || Number(gpu.totalMb || 0) / 1024;
    const freeGb = Number(gpu.freeGb || 0);
    const usableGb = Number(gpu.usableGb || 0) || totalGb * estimate.utilization;
    const percent = usableGb ? Math.min(100, Math.round((estimate.perGpuGb / usableGb) * 100)) : 0;
    const stateClass = percent > 100 ? "fail" : percent > 90 ? "warn" : "ok";
    return `
      <div class="gpu-bar">
        <div class="gpu-bar-head">
          <strong>GPU ${escapeHtml(gpu.id)} · ${escapeHtml(gpu.name || "NVIDIA")}</strong>
          <span>${formatGbNumber(estimate.perGpuGb)} / 可用 ${formatGbNumber(usableGb)} GB · 空闲 ${formatGbNumber(freeGb)} GB</span>
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
    ? "可以降低上下文长度、改用 FP8/NVFP4/INT4、增加 TP/PP 并行，或把部分权重/KV 放到系统内存。"
    : estimate.status === "warn"
      ? "建议留出更多显存余量；vLLM 启动、CUDA graph、并发请求都会增加峰值。"
      : "估算包含权重、当前上下文需要的 KV cache 和运行余量；vLLM 可能继续按显存占用比例预留更多 KV cache。";
  const modeNote = estimate.languageModelOnly
    ? " 已开启仅语言模式，会跳过多模态输入。"
    : " 未开启仅语言模式，多模态模型会保留视觉/视频相关开销。";
  const confidenceText = {
    high: "高：已读取模型 config 的层数/KV 结构",
    medium: "中：已读取部分 config，参数量仍按名称/量化推断",
    "medium-low": "中低：按模型名参数量和常见架构估算",
    low: "低：缺少参数量或 config",
  }[estimate.estimateConfidence] || "中低";
  const headroomLine = estimate.selectedGpus.length
    ? `<span class="memory-headroom">每卡约用 ${formatGbNumber(estimate.perGpuGb)} GB / 可用 ${formatGbNumber(estimate.minUsableGb)} GB（按当前空闲 ${formatGbNumber(estimate.minFreeGb)} GB 与利用率取较小值），余量 ${formatGbNumber(Math.max(0, estimate.minUsableGb - estimate.perGpuGb))} GB。估算可信度：${escapeHtml(confidenceText)}。</span>`
    : "";
  const offloadLine = estimate.systemMemoryAssistGb > 0
    ? `<span class="memory-headroom">系统内存辅助：CPU offload 每卡 ${formatGbNumber(estimate.cpuOffloadGb)} GB，KV offload 总 ${formatGbNumber(estimate.kvOffloadingSize)} GB，合计约 ${formatGbNumber(estimate.systemMemoryAssistGb)} GB。会降低速度，尤其依赖 PCIe/CPU 内存带宽。</span>`
    : "";
  let offloadRecommendLine = "";
  if (estimate.overflowPerGpuGb > 0) {
    const cpuMore = Math.max(0, estimate.recommendedCpuOffloadGb - estimate.cpuOffloadGb);
    const kvMore = Math.max(0, estimate.recommendedKvOffloadingSize - estimate.kvOffloadingSize);
    const cpuText = cpuMore > 0
      ? `先把 CPU offload 调到每卡约 ${formatGbNumber(estimate.recommendedCpuOffloadGb)} GB`
      : "CPU offload 已接近能减少的权重上限";
    const kvText = kvMore > 0
      ? `；若仍溢出，再把 KV offload 总量调到约 ${formatGbNumber(estimate.recommendedKvOffloadingSize)} GB 或降低上下文`
      : "";
    offloadRecommendLine = `<span class="memory-recommend warn">当前每卡还差约 ${formatGbNumber(estimate.overflowPerGpuGb)} GB。${cpuText}${kvText}。CPU offload 救权重，KV offload/FP8 KV 才主要救超长上下文。</span>`;
  }
  // 原生上下文提示：当前 max_model_len 超过模型训练长度时高亮警告
  let nativeLine = "";
  if (estimate.nativeMaxTokens) {
    const over = estimate.contextTokens > estimate.nativeMaxTokens;
    nativeLine = `<span class="memory-recommend${over ? " warn" : ""}">模型原生上下文 <strong>${fmtTokens(estimate.nativeMaxTokens)}</strong>${over ? `；当前 ${fmtTokens(estimate.contextTokens)} 已超出，vLLM 默认会报错，需要 RoPE 扩展（rope_scaling）或调低。` : "。"}</span>`;
  } else if (estimate.configLoading) {
    nativeLine = `<span class="memory-headroom">正在读取模型 config 以获取原生上下文...</span>`;
  }
  const quantLine = estimate.configQuantMethod
    ? `<span class="memory-headroom">该仓库已是量化权重（${escapeHtml(estimate.configQuantMethod)}），无需再叠加量化参数。</span>`
    : "";
  const gatedLine = estimate.configGated
    ? `<span class="memory-recommend warn">该仓库受限（gated/私有），但未配置 HF_TOKEN，下载和启动都会失败。请先在环境变量里设置 HF_TOKEN。</span>`
    : "";
  const recommended = recommendMaxContext(estimate);
  let recommendLine = "";
  if (recommended === 0) {
    recommendLine = `<span class="memory-recommend warn">即使最小上下文也放不下，需降低精度、增加并行或换更大显存。</span>`;
  } else if (recommended) {
    const atCurrent = recommended === estimate.contextTokens;
    recommendLine = `<span class="memory-recommend">所选 GPU 上可稳妥运行的最大上下文约 <strong>${fmtTokens(recommended)}</strong>${atCurrent ? "（当前已接近）" : ""}。${atCurrent ? "" : `<button type="button" class="link-button" data-apply-context="${recommended}">应用 ${fmtTokens(recommended)}</button>`}</span>`;
  }
  // 并发提示：KV 池能装的全长请求数 vs max_num_seqs
  let concurrencyLine = "";
  if (estimate.selectedGpus.length && estimate.concurrentFullSeqs > 0) {
    const kvBound = estimate.concurrentFullSeqs < estimate.maxNumSeqs;
    concurrencyLine = `<span class="memory-recommend${kvBound ? " warn" : ""}">KV 池约 ${fmtTokens(estimate.kvPoolTokens)} tokens ≈ ${fmtNumber(estimate.concurrentFullSeqs)} 条全长并发请求（max_num_seqs=${fmtNumber(estimate.maxNumSeqs)}）。${kvBound ? `实际并发会被 KV 限制到约 ${fmtNumber(estimate.concurrentFullSeqs)} 条，可调小 max_num_seqs 或上下文。` : "当前并发设置在 KV 预算内。"}</span>`;
  } else if (estimate.selectedGpus.length && estimate.concurrentFullSeqs === 0 && estimate.kvPoolTokens > 0) {
    concurrencyLine = `<span class="memory-recommend warn">KV 池只够约 ${fmtTokens(estimate.kvPoolTokens)} tokens，装不下一条全长请求，需降低上下文或精度。</span>`;
  }
  const serverLine = estimate.serverBacked && estimate.serverRecommendations?.suggestions?.length
    ? `<span class="memory-headroom">后端校准：${escapeHtml(estimate.serverRecommendations.suggestions.join(" "))}</span>`
    : "";
  return `
    <strong class="${estimate.status}">${statusText}</strong>
    <span>${escapeHtml(note)} 权重量化：${escapeHtml(estimate.quantNote)}。${escapeHtml(modeNote)}</span>
    ${headroomLine}
    ${serverLine}
    ${offloadLine}
    ${offloadRecommendLine}
    ${nativeLine}
    ${quantLine}
    ${gatedLine}
    ${concurrencyLine}
    ${recommendLine}
  `;
}

function updateContextPresetState(contextTokens, estimate = null) {
  const canFit = estimate && estimate.paramsB && estimate.selectedGpus.length;
  const nativeMax = estimate?.nativeMaxTokens || 0;
  document.querySelectorAll("[data-context-preset]").forEach((button) => {
    const presetTokens = Number(button.dataset.contextPreset);
    button.classList.toggle("active", presetTokens === Number(contextTokens));
    button.classList.remove("fit-ok", "fit-warn", "fit-fail", "beyond-native");
    const beyondNative = nativeMax && presetTokens > nativeMax;
    if (beyondNative) button.classList.add("beyond-native");
    if (!canFit) {
      button.title = beyondNative ? `超过模型原生上下文 ${fmtTokens(nativeMax)}，需 RoPE 扩展` : "";
      return;
    }
    // 用同一套估算逻辑算出每个预设上下文在所选 GPU 上的占用，给按钮着色
    const perGpu = estimateMemoryUsage(presetTokens).perGpuGb;
    const ratio = estimate.minUsableGb ? perGpu / estimate.minUsableGb : 0;
    const fit = ratio <= 0.9 ? "fit-ok" : ratio <= 1 ? "fit-warn" : "fit-fail";
    button.classList.add(fit);
    button.title = `预计每卡约 ${formatGbNumber(perGpu)} GB / 可用 ${formatGbNumber(estimate.minUsableGb)} GB`
      + (beyondNative ? ` · 超过原生 ${fmtTokens(nativeMax)}，需 RoPE 扩展` : "");
  });
}

// 在所选 GPU 上二分出能稳妥运行（status=ok）的最大上下文长度
// 默认不超过模型原生上下文（超出需 RoPE 扩展，可能降质且 vLLM 默认会报错）
function recommendMaxContext(estimate) {
  if (!estimate?.paramsB || !estimate.selectedGpus.length || !estimate.minUsableGb) return null;
  const ceiling = estimate.nativeMaxTokens || 1048576;
  const fitsAt = (tokens) => estimateMemoryUsage(tokens).perGpuGb <= estimate.minUsableGb * 0.9;
  if (!fitsAt(2048)) return 0; // 连最小上下文都放不下
  let low = 2048;
  let high = ceiling;
  if (fitsAt(high)) return high;
  while (high - low > 1024) {
    const mid = Math.floor((low + high) / 2 / 1024) * 1024;
    if (fitsAt(mid)) low = mid; else high = mid;
  }
  return low;
}

function getParallelMemorySplitFactor() {
  const mode = $("#multiGpuMode")?.value || "single";
  if (mode === "tensor") return Math.max(1, Number($("#tensorParallelSize")?.value || 1));
  if (mode === "pipeline") return Math.max(1, Number($("#pipelineParallelSize")?.value || 1));
  return 1;
}

function getParallelSplitLabel(splitFactor) {
  const mode = $("#multiGpuMode")?.value || "single";
  if (mode === "data") return "Data Parallel 每卡保留完整副本";
  if (splitFactor > 1 && mode === "tensor") return `按 TP=${splitFactor} 分摊`;
  if (splitFactor > 1 && mode === "pipeline") return `按 PP=${splitFactor} 分摊`;
  return "单卡或未分摊";
}

function getLaunchQuantizationProfile(model) {
  if (isGgufLaunchActive()) return detectGgufQuantizationProfile(model);
  const explicit = $("#launchQuantization")?.value || "";
  const detected = explicit || detectQuantizationFromText(model);
  const profile = QUANTIZATION_PROFILES[detected] || QUANTIZATION_PROFILES[""];
  return {
    ...profile,
    value: detected,
    label: explicit ? profile.label : detected ? `Auto → ${profile.label}` : "Auto / BF16-FP16",
  };
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
    note: "GGUF 文件已预量化，vLLM 启动时不再叠加 AWQ/GPTQ/Compressed",
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
  if ((lower.includes("qwen3.6") || lower.includes("qwen3_5") || lower.includes("qwen3-5")) && paramsB >= 20 && paramsB <= 35) {
    return {
      layers: 64,
      kvLayers: 16,
      kvHeads: 4,
      headDim: 256,
      weightMultiplier: 1.2,
      label: "Qwen3.6 混合架构 · 16 层 full attention KV",
    };
  }
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
  const detected = detectQuantizationFromText(model);
  if (detected && $("#launchQuantization")) {
    $("#launchQuantization").value = detected;
  }
  updateGgufModeState();
  updateMemoryEstimate();
  updateReasoningNote();
  updateToolCallNote();
}

function updateParallelDefaults() {
  const selectedCount = Math.max(1, getSelectedGpuIds().length || state.selectedGpuIds.size || 1);
  const mode = $("#multiGpuMode").value;
  const values = {
    tensor: mode === "tensor" ? selectedCount : 1,
    pipeline: mode === "pipeline" ? selectedCount : 1,
    data: mode === "data" ? selectedCount : 1,
  };
  $("#tensorParallelSize").value = values.tensor;
  $("#pipelineParallelSize").value = values.pipeline;
  $("#dataParallelSize").value = values.data;
  updateMemoryEstimate();
  renderVllmGpuPlan();
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
    openwebui: "Open WebUI 能把 reasoning_content / reasoning / thinking 分离成思考块，推荐启用匹配模型的 parser。",
    "claude-code": "Claude Code 通常走 Anthropic API；如果你用 OpenAI 兼容桥接，只有桥接器转发 reasoning_content 时才建议启用 parser。",
    "claude-cowork": "Claude Cowork/Claude 侧工具通常更偏 Anthropic thinking 格式；桥接器不支持结构化 reasoning 时建议关闭。",
    generic: "通用客户端兼容性优先；支持 reasoning_content 的客户端可启用 parser，否则关闭更稳。",
  }[preset] || "";
  const parserText = active ? `本次启动会使用 --reasoning-parser ${active}。` : "本次启动不会传 --reasoning-parser，模型输出会按原样进入正文。";
  $("#reasoningNote").innerHTML = `
    <strong>${escapeHtml(active || "关闭")}</strong>
    <span>${escapeHtml(parserText)} ${escapeHtml(presetText)}</span>
  `;
}

function inferReasoningParser(model, preset) {
  const text = String(model || "").toLowerCase();
  if (text.includes("diffusiongemma") || text.includes("diffusion_gemma") || text.includes("gemma4") || text.includes("gemma-4")) return "gemma4";
  if (text.includes("qwen3") || text.includes("qwen-3") || text.includes("qwen3.5") || text.includes("qwen3.6")) return "qwen3";
  if (text.includes("deepseek") && text.includes("r1")) return "deepseek_r1";
  if (text.includes("deepseek") && text.includes("v3")) return "deepseek_v3";
  if (text.includes("gpt-oss") || text.includes("gptoss")) return "gptoss";
  if (text.includes("kimi")) return "kimi_k2";
  if (text.includes("mistral")) return "mistral";
  if (text.includes("granite")) return "granite";
  return "";
}

function updateToolCallNote() {
  const model = $("#startModel")?.value || "";
  const preset = $("#clientPreset")?.value || "openwebui";
  const select = $("#toolCallParser");
  if (!select) return;
  const suggested = inferToolCallParser(model, preset);
  if (!state.toolCallParserTouched) {
    select.value = suggested || "auto";
  }
  const active = select.value === "auto" ? suggested : select.value;
  const enabled = $("#enableAutoToolChoice")?.checked && Boolean(active);
  const presetText = {
    openwebui: "Open WebUI 的函数调用会直接走 OpenAI tools；模型支持 parser 时可开启。",
    "claude-code": "Claude Code 需要管理器把 Anthropic tool_use 与 OpenAI tool_calls 互转；这里应保持开启。",
    "claude-cowork": "Claude Cowork 会下发工具 schema；开启后 vLLM 才能返回结构化 tool_calls。",
    generic: "通用客户端只在发送 tools 参数时生效；不支持工具的模型可关闭。",
  }[preset] || "";
  const flagText = enabled
    ? `本次启动会使用 --enable-auto-tool-choice --tool-call-parser ${active}。`
    : "本次启动不会启用 vLLM 自动工具解析。";
  $("#toolCallNote").innerHTML = `
    <strong>${escapeHtml(enabled ? active : "关闭")}</strong>
    <span>${escapeHtml(flagText)} ${escapeHtml(presetText)}</span>
  `;
}

function inferToolCallParser(model, preset) {
  const text = `${model || ""} ${preset || ""}`.toLowerCase();
  if (text.includes("diffusiongemma") || text.includes("diffusion_gemma") || text.includes("gemma4") || text.includes("gemma-4")) return "gemma4";
  if (text.includes("qwen3.6") || text.includes("qwen3-") || text.includes("qwen/qwen3") || text.includes("qwen3_coder") || text.includes("qwen3-coder")) return "qwen3_coder";
  if (text.includes("qwen2.5") || text.includes("qwq") || text.includes("qwen")) return "hermes";
  if (text.includes("deepseek")) return "deepseek_v3";
  if (text.includes("mistral")) return "mistral";
  if (text.includes("llama-3") || text.includes("llama3")) return "llama3_json";
  if (text.includes("xlam")) return "xlam";
  return "";
}

let portCheckTimer = null;
let portCheckSeq = 0;

function schedulePortCheck() {
  if (portCheckTimer) clearTimeout(portCheckTimer);
  portCheckTimer = setTimeout(runPortCheck, 500);
}

async function runPortCheck() {
  const el = $("#portStatus");
  if (!el) return;
  const port = Number($("#servicePort")?.value || 0);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    el.textContent = "";
    el.dataset.state = "";
    return;
  }
  const seq = ++portCheckSeq;
  el.dataset.state = "loading";
  el.textContent = "检查端口...";
  try {
    const result = await api(`/api/port-check?port=${port}`);
    if (seq !== portCheckSeq) return;
    if (result.available) {
      el.dataset.state = "ok";
      el.textContent = `端口 ${port} 可用`;
    } else if (result.isOwnContainer) {
      el.dataset.state = "ok";
      el.textContent = `端口 ${port} 当前由本管理器的模型容器使用，启动时会先替换它`;
    } else {
      el.dataset.state = "fail";
      el.textContent = result.detail || `端口 ${port} 被占用`;
    }
  } catch (error) {
    if (seq !== portCheckSeq) return;
    el.dataset.state = "";
    el.textContent = "";
  }
}

// 一键最优配置：用 config + GPU + 推荐器自动填关键参数
function autoTuneLaunch() {
  const cfg = getLaunchModelConfig();
  const gpus = getSelectedGpuObjects();
  if (!gpus.length) {
    notify("无法自动调优", "未检测到所选 GPU，请先在下方选择 GPU。", "info");
    return;
  }
  const model = $("#startModel")?.value.trim() || "";
  if (!model) {
    notify("无法自动调优", "请先填入模型 ID 或本地路径。", "info");
    return;
  }
  // KV dtype：长上下文/紧张显存优先 FP8
  const totalGb = gpus.reduce((sum, gpu) => sum + Number(gpu.totalMb || 0) / 1024, 0);
  // 多卡同规格时建议 TP，异构则单卡
  const sameModel = new Set(gpus.map((g) => String(g.name || "").toLowerCase())).size === 1;
  const applied = [];
  if (gpus.length >= 2 && sameModel) {
    $("#multiGpuMode").value = "tensor";
    $("#tensorParallelSize").value = String(gpus.length);
    updateParallelDefaults();
    applied.push(`TP=${gpus.length}`);
  } else {
    $("#multiGpuMode").value = "single";
    updateParallelDefaults();
  }
  // 显存占用比例：留点余量
  $("#gpuMemoryUtilization").value = "0.9";
  // KV dtype 默认 fp8（省显存、对质量影响小），但量化权重模型保持 auto
  if (!cfg?.quantMethod) $("#kvCacheDtype").value = "fp8";
  applied.push(`KV ${$("#kvCacheDtype").value}`);
  updateMemoryEstimate();
  // 推荐上下文（已含原生封顶 + 显存适配），需要先有一版 estimate
  const estimate = estimateMemoryUsage();
  const recommended = recommendMaxContext(estimate);
  if (recommended && recommended > 0) {
    $("#maxModelLen").value = String(recommended);
    applied.push(`上下文 ${fmtTokens(recommended)}`);
  } else if (recommended === 0) {
    notify("显存不足", "即使最小上下文也放不下，建议降低精度、增加并行或换更大显存 GPU。", "error");
  }
  updateMemoryEstimate();
  notify("已自动调优", applied.join(" · ") || "已套用推荐参数", "success");
}

async function refreshRecentLaunches() {
  try {
    const data = await api("/api/recent-launches");
    state.recentLaunches = Array.isArray(data?.launches) ? data.launches : [];
  } catch {
    state.recentLaunches = [];
  }
  renderRecentLaunches();
}

function renderRecentLaunches() {
  const root = $("#recentLaunches");
  if (!root) return;
  const launches = state.recentLaunches || [];
  if (!launches.length) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;
  root.innerHTML = `<span class="recent-launches-label">最近启动</span>`
    + launches.map((item, index) => {
      const label = item.name || item.config?.name || item.model;
      return `<button type="button" class="recent-launch-chip" data-recent-index="${index}" title="${escapeAttr(item.model)}">
        <i data-lucide="rotate-cw"></i><span>${escapeHtml(label)}</span>
      </button>`;
    }).join("");
  renderIcons();
}

function handleRecentLaunchAction(event) {
  const chip = event.target.closest("[data-recent-index]");
  if (!chip) return;
  const item = (state.recentLaunches || [])[Number(chip.dataset.recentIndex)];
  if (!item?.config) return;
  applyLaunchProfile(item.config);
  scheduleModelConfigFetch();
  notify("已填入最近启动配置", item.name || item.model, "success");
}

async function loadDownloadSettings() {
  try {
    const data = await api("/api/download/settings");
    const toggle = $("#downloadQueueMode");
    if (toggle) toggle.checked = Boolean(data?.queueMode);
  } catch {
    // 设置读取失败不阻塞
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

function renderNetworkNote() {
  const lanAddress = state.config?.lanAddress || "127.0.0.1";
  const port = Number($("#servicePort")?.value || state.config?.defaultPort || 8000);
  const networkAccess = $("#networkAccess")?.value || "local";
  const localUrl = `http://127.0.0.1:${port}/v1`;
  const lanUrl = `http://${lanAddress}:${port}/v1`;
  const claudeUrl = `http://127.0.0.1:${state.config?.managerPort || 5177}/claude/v1/messages`;
  const apiKeyFilled = Boolean($("#vllmApiKey")?.value.trim());
  const keyNote = apiKeyFilled
    ? "已设置 API Key，客户端需以 Bearer Token 携带。"
    : networkAccess === "lan"
      ? "警告：局域网开放且未设置 API Key，同一网络的任何设备都能调用该模型。"
      : "";
  const text = networkAccess === "lan"
    ? `局域网访问已开启。Docker 会同时发布 ${localUrl} 和 ${lanUrl}；容器内仍监听 0.0.0.0，由 Docker 转发到本机 IP。Claude 兼容桥在管理器上：${claudeUrl}。${keyNote}`
    : `当前仅本机访问。OpenAI 兼容地址为 ${localUrl}；Claude 兼容地址为 ${claudeUrl}。${keyNote}`;
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

async function saveServiceExposure(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = form.elements;
  const payload = {
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
    exposeOpenCode: fields.exposeOpenCode.checked,
    exposeMetrics: fields.exposeMetrics.checked,
    allowManagerRemote: fields.allowManagerRemote.checked,
    notes: fields.notes.value,
  };
  const result = await api("/api/service-exposure", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.serviceExposure = result;
  if (payload.apiKey && $("#vllmApiKey")) $("#vllmApiKey").value = payload.apiKey;
  renderServiceExposure();
  notify("服务化设置已保存", "需要改变实际开放范围时，请应用到启动表单并重启模型。", "success");
}

function applyExposureToLaunchForm() {
  const settings = state.serviceExposure?.settings || {};
  const mode = settings.exposureMode || "local";
  if ($("#networkAccess")) {
    $("#networkAccess").value = mode === "lan" ? "lan" : "local";
    renderNetworkNote();
  }
  const typedKey = $("#exposureApiKey")?.value.trim();
  if (typedKey && $("#vllmApiKey")) $("#vllmApiKey").value = typedKey;
  notify("已应用到启动表单", mode === "lan" ? "下一次启动会发布到局域网；请确认 API Key。" : "下一次启动会保持本机绑定。", "success");
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
  accumulateStatsSample(stats);
  statsSummaryRenderer.render(stats);
  renderStatsFreshness(stats);
  renderStatsTrends();
  renderStatsComposition(stats);
  renderStatsGpuDetail(stats);
  renderStatsModels(stats);
  renderStatsClients(stats);
  renderStatsCosts(stats);
  renderStatsDetails(stats);
  renderIcons();
}

function renderExternalAccess() {
  externalAccessRenderer.renderExternalAccess(state.externalAccess);
}

// 累积轮询样本用于实时趋势图；模型实例（进程）变化时清空
function accumulateStatsSample(stats) {
  const runtimeKey = String(stats.live?.processStartSeconds || stats.processStartSeconds || stats.container?.status || "");
  if (runtimeKey !== state.statsRuntimeKey) {
    state.statsRuntimeKey = runtimeKey;
    state.statsHistory = [];
  }
  if (!stats.container?.running) return;
  const speed = stats.totals?.speed || {};
  const context = stats.totals?.context || {};
  const gpu = stats.gpu || {};
  state.statsHistory.push({
    t: Date.now(),
    outTps: Number(speed.recentOutputTokensPerSecond || 0),
    promptTps: Number(speed.recentPromptTokensPerSecond || 0),
    reqPerMin: Number(speed.recentRequestsPerMinute || 0),
    gpuUtil: Number(gpu.util || 0),
    kvPct: Number(context.kvUsagePercent || 0) * 100,
  });
  if (state.statsHistory.length > 90) state.statsHistory.splice(0, state.statsHistory.length - 90);
}

function renderStatsFreshness(stats) {
  const el = $("#statsFreshness");
  if (!el) return;
  if (!stats.updatedAt) { el.textContent = ""; return; }
  const ageMs = Date.now() - new Date(stats.updatedAt).getTime();
  const ageSec = Math.max(0, Math.round(ageMs / 1000));
  el.textContent = ageSec < 5 ? "刚刚更新" : `更新于 ${ageSec} 秒前`;
}

function sparkline(values, options = {}) {
  const width = options.width || 240;
  const height = options.height || 44;
  const color = options.color || "var(--blue)";
  const data = (values || []).filter((value) => Number.isFinite(value));
  if (data.length < 2) {
    return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"></svg>`;
  }
  const max = Math.max(...data, options.min || 0);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data.map((value, index) => {
    const x = index * stepX;
    const y = height - ((value - min) / span) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const areaPoints = `0,${height} ${points.join(" ")} ${width},${height}`;
  return `
    <svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <polygon class="sparkline-area" points="${areaPoints}" style="fill:${color}"></polygon>
      <polyline class="sparkline-line" points="${points.join(" ")}" style="stroke:${color}"></polyline>
    </svg>
  `;
}

function renderStatsTrends() {
  const root = $("#statsTrends");
  if (!root) return;
  const history = state.statsHistory || [];
  if (history.length < 2) {
    root.innerHTML = `<div class="empty compact">正在采样实时数据... 停留在本页约 ${history.length < 1 ? "10" : "5"} 秒后开始显示曲线。</div>`;
    return;
  }
  const cards = [
    { label: "输出速度", unit: " tok/s", key: "outTps", color: "var(--teal)", fmt: (v) => fmtRate(v, " tok/s") },
    { label: "请求频率", unit: " req/min", key: "reqPerMin", color: "var(--blue)", fmt: (v) => fmtRate(v, " req/min") },
    { label: "GPU 利用率", unit: "%", key: "gpuUtil", color: "var(--amber)", fmt: (v) => `${Math.round(v)}%` },
    { label: "KV cache 占用", unit: "%", key: "kvPct", color: "var(--green)", fmt: (v) => `${v.toFixed(1)}%` },
  ];
  root.innerHTML = cards.map((card) => {
    const values = history.map((sample) => Number(sample[card.key] || 0));
    const current = values[values.length - 1];
    const peak = Math.max(...values);
    return `
      <div class="trend-card">
        <div class="trend-head">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.fmt(current))}</strong>
        </div>
        ${sparkline(values, { color: card.color })}
        <div class="trend-foot"><span>近 ${history.length} 个采样</span><span>峰值 ${escapeHtml(card.fmt(peak))}</span></div>
      </div>
    `;
  }).join("");
}

function renderStatsComposition(stats) {
  const root = $("#statsComposition");
  if (!root) return;
  const tokens = stats.totals?.tokens || {};
  const requests = stats.totals?.requests || {};
  const prompt = Number(tokens.prompt || 0);
  const cached = Math.min(prompt, Number(tokens.cachedPrompt || 0));
  const uncached = Math.max(0, prompt - cached);
  const generation = Number(tokens.generation || 0);
  const totalTok = uncached + cached + generation;
  const reqTotal = Number(requests.total || 0);
  if (!totalTok && !reqTotal) {
    root.innerHTML = `<div class="empty compact">暂无负载数据。产生请求后会显示 token 构成和请求结果分布。</div>`;
    return;
  }
  const tokenSeg = [
    { label: "未缓存输入", value: uncached, color: "var(--blue)" },
    { label: "缓存命中输入", value: cached, color: "var(--teal)" },
    { label: "输出生成", value: generation, color: "var(--amber)" },
  ];
  const reqSeg = [
    { label: "成功", value: Number(requests.success || 0), color: "var(--green)" },
    { label: "错误", value: Number(requests.error || 0), color: "var(--red)" },
    { label: "中止", value: Number(requests.aborted || 0), color: "var(--amber)" },
  ];
  root.innerHTML = `
    ${renderStackedComposition("Token 构成", tokenSeg, totalTok, fmtTokens)}
    ${renderStackedComposition("请求结果", reqSeg, reqTotal, fmtTokens)}
  `;
}

function renderStackedComposition(title, segments, total, fmt) {
  const safeTotal = Math.max(1, total);
  const bar = segments.filter((seg) => seg.value > 0).map((seg) =>
    `<div class="stack-seg" style="width:${(seg.value / safeTotal * 100).toFixed(2)}%;background:${seg.color}" title="${escapeAttr(seg.label)}: ${fmt(seg.value)}"></div>`
  ).join("");
  const legend = segments.map((seg) =>
    `<div class="stack-legend-item"><span class="stack-dot" style="background:${seg.color}"></span>${escapeHtml(seg.label)} · ${fmt(seg.value)} · ${fmtPct(total ? seg.value / total : 0)}</div>`
  ).join("");
  return `
    <div class="composition-card">
      <div class="composition-title"><span>${escapeHtml(title)}</span><strong>${fmt(total)}</strong></div>
      <div class="stack-bar">${bar || '<div class="stack-seg" style="width:100%;background:var(--line)"></div>'}</div>
      <div class="stack-legend">${legend}</div>
    </div>
  `;
}

function renderStatsGpuDetail(stats) {
  const panel = $("#statsGpuPanel");
  const root = $("#statsGpuDetail");
  if (!panel || !root) return;
  const gpus = Array.isArray(stats.gpu?.gpus) ? stats.gpu.gpus : [];
  if (!gpus.length) { panel.hidden = true; return; }
  panel.hidden = false;
  root.innerHTML = gpus.map((gpu) => {
    const memPct = gpu.totalMb ? Math.min(100, Math.round(gpu.usedMb / gpu.totalMb * 100)) : 0;
    const utilPct = Math.min(100, Math.max(0, Number(gpu.util || 0)));
    const tempState = gpu.temp >= 85 ? "fail" : gpu.temp >= 75 ? "warn" : "ok";
    const memState = memPct >= 95 ? "fail" : memPct >= 85 ? "warn" : "ok";
    return `
      <div class="gpu-detail-card">
        <div class="gpu-detail-head">
          <strong>GPU ${escapeHtml(String(gpu.id ?? gpu.index ?? "0"))}</strong>
          <span>${escapeHtml(gpu.name || "NVIDIA")}</span>
        </div>
        <div class="gpu-detail-bar-row">
          <span>利用率</span>
          <div class="gpu-detail-track"><div class="gpu-detail-fill" style="width:${utilPct}%"></div></div>
          <em>${utilPct}%</em>
        </div>
        <div class="gpu-detail-bar-row">
          <span>显存</span>
          <div class="gpu-detail-track"><div class="gpu-detail-fill ${memState}" style="width:${memPct}%"></div></div>
          <em>${fmtNumber(gpu.usedMb)} / ${fmtNumber(gpu.totalMb)} MB</em>
        </div>
        <div class="gpu-detail-temp ${tempState}">温度 ${Number.isFinite(gpu.temp) ? `${gpu.temp}°C` : "-"}</div>
      </div>
    `;
  }).join("");
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

function statsMetric(label, value, detail, className = "") {
  return window.statsUiRenderer.statsMetric(label, value, detail, { className, escapeHtml, escapeAttr });
}

function renderStatsModels(stats) {
  window.statsListRenderer.renderModels(stats, {
    root: $("#statsModelList"),
    showRuntimeState: true,
    escapeHtml,
    miniStat,
    shareBar,
    fmtPct,
    fmtTokens,
    fmtRate,
    formatContextUsage,
    labels: {
      modelEmpty: "暂无模型统计。启动模型并产生请求后这里会显示占比。",
      modelFallbackRoot: "vLLM model",
      tokenShare: "Token 占比",
      requestShare: "请求占比",
      outputSpeed: "输出速度",
      activeKv: "活跃 KV",
      average: "平均",
      avgInput: "平均输入",
      running: "运行中",
      historical: "历史累计",
    },
  });
}

function renderStatsClients(stats) {
  window.statsListRenderer.renderClients(stats, {
    root: $("#statsClientBreakdown"),
    showSessions: true,
    escapeHtml,
    miniStat,
    shareBar,
    fmtTokens,
    fmtMs,
    formatDateTime,
    labels: statsClientLabels(false),
  });
}

function renderStatsClientRow(client) {
  return window.statsListRenderer.renderClientRow(client, {
    showSessions: true,
    escapeHtml,
    miniStat,
    shareBar,
    fmtTokens,
    fmtMs,
    formatDateTime,
    labels: statsClientLabels(false),
  });
}

function renderClientSessionLine(client) {
  return window.statsListRenderer.renderClientSessionLine(client, {
    escapeHtml,
    fmtTokens,
    formatDateTime,
    labels: statsClientLabels(false),
  });
}

function renderClientModelLine(client) {
  return window.statsListRenderer.renderClientModelLine(client, {
    escapeHtml,
    fmtTokens,
    labels: statsClientLabels(false),
  });
}

function statsClientLabels(en) {
  return en ? {
    clientsEmpty: "No client usage yet. Claude bridge calls will be separated from chat and direct API usage here.",
    clientsNote: "Claude statistics include only requests through the manager Claude-compatible bridge.",
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
    sessionTask: "Claude 当前任务",
    sessionLabel: "session",
    sessionSourceFallback: "auto",
    sessionSwitches: "切换",
    sessionAutoClean: "自动清理",
    sessionRecent: "最近",
    sessionWaiting: "等待 Claude 任务请求",
    sessionDefaultTask: "Claude task",
    separator: " · ",
    detailSeparator: " · ",
  };
}

function renderStatsCosts(stats) {
  window.statsUiRenderer.renderCosts(stats, {
    root: $("#statsCostTable"),
    managerName: "vLLM",
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

function fmtMs(value) {
  const number = Number(value || 0);
  if (!number) return "-";
  if (number < 1000) return `${number.toFixed(0)} ms`;
  return fmtSeconds(number / 1000);
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

function renderModels() {
  window.LocalAiLocalModelRenderer.render({
    state,
    root: $("#modelList"),
    escapeHtml,
    escapeAttr,
    fmtBytes,
    renderIcons,
    allowDeleteLocal: true,
    onUse: ({ model, name, format }) => {
      selectLaunchModel(model, { name: name || model, format: format || "auto", silent: true });
    },
    onDelete: async ({ button, name, size }) => {
      const ok = window.confirm(`删除本地模型 ${name}（${size || "未知大小"}）？\n会从磁盘移除整个目录，无法恢复；正在运行的服务不会自动停止。`);
      if (!ok) return;
      button.disabled = true;
      try {
        await api("/api/models/delete-local", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        notify("本地模型已删除", name, "success");
        await refreshModels();
      } catch (error) {
        button.disabled = false;
        reportActionError("删除本地模型失败", error);
      }
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
    const sortFilter = $("#remoteSort")?.selectedOptions?.[0]?.textContent?.replace(/^[^一-龥A-Za-z]+/, "") || "热度趋势";
    const taskFilter = $("#remoteTask")?.selectedOptions?.[0]?.textContent || "全部类型";
    const featureFilter = $("#remoteFeature")?.value && $("#remoteFeature")?.value !== "all"
      ? `· ${$("#remoteFeature").selectedOptions[0].textContent}`
      : "";
    const sizeFilter = $("#remoteSizeFilter")?.selectedOptions?.[0]?.textContent || "全部规模";
    const unknownCount = (state.remoteModels || []).filter((model) => !Number(model.paramsB || 0)).length;
    const unknownHint = unknownCount ? ` · ${fmtNumber(unknownCount)} 个未知规格可单独筛选` : "";
    hint.textContent = `按「${sortFilter}」排序 · ${taskFilter} · ${sizeFilter} ${featureFilter} · 返回 ${fmtNumber(state.remoteModels.length)} 个，显示 ${fmtNumber(models.length)} 个${unknownHint}。参数和文件大小按公开元数据估算，gated 模型下载前需配置 token。`;
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
      runnableOk: english ? "vLLM runnable" : "vLLM 可运行",
      runnableWarn: english ? "Use another manager" : "需换管理器",
      downloadTitle: english ? "Use in download form" : "填入下载页",
      downloadLabel: english ? "Download" : "下载",
      startTitle: english ? "Use in launch form" : "填入启动表单",
      startLabel: english ? "Launch" : "启动",
      readmeTitle: english ? "View model notes" : "查看模型说明",
      openTitle: english ? "Open model page" : "打开介绍页",
    },
    escapeHtml,
    escapeAttr,
    fmtNumber,
    fmtBytes,
    formatDate,
    formatParamsB,
    isRunnableRemoteModel: isManagerRunnableRemoteModel,
    canShowReadme: (model) => model.source !== "modelscope",
    renderIcons,
    onReadme: loadRemoteReadme,
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
      selectLaunchModel(modelId, { format: "auto", silent: true });
    },
  });
}

async function loadRemoteReadme(modelId) {
  const box = document.querySelector(`.remote-readme[data-readme-for="${CSS.escape(modelId)}"]`);
  if (!box) return;
  // 再次点击折叠
  if (!box.hidden && box.dataset.loaded === "true") {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.textContent = "正在读取模型说明...";
  try {
    const data = await api(`/api/model/readme?model=${encodeURIComponent(modelId)}`);
    box.dataset.loaded = "true";
    if (data.found && data.summary) {
      box.textContent = data.summary + (data.truncated ? " …（点开介绍页看完整说明）" : "");
    } else {
      box.textContent = data.reason || "没有可显示的模型说明。";
    }
  } catch (error) {
    box.textContent = `读取说明失败：${error.message}`;
  }
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
  return date.toLocaleDateString(effectiveLanguage());
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(effectiveLanguage(), { hour12: false });
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
  if (job.status === "running") {
    return `<div class="job-actions"><button type="button" class="job-action-button danger" data-service-action="cancel-job" data-job="${escapeAttr(job.id)}">取消启动</button></div>`;
  }
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
  setDownloadOutputName(model.outputName || deriveName(model.model || model.id || "model"));
  applyDownloadModelSelection(model);
  scheduleDownloadEstimate();
}

async function resolveModelLink(event) {
  const clearBusy = event?.currentTarget ? setButtonBusy(event.currentTarget, "解析中...") : () => {};
  const url = $("#modelPageUrl").value.trim();
  if (!url) {
    clearBusy();
    notify("需要模型页面链接", "粘贴 Hugging Face 或 ModelScope 的模型介绍页后再解析。", "info");
    return null;
  }
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
    notify("链接解析完成", result.model || result.label || url, "success");
    return result;
  } catch (error) {
    $("#linkResolveResult").textContent = error.message;
    notify("链接解析失败", error.message, "error");
    throw error;
  } finally {
    clearBusy();
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
    // 保留表单内容，方便继续下载同系列的其它规格/量化版本
    await refreshJobs();
  } catch (error) {
    reportActionError("下载任务创建失败", error);
  } finally {
    clearBusy();
  }
}

async function startService(event) {
  event.preventDefault();
  const clearBusy = setButtonBusy(event.submitter || event.currentTarget.querySelector("button[type='submit']"), "创建启动...");
  const form = new FormData(event.currentTarget);
  try {
    const payload = Object.fromEntries(form.entries());
    payload.gpuDeviceIds = form.getAll("gpuDeviceIds");
    payload.trustRemoteCode = form.get("trustRemoteCode") === "on";
    payload.enableExpertParallel = form.get("enableExpertParallel") === "on";
    payload.enablePrefixCaching = form.get("enablePrefixCaching") === "on";
    payload.languageModelOnly = form.get("languageModelOnly") === "on";
    payload.networkAccess = String(payload.networkAccess || "local");
    payload.kvCacheDtype = String(payload.kvCacheDtype || "auto");
    payload.clientPreset = String(payload.clientPreset || "openwebui");
    payload.reasoningParser = payload.reasoningParser === "auto"
      ? inferReasoningParser(payload.model, payload.clientPreset)
      : String(payload.reasoningParser || "");
    payload.toolCallParser = payload.toolCallParser === "auto"
      ? inferToolCallParser(payload.model, payload.clientPreset)
      : String(payload.toolCallParser || "");
    payload.enableAutoToolChoice = form.get("enableAutoToolChoice") === "on" && Boolean(payload.toolCallParser);
    payload.port = Number(payload.port || 8000);
    payload.maxModelLen = Number(payload.maxModelLen || 8192);
    payload.maxNumSeqs = Number(payload.maxNumSeqs || 4);
    payload.gpuMemoryUtilization = Number(payload.gpuMemoryUtilization || 0.9);
    payload.cpuOffloadGb = Number(payload.cpuOffloadGb || 0);
    payload.kvOffloadingSize = Number(payload.kvOffloadingSize || 0);
    // 0 是合法值（禁用多模态缓存），不能用 || 兜底
    payload.mmProcessorCacheGb = payload.mmProcessorCacheGb === "" || payload.mmProcessorCacheGb === undefined
      ? 4
      : Number(payload.mmProcessorCacheGb);
    payload.tensorParallelSize = Number(payload.tensorParallelSize || 1);
    payload.pipelineParallelSize = Number(payload.pipelineParallelSize || 1);
    payload.dataParallelSize = Number(payload.dataParallelSize || 1);
    await api("/api/start", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    notify("启动任务已创建", `${payload.name || payload.model} · ${fmtTokens(payload.maxModelLen)} 上下文`, "success");
    await refreshJobs();
  } catch (error) {
    reportActionError("启动任务创建失败", error);
  } finally {
    clearBusy();
  }
}

async function handleRunningModelAction(event) {
  const button = event.target.closest("[data-running-action]");
  if (!button) return;
  const action = button.dataset.runningAction;
  const clearBusy = setButtonBusy(button, "卸载中...");
  try {
    if (action === "unload-model") {
      const result = await api("/api/running-models/unload", {
        method: "POST",
        body: JSON.stringify({ modelId: button.dataset.model || "" }),
      });
      notify("模型已卸载", result.modelId || "vLLM 容器已停止", "success");
      showTestResult({ unloaded: result.unloaded, audit: result.audit });
      await Promise.all([refreshStatus(), refreshLogs()]);
      if (state.auditToken) refreshAuditExports().catch(() => {});
    }
  } catch (error) {
    reportActionError("模型卸载失败", error);
  } finally {
    clearBusy();
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
    const clearPauseBusy = setButtonBusy(button, "暂停中...");
    try {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/pause`, { method: "POST", body: "{}" });
      notify("下载已暂停", meta.model || job.title, "success");
      await refreshJobs();
    } catch (error) {
      reportActionError("暂停下载失败", error);
    } finally {
      clearPauseBusy();
    }
    return;
  }
  if (button.dataset.downloadAction === "resume") {
    const clearResumeBusy = setButtonBusy(button, "继续中...");
    try {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/resume`, { method: "POST", body: "{}" });
      notify("下载已继续", meta.model || job.title, "success");
      await refreshJobs();
    } catch (error) {
      reportActionError("继续下载失败", error);
    } finally {
      clearResumeBusy();
    }
    return;
  }
  if (button.dataset.downloadAction === "cancel") {
    const ok = window.confirm("取消下载会停止任务，并删除该模型已下载的部分文件。确定继续吗？");
    if (!ok) return;
    const clearCancelBusy = setButtonBusy(button, "取消中...");
    try {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST", body: "{}" });
      notify("下载已取消并清理", meta.model || job.title, "success");
      await refreshJobs();
    } catch (error) {
      reportActionError("取消下载失败", error);
    } finally {
      clearCancelBusy();
    }
    return;
  }
  if (button.dataset.downloadAction === "use-start") {
    const model = meta.localDir || meta.model || "";
    selectLaunchModel(model, {
      name: meta.outputName || meta.model || model,
      format: inferLaunchFormat(model),
      silent: false,
    });
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

async function setupClaudeBridge(event) {
  const button = event.currentTarget;
  const clearBusy = setButtonBusy(button, "配置中...");
  try {
    const result = await api("/api/claude/setup", {
      method: "POST",
      body: "{}",
    });
    notify("Claude 配置已写入", result.modelAlias || "本地 Claude 兼容桥", "success");
    showTestResult(result);
    await refreshStatus();
  } catch (error) {
    reportActionError("Claude 配置失败", error);
  } finally {
    clearBusy();
  }
}

async function handleServiceJobAction(event) {
  const button = event.target.closest("[data-service-action]");
  if (!button) return;
  const action = button.dataset.serviceAction;
  const busyLabel = action === "start-docker" ? "启动 Docker..." : action === "cancel-job" ? "取消中..." : "重试中...";
  const clearBusy = setButtonBusy(button, busyLabel);
  try {
    if (action === "start-docker") {
      await api("/api/docker/start", { method: "POST", body: "{}" });
      notify("已请求启动 Docker", "Docker Desktop 初始化可能需要几十秒。", "success");
      await Promise.all([refreshStatus(), refreshJobs()]);
      return;
    }
    if (action === "retry-serve") {
      const job = state.jobs.find((item) => item.id === button.dataset.job);
      if (!job?.meta) throw new Error("找不到可重试的启动参数。");
      const payload = {
        ...job.meta,
        gpuDeviceIds: Array.isArray(job.meta.gpuDeviceIds) ? job.meta.gpuDeviceIds : [],
        trustRemoteCode: Boolean(job.meta.trustRemoteCode),
        enableExpertParallel: Boolean(job.meta.enableExpertParallel),
      };
      // API Key 不会持久化到任务记录里，重试时从表单取
      if (job.meta.hasApiKey && !payload.apiKey) {
        payload.apiKey = $("#vllmApiKey")?.value.trim() || "";
        if (!payload.apiKey) notify("API Key 未恢复", "原任务启用了 API Key，但重试时表单里没有填写，本次将不启用鉴权。", "info");
      }
      await api("/api/start", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      notify("已重新创建启动任务", payload.name || payload.model || "vLLM", "success");
      await refreshJobs();
    }
    if (action === "cancel-job") {
      const result = await api(`/api/jobs/${encodeURIComponent(button.dataset.job)}/cancel`, { method: "POST", body: "{}" });
      notify("任务已取消", result.id || "", "success");
      await Promise.all([refreshJobs(), refreshStatus()]);
    }
  } catch (error) {
    reportActionError("启动修复操作失败", error);
  } finally {
    clearBusy();
  }
}

async function loginAudit(event) {
  event.preventDefault();
  const clearBusy = setButtonBusy(event.submitter || event.currentTarget.querySelector("button[type='submit']"), "解锁中...");
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
    notify("审计后台已解锁", "现在可以查看本地导出的 Markdown。", "success");
    await refreshAuditExports();
  } catch (error) {
    state.auditError = error.message;
    notify("审计密码不正确", error.message, "error");
    renderAudit();
  } finally {
    clearBusy();
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
  const clearBusy = setButtonBusy(event.currentTarget, "生成中...");
  state.auditError = "";
  try {
    const result = await auditApi("/api/audit/export", {
      method: "POST",
      body: JSON.stringify({ note: "manual export from manager UI" }),
    });
    state.selectedAuditId = result.auditId || "";
    state.auditMarkdown = "";
    notify("审计 Markdown 已生成", result.auditId || "manual export", "success");
    showTestResult({ audit: result });
    await refreshAuditExports();
  } catch (error) {
    state.auditError = error.message;
    notify("审计导出失败", error.message, "error");
    renderAudit();
  } finally {
    clearBusy();
  }
}

async function handleAuditListAction(event) {
  const button = event.target.closest("[data-audit-action]");
  if (!button) return;
  const auditId = button.dataset.auditId || "";
  if (button.dataset.auditAction !== "view-md" || !auditId) return;
  const clearBusy = setButtonBusy(button, "读取中...");
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
    notify("审计 Markdown 已打开", auditId, "success");
    renderAudit();
  } catch (error) {
    if (error.status === 401) {
      state.auditToken = "";
      localStorage.removeItem("auditToken");
    }
    state.auditError = error.message;
    state.auditMarkdown = "";
    notify("审计 Markdown 读取失败", error.message, "error");
    renderAudit();
  } finally {
    clearBusy();
  }
}

async function stopService(event) {
  const clearBusy = setButtonBusy(event?.currentTarget, "停止中...");
  try {
    const result = await api("/api/stop", { method: "POST", body: "{}" });
    notify("vLLM 已停止", result.removed ? "容器已移除，后台 OpenWebUI 不受影响。" : "没有需要停止的 vLLM 容器。", "success");
    showTestResult({ stopped: result.removed, audit: result.audit });
    await Promise.all([refreshStatus(), refreshLogs()]);
    if (state.auditToken) refreshAuditExports().catch(() => {});
  } catch (error) {
    reportActionError("停止 vLLM 失败", error);
  } finally {
    clearBusy();
  }
}

async function testService(event) {
  event.preventDefault();
  const clearBusy = setButtonBusy(event.submitter || event.currentTarget.querySelector("button[type='submit']"), "测试中...");
  $("#testResult").textContent = "请求中...";
  try {
    const result = await api("/api/test", {
      method: "POST",
      body: JSON.stringify({
        model: $("#testModel").value,
        prompt: $("#testPrompt").value,
        port: Number($("#servicePort").value || 8000),
      }),
    });
    notify("接口测试完成", "本地 OpenAI 兼容接口已返回结果。", "success");
    showTestResult(result);
  } catch (error) {
    reportActionError("接口测试失败", error);
  } finally {
    clearBusy();
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
    scheduleLanguageTranslation();
    return;
  }
  document.querySelectorAll("i[data-lucide]").forEach((icon) => {
    icon.textContent = ICON_FALLBACKS[icon.dataset.lucide] || "";
  });
  scheduleLanguageTranslation();
}

window.renderIcons = renderIcons;
init();
