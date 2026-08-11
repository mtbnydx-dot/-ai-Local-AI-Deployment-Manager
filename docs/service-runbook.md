# 本地模型服务运行手册

本文档记录当前模型服务平台的启动、对外访问、网关路径、日志和排错方式。它面向日常使用，不要求读代码。

## 1. 组件

- `service-entry`：统一入口和一级控制台，默认端口 `5176`。
- `vllm-manager`：vLLM 管理器，默认端口 `5177`。
- `llama-manager`：llama.cpp 管理器，默认端口 `5178`。
- `manager-core`：三者共用的网络、鉴权、健康检查和访问统计工具。

统一入口不直接跑模型。它负责启动/检查两个管理器，并提供统一网关，把 OpenAI、Claude、OpenCode 请求转发给正在运行的后端。

## 2. 启动

本机模式：

```bat
.\start-service-entry.cmd
```

局域网模式：

```bat
.\start-service-entry.cmd lan
```

也可以直接双击：

```bat
.\start-service-entry-lan.cmd
```

本机模式只监听 `127.0.0.1:5176`。局域网模式会让统一入口监听 `0.0.0.0:5176`，其它设备才能访问。

关闭控制台和管理器：

```bat
.\stop-service-entry.cmd
```

关闭脚本只关闭管理界面和管理器进程，不停止后台模型容器。需要卸载模型时，仍在对应管理器里使用“卸载模型”按钮。

## 3. 统一网关地址

本机：

- OpenAI 兼容：`http://127.0.0.1:5176/gateway/auto/openai/v1`
- Claude 兼容：`http://127.0.0.1:5176/gateway/auto/claude`
- OpenCode：`http://127.0.0.1:5176/gateway/auto/opencode/v1`

局域网：

- OpenAI 兼容：`http://<本机局域网IP>:5176/gateway/auto/openai/v1`
- Claude 兼容：`http://<本机局域网IP>:5176/gateway/auto/claude`
- OpenCode：`http://<本机局域网IP>:5176/gateway/auto/opencode/v1`

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
- 局域网模式需要显式执行 `start-service-entry.cmd lan`。
- 对外服务建议始终启用 API Key。
- 公网暴露前应使用反向代理、TLS、访问控制和速率限制。
