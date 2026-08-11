# 平台全面审计报告 — 2026-08-11

审计范围:`service-entry`(约 4900 行)、`manager-core`(约 15700 行)、`llama-manager`(约 11700 行)、`vllm-manager`(约 13100 行)、`search-gateway`、`shared-public` 前端、部署模板与发布脚本、仓库卫生。方法:按组件并行深入阅读全部源码(非抽样),对照 README 安全承诺与历史审计(2026-06-14 / 07-10 / 07-16 / 08-04)验证遗留项。

历史背景:08-04 安全加固轮修复了签名回环跳转、Host/Origin 校验、CORS 默认拒绝、API Key 重启失效等核心问题。本轮审计确认这些修复**有效**(见末节"已确认无问题的关键路径"),但发现了一批新问题和两个仍未处理的架构债。

---

## 一、高危问题(6 项)

### H1. 公网反代部署下全部管理端点对互联网无鉴权开放
`service-entry/lib/security.js:119-128`,`server.js` 管理端点(186/204/209/223/241/249/256/263)
`checkManagementAccess` 只看 `req.socket.remoteAddress` 是否回环。平台自带并文档化的公网模板 `deploy/public/Caddyfile:27` 把公网域名 `reverse_proxy 127.0.0.1:5176`,此时所有请求的 socket 都是回环,管理鉴权整体失效。
**触发**:按 deploy/public 模板上线后,互联网任何人可 POST `/api/shutdown`、`/api/managers/*/stop`、`/api/stop-all`,可读写 `/api/fleet/settings`,可读 `/api/status` 未脱敏数据。仅 `/api/billing/*` 因 `strictLocalBillingAdmin` 拒绝带转发头的请求而幸免。
**修复方向**:管理端点要求存在且验证网关自签的 loopback-only 标记,或要求部署模板强制 `SERVICE_ENTRY_ALLOW_LAN_ADMIN=0` 之外的显式管理面鉴权;文档补充该场景。

### H2. API Key `auto` 模式在反代公网部署下静默失效
`service-entry/lib/security.js:54,68`
`lanMode` 仅由绑定地址推断。反代部署时 service-entry 仍绑 127.0.0.1 → 不强制 API Key,但服务经 Caddy 对公网可达 → 公网免 Key 调用全部模型推理。`deploy/public/README.md` 未要求 `SERVICE_ENTRY_REQUIRE_API_KEY=1`。
**修复方向**:`deploy/public` 模板与文档强制要求 `SERVICE_ENTRY_REQUIRE_API_KEY=1`;或提供 `PUBLIC_MODE=1` 显式开关使 auto 判定考虑反代场景。

### H3. search-gateway:CORS 反射 + 无 Key 回环豁免 → 恶意网页盗用本机推理并可读响应
`search-gateway/server.js:483-491 + 378-398`
`corsHeaders()` 无条件回显请求方 Origin 且允许 `authorization` 头;`authorizeGateway()` 在未配置 `SEARCH_GATEWAY_API_KEY` 时,回环监听 + 来源 127.0.0.1 即放行(直接 `node server.js` 的默认形态)。恶意网页 `fetch("http://127.0.0.1:5180/v1/chat/completions")` 即可让 gateway 附服务端持有的 `UPSTREAM_API_KEY` 转发推理,响应因 CORS 回显可被网页读取。`SEARCH_GATEWAY_ALLOW_NO_KEY=true` 时 LAN 同样成立。
**修复方向**:无 Key 模式只应答无 Origin 头的请求;CORS 改白名单制。

### H4. 取消下载可删除整个 modelsRoot(两个管理器同源)
`manager-core/settings-stores.js:9-16` + `model-filesystem-store.js:30-39` + `download-job-controller.js:165-171`
`safeOutputName(".")` 原样返回 `"."`(`".."` 也被折叠成 `"."`),`localDir = path.join(modelsRoot, ".")` = modelsRoot 本体;`resolveModelsRootChild` 显式放行 `resolved === root`;`deletePartialDownload` 无根目录保护,直接 `fsp.rm(resolved, {recursive:true})`。
**触发**:`POST /api/models/download` 传 `outputName: "."` → 随后取消 → **整个模型库被递归删除**。`vllm-manager/server.js:791` 的删除路由专门有 root 守卫,但取消路径没有。
**修复方向**:`startDownloadRequest`/`deletePartialDownload` 拒绝 `localDir === modelsRoot`;`safeOutputName` 拒绝 `"."`/`".."` 及折叠结果。

### H5. 上下文压缩预筛系统性低估代码/路径 token,该压缩时不压缩
`manager-core/claude-compression.js:174-176, 12-19`
`estimateTokenCount` 标点按 0.35 token 计(实际 BPE 约 1 token/个),`[A-Za-z0-9_./:-]+` 把整条路径/标识符算 1 词。预筛 `estimatedPromptTokens + maxTokens >= contextLimit * 0.6` 不成立就直接 return,连精确 `/tokenize` 都跳过。
**触发**:含大量工具输出/代码/路径的长会话,真实 token 已达上限而估值低于 60%,压缩被跳过 → vLLM 返回 context-length 400。核心功能在最需要它的场景失效。
**修复方向**:低估场景回落到 `/tokenize` 精确计数(如估值在 40%-60% 区间时仍做精确计数);校正标点/标识符权重。

### H6. 显存估算启发式硬编码 kvHeads=8,MHA 模型 KV cache 低估 4 倍
`manager-core/memory-estimator.js:5-12, 39-41`
`DEFAULT_ARCH_BUCKETS` 全部 `kvHeads: 8`;Llama-2-7B、Mistral-7B 等 MHA 模型 kvHeads=32。无 config/GGUF 元数据时走纯启发式路径 → KV 低估至 1/4,估算给出 `ok` → 运行时 CUDA OOM。27B/32B 档 `layers:48` 对 Qwen2.5-32B(实际 64 层)低估 KV 25%。
**修复方向**:启发式按档位区分 MHA/GQA;无元数据时结论降级为"粗略"并在 UI 明示。

---

## 二、中危问题(按主题归并)

### 网关与鉴权(service-entry / manager-core)
1. **`/gateway/` 路径完全豁免 Origin 校验 → 盲 CSRF 消耗 GPU**(`security.js:103-108`):默认本机模式不要求 Key,恶意网页用 `content-type: text/plain` 即可跨站驱动本机推理(无 preflight,CORS 只挡读响应)。与 README"浏览器跨域默认拒绝"冲突。
2. **Origin 校验只比 hostname 不比端口**(`security.js:76-90,104-106`):本机任意端口的恶意页面可通过变更请求 Origin 检查,甚至满足 `strictLocalBillingAdmin` 操作计费后台。标准 Origin 比较应含 scheme+port。
3. **README 承诺的入口"限流"不存在**:service-entry 无任何限流代码,限流由下游管理器执行;入口层 API Key 爆破、目录探测无节流,401 无惩罚。
4. **访问日志记 socket 地址而非真实客户端**(`gateway-utils.js:1506`):LAN 客户端在管理器日志全记为 127.0.0.1,`external` 判定恒 false,外部访问统计/取证失效——签名链已解析出真实地址却未用于日志。
5. **未强制 Key 时限流/并发桶可轮换绕过**(`gateway-utils.js:1473-1476`):指纹取 `apiKey || origin.address`,无效随机 Key 即获新桶。无效 Key 应回落到地址指纹。
6. **开放 CORS 模式反射 Origin + credentials + PNA 三者叠加**(`gateway-utils.js:1406-1418`):建议 open 模式不下发 `allow-credentials`。
7. **网关签名只绑定 (clientAddress, timestamp)**(`gateway-trust.js:88-93`):5 分钟窗口内可跨路径/跨管理器重放。建议 method+path+manager 纳入 HMAC。
8. **search-gateway 管理员 safe_search 策略可被客户端覆盖**(`search-gateway/server.js:171,331`):`safesearch` 参数未做范围校验,`safesearch=0` 绕过实例级策略。

### 下载与任务(manager-core / vllm / llama)
9. **续传/自动重试丢失 HF_TOKEN**(`download-utils.js:182-196`):token 不进 meta,暂停后继续、失败自动重试都 401。
10. **取消"重新下载"删除已有完整模型**(`download-job-controller.js:139-155` + vllm `server.js:821-862` / llama 同构):对已存在模型的目录再发起下载,排队/运行中点取消 → 旧模型被静默删除。
11. **spawn 同步抛错留永久 "running" 僵尸任务**(`process-job-runner.js:47-56`):`hasRunningDownload()` 恒 true,队列永久阻塞,任务不可取消。
12. **下载启动不校验磁盘空间**(vllm `server.js:821-862`):`expected.bytes` 只写日志;磁盘写满后自动重试放大写入。
13. **自动重试不区分失败类型**(`download-job-controller.js:261-294`):401/gated、磁盘满、校验失败一律整包重下。
14. **模型名未拒绝前导 `-`**(两个管理器):无 shell 注入(execFile 数组),但可被解析为 CLI flag 造成参数错位。建议正则白名单。

### 存储与并发(manager-core)
15. **读-改-写竞态丢配置更新**(`settings-stores.js:71-95`、`service-entry/server.js:217-219` 舰队设置):写队列只串行化"写",不覆盖读-改-写周期;并发更新静默丢失。
16. **stats-ledger 无界增长**(`stats-ledger-store.js:138-145` + `stats-utils.js:446-449`):`runtimes` 键永不清理;`aliases`/`models` 以客户端提供的任意模型名为键,可被随机模型名无限撑大。
17. **审计 markdown 流无 error 监听 → TOCTOU 崩溃**(`audit-routes.js:5-8`):stat 与流之间目录被 prune 删除 → uncaught exception → 管理器进程崩溃。
18. **审计增量游标竞态丢聊天**(`openwebui-audit-exporter.js:89-98`):先拉行再取 max(updated_at),窗口内更新的聊天永久漏出审计。
19. **文件锁超时(15s) < 陈旧锁阈值(30s)**(`file-utils.js:162-189`):持锁进程崩溃后最长 30s 内所有写失败,任务账本变更不落盘。
20. **备份无保留策略、一个损坏文件拖垮整体**(`manager-backup.js`):备份无限积累;任一配置损坏 → 整个备份/列表失败。

### 运行时与协议(manager-core / vllm / llama)
21. **KV cache 按单序列估算**(vllm `lib/memory-estimate.js:55-69`):`maxNumSeqs` 不参与估算,`maxNumSeqs=8 + 长上下文` 被评 ok,实际 KV 需求 8 倍 → OOM。
22. **docker 写命令完全无超时**(`docker-runtime.js:31-37,182`):Docker Desktop 卡死时 `docker run/pull` 永久挂起,启动 job 永不结束,租约悬挂。
23. **压缩边界产生悬空 tool 消息**(`claude-compression.js:81-98`):单遍扩展,跨边界的 tool_result 无配对 tool_use → 转换后 400。
24. **tool_result 图像内容转换中静默丢失**(`claude-bridge.js:62,178-195`):多模态工具结果变空串。
25. **密钥脱敏中间件只拦 `res.json`,`res.send` 完全绕过**(`manager-routes.js:196-205,273-299`):备份下载/日志导出路径;备份是设置全量拷贝,若含 HF token/明文 Key 则未脱敏外泄。
26. **GPU 租约过期后 commit 静默返回失败**(`gpu-admission.js:635-658`):大模型加载 >15 分钟租约失效,两个容器同时抢 VRAM → OOM,无告警。最需要保护的慢启动场景失效。
27. **停滞误判杀正常启动**(`runtime-wait.js:189-215`):只看日志是否有新行;70B 级模型权重 mmap 数分钟无日志被判卡死终止。
28. **llama KV 容量单位混用,stats 容量被放大 maxNumSeqs 倍**(llama `server.js:2666-2674`):每槽 token 数与总 ctx-size 两个来源统一再乘并发数。
29. **回滚容器无回收,崩溃后永久泄漏**(vllm + llama 同源,`container-replacement.js:67-105`):rename 后进程崩溃/commit 失败 → `*-rollback-*` 容器残留,被当实例列出,无启动时 GC;无属主标签的同名容器会被接管删除。
30. **llama LAN 模式容器端口绕过网关且可无鉴权**(llama `runtime-command.js:84-116`):LAN 绑定时 llama-server `--host 0.0.0.0` 而 `--api-key` 仅用户显式提供才传 → LAN 直连裸奔,仅 warn 不阻止。
31. **vllm manager-public-proxy:HTTP Basic 明文暴露 0.0.0.0:55177,无防爆破**(`vllm-manager/manager-public-proxy.js`):建议仅绑回环或加失败计数。
32. **用户提交的 maxNumBatchedTokens 被静默丢弃**(vllm `launch-request.js:224-270`):兼容性建议的 8192 永远到不了 docker run。
33. **express.json 32MB 解析在网关鉴权之前**(vllm `server.js:581-582`):预认证内存/CPU 放大面,建议网关路径先鉴权或降 limit。

### 发布工程(build-github-release.ps1)
34. **身份泄露检查可被路径写法绕过**(:223-228):只做字面 `IndexOf`,`C:/Users/zlk`(正斜杠)、`%USERPROFILE%`、8.3 短名均不命中。与 README 承诺不符。
35. **密钥格式清单漏本平台真实使用的令牌**(:229-236):无 `hf_…`(下载表单明确接受 hfToken)、Google `AIza…`、npm、JWT。
36. **内容扫描按扩展名白名单,漏 Caddyfile(无扩展名)与 .css**(:238-241):这些文件会被打包但永不扫描。

---

## 三、低危问题(摘要)

- 计费:过期预约 authorize 重放仍放行且不占额度(billing-store.js:550-559);空 JSON body 500 而非 400(billing-http.js:209-212);`limit=abc` 解析 NaN 边界失效(server.js:798)。
- 密钥/安全细节:哈希比较用 `===` 非恒定时间(service-policy.js:431 等);密钥吊销最长 5 秒缓存窗口(security.js:20);`"unknown"` 被当作本地地址的边界(manager-security.js:30);固定窗口限流边界 2 倍突发;`icacls /grant:r` 残留显式 ACE 的脆弱依赖(runtime-secret-store.js:108)。
- 任务/存储:暂停-继续-取消竞态(暂停意图可被翻成删除);同秒同 auditId 导出互相覆盖;内存 jobs Map 永不裁剪;符号链接逃逸路径校验(信息泄露面);PID 复用 taskkill 风险;`collectModelFiles` maxFiles 限制不严;业务校验错误一律 500。
- 运行时:已 done 的 tool_call 迟到 delta 参数丢弃;非数值参数 NaN→null 透传;`docker logs` 10s 超时误伤;`replaceDockerPublishArgs` 隐式耦合 `--ipc=host`;GGUF 元数据读取可达 4GB 分配 + 同步 I/O 阻塞事件循环;张量维度乘积无溢出保护;shutdown 未排空 keep-alive;"API ready" 死分支;prometheus label 反转义顺序;`*Gb` 命名实为 GiB 的陷阱。
- 前端/部署:`clipboard.writeText` 无 catch(LAN http 下静默失败);5 处属性插值未转义(当前不可注入);searxng `secret_key` 硬编码默认值;`/health` 泄露内部地址;Dockerfile 无 USER(root 运行);413 被当 500 返回。
- vllm:非流式桥接不随客户端断开中止上游(GPU 空跑);MTP 名称启发式误报;日志脱敏仅覆盖 ≥6 字符密钥;cc-switch 备份无清理;UPnP 工具硬编码内网 IP。

---

## 四、架构与运维债(历史遗留,本轮核实仍在)

1. **`.git` 是空目录,项目无版本控制** — 2026-06-14 审计即列为 P1,至今未处理。本轮全部修复记录无法追溯 diff。
2. **三份代码副本并存且已漂移** — `llm manager/`(82MB)、`github-release/`(过期)、主工作区,本轮实测 `manager-core`/`service-entry` 大量文件不一致;过期副本是误用与误导来源。
3. **双 manager 公共逻辑下沉(M3)仍暂缓** — OpenCode handler、`serviceClientAllowsModel` 参数差异等漂移点仍在;本轮发现的下载/取消/回滚类问题多数是"两处同构代码同一 bug",修复需改两遍,漂移风险持续放大。
4. **M8 显存估算接口被渲染链重复触发** — 仍未触碰。
5. **功能#1 内置对话测试台未实施** — 启动向导闭环仍断裂。
6. **工作区杂项** — 根目录 `router-*.html`(600KB 路由器管理页转储,与平台无关,未发现凭据)、`.gateway-trust.json` 为活跃共享密钥(已 gitignore,权限依赖 NTFS)。

---

## 五、已确认无问题的关键路径(抽查验证通过)

- **签名信任链**:HMAC 恒定时间比较、5 分钟窗口、伪造 marker fail-closed、token 文件 ACL 加固且每次请求重读;客户端信任头先剥离再重签,无法伪造。
- **API Key 重启失效修复完整**(08-04 升级提示的问题):空 apiKey 不再清哈希,旧明文 Key 自动迁移。
- **命令注入面**:全部 docker/hf/modelscope/taskkill/nvidia-smi 调用走 execFile/spawn 参数数组,无 shell 拼接;容器名/实例 ID 白名单化。
- **前端 XSS 面(本轮最高优先级排查)**:shared-public 全部 20 个渲染模块统一 escapeHtml;billing.html 零 innerHTML;未发现可注入点。
- **计费内部端点**:BigInt 金额、参数化 SQL、BEGIN IMMEDIATE、幂等键唯一约束、不可变触发器。
- **配置损坏 fail-closed**、**密钥只存哈希**、**日志/CSV 注入转义**、**JSON 原子写主链路**、**容器替换事务与 GPU admission 锁**、**GGUF 解析边界检查**、**build-muse-runtime.ps1 声明属实**。
- **search-gateway 主体**:有 Key 时恒定时间比对、Docker 默认 fail-closed、查询转发无注入、无 SSRF。
- **发布脚本主体**:路径防注入/防误删双重保护、robocopy 排除规则正确、打包后复查。

---

## 六、整改优先级建议

| 优先级 | 事项 | 理由 |
| --- | --- | --- |
| P0 | H4 下载取消删除 modelsRoot(加 root 守卫) | 数据毁灭,单行修复 |
| P0 | H1/H2 公网反代部署鉴权失效(模板+代码双修) | 已有用户文档引导该部署形态 |
| P0 | H3 search-gateway CORS/无 Key 组合 | 默认配置下"浏览网页即被盗用" |
| P1 | H5 压缩预筛低估 + #23/#24 压缩/桥接协议缺陷 | 核心功能正确性, Claude 客户端高频路径 |
| P1 | H6 + #21 KV/显存估算失真(MHA、maxNumSeqs) | 核心卖点功能,误导 OOM 决策 |
| P1 | #9 HF_TOKEN 续传丢失、#10 取消删除已有模型、#11 僵尸任务 | 下载流程数据/可用性 |
| P1 | #26 GPU 租约过期静默失败、#29 回滚容器 GC | 双容器抢 VRAM、磁盘泄漏 |
| P2 | #1-#7 网关鉴权细节(Origin 端口、签名绑定、日志真实地址) | 纵深防御,本机/LAN 场景 |
| P2 | #15-#20 存储并发与保留策略 | 长期运行稳定性 |
| P2 | #34-#36 发布脚本检查补强 | 下次发布前必修 |
| P3 | 架构债:初始化 git、清理过期副本、双 manager 下沉 | 所有后续修复的工程基础 |

---

*审计执行:8 路并行深入阅读(基线梳理、service-entry、manager-core×3、llama-manager、vllm-manager、前端与部署),覆盖全部自有源码;test/node_modules/模型文件不在范围内。*
