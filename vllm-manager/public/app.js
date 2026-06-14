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

const UI_COPY = {
  "zh-CN": {
    "app.title": "本地模型控制台",
    "app.subtitle.fallback": "vLLM / Docker",
    "brand.subtitle": "本地推理控制台",
    "nav.service": "服务",
    "nav.models": "模型",
    "nav.download": "下载",
    "nav.exposure": "对外服务",
    "nav.externalAccess": "外来访问",
    "nav.tools": "工具",
    "nav.stats": "统计",
    "nav.audit": "审计",
    "nav.logs": "日志",
    "theme.auto": "自动主题",
    "theme.light": "浅色",
    "theme.dark": "深色",
    "language.auto": "语言自动",
    "language.zh": "中文",
    "language.en": "English",
    "modelPicker.label": "模型 ID 或本地路径",
    "modelPicker.toggle": "选择",
    "modelPicker.search": "搜索本地、缓存、收藏或在线模型",
    "modelPicker.refresh": "刷新模型列表",
    "modelPicker.all": "全部",
    "modelPicker.favorite": "收藏",
    "modelPicker.local": "本地",
    "modelPicker.cached": "缓存",
    "modelPicker.remote": "在线",
    "modelPicker.runnableOnly": "仅可运行",
    "modelPicker.runnableTitle": "仅显示 vLLM 可直接启动的模型",
    "modelPicker.empty": "没有匹配的模型。可以换个关键词，或先刷新本地/在线列表。",
    "modelPicker.loading": "正在读取模型列表...",
    "modelPicker.running": "运行中",
    "modelPicker.gated": "需授权",
    "modelPicker.updated": "更新",
    "modelPicker.selected": "已填入启动表单",
    "modelPicker.refreshing": "刷新中...",
    "remote.runnableOnly": "仅可运行",
    "remote.runnableTitle": "仅显示 vLLM 可直接运行的模型",
    "download.runnableModels": "选择可运行模型",
    "refresh": "刷新",
  },
  "en-US": {
    "app.title": "Local Model Console",
    "app.subtitle.fallback": "vLLM / Docker",
    "brand.subtitle": "Local inference console",
    "nav.service": "Service",
    "nav.models": "Models",
    "nav.download": "Download",
    "nav.exposure": "Serving",
    "nav.externalAccess": "External Access",
    "nav.tools": "Tools",
    "nav.stats": "Stats",
    "nav.audit": "Audit",
    "nav.logs": "Logs",
    "theme.auto": "Auto theme",
    "theme.light": "Light",
    "theme.dark": "Dark",
    "language.auto": "Auto language",
    "language.zh": "中文",
    "language.en": "English",
    "modelPicker.label": "Model ID or local path",
    "modelPicker.toggle": "Choose",
    "modelPicker.search": "Search local, cached, favorite, or online models",
    "modelPicker.refresh": "Refresh model list",
    "modelPicker.all": "All",
    "modelPicker.favorite": "Favorites",
    "modelPicker.local": "Local",
    "modelPicker.cached": "Cache",
    "modelPicker.remote": "Online",
    "modelPicker.runnableOnly": "Runnable only",
    "modelPicker.runnableTitle": "Only show models vLLM can launch directly",
    "modelPicker.empty": "No matching models. Try another keyword or refresh local/online lists.",
    "modelPicker.loading": "Reading model list...",
    "modelPicker.running": "Running",
    "modelPicker.gated": "Gated",
    "modelPicker.updated": "Updated",
    "modelPicker.selected": "Filled launch form",
    "modelPicker.refreshing": "Refreshing...",
    "remote.runnableOnly": "Runnable only",
    "remote.runnableTitle": "Only show models vLLM can run directly",
    "download.runnableModels": "Choose runnable model",
    "refresh": "Refresh",
  },
};

const UI_TEXT_TRANSLATIONS = {
  "可用": "Available",
  "异常": "Error",
  "未检测到": "Not detected",
  "运行中": "Running",
  "已停止": "Stopped",
  "未启动": "Not started",
  "当前模型": "Current Model",
  "启动服务": "Start Service",
  "停止": "Stop",
  "仅可运行": "Runnable only",
  "选择可运行模型": "Choose runnable model",
  "vLLM 可运行": "vLLM runnable",
  "需换管理器": "Use another manager",
  "服务名": "Service name",
  "端口": "Port",
  "上下文与显存": "Context and VRAM",
  "这些参数共同决定可用上下文、启动显存和并发能力。": "These settings jointly determine available context, startup VRAM use, and concurrency.",
  "上下文长度 max_model_len": "Context length max_model_len",
  "并发序列数 max_num_seqs": "Concurrent sequences max_num_seqs",
  "显存占用比例": "GPU memory utilization",
  "KV cache 精度": "KV cache precision",
  "多模态缓存 GB": "Multimodal cache GB",
  "启用 prefix cache": "Enable prefix cache",
  "仅语言模式": "Language-only mode",
  "本地 Claude 推荐": "Recommended for local Claude",
  "单人聊天用 4；冲 128K/192K 长上下文时用 1-2。": "Use 4 for solo chat; use 1-2 when pushing 128K/192K long context.",
  "FP8 最省显存，长上下文优先用 FP8；auto 通常会按模型 dtype 使用更大缓存。": "FP8 saves the most VRAM. Prefer FP8 for long context; auto usually follows the model dtype and uses a larger cache.",
  "CPU/KV offload 可以换更长上下文，但会牺牲速度，先从 4-8 GB 小步尝试。": "CPU/KV offload can buy more context at a speed cost. Start with small 4-8 GB steps.",
  "不用图片/视频时可开启，减少多模态 encoder 和缓存开销。": "Enable this when image/video input is not needed to reduce multimodal encoder and cache overhead.",
  "模型规模": "Model size",
  "权重显存": "Weight VRAM",
  "每张 GPU": "Per GPU",
  "单卡或未分摊": "Single GPU or not split",
  "预计可运行": "Likely runnable",
  "估算包含权重、当前上下文需要的 KV cache 和运行余量；vLLM 可能继续按显存占用比例预留更多 KV cache。 权重量化：按模型配置或 dtype 估算。 未开启仅语言模式，多模态模型会保留视觉/视频相关开销。": "The estimate includes weights, KV cache for the selected context, and runtime headroom. vLLM may reserve more KV cache according to the memory utilization ratio. Weight quantization: estimated from model config or dtype. Language-only mode is off, so multimodal models keep vision/video overhead.",
  "量化": "Quantization",
  "加载格式": "Load format",
  "调用工具预设": "Client/tool preset",
  "本次启动会使用 --reasoning-parser qwen3。 Open WebUI 能把 reasoning_content / reasoning / thinking 分离成思考块，推荐启用匹配模型的 parser。": "This launch will use --reasoning-parser qwen3. OpenWebUI can separate reasoning_content / reasoning / thinking into thinking blocks. Use the parser that matches the model.",
  "工具调用桥接": "Tool-call bridge",
  "Claude 会把工具 schema 发给管理器，管理器再转成 vLLM/OpenAI tools。": "Claude sends tool schemas to the manager; the manager converts them to vLLM/OpenAI tools.",
  "启用 vLLM 自动工具调用": "Enable vLLM automatic tool choice",
  "本次启动会使用 --enable-auto-tool-choice --tool-call-parser qwen3_coder。 Open WebUI 的函数调用会直接走 OpenAI tools；模型支持 parser 时可开启。": "This launch will use --enable-auto-tool-choice --tool-call-parser qwen3_coder. OpenWebUI function calls go through OpenAI tools directly; enable this when the model supports the parser.",
  "Claude 上下文自动压缩": "Claude automatic context compression",
  "仅作用于 Claude 兼容桥；触发后保留最近原文，把更旧内容压成结构化摘要。": "Only applies to the Claude compatibility bridge. When triggered, recent original messages are kept and older content is compressed into a structured summary.",
  "启用自动压缩": "Enable automatic compression",
  "触发阈值 %": "Trigger threshold %",
  "最近原文保留 %": "Recent original retention %",
  "摘要预算 %": "Summary budget %",
  "谨慎模式": "Cautious mode",
  "自动压缩已启用：估算 prompt + 输出预算达到上下文 90% 时触发；最近 20% 原文不压缩，旧内容压成 20% 结构化摘要。 错误、路径、模型名、端口、用户硬性要求和最近工具调用会优先保留。": "Automatic compression is enabled: it triggers when estimated prompt + output budget reaches 90% of context. The latest 20% remains uncompressed, and older content is compressed into a 20% structured summary. Errors, paths, model names, ports, hard user requirements, and recent tool calls are preserved first.",
  "保存压缩设置": "Save compression settings",
  "服务访问范围": "Service access scope",
  "当前仅本机访问。OpenAI 兼容地址为 http://127.0.0.1:8000/v1；Claude 兼容地址为 http://127.0.0.1:5177/claude/v1/messages。": "Localhost only. OpenAI-compatible base URL: http://127.0.0.1:8000/v1. Claude-compatible endpoint: http://127.0.0.1:5177/claude/v1/messages.",
  "GPU 设备": "GPU devices",
  "勾选要暴露给 vLLM 的显卡；单卡机器会自动选中 GPU 0。": "Select the GPUs exposed to vLLM. Single-GPU machines automatically select GPU 0.",
  "多 GPU 利用方式": "Multi-GPU mode",
  "执行后端": "Execution backend",
  "TP 数": "TP size",
  "PP 数": "PP size",
  "DP 数": "DP size",
  "Tensor Parallel 适合把大模型切到多张同规格 GPU；Pipeline Parallel 适合超大模型分层放置；Data Parallel 更偏吞吐扩展，普通非 MoE 模型通常用多实例更直接。": "Tensor Parallel splits large models across matched GPUs. Pipeline Parallel places layers across GPUs for very large models. Data Parallel is for throughput scaling; for ordinary non-MoE models, multiple instances are often more direct.",
  "启动 vLLM": "Start vLLM",
  "暂无启动任务": "No startup jobs",
  "运行中模型": "Running Models",
  "显示当前 vLLM 容器实际暴露的模型；卸载会停止该 vLLM 容器。": "Shows the models actually exposed by the current vLLM container. Unload stops that vLLM container.",
  "一键 Claude": "One-click Claude",
  "OpenAI 兼容": "OpenAI compatible",
  "/chat/completions、/models 由模型服务原生提供": "/chat/completions and /models are provided directly by the model service.",
  "Claude 兼容": "Claude compatible",
  "Base URL 用 http://127.0.0.1:5177/claude；模型名用 claude-opus-4-7": "Use Base URL http://127.0.0.1:5177/claude and model name claude-opus-4-7.",
  "卸载": "Unload",
  "实测上限": "Measured limit",
  "来自 /v1/models 的 max_model_len": "max_model_len from /v1/models",
  "KV 容量": "KV capacity",
  "来自启动日志并持久化保存": "Persisted from startup logs",
  "当前活跃 KV": "Current active KV",
  "只代表正在运行的请求": "Only active running requests",
  "累计吞吐": "Cumulative throughput",
  "为什么启动慢、显存高？": "Why startup is slow and VRAM is high",
  "vLLM 启动会经历读权重、初始化 CUDA/FlashInfer、torch.compile、profiling 和 warmup；显存还会预留 KV cache、CUDA graph、encoder cache 和并发余量。": "vLLM startup reads weights, initializes CUDA/FlashInfer, runs torch.compile, profiling, and warmup. VRAM is also reserved for KV cache, CUDA graphs, encoder cache, and concurrency headroom.",
  "接口测试": "API Test",
  "用一句中文回答：本地 vLLM 服务是否可用？": "Answer briefly: is the local vLLM service available?",
  "发送": "Send",
  "等待测试": "Waiting for test",
  "模型库": "Model Library",
  "在线模型": "Online Models",
  "从 Hugging Face Hub 实时获取，适合找最新、热门、蒸馏和去审查模型。": "Fetched live from Hugging Face Hub, useful for finding latest, popular, distilled, and uncensored models.",
  "分类": "Category",
  "搜索": "Search",
  "联网查询": "Search online",
  "在线列表按公开模型元数据返回；gated 模型下载前需要配置对应 token。": "The online list uses public model metadata. Gated models require the matching token before download.",
  "下载模型": "Download Model",
  "模型介绍页链接": "Model page link",
  "解析链接": "Parse link",
  "粘贴 Hugging Face 或 ModelScope 的模型页面链接，可自动填入模型 ID、保存名和下载来源。": "Paste a Hugging Face or ModelScope model page link to auto-fill model ID, save name, and source.",
  "选择预设后仍可手动改模型 ID。": "You can still edit the model ID after choosing a preset.",
  "规格越大效果通常越好但更吃显存；量化精度越低越省显存，可能损失一点质量。": "Larger specs usually perform better but use more VRAM. Lower quantization saves VRAM but may lose some quality.",
  "开发商": "Developer",
  "模型版本": "Model version",
  "规格": "Size",
  "量化精度": "Quantization precision",
  "下载来源": "Download source",
  "Hugging Face 通用性最好，私有或 gated 模型需要提前配置 HF_TOKEN。 原始权重质量最好，显存占用也最高。 轻量验证和低显存测试。": "Hugging Face has the best general compatibility. Private or gated models require HF_TOKEN. Original weights have the best quality and the highest VRAM use. Good for lightweight validation and low-VRAM tests.",
  "模型 ID": "Model ID",
  "保存名称": "Save name",
  "开始下载": "Start download",
  "暂无下载任务": "No download jobs",
  "实用工具": "Utilities",
  "把健康检查、启动方案、模型兼容性、日志摘要、测速、连接和自动保护放在一起。": "Health checks, launch profiles, model compatibility, log summaries, benchmarks, connection guides, and protections in one place.",
  "刷新工具状态": "Refresh tools",
  "环境可用": "Environment available",
  "一键健康检查": "One-click health check",
  "检查 Docker、GPU、镜像、API、目录、token、CLI 和最近错误。": "Check Docker, GPU, image, API, directories, tokens, CLI tools, and recent errors.",
  "检查": "Check",
  "vLLM 镜像": "vLLM image",
  "镜像版本": "Image version",
  "vLLM 容器": "vLLM container",
  "OpenAI 兼容 API": "OpenAI-compatible API",
  "模型目录": "Model directory",
  "HF 缓存目录": "HF cache directory",
  "下载 gated 模型前需要配置 HF_TOKEN": "Set HF_TOKEN before downloading gated models",
  "最近日志": "Recent logs",
  "启动配置方案": "Launch profiles",
  "保存和套用 Claude 长上下文、OpenWebUI、低显存、多卡等启动参数。": "Save and apply launch settings for Claude long context, OpenWebUI, low VRAM, and multi-GPU use.",
  "保存当前表单": "Save current form",
  "Claude 长上下文 64K": "Claude long context 64K",
  "本地 Claude 单人使用，启动更稳，适合日常编码和工具调用。": "For solo local Claude use. More stable startup; suitable for daily coding and tool calls.",
  "Claude 极限上下文": "Claude maximum context",
  "冲 128K/192K/256K 时使用，牺牲并发换上下文。": "Use when pushing 128K/192K/256K. Trades concurrency for context.",
  "OpenWebUI 日常聊天": "OpenWebUI daily chat",
  "偏稳定和吞吐，适合 OpenWebUI 直接聊天。": "Optimized for stability and throughput; suitable for direct OpenWebUI chat.",
  "低显存保守模式": "Low-VRAM conservative mode",
  "启动失败或显存吃紧时先用这个排查。": "Use this first when startup fails or VRAM is tight.",
  "内置": "Built-in",
  "套用": "Apply",
  "模型兼容性检查": "Model compatibility check",
  "启动前判断 vLLM / GGUF / token / parser / 量化参数风险。": "Check vLLM / GGUF / token / parser / quantization risks before startup.",
  "检查模型": "Check model",
  "尚未检查模型。": "Model has not been checked yet.",
  "日志智能摘要": "Smart log summary",
  "把 vLLM 最近日志整理成阶段、错误、原因和建议操作。": "Summarize recent vLLM logs into phases, errors, causes, and suggested actions.",
  "摘要": "Summarize",
  "尚未读取日志摘要。": "No log summary loaded yet.",
  "空闲卸载与显存保护": "Idle unload and VRAM protection",
  "默认关闭。开启后管理器会按空闲时间或显存阈值提醒/卸载 vLLM 容器。": "Disabled by default. When enabled, the manager can warn or unload vLLM based on idle time or VRAM threshold.",
  "保存保护设置": "Save protection settings",
  "空闲自动卸载": "Idle auto-unload",
  "空闲分钟": "Idle minutes",
  "显存保护": "VRAM protection",
  "显存阈值 %": "VRAM threshold %",
  "阈值动作": "Threshold action",
  "自动保护关闭": "Auto protection off",
  "空闲 30 分钟 · 显存阈值 94% · 只提醒": "Idle 30 minutes · VRAM threshold 94% · warn only",
  "模型测速基准": "Model benchmark",
  "对当前运行模型做短测，记录延迟、输出速度和返回预览。": "Run a short benchmark against the current model and record latency, output speed, and a preview.",
  "用中文简要说明本地模型是否可以稳定完成工具调用、长上下文和代码任务。": "Briefly explain whether the local model can reliably handle tool calls, long context, and coding tasks.",
  "开始测速": "Start benchmark",
  "暂无测速任务": "No benchmark jobs",
  "客户端连接向导": "Client connection guide",
  "OpenWebUI、Claude Desktop / ccswitch、curl 测试命令集中展示。": "OpenWebUI, Claude Desktop / ccswitch, and curl test commands in one place.",
  "刷新连接": "Refresh connection",
  "API Key 可填任意占位字符串；模型名：qwen3.6-27b-aeon-ultimate-uncensored-multimodal-nvfp4-mtp-xs": "API key can be any placeholder string. Model name: qwen3.6-27b-aeon-ultimate-uncensored-multimodal-nvfp4-mtp-xs",
  "模型别名：claude-opus-4-7": "Model alias: claude-opus-4-7",
  "curl 测试": "curl test",
  "用于确认本地服务是否返回模型列表。": "Use this to confirm the local service returns the model list.",
  "管理器地址": "Manager address",
  "当前管理器只绑定本机。": "The manager is currently bound to localhost only.",
  "上下文压缩可视化": "Context compression view",
  "只显示压缩统计和最近会话，不读取原始对话正文。": "Only compression statistics and recent sessions are shown. Raw conversation text is not read.",
  "刷新压缩统计": "Refresh compression stats",
  "触发次数": "Triggers",
  "Claude 桥自动压缩": "Claude bridge auto-compression",
  "节省 tokens": "Saved tokens",
  "最近原文": "Recent originals",
  "压缩后保留的最近消息": "Recent messages kept after compression",
  "摘要消息": "Summary messages",
  "被压缩进摘要的旧消息": "Older messages compressed into summaries",
  "这里只显示压缩统计和最近会话摘要，不返回原始对话正文。": "Only compression statistics and recent session summaries are shown here. Raw conversation text is not returned.",
  "模型收藏与标签": "Model favorites and tags",
  "给常用模型标记用途，例如 Claude、长上下文、去审查、多模态、容易报错。": "Tag common models by purpose, such as Claude, long context, uncensored, multimodal, or error-prone.",
  "保存标签": "Save tag",
  "收藏": "Favorite",
  "暂无收藏标签。": "No favorite tags yet.",
  "统计总览": "Statistics Overview",
  "来自 vLLM /metrics 与本地累计账本，统计请求、速度、上下文和等价 API 价值。": "Request, speed, context, and API-equivalent value from vLLM /metrics and the local cumulative ledger.",
  "累计 tokens": "Total tokens",
  "请求数": "Requests",
  "当前实例": "Current instance",
  "当前输出速度": "Current output speed",
  "平均延迟": "Average latency",
  "活跃 KV cache": "Active KV cache",
  "只表示当前正在推理的请求；聊天历史在 Open WebUI 侧保存": "Only active inference requests are shown. Chat history is stored by OpenWebUI.",
  "错误率": "Error rate",
  "当前累计未记录错误请求": "No cumulative error requests recorded",
  "运行时长": "Uptime",
  "模型占比": "Model Share",
  "按模型名聚合 token、请求、上下文和速度。": "Tokens, requests, context, and speed grouped by model name.",
  "Token 占比": "Token share",
  "请求占比": "Request share",
  "输出速度": "Output speed",
  "活跃 KV": "Active KV",
  "历史累计": "Historical total",
  "Claude 调用情况": "Claude Usage",
  "把 Claude Desktop / Claude Code / Cowork 经过管理器的调用，和 OpenWebUI 聊天或直连 API 分开统计。": "Separates Claude Desktop / Claude Code / Cowork calls through the manager from OpenWebUI chat or direct API traffic.",
  "Claude 兼容桥": "Claude compatibility bridge",
  "经管理器 /claude/v1/messages 进入本地 vLLM 的 Claude Desktop / Claude Code / Cowork 请求。": "Claude Desktop / Claude Code / Cowork requests entering local vLLM through the manager's /claude/v1/messages endpoint.",
  "请求": "Requests",
  "工具": "Tools",
  "上下文压缩": "Context compression",
  "平均耗时": "Average duration",
  "Claude 当前任务": "Current Claude task",
  "聊天 / 直连 OpenAI": "Chat / Direct OpenAI",
  "OpenWebUI、API Docs 测试页或其他直接访问 vLLM /v1 的请求。这里按 vLLM 总量减去 Claude 桥接量估算。": "OpenWebUI, API Docs test page, or other requests directly accessing vLLM /v1. Estimated as total vLLM traffic minus Claude bridge traffic.",
  "暂无最后调用": "No last call",
  "Claude 只统计通过管理器 Claude 兼容桥的请求；OpenWebUI 或直接访问 vLLM /v1 的请求会归入聊天/直连。": "Claude only counts requests through the manager's Claude bridge. OpenWebUI or direct vLLM /v1 traffic is grouped under chat/direct.",
  "等价 API 价值": "Equivalent API Value",
  "按官方公开价格估算，如果这些 token 调用 GPT 或 Claude 大概值多少钱。": "Estimated from public official pricing: what these tokens would roughly cost with GPT or Claude.",
  "模型": "Model",
  "输入/输出": "Input/Output",
  "标准等值": "Standard value",
  "含缓存等值": "Cached value",
  "价格按 2026-05-25 官方公开价估算；本地 vLLM 不会产生这些 API 费用，仅用于对比价值。": "Pricing is estimated from public official rates on 2026-05-25. Local vLLM does not incur these API fees; this is only for value comparison.",
  "性能细节": "Performance Details",
  "延迟、队列、KV cache、prefix cache 和启动阶段指标。": "Latency, queue, KV cache, prefix cache, and startup phase metrics.",
  "平均端到端": "Average end-to-end",
  "请求完成平均耗时": "Average request completion time",
  "平均首 token": "Average first token",
  "平均单输出 token": "Average per output token",
  "越低越快": "Lower is faster",
  "KV cache 容量": "KV cache capacity",
  "最大并发": "Maximum concurrency",
  "加载权重": "Load weights",
  "模型载入阶段": "Model loading phase",
  "首次启动主要耗时之一": "One of the main first-start costs",
  "graph pool 实占": "Graph pool actual",
  "采集源": "Collection source",
  "用户审计": "User Audit",
  "模型卸载或手动导出时生成本地完整 Markdown，对话正文需要审计密码后才会在浏览器中读取。": "A complete local Markdown export is generated when a model is unloaded or exported manually. Conversation text is read in the browser only after the audit password is provided.",
  "审计密码": "Audit password",
  "解锁审计后台": "Unlock audit backend",
  "首次使用会自动生成密码文件；路径会显示在上方状态里。这个页面只在密码通过后读取完整对话。": "A password file is generated on first use and shown above. This page reads complete conversations only after the password is accepted.",
  "运行日志": "Runtime Logs",
};

const UI_TRANSLATION_PATTERNS = [
  [/^(.+) 分$/u, "$1 pts"],
  [/^环境可用 · (.+)$/u, "Environment available · $1"],
  [/^(.+) · 更新 (.+)$/u, "$1 · Updated $2"],
  [/^下载 (.+)$/u, "Downloads $1"],
  [/^喜欢 (.+)$/u, "Likes $1"],
  [/^(.+) 输入 · (.+) 输出$/u, "$1 input · $2 output"],
  [/^(.+) 错误 · (.+) 中止$/u, "$1 errors · $2 aborted"],
  [/^(.+) 成功 · (.+) 错误$/u, "$1 success · $2 errors"],
  [/^(.+) 个 schema · (.+) 流式$/u, "$1 schemas · $2 streaming"],
  [/^(.+) 次 · 节省 tokens$/u, "$1 times · saved tokens"],
  [/^上下文：(.+)$/u, "Context: $1"],
  [/^活跃 KV：(.+)$/u, "Active KV: $1"],
  [/^启动：(.+)$/u, "Started: $1"],
  [/^容器：(.+)$/u, "Container: $1"],
  [/^(.+) 个请求$/u, "$1 requests"],
  [/^(.+) 请求$/u, "$1 requests"],
  [/^(.+) 上下文$/u, "$1 context"],
  [/^(.+) 并发$/u, "$1 concurrent"],
  [/^平均 (.+)$/u, "Avg $1"],
  [/^最近 (.+)$/u, "Recent $1"],
  [/^最后 (.+)$/u, "Last $1"],
  [/^生命周期 (.+)$/u, "Lifetime $1"],
  [/^平均输入 (.+)$/u, "Avg input $1"],
  [/^最大并发 (.+)$/u, "Max concurrency $1"],
  [/^审计目录：(.+)$/u, "Audit directory: $1"],
  [/^Open WebUI 容器：(.+) · 运行中$/u, "OpenWebUI container: $1 · running"],
  [/^密码文件：(.+)$/u, "Password file: $1"],
  [/^(.+) 个历史模型保留累计消耗$/u, "$1 historical model(s) retained cumulative usage"],
  [/^(.+) 个$/u, "$1"],
  [/^(.+)小时(.+)分$/u, "$1h $2m"],
  [/^(.+) 层 · KV heads (.+)$/u, "$1 layers · KV heads $2"],
  [/^(.+)：(.+) tokens \/ (.+) 请求$/u, "$1: $2 tokens / $3 requests"],
  [/^(.+)：(.+) saved$/u, "$1: $2 saved"],
  [/^自动清理 (.+) 次 · 最近 (.+)$/u, "Auto cleanup $1 times · recent $2"],
  [/^(.+) · 切换 (.+) 次$/u, "$1 · switched $2 times"],
];

const UI_PARTIAL_TRANSLATIONS = [
  [/中文/g, "Chinese"],
  [/截断/g, "truncated"],
  [/输入/g, "input"],
  [/输出/g, "output"],
  [/错误/g, "errors"],
  [/中止/g, "aborted"],
  [/成功/g, "success"],
  [/请求/g, "requests"],
];

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

function notify(title, detail = "", type = "info") {
  const root = $("#toastRoot");
  if (!root) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.innerHTML = `
    <div class="toast-icon" aria-hidden="true">${type === "error" ? "!" : type === "success" ? "✓" : "i"}</div>
    <div>
      <strong>${escapeHtml(title)}</strong>
      ${detail ? `<span>${escapeHtml(detail)}</span>` : ""}
    </div>
    <button type="button" class="toast-close" aria-label="关闭提示">×</button>
  `;
  root.appendChild(toast);
  const close = () => {
    toast.classList.add("toast-exit");
    window.setTimeout(() => toast.remove(), 180);
  };
  toast.querySelector(".toast-close").addEventListener("click", close);
  window.setTimeout(close, type === "error" ? 9000 : 4800);
}

function setButtonBusy(button, label = "处理中...") {
  if (!button) return () => {};
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.classList.add("is-busy");
  button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
  return () => {
    button.disabled = false;
    button.classList.remove("is-busy");
    button.innerHTML = originalHtml;
    renderIcons();
  };
}

function reportActionError(title, error) {
  // 只弹 toast，不要把无关错误写进「接口测试」结果框
  notify(title, error?.message || String(error || "未知错误"), "error");
}

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

// 量化精度不再用来拼仓库后缀（-AWQ/-FP8 这类仓库多半不存在）。
// base 直接下载原始仓库；其它精度引导到在线搜索按 quantFilter 找真实存在的量化仓库。
const PRECISION_PRESETS = [
  { value: "base", label: "原始 BF16/FP16", quantFilter: "", launchQuantization: "" },
  { value: "fp8", label: "FP8", quantFilter: "fp8", launchQuantization: "fp8" },
  { value: "awq", label: "AWQ INT4", quantFilter: "awq", launchQuantization: "awq" },
  { value: "gptq", label: "GPTQ INT4", quantFilter: "gptq", launchQuantization: "gptq" },
  { value: "nvfp4", label: "NVFP4", quantFilter: "nvfp4", launchQuantization: "modelopt_fp4" },
  { value: "int4", label: "INT4 / NF4", quantFilter: "int4", launchQuantization: "bitsandbytes" },
  { value: "gguf", label: "GGUF", quantFilter: "gguf", launchQuantization: "" },
];

const MODEL_PRESETS = [
  // Qwen3 稠密：单卡主力，覆盖从验证到 32B
  { developer: "Qwen", version: "Qwen3 稠密", spec: "0.6B", repo: "Qwen/Qwen3-0.6B", note: "极轻量，用于跑通流程和低显存验证。" },
  { developer: "Qwen", version: "Qwen3 稠密", spec: "1.7B", repo: "Qwen/Qwen3-1.7B", note: "小显存设备也能流畅运行。" },
  { developer: "Qwen", version: "Qwen3 稠密", spec: "4B", repo: "Qwen/Qwen3-4B", note: "单卡友好的日常中文模型。" },
  { developer: "Qwen", version: "Qwen3 稠密", spec: "8B", repo: "Qwen/Qwen3-8B", note: "质量与速度均衡，单卡通用首选。" },
  { developer: "Qwen", version: "Qwen3 稠密", spec: "14B", repo: "Qwen/Qwen3-14B", note: "更强推理，建议 24GB+ 或量化。" },
  { developer: "Qwen", version: "Qwen3 稠密", spec: "32B", repo: "Qwen/Qwen3-32B", note: "高质量稠密模型，建议大显存或量化。" },
  // Qwen3 MoE：激活参数少、吞吐高
  { developer: "Qwen", version: "Qwen3 MoE", spec: "30B-A3B", repo: "Qwen/Qwen3-30B-A3B", note: "激活仅 3B，吞吐高且质量接近 32B 稠密。" },
  { developer: "Qwen", version: "Qwen3 MoE", spec: "235B-A22B", repo: "Qwen/Qwen3-235B-A22B", note: "旗舰 MoE，需多卡或低比特量化。" },
  // Qwen3-VL：多模态
  { developer: "Qwen", version: "Qwen3-VL 多模态", spec: "8B", repo: "Qwen/Qwen3-VL-8B-Instruct", note: "图文理解，单卡可跑。" },
  { developer: "Qwen", version: "Qwen3-VL 多模态", spec: "30B-A3B", repo: "Qwen/Qwen3-VL-30B-A3B-Instruct", note: "MoE 多模态，吞吐高。" },
  // OpenAI gpt-oss：原生 MXFP4 开源权重
  { developer: "OpenAI", version: "gpt-oss", spec: "20B", repo: "openai/gpt-oss-20b", note: "原生 MXFP4 量化，单卡即可运行。" },
  { developer: "OpenAI", version: "gpt-oss", spec: "120B", repo: "openai/gpt-oss-120b", note: "大号开源权重，需多卡或大显存。" },
  // NVIDIA DiffusionGemma：需要 vLLM Gemma 专用镜像与 gemma4 parser
  { developer: "NVIDIA", version: "DiffusionGemma", spec: "26B-A4B IT", repo: "nvidia/diffusiongemma-26B-A4B-it-NVFP4", precision: "nvfp4", note: "NVFP4 多模态/扩散式 Gemma 架构；启动时管理器会自动切换 Gemma vLLM 镜像、V2 runner、TRITON_ATTN 与 gemma4 parser。" },
  // DeepSeek R1 蒸馏：强推理小模型
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "1.5B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B", note: "最小的强推理蒸馏模型。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "7B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", note: "单卡推理蒸馏小规格。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "14B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B", note: "推理更稳，显存需求更高。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "32B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", note: "蒸馏旗舰，建议多卡或量化。" },
  { developer: "DeepSeek", version: "R1 Distill Llama", spec: "8B", repo: "deepseek-ai/DeepSeek-R1-Distill-Llama-8B", note: "Llama 架构的推理蒸馏版。" },
  { developer: "DeepSeek", version: "R1 Distill Llama", spec: "70B", repo: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B", note: "高质量推理，需多卡或量化。" },
  // Meta Llama：英文/通用，多数需授权 token
  { developer: "Meta", version: "Llama 3.3", spec: "70B", repo: "meta-llama/Llama-3.3-70B-Instruct", note: "强英文/通用模型，需授权 token，建议多卡。" },
  { developer: "Meta", version: "Llama 3.1", spec: "8B", repo: "meta-llama/Llama-3.1-8B-Instruct", note: "单卡通用英文模型，需授权 token。" },
  // Google Gemma 3：轻量多语言，多数需授权 token
  { developer: "Google", version: "Gemma 3", spec: "1B", repo: "google/gemma-3-1b-it", note: "超轻量，需授权 token。" },
  { developer: "Google", version: "Gemma 3", spec: "4B", repo: "google/gemma-3-4b-it", note: "轻量多语言 instruction 模型。" },
  { developer: "Google", version: "Gemma 3", spec: "12B", repo: "google/gemma-3-12b-it", note: "单卡可跑的中端模型。" },
  { developer: "Google", version: "Gemma 3", spec: "27B", repo: "google/gemma-3-27b-it", note: "Gemma 旗舰，建议大显存或量化。" },
  // Mistral：欧洲通用模型
  { developer: "Mistral", version: "Small 3.2", spec: "24B", repo: "mistralai/Mistral-Small-3.2-24B-Instruct-2506", note: "中等规模通用模型，建议高显存。" },
];

const DTYPE_BYTES = {
  auto: 2,
  bfloat16: 2,
  float16: 2,
  float32: 4,
};

const KV_DTYPE_BYTES = {
  auto: null,
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
  wrench: "TOOL",
  "badge-check": "OK",
};

function enhanceUiArchitecture() {
  ensureServiceExposureUi();
  ensureModelPickerRunningTab();
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
    link.innerHTML = `<i data-lucide="globe-2"></i><span>${t("nav.exposure")}</span>`;
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
          <label class="check-row">
            <input id="exposureEnabled" name="enabled" type="checkbox" />
            <span>启用服务化配置</span>
          </label>
          <label>
            <span>开放方式</span>
            <select id="exposureMode" name="exposureMode">
              <option value="local">仅本机客户端</option>
              <option value="lan">局域网服务</option>
              <option value="reverse-proxy">公网/反向代理</option>
            </select>
          </label>
          <label class="check-row">
            <input id="exposureRequireApiKey" name="requireApiKey" type="checkbox" />
            <span>对外访问必须使用 API Key</span>
          </label>
          <label>
            <span>API Key</span>
            <div class="inline-input-action">
              <input id="exposureApiKey" name="apiKey" type="password" autocomplete="off" placeholder="留空表示保持现有密钥" />
              <button class="ghost-mini-button" id="generateExposureApiKey" type="button">生成</button>
            </div>
            <small id="exposureApiKeyState">未保存密钥</small>
          </label>
          <label class="check-row">
            <input id="exposureClearApiKey" name="clearApiKey" type="checkbox" />
            <span>清除已保存 API Key</span>
          </label>
          <label>
            <span>公网 Base URL</span>
            <input id="exposurePublicBaseUrl" name="publicBaseUrl" placeholder="https://llm.example.com" />
          </label>
          <label>
            <span>每分钟请求上限</span>
            <input id="exposureRateLimitRpm" name="rateLimitRpm" type="number" min="1" max="5000" value="120" />
          </label>
          <label>
            <span>最大并发请求</span>
            <input id="exposureMaxConcurrentRequests" name="maxConcurrentRequests" type="number" min="1" max="256" value="4" />
          </label>
          <label>
            <span>请求超时秒数</span>
            <input id="exposureRequestTimeoutSeconds" name="requestTimeoutSeconds" type="number" min="10" max="7200" value="600" />
          </label>
          <label class="wide-field">
            <span>允许来源 / 客户端备注</span>
            <textarea id="exposureAllowedOrigins" name="allowedOrigins" rows="3" placeholder="每行一个域名、IP 或客户端名称"></textarea>
          </label>
          <div class="exposure-toggle-grid wide-field">
            <label class="check-row"><input id="exposureOpenAI" name="exposeOpenAI" type="checkbox" /><span>OpenAI 兼容接口</span></label>
            <label class="check-row"><input id="exposureClaude" name="exposeClaude" type="checkbox" /><span>Claude 兼容桥</span></label>
            <label class="check-row"><input id="exposureOpenCode" name="exposeOpenCode" type="checkbox" /><span>OpenCode 代理</span></label>
            <label class="check-row"><input id="exposureMetrics" name="exposeMetrics" type="checkbox" /><span>暴露 metrics</span></label>
            <label class="check-row"><input id="exposureAllowManagerRemote" name="allowManagerRemote" type="checkbox" /><span>允许远程管理器桥接</span></label>
          </div>
          <label class="wide-field">
            <span>运维备注</span>
            <textarea id="exposureNotes" name="notes" rows="3" placeholder="服务对象、端口、防火墙、反代、密钥轮换计划等"></textarea>
          </label>
        </div>
        <div class="form-note">
          局域网或公网服务建议同时使用 API Key、固定模型别名、日志统计和反向代理限流。保存后如需生效到容器，请点“应用到启动表单”并重启模型。
        </div>
      </form>
      <div class="panel exposure-status-panel">
        <div class="panel-head">
          <h3>当前入口</h3>
        </div>
        <div class="exposure-endpoints" id="serviceExposureEndpoints">
          <div class="empty compact">正在读取服务入口...</div>
        </div>
      </div>
      <div class="panel exposure-check-panel">
        <div class="panel-head">
          <h3>上线前检查</h3>
        </div>
        <div class="exposure-checks" id="serviceExposureChecks">
          <div class="empty compact">正在生成检查项...</div>
        </div>
      </div>
      <div class="panel exposure-clients-panel">
        <div class="panel-head">
          <div>
            <h3>客户端 API Key</h3>
            <p>给 OpenWebUI、Claude、OpenCode 或局域网设备单独发 Key，并限制模型、速率和并发。</p>
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

function scheduleDownloadEstimate() {
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
    return;
  }
  if (source !== "huggingface") {
    box.hidden = false;
    box.dataset.state = "info";
    textEl.textContent = "ModelScope 暂不支持下载体积预估，下载时会显示实际进度。";
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
      textEl.textContent = "无法读取该仓库的文件体积（可能是 gated 或私有），下载时会显示实际进度。"
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
  renderQuantFinder(null, getSelectedPrecision());
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
  const result = await api(`/api/remote-models?${params}`);
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
    list.innerHTML = `<div class="empty compact">${escapeHtml(t("modelPicker.empty"))}</div>`;
    return;
  }

  list.innerHTML = items.slice(0, 80).map(renderModelPickerItem).join("");
  renderIcons();
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
  const badges = (item.badges || []).slice(0, 8).map((badge) => {
    const className = item.favorite && badge === t("modelPicker.favorite") ? "favorite" : "";
    return `<span class="${className}">${escapeHtml(badge)}</span>`;
  }).join("");
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
  const headroomGb = Math.max(2, modelGb * 0.22);
  const peerSuffix = state.status?.resources?.hasPeerRunning ? "·已扣占用" : "";
  if (modelGb + headroomGb <= maxFreeGb) return { label: `单卡可跑${peerSuffix}`, state: "ok" };
  if (selected.length > 1 && modelGb + headroomGb <= totalFreeGb * 0.82) return { label: `需多卡${peerSuffix}`, state: "warn" };
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
  const status = state.status;
  $("#dockerStatus").textContent = status.docker.ok ? "可用" : "异常";
  setMetricState("dockerStatus", status.docker.ok ? "ok" : "fail");
  if (status.gpu.ok) {
    const gpuLabel = status.gpu.count > 1 ? `${status.gpu.count} 张 GPU` : status.gpu.name;
    $("#gpuStatus").textContent = `${gpuLabel} · ${status.gpu.usedMb}/${status.gpu.totalMb} MB`;
    setMetricState("gpuStatus", status.gpu.util > 90 ? "warn" : "ok");
    $("#subtitle").textContent = `vLLM / Docker / ${gpuLabel}`;
  } else {
    $("#gpuStatus").textContent = "未检测到";
    setMetricState("gpuStatus", "warn");
    $("#subtitle").textContent = "vLLM / Docker";
  }
  if (status.container.running) {
    $("#serviceStatus").textContent = status.container.status || "运行中";
    setMetricState("serviceStatus", "ok");
  } else if (status.container.exists) {
    $("#serviceStatus").textContent = status.container.status || "已停止";
    setMetricState("serviceStatus", "warn");
  } else {
    $("#serviceStatus").textContent = "未启动";
    setMetricState("serviceStatus", "warn");
  }
  const served = status.servedModels || [];
  $("#servedModel").textContent = served.length ? served.map((item) => item.id).join(", ") : "-";
  setMetricState("servedModel", served.length ? "ok" : "warn");
  if (served[0]) $("#testModel").value = served[0].id;
  if (status.endpoint?.port) {
    $("#apiDocsLink").href = `http://127.0.0.1:${status.endpoint.port}/docs`;
  }
  renderRunningModels();
  renderGpuPicker();
  updateMemoryEstimate();
}

function setMetricState(strongId, stateName) {
  const metric = $(`#${strongId}`)?.closest(".metric");
  if (metric) metric.dataset.state = stateName;
}

function renderStatusInsights() {
  if (!$("#vramStatus")) return;
  const gpu = state.status?.gpu || {};
  if (gpu.ok && gpu.totalMb) {
    const usedPct = (Number(gpu.usedMb || 0) / Number(gpu.totalMb || 1)) * 100;
    $("#vramStatus").textContent = `${usedPct.toFixed(1)}% · ${fmtBytes(Number(gpu.usedMb || 0) * 1024 ** 2)} / ${fmtBytes(Number(gpu.totalMb || 0) * 1024 ** 2)}`;
    setMetricState("vramStatus", usedPct > 92 ? "warn" : "ok");
  } else {
    $("#vramStatus").textContent = "-";
    setMetricState("vramStatus", "warn");
  }

  const model = (state.status?.runningModels || [])[0] || {};
  const contextCapacity = model.contextCapacityTokens || model.maxModelLen || 0;
  const contextUsed = model.contextUsedTokens || model.contextUsed || 0;
  if (contextCapacity) {
    const pct = contextUsed ? (contextUsed / contextCapacity) * 100 : 0;
    $("#contextStatus").textContent = `${fmtTokens(contextUsed)} / ${fmtTokens(contextCapacity)} · ${pct.toFixed(1)}%`;
    setMetricState("contextStatus", pct > 85 ? "warn" : "ok");
  } else {
    $("#contextStatus").textContent = state.status?.container?.running ? "等待指标" : "-";
    setMetricState("contextStatus", state.status?.container?.running ? "warn" : "warn");
  }

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
          <span>${fmtTokens(profile.config?.maxNumSeqs || 0)} 并发</span>
          <span>${escapeHtml(profile.config?.kvCacheDtype || "auto")} KV</span>
          <span>${escapeHtml(profile.config?.clientPreset || "generic")}</span>
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
    cfg.clientPreset || "",
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
    <div class="client-session-list">
      ${(data.sessions || []).slice(0, 6).map((item) => `<span>${escapeHtml(item.label || item.id)}：${fmtTokens(item.compression?.savedTokens || 0)} saved</span>`).join("")}
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
        当前没有运行中的 vLLM 模型。启动模型后，这里会显示服务名、API 地址和卸载按钮。
      </div>
    `;
    renderRuntimeFacts();
    renderIcons();
    return;
  }

  if (!models.length) {
    root.innerHTML = `
      <div class="running-model-row">
        <div>
          <h4>vLLM 容器正在运行</h4>
          <p>API 还没有返回模型列表，可能仍在加载权重、编译或 warmup。</p>
          <div class="running-meta">
            <span>容器：${escapeHtml(status.container.name || "vllm-local")}</span>
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
    renderRuntimeFacts(status);
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
            ${status.apiKeyRequired ? `<span class="pill warn" title="该服务已启用 API Key，客户端需要以 Bearer Token 方式携带">API Key 已启用</span>` : ""}
          </div>
          ${renderRunningSpeed(model)}
          ${renderRunningKvBar(model)}
        </div>
        <button class="job-action-button danger" data-running-action="unload-model" data-model="${escapeAttr(model.id || "")}" title="停止 vLLM 容器并释放显存">
          <i data-lucide="trash-2"></i><span>卸载</span>
        </button>
      </div>
    `;
  }).join("");
  injectRunningContextBadges(root, models);
  renderRuntimeFacts(status);
  const testModel = $("#testModel");
  if (testModel && testModel.dataset.userEdited !== "true" && models[0]?.id && testModel.value !== models[0].id) {
    testModel.value = models[0].id;
  }
  renderIcons();
}

function renderRuntimeFacts(status = state.status) {
  window.VllmRuntimeInsights?.renderRuntimeFacts(status, {
    formatContextUsage,
    fmtTokens,
    escapeHtml,
  });
}

function renderCompatEndpoints(endpoint) {
  const openai = endpoint.compat?.openai || {};
  const claude = endpoint.compat?.claude || {};
  const modelAlias = claude.modelAlias || "claude-opus-4-7";
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
        <span>Base URL 用 ${escapeHtml(claude.baseUrl || "-")}；模型名用 ${escapeHtml(modelAlias)}</span>
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

// 运行中模型的平均输出速度：以「启动以来的活跃时间」为基准（累计生成 token ÷ 实际生成耗时），
// 不受空闲时间稀释。实时速度和并发作为次要信息。
function renderRunningSpeed(model) {
  const lifetime = Number(model.lifetimeOutputTokensPerSecond || 0);
  const activeSeconds = Number(model.activeSeconds || 0);
  const recent = Number(model.recentOutputTokensPerSecond || 0);
  const running = Number(model.runningRequests || 0);
  const waiting = Number(model.waitingRequests || 0);
  const outputTokens = Number(model.outputTokens || 0);
  // 完全没产生过输出时不显示速度
  if (!lifetime && !recent && !running && !waiting && !outputTokens) {
    return `<div class="running-speed idle"><div class="running-speed-main"><span>启动以来平均速度</span><strong>等待首个请求</strong></div><div class="running-speed-meta"><span>产生输出后会显示活跃时间内的平均 tok/s</span></div></div>`;
  }
  const liveClass = running > 0 ? "active" : "";
  const metaParts = [];
  if (outputTokens) {
    metaParts.push(`累计输出 ${fmtTokens(outputTokens)} tokens`);
  }
  if (activeSeconds > 0) {
    metaParts.push(`活跃约 ${formatDuration(activeSeconds)}`);
  }
  if (recent > 0) {
    metaParts.push(`实时 ${fmtRate(recent, " tok/s")}`);
  }
  metaParts.push(`<span class="running-activity ${liveClass}">${fmtNumber(running)} 进行中 · ${fmtNumber(waiting)} 排队</span>`);
  return `
    <div class="running-speed">
      <div class="running-speed-main">
        <span title="累计生成 token ÷ 实际生成耗时，覆盖整个启动周期，不含空闲等待">启动以来平均速度（活跃时间）</span>
        <strong>${escapeHtml(lifetime ? fmtRate(lifetime, " tok/s") : "-")}</strong>
      </div>
      <div class="running-speed-meta">${metaParts.join("<span class=\"dot-sep\">·</span>")}</div>
    </div>
  `;
}

// 运行中模型的实时 KV cache 占用条：数据来自 vLLM /metrics 经 /api/status 透出
function renderRunningKvBar(model) {
  const percent = Number(model.contextUsagePercent || 0);
  const used = Number(model.contextUsedTokens || 0);
  const capacity = Number(model.contextCapacityTokens || 0);
  if (!capacity && !used && !percent) return "";
  const pct = Math.min(100, Math.max(0, percent));
  const stateClass = pct > 90 ? "fail" : pct > 70 ? "warn" : "ok";
  const label = capacity
    ? `${fmtTokens(used)} / ${fmtTokens(capacity)} tokens · ${fmtPct(percent)}`
    : `${fmtTokens(used)} tokens · ${fmtPct(percent)}`;
  return `
    <div class="kv-usage">
      <div class="kv-usage-head"><span>实时 KV cache 占用</span><span>${escapeHtml(label)}</span></div>
      <div class="kv-usage-track"><div class="kv-usage-fill ${stateClass}" style="width:${pct}%"></div></div>
    </div>
  `;
}

function renderGpuPicker() {
  const root = $("#gpuPicker");
  const gpus = getVisibleGpus();
  if (!root) return;
  if (!gpus.length) {
    root.innerHTML = `<div class="empty compact">未检测到 NVIDIA GPU；启动时会保留 Docker 默认 GPU 设置。</div>`;
    state.gpuSignature = "";
    renderVllmGpuPlan();
    updateMemoryEstimate();
    return;
  }

  const signature = gpus.map((gpu) => `${gpu.id}:${gpu.name}:${gpu.totalMb}`).join("|");
  if (!state.gpuSelectionTouched && !state.selectedGpuIds.size) {
    state.selectedGpuIds = new Set([gpus[0].id]);
  }
  if (state.gpuSignature === signature && root.querySelector("[name='gpuDeviceIds']")) {
    renderVllmGpuPlan();
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
  renderVllmGpuPlan();
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
  const selected = getSelectedGpuObjects().map(normalizeVllmGpu);
  const mode = $("#multiGpuMode")?.value || "single";
  const hetero = isVllmHeterogeneous(selected);
  const count = Math.max(1, selected.length);
  const primary = selected[0] || null;
  const primaryLabel = primary ? shortGpuLabel(primary.name, primary.id) : "当前 GPU";
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

function normalizeVllmGpu(gpu) {
  const totalMb = Number(gpu.totalMb || 0);
  const usedMb = Number(gpu.usedMb || 0);
  const freeMb = Math.max(0, totalMb - usedMb);
  const utilization = Math.min(0.98, Math.max(0.1, Number($("#gpuMemoryUtilization")?.value || 0.9)));
  return {
    ...gpu,
    id: String(gpu.id ?? gpu.index ?? "0"),
    totalGb: totalMb / 1024,
    usedGb: usedMb / 1024,
    freeGb: freeMb / 1024,
    usableGb: Math.max(0, Math.min(totalMb * utilization, freeMb - 1024) / 1024),
    generation: inferGpuGeneration(gpu.name),
  };
}

function isVllmHeterogeneous(gpus) {
  if (gpus.length < 2) return false;
  const totals = gpus.map((gpu) => Number(gpu.totalGb || 0));
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  if (min && max / min > 1.2) return true;
  const names = new Set(gpus.map((gpu) => String(gpu.name || "").replace(/\s+/g, " ").toLowerCase()));
  return names.size > 1;
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
  const selectedGpus = getSelectedGpuObjects().map(normalizeVllmGpu);
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
    $("#exposureOpenCode").checked = settings.exposeOpenCode !== false;
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
  const servicePort = Number(service.port || state.config?.defaultPort || 8000);
  const plannedOpenAiLan = selectedMode === "lan" && !service.openAiLanBaseUrl
    ? `http://${lanAddress}:${servicePort}/v1`
    : "";
  const publicOpenAi = settings.publicBaseUrl ? `${settings.publicBaseUrl.replace(/\/$/, "")}/serve/v1` : "";
  root.innerHTML = `
    ${exposureEndpointCard("OpenAI 网关（推荐）", service.openAiGatewayLocalBaseUrl || "-", "鉴权、限流、并发和超时都在这里执行；模型名可用 local-current")}
    ${service.openAiGatewayLanBaseUrl ? exposureEndpointCard("OpenAI 网关局域网", service.openAiGatewayLanBaseUrl, "局域网设备优先使用这个地址") : ""}
    ${publicOpenAi ? exposureEndpointCard("OpenAI 网关公网", publicOpenAi, "反向代理后提供给外部客户端") : ""}
    ${exposureEndpointCard("OpenAI 直连容器", service.openAiLocalBaseUrl || "-", "本机调试用；不经过管理器网关限流")}
    ${service.openAiLanBaseUrl ? exposureEndpointCard("OpenAI 容器局域网", service.openAiLanBaseUrl, `Docker 已把容器端口转发到 ${service.lanHost || "本机局域网 IP"}；直连容器端口，外部使用前需确认容器自身鉴权`) : ""}
    ${plannedOpenAiLan ? exposureEndpointCard("OpenAI 容器局域网（下次启动）", plannedOpenAiLan, "保存并按局域网模式启动/重启模型后，Docker 会把容器端口转发到这个本机 IP。") : ""}
    ${settings.exposeClaude !== false ? exposureEndpointCard("Claude 桥", service.claudeLocalMessagesUrl || "-", "Claude Desktop / Cowork / Claude Code") : ""}
    ${settings.exposeOpenCode !== false ? exposureEndpointCard("OpenCode", service.openCodeBaseUrl || "-", "模型名可用 local-current") : ""}
    ${exposureEndpointCard("Manager", manager.localBaseUrl || "-", manager.remoteManagementAllowed ? "管理器允许远程访问" : "管理器仅建议本机访问")}
    <div class="exposure-runtime-summary">
      <span>状态：${escapeHtml(service.running ? service.containerStatus || "运行中" : "未运行")}</span>
      <span>模型：${escapeHtml((service.modelIds || []).join(", ") || "-")}</span>
      <span>上下文：${service.maxModelLen ? fmtTokens(service.maxModelLen) : "-"}</span>
      <span>客户端 Key：${fmtTokens(service.clients?.active || 0)} / ${fmtTokens(service.clients?.total || 0)}</span>
      <span>API Key：${service.apiKeyRequired ? "运行中已启用" : "运行中未启用"}</span>
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
  const liveModelCount = stats.live?.models?.length || state.status?.runningModels?.length || 0;
  const historicalModelCount = Math.max(0, (stats.models || []).length - liveModelCount);
  const errorRate = requests.total ? (Number(requests.error || 0) + Number(requests.aborted || 0)) / requests.total : 0;
  const cacheHit = tokens.prompt ? Number(tokens.cachedPrompt || 0) / tokens.prompt : 0;

  accumulateStatsSample(stats);

  $("#statsSummary").innerHTML = [
    statsMetric("累计 tokens", fmtTokens(tokens.total), `${fmtTokens(tokens.prompt)} 输入 · ${fmtTokens(tokens.generation)} 输出`, "stats-metric-hero"),
    statsMetric("请求数", fmtTokens(requests.total), `${fmtTokens(requests.success)} 成功 · ${fmtTokens(requests.error)} 错误 · ${fmtTokens(requests.aborted)} 中止`),
    statsMetric("当前实例", `${fmtTokens(liveModelCount)} 个`, `${fmtTokens(historicalModelCount)} 个历史模型保留累计消耗`),
    statsMetric("当前输出速度", fmtRate(speed.recentOutputTokensPerSecond, " tok/s"), `${fmtRate(speed.recentPromptTokensPerSecond, " in/s")} · ${fmtRate(speed.recentRequestsPerMinute, " req/min")}`),
    statsMetric("平均延迟", fmtSeconds(latency.avgE2eSeconds), `TTFT ${fmtSeconds(latency.avgTtftSeconds)}`),
    statsMetric("活跃 KV cache", formatContextUsage(context.activeTokens, context.capacityTokens, context.kvUsagePercent), "只表示当前正在推理的请求；聊天历史在 Open WebUI 侧保存"),
    statsMetric("Prefix cache 命中", fmtPct(cacheHit), `${fmtTokens(tokens.cachedPrompt || 0)} / ${fmtTokens(tokens.prompt)} 输入 token 命中`),
    statsMetric("运行时长", stats.uptimeSeconds ? formatDuration(stats.uptimeSeconds) : "-", `生命周期 ${fmtRate(speed.lifetimeTokensPerSecond, " tok/s")}`),
  ].join("");

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
      statsMetric("外部请求", fmtTokens(externalRequests.total || 0), `${fmtTokens(externalRequests.success || 0)} 成功 · ${fmtTokens(externalRequests.error || 0)} 错误`, "stats-metric-hero"),
      statsMetric("外部客户端", fmtTokens(externalClients.unique || 0), `${fmtPct(externalShare)} 来自非本机地址`),
      statsMetric("错误率", fmtPct(externalRequests.errorRate || 0), `${fmtTokens(externalRequests.authFailures || 0)} 鉴权失败 · ${fmtTokens(externalRequests.rateLimited || 0)} 限流`),
      statsMetric("平均延迟", fmtMs(externalLatency.avgMs || 0), `P50 ${fmtMs(externalLatency.p50Ms || 0)} · P95 ${fmtMs(externalLatency.p95Ms || 0)} · Max ${fmtMs(externalLatency.maxMs || 0)}`),
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
  if (privacy) {
    privacy.innerHTML = `<i data-lucide="shield-check"></i><span>${escapeHtml(data.privacy || "只展示访问元数据，不展示聊天正文。")}</span>`;
  }

  renderExternalEndpoints(service);
  renderExternalWindows(external.windows || {});
  renderExternalClients(data.clients || [], externalRequests.total || 0);
  renderExternalCompactList("#externalAccessPaths", data.paths || [], totalRequests.total || 0, "暂无路径访问记录。", renderExternalPathDetail);
  renderExternalModels(data);
  renderExternalCompactList("#externalAccessAuth", data.authSources || [], totalRequests.total || 0, "暂无认证字段记录。", renderExternalAuthDetail);
  renderExternalCompactList("#externalAccessStatuses", data.statuses || [], totalRequests.total || 0, "暂无状态码记录。", renderExternalStatusDetail);
  renderExternalTimeline(data.timeline || []);
  renderExternalRecent(data.recent || []);
  renderIcons();
}

function renderExternalEndpoints(service = {}) {
  const root = $("#externalAccessEndpoints");
  if (!root) return;
  const apiKeyLabel = service.requireApiKey ? "需要 API Key" : "未强制 API Key";
  const runningLabel = service.running ? "模型服务运行中" : "模型服务未运行";
  const cards = [
    renderExternalEndpointCard("Claude 兼容入口", service.claudeBaseUrl || "-", "给 Claude Desktop / CC Switch 使用，客户端再拼 /v1/messages。", service.running ? "ok" : "warn"),
    renderExternalEndpointCard("OpenAI 兼容入口", service.openAiGatewayBaseUrl || "-", "给 OpenWebUI、OpenCode 或 OpenAI SDK 使用，路径为 /v1/chat/completions。", service.running ? "ok" : "warn"),
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
  const rows = [
    ["m5", "最近 5 分钟"],
    ["m15", "最近 15 分钟"],
    ["h1", "最近 1 小时"],
    ["h24", "最近 24 小时"],
  ];
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
  const topModel = formatAccessCounterPair(client.topModel);
  const topPath = formatAccessCounterPair(client.topPath);
  const topAuth = formatAccessCounterPair(client.topAuthSource);
  return `
    <article class="stats-model-row external-client-row">
      <div>
        <h4>
          <span>${escapeHtml(client.key || "unknown")}</span>
          <em class="status-pill ${stateName}">${escapeHtml(stateName === "ok" ? "正常" : stateName === "warn" ? "注意" : "错误")}</em>
        </h4>
        <p>首次 ${escapeHtml(client.firstAt ? formatDateTime(client.firstAt) : "-")} · 最后 ${escapeHtml(client.lastAt ? formatDateTime(client.lastAt) : "-")}</p>
        <div class="stats-row-grid">
          ${miniStat("请求", fmtTokens(client.count || 0), `${fmtTokens(client.success || 0)} 成功 · ${fmtTokens(client.error || 0)} 错误`)}
          ${miniStat("错误率", fmtPct(client.errorRate || 0), `状态 ${topStatusLabel(client.topStatus)}`)}
          ${miniStat("延迟", fmtMs(client.avgDurationMs || 0), `Max ${fmtMs(client.maxDurationMs || 0)}`)}
          ${miniStat("Tokens", fmtTokens(client.totalTokens || 0), `${fmtTokens(client.inputTokens || 0)} 输入 · ${fmtTokens(client.outputTokens || 0)} 输出`)}
          ${miniStat("常用路径", topPath, "按请求数排序")}
          ${miniStat("请求模型", topModel, "客户端传入的 model")}
          ${miniStat("认证字段", topAuth, "实际命中的 Header")}
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
  root.innerHTML = items.map((item) => {
    const share = totalRequests ? Number(item.count || 0) / totalRequests : 0;
    const stateName = item.errorRate >= 0.2 ? "fail" : item.errorRate > 0 ? "warn" : "ok";
    return `
      <div class="external-compact-row">
        <div>
          <strong>${escapeHtml(item.key || "-")}</strong>
          <span>${escapeHtml(detailFn ? detailFn(item) : `${fmtTokens(item.success || 0)} 成功 · ${fmtTokens(item.error || 0)} 错误`)}</span>
          ${shareBar("占比", share)}
        </div>
        <em class="status-pill ${stateName}">${fmtTokens(item.count || 0)}</em>
      </div>
    `;
  }).join("");
}

function renderExternalModels(data = {}) {
  const root = $("#externalAccessModels");
  if (!root) return;
  const requested = data.models || [];
  const resolved = data.resolvedModels || [];
  if (!requested.length && !resolved.length) {
    root.innerHTML = `<div class="empty compact">暂无模型调用记录。</div>`;
    return;
  }
  const total = data.totals?.requests?.total || 0;
  root.innerHTML = `
    ${requested.length ? `<div class="external-list-heading">请求模型名</div>${renderExternalCompactRows(requested, total, renderExternalModelDetail)}` : ""}
    ${resolved.length ? `<div class="external-list-heading">实际解析模型</div>${renderExternalCompactRows(resolved, total, renderExternalModelDetail)}` : ""}
  `;
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

function renderExternalTimeline(timeline) {
  const root = $("#externalAccessTimeline");
  if (!root) return;
  const hasData = timeline.some((item) => Number(item.total || 0) > 0);
  if (!hasData) {
    root.innerHTML = `<div class="empty compact">近 2 小时暂无外部请求。</div>`;
    return;
  }
  const cards = [
    { label: "请求数", key: "total", color: "var(--blue)", fmt: (v) => fmtTokens(v), detail: "每 5 分钟" },
    { label: "错误数", key: "error", color: "var(--red)", fmt: (v) => fmtTokens(v), detail: "非 2xx/3xx" },
    { label: "Tokens", key: "totalTokens", color: "var(--teal)", fmt: (v) => fmtTokens(v), detail: "输入 + 输出" },
    { label: "平均延迟", key: "avgDurationMs", color: "var(--amber)", fmt: (v) => fmtMs(v), detail: "每桶平均" },
  ];
  root.innerHTML = cards.map((card) => {
    const values = timeline.map((item) => Number(item[card.key] || 0));
    const current = values.at(-1) || 0;
    const peak = Math.max(...values);
    return `
      <div class="trend-card">
        <div class="trend-head">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.fmt(current))}</strong>
        </div>
        ${sparkline(values, { color: card.color })}
        <div class="trend-foot"><span>${escapeHtml(card.detail)}</span><span>峰值 ${escapeHtml(card.fmt(peak))}</span></div>
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
    const modelText = event.model && event.resolvedModel && event.model !== event.resolvedModel
      ? `${event.model} → ${event.resolvedModel}`
      : event.model || event.resolvedModel || "-";
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

function statsMetric(label, value, detail, className = "") {
  return `
    <div class="stats-metric ${escapeAttr(className)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail || "")}</small>
    </div>
  `;
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
    const liveContext = Boolean(model.context?.capacityTokens);
    const rowClass = liveContext ? "is-live" : "is-inactive";
    const stateLabel = liveContext ? "运行中" : "历史累计";
    return `
      <article class="stats-model-row ${rowClass}">
        <div>
          <h4><span>${escapeHtml(model.name)}</span><em class="runtime-state">${stateLabel}</em></h4>
          <p>${escapeHtml(model.root || "vLLM model")}</p>
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
  const tokens = client.tokens || {};
  const requests = client.requests || {};
  const tools = client.tools || {};
  const compression = client.compression || {};
  const latency = client.latency || {};
  const share = client.share || {};
  const last = client.last || {};
  const modelLine = renderClientModelLine(client);
  const sessionLine = renderClientSessionLine(client);
  return `
    <article class="stats-model-row">
      <div>
        <h4>${escapeHtml(client.label || client.id || "-")}</h4>
        <p>${escapeHtml(client.description || "")}</p>
        <div class="stats-row-grid">
          ${miniStat("Tokens", fmtTokens(tokens.total), `${fmtTokens(tokens.prompt)} 输入 · ${fmtTokens(tokens.generation)} 输出`)}
          ${miniStat("请求", fmtTokens(requests.total), `${fmtTokens(requests.success)} 成功 · ${fmtTokens(requests.error)} 错误`)}
          ${miniStat("工具", fmtTokens(tools.toolUse), `${fmtTokens(tools.schemas)} 个 schema · ${fmtTokens(requests.streamed)} 流式`)}
          ${miniStat("上下文压缩", fmtTokens(compression.savedTokens || 0), `${fmtTokens(compression.applied || 0)} 次 · 节省 tokens`)}
          ${miniStat("平均耗时", fmtMs(latency.avgMs), last.at ? `最后 ${formatDateTime(last.at)}` : "暂无最后调用")}
        </div>
        ${sessionLine}
        ${modelLine}
        ${shareBar("tokens", share.tokens || 0)}
        ${shareBar("requests", share.requests || 0)}
      </div>
    </article>
  `;
}

function renderClientSessionLine(client) {
  const session = client.session || {};
  const sessions = Array.isArray(client.sessions) ? client.sessions : [];
  if (!session.currentId && !sessions.length) return "";
  const currentId = String(session.currentId || "");
  const shortId = currentId.replace(/^claude-/, "").slice(0, 12) || "-";
  const current = sessions.find((item) => item.id === currentId) || sessions[0] || {};
  const recent = sessions.slice(0, 4);
  const detail = session.contextClearedAt
    ? `自动清理 ${fmtTokens(session.resets || 0)} 次 · 最近 ${formatDateTime(session.contextClearedAt)}`
    : "等待 Claude 任务请求";
  return `
    <div class="client-session-panel">
      <div>
        <span>Claude 当前任务</span>
        <strong>${escapeHtml(current.label || session.currentLabel || shortId)}</strong>
        <small>${escapeHtml(`session ${shortId} · ${session.currentSource || current.source || "auto"} · 切换 ${fmtTokens(session.switches || 0)} 次`)}</small>
        <small>${escapeHtml(detail)}</small>
      </div>
      ${recent.length ? `
        <div class="client-session-list">
          ${recent.map((item) => `
            <span>${escapeHtml(item.label || item.id || "Claude task")}：${fmtTokens(item.tokens?.total || 0)} tokens / ${fmtTokens(item.requests?.total || 0)} 请求</span>
          `).join("")}
        </div>
      ` : ""}
    </div>
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
      价格按 ${escapeHtml(stats.pricingAsOf || "current")} 官方公开价估算；本地 vLLM 不会产生这些 API 费用，仅用于对比价值。
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
          ${model.ggufFiles?.[0] ? `<span class="pill">${escapeHtml(model.ggufFiles[0].name || "single file")}</span>` : ""}
        </div>
      </div>
      <div class="mini-actions">
        <button title="填入启动表单" data-action="use-model" data-model="${escapeAttr(model.launchModel)}" data-name="${escapeAttr(model.label)}" data-format="${model.hasGguf && !model.hasConfig ? "gguf" : "auto"}"><i data-lucide="play"></i></button>
        ${model.kind === "local" ? `<button class="danger" title="删除本地模型文件" data-action="delete-model" data-name="${escapeAttr(model.id)}" data-size="${escapeAttr(fmtBytes(model.size))}"><i data-lucide="trash-2"></i></button>` : ""}
      </div>
    </article>
  `).join("");
  root.querySelectorAll("[data-action='use-model']").forEach((button) => {
    button.addEventListener("click", () => {
      const model = button.dataset.model;
      selectLaunchModel(model, {
        name: button.dataset.name || model,
        format: button.dataset.format || "auto",
        silent: true,
      });
    });
  });
  root.querySelectorAll("[data-action='delete-model']").forEach((button) => {
    button.addEventListener("click", async () => {
      const name = button.dataset.name || "";
      const ok = window.confirm(`删除本地模型 ${name}（${button.dataset.size || "未知大小"}）？\n会从磁盘移除整个目录，无法恢复；正在运行的服务不会自动停止。`);
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
    const sortFilter = $("#remoteSort")?.selectedOptions?.[0]?.textContent?.replace(/^[^一-龥A-Za-z]+/, "") || "热度趋势";
    const taskFilter = $("#remoteTask")?.selectedOptions?.[0]?.textContent || "全部类型";
    const featureFilter = $("#remoteFeature")?.value && $("#remoteFeature")?.value !== "all"
      ? `· ${$("#remoteFeature").selectedOptions[0].textContent}`
      : "";
    const sizeFilter = $("#remoteSizeFilter")?.selectedOptions?.[0]?.textContent || "全部规模";
    hint.textContent = `按「${sortFilter}」排序 · ${taskFilter} · ${sizeFilter} ${featureFilter} · 返回 ${fmtNumber(state.remoteModels.length)} 个，显示 ${fmtNumber(models.length)} 个。参数和文件大小按公开元数据估算，gated 模型下载前需配置 token。`;
  }
  $("#remoteLoadMoreBtn")?.toggleAttribute("disabled", getRemoteLimit() >= 120);
  if (!models.length) {
    root.innerHTML = `<div class="empty">没有找到匹配的在线模型。换个关键词再试。</div>`;
    return;
  }
  root.innerHTML = models.map((model) => {
    const badges = (model.badges || []).slice(0, 7).map((badge) => `<span class="pill">${escapeHtml(badge)}</span>`).join("");
    const gated = model.gated ? `<span class="pill warn">gated</span>` : "";
    const runnableOk = effectiveLanguage() === "en-US" ? "vLLM runnable" : "vLLM 可运行";
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
          <div class="remote-readme" data-readme-for="${escapeAttr(model.id)}" hidden></div>
        </div>
        <div class="remote-actions">
          <button title="填入下载页" data-action="remote-download" data-model="${escapeAttr(model.id)}" data-output="${escapeAttr(model.outputName)}"><i data-lucide="download"></i></button>
          <button title="填入启动表单" data-action="remote-start" data-model="${escapeAttr(model.id)}"><i data-lucide="play"></i></button>
          ${model.source !== "modelscope" ? `<button title="查看模型说明" data-action="remote-readme" data-model="${escapeAttr(model.id)}"><i data-lucide="file-text"></i></button>` : ""}
          <a title="打开介绍页" href="${escapeAttr(model.url)}" target="_blank"><i data-lucide="database"></i></a>
        </div>
      </article>
    `;
  }).join("");
  root.querySelectorAll("[data-action='remote-readme']").forEach((button) => {
    button.addEventListener("click", () => loadRemoteReadme(button.dataset.model));
  });
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
      selectLaunchModel(button.dataset.model, { format: "auto", silent: true });
    });
  });
  renderIcons();
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
  if (!text.trim()) return false;
  if (isBlockedForVllm(text)) return false;
  if (item?.format === "gguf" || /\.gguf(?:\b|$)/i.test(text) || /\bgguf\b/i.test(text)) return false;
  return true;
}

function isManagerRunnableRemoteModel(model) {
  const text = remoteModelCompatibilityText(model);
  if (!model?.id || isBlockedForVllm(text)) return false;
  if (model.hasGguf && !model.hasSafetensors) return false;
  if (/\bgguf\b|\bggml\b/i.test(text) && !model.hasSafetensors) return false;
  return true;
}

function remoteModelCompatibilityText(model) {
  return [
    model?.id,
    model?.label,
    model?.author,
    model?.pipelineTag,
    model?.libraryName,
    ...(model?.badges || []),
    ...(model?.quantFormats || []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function isBlockedForVllm(text) {
  const lower = String(text || "").toLowerCase();
  return [
    "qwen35moe",
    "gemma4",
    "embedding",
    "embeddings",
    "rerank",
    "sentence-transformers",
    "feature-extraction",
    "text-classification",
    "token-classification",
    "zero-shot-classification",
    "translation",
    "fill-mask",
  ].some((token) => lower.includes(token));
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
  return date.toLocaleDateString(effectiveLanguage());
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(effectiveLanguage(), { hour12: false });
}

function renderJobs() {
  renderJobList($("#jobList"), (state.jobs || []).filter((job) => job.type === "download").slice(0, 6), "暂无下载任务");
  renderJobList($("#serviceJobList"), (state.jobs || []).filter((job) => job.type === "serve").slice(0, 4), "暂无启动任务");
  renderJobList($("#benchmarkJobList"), (state.jobs || []).filter((job) => job.type === "benchmark" || job.type === "automation").slice(0, 5), "暂无测速任务");
}

function renderJobList(root, jobs, emptyText) {
  if (!root) return;
  const html = !jobs.length
    ? `<div class="empty">${escapeHtml(emptyText)}</div>`
    : jobs.map((job) => {
      const status = jobStatusInfo(job.status);
      const tail = (job.logs || []).slice(-3).join(" | ");
      const updatedAt = job.updatedAt || job.finishedAt || job.createdAt;
      const expanded = state.expandedJobLogs.has(job.id);
      return `
        <article class="job-row ${status.rowClass}">
          <div>
            <div class="job-title-line">
              <h4>${escapeHtml(job.title)}</h4>
              <span class="pill ${status.pillClass}">${escapeHtml(status.label)}</span>
            </div>
            <div class="job-meta-line">
              <span>${escapeHtml(jobTypeLabel(job.type))}</span>
              <span>${escapeHtml(formatDateTime(updatedAt))}</span>
              ${job.error ? `<span class="job-error-text">${escapeHtml(job.error)}</span>` : ""}
            </div>
            <p class="job-log-tail">${escapeHtml(tail || status.detail)}</p>
            ${renderJobProgress(job)}
            ${expanded ? `<pre class="job-log-full">${escapeHtml((job.logs || []).join("\n") || "暂无日志")}</pre>` : ""}
          </div>
        </article>
      `;
    }).join("");
  // 内容没变就不重绘，避免 3 秒轮询导致按钮闪烁和点击丢失
  if (root.__jobsHtml === html) return;
  root.__jobsHtml = html;
  root.innerHTML = html;
}

function jobStatusInfo(status) {
  if (status === "success") return { label: "完成", pillClass: "ok", rowClass: "is-success", detail: "任务已完成" };
  if (status === "failed") return { label: "失败", pillClass: "fail", rowClass: "is-failed", detail: "任务失败，查看日志尾部或一键重试" };
  if (status === "cancelled") return { label: "已取消", pillClass: "fail", rowClass: "is-failed", detail: "下载已取消，部分文件已清理" };
  if (status === "paused") return { label: "已暂停", pillClass: "warn", rowClass: "is-queued", detail: "下载已暂停，可以继续" };
  if (status === "interrupted") return { label: "中断", pillClass: "warn", rowClass: "is-queued", detail: "管理器重启时任务仍在运行" };
  if (status === "queued") return { label: "等待", pillClass: "warn", rowClass: "is-queued", detail: "等待后台开始处理" };
  return { label: "运行中", pillClass: "warn", rowClass: "is-running", detail: "后台正在处理" };
}

function jobTypeLabel(type) {
  if (type === "download") return "模型下载";
  if (type === "serve") return "服务启动";
  return type || "任务";
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
  const logsButton = `<button type="button" class="job-action-button" data-download-action="logs" data-job="${escapeAttr(job.id)}">${state.expandedJobLogs.has(job.id) ? "收起日志" : "查看日志"}</button>`;
  if (job.status === "running") {
    return `
      <div class="job-actions">
        <button type="button" class="job-action-button" data-download-action="pause" data-job="${escapeAttr(job.id)}">暂停</button>
        <button type="button" class="job-action-button danger" data-download-action="cancel" data-job="${escapeAttr(job.id)}">取消并删除</button>
        ${logsButton}
      </div>
    `;
  }
  if (job.status === "queued") {
    return `
      <div class="job-actions">
        <button type="button" class="job-action-button" data-download-action="pause" data-job="${escapeAttr(job.id)}">暂停排队</button>
        <button type="button" class="job-action-button danger" data-download-action="cancel" data-job="${escapeAttr(job.id)}">取消并删除</button>
        ${logsButton}
      </div>
    `;
  }
  const meta = job.meta || {};
  const canResume = meta.model && ["paused", "interrupted", "failed", "cancelled"].includes(job.status);
  const resumeButton = canResume
    ? `<button type="button" class="job-action-button primary" data-download-action="resume" data-job="${escapeAttr(job.id)}">继续下载</button>`
    : "";
  const cleanupButton = meta.localDir && ["paused", "interrupted", "failed"].includes(job.status)
    ? `<button type="button" class="job-action-button danger" data-download-action="cancel" data-job="${escapeAttr(job.id)}">取消并删除</button>`
    : "";
  const verifyButton = meta.localDir || meta.outputName
    ? `<button type="button" class="job-action-button" data-download-action="verify" data-job="${escapeAttr(job.id)}">校验文件</button>`
    : "";
  const startButton = job.status === "success" && (meta.localDir || meta.outputName)
    ? `<button type="button" class="job-action-button primary" data-download-action="use-start" data-job="${escapeAttr(job.id)}">填入启动</button>`
    : "";
  const actions = [resumeButton, cleanupButton, verifyButton, startButton, logsButton].filter(Boolean).join("");
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
