# Local Model Service Platform / 本地模型服务平台

一个面向高端个人工作站和小团队局域网的本地大模型服务控制台。它把 vLLM、llama.cpp、模型下载、显存估算、多 GPU 配置、OpenAI/Claude 兼容接口、局域网服务、访问统计和基础审计整合在同一套本地管理工具里。

This is a local model service control panel for high-end personal workstations and small LAN teams. It combines vLLM, llama.cpp, model download workflows, VRAM estimation, multi-GPU configuration, OpenAI/Claude-compatible gateways, LAN serving, access statistics, and basic audit exports in one local toolkit.

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
├─ docs/                   # 使用手册和设计/审计文档
├─ package.json            # 根目录测试依赖，主要用于 Playwright smoke test
├─ playwright.config.cjs   # 浏览器烟测配置
├─ install-all.cmd         # 安装 Node 依赖
├─ test-all.cmd            # 运行核心测试
├─ start-service-entry.cmd # 启动本机模式
└─ start-service-entry-lan.cmd # 启动局域网模式
```

### 系统要求

- Windows 10/11。
- Node.js 20 或更高版本。
- Docker Desktop。
- NVIDIA 驱动；运行 vLLM/llama.cpp CUDA 容器时需要可用 GPU。
- Chrome 或 Edge；前端 smoke test 默认使用本机 Chrome，也可以设置 `PLAYWRIGHT_BROWSER_CHANNEL=msedge` 使用 Edge。
- 可选：Hugging Face CLI、ModelScope CLI、CUDA Toolkit、PowerShell 7。

### 快速开始

在发布目录根部运行：

```cmd
install-all.cmd
test-all.cmd
start-service-entry.cmd
```

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
```

局域网：

```text
OpenAI:  http://<本机局域网 IP>:5176/gateway/auto/openai/v1
Claude:  http://<本机局域网 IP>:5176/gateway/auto/claude
OpenCode: http://<本机局域网 IP>:5176/gateway/auto/opencode/v1
```

`auto` 会自动选择当前可用的 vLLM 或 llama.cpp 后端。需要固定后端时，可以把 `auto` 换成 `vllm` 或 `llama`。

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

### 发布同步

开发目录里的成品同步到 `github-release`：

```cmd
sync-github-release.cmd
```

同步脚本会复制源码和文档，并主动移除发布目录里的运行时残留，例如 `node_modules`、`logs`、`models`、`cache`、数据库和密钥文件。

发布到 GitHub 前请使用 `git add -A`，因为项目拆分后经常会新增 `manager-core/*`、`*/lib/*`、`public/js/*` 和测试文件；只用 `git commit -am` 会漏掉新文件。

```cmd
sync-github-release.cmd
cd github-release
git status -sb
git add -A
git commit -m "Update local model service platform"
git push origin main
```

建议每次发布前在 `github-release` 目录再跑一遍：

```cmd
install-all.cmd
test-all.cmd
```

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
├─ docs/                   # Runbooks, design notes, and audit documents
├─ package.json            # Root test dependencies, mainly Playwright smoke tests
├─ playwright.config.cjs   # Browser smoke-test configuration
├─ install-all.cmd         # Install Node dependencies
├─ test-all.cmd            # Run core tests
├─ start-service-entry.cmd # Start local-only mode
└─ start-service-entry-lan.cmd # Start LAN mode
```

### Requirements

- Windows 10/11.
- Node.js 20 or newer.
- Docker Desktop.
- NVIDIA driver and GPU access for vLLM/llama.cpp CUDA containers.
- Chrome or Edge. The frontend smoke test uses local Chrome by default; set `PLAYWRIGHT_BROWSER_CHANNEL=msedge` to use Edge.
- Optional: Hugging Face CLI, ModelScope CLI, CUDA Toolkit, PowerShell 7.

### Quick Start

From the release root:

```cmd
install-all.cmd
test-all.cmd
start-service-entry.cmd
```

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
```

LAN:

```text
OpenAI:  http://<LAN IP>:5176/gateway/auto/openai/v1
Claude:  http://<LAN IP>:5176/gateway/auto/claude
OpenCode: http://<LAN IP>:5176/gateway/auto/opencode/v1
```

`auto` routes to the currently available vLLM or llama.cpp backend. Replace it with `vllm` or `llama` to pin a backend.

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

### Release Sync

To sync the working project into `github-release`:

```cmd
sync-github-release.cmd
```

The sync script copies source files and docs, then removes runtime leftovers such as `node_modules`, `logs`, `models`, `cache`, databases, and secret files from the release mirror.

Before pushing to GitHub, always stage with `git add -A`. The project now has many split modules and generated release-safe source files; `git commit -am` does not add new files.

```cmd
sync-github-release.cmd
cd github-release
git status -sb
git add -A
git commit -m "Update local model service platform"
git push origin main
```

Recommended release check:

```cmd
install-all.cmd
test-all.cmd
```
