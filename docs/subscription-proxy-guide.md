# 订阅反代指南：CLIProxyAPI

## 先声明使用范围

反代能力不局限于“对外服务”。同一套入口可用于：

- 本机：应用和代理都运行在同一台电脑上。
- 局域网：手机、笔记本或另一台工作站连接这台服务机。
- 可选公网：仅在已配置 HTTPS、强 API Key、访问控制和可信隧道后使用。

本平台采用截图所示的 CLIProxyAPI 技术路线：CLIProxyAPI 负责你已获授权账号的 OAuth 登录、协议转换和模型路由，`service-entry` 只提供统一地址、状态展示和 HTTP/SSE 转发。

> CLIProxyAPI 是第三方开源项目，不是 OpenAI 官方组件。订阅计划、账号权限、配额和各服务商条款仍然适用。请只连接你有权使用的账号与服务。

## 架构与凭据边界

```text
本机 / 局域网 / 可选公网客户端
        ↓ HTTP/SSE + API Key
service-entry 127.0.0.1:5176
        ↓ API Key 原样透传
CLIProxyAPI 127.0.0.1:8317
        ↓ OAuth（由 CLIProxyAPI 管理）
已授权的订阅服务
```

`service-entry` 不读取或保存 CLIProxyAPI 的 OAuth 文件、账号口令或订阅凭据。客户端携带的 `Authorization`、`x-api-key` 或 `anthropic-api-key` 会原样交给 CLIProxyAPI 校验；统一入口日志只保存请求元数据，不保存提示词和响应正文。

## 1. 安装 CLIProxyAPI

macOS：

```bash
brew install cliproxyapi
brew services start cliproxyapi
```

Windows：从 [CLIProxyAPI Releases](https://github.com/router-for-me/CLIProxyAPI/releases) 下载与你的系统匹配的程序并运行。Linux 可使用项目官方安装方式。

官方资料：

- [快速开始](https://help.router-for.me/introduction/quick-start)
- [基础配置](https://help.router-for.me/configuration/basic)
- [CLIProxyAPI GitHub](https://github.com/router-for-me/CLIProxyAPI)

## 2. 只让 CLIProxyAPI 监听本机

在 CLIProxyAPI 的配置文件中至少确认以下内容：

```yaml
host: "127.0.0.1"
port: 8317

remote-management:
  allow-remote: false
  secret-key: ""

api-keys:
  - "replace-with-a-long-random-key"
```

默认建议让 CLIProxyAPI 只监听 `127.0.0.1`，不要直接把 8317 端口暴露给局域网或公网。需要远程使用时，让本项目的 `service-entry` 负责统一入口。

macOS 使用 Homebrew 服务时，配置文件通常在 `$(brew --prefix)/etc/cliproxyapi.conf`。其它安装方式可用：

```bash
cli-proxy-api --config /path/to/config.yaml
```

## 3. 完成 Codex OAuth 登录

macOS / Linux：

```bash
cli-proxy-api --codex-login
```

Windows：

```powershell
.\cli-proxy-api.exe --codex-login
```

无图形界面环境可追加 `--no-browser`，在另一台设备打开输出的登录地址。OAuth 回调默认需要本机端口 `1455`。登录流程和 OAuth 文件都由 CLIProxyAPI 管理。

参考：[Codex OAuth 配置](https://help.router-for.me/configuration/provider/codex)

## 4. 让本平台连接 CLIProxyAPI

默认无需改动，本平台会使用：

```text
CLIPROXY_ENABLED=1
CLIPROXY_BASE_URL=http://127.0.0.1:8317
CLIPROXY_STATUS_TIMEOUT_MS=2500
```

这些环境变量只保存上游地址和开关，不保存 CLIProxyAPI API Key。修改后重启 `service-entry`。

在控制台打开“订阅反代 · CLIProxyAPI”即可查看：

- `状态良好`：无需认证即可读取模型列表。
- `在线 · 调用需 Key`：CLIProxyAPI 已连通，状态探测因未携带 Key 返回 401/403，这是启用鉴权时的正常状态。
- `未连接`：CLIProxyAPI 未启动、端口不同或地址配置错误。

## 5. 统一入口地址

本机：

```text
OpenAI:  http://127.0.0.1:5176/gateway/subscription/openai/v1
Claude:  http://127.0.0.1:5176/gateway/subscription/claude
Codex:   http://127.0.0.1:5176/gateway/subscription/codex/v1
OpenCode:http://127.0.0.1:5176/gateway/subscription/opencode/v1
```

局域网模式先运行：

```powershell
.\start-service-entry.cmd lan
```

然后把地址中的 `127.0.0.1` 换成本机局域网 IP。可选公网地址由 `SERVICE_ENTRY_PUBLIC_BASE_URL` 生成；这只是地址声明，不会自动创建隧道、TLS 或防火墙规则。

订阅反代不会加入 `/gateway/auto/...`。这样本地模型的自动路由不会意外消耗订阅配额；需要订阅服务时应显式使用 `/gateway/subscription/...`。

## 6. 客户端示例

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:5176/gateway/subscription/claude
export ANTHROPIC_AUTH_TOKEN="replace-with-cliproxyapi-api-key"
export ANTHROPIC_MODEL="replace-with-model-from-v1-models"
```

模型名以 CLIProxyAPI 的 `/v1/models` 实际返回为准，不要长期依赖截图中的临时模型名。参考：[CLIProxyAPI 的 Claude Code 配置](https://help.router-for.me/agent-client/claude-code)。

### Codex

编辑 `~/.codex/config.toml`：

```toml
model = "<MODEL_FROM_V1_MODELS>"
model_provider = "local_subscription_proxy"

[model_providers.local_subscription_proxy]
name = "CLIProxyAPI through service-entry"
base_url = "http://127.0.0.1:5176/gateway/subscription/codex/v1"
experimental_bearer_token = "<CLIProxyAPI_API_KEY>"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

本项目统一入口当前支持 HTTP 与 SSE；若客户端必须使用 WebSocket，请按 CLIProxyAPI 官方文档直接连接 8317，并自行控制网络边界。参考：[CLIProxyAPI 的 Codex 客户端配置](https://help.router-for.me/agent-client/codex)。

### curl

列模型：

```bash
curl http://127.0.0.1:5176/gateway/subscription/openai/v1/models \
  -H "Authorization: Bearer <CLIProxyAPI_API_KEY>"
```

OpenAI Chat Completions：

```bash
curl http://127.0.0.1:5176/gateway/subscription/openai/v1/chat/completions \
  -H "Authorization: Bearer <CLIProxyAPI_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<MODEL_FROM_V1_MODELS>","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

Codex Responses：

```bash
curl http://127.0.0.1:5176/gateway/subscription/codex/v1/responses \
  -H "Authorization: Bearer <CLIProxyAPI_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<MODEL_FROM_V1_MODELS>","input":"hello"}'
```

## 7. 排错

- `401/403`：客户端没有携带 CLIProxyAPI `api-keys` 中配置的 Key，或认证字段不匹配。
- `502`：`service-entry` 无法连接 `CLIPROXY_BASE_URL`。
- `404`：客户端重复拼接了 `/v1`，或使用了 CLIProxyAPI 当前不支持的协议路径。
- 模型不可用：先调用 OpenAI 入口的 `/v1/models`，再使用返回的模型 ID。
- 公网不可用：`SERVICE_ENTRY_PUBLIC_BASE_URL` 不会自动部署反向隧道；仍需单独配置 HTTPS、DNS、防火墙与访问策略。

不要把 API Key、OAuth 文件、登录链接或回调中的授权信息提交到 Git 仓库、截图或聊天记录。
