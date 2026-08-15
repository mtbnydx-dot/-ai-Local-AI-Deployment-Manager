# 自建平台级 MCP 接入指南

## 结论

本平台的 MCP 是一个独立、只读的工具服务，不属于某个模型，也不绑定 OpenWebUI。vLLM 继续提供推理；支持 MCP 的宿主软件负责让模型发现和调用工具；`platform-mcp` 只把本机管理平台已有的安全只读数据转换为标准 MCP 工具。

```text
OpenWebUI / Claude / Codex / IDE / 自建 Agent
                    │ MCP (HTTP 或 stdio)
                    ▼
          platform-mcp（只读工具层）
                    │ 固定 loopback API
                    ▼
 service-entry / vLLM manager / llama manager / search gateway
                    │
                    ▼
                  vLLM
```

这意味着任何软件只要自身支持 MCP，就可以复用这一个服务；软件不支持 MCP 时，需要在该软件的 Agent/网关层增加 MCP client，不能仅靠给本地模型换一段 system prompt。

## 当前安全边界

- Streamable HTTP：`http://127.0.0.1:5190/mcp`。
- Docker 宿主访问：`http://host.docker.internal:5190/mcp`。
- 本机进程也可用 `node D:\AI\platform-mcp\dist\src\index.js --stdio`。
- HTTP 仅监听 loopback，强制独立 Bearer key，并校验 Host 与 Origin。
- 上游地址固定为本机 `5176/5177/5178/5180`，调用方不能传任意 URL。
- 没有 shell、任意文件读取、下载、启动、停止、删除或配置写入工具。
- 工具响应不返回模型绝对路径、Docker labels、服务密钥或搜索上游 URL。
- 审计日志只记录请求 ID、工具名、客户端 ID、耗时和成功/失败，不记录参数、结果或密钥。

当前 0.2.0 版本故意不暴露远程写操作。需要启停 MCP 时使用本机脚本；模型和管理器不会随 MCP 启停而重启。

## 启动与检查

在 `D:\AI` 运行：

```cmd
install-all.cmd
start-platform-mcp.cmd
status-platform-mcp.cmd
```

升级或部署后，可在 `D:\AI\platform-mcp` 运行 `npm run validate:live`。验证器使用官方 MCP client 协商 2026-07-28 协议，逐一调用 12 个真实工具，并要求联网搜索有结果、工具路由可选；它只允许 loopback `/mcp`，从受保护的 `server.env` 内部读取 Bearer key，输出中不包含 key、模型路径、搜索内容或上游原始响应。

首次启动会在 `D:\AI\.runtime\platform-mcp\server.env` 生成随机 MCP 客户端密钥，并把目录 ACL 限制为当前 Windows 用户。启动脚本只显示密钥文件位置，不打印密钥内容。联网搜索所需的 search-gateway 密钥优先从进程 secret 注入，否则读取平台现有的受保护服务密钥文件；它不会被复制进 `server.env`，日志也只显示搜索已启用或未启用。

停止：

```cmd
stop-platform-mcp.cmd
```

停止脚本会验证 PID、命令行和监听端口的所有者，只终止 `platform-mcp` 进程。

## 工具目录

| 工具 | 用途 |
|---|---|
| `local_ai_get_overview` | 平台入口、管理器、运行模型数、GPU 和搜索健康概览 |
| `local_ai_list_running_models` | 按 vLLM/llama.cpp 查看正在运行或已知的实例与模型 |
| `local_ai_get_gpu_status` | GPU 总量、已用、空闲、预留和安全可分配显存 |
| `local_ai_list_local_models` | 分页读取本地模型与下载缓存的脱敏清单 |
| `local_ai_get_performance` | 请求、token、速度、延迟、缓存、推测解码和上下文指标 |
| `local_ai_get_diagnostics` | 只读健康检查；日志默认不返回，显式请求时最多返回 20 行且会脱敏 |
| `local_ai_get_search_health` | 检查现有 search-gateway 的健康、模式与鉴权状态 |
| `local_ai_search_web` | 经现有鉴权 search-gateway/SearXNG 联网搜索；每客户端限流，最多返回 10 条 |
| `local_ai_list_jobs` | 分页查询下载、serve、benchmark、test 任务摘要，不返回日志、命令、路径或 PID |
| `local_ai_preview_route` | 只预演请求会路由到哪个管理器、实例和模型，不发送推理 |
| `local_ai_estimate_memory` | 用当前 GPU 状态和管理器估算器评估模型、上下文、精度与并发的显存适配 |
| `local_ai_get_security_posture` | 汇总入口、MCP、搜索和两类管理器的脱敏暴露/鉴权态势 |

12 个工具都声明 `readOnlyHint=true`、`destructiveHint=false` 和 `idempotentHint=true`，并同时返回文本与 `structuredContent`。只有确实访问外部搜索引擎的 `local_ai_search_web` 声明 `openWorldHint=true`；其余 11 个为 `false`。

联网搜索的 query 可能被 SearXNG 配置的外部引擎接收，不要把密钥、私人提示词或内部路径放进 query。MCP 只返回规范化标题、公共 HTTP(S) URL、摘要、来源和日期；带账号密码的 URL、`file:` URL、localhost/RFC1918/链路本地/常见内网域名、search backend 地址及凭据字段会被丢弃或脱敏。默认限流为每个 MCP client 每分钟 20 次，并设有 4 倍于该值的 MCP 服务级硬上限，防止轮换客户端 ID 绕过；过期客户端桶会回收。客户端限额可用 `PLATFORM_MCP_SEARCH_RATE_LIMIT_PER_MINUTE` 在 1–120 之间调整。

## 各类客户端接入

### 通用 HTTP MCP 客户端

在客户端的 MCP server 配置中填写：

```text
Transport: Streamable HTTP
URL: http://127.0.0.1:5190/mcp
Header: Authorization: Bearer <从本机密钥存储读取>
```

若客户端自身运行在 Docker 中，把 URL 改为：

```text
http://host.docker.internal:5190/mcp
```

不要把 key 写进可提交的配置文件。泛化服务平台应把它存进自身 secret store，在发起 MCP 请求时注入 Header。

### OpenWebUI

OpenWebUI 只是 MCP client 之一。在管理员的 MCP/外部工具连接配置中添加 Streamable HTTP server，Docker 部署使用 `host.docker.internal` 地址并设置 Bearer Header。若同时保留 OpenWebUI 自带搜索，请在 Agent 策略里明确优先级，避免一次问题同时调用两套搜索；平台 MCP 的 `local_ai_search_web` 适合需要统一鉴权、限流和审计的场景。

### Claude Desktop、Claude Code、Codex 和本机 IDE

支持 stdio 的本机宿主可配置：

```json
{
  "mcpServers": {
    "local-ai-platform": {
      "command": "node",
      "args": [
        "D:\\AI\\platform-mcp\\dist\\src\\index.js",
        "--stdio"
      ],
      "env": {
        "AI_ROOT": "D:\\AI"
      }
    }
  }
}
```

stdio 由宿主直接创建本机子进程，因此不使用 HTTP Bearer key。不同软件的配置文件位置和字段外壳可能不同，但 `command`、`args` 和 `env` 这三个核心值相同。上述最小配置可使用 11 个纯平台查询工具；若还要使用 `local_ai_search_web`，宿主必须从自己的 secret store 向子进程注入 `PLATFORM_MCP_SEARCH_GATEWAY_API_KEY`。不要把真实值提交到 JSON、Git 或提示词。泛化服务平台优先复用常驻 HTTP MCP，可避免每个 stdio 宿主各自保存一份搜索密钥。

### 自建泛化服务平台

建议把 MCP 作为独立的“工具提供方”注册表，而不是写死到模型配置中。每条记录至少包含：

- server ID 与展示名；
- transport（HTTP/stdio）；
- endpoint 或本机 command；
- secret 引用，不存明文 Header；
- 允许调用它的租户/客户端；
- 通过 `tools/list` 动态发现的能力与 schema；
- 超时、并发上限、审计 client ID 和启用状态。

Agent 调用链应为：选择模型 → 读取授权后的 MCP 工具 → 把 tool schema 交给模型 → 校验 tool call → MCP client 执行 → 把结果回填模型。不要让模型自行拼接 HTTP 请求，也不要把 MCP key放入提示词。

## 管理平台接口

统一入口现提供：

- `GET /api/status`：新增脱敏的 `mcp` 状态字段；
- `GET /api/mcp/status`：返回监听、健康、版本、只读和鉴权状态；
- 管理首页摘要卡：显示 MCP 在线/异常/未启动。

现有管理 API 已足够支撑当前 12 个只读工具，无需为 MCP 复制一套模型或 GPU 接口。本次直接复用了 `/api/jobs?fields=summary`、`/api/fleet/route-preview`、`/api/memory-estimate`、`/api/security` 和 `/api/service-exposure`；唯一发现的参数缺口是 search-gateway 直搜未转发 `safesearch`，现已补齐并限制为 0/1/2。现有动态 MCP 状态接口也能直接显示 0.2.0 与 12 工具，因此管理平台当前没有其他必须补齐的读接口。

仍然缺少、且本阶段有意不补的是远程启停、模型切换、下载、任务取消和配置写入。以后若开放，需另建控制面并补充细粒度 scope、逐租户授权、确认/审批、幂等键、并发控制、完整参数审计和回滚，而不是把现有只读工具改成可写。

## 协议兼容与验证

服务使用 MCP TypeScript SDK v2，并由同一份工具定义同时服务 [2026-07-28 规范](https://modelcontextprotocol.io/specification/2026-07-28) 与旧版客户端：

- 2025 时代的 `initialize` + Stateless Streamable HTTP 客户端；
- 2026-07-28 的 `server/discover` + per-request envelope 客户端；
- stdio 客户端。

`npm test` 会验证两代 HTTP 握手、12 个工具的 schema 与结构化输出、认证、Host/Origin 防护、联网搜索限流和 URL 过滤、分页、路径/凭据脱敏、固定上游边界、上游响应大小限制，以及覆盖全部工具的十组固定快照评测。

## 故障排查

- `401`：Bearer Header 缺失或 key 不匹配。
- `403`：Host/Origin 不在本机白名单；Docker 客户端应使用 `host.docker.internal`。
- `health=offline`：运行 `start-platform-mcp.cmd`。
- `local_ai_search_web` 提示未配置：确认现有 search-gateway 服务密钥文件可读，或从 secret store 设置 `PLATFORM_MCP_SEARCH_GATEWAY_API_KEY` 后只重启 MCP。
- 搜索提示 rate limit：等待返回的秒数，或缩小/复用已有结果；不要靠提高结果上限绕过限流。
- 工具返回 `partial=true`：某个固定上游未响应；用 `status-service-entry.cmd` 和 `local_ai_get_diagnostics` 确认具体管理器。
- 需要轮换 key：先停止 MCP，备份后移走 `server.env`，再启动生成新 key，并同步更新客户端 secret store。旧 key 会立即失效。

审计文件位于 `D:\AI\audit-logs\platform-mcp.jsonl`；stdout/stderr 也在同一目录。它们都是本机运行数据，不进入 Git 或发布包。
