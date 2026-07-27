# 本地模型服务平台工作文档

更新时间：2026-06-14

## 1. 总目标

把当前的 `vllm-manager`、`llama-manager` 和 `service-entry` 从三个相对独立的工具，升级为一个稳定的本地/局域网模型服务平台。

最终形态：

- `service-entry` 是一级控制台和统一网关。
- `vllm-manager` 和 `llama-manager` 是两个后端引擎管理器。
- 所有外部客户端通过统一入口拿到 OpenAI、Claude、OpenCode 兼容接口。
- 服务认证、客户端 Key、限流、并发、访问统计、审计、模型目录、下载任务和 GPU 规划尽量共享同一套核心逻辑。
- 前端保持一致的导航、设计语言、深色主题和中文/英文模式。

## 2. 核心原则

1. 先服务稳定性，再功能丰富度。
2. 每一批改动都必须能独立启动、独立测试、独立回滚。
3. 管理后台和模型网关严格分离：可以开放模型服务，不默认开放管理操作。
4. API Key 不再明文落盘；新增凭据只显示一次，落盘只保存 hash、预览和权限。
5. 外来访问统计只记录元数据，不记录用户提示词和模型正文。
6. vLLM 和 llama.cpp 的差异放在 engine adapter，不在业务逻辑里到处写分支。
7. 前端优先做可操作控制台，不做装饰型页面。

## 3. 目标目录结构

```text
<release-root>\
  docs\
    model-service-platform-workplan.md
    service-runbook.md
    client-setup-guide.md
  manager-core\
    package.json
    index.js
    health.js
    network.js
    secrets.js
    access-log.js
    gateway-utils.js
    service-clients.js
    tests\
      core.test.js
  service-entry\
    server.js
    index.html
  vllm-manager\
    server.js
    public\
    test\
  llama-manager\
    server.js
    public\
    test\
```

## 4. 分阶段计划

### Phase 1：统一入口服务化

目标：`service-entry` 不再只是启动页，而是成为控制平面雏形。

任务：

- 展示每个 manager 的真实健康状态、PID、端口监听、陈旧 PID、运行时间。
- 展示当前模型服务、OpenAI/Claude/OpenCode 地址、外来请求摘要。
- 提供本机一键启动/关闭 manager，但不停止后台模型容器。
- 增加统一网关路由雏形：
  - `/gateway/vllm/openai/v1/*`
  - `/gateway/vllm/claude/*`
  - `/gateway/llama/openai/v1/*`
  - `/gateway/llama/claude/*`
  - `/gateway/auto/openai/v1/*`
  - `/gateway/auto/claude/*`
- `auto` 模式优先选择当前有运行模型的后端。

验收：

- 另一台设备只需要看统一入口给出的地址。
- 统一入口能识别 manager 离线、端口占用、PID 陈旧。
- 统一网关请求能转发到对应 manager，并保留 Authorization / x-api-key / anthropic-api-key。

### Phase 2：manager-core 共享核心

目标：停止把同一套功能复制在 vLLM 和 llama 两份 `server.js` 里。

第一批抽出：

- `health.js`：PID、进程、端口、启动时间、健康对象。
- `network.js`：LAN IP、host 解析、loopback 判断。
- `secrets.js`：API Key hash、预览、timing safe compare、secret 归一化。
- `access-log.js`：外来访问事件规范、聚合统计、时间窗口。
- `gateway-utils.js`：认证头提取、网关类型识别、错误格式。

验收：

- vLLM / llama 可逐步引用共享函数。
- 共享模块有独立单测。
- 不改变现有 API 响应结构。

### Phase 3：客户端与服务认证统一

目标：建立真正的服务客户端管理。

任务：

- 统一客户端 ledger 格式。
- 每个客户端支持：
  - name
  - keyHash
  - keyPreview
  - allowedModels
  - allowedProtocols
  - rateLimitRpm
  - maxConcurrentRequests
  - expiresAt
  - notes
- 统一入口能创建、停用、轮换客户端 Key。
- manager 可继续保留本地客户端列表，但推荐迁移到统一入口。

验收：

- 外部设备可单独发 Key。
- Key 泄露时可只停用一个客户端。
- 统计页能按客户端区分请求量、错误率、速度和 token。

### Phase 4：外来访问与统计统一

目标：服务运营视角完整。

任务：

- vLLM / llama 都写统一访问事件格式。
- 统一入口能聚合两边：
  - 请求数
  - 成功/失败
  - 状态码
  - 模型
  - 协议
  - 来源 IP
  - clientId
  - token
  - 延迟
  - 工具调用数量
- 后续从 JSONL 迁移到 SQLite。

验收：

- 模型卸载后统计仍保留。
- manager 重启后历史统计仍保留。
- 不读取原始聊天正文。

### Phase 5：GPU 与上下文智能规划

目标：让 96G 新卡、5090、5070 Ti、异构双卡场景更好用。

任务：

- GPU 页面显示型号、显存、温度、PCIe、进程占用。
- vLLM 推荐：
  - 单卡
  - TP
  - PP
  - `max_model_len`
  - `max_num_seqs`
  - `gpu_memory_utilization`
  - FP8 KV cache
- llama 推荐：
  - tensor split
  - main GPU
  - GPU layers
  - KV cache 类型
  - batch / ubatch
- 显存估算统一展示：
  - 权重
  - KV cache
  - graph/warmup 预留
  - 并发序列数
  - 总预留

验收：

- 选中模型和上下文后，页面能给出可行/危险/不可行。
- 多卡比例显示和实际启动参数一致。

### Phase 6：下载与模型库

目标：模型选择和下载变成真正的模型市场。

任务：

- Hugging Face / ModelScope 搜索分页。
- 筛选：
  - 当前引擎可运行
  - GGUF
  - safetensors
  - AWQ/GPTQ/FP8/NVFP4
  - 蒸馏
  - 去审查
  - 多模态
  - 代码
  - 长上下文
- 下载任务支持：
  - 暂停
  - 继续
  - 取消并删除半成品
  - 校验完整性
  - 自动重试
  - 队列优先级
- 本地模型库支持：
  - 收藏
  - 标签
  - 备注
  - 上次启动参数
  - 上次失败原因

验收：

- 从模型介绍链接可以自动解析 repo、量化、保存名。
- 下载失败不会留下难清理的半成品。

### Phase 7：前端统一设计

目标：让两个 manager 和统一入口像一个产品。

任务：

- 统一导航：
  - 首页
  - 服务
  - 模型
  - 下载
  - 外来访问
  - GPU
  - 统计
  - 审计
  - 日志
  - 设置
- 服务页分区：
  - 基础启动
  - 上下文与显存
  - GPU 策略
  - 工具调用
  - 网络服务
  - 高级参数
- 高级参数默认折叠。
- 模型选择器显示大小、量化、适配度、上次使用、运行中速度。
- 深色主题无浅色硬编码。
- 英文模式改为真正字典渲染。

验收：

- vLLM / llama 页面结构一致。
- 英文模式没有明显中文残留。
- 深色主题可读性稳定。

### Phase 8：可靠性、测试与文档

任务：

- 单测：
  - 服务认证
  - API Key hash-only
  - 网关转发
  - Claude/OpenAI 转换
  - 工具调用桥
  - 上下文压缩
  - 下载队列
  - PID 恢复
  - 外来访问统计
- smoke test：
  - 统一入口页面
  - vLLM 服务页
  - llama 外来访问页
- 文档：
  - `service-runbook.md`
  - `client-setup-guide.md`
  - `troubleshooting.md`

验收：

- 每次改网关都有测试兜底。
- 新机器按文档能启动。
- 出错时后台能给出下一步动作。

## 5. 当前优先级

当前先做：

1. 建立 `manager-core`。
2. 从 `service-entry` 引入共享健康/网络/secret 工具。
3. 给 `service-entry` 增加统一网关代理雏形。
4. 补 `manager-core` 独立测试。
5. 再逐步让 vLLM / llama 引用共享核心。

## 6. 风险与控制

- 不一次性重写两个大 `server.js`。
- 不改变现有 manager 的公开接口，先增加共享层。
- 不把统一入口绑定到 LAN，除非用户明确启用。
- 不停止或删除正在运行的模型容器。
- 不把 API Key 打印到日志或前端。
- 每批至少跑：
  - `node --check`
  - vLLM tests
  - llama tests
  - manager-core tests
  - 统一入口 smoke test

## 7. 完成定义

平台级完成定义：

- 统一入口可以作为唯一用户入口。
- 外部设备可以通过统一入口拿到 OpenAI/Claude 兼容服务。
- 客户端 Key、统计、限流、错误定位统一。
- vLLM 和 llama 的差异清晰、可解释、可切换。
- 前端体验一致，日常使用不用理解底层细节。
