"use strict";

// First-run setup wizard backend (06 §8). Two halves:
//   describeSetup()      the live status of every step, derived from a doctor
//                        report, so a step done by hand shows as done;
//   createSetupRunner()  prepare() validates a step request before any operation
//                        exists, execute() runs the step's action and records it
//                        in .runtime/platform/setup.json.
// The supervisor wraps execute() in a streamed "setup" operation
// (POST /v1/setup/:step); `platform setup` uses the same runner in-process when
// no supervisor is running. Image pulls go through the doctor fix runner's
// pull-image executor, which only calls the hosting manager's
// POST /api/runtimes/:runtimeId/pull; nothing here spawns `docker pull`, and the
// `ops` step never registers a task from the API: it only returns the commands.
const nodeFs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const childProcess = require("node:child_process");
const { controlError } = require("./control");

const L = (zh, en) => ({ "zh-CN": zh, "en-US": en });

const STEPS = Object.freeze([
  { id: "prereq", title: L("检查环境", "Check prerequisites"), optional: false },
  { id: "deps", title: L("安装依赖", "Install dependencies"), optional: false },
  { id: "download-cli", title: L("下载工具", "Download tool"), optional: true },
  { id: "storage", title: L("存储位置", "Storage locations"), optional: false },
  { id: "images", title: L("预拉取运行时", "Pre-pull runtimes"), optional: false },
  { id: "tts", title: L("语音（可选）", "Voice (optional)"), optional: true },
  { id: "exposure", title: L("访问范围", "Access"), optional: false },
  { id: "ops", title: L("自动运行", "Automation"), optional: true },
  { id: "start", title: L("启动平台", "Start the platform"), optional: false },
  { id: "first-model", title: L("部署第一个模型", "Deploy a first model"), optional: true },
]);
const STEP_IDS = Object.freeze(STEPS.map((step) => step.id));
const ENGINES = Object.freeze(["vllm", "llama", "sglang"]);
const DEFAULT_ENGINES = Object.freeze(["vllm"]);
const SETTLED = new Set(["done", "skipped"]);
// Checks owned by a later step; a failure there does not block `prereq`.
const LATER_STEP_CHECKS = /^(env\.deps\.|env\.mcp-dist$|env\.download-cli$|runtime\.images$|runtime\.gpu-in-docker$)/;
const MANAGER_OF = { vllm: "vllm-manager", sglang: "vllm-manager", llama: "llama-manager" };

function setupFile(aiRoot) { return path.join(aiRoot, ".runtime", "platform", "setup.json"); }

function readSetupState(aiRoot, fsImpl = nodeFs) {
  try {
    const parsed = JSON.parse(String(fsImpl.readFileSync(setupFile(aiRoot), "utf8")).replace(/^﻿/, ""));
    return { steps: parsed && typeof parsed.steps === "object" && parsed.steps ? parsed.steps : {}, completedAt: parsed?.completedAt || null };
  } catch {
    return { steps: {}, completedAt: null };
  }
}

function writeSetupState(aiRoot, state, fsImpl = nodeFs) {
  const file = setupFile(aiRoot);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(temp, `${JSON.stringify({ steps: state.steps, completedAt: state.completedAt || null }, null, 2)}\n`);
  fsImpl.renameSync(temp, file);
}

function allSettled(state) { return STEP_IDS.every((id) => SETTLED.has(state.steps[id]?.state)); }

/** Records one step ("done" | "skipped" | "failed") and sets completedAt once every step is settled. */
function recordStep(aiRoot, id, stateName, options = {}) {
  if (!STEP_IDS.includes(id)) throw controlError(404, "setup_step_unknown", `Unknown setup step ${id}.`);
  const fsImpl = options.fs || nodeFs;
  const at = new Date((options.now || Date.now)()).toISOString();
  const state = readSetupState(aiRoot, fsImpl);
  state.steps[id] = { state: stateName, at };
  if (allSettled(state) && !state.completedAt) state.completedAt = at;
  writeSetupState(aiRoot, state, fsImpl);
  return state;
}

/** The owner's "Skip setup": every unsettled step becomes skipped and the wizard is complete. */
function skipAll(aiRoot, options = {}) {
  const fsImpl = options.fs || nodeFs;
  const at = new Date((options.now || Date.now)()).toISOString();
  const state = readSetupState(aiRoot, fsImpl);
  for (const id of STEP_IDS) if (!SETTLED.has(state.steps[id]?.state)) state.steps[id] = { state: "skipped", at };
  state.completedAt = state.completedAt || at;
  writeSetupState(aiRoot, state, fsImpl);
  return state;
}

// ---- live status --------------------------------------------------------------------------------

function indexChecks(doctor) {
  const byId = new Map();
  for (const check of Array.isArray(doctor?.checks) ? doctor.checks : []) byId.set(check.id, check);
  return byId;
}

function fixInfo(check) {
  const fix = check?.fix;
  return fix ? { id: fix.id, risk: fix.risk, label: fix.label, command: fix.command || null, docs: fix.docs || null } : null;
}

function brief(check) { return check ? { id: check.id, status: check.status, detail: check.detail } : null; }

function freeBytesOf(directory, statfs) {
  try { const stat = statfs(directory); return Number(stat.bavail) * Number(stat.bsize); } catch { return null; }
}

function liveStatus(id, checks, context) {
  const get = (name) => checks.get(name);
  const status = (name) => get(name)?.status;
  const seen = checks.size > 0;
  const withPrefix = (prefix) => [...checks.values()].filter((check) => check.id.startsWith(prefix));
  switch (id) {
    case "prereq": {
      const blocking = [...checks.values()].filter((check) => /^(env|runtime)\./.test(check.id) && check.status === "fail" && !LATER_STEP_CHECKS.test(check.id));
      if (!seen) return { status: "todo", detail: "No doctor report yet." };
      return blocking.length
        ? { status: "blocked", detail: `${blocking.length} blocking problem(s).`, data: { blocking: blocking.map((check) => ({ id: check.id, detail: check.detail, fix: fixInfo(check) })) } }
        : { status: "done", detail: "The environment checks pass." };
    }
    case "deps": {
      const deps = withPrefix("env.deps.");
      const missing = deps.filter((check) => check.status !== "ok");
      const mcp = get("env.mcp-dist");
      const mcpMissing = mcp && mcp.status !== "ok" && mcp.status !== "skip";
      if (!deps.length && !mcp) return { status: "todo", detail: "Dependencies have not been checked." };
      return missing.length || mcpMissing
        ? { status: "todo", detail: `${missing.length + (mcpMissing ? 1 : 0)} dependency check(s) are not ok.`, data: { checks: [...missing, ...(mcpMissing ? [mcp] : [])].map(brief) } }
        : { status: "done", detail: "Dependencies and the MCP build are present." };
    }
    case "download-cli":
      return status("env.download-cli") === "ok" ? { status: "done", detail: "The download tool is installed." } : { status: "todo", detail: get("env.download-cli")?.detail || "The download tool is not installed." };
    case "storage": {
      const roots = get("storage.model-roots"), hf = get("storage.hf-cache");
      const data = { freeBytes: freeBytesOf(context.aiRoot, context.statfs), checks: [roots, hf].filter(Boolean).map(brief) };
      return roots?.status === "ok" ? { status: "done", detail: roots.detail, data } : { status: "todo", detail: roots?.detail || "Model storage has not been checked.", data };
    }
    case "images": {
      const images = get("runtime.images");
      if (!images) return { status: "todo", detail: "Runtime images have not been checked." };
      const rows = Array.isArray(images.data?.runtimes) ? images.data.runtimes : [];
      const data = { runtimes: rows.map((row) => ({ runtimeId: row.runtimeId, engineId: row.engineId, present: row.present, localBuild: row.localBuild })) };
      return images.status === "ok" ? { status: "done", detail: images.detail, data } : { status: "todo", detail: images.detail, data };
    }
    case "tts": return { status: "todo", detail: "Optional voice gateway." };
    case "exposure": {
      const lan = context.lan === true;
      return { status: "todo", detail: lan ? "The admin listener is open to the LAN." : "Access is local only.", data: { mode: lan ? "lan" : "local", lanKeys: brief(get("sec.lan-keys")), firewall: fixInfo(get("net.firewall")) } };
    }
    case "ops": {
      const auto = get("ops.autostart"), nightly = get("ops.nightly"), backup = get("ops.backup");
      const done = auto?.status === "ok" && nightly?.status === "ok" && backup?.status === "ok";
      return { status: done ? "done" : "todo", detail: done ? "Autostart, nightly and backup are registered." : "Automation is not fully registered.", data: { commands: opsCommands({ aiRoot: context.aiRoot }).map((command) => command.display) } };
    }
    case "start":
      return status("ops.supervisor") === "ok" ? { status: "done", detail: "The platform is running." } : { status: "todo", detail: get("ops.supervisor")?.detail || "The platform is not running." };
    case "first-model": return { status: "todo", detail: "Deploy a first model from the console." };
    default: return { status: "todo", detail: "" };
  }
}

/**
 * describeSetup({aiRoot, env, doctor}) -> {steps, completedAt, current}.
 * `status` is live (done | todo | blocked | skipped | failed); a step the doctor
 * sees as done is done whatever setup.json says. `recorded` is the stored state.
 */
function describeSetup(options = {}) {
  const env = options.env || process.env;
  const aiRoot = path.resolve(options.aiRoot || env.AI_ROOT || path.join(__dirname, "../.."));
  const fsImpl = options.fs || nodeFs;
  const state = readSetupState(aiRoot, fsImpl);
  const checks = indexChecks(options.doctor);
  let lan = options.lan;
  if (lan === undefined) {
    try { lan = require("./config").loadPlatformConfig({ aiRoot, env }).values?.["listeners.admin.lan"] === true; } catch { lan = false; }
  }
  const context = { aiRoot, statfs: options.statfs || ((directory) => fsImpl.statfsSync(directory)), lan: lan === true };
  const steps = STEPS.map((step, index) => {
    const live = liveStatus(step.id, checks, context);
    const recorded = state.steps[step.id] || null;
    let status = live.status;
    if (status !== "done" && recorded?.state === "done") status = "done";
    else if (status !== "done" && recorded?.state === "skipped") status = "skipped";
    else if (status === "todo" && recorded?.state === "failed") status = "failed";
    return { id: step.id, index: index + 1, title: step.title, optional: step.optional, status, detail: live.detail, recorded: recorded ? { state: recorded.state, at: recorded.at } : null, ...(live.data ? { data: live.data } : {}) };
  });
  const current = steps.find((step) => !SETTLED.has(step.status) && step.status !== "done");
  return { steps, completedAt: state.completedAt, current: current ? current.id : null };
}

// ---- ops commands (shown, never run by the API) --------------------------------------------------

const POWERSHELL_ARGS = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];

function opsCommands(options = {}) {
  const aiRoot = path.resolve(options.aiRoot || ".");
  const node = options.nodePath || process.execPath;
  return [
    { id: "autostart", display: "platform autostart enable", file: node, args: [path.join(aiRoot, "scripts", "platformctl.js"), "autostart", "enable"] },
    { id: "backup", display: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\backup-platform.ps1 -Register", file: "powershell.exe", args: [...POWERSHELL_ARGS, path.join(aiRoot, "scripts", "backup-platform.ps1"), "-Register"] },
    { id: "nightly", display: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\nightly-e2e.ps1 -Register", file: "powershell.exe", args: [...POWERSHELL_ARGS, path.join(aiRoot, "scripts", "nightly-e2e.ps1"), "-Register"] },
  ];
}

// ---- runner --------------------------------------------------------------------------------------

function createSetupRunner(options = {}) {
  const env = options.env || process.env;
  const aiRoot = path.resolve(options.aiRoot || env.AI_ROOT || path.join(__dirname, "../.."));
  const fsImpl = options.fs || nodeFs;
  const now = options.now || Date.now;
  const execFile = options.execFile || childProcess.execFile;
  const supervisor = options.supervisor || null;
  const runDoctor = options.runDoctor || ((request) => require("./doctor").runDoctor(request));
  const execute = options.execute || ((command, args, extra = {}) => new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...extra }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr || "") })) : resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") })));
  }));

  async function loadConfig() { return options.config || require("./config").loadPlatformConfig({ aiRoot, env }); }
  async function loadRegistry() {
    const config = await loadConfig();
    return options.registry || require("./components").loadComponentRegistry({ aiRoot, config });
  }
  function doctor(extra) { return runDoctor({ aiRoot, env, ...(options.doctorOptions || {}), ...extra }); }
  function fixRunner() {
    const create = options.createFixRunner || require("./doctor-fix").createFixRunner;
    return create({ aiRoot, env, supervisor, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.registry ? { registry: options.registry } : {}), ...(options.config ? { config: options.config } : {}), now, ...(options.fixOptions || {}) });
  }
  async function runFixExecutor(name, fix, io) {
    const runner = fixRunner();
    const executor = runner.executors?.[name];
    if (typeof executor !== "function") throw controlError(501, "fix_unavailable", `The ${name} executor is unavailable.`);
    return executor({ fix, check: null }, io);
  }

  // ---- parameter validation (before any operation exists) ----

  function stringList(value, name, pattern) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() && (!pattern || pattern(item)))) {
      throw controlError(400, "invalid_request", `${name} must be a list of valid strings.`);
    }
    return value.map((item) => item.trim());
  }

  function validate(step, body) {
    const params = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    if (params.skip === true) return { mark: "skipped" };
    if (params.done === true) return { mark: "done" };
    switch (step) {
      case "images": {
        const engines = stringList(params.engines, "engines", (item) => ENGINES.includes(item)) || [...DEFAULT_ENGINES];
        return { engines: [...new Set(engines)] };
      }
      case "storage": {
        const modelRoots = stringList(params.modelRoots, "modelRoots", (item) => path.isAbsolute(item)) || [];
        if (params.hfHome !== undefined && (typeof params.hfHome !== "string" || !path.isAbsolute(params.hfHome))) throw controlError(400, "invalid_request", "hfHome must be an absolute path.");
        return { modelRoots, hfHome: params.hfHome };
      }
      case "exposure": {
        const mode = params.mode === undefined ? "local" : params.mode;
        if (mode !== "local" && mode !== "lan") throw controlError(400, "invalid_request", "mode is local or lan.");
        return { mode };
      }
      default: return {};
    }
  }

  async function prepare(step, body = {}) {
    // "all" is the console's "Skip setup": every unsettled step is skipped.
    if (step === "all") {
      if (body?.skip !== true) throw controlError(400, "invalid_request", "Only {skip:true} is accepted for all.");
      return { step: "all", params: { mark: "skipped" }, immediate: {} };
    }
    if (!STEP_IDS.includes(String(step))) throw controlError(404, "setup_step_unknown", `Unknown setup step ${step}.`);
    const params = validate(step, body);
    // The ops step never registers anything from here; the operation just
    // reports the commands (the CLI asks the owner and runs them itself).
    const immediate = step === "ops" && !params.mark ? { commands: opsCommands({ aiRoot }).map((command) => command.display) } : {};
    return { step, params, immediate };
  }

  // ---- step actions ----

  const actions = {
    async prereq(_params, io) {
      const report = await doctor({ groups: ["env", "runtime"] });
      const blocking = report.checks.filter((check) => check.status === "fail" && !LATER_STEP_CHECKS.test(check.id));
      for (const check of report.checks) io.line(`${check.status.toUpperCase()} ${check.id}`);
      if (blocking.length) {
        throw controlError(409, "prereq_blocked", `${blocking.length} prerequisite check(s) fail and need a manual fix.`, { blocking: blocking.map((check) => ({ id: check.id, detail: check.detail, fix: fixInfo(check) })) });
      }
      return { ok: true, checked: report.checks.length };
    },

    async deps(_params, io) {
      const registry = await loadRegistry();
      const packages = (registry.packages || []).filter((pkg) => pkg.live !== false);
      const installed = [];
      for (let index = 0; index < packages.length; index += 1) {
        const pkg = packages[index];
        io.line(`${pkg.dir}: npm ci`);
        if (options.installDeps) await options.installDeps(pkg, io);
        else await execute(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm ci --no-audit --no-fund"], { cwd: path.join(aiRoot, pkg.dir), timeout: 15 * 60 * 1000 });
        installed.push(pkg.dir);
        io.progress((index + 1) / (packages.length + 1));
      }
      const report = await doctor({ ids: ["env.mcp-dist"] });
      const mcp = report.checks.find((check) => check.id === "env.mcp-dist");
      if (mcp && mcp.status !== "ok" && mcp.status !== "skip") {
        io.line("platform-mcp: build");
        await runFixExecutor("mcp-build", { id: "mcp-build", risk: "confirm" }, io);
      }
      return { installed };
    },

    async "download-cli"(_params, io) {
      return runFixExecutor("install-download-cli", { id: "install-download-cli", risk: "confirm" }, io);
    },

    async storage(params, io) {
      const registered = [];
      if (params.modelRoots.length) {
        const create = options.createModelStorage || require("../model-storage").createModelStorage;
        const storage = create({
          modelsRoot: env.VLLM_MODELS_ROOT || path.join(aiRoot, "models"),
          file: env.MODEL_STORAGE_FILE || path.join(aiRoot, "service-entry", "data", "model-storage.json"),
        });
        for (const root of params.modelRoots) {
          try {
            storage.registerRoot({ path: root, create: true });
            registered.push({ path: root, status: "registered" });
            io.line(`${root}: registered`);
          } catch (error) {
            if (/已登记|重叠|already|overlap/i.test(String(error?.message))) { registered.push({ path: root, status: "already" }); io.line(`${root}: already registered`); }
            else throw controlError(400, "root_rejected", `${root}: ${String(error?.message || error)}`);
          }
        }
      }
      let hfHome = null;
      if (params.hfHome) {
        const write = options.writeConfig || require("./config").writePlatformConfig;
        const saved = await write({ aiRoot, env, actor: "setup", set: { "paths.hfHome": params.hfHome } });
        if (saved?.ok === false) throw controlError(400, saved.error?.code || saved.code || "config_invalid", "The Hugging Face cache folder was not saved.");
        hfHome = params.hfHome;
        io.line(`paths.hfHome: ${params.hfHome}`);
      }
      return { registered, hfHome, freeBytes: freeBytesOf(aiRoot, options.statfs || ((directory) => fsImpl.statfsSync(directory))) };
    },

    // Image pulls: only the hosting manager's endpoint, through the doctor fix runner.
    async images(params, io) {
      const report = await doctor({ ids: ["runtime.images"] });
      const check = report.checks.find((item) => item.id === "runtime.images");
      const rows = Array.isArray(check?.data?.runtimes) ? check.data.runtimes : [];
      const wanted = rows.filter((row) => params.engines.some((engine) => String(row.engineId || "").toLowerCase().startsWith(engine)));
      if (!wanted.length) throw controlError(404, "runtime_unknown", "No active runtime matches the chosen engines.", { engines: params.engines });
      const pulled = [], present = [], skipped = [];
      for (const row of wanted) {
        if (row.present === true) { present.push(row.runtimeId); io.line(`${row.runtimeId}: already present`); continue; }
        if (row.localBuild) { skipped.push({ runtimeId: row.runtimeId, reason: "local_build" }); io.line(`${row.runtimeId}: local build, rebuild it manually`); continue; }
        const manager = MANAGER_OF[String(row.engineId || "").toLowerCase().replace(/[^a-z].*$/, "")] || "vllm-manager";
        await runFixExecutor("pull-image", { id: `pull-image:${row.runtimeId}`, runtimeId: row.runtimeId, engineId: row.engineId, managerId: manager, risk: "confirm" }, io);
        pulled.push(row.runtimeId);
        io.progress((pulled.length + present.length) / wanted.length);
      }
      return { pulled, present, skipped };
    },

    async tts(_params, io) {
      io.line("install-tts-gateway.cmd");
      await execute(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "install-tts-gateway.cmd"], { cwd: aiRoot, timeout: 30 * 60 * 1000 });
      return { installed: true };
    },

    async exposure(params, io) {
      const write = options.writeConfig || require("./config").writePlatformConfig;
      const lan = params.mode === "lan";
      const saved = await write({ aiRoot, env, actor: "setup", set: { "listeners.admin.lan": lan } });
      if (saved?.ok === false) throw controlError(400, saved.error?.code || saved.code || "config_invalid", "The access scope was not saved.");
      io.line(`listeners.admin.lan: ${lan}`);
      if (!lan) return { mode: "local" };
      // LAN needs a key: verify, and put the setting back when it is not met.
      const report = await doctor({ ids: ["sec.lan-keys", "net.firewall"], config: undefined });
      const keys = report.checks.find((check) => check.id === "sec.lan-keys");
      if (keys && keys.status === "fail") {
        await write({ aiRoot, env, actor: "setup", set: { "listeners.admin.lan": false } });
        throw controlError(409, "lan_requires_key", "LAN access needs an active API key; it was not enabled.", { fix: fixInfo(keys) });
      }
      const firewall = report.checks.find((check) => check.id === "net.firewall");
      return { mode: "lan", restartRequired: saved?.restartRequired || ["entry"], firewall: fixInfo(firewall) };
    },

    async ops() { return { commands: opsCommands({ aiRoot }).map((command) => command.display), registered: false }; },

    async start(_params, io) {
      if (!supervisor) throw controlError(503, "supervisor_unavailable", "Starting the platform needs a running supervisor.");
      io.line("platform start core");
      await supervisor.startProfile("core");
      return { profile: "core", console: "/" };
    },

    async "first-model"() { return { handoff: "console:deploy", path: "/#/deploy" }; },
  };

  async function executePlan(plan, io = {}) {
    const sink = { line: io.line || (() => {}), progress: io.progress || (() => {}) };
    if (plan.step === "all") {
      skipAll(aiRoot, { fs: fsImpl, now });
      sink.line("setup: skipped");
      return { step: "all", state: "skipped" };
    }
    if (plan.params.mark) {
      recordStep(aiRoot, plan.step, plan.params.mark, { fs: fsImpl, now });
      sink.line(`${plan.step}: ${plan.params.mark}`);
      return { step: plan.step, state: plan.params.mark };
    }
    let result;
    try {
      result = await actions[plan.step](plan.params, sink);
    } catch (error) {
      if (plan.step !== "ops") { try { recordStep(aiRoot, plan.step, "failed", { fs: fsImpl, now }); } catch {} }
      throw error;
    }
    // `ops` only shows commands, `first-model` is a hand-off: neither is "done" by running.
    if (plan.step !== "ops" && plan.step !== "first-model") recordStep(aiRoot, plan.step, "done", { fs: fsImpl, now });
    return { step: plan.step, state: plan.step === "ops" || plan.step === "first-model" ? "shown" : "done", result };
  }

  return { prepare, execute: executePlan, runStep: async (step, body, io) => executePlan(await prepare(step, body), io) };
}

function runSetupStep(step, body, options = {}) {
  return createSetupRunner(options).runStep(step, body, { line: options.line, progress: options.progress });
}

module.exports = { STEPS, STEP_IDS, ENGINES, DEFAULT_ENGINES, describeSetup, createSetupRunner, runSetupStep, readSetupState, recordStep, skipAll, opsCommands, setupFile };
