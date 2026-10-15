# 快速上手 / Getting Started

从解压（或克隆）完成到浏览器里看到控制台，需要四条命令。

From a fresh copy to the console in your browser takes four commands.

## 1. 前置条件 / Prerequisites

- Windows 10/11。
- Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`（22.x 需 22.22.2 及以上，24.x 需 24.15.0 及以上，或 26 及更新版本；23 和 25 不支持）。从 nodejs.org 安装 Node 24 LTS 即可。
- Docker Desktop（WSL 2 后端），NVIDIA 驱动和可用 GPU。运行 vLLM、SGLang 和 llama.cpp 的 CUDA 容器需要它们。
- 可选：Python 3.10+（模型下载工具）；Python 3.12、`uv` 和 PowerShell 7（TTS）。

## 2. 四条命令 / The four commands

在平台根目录的命令提示符里运行：

```cmd
install-all
install-download-cli
platform setup
platform start
```

1. `install-all` 安装各包的 Node 依赖。
2. `install-download-cli` 创建独立的下载环境（`venvs/download-cli`），其中的 `hf` 和 `modelscope` 用于下载模型。
3. `platform setup` 是首次运行向导：检查环境、安装依赖、选择存储位置、预拉取引擎镜像、决定谁可以访问、可选地设置自动运行，并启动平台。每一步都可以跳过，之后可以用 `platform setup --step <id>` 重做。
4. `platform start` 启动统一入口和两个管理器，并以配对状态打开浏览器。`platform start full` 再加 TTS、MCP 和搜索网关。

`platform status` 查看各组件状态，`platform doctor` 检查环境并给出修复建议，`platform stop` 停止（不会停止模型容器）。

## 3. 局域网访问 {#lan}

默认只有本机能访问。让其它设备访问统一入口：

```cmd
platform start --lan
```

局域网模式默认强制 API Key，管理界面仍只对本机开放。管理器自己的端口默认只监听 `127.0.0.1`；确实需要局域网直连管理器时，在 `platform.json` 里设置 `managers.bindHost`，`platform doctor` 会提示这一选择。Windows 防火墙需要允许入口端口（5176）；`platform doctor` 会给出命令。

## 4. 旧脚本 / Legacy scripts

`start-platform.cmd`、`start-service-entry.cmd`、`stop-service-entry.cmd`、`status-platform.cmd` 等脚本保留原名和参数，它们只是转调 `platform.cmd` 的短脚本，对照表见 [service-runbook.md](service-runbook.md)。计划任务引用的脚本路径不变。

## 5. 出问题时 / When something fails

- `platform doctor` 列出失败的检查和对应的修复命令。
- 端口被占用、Docker 未启动、驱动过旧等常见问题见 [troubleshooting.md](troubleshooting.md)。
- Node 版本不符时 `platform` 会直接退出并指向本文。

---

## English

### Prerequisites

- Windows 10/11.
- Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` (22.x from 22.22.2, 24.x from 24.15.0, or 26 and later; 23 and 25 are not supported). Installing the Node 24 LTS from nodejs.org is enough.
- Docker Desktop (WSL 2 backend), an NVIDIA driver and a GPU for the vLLM, SGLang and llama.cpp CUDA containers.
- Optional: Python 3.10+ (the model download tool); Python 3.12, `uv` and PowerShell 7 (TTS).

### Steps

From a command prompt in the platform root:

```cmd
install-all
install-download-cli
platform setup
platform start
```

1. `install-all` installs each package's Node dependencies.
2. `install-download-cli` creates the separate download environment (`venvs/download-cli`) whose `hf` and `modelscope` commands download models.
3. `platform setup` is the first-run wizard: it checks the environment, installs dependencies, picks storage locations, pre-pulls engine images, decides who may connect, optionally sets up automation, and starts the platform. Every step can be skipped and redone later with `platform setup --step <id>`.
4. `platform start` starts the entry and both managers and opens the browser already paired. `platform start full` adds TTS, MCP and the search gateway.

`platform status` shows component state, `platform doctor` checks the environment and suggests fixes, and `platform stop` stops the platform (model containers keep running).

### LAN access

Only this machine can connect by default. To let other devices reach the entry:

```cmd
platform start --lan
```

LAN mode requires an API key by default, and the admin pages stay local. The managers' own ports listen on `127.0.0.1` unless you set `managers.bindHost` in `platform.json`; `platform doctor` reports that choice. Windows Firewall must allow the entry port (5176); `platform doctor` prints the command.

### Legacy scripts

`start-platform.cmd`, `start-service-entry.cmd`, `stop-service-entry.cmd`, `status-platform.cmd` and the other old launchers keep their names and arguments. They are short shims that call `platform.cmd`; see [service-runbook.md](service-runbook.md) for the mapping. Script paths that scheduled tasks use do not change.

### When something fails

- `platform doctor` lists failing checks and the command that fixes each.
- Busy ports, a stopped Docker Desktop and old drivers are covered in [troubleshooting.md](troubleshooting.md).
- When the Node version does not match, `platform` exits and points here.
