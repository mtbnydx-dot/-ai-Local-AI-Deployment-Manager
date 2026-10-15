#!/usr/bin/env node
"use strict";

// The `platform` CLI (docs/overhaul/06-ops.md §6). This file is the framework
// (argument parsing, language, exit codes, the command table) plus the read
// commands: doctor (report only), status, logs, version, open, config, deps,
// post-deploy (OPS-11a) and secrets. Lifecycle, access and the remaining deploy
// commands register in COMMANDS from later packages; until then they answer
// "not available yet" with exit 1.
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
  "config.secretSet": { [ZH]: "（已设置）", [EN]: "(set)" },
  "config.secretUnset": { [ZH]: "（未设置）", [EN]: "(not set)" },
  "deps.title": { [ZH]: "依赖状态", [EN]: "Dependencies" },
  "deps.recorded": { [ZH]: "已记录依赖状态：{count} 个包，MCP 构建：{mcp}", [EN]: "Recorded dependency state: {count} package(s), MCP build: {mcp}" },
  "deps.installed": { [ZH]: "{package}：{status}", [EN]: "{package}: {status}" },
  "deps.unknownPackage": { [ZH]: "没有这个包：{name}", [EN]: "No such package: {name}" },
  "postDeploy.title": { [ZH]: "部署后处理", [EN]: "Post-deploy steps" },
  "postDeploy.titleDry": { [ZH]: "部署后处理（仅预览，不做任何更改）", [EN]: "Post-deploy steps (plan only, nothing is changed)" },
  "postDeploy.noManifest": { [ZH]: "需要 --manifest <部署清单路径>。", [EN]: "--manifest <path to deployment-manifest.json> is required." },
  "postDeploy.badManifest": { [ZH]: "无法读取部署清单：{path}", [EN]: "Cannot read the deployment manifest: {path}" },
  "postDeploy.badRestart": { [ZH]: "--restart 只能是 none、changed 或 all。", [EN]: "--restart must be none, changed or all." },
  "postDeploy.otherRoot": { [ZH]: "该部署清单属于另一个目录（{root}），拒绝处理。", [EN]: "This manifest belongs to another root ({root}); refusing." },
  "postDeploy.prune": { [ZH]: "清理旧文件：{count} 个（已备份到部署备份目录），保留 {kept} 个", [EN]: "Prune: {count} stale file(s) (backed up beside the deploy manifest), {kept} kept" },
  "postDeploy.pruneDry": { [ZH]: "清理旧文件：将删除 {count} 个，保留 {kept} 个", [EN]: "Prune: would remove {count} file(s), keep {kept}" },
  "postDeploy.pruneSkipped": { [ZH]: "清理旧文件：已跳过（--no-prune）", [EN]: "Prune: skipped (--no-prune)" },
  "postDeploy.kept": { [ZH]: "  保留 {path}（{reason}）", [EN]: "  kept {path} ({reason})" },
  "postDeploy.remove": { [ZH]: "  删除 {path}", [EN]: "  remove {path}" },
  "postDeploy.dep": { [ZH]: "依赖 {package}：{status}", [EN]: "Dependencies {package}: {status}" },
  "postDeploy.depNone": { [ZH]: "依赖：无需更新", [EN]: "Dependencies: up to date" },
  "postDeploy.mcp": { [ZH]: "MCP 构建：{status}", [EN]: "MCP build: {status}" },
  "postDeploy.version": { [ZH]: "version.json：{status}", [EN]: "version.json: {status}" },
  "postDeploy.restartNone": { [ZH]: "需要重启：{list}", [EN]: "restart required: {list}" },
  "postDeploy.restartNothing": { [ZH]: "无需重启组件。", [EN]: "No component needs a restart." },
  "postDeploy.restartRun": { [ZH]: "运行：{command}", [EN]: "Run: {command}" },
  "postDeploy.failed": { [ZH]: "部署后处理有步骤失败：{steps}", [EN]: "Post-deploy steps failed: {steps}" },
  "postDeploy.done": { [ZH]: "部署后处理完成。", [EN]: "Post-deploy steps finished." },
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
  "doctor.fixLater": { [ZH]: "doctor --fix 将随修复执行器一起提供。", [EN]: "doctor --fix arrives with the fix runner." },
  "doctor.summary": { [ZH]: "通过 {ok} · 警告 {warn} · 失败 {fail} · 信息 {info} · 跳过 {skip}", [EN]: "ok {ok} · warn {warn} · fail {fail} · info {info} · skipped {skip}" },
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
  const registry = components.loadComponentRegistry({ aiRoot: ctx.aiRoot, config, now: ctx.now() });
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
  if (sub === "import-env") throw new CliError(EXIT.FAILURE, tr(ctx, "error.notAvailable", { name: "config import-env", package: "OPS-16" }));
  throw usageError(ctx, "config list|get <key>|set <key> <value>|unset <key>|validate|path|init");
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
    return { package: pkg.dir, live: pkg.live === true, components: pkg.components || [], installed, lockHash, recordedHash, versionsMatch, status, ...(saved?.pendingSwap ? { pendingSwap: true } : {}), ...(pkg.live ? {} : { note: pkg.reason || "test-only" }) };
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

// deps --record / --install <pkg> (06 §6.2, §9.3): the machinery post-deploy uses.
async function cmdDepsWrite(ctx, flags, registry) {
  const steps = require("../manager-core/platform/deploy-steps");
  const seams = { fs: ctx.fs, now: ctx.now, ...(ctx.nodeVersion ? { nodeVersion: ctx.nodeVersion } : {}) };
  if (flags.install) {
    const name = String(flags.install);
    if (!registry.packages.some((pkg) => pkg.dir === name)) throw new CliError(EXIT.USAGE, tr(ctx, "deps.unknownPackage", { name }));
    const done = await steps.runDependencies({ aiRoot: ctx.aiRoot, registry, only: [name], force: true, npm: ctx.npm, log: (line) => ctx.err(line), ...seams });
    if (flags.json) ctx.json({ schemaVersion: 1, ...done });
    else for (const item of done.packages) ctx.out(tr(ctx, "deps.installed", { package: item.package, status: item.status + (item.detail ? ` (${item.detail})` : "") }));
    return done.packages.some((item) => item.status === "failed") ? EXIT.FAILURE : EXIT.OK;
  }
  const done = await steps.recordDependencyState({ aiRoot: ctx.aiRoot, registry, ...seams });
  if (flags.json) ctx.json({ schemaVersion: 1, ...done });
  else ctx.out(tr(ctx, "deps.recorded", { count: done.packages.filter((item) => item.status === "recorded").length, mcp: done.mcp ? done.mcp.status : "-" }));
  return EXIT.OK;
}

async function cmdDeps(ctx, { flags }) {
  const config = loadConfig(ctx);
  const { registry } = loadRegistry(ctx, config);
  if (flags.record || flags.install) return cmdDepsWrite(ctx, flags, registry);
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
// post-deploy (06 §9.3). deploy-worktree.ps1 calls it with the deploy backup's
// manifest; the steps live in manager-core/platform/deploy-steps.js.

const POST_DEPLOY_LIST_LIMIT = 40;

function samePath(left, right) {
  const norm = (value) => path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(left).toLowerCase() === norm(right).toLowerCase() : norm(left) === norm(right);
}

function printList(ctx, key, items, render) {
  for (const item of items.slice(0, POST_DEPLOY_LIST_LIMIT)) ctx.out(tr(ctx, key, render(item)));
  if (items.length > POST_DEPLOY_LIST_LIMIT) ctx.out(`  … +${items.length - POST_DEPLOY_LIST_LIMIT}`);
}

function printRestart(ctx, mode, ids, reexec, commands, dry) {
  if (!ids.length && !reexec) { ctx.out(tr(ctx, "postDeploy.restartNothing")); return; }
  const list = [...(reexec ? ["supervisor"] : []), ...ids].join(", ");
  if (mode === "none" || dry) ctx.out(tr(ctx, "postDeploy.restartNone", { list }));
  if (mode !== "none" && !dry) for (const command of commands) ctx.out(tr(ctx, "postDeploy.restartRun", { command }));
}

function printPostDeployPlan(ctx, plan) {
  const [prune, deps, build, version, restart] = plan.steps;
  ctx.out(tr(ctx, "postDeploy.titleDry"));
  if (prune.skipped) ctx.out(tr(ctx, "postDeploy.pruneSkipped"));
  else {
    ctx.out(tr(ctx, "postDeploy.pruneDry", { count: prune.candidates.length, kept: prune.kept.length }));
    printList(ctx, "postDeploy.remove", prune.candidates, (item) => ({ path: item.path }));
    printList(ctx, "postDeploy.kept", prune.kept, (item) => ({ path: item.path, reason: item.reason }));
  }
  const changes = deps.packages.filter((step) => step.action !== "ok" && step.action !== "skip");
  if (!changes.length) ctx.out(tr(ctx, "postDeploy.depNone"));
  for (const step of changes) ctx.out(tr(ctx, "postDeploy.dep", { package: step.package, status: `${step.action} (${step.reason})` }));
  ctx.out(tr(ctx, "postDeploy.mcp", { status: build.needed ? `build (${build.reason})` : build.reason === "no_build_package" || build.reason === "package_missing" ? "-" : "current" }));
  ctx.out(tr(ctx, "postDeploy.version", { status: `write ${version.version || version.commit || "-"}` }));
  printRestart(ctx, restart.mode, restart.ids, restart.reexec, [], true);
}

function printPostDeployResult(ctx, result) {
  ctx.out(tr(ctx, "postDeploy.title"));
  ctx.out(result.pruneSkipped ? tr(ctx, "postDeploy.pruneSkipped") : tr(ctx, "postDeploy.prune", { count: result.pruned.length, kept: result.kept.length }));
  printList(ctx, "postDeploy.kept", result.kept, (item) => ({ path: item.path, reason: item.reason }));
  const changes = result.dependencies.filter((item) => item.status && item.status !== "ok" && item.status !== "skipped");
  if (!changes.length) ctx.out(tr(ctx, "postDeploy.depNone"));
  for (const item of changes) ctx.out(tr(ctx, "postDeploy.dep", { package: item.package || "-", status: item.status + (item.detail ? ` (${item.detail})` : "") }));
  if (result.mcp) ctx.out(tr(ctx, "postDeploy.mcp", { status: result.mcp.status + (result.mcp.detail ? ` (${result.mcp.detail})` : "") }));
  if (result.version) ctx.out(tr(ctx, "postDeploy.version", { status: result.version.written ? "ok" : `failed (${result.version.code})` }));
  const restart = result.restartResult;
  if (restart) printRestart(ctx, restart.mode, restart.ids, restart.reexec, restart.commands, false);
  ctx.out(tr(ctx, result.ok ? "postDeploy.done" : "postDeploy.failed", { steps: result.failed.join(", ") }));
}

async function cmdPostDeploy(ctx, { flags }) {
  if (!flags.manifest) throw usageError(ctx, tr(ctx, "postDeploy.noManifest"));
  const mode = flags.restart === undefined ? "none" : String(flags.restart);
  if (!["none", "changed", "all"].includes(mode)) throw usageError(ctx, tr(ctx, "postDeploy.badRestart"));
  const manifestFile = path.resolve(String(flags.manifest));
  let manifest = null;
  try {
    const text = fs.readFileSync(manifestFile, "utf8");
    manifest = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch { /* reported below */ }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !manifest.files) {
    throw new CliError(EXIT.FAILURE, tr(ctx, "postDeploy.badManifest", { path: path.basename(manifestFile) }));
  }
  // A manifest names the live root it deployed to; never prune another one.
  if (manifest.liveRoot && !samePath(String(manifest.liveRoot), ctx.aiRoot)) {
    throw new CliError(EXIT.FAILURE, tr(ctx, "postDeploy.otherRoot", { root: path.basename(String(manifest.liveRoot)) }));
  }
  const config = loadConfig(ctx);
  const { registry } = loadRegistry(ctx, config);
  const steps = require("../manager-core/platform/deploy-steps");
  const result = await steps.executePostDeploy({
    aiRoot: ctx.aiRoot, manifest, manifestFile, registry, restart: mode,
    noPrune: flags["no-prune"] === true, dryRun: flags["dry-run"] === true,
    fs: ctx.fs, npm: ctx.npm, now: ctx.now, restartAdapter: ctx.restartAdapter,
    ...(ctx.nodeVersion ? { nodeVersion: ctx.nodeVersion } : {}),
    log: (line) => ctx.err(line),
  });
  if (flags.json) ctx.json(result);
  else if (result.dryRun) printPostDeployPlan(ctx, result.plan);
  else printPostDeployResult(ctx, result);
  return result.ok ? EXIT.OK : EXIT.FAILURE;
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
    usage: "config list|get <k>|set <k> <v>|unset <k>|validate|path|init",
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
  "post-deploy": {
    usage: "post-deploy --manifest <path> [--restart none|changed|all] [--no-prune] [--dry-run] [--json]",
    summary: { [ZH]: "部署后处理（内部使用，由部署脚本调用）", [EN]: "Post-deploy steps (internal; called by the deploy script)" },
    spec: { bool: ["json", "no-prune", "dry-run"], value: ["manifest", "restart"], max: 0 },
    run: cmdPostDeploy,
  },
  secrets: {
    usage: "secrets list|set <key>|clear <key>|copy <key>|migrate|export-legacy --namespace n",
    summary: { [ZH]: "管理密钥库（值从不出现在命令行或屏幕上）", [EN]: "Manage the secret store (values never appear on the command line or screen)" },
    spec: { bool: ["json", "yes"], value: ["namespace"] },
    run: cmdSecrets,
  },
};

const PLANNED = {
  setup: { package: "OPS-14", usage: "setup [--step id] [--yes] [--non-interactive]", summary: { [ZH]: "首次运行向导", [EN]: "First-run wizard" } },
  start: { package: "OPS-7b", usage: "start [core|full|<id>…] [--lan] [--public] [--save] [--restore-models] [--no-supervisor] [--no-browser] [--open] [--timeout s]", summary: { [ZH]: "启动平台或指定组件", [EN]: "Start the platform or selected components" } },
  stop: { package: "OPS-7b", usage: "stop [<id>…|core|full|all] [--models] [--yes]", summary: { [ZH]: "停止组件", [EN]: "Stop components" } },
  restart: { package: "OPS-7b", usage: "restart <id…|all> [--if-idle] [--when-idle] [--force]", summary: { [ZH]: "重启组件", [EN]: "Restart components" } },
  supervise: { package: "OPS-7b", usage: "supervise …", summary: { [ZH]: "运行监督进程", [EN]: "Run the supervisor" } },
  supervisor: { package: "OPS-7b", usage: "supervisor status|stop|reexec", summary: { [ZH]: "管理监督进程", [EN]: "Manage the supervisor" } },
  admin: { package: "OPS-7c", usage: "admin pair [--open] [--ttl s]", summary: { [ZH]: "配对浏览器", [EN]: "Pair a browser" } },
  keys: { package: "OPS-7c", usage: "keys migrate [--dry-run|--report] [--json]", summary: { [ZH]: "访问密钥迁移计划", [EN]: "Access-key migration plan" } },
  exposure: { package: "OPS-7c", usage: "exposure scan [--json] | exposure setup [args…]", summary: { [ZH]: "对外暴露检查与设置", [EN]: "Exposure scan and setup" } },
  autostart: { package: "OPS-12", usage: "autostart enable [--profile p] | disable | status", summary: { [ZH]: "登录自启动", [EN]: "Start at logon" } },
  deploy: { package: "OPS-11b", usage: "deploy [--restart none|changed|all] [--skip-tests] [--no-prune] [--allow-live-drift] [--yes] [--dry-run]", summary: { [ZH]: "从工作区部署到线上目录", [EN]: "Deploy a worktree to the live root" } },
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
