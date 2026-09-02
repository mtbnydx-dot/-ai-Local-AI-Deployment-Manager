# 客户端连接指南

本文档用于把本机模型服务接入 OpenWebUI、ccswitch、Claude Desktop/Cowork、OpenCode 和常规 OpenAI SDK。

示例里的 `<HOST>` 可以替换为：

- 本机：`127.0.0.1`
- 局域网设备访问：本机局域网 IP，例如 `192.168.1.27`

如果从另一台电脑访问，必须先用局域网模式启动：

```bat
.\start-service-entry.cmd lan
```

也可以直接双击发布目录根部的 `start-service-entry-lan.cmd`。

## 1. 推荐总入口

OpenAI 兼容 Base URL：

```text
http://<HOST>:5176/gateway/auto/openai/v1
```

Claude 兼容 Base URL：

```text
http://<HOST>:5176/gateway/auto/claude
```

OpenCode Base URL：

```text
http://<HOST>:5176/gateway/auto/opencode/v1
```

`auto` 会自动转发到可用的 vLLM 或 llama 后端。想固定后端时，把 `auto` 换成 `vllm` 或 `llama`。

## 2. ccswitch / Claude Cowork

推荐配置：

- API 格式：`Anthropic Messages` 或 `Claude 原生`
- 请求地址/Base URL：`http://<HOST>:5176/gateway/auto/claude`
- 认证字段：`ANTHROPIC_API_KEY`
- API Key：填管理器“服务提供”页面生成的 key
- 模型名：优先用管理器返回的模型列表；不确定时用 `local-current` 或你在管理器里设置的 alias

如果 ccswitch 开了“完整 URL”：

```text
http://<HOST>:5176/gateway/auto/claude/v1/messages
```

不要在 Base URL 模式下手动加 `/v1/messages`。很多客户端会自己拼路径，重复拼接会导致 404 或 502。

## 3. Claude Desktop

Claude Desktop 通过 ccswitch 或类似网关转发时，按上一节配置。

如果转发器要求环境变量名：

```text
ANTHROPIC_API_KEY
```

如果转发器要求请求头：

```text
anthropic-api-key: <API_KEY>
```

也可以使用：

```text
Authorization: Bearer <API_KEY>
```

但 Claude 类客户端优先用 `ANTHROPIC_API_KEY`，兼容性更直观。

## 4. OpenWebUI

连接 OpenAI 兼容接口：

- Base URL：`http://<HOST>:5176/gateway/auto/openai/v1`
- API Key：管理器生成的 key
- 模型：点击获取模型列表；不确定时用 `local-current`

从 Docker 里的 OpenWebUI 访问 Windows 主机时，常见主机名可能是：

```text
http://host.docker.internal:5176/gateway/auto/openai/v1
```

如果 OpenWebUI 容器跑在另一台机器上，就使用本机局域网 IP。

## 5. OpenCode

Base URL：

```text
http://<HOST>:5176/gateway/auto/opencode/v1
```

OpenCode 当前建议走 vLLM。统一入口会把 `opencode` 自动转到 vLLM manager。

认证：

```text
Authorization: Bearer <API_KEY>
```

模型名不要写死成云端模型名，优先获取后端模型列表，或使用管理器配置的 alias。

## 6. OpenAI SDK / curl

获取模型：

```bash
curl http://<HOST>:5176/gateway/auto/openai/v1/models \
  -H "Authorization: Bearer <API_KEY>"
```

聊天补全：

```bash
curl http://<HOST>:5176/gateway/auto/openai/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"local-current\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}],\"stream\":false}"
```

Claude Messages：

```bash
curl http://<HOST>:5176/gateway/auto/claude/v1/messages \
  -H "ANTHROPIC_API_KEY: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"local-current\",\"max_tokens\":128,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

## 7. 模型名建议

客户端报 `Configured model not available` 时，通常不是网络错，而是模型名没有映射。

建议顺序：

1. 先点客户端里的“获取模型列表”。
2. 如果客户端必须手动填，先用 `local-current`。
3. 如果要伪装成 Claude/GPT 名称，在管理器“服务提供/客户端”里配置 alias。
4. 不要直接填 `claude-opus-4-7`，除非管理器里明确把它映射到当前本地模型。

## 8. 快速判断错误

- 连接失败：IP、端口、防火墙、是否用 `lan` 启动。
- 401：API Key 或认证字段不对。
- 404：URL 模式错，Base URL 和完整 URL 混用了。
- 502：网关收到请求，但后端模型服务不可达。
- 503：统一入口找不到可用管理器。
- 模型不可用：模型名或 alias 配置错。

## 9. 隐私和审计

统一入口和管理器统计只记录访问元数据，不记录提示词和回答正文。

如果需要完整对话审计，应只在受控本机上开启，并把查看页面放在密码保护后面。
