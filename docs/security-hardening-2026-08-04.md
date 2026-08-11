# 安全加固与功能改造记录（2026-08-04）

本次改造覆盖 `docs/comprehensive-audit-2026-07-16.md` 中全部严重项，并实施了四项功能改进。
未实施项集中记录在本文末尾的「归档」一节。

测试基线：**225/225 通过**（改造前 194），前端 Playwright 烟测 2/2。
分布：manager-core 114、service-entry 19、search-gateway 10、vllm-manager 48、llama-manager 34。

---

## 一、架构变化：鉴权上收到 service-entry

改造前，`service-entry` 是无鉴权的纯转发层，由两个 manager 各自把关。因为转发始终从
`127.0.0.1` 发起，manager 无法从 socket 地址判断真实来源，这正是 S3「local-only 边界被
回环代理穿透」的根因。

改造后：

```
客户端 ──► service-entry ──────────────────► manager ──► 模型容器
           │                    签名转发       │
           ├─ Host / Origin 校验              ├─ 校验签名，取真实客户端地址
           ├─ API Key 鉴权（唯一策略执行点）   └─ 回环 + 网关头但签名无效 ⇒ 判定为远程
           └─ CORS 默认拒绝
```

新增 `manager-core/gateway-trust.js`：

- service-entry 启动时在内存生成信任令牌，并发布到 `<AI_ROOT>/.gateway-trust.json`（0600）。
  由它拉起的 manager 通过 `SERVICE_GATEWAY_TRUST_TOKEN` 环境变量直接拿到，不读文件。
- 每次转发附带 `x-service-entry-client`（真实客户端地址）、时间戳和 HMAC 签名。
  客户端自带的同名请求头在转发前被剥离，无法伪造。
- manager 侧 `isLocalRequester` 的判定规则：

  | 来源 | 网关标记 | 签名 | 判定 |
  |---|---|---|---|
  | 回环 | 无 | — | 本机（直连客户端） |
  | 回环 | 有 | 有效 | 按签名中的真实地址判定 |
  | 回环 | 有 | 无效/缺失 | **远程**（fail-closed） |
  | 局域网 | 任意 | 任意 | 远程 |

- 签名超出 5 分钟时间窗即失效，防重放。

**注意**：令牌在内存中生成，写盘失败不影响签名——否则一次权限错误会让所有 local 模式
请求被判为远程而全部拒绝。写盘只服务于「独立启动的 manager」这一种场景。

---

## 二、已修复的审计项

| 编号 | 问题 | 修复位置 | 实机验证 |
|---|---|---|---|
| S1 | shutdown 端点缺本机校验，LAN 可远程关停 | `service-entry/server.js` 全部管理端点统一走 `checkManagementAccess` | `POST /api/shutdown` + 跨站 Origin → 403 |
| S2 | 全站无 Origin/Host 校验，本地 CSRF | `service-entry/lib/security.js` `checkRequest` | `Host: evil.example.com` → 403 `host_not_allowed` |
| S3 | local-only 边界被回环代理穿透 | `manager-core/gateway-trust.js` + `gateway-utils.js` | 单测覆盖 7 种来源组合 |
| S4 | CORS 反射任意 Origin | `security.corsHeaders` 默认拒绝 | 敌意 Origin 预检 → 无 `allow-origin` 头 |
| M1 | XFF 轮换绕过限流 | `serviceClientFingerprint` 改用可信来源地址 | 单测：轮换 XFF 落入同一限流桶 |
| M2 | Claude 会话标签把用户首条消息落盘 | `deriveClaudeTaskSession` 改用「模型 · 指纹前 8 位」 | — |
| M6 | 三处 `getLanAddress` 实现不一致 | 两个 manager 改为委托 `core.getLanAddress` | — |
| M7 | 状态接口无鉴权的信息暴露 | 非管理访问返回脱敏结果（去除 PID、路径、客户端明细） | — |
| 新 | search-gateway 鉴权 fail-open + 默认绑 0.0.0.0 | `authorizeGateway` 改 fail-closed，默认绑回环 | 单测 4 项 |
| 新 | 配置损坏时静默 fail-open | `readJsonFile` 对「存在但无法解析」抛错 | 单测：网关返回 500 且不放行 |
| 新 | **服务 API Key 每次重启后失效** | `normalizeServiceExposureSecret` / `normalizeSecretRecord` | 单测：保存→重启→仍可鉴权 |

### 关于最后一条

这是本次改造中发现的既有缺陷，两次历史审计都未记录，影响面比多数审计项更大。

`normalizeServiceExposureSecret` 把「持久化记录里的 `apiKey: ""`」当成「用户要求把密钥设为空」，
于是在加载时丢弃同一对象里的 `apiKeyHash`。结果是**全局服务 API Key 在 manager 重启后静默失效**。

本机 `vllm-manager/logs/service-exposure-settings.json` 正处于这个状态：
`requireApiKey: true`、`apiKeyHash: ""`，而 `notes` 写着 "Public vLLM NVFP4 service on 18080 with forced key"——
说明用户设置过密钥，但它没能存活。

清空密钥有独立的 `clearApiKey` 标志，因此「空字符串 = 未提供新密钥，保留原有 hash」是安全的。
`secrets.js` 中的 `normalizeSecretRecord` 有同样的缺陷，一并修复。

**升级后请重新生成一次服务 API Key**，此前配置的全局密钥已经丢失。

---

## 三、开关接口

所有开关都是环境变量，当前生效状态可通过 `GET /api/security` 查询，也会打印在启动横幅里。

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERVICE_ENTRY_REQUIRE_API_KEY` | `auto` | `auto` = 仅在监听非回环地址时强制；`1` = 始终强制；`0` = **关闭鉴权**（可信局域网免密） |
| `SERVICE_ENTRY_ALLOW_LAN_ADMIN` | `0` | `1` = 允许局域网设备访问管理端点（启停管理器、完整状态） |
| `SERVICE_ENTRY_ALLOWED_ORIGINS` | 空 | 逗号分隔的浏览器 Origin 白名单；留空表示不允许任何跨域，`*` 表示全放行 |
| `SERVICE_ENTRY_ALLOWED_HOSTS` | 空 | 额外 Host 白名单，用于反代域名 |
| `SEARCH_GATEWAY_ALLOW_NO_KEY` | `false` | `true` = 允许 search-gateway 无密钥对外服务 |
| `SEARCH_GATEWAY_BIND` | `127.0.0.1` | search-gateway 在宿主机的发布地址 |
| `AI_AUDIT_MAX_EXPORTS` | `30` | 审计导出保留份数，`0` = 不限制 |
| `AI_AUDIT_MAX_AGE_DAYS` | `90` | 审计导出保留天数，`0` = 不限制 |
| `AI_REFERENCE_DATA_DIR` | `<AI_ROOT>/config` | 价格/GPU 参考数据的用户覆盖目录 |

**默认零配置可用**：本机模式（监听 127.0.0.1）下 `auto` 不强制密钥，行为与改造前一致。
只有以 LAN 模式启动时才要求密钥，这时若确实不需要鉴权，显式设置 `SERVICE_ENTRY_REQUIRE_API_KEY=0`——
`/api/security` 会返回一条 `fail` 级告警，启动横幅也会警告，但不会阻止运行。

免密 + 局域网管理的组合示例：

```cmd
set SERVICE_ENTRY_REQUIRE_API_KEY=0
set SERVICE_ENTRY_ALLOW_LAN_ADMIN=1
start-service-entry.cmd lan
```

---

## 四、功能改造

### 功能 #2：鉴权上收（见第一节）

service-entry 直接读取两个 manager 的 `service-exposure-settings.json` 与 `service-clients.json`，
因此**已有密钥无需重新生成**，两个 manager UI 的密钥管理界面照常使用。任一 manager 的全局密钥
或客户端密钥都可用于统一网关。

### 功能 #4：审计导出增量化 + 保留策略

- Python 导出器新增游标参数：只导出 `updated_at` 大于游标的会话，游标由上次运行的
  `max_updated_at` 原样回传，无需猜测时间戳单位（秒/毫秒）。
- 游标存在 `audit-logs/.audit-cursor.json`，仅在导出落盘成功后推进。
- 手动导出（UI 触发）仍为全量；`model-stop` / `model-unload` 等自动导出为增量。
  可用 `context.full = true` 强制全量。
- 保留策略：超出份数或天数的旧导出自动清理，**最新一份永不删除**，且删除前校验路径在
  审计根目录内。

实测（模拟 OpenWebUI 库）：全量 2 会话 2876B，新增 1 会话后增量导出仅 1716B 且只含新会话。

改造前 `audit-logs/` 已积累 133MB，单次导出 8.5MB，相隔 5 秒的两次导出各存一份全量副本。

### 功能 #5：配置校验与告警

- `readJsonFile` 现在区分三种情况：**不存在** → 返回 fallback；**存在但无法解析 / 为空** → 抛
  `CONFIG_CORRUPT`；**可读** → 正常返回。零长度文件视为截断写入的残留，按损坏处理。
- 所有损坏记录进入 `listConfigHealthIssues()`，在「对外服务」页作为 `fail` 级检查项展示。
- 服务网关中间件对读取失败返回 500 并拒绝放行（此前会退回默认配置，而默认配置的
  `requireApiKey` 是 `false`）。
- 前端 `renderPublicGuide` 改用服务端计算的 `gatewayApiKeyEnforced`，不再自行推断。
- `atomicWriteJsonFile` 在 Windows 上先重试 12 次原子 rename，仅在全部失败后才退化为
  非原子 copy——copy 中途崩溃正是产生截断配置的路径。

### 功能 #6：价格 / GPU 系数外置

- `manager-core/data/model-pricing.json`、`manager-core/data/gpu-performance.json`
- 用户副本放在 `<AI_ROOT>/config/` 同名文件即可覆盖内置版本
- 两份数据都带 `asOf` 与 `staleAfterDays`；超期时 `freshness.notice` 会给出中文提示，
  统计接口通过 `pricingFreshness` 下发
- 新增 `GET /api/reference-data`；前端启动时拉取并注入 GPU 系数表，失败则回退内置表
- 已验证：数据文件驱动的系数与原硬编码逻辑在 12 个 GPU 名称上完全一致；用户覆盖可新增
  机型；表结构损坏时回退内置表而非全部归零

---

## 五、前端体验改造（2026-08-04 第二轮）

### 连接中断横幅与数据新鲜度

改造前所有轮询失败都被 `.catch(() => {})` 吞掉（两个 app.js 合计 29 处），`notify` 从未覆盖轮询路径。
manager 进程崩溃、Docker 停止或机器休眠后，界面会继续显示最后一次成功的快照且没有任何提示——
对运维控制台来说，分不清「现在就是这样」和「十分钟前是这样」是根本性缺陷。

新增 `shared-public/js/connection-status.js`：

- `track(promise)` 包裹被轮询的 `refreshStatus` / `refreshJobs`，记录成败且从不 reject
- 连续 2 次失败后显示顶部横幅（`role="alert"`），标注最后一次成功的时间与相对时长
- 从未成功加载过时立即显示（没有陈旧数据可看，不必等第二次失败）
- 顶栏常驻新鲜度标记：数据新鲜时为空，超过 20 秒未更新才出现
- 恢复后横幅自动消失，并立即拉取一次完整数据，不等轮询周期
- 断连期间每 10 秒自更新一次相对时间，因为不会再有轮询回来重绘

### 模型选择器渲染

`renderModelPicker()` 挂在 5 秒一次的 `refreshStatus()` 上，而 `.model-picker-list` 是
`overflow: auto` 的滚动容器，每次都整段 `innerHTML` 替换：**打开选择器往下翻找模型，5 秒后跳回顶部**。

- 选择器关闭时直接返回，不再构建全量条目（原本每 5 秒遍历 running/local/cached/remote 并映射备注）
- 渲染结果与上次相同则完全不写 DOM（WeakMap 缓存，避免把大字符串塞进 data- 属性）
- 确实需要重写时先记录再恢复 `scrollTop`

### 导航可访问性

给两个 manager 的导航项补 `title` 与 `aria-label`，图标标注 `aria-hidden`。
运行时注入的「对外服务」项在 `ui-architecture.js` 注入处一并补上，否则它会漏掉。
vLLM 用 `applyNavLabel()` 让可见文字、tooltip、无障碍名称同源于 `t()`；
llama 用 `syncNavLabels()` 镜像短语翻译后的结果。

> **更正**：上一轮我曾称「窄屏下导航只剩 8 个无标签图标」，这是照搬 2026-07-16 审计的结论而未核对当前 CSS。
> 实际上 `styles.css` 在 `@media (max-width: 820px)` 里先 `display: none` 隐藏 `.nav span`，
> 但后面一个同断点区块又用 `display: inline !important` 把它显示回来，因此文字标签一直是可见的。
> 补 `title`/`aria-label` 仍有价值（悬停提示、图标加载失败时的兜底、无障碍名称不依赖 CSS），
> 但它是打磨项而非无障碍缺陷。

### 测试

新增 `tests/connection-status.spec.cjs`（9 条前端用例，已并入 `npm run test:frontend-smoke` 与 `test-all.cmd`）：
真实启动 manager 后中断 `/api/status` 与 `/api/jobs`，断言横幅出现、文案正确、恢复后消失；
断言中英文各自完整本地化（英文渲染中不得混入中文字符）；断言导航项在 600px 下仍有无障碍名称并随语言切换；
断言模型选择器滚动位置在一次轮询重渲染后保留。

实机确认：浅色/暗色两套主题下横幅配色均取自现有令牌；新鲜度标记在断连 20 秒后出现、恢复后清空。

---

## 六、归档：本次未实施的改进项

### 功能 #1：内置对话测试台（playground）

**未实施原因**：这是纯增量功能，工作量集中在前端（新视图、SSE 流式渲染、会话状态、
中止控制），与本次安全改造无重叠，混在同一批改动里会让回归范围难以界定。

**价值**：目前 8 个视图没有一个能发出一条消息。启动向导是本系统最大亮点，但走完向导后
必须切到 OpenWebUI 或 curl 才能确认模型真的可用，闭环在最后一步断裂。

**实施要点**：
- 新增 `#playground` 视图，复用 `/serve/v1/chat/completions` 与现有 `api-client`
- 流式渲染需要绕开 `api-client` 的 20s 超时（改用 `fetch` + `ReadableStream` + 手动 abort）
- 模型下拉直接复用 `/api/running-models`
- 注意：请求会计入访问统计与限流，需要在 UI 上说明，或为本机测试请求单独标记
- 不要持久化对话内容——与「不记录提示词」的承诺冲突（参见本次 M2 的处理）

### 功能 #3：双 manager 公共逻辑下沉

**未实施原因**：这是本次列表中风险最高的一项。两个 `server.js` 约 2000 行同构代码，
两个 `app.js` 同样。合并需要逐段比对已经发生的漂移（OpenCode handler、
`serviceClientAllowsModel` 参数、Claude 压缩 UI 等），且现有测试覆盖不足以在大规模移动
代码后保证等价。在同一批改动里做完安全加固再做结构重构，一旦回归将无法区分是哪一类改动
引入的。

**已做的部分**：本次新增的共享逻辑（`gateway-trust`、`reference-data`、配置健康）一开始
就放在 `manager-core`，两个 manager 只是调用方；`getLanAddress` 的三份实现已合并为一份。

**实施要点**（建议作为独立一轮）：
1. 先补集成测试，覆盖两个 manager 的 job / 下载 / 统计 / 运行时实例 / 指标接口
2. 按模块逐个下沉，每次只移动一个模块并跑全量测试
3. 保留引擎差异：启动命令构造、显存估算、GPU 并行规划
4. 前端同理，优先下沉 `shared-public/js` 已有的渲染器未覆盖的部分

### 其余未处理项（来自 2026-07-16 审计）

| 编号 | 问题 | 未处理原因 |
|---|---|---|
| M8 | 显存估算接口被渲染链路重复触发（闲置 20s 内 6 次） | 性能优化，需要重构前端渲染依赖，本次未触碰该链路 |
| 低 | manager offline 分支访问日志 `durationMs` 恒为 0 | 已随 S1/S4 改动保留原逻辑，属日志精度问题 |
| 低 | 模型名解析兜底静默落到第一个服务模型 | 行为变更会影响现有客户端，需要单独评估 |
| 低 | 网关 `res.setTimeout` 会切断超长流式生成 | 需要按写出活动刷新计时，涉及流式链路改造 |
| 低 | `collectStats` 每次请求都写 metrics-history | 与 60s 定时采样叠加，属采样策略问题 |
| 低 | Claude 转换丢弃 thinking / redacted_thinking 块 | 协议转换语义问题，需要单独设计 |
| 低 | `auditToken` 存 localStorage | 建议改 sessionStorage，属前端存储策略 |
| 低 | 窄屏侧边导航无文字标签 | 视觉可用性 |

### 未处理的仓库健康问题（非代码）

1. **`.git` 是空目录，项目无版本控制**。5.8 万行代码没有提交历史。本次改动前已在
   `artifacts/edit-backups/20260804-195919-security-hardening/` 备份了全部被修改文件。
   强烈建议尽快 `git init` 并提交一次基线。
2. **三份代码副本**：`llm manager/`（82MB，与主干仅 `file-utils.js` 一处差异）、
   `github-release/`（29MB，已过期，缺 6 个模块）、`artifacts/release-validation/`（27MB）。
   在建立版本控制前不建议删除。
3. **`.last-public-service-key.txt`**：明文服务密钥，仅被 `start-search-gateway.cmd` 读取，
   仓库内无任何代码写入它。该工作流实际是断的——文件不存在时脚本会静默地以无上游密钥启动。
4. **`audit-admin-password.txt`** 为明文存储，而它保护的是含完整对话正文的审计导出。
