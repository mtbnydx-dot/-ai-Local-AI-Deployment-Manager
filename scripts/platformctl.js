#!/usr/bin/env node
"use strict";

// The `platform` CLI (docs/overhaul/06-ops.md §6). This file is the framework
// (argument parsing, language, exit codes, the command table), the read
// commands (doctor (report only), status, logs, version, open, config, deps
// and secrets) and the lifecycle commands (start, stop, restart, supervise,
// supervisor). Access and deploy commands register in COMMANDS from later
// packages; until then they answer "not available yet" with exit 1.
//
// Only node built-ins are required at load time. Every platform module is
// required inside the command that needs it, so `doctor` still starts on an
// unsupported Node and `logs` never touches the secret store unless it must.
//
// run(argv, overrides) is the whole CLI as a function (tests inject streams,
// the AI root, a fake DPAPI, fetch and so on); the bottom of the file only
// wires it to the process.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// §6.3
const EXIT = Object.freeze({ OK: 0, FAILURE: 1, USAGE: 2, BUSY: 3, SUPERVISOR_UNAVAILABLE: 4, PREFLIGHT: 5, NODE_MISSING: 9009 });
const ZH = "zh-CN";
const EN = "en-US";

// ---------------------------------------------------------------------------
// Strings (06 §6.4). Kept next to the commands that print them; the platform
// modules' own strings live in manager-core/platform/messages.js.

const S = {
  "error.usage": { [ZH]: "用法错误：{detail}", [EN]: "Usage error: {detail}" },
  "error.unknownCommand": { [ZH]: "未知命令“{name}”。运行 platform --help 查看全部命令。", [EN]: "Unknown command \"{name}\". Run platform --help for the list." },
  "error.unknownOption": { [ZH]: "{command} 不支持选项 {option}。", [EN]: "{command} does not accept the option {option}." },
  "error.missingValue": { [ZH]: "选项 {option} 需要一个值。", [EN]: "The option {option} needs a value." },
  "error.failed": { [ZH]: "失败：{detail}", [EN]: "Failed: {detail}" },
  "error.notAvailable": { [ZH]: "命令 {name} 在当前版本中尚未提供（{package}）。", [EN]: "The command {name} is not available in this build yet ({package})." },
  "error.nodeRange": { [ZH]: "需要 Node.js {range}，当前是 {current}。", [EN]: "Node.js {range} is required; this is {current}." },
  "help.title": { [ZH]: "platform：本地 AI 模型服务平台命令行", [EN]: "platform: command line of the local AI model-serving platform" },
  "help.usage": { [ZH]: "用法", [EN]: "Usage" },
  "help.commands": { [ZH]: "命令", [EN]: "Commands" },
  "help.global": { [ZH]: "通用选项", [EN]: "Global options" },
  "help.soon": { [ZH]: "即将提供", [EN]: "coming soon" },
  "help.exit": { [ZH]: "退出码", [EN]: "Exit codes" },
  "help.exitCodes": {
    [ZH]: "0 成功 · 1 失败或组件未就绪 · 2 用法错误 · 3 平台繁忙被拒绝 · 4 监督进程不可用 · 5 预检未通过 · 9009 缺少 Node",
    [EN]: "0 OK · 1 failure or a component not ready · 2 usage error · 3 refused, platform busy · 4 supervisor unavailable · 5 preflight blocked · 9009 Node missing",
  },
  "help.langOption": { [ZH]: "--lang zh|en  界面语言（其次 PLATFORM_LANG，再次系统语言）", [EN]: "--lang zh|en  language (then PLATFORM_LANG, then the system locale)" },
  "help.helpOption": { [ZH]: "--help, -h  显示帮助", [EN]: "--help, -h  show this help" },
  "help.json": { [ZH]: "--json 只在标准输出打印一个 JSON 文档，进度信息走标准错误。", [EN]: "--json prints exactly one JSON document on stdout; progress goes to stderr." },
  "status.title": { [ZH]: "平台状态", [EN]: "Platform status" },
  "status.mode.supervised": { [ZH]: "由监督进程管理", [EN]: "supervised" },
  "status.mode.probe": { [ZH]: "无监督进程（仅探测）", [EN]: "no supervisor (probe only)" },
  "status.overall": { [ZH]: "总体", [EN]: "Overall" },
  "status.build": { [ZH]: "构建", [EN]: "Build" },
  "status.layers": { [ZH]: "就绪层级", [EN]: "Readiness" },
  "status.components": { [ZH]: "组件", [EN]: "Components" },
  "status.models": { [ZH]: "正在服务的模型实例：{count}", [EN]: "Model instances serving: {count}" },
  "status.unknownComponent": { [ZH]: "没有这个组件：{id}", [EN]: "No such component: {id}" },
  "status.noJsonWatch": { [ZH]: "--watch 不能与 --json 同时使用。", [EN]: "--watch cannot be combined with --json." },
  "layer.environment": { [ZH]: "环境", [EN]: "Environment" },
  "layer.runtime": { [ZH]: "运行时", [EN]: "Runtime" },
  "layer.components": { [ZH]: "组件", [EN]: "Components" },
  "layer.serving": { [ZH]: "模型服务", [EN]: "Serving" },
  "layer.exposure": { [ZH]: "对外暴露", [EN]: "Exposure" },
  "col.id": { [ZH]: "组件", [EN]: "ID" },
  "col.state": { [ZH]: "状态", [EN]: "STATE" },
  "col.pid": { [ZH]: "进程", [EN]: "PID" },
  "col.ports": { [ZH]: "端口", [EN]: "PORTS" },
  "col.uptime": { [ZH]: "已运行", [EN]: "UPTIME" },
  "col.name": { [ZH]: "名称", [EN]: "NAME" },
  "logs.noFile": { [ZH]: "还没有日志文件：{file}", [EN]: "No log file yet: {file}" },
  "logs.unknownComponent": { [ZH]: "没有这个组件：{id}。可用：{known}", [EN]: "No such component: {id}. Known: {known}" },
  "logs.bad": { [ZH]: "{option} 的值无效：{value}", [EN]: "Invalid value for {option}: {value}" },
  "logs.redactionUnavailable": { [ZH]: "密钥库不可用，为避免泄露，不显示日志。", [EN]: "The secret store is unavailable, so the log is not shown (it could contain secrets)." },
  "version.title": { [ZH]: "平台版本", [EN]: "Platform version" },
  "version.newer": { [ZH]: "更新分支上有 {count} 个更新的提交", [EN]: "{count} newer commit(s) on the update branch" },
  "version.upToDate": { [ZH]: "已是更新分支的最新提交", [EN]: "Up to date with the update branch" },
  "version.newerUnknown": { [ZH]: "无法判断是否有更新：{detail}", [EN]: "Cannot tell whether there are updates: {detail}" },
  "version.drift": { [ZH]: "线上被改动过的文件：{count}", [EN]: "Live files changed since deploy: {count}" },
  "open.opened": { [ZH]: "已打开 {url}", [EN]: "Opened {url}" },
  "open.unknownTarget": { [ZH]: "未知目标“{name}”。可选：{known}", [EN]: "Unknown target \"{name}\". Choose one of: {known}" },
  "open.failed": { [ZH]: "无法打开浏览器，请手动访问：{url}", [EN]: "Could not open the browser. Open this address yourself: {url}" },
  "config.secretViaStore": {
    [ZH]: "{key} 是密钥，不能用 config 命令设置。请运行：platform secrets set {key}",
    [EN]: "{key} is a secret and cannot be set with config. Run: platform secrets set {key}",
  },
  "config.unknownKey": { [ZH]: "没有这个配置项：{key}", [EN]: "No such setting: {key}" },
  "config.badValue": { [ZH]: "{key} 需要 {type} 类型的值，收到：{value}", [EN]: "{key} needs a value of type {type}; got: {value}" },
  "config.saved": { [ZH]: "已保存：{keys}", [EN]: "Saved: {keys}" },
  "config.noChange": { [ZH]: "没有变化。", [EN]: "Nothing changed." },
  "config.restart": { [ZH]: "需要重启：{components}（platform restart {components}）", [EN]: "Restart required: {components} (platform restart {components})" },
  "config.valid": { [ZH]: "配置有效。", [EN]: "The configuration is valid." },
  "config.invalid": { [ZH]: "配置有问题：", [EN]: "The configuration has problems:" },
  "config.initialized": { [ZH]: "已创建 {file}", [EN]: "Created {file}" },
  "config.exists": { [ZH]: "{file} 已存在，未改动。", [EN]: "{file} already exists and was left alone." },
  "importEnv.none": { [ZH]: "没有找到可导入的平台环境变量。", [EN]: "No platform environment variables were found to import." },
  "importEnv.row": { [ZH]: "{name} -> {key} = {value}{note}", [EN]: "{name} -> {key} = {value}{note}" },
  "importEnv.invalid": { [ZH]: "  （值无效，已跳过）", [EN]: "  (invalid value, skipped)" },
  "importEnv.dryRun": { [ZH]: "以上为预览。加 --apply 写入 platform.json 和密钥库。", [EN]: "That was a preview. Add --apply to write platform.json and the secret store." },
  "importEnv.done": { [ZH]: "已导入 {count} 项。", [EN]: "Imported {count} setting(s)." },
  "importEnv.removeNeedsApply": { [ZH]: "--remove-user-env 必须与 --apply 一起使用。", [EN]: "--remove-user-env only works together with --apply." },
  "importEnv.needsTty": { [ZH]: "未删除用户环境变量：需要在交互式终端中确认。", [EN]: "User environment variables were not removed: confirmation needs an interactive terminal." },
  "importEnv.confirmRemove": { [ZH]: "从用户环境变量（HKCU\\Environment）中删除 {names}？[y/N] ", [EN]: "Delete {names} from the user environment (HKCU\\Environment)? [y/N] " },
  "importEnv.removed": { [ZH]: "已删除：{names}（已运行的程序需重新启动才会生效）", [EN]: "Removed: {names} (programs that are already running keep their copy until restarted)" },
  "importEnv.removeKept": { [ZH]: "未删除用户环境变量。", [EN]: "User environment variables were kept." },
  "importEnv.removeFailed": { [ZH]: "无法删除 {name}。", [EN]: "Could not delete {name}." },
  "exposure.setupFailed": { [ZH]: "无法运行 setup-public.ps1：{detail}", [EN]: "Could not run setup-public.ps1: {detail}" },
  "config.secretSet": { [ZH]: "（已设置）", [EN]: "(set)" },
  "config.secretUnset": { [ZH]: "（未设置）", [EN]: "(not set)" },
  "deps.title": { [ZH]: "依赖状态", [EN]: "Dependencies" },
  "deps.notYet": { [ZH]: "deps {option} 将随部署后处理一起提供。", [EN]: "deps {option} arrives with the post-deploy package." },
  "deps.mcp": { [ZH]: "MCP 构建", [EN]: "MCP build" },
  "secrets.none": { [ZH]: "密钥库里还没有任何密钥。", [EN]: "The secret store is empty." },
  "secrets.unknownKey": {
    [ZH]: "未知的密钥项“{key}”。请使用密钥类配置项（platform config list）或 <命名空间>/<名称>。",
    [EN]: "Unknown secret \"{key}\". Use a secret setting (platform config list) or <namespace>/<name>.",
  },
  "secrets.valueNotInArgv": { [ZH]: "密钥值不能放在命令行里。请从提示输入，或通过标准输入传入。", [EN]: "The value never goes on the command line. Type it at the prompt or pipe it on stdin." },
  "secrets.prompt": { [ZH]: "输入 {key} 的值（输入内容不会显示）：", [EN]: "Enter the value for {key} (input is hidden): " },
  "secrets.empty": { [ZH]: "没有收到值。", [EN]: "No value was received." },
  "secrets.saved": { [ZH]: "已保存 {key}。", [EN]: "Saved {key}." },
  "secrets.cleared": { [ZH]: "已清除 {key}。", [EN]: "Cleared {key}." },
  "secrets.absent": { [ZH]: "{key} 没有保存的值。", [EN]: "{key} has no stored value." },
  "secrets.copied": { [ZH]: "已复制到剪贴板（不会显示）。", [EN]: "Copied to the clipboard (not shown)." },
  "secrets.copyFailed": { [ZH]: "无法写入剪贴板。", [EN]: "Could not write to the clipboard." },
  "secrets.unavailable": { [ZH]: "密钥库不可用（{code}），没有做任何改动。", [EN]: "The secret store is unavailable ({code}); nothing was changed." },
  "secrets.migrated": { [ZH]: "{file} → {namespace}：导入 {imported}，跳过 {skipped}{replaced}", [EN]: "{file} → {namespace}: imported {imported}, skipped {skipped}{replaced}" },
  "secrets.replaced": { [ZH]: "，原文件已改为占位文件", [EN]: ", the plaintext file is now a stub" },
  "secrets.migrateNone": { [ZH]: "没有需要迁移的明文密钥文件。", [EN]: "No plaintext secret files to migrate." },
  "secrets.mcpNote": { [ZH]: "MCP 的 server.env 密钥在 platform-mcp 组件启动时迁移。", [EN]: "The MCP server.env key is migrated when the platform-mcp component starts." },
  "secrets.exportNeedsTty": { [ZH]: "export-legacy 必须在交互终端中由本人确认，已拒绝。", [EN]: "export-legacy must be confirmed by you in an interactive terminal; refused." },
  "secrets.exportNamespace": { [ZH]: "--namespace 必须是 {known} 之一。", [EN]: "--namespace must be one of {known}." },
  "secrets.exportConfirm": {
    [ZH]: "这会把 {namespace} 的 {count} 个密钥以明文写回 {file}。输入 export 确认：",
    [EN]: "This writes {count} secret(s) of {namespace} back to {file} in plaintext. Type export to confirm: ",
  },
  "secrets.exportAborted": { [ZH]: "已取消，没有写入任何文件。", [EN]: "Cancelled; no file was written." },
  "secrets.exportExisting": { [ZH]: "{file} 已含有明文密钥，未覆盖。", [EN]: "{file} already holds plaintext secrets and was not overwritten." },
  "secrets.exported": { [ZH]: "已写入 {count} 个密钥到 {file}（明文，回滚完成后请删除）。", [EN]: "Wrote {count} secret(s) to {file} (plaintext; remove it once the rollback is over)." },
  "secrets.exportEmpty": { [ZH]: "{namespace} 里没有密钥，没有写入文件。", [EN]: "{namespace} holds no secrets; no file was written." },
  "lifecycle.noSupervisor": { [ZH]: "监督进程没有运行。先运行：platform start", [EN]: "The supervisor is not running. Run: platform start" },
  "start.preflight": { [ZH]: "启动前检查未通过：{detail}。下一步：{next}", [EN]: "Preflight blocked: {detail}. Next step: {next}" },
  "start.noSqlite": { [ZH]: "此 Node.js 没有内置 node:sqlite", [EN]: "This Node.js has no built-in node:sqlite" },
  "start.depsMissing": { [ZH]: "{package} 的依赖尚未安装", [EN]: "Dependencies of {package} are not installed" },
  "start.mcpMissing": { [ZH]: "MCP 尚未构建", [EN]: "The MCP server is not built" },
  "start.spawning": { [ZH]: "正在启动监督进程…", [EN]: "Starting the supervisor…" },
  "start.supervisorTimeout": { [ZH]: "监督进程在 {seconds} 秒内没有就绪，请查看 logs/platform/supervisor.err.log", [EN]: "The supervisor was not ready within {seconds} s; see logs/platform/supervisor.err.log" },
  "start.timeout": { [ZH]: "启动在 {seconds} 秒内未完成（仍在后台继续）。", [EN]: "Start did not finish within {seconds} s (it continues in the background)." },
  "start.summary": { [ZH]: "已选组件：", [EN]: "Selected components:" },
  "start.overridesNeedProfile": { [ZH]: "--lan / --public 只对 core、full 生效；指定组件时已忽略（用 --save 写入配置）。", [EN]: "--lan / --public apply to core and full only; ignored for named components (use --save to persist)." },
  "stop.modelsListed": { [ZH]: "将停止的模型容器：{list}", [EN]: "Model containers to stop: {list}" },
  "stop.noModels": { [ZH]: "没有正在运行的模型容器。", [EN]: "No model containers are running." },
  "stop.modelsUnknown": { [ZH]: "无法读取模型容器列表（管理器未运行？）。", [EN]: "Cannot list model containers (managers not running?)." },
  "stop.modelsKeep": { [ZH]: "模型容器会继续运行：{list}（加 --models 一并停止）", [EN]: "Model containers keep running: {list} (add --models to stop them too)" },
  "stop.modelsNeedYes": { [ZH]: "--models 会停止模型容器；非交互终端需要 --yes 确认，已拒绝。", [EN]: "--models stops model containers; without a terminal it needs --yes. Refused." },
  "stop.modelsConfirm": { [ZH]: "输入 stop 确认停止以上模型容器：", [EN]: "Type stop to stop the model containers above: " },
  "stop.aborted": { [ZH]: "已取消。", [EN]: "Cancelled." },
  "stop.modelStopped": { [ZH]: "已停止模型容器 {id}", [EN]: "Stopped model container {id}" },
  "stop.modelFailed": { [ZH]: "无法停止模型容器 {id}：{detail}", [EN]: "Could not stop model container {id}: {detail}" },
  "stop.stopped": { [ZH]: "已停止 {id}", [EN]: "Stopped {id}" },
  "stop.done": { [ZH]: "完成。", [EN]: "Done." },
  "stop.supervisorStill": { [ZH]: "监督进程没有按时退出。", [EN]: "The supervisor did not exit in time." },
  "restart.busy": { [ZH]: "{id} 正忙：", [EN]: "{id} is busy:" },
  "restart.needForce": { [ZH]: "非交互终端下已拒绝。可用 --when-idle 排队，或 --force 强制重启。", [EN]: "Refused without a terminal. Use --when-idle to queue it, or --force." },
  "restart.confirm": { [ZH]: "仍要重启 {id} 吗？输入 yes 确认：", [EN]: "Restart {id} anyway? Type yes: " },
  "restart.queued": { [ZH]: "{id} 已排队，空闲时重启：", [EN]: "{id} is queued and restarts when idle:" },
  "restart.done": { [ZH]: "已重启 {id}", [EN]: "Restarted {id}" },
  "restart.nothing": { [ZH]: "没有需要重启的组件。", [EN]: "No components to restart." },
  "supervise.already": { [ZH]: "监督进程已在运行。", [EN]: "The supervisor is already running." },
  "supervise.running": { [ZH]: "监督进程已启动（profile：{profile}）。", [EN]: "Supervisor running (profile: {profile})." },
  "supervisor.running": { [ZH]: "监督进程运行中 · 进程 {pid} · profile {profile} · 启动于 {since}", [EN]: "Supervisor running · pid {pid} · profile {profile} · since {since}" },
  "supervisor.stopped": { [ZH]: "监督进程已退出（组件继续运行）。", [EN]: "The supervisor exited (components keep running)." },
  "supervisor.reexeced": { [ZH]: "监督进程已重新执行 · 新进程 {pid}", [EN]: "The supervisor re-executed · new pid {pid}" },
  "supervisor.reexecFailed": { [ZH]: "重新执行没有完成。", [EN]: "The re-exec did not complete." },
  "doctor.fixLater": { [ZH]: "doctor --fix 将随修复执行器一起提供。", [EN]: "doctor --fix arrives with the fix runner." },
  "doctor.summary": { [ZH]: "通过 {ok} · 警告 {warn} · 失败 {fail} · 信息 {info} · 跳过 {skip}", [EN]: "ok {ok} · warn {warn} · fail {fail} · info {info} · skipped {skip}" },
  "setup.title": { [ZH]: "首次运行向导", [EN]: "First-run setup" },
  "setup.unknownStep": { [ZH]: "未知的步骤：{step}（可选 {steps}）", [EN]: "Unknown step: {step} (one of {steps})" },
  "setup.step": { [ZH]: "[{n}/{total}] {title}", [EN]: "[{n}/{total}] {title}" },
  "setup.alreadyDone": { [ZH]: "已完成：{detail}", [EN]: "Already done: {detail}" },
  "setup.alreadySkipped": { [ZH]: "已跳过。", [EN]: "Skipped." },
  "setup.blocked": { [ZH]: "环境检查未通过，请先手动修复：", [EN]: "The environment check failed; fix these by hand first:" },
  "setup.ask": { [ZH]: "运行这一步？{hint} ", [EN]: "Run this step? {hint} " },
  "setup.askRoots": { [ZH]: "模型库目录（留空保持不变，多个用逗号分隔）：", [EN]: "Model folders (empty keeps the current ones; comma separated): " },
  "setup.askEngines": { [ZH]: "要预拉取的引擎（vllm、llama、sglang，默认 vllm）：", [EN]: "Engines to pre-pull (vllm, llama, sglang; default vllm): " },
  "setup.askLan": { [ZH]: "对局域网开放管理端？需要 API Key。[y/N] ", [EN]: "Open the admin listener to the LAN? It needs an API key. [y/N] " },
  "setup.skippedStep": { [ZH]: "已跳过。", [EN]: "Skipped." },
  "setup.stepDone": { [ZH]: "完成。", [EN]: "Done." },
  "setup.stepFailed": { [ZH]: "步骤失败：{detail}", [EN]: "Step failed: {detail}" },
  "setup.opsIntro": { [ZH]: "自动运行命令（不会自动执行）：", [EN]: "Automation commands (nothing runs without your yes):" },
  "setup.opsAsk": { [ZH]: "现在运行这些命令？[y/N] ", [EN]: "Run these commands now? [y/N] " },
  "setup.opsRan": { [ZH]: "已运行：{command}", [EN]: "Ran: {command}" },
  "setup.firstModel": { [ZH]: "下一步：在控制台的“部署”向导里部署第一个模型（{url}）。", [EN]: "Next: deploy a first model from the console Deploy wizard ({url})." },
  "setup.freeSpace": { [ZH]: "可用空间：{gb} GB", [EN]: "Free space: {gb} GB" },
  "setup.complete": { [ZH]: "设置完成。", [EN]: "Setup is complete." },
  "setup.incomplete": { [ZH]: "还有步骤未完成：{steps}。再次运行 platform setup 继续。", [EN]: "Some steps are not finished: {steps}. Run platform setup again to continue." },
  "doctor.unknownGroup": { [ZH]: "未知的检查组：{group}（可选 env、runtime、storage）", [EN]: "Unknown check group: {group} (env, runtime, storage)" },
};

function interpolate(text, params) {
  return String(text).replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined ? String(params[name]) : match));
}

function tr(ctx, key, params) {
  const entry = S[key];
  if (!entry) return key;
  return interpolate(entry[ctx.lang] || entry[EN], params);
}

function pick(ctx, localized) {
  if (!localized || typeof localized !== "object") return String(localized ?? "");
  return localized[ctx.lang] || localized[EN] || localized[ZH] || "";
}

// ---------------------------------------------------------------------------
// Errors and arguments

class CliError extends Error {
  constructor(exit, message) {
    super(message);
    this.name = "CliError";
    this.exit = exit;
  }
}

const usageError = (ctx, detail) => new CliError(EXIT.USAGE, tr(ctx, "error.usage", { detail }));

/**
 * spec: { bool: [names], value: [names], optional: [names] (--name or --name=v),
 * alias: { f: "follow" }, max: positional limit }. Returns { args, flags }.
 * An unknown option or a missing value is a usage error.
 */
function parseArgs(ctx, command, tokens, spec = {}) {
  // A command that wraps another tool hands its tokens over untouched.
  if (typeof spec.passthrough === "function" && spec.passthrough(tokens)) return { args: tokens.slice(), flags: {} };
  const bool = new Set(spec.bool || []);
  const value = new Set(spec.value || []);
  const optional = new Set(spec.optional || []);
  const alias = spec.alias || {};
  const args = [];
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") { args.push(...tokens.slice(index + 1)); break; }
    let name = null;
    let inline;
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      inline = eq < 0 ? undefined : token.slice(eq + 1);
    } else if (/^-[A-Za-z]$/.test(token)) {
      name = alias[token.slice(1)];
      if (!name) throw new CliError(EXIT.USAGE, tr(ctx, "error.unknownOption", { command, option: token }));
    } else {
      args.push(token);
      continue;
    }
    if (bool.has(name)) {
      if (inline !== undefined) flags[name] = !/^(0|false|no|off)$/i.test(inline);
      else flags[name] = true;
    } else if (value.has(name)) {
      let next = inline;
      if (next === undefined) {
        next = tokens[index + 1];
        if (next === undefined || (next.startsWith("--") && next.length > 2)) throw new CliError(EXIT.USAGE, tr(ctx, "error.missingValue", { option: `--${name}` }));
        index += 1;
      }
      flags[name] = next;
    } else if (optional.has(name)) {
      flags[name] = inline === undefined ? true : inline;
    } else {
      throw new CliError(EXIT.USAGE, tr(ctx, "error.unknownOption", { command, option: token }));
    }
  }
  if (spec.max !== undefined && args.length > spec.max) throw usageError(ctx, args.slice(spec.max).join(" "));
  return { args, flags };
}

// ---------------------------------------------------------------------------
// Context

function createContext(overrides = {}) {
  const env = overrides.env || process.env;
  const stdout = overrides.stdout || process.stdout;
  const stderr = overrides.stderr || process.stderr;
  const stdin = overrides.stdin || process.stdin;
  const ctx = {
    ...overrides,
    env,
    aiRoot: path.resolve(overrides.aiRoot || env.AI_ROOT || path.join(__dirname, "..")),
    stdout,
    stderr,
    stdin,
    stdinIsTTY: overrides.stdinIsTTY !== undefined ? overrides.stdinIsTTY : Boolean(stdin.isTTY),
    now: overrides.now || Date.now,
    lang: EN,
  };
  ctx.out = (text = "") => { stdout.write(`${text}\n`); };
  ctx.err = (text = "") => { stderr.write(`${text}\n`); };
  ctx.json = (value) => { stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
  let vault = null;
  ctx.vault = () => {
    if (!vault) {
      const { createSecretVault } = require("../manager-core/secret-store");
      vault = createSecretVault({ aiRoot: ctx.aiRoot, ...(ctx.dpapi ? { dpapi: ctx.dpapi } : {}), ...(ctx.acl ? { acl: ctx.acl } : {}) });
    }
    return vault;
  };
  let control = null;
  ctx.refreshControl = () => { control = null; };
  ctx.control = () => {
    if (ctx.controlClient) return ctx.controlClient;
    if (!control) {
      const { createControlClient } = require("../manager-core/platform/control");
      control = createControlClient({ aiRoot: ctx.aiRoot, tokenStore: ctx.vault().store("platform-control"), timeoutMs: 3000 });
    }
    return control;
  };
  return ctx;
}

// Loaded lazily and shared by the commands that need the effective config.
function loadConfig(ctx, { secrets } = {}) {
  const configApi = require("../manager-core/platform/config");
  return configApi.loadPlatformConfig({ aiRoot: ctx.aiRoot, env: ctx.env, ...(secrets ? { secrets } : {}) });
}

function loadRegistry(ctx, config) {
  const components = require("../manager-core/platform/components");
  const registry = components.loadComponentRegistry({ aiRoot: ctx.aiRoot, config, now: ctx.now(), ...(ctx.registryFile ? { bundledFile: ctx.registryFile } : {}) });
  return { registry, components };
}

function findSpec(registry, id) {
  const wanted = String(id || "");
  return registry.components.find((spec) => spec.id === wanted) || registry.components.find((spec) => spec.legacyId === wanted) || null;
}

function sha256File(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function readJsonFile(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return fallback; }
}

function ask(ctx, question) {
  if (typeof ctx.prompt === "function") return Promise.resolve(ctx.prompt(question));
  const readline = require("node:readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: ctx.stdin, output: ctx.stderr, terminal: false });
    ctx.stderr.write(question);
    rl.once("line", (line) => { rl.close(); resolve(line); });
    rl.once("close", () => resolve(""));
  });
}

function readAllStdin(stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", reject);
    if (typeof stdin.resume === "function") stdin.resume();
  });
}

// A hidden prompt on a TTY; otherwise the whole of stdin (one trailing newline
// removed). The value is never taken from argv.
async function readSecretValue(ctx, key) {
  if (typeof ctx.readSecret === "function") return String(await ctx.readSecret(key) ?? "");
  if (!ctx.stdinIsTTY) return (await readAllStdin(ctx.stdin)).replace(/\r?\n$/, "");
  ctx.stderr.write(tr(ctx, "secrets.prompt", { key }));
  return new Promise((resolve) => {
    const stdin = ctx.stdin;
    let value = "";
    const done = (result) => {
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      ctx.stderr.write("\n");
      resolve(result);
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return done(value);
        if (char === "\u0003") return done("");
        if (char === "\u0008" || char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    try { stdin.setRawMode(true); } catch {}
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

function table(rows) {
  const widths = [];
  for (const row of rows) row.forEach((cell, index) => { widths[index] = Math.max(widths[index] || 0, String(cell).length); });
  return rows.map((row) => row.map((cell, index) => (index === row.length - 1 ? String(cell) : String(cell).padEnd(widths[index]))).join("  ").trimEnd());
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "-";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400), hours = Math.floor((total % 86400) / 3600), minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d${hours}h`;
  if (hours) return `${hours}h${minutes}m`;
  if (minutes) return `${minutes}m${total % 60}s`;
  return `${total}s`;
}

const STATUS_MARK = { ok: "[ok]  ", warn: "[warn]", fail: "[fail]", unknown: "[?]   ", info: "[info]", skip: "[skip]" };

// ---------------------------------------------------------------------------
// status

async function collectStatus(ctx) {
  try {
    const result = await ctx.control().request("GET", "/v1/status", { timeoutMs: 3000 });
    if (result.status === 200 && result.json && typeof result.json === "object") return result.json;
  } catch {
    // No supervisor (or no token): fall through to probing.
  }
  const statusApi = require("../manager-core/platform/status");
  const config = loadConfig(ctx);
  const { registry, components } = loadRegistry(ctx, config);
  const resolved = registry.components.map((spec) => components.resolveComponent(spec, { aiRoot: ctx.aiRoot, config }));
  let build = null;
  try { build = require("../manager-core/platform/version").getBuildId({ aiRoot: ctx.aiRoot }); } catch {}
  const listListeners = ctx.listListeners || (() => require("../manager-core/platform/winproc").listListeners());
  return statusApi.probePlatformStatus({
    aiRoot: ctx.aiRoot,
    components: resolved,
    config,
    build,
    listListeners,
    fetch: ctx.fetch,
    execFile: ctx.execFile,
    now: ctx.now,
    ...(ctx.instances !== undefined ? { instances: ctx.instances } : {}),
  });
}

function componentReady(row) {
  return row.state === "ready" || row.state === "external";
}

function renderStatus(ctx, status, rows) {
  const lines = [];
  const mode = status.mode === "supervised" ? "status.mode.supervised" : "status.mode.probe";
  lines.push(`${tr(ctx, "status.title")} · ${tr(ctx, mode)}`);
  const build = status.build?.commit || status.build?.contentHash;
  lines.push(`${tr(ctx, "status.overall")}: ${status.readiness?.overall}${build ? `    ${tr(ctx, "status.build")}: ${status.build.commit || "-"} / ${status.build.contentHash || "-"}` : ""}`);
  lines.push("", tr(ctx, "status.layers"));
  for (const layer of status.readiness?.layers || []) {
    const name = S[`layer.${layer.id}`] ? tr(ctx, `layer.${layer.id}`) : layer.id;
    const extra = [layer.detail, layer.mode, layer.code].filter(Boolean).join(" · ");
    lines.push(`  ${STATUS_MARK[layer.status] || `[${layer.status}]`} ${name}${extra ? `  ${extra}` : ""}`);
  }
  lines.push("", tr(ctx, "status.components"));
  const header = [tr(ctx, "col.id"), tr(ctx, "col.state"), tr(ctx, "col.pid"), tr(ctx, "col.ports"), tr(ctx, "col.uptime"), tr(ctx, "col.name")];
  const body = rows.map((row) => [
    row.id,
    row.state,
    row.pid ?? "-",
    (row.ports || []).filter((port) => port.enabled !== false).map((port) => port.port).join(",") || "-",
    formatUptime(row.uptimeSec),
    pick(ctx, row.label) || row.message || "",
  ]);
  for (const line of table([header, ...body])) lines.push(`  ${line}`);
  if (status.models) lines.push("", tr(ctx, "status.models", { count: status.models.serving ?? 0 }));
  return lines.join("\n");
}

async function cmdStatus(ctx, { args, flags }) {
  if (flags.watch && flags.json) throw new CliError(EXIT.USAGE, tr(ctx, "status.noJsonWatch"));
  let exit = EXIT.OK;
  let iteration = 0;
  for (;;) {
    iteration += 1;
    const status = await collectStatus(ctx);
    let rows = status.components || [];
    if (args.length) {
      const picked = [];
      for (const id of args) {
        const row = rows.find((candidate) => candidate.id === id || candidate.legacyId === id);
        if (!row) throw new CliError(EXIT.USAGE, tr(ctx, "status.unknownComponent", { id }));
        picked.push(row);
      }
      rows = picked;
    }
    // Ready means every selected component, or (without a selection) the
    // components layer, is ok and the entry is up.
    if (args.length) exit = rows.every(componentReady) ? EXIT.OK : EXIT.FAILURE;
    else {
      const layer = (status.readiness?.layers || []).find((item) => item.id === "components");
      exit = status.readiness?.overall !== "down" && (!layer || layer.status === "ok") ? EXIT.OK : EXIT.FAILURE;
    }
    if (flags.json) ctx.json(args.length ? { ...status, components: rows } : status);
    else ctx.out(renderStatus(ctx, status, rows));
    if (!flags.watch) return exit;
    if (ctx.watchLimit && iteration >= ctx.watchLimit) return exit;
    if (ctx.signal?.aborted) return exit;
    ctx.out("");
    await (ctx.sleep ? ctx.sleep(2000) : new Promise((resolve) => setTimeout(resolve, 2000)));
  }
}

// ---------------------------------------------------------------------------
// logs

const SINCE_UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
const LINE_TIME = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?/;

function parseSince(ctx, text) {
  const match = /^(\d+)([smhd])$/.exec(String(text));
  if (!match) throw new CliError(EXIT.USAGE, tr(ctx, "logs.bad", { option: "--since", value: text }));
  return Number(match[1]) * SINCE_UNITS[match[2]];
}

// Lines carrying a leading timestamp are judged by it; others follow the
// previous line (a stack trace stays with its first line). Before any
// timestamp, the file's mtime decides.
function createSinceFilter(cutoffMs, file) {
  if (cutoffMs === null) return () => true;
  let keep;
  try { keep = fs.statSync(file).mtimeMs >= cutoffMs; } catch { keep = false; }
  return (line) => {
    const match = LINE_TIME.exec(line);
    if (match) {
      const time = Date.parse(match[1].replace(",", ".").replace(" ", "T"));
      if (Number.isFinite(time)) keep = time >= cutoffMs;
    }
    return keep;
  };
}

function rotatedLog(file, index) {
  return file.endsWith(".log") ? `${file.slice(0, -4)}.${index}.log` : `${file}.${index}`;
}

function logTail(ctx, file, count, since, redaction) {
  const logs = require("../manager-core/platform/logs");
  const read = (target, lines) => {
    const text = logs.tailLog(target, { lines, ...redaction });
    return text ? text.split("\n") : [];
  };
  let lines = read(file, since === null ? count : 10000);
  if (since !== null) lines = lines.filter(createSinceFilter(ctx.now() - since, file)).slice(-count);
  else if (lines.length < count && fs.existsSync(rotatedLog(file, 1))) lines = [...read(rotatedLog(file, 1), count - lines.length), ...lines];
  return lines;
}

async function cmdLogs(ctx, { args, flags }) {
  if (args.length !== 1) throw usageError(ctx, "logs <id>");
  const tail = flags.tail === undefined ? 100 : Number(flags.tail);
  if (!Number.isInteger(tail) || tail < 1 || tail > 10000) throw new CliError(EXIT.USAGE, tr(ctx, "logs.bad", { option: "--tail", value: flags.tail }));
  const since = flags.since === undefined ? null : parseSince(ctx, flags.since);
  const config = loadConfig(ctx);
  const { registry, components } = loadRegistry(ctx, config);
  const spec = findSpec(registry, args[0]);
  if (!spec || !/^[a-z][a-z0-9-]{1,31}$/.test(spec.id)) {
    throw new CliError(EXIT.USAGE, tr(ctx, "logs.unknownComponent", { id: args[0], known: registry.components.map((item) => item.id).join(", ") }));
  }
  const resolved = components.resolveComponent(spec, { aiRoot: ctx.aiRoot, config });
  let files = resolved.logs || {};
  if (flags.legacy) {
    const cwd = resolved.cwd || path.join(ctx.aiRoot, spec.cwd || "");
    files = { out: path.join(cwd, "logs", "manager.out.log"), err: path.join(cwd, "logs", "manager.err.log") };
  }
  let streams = ["out", "err"];
  if (flags.out && !flags.err) streams = ["out"];
  else if (flags.err && !flags.out) streams = ["err"];
  const prefixed = streams.length > 1;
  const vault = ctx.vault();
  const redaction = { aiRoot: ctx.aiRoot, getSecrets: () => vault.values() };
  const print = (stream, line) => ctx.out(prefixed && stream === "err" ? `[err] ${line}` : line);
  try {
    // Fail closed up front: a store that cannot be read must not leak a line.
    vault.values();
  } catch {
    throw new CliError(EXIT.FAILURE, tr(ctx, "logs.redactionUnavailable"));
  }

  if (!flags.follow) {
    let any = false;
    for (const stream of streams) {
      const file = files[stream];
      if (!file || !fs.existsSync(file)) continue;
      any = true;
      for (const line of logTail(ctx, file, tail, since, redaction)) print(stream, line);
    }
    if (!any) {
      ctx.err(tr(ctx, "logs.noFile", { file: streams.map((stream) => files[stream]).filter(Boolean).join(", ") }));
      return EXIT.FAILURE;
    }
    return EXIT.OK;
  }

  const logs = require("../manager-core/platform/logs");
  let controller = null;
  let signal = ctx.signal;
  if (!signal) {
    controller = new AbortController();
    signal = controller.signal;
    process.once("SIGINT", () => controller.abort());
  }
  const followers = streams.filter((stream) => files[stream]).map((stream) => {
    const keep = createSinceFilter(since === null ? null : ctx.now() - since, files[stream]);
    return logs.followLog(files[stream], {
      ...redaction,
      lines: tail,
      intervalMs: ctx.followIntervalMs,
      signal,
      onLine: (line) => { if (keep(line)) print(stream, line); },
      onError: (error) => ctx.err(tr(ctx, "error.failed", { detail: error.code || error.message })),
    });
  });
  if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  for (const follower of followers) follower.close();
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// version

function packageVersion(dir) {
  return readJsonFile(path.join(dir, "package.json"), {})?.version || null;
}

async function cmdVersion(ctx, { flags }) {
  const versionApi = require("../manager-core/platform/version");
  const config = loadConfig(ctx);
  const { registry } = loadRegistry(ctx, config);
  const current = versionApi.readVersion(ctx.aiRoot);
  let build = null;
  try { build = versionApi.getBuildId({ aiRoot: ctx.aiRoot }); } catch (error) { build = { error: error.code || "build_id_unavailable" }; }
  let drift = { count: null, files: [] };
  try {
    const items = versionApi.computeLiveDrift(ctx.aiRoot);
    drift = { count: items.length, files: items.slice(0, 20).map((item) => item.path) };
  } catch (error) { drift = { count: null, files: [], error: error.code || "drift_unavailable" }; }
  const branch = config.values["updates.branch"];
  const newer = await versionApi.countNewerCommits(ctx.aiRoot, { ...(branch ? { branch } : {}), fetch: flags.fetch === true });
  const packages = [{ dir: ".", version: packageVersion(ctx.aiRoot) }, ...registry.packages.map((pkg) => ({ dir: pkg.dir, version: pkg.dir === "." ? null : packageVersion(path.join(ctx.aiRoot, pkg.dir)) }))]
    .filter((pkg, index, all) => pkg.version && all.findIndex((other) => other.dir === pkg.dir) === index);
  const result = {
    schemaVersion: 1,
    version: current,
    build,
    node: process.version,
    packages,
    runtimeManifest: { asOf: registry.asOf || null, staleAfterDays: registry.staleAfterDays },
    newerCommits: newer,
    drift,
  };
  if (flags.json) { ctx.json(result); return EXIT.OK; }
  ctx.out(tr(ctx, "version.title"));
  ctx.out(`  version     ${current.version || "-"} (${current.source})`);
  ctx.out(`  commit      ${current.shortCommit || "-"}${current.branch ? `  ${current.branch}` : ""}`);
  if (current.deployedAt) ctx.out(`  deployed    ${current.deployedAt}`);
  ctx.out(`  build id    ${build?.commit || "-"} / ${build?.contentHash || build?.error || "-"}`);
  ctx.out(`  node        ${process.version}`);
  ctx.out(`  components  asOf ${registry.asOf || "-"}`);
  for (const pkg of packages) ctx.out(`  package     ${pkg.dir === "." ? "(root)" : pkg.dir} ${pkg.version}`);
  if (newer.error) ctx.out(`  ${tr(ctx, "version.newerUnknown", { detail: newer.error.message })}`);
  else ctx.out(`  ${newer.behind > 0 ? tr(ctx, "version.newer", { count: newer.behind }) : tr(ctx, "version.upToDate")}`);
  if (drift.count !== null) ctx.out(`  ${tr(ctx, "version.drift", { count: drift.count })}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// open

const OPEN_TARGETS = Object.freeze({
  console: { component: "entry", url: "admin", suffix: "/" },
  billing: { component: "entry", url: "admin", suffix: "/billing" },
  vllm: { component: "vllm-manager", url: "api", suffix: "/" },
  llama: { component: "llama-manager", url: "api", suffix: "/" },
  tts: { component: "tts-gateway", url: "http", suffix: "/" },
});

function defaultOpenUrl(url) {
  const { spawn } = require("node:child_process");
  const [command, args] = process.platform === "win32" ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

// Pairing (opening `…/#pair=<code>` for console and billing) is wired in by
// the access-commands package; this opens the plain URL.
async function cmdOpen(ctx, { args, flags }) {
  if (args.length > 1) throw usageError(ctx, "open [console|billing|vllm|llama|tts]");
  const name = args[0] || "console";
  const target = OPEN_TARGETS[name];
  if (!target) throw new CliError(EXIT.USAGE, tr(ctx, "open.unknownTarget", { name, known: Object.keys(OPEN_TARGETS).join(", ") }));
  const config = loadConfig(ctx);
  const { registry, components } = loadRegistry(ctx, config);
  const spec = findSpec(registry, target.component);
  const resolved = spec ? components.resolveComponent(spec, { aiRoot: ctx.aiRoot, config }) : null;
  const base = resolved?.urls?.[target.url];
  if (!base) throw new CliError(EXIT.FAILURE, tr(ctx, "error.failed", { detail: `${target.component} has no ${target.url} address` }));
  const url = `${base.replace(/\/+$/, "")}${target.suffix}`;
  if (flags.json) { ctx.json({ target: name, url }); return EXIT.OK; }
  if (flags.print) { ctx.out(url); return EXIT.OK; }
  try {
    await (ctx.openUrl || defaultOpenUrl)(url);
  } catch {
    ctx.err(tr(ctx, "open.failed", { url }));
    return EXIT.FAILURE;
  }
  ctx.out(tr(ctx, "open.opened", { url }));
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// config

function parseConfigValue(ctx, leaf, key, text) {
  const types = leaf ? String(leaf.type).split(",") : [];
  const fail = () => new CliError(EXIT.USAGE, tr(ctx, "config.badValue", { key, type: leaf?.type || "json", value: text }));
  if (types.includes("null") && text === "null") return null;
  const type = types.find((item) => item !== "null") || null;
  if (type === "boolean") {
    if (/^(true|yes|on|1)$/i.test(text)) return true;
    if (/^(false|no|off|0)$/i.test(text)) return false;
    throw fail();
  }
  if (type === "integer") {
    if (!/^-?\d+$/.test(text)) throw fail();
    return Number(text);
  }
  if (type === "number") {
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value)) throw fail();
    return value;
  }
  if (type === "array") {
    if (text.trim().startsWith("[")) {
      try { return JSON.parse(text); } catch { throw fail(); }
    }
    return text.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (type === "object") {
    try { return JSON.parse(text); } catch { throw fail(); }
  }
  if (type === "string") return text;
  // Not a known key: let the writer report unknown_key, but keep JSON literals typed.
  try { return JSON.parse(text); } catch { return text; }
}

function printConfigProblems(ctx, items) {
  for (const item of items) ctx.err(`  ${item.field || item.code}: ${item.message || item.code}`);
}

function configItems(ctx, loaded) {
  const configApi = require("../manager-core/platform/config");
  return configApi.describeEffectiveConfig(loaded, { includeSecrets: true });
}

function secretState(ctx, item) {
  return item.secret?.set ? tr(ctx, "config.secretSet") : tr(ctx, "config.secretUnset");
}

async function cmdConfig(ctx, { args, flags }) {
  const [sub, key, ...rest] = args;
  const configApi = require("../manager-core/platform/config");
  const loadWithVault = () => {
    try { return loadConfig(ctx, { secrets: ctx.vault() }); } catch { return loadConfig(ctx); }
  };
  if (sub === "list") {
    if (args.length > 1) throw usageError(ctx, "config list");
    const loaded = loadWithVault();
    const described = configItems(ctx, loaded);
    if (flags.json) { ctx.json(described); return EXIT.OK; }
    for (const group of described.groups) {
      if (!group.items.length) continue;
      ctx.out(`# ${pick(ctx, group.title) || group.id}`);
      for (const item of group.items) {
        const value = item.secret ? secretState(ctx, item) : JSON.stringify(item.value);
        ctx.out(`${item.key} = ${value}  (${item.secret?.source || item.source})`);
      }
    }
    return EXIT.OK;
  }
  if (sub === "get") {
    if (!key || rest.length) throw usageError(ctx, "config get <key>");
    const loaded = loadWithVault();
    const leaf = loaded.schema.leaves.get(key);
    if (!leaf) throw new CliError(EXIT.USAGE, tr(ctx, "config.unknownKey", { key }));
    if (leaf.secret) {
      const item = configItems(ctx, loaded).groups.flatMap((group) => group.items).find((entry) => entry.key === key);
      if (flags.json) ctx.json({ key, secret: item?.secret || { set: null } });
      else ctx.out(secretState(ctx, item || {}));
      return EXIT.OK;
    }
    if (flags.json) ctx.json({ key, value: loaded.values[key], source: loaded.sources[key] });
    else ctx.out(typeof loaded.values[key] === "string" ? loaded.values[key] : JSON.stringify(loaded.values[key]));
    return EXIT.OK;
  }
  if (sub === "set" || sub === "unset") {
    const expected = sub === "set" ? 2 : 1;
    if (!key || rest.length !== expected - 1) throw usageError(ctx, sub === "set" ? "config set <key> <value>" : "config unset <key>");
    const schema = configApi.loadPlatformSchema();
    const leaf = schema.leaves.get(key);
    if (leaf?.secret) throw new CliError(EXIT.USAGE, tr(ctx, "config.secretViaStore", { key }));
    const options = { aiRoot: ctx.aiRoot, env: ctx.env, actor: "cli" };
    const result = sub === "set"
      ? await configApi.writePlatformConfig({ ...options, set: { [key]: parseConfigValue(ctx, leaf, key, rest[0]) } })
      : await configApi.writePlatformConfig({ ...options, unset: [key] });
    if (!result.ok) {
      ctx.err(tr(ctx, "error.failed", { detail: result.error?.code || result.code || "config_invalid" }));
      printConfigProblems(ctx, result.errors || (result.error ? [result.error] : []));
      if (flags.json) ctx.json(result);
      return (result.errors || []).some((entry) => entry.code === "secret_via_store") ? EXIT.USAGE : EXIT.FAILURE;
    }
    if (flags.json) { ctx.json(result); return EXIT.OK; }
    ctx.out(result.changed?.length ? tr(ctx, "config.saved", { keys: result.changed.join(", ") }) : tr(ctx, "config.noChange"));
    if (result.restartRequired?.length) ctx.out(tr(ctx, "config.restart", { components: result.restartRequired.join(" ") }));
    return EXIT.OK;
  }
  if (sub === "validate") {
    const loaded = loadConfig(ctx);
    const problems = [...loaded.errors];
    if (flags.json) { ctx.json({ ok: problems.length === 0, errors: loaded.errors, warnings: loaded.warnings }); return problems.length ? EXIT.FAILURE : EXIT.OK; }
    if (loaded.warnings.length) printConfigProblems(ctx, loaded.warnings);
    if (problems.length) { ctx.err(tr(ctx, "config.invalid")); printConfigProblems(ctx, problems); return EXIT.FAILURE; }
    ctx.out(tr(ctx, "config.valid"));
    return EXIT.OK;
  }
  if (sub === "path") {
    ctx.out(configApi.platformConfigFile({ aiRoot: ctx.aiRoot, env: ctx.env }));
    return EXIT.OK;
  }
  if (sub === "init") {
    const file = configApi.platformConfigFile({ aiRoot: ctx.aiRoot, env: ctx.env });
    if (fs.existsSync(file)) { ctx.out(tr(ctx, "config.exists", { file })); return EXIT.OK; }
    // The writer never creates a file for an empty change, so one real change
    // and its undo leave exactly { "schemaVersion": 1 } (§4.1) via the only writer.
    const options = { aiRoot: ctx.aiRoot, env: ctx.env, actor: "cli" };
    let result = await configApi.writePlatformConfig({ ...options, set: { "cli.openBrowser": false } });
    if (result.ok) result = await configApi.writePlatformConfig({ ...options, unset: ["cli.openBrowser"] });
    if (!result.ok || !fs.existsSync(file)) {
      ctx.err(tr(ctx, "error.failed", { detail: result.error?.code || "config_write_failed" }));
      return EXIT.FAILURE;
    }
    ctx.out(tr(ctx, "config.initialized", { file }));
    return EXIT.OK;
  }
  if (sub === "import-env") {
    if (args.length > 1) throw usageError(ctx, "config import-env [--apply] [--remove-user-env]");
    return importEnv(ctx, { flags });
  }
  throw usageError(ctx, "config list|get <key>|set <key> <value>|unset <key>|validate|path|init");
}

// ---------------------------------------------------------------------------
// config import-env (06 §4.7): move setx-era values into platform.json / the secret store

function execFileAsync(ctx, file, args) {
  const execFile = ctx.execFile || require("node:child_process").execFile;
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, encoding: "utf8" }, (error, stdout) => (error ? reject(error) : resolve(String(stdout || ""))));
  });
}

/** HKCU\Environment as a Map(UPPERCASE name -> { name, value }); empty when reg.exe is unavailable. */
async function readUserEnvironment(ctx) {
  const found = new Map();
  if (!ctx.execFile && process.platform !== "win32") return found;
  let text = "";
  try { text = await execFileAsync(ctx, "reg", ["query", "HKCU\\Environment"]); } catch { return found; }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s*(.*)$/.exec(line);
    if (match) found.set(match[1].toUpperCase(), { name: match[1], value: match[2].trim() });
  }
  return found;
}

async function importEnv(ctx, { flags }) {
  const configApi = require("../manager-core/platform/config");
  if (flags["remove-user-env"] && !flags.apply) throw new CliError(EXIT.USAGE, tr(ctx, "importEnv.removeNeedsApply"));
  const schema = configApi.loadPlatformSchema();
  const userEnv = await readUserEnvironment(ctx);
  const processEnv = new Map(Object.entries(ctx.env).map(([name, value]) => [name.toUpperCase(), { name, value: String(value ?? "") }]));
  // Per setting, the first mapped name that holds a value wins (alias order of the schema).
  const picked = [];
  for (const leaf of schema.leaves.values()) {
    for (const entry of leaf.env) {
      const upper = entry.name.toUpperCase();
      const fromProcess = processEnv.get(upper);
      const fromRegistry = userEnv.get(upper);
      const value = fromProcess?.value?.trim() || fromRegistry?.value?.trim() || "";
      if (!value) continue;
      picked.push({ key: leaf.key, name: entry.name, secret: Boolean(leaf.secret), raw: value, registryName: fromRegistry?.name || null });
      break;
    }
  }
  // The loader's own env parser decides the typed value, so an import cannot disagree with a run.
  let parsed = null;
  if (picked.some((row) => !row.secret)) {
    const env = Object.fromEntries(picked.filter((row) => !row.secret).map((row) => [row.name, row.raw]));
    let secrets;
    try { secrets = ctx.vault(); } catch { secrets = undefined; }
    parsed = configApi.loadPlatformConfig({ aiRoot: ctx.aiRoot, env, ...(secrets ? { secrets } : {}) });
  }
  const rows = picked.map((row) => {
    if (row.secret) return { ...row, value: null, valid: true };
    const ok = parsed.sources[row.key] === "env" && !parsed.errors.some((entry) => entry.field === row.key);
    return { ...row, value: ok ? parsed.values[row.key] : null, valid: ok };
  });
  const display = (row) => (row.secret ? "****" : JSON.stringify(row.value));
  const report = rows.map((row) => ({ name: row.name, key: row.key, secret: row.secret, value: row.secret ? "****" : row.value, valid: row.valid, inUserEnvironment: Boolean(row.registryName) }));
  const printRows = () => {
    for (const row of rows) ctx.out(tr(ctx, "importEnv.row", { name: row.name, key: row.key, value: row.valid ? display(row) : "?", note: row.valid ? "" : tr(ctx, "importEnv.invalid") }));
  };
  if (!flags.apply) {
    if (flags.json) ctx.json({ schemaVersion: 1, apply: false, settings: report });
    else if (!rows.length) ctx.out(tr(ctx, "importEnv.none"));
    else { printRows(); ctx.out(tr(ctx, "importEnv.dryRun")); }
    return EXIT.OK;
  }

  const imported = [];
  const plain = rows.filter((row) => !row.secret && row.valid);
  if (plain.length) {
    const result = await configApi.writePlatformConfig({ aiRoot: ctx.aiRoot, env: ctx.env, actor: "cli", set: Object.fromEntries(plain.map((row) => [row.key, row.value])) });
    if (!result.ok) {
      ctx.err(tr(ctx, "error.failed", { detail: result.error?.code || result.code || "config_invalid" }));
      printConfigProblems(ctx, result.errors || (result.error ? [result.error] : []));
      return EXIT.FAILURE;
    }
    imported.push(...plain);
  }
  for (const row of rows.filter((item) => item.secret)) {
    let result;
    try {
      result = await configApi.setSecretLeaf(row.key, row.raw, { aiRoot: ctx.aiRoot, env: ctx.env, secrets: ctx.vault(), actor: "cli" });
    } catch (error) { throw storeFailure(ctx, error); }
    if (!result.ok) {
      ctx.err(tr(ctx, "error.failed", { detail: result.error?.code || result.code || "secret_store_unavailable" }));
      return EXIT.FAILURE;
    }
    imported.push(row);
  }
  if (flags.json) ctx.json({ schemaVersion: 1, apply: true, settings: report, imported: imported.map((row) => row.key) });
  else {
    printRows();
    ctx.out(imported.length ? tr(ctx, "importEnv.done", { count: imported.length }) : tr(ctx, "importEnv.none"));
  }

  if (!flags["remove-user-env"]) return EXIT.OK;
  // Registry removal cannot be undone from here, so it needs a person at a terminal.
  const removable = imported.map((row) => row.registryName).filter((name) => name && /^[A-Za-z0-9_]+$/.test(name));
  if (!removable.length) return EXIT.OK;
  if (!ctx.stdinIsTTY) { ctx.err(tr(ctx, "importEnv.needsTty")); return EXIT.OK; }
  const answer = await ask(ctx, tr(ctx, "importEnv.confirmRemove", { names: removable.join(", ") }));
  if (!/^y(es)?$/i.test(String(answer || "").trim())) { ctx.out(tr(ctx, "importEnv.removeKept")); return EXIT.OK; }
  const removed = [];
  for (const name of removable) {
    try {
      await execFileAsync(ctx, "reg", ["delete", "HKCU\\Environment", "/v", name, "/f"]);
      removed.push(name);
    } catch { ctx.err(tr(ctx, "importEnv.removeFailed", { name })); }
  }
  if (removed.length) ctx.out(tr(ctx, "importEnv.removed", { names: removed.join(", ") }));
  return removed.length === removable.length ? EXIT.OK : EXIT.FAILURE;
}

// ---------------------------------------------------------------------------
// exposure (scan: OPS-7c; setup: thin wrapper over scripts/setup-public.ps1, 05 PUB-20)

/** PowerShell takes -Name; accept the CLI-style --Name / --Name=value too. */
function powerShellArgs(tokens) {
  const out = [];
  for (const token of tokens) {
    const match = /^--([A-Za-z][A-Za-z0-9]*)(?:=(.*))?$/.exec(token);
    if (!match) { out.push(token); continue; }
    out.push(`-${match[1]}`);
    if (match[2] !== undefined) out.push(match[2]);
  }
  return out;
}

async function cmdExposure(ctx, { args }) {
  const [sub, ...rest] = args;
  if (sub === "setup") {
    const script = path.join(ctx.aiRoot, "scripts", "setup-public.ps1");
    const argv = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...powerShellArgs(rest)];
    const spawnSync = ctx.spawnSync || require("node:child_process").spawnSync;
    const result = spawnSync("powershell", argv, { stdio: "inherit", windowsHide: true, cwd: ctx.aiRoot });
    if (result.error) { ctx.err(tr(ctx, "exposure.setupFailed", { detail: result.error.code || result.error.message })); return EXIT.FAILURE; }
    return typeof result.status === "number" ? result.status : EXIT.FAILURE;
  }
  if (sub === "scan") throw new CliError(EXIT.FAILURE, tr(ctx, "error.notAvailable", { name: "exposure scan", package: "OPS-7c" }));
  throw usageError(ctx, "exposure scan [--json] | exposure setup [args…]");
}

// ---------------------------------------------------------------------------
// deps

function dependencyRows(ctx, registry) {
  const probes = require("../manager-core/platform/doctor-probes");
  const state = readJsonFile(path.join(ctx.aiRoot, ".runtime", "platform", "deps-state.json"), {}) || {};
  return registry.packages.map((pkg) => {
    const dir = path.resolve(ctx.aiRoot, pkg.dir);
    const lockFile = path.join(dir, "package-lock.json");
    const lockHash = sha256File(lockFile);
    const saved = state.packages?.[pkg.dir] || state[pkg.dir] || null;
    const installed = fs.existsSync(path.join(dir, "node_modules"));
    const recordedHash = saved?.lockSha256 || null;
    const versionsMatch = probes.lockVersionsMatch(readJsonFile(lockFile), readJsonFile(path.join(dir, "node_modules", ".package-lock.json")));
    let status = "ok";
    if (!installed) status = "missing";
    else if (!lockHash) status = "unknown";
    else if (recordedHash) status = recordedHash === lockHash ? "ok" : "stale";
    else if (versionsMatch === true) status = "ok";
    else status = versionsMatch === false ? "stale" : "unknown";
    return { package: pkg.dir, live: pkg.live === true, components: pkg.components || [], installed, lockHash, recordedHash, versionsMatch, status, ...(pkg.live ? {} : { note: pkg.reason || "test-only" }) };
  });
}

function mcpBuildRow(ctx, registry) {
  const pkg = registry.packages.find((item) => item.build);
  if (!pkg) return null;
  const probes = require("../manager-core/platform/doctor-probes");
  const dir = path.resolve(ctx.aiRoot, pkg.dir);
  const stamp = readJsonFile(path.join(dir, pkg.build.stamp), null);
  const exists = fs.existsSync(path.join(dir, "dist", "src", "index.js"));
  const currentHash = probes.hashBuildInputs(dir, pkg.build.inputs);
  const stampHash = stamp?.srcSha256 || null;
  return { package: pkg.dir, exists, currentHash, stampHash, status: !exists ? "missing" : currentHash && currentHash === stampHash ? "ok" : "stale" };
}

async function cmdDeps(ctx, { flags }) {
  if (flags.record || flags.install) throw new CliError(EXIT.FAILURE, tr(ctx, "deps.notYet", { option: flags.record ? "--record" : "--install" }));
  const config = loadConfig(ctx);
  const { registry } = loadRegistry(ctx, config);
  const packages = dependencyRows(ctx, registry);
  const mcp = mcpBuildRow(ctx, registry);
  const problems = packages.filter((row) => row.live && (row.status === "missing" || row.status === "stale")).length + (mcp && mcp.status !== "ok" ? 1 : 0);
  if (flags.json) { ctx.json({ schemaVersion: 1, packages, mcp, ok: problems === 0 }); return problems ? EXIT.FAILURE : EXIT.OK; }
  ctx.out(tr(ctx, "deps.title"));
  const rows = packages.map((row) => [row.package === "." ? "(root)" : row.package, row.live ? row.status : `${row.status} (${row.note})`, row.lockHash ? row.lockHash.slice(0, 12) : "-"]);
  for (const line of table([["PACKAGE", "STATUS", "LOCK"], ...rows])) ctx.out(`  ${line}`);
  if (mcp) ctx.out(`  ${tr(ctx, "deps.mcp")}: ${mcp.status}`);
  return problems ? EXIT.FAILURE : EXIT.OK;
}

// ---------------------------------------------------------------------------
// secrets

const NAMESPACE_NAME = /^([a-z][a-z0-9.-]{1,63})\/([A-Za-z0-9._:-]{1,160})$/;
const LEGACY_FILES = Object.freeze({
  "runtime.vllm": ["vllm-manager", "logs", "runtime-api-keys.json"],
  "runtime.llama": ["llama-manager", "logs", "runtime-api-keys.json"],
});

function resolveSecretTarget(ctx, key) {
  const configApi = require("../manager-core/platform/config");
  const leaf = configApi.loadPlatformSchema().leaves.get(String(key || ""));
  if (leaf?.secret) return { key, leaf: true, namespace: leaf.secret.namespace, name: leaf.secret.name };
  const match = NAMESPACE_NAME.exec(String(key || ""));
  if (match) return { key, leaf: false, namespace: match[1], name: match[2] };
  throw new CliError(EXIT.USAGE, tr(ctx, "secrets.unknownKey", { key }));
}

function storeFailure(ctx, error) {
  return new CliError(EXIT.FAILURE, tr(ctx, "secrets.unavailable", { code: error?.code || "error" }));
}

function defaultClipboard(value) {
  const { spawn } = require("node:child_process");
  return new Promise((resolve, reject) => {
    const [command, args] = process.platform === "win32" ? ["clip.exe", []] : process.platform === "darwin" ? ["pbcopy", []] : ["xclip", ["-selection", "clipboard"]];
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`clipboard exited ${code}`))));
    child.stdin.end(value);
  });
}

function legacySources(ctx) {
  const defaultFile = path.join(ctx.aiRoot, "logs", "runtime-secrets.json");
  return [
    { namespace: "runtime.vllm", file: path.join(ctx.aiRoot, ...LEGACY_FILES["runtime.vllm"]) },
    { namespace: "runtime.llama", file: path.join(ctx.aiRoot, ...LEGACY_FILES["runtime.llama"]) },
    // The facade names a store that was opened by file alone like this.
    { namespace: `runtime.legacy-${crypto.createHash("sha256").update(path.resolve(defaultFile)).digest("hex").slice(0, 8)}`, file: defaultFile },
  ];
}

async function cmdSecrets(ctx, { args, flags }) {
  const [sub, key, ...rest] = args;
  const secretStore = require("../manager-core/secret-store");
  if (sub === "list") {
    if (args.length > 1) throw usageError(ctx, "secrets list");
    const vault = ctx.vault();
    const rows = [];
    try {
      for (const namespace of secretStore.listSecretNamespaces(ctx.aiRoot)) {
        const store = vault.store(namespace);
        for (const entry of store.list()) rows.push({ namespace, name: entry.name, protection: store.protection, createdAt: entry.createdAt || null, updatedAt: entry.updatedAt || null });
      }
    } catch (error) { throw storeFailure(ctx, error); }
    if (flags.json) { ctx.json({ schemaVersion: 1, secrets: rows }); return EXIT.OK; }
    if (!rows.length) { ctx.out(tr(ctx, "secrets.none")); return EXIT.OK; }
    for (const line of table([["NAMESPACE", "NAME", "PROTECTION", "UPDATED"], ...rows.map((row) => [row.namespace, row.name, row.protection, row.updatedAt || row.createdAt || "-"])])) ctx.out(line);
    return EXIT.OK;
  }
  if (sub === "set") {
    if (!key) throw usageError(ctx, "secrets set <key>");
    if (rest.length) throw new CliError(EXIT.USAGE, tr(ctx, "secrets.valueNotInArgv"));
    const target = resolveSecretTarget(ctx, key);
    const value = await readSecretValue(ctx, key);
    if (!value.trim()) throw new CliError(EXIT.USAGE, tr(ctx, "secrets.empty"));
    const vault = ctx.vault();
    try {
      if (target.leaf) {
        const configApi = require("../manager-core/platform/config");
        const result = await configApi.setSecretLeaf(target.key, value, { aiRoot: ctx.aiRoot, env: ctx.env, secrets: vault, actor: "cli" });
        if (!result.ok) {
          ctx.err(tr(ctx, "error.failed", { detail: result.error?.code || result.code || "secret_store_unavailable" }));
          return EXIT.FAILURE;
        }
        ctx.out(tr(ctx, "secrets.saved", { key }));
        if (result.restartRequired?.length) ctx.out(tr(ctx, "config.restart", { components: result.restartRequired.join(" ") }));
      } else {
        await vault.set(target.namespace, target.name, value);
        ctx.out(tr(ctx, "secrets.saved", { key }));
      }
    } catch (error) { throw storeFailure(ctx, error); }
    return EXIT.OK;
  }
  if (sub === "clear") {
    if (!key || rest.length) throw usageError(ctx, "secrets clear <key>");
    const target = resolveSecretTarget(ctx, key);
    const vault = ctx.vault();
    try {
      if (target.leaf) {
        const configApi = require("../manager-core/platform/config");
        const result = await configApi.setSecretLeaf(target.key, null, { aiRoot: ctx.aiRoot, env: ctx.env, secrets: vault, actor: "cli" });
        if (!result.ok) { ctx.err(tr(ctx, "error.failed", { detail: result.error?.code || result.code || "secret_store_unavailable" })); return EXIT.FAILURE; }
      } else await vault.clear(target.namespace, target.name);
    } catch (error) { throw storeFailure(ctx, error); }
    ctx.out(tr(ctx, "secrets.cleared", { key }));
    return EXIT.OK;
  }
  if (sub === "copy") {
    if (!key || rest.length) throw usageError(ctx, "secrets copy <key>");
    const target = resolveSecretTarget(ctx, key);
    let value;
    try { value = ctx.vault().get(target.namespace, target.name); } catch (error) { throw storeFailure(ctx, error); }
    if (!value) { ctx.err(tr(ctx, "secrets.absent", { key })); return EXIT.FAILURE; }
    try {
      await (ctx.clipboard || defaultClipboard)(value);
    } catch {
      ctx.err(tr(ctx, "secrets.copyFailed"));
      return EXIT.FAILURE;
    }
    ctx.out(tr(ctx, "secrets.copied"));
    return EXIT.OK;
  }
  if (sub === "migrate") {
    if (args.length > 1) throw usageError(ctx, "secrets migrate");
    const vault = ctx.vault();
    let touched = 0;
    let failed = false;
    for (const source of legacySources(ctx)) {
      if (!fs.existsSync(source.file)) continue;
      try {
        const result = await vault.store(source.namespace).importLegacy({ file: source.file });
        if (!result.imported && !result.skipped && !result.replaced) continue;
        touched += 1;
        ctx.out(tr(ctx, "secrets.migrated", {
          file: path.relative(ctx.aiRoot, source.file), namespace: source.namespace, imported: result.imported, skipped: result.skipped,
          replaced: result.replaced ? tr(ctx, "secrets.replaced") : "",
        }));
      } catch (error) {
        failed = true;
        ctx.err(`${path.relative(ctx.aiRoot, source.file)}: ${tr(ctx, "secrets.unavailable", { code: error?.code || "error" })}`);
      }
    }
    if (!touched && !failed) ctx.out(tr(ctx, "secrets.migrateNone"));
    ctx.out(tr(ctx, "secrets.mcpNote"));
    return failed ? EXIT.FAILURE : EXIT.OK;
  }
  if (sub === "export-legacy") {
    if (args.length > 1) throw usageError(ctx, "secrets export-legacy --namespace n");
    const namespace = flags.namespace;
    if (!namespace || !LEGACY_FILES[namespace]) throw new CliError(EXIT.USAGE, tr(ctx, "secrets.exportNamespace", { known: Object.keys(LEGACY_FILES).join(", ") }));
    // The rollback path is a person's decision: never from a pipe or a script.
    if (!ctx.stdinIsTTY) { ctx.err(tr(ctx, "secrets.exportNeedsTty")); return EXIT.FAILURE; }
    const file = path.join(ctx.aiRoot, ...LEGACY_FILES[namespace]);
    const store = ctx.vault().store(namespace);
    let entries;
    try { entries = store.list().map((entry) => ({ name: entry.name, createdAt: entry.createdAt, secret: store.get(entry.name) })).filter((entry) => entry.secret); } catch (error) { throw storeFailure(ctx, error); }
    if (!entries.length) { ctx.out(tr(ctx, "secrets.exportEmpty", { namespace })); return EXIT.OK; }
    const existing = readJsonFile(file, null);
    if (existing && existing.secrets && Object.keys(existing.secrets).length) { ctx.err(tr(ctx, "secrets.exportExisting", { file: path.relative(ctx.aiRoot, file) })); return EXIT.FAILURE; }
    if (!flags.yes) {
      const answer = await ask(ctx, tr(ctx, "secrets.exportConfirm", { namespace, count: entries.length, file: path.relative(ctx.aiRoot, file) }));
      if (String(answer).trim() !== "export") { ctx.out(tr(ctx, "secrets.exportAborted")); return EXIT.FAILURE; }
    }
    const document = { version: 1, secrets: Object.fromEntries(entries.map((entry) => [entry.name, { secret: entry.secret, createdAt: entry.createdAt || "" }])) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    try { await (ctx.acl || { secure: secretStore.secureSecretFile }).secure(file); } catch {}
    ctx.out(tr(ctx, "secrets.exported", { count: entries.length, file: path.relative(ctx.aiRoot, file) }));
    return EXIT.OK;
  }
  throw usageError(ctx, "secrets list|set <key>|clear <key>|copy <key>|migrate|export-legacy --namespace n");
}

// ---------------------------------------------------------------------------
// doctor (report only; --fix belongs to the fix runner)

async function cmdDoctor(ctx, { flags }) {
  if (flags.fix) throw new CliError(EXIT.FAILURE, tr(ctx, "doctor.fixLater"));
  const groups = flags.group ? String(flags.group).split(",").map((item) => item.trim()).filter(Boolean) : undefined;
  for (const group of groups || []) {
    if (!["env", "runtime", "storage"].includes(group)) throw new CliError(EXIT.USAGE, tr(ctx, "doctor.unknownGroup", { group }));
  }
  const vault = ctx.vault();
  const runDoctor = ctx.runDoctor || require("../manager-core/platform/doctor").runDoctor;
  const report = await runDoctor({
    aiRoot: ctx.aiRoot,
    env: ctx.env,
    groups,
    deep: flags.deep === true,
    getSecrets: () => vault.values(),
    ...(ctx.probes ? { probes: ctx.probes } : {}),
  });
  try {
    const dir = path.join(ctx.aiRoot, ".runtime", "platform");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "doctor-last.json"), JSON.stringify(report));
  } catch {}
  if (flags.json) ctx.json(report);
  else {
    for (const check of report.checks) {
      ctx.out(`${STATUS_MARK[check.status] || `[${check.status}]`} ${check.id}  ${pick(ctx, check.title)}${check.detail ? ` — ${check.detail}` : ""}`);
    }
    ctx.out("");
    ctx.out(tr(ctx, "doctor.summary", report.summary));
  }
  return report.summary.fail > 0 ? EXIT.FAILURE : EXIT.OK;
}

// ---------------------------------------------------------------------------
// Lifecycle: start, stop, restart, supervise, supervisor (06 §5.1, §6.2)

const PROFILE_WORDS = new Set(["core", "full", "all"]);
const PASS_STATES = new Set(["ready", "external", "disabled", "not-installed"]);
const SETTLED_LINE = /^(.+): (ready|failed|blocked|backoff|not-installed|external|stopped|unhealthy|unknown|disabled)$/;
const SUPERVISOR_WAIT_MS = 10000;
// Lifecycle calls queue behind the supervisor's own work (spawning, probing).
const CONTROL_TIMEOUT_MS = 15000;

function sleepFor(ctx, ms) {
  return ctx.sleep ? ctx.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
}

/** A control request; an unreachable supervisor becomes exit 4 with the way to start one. */
async function controlCall(ctx, method, route, body, timeoutMs) {
  try {
    return await ctx.control().request(method, route, { ...(body !== undefined ? { body } : {}), timeoutMs: timeoutMs || CONTROL_TIMEOUT_MS });
  } catch (error) {
    if (error?.code === "supervisor_unavailable") throw new CliError(EXIT.SUPERVISOR_UNAVAILABLE, tr(ctx, "lifecycle.noSupervisor"));
    throw error;
  }
}

function controlProblem(ctx, result) {
  return new CliError(EXIT.FAILURE, tr(ctx, "error.failed", { detail: result.json?.error?.message || result.json?.error?.code || `HTTP ${result.status}` }));
}

async function supervisorUp(ctx) {
  ctx.refreshControl();
  try { return await ctx.control().available(); } catch { return false; }
}

async function waitForSupervisor(ctx, wanted, limitMs) {
  const deadline = ctx.now() + limitMs;
  for (;;) {
    if ((await supervisorUp(ctx)) === wanted) return true;
    if (ctx.now() >= deadline) return false;
    await sleepFor(ctx, 200);
  }
}

function defaultSpawnSupervisor(ctx, argv) {
  const { spawn } = require("node:child_process");
  const dir = path.join(ctx.aiRoot, "logs", "platform");
  fs.mkdirSync(dir, { recursive: true });
  const outFd = fs.openSync(path.join(dir, "supervisor.out.log"), "a");
  const errFd = fs.openSync(path.join(dir, "supervisor.err.log"), "a");
  try {
    const child = spawn(process.execPath, [__filename, ...argv], {
      cwd: ctx.aiRoot,
      env: { ...ctx.env, AI_ROOT: ctx.aiRoot },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, errFd],
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

function spawnSupervisor(ctx, argv) {
  return ctx.spawnSupervisor ? ctx.spawnSupervisor(argv) : defaultSpawnSupervisor(ctx, argv);
}

/** Resolve the positional targets: nothing (the fallback), a profile word, or component ids. */
function resolveTargets(ctx, registry, components, args, fallback) {
  const words = args.length ? args : [fallback];
  const profiles = words.filter((word) => PROFILE_WORDS.has(word));
  if (profiles.length) {
    if (words.length > 1) throw usageError(ctx, words.join(" "));
    return { kind: "profile", scope: profiles[0], profile: profiles[0] === "all" ? "full" : profiles[0] };
  }
  const ids = [];
  for (const word of words) {
    const spec = findSpec(registry, word);
    if (!spec) throw new CliError(EXIT.USAGE, tr(ctx, "logs.unknownComponent", { id: word, known: registry.components.map((item) => item.id).join(", ") }));
    if (!ids.includes(spec.id)) ids.push(spec.id);
  }
  return { kind: "ids", ids: components.startOrder(registry, ids) };
}

function selectedIds(components, registry, target) {
  return target.kind === "profile"
    ? components.startOrder(registry, components.selectProfile(registry, target.profile))
    : target.ids;
}

/** Fast preflight (06 §6.2 start, step 1): node, sqlite, config, deps and the MCP build. */
function preflight(ctx, { config, registry, ids }) {
  const semver = require("../manager-core/platform/semver");
  const range = registry.requirements?.node;
  if (range && !semver.satisfies(process.versions.node, range)) {
    return { detail: tr(ctx, "error.nodeRange", { range, current: process.versions.node }), next: "docs/getting-started.md" };
  }
  try { require("node:sqlite"); } catch {
    return { detail: tr(ctx, "start.noSqlite"), next: "docs/getting-started.md" };
  }
  if (config.errors?.length) {
    const first = config.errors[0];
    return { detail: `${first.field || "config"}: ${first.code || first.message}`, next: "platform config validate" };
  }
  const bad = registry.errors.find((error) => ids.includes(error.id));
  if (bad) return { detail: `${bad.id}: ${bad.code}`, next: "platform doctor" };
  const missing = dependencyRows(ctx, registry).find((row) => row.live && row.status === "missing" && row.components.some((id) => ids.includes(id)));
  if (missing) return { detail: tr(ctx, "start.depsMissing", { package: missing.package === "." ? "(root)" : missing.package }), next: "install-all.cmd" };
  if (ids.includes("platform-mcp")) {
    const mcp = mcpBuildRow(ctx, registry);
    if (mcp && mcp.status === "missing") return { detail: tr(ctx, "start.mcpMissing"), next: "platform doctor --fix=env.mcp-dist" };
  }
  return null;
}

function lanAddress(ctx) {
  if (ctx.lanAddress !== undefined) return ctx.lanAddress;
  const interfaces = require("node:os").networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const item of list || []) if (item.family === "IPv4" && !item.internal) return item.address;
  }
  return null;
}

async function pollOperation(ctx, opId, { timeoutMs, onLog }) {
  const deadline = ctx.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    const result = await controlCall(ctx, "GET", `/v1/operations/${opId}`);
    if (result.status !== 200) throw controlProblem(ctx, result);
    const log = result.json.log || [];
    for (; seen < log.length; seen += 1) onLog?.(log[seen]);
    if (result.json.state !== "running") return result.json;
    if (ctx.now() >= deadline) return { ...result.json, state: "timeout" };
    await sleepFor(ctx, 150);
  }
}

function startProgress(ctx, total) {
  const began = ctx.now();
  let count = 0;
  return (line) => {
    const match = SETTLED_LINE.exec(line);
    if (!match) return;
    count += 1;
    const seconds = ((ctx.now() - began) / 1000).toFixed(1);
    ctx.err(`[${count}/${Math.max(total, count)}] ${match[1]} … ${match[2]} (${seconds} s)`);
  };
}

function componentUrls(ctx, spec, config, components) {
  const resolved = components.resolveComponent(spec, { aiRoot: ctx.aiRoot, config });
  const urls = Object.entries(resolved.urls || {}).map(([name, url]) => ({ name, url }));
  const lan = (resolved.ports || []).filter((port) => port.enabled !== false && /^(0\.0\.0\.0|::)$/.test(String(port.bind || "")));
  const address = lan.length ? lanAddress(ctx) : null;
  if (address) for (const port of lan) urls.push({ name: `${port.name} (LAN)`, url: `http://${address}:${port.port}` });
  return urls;
}

async function cmdStart(ctx, { args, flags }) {
  const timeoutMs = flags.timeout !== undefined ? Math.round(Number(flags.timeout) * 1000) : 180000;
  if (!(timeoutMs > 0)) throw new CliError(EXIT.USAGE, tr(ctx, "logs.bad", { option: "--timeout", value: flags.timeout }));
  const runtimeOverrides = {};
  if (flags.lan) runtimeOverrides["listeners.admin.lan"] = true;
  if (flags.public) runtimeOverrides["listeners.public.lan"] = true;
  const configApi = require("../manager-core/platform/config");
  const config = configApi.loadPlatformConfig({ aiRoot: ctx.aiRoot, env: ctx.env, runtimeOverrides });
  const { registry, components } = loadRegistry(ctx, config);
  const target = resolveTargets(ctx, registry, components, args, "core");
  const ids = selectedIds(components, registry, target);

  const problem = preflight(ctx, { config, registry, ids });
  if (problem) {
    ctx.err(tr(ctx, "start.preflight", problem));
    return EXIT.PREFLIGHT;
  }
  if (flags.save && Object.keys(runtimeOverrides).length) {
    const saved = await configApi.writePlatformConfig({ aiRoot: ctx.aiRoot, env: ctx.env, actor: "cli", set: runtimeOverrides });
    if (!saved.ok) {
      ctx.err(tr(ctx, "error.failed", { detail: saved.error?.code || saved.code || "config_invalid" }));
      return EXIT.FAILURE;
    }
    ctx.err(tr(ctx, "config.saved", { keys: Object.keys(runtimeOverrides).join(", ") }));
  }
  if (target.kind === "ids" && Object.keys(runtimeOverrides).length && !flags.save) ctx.err(tr(ctx, "start.overridesNeedProfile"));

  if (!(await supervisorUp(ctx))) {
    if (flags["no-supervisor"]) throw new CliError(EXIT.SUPERVISOR_UNAVAILABLE, tr(ctx, "lifecycle.noSupervisor"));
    ctx.err(tr(ctx, "start.spawning"));
    await spawnSupervisor(ctx, ["supervise", "--profile", "none"]);
    if (!(await waitForSupervisor(ctx, true, SUPERVISOR_WAIT_MS))) throw new CliError(EXIT.SUPERVISOR_UNAVAILABLE, tr(ctx, "start.supervisorTimeout", { seconds: SUPERVISOR_WAIT_MS / 1000 }));
  }

  const progress = startProgress(ctx, ids.length);
  let failure = null;
  const operations = [];
  if (target.kind === "profile") {
    const result = await controlCall(ctx, "POST", `/v1/profiles/${target.profile}/start`, { runtimeOverrides, restoreModels: flags["restore-models"] === true });
    if (result.status >= 300) throw controlProblem(ctx, result);
    operations.push(result.json.opId);
  } else {
    for (const id of target.ids) {
      const result = await controlCall(ctx, "POST", `/v1/components/${id}/start`, { wait: false });
      if (result.status >= 300) {
        ctx.err(tr(ctx, "error.failed", { detail: `${id}: ${result.json?.error?.message || result.json?.error?.code || result.status}` }));
        failure = EXIT.FAILURE;
        continue;
      }
      operations.push(result.json.opId);
    }
  }
  for (const opId of operations) {
    const op = await pollOperation(ctx, opId, { timeoutMs, onLog: progress });
    if (op.state === "failed") {
      ctx.err(tr(ctx, "error.failed", { detail: op.result?.message || op.result?.code || "start" }));
      failure = EXIT.FAILURE;
    } else if (op.state === "timeout") {
      ctx.err(tr(ctx, "start.timeout", { seconds: Math.round(timeoutMs / 1000) }));
      failure = EXIT.FAILURE;
    }
  }

  const statusResult = await controlCall(ctx, "GET", "/v1/status");
  const rows = new Map((statusResult.json?.components || []).map((row) => [row.id, row]));
  const summary = ids.map((id) => {
    const spec = findSpec(registry, id);
    const row = rows.get(id) || { id, state: "unknown" };
    return { row, spec, urls: componentUrls(ctx, spec, config, components) };
  });
  const allReady = summary.every((item) => PASS_STATES.has(item.row.state) || (item.row.kind === "listener" && item.row.state === "stopped" && item.row.reason === "disabled"));
  if (flags.json) {
    ctx.json({ ok: !failure && allReady, components: summary.map((item) => ({ ...item.row, urls: item.urls })) });
  } else {
    ctx.out(tr(ctx, "start.summary"));
    const body = summary.map((item) => [item.row.id, item.row.state, item.row.pid ?? "-", pick(ctx, item.spec?.label) || "", item.urls.map((entry) => entry.url).join("  ")]);
    for (const line of table([[tr(ctx, "col.id"), tr(ctx, "col.state"), tr(ctx, "col.pid"), tr(ctx, "col.name"), "URL"], ...body])) ctx.out(`  ${line}`);
    for (const item of summary) {
      if (!PASS_STATES.has(item.row.state)) ctx.out(`  ${item.row.id}: ${item.row.state}${item.row.reason ? ` (${item.row.reason})` : ""}${item.row.message ? ` ${item.row.message}` : ""}`);
    }
  }

  const entry = summary.find((item) => item.row.id === "entry");
  const wantsBrowser = flags.open === true || (config.values["cli.openBrowser"] === true && !flags["no-browser"]);
  if (wantsBrowser && entry?.row.state === "ready") {
    const url = entry.urls.find((item) => item.name === "admin")?.url;
    if (url) {
      try { await (ctx.openUrl || defaultOpenUrl)(`${url.replace(/\/+$/, "")}/`); } catch { ctx.err(tr(ctx, "open.failed", { url })); }
    }
  }
  return failure || (allReady ? EXIT.OK : EXIT.FAILURE);
}

// -- stop ------------------------------------------------------------------

async function listModelInstances(ctx, registry, components, config) {
  const statusApi = require("../manager-core/platform/status");
  const fetchImpl = ctx.fetch || ((...fetchArgs) => fetch(...fetchArgs));
  const found = [];
  let reached = false;
  for (const id of ["vllm-manager", "llama-manager"]) {
    const spec = findSpec(registry, id);
    const origin = spec ? components.resolveComponent(spec, { aiRoot: ctx.aiRoot, config }).urls?.api : null;
    if (!origin) continue;
    try {
      const response = await fetchImpl(`${origin}/api/instances`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) continue;
      const body = await response.json();
      reached = true;
      for (const instance of Array.isArray(body) ? body : Array.isArray(body?.instances) ? body.instances : []) {
        const state = statusApi.instanceLifecycle(instance).key;
        if (state === "stopped" || !instance?.id) continue;
        found.push({ id: String(instance.id), manager: id, origin, state });
      }
    } catch {}
  }
  return { instances: found, reached };
}

async function stopModelInstances(ctx, instances) {
  const fetchImpl = ctx.fetch || ((...fetchArgs) => fetch(...fetchArgs));
  let failed = 0;
  for (const item of instances) {
    try {
      const response = await fetchImpl(`${item.origin}/api/instances/${encodeURIComponent(item.id)}/stop`, { method: "POST", headers: { accept: "application/json" }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      ctx.err(tr(ctx, "stop.modelStopped", { id: item.id }));
    } catch (error) {
      failed += 1;
      ctx.err(tr(ctx, "stop.modelFailed", { id: item.id, detail: error?.message || String(error) }));
    }
  }
  return failed;
}

async function cmdStop(ctx, { args, flags }) {
  const config = loadConfig(ctx);
  const { registry, components } = loadRegistry(ctx, config);
  const target = resolveTargets(ctx, registry, components, args, "full");
  if (!(await supervisorUp(ctx))) throw new CliError(EXIT.SUPERVISOR_UNAVAILABLE, tr(ctx, "lifecycle.noSupervisor"));

  const managersInScope = target.kind === "profile" || target.ids.some((id) => id === "vllm-manager" || id === "llama-manager");
  if (flags.models) {
    const listed = await listModelInstances(ctx, registry, components, config);
    ctx.err(listed.instances.length
      ? tr(ctx, "stop.modelsListed", { list: listed.instances.map((item) => `${item.id} (${item.manager})`).join(", ") })
      : tr(ctx, listed.reached ? "stop.noModels" : "stop.modelsUnknown"));
    if (flags.yes !== true) {
      if (!ctx.stdinIsTTY) {
        ctx.err(tr(ctx, "stop.modelsNeedYes"));
        return EXIT.BUSY;
      }
      const answer = String(await ask(ctx, tr(ctx, "stop.modelsConfirm"))).trim();
      if (answer !== "stop") {
        ctx.err(tr(ctx, "stop.aborted"));
        return EXIT.BUSY;
      }
    }
    if (await stopModelInstances(ctx, listed.instances)) return EXIT.FAILURE;
  } else if (managersInScope) {
    const listed = await listModelInstances(ctx, registry, components, config);
    if (listed.instances.length) ctx.err(tr(ctx, "stop.modelsKeep", { list: listed.instances.map((item) => item.id).join(", ") }));
  }

  let failure = null;
  if (target.kind === "profile") {
    const result = await controlCall(ctx, "POST", "/v1/stop", { scope: target.scope === "all" ? "all" : target.profile, exitSupervisor: target.scope === "all" });
    if (result.status >= 300) throw controlProblem(ctx, result);
    // `stop all` makes the supervisor exit right after the operation ends, so
    // the pipe may vanish between two polls: that is the success case.
    const op = await pollOperation(ctx, result.json.opId, { timeoutMs: 180000, onLog: (line) => ctx.err(line) })
      .catch((error) => { if (target.scope === "all" && error.exit === EXIT.SUPERVISOR_UNAVAILABLE) return { state: "ok" }; throw error; });
    if (op.state !== "ok") { ctx.err(tr(ctx, "error.failed", { detail: op.result?.message || op.state })); failure = EXIT.FAILURE; }
    if (target.scope === "all" && !(await waitForSupervisor(ctx, false, 10000))) {
      ctx.err(tr(ctx, "stop.supervisorStill"));
      failure = EXIT.FAILURE;
    }
  } else {
    for (const id of components.stopOrder(registry, target.ids).filter((item) => target.ids.includes(item))) {
      const result = await controlCall(ctx, "POST", `/v1/components/${id}/stop`, { wait: true }, 180000);
      if (result.status >= 300) {
        ctx.err(tr(ctx, "error.failed", { detail: `${id}: ${result.json?.error?.message || result.json?.error?.code || result.status}` }));
        failure = EXIT.FAILURE;
      } else ctx.err(tr(ctx, "stop.stopped", { id }));
    }
  }
  if (!failure) ctx.out(tr(ctx, "stop.done"));
  return failure || EXIT.OK;
}

// -- restart ---------------------------------------------------------------

function describeBlocker(blocker) {
  return `${blocker.kind || "busy"}${blocker.source ? ` (${blocker.source})` : ""}${blocker.title ? `: ${blocker.title}` : ""}`;
}

async function cmdRestart(ctx, { args, flags }) {
  if (!args.length) throw usageError(ctx, "restart <id…|all>");
  if (flags["if-idle"] && flags["when-idle"]) throw usageError(ctx, "--if-idle --when-idle");
  const config = loadConfig(ctx);
  const { registry, components } = loadRegistry(ctx, config);
  if (!(await supervisorUp(ctx))) throw new CliError(EXIT.SUPERVISOR_UNAVAILABLE, tr(ctx, "lifecycle.noSupervisor"));

  let ids;
  if (args.length === 1 && args[0] === "all") {
    const status = (await controlCall(ctx, "GET", "/v1/status")).json || {};
    ids = components.startOrder(registry, (status.components || [])
      .filter((row) => row.desired === "running" && !["listener", "external"].includes(row.kind))
      .map((row) => row.id));
  } else {
    const target = resolveTargets(ctx, registry, components, args, "core");
    if (target.kind !== "ids") throw usageError(ctx, args.join(" "));
    ids = target.ids;
  }
  if (!ids.length) { ctx.out(tr(ctx, "restart.nothing")); return EXIT.OK; }

  let failure = null;
  const post = (id, force) => controlCall(ctx, "POST", `/v1/components/${id}/restart`, { when: flags["when-idle"] ? "idle" : "now", force });
  for (const id of ids) {
    let result = await post(id, flags.force === true);
    if (result.status === 409 && result.json?.error?.code === "component_busy") {
      const blockers = result.json.blockers || [];
      ctx.err(tr(ctx, "restart.busy", { id }));
      for (const blocker of blockers) ctx.err(`  - ${describeBlocker(blocker)}`);
      if (flags["if-idle"] || !ctx.stdinIsTTY) {
        if (!flags["if-idle"]) ctx.err(tr(ctx, "restart.needForce"));
        return EXIT.BUSY;
      }
      const answer = String(await ask(ctx, tr(ctx, "restart.confirm", { id }))).trim().toLowerCase();
      if (!/^(y|yes|是)$/.test(answer)) { ctx.err(tr(ctx, "stop.aborted")); return EXIT.BUSY; }
      result = await post(id, true);
    }
    if (result.status >= 300) {
      ctx.err(tr(ctx, "error.failed", { detail: `${id}: ${result.json?.error?.message || result.json?.error?.code || result.status}` }));
      failure = EXIT.FAILURE;
      continue;
    }
    if (result.json.queued) {
      ctx.out(tr(ctx, "restart.queued", { id }));
      for (const blocker of result.json.blockers || []) ctx.out(`  - ${describeBlocker(blocker)}`);
      continue;
    }
    const op = await pollOperation(ctx, result.json.opId, { timeoutMs: 180000 });
    if (op.state === "ok") ctx.out(tr(ctx, "restart.done", { id }));
    else { ctx.err(tr(ctx, "error.failed", { detail: `${id}: ${op.result?.message || op.state}` })); failure = EXIT.FAILURE; }
  }
  return failure || EXIT.OK;
}

// -- supervise, supervisor --------------------------------------------------

async function cmdSupervise(ctx, { flags }) {
  const profile = flags.profile === "all" ? "full" : flags.profile || "core";
  if (!["core", "full", "none"].includes(profile)) throw new CliError(EXIT.USAGE, tr(ctx, "logs.bad", { option: "--profile", value: flags.profile }));
  const supervisorApi = require("../manager-core/platform/supervisor");
  const control = require("../manager-core/platform/control");
  let finish;
  const exited = new Promise((resolve) => { finish = resolve; });
  const options = {
    aiRoot: ctx.aiRoot,
    env: ctx.env,
    profile,
    restoreModels: flags["restore-models"] === true,
    autostart: flags.autostart === true,
    tokenStore: control.createControlTokenStore({ aiRoot: ctx.aiRoot, store: ctx.vault().store("platform-control") }),
    log: (line) => ctx.out(`${new Date(ctx.now()).toISOString()} ${typeof line === "string" ? line : JSON.stringify(line)}`),
    exit: (code) => finish(code || 0),
    spawnSupervisor: (argv) => spawnSupervisor(ctx, argv),
    waitForPipe: (ms) => waitForSupervisor(ctx, true, ms),
    ...(ctx.superviseOptions || {}),
  };
  let started = await supervisorApi.startSupervisorProcess(options);
  // A successor (re-exec) races the old process closing its pipe.
  for (let attempt = 0; started.alreadyRunning && flags.takeover && attempt < 20; attempt += 1) {
    await sleepFor(ctx, 300);
    started = await supervisorApi.startSupervisorProcess(options);
  }
  if (started.alreadyRunning) {
    ctx.out(tr(ctx, "supervise.already"));
    return EXIT.OK;
  }
  ctx.out(tr(ctx, "supervise.running", { profile }));
  const stop = () => { started.supervisor.shutdown({ leaveChildren: true }).catch(() => finish(1)); };
  const signals = ctx.handleSignals === false ? [] : ["SIGINT", "SIGTERM", "SIGBREAK"];
  for (const signal of signals) process.on(signal, stop);
  const code = await exited;
  for (const signal of signals) process.removeListener(signal, stop);
  await started.close().catch(() => {});
  return code;
}

async function cmdSupervisor(ctx, { args, flags }) {
  const sub = args[0] || "status";
  if (args.length > 1 || !["status", "stop", "reexec"].includes(sub)) throw usageError(ctx, "supervisor status|stop|reexec");
  if (sub === "status") {
    const result = await controlCall(ctx, "GET", "/v1/status");
    if (result.status !== 200) throw controlProblem(ctx, result);
    const info = result.json.supervisor || {};
    if (flags.json) { ctx.json(info); return EXIT.OK; }
    ctx.out(tr(ctx, "supervisor.running", { pid: info.pid ?? "-", profile: info.profile || "-", since: info.startedAt || "-" }));
    return EXIT.OK;
  }
  if (sub === "stop") {
    const result = await controlCall(ctx, "POST", "/v1/shutdown", { leaveChildren: true });
    if (result.status >= 300) throw controlProblem(ctx, result);
    if (!(await waitForSupervisor(ctx, false, 10000))) { ctx.err(tr(ctx, "stop.supervisorStill")); return EXIT.FAILURE; }
    ctx.out(tr(ctx, "supervisor.stopped"));
    return EXIT.OK;
  }
  const before = (await controlCall(ctx, "GET", "/v1/status")).json?.supervisor?.pid ?? null;
  const result = await controlCall(ctx, "POST", "/v1/reexec", {});
  if (result.status >= 300) throw controlProblem(ctx, result);
  const deadline = ctx.now() + 20000;
  for (;;) {
    await sleepFor(ctx, 300);
    ctx.refreshControl();
    try {
      const status = await ctx.control().request("GET", "/v1/status", { timeoutMs: 2000 });
      const pid = status.json?.supervisor?.pid ?? null;
      if (status.status === 200 && pid !== before) { ctx.out(tr(ctx, "supervisor.reexeced", { pid: pid ?? "-" })); return EXIT.OK; }
    } catch {}
    if (ctx.now() >= deadline) { ctx.err(tr(ctx, "supervisor.reexecFailed")); return EXIT.FAILURE; }
  }
}

// ---------------------------------------------------------------------------
// setup (first-run wizard, 06 §8)

const SETUP_YES = /^\s*(y|yes|是)\s*$/i;

function setupExec(ctx, file, args) {
  if (ctx.exec) return ctx.exec(file, args);
  const { execFile } = require("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: ctx.aiRoot, env: ctx.env, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
}

async function setupDoctorReport(ctx) {
  const vault = ctx.vault();
  const runDoctor = ctx.runDoctor || require("../manager-core/platform/doctor").runDoctor;
  const report = await runDoctor({ aiRoot: ctx.aiRoot, env: ctx.env, getSecrets: () => vault.values(), ...(ctx.probes ? { probes: ctx.probes } : {}) });
  try {
    const dir = path.join(ctx.aiRoot, ".runtime", "platform");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "doctor-last.json"), JSON.stringify(report));
  } catch {}
  return report;
}

/** Runs one step: through the supervisor when it is up, otherwise in this process. */
async function setupRunStep(ctx, setup, step, params) {
  if (step === "images" && !(await supervisorUp(ctx))) {
    const engines = params.engines || setup.DEFAULT_ENGINES;
    const managers = [...new Set(engines.map((engine) => (engine === "llama" ? "llama-manager" : "vllm-manager")))];
    await (ctx.startPlatform || cmdStart)(ctx, { args: managers, flags: {} });
  }
  if (await supervisorUp(ctx)) {
    const started = await controlCall(ctx, "POST", `/v1/setup/${step}`, params);
    if (started.status >= 300) throw new CliError(EXIT.FAILURE, tr(ctx, "error.failed", { detail: started.json?.error?.message || started.json?.error?.code || `HTTP ${started.status}` }));
    const op = await pollOperation(ctx, started.json.opId, { timeoutMs: 45 * 60 * 1000, onLog: (line) => ctx.err(`    ${line}`) });
    if (op.state !== "ok") return { ok: false, result: op.result, detail: op.result?.message || op.result?.code || op.state };
    return { ok: true, result: op.result?.result };
  }
  const runner = setup.createSetupRunner({ aiRoot: ctx.aiRoot, env: ctx.env, now: ctx.now, ...(ctx.setupOptions || {}) });
  try {
    const done = await runner.runStep(step, params, { line: (line) => ctx.err(`    ${line}`), progress: () => {} });
    return { ok: true, result: done.result };
  } catch (error) {
    return { ok: false, result: { code: error.code, ...(error.data || error.extra || {}) }, detail: error.message };
  }
}

async function cmdSetup(ctx, { flags }) {
  const setup = ctx.setup || require("../manager-core/platform/setup");
  const stepIds = setup.STEP_IDS;
  if (flags.step !== undefined && !stepIds.includes(flags.step)) throw usageError(ctx, tr(ctx, "setup.unknownStep", { step: flags.step, steps: stepIds.join(", ") }));
  if (flags.exposure !== undefined && flags.exposure !== "lan" && flags.exposure !== "local") throw usageError(ctx, "--exposure local|lan");
  const interactive = flags["non-interactive"] !== true && ctx.stdinIsTTY === true;
  const yes = flags.yes === true;
  const explicit = flags.step !== undefined;
  const list = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  const confirm = async (hint, defaultYes) => {
    const answer = await ask(ctx, tr(ctx, "setup.ask", { hint }));
    return answer.trim() === "" ? defaultYes : SETUP_YES.test(answer);
  };
  const record = (id, state) => setup.recordStep(ctx.aiRoot, id, state, { now: ctx.now });

  ctx.out(tr(ctx, "setup.title"));
  const description = setup.describeSetup({ aiRoot: ctx.aiRoot, env: ctx.env, doctor: await setupDoctorReport(ctx) });
  let failed = false;
  const total = description.steps.length;
  for (const entry of description.steps) {
    if (explicit && entry.id !== flags.step) continue;
    ctx.out("");
    ctx.out(tr(ctx, "setup.step", { n: entry.index, total, title: pick(ctx, entry.title) }));
    if (entry.status === "done") {
      ctx.out(`  ${tr(ctx, "setup.alreadyDone", { detail: entry.detail })}`);
      if (entry.recorded?.state !== "done") record(entry.id, "done");
      continue;
    }
    if (entry.status === "skipped" && !explicit) { ctx.out(`  ${tr(ctx, "setup.alreadySkipped")}`); continue; }
    if (entry.status === "blocked") {
      ctx.out(`  ${tr(ctx, "setup.blocked")}`);
      for (const item of entry.data?.blocking || []) {
        ctx.out(`    ${item.id}: ${item.detail}`);
        if (item.fix?.command) ctx.out(`      ${item.fix.command}`);
      }
      failed = true;
      break;
    }
    if (entry.id === "storage" && entry.data?.freeBytes) ctx.out(`  ${tr(ctx, "setup.freeSpace", { gb: (entry.data.freeBytes / 1024 ** 3).toFixed(1) })}`);

    // The ops step never registers anything on its own: the commands are shown
    // and run only on a yes (default N; --yes answers it).
    if (entry.id === "ops") {
      const commands = setup.opsCommands({ aiRoot: ctx.aiRoot });
      ctx.out(`  ${tr(ctx, "setup.opsIntro")}`);
      for (const command of commands) ctx.out(`    ${command.display}`);
      const run = interactive ? SETUP_YES.test(await ask(ctx, tr(ctx, "setup.opsAsk"))) : yes;
      if (!run) { record("ops", "skipped"); ctx.out(`  ${tr(ctx, "setup.skippedStep")}`); continue; }
      let allOk = true;
      for (const command of commands) {
        try { await setupExec(ctx, command.file, command.args); ctx.out(`  ${tr(ctx, "setup.opsRan", { command: command.display })}`); }
        catch (error) { allOk = false; ctx.err(`  ${tr(ctx, "setup.stepFailed", { detail: `${command.display}: ${error.message || error}` })}`); }
      }
      record("ops", allOk ? "done" : "failed");
      if (!allOk) failed = true;
      continue;
    }
    if (entry.id === "first-model") {
      ctx.out(`  ${tr(ctx, "setup.firstModel", { url: "/#/deploy" })}`);
      record("first-model", "skipped");
      continue;
    }

    // Optional steps run only on an explicit yes; the others default to yes.
    const wanted = explicit || !entry.optional;
    let proceed;
    if (explicit && !interactive) proceed = true;
    else if (!interactive) proceed = wanted || (yes && entry.id !== "tts");
    else proceed = await confirm(wanted ? "[Y/n]" : "[y/N]", wanted);
    if (!proceed) { record(entry.id, "skipped"); ctx.out(`  ${tr(ctx, "setup.skippedStep")}`); continue; }

    const params = {};
    if (entry.id === "storage") {
      let roots = list(flags["model-root"]);
      if (interactive && !flags["model-root"]) roots = list(await ask(ctx, tr(ctx, "setup.askRoots")));
      if (roots.length) params.modelRoots = roots;
      if (flags["hf-home"]) params.hfHome = String(flags["hf-home"]);
    } else if (entry.id === "images") {
      let engines = list(flags.engines);
      if (interactive && !flags.engines) engines = list(await ask(ctx, tr(ctx, "setup.askEngines")));
      if (engines.length) params.engines = engines;
    } else if (entry.id === "exposure") {
      let lan = flags.exposure === "lan";
      if (interactive && flags.exposure === undefined) lan = SETUP_YES.test(await ask(ctx, tr(ctx, "setup.askLan")));
      params.mode = lan ? "lan" : "local";
    }

    let outcome;
    if (entry.id === "start") {
      const code = await (ctx.startPlatform || cmdStart)(ctx, { args: ["core"], flags: {} });
      outcome = code === EXIT.OK ? { ok: true } : { ok: false, detail: `platform start (exit ${code})` };
      record("start", outcome.ok ? "done" : "failed");
    } else {
      outcome = await setupRunStep(ctx, setup, entry.id, params);
    }
    if (outcome.ok) {
      ctx.out(`  ${tr(ctx, "setup.stepDone")}`);
      if (entry.id === "exposure" && outcome.result?.firewall?.command) ctx.out(`    ${outcome.result.firewall.command}`);
    } else {
      ctx.err(`  ${tr(ctx, "setup.stepFailed", { detail: outcome.detail })}`);
      for (const item of outcome.result?.blocking || []) ctx.err(`    ${item.id}: ${item.detail}${item.fix?.command ? ` (${item.fix.command})` : ""}`);
      failed = true;
      if (!explicit) break;
    }
  }

  const after = setup.describeSetup({ aiRoot: ctx.aiRoot, env: ctx.env, doctor: null });
  const pending = after.steps.filter((entry) => entry.status !== "skipped" && entry.status !== "done" && (!explicit || entry.id === flags.step));
  ctx.out("");
  if (!failed && !pending.length) {
    if (!explicit) ctx.out(tr(ctx, "setup.complete"));
    return EXIT.OK;
  }
  if (pending.length && !explicit) ctx.out(tr(ctx, "setup.incomplete", { steps: pending.map((entry) => entry.id).join(", ") }));
  return failed ? EXIT.FAILURE : EXIT.OK;
}

// ---------------------------------------------------------------------------
// Command table. Later packages add their commands here (and remove them from
// PLANNED); `run` is (ctx, { args, flags }) -> exit code.

const COMMANDS = {
  doctor: {
    usage: "doctor [--fix[=<checkId>]] [--yes] [--deep] [--group g] [--json]",
    summary: { [ZH]: "检查环境并给出修复建议", [EN]: "Check the environment and suggest fixes" },
    spec: { bool: ["json", "deep", "yes"], value: ["group"], optional: ["fix"], max: 0 },
    run: cmdDoctor,
  },
  status: {
    usage: "status [<id>…] [--json] [--watch]",
    summary: { [ZH]: "显示组件状态和就绪层级", [EN]: "Show component state and readiness layers" },
    spec: { bool: ["json", "watch"] },
    run: cmdStatus,
  },
  logs: {
    usage: "logs <id> [-f] [--err|--out] [--tail N] [--since 10m] [--legacy]",
    summary: { [ZH]: "查看组件日志（已脱敏，不需要监督进程）", [EN]: "Show a component's log (redacted; no supervisor needed)" },
    spec: { bool: ["follow", "err", "out", "legacy"], value: ["tail", "since"], alias: { f: "follow" } },
    run: cmdLogs,
  },
  open: {
    usage: "open [console|billing|vllm|llama|tts]",
    summary: { [ZH]: "在浏览器中打开控制台或管理页面", [EN]: "Open the console or a manager page in the browser" },
    spec: { bool: ["print", "json"] },
    run: cmdOpen,
  },
  version: {
    usage: "version [--json] [--fetch]",
    summary: { [ZH]: "显示版本、构建号、依赖版本和可用更新", [EN]: "Show the version, build id, package versions and available updates" },
    spec: { bool: ["json", "fetch"], max: 0 },
    run: cmdVersion,
  },
  config: {
    usage: "config list|get <k>|set <k> <v>|unset <k>|validate|path|init|import-env [--apply] [--remove-user-env]",
    summary: { [ZH]: "查看和修改平台配置（密钥请用 secrets）", [EN]: "Read and change the platform configuration (secrets go through secrets)" },
    spec: { bool: ["json", "apply", "remove-user-env"] },
    run: cmdConfig,
  },
  deps: {
    usage: "deps [--record] [--install <pkg>] [--json]",
    summary: { [ZH]: "显示各包的依赖锁文件和构建状态", [EN]: "Show lockfile and build state of each package" },
    spec: { bool: ["json", "record"], value: ["install"], max: 0 },
    run: cmdDeps,
  },
  start: {
    usage: "start [core|full|<id>…] [--lan] [--public] [--save] [--restore-models] [--no-supervisor] [--no-browser] [--open] [--timeout s]",
    summary: { [ZH]: "启动平台或指定组件", [EN]: "Start the platform or selected components" },
    spec: { bool: ["lan", "public", "save", "restore-models", "no-supervisor", "no-browser", "open", "json"], value: ["timeout"] },
    run: cmdStart,
  },
  stop: {
    usage: "stop [<id>…|core|full|all] [--models] [--yes]",
    summary: { [ZH]: "停止组件", [EN]: "Stop components" },
    spec: { bool: ["models", "yes"] },
    run: cmdStop,
  },
  restart: {
    usage: "restart <id…|all> [--if-idle] [--when-idle] [--force]",
    summary: { [ZH]: "重启组件", [EN]: "Restart components" },
    spec: { bool: ["if-idle", "when-idle", "force"] },
    run: cmdRestart,
  },
  supervise: {
    usage: "supervise [--profile core|full|none] [--restore-models] [--autostart]",
    summary: { [ZH]: "运行监督进程（前台）", [EN]: "Run the supervisor (foreground)" },
    spec: { bool: ["restore-models", "autostart", "takeover"], value: ["profile"], max: 0 },
    run: cmdSupervise,
  },
  supervisor: {
    usage: "supervisor status|stop|reexec",
    summary: { [ZH]: "管理监督进程", [EN]: "Manage the supervisor" },
    spec: { bool: ["json"] },
    run: cmdSupervisor,
  },
  setup: {
    usage: "setup [--step id] [--yes] [--non-interactive] [--engines list] [--model-root list] [--hf-home path] [--exposure local|lan]",
    summary: { [ZH]: "首次运行向导", [EN]: "First-run wizard" },
    spec: { bool: ["yes", "non-interactive"], value: ["step", "engines", "model-root", "hf-home", "exposure"], max: 0 },
    run: cmdSetup,
  },
  exposure: {
    usage: "exposure scan [--json] | exposure setup [args…]",
    summary: { [ZH]: "对外暴露检查与设置", [EN]: "Exposure scan and setup" },
    spec: { bool: ["json"], passthrough: (tokens) => tokens[0] === "setup" },
    run: cmdExposure,
  },
  secrets: {
    usage: "secrets list|set <key>|clear <key>|copy <key>|migrate|export-legacy --namespace n",
    summary: { [ZH]: "管理密钥库（值从不出现在命令行或屏幕上）", [EN]: "Manage the secret store (values never appear on the command line or screen)" },
    spec: { bool: ["json", "yes"], value: ["namespace"] },
    run: cmdSecrets,
  },
};

const PLANNED = {
  admin: { package: "OPS-7c", usage: "admin pair [--open] [--ttl s]", summary: { [ZH]: "配对浏览器", [EN]: "Pair a browser" } },
  keys: { package: "OPS-7c", usage: "keys migrate [--dry-run|--report] [--json]", summary: { [ZH]: "访问密钥迁移计划", [EN]: "Access-key migration plan" } },
  autostart: { package: "OPS-12", usage: "autostart enable [--profile p] | disable | status", summary: { [ZH]: "登录自启动", [EN]: "Start at logon" } },
  deploy: { package: "OPS-11b", usage: "deploy [--restart none|changed|all] [--skip-tests] [--no-prune] [--allow-live-drift] [--yes] [--dry-run]", summary: { [ZH]: "从工作区部署到线上目录", [EN]: "Deploy a worktree to the live root" } },
  "post-deploy": { package: "OPS-11a", usage: "post-deploy --manifest <path> [--restart …] [--no-prune] [--dry-run]", summary: { [ZH]: "部署后处理（内部使用）", [EN]: "Post-deploy steps (internal)" } },
  update: { package: "OPS-11b", usage: "update [--check]", summary: { [ZH]: "更新线上目录", [EN]: "Update the live root" } },
};

// ---------------------------------------------------------------------------
// Help (always bilingual, 06 §6.4)

function helpText(ctx, name) {
  const lines = [];
  const entry = name ? COMMANDS[name] || PLANNED[name] : null;
  if (entry) {
    lines.push(`platform ${entry.usage}`, `  ${entry.summary[ZH]}`, `  ${entry.summary[EN]}`);
    if (!COMMANDS[name]) lines.push(`  (${S["help.soon"][ZH]} / ${S["help.soon"][EN]}: ${entry.package})`);
    return lines.join("\n");
  }
  lines.push(`${S["help.title"][ZH]}`, `${S["help.title"][EN]}`, "");
  lines.push(`${S["help.usage"][ZH]} / ${S["help.usage"][EN]}: platform <command> [options]`, "");
  lines.push(`${S["help.commands"][ZH]} / ${S["help.commands"][EN]}`);
  const all = [...Object.entries(COMMANDS).map(([key, value]) => [key, value, false]), ...Object.entries(PLANNED).map(([key, value]) => [key, value, true])];
  for (const [, value, planned] of all) {
    lines.push(`  ${value.usage}`);
    lines.push(`      ${value.summary[ZH]} / ${value.summary[EN]}${planned ? `  [${S["help.soon"][ZH]} / ${S["help.soon"][EN]}]` : ""}`);
  }
  lines.push("", `${S["help.global"][ZH]} / ${S["help.global"][EN]}`);
  lines.push(`  ${S["help.langOption"][ZH]}`, `  ${S["help.langOption"][EN]}`);
  lines.push(`  ${S["help.helpOption"][ZH]} / ${S["help.helpOption"][EN]}`);
  lines.push("", S["help.json"][ZH], S["help.json"][EN]);
  lines.push("", `${S["help.exit"][ZH]}: ${S["help.exitCodes"][ZH]}`, `${S["help.exit"][EN]}: ${S["help.exitCodes"][EN]}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry

/** Global options may appear anywhere: --lang, --help/-h, --pause-on-error. */
function extractGlobals(ctx, argv) {
  const rest = [];
  const globals = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") { rest.push(...argv.slice(index)); break; }
    if (token === "--lang") {
      if (argv[index + 1] === undefined) throw new CliError(EXIT.USAGE, tr(ctx, "error.missingValue", { option: "--lang" }));
      globals.lang = argv[index + 1];
      index += 1;
    } else if (token.startsWith("--lang=")) globals.lang = token.slice(7);
    else if (token === "--help" || token === "-h") globals.help = true;
    else if (token === "--pause-on-error") globals.pauseOnError = true;
    else rest.push(token);
  }
  return { rest, globals };
}

async function run(argv, overrides = {}) {
  const ctx = createContext(overrides);
  const { resolveLanguage } = require("../manager-core/platform/messages");
  let code;
  let pause = false;
  try {
    ctx.lang = resolveLanguage({ lang: overrides.lang, env: ctx.env, locale: overrides.locale });
    const { rest, globals } = extractGlobals(ctx, argv);
    if (globals.lang) ctx.lang = resolveLanguage({ lang: globals.lang, env: ctx.env });
    pause = globals.pauseOnError === true;
    const [name, ...tokens] = rest;
    if (!name || name === "help") {
      ctx.out(helpText(ctx, name === "help" ? tokens[0] : null));
      // A bare `platform` shows the help but is a usage error.
      code = name || globals.help ? EXIT.OK : EXIT.USAGE;
    } else if (COMMANDS[name]) {
      if (globals.help) { ctx.out(helpText(ctx, name)); code = EXIT.OK; }
      else {
        const parsed = parseArgs(ctx, name, tokens, COMMANDS[name].spec);
        code = await COMMANDS[name].run(ctx, parsed);
      }
    } else if (PLANNED[name]) {
      if (globals.help) { ctx.out(helpText(ctx, name)); code = EXIT.OK; }
      else {
        ctx.err(tr(ctx, "error.notAvailable", { name, package: PLANNED[name].package }));
        code = EXIT.FAILURE;
      }
    } else {
      ctx.err(tr(ctx, "error.unknownCommand", { name }));
      code = EXIT.USAGE;
    }
  } catch (error) {
    if (error instanceof CliError) {
      ctx.err(error.message);
      code = error.exit;
    } else {
      ctx.err(tr(ctx, "error.failed", { detail: error?.message || String(error) }));
      if (ctx.env.PLATFORM_DEBUG && error?.stack) ctx.err(error.stack);
      code = EXIT.FAILURE;
    }
  }
  if (pause && code !== EXIT.OK && ctx.stdinIsTTY && !overrides.stdin) {
    ctx.err("Press Enter to close / 按回车键关闭");
    await new Promise((resolve) => { ctx.stdin.once("data", resolve); ctx.stdin.resume(); });
  }
  return code;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // A dangling handle must not keep a finished command alive.
    setTimeout(() => process.exit(code), 1000).unref();
  });
}

module.exports = { EXIT, COMMANDS, PLANNED, CliError, run, parseArgs, createContext, tr, helpText };
