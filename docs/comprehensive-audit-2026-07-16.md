# 本地模型服务平台 · 综合审计报告（2026-07-16）

审计对象：service-entry、vllm-manager、llama-manager、manager-core、shared-public 及全部前端代码（合计约 3.5 万行）。
方法：全部关键代码通读 + 单元/烟测运行 + 实机启动三个服务用 Playwright 对 19 个视图截图验证、XSS 注入实测、稳态轮询观测、375px 窄屏实测。实机环境为带 NVIDIA RTX PRO 5000（48GB）+ Docker 的生产在用机器，验证时有一个真实 vLLM 容器在运行。
历史参考：本报告不重复 `platform-audit-remediation-2026-07-10.md` 已整改的内容。

## 测试基线（全部通过）

- 单元测试 188/188：manager-core 100、service-entry 8、vllm-manager 46、llama-manager 34。
- 前端 Playwright 烟测 2/2。
- 实机验证：19 个视图 **0 console 错误、0 页面异常、0 失败请求**；375px 窄屏无横向溢出；XSS 载荷（`<img onerror>`）在模型库搜索框与下载模型 ID 输入框均未进入 DOM、未执行。

## 总体评价

这是一套完成度很高的本地 LLM 服务控制台：启动流程有串行化、端口预检、镜像预拉和容器级自动回滚；网关鉴权 fail-closed、并发队列、限流、访问审计、统计账本、JSON 原子写入等基础设施扎实；前端是少见的"重操作逻辑"设计（防重复提交、轮询感知页面可见性、按视图懒加载、滚动位置记忆、双语运行时切换）。主要风险集中在 **service-entry 这一层的安全防线明显弱于两个 manager**（无 Origin/Host 校验、shutdown 端点漏检、CORS 反射），以及 **local-only 信任边界被统一网关在回环代理下穿透**、双 manager 大体积代码复制带来的漂移。

---

## 严重问题

### S1. service-entry 的 shutdown 端点缺少本机校验，LAN 模式下可被远程关闭
`service-entry/server.js:113-116`：`POST /api/shutdown`、`POST /api/manager/shutdown` 直接执行 `shutdownSoon()`；而相邻的 start/stop/stop-all（93-108 行）都有 `core.isLocalRequest` 检查。统一入口以 LAN 模式启动后，任何局域网设备 POST 一下即可关掉整个网关。
修复：为这两个端点补上 `isLocalRequest` 检查（与 `/api/stop-all` 一致）。

### S2. service-entry 全站无 Origin/Host 校验，本机浏览器可跨站操控
manager-core 提供了 `createManagerSecurityGuard`（Host 白名单 + 变更请求 Origin 校验，manager-security.js:44-66），两个 manager 都接入了，但 service-entry 是裸 http 服务没有使用。后果：用户浏览器打开任意恶意网页，即可向 `http://127.0.0.1:5176` 发起跨站 POST——`/api/stop-all` 关掉所有管理界面、`/api/managers/{id}/start|stop` 启停管理器（这些端点的 `isLocalRequest` 检查看到的是回环地址，照常放行）。这是典型的本地 CSRF/DNS-rebinding 面。
修复：在 `handleRequest` 入口对所有变更请求校验 `Origin`（存在时必须在 127.0.0.1/localhost/LAN 白名单内），并对全部请求校验 `Host` 白名单；可直接复用 manager-core 的 guard 逻辑。

### S3. local-only 信任边界被统一网关回环代理穿透
manager 的服务网关用 `isLocalRequester`（gateway-utils.js:562-565）在 `exposureMode=local` 时只放本机连接；但 service-entry 转发时总是以 `127.0.0.1` 连接 manager（service-entry/server.js:288），manager 看到的永远是"本机"。结果：
- manager 配置为"仅本机"时，只要 service-entry 以 LAN 模式运行，局域网设备经 `/gateway/*` 即可使用模型，manager UI 却显示"只绑定本机"；
- 由于 local 模式默认 `requireApiKey=false`（service-policy.js:103），此时 LAN 访问是**免密**的。
审计时实机观察到 vllm-manager 配置为"局域网服务 + API Key 未强制"，且容器端口直接发布到 `192.168.0.126:8000`（UI 已正确标注"仅调试、绕过鉴权限流"）。
修复（任一即可，建议都做）：
1. service-entry 在 LAN 模式下对 `/gateway/*` 增加自己的网关级鉴权（或要求 manager 侧必须存在 key）；
2. manager 判定来源时，对来自回环且带有网关签名头的请求，改用 service-entry 写入的可信 `x-forwarded-for` 最右端重新计算 `isLocalRequester`；
3. 文档明确"exposureMode=local 在统一入口 LAN 模式下不生效"。

### S4. service-entry 网关 CORS 默认反射任意 Origin
`service-entry/server.js:561-572`：未配置 `SERVICE_ENTRY_ALLOWED_ORIGINS` 时 `allowedOrigin = origin`，即反射请求 Origin（且 `access-control-allow-headers` 含 authorization）。对比 manager 侧 `applyServiceCorsHeaders`（gateway-utils.js:541-560）默认**不**放行任何跨域——两处策略相反。反射型 CORS 意味着任意网站脚本都能从用户浏览器读写网关响应；配合 S2/S3，本地免密模式下可直接被网页调用模型。
修复：与 manager 对齐——默认不反射，仅显式配置时放行对应 Origin。

---

## 中等问题

### M1. 无 API Key 时网关限流可被 X-Forwarded-For 轮换绕过
`gateway-utils.js:567-570`：未认证请求的限流键为 `sha256(apiKey || req.headers["x-forwarded-for"] || remoteAddress)`。客户端每次换一个 XFF 值就得到新限流桶，`rateLimitRpm` 失效。仅影响"未配置 key 且对外开放"的场景（恰是 S3 的场景）。
修复：无 key 时只使用 socket 地址；XFF 仅在可信代理签名头存在时采纳。

### M2. Claude 会话标签把首条用户消息写入持久化账本
`vllm-manager/server.js:1900-1937` `deriveClaudeTaskSession`：会话 label 取首条用户消息前 96 字符，随 stats-ledger.json 落盘，并在压缩洞察接口和 UI 展示。README 与外来访问页都承诺"不记录提示词"，访问日志确实做到了，但这个会话标签是例外（虽然是截断的）。
修复：label 改为指纹短哈希或"会话 #n"，原文不落盘；或至少在 UI/文档明示。

### M3. 双 manager 大体积复制，前后端均已漂移
后端两个 server.js（3751 + 2566 行）约 2000 行同构复制；前端两个 app.js（4875 + 4107 行）同样。已观测到的漂移：
- vllm 有 Claude 会话跟踪与压缩洞察 UI、OpenCode 专用 handler（含 reasoning_content 回填 normalizeOpenCodeChatPayload，server.js:1676-1691）；llama 都没有，OpenCode 直接复用 OpenAI handler（llama server.js:625-626）；
- vllm 的 `serviceClientAllowsModel` 传了 runtime root 映射（server.js:1384-1387），llama 未传（llama server.js:1364），allowedModels 配 root 别名时两边判定不同；
- vllm 前端独有 recent launches、端口检查、自动调优、Claude 一键配置、README 预览等数十个函数。
修复：把 job/下载/统计/运行时实例/指标等无差异段落继续下沉到 manager-core 与 shared-public，两个 server.js 只保留引擎差异（启动命令、显存估算、GPU 规划）。

### M4. "停止服务 / 卸载模型"无二次确认
vllm app.js:4794 `stopService`、4534 `unload-model`；llama app.js:4038 `stopService`——均为一键执行；而删除模型、取消下载都有 confirm。移动端窄屏下"停止"按钮与"自动调优"并列，误触风险更高。运行中的模型服务被误停影响所有客户端。
修复：停止/卸载前加 confirm（文案说明不影响 Docker 之外的东西），或像 service-entry 的"关闭管理界面"一样统一确认模式。

### M5. 前端 API 客户端无超时
`public/js/api-client.js:2-21`：fetch 无 AbortSignal。manager 某个接口挂起时，UI 请求永不返回；叠加 5s/3s 轮询会产生堆积请求，按钮 busy 态也无法解除之外的恢复路径。
修复：request() 包一层 `AbortSignal.timeout(20000)` 并对轮询类调用做"上一次未结束则跳过"。

### M6. LAN 地址三处实现不一致
manager-core/network.js 的 `getLanAddress` 过滤虚拟网卡（docker/wsl/hyper-v 等）；两个 manager 各自的 `getLanAddress`（vllm server.js:2335、llama server.js:1566）不过滤，且 `addresses[0]` 兜底可能取到公网或 WSL 地址。同一台机器上 service-entry 与 manager 可能展示不同的"LAN 地址"。
修复：两个 manager 删除本地实现，统一用 core.getLanAddress。

### M7. service-entry 状态接口无鉴权的信息暴露
`GET /api/status`、`GET /api/gateway-access`（server.js:72-92）返回 PID 文件路径、日志路径、来源 IP/UA/模型名等。LAN 模式下任何设备可读。配合 S2 修复 Host/Origin 后影响降低，仍建议 LAN 模式下对这些读接口加限制或脱敏（路径类字段仅本机可见）。

### M8. 显存估算接口被渲染链路反复触发
稳态观测（页面闲置 20s）：`/api/memory-estimate` 被调用 6 次，其余 status 6、jobs 9、instances 2。显存估算被 status 渲染链带动，频率远超用户操作需要。
修复：仅表单输入/模型变化时触发，或把渲染期的估算结果缓存到 status 快照里复用。

---

## 低 / 建议

- service-entry 网关在 manager offline 分支记录访问日志时把 `Date.now()` 当 startedAt 传入，durationMs 恒为 0（server.js:283）。
- 模型名解析兜底静默落到第一个服务模型（vllm server.js:1980-1981、1995），客户端写错模型名不会收到 404；建议至少在响应头加 `x-resolved-model` 提示（访问日志已记录 resolvedModel）。
- 网关 `res.setTimeout` 到点强制结束响应（gateway-utils.js:802-805）：超长流式生成（默认 600s）会被中途切断，建议流式期间按写出活动刷新计时。
- PRICE_PROFILES 硬编码且带 `pricingAsOf`（vllm server.js:433-442），无更新机制，成本对比会失真；GPU 性能系数表（gpu-plan.js:184-194）同理。
- `collectStats` 每次请求都写 metrics-history（vllm server.js:3130），与 60s 定时采样叠加，采样间隔不确定；建议只保留定时采样。
- Claude 转换中 thinking/redacted_thinking 块被丢弃（claude-bridge.js appendAnthropicMessageAsOpenAi），多轮思考上下文丢失，建议文档注明。
- `auditToken` 存 localStorage（vllm app.js:17）；审计 Markdown 含对话导出，建议改内存/sessionStorage。
- api-client 对 GET 也发送 `content-type: application/json`（api-client.js:4）。
- gpu-plan.js `selectPlanGpus` 选中 ID 无匹配时静默回退第一张卡（146-153），建议返回提示。
- service-entry `handleRequest` 兜底 500 直接回显 error.message（server.js:118-120）。
- 前端 i18n 用 MutationObserver 监听整棵 body 树（app.js:386-396），大列表渲染时 TreeWalker 全量扫描有性能开销；已有调度去抖，建议后续按渲染函数内联翻译替代。
- 窄屏（≤620px）侧边导航折叠为纯图标条且无文字标签/提示，辨识度一般。
- service-entry 页点击"关闭管理界面"后仍每 15s 轮询 `/api/status`，控制台持续报错，建议检测关机后进入终态页。
- hash 比较用 `===`（secrets.js:44、service-policy.js:369）：因比较的是哈希而非密钥本身，实际风险极低，仅建议统一为 timingSafeEqual。

---

## 前端设计与操作逻辑专项评价

**信息架构**：三层结构清晰——service-entry 做总览/网关/文档入口；manager 内 9 个视图（服务、模型、下载、对外服务、外来访问、工具、统计、审计、日志）职责分明；启动流程做成 4 步向导（选择模型→资源配置→模型能力→访问与确认），是本系统操作逻辑的最大亮点，把"启动一个 vLLM/llama.cpp 服务"这种高门槛操作变成了可引导流程，且每步有显存估算、端口预检、兼容性检查随行。

**操作反馈**：所有变更按钮都有 busy 态与 spinner；toast 分 success/info/error；任务系统（下载/启动/基准）有进度百分比、阶段文案、日志展开；危险操作大多有确认（见 M4 的例外）。

**状态一致性**：hash 路由与视图状态同步、滚动位置按视图记忆、按视图懒刷新；轮询全部检查 `document.hidden`；表单输入 debounce（估算 450ms、端口 500ms）；下载目录名随模型 ID 联动且尊重手动修改；重试启动任务时不持久化 API Key 并明确提示。

**视觉与可用性**：卡片式布局对齐工整，状态色（ok/warn/fail）语义统一；空状态有解释文案（如"为什么启动慢、显存高？"）；暗色模式完整；窄屏布局可用。图标用 lucide 并带 fallback。可访问性有 aria-current、aria-live toast、图标 aria-hidden、外链 rel 处理。

**实测确认**：19 视图零报错；XSS 实测无注入（渲染层 escapeHtml/escapeAttr 使用一致，miniStat/statsMetric 等共享组件默认转义）；窄屏无横向滚动。

## 后端与架构评价

- **manager-core 抽象良好**：鉴权策略、限流并发队列、访问日志（32MB×5 滚动）、统计账本、JSON 原子写（队列 + lock 目录 + temp rename）、容器替换回滚、健康探针等均为共享实现，两个 manager 只是组合根。
- **Claude/OpenAI 协议转换质量高**：tool_use/tool_result/image/流式 SSE 全链路，工具增量与断连处理完备；压缩保留工具调用对。
- **隐私工程**：访问日志只记元数据、审计导出带 SHA256SUMS、密钥只存 hash、审计会话 token 存 hash。例外见 M2。
- **主要架构债**：M3 的双 manager 复制；service-entry 未复用 manager-core 的安全件（S1/S2/S4 同根）。

## 实机运维观察（非代码问题）

- vllm 外来访问 34 次外部请求、错误率 91.2%（0 鉴权失败、0 限流）——多为错误路径/方法的外部请求，像是扫描或客户端配错 Base URL，值得在运行手册里给出排查指引。
- 当前 vllm-manager 配置为"局域网服务 + 未强制 API Key"，且容器端口直接发布到 LAN（192.168.0.126:8000）——若局域网不可信，建议开启网关 API Key 并收回容器 LAN 发布。

## 整改优先级建议

1. 立即（安全）：S1、S2、S4（service-entry 三处，代码量小、收益大）；M2（隐私声明一致性）。
2. 近期（安全边界）：S3 的网关级鉴权或可信 XFF 判定；M1 限流键修正；M7 读接口脱敏。
3. 体验修正：M4 停止确认、M5 fetch 超时、M6 统一 getLanAddress、M8 估算触发收敛。
4. 架构健康：M3 双 manager 公共逻辑下沉；补 service-entry 的 Host/Origin 测试与"LAN 模式免密"的集成测试。
