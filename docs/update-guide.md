# GitHub 推送与多电脑更新

这个发布目录只保存平台源码、测试、示例配置和启动脚本。模型、缓存、`.env`、密钥、数据库、日志、TTS 音色与生成结果均被 Git 忽略，不会随推送上传。

## 首次推送

在准备好的发布文件夹中配置你的空 GitHub 仓库：

```powershell
git remote add origin https://github.com/<OWNER>/<REPOSITORY>.git
git push -u origin main
```

如果你复制的是 ZIP 而不是已经初始化好的 Git 文件夹，先运行：

```powershell
git init -b main
git add .
git commit -m "Initial local AI platform release"
```

提交前务必运行 `git status --short`，确认没有 `.env`、模型、缓存或运行数据。

## 其它电脑首次安装

```powershell
git clone https://github.com/<OWNER>/<REPOSITORY>.git local-ai-platform
cd local-ai-platform
.\install-all.cmd
.\test-all.cmd
```

TTS 网关需要独立的 Python 3.12 环境和 `uv`：

```powershell
.\install-tts-gateway.cmd
```

大模型、GGUF、TTS 权重和 Docker 镜像不在仓库内，需要在各电脑分别准备。可以用 `AI_ROOT`、`VLLM_MODELS_ROOT`、`LLAMA_MODELS_ROOT`、`HF_HOME` 和 `TTS_RUNTIME_ROOT` 指向已有磁盘目录。

## 后续安全更新

```powershell
.\update-platform.cmd
```

只检查是否有更新：

```powershell
.\update-platform.cmd -CheckOnly
```

更新器只接受当前分支的 fast-forward 更新。它发现本地已修改的受控文件、未推送提交或分叉历史时会拒绝继续；不会自动覆盖本地代码，也不会重启服务或加载模型。更新后默认重新安装 Node 依赖并运行完整测试，可临时使用 `-SkipInstall` 或 `-SkipTests` 跳过对应步骤。

运行数据由 `.gitignore` 隔离，因此正常的 `git pull` 不会碰模型、缓存、`.env`、数据库、日志、TTS 音色和输出。不要对包含这些数据的目录执行 `git clean -x`。

