# 本地模型服务运行手册

本文档记录当前模型服务平台的启动、对外访问、网关路径、日志和排错方式。它面向日常使用，不要求读代码。

模型路径、跨盘下载、已有模型接入和迁移回滚见 [模型存储指南](model-storage-guide.md)。

## 1. 组件

- `service-entry`：统一入口和一级控制台，默认端口 `5176`。
- `vllm-manager`：vLLM 管理器，默认端口 `5177`。
- `llama-manager`：llama.cpp 管理器，默认端口 `5178`。
- `tts-platform`：多引擎 TTS 聚合网关，默认端口 `7000`；worker 使用 `7011`~`7014`，均保持回环监听。
- `manager-core`：三者共用的网络、鉴权、健康检查和访问统计工具。

统一入口不直接跑模型。它负责启动/检查两个管理器，并提供统一网关，把 OpenAI、Claude、OpenCode 请求转发给正在运行的后端。

TTS 由独立脚本启动，统一入口负责健康展示、客户端 Key 校验、限流和流式反代，不会缓冲完整的参考音频上传。

## 2. 启动

首次使用先看 [快速上手](getting-started.md)。日常操作都通过 `platform` 命令：

```bat
platform start
platform start full
platform start --lan
platform status
platform doctor
platform stop
```

- `platform start`（等同 `platform start core`）启动统一入口和两个管理器，本机模式只监听 `127.0.0.1:5176`，浏览器以配对状态打开。`full` 再加 TTS 网关、MCP 和搜索网关（需要 Docker Desktop）。
- `--lan` 让统一入口监听 `0.0.0.0:5176`，其它设备才能访问。管理器仍只监听 `managers.bindHost`（默认 `127.0.0.1`）；需要局域网直连管理器时在 `platform.json` 里设置，`platform doctor` 会报告。
- `platform stop` 关闭控制台和管理器，不停止后台模型容器。需要卸载模型时，仍在对应管理器里使用“卸载模型”按钮；`platform stop --models` 会先列出并确认。

旧脚本保留原名和参数，现在只是转调 `platform.cmd` 的短脚本：

| 旧脚本 | 等同于 |
|---|---|
| `start-platform.cmd [core\|all] [lan]` | `platform start [core\|full] [--lan]` |
| `start-service-entry.cmd [lan]`、`start-service-entry-lan.cmd` | `platform start core [--lan] --open`（`SERVICE_ENTRY_NO_BROWSER=1` 不开浏览器） |
| `stop-service-entry.cmd`、`stop-platform.cmd [all]` | `platform stop entry vllm-manager llama-manager`、`platform stop core\|all` |
| `status-service-entry.cmd`、`status-platform.cmd` | `platform status` |
| `start\|stop\|status-platform-mcp.cmd` | `platform start\|stop\|status platform-mcp` |
| `start\|stop-search-gateway.cmd` | `platform start\|stop search-gateway` |
| `start-tts-platform.cmd [-GatewayOnly]` | `platform start tts-gateway tts-workers`（带 `-GatewayOnly` 时只启动网关） |
| `vllm-manager\start-manager.cmd`、`llama-manager\start-manager.cmd`（及 `stop-manager.cmd`） | `platform start\|stop vllm-manager\|llama-manager`，启动后打开该管理器页面 |

`status-tts-platform.cmd`、`update-platform.cmd` 和 `install-*.cmd` 不变。

## 3. 统一网关地址

本机：

- OpenAI 兼容：`http://127.0.0.1:5176/gateway/auto/openai/v1`
- Claude 兼容：`http://127.0.0.1:5176/gateway/auto/claude`
- OpenCode：`http://127.0.0.1:5176/gateway/auto/opencode/v1`
- TTS 网页：`http://127.0.0.1:5176/gateway/tts/`
- OpenAI Audio：`http://127.0.0.1:5176/gateway/tts/openai/v1`

局域网：

- OpenAI 兼容：`http://<本机局域网IP>:5176/gateway/auto/openai/v1`
- Claude 兼容：`http://<本机局域网IP>:5176/gateway/auto/claude`
- OpenCode：`http://<本机局域网IP>:5176/gateway/auto/opencode/v1`
- TTS 网页：`http://<本机局域网IP>:5176/gateway/tts/`
- OpenAI Audio：`http://<本机局域网IP>:5176/gateway/tts/openai/v1`

`auto` 会优先选择正在运行且监听中的后端。OpenCode 当前只走 vLLM。

## 4. 直接管理器地址

vLLM：

- 控制台：`http://127.0.0.1:5177/`
- OpenAI 网关：`http://127.0.0.1:5177/serve/v1`
- Claude 桥：`http://127.0.0.1:5177/claude`

llama.cpp：

- 控制台：`http://127.0.0.1:5178/`
- OpenAI 网关：`http://127.0.0.1:5178/serve/v1`
- Claude 桥：`http://127.0.0.1:5178/claude`

日常客户端优先使用 `service-entry` 的统一网关；只有排错时才建议直连管理器。

## 5. Docker 和局域网转发

有两层网络要分清：

- 管理器网关：Node.js 进程监听 `5177` 或 `5178`，负责鉴权、限流、Claude 桥接、统计。
- 模型容器：Docker 容器监听模型端口，由管理器根据启动配置发布到本机或局域网 IP。

局域网服务要真正可用，需要同时满足：

1. `service-entry` 以 `lan` 模式启动，统一入口监听 `0.0.0.0:5176`。
2. 对应管理器的“服务提供”页面选择局域网服务，并设置 API Key。
3. 启动模型时 Docker 端口发布到本机局域网 IP。
4. Windows 防火墙允许 Node.js / Docker Desktop 对应端口通过专用网络。

## 6. 鉴权

推荐每个客户端单独创建 API Key，并在管理器“服务提供”页面设置速率、并发和模型限制。

`/gateway/tts/*` 复用同一组客户端 Key。统一入口验证后会剥离客户端凭证，再转发到回环 TTS 网关；如设置了 TTS 自身的 `TTS_API_KEY`，同时在 service-entry 进程环境中设置相同的 `TTS_UPSTREAM_API_KEY`。

常见请求头：

- OpenAI / OpenWebUI / OpenCode：`Authorization: Bearer <API_KEY>`
- Claude / ccswitch：`ANTHROPIC_API_KEY: <API_KEY>` 或 `Authorization: Bearer <API_KEY>`

不要把真实 key 写进截图、文档或聊天记录。统计日志只记录认证字段来源，不记录 key 原文。

## 7. 访问统计

统一入口访问统计：

- 页面：`http://127.0.0.1:5176/`
- API：`http://127.0.0.1:5176/api/gateway-access`
- 日志：`service-entry\logs\gateway-access.log`

管理器外来访问统计：

- vLLM：`http://127.0.0.1:5177/#external-access`
- llama.cpp：`http://127.0.0.1:5178/#external-access`

统计只记录元数据，例如来源 IP、路径、状态码、模型名、token 数、耗时、认证字段来源，不记录用户聊天正文和模型响应正文。

## 8. 常见错误

### TTS 卡片显示离线

- 运行 `status-tts-platform.cmd` 检查 7000 与各 worker。
- 只恢复聚合网关可运行 `pwsh -File .\tts-platform\scripts\start_all.ps1 -GatewayOnly -NoBrowser`；不会重启已有 Step 容器或加载其它 TTS 模型。
- 参考音色、输出和 `.env` 位于 `tts-platform` 本机运行目录，不要从发布包覆盖或删除。

`401 Missing or invalid service API key`

- 客户端没有带 key，或者认证字段选错。
- Claude/ccswitch 优先选 `ANTHROPIC_API_KEY`。
- OpenAI/OpenWebUI/OpenCode 优先用 `Authorization: Bearer ...`。

`502 client error (Connect)`

- 网关能收到请求，但转发到上游失败。
- 检查模型容器是否还在跑、管理器是否能访问容器端口、Docker 是否启动。

`503 No matching manager is available`

- 统一入口没有找到可用管理器。
- 先打开 `http://127.0.0.1:5176/`，看 vLLM 或 llama manager 是否 running/listening。

`Configured model not available`

- 客户端请求的模型名没有被管理器 alias 接住。
- 用客户端的“获取模型列表”按钮检查实际模型名，或在管理器里配置 `local-current` / 自定义别名。

首次 token 很慢但后续快

- 通常是长上下文预填充、KV cache 分配、工具 schema 较大、跨 GPU 通信或模型刚冷启动。
- 本地 Claude 单路长任务建议先降低并发序列数，确认上下文长度和显存余量。

## 9. 安全默认值

- 默认启动脚本只开放本机。
- 局域网模式需要显式执行 `platform start --lan`（旧的 `start-service-entry.cmd lan` 等价）。
- 对外服务建议始终启用 API Key。
- 公网暴露前应使用反向代理、TLS、访问控制和速率限制。

## 10. 备份与例行检查

`powershell -File scripts\backup-platform.ps1 -Root <发布目录> -NoPrune` 会备份计费库、管理器账本、TTS 音色、历史音频、历史数据库及运行配置。TTS 默认数据目录是 `tts-platform`；如设置了 `TTS_DATA_ROOT` 或 `.env`，按配置定位。模型权重和环境不复制进日常备份。

每份备份附带 `backup-manifest.json`，并校验文件 SHA256 与 SQLite `integrity_check`。可用 `node scripts\verify-backup.js <备份目录>` 重新验证。备份含本机配置，目录 ACL 限定本机用户、管理员和 SYSTEM。保留期只清理带 v2 格式标识、来自同一发布目录的本脚本备份；历史手工备份不删除。

恢复时先停止计费入口和 TTS 网关，保存当前数据，按清单恢复数据库、`voices`、`outputs` 和对应配置，再启动网关并核对记录数与音频。不要直接覆盖运行中的 SQLite 数据库；代码回滚与数据回滚应分别核对。

`backup-platform.ps1 -Register` 安排每日 03:30 备份。`nightly-e2e.ps1 -Register -SkipUnitTests -PublicModelsUrl https://api.example.com/vllm/v1/models` 安排每日 03:00 运行状态检查，记录保存在 `artifacts/nightly/latest.json`。公网检查验证模型列表响应，或确认 401 鉴权边界可达；它不验证真实生成性能，也不把未加载模型当成已可推理。发布时仍须在干净包中运行完整 `test-all.cmd`。

TTS 停止操作依据 `TTS_RUNTIME_ROOT/state/gateway-process.json` 的进程身份记录，检查 PID、可执行文件、启动时间和工作目录后才停止。没有有效记录时保留现有进程，不能按 7000 端口盲目结束程序。

## 11. TTS 客户数据与用量

客户端 Key 新建的音色、生成历史和异步任务按客户隔离。历史无归属音色作为共享音色继续可读、可用于合成，只有本机或全局管理入口能修改；历史输出仍由本机管理。原有本机、全局 Key 和显式关闭鉴权的开放模式保持兼容，开放模式具有共享管理权限，客户隔离须与入口鉴权一起使用。

统一入口签名传递客户身份，TTS 只接受本机且签名有效的身份头。转发会替换来路身份头；兼容音频下载地址和批量重试也采用相同隔离与计量规则。TTS 静态界面可加载，数据请求沿用客户端 Key。

Hard 客户合成前按字符数、语速和引擎数估算时长，预留钱包和每日配额；零余额或配额不足时先拒绝请求。预留价格固定到该次请求。完成后按实际音频时长与成功字符数结算，批量请求在全部子任务结束后结算一次。入口重启、断线通过 SQLite 中的待结算记录和 TTS 完成凭据恢复核对；不可确认的请求保留待结算状态，上游明确不存在凭据超过 30 分钟后记为未完成。

估算不等于音频时长保证。实际时长超出估算且余额不足时扣到可用余额为止，以 `billing_tts_balance_capped` 标记差额，并保留完整预计费用；不会把客户余额扣成负数。Shadow 和未绑定客户只记用量。异步任务的并发、队列长度和等待超时沿用客户策略。
