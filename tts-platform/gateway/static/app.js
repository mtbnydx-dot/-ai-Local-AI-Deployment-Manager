"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const pageBase = new URL(location.pathname.endsWith("/") ? location.pathname : `${location.pathname}/`, location.origin);

const ENGINE_LABELS = {
  chatterbox: "Chatterbox V3",
  qwen_local: "Qwen3-TTS 1.7B",
  fish: "Fish S2 Pro",
  step_audio: "Step-Audio-EditX",
  voxcpm2: "VoxCPM 2",
  qwen_voice_design: "Qwen3-TTS VoiceDesign",
  mimo_api: "小米 MiMo",
  qwen_api: "Qwen3-TTS API",
  unknown: "未知引擎",
};

const state = {
  engines: [],
  voices: [],
  jobs: [],
  outputs: [],
  models: [],
  modelResources: null,
  languageOptions: [],
  outputTotal: 0,
  outputOffset: 0,
  system: null,
  selectedEngines: new Set(readJsonStorage("tts.selectedEngines", [])),
  selectedVoice: localStorage.getItem("tts.selectedVoice") || "",
  emotion: "",
  taskFilter: "",
  historyQuery: "",
  historyEngine: "",
  maxBatchEngines: 3,
  audioPlayers: new Map(),
  previousJobStatus: new Map(),
  pollingTimer: null,
  modelPollingTimer: null,
  previousModelOperationStatus: new Map(),
  searchTimer: null,
  draftTimer: null,
  sessionApiKey: sessionStorage.getItem("tts.gatewayApiKey") || "",
  authPromise: null,
  editingVoiceId: "",
  recordedBlob: null,
  previewObjectUrl: "",
  mediaRecorder: null,
  mediaStream: null,
  recordStartedAt: 0,
  recordTimer: null,
};

class ApiError extends Error {
  constructor(message, status = 0, code = "request_failed", payload = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

function readJsonStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
}

function icon(name) {
  return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function resourceUrl(path) {
  const value = String(path || "");
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return new URL(value, location.origin).toString();
  return new URL(value.replace(/^\.\//, ""), pageBase).toString();
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(Number(milliseconds)) || Number(milliseconds) < 0) return "--:--";
  const seconds = Math.floor(Number(milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function textPreview(value, fallback = "未记录文本") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function setInlineStatus(element, message = "", type = "") {
  if (!element) return;
  element.textContent = message;
  element.className = `inline-status${type ? ` is-${type}` : ""}`;
}

function toast(message, type = "") {
  const region = $("#toastRegion");
  const item = document.createElement("div");
  item.className = `toast${type ? ` is-${type}` : ""}`;
  item.textContent = message;
  region.appendChild(item);
  window.setTimeout(() => item.remove(), 4200);
}

async function requestSessionKey() {
  if (state.authPromise) return state.authPromise;
  const dialog = $("#authDialog");
  const input = $("#authKey");
  input.value = "";
  state.authPromise = new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      const key = dialog.returnValue === "confirm" ? input.value.trim() : "";
      if (key) {
        state.sessionApiKey = key;
        sessionStorage.setItem("tts.gatewayApiKey", key);
      }
      state.authPromise = null;
      resolve(Boolean(key));
    };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    requestAnimationFrame(() => input.focus());
  });
  return state.authPromise;
}

async function apiFetch(path, options = {}, retryAuth = true) {
  const headers = new Headers(options.headers || {});
  if (state.sessionApiKey) headers.set("Authorization", `Bearer ${state.sessionApiKey}`);
  const response = await fetch(resourceUrl(path), { ...options, headers });
  if (response.status === 401 && retryAuth && await requestSessionKey()) {
    return apiFetch(path, options, false);
  }
  return response;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await apiFetch(path, options);
  } catch (error) {
    throw new ApiError(`无法连接语音网关：${error.message}`, 0, "network_error");
  }
  const contentType = response.headers.get("content-type") || "";
  let payload = null;
  if (contentType.includes("json")) {
    try { payload = await response.json(); } catch { payload = null; }
  } else {
    payload = await response.text();
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" ? payload.detail : String(payload || `HTTP ${response.status}`);
    throw new ApiError(message, response.status, payload?.code || "request_failed", payload);
  }
  return payload;
}

function showSkeleton(element, count = 2) {
  element.innerHTML = Array.from({ length: count }, () => '<div class="skeleton"></div>').join("");
}

function setConnection(online, label = "") {
  const status = $("#connectionLabel");
  const dot = status?.previousElementSibling;
  if (!status || !dot) return;
  status.textContent = label || (online ? "已连接" : "连接失败");
  status.parentElement.style.color = online ? "var(--success)" : "var(--danger)";
  dot.className = `status-dot ${online ? "is-online" : "is-warning"}`;
}

async function loadSystem() {
  try {
    state.system = await api("api/system");
    state.maxBatchEngines = Number(state.system?.limits?.batch_engines || 3);
    $("#engineHelp").textContent = `最多同时选择 ${state.maxBatchEngines} 个引擎进行对比。`;
    setConnection(true, "已连接");
  } catch (error) {
    setConnection(false, "连接失败");
    throw error;
  }
}

async function loadLanguages() {
  try {
    const payload = await api("api/languages");
    state.languageOptions = payload.items || [];
    $("#languageOptions").innerHTML = state.languageOptions.map((item) => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name)}</option>`).join("");
  } catch {
    state.languageOptions = [];
  }
}

function engineStateCopy(engine) {
  if (engine.status === "busy") return "忙碌";
  if (engine.available) return engine.model_loaded ? "在线 · 已加载" : "在线";
  if (engine.status === "unconfigured") return "未配置";
  return "离线";
}

function persistSelections() {
  localStorage.setItem("tts.selectedEngines", JSON.stringify([...state.selectedEngines]));
  if (state.selectedVoice) localStorage.setItem("tts.selectedVoice", state.selectedVoice);
  else localStorage.removeItem("tts.selectedVoice");
}

function normalizeEngineSelection() {
  const availableIds = new Set(state.engines.filter((engine) => engine.available).map((engine) => engine.id));
  state.selectedEngines = new Set([...state.selectedEngines].filter((id) => availableIds.has(id)).slice(0, state.maxBatchEngines));
  if (!state.selectedEngines.size) {
    for (const preferred of ["step_audio", "mimo_api", "qwen_api", "qwen_local", "chatterbox", "fish"]) {
      if (availableIds.has(preferred)) state.selectedEngines.add(preferred);
      if (state.selectedEngines.size >= Math.min(2, state.maxBatchEngines)) break;
    }
  }
  persistSelections();
}

function renderEngines() {
  const grid = $("#engineGrid");
  if (!state.engines.length) {
    grid.innerHTML = '<div class="empty-state">没有检测到引擎配置</div>';
    return;
  }
  grid.innerHTML = state.engines.map((engine) => {
    const selected = state.selectedEngines.has(engine.id);
    const statusClass = engine.status === "busy" ? "is-busy" : engine.available ? "is-online" : "";
    return `<button class="engine-card${selected ? " is-selected" : ""}${engine.available ? "" : " is-disabled"}" type="button" data-engine-id="${escapeHtml(engine.id)}" aria-pressed="${selected}" title="${escapeHtml([engine.detail, engine.language_summary].filter(Boolean).join(" · "))}">
      <span class="engine-card-top"><span class="engine-glyph">${icon("wave")}</span><span class="engine-select-mark">${icon("check")}</span></span>
      <span class="engine-name">${escapeHtml(engine.name || ENGINE_LABELS[engine.id] || engine.id)}</span>
      <span class="engine-state ${statusClass}"><span class="status-dot ${engine.available ? (engine.status === "busy" ? "is-warning" : "is-online") : ""}"></span>${escapeHtml(engineStateCopy(engine))}</span>
    </button>`;
  }).join("");
  const unavailable = state.engines.some((engine) => !engine.available);
  $("#engineWarning").hidden = !unavailable;
  updateGenerateLabel();
  updateLanguageHint();
  renderApiModels();
}

function updateLanguageHint() {
  const language = $("#synthesisLanguage")?.value.trim() || "auto";
  const selected = state.engines.filter((engine) => state.selectedEngines.has(engine.id));
  const summaries = [...new Set(selected.map((engine) => engine.language_summary).filter(Boolean))];
  const suffix = summaries.length ? `所选模型：${summaries.join("；")}` : "选择模型后会显示其原生语种范围。";
  $("#languageHint").textContent = `${language === "auto" ? "当前由模型自动识别" : `当前合成语种：${language}`}。${suffix}`;
}

async function loadEngines(refresh = false) {
  if (!state.engines.length) showSkeleton($("#engineGrid"), 3);
  try {
    state.engines = await api(`api/engines${refresh ? "?refresh=true" : ""}`);
    normalizeEngineSelection();
    const available = state.engines.filter((engine) => engine.available).length;
    const summary = $("#engineSummary");
    summary.textContent = `${available} / ${state.engines.length} 引擎可用`;
    summary.style.color = available ? "var(--success)" : "var(--danger)";
    renderEngines();
    updateHistoryEngineOptions();
  } catch (error) {
    $("#engineGrid").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    $("#engineSummary").textContent = "引擎状态不可用";
    $("#engineSummary").style.color = "var(--danger)";
    setConnection(false, "连接失败");
  }
}

function updateGenerateLabel() {
  const count = state.selectedEngines.size;
  $("#generateLabel").textContent = count ? `生成语音（已选 ${count} 个引擎）` : "生成语音";
  $("#generateButton").disabled = count === 0;
}

function renderVoicePicker() {
  const picker = $("#voicePicker");
  const voiceCards = state.voices.map((voice) => {
    const selected = voice.id === state.selectedVoice;
    const info = voice.ref_text ? "克隆音色 · 有文字稿" : "克隆音色 · 无文字稿";
    return `<button type="button" class="voice-choice${selected ? " is-selected" : ""}" data-voice-id="${escapeHtml(voice.id)}" aria-pressed="${selected}">
      <span class="voice-icon">${icon("mic")}</span>
      <span class="voice-copy"><strong>${escapeHtml(voice.name)}</strong><span>${escapeHtml(info)}</span></span>
      <span class="choice-check">${icon("check")}</span>
    </button>`;
  }).join("");
  picker.innerHTML = `${voiceCards}<button type="button" class="voice-choice empty-add" data-action="add-voice">${icon("plus")}<span>添加音色</span></button>`;
}

function playerMarkup(key, url, downloadUrl = "", label = "播放音频") {
  return `<div class="mini-player" data-player="${escapeHtml(key)}" data-audio-url="${escapeHtml(url)}">
    <button class="icon-button" type="button" data-action="toggle-audio" aria-label="${escapeHtml(label)}">${icon("play")}</button>
    <div><input type="range" min="0" max="1000" value="0" data-audio-seek aria-label="音频进度"><div class="mini-player-time"><span data-audio-current>00:00</span><span data-audio-duration>--:--</span></div></div>
    ${downloadUrl ? `<button class="icon-button" type="button" data-action="download-audio" data-download-url="${escapeHtml(downloadUrl)}" aria-label="下载音频">${icon("download")}</button>` : "<span></span>"}
  </div>`;
}

function renderVoiceLibrary() {
  const library = $("#voiceLibrary");
  if (!state.voices.length) {
    library.innerHTML = `<button type="button" class="library-card empty-state" data-action="add-voice">${icon("mic")}<span>还没有参考音色，添加一个开始创作。</span></button>`;
    return;
  }
  library.innerHTML = state.voices.map((voice) => `<article class="library-card">
    <div class="library-card-heading"><span class="voice-icon">${icon("mic")}</span><span class="voice-copy"><strong>${escapeHtml(voice.name)}</strong><span>${formatBytes(voice.bytes)} · ${formatDuration(voice.duration_ms)}</span></span></div>
    <p class="reference-copy">${escapeHtml(textPreview(voice.ref_text, "未填写参考文字"))}</p>
    ${playerMarkup(`voice-${voice.id}`, voice.audio_url, voice.audio_url, `播放 ${voice.name}`)}
    <div class="card-actions"><button class="button subtle compact" type="button" data-action="edit-voice" data-id="${escapeHtml(voice.id)}">${icon("edit")}<span>编辑</span></button><button class="icon-button" type="button" data-action="delete-voice" data-id="${escapeHtml(voice.id)}" aria-label="删除 ${escapeHtml(voice.name)}">${icon("trash")}</button></div>
  </article>`).join("");
}

async function loadVoices() {
  try {
    state.voices = await api("api/voices");
    if (!state.voices.some((voice) => voice.id === state.selectedVoice)) {
      state.selectedVoice = state.voices[0]?.id || "";
    }
    persistSelections();
    renderVoicePicker();
    renderVoiceLibrary();
  } catch (error) {
    $("#voicePicker").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    $("#voiceLibrary").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function taskStatusLabel(status) {
  return ({ queued: "排队", running: "运行中", succeeded: "已完成", failed: "失败", cancelled: "已取消" })[status] || status;
}

function taskActions(job, compact = false) {
  if (job.cancellable) return `<button class="icon-button" type="button" data-action="cancel-job" data-id="${escapeHtml(job.id)}" aria-label="取消任务">${icon("stop")}</button>`;
  if (job.retryable) return `<button class="${compact ? "icon-button" : "button subtle compact"}" type="button" data-action="retry-job" data-id="${escapeHtml(job.id)}" aria-label="重试任务">${icon("retry")}${compact ? "" : "<span>重试</span>"}</button>`;
  if (job.output) return `<button class="icon-button" type="button" data-action="open-output" data-id="${escapeHtml(job.output.id)}" aria-label="查看结果">${icon("play")}</button>`;
  return "";
}

function renderTaskRail() {
  const rail = $("#taskRail");
  const active = state.jobs.filter((job) => ["queued", "running", "failed"].includes(job.status)).slice(0, 5);
  if (!active.length) {
    rail.innerHTML = `<div class="empty-state">${icon("task")}<span>当前没有活跃任务</span></div>`;
    return;
  }
  rail.innerHTML = active.map((job) => `<article class="task-row">
    <div class="task-row-heading"><span class="engine-glyph">${icon("wave")}</span><div class="task-copy"><strong>${escapeHtml(ENGINE_LABELS[job.engine] || job.engine)}</strong><span>${escapeHtml(textPreview(job.request?.text))}</span></div><div class="task-actions">${taskActions(job, true)}</div></div>
    <div class="progress-track"><span style="width:${Math.max(0, Math.min(100, Number(job.progress || 0)))}%"></span></div>
    ${job.error ? `<div class="task-error">${escapeHtml(job.error)}</div>` : ""}
  </article>`).join("");
}

function renderTaskList() {
  const list = $("#taskList");
  const jobs = state.taskFilter ? state.jobs.filter((job) => job.status === state.taskFilter) : state.jobs;
  if (!jobs.length) {
    list.innerHTML = `<div class="empty-state">${icon("task")}<span>此筛选条件下没有任务</span></div>`;
    return;
  }
  list.innerHTML = jobs.map((job) => `<article class="task-row">
    <div class="task-detail">
      <span class="status-label is-${escapeHtml(job.status)}"><span class="status-dot ${job.status === "succeeded" ? "is-online" : job.status === "failed" ? "is-warning" : ""}"></span>${escapeHtml(taskStatusLabel(job.status))}</span>
      <div class="task-text"><strong>${escapeHtml(ENGINE_LABELS[job.engine] || job.engine)} · ${formatDate(job.created_at)}</strong><p>${escapeHtml(textPreview(job.request?.text))}</p>${job.error ? `<p class="task-error">${escapeHtml(job.error)}</p>` : ""}</div>
      <div class="task-actions">${taskActions(job)}</div>
    </div>
    ${["queued", "running"].includes(job.status) ? `<div class="progress-track"><span style="width:${Math.max(0, Math.min(100, Number(job.progress || 0)))}%"></span></div>` : ""}
  </article>`).join("");
}

function notifyJobTransitions(jobs) {
  let shouldRefreshHistory = false;
  for (const job of jobs) {
    const previous = state.previousJobStatus.get(job.id);
    if (previous && previous !== job.status) {
      if (job.status === "succeeded") {
        toast(`${ENGINE_LABELS[job.engine] || job.engine} 已生成`, "success");
        shouldRefreshHistory = true;
      } else if (job.status === "failed") {
        toast(`${ENGINE_LABELS[job.engine] || job.engine}：${job.error || "生成失败"}`, "error");
      }
    }
    state.previousJobStatus.set(job.id, job.status);
  }
  if (shouldRefreshHistory) loadHistory(true).catch(() => {});
}

async function loadJobs({ quiet = false } = {}) {
  try {
    const payload = await api("api/jobs?limit=100");
    notifyJobTransitions(payload.items || []);
    state.jobs = payload.items || [];
    const active = Number(payload.counts?.active || 0);
    const badge = $("#taskNavCount");
    badge.textContent = String(active);
    badge.hidden = active === 0;
    renderTaskRail();
    renderTaskList();
  } catch (error) {
    if (!quiet) toast(error.message, "error");
  }
}

function updateHistoryEngineOptions() {
  const select = $("#historyEngine");
  const current = select.value || state.historyEngine;
  select.innerHTML = `<option value="">全部引擎</option>${state.engines.map((engine) => `<option value="${escapeHtml(engine.id)}">${escapeHtml(engine.name)}</option>`).join("")}`;
  select.value = current;
}

function outputRow(output, compact = false) {
  const label = ENGINE_LABELS[output.engine] || output.engine;
  const preview = textPreview(output.text, output.filename);
  if (compact) {
    return `<article class="output-row"><div class="output-row-heading"><span class="engine-glyph">${icon("wave")}</span><div class="output-copy"><strong>${escapeHtml(preview)}</strong><span>${escapeHtml(label)} · ${formatDate(output.created_at)}</span></div></div>${playerMarkup(`recent-${output.id}`, output.audio_url, output.download_url, `播放 ${preview}`)}</article>`;
  }
  return `<article class="history-row" data-output-id="${escapeHtml(output.id)}">
    <div class="history-meta"><strong>${escapeHtml(preview)}</strong><span>${escapeHtml(label)} · ${formatDate(output.created_at)} · ${formatBytes(output.bytes)} · ${formatDuration(output.duration_ms)}</span></div>
    <div class="history-player">${playerMarkup(`history-${output.id}`, output.audio_url, output.download_url, `播放 ${preview}`)}</div>
    <div class="history-actions"><button class="icon-button" type="button" data-action="delete-output" data-id="${escapeHtml(output.id)}" aria-label="删除生成记录">${icon("trash")}</button></div>
  </article>`;
}

function renderRecentRail() {
  const rail = $("#recentRail");
  const recent = state.outputs.slice(0, 6);
  rail.innerHTML = recent.length ? recent.map((output) => outputRow(output, true)).join("") : `<div class="empty-state">${icon("history")}<span>尚无生成记录</span></div>`;
}

function renderHistory() {
  const list = $("#historyList");
  list.innerHTML = state.outputs.length ? state.outputs.map((output) => outputRow(output)).join("") : `<div class="empty-state">${icon("history")}<span>没有匹配的生成记录</span></div>`;
  $("#historyTotal").textContent = `共 ${state.outputTotal} 条`;
  $("#historyMore").hidden = state.outputs.length >= state.outputTotal;
  renderRecentRail();
}

async function loadHistory(reset = true) {
  const offset = reset ? 0 : state.outputs.length;
  const params = new URLSearchParams({ limit: "30", offset: String(offset) });
  if (state.historyEngine) params.set("engine", state.historyEngine);
  if (state.historyQuery) params.set("query", state.historyQuery);
  try {
    const payload = await api(`api/outputs?${params}`);
    state.outputTotal = Number(payload.total || 0);
    state.outputOffset = offset;
    if (reset) state.outputs = payload.items || [];
    else {
      const known = new Set(state.outputs.map((item) => item.id));
      state.outputs.push(...(payload.items || []).filter((item) => !known.has(item.id)));
    }
    renderHistory();
  } catch (error) {
    if (reset) {
      $("#historyList").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      $("#recentRail").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }
}

function modelRuntimeLabel(model) {
  if (model.operation && ["queued", "running"].includes(model.operation.status)) return model.operation.message || "正在执行操作";
  if (model.busy) return "正在生成语音";
  if (model.available && model.model_loaded) return "服务在线 · 模型已加载到显存";
  if (model.available) return "服务在线 · 权重尚未加载";
  if (model.type === "api") return model.configured ? "API 已配置" : "API Key 尚未配置";
  if (!model.installed) return "尚未安装";
  return "已安装 · 服务未启动";
}

function modelActionButton(model, action, label, primary = false) {
  if (!model.actions?.[action]) return "";
  return `<button class="button ${primary ? "primary" : "subtle"} compact" type="button" data-model-action="${escapeHtml(action)}" data-model-id="${escapeHtml(model.id)}">${escapeHtml(label)}</button>`;
}

function notifyModelTransitions(models) {
  for (const model of models) {
    const operation = model.operation;
    if (!operation) continue;
    const key = `${model.id}:${operation.action}:${operation.started_at}`;
    const previous = state.previousModelOperationStatus.get(key);
    if (previous && previous !== operation.status) {
      if (operation.status === "succeeded") {
        toast(`${model.name}：${operation.message}`, "success");
        loadEngines(true).catch(() => {});
        setTimeout(() => loadModels(true).catch(() => {}), 700);
      } else if (operation.status === "failed") {
        toast(`${model.name}：${operation.message}`, "error");
      }
    }
    state.previousModelOperationStatus.set(key, operation.status);
  }
}

function renderModels() {
  const grid = $("#modelGrid");
  if (!state.models.length) {
    grid.innerHTML = '<div class="empty-state">模型目录尚未加载</div>';
    return;
  }
  grid.innerHTML = state.models.map((model) => {
    const running = model.operation && ["queued", "running"].includes(model.operation.status);
    const failed = model.operation?.status === "failed";
    const badge = model.busy ? "忙碌" : model.available ? (model.model_loaded ? "已加载" : "在线") : model.installed ? "已安装" : model.type === "api" ? "云端" : "可安装";
    const badgeClass = model.busy ? "is-busy" : model.available ? "is-online" : "";
    const facts = [model.language_summary, model.model_size_bytes ? `下载约 ${formatBytes(model.model_size_bytes)}` : "", model.license].filter(Boolean);
    const actionMarkup = running
      ? '<button class="button subtle compact" type="button" disabled>操作进行中…</button>'
      : [
          modelActionButton(model, "install", "安装模型", true),
          modelActionButton(model, "start", "启动服务"),
          modelActionButton(model, "wake", model.available ? "加载到显存" : "启动并加载", true),
          modelActionButton(model, "unload", "释放显存"),
          modelActionButton(model, "stop", "停止服务"),
        ].join("");
    return `<article class="model-card${model.featured ? " is-featured" : ""}">
      <div class="model-card-heading"><span class="engine-glyph">${icon("model")}</span><div class="model-title"><strong>${escapeHtml(model.name)}</strong><span>${escapeHtml(model.type === "api" ? "云端 API" : model.type === "docker" ? "本地 Docker" : "本地模型")}</span></div>${model.featured ? '<span class="model-badge is-new">新增推荐</span>' : ""}<span class="model-badge ${badgeClass}">${escapeHtml(badge)}</span></div>
      <p class="model-description">${escapeHtml(model.description)}</p>
      <div class="model-facts">${facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("")}</div>
      <div class="model-state${failed ? " is-error" : ""}"><strong>${escapeHtml(modelRuntimeLabel(model))}</strong>${model.operation ? `<span>${escapeHtml(model.operation.message || "")}</span>` : `<span>${escapeHtml(model.detail || "")}</span>`}</div>
      <div class="model-actions">${actionMarkup}<a class="source-link" href="${escapeHtml(model.source_url)}" target="_blank" rel="noopener noreferrer">官方资料 ↗</a></div>
    </article>`;
  }).join("");
}

function scheduleModelPolling(active) {
  if (!active) {
    clearTimeout(state.modelPollingTimer);
    state.modelPollingTimer = null;
    return;
  }
  if (state.modelPollingTimer) return;
  state.modelPollingTimer = setTimeout(async () => {
    state.modelPollingTimer = null;
    if (document.visibilityState === "visible") await loadModels(true);
    else scheduleModelPolling(true);
  }, 1600);
}

async function loadModels(refresh = false) {
  if (!state.models.length) showSkeleton($("#modelGrid"), 3);
  try {
    const payload = await api(`api/models${refresh ? "?refresh=true" : ""}`);
    state.models = payload.items || [];
    state.modelResources = payload.resources || null;
    const diskFree = Number(state.modelResources?.disk_free_bytes || 0);
    const gpu = state.modelResources?.gpu;
    $("#modelResourceSummary").textContent = [diskFree ? `模型盘可用 ${formatBytes(diskFree)}` : "", gpu ? `GPU 可用 ${(Number(gpu.free_mib || 0) / 1024).toFixed(1)} GB / ${(Number(gpu.total_mib || 0) / 1024).toFixed(1)} GB` : ""].filter(Boolean).join(" · ");
    notifyModelTransitions(state.models);
    renderModels();
    scheduleModelPolling(state.models.some((model) => ["queued", "running"].includes(model.operation?.status)));
  } catch (error) {
    $("#modelGrid").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    scheduleModelPolling(false);
  }
}

async function runModelAction(modelId, action) {
  const model = state.models.find((item) => item.id === modelId);
  if (!model) return;
  const confirmations = {
    install: ["安装模型", `将下载并安装 ${model.name}${model.model_size_bytes ? `（权重约 ${formatBytes(model.model_size_bytes)}）` : ""}。下载可在后台继续。`, "开始安装"],
    unload: ["释放模型显存", `将 ${model.name} 的权重移出显存，服务仍保持在线，下次使用时可再次加载。`, "释放显存"],
    stop: ["停止模型服务", `将停止 ${model.name} 的本地服务并释放资源。正在生成时系统会拒绝此操作。`, "停止服务"],
  };
  if (confirmations[action] && !await confirmAction(...confirmations[action])) return;
  try {
    const result = await api(`api/models/${encodeURIComponent(modelId)}/actions/${encodeURIComponent(action)}`, { method: "POST" });
    model.operation = result.operation;
    renderModels();
    scheduleModelPolling(true);
    toast(`${model.name}：操作已开始`, "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderApiModels() {
  const list = $("#apiModels");
  if (!list) return;
  list.innerHTML = state.engines.length ? state.engines.map((engine) => {
    const labels = { voice_clone: "音色克隆", voice_optional: "音色可选", emotion: "语气", style: "风格", requires_ref_text: "需文字稿" };
    const capabilities = Object.entries(engine.capabilities || {}).filter(([key, enabled]) => enabled && labels[key]).map(([key]) => labels[key]);
    return `<div class="api-model"><strong>tts-${escapeHtml(engine.id)}</strong><span>${escapeHtml(engineStateCopy(engine))}${capabilities.length ? ` · ${escapeHtml(capabilities.join(" / "))}` : ""} · ${escapeHtml(engine.language_summary || "语种由模型处理")}</span></div>`;
  }).join("") : '<div class="empty-state">模型状态尚未加载</div>';
}

function updateApiGuide() {
  const base = new URL("openai/v1", pageBase).toString().replace(/\/$/, "");
  $("#openAiBase").textContent = base;
  $("#apiExample").textContent = `curl ${base}/audio/speech ^\n  -H "Content-Type: application/json" ^\n  -d "{\\\"model\\\":\\\"tts-step_audio\\\",\\\"voice\\\":\\\"<voice_id>\\\",\\\"input\\\":\\\"Hello from the voice workstation.\\\",\\\"response_format\\\":\\\"wav\\\"}" ^\n  --output speech.wav`;
}

async function translateText() {
  const button = $("#translateButton");
  const source = $("#sourceText").value.trim();
  if (!source) {
    setInlineStatus($("#translationStatus"), "请先输入需要翻译的原文", "error");
    $("#sourceText").focus();
    return;
  }
  const targetLanguage = $("#translationLanguage").value.trim();
  if (!targetLanguage || targetLanguage.toLowerCase() === "auto") {
    setInlineStatus($("#translationStatus"), "请填写明确的翻译目标语种，例如 en、日语或 fr-CA", "error");
    $("#translationLanguage").focus();
    return;
  }
  button.disabled = true;
  setInlineStatus($("#translationStatus"), "正在选择可用翻译服务……");
  try {
    const result = await api("api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: source, target_language: targetLanguage }),
    });
    $("#targetText").value = result.translation || result.english || "";
    $("#synthesisLanguage").value = result.target_language || targetLanguage;
    updateLanguageHint();
    updateTextCounts();
    persistDraftSoon();
    const provider = result.model || result.provider || "翻译服务";
    setInlineStatus($("#translationStatus"), `翻译完成 · ${provider} · ${(Number(result.elapsed_ms || 0) / 1000).toFixed(1)} 秒`, "success");
  } catch (error) {
    setInlineStatus($("#translationStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function insertPause() {
  const textarea = $("#targetText");
  const position = textarea.selectionStart ?? textarea.value.length;
  const marker = " ⏸ ";
  textarea.setRangeText(marker, position, textarea.selectionEnd ?? position, "end");
  textarea.focus();
  updateTextCounts();
  persistDraftSoon();
}

function updateTextCounts() {
  $("#sourceCount").textContent = `${$("#sourceText").value.length} / 12000`;
  $("#targetCount").textContent = `${$("#targetText").value.length} / 10000`;
  $("#styleCount").textContent = `${$("#styleText").value.length} / 500`;
}

function persistDraftSoon() {
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => {
    localStorage.setItem("tts.draft", JSON.stringify({
      source: $("#sourceText").value,
      target: $("#targetText").value,
      style: $("#styleText").value,
      speed: Number($("#speedControl").value),
      intensity: Number($("#intensityControl").value),
      emotion: state.emotion,
      translationLanguage: $("#translationLanguage").value,
      synthesisLanguage: $("#synthesisLanguage").value,
    }));
  }, 220);
}

function restoreDraft() {
  const draft = readJsonStorage("tts.draft", {});
  $("#sourceText").value = String(draft.source || "");
  $("#targetText").value = String(draft.target || "");
  $("#styleText").value = String(draft.style || "");
  $("#translationLanguage").value = String(draft.translationLanguage || "en");
  $("#synthesisLanguage").value = String(draft.synthesisLanguage || "auto");
  $("#speedControl").value = String(Number(draft.speed || 1));
  $("#intensityControl").value = String(Number.isFinite(Number(draft.intensity)) ? Number(draft.intensity) : 0.5);
  selectEmotion(String(draft.emotion || ""));
  updateControls();
  updateLanguageHint();
  updateTextCounts();
}

function selectEmotion(value) {
  state.emotion = value;
  $$("[data-emotion]").forEach((button) => {
    const active = button.dataset.emotion === value;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  $("#emotionValue").textContent = value || "自然";
  persistDraftSoon();
}

function updateControls() {
  $("#speedOutput").textContent = `${Number($("#speedControl").value).toFixed(2)}×`;
  $("#intensityOutput").textContent = `${Math.round(Number($("#intensityControl").value) * 100)}%`;
  updateTextCounts();
  persistDraftSoon();
}

function resetControls() {
  $("#speedControl").value = "1";
  $("#intensityControl").value = "0.5";
  $("#styleText").value = "";
  selectEmotion("");
  updateControls();
}

async function generateSpeech() {
  const target = $("#targetText").value.trim();
  const engines = [...state.selectedEngines];
  if (!target) {
    setInlineStatus($("#createStatus"), "请先填写需要合成的文本", "error");
    $("#targetText").focus();
    return;
  }
  if (!engines.length) {
    setInlineStatus($("#createStatus"), "请至少选择一个可用引擎", "error");
    return;
  }
  const needsVoice = engines.some((engineId) => state.engines.find((engine) => engine.id === engineId)?.capabilities?.voice_required);
  if (needsVoice && !state.selectedVoice) {
    setInlineStatus($("#createStatus"), "所选引擎需要参考音色", "error");
    openVoiceDialog();
    return;
  }
  const button = $("#generateButton");
  button.disabled = true;
  setInlineStatus($("#createStatus"), "正在创建任务……");
  try {
    const result = await api("api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engines,
        text: target,
        voice_id: state.selectedVoice || null,
        language: $("#synthesisLanguage").value.trim() || "auto",
        speed: Number($("#speedControl").value),
        emotion: state.emotion,
        emotion_intensity: Number($("#intensityControl").value),
        style: $("#styleText").value.trim(),
      }),
    });
    for (const job of result.items || []) state.previousJobStatus.set(job.id, job.status);
    setInlineStatus($("#createStatus"), `已创建 ${result.items?.length || 0} 个合成任务`, "success");
    toast("合成任务已进入队列", "success");
    await loadJobs({ quiet: true });
  } catch (error) {
    setInlineStatus($("#createStatus"), error.message, "error");
  } finally {
    button.disabled = state.selectedEngines.size === 0;
  }
}

async function cancelJob(id) {
  try {
    await api(`api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("任务已取消");
    await loadJobs({ quiet: true });
  } catch (error) { toast(error.message, "error"); }
}

async function retryJob(id) {
  try {
    await api(`api/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
    toast("已创建重试任务", "success");
    await loadJobs({ quiet: true });
  } catch (error) { toast(error.message, "error"); }
}

function setView(view) {
  const selected = $(`[data-view-panel="${CSS.escape(view)}"]`);
  if (!selected) view = "create";
  $$('[data-view-panel]').forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  window.history.replaceState(null, "", `${location.pathname}${location.search}#${view}`);
  $("#primaryNav").classList.remove("is-open");
  $("#mobileMenu").setAttribute("aria-expanded", "false");
  $(".main-area").scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  if (view === "history") loadHistory(true).catch(() => {});
  if (view === "tasks") loadJobs({ quiet: true }).catch(() => {});
  if (view === "models") loadModels(true).catch(() => {});
}

async function ensureAudio(player) {
  const key = player.dataset.player;
  if (state.audioPlayers.has(key)) return state.audioPlayers.get(key);
  const response = await apiFetch(player.dataset.audioUrl);
  if (!response.ok) throw new ApiError(`音频读取失败：HTTP ${response.status}`, response.status);
  const objectUrl = URL.createObjectURL(await response.blob());
  const audio = new Audio(objectUrl);
  audio.preload = "metadata";
  const record = { audio, objectUrl, player };
  state.audioPlayers.set(key, record);
  const seek = $("[data-audio-seek]", player);
  const current = $("[data-audio-current]", player);
  const duration = $("[data-audio-duration]", player);
  const playButton = $('[data-action="toggle-audio"]', player);
  const update = () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      seek.value = String(Math.round(audio.currentTime / audio.duration * 1000));
      duration.textContent = formatDuration(audio.duration * 1000);
    }
    current.textContent = formatDuration(audio.currentTime * 1000);
  };
  audio.addEventListener("loadedmetadata", update);
  audio.addEventListener("timeupdate", update);
  audio.addEventListener("play", () => { playButton.innerHTML = icon("pause"); playButton.setAttribute("aria-label", "暂停音频"); });
  const resetButton = () => { playButton.innerHTML = icon("play"); playButton.setAttribute("aria-label", "播放音频"); };
  audio.addEventListener("pause", resetButton);
  audio.addEventListener("ended", resetButton);
  seek.addEventListener("input", () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value) / 1000 * audio.duration;
  });
  return record;
}

async function toggleAudio(button) {
  const player = button.closest("[data-player]");
  if (!player) return;
  try {
    const record = await ensureAudio(player);
    for (const item of state.audioPlayers.values()) {
      if (item !== record) item.audio.pause();
    }
    if (record.audio.paused) await record.audio.play();
    else record.audio.pause();
  } catch (error) { toast(error.message, "error"); }
}

async function downloadAudio(path) {
  try {
    const response = await apiFetch(path);
    if (!response.ok) throw new ApiError(`下载失败：HTTP ${response.status}`, response.status);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const link = document.createElement("a");
    link.href = url;
    link.download = match?.[1] || "speech.wav";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message, "error"); }
}

function openOutput(id) {
  setView("history");
  requestAnimationFrame(() => $(`[data-output-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

function resetVoicePreview() {
  if (state.previewObjectUrl) URL.revokeObjectURL(state.previewObjectUrl);
  state.previewObjectUrl = "";
  state.recordedBlob = null;
  const preview = $("#voicePreview");
  preview.pause();
  preview.removeAttribute("src");
  preview.hidden = true;
}

function setVoicePreview(blob) {
  resetVoicePreview();
  state.recordedBlob = blob;
  state.previewObjectUrl = URL.createObjectURL(blob);
  const preview = $("#voicePreview");
  preview.src = state.previewObjectUrl;
  preview.hidden = false;
}

function openVoiceDialog(voiceId = "") {
  const dialog = $("#voiceDialog");
  state.editingVoiceId = voiceId;
  resetVoicePreview();
  $("#voiceFile").value = "";
  setInlineStatus($("#voiceFormStatus"));
  if (voiceId) {
    const voice = state.voices.find((item) => item.id === voiceId);
    if (!voice) return;
    $("#voiceDialogTitle").textContent = "编辑参考音色";
    $("#voiceDialogHint").textContent = "修改名称或参考文字，不会重新编码音频。";
    $("#voiceName").value = voice.name;
    $("#voiceTranscript").value = voice.ref_text || "";
    $("#voiceSourceControls").hidden = true;
    $("#saveVoiceButton").textContent = "保存修改";
  } else {
    $("#voiceDialogTitle").textContent = "添加参考音色";
    $("#voiceDialogHint").textContent = "录制 10–20 秒，或上传清晰的单人语音。";
    $("#voiceName").value = "我的声音";
    $("#voiceTranscript").value = "";
    $("#voiceSourceControls").hidden = false;
    $("#saveVoiceButton").textContent = "保存音色";
  }
  dialog.showModal();
  requestAnimationFrame(() => $("#voiceName").focus());
}

function stopRecordingStream() {
  if (state.mediaStream) state.mediaStream.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  clearInterval(state.recordTimer);
  state.recordTimer = null;
  $("#recordButton").classList.remove("is-recording");
  $("#recordButton").innerHTML = `${icon("mic")}<span>开始录音</span>`;
}

async function toggleRecording() {
  if (state.mediaRecorder?.state === "recording") {
    state.mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    state.mediaStream = stream;
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    state.mediaRecorder = recorder;
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener("stop", () => {
      setVoicePreview(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      stopRecordingStream();
      $("#recordTime").textContent = "录音完成";
    });
    recorder.start(500);
    state.recordStartedAt = Date.now();
    $("#recordButton").classList.add("is-recording");
    $("#recordButton").innerHTML = `${icon("stop")}<span>停止录音</span>`;
    state.recordTimer = setInterval(() => { $("#recordTime").textContent = formatDuration(Date.now() - state.recordStartedAt); }, 250);
  } catch (error) {
    setInlineStatus($("#voiceFormStatus"), `无法访问麦克风：${error.message}`, "error");
  }
}

async function saveVoice(event) {
  event.preventDefault();
  const button = $("#saveVoiceButton");
  const name = $("#voiceName").value.trim();
  const refText = $("#voiceTranscript").value.trim();
  button.disabled = true;
  setInlineStatus($("#voiceFormStatus"), state.editingVoiceId ? "正在保存修改……" : "正在转换并保存音频……");
  try {
    let voice;
    if (state.editingVoiceId) {
      voice = await api(`api/voices/${encodeURIComponent(state.editingVoiceId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ref_text: refText }),
      });
    } else {
      const file = $("#voiceFile").files[0];
      const audio = file || state.recordedBlob;
      if (!audio) throw new ApiError("请先录音或选择音频文件", 0, "audio_required");
      const form = new FormData();
      form.append("file", audio, file?.name || "recording.webm");
      form.append("name", name || "我的声音");
      form.append("ref_text", refText);
      voice = await api("api/voices", { method: "POST", body: form });
    }
    state.selectedVoice = voice.id;
    persistSelections();
    $("#voiceDialog").close("saved");
    await loadVoices();
    toast(state.editingVoiceId ? "音色信息已更新" : "音色已保存", "success");
  } catch (error) {
    setInlineStatus($("#voiceFormStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function confirmAction(title, message, confirmLabel = "确认删除") {
  const dialog = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $(".button.danger", dialog).textContent = confirmLabel;
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "confirm");
    };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
}

async function deleteVoice(id) {
  const voice = state.voices.find((item) => item.id === id);
  if (!await confirmAction("删除参考音色", `将删除“${voice?.name || id}”及其本地 WAV 文件。已经生成的结果不会删除。`)) return;
  try {
    await api(`api/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.selectedVoice === id) state.selectedVoice = "";
    await loadVoices();
    toast("参考音色已删除", "success");
  } catch (error) { toast(error.message, "error"); }
}

async function deleteOutput(id) {
  if (!await confirmAction("删除生成结果", "将删除这条历史记录和对应的本地 WAV 文件，此操作不可撤销。")) return;
  try {
    await api(`api/outputs/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadHistory(true);
    toast("生成结果已删除", "success");
  } catch (error) { toast(error.message, "error"); }
}

async function copyTarget(id) {
  const target = document.getElementById(id);
  if (!target) return;
  try {
    await navigator.clipboard.writeText(target.textContent || "");
    toast("已复制到剪贴板", "success");
  } catch { toast("复制失败，请手动选择文本", "error"); }
}

function handleDocumentClick(event) {
  const dialogClose = event.target.closest("[data-dialog-close]");
  if (dialogClose) {
    document.getElementById(dialogClose.dataset.dialogClose)?.close("cancel");
    return;
  }
  const nav = event.target.closest(".nav-item[data-view]");
  if (nav) { setView(nav.dataset.view); return; }
  const engineCard = event.target.closest("[data-engine-id]");
  if (engineCard) {
    const engine = state.engines.find((item) => item.id === engineCard.dataset.engineId);
    if (!engine?.available) {
      setView("models");
      toast(`${engine?.name || "该引擎"} 尚不可用，可在模型管理中启动或安装`);
      return;
    }
    if (state.selectedEngines.has(engine.id)) state.selectedEngines.delete(engine.id);
    else if (state.selectedEngines.size >= state.maxBatchEngines) toast(`一次最多选择 ${state.maxBatchEngines} 个引擎`, "error");
    else state.selectedEngines.add(engine.id);
    persistSelections();
    renderEngines();
    return;
  }
  const voice = event.target.closest("[data-voice-id]");
  if (voice) {
    state.selectedVoice = voice.dataset.voiceId;
    persistSelections();
    renderVoicePicker();
    return;
  }
  const emotion = event.target.closest("[data-emotion]");
  if (emotion) { selectEmotion(emotion.dataset.emotion); return; }
  const action = event.target.closest("[data-action]");
  const modelAction = event.target.closest("[data-model-action]");
  if (modelAction) {
    runModelAction(modelAction.dataset.modelId, modelAction.dataset.modelAction);
    return;
  }
  if (!action) return;
  const { action: name, id, view, downloadUrl } = action.dataset;
  if (name === "add-voice") openVoiceDialog();
  else if (name === "edit-voice") openVoiceDialog(id);
  else if (name === "delete-voice") deleteVoice(id);
  else if (name === "delete-output") deleteOutput(id);
  else if (name === "cancel-job") cancelJob(id);
  else if (name === "retry-job") retryJob(id);
  else if (name === "toggle-audio") toggleAudio(action);
  else if (name === "download-audio") downloadAudio(downloadUrl);
  else if (name === "open-output") openOutput(id);
  else if (name === "open-view") setView(view);
  else if (name === "refresh-engines") loadEngines(true);
  else if (name === "refresh-history") loadHistory(true);
  else if (name === "refresh-tasks") loadJobs();
  else if (name === "refresh-models") loadModels(true);
}

function bindEvents() {
  document.addEventListener("click", handleDocumentClick);
  $("#translateButton").addEventListener("click", translateText);
  $("#insertPause").addEventListener("click", insertPause);
  $("#generateButton").addEventListener("click", generateSpeech);
  $("#refreshStatus").addEventListener("click", async () => { await Promise.all([loadEngines(true), loadModels(true), loadSystem()]); toast("状态已刷新", "success"); });
  $("#addVoiceButton").addEventListener("click", () => openVoiceDialog());
  $("#recordButton").addEventListener("click", toggleRecording);
  $("#voiceForm").addEventListener("submit", saveVoice);
  $("#voiceDialog").addEventListener("close", () => { stopRecordingStream(); resetVoicePreview(); });
  $("#voiceFile").addEventListener("change", (event) => { const file = event.target.files[0]; if (file) setVoicePreview(file); });
  $("#speedControl").addEventListener("input", updateControls);
  $("#intensityControl").addEventListener("input", updateControls);
  $("#styleText").addEventListener("input", updateControls);
  $("#sourceText").addEventListener("input", () => { updateTextCounts(); persistDraftSoon(); });
  $("#targetText").addEventListener("input", () => { updateTextCounts(); persistDraftSoon(); });
  $("#translationLanguage").addEventListener("input", persistDraftSoon);
  $("#synthesisLanguage").addEventListener("input", () => { updateLanguageHint(); persistDraftSoon(); });
  $("#resetControls").addEventListener("click", resetControls);
  $("#taskFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-job-filter]");
    if (!button) return;
    state.taskFilter = button.dataset.jobFilter;
    $$("[data-job-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
    renderTaskList();
  });
  $("#historySearch").addEventListener("input", (event) => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => { state.historyQuery = event.target.value.trim(); loadHistory(true); }, 280);
  });
  $("#historyEngine").addEventListener("change", (event) => { state.historyEngine = event.target.value; loadHistory(true); });
  $("#historyMore").addEventListener("click", () => loadHistory(false));
  $$('[data-copy-target]').forEach((button) => button.addEventListener("click", () => copyTarget(button.dataset.copyTarget)));
  $("#authForm").addEventListener("submit", (event) => { event.preventDefault(); $("#authDialog").close("confirm"); });
  $("#mobileMenu").addEventListener("click", () => {
    const nav = $("#primaryNav");
    const open = nav.classList.toggle("is-open");
    $("#mobileMenu").setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      generateSpeech();
    } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "t") {
      event.preventDefault();
      translateText();
    }
  });
  window.addEventListener("beforeunload", () => {
    for (const record of state.audioPlayers.values()) URL.revokeObjectURL(record.objectUrl);
    stopRecordingStream();
    clearTimeout(state.modelPollingTimer);
  });
}

async function initialize() {
  bindEvents();
  $("#connectionEndpoint").textContent = `统一入口 · ${location.host}`;
  restoreDraft();
  updateApiGuide();
  showSkeleton($("#voicePicker"), 2);
  showSkeleton($("#taskRail"), 1);
  showSkeleton($("#recentRail"), 2);
  $("#voiceLibrary").innerHTML = '<div class="skeleton"></div>';
  $("#taskList").innerHTML = '<div class="skeleton"></div>';
  $("#historyList").innerHTML = '<div class="skeleton"></div>';
  $("#modelGrid").innerHTML = '<div class="skeleton"></div>';
  const initialView = location.hash.replace(/^#/, "") || "create";
  setView(initialView);
  await Promise.allSettled([loadSystem(), loadLanguages(), loadEngines(), loadModels(), loadVoices(), loadJobs({ quiet: true }), loadHistory(true)]);
  state.pollingTimer = setInterval(() => {
    if (document.visibilityState === "visible") loadJobs({ quiet: true });
  }, 2500);
}

initialize();
