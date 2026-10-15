# 故障排查

`platform doctor` 的每条修复建议都会指向本页的一个小节。先运行下面的命令，再按失败项的 id 找到对应小节：

```powershell
platform doctor              # 全部检查，结果写入 .runtime\platform\doctor-last.json
platform doctor --json       # 机器可读
platform status              # 组件状态和就绪层级（环境 -> 运行时 -> 组件 -> 模型服务 -> 访问范围）
platform logs <组件> --tail 200
```

所有命令都在平台根目录运行；`<AI_ROOT>` 表示平台根目录。

## dependencies

`env.*` 依赖检查失败，通常是 `package-lock.json` 变了而 `node_modules` 没有更新，或者某个包从未安装。

```powershell
platform deps                # 查看每个包的 lock 哈希和安装状态
install-all.cmd              # 重新安装，结束时记录 lock 哈希
```

Node 版本需要 22.22.2 或 24.15 以上；`platform.cmd` 找不到 `node` 时会直接提示。

## docker

`runtime.docker-daemon` 失败表示 Docker Desktop 没有响应。Doctor 不会替你启动它。

1. 手动启动 Docker Desktop，等托盘图标变为运行状态。
2. 运行 `docker version`，Server 一栏有内容即可。
3. 运行 `platform doctor --group runtime` 复查。

如果 WSL 后端卡住，先 `wsl --shutdown`，再重新启动 Docker Desktop。

## runtime

`runtime.images` 提示本机缺少运行时镜像：

- 官方镜像：按 Doctor 给出的确认提示拉取，或在管理页的“运行时”里拉取。
- 本机构建的镜像：按提示运行对应的构建脚本（例如 `scripts\rebuild-sglang-flashnext.ps1`），耗时较长，不会在后台自动执行。

镜像、容器和 GPU 状态以 `platform status --json` 的 `runtime` 层为准。

## network

- `net.ports`：端口被旧进程占用。Doctor 会列出占用者并在确认后停止；也可以用 `platform stop <组件>` 后重试。
- `net.orphans`：遗留的 pid 记录或孤儿进程，确认后清理。
- `net.manager-bind`：管理器仍绑定在旧地址上，需要在空闲时重启（`platform restart <组件> --if-idle`）。
- 局域网访问：管理页默认只监听 `127.0.0.1`。开启局域网管理请用 `platform config set listeners.admin.lan true`，并确认防火墙规则是你自己创建的。

## storage

`storage.*` 失败说明平台根目录、模型目录、Hugging Face 缓存或 Docker 数据盘的剩余空间低于 `doctor.minFreeGb.*` 设定的值，或者路径不可写。

```powershell
platform config get doctor.minFreeGb.aiRoot
platform config get paths.hfHome
```

先释放空间或修正路径，再重启受影响的组件。`platform doctor --fix` 只会清理 14 天前的轮转日志，不会删除模型。

## keys

`sec.*` 里与 API Key 相关的失败表示还没有可用的客户端 Key。在管理页的“密钥”页面（`/c/keys`）创建或启用一个 Key。`platform keys migrate --dry-run` 可以预览旧 Key 文件的迁移计划，只读。

忘记管理页的配对：运行 `platform admin pair --open`，一次性链接只显示在终端里。

## secrets

密钥保存在 `<AI_ROOT>\.runtime\secrets\` 下按命名空间划分的加密文件中（Windows 上使用 DPAPI，仅当前 Windows 用户可读）。管理命令只显示名称和时间，从不显示值。

```powershell
platform secrets list
platform secrets set platformMcp.apiKey      # 值从隐藏提示或标准输入读取，不放在命令行里
platform secrets copy platformMcp.apiKey     # 复制到剪贴板，不显示
platform secrets migrate                     # 一次性导入旧的明文密钥文件
```

### 迁移明文密钥

`sec.plaintext-secrets` 提示还有明文密钥文件。`platform secrets migrate` 把运行时 Key 文件、`logs\runtime-secrets.json` 和 MCP 的 `server.env` 里的密钥导入密钥库，校验通过后把原文件替换为只含引用的占位文件。该操作可重复执行。

### 回滚密钥（secret rollback）

需要把管理器版本退回到密钥库出现之前时，旧代码读不到密钥库，要先把密钥写回明文文件：

```powershell
platform secrets export-legacy --namespace runtime.vllm
platform secrets export-legacy --namespace runtime.llama
```

- 必须在交互式终端里由你本人执行；管道或脚本里会被拒绝（退出码 1）。
- 命令会提示输入 `export` 确认；`--yes` 只跳过这一次提问，仍然要求交互式终端。
- 目标文件里已经有明文密钥时命令不会覆盖，先自行处理那个文件。
- 导出后文件权限收紧为仅当前用户，但内容是明文：回滚完成并重新迁移后，应立即再次运行 `platform secrets migrate`，让文件变回占位文件。
- 部署备份只恢复 `.cmd` 等源码文件，不包含密钥库；回滚代码前先导出，再回滚。

`sec.secret-store` 失败时（文件无法读取或权限过宽），Doctor 不会改动该文件。权限过宽可以按提示收紧；无法读取通常是换了 Windows 用户或重装系统，需要重新 `platform secrets set`。

## ops

- `ops.nightly`：夜间自检连续失败。打开 `artifacts\nightly\latest.json`，看 `steps[]` 里 `ok` 为 `false` 的项。`platform status` 步骤给出五个就绪层级，`serving` 步骤要求至少有一个模型在提供服务；如果夜里本来就不加载模型，用 `-AllowNoServing` 重新注册计划任务。
- `ops.backup`：备份超过 36 小时。运行 `scripts\backup-platform.ps1 -Register` 注册每日任务，或手动运行一次。
- `ops.config-shadowed`：环境变量（例如早年用 `setx` 设置的）盖住了 `platform.json` 的值。把它们迁移进配置：

  ```powershell
  platform config import-env                    # 预览，密钥只显示 ****
  platform config import-env --apply            # 写入 platform.json 和密钥库
  platform config import-env --apply --remove-user-env
  ```

  `--remove-user-env` 会在你确认 `y/N` 后，对已导入的名称运行 `reg delete HKCU\Environment /v <名称> /f`；没有交互式终端时绝不执行。已经运行的程序要重启后才不再看到旧环境变量。
- 对外暴露：`platform exposure setup -DryRun -ModelApiDomain models.example.com` 只是转调 `scripts\setup-public.ps1`，参数原样传递（`--DryRun` 也会被转成 `-DryRun`）。不带 `-Apply` 时只打印将要执行的 `platform config set` 命令。

## legacy-claude-proxy

`claude-vllm-anthropic-proxy.py`（端口 8001）是旧的 Anthropic 兼容代理，已被服务入口取代。平台只检测它，不会启动或停止它。

- 看到它还在运行：确认没有客户端仍指向 `127.0.0.1:8001`，然后手动结束该进程。
- 它由登录项 `ClaudeVllmProxy` 启动时，到“任务管理器 -> 启动应用”里关掉。
