# 本地模型公网计费与用量控制指南

## 入口与边界

- 统一服务入口：`http://127.0.0.1:5176/`，这里只保留计费中心入口。
- 独立计费中心：`http://127.0.0.1:5176/billing`。
- 公网模型 API 保持不变：
  - `https://api.zlk7301.com/vllm/v1`
  - `https://api.zlk7301.com/llama/v1`
- 计费管理 API 只接受直接连接到 localhost 的请求，不通过 Cloudflare Tunnel 或 Caddy 暴露。
- 计费库只绑定现有服务客户端的 `managerId + serviceClientId`，不读取、保存或显示明文 API Key。

## 首次配置顺序

1. 在 vLLM 或 llama.cpp 管理器的“对外服务”页创建服务客户端 Key，并保存好只显示一次的明文 Key。
2. 打开独立计费中心，在“套餐与价格”中创建套餐。建议先选择 `Shadow`。
3. 创建客户，可设置客户级月 Token、月请求和信用额度；输入 `0` 表示不单独设置该限制。
4. 在“手工积分调整”给客户增加余额。
5. 将客户绑定到第 1 步的服务客户端。下拉框只显示客户端名称、ID 和 Key 预览。
6. 为实际模型创建价格。可以手工填写，也可以在官方模板库中先选择价格快照，再明确映射到管理器、套餐和本地模型匹配规则。
7. 用真实客户端请求验证用量、投影费用和模型匹配无误，再将客户切换到 `Hard`。

## 单位与价格示例

- `1 积分 = 1,000,000 微积分`。
- 如果输入价为每百万 token 1 积分，填写 `1000000`。
- 如果输出价为每百万 token 2 积分，填写 `2000000`。
- 价格查找优先级：套餐专属优先于全局、具体管理器优先于 `*`、精确模型优先于更具体的通配规则，最后才是 `*`。
- 模型规则支持 `*` 和 `?`，例如 `Qwen/*`。

## 官方价格模板

- 模板是带版本、来源、快照日期和生效区间的只读参考，不会自动覆盖已经生效的本地价格。
- 默认换算为 `1 USD = 1 积分`，支持在预览时调整 USD 到积分的倍率及加价基点；换算全程使用十进制字符串与 BigInt，并向上取整到 1 微积分。
- 套用前必须为每条模板显式指定 `managerId + planId + 本地 modelPattern`。确认套用时最多 50 条作为一个事务写入，任一映射失败会整批回滚。
- 以下为 2026-08-11 官方公开页快照，单位均为 `USD / 1M tokens`：

| Provider | 模型 / 分档 | 输入 | 缓存读取 | 输出 | 生效区间 |
|---|---|---:|---:|---:|---|
| OpenAI | GPT-5.6 Sol，输入 ≤272K | 5.00 | 0.50 | 30.00 | 当前 |
| OpenAI | GPT-5.6 Sol，输入 >272K | 10.00 | 1.00 | 45.00 | 当前 |
| OpenAI | GPT-5.6 Terra，输入 ≤272K | 2.00 | 0.20 | 12.00 | 当前 |
| OpenAI | GPT-5.6 Terra，输入 >272K | 4.00 | 0.40 | 18.00 | 当前 |
| OpenAI | GPT-5.6 Luna，输入 ≤272K | 0.20 | 0.02 | 1.20 | 当前 |
| OpenAI | GPT-5.6 Luna，输入 >272K | 0.40 | 0.04 | 1.80 | 当前 |
| Anthropic | Claude Opus 5 | 5.00 | 0.50 | 25.00 | 当前 |
| Anthropic | Claude Sonnet 5（介绍期） | 2.00 | 0.20 | 10.00 | 至 2026-08-31 |
| Anthropic | Claude Sonnet 5 | 3.00 | 0.30 | 15.00 | 自 2026-09-01 |
| Anthropic | Claude Haiku 4.5 | 1.00 | 0.10 | 5.00 | 当前 |
| Google | Gemini 3.5 Flash | 1.50 | 0.15 | 9.00 | 当前 |
| Google | Gemini 3.5 Flash-Lite | 0.30 | 0.03 | 2.50 | 当前 |
| DeepSeek | DeepSeek V4 Flash | 0.14 | 0.0028 | 0.28 | 当前 |
| DeepSeek | DeepSeek V4 Pro | 0.435 | 0.003625 | 0.87 | 当前 |

来源：[OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)、[Anthropic Claude Pricing](https://platform.claude.com/docs/en/about-claude/pricing)、[Google Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing)、[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)。云厂商可能调整价格，正式对外销售前应重新核对来源页。

当前用量遥测只结算输入、缓存读取和输出 token。模板保留的缓存写入、缓存存储、Batch/Flex/Fast/Priority 等价格仅供参考，不会被错误映射到缓存读取费。当前价格解析也不会按单次请求的上下文长度自动切换 OpenAI 的 272K 分档；若要使用长上下文价格，需要映射到单独本地模型别名或单独价格规则。

## Shadow 与 Hard

- `Shadow`：记录 token 和预计费用，但不扣余额，也不因余额或额度拒绝请求。适合上线前观察。
- `Hard`：推理前预留预计最大费用并检查余额、月 Token、月请求和客户信用额度；不足时在请求到达 GPU 前拒绝。结束后按实际量原子结算。
- 流式响应优先使用上游最终 usage；若客户端中途断开但已有输出，使用有界估算结算已消费量；完全缺少或无法可信判断 usage 时不扣费并标记为 missing/ambiguous。
- 实际输出可能高于预留，系统会按实际量扣款，余额可暂时变为负数；后续 Hard 请求会被拦截。

## 数据与审计

- 中央账本：`D:\AI\service-entry\data\platform-billing.sqlite`。
- SQLite 使用 WAL、外键、busy timeout 和 `synchronous=FULL`。
- 余额调整、usage 和管理审计是不可覆盖记录；重复授权、结算和余额调整使用幂等键防止重复扣款。
- 金额在接口和 JavaScript 中使用十进制字符串，不经过浮点金额运算。

## TTS 用量计费

客户端 Key 经 `/gateway/tts/*` 合成时会记入 TTS 用量账本。Hard 模式在提交模型前预留余额与每日时长配额，异步批量和重试在完成后按成功字符数及实际音频时长结算，重启后继续核对待结算记录。Shadow 和未绑定客户只记录，不扣费。

套餐价格为 `ttsPerMinuteMicrocredits` 和 `ttsPerThousandCharsMicrocredits`，客户日配额为 `ttsDailySecondsLimit`。预留期间价格变更不会改变该次报价。实际音频超出预估、可用余额不足时记录 `billing_tts_balance_capped`，保留完整预计金额并限制实际扣款不产生负余额；应在账本中核对差额。

具体客户归属、历史数据兼容与恢复步骤见 [运行手册](service-runbook.md#11-tts-客户数据与用量)。

## 当前版本范围

- 中央计费覆盖两个管理器的 OpenAI 兼容公网路由。
- 当前不包含在线支付、自动续费、发票或套餐包含积分的自动月度入账；余额由本机后台手工调整。
- Claude/OpenCode 专用协议尚未接入中央扣费。当前公网 Caddy 也未开放这些协议。
