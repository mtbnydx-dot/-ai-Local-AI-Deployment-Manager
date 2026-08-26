# 🎙️ 语音克隆聚合平台

为课程作业搭建的多引擎语音克隆平台：**输入中文 → 自动翻译成英文 → 用你自己的声音朗读英文**。

## 支持的引擎

| 引擎 | 类型 | 说明 |
|---|---|---|
| Fish S2 Pro (4B) | 本地 | fishaudio/s2-pro，效果最好之一，占用显存较大 |
| Chatterbox Multilingual V3 | 本地 | Resemble AI，0.5B，快，输出自带水印 |
| Qwen3-TTS 1.7B Base | 本地 | 阿里开源，3 秒克隆 |
| Step-Audio-EditX (3B) | Docker | 依赖 vLLM，只能跑在 Linux 容器里；**必须填参考音频文字** |
| 小米 MiMo v2.5 TTS | API | 需在 https://platform.xiaomimimo.com 申请 Key（限时免费），支持音色克隆 |
| Qwen3-TTS (DashScope) | API | 需阿里云百炼 Key，预置音色（API 克隆需公网音频 URL，故未接） |

翻译（中→英）走 DashScope（qwen-plus）或小米 MiMo 的 chat 接口，两个 Key 配一个即可。

## 目录结构

- 本目录（`<AI_ROOT>\tts-platform`；本机为 `D:\AI\tts-platform`）：平台代码
  - `gateway/` 聚合网关 + 网页界面（端口 7000）
  - `workers/` 各引擎的 worker 服务（chatterbox 7011 / qwen 7012 / fish 7013 / step 7014）
  - `scripts/` 启动脚本
  - `voices/` 保存的参考音色；`outputs/` 生成的语音
  - `.env` API Key 配置（参考 `.env.example`）
- `E:\tts_runtime\`：运行时（纯英文路径，避免中文路径兼容问题）
  - `hf/` 模型权重（约 36GB）；`envs/` 各引擎隔离的 Python 环境；`repos/` fish-speech 与 Step-Audio-EditX 源码；`models/` 指向权重快照的链接

## 使用方法

1. **一键启动**（3 个本地 worker + 网关，各开一个最小化窗口）：

```bash
pwsh -File "D:\AI\tts-platform\scripts\start_all.ps1"
```

2. 浏览器打开统一入口 **http://127.0.0.1:5176/gateway/tts/**（7000 仍只作为本机上游）：
   1. 录 10~20 秒中文（读什么都行，**把读的文字填进"参考音频的文字内容"**），保存音色
   2. 输入中文 → 点"翻译成英文" → 可手动润色英文
   3. 勾选想对比的引擎 → 调整语速/语气 → 生成 → 试听/下载

### 表现力控制

| 控制 | 支持引擎 | 实现方式 |
|---|---|---|
| 语速 0.5×~1.5× | 全部 | ffmpeg 变速不变调 |
| 语气（开心/悲伤/生气/兴奋/平静/耳语） | Fish / Chatterbox / 小米 | Fish 情感标记；Chatterbox 情感强度；小米自然语言描述 |
| 停顿 ⏸ | 全部 | Fish 转 `(break)`，其他转省略号 |
| 风格描述（任意文字） | 仅小米 | 直接作为风格指令传给 API |

### 翻译

级联尝试（哪个可用走哪个）：

1. **D:\AI 本地大模型平台**（service-entry 统一网关 `127.0.0.1:5176`，用当前 fleet 里已加载的模型，免费且质量最好）
2. DashScope（qwen-plus，需 Key）
3. 小米 MiMo（mimo-v2.5，**聊天模型要账户有余额**）
4. 本地 Qwen3-4B-Instruct 兜底（qwen worker 内，首次用时加载 ~9GB 显存）

### 与 D:\AI 平台的显存共存

Step-Audio 容器的 vLLM 只预留 15% 显存（~15GB，STEP_GPU_MEM_UTIL 可调）；三个本地 TTS 引擎合计约 16GB。与 27B FP8 的 LLM fleet 可同时驻留。

3. **Step-Audio-EditX**（可选，需要 Docker Desktop 在运行）：

```bash
pwsh -File "D:\AI\tts-platform\scripts\start_step_docker.ps1"
```

## 注意事项

- worker **首次生成时才加载模型**，第一次会慢（30 秒~几分钟），之后就快了。
- 参考音频质量决定克隆效果：安静环境、正常语速、10~20 秒最佳。
- .env 里填好 `MIMO_API_KEY` 或 `DASHSCOPE_API_KEY` 后**重启网关**生效。
- 显卡为 RTX PRO 6000 Blackwell（96GB），所有 torch 均为 cu128 版本；若另有大程序占显存，留 ~25GB 给本平台即可（fish 半精度 ~9GB + qwen ~4GB + chatterbox ~3GB）。
- Chatterbox 每段输出内嵌 PerTh 水印（不可听），交作业时可说明这是 AI 生成标识。
- 局域网访问统一走 `service-entry` 的 `/gateway/tts/`，复用模型平台客户端 Key；不要把 7000/7011~7014 直接暴露到局域网。
- OpenAI 兼容地址为 `http://127.0.0.1:5176/gateway/tts/openai/v1`，支持 `GET /models` 与 `POST /audio/speech`（当前输出格式为 WAV）。
- `.env`、`voices/`、`outputs/` 和 `logs/` 是本机运行数据，不进入 Git 或发布包。

## 常用维护

- 单独重启某个引擎：关掉对应窗口，再运行 `scripts\start_<引擎>.ps1`
- 看 Step 容器日志：`docker logs -f step-audio`
- 更新 fish-speech / Step-Audio 源码：去 `E:\tts_runtime\repos\` 里 `git pull` 后重装对应 env
