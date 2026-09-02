# 语音克隆聚合平台

统一接入本地与云端 TTS 的创作工作台：可完成**任意目标语种翻译、音色管理、多引擎对比、模型生命周期管理、异步生成、试听下载和历史检索**。网页与 API 默认通过平台根目录中的 `service-entry` 暴露，7000 与 worker 端口只监听本机回环地址。

## 本版能力

- 创建工作台：原文自动识别、自由填写翻译目标与合成语种、停顿插入、语速/情绪/风格控制，一次最多对比 3 个引擎。
- 模型管理器：展示安装、服务、显存加载与忙碌状态；支持安装、启动、启动并加载、释放显存和安全停止。
- 可靠任务队列：全局并发限制、同引擎串行保护、进度/取消/失败重试和结构化错误。
- 持久化历史：生成结果写入 SQLite 索引，支持搜索、引擎筛选、分页、试听、下载和删除。
- 音色库：上传或浏览器录音，服务端统一转为 24kHz 单声道 WAV，支持改名、编辑参考文本和删除。
- 运维可见性：引擎状态缓存、延迟/忙碌/模型加载状态、任务与存储摘要、请求 ID 和滚动日志。
- 兼容性：保留原 `/api/tts`，同时提供 OpenAI Audio 兼容的 `/openai/v1/audio/speech`。

## 支持的引擎

| 引擎 | 类型 | 说明 |
|---|---|---|
| Fish S2 Pro (4B) | 本地 | fishaudio/s2-pro，效果最好之一，占用显存较大 |
| Chatterbox Multilingual V3 | 本地 | Resemble AI，0.5B，快，输出自带水印 |
| Qwen3-TTS 1.7B Base | 本地 | 阿里开源，3 秒克隆 |
| Step-Audio-EditX (3B) | Docker | 依赖 vLLM，只能跑在 Linux 容器里；**必须填参考音频文字** |
| VoxCPM 2 (2B) | 本地 / 可选安装 | 30 种语言，自动识别，支持音色克隆与文字风格设计 |
| Qwen3-TTS VoiceDesign 1.7B | 本地 / 可选安装 | 不需要参考音频，按文字描述设计声音，支持 10 种原生语种 |
| 小米 MiMo v2.5 TTS | API | 需在 https://platform.xiaomimimo.com 申请 Key（限时免费），支持音色克隆 |
| Qwen3-TTS (DashScope) | API | 需阿里云百炼 Key，预置音色（API 克隆需公网音频 URL，故未接） |

翻译目标不再固定为英文；可输入任意 BCP-47 代码（如 `fr-CA`）或语种名称。翻译走本地统一大模型、DashScope、小米 MiMo、本地 Qwen 兜底的级联策略。

平台不设置全局语种白名单，但模型的物理能力仍有差异。Qwen 与 VoxCPM 可使用 `auto`，Chatterbox 会对其 23 种原生语种做明确校验；不支持时返回可读错误，不会静默伪装成英文。

## 目录结构

- 本目录（`<AI_ROOT>\tts-platform`）：平台代码
  - `gateway/` 聚合网关 + 网页界面（端口 7000）
  - `workers/` 各引擎的 worker 服务（chatterbox 7011 / qwen 7012 / fish 7013 / step 7014 / VoxCPM 7015 / Qwen VoiceDesign 7016）
  - `scripts/` 启动脚本
  - `voices/` 保存的参考音色；`outputs/` 生成的语音；`tts-history.sqlite3` 为历史索引
  - `.env` API Key 配置（参考 `.env.example`）
- `<TTS_RUNTIME_ROOT>\`：运行时；默认是 `<AI_ROOT>\tts-runtime`，也可放到其它英文路径磁盘
  - `hf/` 模型权重（约 36GB）；`envs/` 各引擎隔离的 Python 环境；`repos/` fish-speech 与 Step-Audio-EditX 源码；`models/` 指向权重快照的链接

## 使用方法

1. **一键启动**（已运行的服务保持不动，缺少的 worker 与网关会在后台补齐）：

```bash
pwsh -File ".\tts-platform\scripts\start_all.ps1"
```

仅使用已运行的 Step/API 引擎或只想打开网页时，可运行：

```powershell
pwsh -File ".\tts-platform\scripts\start_all.ps1" -GatewayOnly -NoBrowser
```

2. 浏览器打开统一入口 **http://127.0.0.1:5176/gateway/tts/**（7000 仍只作为本机上游）：
   1. 录 10~20 秒中文（读什么都行，**把读的文字填进"参考音频的文字内容"**），保存音色
   2. 输入任意语种原文 → 填写翻译目标 → 翻译并按需润色
   3. 选择最多 3 个可用引擎 → 调整语速/语气 → 提交任务
   4. 在右侧任务区观察进度；成功后可试听/下载，历史页可搜索与复用结果

3. 查看运行状态：

```powershell
pwsh -File ".\tts-platform\scripts\status.ps1"
```

状态脚本会输出监听进程、版本、运行时长、任务计数、历史存储和各引擎的在线/忙碌/延迟状态。

### 模型管理

网页左侧进入 **模型**：

- `启动服务`：只启动轻量 worker，不主动占用模型显存。
- `启动并加载` / `加载到显存`：等待模型真正加载完成，随后可立即生成。
- `释放显存`：仅卸载权重，worker 继续在线；下一次可再次加载。
- `停止服务`：仅在模型不忙时执行，并校验端口进程确实属于对应 worker。
- `安装模型`：只允许安装代码内固定白名单的 VoxCPM 2 与 Qwen VoiceDesign，不接受网页传入命令、仓库或目录。

安装和生命周期变更只允许从 `127.0.0.1` / `localhost` 直接访问统一入口时执行；局域网和代理客户端只能查看状态。安装日志保存在 `tts-platform/logs/model-*.log`，运行状态保存在被 Git 忽略的 `.runtime/`。

### 表现力控制

| 控制 | 支持引擎 | 实现方式 |
|---|---|---|
| 语速 0.5×~1.5× | 全部 | ffmpeg 变速不变调 |
| 语气（开心/悲伤/生气/兴奋/平静/耳语） | Fish / Chatterbox / 小米 | Fish 情感标记；Chatterbox 情感强度；小米自然语言描述 |
| 停顿 ⏸ | 全部 | Fish 转 `(break)`，其他转省略号 |
| 风格描述（任意文字） | 小米 / VoxCPM 2 / Qwen VoiceDesign | 作为模型原生风格或声音设计指令 |

### 翻译

级联尝试（哪个可用走哪个）：

1. **本地大模型平台**（service-entry 统一网关 `127.0.0.1:5176`，用当前 fleet 里已加载的模型，免费且质量最好）
2. DashScope（qwen-plus，需 Key）
3. 小米 MiMo（mimo-v2.5，**聊天模型要账户有余额**）
4. 本地 Qwen3-4B-Instruct 兜底（qwen worker 内，支持任意目标语种，首次用时加载 ~9GB 显存）

### 与本地模型平台的显存共存

Step-Audio 容器的 vLLM 只预留 15% 显存（~15GB，STEP_GPU_MEM_UTIL 可调）；三个本地 TTS 引擎合计约 16GB。与 27B FP8 的 LLM fleet 可同时驻留。

4. **Step-Audio-EditX**（可选，需要 Docker Desktop 在运行）：

```bash
pwsh -File ".\tts-platform\scripts\start_step_docker.ps1"
```

## API

统一入口基址：`http://127.0.0.1:5176/gateway/tts/`

| 方法与路径 | 用途 |
|---|---|
| `GET api/system` | 版本、限制、任务与存储摘要 |
| `GET api/engines` | 引擎能力和当前状态；`?refresh=true` 强制探测 |
| `GET api/languages` | 常用语种提示；输入仍为自由文本 |
| `GET api/models` | 模型安装、服务、加载、忙碌和可用操作状态 |
| `POST api/models/{id}/actions/{action}` | 本机限定的安装/启动/加载/释放/停止操作 |
| `POST api/jobs` | 创建单引擎或多引擎异步任务 |
| `GET api/jobs` | 查询最近任务；任务资源支持取消和失败重试 |
| `GET api/outputs` | 搜索、筛选和分页查询生成历史 |
| `POST api/voices` | 上传参考音频并创建音色 |
| `POST api/translate` | 按级联策略翻译文本 |
| `GET openai/v1/models` | OpenAI 兼容模型清单 |
| `POST openai/v1/audio/speech` | OpenAI Audio 兼容 WAV 输出 |

数据接口可用 `TTS_API_KEY` 增加独立 Bearer 保护；经统一入口访问时应同时配置 `TTS_UPSTREAM_API_KEY`。请求体、上传、批量和并发上限均可在 `.env` 调整。

## 注意事项

- worker 默认在**首次生成时才加载模型**；也可以在模型页提前“加载到显存”，避免首条任务冷启动。
- 参考音频质量决定克隆效果：安静环境、正常语速、10~20 秒最佳。
- `.env` 里填好 `MIMO_API_KEY` 或 `DASHSCOPE_API_KEY` 后**重启网关**生效。隔离运行时可在进程环境中用 `TTS_ENV_FILE` 指向另一份配置，并用 `TTS_DATA_ROOT` 隔离运行数据。
- 显卡为 RTX PRO 6000 Blackwell（96GB），所有 torch 均为 cu128 版本；若另有大程序占显存，留 ~25GB 给本平台即可（fish 半精度 ~9GB + qwen ~4GB + chatterbox ~3GB）。
- Chatterbox 每段输出内嵌 PerTh 水印（不可听），交作业时可说明这是 AI 生成标识。
- 局域网访问统一走 `service-entry` 的 `/gateway/tts/`，复用模型平台客户端 Key；不要把 7000/7011~7016 直接暴露到局域网。
- OpenAI 兼容地址为 `http://127.0.0.1:5176/gateway/tts/openai/v1`，支持 `GET /models` 与 `POST /audio/speech`（当前输出格式为 WAV）。
- `.env`、`voices/`、`outputs/`、`logs/`、`.tmp/` 和 SQLite 历史索引是本机运行数据，不进入 Git 或发布包。

## 常用维护

- 单独控制某个引擎：优先使用网页“模型”页；也可运行对应 `scripts\start_<引擎>.ps1`
- 看 Step 容器日志：`docker logs -f step-audio`
- 更新 fish-speech / Step-Audio 源码：去 `<TTS_RUNTIME_ROOT>\repos\` 里 `git pull` 后重装对应 env
