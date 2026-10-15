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
├─ deploy/cloudflare/      # Cloudflare 隧道模板
├─ docs/                   # 使用手册与客户端连接指南
├─ package.json            # 根目录测试依赖，主要用于 Playwright smoke test
├─ playwright.config.cjs   # 浏览器烟测配置
├─ install-all.cmd         # 安装 Node 依赖
├─ install-download-cli.cmd # 创建模型下载专用的 Python 环境（hf / modelscope）
├─ install-tts-gateway.cmd # 用 uv 创建 TTS 网关 Python 3.12 环境
├─ update-platform.cmd     # 从 GitHub 安全 fast-forward 更新并复测
├─ test-all.cmd            # 运行核心测试
├─ platform.cmd            # 平台命令行（setup / start / stop / status / doctor）
├─ start-service-entry.cmd # 旧名：platform start core
├─ start-platform-mcp.cmd  # 旧名：platform start platform-mcp
├─ start-tts-platform.cmd  # 启动 TTS 网关与语音 worker
├─ status-tts-platform.cmd # 查看 TTS 端口与引擎状态
└─ start-service-entry-lan.cmd # 旧名：platform start core --lan
```

Qwen3.8-27B 的 vLLM MTP、SGLang DSpark 实测结果、管理器预设和接口字段见 [Qwen3.8-27B 本地加速与管理平台指南](docs/qwen38-acceleration-guide.md)。

平台 MCP（当前版本见 `platform-mcp/package.json`）提供只读工具，包括单次搜索、多查询研究、显式公网链接与搜索结果正文识别、页内定位、任务历史、路由预览、显存估算和安全态势。跨 Chatbox、OpenWebUI、Claude、Codex、IDE 和自建 Agent 复用 MCP 的架构、安全边界与配置示例见 [自建平台级 MCP 接入指南](docs/mcp-platform-guide.md)。

### 系统要求

- Windows 10/11。
- Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`：22.x 需 22.22.2 及以上，24.x 需 24.15.0 及以上，或 26 及更新版本（23、25 不在支持范围内）。search-gateway 依赖的 jsdom 要求这个范围；`platform` 启动前会检查版本，不符合时直接退出。
- Docker Desktop。
- NVIDIA 驱动；运行 vLLM/llama.cpp CUDA 容器时需要可用 GPU。
- Chrome 或 Edge；前端 smoke test 默认使用本机 Chrome，也可以设置 `PLAYWRIGHT_BROWSER_CHANNEL=msedge` 使用 Edge。
- TTS 功能需要 Python 3.12、`uv` 和 PowerShell 7；不用 TTS 时可不安装。
- 可选：Hugging Face CLI、ModelScope CLI、CUDA Toolkit。

### 快速开始

在发布目录根部运行：

```cmd
install-all
install-download-cli
platform setup
platform start
```

`install-download-cli` 创建独立的 `venvs\download-cli` 环境（需要 Python 3.10+），管理器用其中的 `hf` 和 `modelscope` 命令下载模型。`platform setup` 是首次运行向导（检查环境、选择模型目录、选择引擎和访问范围），`platform start` 启动入口和两个管理器；`platform start full` 再加 TTS、MCP 和搜索网关。需要 TTS 时另外运行 `install-tts-gateway.cmd`。完整步骤见 `docs/getting-started.md`，日常操作见 `docs/service-runbook.md`。运行测试属于开发步骤，见“测试”一节。

模型、缓存和运行数据默认保存在发布目录内。需要放到其它磁盘时，请在启动前设置 `AI_ROOT`；也可以分别用 `VLLM_MODELS_ROOT`、`LLAMA_MODELS_ROOT`、`HF_HOME` 和 `TTS_RUNTIME_ROOT` 覆盖模型、缓存或 TTS 运行目录。

浏览器打开：

```text
http://127.0.0.1:5176/
```

这是新版统一控制台（总览、部署、模型、引擎、Playground、观测、审计、访问、计费、语音、系统）。`/classic` 已退役，现在会跳转到 `/overview`。需要回到经典控制台时，打开 `http://127.0.0.1:5176/?ui=classic`，或设置环境变量 `SERVICE_ENTRY_CONSOLE_DEFAULT=classic`（也可在平台配置里设 `console.defaultUi` 为 `classic`）让根地址默认显示经典界面。vLLM / llama 管理器页面会显示一条可关闭的提示，链接到新版控制台。

如果要让局域网其它设备访问：

```cmd
platform start --lan
```

旧脚本 `start-service-entry-lan.cmd`、`start-service-entry.cmd lan` 仍可用，等同于 `platform start core --lan`。管理器默认只监听 `127.0.0.1`；需要局域网直连管理器时在 `platform.json` 里设置 `managers.bindHost`。

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

- 默认本机模式下，统一入口（5176）只监听 `127.0.0.1`。两个管理器（5177/5178）为了让 Docker 容器经 `host.docker.internal` 回连而监听 `0.0.0.0`：其它设备只能访问带 API Key 的模型网关接口，管理界面和管理 API 一律返回 403，除非显式设置 `VLLM_MANAGER_ALLOW_REMOTE=1` / `LLAMA_MANAGER_ALLOW_REMOTE=1`（默认 `0`）。不需要其它设备直连管理器时，建议在 Windows 防火墙中阻止 5177/5178 的入站连接。
- **统一入口是唯一的策略执行点**：`service-entry` 在转发前完成 Host/Origin 校验、API Key 鉴权和限流，再用签名请求头把真实客户端地址传给管理器。管理器只信任带有效签名的回环请求。
- TTS 的 7000 与 worker 端口保持回环监听；局域网客户端只能经 `/gateway/tts/` 访问，并复用统一入口的客户端 Key。参考音色和生成音频属于本机运行数据，不进入 Git 或发布包。
- 局域网模式（`start-service-entry.cmd lan`）**默认强制 API Key**。密钥在任一管理器的“对外服务”页生成，两个管理器的密钥都可用于统一网关。
- 浏览器跨域默认拒绝，需要时用 `SERVICE_ENTRY_ALLOWED_ORIGINS` 显式放行。
- 管理端点默认仅本机可用；局域网设备读取状态时会得到脱敏结果。
- 发布目录不会包含模型文件、缓存、日志、数据库、运行时账本、PID 文件、`.env` 或 `node_modules`。
- 访问统计只记录元数据，例如来源 IP、路径、状态码、模型名、token 数和耗时；不记录提示词或响应正文。
- 旧版本可能把模型的运行时 API Key 明文写进管理器任务账本。新版本在读取和写入账本时都会把密钥替换为 `<redacted>`。也可以在停止两个管理器后运行 `node scripts/scrub-job-ledgers.js` 预览清理结果（默认只读），确认后加 `--apply` 写回；该工具不会修改密钥存储。曾经出现在账本、日志或备份里的 Key 应视为已泄露：用新 Key 重启相关模型，再更新客户端配置。

#### 安全开关

全部通过环境变量控制，当前生效状态见启动横幅或 `GET /api/security`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SERVICE_ENTRY_REQUIRE_API_KEY` | `auto` | `auto` = 仅局域网模式强制；`1` = 始终强制；`0` = 关闭鉴权（可信局域网免密） |
| `SERVICE_ENTRY_ALLOW_LAN_ADMIN` | `0` | `1` = 允许局域网设备启停管理器、查看完整状态 |
| `SERVICE_ENTRY_ALLOWED_ORIGINS` | 空 | 逗号分隔的浏览器 Origin 白名单；`*` 表示全放行 |
| `SERVICE_ENTRY_ALLOWED_HOSTS` | 空 | 额外 Host 白名单，用于反向代理域名 |
| `SERVICE_ENTRY_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | 逗号分隔的可信代理地址段（平台配置 `trustedProxies.cidrs`）。只有来自这些地址的请求才会采信转发头里的客户端 IP。cloudflared 在本机进程运行时保持默认；只有 cloudflared 跑在容器里时才加入 Docker Desktop 网关所在地址段 |
| `SEARCH_GATEWAY_ALLOW_NO_KEY` | `false` | `true` = 允许 search-gateway 无密钥对外服务 |
| `AI_AUDIT_MAX_EXPORTS` / `AI_AUDIT_MAX_AGE_DAYS` | `30` / `90` | 审计导出保留份数与天数，`0` = 不限制 |

想在可信家庭局域网里免密使用并开放管理界面：

```cmd
set SERVICE_ENTRY_REQUIRE_API_KEY=0
set SERVICE_ENTRY_ALLOW_LAN_ADMIN=1
start-service-entry.cmd lan
```

### 性能与下载行为开关

2026-08-22 起的行为变化：下载停滞（默认 5 分钟无字节增长，包括 Xet 缓存）会终止下载进程但**保留全部已下载文件**，并按自动重试策略从本地续传；此前版本会删除部分文件且不重试。管理器状态热路径（docker/nvidia-smi/容器 /metrics）带 2 秒单飞缓存；任务进度通过 `GET /api/events`（SSE）推送，浏览器轮询自动降为安全网频率。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MODEL_DOWNLOAD_STALL_TIMEOUT_MS` | `300000` | 下载停滞判定时长；`0` = 关闭停滞检测 |
| `MODEL_DOWNLOAD_PROGRESS_INTERVAL_MS` | `10000` | 下载进度目录扫描间隔 |
| `MANAGER_STATUS_CACHE_MS` | `2000` | 管理器状态快照缓存 TTL |
| `MODEL_ACCESS_STATS_CACHE_MS` | `10000` | 访问统计聚合结果缓存 TTL；`0` = 每次重算 |
| `MODEL_REMOTE_SEARCH_CACHE_MS` | `90000` | HF/ModelScope 在线搜索结果缓存 TTL |
| `MODEL_REMOTE_INFO_CACHE_MS` | `300000` | 模型详情与下载体积预估缓存 TTL |
| `METRICS_HISTORY_FLUSH_MS` | `300000` | 指标历史落盘间隔（内存实时可读；`0` = 每次采样即写） |
| `STATS_SAMPLE_INTERVAL_MS` | `10000` | 管理器统计后台采样间隔（5000–60000）；统计页只读最新样本，不再触发引擎 /metrics 抓取 |

### 统一启动、公网模式与运维（2026-09-03）

- `platform start [core|full] [--lan]` 一次拉起入口 + 两个管理器（`full` 再加 TTS、MCP、搜索网关，搜索网关需要 Docker Desktop）；`platform stop`、`platform status`、`platform doctor` 对应停止、查看和自检。旧脚本 `start-platform.cmd [core|all] [lan]`、`stop-platform.cmd [all]`、`status-platform.cmd`、`start-service-entry.cmd`、`stop-service-entry.cmd` 等保留原名和参数，现在只是转调 `platform.cmd` 的短脚本。入口首页出现离线组件横幅（可一键拉起管理器，可选桌面通知）。
  - `platform start` 结束时按组件显示状态与地址，有失败时退出码非 0；`start-platform.cmd` 双击运行时仍会在结尾暂停，设置 `PLATFORM_NO_PAUSE=1` 可关闭。
  - `full` 默认只启动 TTS 网关；四个语音 worker 会加载大模型，需要时先设置 `TTS_START_WORKERS=1`（或运行 `start-tts-platform.cmd`）。
  - Docker Desktop 尚在启动时最多等待 `docker.waitTimeoutSec` 秒（默认 120；旧环境变量 `PLATFORM_DOCKER_WAIT_SECONDS` 仍被识别）。
  - `start-service-entry.cmd` 现在不再向管理器注入 `0.0.0.0`：管理器按 `managers.bindHost`（默认 `127.0.0.1`）监听，浏览器以配对状态打开；`SERVICE_ENTRY_NO_BROWSER=1` 保持浏览器关闭。`SERVICE_ENTRY_PORT`、`VLLM_MANAGER_PORT`、`LLAMA_MANAGER_PORT` 仍可改端口。
- 进程退出留痕：入口与两个管理器把 Ctrl+C / 控制台关闭 / 未捕获异常写入各自 `logs/process-exit.log`，并走正常关机流程；组件的 stdout/stderr 落到各自的 `logs/`（保留轮转副本）。
- 公网模式：入口首页顶部显示“本机 / 局域网 / 公网”模式与上线检查清单（API Key 强制、管理端点仅本机、CORS、HTTPS、Caddy 路径、防火墙）。`deploy/public/Caddyfile` 与 `deploy/cloudflare/` 只指向 PUBLIC 监听（5186），`scripts/setup-public.ps1` 把模板渲染到 `config/public/`（`-Apply` 才通过 `platform config set` 写设置）。鉴权失败风暴防护：`SERVICE_ENTRY_AUTH_FAIL_LIMIT`（默认 20 次/`SERVICE_ENTRY_AUTH_FAIL_WINDOW_SECONDS`=60 秒）后封禁 `SERVICE_ENTRY_AUTH_BAN_SECONDS`（600）秒，本机直连永不封禁。
- 统一入口新增：`GET /gateway/status`（需 Key：可用模型、在线组件、本 Key 限流余量与 TTS 配额）、`/gateway/search/*`（搜索网关）、`/gateway/mcp`（MCP，只读）、`GET /api/keys` 与首页“密钥总览”（两管理器客户端 Key 的状态 / 最近使用 / 到期）。搜索网关启动时若入口监听局域网则自动以入口 auto 路由为上游。
- 守护与备份：GPU 温度守护新增功耗墙提示（`powerGuardEnabled` 默认跟随温度守护，`powerLimitPct` 默认 97）；`scripts/backup-platform.ps1` 每日快照计费库 / TTS 历史库 / JSON 账本到 `backups/`（`-Register` 注册计划任务，`-KeepDays` 默认 14）；`scripts/nightly-e2e.ps1` 跑 test-all + 在线探活并写 `artifacts/nightly/`（`-Register` 每日 03:00）。
- TTS 用量进入计费：客户端 Key 的合成请求按秒数 / 字符数记账并支持每日秒数配额，见 `docs/billing-guide.md`。

### 可更新的参考数据

模型价格和 GPU 性能系数存放在 `manager-core/data/*.json`，都带 `asOf` 日期；数据超期时统计页会提示成本对比仅供粗略参考。把同名文件放到 `<AI_ROOT>/config/` 即可覆盖内置版本，无需改代码。

### 测试

开发、升级或改动脚本后，在已运行过 `install-all.cmd` 的目录中执行（完整运行需要几分钟，会在结尾汇总通过 / 跳过 / 失败的步骤）：

```cmd
test-all.cmd
```

其中的脚本编码检查要求受 Git 管理的 `*.cmd` / `*.ps1` 使用 CRLF 且没有 BOM（`node scripts/check-script-encoding.js`）；在没有 `.git` 的部署目录或发布包中该步骤会被跳过。

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

平台出问题时先运行 `platform doctor`，每条修复建议都链接到 [`docs/troubleshooting.md`](docs/troubleshooting.md) 的对应小节（含密钥回滚步骤）。

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
├─ deploy/cloudflare/      # Cloudflare Tunnel templates
├─ docs/                   # Runbooks and client setup guides
├─ package.json            # Root test dependencies, mainly Playwright smoke tests
├─ playwright.config.cjs   # Browser smoke-test configuration
├─ install-all.cmd         # Install Node dependencies
├─ install-download-cli.cmd # Create the dedicated model-download Python environment (hf / modelscope)
├─ install-tts-gateway.cmd # Create the Python 3.12 TTS gateway environment with uv
├─ update-platform.cmd     # Safe fast-forward GitHub update and validation
├─ test-all.cmd            # Run core tests
├─ platform.cmd            # Platform CLI (setup / start / stop / status / doctor)
├─ start-service-entry.cmd # Legacy name: platform start core
├─ start-platform-mcp.cmd  # Legacy name: platform start platform-mcp
├─ start-tts-platform.cmd  # Start the TTS gateway and workers
├─ status-tts-platform.cmd # Inspect TTS listeners and engines
└─ start-service-entry-lan.cmd # Legacy name: platform start core --lan
```

### Requirements

- Windows 10/11.
- Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`: 22.x from 22.22.2, 24.x from 24.15.0, or 26 and later (23 and 25 are not supported). The search gateway's jsdom dependency requires this range; `platform` checks the version and exits before starting anything when it does not match.
- Docker Desktop.
- NVIDIA driver and GPU access for vLLM/llama.cpp CUDA containers.
- Chrome or Edge. The frontend smoke test uses local Chrome by default; set `PLAYWRIGHT_BROWSER_CHANNEL=msedge` to use Edge.
- TTS requires Python 3.12, `uv`, and PowerShell 7; they are optional if TTS is not used.
- Optional: Hugging Face CLI, ModelScope CLI, and CUDA Toolkit.

### Quick Start

From the release root:

```cmd
install-all
install-download-cli
platform setup
platform start
```

`install-download-cli` creates the separate `venvs\download-cli` environment (Python 3.10+ required) whose `hf` and `modelscope` commands the managers use for model downloads. `platform setup` is the first-run wizard (checks the environment, picks model folders, engines and who may connect), and `platform start` starts the entry and both managers; `platform start full` adds TTS, MCP and the search gateway. Run `install-tts-gateway.cmd` as well when you use TTS. The full walk-through is `docs/getting-started.md`; daily operation is `docs/service-runbook.md`. Running the tests is a developer step; see "Testing".

Models, caches, and runtime data are stored inside the release directory by default. Set `AI_ROOT` before startup to use another drive, or override `VLLM_MODELS_ROOT`, `LLAMA_MODELS_ROOT`, `HF_HOME`, and `TTS_RUNTIME_ROOT` individually.

Open:

```text
http://127.0.0.1:5176/
```

This is the unified console (Overview, Deployments, Models, Engines, Playground, Observability, Audit, Access, Billing, Voice, System). `/classic` is retired and redirects to `/overview`. To roll back to the classic console, open `http://127.0.0.1:5176/?ui=classic`, or set `SERVICE_ENTRY_CONSOLE_DEFAULT=classic` (or `console.defaultUi` to `classic` in the platform config) so the root address serves it by default. The vLLM and llama manager pages show a dismissible banner that links to the new console.

To serve other LAN devices:

```cmd
platform start --lan
```

The old scripts `start-service-entry-lan.cmd` and `start-service-entry.cmd lan` still work and mean `platform start core --lan`. The managers bind `127.0.0.1` by default; set `managers.bindHost` in `platform.json` to reach them directly over the LAN.

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

Platform MCP (see `platform-mcp/package.json` for the current version) provides read-only tools, including single-query search, multi-query research, bounded explicit-URL and result-page reading, in-page passage finding, job history, route preview, memory-fit estimation, and security posture. For the reusable MCP architecture, security boundary, and setup examples for Chatbox, OpenWebUI, Claude, Codex, IDEs, and custom agents, see the [self-hosted platform MCP guide](docs/mcp-platform-guide.md).

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

- In local mode the unified entry (5176) listens on `127.0.0.1` only. The two managers (5177/5178) listen on `0.0.0.0` so Docker containers can reach them through `host.docker.internal`. Other devices can use only their API-key model gateway routes; the management UI and API answer 403 unless `VLLM_MANAGER_ALLOW_REMOTE=1` / `LLAMA_MANAGER_ALLOW_REMOTE=1` is set (default `0`). If no other device needs direct manager access, block inbound 5177/5178 in Windows Firewall.
- `service-entry` is the single policy enforcement point. It validates Host/Origin, authenticates the API key, and applies rate limits before proxying, then signs the loopback hop with the real client address. Managers treat an unsigned hop that claims to come from the gateway as remote.
- LAN mode requires an API key by default. Generate one on either manager's service page; both managers' keys work at the unified gateway.
- Browser CORS is deny-by-default; allow origins explicitly with `SERVICE_ENTRY_ALLOWED_ORIGINS`.
- Management endpoints are local-only by default, and LAN status reads are redacted.
- The release mirror excludes model files, caches, logs, databases, runtime ledgers, PID files, `.env`, and `node_modules`.
- Access statistics contain metadata only: source IP, path, status code, model name, token counts, and latency.
- Older versions could write a model's runtime API key in plain text into the manager job ledgers. Current versions replace secrets with `<redacted>` whenever a ledger is read or written. To clean the files offline, stop both managers, run `node scripts/scrub-job-ledgers.js` to preview the changes (it is read-only by default), then add `--apply` to write them; the tool never touches the key store. Treat any key that ever appeared in a ledger, log, or backup as exposed: restart the affected models with new keys, then update the clients.

#### Security switches

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERVICE_ENTRY_REQUIRE_API_KEY` | `auto` | `auto` = required only when bound off-loopback; `1` = always; `0` = disable auth (trusted LAN) |
| `SERVICE_ENTRY_ALLOW_LAN_ADMIN` | `0` | `1` = let LAN devices start/stop managers and read full status |
| `SERVICE_ENTRY_ALLOWED_ORIGINS` | empty | Comma-separated browser Origin allowlist; `*` allows all |
| `SERVICE_ENTRY_ALLOWED_HOSTS` | empty | Extra Host allowlist for reverse-proxy domains |
| `SERVICE_ENTRY_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | Comma-separated trusted proxy address ranges (platform config `trustedProxies.cidrs`). Forwarded client-IP headers are believed only from these addresses. Keep the default when cloudflared runs as a local process; add the Docker Desktop gateway range only if cloudflared runs in a container |
| `SEARCH_GATEWAY_ALLOW_NO_KEY` | `false` | `true` = let search-gateway serve without a key |
| `AI_AUDIT_MAX_EXPORTS` / `AI_AUDIT_MAX_AGE_DAYS` | `30` / `90` | Audit export retention by count and age; `0` disables the limit |

### Performance And Download Behavior

Behavior changes as of 2026-08-22: a stalled download (no byte growth for 5 minutes by default, Xet cache included) terminates the download process but **keeps every downloaded file** and resumes through the auto-retry policy; earlier versions deleted the partial files without retrying. Manager status hot paths (docker/nvidia-smi/container /metrics) sit behind a 2-second single-flight cache, and job progress is pushed over `GET /api/events` (SSE) with browser polling reduced to a safety net.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODEL_DOWNLOAD_STALL_TIMEOUT_MS` | `300000` | Download stall threshold; `0` disables stall detection |
| `MODEL_DOWNLOAD_PROGRESS_INTERVAL_MS` | `10000` | Download progress scan interval |
| `MANAGER_STATUS_CACHE_MS` | `2000` | Manager runtime snapshot cache TTL |
| `MODEL_ACCESS_STATS_CACHE_MS` | `10000` | Access statistics aggregation cache TTL; `0` recomputes every request |
| `MODEL_REMOTE_SEARCH_CACHE_MS` | `90000` | HF/ModelScope online search cache TTL |
| `MODEL_REMOTE_INFO_CACHE_MS` | `300000` | Model info and download size estimate cache TTL |
| `METRICS_HISTORY_FLUSH_MS` | `300000` | Metrics history flush interval (reads stay in-memory; `0` writes every sample) |
| `STATS_SAMPLE_INTERVAL_MS` | `10000` | Manager stats background sampling interval (5000-60000); the stats page reads the newest sample and never triggers an engine /metrics scrape |

### Unified Startup, Public Mode And Operations (2026-09-03)

- `platform start [core|full] [--lan]` starts the entry and both managers (`full` adds TTS, MCP and the Docker-based search gateway); `platform stop`, `platform status` and `platform doctor` stop, inspect and self-check. The old scripts `start-platform.cmd [core|all] [lan]`, `stop-platform.cmd [all]`, `status-platform.cmd`, `start-service-entry.cmd`, `stop-service-entry.cmd` and the rest keep their names and arguments, and are now short shims that call `platform.cmd`. The entry page shows an offline-component banner with one-click manager start and optional desktop notifications.
  - `platform start` ends with each component's state and address and exits non-zero when something failed. A double-clicked `start-platform.cmd` still pauses at the end; `PLATFORM_NO_PAUSE=1` turns that off.
  - `full` starts only the TTS gateway. The four voice workers load large models, so set `TTS_START_WORKERS=1` first when you want them (or run `start-tts-platform.cmd`).
  - While Docker Desktop is still starting, the CLI waits up to `docker.waitTimeoutSec` (default 120); the old `PLATFORM_DOCKER_WAIT_SECONDS` variable is still understood.
  - `start-service-entry.cmd` no longer injects `0.0.0.0` into the managers: they bind `managers.bindHost` (default `127.0.0.1`), and the browser opens paired. `SERVICE_ENTRY_NO_BROWSER=1` keeps the browser closed. `SERVICE_ENTRY_PORT`, `VLLM_MANAGER_PORT` and `LLAMA_MANAGER_PORT` still change the ports.
- Exit traces: the entry and both managers write Ctrl+C / console close / uncaught errors to their own `logs/process-exit.log` and run the normal shutdown; component stdout/stderr go to their own `logs/` with rotated copies.
- Public mode: the entry page shows the local / LAN / public exposure and a go-live checklist (API key enforced, management local-only, CORS, HTTPS, Caddy paths, firewall). `deploy/public/Caddyfile` and `deploy/cloudflare/` target only the PUBLIC listener (5186); `scripts/setup-public.ps1` renders the templates into `config/public/` (settings change only with `-Apply`, through `platform config set`). Auth-failure guard: `SERVICE_ENTRY_AUTH_FAIL_LIMIT` (20) failures within `SERVICE_ENTRY_AUTH_FAIL_WINDOW_SECONDS` (60) ban the source for `SERVICE_ENTRY_AUTH_BAN_SECONDS` (600); local direct callers are never banned.
- New entry surfaces: `GET /gateway/status` (key required: models, online components, this key's rate-limit remaining and TTS quota), `/gateway/search/*` (search gateway), `/gateway/mcp` (read-only MCP), `GET /api/keys` and the "密钥总览" section (client keys across both managers with state, last use and expiry). The search gateway picks the entry auto route as upstream when the entry listens on the LAN.
- Guards and backups: the GPU temperature guard gained a power-wall hint (`powerGuardEnabled` follows the temperature guard, `powerLimitPct` default 97); `scripts/backup-platform.ps1` snapshots the billing database, TTS history and JSON ledgers into `backups/` daily (`-Register`, `-KeepDays` 14); `scripts/nightly-e2e.ps1` runs test-all plus live probes into `artifacts/nightly/` (`-Register` at 03:00).
- TTS usage is billed: synthesis through a client key is metered by audio seconds and characters with a daily seconds quota; see `docs/billing-guide.md`.

### Updatable Reference Data

Model pricing and GPU performance factors live in `manager-core/data/*.json` with an `asOf` date. Drop a file of the same name into `<AI_ROOT>/config/` to override the bundled copy. When the data is past its refresh window, the stats view labels the cost comparison as approximate.

### Testing

After development, an upgrade, or a script change, run this in a directory where `install-all.cmd` has already run. A full run takes a few minutes and ends with a summary of passed, skipped and failed steps:

```cmd
test-all.cmd
```

Its script encoding step requires git-tracked `*.cmd` / `*.ps1` files to use CRLF without a BOM (`node scripts/check-script-encoding.js`); it is skipped in a deployed directory or release package that has no `.git`.

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

When something is wrong, run `platform doctor` first; every suggested fix links to a section of [`docs/troubleshooting.md`](docs/troubleshooting.md) (Chinese; includes the secret rollback steps).

### Build A GitHub Release Archive

Run from the project root:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-github-release.ps1
```

The script keeps a Git-ready versioned directory and creates a matching ZIP under `artifacts/github-release/`. Both contain only release source, user documentation, and example configuration. It excludes dependencies, logs, models, caches, databases, PIDs, `.env`, machine-local proxy data, internal audit notes, and test artifacts. Before completing, it also checks for the current username, user profile, computer name, and common credential formats.
