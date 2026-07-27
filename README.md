# Local Model Service Platform / 本地模型服务平台

一个面向高端个人工作站和小团队局域网的 AI 服务控制台。它把 vLLM、llama.cpp、本地模型管理，以及由 CLIProxyAPI 提供的可选订阅反代整合在同一套统一入口里。

This is an AI service control panel for high-end personal workstations and small LAN teams. It combines vLLM, llama.cpp, local model management, and an optional CLIProxyAPI subscription adapter behind one entrypoint.

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
- **订阅反代**：可连接本机 CLIProxyAPI，把已获授权的订阅服务提供为 OpenAI、Claude、Codex、OpenCode API；适用于本机、局域网和受控的可选公网，不只用于“对外服务”。
- **订阅登录前端**：本机控制台可生成 CLIProxyAPI 客户端 Key，并启动 Codex、Claude、Kimi、xAI、Antigravity 登录；局域网访问只能查看状态。
- **vLLM 管理器**：下载模型、启动 vLLM 容器、OpenAI/Claude 兼容接口、工具调用桥接、上下文压缩、统计和日志。
- **llama.cpp 管理器**：管理 GGUF 模型，重点支持异构双卡、GPU layers、tensor split、长上下文和 RAM fallback。
- **模型下载**：支持 Hugging Face / ModelScope 链接解析、在线模型搜索、量化筛选、下载进度、暂停、继续和取消。
- **显存估算**：按模型参数量、量化精度、上下文长度、KV cache、GPU 空闲显存和多卡模式估算显存风险。
- **多客户端服务**：对 OpenWebUI、Claude/Cowork、ccswitch、OpenCode 和 OpenAI-compatible SDK 提供统一接入。
- **局域网服务**：可选择向局域网设备开放服务，并显示本机局域网地址。
- **访问控制**：支持服务 API Key、客户端策略、限流、并发限制和外来访问统计。
- **审计导出**：可在本地生成对话审计 Markdown；默认不把运行日志、数据库和密钥放进发布目录。

### 目录结构

```text
.
├─ service-entry/          # 统一入口和网关
├─ vllm-manager/           # vLLM 管理后台
├─ llama-manager/          # llama.cpp / GGUF 管理后台
├─ manager-core/           # 共用网络、密钥、统计、显存估算工具
├─ tests/                  # 跨管理器前端烟测
├─ model-capability-tests/ # 长任务能力测试提示词
├─ vllm/                   # 轻量 vLLM helper 脚本
├─ deploy/public/          # 公网 TLS / OpenWebUI 可选模板
├─ docs/                   # 使用手册与客户端连接指南
├─ package.json            # 根目录测试依赖，主要用于 Playwright smoke test
├─ playwright.config.cjs   # 浏览器烟测配置
├─ install-all.cmd         # 安装 Node 依赖
├─ test-all.cmd            # 运行核心测试
├─ start-service-entry.cmd # 启动本机模式
├─ start-service-entry-lan.cmd # 启动局域网模式
├─ start-subscription-proxy.cmd # Windows 只反代模式
├─ start-subscription-proxy.sh # Ubuntu/macOS 自动识别一键启动
├─ start-subscription-proxy-ubuntu.sh # Ubuntu 一键启动
└─ start-subscription-proxy-macos.command # macOS 双击启动
```

### 系统要求

- Windows 10/11。
- Ubuntu 与 macOS 当前用于下文的“只反代模式”；完整本地模型管理仍以 Windows 为主。
- Node.js 20 或更高版本。
- Docker Desktop。
- NVIDIA 驱动；运行 vLLM/llama.cpp CUDA 容器时需要可用 GPU。
- Chrome 或 Edge；前端 smoke test 默认使用本机 Chrome，也可以设置 `PLAYWRIGHT_BROWSER_CHANNEL=msedge` 使用 Edge。
- 可选：Hugging Face CLI、ModelScope CLI、CUDA Toolkit、PowerShell 7。
- 可选：[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)，用于订阅反代；它是第三方项目，不是 OpenAI 官方组件。

### 快速开始

在发布目录根部运行：

```cmd
install-all.cmd
test-all.cmd
start-service-entry.cmd
```

模型、缓存和运行数据默认保存在发布目录内。需要放到其它磁盘时，请在启动前设置 `AI_ROOT`；也可以分别用 `VLLM_MODELS_ROOT`、`LLAMA_MODELS_ROOT` 和 `HF_HOME` 覆盖模型或缓存目录。

浏览器打开：

```text
http://127.0.0.1:5176/
```

如果只需要订阅反代，不启动 vLLM、llama.cpp 管理器或模型容器：

```cmd
start-subscription-proxy.cmd
```

局域网使用 `start-subscription-proxy-lan.cmd`，停止使用 `stop-subscription-proxy.cmd`。

Ubuntu：

```bash
./start-subscription-proxy-ubuntu.sh
```

macOS：

```bash
open ./start-subscription-proxy-macos.command
```

也可以直接在 Finder 中双击 `start-subscription-proxy-macos.command`。如果尚未安装 CLIProxyAPI，启动器会询问是否通过 Homebrew 安装并在安装后继续启动。

也可直接运行 `./start-subscription-proxy.sh`，脚本会自动识别 Ubuntu 或 macOS。启动器会等待前端和网关可用后自动打开浏览器。

局域网、状态和停止等高级操作继续使用 `subscription-proxy-ubuntu.sh` 或 `subscription-proxy-macos.sh`。两个版本都只运行 CLIProxyAPI、前端和统一网关，需要 Node.js 20+、Bash 和 curl，不需要 Docker 或 NVIDIA GPU。

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
```

局域网：

```text
OpenAI:  http://<本机局域网 IP>:5176/gateway/auto/openai/v1
Claude:  http://<本机局域网 IP>:5176/gateway/auto/claude
OpenCode: http://<本机局域网 IP>:5176/gateway/auto/opencode/v1
```

`auto` 会自动选择当前可用的 vLLM 或 llama.cpp 后端。需要固定后端时，可以把 `auto` 换成 `vllm` 或 `llama`。

可选订阅反代使用独立路径，不加入 `auto`，避免本地模型请求意外消耗订阅配额：

```text
OpenAI:  http://127.0.0.1:5176/gateway/subscription/openai/v1
Claude:  http://127.0.0.1:5176/gateway/subscription/claude
Codex:   http://127.0.0.1:5176/gateway/subscription/codex/v1
OpenCode:http://127.0.0.1:5176/gateway/subscription/opencode/v1
```

安装、OAuth 登录和凭据边界见 [`docs/subscription-proxy-guide.md`](docs/subscription-proxy-guide.md)。

一键启动会直接打开 `http://127.0.0.1:5176/subscription-console.html`。同一个“订阅反代控制台”内可切换“反代账号”和“服务发布”两个页签：前者用于生成 Key 和登录订阅，后者用于查看本机、局域网地址，并填写可选公网 HTTPS 基础地址。

### 客户端配置建议

- OpenWebUI / OpenAI SDK：使用 OpenAI Base URL，认证字段使用 `Authorization: Bearer <API_KEY>`。
- Claude Desktop / Cowork / ccswitch：使用 Claude Base URL，认证字段优先选 `ANTHROPIC_API_KEY`。
- OpenCode：使用 OpenCode Base URL，模型名优先用 `local-current`。

API Key 请在管理器的“服务提供/外来访问”页面生成。不要把真实 key 写入截图、文档或 issue。

### vLLM 还是 llama.cpp

- 选择 **vLLM**：需要高吞吐、OpenAI-compatible serving、Qwen 工具调用、并发请求和更接近服务端部署的行为。
- 选择 **llama.cpp**：使用 GGUF、想节省显存、需要异构双卡、需要 GPU layers/RAM fallback，或者想快速加载本地量化模型。

### 安全和隐私

- 默认本机模式只监听 `127.0.0.1`。
- 局域网模式需要显式启动，并建议开启 API Key。
- 发布目录不会包含模型文件、缓存、日志、数据库、运行时账本、PID 文件、`.env` 或 `node_modules`。
- 访问统计只记录元数据，例如来源 IP、路径、状态码、模型名、token 数和耗时；不应记录完整提示词或响应正文。

### 测试

```cmd
test-all.cmd
```

公网 TLS / OpenWebUI 部署模板位于 `deploy/public/`；本次平台审计与整改记录见 `docs/platform-audit-remediation-2026-07-10.md`。

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

### 构建 GitHub 发布包

在项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\build-github-release.ps1
```

脚本会在 `artifacts/github-release/` 生成带版本号的 ZIP，并只收录发布所需源码、用户文档和示例配置。`node_modules`、日志、模型、缓存、数据库、PID、`.env`、本机代理配置、内部审计文档和测试产物均会排除；打包结束前还会检查本机用户名、用户目录、计算机名和常见密钥格式。

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
- **Subscription adapter**: optionally connects a loopback CLIProxyAPI instance and exposes authorized subscriptions through OpenAI, Claude, Codex, and OpenCode routes for local, LAN, or controlled public use.
- **Subscription login UI**: the localhost dashboard can generate CLIProxyAPI client keys and launch supported provider logins; LAN visitors remain read-only.
- **vLLM manager**: model download, Docker launch, OpenAI/Claude-compatible APIs, tool-call bridging, context compression, stats, and logs.
- **llama.cpp manager**: GGUF model management with heterogeneous GPU support, GPU layers, tensor split, long context, and RAM fallback.
- **Model downloads**: Hugging Face / ModelScope link parsing, remote search, quantization filters, progress bars, pause/resume/cancel.
- **VRAM estimation**: estimates memory risk from model size, quantization, context length, KV cache, free GPU memory, and multi-GPU mode.
- **Client serving**: unified access for OpenWebUI, Claude/Cowork, ccswitch, OpenCode, and OpenAI-compatible clients.
- **LAN serving**: optional local-network service mode with visible LAN addresses.
- **Access control**: service API keys, client policies, rate limits, concurrency limits, and external access statistics.
- **Audit export**: local Markdown audit export without publishing runtime logs, databases, or secrets.

### Project Layout

```text
.
├─ service-entry/          # Unified entrypoint and gateway
├─ vllm-manager/           # vLLM control panel
├─ llama-manager/          # llama.cpp / GGUF control panel
├─ manager-core/           # Shared networking, secret, stats, and memory-estimation helpers
├─ tests/                  # Cross-manager frontend smoke tests
├─ model-capability-tests/ # Long-running model capability prompts
├─ vllm/                   # Lightweight vLLM helper scripts
├─ deploy/public/          # Optional public TLS / OpenWebUI templates
├─ docs/                   # Runbooks and client setup guides
├─ package.json            # Root test dependencies, mainly Playwright smoke tests
├─ playwright.config.cjs   # Browser smoke-test configuration
├─ install-all.cmd         # Install Node dependencies
├─ test-all.cmd            # Run core tests
├─ start-service-entry.cmd # Start local-only mode
├─ start-service-entry-lan.cmd # Start LAN mode
├─ start-subscription-proxy.cmd # Windows subscription-only mode
├─ start-subscription-proxy.sh # Auto-detect Ubuntu/macOS and start
├─ start-subscription-proxy-ubuntu.sh # Ubuntu one-click launcher
└─ start-subscription-proxy-macos.command # macOS Finder launcher
```

### Requirements

- Windows 10/11.
- Ubuntu and macOS currently support the subscription-only mode documented below; full local-model management remains Windows-focused.
- Node.js 20 or newer.
- Docker Desktop.
- NVIDIA driver and GPU access for vLLM/llama.cpp CUDA containers.
- Chrome or Edge. The frontend smoke test uses local Chrome by default; set `PLAYWRIGHT_BROWSER_CHANNEL=msedge` to use Edge.
- Optional: Hugging Face CLI, ModelScope CLI, CUDA Toolkit, PowerShell 7.
- Optional: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) for subscription routing. It is a third-party project, not an official OpenAI component.

### Quick Start

From the release root:

```cmd
install-all.cmd
test-all.cmd
start-service-entry.cmd
```

Models, caches, and runtime data are stored inside the release directory by default. Set `AI_ROOT` before startup to use another drive, or override `VLLM_MODELS_ROOT`, `LLAMA_MODELS_ROOT`, and `HF_HOME` individually.

Open:

```text
http://127.0.0.1:5176/
```

To run only CLIProxyAPI, the frontend, and the gateway—without either local model manager or any model container:

```cmd
start-subscription-proxy.cmd
```

Use `start-subscription-proxy-lan.cmd` for LAN mode and `stop-subscription-proxy.cmd` to stop the isolated stack.

Ubuntu:

```bash
./start-subscription-proxy-ubuntu.sh
```

macOS:

```bash
open ./start-subscription-proxy-macos.command
```

You can also double-click `start-subscription-proxy-macos.command` in Finder. If CLIProxyAPI is missing, the launcher offers to install it with Homebrew and then continues startup.

You can also run `./start-subscription-proxy.sh` to auto-detect Ubuntu or macOS. The launcher waits for the frontend and gateway to become ready, then opens the unified subscription console with account and service tabs in the browser.

Use `subscription-proxy-ubuntu.sh` or `subscription-proxy-macos.sh` for advanced `start lan`, `status`, and `stop` operations. They require Node.js 20+, Bash, and curl, but do not require Docker or an NVIDIA GPU.

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
```

LAN:

```text
OpenAI:  http://<LAN IP>:5176/gateway/auto/openai/v1
Claude:  http://<LAN IP>:5176/gateway/auto/claude
OpenCode: http://<LAN IP>:5176/gateway/auto/opencode/v1
```

`auto` routes to the currently available vLLM or llama.cpp backend. Replace it with `vllm` or `llama` to pin a backend.

The optional subscription adapter uses explicit routes and is intentionally excluded from `auto`:

```text
OpenAI:  http://127.0.0.1:5176/gateway/subscription/openai/v1
Claude:  http://127.0.0.1:5176/gateway/subscription/claude
Codex:   http://127.0.0.1:5176/gateway/subscription/codex/v1
OpenCode:http://127.0.0.1:5176/gateway/subscription/opencode/v1
```

See [`docs/subscription-proxy-guide.md`](docs/subscription-proxy-guide.md) for setup, OAuth, and credential-boundary details.

### Client Setup Tips

- OpenWebUI / OpenAI SDK: use the OpenAI Base URL and `Authorization: Bearer <API_KEY>`.
- Claude Desktop / Cowork / ccswitch: use the Claude Base URL and prefer `ANTHROPIC_API_KEY`.
- OpenCode: use the OpenCode Base URL and start with `local-current` as the model name.

Generate API keys from the manager's service/external access page. Do not put real keys in screenshots, docs, or issues.

### vLLM vs llama.cpp

- Use **vLLM** for high throughput, OpenAI-compatible serving, Qwen tool calling, concurrency, and service-like behavior.
- Use **llama.cpp** for GGUF, lower VRAM use, heterogeneous GPUs, GPU layers/RAM fallback, and fast local quantized model loading.

### Security And Privacy

- Local mode listens on `127.0.0.1` by default.
- LAN mode is explicit and should be used with API keys.
- The release mirror excludes model files, caches, logs, databases, runtime ledgers, PID files, `.env`, and `node_modules`.
- Access statistics should contain metadata only: source IP, path, status code, model name, token counts, and latency.

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

### Build A GitHub Release Archive

Run from the project root:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-github-release.ps1
```

The script creates a versioned ZIP under `artifacts/github-release/` containing only release source, user documentation, and example configuration. It excludes dependencies, logs, models, caches, databases, PIDs, `.env`, machine-local proxy data, internal audit notes, and test artifacts. Before completing, it also checks for the current username, user profile, computer name, and common credential formats.
