# 精细化功能审计报告

日期：2026-06-14  
审计对象：`D:\AI\github-release` 发布镜像  
审计目标：检查当前精细化功能是否可靠、是否可发布、是否容易继续扩展。

## 结论摘要

当前发布镜像的核心功能已经比较完整，没有发现会立刻阻断使用的 P0 问题。实际测试结果全部通过：

- `service-entry`：5/5
- `manager-core`：8/8
- `vllm-manager`：19/19
- `llama-manager`：13/13

但代码仍处在“功能快速堆叠后的可用产品”阶段，还没有进入“长期可维护、可发布、可多人协作”的形态。主要风险集中在：

1. 精细化功能分散在巨型文件里，改一个功能容易影响其它功能。
2. 显存估算已经抽出共享模块，但前端仍在复制估算公式。
3. 发布目录不是 git 仓库，没有 CI、tag、release notes 和自动校验。
4. 发布包仍有较多本机路径和硬编码启动依赖。
5. vLLM 与 llama 的任务持久化能力不完全对齐。

## 审计方法

- 检查发布镜像结构、文件规模、运行数据污染情况。
- 检索精细化功能：多卡、显存估算、内存回退、Claude 桥、上下文压缩、外来访问、统计、下载队列、审计导出。
- 临时在发布镜像中运行 `npm ci --ignore-scripts`，验证 clone 后安装依赖可行。
- 运行全部测试后清理 `node_modules`，保持发布目录干净。

## 重要观察

### 1. 文件规模仍是最大维护风险

当前核心文件规模：

- `vllm-manager/server.js`：8903 行
- `llama-manager/server.js`：7385 行
- `vllm-manager/public/app.js`：5706 行
- `llama-manager/public/app.js`：4371 行

这些文件承担了路由、Docker、下载、统计、Claude 桥、审计、前端渲染、i18n、显存估算等多个职责。功能确实跑起来了，但继续精细化时容易出现：

- vLLM 修了，llama 漏掉。
- 前端 UI 改了，后端参数含义没同步。
- 测试覆盖到了导出函数，但没覆盖 UI 交互和端到端行为。

建议优先拆分：

- `engine-adapters/vllm.js`
- `engine-adapters/llama.js`
- `features/claude-bridge.js`
- `features/service-exposure.js`
- `features/download-jobs.js`
- `features/audit-export.js`
- `features/stats-ledger.js`
- `public/js/memory-estimate.js`
- `public/js/download-page.js`
- `public/js/external-access-page.js`

### 2. 显存估算共享模块尚未成为唯一真源

已存在共享模块：

- `manager-core/memory-estimator.js`

它已经包含：

- `estimateVllmMemoryPlan`
- `estimateLlamaMemoryPlan`
- vLLM DP 不分摊显存的逻辑
- vLLM CPU offload 每卡口径
- llama GPU layers 回退到 RAM 的估算

但当前实际前端仍各自复制公式：

- `vllm-manager/public/app.js` 的 `estimateMemoryUsage`
- `llama-manager/public/app.js` 的 `estimateMemoryUsage`

这会造成长期漂移。下一步建议：

1. 后端提供统一 `/api/memory-estimate`。
2. 前端只收集表单值，把估算交给 `manager-core`。
3. 两个 manager 的估算 UI 使用同一份返回结构。
4. 每次启动时保存“估算快照 + 实际日志峰值”，后续可以自动校准误差。

### 3. 多卡支持方向正确，但还缺实测闭环

当前 vLLM / llama 的多卡策略已经有明显差异化：

- vLLM：同级卡优先 TP；异构大卡 + 小卡优先单大卡或 PP。
- llama.cpp：异构卡优先 layer split；OOM 时降低 GPU layers，把更多层留在 RAM。

这是正确方向。缺口是“建议来自估算，但还没有真实运行反馈闭环”：

- 未记录每次启动时的实际显存峰值。
- 未记录 prefill / decode / 首 token / 温度 / PCIe 限制。
- 未把不同 split 方案的实测速度反写为推荐权重。

建议新增“多卡实验记录”：

- 模型、量化、上下文、GPU 组合、split 参数。
- 启动是否成功。
- 首 token 时间。
- decode tok/s。
- GPU 显存峰值。
- GPU 利用率和温度。
- 是否触发 CPU/RAM 回退。

这样 96GB 大卡 + 5090 / 5070Ti 的推荐会越来越准。

### 4. vLLM 与 llama 的任务持久化能力仍不对齐

vLLM 已经有：

- `jobs-ledger.json`
- `loadJobsLedgerIntoMemory`
- `jobsLedgerWriteQueue`

llama 当前仍主要是：

- `const jobs = new Map()`
- 没有同等 jobs ledger 恢复流程

影响：

- llama manager 重启后，下载/启动/测速任务历史会更容易丢失。
- 暂停下载后如果管理器重启，恢复体验不如 vLLM。
- 前端统计和任务追踪两套引擎口径不一致。

建议把 vLLM 的 jobs ledger 抽到 `manager-core/job-ledger.js`，两个 manager 共用。

### 5. 发布目录仍偏本机化

发现较多硬编码路径或本机提示：

- `vllm-manager/package.json` 和 `llama-manager/package.json` 的 `start` 脚本使用 `D:\DevTools\NodeJS\node.exe`。
- `start-claude-vllm-proxy.ps1` 使用 `D:\AI\claude-vllm-anthropic-proxy.py`。
- 文档和 UI 多处直接写 `D:\AI\...`。

这些对你本机好用，但作为 GitHub 仓库会降低可移植性。

建议：

- package 脚本统一改成 `node server.js`。
- Windows 专用脚本里保留 `D:\DevTools` fallback，但不要让 npm start 依赖它。
- README 增加：
  - 推荐安装路径
  - 非 `D:\AI` 路径启动方式
  - `AI_ROOT`、`DEVTOOLS_ROOT`、`MODELS_ROOT`、`HF_HOME` 环境变量说明
- 所有文档里把 `D:\AI` 改成“默认示例路径”，不要写成唯一可用路径。

### 6. 发布工程化还没完成

`github-release` 当前不是 git 仓库。它是干净发布镜像，但还不是完整发布工程。

缺少：

- `.github/workflows/ci.yml`
- 根目录 `package.json` 或测试聚合脚本
- 版本号策略
- changelog
- release checklist
- GitHub issue templates
- 安装验证脚本

建议新增：

- `test-all.cmd`
- `install-all.cmd`
- `.github/workflows/ci.yml`
- `CHANGELOG.md`
- `RELEASE_CHECKLIST.md`
- `docs/install-windows.md`

CI 至少跑：

- `npm ci --ignore-scripts`
- `npm test`
- `node --check` for server/public JS
- 发布目录污染检查：禁止 `node_modules`、`logs`、`.pid`、`.db`、模型文件进入仓库

### 7. 外来访问功能已经有基础安全设计，但直连容器仍需更醒目

现状：

- 统一入口和 manager 网关会做访问日志、鉴权、限流、并发限制。
- 外来访问统计只记录元数据，不记录正文。
- 服务客户端 key 会 hash 存储，前端只显示一次明文。

风险点：

- Docker 容器直连端口不经过管理器网关鉴权。
- 页面已经提示这一点，但对普通用户可能仍不够强。

建议：

- 外来访问页把“推荐地址”和“危险直连地址”视觉分开。
- 对 LAN 模式启动，如果没有 API Key，启动按钮前弹一次确认。
- 给直连容器 URL 加红色 warning：“只适合可信内网调试，不要给客户端长期使用”。
- 统一入口默认只暴露 manager gateway，不鼓励暴露容器原生端口。

### 8. 统计功能已经细，但价值估算需要版本化

统计里包含：

- 请求数
- tokens
- Claude 调用分组
- 聊天/直连分组
- 外来访问统计
- API 等价价值估算

问题：

- API 价格常变，代码内静态价格表会过期。
- “等价价值”容易被误读为真实成本节省。

建议：

- 在统计页显示价格表版本日期。
- 把价格表移动到 `docs/pricing-profiles.json` 或 `manager-core/pricing.js`。
- 给用户一个选择：GPT / Claude / 自定义每百万 token 单价。
- 明确标注“估算价值，不是账单”。

### 9. 前端质量已经明显提升，但仍需要组件化和视觉 QA

当前页面已经具备：

- 深色/浅色/自动主题
- 中英切换
- 侧边栏功能页
- 外来访问页
- 下载进度和任务按钮
- 显存条和多卡规划

剩余风险：

- i18n 仍是大字典 + DOM 扫描，容易漏翻。
- vLLM 和 llama 的 CSS/组件实现不完全一致。
- icon 使用 CDN，离线时图标会丢。
- 巨型 `app.js` 修改风险高。

建议：

- 抽 `public/js/i18n.js`、`api-client.js`、`formatters.js`、`job-list.js`、`memory-panel.js`。
- lucide 改为本地 vendored asset，避免离线失败。
- 给主要页面做 Playwright smoke test：
  - 服务页
  - 下载页
  - 外来访问页
  - 统计页
  - 审计页
  - 深色主题
  - 英文模式

## 优先级清单

### P1：下一批最值得做

1. 把显存估算统一改成后端 `/api/memory-estimate`，前端不再复制公式。
2. 把 jobs ledger 抽到 `manager-core`，llama 与 vLLM 对齐。
3. 修正发布可移植性：npm start 不硬编码 `D:\DevTools`。
4. 加根目录 `install-all/test-all` 和 GitHub Actions CI。
5. 把外来访问的“推荐网关地址”和“危险容器直连地址”强视觉区分。

### P2：增强体验和稳定性

1. 多卡实验记录与推荐自动校准。
2. 价格表版本化和自定义价格。
3. lucide 本地化，避免离线图标丢失。
4. 前端拆模块，先拆下载、统计、外来访问、显存估算四块。
5. 启动日志错误分类继续结构化，和一键修复按钮绑定。

### P3：发布产品化

1. 初始化 Git 仓库并建立 tag/release 流程。
2. 增加安装文档、配置示例、故障排查。
3. 增加端到端 UI smoke test。
4. 增加 issue templates 和 release checklist。
5. 加一个“导出诊断包”功能，自动打包配置摘要、版本、Docker/GPU 状态和脱敏日志。

## 当前可信度

本次审计已经实际验证：

- 发布镜像可安装依赖。
- 当前测试全通过。
- 发布目录清理后不含 `node_modules`。
- 没发现 P0 阻断。

仍未覆盖：

- 真实 Docker 启动模型。
- 真实 HF 下载/暂停/继续。
- 浏览器全页面视觉回归。
- 双卡实测速度和显存峰值。

因此判断为：当前功能“可用且测试健康”，但要成为稳定 GitHub 项目，下一阶段应先补发布工程化和共享模块收敛。
