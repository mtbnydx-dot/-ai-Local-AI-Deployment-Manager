# Local Model Service Platform / 本地模型服务平台

一个面向高端个人工作站和小团队局域网的本地 AI 服务控制台。它把 vLLM、llama.cpp、TTS 语音克隆、模型下载、显存估算、多 GPU 配置、OpenAI/Claude/Audio 兼容接口、局域网服务、访问统计和基础审计整合在同一套本地管理工具里。

This is a local AI service control panel for high-end personal workstations and small LAN teams. It combines vLLM, llama.cpp, a multi-engine TTS/voice-cloning platform, model download workflows, VRAM estimation, multi-GPU configuration, OpenAI/Claude/Audio-compatible gateways, LAN serving, access statistics, and basic audit exports in one local toolkit.

---

## 中文说明

### 适合谁

- 想在本机或局域网里运行 Qwen、Llama、DeepSeek、Gemma 等开源模型的人。
- 有 NVIDIA 显卡，尤其是 24GB、48GB、96GB 显存或多卡机器的用户。
- 想把本地模型接入 OpenWebUI、Claude Desktop/Cowork、ccswitch、OpenCode、OpenAI SDK 的用户。
- 想同时使用 vLLM 的高吞吐能力和 llama.cpp/GGUF 的省显存、异构双卡能力的用户。
- 想看清楚模型启动、显存占用、上下文容量、访问来源、token 用量和速度统计的用户。

### 主要功能

- **统一入口**：`service-entry` 提供一级控制台和自动网关。
- **多模型舰队**：聚合 vLLM 与 llama.cpp 的主实例和并行实例，提供显存账本、能力标签、规划空槽和文本/视觉/音频/Embedding/Rerank 自动路由；不会擅自停止正在服务的模型。
- **vLLM 管理器**：下载模型、启动 vLLM 容器、OpenAI/Claude 兼容接口、工具调用桥接、上下文压缩、统计和日志。
- **llama.cpp 管理器**：管理 GGUF 模型，重点支持异构双卡、GPU layers、tensor split、长上下文和 RAM fallback。
- **TTS 语音平台**：聚合 Chatterbox、Qwen3-TTS、Fish、Step-Audio 及外部 API，提供响应式创作台、音色库、多引擎异步队列、持久化历史和 OpenAI Audio 兼容接口，并统一显示在 `service-entry`。
- **模型下载**：支持 Hugging Face / ModelScope 链接解析、在线模型搜索、量化筛选、下载进度、暂停、继续和取消。
- **显存估算**：按模型参数量、量化精度、上下文长度、KV cache、GPU 空闲显存和多卡模式估算显存风险。
- **多客户端服务**：对 OpenWebUI、Claude/Cowork、ccswitch、OpenCode 和 OpenAI-compatible SDK 提供统一接入。
- **平台级 MCP**：独立的只读 MCP 服务可被 OpenWebUI、Claude、Codex、IDE 或自建 Agent 复用，并同时支持 Streamable HTTP 与 stdio。
- **局域网服务**：可选择向局域网设备开放服务，并显示本机局域网地址。
- **访问控制**：支持服务 API Key、客户端策略、限流、并发限制和外来访问统计。
- **审计导出**：可在本地生成对话审计 Markdown；默认不把运行日志、数据库和密钥放进发布目录。

### 目录结构

```text
.
├─ service-entry/          # 统一入口和网关
├─ vllm-manager/           # vLLM 管理后台
├─ llama-manager/          # llama.cpp / GGUF 管理后台
├─ tts-platform/           # TTS 聚合网关、网页、worker 与启动脚本
├─ manager-core/           # 共用网络、密钥、统计、显存估算工具
├─ platform-mcp/           # 平台级只读 MCP 工具服务
├─ search-gateway/         # 联网搜索、网页/PDF 安全读取与 OpenAI 兼容网关
├─ tests/                  # 跨管理器前端烟测
├─ model-capability-tests/ # 长任务能力测试提示词
├─ vllm/                   # 轻量 vLLM helper 脚本
├─ deploy/public/          # 公网 TLS / OpenWebUI 可选模板
├─ docs/                   # 使用手册与客户端连接指南
├─ package.json            # 根目录测试依赖，主要用于 Playwright smoke test
├─ playwright.config.cjs   # 浏览器烟测配置
├─ install-all.cmd         # 安装 Node 依赖
├─ install-tts-gateway.cmd # 用 uv 创建 TTS 网关 Python 3.12 环境
├─ update-platform.cmd     # 从 GitHub 安全 fast-forward 更新并复测
├─ test-all.cmd            # 运行核心测试
├─ start-service-entry.cmd # 启动本机模式
├─ start-platform-mcp.cmd  # 启动 loopback MCP 服务
├─ start-tts-platform.cmd  # 启动 TTS 网关与语音 worker
├─ status-tts-platform.cmd # 查看 TTS 端口与引擎状态
└─ start-service-entry-lan.cmd # 启动局域网模式
```

Qwen3.8-27B 的 vLLM MTP、SGLang DSpark 实测结果、管理器预设和接口字段见 [Qwen3.8-27B 本地加速与管理平台指南](docs/qwen38-acceleration-guide.md)。

平台 MCP 0.5.0 提供 16 个只读工具，包括单次搜索、多查询研究、显式公网链接与搜索结果正文识别、页内定位、任务历史、路由预览、显存估算和安全态势。跨 Chatbox、OpenWebUI、Claude、Codex、IDE 和自建 Agent 复用 MCP 的架构、安全边界与配置示例见 [自建平台级 MCP 接入指南](docs/mcp-platform-guide.md)。

### 系统要求

- Windows 10/11。
- Node.js 22.22.2 或更高版本（完整 search-gateway 所需）。
- Docker Desktop。
- NVIDIA 驱动；运行 vLLM/llama.cpp CUDA 容器时需要可用 GPU。
- Chrome 或 Edge；前端 smoke test 默认使用本机 Chrome，也可以设置 `PLAYWRIGHT_BROWSER_CHANNEL=msedge` 使用 Edge。
- TTS 功能需要 Python 3.12、`uv` 和 PowerShell 7；不用 TTS 时可不安装。
- 可选：Hugging Face CLI、ModelScope CLI、CUDA Toolkit。

### 快速开始

在发布目录根部运行：

```cmd
install-all.cmd
install-tts-gateway.cmd
test-all.cmd
start-service-entry.cmd
start-platform-mcp.cmd
start-tts-platform.cmd -GatewayOnly -NoBrowser
```

模型、缓存和运行数据默认保存在发布目录内。需要放到其它磁盘时，请在启动前设置 `AI_ROOT`；也可以分别用 `VLLM_MODELS_ROOT`、`LLAMA_MODELS_ROOT`、`HF_HOME` 和 `TTS_RUNTIME_ROOT` 覆盖模型、缓存或 TTS 运行目录。

浏览器打开：

```text
http://127.0.0.1:5176/
```

如果要让局域网其它设备访问：

```cmd
start-service-entry-lan.cmd
```

或：

```cmd
start-service-entry.cmd lan
```

### 常用接口地址

本机：

```text
OpenAI:  http://127.0.0.1:5176/gateway/auto/openai/v1
Claude:  http://127.0.0.1:5176/gateway/auto/claude
OpenCode: http://127.0.0.1:5176/gateway/auto/opencode/v1
MCP:      http://127.0.0.1:5190/mcp
TTS UI:   http://127.0.0.1:5176/gateway/tts/
TTS API:  http://127.0.0.1:5176/gateway/tts/openai/v1
```

局域网：

```text
OpenAI:  http://<本机局域网 IP>:5176/gateway/auto/openai/v1
Claude:  http://<本机局域网 IP>:5176/gateway/auto/claude
OpenCode: http://<本机局域网 IP>:5176/gateway/auto/opencode/v1
TTS UI:   http://<本机局域网 IP>:5176/gateway/tts/
TTS API:  http://<本机局域网 IP>:5176/gateway/tts/openai/v1
```

`auto` 会自动选择当前可用的 vLLM 或 llama.cpp 后端。需要固定后端时，可以把 `auto` 换成 `vllm` 或 `llama`。

完整发布包包含可选的 `search-gateway` 联网搜索扩展，但不会自动启动。需要时先保持模型服务运行，再执行 `start-search-gateway.cmd`，客户端使用 `http://127.0.0.1:5180/v1`；局域网使用 `http://<本机局域网 IP>:5180/v1`。详见 `search-gateway/README.md`。

### 客户端配置建议

- OpenWebUI / OpenAI SDK：使用 OpenAI Base URL，认证字段使用 `Authorization: Bearer <API_KEY>`。
- Claude Desktop / Cowork / ccswitch：使用 Claude Base URL，认证字段优先选 `ANTHROPIC_API_KEY`。
- OpenCode：使用 OpenCode Base URL，模型名优先用 `local-current`。

API Key 请在管理器的“服务提供/外来访问”页面生成。不要把真实 key 写入截图、文档或 issue。

### vLLM 还是 llama.cpp

- 选择 **vLLM**：需要高吞吐、OpenAI-compatible serving、Qwen 工具调用、并发请求和更接近服务端部署的行为。
- 选择 **llama.cpp**：使用 GGUF、想节省显存、需要异构双卡、需要 GPU layers/RAM fallback，或者想快速加载本地量化模型。

### 固定运行时与新版能力

- 普通 GGUF 模型使用已验证的 llama.cpp `b10630` CUDA 镜像。管理器已对齐 `--reasoning-effort`、`--reasoning-budget` 与 `--mmproj-device`；实验性的 `--tools-runtime` 涉及外部命令执行，因此不在网页端开放。历史 Muse 镜像和兼容代码仅为回滚保留，本轮不再维护、下载或验证 Muse。
- 同一目录中的 `dynamic` 与 `17gb` 等主 GGUF 是可分别选择的替代变体，不会相加为模型权重。显存估算和启动命令始终使用当前选中的一个主变体；`mmproj` 是可选视觉投影组件，DFlash GGUF 是可选的推测解码加速组件，只有启用或自动匹配时才计入估算和命令。
- vLLM 默认运行时固定为 Linux/amd64 的 v0.28.0 平台镜像 `vllm/vllm-openai@sha256:2286e8533ca8b6bc777594bae30524f1426ba46ca21797524e06df6a94b06635`，前端提供 `max_num_batched_tokens`。本地策略已弃用 Muse，即使上游 v0.28 已加入相关实现，管理器仍会在创建容器前阻断。v0.28 已把 BitsAndBytes 支持迁移到外部 `vllm-bnb-plugin`，固定镜像未安装该插件，因此 BNB checkpoint 也会明确阻断；非 BNB safetensors 不受影响。

### 安全和隐私

- 默认本机模式只监听 `127.0.0.1`。
- **统一入口是唯一的策略执行点**：`service-entry` 在转发前完成 Host/Origin 校验、API Key 鉴权和限流，再用签名请求头把真实客户端地址传给管理器。管理器只信任带有效签名的回环请求。
- TTS 的 7000 与 worker 端口保持回环监听；局域网客户端只能经 `/gateway/tts/` 访问，并复用统一入口的客户端 Key。参考音色和生成音频属于本机运行数据，不进入 Git 或发布包。
- 局域网模式（`start-service-entry.cmd lan`）**默认强制 API Key**。密钥在任一管理器的“对外服务”页生成，两个管理器的密钥都可用于统一网关。
- 浏览器跨域默认拒绝，需要时用 `SERVICE_ENTRY_ALLOWED_ORIGINS` 显式放行。
- 管理端点默认仅本机可用；局域网设备读取状态时会得到脱敏结果。
- 发布目录不会包含模型文件、缓存、日志、数据库、运行时账本、PID 文件、`.env` 或 `node_modules`。
- 访问统计只记录元数据，例如来源 IP、路径、状态码、模型名、token 数和耗时；不记录提示词或响应正文。

#### 安全开关

全部通过环境变量控制，当前生效状态见启动横幅或 `GET /api/security`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SERVICE_ENTRY_REQUIRE_API_KEY` | `auto` | `auto` = 仅局域网模式强制；`1` = 始终强制；`0` = 关闭鉴权（可信局域网免密） |
| `SERVICE_ENTRY_ALLOW_LAN_ADMIN` | `0` | `1` = 允许局域网设备启停管理器、查看完整状态 |
| `SERVICE_ENTRY_ALLOWED_ORIGINS` | 空 | 逗号分隔的浏览器 Origin 白名单；`*` 表示全放行 |
| `SERVICE_ENTRY_ALLOWED_HOSTS` | 空 | 额外 Host 白名单，用于反向代理域名 |
| `SEARCH_GATEWAY_ALLOW_NO_KEY` | `false` | `true` = 允许 search-gateway 无密钥对外服务 |
| `AI_AUDIT_MAX_EXPORTS` / `AI_AUDIT_MAX_AGE_DAYS` | `30` / `90` | 审计导出保留份数与天数，`0` = 不限制 |

想在可信家庭局域网里免密使用并开放管理界面：

```cmd
set SERVICE_ENTRY_REQUIRE_API_KEY=0
set SERVICE_ENTRY_ALLOW_LAN_ADMIN=1
start-service-entry.cmd lan
```

### 可更新的参考数据

模型价格和 GPU 性能系数存放在 `manager-core/data/*.json`，都带 `asOf` 日期；数据超期时统计页会提示成本对比仅供粗略参考。把同名文件放到 `<AI_ROOT>/config/` 即可覆盖内置版本，无需改代码。

### 测试

```cmd
test-all.cmd
```

公网 TLS / OpenWebUI 部署模板位于 `deploy/public/`。审计与整改记录见 `docs/comprehensive-audit-2026-07-16.md` 和 `docs/security-hardening-2026-08-04.md`（后者含本轮安全加固、开关说明和未实施项归档）。

> **升级提示**：本轮修复了一个既有缺陷——全局服务 API Key 在管理器重启后会静默失效。升级后请到“对外服务”页重新生成一次密钥。

当前测试覆盖：

- 统一网关路由。
- OpenAI/Claude 消息转换。
- 服务 API Key 和访问策略。
- vLLM / llama.cpp 显存估算。
- llama 任务账本规范化。
- JSON 并发写入安全。
- vLLM / llama 前端真实浏览器 smoke test：启动两个管理器、打开首页、切换服务/下载/外来访问/统计页面，并检查脚本、样式和控制台错误。

单独运行前端 smoke test：

```cmd
npm run test:frontend-smoke
```

如果机器没有 Chrome，但有 Edge：

```cmd
set PLAYWRIGHT_BROWSER_CHANNEL=msedge
npm run test:frontend-smoke
```

### Git worktree 开发

源码仓库、功能工作树和 `<AI_ROOT>` 运行目录相互隔离。新功能从 `integration` 创建独立 worktree，测试并提交后再合并；部署脚本按发布白名单备份和同步源码，不会删除模型、缓存、密钥、数据库或日志，也不会自动重启模型。完整流程见 [`docs/git-worktree-workflow.md`](docs/git-worktree-workflow.md)。

### GitHub 多电脑更新

其它电脑首次使用时从 GitHub 克隆并运行 `install-all.cmd`；之后运行 `update-platform.cmd` 即可进行只允许 fast-forward 的安全更新。更新器发现受控文件有本地修改、存在未推送提交或分叉历史时会拒绝覆盖，也不会重启服务或加载模型。完整流程见 [`docs/update-guide.md`](docs/update-guide.md)。

### 构建 GitHub 发布包

在项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\build-github-release.ps1
```

脚本会在 `artifacts/github-release/` 同时保留可直接初始化 Git 的版本目录并生成同名 ZIP，只收录发布所需源码、用户文档和示例配置。`node_modules`、日志、模型、缓存、数据库、PID、`.env`、本机代理配置、内部审计文档和测试产物均会排除；打包结束前还会检查本机用户名、用户目录、计算机名和常见密钥格式。

---

## English

### Who This Is For

- Users who want to run open-weight models such as Qwen, Llama, DeepSeek, and Gemma on a local workstation or LAN.
- NVIDIA GPU users, especially machines with 24GB, 48GB, 96GB VRAM, or multiple GPUs.
- Users who want to connect local models to OpenWebUI, Claude Desktop/Cowork, ccswitch, OpenCode, or OpenAI-compatible SDKs.
- Users who want both vLLM throughput and llama.cpp/GGUF memory efficiency.
- Users who need visibility into launch status, VRAM use, context length, request sources, token usage, and generation speed.

### Key Features

- **Unified entrypoint**: `service-entry` provides the first-level console and automatic gateway.
- **Multi-model fleet**: aggregates primary and parallel vLLM/llama.cpp instances with a deduplicated VRAM ledger, capability tags, planning slots, and automatic text/vision/audio/embedding/rerank routing without stopping resident models.
- **vLLM manager**: model download, Docker launch, OpenAI/Claude-compatible APIs, tool-call bridging, context compression, stats, and logs.
- **llama.cpp manager**: GGUF model management with heterogeneous GPU support, GPU layers, tensor split, long context, and RAM fallback.
- **TTS platform**: Chatterbox, Qwen3-TTS, Fish, Step-Audio, and external API engines behind the unified entrypoint, with a responsive studio, voice library, multi-engine job queue, persistent history, and an OpenAI Audio-compatible API.
- **Model downloads**: Hugging Face / ModelScope link parsing, remote search, quantization filters, progress bars, pause/resume/cancel.
- **VRAM estimation**: estimates memory risk from model size, quantization, context length, KV cache, free GPU memory, and multi-GPU mode.
- **Client serving**: unified access for OpenWebUI, Claude/Cowork, ccswitch, OpenCode, and OpenAI-compatible clients.
- **Platform MCP**: a reusable read-only MCP service for OpenWebUI, Claude, Codex, IDEs, and custom agents over Streamable HTTP or stdio.
- **LAN serving**: optional local-network service mode with visible LAN addresses.
- **Access control**: the unified entry is the single policy enforcement point — Host/Origin checks, API key auth, and rate limits run before the request is proxied, and managers only trust a signed loopback hop. Service API keys, per-client policies, concurrency limits, and external access statistics.
- **Audit export**: local Markdown audit export without publishing runtime logs, databases, or secrets.

### Project Layout

```text
.
├─ service-entry/          # Unified entrypoint and gateway
├─ vllm-manager/           # vLLM control panel
├─ llama-manager/          # llama.cpp / GGUF control panel
├─ tts-platform/           # TTS gateway, web UI, workers, and launch scripts
├─ manager-core/           # Shared networking, secret, stats, and memory-estimation helpers
├─ platform-mcp/           # Platform-level read-only MCP tool service
├─ search-gateway/         # Web search, bounded page/PDF reader, and OpenAI-compatible gateway
├─ tests/                  # Cross-manager frontend smoke tests
├─ model-capability-tests/ # Long-running model capability prompts
├─ vllm/                   # Lightweight vLLM helper scripts
├─ deploy/public/          # Optional public TLS / OpenWebUI templates
├─ docs/                   # Runbooks and client setup guides
├─ package.json            # Root test dependencies, mainly Playwright smoke tests
├─ playwright.config.cjs   # Browser smoke-test configuration
├─ install-all.cmd         # Install Node dependencies
├─ install-tts-gateway.cmd # Create the Python 3.12 TTS gateway environment with uv
├─ update-platform.cmd     # Safe fast-forward GitHub update and validation
├─ test-all.cmd            # Run core tests
├─ start-service-entry.cmd # Start local-only mode
├─ start-platform-mcp.cmd  # Start the loopback MCP service
├─ start-tts-platform.cmd  # Start the TTS gateway and workers
├─ status-tts-platform.cmd # Inspect TTS listeners and engines
└─ start-service-entry-lan.cmd # Start LAN mode
```

### Requirements

- Windows 10/11.
- Node.js 22.22.2 or newer (required by the complete search gateway).
- Docker Desktop.
- NVIDIA driver and GPU access for vLLM/llama.cpp CUDA containers.
- Chrome or Edge. The frontend smoke test uses local Chrome by default; set `PLAYWRIGHT_BROWSER_CHANNEL=msedge` to use Edge.
- TTS requires Python 3.12, `uv`, and PowerShell 7; they are optional if TTS is not used.
- Optional: Hugging Face CLI, ModelScope CLI, and CUDA Toolkit.

### Quick Start

From the release root:

```cmd
install-all.cmd
install-tts-gateway.cmd
test-all.cmd
start-service-entry.cmd
start-platform-mcp.cmd
start-tts-platform.cmd -GatewayOnly -NoBrowser
```

Models, caches, and runtime data are stored inside the release directory by default. Set `AI_ROOT` before startup to use another drive, or override `VLLM_MODELS_ROOT`, `LLAMA_MODELS_ROOT`, `HF_HOME`, and `TTS_RUNTIME_ROOT` individually.

Open:

```text
http://127.0.0.1:5176/
```

To serve other LAN devices:

```cmd
start-service-entry-lan.cmd
```

or:

```cmd
start-service-entry.cmd lan
```

### Common Endpoint URLs

Local:

```text
OpenAI:  http://127.0.0.1:5176/gateway/auto/openai/v1
Claude:  http://127.0.0.1:5176/gateway/auto/claude
OpenCode: http://127.0.0.1:5176/gateway/auto/opencode/v1
MCP:      http://127.0.0.1:5190/mcp
TTS UI:   http://127.0.0.1:5176/gateway/tts/
TTS API:  http://127.0.0.1:5176/gateway/tts/openai/v1
```

LAN:

```text
OpenAI:  http://<LAN IP>:5176/gateway/auto/openai/v1
Claude:  http://<LAN IP>:5176/gateway/auto/claude
OpenCode: http://<LAN IP>:5176/gateway/auto/opencode/v1
TTS UI:   http://<LAN IP>:5176/gateway/tts/
TTS API:  http://<LAN IP>:5176/gateway/tts/openai/v1
```

`auto` routes to the currently available vLLM or llama.cpp backend. Replace it with `vllm` or `llama` to pin a backend.

The complete release includes the optional `search-gateway` web-search extension but does not start it automatically. Keep the model service running, launch `start-search-gateway.cmd`, and use `http://127.0.0.1:5180/v1`, or `http://<LAN IP>:5180/v1` from the LAN. See `search-gateway/README.md`.

Platform MCP 0.5.0 provides 16 read-only tools, including single-query search, multi-query research, bounded explicit-URL and result-page reading, in-page passage finding, job history, route preview, memory-fit estimation, and security posture. For the reusable MCP architecture, security boundary, and setup examples for Chatbox, OpenWebUI, Claude, Codex, IDEs, and custom agents, see the [self-hosted platform MCP guide](docs/mcp-platform-guide.md).

### Client Setup Tips

- OpenWebUI / OpenAI SDK: use the OpenAI Base URL and `Authorization: Bearer <API_KEY>`.
- Claude Desktop / Cowork / ccswitch: use the Claude Base URL and prefer `ANTHROPIC_API_KEY`.
- OpenCode: use the OpenCode Base URL and start with `local-current` as the model name.

Generate API keys from the manager's service/external access page. Do not put real keys in screenshots, docs, or issues.

### vLLM vs llama.cpp

- Use **vLLM** for high throughput, OpenAI-compatible serving, Qwen tool calling, concurrency, and service-like behavior.
- Use **llama.cpp** for GGUF, lower VRAM use, heterogeneous GPUs, GPU layers/RAM fallback, and fast local quantized model loading.

### Pinned Runtimes And New Capabilities

- Ordinary GGUF models use the validated llama.cpp `b10630` CUDA image. The manager exposes `--reasoning-effort`, `--reasoning-budget`, and `--mmproj-device`; the experimental `--tools-runtime` can execute external commands and therefore remains unavailable in the web UI. The historical Muse image and compatibility code are retained only for rollback; Muse is no longer maintained, downloaded, or validated in this rollout.
- Main GGUFs such as `dynamic` and `17gb` in one directory are selectable alternatives, not additive weights. Estimation and launch use exactly one selected main variant. `mmproj` is an optional vision projector and the DFlash GGUF is an optional speculative-decoding accelerator; each is counted and passed to the runtime only when selected or automatically matched.
- The default vLLM runtime is pinned to the Linux/amd64 v0.28.0 platform image `vllm/vllm-openai@sha256:2286e8533ca8b6bc777594bae30524f1426ba46ca21797524e06df6a94b06635`, and the UI exposes `max_num_batched_tokens`. Local policy retires Muse, so the manager blocks it before container creation even though upstream v0.28 contains an implementation. vLLM 0.28 moved BitsAndBytes loading to the external `vllm-bnb-plugin`; that plugin is absent from the pinned image, so BNB checkpoints are also blocked while ordinary safetensors remain supported.

### Security And Privacy

- Local mode listens on `127.0.0.1` by default.
- `service-entry` is the single policy enforcement point. It validates Host/Origin, authenticates the API key, and applies rate limits before proxying, then signs the loopback hop with the real client address. Managers treat an unsigned hop that claims to come from the gateway as remote.
- LAN mode requires an API key by default. Generate one on either manager's service page; both managers' keys work at the unified gateway.
- Browser CORS is deny-by-default; allow origins explicitly with `SERVICE_ENTRY_ALLOWED_ORIGINS`.
- Management endpoints are local-only by default, and LAN status reads are redacted.
- The release mirror excludes model files, caches, logs, databases, runtime ledgers, PID files, `.env`, and `node_modules`.
- Access statistics contain metadata only: source IP, path, status code, model name, token counts, and latency.

#### Security switches

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERVICE_ENTRY_REQUIRE_API_KEY` | `auto` | `auto` = required only when bound off-loopback; `1` = always; `0` = disable auth (trusted LAN) |
| `SERVICE_ENTRY_ALLOW_LAN_ADMIN` | `0` | `1` = let LAN devices start/stop managers and read full status |
| `SERVICE_ENTRY_ALLOWED_ORIGINS` | empty | Comma-separated browser Origin allowlist; `*` allows all |
| `SERVICE_ENTRY_ALLOWED_HOSTS` | empty | Extra Host allowlist for reverse-proxy domains |
| `SEARCH_GATEWAY_ALLOW_NO_KEY` | `false` | `true` = let search-gateway serve without a key |
| `AI_AUDIT_MAX_EXPORTS` / `AI_AUDIT_MAX_AGE_DAYS` | `30` / `90` | Audit export retention by count and age; `0` disables the limit |

### Updatable Reference Data

Model pricing and GPU performance factors live in `manager-core/data/*.json` with an `asOf` date. Drop a file of the same name into `<AI_ROOT>/config/` to override the bundled copy. When the data is past its refresh window, the stats view labels the cost comparison as approximate.

### Testing

```cmd
test-all.cmd
```

The tests cover gateway routing, OpenAI/Claude message conversion, service API keys, access policies, vLLM/llama.cpp memory estimation, llama job ledger normalization, JSON write safety, and real browser frontend smoke tests for both managers.

Run only the frontend smoke test:

```cmd
npm run test:frontend-smoke
```

Use Edge instead of Chrome:

```cmd
set PLAYWRIGHT_BROWSER_CHANNEL=msedge
npm run test:frontend-smoke
```

### Git worktree development

The source repository, feature worktrees, and the live `<AI_ROOT>` runtime are isolated. Create each change from `integration`, test and commit it independently, then merge it. The deployment helper backs up and syncs only the release allowlist; it never deletes models, caches, keys, databases, or logs, and never restarts a model automatically. See [`docs/git-worktree-workflow.md`](docs/git-worktree-workflow.md).

### GitHub Updates On Multiple Computers

Clone the GitHub repository and run `install-all.cmd` on another computer. Later, use `update-platform.cmd` for a fast-forward-only update. It refuses tracked local edits, unpushed commits, and diverged history, and never restarts a service or loads a model. See [`docs/update-guide.md`](docs/update-guide.md).

### Build A GitHub Release Archive

Run from the project root:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-github-release.ps1
```

The script keeps a Git-ready versioned directory and creates a matching ZIP under `artifacts/github-release/`. Both contain only release source, user documentation, and example configuration. It excludes dependencies, logs, models, caches, databases, PIDs, `.env`, machine-local proxy data, internal audit notes, and test artifacts. Before completing, it also checks for the current username, user profile, computer name, and common credential formats.
