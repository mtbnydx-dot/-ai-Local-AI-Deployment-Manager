# 前端设计审计报告 — 2026-08-11

审计范围:`service-entry` 控制台(index.html / billing.html)、vllm-manager 与 llama-manager 前端(各约 12k 行)、`shared-public` 共享组件库(20 个模块 + lucide)。方法:三路并行审读全部前端源码 + 对运行中实例(5176/5177/5178)实机截图核对视觉效果。安全面(XSS)已并入 `comprehensive-audit-2026-08-11.md`,本报告专注设计/可用性/可访问性/性能;唯一新发现的安全相关问题见 §1 末尾。

---

## 一、高优先级问题(6 项)

### D1. 主控制台每 15 秒整树 innerHTML 重绘
`service-entry/index.html:911, 1099, 1281`
舰队面板与管理器卡片每 15s 整体重绘:用户展开的"详情"、文本选区、焦点全部丢失;且容器挂 `aria-live="polite"`,读屏器每 15 秒被迫重读整个面板。与控制台"监控+操作"定位直接冲突。
**建议**:按实例 ID 做 keyed 增量更新,`aria-live` 只挂小型状态摘要。

### D2. 计费页 LAN 场景导航完全失效
`billing.html:769-778, 804, 1139-1141`
侧边栏导航、"返回管理器"全部硬编码 `127.0.0.1:5177/5178`。平台定位是 LAN 小团队——局域网设备打开计费页点任何导航都会连回客户机自己的 loopback。
**建议**:用 `location.hostname` 拼接或由后端注入 baseUrl。

### D3. 手工积分调整(可负数、不可逆流水的扣款)无确认对话框
`billing.html:958-961, 2050-2060`
误输一个负号即不可逆扣款。模板套用有 preview→confirm 两步(做得很好),积分调整应对齐。

### D4. llama 侧英文模式基本失效
`llama-manager/public/js/i18n-copy.js:2-197`
字典仅约 100 条精确全串,且键与 HTML 实际标签不一致(字典"上下文长度" vs 页面"每槽上下文长度"),统计/外来访问/审计/启动表单等大半界面在 en-US 下仍是中文。vllm 侧 key 化 UI_COPY 明显更好。

### D5. lucide 全量包 355KB 加载,实际只用 39 个图标
`shared-public/js/lucide.min.js`(两个管理器 defer 加载)
浪费约 97% 体积。官方打包工具只导出用到的图标可降到 ~10KB。历史审计点名的"CDN 离线失效"已通过本地化解决,但体积问题仍在。

### D6. i18n 靠 MutationObserver 全树扫描兜底
`vllm-manager/public/app.js:413-432` + `llama app.js:4762-4775`
根因:共享组件 i18n 接口不统一(部分有 `labels()`,部分硬编码中文),只能在 DOM 层打补丁。渲染器每 3-5s 重写 innerHTML → observer 触发全页 TreeWalker。vllm 每轮询一次扫一遍;llama `renderIcons()` 中文模式下也白跑两遍全树翻译。
**建议**:组件层统一 `labels` 注入参数,删掉 DOM 翻译层。

### ⚠ 附带发现(安全,移交安全审计清单)
`shared-public/js/ui-architecture.js:4`:`escapeHtml` 的**默认 fallback 不做任何转义**,而 `serviceExposureHtml()` 会把 `navLabel/formNote/apiKeyLabel` 等参数拼进 innerHTML——宿主漏传 deps 即成 XSS 面。默认 fallback 必须换成真正的转义实现。

---

## 二、两管理器漂移对比(核心结构性问题)

vllm 侧在通用体验上持续进化,llama 停留在较早基线,只投入了 GGUF/异构双卡特色功能。漂移全景:

| 功能 | 更好的一方 |
|---|---|
| i18n 覆盖与机制、端口实时检查、启动取消按钮、上下文预设着色反馈、二分推荐上下文、超原生上下文警告、LAN 无 Key 内联警告、Key 同步回启动表单、Claude 压缩阈值编辑、一键 Claude、外来访问趋势、测试模型同步、stats hero 样式、焦点环/视觉基线 | **vllm** |
| 本地模型库(搜索+兼容筛选+GGUF 变体元数据面板)、显存估算数据源(GGUF 真实结构 vs 启发式)、异构双卡 split 推荐、KV/上下文措辞、picker 去重 | **llama** |
| 鉴权状态显示:vllm 用服务端权威字段,llama 用启发式 `requireApiKey && (hasKey || 客户端>0)`,**可能把未鉴权网关显示为已保护**(`service-exposure-renderer.js:118`) | **vllm(正确性)** |
| GPU 默认选择:vllm 默认只选 GPU 0,llama 默认全选 | 不一致,需确认是否有意 |
| 推测解码/推理控制 | 合理分化,不算坏漂移 |

`styles.css` 两边 diff 达 2732 行:status-pill 等共享 class 字节级相同却各存一份,无 shared-public/css;service-entry 更是 87KB 自包含单文件,三端视觉漂移没有防线。

---

## 三、中优先级问题(按主题)

**视觉/对比度**
- 暗色模式 `--blue:#6aa4ff` + 白字主按钮对比约 3:1(index.html:33);亮色 `--green`/`--amber` 用于 12-13px 徽章约 3-3.5:1,低于 AA(index.html:19-20);billing 主按钮 teal + 白字约 2.9:1(billing.html:639-640)。
- 三处品牌标识不一致("mtbnydx-dot"/"本地模型服务平台"/"V" 标;llama 角标仍是 vllm 遗留的 "V")。
- 截图核实:GPU 卡单位混用(`23803/97887 MB` vs 下方 `23 GB / 96 GB`);entry 页"网关错误率 100%"以橙色告警展示,无请求基数说明,易误导。

**反馈/状态**
- toast 2.2s 自动消失是关键错误的唯一通道(index.html:2107);无数据时 `管理器在线 0/0`、`GPU 显存 "-"` 误判为 ok 态(index.html:1226-1230);中文界面混出英文 `ok/warn/fail`。
- llama 侧多处反馈缺口:卸载成功无 toast、`notify()` 会把无关报错写进接口测试框(ui-utils.js:38)、启动无取消、端口冲突无预检。
- 两管理器日志页不自动轮询,看容器启动日志要手动刷新。
- billing 表单校验错误甩到页面顶部,字段旁无 inline 提示;刷新失败把 10 个接口错误拼成单条超长 notice。

**表单/校验**
- 两管理器 payload 构建对所有数值字段只 `Number()` 强转,不 clamp 不报错(端口 min=1024 手输 80 照样提交);llama GPU layers/tensorSplit 非法输入静默回退,用户无感知。
- llama `hfQuantHint` 是永久 disabled 的输入框,占位误导。

**响应式/布局**
- 舰队实例表 620-960px 区间无声裁切无横向滚动(index.html:512,519);≤620px 所有按钮强制全宽(含"详情/日志/复制"小按钮)。
- billing 列表 500 条静默截断,无"仅显示前 N 条"提示。

**组件库一致性**
- 导出三种形态并存(create(deps) / 扁平 window.xxx / 小写开头);`defaultEscape` 等 helper 在 8+ 文件逐字复制;事件绑定逐按钮 addEventListener vs 事件委托混用;diff-skip 只有 2 个组件有;i18n 默认语言三个组件三个样;列表上限 6/80/300 各自为政。
- 成本对比二维表格用 div 网格而非 `<table>`;sparkline 统一 `aria-label="trend"` 等于无替代文本。
- vllm `accumulateStatsSample` 约 120 行死代码;`moveAdvancedFields` 双边死代码;llama 每 500ms 轮询同步两个 select 的冗余 hack。

---

## 四、做得好的方面(应以之为基准)

- **显存估算反馈链**:前端即时 + 后端 250ms 防抖校准 + payload 签名去重 + GPU 条形图 + 可信度标注——同类产品少见的高质量反馈。
- **启动四阶段向导 + 启动前 review**,替换/重启/切换/并行语义清楚,"表单值不会被自动改写"承诺一致。
- **下载流完整**:链接解析、磁盘余量判断、include 过滤 0 匹配警告、暂停/继续/取消、顺序队列。
- **billing 模板套用**:选模板→服务端预览→参数签名比对→confirm,危险操作范本;页签是完整 WAI-ARIA tablist(方向键/roving tabindex)。
- **model-picker-renderer**:WeakMap diff-skip、滚动保留、dialog focus trap,教科书级。
- **connection-status**:断连横幅 + 数据新鲜度 + 后台标签页停 tick,全库最完整模块。
- 工程层:请求去重、8s 超时、mutation revision 防竞态、`fleetPolicyDirty` 防轮询覆盖编辑中表单、BigInt 数值、脱敏兜底、prefers-reduced-motion 双侧齐全。

---

## 五、总体评价与建议

**功能成熟度高于工程一致性。** 核心任务流(下载→估算→启动→观测)的反馈密度和文案质量远超一般内部工具;问题集中在三处:复制漂移(两个管理器 + service-entry 三套独立演化)、横切约定缺失(组件形态/i18n/事件/样式基线)、少数高曝光缺陷(15s 整树重绘、355KB 图标包、llama 英文模式失效)。

建议行动顺序:
1. **P0**:D1 增量渲染(主控制台可用性);D2/D3 计费页 LAN 导航与扣款确认;ui-architecture escapeHtml fallback(安全)
2. **P1**:D5 lucide tree-shake(一行构建脚本,收益最大);漂移对齐:llama 移植 vllm 的端口检查/启动取消/内联 Key 警告/鉴权状态权威字段;service-exposure-renderer 收回共享层
3. **P2**:D4+D6 i18n 重做(组件级 labels 注入,删 MutationObserver 层);抽 shared-public/css 基线;组件库统一 create(deps) 形态 + dom-utils
4. **P3**:对比度达标、品牌统一、暗色 token 收敛、死代码清理

截图证据:`.tmp/design-entry.png` / `design-vllm.png` / `design-llama.png`(1440×900 首屏)。

---

## 六、全量修复回执（2026-08-11）

本报告列出的 6 项高优先级问题、两管理器漂移项及中优先级可执行项已完成修复，并以 `D:\AI` 当前源码为准重新生成发布包。

- **D1**：统一入口改为按 manager/instance/slot/route 稳定键增量协调 DOM；后台刷新保留节点、焦点和展开状态，`aria-live` 收敛到小型状态播报区。
- **D2/D3**：billing 返回地址改用当前 `location.hostname`（含 IPv6 安全拼接）；不可变账本的正负调整均显示客户、记录、带符号金额和原因，负数扣款必须二次确认；字段错误改为就地提示并聚焦。
- **D4/D6**：两管理器共用基础词典和组件标签约定；动态区域采用变更根批处理，翻译刷新改为微任务，停止轮询时的整页重复扫描；llama 英文回归现在覆盖 9 个主页面的全部同名可见区域及异步内容，中文残留断言为 0。
- **D5**：Lucide 由 355,323 B 全量包改为 46 图标、19,334 B 运行子集（约减少 94.6%）；保留可复现构建脚本和上游完整源包。
- **漂移与一致性**：补齐 llama 端口预检、启动任务取消、LAN 无 Key 内联告警、鉴权权威状态、上下文预设/推荐/原生上限、Claude 压缩和一键配置、外来访问趋势、测试模型同步；`service-exposure-renderer` 回归共享层。
- **组件与可访问性**：新增共享 `dom-utils`/样式基线，统一 create/render 兼容导出、转义、列表上限、事件委托和 diff-skip；成本对比改为语义化 table，sparkline 增加可读标签；修复焦点环、状态对比度、toast 时长、窄屏溢出和小按钮误拉满宽度。
- **输入与危险操作**：前后端共同严格校验端口、上下文、并行槽、batch/ubatch、GPU 利用率、GPU layers 和 tensor split；移除误导的禁用量化提示；新增服务启动任务安全取消和归属检查。
- **体积与死代码**：移除重复 renderer/helper、500ms select 同步、旧 stats 累计和 `moveAdvancedFields`；发布脚本纳入图标子集构建资产。

验证结果：

- 源码树与干净解压发布包均通过：manager-core `156/156`、service-entry `69/69`、vLLM `65/65`、llama `50/50`、前端浏览器回归 `10/10`。
- 干净发布包三处 `npm audit` 均为 0 vulnerabilities；发布清单 217 个文件，运行数据/密钥命中 0。
- 真实浏览器验收：统一入口与 llama 桌面页面正常；英文 9 主页面无可见中文残留；390px 窄屏全局横向溢出为 0。
- 最终发布包：`D:\AI\artifacts\github-release\local-model-service-platform-v0.1.0-frontend-audit-20260811.zip`
- SHA256：`37bc9f1d62ea576e1b12e0a4e277519619314c6ef6048b548335f7a3bd7d3497`
- 为避免影响正在运行的模型，本轮未重启 llama 管理器或模型容器；容器验收时为 `healthy`、`RestartCount=0`、`OOMKilled=false`。涉及后端路由的新能力会在下一次正常重启管理器后生效。
