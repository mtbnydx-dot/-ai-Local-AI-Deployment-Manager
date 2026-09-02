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
- 本机进程也可在平台根目录运行 `node .\platform-mcp\dist\src\index.js --stdio`。
- HTTP 仅监听 loopback，强制独立 Bearer key，并校验 Host 与 Origin。
- 管理和搜索上游地址固定为本机 `5176/5177/5178/5180`；只有显式网页读取工具接受公网 HTTP(S) URL，并由网关执行 DNS、跳转、端口和响应体安全校验。
- 没有 shell、任意文件读取、下载、启动、停止、删除或配置写入工具。
- 工具响应不返回模型绝对路径、Docker labels、服务密钥或搜索上游 URL。
- 审计日志只记录请求 ID、工具名、客户端 ID、耗时和成功/失败，不记录参数、结果或密钥。

当前 0.5.0 版本故意不暴露远程写操作。需要启停 MCP 时使用本机脚本；模型和管理器不会随 MCP 启停而重启。

## 启动与检查

在 `<AI_ROOT>` 运行：

```cmd
install-all.cmd
start-platform-mcp.cmd
status-platform-mcp.cmd
```

升级或部署后，可在 `<AI_ROOT>\platform-mcp` 运行 `npm run validate:live`。验证器使用官方 MCP client 协商 2026-07-28 协议，逐一调用 16 个真实工具，并要求单次搜索、批量研究、显式公网链接读取、搜索结果正文读取、页内查找和工具路由均实际可用；它只允许 loopback `/mcp`，从受保护的 `server.env` 内部读取 Bearer key，输出中不包含 key、模型路径、搜索内容或上游原始响应。

首次启动会在 `<AI_ROOT>\.runtime\platform-mcp\server.env` 生成随机 MCP 客户端密钥，并把目录 ACL 限制为当前 Windows 用户。启动脚本只显示密钥文件位置，不打印密钥内容。联网搜索所需的 search-gateway 密钥优先从进程 secret 注入，否则读取平台现有的受保护服务密钥文件；它不会被复制进 `server.env`，日志也只显示搜索已启用或未启用。

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
| `local_ai_search_web` | 单次联网搜索；返回质量、部分失败、引擎状态、`search_id/result_id`，最多 20 条 |
| `local_ai_research_web` | 用 1–8 个互补查询做一次受限研究，按域名和来源类型覆盖合并去重，最多 40 个来源 |
| `local_ai_open_web_page` | 直接识别 1–3 个已知公网链接中的 HTML、PDF、JSON、XML/RSS 和文本正文/元数据 |
| `local_ai_read_search_result` | 识别近期结果中的 HTML、PDF、JSON、XML/RSS 和文本正文/元数据；不接受任意 URL |
| `local_ai_find_in_search_result` | 在一个近期结果页内定位短语或同时包含全部词项的段落，PDF 尽量返回页码 |
| `local_ai_list_jobs` | 分页查询下载、serve、benchmark、test 任务摘要，不返回日志、命令、路径或 PID |
| `local_ai_preview_route` | 只预演请求会路由到哪个管理器、实例和模型，不发送推理 |
| `local_ai_estimate_memory` | 用当前 GPU 状态和管理器估算器评估模型、上下文、精度与并发的显存适配 |
| `local_ai_get_security_posture` | 汇总入口、MCP、搜索和两类管理器的脱敏暴露/鉴权态势 |

16 个工具都声明 `readOnlyHint=true`、`destructiveHint=false` 和 `idempotentHint=true`，并同时返回文本与 `structuredContent`。五个联网搜索/研究/显式链接/结果正文/页内查找工具声明 `openWorldHint=true`；其余 11 个为 `false`。

联网搜索的 query 可能被 SearXNG 配置的外部引擎接收，不要把密钥、私人提示词或内部路径放进 query。本机对中英文多轮逐引擎和连续请求实测后，默认主池只用快速且相关性稳定的 SearchToday；只有主结果为空、弱或不足 3 条时，才用 Yandex 做一次末级回退。PrivacyWall 虽然相关性好，但连续请求后会进入限流；Brave 同样频繁限流，Bing 有严重跑题，DuckDuckGo、Startpage、Baidu 持续 CAPTCHA/拒绝访问，Google 在本机 JSON 搜索返回空结果，360 Search 则会间歇性静默返回空结果，因此都不参与自动池，但仍可显式指定。需要更广覆盖时用 `local_ai_research_web` 拆分角度，而不是让每次请求同时消耗一组不稳定引擎。网关会解析 `unresponsive_engines`、按 CAPTCHA/429/超时设置冷却、最多并发两个后端请求、合并同一在途请求，并对正常/弱结果使用不同的短缓存。结果先规范 URL、去跟踪参数和重复项，过滤极低相关候选与搜索套搜索页面，再按词法相关性、官方/偏好域名和域名多样性排序；同时显式返回 `quality`、`partial`、失败引擎、修正和建议，弱结果不会伪装成完整结果。

`local_ai_read_search_result` 和 `local_ai_find_in_search_result` 只能使用网关签发的近期 `search_id/result_id`；`local_ai_open_web_page` 则用于用户粘贴或上下文中已经明确给出的 1–3 个公网链接，不负责发现页面。三者共用同一安全读取器：每次 DNS 解析和跳转都会重新校验并固定到公网地址；阻止 localhost、私网/链路本地/保留地址、账号密码 URL、非标准端口、非 HTTP(S)、未知二进制和超限响应。HTML 使用 Mozilla Readability 与 DOM 回退识别正文并解析 JSON-LD、作者、日期、规范链接、语言和标题层级；PDF.js 提取有文本层的 PDF 并保留页码标记；JSON、XML/RSS、Markdown、CSV 和纯文本也使用独立的受限解析。所有内容仍属于不可信外部文本，不能把其中指令当作系统指令或授权。JS-only 页面、登录墙、验证码、付费墙和纯扫描 PDF 可能无法识别；当前不会执行页面脚本、携带浏览器 cookie 或做 OCR。默认限流为每个 MCP client 每分钟 20 个工作单元，批量查询和多页读取按数量计费，并设有 4 倍服务级硬上限。客户端限额可用 `PLATFORM_MCP_SEARCH_RATE_LIMIT_PER_MINUTE` 在 1–120 之间调整。

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
        "D:\\AI\\platform-mcp\\scripts\\run-stdio.mjs"
      ],
      "env": {
        "AI_ROOT": "D:\\AI"
      }
    }
  }
}
```

stdio 由宿主直接创建本机子进程，因此不使用 HTTP Bearer key。`run-stdio.mjs` 会先验证已构建入口，再从环境 secret 或本机受保护的现有服务密钥文件读取 search-gateway 凭据，不打印也不复制凭据。不同软件的配置文件位置和字段外壳可能不同，但 `command`、`args` 和 `env` 三个核心值相同。Chatbox 采用上面的脚本即可发现全部 16 个工具；若宿主有自己的 secret store，也可显式注入 `PLATFORM_MCP_SEARCH_GATEWAY_API_KEY`。不要把真实值提交到 JSON、Git 或提示词。

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

现有管理 API 已足够支撑当前 16 个只读工具，无需为 MCP 复制一套模型或 GPU 接口。平台管理类工具继续复用既有安全摘要接口；搜索侧由 search-gateway 提供 `/research`、`/open`、`/read`、`/find` 和语义健康字段。现有动态 MCP 状态接口会显示 0.5.0 与 16 工具。

仍然缺少、且本阶段有意不补的是远程启停、模型切换、下载、任务取消和配置写入。以后若开放，需另建控制面并补充细粒度 scope、逐租户授权、确认/审批、幂等键、并发控制、完整参数审计和回滚，而不是把现有只读工具改成可写。

## 协议兼容与验证

服务使用 MCP TypeScript SDK v2，并由同一份工具定义同时服务 [2026-07-28 规范](https://modelcontextprotocol.io/specification/2026-07-28) 与旧版客户端：

- 2025 时代的 `initialize` + Stateless Streamable HTTP 客户端；
- 2026-07-28 的 `server/discover` + per-request envelope 客户端；
- stdio 客户端。

`npm test` 会验证两代 HTTP 握手、16 个工具的 schema 与结构化输出、认证、Host/Origin 防护、按工作量限流、研究/显式公网链接/结果正文/页内查找工作流、URL 与公网 DNS 边界、分页、路径/凭据脱敏、固定管理上游边界、上游响应大小限制，以及十组固定快照评测。search-gateway 自身另测缓存、在途合并、引擎冷却、单次回退、去重/排序、中文切词、来源分类、重定向复验、解压限制，以及 HTML/JSON/XML/PDF 正文提取。

## 故障排查

- `401`：Bearer Header 缺失或 key 不匹配。
- `403`：Host/Origin 不在本机白名单；Docker 客户端应使用 `host.docker.internal`。
- `health=offline`：运行 `start-platform-mcp.cmd`。
- 联网工具提示未配置：确认现有 search-gateway 服务密钥文件可读，或从 secret store 设置 `PLATFORM_MCP_SEARCH_GATEWAY_API_KEY` 后只重启 MCP。
- `quality=weak|empty`：优先缩短查询、拆成 2–8 个角度交给 `local_ai_research_web`，或设置 `preferred_domains/include_domains/preferred_source_types`；不要只提高结果上限。
- 引号内短语按精确检索约束处理；如果上游忽略引号，未命中完整短语的候选会被降为低相关，避免用只沾到几个常见词的页面凑数。
- `quality` 只描述检索相关性和覆盖度，不等于事实已经核验，也不代表所有来源同等可信；重要结论仍应读取正文并交叉验证。
- 正文读取报错：该页可能依赖 JavaScript、登录/cookie、验证码或付费墙，也可能跳到私网/非标准端口、类型不支持或超过安全限制；对搜索结果可改选同一集合中的其他 `result_id`，对粘贴链接可换同站的公开 HTML/PDF/RSS 页面。
- 搜索提示 rate limit：等待返回的秒数，或缩小/复用已有结果；不要靠提高结果上限绕过限流。
- 工具返回 `partial=true`：某个固定上游未响应；用 `status-service-entry.cmd` 和 `local_ai_get_diagnostics` 确认具体管理器。
- 需要轮换 key：先停止 MCP，备份后移走 `server.env`，再启动生成新 key，并同步更新客户端 secret store。旧 key 会立即失效。

审计文件位于 `<AI_ROOT>\audit-logs\platform-mcp.jsonl`；stdout/stderr 也在同一目录。它们都是本机运行数据，不进入 Git 或发布包。
