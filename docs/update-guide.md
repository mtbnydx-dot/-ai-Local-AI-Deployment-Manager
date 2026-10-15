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


## 线上运行根目录（platform deploy / platform update）

线上运行根目录（有 `platform-repo.git` 和 `worktrees\main`）不是 Git 工作区，直接运行 `update-platform.cmd` 会打印中英文提示并以退出码 2 结束，不会改动任何文件。请使用平台命令行：

```powershell
platform update            # 在线上根目录：拉取 worktrees\main 的更新（仅 fast-forward）并部署，包含测试和部署后处理
platform update --check    # 只报告更新分支上有多少个更新的提交
```

`platform update` 等价于 `update-platform.ps1 -Delegate`：对 `worktrees\main` 执行 `git fetch --prune` 和 `git merge --ff-only @{u}`（没有上游时跳过合并），再运行该工作区的 `scripts\deploy-worktree.ps1 -LiveRoot <线上根目录>`。

从源码工作区部署到线上根目录：

```powershell
platform deploy --dry-run                       # 只预览（-WhatIf），部署后处理也只打印计划
platform deploy --yes --restart changed         # 部署并请求重启受影响的组件
```

`platform deploy` 只能在工作区里运行，在线上根目录里会被拒绝。参数对应 `deploy-worktree.ps1`：`--restart none|changed|all` → `-Restart`，`--skip-tests` → `-SkipTests`，`--no-prune` → `-NoPrune`，`--allow-live-drift` → `-AllowLiveDrift`，`--yes` → `-Confirm:$false`，`--dry-run` → `-WhatIf`。

重启默认是 `none`：部署从不重启服务，只列出需要重启的组件。`changed` 把改动的文件映射到组件；`all` 覆盖全部可重启组件。两者都需要监督进程（`platform start` 启动）：

- 改动涉及监督进程本身（`supervisor`）时，先重新执行（re-exec）监督进程，再重启组件。
- 空闲的组件立即重启，正忙的（正在加载、下载、迁移、基准测试或有进行中的请求）排队，空闲后由监督进程重启。
- 没有监督进程时只打印 `platform restart <组件…> --when-idle`，部署仍以退出码 0 结束。
- 模型容器永远不会被重启。
