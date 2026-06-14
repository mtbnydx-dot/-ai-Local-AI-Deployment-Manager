# 本地模型服务平台深度审查与改进清单

日期：2026-06-14

范围：

- `D:\AI\service-entry`
- `D:\AI\vllm-manager`
- `D:\AI\llama-manager`
- `D:\AI\manager-core`
- `D:\AI\docs`

本报告结合当前代码结构、已有运行状态、官方文档和大模型服务后端常见故障模式，重新推敲每个功能面。

## 一、当前状态速览

### 1. 代码体积与复杂度

当前项目已经从“单机工具”成长为“本地模型服务平台”。功能很多，但核心实现仍集中在少数大文件里。

| 文件 | 行数 | 大小 | 路由数 | 函数数 | 风险 |
| --- | ---: | ---: | ---: | ---: | --- |
| `vllm-manager/server.js` | 9528 | 379 KB | 77 | 459 | 高 |
| `llama-manager/server.js` | 7934 | 309 KB | 69 | 408 | 高 |
| `vllm-manager/public/app.js` | - | 275 KB | - | - | 高 |
| `llama-manager/public/app.js` | - | 198 KB | - | - | 中高 |
| `service-entry/server.js` | 544 | 21 KB | 自定义 HTTP | 31 | 中 |

主要问题不是“现在跑不了”，而是未来继续加功能时容易出现：

- 一处改动影响多个功能面。
- vLLM/llama 功能逐渐漂移。
- 测试只能覆盖导出的少量核心函数，页面和路由行为仍靠手工验证。
- 错误处理、任务状态、统计口径容易不一致。

### 2. 已经做得不错的地方

- 已经有 OpenAI、Claude、OpenCode 入口。
- 已经有 Claude 工具桥和上下文压缩。
- 已经有下载队列、暂停、继续、取消、进度。
- 已经有外来访问统计，并且只记元数据，不记录正文。
- 已经有 `manager-core`，可以继续抽公共逻辑。
- 已经有单元测试：
  - `vllm-manager` 19 条
  - `llama-manager` 13 条
  - `service-entry` 5 条
  - `manager-core` 4 条

### 3. 最高优先级判断

下一步最值得做的不是再加一个炫功能，而是把平台的“服务提供能力”打牢：

1. 统一网关要成为真正入口，包括鉴权、路由、健康检查、熔断、模型选择、统计。
2. vLLM/llama 两个 manager 要共享更多后端模块，减少复制分叉。
3. 所有长任务和账本要从“文件 + 内存 Map”升级到 SQLite。
4. 服务暴露必须默认安全，局域网和公网都要有清晰保护。
5. 前端要进入“控制台产品”形态，而不是不断追加面板。

## 二、互联网资料映射到本项目

### 0. 本轮已落地：多卡显存估算与系统内存回退

本轮把显存估算从“总模型大小粗略除以 GPU 数量”推进到“启动决策级估算”：

- 新增 `D:\AI\manager-core\memory-estimator.js`，统一计算权重、KV cache、运行余量、单卡峰值、当前空闲约束、溢出量和回退建议。
- vLLM 前端修正 `cpu-offload-gb` 口径：这是每张 GPU 的 CPU 权重 offload 额度，不是全局总量。
- vLLM 前端修正 `kv-offloading-size` 口径：这是 KV cache offload 总缓冲；TP 多卡时按 rank 分摊。
- vLLM 显存条不再只看显卡总显存，而是取“当前空闲显存减保护余量”和 `gpu-memory-utilization` 两者较小值。
- vLLM 多卡说明增加异构组合建议：96GB 大卡 + 5090/5070Ti 这类组合优先单大卡或 PP，TP 只适合同级卡短测。
- llama 前端把 `gpu-layers` 纳入估算：`all` 是全层进 GPU，填具体层数会把剩余权重/KV 计入系统内存。
- llama 前端增加“系统内存”指标，明确“能启动”与“速度下降”的取舍。
- llama 异构建议强化：优先 `layer` split，大卡承担主要层，小卡少量辅助；OOM 时先降低 GPU layers，再降 KV 精度/上下文/parallel。

依据口径：

- vLLM 官方文档说明 `--gpu-memory-utilization` 是当前 vLLM 实例的显存使用比例，`--cpu-offload-gb` 是每 GPU 的 CPU offload 空间，`--kv-offloading-size` 是总 KV offload 缓冲，TP>1 时为所有 TP rank 的总和。
- llama.cpp 官方 multi-GPU 文档说明 `layer` 是默认且兼容性最好的多卡模式，KV cache 跟随所在 layer；`tensor` 是实验性模式，且量化 KV cache 与 tensor split 存在限制；OOM 时建议依次降低 ctx-size、parallel，最后降低 GPU layers 让剩余层跑系统内存。

后续仍建议：

- 把前端估算调用改成后端 `/api/memory-estimate`，彻底避免两个前端复制公式。
- 记录每次启动时的估算快照和真实日志峰值，形成“估算误差校准”。
- 对 96GB + 5090 / 96GB + 5070Ti 做实测 profile：首 token、prefill、decode、温度、PCIe 利用率，反向修正默认推荐。

### 1. vLLM 生产指标

vLLM 官方说明提供 Prometheus/Grafana 监控思路，重点指标包括请求等待、运行中请求、端到端延迟、inter-token latency、KV cache 使用率等。

对应本项目：

- 现在统计页面已经解析部分 Prometheus 指标。
- 还应该增加“服务健康分数”和“瓶颈归因”：
  - KV cache 使用率高：上下文/并发太高。
  - waiting requests 高：并发或调度瓶颈。
  - inter-token latency 高：解码慢，可能是量化、跨卡、温度降频。
  - prefill latency 高：上下文太大、prefix cache 未命中。

参考：

- https://docs.vllm.ai/en/stable/design/metrics/
- https://docs.vllm.ai/en/v0.14.0/usage/metrics/

### 2. vLLM chunked prefill 与 prefix cache

vLLM 文档强调 chunked prefill 用于把大 prefill 分块，与 decode 请求混合调度；prefix caching 用于复用相同前缀的 KV cache。

对应本项目：

- 本地 Claude/编程工具的请求常有大 system prompt、大工具 schema、长历史。
- 单路首 token 慢，常常不是“卡不够快”，而是 prefill 长。
- 需要在界面里把“首 token 慢”的原因拆成：
  - 模型冷启动
  - 长上下文预填充
  - 工具 schema 过大
  - prefix cache 未命中
  - KV cache 分配/碎片
  - 跨 GPU 通信

建议：

- 启动参数区加“长上下文/Agent 模式优化”预设。
- 指标区显示 prefill、decode、queue、KV cache 命中相关解释。
- 对 Claude 桥接重复系统提示和工具 schema，增加 prefix-cache 友好的请求规范。

参考：

- https://docs.vllm.ai/en/stable/configuration/optimization/
- https://docs.vllm.ai/en/stable/design/prefix_caching/

### 3. vLLM 工具调用和 reasoning parser

vLLM 工具调用文档说明，自动工具选择需要 `--enable-auto-tool-choice` 和 `--tool-call-parser`；不同模型需要不同 parser。文档也提醒，部分 parser 只能从文本中尽力抽取，参数可能不符合 schema。

对应本项目：

- 现在已经有 Qwen、Claude 工具桥和 parser 选择。
- 还缺“模型能力档案”：
  - 这个模型支持哪些 tool parser？
  - 是否需要 chat template？
  - reasoning parser 是什么？
  - 是否支持严格 schema？
  - 是否支持并行工具？
  - 客户端是 OpenWebUI、Claude Cowork、Claude Code 还是 OpenCode？

建议：

- 增加 `model-capabilities.json` 或 SQLite 表。
- 每个模型首次启动时自动探测：
  - `/v1/models`
  - 简单 tool call 测试
  - streaming tool call 测试
  - reasoning 分离测试
  - 图片输入测试
- UI 下载/启动页给出“推荐 parser 组合”。

参考：

- https://docs.vllm.ai/en/latest/features/tool_calling/
- https://docs.vllm.ai/en/latest/features/reasoning_outputs/

### 4. Claude SSE、工具流和 thinking

Anthropic 文档规定 Claude streaming 的事件顺序：`message_start`，多个 content block 的 start/delta/stop，`message_delta`，`message_stop`。工具参数是 `input_json_delta.partial_json`，thinking 也有独立 delta 和 signature。

对应本项目：

- vLLM/llama 的 Claude 桥已经能流式转换 tool calls。
- 但还应该建立“协议兼容性测试矩阵”，覆盖：
  - text-only stream
  - tool_use stream
  - tool_result round-trip
  - malformed tool JSON
  - empty assistant message
  - error event after headers sent
  - thinking/reasoning 的显示/隐藏策略

建议：

- 给 Claude 桥补一组 golden fixture。
- 页面增加“Claude 桥协议自检”按钮。
- 对 ccswitch 的“完整 URL/Base URL”误配给更明确错误。

参考：

- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview

### 5. OpenAI structured outputs 与 function calling

OpenAI 文档建议工具/函数调用时走 function calling；Structured Outputs 比 JSON mode 更能保证 schema adherence，但 unsupported schema 会报错。

对应本项目：

- 本地模型未必能严格遵守 schema。
- 网关可以做两级保障：
  - 上游支持 strict/structured，就透传。
  - 上游不支持，就在网关侧做 JSON schema validate，并把错误转成 Claude/OpenAI 兼容错误。

建议：

- 加 `schemaCompatibility` 检查：
  - unsupported schema 预警
  - too-large tool schema 预警
  - anyOf/oneOf/nullable/recursive schema 支持度提示
- 工具桥统计中增加：
  - tool schema 数
  - tool call 成功数
  - tool JSON parse 失败数
  - schema validation 失败数

参考：

- https://developers.openai.com/api/docs/guides/function-calling
- https://developers.openai.com/api/docs/guides/structured-outputs

### 6. Docker 端口暴露和安全

Docker 官方提醒：发布端口默认会发布到所有网络接口，任何能到达机器的流量都可能访问该服务。OWASP Docker 安全建议包括限制资源、谨慎映射端口、只读文件系统、运行时安全策略等。

对应本项目：

- 当前已经区分本机和 LAN。
- 还需要把“端口发布实际状态”做成强提示：
  - 管理器监听地址
  - Docker 发布地址
  - Windows 防火墙状态
  - API Key 是否开启
  - 当前容器是否绕过管理器直连暴露

建议：

- 服务提供页加“暴露风险评分”：
  - 绿色：127.0.0.1 + key
  - 黄色：LAN + key
  - 红色：LAN/0.0.0.0 + 无 key 或直连容器端口
- Docker run 加资源限制：
  - `--ulimit`
  - `--restart=no` 或受控 restart policy
  - 明确 volume 读写范围
  - 可选只读模型挂载

参考：

- https://docs.docker.com/get-started/docker-concepts/running-containers/publishing-ports/
- https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html

## 三、逐功能深挖

## 1. 统一入口 `service-entry`

### 当前定位

现在已经是一级控制台和统一网关雏形：

- `/gateway/auto/openai/v1`
- `/gateway/auto/claude`
- `/gateway/auto/opencode/v1`
- `/api/status`
- `/api/gateway-access`

### 主要风险

1. `auto` 路由策略太简单。

当前只按 manager 是否 listening、container 是否 running 做判断。真实服务里还需要看：

- 当前模型是否支持请求协议。
- 当前模型是否支持工具/视觉/长上下文。
- 当前模型是否已经满载。
- 当前模型是否处于启动中/卸载中。
- vLLM 和 llama 是否都在跑，哪个更适合该请求。

2. 网关代理没有熔断。

如果上游反复 502/timeout，入口应短暂标记 unhealthy，避免客户端持续打满。

3. 访问统计仍是 JSONL。

JSONL 对小规模可行，但以后要查“某个客户端 24 小时内所有错误”“某模型 P95 首 token”就会吃力。

4. 文档路由是白名单静态暴露。

目前没问题，但以后如果继续加文档，最好统一到 `/docs/index`，而不是代码里继续加白名单。

### 改进建议

P0：

- 增加 `/api/gateway/health`：
  - backend 状态
  - last success
  - last error
  - rolling error rate
  - circuit breaker 状态
- `auto` 路由改为 policy-based：
  - protocol: openai/claude/opencode
  - required features: tools/vision/reasoning/long-context
  - model alias
  - backend load
  - backend health
- 所有 gateway access 写入 SQLite。

P1：

- 统一入口增加“客户端配置生成器”：
  - ccswitch JSON
  - OpenWebUI 配置
  - OpenCode 配置
  - curl 测试命令
- 增加 LAN 连通性自检：
  - 从本机绑定检查
  - 防火墙提示
  - Docker 发布检查

P2：

- 加一个只读 `/api/capabilities`，聚合 vLLM/llama 当前模型能力。

## 2. vLLM Manager

### 当前强项

- 功能最完整。
- 支持 NVFP4/FP8/AWQ/GPTQ 等选择。
- 支持 Claude 桥、OpenCode、工具 parser、reasoning parser。
- 支持外来访问统计和客户端 key。
- 支持下载队列和进度。

### 主要风险

1. 后端大单体。

`server.js` 有 77 个路由、459 个函数。任何一次改下载、统计、Claude 桥，都可能误伤启动逻辑。

2. 工具 parser 选择还不够模型感知。

vLLM 文档已经列出很多 parser，但不同模型需要不同模板和 parser。现在更多是用户手动选。

3. 显存估算仍可能和真实差异较大。

显存消耗由多个因素决定：

- 权重大小
- KV cache dtype
- max model len
- max num seqs
- max batched tokens
- chunked prefill
- graph/cudagraph overhead
- multimodal processor cache
- tensor/pipeline/data parallel
- prefix cache
- CUDA allocator 碎片

4. vLLM 多卡 UI 对异构卡仍应更强警告。

RTX PRO 6000 + 5090 这种组合，vLLM TP 往往受最小卡、PCIe、NCCL、同步开销影响。应默认建议单主卡，除非用户明确选择 TP/PP/DP 实验。

### 改进建议

P0：

- 拆 `server.js`：
  - `routes/service-exposure.js`
  - `routes/claude-bridge.js`
  - `routes/downloads.js`
  - `routes/launch.js`
  - `routes/stats.js`
  - `lib/docker.js`
  - `lib/vllm-args.js`
  - `lib/model-catalog.js`
  - `lib/claude-protocol.js`
- 为 `buildVllmArgs` 做 snapshot tests。
- 为 Claude streaming 做 fixture tests。

P1：

- 模型能力档案：
  - Qwen/Qwen3/Qwen3-Coder
  - DeepSeek
  - GLM
  - Kimi
  - Hermes
  - xLAM
  - OpenAI OSS
- 启动时自动推荐：
  - reasoning parser
  - tool parser
  - trust remote code
  - dtype
  - quantization
  - max context
  - max num seqs

P1：

- 显存估算升级为“区间 + 置信度”：
  - 权重显存
  - KV cache
  - runtime overhead
  - batch/concurrency overhead
  - multimodal overhead
  - safety headroom

P2：

- 加“性能诊断解释器”：
  - 首 token 慢：prefill 长 / prefix cache miss / cold start
  - token/s 低：decode 慢 / 热降频 / 跨卡
  - 并发好单路慢：batching 利用了 GPU，单路 decode 没吃满

## 3. llama Manager

### 当前定位

llama.cpp 重点应放在：

- GGUF
- 异构双卡
- 长上下文实验
- 低内存/CPU offload
- 本地稳定单人使用

### 主要风险

1. 功能虽然对齐了很多，但策略不应完全复制 vLLM。

llama.cpp 的优势不是高并发服务，而是 GGUF 灵活、异构分层、可跑更多模型格式。UI 应更强调：

- split mode
- tensor split
- main GPU
- GPU layers
- KV cache type
- batch/ubatch
- flash attention
- continuous batching

2. 长上下文启动慢是常态，但需要解释。

llama.cpp 的 `--parallel`、continuous batching、KV cache、batch/ubatch 会影响启动和运行。用户应该看到“启动慢阶段”：

- mmap/模型文件读取
- GPU offload
- KV cache 分配
- graph 初始化
- server ready

3. GGUF 适配度还可以更强。

下载页应检查：

- 是否存在 `.gguf`
- 是否有 mmproj
- 量化等级
- 文件大小
- tokenizer/chat template 是否内嵌
- 是否适合当前双卡 split

### 改进建议

P0：

- llama 启动进度拆阶段。
- 日志识别：
  - model load
  - offload layers
  - KV cache allocation
  - server listening
  - failed tensor split
  - unsupported architecture

P1：

- 异构双卡向导升级：
  - 稳定模式：layer split，PRO 6000 主卡，5090 少量辅助或不参与
  - 吞吐实验：row split
  - 长上下文：尽量单大显存卡，减少跨卡 KV 压力
  - 仅显示输出卡：避免桌面占用影响推理

P1：

- llama 的 stats 和外来访问统计应完全对齐 vLLM，包括 Claude 调用独立面板、错误率、延迟、token、上下文使用。

P2：

- 增加 GGUF 文件健康检查：
  - 文件是否完整
  - metadata 是否可读
  - quant 是否匹配
  - chat template 是否存在

参考：

- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- https://manpages.debian.org/unstable/llama.cpp-tools/llama-server.1.en.html

## 4. 下载与在线模型列表

### 当前风险

1. Hugging Face 搜索仍然容易“看起来很多，实际不可用”。

需要区分：

- vLLM 可跑：safetensors / fp8 / awq / gptq / nvfp4 等。
- llama 可跑：gguf。
- 多模态需要额外 projector/mmproj 或 processor。
- 有些 repo 是 LoRA、adapter、dataset、旧转换版。

2. 下载任务账本太大。

`vllm-manager/logs/jobs-ledger.json` 已约 1.9 MB。继续增长后，页面加载和写入都会变慢。

3. 下载取消后的部分文件删除需要事务化。

当前已加入取消删除思路，但建议更严谨：

- 每个下载任务独立 `.partial` 目录。
- 完成后原子 rename 到目标目录。
- 取消只删 `.partial`。
- 断点续传则保留 `.partial` 和 manifest。

### 改进建议

P0：

- 下载任务迁移到 SQLite：
  - jobs
  - job_events
  - downloads
  - downloaded_files
  - model_manifest
- JSON ledger 只保留迁移兼容。

P1：

- 模型在线列表做“可运行过滤”：
  - 当前 manager 可运行
  - 当前 GPU 可运行
  - 当前上下文目标可运行
  - 当前量化可下载
  - 多模态/仅文本

P1：

- 下载前生成 manifest：
  - repo id
  - revision
  - selected files
  - expected bytes
  - sha256/lfs oid if available
  - target engine
  - precision

P2：

- 支持 aria2 多线程下载，但要保留 HF token、重试、限速、校验。

## 5. 统计、计费估算与容量管理

### 当前风险

1. 价格表会过期。

OpenAI/Anthropic 价格变化很快。代码里硬编码价格适合离线演示，但作为平台应显示“价格数据更新时间”和“手动刷新”。

2. 本地 token 统计不等于云 API 计费。

本地模型 tokenizer、Claude tokenizer、OpenAI tokenizer 不同。应该标注“估算口径”。

3. 卸载模型后统计保留是对的，但 runtime facts 要独立于 live metrics。

现在已经开始做 ledger，但建议彻底转 SQLite。

### 改进建议

P0：

- `usage.sqlite` 统一为主账本。
- Prometheus live metrics 只作为实时层，卸载后历史仍来自 SQLite。

P1：

- 统计增加：
  - 首 token latency
  - output token/s
  - prefill token/s
  - queue time
  - KV usage
  - cache hit proxy 指标
  - per-client request/tokens/error
  - per-model cost equivalent

P1：

- 计费表改为外部 JSON：
  - `pricing/providers.json`
  - 字段：provider、model、input、cached_input、output、context tier、updated_at、source_url

参考：

- https://developers.openai.com/api/docs/pricing
- https://platform.claude.com/docs/en/about-claude/models/overview

## 6. 外来访问、安全与审计

### 当前做法

- 已有外来访问页。
- 已有 API key 和客户端 key。
- 已有审计导出，查看需要密码。
- 访问统计只记录元数据。

### 主要风险

1. 管理器监听 `0.0.0.0`，但远程管理靠请求来源判断。

这比完全开放好，但更稳的做法是：

- 管理界面只监听 localhost。
- 统一入口负责 LAN。
- 需要 LAN 管理时启用单独 admin key。

2. 审计密码文件风险。

当前日志目录存在 `audit-admin-password.txt`。不讨论内容，但从设计上应避免明文密码文件。

3. 客户端 key 应该支持权限分级。

例如：

- chat only
- tools allowed
- web search allowed
- audit read
- admin
- metrics read

### 改进建议

P0：

- 审计密码改为 hash-only，提供首次设置和重置流程。
- 所有管理写操作加 CSRF/token 或 local-only + admin key。
- LAN 模式下 UI 显示清楚：
  - 管理 API 是否远程可用
  - 模型 API 是否远程可用
  - 容器端口是否绕过网关可访问

P1：

- 客户端 key 权限模型：
  - `scopes: ["openai:chat", "claude:messages", "tools:call", "metrics:read"]`
  - per-client model allowlist
  - per-client max context
  - per-client max tool count

P1：

- 审计导出分级：
  - 元数据审计
  - 完整对话审计
  - 工具调用审计
  - 敏感字段脱敏版

## 7. Claude 桥、上下文压缩与 agent 长任务

### 当前风险

1. 自动压缩可能保留了任务线索，但还缺“可验证压缩质量”。

压缩最怕丢：

- 用户目标
- 最新约束
- 错误原因
- 已经试过的命令
- 文件路径
- 关键配置
- 工具结果 ID 关系

2. 压缩触发后，前台工作流是否中断仍要用真实客户端测试。

不同客户端对 streaming 中断和 retry 的处理不同。

3. Claude 桥需要对 thinking/reasoning 采取明确策略。

本地模型 reasoning parser 输出可能是 `reasoning_content`，Claude 侧可能需要 thinking block 或隐藏。

### 改进建议

P0：

- 压缩前后生成 diagnostic record：
  - old tokens
  - new tokens
  - preserved recent messages
  - preserved tool pairs
  - extracted goals/errors/files
  - compression reason
- UI 上展示最近一次压缩摘要，不展示原文。

P1：

- 加“压缩回放测试”：
  - 给一组长任务 fixture
  - 压缩后问模型继续任务
  - 检查目标/错误/文件是否还在

P1：

- Claude 桥 reasoning 策略：
  - `none`
  - `strip`
  - `as_text`
  - `as_thinking_omitted`
  - `as_thinking_visible`

## 8. GPU、显存和性能调优

### 当前场景

用户硬件已经偏高端，可能包括 96GB 级别新卡、RTX 5090、5070 Ti 等。平台要避免把“能跑”和“跑得舒服”混在一起。

### 常见问题

- 单路 token/s 低于并发总吞吐，是 batching 的正常现象。
- 5070 Ti 插 x4 槽可能影响跨卡/加载/通信，但 decode 单路主要看模型、内存带宽、KV、batch。
- 异构 TP 常被小卡拖慢。
- 长上下文显存主要被 KV cache 吃掉。
- 显示输出卡会被桌面占显存。

### 改进建议

P0：

- GPU 页展示：
  - PCIe link width / generation
  - display attached
  - power limit
  - temperature
  - throttling reason
  - memory bandwidth proxy
  - process list

P1：

- “配置评分”：
  - 单路低延迟
  - 长上下文
  - 多设备并发
  - 工具调用
  - 多模态
  - 稳定性

P1：

- 基准测试标准化：
  - 1k/8k/32k/128k prefill
  - 128/1024 output
  - 1/2/4 并发
  - 工具 schema 大小
  - 首 token / decode / total

## 9. 前端产品体验

### 当前问题

- 功能很多，入口页已经较清晰，但 vLLM/llama 主界面仍可能信息密度过高。
- 工具页容易变成杂物抽屉。
- 模型选择、下载、启动、服务提供之间还缺统一流程。

### 建议信息架构

一级导航：

1. 首页
   - 当前运行
   - 快速启动
   - 客户端接入
   - 风险提醒
2. 模型
   - 本地模型
   - 在线模型
   - 下载任务
   - 模型能力档案
3. 启动
   - 基础配置
   - 上下文与显存
   - GPU 与并发
   - 工具/reasoning
   - 高级参数
4. 服务提供
   - LAN/Public
   - Key
   - 客户端
   - 连接向导
   - 风险评分
5. 运行中
   - 模型列表
   - 卸载
   - 上下文使用
   - 性能
6. 统计
   - 总览
   - Claude 调用
   - OpenAI/OpenWebUI
   - 外来访问
   - 成本估算
7. 诊断
   - Docker
   - GPU
   - 端口
   - 日志摘要
   - 自检
8. 审计
   - 密码保护
   - 元数据
   - 对话导出

### UI 改进

P0：

- 启动页默认只展示基础配置。
- 高级参数分组折叠。
- 所有危险操作二次确认。

P1：

- 下载和启动任务使用统一 task drawer。
- 每个错误都给：
  - 原始错误摘要
  - 可能原因
  - 一键修复
  - 相关日志链接

P2：

- 深色/浅色主题继续统一变量。
- 中英文文案放到 i18n 文件，不在 JS 中散落。

## 10. 测试策略

### 当前覆盖

已有测试主要覆盖核心转换、文件写、Docker 参数、服务暴露、Claude bridge。

### 还缺

P0：

- 路由层 contract tests：
  - `/api/status`
  - `/api/service-exposure`
  - `/api/download`
  - `/api/start`
  - `/claude/v1/messages`
  - `/serve/v1/chat/completions`

P0：

- Claude/OpenAI 协议 fixture：
  - non-stream text
  - stream text
  - stream tool
  - tool_result
  - malformed upstream
  - client abort

P1：

- UI smoke tests：
  - 首页加载
  - 模型选择器
  - 下载页
  - 启动页
  - 服务提供页
  - 外来访问页

P1：

- 真实本地集成测试：
  - fake upstream server
  - fake Docker CLI
  - fake Hugging Face API
  - fake Prometheus metrics

## 四、推荐路线图

## 第一批：服务平台稳定性

目标：让它可以安心作为局域网模型服务入口。

任务：

1. 统一入口 gateway policy。
2. gateway health + 熔断。
3. 外来访问/任务/统计迁移 SQLite。
4. 审计密码 hash-only。
5. 暴露风险评分。
6. 路由 contract tests。

验收：

- 不启动模型时返回清晰 503。
- 启动 vLLM/llama 任一个时 auto 能正确路由。
- 上游连续失败后短暂熔断并在页面显示。
- 统计查询不再扫大 JSON。
- LAN 模式能明确显示当前暴露风险。

## 第二批：模型能力与启动可靠性

目标：减少“模型选了但参数不对”的失败。

任务：

1. 模型能力档案。
2. 启动参数推荐器。
3. 显存估算区间化。
4. 启动日志阶段识别。
5. vLLM/llama 各自的启动参数 snapshot tests。

验收：

- 粘贴模型链接后能识别 engine、格式、量化、能力。
- 启动前提示 parser/dtype/上下文/GPU 风险。
- 启动失败给一键修复建议。

## 第三批：Claude/Agent 专项增强

目标：让本地模型更适合 Claude Desktop/Cowork/Code 类长任务。

任务：

1. Claude protocol fixture。
2. 上下文压缩诊断。
3. 工具 schema validator。
4. reasoning 策略。
5. 长任务保活和恢复提示。

验收：

- ccswitch 测试通过 text/tool/stream。
- 压缩后目标/错误/路径不丢。
- 工具 JSON 失败能统计并提示。

## 第四批：前端产品化

目标：把“功能页面集合”变成“模型服务控制台”。

任务：

1. 统一首页。
2. 任务抽屉。
3. 诊断中心。
4. 服务提供向导。
5. i18n 文案拆分。
6. 页面级 Playwright smoke。

验收：

- 新用户从首页能完成：下载模型、启动、接 OpenWebUI/ccswitch、查看统计。
- 错误可以在诊断中心闭环。
- 深色/浅色/窄屏无明显错位。

## 第五批：高级能力

目标：为“真正提供模型服务”预留空间。

任务：

1. 多租户 client scopes。
2. 反向代理配置导出。
3. TLS/Caddy/Nginx 指南。
4. Prometheus/Grafana 可选栈。
5. 模型 benchmark 历史对比。
6. 自动选择后端。

验收：

- 每个客户端可限模型、限上下文、限工具、限速率。
- 可以导出生产化配置。
- 性能报告能比较不同模型/参数/显卡。

## 五、最值得马上开工的 12 个点

1. 把 `service-entry` 的 gateway access 改 SQLite。
2. 把 vLLM/llama 的 jobs ledger 改 SQLite。
3. 把 `claude-protocol` 抽进 `manager-core`。
4. 把 `service-exposure` 抽进 `manager-core`。
5. 审计密码改 hash-only。
6. 给 `/gateway/auto/*` 加路由策略和熔断。
7. 给 Docker 暴露做风险评分。
8. 给启动参数生成器加 snapshot tests。
9. 给 Claude streaming 加 fixture tests。
10. 模型能力档案第一版：Qwen/DeepSeek/GLM/Hermes/GGUF。
11. 下载 `.partial` 事务目录。
12. 首页加“服务向导”：本机、局域网、OpenWebUI、ccswitch、OpenCode。

## 六、我的判断

这个项目目前已经越过“能管理本地模型”的阶段，正在进入“本地模型服务平台”的阶段。下一阶段最重要的是减少隐性状态和复制代码：

- 任务、统计、访问日志进 SQLite。
- 协议转换和服务暴露进 `manager-core`。
- 网关成为唯一推荐入口。
- vLLM/llama 只保留各自 engine 特有能力。
- 前端从堆面板改为流程化控制台。

只要这几条做完，后面无论加联网搜索、RAG、权限分级、反向代理、Prometheus、模型 benchmark，都不会再把项目越改越脆。
