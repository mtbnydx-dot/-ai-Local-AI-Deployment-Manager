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
  runnableOnly: localStorage.getItem("llamaRunnableOnly") === "1",
  uiPrefs: {
    theme: localStorage.getItem("llamaThemeMode") || "auto",
    language: localStorage.getItem("llamaLanguageMode") || "auto",
  },
};

let memoryEstimateTimer = null;
let memoryEstimateSeq = 0;

const $ = (selector) => document.querySelector(selector);
const fmtBytes = (bytes) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const fmtNumber = (value) => {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
};

const fmtTokens = (value) => fmtNumber(Math.round(Number(value || 0)));
const fmtPct = (value) => {
  const number = Number(value || 0);
  return `${(number * 100).toFixed(number >= 0.1 ? 1 : 2)}%`;
};
const fmtRate = (value, suffix = "/s") => {
  const number = Number(value || 0);
  return `${number.toFixed(number >= 10 ? 1 : 2)}${suffix}`;
};
const fmtMoney = (value) => `$${Number(value || 0).toFixed(value >= 10 ? 2 : 4)}`;

const DOWNLOAD_SOURCES = {
  huggingface: {
    label: "Hugging Face",
    hint: "Hugging Face 通用性最好，私有或 gated 模型需要提前配置 HF_TOKEN。",
  },
  modelscope: {
    label: "ModelScope 魔搭",
    hint: "ModelScope 在国内网络环境通常更顺手，需要本机可调用 modelscope CLI。",
  },
};

const PRECISION_PRESETS = [
  { value: "base", label: "原始 BF16/FP16", suffix: "", launchQuantization: "" },
  { value: "fp8", label: "FP8", suffix: "-FP8", launchQuantization: "fp8" },
  { value: "awq", label: "AWQ INT4", suffix: "-AWQ", launchQuantization: "awq" },
  { value: "gptq", label: "GPTQ INT4", suffix: "-GPTQ-Int4", launchQuantization: "gptq" },
];

const MODEL_PRESETS = [
  { developer: "Qwen", version: "Qwen3", spec: "0.6B", repo: "Qwen/Qwen3-0.6B", note: "轻量验证和低显存测试。" },
  { developer: "Qwen", version: "Qwen3", spec: "4B", repo: "Qwen/Qwen3-4B", note: "单卡友好的日常中文模型。" },
  { developer: "Qwen", version: "Qwen3", spec: "8B", repo: "Qwen/Qwen3-8B", note: "质量和速度比较均衡。" },
  { developer: "Qwen", version: "Qwen3", spec: "14B", repo: "Qwen/Qwen3-14B", note: "更强推理，建议高显存或量化。" },
  { developer: "Qwen", version: "Qwen3", spec: "32B", repo: "Qwen/Qwen3-32B", note: "适合多卡或量化部署。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "7B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", note: "推理蒸馏小规格。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "14B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B", note: "推理能力更稳，显存需求更高。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "32B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", note: "建议多卡或量化版本。" },
  { developer: "Meta", version: "Llama 3.1 Instruct", spec: "8B", repo: "meta-llama/Meta-Llama-3.1-8B-Instruct", note: "英文和通用任务稳定，可能需要授权 token。" },
  { developer: "Google", version: "Gemma 3 IT", spec: "4B", repo: "google/gemma-3-4b-it", note: "轻量 instruction 模型，可能需要授权 token。" },
  { developer: "Mistral", version: "Small Instruct", spec: "24B", repo: "mistralai/Mistral-Small-3.2-24B-Instruct-2506", note: "中等规模通用模型，建议高显存。" },
];

const DTYPE_BYTES = {
  auto: 2,
  bfloat16: 2,
  float16: 2,
  float32: 4,
};

const KV_DTYPE_BYTES = {
  auto: null,
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 1,
  q5_1: 0.7,
  q5_0: 0.66,
  q4_1: 0.58,
  q4_0: 0.52,
  iq4_nl: 0.52,
  fp8: 1,
  fp8_e5m2: 1,
  fp8_e4m3: 1,
};

const QUANTIZATION_PROFILES = {
  "": { label: "Auto", bytesPerParam: null, note: "按模型配置或 dtype 估算" },
  awq: { label: "AWQ INT4", bytesPerParam: 0.58, note: "4-bit 权重量化，另含 scale/zero 开销" },
  gptq: { label: "GPTQ INT4", bytesPerParam: 0.58, note: "4-bit 权重量化，另含 scale 开销" },
  bitsandbytes: { label: "BitsAndBytes 4-bit", bytesPerParam: 0.62, note: "通常按 NF4/INT4 估算" },
  fp8: { label: "FP8", bytesPerParam: 1.08, note: "FP8 权重，预留少量 scale 开销" },
  modelopt: { label: "ModelOpt FP8", bytesPerParam: 1.08, note: "ModelOpt FP8 权重" },
  modelopt_fp4: { label: "NVFP4", bytesPerParam: 0.62, note: "FP4 权重，预留 scale 开销" },
  "compressed-tensors": { label: "Compressed", bytesPerParam: 0.62, note: "按常见 4-bit 压缩估算" },
};

const ICON_FALLBACKS = {
  activity: "~",
  database: "DB",
  download: "DL",
  terminal: ">_",
  wrench: "TOOL",
  "badge-check": "OK",
  "refresh-cw": "R",
  "rotate-cw": "R",
  "scroll-text": "LOG",
  play: ">",
  square: "STOP",
  send: ">",
  "trash-2": "DEL",
  "bar-chart-3": "STAT",
  "shield-check": "AUD",
  "lock-keyhole": "KEY",
  eye: "VIEW",
};

const EN_TEXT = {
  "本地模型控制台": "Local Model Console",
  "Local inference console": "Local inference console",
  "服务": "Service",
  "模型": "Models",
  "下载": "Download",
  "外来访问": "External Access",
  "工具": "Tools",
  "统计": "Stats",
  "审计": "Audit",
  "日志": "Logs",
  "刷新": "Refresh",
  "启动服务": "Start Service",
  "停止": "Stop",
  "模型 ID 或本地路径": "Model ID or local path",
  "选择": "Choose",
  "仅可运行": "Runnable only",
  "服务名": "Service name",
  "端口": "Port",
  "上下文长度": "Context length",
  "并行槽数": "Parallel slots",
  "显存分配比例": "GPU memory ratio",
  "GPU layers": "GPU layers",
  "batch": "Batch",
  "ubatch": "UBatch",
  "GGUF 与远程仓库": "GGUF and remote repo",
  "加载格式": "Load format",
  "HF repo 量化": "HF repo quant",
  "K cache": "K cache",
  "V cache": "V cache",
  "Flash Attention": "Flash Attention",
  "仅文本模式": "Text-only mode",
  "llama.cpp 不传 mmproj 时就是纯文本服务；开启后会在配置和估算里明确不预留视觉 projector。": "llama.cpp is text-only when no mmproj/projector is passed. When enabled, config and estimates explicitly avoid vision-projector reserve.",
  "调用工具预设": "Client preset",
  "reasoning": "Reasoning",
  "reasoning format": "Reasoning format",
  "上下文与显存估算": "Context and VRAM estimate",
  "模型规模": "Model size",
  "权重显存": "Weight VRAM",
  "每张 GPU": "Per GPU",
  "服务访问范围": "Service access",
  "GPU 设备": "GPU devices",
  "异构双卡优化": "Heterogeneous dual-GPU",
  "多 GPU 模式": "Multi-GPU mode",
  "tensor split": "Tensor split",
  "main GPU": "Main GPU",
  "分层比例": "Layer ratio",
  "槽数": "Slots",
  "启动 llama.cpp": "Start llama.cpp",
  "运行中模型": "Running models",
  "接口测试": "API test",
  "发送": "Send",
  "模型库": "Model library",
  "在线模型": "Online models",
  "分类": "Category",
  "搜索": "Search",
  "联网查询": "Online search",
  "下载模型": "Download model",
  "选择可运行模型": "Choose runnable model",
  "模型介绍页链接": "Model page URL",
  "解析链接": "Parse link",
  "开发商": "Developer",
  "模型版本": "Model version",
  "规格": "Size",
  "量化精度": "Quantization",
  "下载来源": "Source",
  "模型 ID": "Model ID",
  "保存名称": "Save name",
  "开始下载": "Start download",
  "llama 可运行": "llama runnable",
  "需换管理器": "Use another manager",
  "Claude 调用情况": "Claude Usage",
  "把 Claude Desktop / Claude Code / Cowork 经过管理器的调用，和 OpenWebUI 聊天或直连 API 分开统计。": "Separates Claude Desktop / Claude Code / Cowork calls through the manager from OpenWebUI chat or direct API calls.",
  "暂无调用来源统计。Claude 桥接产生请求后，这里会和聊天/直连分开显示。": "No client-source stats yet. Claude bridge calls will be separated from chat/direct traffic here.",
  "Claude 统计只包含经过管理器 Claude 兼容桥的请求。": "Claude stats only include requests through the manager's Claude compatibility bridge.",
  "Claude 兼容桥": "Claude compatibility bridge",
  "OpenWebUI / 直连 API": "OpenWebUI / direct API",
  "经管理器 /claude/v1/messages 进入本地 llama.cpp 的 Claude Desktop / Claude Code / Cowork 请求。": "Claude Desktop / Claude Code / Cowork requests entering local llama.cpp through the manager's /claude/v1/messages endpoint.",
  "OpenAI 兼容接口、OpenWebUI 聊天和没有经过 Claude 桥的请求。": "OpenAI-compatible API calls, OpenWebUI chats, and requests that did not pass through the Claude bridge.",
  "工具": "Tools",
  "上下文压缩": "Context compression",
  "平均耗时": "Average latency",
  "暂无最后调用": "No recent call",
  "暂无启动任务": "No launch jobs",
  "暂无下载任务": "No download jobs",
  "稳妥异构": "Safe hetero",
  "长上下文": "Long context",
  "row 并行": "Row parallel",
  "tensor 实验": "Tensor test",
  "已检测到异构双卡": "Heterogeneous dual-GPU detected",
  "启动模式": "Launch mode",
  "实际 split": "Active split",
  "运行日志": "Runtime logs",
  "实用工具": "Utilities",
  "一键健康检查": "One-click health check",
  "启动配置方案": "Launch profiles",
  "模型兼容性检查": "Model compatibility",
  "日志智能摘要": "Log summary",
  "空闲卸载与显存保护": "Idle unload and VRAM guard",
  "模型测速基准": "Model benchmark",
  "客户端连接向导": "Client connection guide",
  "上下文压缩可视化": "Context compression",
  "模型收藏与标签": "Model notes and favorites",
  "刷新工具状态": "Refresh tools",
  "检查": "Check",
  "保存当前表单": "Save current form",
  "检查模型": "Check model",
  "摘要": "Summarize",
  "保存保护设置": "Save guard settings",
  "开始测速": "Start benchmark",
  "刷新连接": "Refresh connection",
  "刷新压缩统计": "Refresh compression",
  "保存标签": "Save note",
  "空闲自动卸载": "Auto unload when idle",
  "空闲分钟": "Idle minutes",
  "显存保护": "VRAM guard",
  "显存阈值 %": "VRAM threshold %",
  "阈值动作": "Guard action",
  "只提醒": "Warn only",
  "空闲时卸载": "Unload when idle",
  "收藏": "Favorite",
  "暂无测速任务": "No benchmark jobs",
  "审计后台": "Audit console",
  "审计密码": "Audit password",
  "解锁审计后台": "Unlock audit",
  "手动生成审计": "Manual audit export",
  "锁定": "Lock",
  "自动主题": "Auto theme",
  "浅色": "Light",
  "深色": "Dark",
  "语言自动": "Auto language",
  "中文": "Chinese",
};

const ZH_TEXT = Object.fromEntries(Object.entries(EN_TEXT).map(([zh, en]) => [en, zh]));

function enhanceUiArchitecture() {
  ensureToastRoot();
  ensureServiceExposureUi();
  ensureStatusInsightMetrics();
  enhanceLaunchFormLayout();
  enhanceToolsPage();
}

function ensureServiceExposureUi() {
  const nav = document.querySelector(".nav");
  if (nav && !nav.querySelector("[data-view='exposure']")) {
    const link = document.createElement("a");
    link.href = "#exposure";
    link.dataset.view = "exposure";
    link.innerHTML = `<i data-lucide="globe-2"></i><span>对外服务</span>`;
    nav.querySelector("[data-view='download']")?.after(link);
  }
  if ($("#exposure")) return;
  const tools = $("#tools");
  const section = document.createElement("section");
  section.className = "service-exposure-page view-panel";
  section.id = "exposure";
  section.dataset.viewPanel = "exposure";
  section.innerHTML = `
    <div class="panel exposure-hero-panel">
      <div>
        <h3>对外提供模型服务</h3>
        <p>集中管理访问范围、鉴权、客户端入口和上线前检查。这里保存的是服务化策略；模型参数仍在“服务”页启动。</p>
      </div>
      <div class="panel-actions">
        <button class="secondary-button compact-button" id="refreshServiceExposureBtn" type="button"><i data-lucide="refresh-cw"></i><span>刷新状态</span></button>
        <button class="secondary-button compact-button" id="applyExposureToLaunchBtn" type="button"><i data-lucide="send"></i><span>应用到启动表单</span></button>
      </div>
    </div>
    <div class="service-exposure-grid">
      <form class="panel exposure-settings-panel" id="serviceExposureForm">
        <div class="panel-head">
          <h3>服务化策略</h3>
          <button class="primary-button compact-button" type="submit"><i data-lucide="save"></i><span>保存</span></button>
        </div>
        <div class="exposure-form-grid">
          <label class="check-row"><input id="exposureEnabled" name="enabled" type="checkbox" /><span>启用服务化配置</span></label>
          <label>
            <span>开放方式</span>
            <select id="exposureMode" name="exposureMode">
              <option value="local">仅本机客户端</option>
              <option value="lan">局域网服务</option>
              <option value="reverse-proxy">公网/反向代理</option>
            </select>
          </label>
          <label class="check-row"><input id="exposureRequireApiKey" name="requireApiKey" type="checkbox" /><span>对外访问必须使用 API Key</span></label>
          <label>
            <span>API Key 规划</span>
            <div class="inline-input-action">
              <input id="exposureApiKey" name="apiKey" type="password" autocomplete="off" placeholder="留空表示保持现有密钥" />
              <button class="ghost-mini-button" id="generateExposureApiKey" type="button">生成</button>
            </div>
            <small id="exposureApiKeyState">未保存密钥</small>
          </label>
          <label class="check-row"><input id="exposureClearApiKey" name="clearApiKey" type="checkbox" /><span>清除已保存 API Key</span></label>
          <label><span>公网 Base URL</span><input id="exposurePublicBaseUrl" name="publicBaseUrl" placeholder="https://llm.example.com" /></label>
          <label><span>每分钟请求上限</span><input id="exposureRateLimitRpm" name="rateLimitRpm" type="number" min="1" max="5000" value="120" /></label>
          <label><span>最大并发请求</span><input id="exposureMaxConcurrentRequests" name="maxConcurrentRequests" type="number" min="1" max="256" value="4" /></label>
          <label><span>请求超时秒数</span><input id="exposureRequestTimeoutSeconds" name="requestTimeoutSeconds" type="number" min="10" max="7200" value="600" /></label>
          <label class="wide-field"><span>允许来源 / 客户端备注</span><textarea id="exposureAllowedOrigins" name="allowedOrigins" rows="3" placeholder="每行一个域名、IP 或客户端名称"></textarea></label>
          <div class="exposure-toggle-grid wide-field">
            <label class="check-row"><input id="exposureOpenAI" name="exposeOpenAI" type="checkbox" /><span>OpenAI 兼容接口</span></label>
            <label class="check-row"><input id="exposureClaude" name="exposeClaude" type="checkbox" /><span>Claude 兼容桥</span></label>
            <label class="check-row"><input id="exposureMetrics" name="exposeMetrics" type="checkbox" /><span>暴露 metrics</span></label>
            <label class="check-row"><input id="exposureAllowManagerRemote" name="allowManagerRemote" type="checkbox" /><span>允许远程管理器桥接</span></label>
          </div>
          <label class="wide-field"><span>运维备注</span><textarea id="exposureNotes" name="notes" rows="3" placeholder="服务对象、端口、防火墙、反代、密钥轮换计划等"></textarea></label>
        </div>
        <div class="form-note">llama.cpp 对外服务建议优先放在 Caddy/Nginx/Cloudflare Tunnel 后面做 TLS、鉴权和限流。保存后如需改变局域网绑定，请应用到启动表单并重启模型。</div>
      </form>
      <div class="panel exposure-status-panel"><div class="panel-head"><h3>当前入口</h3></div><div class="exposure-endpoints" id="serviceExposureEndpoints"><div class="empty compact">正在读取服务入口...</div></div></div>
      <div class="panel exposure-check-panel"><div class="panel-head"><h3>上线前检查</h3></div><div class="exposure-checks" id="serviceExposureChecks"><div class="empty compact">正在生成检查项...</div></div></div>
      <div class="panel exposure-clients-panel">
        <div class="panel-head">
          <div>
            <h3>客户端 API Key</h3>
            <p>给 OpenWebUI、Claude 或局域网设备单独发 Key，并限制模型、速率和并发。</p>
          </div>
        </div>
        <form class="service-client-form" id="serviceClientForm">
          <input name="name" placeholder="客户端名称，例如 OpenWebUI iPad" />
          <input name="allowedModels" placeholder="允许模型，留空=全部；多个用逗号分隔" />
          <input name="rateLimitRpm" type="number" min="1" max="5000" value="120" title="每分钟请求上限" />
          <input name="maxConcurrentRequests" type="number" min="1" max="256" value="4" title="最大并发" />
          <input name="requestTimeoutSeconds" type="number" min="10" max="7200" value="600" title="超时秒数" />
          <input name="expiresAt" type="datetime-local" title="过期时间，可留空" />
          <textarea name="notes" rows="2" placeholder="备注"></textarea>
          <button class="primary-button compact-button" type="submit"><i data-lucide="key-round"></i><span>创建 Key</span></button>
        </form>
        <div class="service-client-secret" id="serviceClientSecret" hidden></div>
        <div class="service-client-list" id="serviceClientList"><div class="empty compact">暂无客户端 Key。</div></div>
      </div>
    </div>
  `;
  tools?.before(section);
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

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Plain text response.
  }
  if (!response.ok) {
    const message = body && body.error ? body.error : text || response.statusText;
    throw new Error(message);
  }
  return body;
}

async function auditApi(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.auditToken}`,
      ...(options.headers || {}),
    },
    ...options,
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Markdown/plain text response.
  }
  if (!response.ok) {
    const error = new Error(body && body.error ? body.error : text || response.statusText);
    error.status = response.status;
    throw error;
  }
  return body;
}

function setButtonBusy(button, label = "处理中...") {
  if (!button) return () => {};
  const previousHtml = button.innerHTML;
  const previousDisabled = button.disabled;
  button.disabled = true;
  button.innerHTML = `<span>${escapeHtml(label)}</span>`;
  return () => {
    button.disabled = previousDisabled;
    button.innerHTML = previousHtml;
    renderIcons();
  };
}

function notify(title, detail = "", type = "info") {
  const root = $("#toastRoot");
  if (root) {
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.innerHTML = `
      <div class="toast-icon" aria-hidden="true">${type === "error" ? "!" : type === "success" ? "OK" : "i"}</div>
      <div>
        <strong>${escapeHtml(title)}</strong>
        ${detail ? `<span>${escapeHtml(detail)}</span>` : ""}
      </div>
      <button type="button" class="toast-close" aria-label="关闭提示">x</button>
    `;
    root.appendChild(toast);
    const close = () => {
      toast.classList.add("toast-exit");
      window.setTimeout(() => toast.remove(), 180);
    };
    toast.querySelector(".toast-close").addEventListener("click", close);
    window.setTimeout(close, type === "error" ? 9000 : 4800);
  }
  const text = [title, detail].filter(Boolean).join("：");
  console[type === "error" ? "error" : "log"](text);
  if ($("#testResult") && type === "error") showTestResult({ error: text });
}

function reportActionError(title, error) {
  const message = error?.message || String(error || "");
  notify(title, message, "error");
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
  $("#remoteCategory").addEventListener("change", refreshRemoteModels);
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
  if (event?.target?.id === "downloadDeveloper") syncPresetSelects("developer");
  if (event?.target?.id === "downloadVersion") syncPresetSelects("version");

  const preset = getSelectedPreset();
  const precision = getSelectedPrecision();
  const source = $("#downloadSource").value || "huggingface";
  const repo = preset ? buildPresetRepo(preset, precision) : "";
  const outputName = repo ? deriveName(repo) : "";
  if (repo) $("#downloadModel").value = repo;
  if (outputName) $("#downloadOutputName").value = outputName;

  const sourceHint = DOWNLOAD_SOURCES[source]?.hint || "";
  const knownPrecision = PRECISION_PRESETS.some((item) => item.value === precision.value);
  const precisionHint = precision.value === "base"
    ? "原始权重质量最好，显存占用也最高。"
    : knownPrecision
      ? `${precision.label} 会优先按常见仓库后缀生成 ID，下载前可以手动确认仓库名。`
      : `当前模型解析出的精度：${precision.label || precision.value}。`;
  const selectionHint = preset?.note || "当前下拉项来自已选择的在线模型；仍可手动修改模型 ID 和保存名称。";
  $("#downloadPresetHint").textContent = [sourceHint, precisionHint, selectionHint].filter(Boolean).join(" ");
}

function getSelectedPreset() {
  const developer = $("#downloadDeveloper").value;
  const version = $("#downloadVersion").value;
  const spec = $("#downloadSpec").value;
  return MODEL_PRESETS.find((item) => item.developer === developer && item.version === version && item.spec === spec);
}

function buildPresetRepo(preset, precision) {
  if (!preset) return "";
  return precision.value === "base" ? preset.repo : `${preset.repo}${precision.suffix}`;
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
  return {
    value,
    label: selectedOptionLabel($("#downloadPrecision")) || value || "未标注",
    suffix: "",
    launchQuantization: "",
  };
}

function selectedOptionLabel(select) {
  return select.options[select.selectedIndex]?.textContent?.trim() || "";
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
  const selectedPrecision = chooseDownloadPrecision(precision, precisionOptions);
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
}

function normalizedOptions(values, fallback) {
  const options = Array.isArray(values) ? values : [fallback];
  return unique(options.map((item) => String(item || "").trim()).filter(Boolean));
}

function normalizedPrecisionOptions(values, fallback) {
  return unique(normalizedOptions(values, fallback)
    .map(normalizeDownloadPrecisionOption)
    .filter(Boolean));
}

function normalizeDownloadPrecisionOption(value) {
  const normalized = normalizeDownloadQuantValue(value);
  if (!normalized || normalized === "MTP") return "";
  if (normalized === "BASE" || normalized === "BF16" || normalized === "FP16") return "原始 BF16/FP16";
  return normalized;
}

function chooseDownloadPrecision(preferred, options) {
  const values = normalizedOptions(options, preferred);
  const remoteQuant = normalizeDownloadQuantValue($("#remoteQuantFilter")?.value || "");
  const remoteChoice = remoteQuant
    ? values.find((item) => downloadPrecisionMatchesFilter(item, remoteQuant))
    : "";
  if (remoteChoice) return remoteChoice;
  if (values.includes(preferred)) return preferred;
  return values[0] || preferred || "原始 BF16/FP16";
}

function downloadPrecisionMatchesFilter(precision, filter) {
  const value = normalizeDownloadQuantValue(precision);
  if (!filter) return true;
  if (filter === "quantized") return value && value !== "BASE" && value !== "GGUF";
  if (filter === "Q4") return value.startsWith("Q4") || value.startsWith("IQ4");
  if (filter === "IQ4") return value.startsWith("IQ4");
  if (filter === "INT4") return value.includes("INT4") || value.startsWith("Q4") || value.startsWith("IQ4") || value === "NF4" || value === "NVFP4" || value === "MXFP4";
  return value === filter;
}

function normalizeDownloadQuantValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/原始|BF16\/FP16|base/i.test(raw)) return "BASE";
  const upper = raw.replace(/\s+/g, "_").replace(/-/g, "_").toUpperCase();
  const aliases = {
    ALL: "",
    AUTO: "",
    ANY: "",
    QUANTIZED: "quantized",
    AWQ_INT4: "AWQ",
    GPTQ_INT4: "GPTQ",
    Q4KM: "Q4_K_M",
    Q5KM: "Q5_K_M",
    Q8: "Q8_0",
    IQ4XS: "IQ4_XS",
    BNB_4BIT: "BNB-4bit",
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
  };
  return aliases[upper] ?? upper;
}

function inferDownloadSelection(modelId, author, source = "huggingface") {
  const owner = author || String(modelId || "").split("/")[0] || "custom";
  const repoName = String(modelId || "").split("/").filter(Boolean).pop() || String(modelId || "");
  const tokens = repoName.split(/[-_\s]+/).map((token) => token.trim()).filter(Boolean);
  const sizeIndex = tokens.findIndex(isDownloadSizeToken);
  const versionTokens = sizeIndex > 0 ? tokens.slice(0, sizeIndex) : tokens.slice(0, Math.min(tokens.length, 4));
  const specTokens = sizeIndex >= 0 ? collectDownloadSpecTokens(tokens, sizeIndex) : [];
  const precisionTokens = tokens.map(normalizeDownloadPrecisionToken).filter(Boolean);
  return {
    developer: owner,
    modelVersion: unique(versionTokens.filter((token) => !normalizeDownloadPrecisionToken(token))).join(" ") || repoName || modelId,
    spec: unique(specTokens).join(" ") || "未标注规格",
    precision: unique(precisionTokens).join(" ") || "原始 BF16/FP16",
    source,
  };
}

function collectDownloadSpecTokens(tokens, sizeIndex) {
  const spec = [tokens[sizeIndex]];
  for (let index = sizeIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (normalizeDownloadPrecisionToken(token)) break;
    if (/^(?:text|chat|instruct|coder|code|vl|vision|audio|base|it|math|reasoning|distill|distilled|sft|rl|reasoner|thinking)$/i.test(token) || /^\d{3,4}$/.test(token)) {
      spec.push(token);
    }
  }
  return spec;
}

function normalizeDownloadPrecisionToken(token) {
  const clean = String(token || "").replace(/[^a-zA-Z0-9.]+/g, "").trim();
  if (!clean) return "";
  const upper = clean.toUpperCase();
  if (["AWQ", "GPTQ", "GGUF", "GGML", "EXL2", "EETQ", "HQQ", "AQLM", "NF4", "NVFP4", "MXFP4", "MTP"].includes(upper)) return upper;
  if (/^(?:BF|FP|INT)\d+$/i.test(clean)) return upper;
  if (/^Q\d(?:[A-Z0-9]+)?$/i.test(clean)) return upper;
  if (/^IQ\d(?:[A-Z0-9]+)?$/i.test(clean)) return upper;
  return "";
}

function isDownloadSizeToken(token) {
  return /^\d+(?:\.\d+)?[BM]$/i.test(String(token || ""))
    || /^\d+(?:\.\d+)?x\d+(?:\.\d+)?[BM]$/i.test(String(token || ""));
}

function normalizeSummary(value) {
  if (!value) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
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

async function refreshModels() {
  state.models = await api("/api/models");
  renderModels();
  renderModelPicker();
  updateGgufModeState();
  updateTextOnlyNote();
  updateSidebarFoot();
}

async function refreshRemoteModels() {
  const root = $("#remoteModelList");
  root.innerHTML = `<div class="empty">正在联网查询模型...</div>`;
  state.remoteError = "";
  const params = new URLSearchParams({
    category: $("#remoteCategory").value,
    search: $("#remoteSearch").value.trim(),
    limit: String(getRemoteLimit()),
    size: $("#remoteSizeFilter")?.value || "",
    quant: $("#remoteQuantFilter")?.value || "",
    freshness: $("#remoteFreshness")?.value || "auto",
  });
  const result = await api(`/api/remote-models?${params}`);
  state.remoteModels = result.models || [];
  state.remoteMeta = {
    limit: result.limit || getRemoteLimit(),
    source: result.source || "huggingface",
    category: result.category || $("#remoteCategory").value,
    freshness: result.freshness || $("#remoteFreshness")?.value || "auto",
    quant: result.quant || $("#remoteQuantFilter")?.value || "",
  };
  renderRemoteModels();
  renderModelPicker();
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
  const report = state.health;
  const scoreBox = $("#healthScoreBox");
  if (!report) {
    $("#healthGrid").innerHTML = `<div class="empty compact">点击检查后显示环境状态。</div>`;
    if (scoreBox) scoreBox.textContent = "等待健康检查";
    return;
  }
  if (scoreBox) {
    scoreBox.innerHTML = `
      <strong>${fmtNumber(report.score)} 分</strong>
      <span>${report.ok ? "环境可用" : "发现需要处理的问题"} · ${formatDateTime(report.generatedAt)}</span>
    `;
  }
  $("#healthGrid").innerHTML = (report.checks || []).map((check) => `
    <article class="tool-card tool-${escapeAttr(check.status)}">
      <div>
        <span class="tool-status-dot"></span>
        <strong>${escapeHtml(check.label)}</strong>
      </div>
      <p>${escapeHtml(check.detail || "")}</p>
    </article>
  `).join("");
}

function renderProfiles() {
  const root = $("#profileList");
  if (!root) return;
  const profiles = [...(state.profiles.builtin || []), ...(state.profiles.profiles || [])];
  renderServiceProfileOptions(profiles);
  if (!profiles.length) {
    root.innerHTML = `<div class="empty compact">暂无配置方案。</div>`;
    return;
  }
  root.innerHTML = profiles.map((profile) => `
    <article class="profile-card">
      <div>
        <h4>${escapeHtml(profile.name)}${profile.source === "builtin" ? `<span class="pill">内置</span>` : ""}</h4>
        <p>${escapeHtml(profile.description || "无说明")}</p>
        <div class="running-meta">
          <span>${fmtTokens(profile.config?.maxModelLen || 0)} 上下文</span>
          <span>${fmtTokens(profile.config?.maxNumSeqs || 0)} 并行</span>
          <span>${escapeHtml(profile.config?.cacheTypeK || "f16")}/${escapeHtml(profile.config?.cacheTypeV || "f16")} KV</span>
          <span>${escapeHtml(profile.config?.multiGpuMode || "layer")}</span>
          <span>${escapeHtml(profile.config?.tensorSplit || "auto split")}</span>
          <span>${profile.config?.textOnlyMode === false || profile.config?.languageModelOnly === false ? "多模态预留" : "仅文本"}</span>
        </div>
      </div>
      <div class="job-actions">
        <button class="job-action-button primary" type="button" data-profile-action="apply" data-profile-id="${escapeAttr(profile.id)}">套用</button>
        ${profile.source !== "builtin" ? `<button class="job-action-button danger" type="button" data-profile-action="delete" data-profile-id="${escapeAttr(profile.id)}">删除</button>` : ""}
      </div>
    </article>
  `).join("");
}

function renderServiceProfileOptions(profiles = [...(state.profiles.builtin || []), ...(state.profiles.profiles || [])]) {
  const select = $("#serviceProfileSelect");
  if (!select) return;
  const current = select.value;
  if (!profiles.length) {
    select.innerHTML = `<option value="">暂无方案</option>`;
    renderServiceProfileSummary();
    return;
  }
  select.innerHTML = profiles.map((profile) => `
    <option value="${escapeAttr(profile.id)}">${escapeHtml(profile.name)}${profile.source === "builtin" ? " · 内置" : ""}</option>
  `).join("");
  if (profiles.some((profile) => profile.id === current)) select.value = current;
  renderServiceProfileSummary();
}

function renderServiceProfileSummary() {
  const summary = $("#serviceProfileSummary");
  const select = $("#serviceProfileSelect");
  if (!summary || !select) return;
  const profiles = [...(state.profiles.builtin || []), ...(state.profiles.profiles || [])];
  const profile = profiles.find((item) => item.id === select.value);
  if (!profile) {
    summary.textContent = "常用参数可在这里快速套用；完整管理仍在工具页。";
    return;
  }
  const cfg = profile.config || {};
  summary.textContent = [
    profile.description || "无说明",
    cfg.maxModelLen ? `${fmtTokens(cfg.maxModelLen)} 上下文` : "",
    cfg.multiGpuMode ? `${cfg.multiGpuMode} GPU` : "",
    cfg.tensorSplit ? `split ${cfg.tensorSplit}` : "",
  ].filter(Boolean).join(" · ");
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
  const root = $("#modelCheckResult");
  const result = state.modelCheck;
  if (!result) return;
  root.innerHTML = `
    <div class="tool-result-head">
      <strong>${escapeHtml(result.model)}</strong>
      <span class="pill ${result.severity === "fail" ? "fail" : result.severity === "warn" ? "warn" : "ok"}">${escapeHtml(result.severity)}</span>
    </div>
    <div class="tool-list">
      ${(result.findings || []).map((item) => `
        <article class="tool-card tool-${escapeAttr(item.severity)}">
          <div><span class="tool-status-dot"></span><strong>${escapeHtml(item.title)}</strong></div>
          <p>${escapeHtml(item.detail)}</p>
        </article>
      `).join("")}
    </div>
    <div class="job-actions">
      <button class="job-action-button primary" type="button" id="applyModelCheckBtn">套用推荐参数</button>
    </div>
  `;
  $("#applyModelCheckBtn")?.addEventListener("click", () => {
    applyLaunchProfile(result.recommendations || {});
    notify("已套用兼容性推荐", result.model, "success");
    showView("service");
  });
  renderIcons();
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
  const root = $("#logSummaryPanel");
  const summary = state.logSummary;
  if (!summary) return;
  root.innerHTML = `
    <div class="tool-result-head">
      <strong>${escapeHtml(summary.stage || "未知阶段")}</strong>
      <span class="pill ${summary.ok ? "ok" : "fail"}">${summary.ok ? "正常" : "有错误"}</span>
    </div>
    <div class="tool-list">
      ${(summary.issues || []).map((item) => `
        <article class="tool-card tool-${escapeAttr(item.severity)}">
          <div><span class="tool-status-dot"></span><strong>${escapeHtml(item.message)}</strong></div>
          <p>${escapeHtml(item.hint || "")}</p>
        </article>
      `).join("") || `<div class="empty compact">最近日志没有明显错误。</div>`}
    </div>
    <div class="selection-hint">${(summary.suggestions || []).map(escapeHtml).join(" · ")}</div>
  `;
}

function renderAutomationSettings() {
  const settings = state.automationSettings || {};
  $("#idleUnloadEnabled").checked = Boolean(settings.idleUnloadEnabled);
  $("#idleMinutes").value = settings.idleMinutes || 30;
  $("#vramGuardEnabled").checked = Boolean(settings.vramGuardEnabled);
  $("#vramPercent").value = settings.vramPercent || 94;
  $("#vramAction").value = settings.vramAction || "warn";
  $("#automationStatus").innerHTML = `
    <strong>${settings.idleUnloadEnabled || settings.vramGuardEnabled ? "自动保护已配置" : "自动保护关闭"}</strong>
    <span>空闲 ${fmtTokens(settings.idleMinutes || 30)} 分钟 · 显存阈值 ${fmtTokens(settings.vramPercent || 94)}% · ${settings.vramAction === "unload" ? "空闲时卸载" : "只提醒"}</span>
  `;
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
  const root = $("#connectionGuide");
  const guide = state.connectionGuide;
  if (!guide) return;
  root.innerHTML = `
    <div class="compat-endpoints">
      <div><strong>OpenWebUI / OpenAI Base URL</strong><code>${escapeHtml(guide.openai?.baseUrl || "-")}</code><span>API Key 可填任意占位字符串；模型名：${escapeHtml(guide.model || "-")}</span></div>
      <div><strong>Claude / ccswitch Base URL</strong><code>${escapeHtml(guide.claude?.baseUrl || "-")}</code><span>模型别名：${escapeHtml(guide.claude?.modelAlias || "-")}</span></div>
      <div><strong>curl 测试</strong><code>${escapeHtml(guide.openai?.curl || "-")}</code><span>用于确认本地服务是否返回模型列表。</span></div>
      <div><strong>管理器地址</strong><code>${escapeHtml(guide.manager?.local || "-")}</code><span>${guide.manager?.lan ? `局域网：${escapeHtml(guide.manager.lan)}` : "当前管理器只绑定本机。"}</span></div>
    </div>
  `;
}

function renderCompressionInsights() {
  const root = $("#compressionInsights");
  const data = state.compressionInsights;
  if (!data) return;
  const totals = data.totals || {};
  const last = data.last || {};
  root.innerHTML = `
    <div class="stats-row-grid">
      ${miniStat("触发次数", fmtTokens(totals.applied || 0), "Claude 桥自动压缩")}
      ${miniStat("节省 tokens", fmtTokens(totals.savedTokens || 0), `最近 ${fmtTokens(last.savedTokens || 0)}`)}
      ${miniStat("最近原文", fmtTokens(last.recentMessageCount || 0), "压缩后保留的最近消息")}
      ${miniStat("摘要消息", fmtTokens(last.summarizedMessageCount || 0), "被压缩进摘要的旧消息")}
    </div>
    <div class="selection-hint">${escapeHtml(data.note || "")}</div>
  `;
}

function renderModelNotes() {
  const root = $("#modelNotesList");
  const notes = Object.values(state.modelNotes?.notes || {}).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  if (!notes.length) {
    root.innerHTML = `<div class="empty compact">暂无收藏标签。</div>`;
    return;
  }
  root.innerHTML = notes.map((note) => `
    <article class="profile-card">
      <div>
        <h4>${note.favorite ? "★ " : ""}${escapeHtml(note.model)}</h4>
        <p>${escapeHtml(note.note || "无备注")}</p>
        <div class="pill-row">${(note.tags || []).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}</div>
      </div>
      <div class="job-actions">
        <button class="job-action-button primary" type="button" data-note-action="use" data-model="${escapeAttr(note.model)}">填入启动</button>
        <button class="job-action-button danger" type="button" data-note-action="delete" data-note-key="${escapeAttr(note.key)}">删除</button>
      </div>
    </article>
  `).join("");
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
  const status = state.status;
  $("#dockerStatus").textContent = status.docker.ok ? "可用" : "异常";
  if (status.gpu.ok) {
    const gpuLabel = status.gpu.count > 1 ? `${status.gpu.count} 张 GPU` : status.gpu.name;
    $("#gpuStatus").textContent = `${gpuLabel} · ${status.gpu.usedMb}/${status.gpu.totalMb} MB`;
    $("#subtitle").textContent = `llama.cpp / Docker / ${gpuLabel}`;
  } else {
    $("#gpuStatus").textContent = "未检测到";
    $("#subtitle").textContent = "llama.cpp / Docker";
  }
  if (status.container.running) {
    $("#serviceStatus").textContent = status.container.status || "运行中";
  } else if (status.container.exists) {
    $("#serviceStatus").textContent = status.container.status || "已停止";
  } else {
    $("#serviceStatus").textContent = "未启动";
  }
  const served = status.servedModels || [];
  $("#servedModel").textContent = served.length ? served.map((item) => item.id).join(", ") : "-";
  if (served[0]) $("#testModel").value = served[0].id;
  if (status.endpoint?.port) {
    $("#apiDocsLink").href = `http://127.0.0.1:${status.endpoint.port}/docs`;
  }
  renderRunningModels();
  renderModelPicker();
  renderGpuPicker();
  updateSplitPreview();
  renderMultiGpuModeGuide();
  updateMemoryEstimate();
}

function renderStatusInsights() {
  if (!$("#vramStatus")) return;
  const gpu = state.status?.gpu || {};
  if (gpu.ok && gpu.totalMb) {
    const usedPct = (Number(gpu.usedMb || 0) / Number(gpu.totalMb || 1)) * 100;
    $("#vramStatus").textContent = `${usedPct.toFixed(1)}% · ${fmtBytes(Number(gpu.usedMb || 0) * 1024 ** 2)} / ${fmtBytes(Number(gpu.totalMb || 0) * 1024 ** 2)}`;
    setMetricState("vramStatus", usedPct > 96 ? "fail" : usedPct > 92 ? "warn" : "ok");
  } else {
    $("#vramStatus").textContent = "-";
    setMetricState("vramStatus", "warn");
  }

  const model = (state.status?.runningModels || [])[0] || {};
  const capacity = model.contextCapacityTokens || model.maxModelLen || 0;
  const used = model.contextUsedTokens || model.contextUsed || 0;
  const contextPct = capacity ? (used / capacity) * 100 : 0;
  $("#contextStatus").textContent = capacity
    ? `${fmtTokens(used)} / ${fmtTokens(capacity)} · ${used ? contextPct.toFixed(1) : "0.0"}%`
    : state.status?.container?.running ? "等待指标" : "-";
  setMetricState("contextStatus", capacity ? (contextPct > 92 ? "fail" : contextPct > 85 ? "warn" : "ok") : state.status?.container?.running ? "warn" : "warn");

  const speed = getLiveTokensPerSecond();
  $("#speedStatus").textContent = speed ? `${speed.toFixed(1)} tok/s` : "-";
  setMetricState("speedStatus", speed ? "ok" : "warn");

  const automation = state.automationSettings || {};
  const idleEnabled = Boolean(automation.idleUnload?.enabled || automation.idleUnloadEnabled);
  const vramEnabled = Boolean(automation.vramGuard?.enabled || automation.vramGuardEnabled);
  $("#idleStatus").textContent = idleEnabled || vramEnabled
    ? `${idleEnabled ? "空闲卸载" : ""}${idleEnabled && vramEnabled ? " · " : ""}${vramEnabled ? "显存保护" : ""}`
    : "未开启";
  setMetricState("idleStatus", idleEnabled || vramEnabled ? "ok" : "warn");
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
  const root = $("#runningModelList");
  if (!root || !state.status) return;
  const status = state.status;
  const models = status.runningModels || [];
  const endpoint = status.endpoint || {};
  const compatEndpoints = renderCompatEndpoints(endpoint);

  if (!status.container?.running) {
    root.innerHTML = `
      <div class="empty compact">
        当前没有运行中的 llama.cpp 模型。启动模型后，这里会显示服务名、API 地址和卸载按钮。
      </div>
    `;
    renderIcons();
    return;
  }

  if (!models.length) {
    root.innerHTML = `
      <div class="running-model-row">
        <div>
          <h4>llama.cpp 容器正在运行</h4>
          <p>API 还没有返回模型列表，可能仍在加载权重、编译或 warmup。</p>
          <div class="running-meta">
            <span>容器：${escapeHtml(status.container.name || "llama-local")}</span>
            <span>状态：${escapeHtml(status.container.status || "running")}</span>
            <span>API：${escapeHtml(endpoint.localUrl || "-")}</span>
          </div>
          ${compatEndpoints}
        </div>
        <button class="job-action-button danger" data-running-action="unload-model">
          <i data-lucide="trash-2"></i><span>卸载</span>
        </button>
      </div>
    `;
    renderIcons();
    return;
  }

  root.innerHTML = models.map((model) => {
    const maxLen = model.maxModelLen ? `${fmtNumber(model.maxModelLen)} tokens` : "未报告";
    const created = model.createdAt ? new Date(model.createdAt).toLocaleString() : "运行中";
    const gpu = model.gpu || (status.gpu?.ok ? `${status.gpu.usedMb}/${status.gpu.totalMb} MB (${status.gpu.util}%)` : "未检测到");
    return `
      <div class="running-model-row">
        <div>
          <h4>${escapeHtml(model.id || "未命名模型")}</h4>
          <p>${escapeHtml(model.apiBaseUrl || endpoint.localUrl || "-")}</p>
          ${compatEndpoints}
          <div class="running-meta">
            <span>上下文：${escapeHtml(maxLen)}</span>
            <span>GPU：${escapeHtml(gpu)}</span>
            <span>启动：${escapeHtml(created)}</span>
            <span>容器：${escapeHtml(model.containerStatus || status.container.status || "running")}</span>
          </div>
        </div>
        <button class="job-action-button danger" data-running-action="unload-model" data-model="${escapeAttr(model.id || "")}" title="停止 llama.cpp 容器并释放显存">
          <i data-lucide="trash-2"></i><span>卸载</span>
        </button>
      </div>
    `;
  }).join("");
  injectRunningContextBadges(root, models);
  renderIcons();
}

function renderCompatEndpoints(endpoint) {
  const openai = endpoint.compat?.openai || {};
  const claude = endpoint.compat?.claude || {};
  return `
    <div class="compat-endpoints">
      <div>
        <strong>OpenAI 兼容</strong>
        <code>${escapeHtml(openai.baseUrl || endpoint.localUrl || "-")}</code>
        <span>/chat/completions、/models 由模型服务原生提供</span>
      </div>
      <div>
        <strong>Claude 兼容</strong>
        <code>${escapeHtml(claude.messagesUrl || "-")}</code>
        <span>Anthropic Messages 桥接到 OpenAI chat completions；base URL 用 ${escapeHtml(claude.baseUrl || "-")}</span>
      </div>
    </div>
  `;
}

function injectRunningContextBadges(root, models) {
  root.querySelectorAll(".running-model-row .running-meta").forEach((meta, index) => {
    const model = models[index];
    if (!model) return;
    const badge = document.createElement("span");
    badge.textContent = `活跃 KV：${formatContextUsage(model.contextUsedTokens, model.contextCapacityTokens, model.contextUsagePercent)}`;
    meta.insertBefore(badge, meta.children[1] || null);
  });
}

function formatContextUsage(used, capacity, percent) {
  const usedText = fmtTokens(used);
  if (capacity) return `${usedText} / ${fmtTokens(capacity)} tokens · KV ${fmtPct(percent)}`;
  return `${usedText} tokens · KV ${fmtPct(percent)}`;
}

function renderGpuPicker() {
  const root = $("#gpuPicker");
  const gpus = getVisibleGpus();
  if (!gpus.length) {
    root.innerHTML = `<div class="empty compact">未检测到 NVIDIA GPU；启动时会保留 Docker 默认 GPU 设置。</div>`;
    state.gpuSignature = "";
    renderHeteroPlan();
    updateMemoryEstimate();
    return;
  }

  const signature = gpus.map((gpu) => `${gpu.id}:${gpu.name}:${gpu.totalMb}`).join("|");
  if (!state.gpuSelectionTouched && !state.selectedGpuIds.size) {
    state.selectedGpuIds = new Set(gpus.map((gpu) => gpu.id));
  }
  if (state.gpuSignature === signature && root.querySelector("[name='gpuDeviceIds']")) {
    return;
  }
  state.gpuSignature = signature;

  root.innerHTML = gpus.map((gpu) => {
    const checked = state.selectedGpuIds.has(gpu.id) ? "checked" : "";
    const freeMb = Math.max(0, Number(gpu.totalMb || 0) - Number(gpu.usedMb || 0));
    const generation = inferGpuGeneration(gpu.name);
    const usage = `free ${fmtBytes(freeMb * 1024 ** 2)} · used ${gpu.usedMb}/${gpu.totalMb} MB · ${gpu.util}% · ${gpu.temp}°C${generation ? ` · ${generation}` : ""}`;
    return `
      <label class="gpu-card">
        <input type="checkbox" name="gpuDeviceIds" value="${escapeAttr(gpu.id)}" ${checked} />
        <span>
          <strong>GPU ${escapeHtml(gpu.id)} · ${escapeHtml(gpu.name)}</strong>
          <small>${escapeHtml(usage)}</small>
        </span>
      </label>
    `;
  }).join("");
  updateParallelDefaults();
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
  const primaryLabel = primary ? shortGpuLabel(primary.name, primary.id) : "主 GPU";
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
  const hetero = isFrontendHeterogeneous(selected);

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

  const memorySplit = splitStringFromWeights(selected.map((gpu) => gpu.usableGb));
  const speedSplit = splitStringFromWeights(selected.map((gpu) => gpu.usableGb * gpu.performanceFactor));
  const lightSplit = buildFrontendLightSplit(selected);
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
      description: `${shortGpuLabel(primary?.name, primary?.id)} 多承担，其它 GPU 轻量分担，适合本地 Claude 单路任务。`,
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
  const totalMb = Number(gpu.totalMb || 0);
  const usedMb = Number(gpu.usedMb || 0);
  const utilization = Math.min(0.98, Math.max(0.1, Number($("#gpuMemoryUtilization")?.value || 0.92)));
  const freeMb = Math.max(0, totalMb - usedMb);
  const usableMb = Math.max(1024, Math.floor(Math.min(totalMb * utilization, Math.max(1024, freeMb - 1024))));
  return {
    ...gpu,
    id: String(gpu.id ?? gpu.index ?? visibleIndex),
    visibleIndex,
    totalGb: totalMb / 1024,
    usedGb: usedMb / 1024,
    freeGb: freeMb / 1024,
    usableGb: usableMb / 1024,
    performanceFactor: estimateFrontendGpuFactor(gpu.name),
  };
}

function estimateFrontendGpuFactor(name) {
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

function inferGpuGeneration(name) {
  const text = String(name || "").toLowerCase();
  if (text.includes("blackwell") || text.includes("rtx pro 6000") || text.includes("pro 6000")) return "Blackwell 96GB";
  if (text.includes("rtx 50") || text.includes("5090") || text.includes("5080") || text.includes("5070")) return "RTX 50";
  if (text.includes("rtx 40") || text.includes("4090") || text.includes("4080") || text.includes("4070")) return "RTX 40";
  if (text.includes("a100")) return "A100";
  if (text.includes("h100")) return "H100";
  return "";
}

function shortGpuLabel(name, fallbackId = "0") {
  const text = String(name || "").replace(/^NVIDIA\s+/i, "").trim();
  if (!text) return `GPU ${fallbackId}`;
  if (/RTX PRO 6000/i.test(text)) return "RTX PRO 6000";
  if (/RTX 6000/i.test(text)) return "RTX 6000";
  const match = text.match(/(RTX\s+\d{4}(?:\s*Ti)?|A100|H100|H200|B200|L40S)/i);
  return match ? match[1].replace(/\s+/g, " ") : `GPU ${fallbackId}`;
}

function isFrontendHeterogeneous(gpus) {
  if (!gpus || gpus.length < 2) return false;
  const names = new Set(gpus.map((gpu) => String(gpu.name || "").toLowerCase()));
  if (names.size > 1) return true;
  const totals = gpus.map((gpu) => Number(gpu.totalMb || 0)).filter(Boolean);
  return totals.length > 1 && Math.max(...totals) / Math.max(1, Math.min(...totals)) > 1.2;
}

function splitStringFromWeights(weights) {
  const clean = (weights || []).map((value) => Math.max(1, Number(value || 0)));
  if (clean.length < 2) return "";
  return clean.map((value) => String(Math.max(1, Math.round(value)))).join(",");
}

function buildFrontendLightSplit(gpus) {
  if (!gpus || gpus.length !== 2) return "";
  const [a, b] = gpus;
  const bigger = a.usableGb >= b.usableGb ? a : b;
  const smaller = bigger === a ? b : a;
  if (bigger.usableGb / Math.max(1, smaller.usableGb) < 1.35) return "";
  const big = Math.max(1, Math.round(bigger.usableGb * 0.82));
  const small = Math.max(1, Math.round(smaller.usableGb * 0.55));
  return gpus.map((gpu) => gpu === bigger ? big : small).join(",");
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
  const payload = state.serviceExposure;
  if (!payload) return;
  const settings = payload.settings || {};
  const form = $("#serviceExposureForm");
  if (form && !form.matches(":focus-within")) {
    $("#exposureEnabled").checked = Boolean(settings.enabled);
    $("#exposureMode").value = settings.exposureMode || "local";
    $("#exposureRequireApiKey").checked = Boolean(settings.requireApiKey);
    $("#exposureClearApiKey").checked = false;
    $("#exposurePublicBaseUrl").value = settings.publicBaseUrl || "";
    $("#exposureRateLimitRpm").value = settings.rateLimitRpm || 120;
    $("#exposureMaxConcurrentRequests").value = settings.maxConcurrentRequests || 4;
    $("#exposureRequestTimeoutSeconds").value = settings.requestTimeoutSeconds || 600;
    $("#exposureAllowedOrigins").value = (settings.allowedOrigins || []).join("\n");
    $("#exposureOpenAI").checked = settings.exposeOpenAI !== false;
    $("#exposureClaude").checked = settings.exposeClaude !== false;
    $("#exposureMetrics").checked = Boolean(settings.exposeMetrics);
    $("#exposureAllowManagerRemote").checked = Boolean(settings.allowManagerRemote);
    $("#exposureNotes").value = settings.notes || "";
    $("#exposureApiKey").value = "";
  }
  const keyState = $("#exposureApiKeyState");
  if (keyState) keyState.textContent = settings.hasApiKey ? `已保存：${settings.apiKeyPreview}` : "未保存密钥";
  renderServiceExposureEndpoints(payload);
  renderServiceExposureChecks(payload);
}

function renderServiceExposureEndpoints(payload) {
  const root = $("#serviceExposureEndpoints");
  if (!root || !payload) return;
  const actual = payload.actual || {};
  const service = actual.service || {};
  const manager = actual.manager || {};
  const settings = payload.settings || {};
  const selectedMode = $("#exposureMode")?.value || settings.exposureMode || "local";
  const lanAddress = state.config?.lanAddress || service.lanHost || "127.0.0.1";
  const servicePort = Number(service.port || state.config?.defaultPort || 8080);
  const plannedOpenAiLan = selectedMode === "lan" && !service.openAiLanBaseUrl
    ? `http://${lanAddress}:${servicePort}/v1`
    : "";
  const publicOpenAi = settings.publicBaseUrl ? `${settings.publicBaseUrl.replace(/\/$/, "")}/serve/v1` : "";
  root.innerHTML = `
    ${exposureEndpointCard("OpenAI 网关（推荐）", service.openAiGatewayLocalBaseUrl || "-", "鉴权、限流、并发和超时都在这里执行；模型名可用 local-current")}
    ${service.openAiGatewayLanBaseUrl ? exposureEndpointCard("OpenAI 网关局域网", service.openAiGatewayLanBaseUrl, "局域网设备优先使用这个地址") : ""}
    ${publicOpenAi ? exposureEndpointCard("OpenAI 网关公网", publicOpenAi, "反向代理后提供给外部客户端") : ""}
    ${exposureEndpointCard("OpenAI 直连容器", service.openAiLocalBaseUrl || "-", "本机调试用；不经过管理器网关限流")}
    ${service.openAiLanBaseUrl ? exposureEndpointCard("OpenAI 容器局域网", service.openAiLanBaseUrl, `Docker 已把容器端口转发到 ${service.lanHost || "本机局域网 IP"}；直连容器端口，外部使用前需确认反向代理鉴权`) : ""}
    ${plannedOpenAiLan ? exposureEndpointCard("OpenAI 容器局域网（下次启动）", plannedOpenAiLan, "保存并按局域网模式启动/重启模型后，Docker 会把容器端口转发到这个本机 IP。") : ""}
    ${settings.exposeClaude !== false ? exposureEndpointCard("Claude 桥", service.claudeLocalMessagesUrl || "-", "Claude Desktop / Cowork / Claude Code") : ""}
    ${exposureEndpointCard("Manager", manager.localBaseUrl || "-", manager.remoteManagementAllowed ? "管理器允许远程访问" : "管理器仅建议本机访问")}
    <div class="exposure-runtime-summary">
      <span>状态：${escapeHtml(service.running ? service.containerStatus || "运行中" : "未运行")}</span>
      <span>模型：${escapeHtml((service.modelIds || []).join(", ") || "-")}</span>
      <span>上下文：${service.maxModelLen ? fmtTokens(service.maxModelLen) : "-"}</span>
      <span>客户端 Key：${fmtTokens(service.clients?.active || 0)} / ${fmtTokens(service.clients?.total || 0)}</span>
      <span>API Key：建议由反向代理强制</span>
    </div>
  `;
}

function exposureEndpointCard(title, value, detail) {
  return `
    <article class="exposure-endpoint-card">
      <span>${escapeHtml(title)}</span>
      <code>${escapeHtml(value)}</code>
      <small>${escapeHtml(detail || "")}</small>
    </article>
  `;
}

function renderServiceExposureChecks(payload) {
  const root = $("#serviceExposureChecks");
  if (!root || !payload) return;
  const checks = payload.checks || [];
  root.innerHTML = checks.length
    ? checks.map((check) => `
      <article class="exposure-check-row ${escapeAttr(check.status || "warn")}">
        <span class="tool-status-dot"></span>
        <div><strong>${escapeHtml(check.title || "")}</strong><small>${escapeHtml(check.detail || "")}</small></div>
      </article>
    `).join("")
    : `<div class="empty compact">暂无检查项。</div>`;
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
    exposeMetrics: fields.exposeMetrics.checked,
    allowManagerRemote: fields.allowManagerRemote.checked,
    notes: fields.notes.value,
  };
  const result = await api("/api/service-exposure", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.serviceExposure = result;
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
  const root = $("#serviceClientList");
  if (!root) return;
  const clients = state.serviceClients?.clients || [];
  if (!clients.length) {
    root.innerHTML = `<div class="empty compact">暂无客户端 Key。创建后明文只显示一次。</div>`;
    return;
  }
  root.innerHTML = clients.map((client) => `
    <article class="service-client-card ${client.enabled ? "enabled" : "disabled"}" data-client-id="${escapeAttr(client.id)}">
      <div class="service-client-main">
        <strong>${escapeHtml(client.name || client.id)}</strong>
        <code>${escapeHtml(client.keyPreview || "-")}</code>
        <span>${client.enabled ? "启用" : "停用"} · ${escapeHtml((client.allowedModels || []).join(", ") || "全部模型")} · ${fmtTokens(client.rateLimitRpm || 0)} req/min · 并发 ${fmtTokens(client.maxConcurrentRequests || 0)}</span>
      </div>
      <div class="service-client-usage">
        <span>${fmtTokens(client.usage?.requests?.total || 0)} 请求</span>
        <span>${fmtTokens(client.usage?.tokens?.total || 0)} tokens</span>
        <span>${client.lastUsedAt ? new Date(client.lastUsedAt).toLocaleString() : "未使用"}</span>
      </div>
      <div class="service-client-actions">
        <button class="ghost-mini-button" data-client-action="toggle" type="button">${client.enabled ? "停用" : "启用"}</button>
        <button class="ghost-mini-button" data-client-action="rotate" type="button">轮换</button>
        <button class="ghost-mini-button danger-text" data-client-action="delete" type="button">删除</button>
      </div>
    </article>
  `).join("");
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
  const box = $("#serviceClientSecret");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `
    <strong>${escapeHtml(title || "客户端 Key")}</strong>
    <code>${escapeHtml(apiKey || "")}</code>
    <small>只显示这一次。请放入客户端的 Bearer Token / API Key 字段。</small>
  `;
}

function renderStats() {
  const stats = state.stats;
  if (!stats) return;
  const totals = stats.totals || {};
  const tokens = totals.tokens || {};
  const requests = totals.requests || {};
  const speed = totals.speed || {};
  const latency = totals.latency || {};
  const context = totals.context || {};

  $("#statsSummary").innerHTML = [
    statsMetric("总 tokens", fmtTokens(tokens.total), `${fmtTokens(tokens.prompt)} 输入 · ${fmtTokens(tokens.generation)} 输出`),
    statsMetric("请求数", fmtTokens(requests.total), `${fmtTokens(requests.error)} 错误 · ${fmtTokens(requests.aborted)} 中止`),
    statsMetric("当前输出速度", fmtRate(speed.recentOutputTokensPerSecond, " tok/s"), `${fmtRate(speed.recentPromptTokensPerSecond, " in/s")} · ${fmtRate(speed.recentRequestsPerMinute, " req/min")}`),
    statsMetric("平均延迟", fmtSeconds(latency.avgE2eSeconds), `TTFT ${fmtSeconds(latency.avgTtftSeconds)}`),
    statsMetric("活跃 KV cache", formatContextUsage(context.activeTokens, context.capacityTokens, context.kvUsagePercent), "只表示当前正在推理的请求；聊天历史在 Open WebUI 侧保存"),
    statsMetric("运行时长", stats.uptimeSeconds ? formatDuration(stats.uptimeSeconds) : "-", `生命周期 ${fmtRate(speed.lifetimeTokensPerSecond, " tok/s")}`),
  ].join("");

  renderStatsModels(stats);
  renderStatsClients(stats);
  renderStatsCosts(stats);
  renderStatsDetails(stats);
  renderIcons();
}

function renderAudit() {
  const status = state.auditStatus;
  const authed = Boolean(state.auditToken);
  const statusRoot = $("#auditStatusBox");
  const loginPanel = $("#auditLoginPanel");
  const adminPanel = $("#auditAdminPanel");
  if (!statusRoot || !loginPanel || !adminPanel) return;

  statusRoot.innerHTML = status ? `
    <strong>审计目录：${escapeHtml(status.auditRoot || "-")}</strong>
    <span>Open WebUI 容器：${escapeHtml(status.openWebuiContainer || "-")} · ${status.container?.running ? "运行中" : status.container?.exists ? "已停止" : "未找到"}</span>
    <span>密码文件：${escapeHtml(status.passwordFile || "-")}</span>
  ` : "正在读取审计状态...";

  loginPanel.classList.toggle("hidden", authed);
  adminPanel.classList.toggle("hidden", !authed);
  $("#auditError").textContent = state.auditError || "";

  if (!authed) {
    $("#auditList").innerHTML = `<div class="empty compact">输入审计密码后才能查看完整对话记录。</div>`;
    $("#auditMarkdownViewer").textContent = "审计内容未解锁。";
    $("#auditSelectedMeta").textContent = "完整 Markdown 只会在密码通过后由浏览器读取。";
    renderIcons();
    return;
  }

  const exports = state.auditExports || [];
  if (!exports.length) {
    $("#auditList").innerHTML = `<div class="empty compact">暂无审计导出。卸载模型后会自动生成，也可以手动生成一次。</div>`;
  } else {
    $("#auditList").innerHTML = exports.map((item) => `
      <article class="audit-row ${item.auditId === state.selectedAuditId ? "selected" : ""}">
        <div>
          <h4>${escapeHtml(item.auditId)}</h4>
          <p>${escapeHtml(item.auditDir || "")}</p>
          <div class="running-meta">
            <span>${escapeHtml(item.reason || "manual")}</span>
            <span>${escapeHtml(item.manager || "-")}</span>
            <span>${escapeHtml(formatDate(item.createdAt))}</span>
            <span>${fmtTokens(item.chatCount)} chats</span>
            <span>${fmtTokens(item.messageCount)} messages</span>
            <span>${fmtBytes(item.mdBytes)}</span>
          </div>
        </div>
        <button class="job-action-button" data-audit-action="view-md" data-audit-id="${escapeAttr(item.auditId)}">
          <i data-lucide="eye"></i><span>查看完整 Markdown</span>
        </button>
      </article>
    `).join("");
  }

  const selected = exports.find((item) => item.auditId === state.selectedAuditId);
  $("#auditSelectedMeta").textContent = selected
    ? `${selected.auditId}\n${selected.auditDir}\n${selected.chatCount} chats · ${selected.messageCount} messages`
    : "选择一条审计记录查看完整 Markdown。";
  $("#auditMarkdownViewer").textContent = state.auditMarkdown || "未打开审计 Markdown。";
  renderIcons();
}

function statsMetric(label, value, detail) {
  return `
    <div class="stats-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail || "")}</small>
    </div>
  `;
}

function renderExternalAccess() {
  const data = state.externalAccess;
  if (!data) return;
  const totals = data.totals || {};
  const external = data.external || {};
  const local = data.local || {};
  const totalRequests = totals.requests || {};
  const externalRequests = external.requests || {};
  const externalTokens = external.tokens || {};
  const externalLatency = external.latency || {};
  const externalClients = external.clients || {};
  const service = data.service || {};
  const lastAt = external.lastAt || totals.lastAt;
  const externalShare = totalRequests.total ? (externalRequests.total || 0) / totalRequests.total : 0;
  const summaryRoot = $("#externalAccessSummary");
  if (summaryRoot) {
    summaryRoot.innerHTML = [
      statsMetric("外部请求", fmtTokens(externalRequests.total || 0), `${fmtTokens(externalRequests.success || 0)} 成功 · ${fmtTokens(externalRequests.error || 0)} 错误`),
      statsMetric("外部客户端", fmtTokens(externalClients.unique || 0), `${fmtPct(externalShare)} 来自非本机地址`),
      statsMetric("错误率", fmtPct(externalRequests.errorRate || 0), `${fmtTokens(externalRequests.authFailures || 0)} 鉴权失败 · ${fmtTokens(externalRequests.rateLimited || 0)} 限流`),
      statsMetric("平均延迟", fmtMs(externalLatency.avgMs || 0), `P50 ${fmtMs(externalLatency.p50Ms || 0)} · P95 ${fmtMs(externalLatency.p95Ms || 0)}`),
      statsMetric("外部 Tokens", fmtTokens(externalTokens.total || 0), `${fmtTokens(externalTokens.input || 0)} 输入 · ${fmtTokens(externalTokens.output || 0)} 输出`),
      statsMetric("本机请求", fmtTokens(local.requests?.total || 0), "127.0.0.1 / 本机 LAN 地址会归到这里"),
      statsMetric("流式请求", fmtTokens(externalRequests.streamed || 0), `${fmtPct(externalRequests.total ? (externalRequests.streamed || 0) / externalRequests.total : 0)} 外部请求为 stream`),
      statsMetric("最后访问", lastAt ? formatDateTime(lastAt) : "-", data.logPath || "访问日志尚未产生"),
    ].join("");
  }

  const freshness = $("#externalAccessFreshness");
  if (freshness) {
    const ageMs = data.updatedAt ? Date.now() - new Date(data.updatedAt).getTime() : 0;
    const ageSec = Math.max(0, Math.round(ageMs / 1000));
    freshness.textContent = data.updatedAt ? (ageSec < 5 ? "刚刚更新" : `更新于 ${ageSec} 秒前`) : "";
  }
  const privacy = $("#externalAccessPrivacy");
  if (privacy) privacy.innerHTML = `<i data-lucide="shield-check"></i><span>${escapeHtml(data.privacy || "只展示访问元数据，不展示聊天正文。")}</span>`;

  renderExternalEndpoints(service);
  renderExternalWindows(external.windows || {});
  renderExternalClients(data.clients || [], externalRequests.total || 0);
  renderExternalCompactList("#externalAccessPaths", data.paths || [], totalRequests.total || 0, "暂无路径访问记录。", renderExternalPathDetail);
  renderExternalModels(data);
  renderExternalCompactList("#externalAccessAuth", data.authSources || [], totalRequests.total || 0, "暂无认证字段记录。", renderExternalAuthDetail);
  renderExternalCompactList("#externalAccessStatuses", data.statuses || [], totalRequests.total || 0, "暂无状态码记录。", renderExternalStatusDetail);
  renderExternalRecent(data.recent || []);
  renderIcons();
}

function renderExternalEndpoints(service = {}) {
  const root = $("#externalAccessEndpoints");
  if (!root) return;
  const apiKeyLabel = service.requireApiKey ? "需要 API Key" : "未强制 API Key";
  const runningLabel = service.running ? "模型服务运行中" : "模型服务未运行";
  const cards = [
    renderExternalEndpointCard("Claude 兼容入口", service.claudeBaseUrl || "-", "给 Claude Desktop / CC Switch 使用，客户端再拼 /messages 或 /v1/messages。", service.running ? "ok" : "warn"),
    renderExternalEndpointCard("OpenAI 兼容入口", service.openAiGatewayBaseUrl || "-", "给 OpenWebUI、OpenCode 或 OpenAI SDK 使用，路径为 /chat/completions。", service.running ? "ok" : "warn"),
    renderExternalEndpointCard("容器直连入口", service.openAiContainerBaseUrl || "-", "仅用于故障排查；它会绕过管理器的 API Key、限流、审计与客户端策略，外部服务请用上面的兼容入口。", "warn"),
    renderExternalEndpointCard("访问策略", `${apiKeyLabel} · ${fmtTokens(service.rateLimitRpm || 0)} rpm · 并发 ${fmtTokens(service.maxConcurrentRequests || 0)}`, `${runningLabel} · LAN ${service.lanAddress || "-"}`, service.requireApiKey ? "ok" : "warn"),
  ];
  root.innerHTML = cards.join("");
}

function renderExternalEndpointCard(label, value, detail, stateName = "ok") {
  return `
    <article class="external-endpoint-card ${escapeAttr(stateName)}">
      <span>${escapeHtml(label)}</span>
      <code>${escapeHtml(value || "-")}</code>
      <small>${escapeHtml(detail || "")}</small>
    </article>
  `;
}

function renderExternalWindows(windows = {}) {
  const root = $("#externalAccessWindows");
  if (!root) return;
  const rows = [["m5", "最近 5 分钟"], ["m15", "最近 15 分钟"], ["h1", "最近 1 小时"], ["h24", "最近 24 小时"]];
  root.innerHTML = rows.map(([key, label]) => {
    const item = windows[key] || {};
    const stateName = item.errorRate >= 0.2 ? "fail" : item.errorRate > 0 ? "warn" : "ok";
    return `
      <article class="external-window-card ${stateName}">
        <div class="external-window-head">
          <span>${escapeHtml(label)}</span>
          <strong>${fmtTokens(item.total || 0)}</strong>
        </div>
        <div class="stats-row-grid external-window-stats">
          ${miniStat("客户端", fmtTokens(item.uniqueClients || 0), "唯一外部 IP")}
          ${miniStat("速度", fmtRate(item.requestsPerMinute || 0, " req/min"), "窗口平均")}
          ${miniStat("错误", fmtTokens(item.error || 0), fmtPct(item.errorRate || 0))}
          ${miniStat("Tokens", fmtTokens(item.totalTokens || 0), "输入 + 输出")}
        </div>
      </article>
    `;
  }).join("");
}

function renderExternalClients(clients, totalRequests) {
  const root = $("#externalAccessClients");
  if (!root) return;
  if (!clients.length) {
    root.innerHTML = `<div class="empty compact">暂无外部客户端访问。其他机器连上后会按 IP 显示在这里。</div>`;
    return;
  }
  root.innerHTML = clients.map((client) => renderExternalClientRow(client, totalRequests)).join("");
}

function renderExternalClientRow(client, totalRequests) {
  const share = totalRequests ? Number(client.count || 0) / totalRequests : 0;
  const stateName = client.errorRate >= 0.2 ? "fail" : client.errorRate > 0 ? "warn" : "ok";
  return `
    <article class="stats-model-row external-client-row">
      <div>
        <h4><span>${escapeHtml(client.key || "unknown")}</span><em class="status-pill ${stateName}">${escapeHtml(stateName === "ok" ? "正常" : stateName === "warn" ? "注意" : "错误")}</em></h4>
        <p>首次 ${escapeHtml(client.firstAt ? formatDateTime(client.firstAt) : "-")} · 最后 ${escapeHtml(client.lastAt ? formatDateTime(client.lastAt) : "-")}</p>
        <div class="stats-row-grid">
          ${miniStat("请求", fmtTokens(client.count || 0), `${fmtTokens(client.success || 0)} 成功 · ${fmtTokens(client.error || 0)} 错误`)}
          ${miniStat("错误率", fmtPct(client.errorRate || 0), `状态 ${topStatusLabel(client.topStatus)}`)}
          ${miniStat("延迟", fmtMs(client.avgDurationMs || 0), `Max ${fmtMs(client.maxDurationMs || 0)}`)}
          ${miniStat("Tokens", fmtTokens(client.totalTokens || 0), `${fmtTokens(client.inputTokens || 0)} 输入 · ${fmtTokens(client.outputTokens || 0)} 输出`)}
          ${miniStat("常用路径", formatAccessCounterPair(client.topPath), "按请求数排序")}
          ${miniStat("请求模型", formatAccessCounterPair(client.topModel), "客户端传入的 model")}
          ${miniStat("认证字段", formatAccessCounterPair(client.topAuthSource), "实际命中的 Header")}
          ${miniStat("流式", fmtTokens(client.streamed || 0), `${fmtPct(client.count ? (client.streamed || 0) / client.count : 0)} 请求`)}
        </div>
        ${shareBar("外部请求占比", share)}
      </div>
    </article>
  `;
}

function renderExternalCompactList(selector, items, totalRequests, emptyText, detailFn) {
  const root = $(selector);
  if (!root) return;
  if (!items.length) {
    root.innerHTML = `<div class="empty compact">${escapeHtml(emptyText)}</div>`;
    return;
  }
  root.innerHTML = renderExternalCompactRows(items, totalRequests, detailFn);
}

function renderExternalModels(data = {}) {
  const root = $("#externalAccessModels");
  if (!root) return;
  const requested = data.models || [];
  if (!requested.length) {
    root.innerHTML = `<div class="empty compact">暂无模型调用记录。</div>`;
    return;
  }
  root.innerHTML = renderExternalCompactRows(requested, data.totals?.requests?.total || 0, renderExternalModelDetail);
}

function renderExternalCompactRows(items, totalRequests, detailFn) {
  return items.map((item) => {
    const share = totalRequests ? Number(item.count || 0) / totalRequests : 0;
    const stateName = item.errorRate >= 0.2 ? "fail" : item.errorRate > 0 ? "warn" : "ok";
    return `
      <div class="external-compact-row">
        <div>
          <strong>${escapeHtml(item.key || "-")}</strong>
          <span>${escapeHtml(detailFn ? detailFn(item) : "")}</span>
          ${shareBar("占比", share)}
        </div>
        <em class="status-pill ${stateName}">${fmtTokens(item.count || 0)}</em>
      </div>
    `;
  }).join("");
}

function renderExternalRecent(events) {
  const root = $("#externalAccessRecent");
  if (!root) return;
  const rows = events.slice(0, 80);
  if (!rows.length) {
    root.innerHTML = `<div class="empty compact">暂无访问记录。远端客户端请求后会显示最近访问元数据。</div>`;
    return;
  }
  root.innerHTML = rows.map((event) => {
    const stateName = event.status >= 500 ? "fail" : event.status >= 400 ? "warn" : "ok";
    const modelText = event.model && event.resolvedModel && event.model !== event.resolvedModel ? `${event.model} → ${event.resolvedModel}` : event.model || event.resolvedModel || "-";
    return `
      <div class="external-recent-row">
        <em class="status-pill ${stateName}">${escapeHtml(String(event.status || "-"))}</em>
        <div>
          <strong>${escapeHtml(`${event.method || "-"} ${event.path || "-"}`)}</strong>
          <span>${escapeHtml(event.remoteAddress || "-")} · ${escapeHtml(event.at ? formatDateTime(event.at) : "-")} · ${escapeHtml(event.kind || "-")}</span>
        </div>
        <div class="external-recent-meta">
          <span>${escapeHtml(modelText)}</span>
          <span>${escapeHtml(event.authSource || "none")} · ${event.stream ? "stream" : "non-stream"} · ${fmtMs(event.durationMs || 0)}</span>
          <span>${fmtTokens(event.totalTokens || 0)} tokens · tools ${fmtTokens(event.toolUseCount || 0)}/${fmtTokens(event.toolSchemaCount || 0)}</span>
          ${event.error ? `<span class="external-error-text">${escapeHtml(event.error)}</span>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

function renderExternalPathDetail(item) {
  return `${fmtTokens(item.success || 0)} 成功 · ${fmtTokens(item.error || 0)} 错误 · ${formatAccessCounterPair(item.topModel, "模型 -")}`;
}

function renderExternalModelDetail(item) {
  return `${fmtTokens(item.totalTokens || 0)} tokens · ${fmtTokens(item.streamed || 0)} 流式 · 错误率 ${fmtPct(item.errorRate || 0)}`;
}

function renderExternalAuthDetail(item) {
  return `${fmtTokens(item.success || 0)} 成功 · ${fmtTokens(item.error || 0)} 错误 · ${formatAccessCounterPair(item.topPath, "路径 -")}`;
}

function renderExternalStatusDetail(item) {
  return `${fmtTokens(item.totalTokens || 0)} tokens · ${formatAccessCounterPair(item.topPath, "路径 -")} · ${formatAccessCounterPair(item.topAuthSource, "认证 -")}`;
}

function formatAccessCounterPair(pair, fallback = "-") {
  if (!Array.isArray(pair) || !pair.length) return fallback;
  return `${pair[0] || "-"} (${fmtTokens(pair[1] || 0)})`;
}

function topStatusLabel(pair) {
  if (!Array.isArray(pair) || !pair.length) return "-";
  return String(pair[0] || "-");
}

function renderStatsModels(stats) {
  const root = $("#statsModelList");
  const models = stats.models || [];
  if (!models.length) {
    root.innerHTML = `<div class="empty compact">暂无模型统计。启动模型并产生请求后这里会显示占比。</div>`;
    return;
  }
  const totalTokens = Math.max(1, stats.totals?.tokens?.total || 0);
  const totalRequests = Math.max(1, stats.totals?.requests?.total || 0);
  root.innerHTML = models.map((model) => {
    const tokenShare = model.tokens.total / totalTokens;
    const requestShare = model.requests.total / totalRequests;
    return `
      <article class="stats-model-row">
        <div>
          <h4>${escapeHtml(model.name)}</h4>
          <p>${escapeHtml(model.root || "llama.cpp model")}</p>
          <div class="stats-row-grid">
            ${miniStat("Token 占比", fmtPct(tokenShare), `${fmtTokens(model.tokens.total)} tokens`)}
            ${miniStat("请求占比", fmtPct(requestShare), `${fmtTokens(model.requests.total)} requests`)}
            ${miniStat("输出速度", fmtRate(model.speed.recentOutputTokensPerSecond, " tok/s"), `平均 ${fmtRate(model.speed.averageOutputTokensPerSecond, " tok/s")}`)}
            ${miniStat("活跃 KV", formatContextUsage(model.context.activeTokens, model.context.capacityTokens, model.context.kvUsagePercent), `平均输入 ${fmtTokens(model.averages.promptTokensPerRequest)} tokens`)}
          </div>
          ${shareBar("tokens", tokenShare)}
          ${shareBar("requests", requestShare)}
        </div>
      </article>
    `;
  }).join("");
}

function renderStatsClients(stats) {
  const root = $("#statsClientBreakdown");
  if (!root) return;
  const usage = stats.clientUsage || {};
  const clients = usage.clients || [];
  if (!clients.length) {
    root.innerHTML = `<div class="empty compact">暂无调用来源统计。Claude 桥接产生请求后，这里会和聊天/直连分开显示。</div>`;
    return;
  }
  root.innerHTML = `
    ${clients.map((client) => renderStatsClientRow(client)).join("")}
    <div class="stats-source-note">${escapeHtml(usage.note || "Claude 统计只包含经过管理器 Claude 兼容桥的请求。")}</div>
  `;
}

function renderStatsClientRow(client) {
  const en = effectiveLanguage() === "en-US";
  const tokens = client.tokens || {};
  const requests = client.requests || {};
  const tools = client.tools || {};
  const compression = client.compression || {};
  const latency = client.latency || {};
  const share = client.share || {};
  const last = client.last || {};
  const modelLine = renderClientModelLine(client);
  const lastAt = last.at || last.updatedAt;
  const labels = en ? {
    tokens: "Tokens",
    requests: "Requests",
    tools: "Tools",
    compression: "Context compression",
    latency: "Average latency",
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
  } : {
    tokens: "Tokens",
    requests: "请求",
    tools: "工具",
    compression: "上下文压缩",
    latency: "平均耗时",
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
  };
  return `
    <article class="stats-model-row">
      <div>
        <h4>${escapeHtml(client.label || client.id || "-")}</h4>
        <p>${escapeHtml(client.description || "")}</p>
        <div class="stats-row-grid">
          ${miniStat(labels.tokens, fmtTokens(tokens.total), `${fmtTokens(tokens.prompt)} ${labels.input} · ${fmtTokens(tokens.generation)} ${labels.output}`)}
          ${miniStat(labels.requests, fmtTokens(requests.total), `${fmtTokens(requests.success)} ${labels.success} · ${fmtTokens(requests.error)} ${labels.error}`)}
          ${miniStat(labels.tools, fmtTokens(tools.toolUse), `${fmtTokens(tools.schemas)} ${labels.schemas} · ${fmtTokens(requests.streamed)} ${labels.streamed}`)}
          ${miniStat(labels.compression, fmtTokens(compression.savedTokens || 0), `${fmtTokens(compression.applied || 0)} ${labels.times} · ${labels.saved}`)}
          ${miniStat(labels.latency, fmtMs(latency.avgMs), lastAt ? `${labels.last} ${formatDateTime(lastAt)}` : labels.noLast)}
        </div>
        ${modelLine}
        ${shareBar("tokens", share.tokens || 0)}
        ${shareBar("requests", share.requests || 0)}
      </div>
    </article>
  `;
}

function renderClientModelLine(client) {
  const models = (client.models || []).slice(0, 3);
  if (!models.length) return "";
  return `
    <div class="client-model-breakdown">
      ${models.map((model) => `
        <span>${escapeHtml(model.name)}：${fmtTokens(model.tokens.total)} tokens / ${fmtTokens(model.requests.total)} 请求</span>
      `).join("")}
    </div>
  `;
}

function renderStatsCosts(stats) {
  const rows = stats.costComparison || [];
  if (!rows.length) {
    $("#statsCostTable").innerHTML = `<div class="empty compact">暂无价格折算。</div>`;
    return;
  }
  $("#statsCostTable").innerHTML = `
    <div class="cost-row cost-head">
      <span>模型</span>
      <span>输入/输出</span>
      <span>标准等值</span>
      <span>含缓存等值</span>
    </div>
    ${rows.map((row) => `
      <div class="cost-row">
        <span><strong>${escapeHtml(row.provider)}</strong> ${escapeHtml(row.label)}</span>
        <span>$${row.inputPerM}/M · $${row.outputPerM}/M</span>
        <span>${fmtMoney(row.standardCost)}</span>
        <span>${fmtMoney(row.cachedEquivalentCost)}</span>
      </div>
    `).join("")}
    <div class="stats-source-note">
      价格按 ${escapeHtml(stats.pricingAsOf || "current")} 官方公开价估算；本地 llama.cpp 不会产生这些 API 费用，仅用于对比价值。
    </div>
  `;
}

function renderStatsDetails(stats) {
  const facts = stats.facts || {};
  const totals = stats.totals || {};
  const latency = totals.latency || {};
  const gpu = stats.gpu?.ok ? `${stats.gpu.usedMb}/${stats.gpu.totalMb} MB · ${stats.gpu.util}% · ${stats.gpu.temp}°C` : "未检测到";
  $("#statsDetailGrid").innerHTML = [
    miniStat("平均端到端", fmtSeconds(latency.avgE2eSeconds), "请求完成平均耗时"),
    miniStat("平均首 token", fmtSeconds(latency.avgTtftSeconds), "time to first token"),
    miniStat("平均单输出 token", fmtSeconds(latency.avgTimePerOutputTokenSeconds), "越低越快"),
    miniStat("GPU", gpu, stats.gpu?.name || ""),
    miniStat("KV cache 容量", facts.kvCacheTokens ? `${fmtTokens(facts.kvCacheTokens)} tokens` : "-", facts.maxConcurrency ? `最大并发 ${facts.maxConcurrency}x` : ""),
    miniStat("加载权重", facts.modelLoadSeconds ? `${fmtSeconds(facts.modelLoadSeconds)} · ${facts.modelLoadMemoryGiB} GiB` : "-", "模型载入阶段"),
    miniStat("torch.compile", fmtSeconds(facts.torchCompileSeconds), "首次启动主要耗时之一"),
    miniStat("warmup", fmtSeconds(facts.warmupSeconds), "profiling / warmup"),
    miniStat("CUDA graph", facts.graphCaptureGiB ? `${facts.graphCaptureGiB} GiB` : "-", "graph pool 实占"),
    miniStat("采集源", stats.source || "-", `${fmtTokens(stats.rawMetricCount)} metrics`),
  ].join("");
}

function miniStat(label, value, detail) {
  return `
    <div class="mini-stat">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? "-")}</strong>
      <small>${escapeHtml(detail || "")}</small>
    </div>
  `;
}

function shareBar(label, value) {
  const percent = Math.min(100, Math.max(0, Number(value || 0) * 100));
  return `
    <div class="share-bar">
      <span>${escapeHtml(label)}</span>
      <div><b style="width:${percent}%"></b></div>
      <em>${percent.toFixed(1)}%</em>
    </div>
  `;
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
  const popover = $("#modelPickerPopover");
  const list = $("#modelPickerList");
  if (!popover || !list) return;

  popover.classList.toggle("hidden", !state.modelPickerOpen);
  $("#modelPickerToggle")?.setAttribute("aria-expanded", state.modelPickerOpen ? "true" : "false");
  renderRunnableFilterToggles();
  document.querySelectorAll("#modelPickerTabs [data-model-source]").forEach((button) => {
    button.classList.toggle("active", button.dataset.modelSource === state.modelPickerSource);
  });

  const search = ($("#modelPickerSearch")?.value || "").trim().toLowerCase();
  const source = state.modelPickerSource || "all";
  let items = buildModelPickerItems();
  if (source !== "all") items = items.filter((item) => item.source === source);
  if (state.runnableOnly) items = items.filter(isManagerRunnableModelItem);
  if (search) {
    items = items.filter((item) => [item.label, item.model, item.detail, ...(item.badges || [])]
      .join(" ")
      .toLowerCase()
      .includes(search));
  }

  if (!items.length) {
    list.innerHTML = `<div class="empty compact">没有匹配的模型。可以换个关键词，或刷新本地/在线列表。</div>`;
    return;
  }

  list.innerHTML = items.slice(0, 80).map(renderModelPickerItem).join("");
  renderIcons();
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
  const badges = (item.badges || []).slice(0, 8)
    .map((badge) => `<span class="${item.favorite && badge === "收藏" ? "favorite" : ""}">${escapeHtml(badge)}</span>`)
    .join("");
  const fit = estimateModelFit(item);
  const metrics = [
    item.sizeBytes ? { label: "Size", value: fmtBytes(item.sizeBytes) } : null,
    item.quantLabel ? { label: "Quant", value: item.quantLabel } : null,
    fit ? { label: "GPU", value: fit.label, state: fit.state } : null,
    item.runningSpeed ? { label: "Speed", value: `${Number(item.runningSpeed).toFixed(1)} tok/s` } : null,
    item.updatedAt ? { label: "Updated", value: formatDate(item.updatedAt) } : null,
  ].filter(Boolean).map((metric) => `
    <span class="model-picker-metric ${metric.state ? `fit-${escapeAttr(metric.state)}` : ""}">
      <em>${escapeHtml(metric.label)}</em><b>${escapeHtml(metric.value)}</b>
    </span>
  `).join("");
  return `
    <button class="model-picker-item" type="button"
      data-picker-model="${escapeAttr(item.model)}"
      data-picker-name="${escapeAttr(item.label || item.model)}"
      data-picker-format="${escapeAttr(item.format || "auto")}"
      data-picker-source="${escapeAttr(item.source)}">
      <span class="model-picker-main">
        <strong>${escapeHtml(item.label || item.model)}</strong>
        <small>${escapeHtml(item.detail || item.model)}</small>
        ${metrics ? `<span class="model-picker-metrics">${metrics}</span>` : ""}
      </span>
      <span class="model-picker-badges">${badges}</span>
    </button>
  `;
}

function inferModelQuantLabel(value) {
  const text = String(value || "");
  const lower = text.toLowerCase();
  const gguf = text.match(/\bI?Q\d(?:_[A-Z0-9]+)+\b/i) || text.match(/\bQ\d\b/i);
  if (gguf) return gguf[0].toUpperCase();
  if (lower.includes("nvfp4") || lower.includes("mxfp4") || lower.includes("fp4")) return "NVFP4/FP4";
  if (lower.includes("fp8")) return "FP8";
  if (lower.includes("awq")) return "AWQ";
  if (lower.includes("gptq")) return "GPTQ";
  if (lower.includes("int4") || lower.includes("nf4")) return "INT4/NF4";
  if (lower.includes("bf16")) return "BF16";
  if (lower.includes("fp16")) return "FP16";
  return "";
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

function quantBytesForLabel(label) {
  const text = String(label || "").toLowerCase();
  if (text.includes("q2")) return 0.34;
  if (text.includes("q3")) return 0.45;
  if (text.includes("q4") || text.includes("fp4") || text.includes("int4") || text.includes("nf4")) return 0.56;
  if (text.includes("q5")) return 0.68;
  if (text.includes("q6")) return 0.8;
  if (text.includes("q8") || text.includes("fp8")) return 1.05;
  return 2;
}

function renderModels() {
  const root = $("#modelList");
  const items = [
    ...state.models.local.map((model) => ({ ...model, badge: "Local" })),
    ...state.models.cached.map((model) => ({ ...model, badge: "HF Cache" })),
  ];
  if (!items.length) {
    root.innerHTML = `<div class="empty">还没有模型，先从右侧下载或直接输入 Hugging Face ID 启动。</div>`;
    return;
  }
  root.innerHTML = items.map((model) => `
    <article class="model-row">
      <div>
        <h4>${escapeHtml(model.label)}</h4>
        <p>${escapeHtml(model.path)}</p>
        <div>
          <span class="pill">${model.badge}</span>
          <span class="pill">${fmtBytes(model.size)}</span>
          ${model.hasConfig ? `<span class="pill ok">config</span>` : ""}
          ${model.hasGguf ? `<span class="pill warn">GGUF</span>` : ""}
          ${!model.hasGguf && model.kind === "local" ? `<span class="pill fail">非 GGUF</span>` : ""}
          ${model.ggufFiles?.[0] ? `<span class="pill">${escapeHtml(model.ggufFiles[0].name || "single file")}</span>` : ""}
        </div>
      </div>
      <div class="mini-actions">
        <button title="${model.hasGguf || model.kind !== "local" ? "填入启动表单" : "llama.cpp 需要 GGUF 文件"}" ${!model.hasGguf && model.kind === "local" ? "disabled" : ""} data-action="use-model" data-model="${escapeAttr(model.launchModel)}" data-name="${escapeAttr(model.label)}" data-format="${model.hasGguf && !model.hasConfig ? "gguf" : "auto"}"><i data-lucide="play"></i></button>
      </div>
    </article>
  `).join("");
  root.querySelectorAll("[data-action='use-model']").forEach((button) => {
    button.addEventListener("click", () => {
      const model = button.dataset.model;
      $("#startModel").value = model;
      $("#servedName").value = deriveName(button.dataset.name || model);
      $("#loadFormat").value = button.dataset.format || "auto";
      setLaunchQuantizationFromModel(model);
      showView("service");
    });
  });
  renderIcons();
}

function renderRemoteModels() {
  const root = $("#remoteModelList");
  if (state.remoteError) {
    root.innerHTML = `<div class="empty">联网模型列表加载失败：${escapeHtml(state.remoteError)}</div>`;
    return;
  }
  const models = getVisibleRemoteModels();
  const hint = $("#remoteHint");
  if (hint) {
    const limit = state.remoteMeta?.limit || getRemoteLimit();
    const sizeFilter = $("#remoteSizeFilter")?.selectedOptions?.[0]?.textContent || "全部规格";
    const quantFilter = $("#remoteQuantFilter")?.selectedOptions?.[0]?.textContent || "全部 GGUF";
    hint.textContent = `已返回 ${fmtNumber(state.remoteModels.length)} 个在线模型，当前显示 ${fmtNumber(models.length)} 个 · ${sizeFilter} · ${quantFilter} · 上限 ${limit}。列表按公开元数据和 GGUF 文件名估算，gated 模型下载前需要配置 token。`;
  }
  $("#remoteLoadMoreBtn")?.toggleAttribute("disabled", getRemoteLimit() >= 120);
  if (!models.length) {
    root.innerHTML = `<div class="empty">没有找到匹配的在线模型。换个关键词再试。</div>`;
    return;
  }
  root.innerHTML = models.map((model) => {
    const badges = (model.badges || []).slice(0, 7).map((badge) => `<span class="pill">${escapeHtml(badge)}</span>`).join("");
    const gated = model.gated ? `<span class="pill warn">gated</span>` : "";
    const runnableOk = effectiveLanguage() === "en-US" ? "llama runnable" : "llama 可运行";
    const runnableWarn = effectiveLanguage() === "en-US" ? "Use another manager" : "需换管理器";
    const runnable = isManagerRunnableRemoteModel(model) ? `<span class="pill ok">${runnableOk}</span>` : `<span class="pill warn">${runnableWarn}</span>`;
    const format = model.hasGguf ? `<span class="pill warn">GGUF</span>` : model.hasSafetensors ? `<span class="pill ok">safetensors</span>` : "";
    const quant = (model.quantFormats || []).slice(0, 4).map((item) => `<span class="pill ok">${escapeHtml(item)}</span>`).join("");
    const metrics = [
      model.paramsB ? `参数 ${formatParamsB(model.paramsB)}` : "",
      model.fileSizeBytes ? `文件 ${fmtBytes(model.fileSizeBytes)}` : "",
      model.largestFileBytes ? `最大 ${fmtBytes(model.largestFileBytes)}` : "",
      model.fileCount ? `${fmtNumber(model.fileCount)} files` : "",
      model.pipelineTag || model.libraryName || "",
    ].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join("");
    return `
      <article class="remote-model-card">
        <div>
          <h4>${escapeHtml(model.label || model.id)}</h4>
          <p>${escapeHtml(model.author || "Hugging Face")} · 更新 ${escapeHtml(formatDate(model.lastModified))}</p>
          <div class="remote-meta">
            <span>下载 ${fmtNumber(model.downloads)}</span>
            <span>喜欢 ${fmtNumber(model.likes)}</span>
            ${metrics}
          </div>
          <div class="pill-row">${runnable}${format}${quant}${gated}${badges}</div>
        </div>
        <div class="remote-actions">
          <button title="填入下载页" data-action="remote-download" data-model="${escapeAttr(model.id)}" data-output="${escapeAttr(model.outputName)}"><i data-lucide="download"></i></button>
          <button title="填入启动表单" data-action="remote-start" data-model="${escapeAttr(model.id)}"><i data-lucide="play"></i></button>
          <a title="打开介绍页" href="${escapeAttr(model.url)}" target="_blank"><i data-lucide="database"></i></a>
        </div>
      </article>
    `;
  }).join("");
  root.querySelectorAll("[data-action='remote-download']").forEach((button) => {
    button.addEventListener("click", () => {
      const selected = state.remoteModels.find((model) => model.id === button.dataset.model);
      fillDownloadForm(selected ? {
        ...selected,
        source: selected.source || "huggingface",
        summary: selected.summary || "已从在线模型列表填入下载信息。",
      } : {
        source: "huggingface",
        model: button.dataset.model,
        outputName: button.dataset.output,
        summary: "已从在线模型列表填入下载信息。",
      });
      showView("download");
    });
  });
  root.querySelectorAll("[data-action='remote-start']").forEach((button) => {
    button.addEventListener("click", () => {
      $("#startModel").value = button.dataset.model;
      $("#servedName").value = deriveName(button.dataset.model);
      $("#loadFormat").value = "auto";
      setLaunchQuantizationFromModel(button.dataset.model);
      showView("service");
    });
  });
  renderIcons();
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

function isManagerRunnableModelItem(item) {
  if (item?.source === "running") return true;
  const text = [
    item?.source,
    item?.label,
    item?.model,
    item?.detail,
    item?.format,
    item?.quantLabel,
    ...(item?.badges || []),
  ].filter(Boolean).join(" ").toLowerCase();
  return item?.format === "gguf" || /\.gguf(?:\b|$)/i.test(text) || /\bgguf\b/i.test(text);
}

function isManagerRunnableRemoteModel(model) {
  const text = [
    model?.id,
    model?.label,
    model?.author,
    model?.pipelineTag,
    model?.libraryName,
    ...(model?.badges || []),
    ...(model?.quantFormats || []),
  ].filter(Boolean).join(" ").toLowerCase();
  return Boolean(model?.hasGguf) || /\bgguf\b/i.test(text);
}

function modelRemoteSizeMatches(model, size) {
  const params = Number(model.paramsB || 0);
  if (!params) return false;
  if (size === "small") return params <= 8;
  if (size === "medium") return params > 8 && params <= 14;
  if (size === "large") return params > 14 && params <= 32;
  if (size === "xlarge") return params > 32;
  return true;
}

function modelRemoteQuantMatches(model, quant) {
  const filter = normalizeDownloadQuantValue(quant);
  if (!filter) return true;
  if (filter === "quantized") return Boolean(model.hasQuantizedFiles);
  const formats = new Set((model.quantFormats || []).map(normalizeDownloadQuantValue).filter(Boolean));
  if (filter === "GGUF") return Boolean(model.hasGguf) || formats.has("GGUF");
  if (formats.has(filter)) return true;
  if (filter === "Q4") return Array.from(formats).some((item) => item.startsWith("Q4") || item.startsWith("IQ4"));
  if (filter === "IQ4") return Array.from(formats).some((item) => item.startsWith("IQ4"));
  if (filter === "INT4") return Array.from(formats).some((item) => item.includes("INT4") || item.startsWith("Q4") || item.startsWith("IQ4") || item === "NF4" || item === "NVFP4" || item === "MXFP4");
  return false;
}

function formatParamsB(value) {
  const number = Number(value || 0);
  if (!number) return "-";
  return `${number >= 10 ? number.toFixed(0) : number.toFixed(1)}B`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleDateString("zh-CN");
}

function renderJobs() {
  renderJobList($("#jobList"), (state.jobs || []).filter((job) => job.type === "download").slice(0, 6), "暂无下载任务");
  renderJobList($("#serviceJobList"), (state.jobs || []).filter((job) => job.type === "serve").slice(0, 4), "暂无启动任务");
  renderJobList($("#benchmarkJobList"), (state.jobs || []).filter((job) => job.type === "benchmark" || job.type === "automation").slice(0, 5), "暂无测速任务");
}

function renderJobList(root, jobs, emptyText) {
  if (!root) return;
  if (!jobs.length) {
    root.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  root.innerHTML = jobs.map((job) => {
    const status = jobStatusInfo(job.status);
    const tail = (job.logs || []).slice(-3).join(" | ");
    return `
      <article class="job-row ${status.rowClass}">
        <div>
          <h4>${escapeHtml(job.title)}</h4>
          <p>${escapeHtml(tail || status.detail || job.type)}</p>
          ${renderJobProgress(job)}
        </div>
        <span class="pill ${status.pillClass}">${escapeHtml(status.label)}</span>
      </article>
    `;
  }).join("");
}

function jobStatusInfo(status) {
  if (status === "success") return { label: "完成", pillClass: "ok", rowClass: "is-success", detail: "任务已完成" };
  if (status === "failed") return { label: "失败", pillClass: "fail", rowClass: "is-failed", detail: "任务失败，查看日志尾部或重试" };
  if (status === "cancelled") return { label: "已取消", pillClass: "fail", rowClass: "is-failed", detail: "下载已取消，部分文件已清理" };
  if (status === "paused") return { label: "已暂停", pillClass: "warn", rowClass: "is-queued", detail: "下载已暂停，可以继续" };
  if (status === "interrupted") return { label: "中断", pillClass: "warn", rowClass: "is-queued", detail: "管理器重启时任务仍在运行" };
  if (status === "queued") return { label: "等待", pillClass: "warn", rowClass: "is-queued", detail: "等待后台开始处理" };
  return { label: "运行中", pillClass: "warn", rowClass: "is-running", detail: "后台正在处理" };
}

function renderJobProgress(job) {
  if (job.type === "serve") return renderServeProgress(job);
  if (job.type === "benchmark") return renderBenchmarkProgress(job);
  if (job.type === "automation") return renderAutomationJobProgress(job);
  if (job.type !== "download") return "";
  const progress = job.progress || {};
  const totalBytes = Number(progress.totalBytes || job.meta?.expectedBytes || 0);
  const downloadedBytes = Number(progress.downloadedBytes || 0);
  const isDone = job.status === "success";
  const percent = totalBytes
    ? Math.min(100, Math.max(0, Number(progress.percent ?? (downloadedBytes / totalBytes) * 100)))
    : (isDone ? 100 : null);
  const fillStyle = percent === null ? "" : `style="width:${percent}%"`;
  const fillClass = percent === null && job.status === "running" ? "indeterminate" : "";
  const mainText = totalBytes
    ? `${fmtBytes(downloadedBytes)} / ${fmtBytes(totalBytes)} · ${percent.toFixed(1)}%`
    : downloadedBytes
      ? `${fmtBytes(downloadedBytes)} 已下载`
      : "等待下载开始";
  const speed = progress.speedBytesPerSec > 0 ? `${fmtBytes(progress.speedBytesPerSec)}/s` : "";
  const eta = progress.etaSeconds > 0 && job.status === "running" ? `剩余约 ${formatDuration(progress.etaSeconds)}` : "";
  const detail = [speed, eta, progress.error].filter(Boolean).join(" · ");

  return `
    <div class="job-progress">
      <div class="download-progress-track">
        <div class="download-progress-fill ${fillClass}" ${fillStyle}></div>
      </div>
      <div class="download-progress-meta">
        <span>${escapeHtml(mainText)}</span>
        <small>${escapeHtml(detail || (totalBytes ? "按本地目录大小估算" : "无法读取总大小时显示已落盘大小"))}</small>
      </div>
      ${renderDownloadActions(job)}
    </div>
  `;
}

function renderDownloadActions(job) {
  const meta = job.meta || {};
  if (job.status === "running") {
    return `
      <div class="job-actions">
        <button type="button" class="job-action-button" data-download-action="pause" data-job="${escapeAttr(job.id)}">暂停</button>
        <button type="button" class="job-action-button danger" data-download-action="cancel" data-job="${escapeAttr(job.id)}">取消并删除</button>
      </div>
    `;
  }
  const canResume = meta.model && ["paused", "interrupted", "failed", "cancelled"].includes(job.status);
  const resumeButton = canResume
    ? `<button type="button" class="job-action-button primary" data-download-action="resume" data-job="${escapeAttr(job.id)}">继续下载</button>`
    : "";
  const cleanupButton = meta.localDir && ["paused", "interrupted", "failed"].includes(job.status)
    ? `<button type="button" class="job-action-button danger" data-download-action="cancel" data-job="${escapeAttr(job.id)}">取消并删除</button>`
    : "";
  const actions = [resumeButton, cleanupButton].filter(Boolean).join("");
  return actions ? `<div class="job-actions">${actions}</div>` : "";
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

function isDockerDaemonIssue(job) {
  const progress = job.progress || {};
  const text = [
    job.error,
    progress.detail,
    ...(progress.issues || []),
    ...(job.logs || []),
  ].filter(Boolean).join("\n").toLowerCase();
  return text.includes("dockerdesktoplinuxengine")
    || text.includes("docker api")
    || text.includes("daemon is running")
    || text.includes("cannot connect to the docker daemon")
    || text.includes("docker daemon")
    || text.includes("docker desktop");
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}小时${minutes}分`;
  if (minutes) return `${minutes}分${secs}秒`;
  return `${secs}秒`;
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
  const form = new FormData(event.currentTarget);
  let model = String(form.get("model") || "").trim();
  let outputName = String(form.get("outputName") || "").trim();
  let source = String(form.get("source") || "huggingface");
  let precision = String(form.get("precision") || "").trim();
  if (!model && $("#modelPageUrl").value.trim()) {
    const resolved = await resolveModelLink();
    model = resolved?.model || "";
    outputName = resolved?.outputName || "";
    source = resolved?.source || source;
    precision = resolved?.selection?.precision || precision;
  }
  if (!model) return;
  await api("/api/download", {
    method: "POST",
    body: JSON.stringify({ model, outputName, source, precision }),
  });
  event.currentTarget.reset();
  initDownloadSelectors();
  await refreshJobs();
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
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

