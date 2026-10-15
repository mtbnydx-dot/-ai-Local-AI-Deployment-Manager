"use strict";

// Doctor fix runner (06 §7.3). runFix(body, options) is what the supervisor's
// POST /v1/doctor/fix and `platform doctor --fix` call.
//
// Rules, enforced in prepare() before anything runs:
//   - manual fixes are never executed; the error carries the command and docs;
//   - confirm fixes need confirm:true / --yes or an interactive yes (options.prompt);
//   - auto fixes run directly.
// Fixes that touch a running component go through the supervisor (restart with
// when:"idle", or the idle gate of withStoppedComponent). Image pulls go only
// through the owning manager's POST /api/runtimes/:runtimeId/pull; this file
// never runs `docker pull`, and no fix touches a model container.
const nodeFs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const childProcess = require("node:child_process");
const doctorApi = require("./doctor");
const componentsApi = require("./components");
const { controlError } = require("./control");
const { createWinproc } = require("./winproc");
const secretStoreApi = require("../secret-store");
const { createDockerHostConfig } = require("../engines/hosts/docker");
const { createDefaultProbes, hashBuildInputs } = require("./doctor-probes");
const platformMcpHook = require("./hooks/platform-mcp");

const RISKS = new Set(["auto", "confirm", "manual"]);
const TERMINAL_JOB = new Set(["success", "failed", "cancelled", "interrupted"]);
const ROTATED_LOG = /\.\d+\.log$/;
const ROTATED_LOG_DAYS = 14;
const RUNNING_STATES = new Set(["starting", "ready", "unhealthy"]);
const LEGACY_NAMESPACES = { "vllm-manager": "runtime.vllm", "llama-manager": "runtime.llama" };

function stateMs(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value.getTime() : Number(value ?? Date.now());
}

// Every fix a check offers: its primary fix plus the per-row fixes in data.
function collectFixes(check) {
  const found = new Map();
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || depth > 4) return;
    if (typeof value.id === "string" && RISKS.has(value.risk) && value.label) { if (!found.has(value.id)) found.set(value.id, value); return; }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(check.fix, 0);
  visit(check.data, 0);
  return [...found.values()];
}

function fixKind(fix) { return String(fix.id).split(":")[0]; }

function createFixRunner(options = {}) {
  const env = options.env || process.env;
  const aiRoot = path.resolve(options.aiRoot || env.AI_ROOT || path.join(__dirname, "../.."));
  const fsImpl = options.fs || nodeFs;
  const execFile = options.execFile || childProcess.execFile;
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || Date.now;
  const supervisor = options.supervisor || null;
  const platform = options.platform || process.platform;
  const winproc = options.winproc || createWinproc({ execFile, platform });
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const execute = (command, args, extra = {}) => new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...extra }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr || "") })) : resolve(String(stdout || ""))));
  });

  // A text-only redactor (the supervisor log redactor) cannot redact a report.
  const doctorOptions = () => ({ ...options, aiRoot, env, platform, supervisor: undefined, redactor: typeof options.redactor?.redactValue === "function" ? options.redactor : undefined });

  async function loadConfig() { return options.config || require("./config").loadPlatformConfig({ aiRoot, env }); }

  // ---- helpers shared by executors --------------------------------------------------------------

  function managerFor(engineId, hint) {
    if (hint) return hint;
    return /^llama/i.test(String(engineId || "")) ? "llama-manager" : "vllm-manager";
  }

  async function managerUrl(componentId) {
    if (typeof options.managerUrl === "function") return options.managerUrl(componentId);
    const config = await loadConfig();
    const registry = options.registry || componentsApi.loadComponentRegistry({ aiRoot, config });
    const spec = registry.components.find((item) => item.id === componentId);
    if (!spec) throw controlError(404, "component_unknown", `Unknown component ${componentId}.`);
    return componentsApi.resolveComponent(spec, { aiRoot, config }).urls?.api;
  }

  async function requestJson(method, url, body, timeoutMs = 5000) {
    const response = await fetchImpl(url, { method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, json };
  }

  async function managerAlive(url) {
    try { return (await requestJson("GET", `${url}/api/manager/health`, null, 1500)).status === 200; } catch { return false; }
  }

  // The idle gate for a fix that has to stop a running component: no work is
  // done while the platform is busy, exactly like restart(when:"now").
  async function withStoppedComponent(componentId, work, io) {
    if (!supervisor) throw controlError(503, "supervisor_unavailable", "This fix needs a running supervisor.");
    const described = await supervisor.describeComponent(componentId);
    const running = RUNNING_STATES.has(described?.component?.state);
    if (running) {
      const gate = await supervisor.idle();
      if (!gate.idle) throw controlError(409, "component_busy", "The platform is busy; run this fix when it is idle.", { blockers: gate.blockers });
      io.line(`${componentId}: stopping`);
      await supervisor.stopComponent(componentId, { wait: true });
    }
    try {
      return await work();
    } finally {
      if (running) {
        io.line(`${componentId}: starting`);
        await supervisor.startComponent(componentId, { wait: true });
      }
    }
  }

  // ---- executors (keyed by the fix id before ":") ----------------------------------------------

  const executors = {
    async mkdirs(_ctx, io) {
      for (const name of ["config", "logs", ".runtime"]) {
        await fsp.mkdir(path.join(aiRoot, name), { recursive: true });
        io.line(`${name}: ready`);
      }
      return { created: ["config", "logs", ".runtime"] };
    },

    async "secure-secret-files"(_ctx, io) {
      const secure = options.secureFile || secretStoreApi.secureSecretFile;
      const directory = secretStoreApi.secretsDirectory(aiRoot);
      let files = [];
      try { files = fsImpl.readdirSync(directory).filter((name) => name.endsWith(".json")); } catch {}
      await secure(directory, { directory: true });
      for (const name of files) { await secure(path.join(directory, name), { directory: false }); io.line(`${name}: owner-only`); }
      return { secured: files.length };
    },

    async "prune-rotated-logs"(_ctx, io) {
      const cutoff = stateMs(now) - ROTATED_LOG_DAYS * 86400000;
      let deleted = 0, bytes = 0;
      const stack = [path.join(aiRoot, "logs")];
      while (stack.length) {
        const directory = stack.pop();
        let entries = [];
        try { entries = fsImpl.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          const full = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { stack.push(full); continue; }
          if (!entry.isFile() || !ROTATED_LOG.test(entry.name)) continue;
          const stat = fsImpl.statSync(full);
          if (stat.mtimeMs >= cutoff) continue;
          fsImpl.unlinkSync(full);
          deleted += 1;
          bytes += stat.size;
        }
      }
      io.line(`deleted ${deleted} rotated log file(s)`);
      return { deleted, bytes };
    },

    // Image pull: only through the hosting manager's endpoint (01 ENG-11), the
    // same one the console's Pull button uses. A stopped manager is started
    // first; the confirmation already covers that.
    async "pull-image"({ fix }, io) {
      const runtimeId = String(fix.runtimeId || fix.id.slice(fix.id.indexOf(":") + 1));
      const managerId = managerFor(fix.engineId, fix.managerId);
      let url = await managerUrl(managerId);
      if (!url) throw controlError(404, "manager_url_unknown", `${managerId} has no API address.`);
      if (!(await managerAlive(url))) {
        if (!supervisor) throw controlError(503, "manager_unavailable", `${managerId} is not running and no supervisor can start it.`);
        io.line(`${managerId}: starting`);
        await supervisor.startComponent(managerId, { wait: true });
        url = await managerUrl(managerId);
      }
      io.line(`${managerId}: POST /api/runtimes/${runtimeId}/pull`);
      const started = await requestJson("POST", `${url}/api/runtimes/${encodeURIComponent(runtimeId)}/pull`, { confirm: true }, 15000);
      if (started.status < 200 || started.status >= 300 || !started.json?.job?.id) {
        const code = started.json?.error?.code || started.json?.code || (typeof started.json?.error === "string" ? started.json.error : "pull_rejected");
        throw controlError(started.status >= 400 ? started.status : 502, String(code), `The manager refused the pull (HTTP ${started.status}).`);
      }
      const jobId = String(started.json.job.id);
      io.line(`${jobId}: ${started.json.existing ? "joined the running pull" : "pull started"}`);
      const deadline = stateMs(now) + (Number(options.pullTimeoutMs) || 30 * 60 * 1000);
      let lastLine = "";
      for (;;) {
        const polled = await requestJson("GET", `${url}/api/jobs/${encodeURIComponent(jobId)}`, null, 5000);
        const job = polled.json || started.json.job;
        const progress = Number(job.progress);
        if (Number.isFinite(progress)) io.progress(progress > 1 ? Math.min(progress / 100, 1) : progress);
        const text = `${jobId}: ${job.status}${Number.isFinite(progress) ? ` ${progress > 1 ? progress : Math.round(progress * 100)}%` : ""}${Array.isArray(job.logs) && job.logs.length ? ` - ${String(job.logs.at(-1)?.message ?? job.logs.at(-1)).slice(0, 160)}` : ""}`;
        if (text !== lastLine) { io.line(text); lastLine = text; }
        if (TERMINAL_JOB.has(job.status)) {
          if (job.status !== "success") throw controlError(502, "pull_failed", `The image pull ended as ${job.status}.`, { jobId, status: job.status });
          return { runtimeId, jobId, status: job.status };
        }
        if (stateMs(now) > deadline) throw controlError(504, "pull_timeout", "The image pull did not finish in time; it keeps running in the manager.", { jobId });
        await sleep(Number(options.pollMs) || 1000);
      }
    },

    // restart:<componentId> - always when:"idle" so a busy manager queues the restart.
    async restart({ fix }, io) {
      if (!supervisor) throw controlError(503, "supervisor_unavailable", "This fix needs a running supervisor.");
      const componentId = String(fix.componentId || fix.id.slice(fix.id.indexOf(":") + 1));
      const result = await supervisor.restart([componentId], { when: "idle", reason: "doctor", wait: true });
      if (result.queued) { io.line(`${componentId}: queued until the platform is idle`); return { queued: result.queued, blockers: result.blockers || [] }; }
      io.line(`${componentId}: restarted`);
      return { restarted: [componentId] };
    },

    // stop-orphan[:port] - identity-checked kills only; a mismatch kills nothing.
    async "stop-orphan"({ fix }, io) {
      const targets = fix.targets || (fix.target ? [fix.target] : []);
      const stopped = [], refused = [];
      for (const target of targets) {
        const result = await winproc.killTree(target.pid, { identity: { pid: target.pid, processCreatedAt: target.processCreatedAt, exe: target.exe } });
        (result.ok ? stopped : refused).push({ pid: target.pid, reason: result.reason });
        io.line(`pid ${target.pid}: ${result.ok ? "stopped" : result.reason}`);
      }
      return { stopped, refused };
    },

    async "start-docker"(_ctx, io) {
      const config = await loadConfig();
      const candidate = path.join(env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe");
      const host = createDockerHostConfig(env, { values: { wslDistro: config.values?.["docker.wslDistro"] || "", desktopExe: config.values?.["docker.desktopExe"] || "" }, sources: {} }, { aiRoot, desktopExeCandidates: [candidate] });
      if (!host.dockerDesktopExe) throw controlError(404, "docker_desktop_not_found", "Docker Desktop was not found.");
      const spawn = options.spawn || childProcess.spawn;
      io.line("starting Docker Desktop");
      const child = spawn(host.dockerDesktopExe, [], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref?.();
      const probes = options.dockerProbes || createDefaultProbes({ aiRoot, env, platform, value: (key, fallback) => config.values?.[key] ?? fallback }, { execFile });
      const deadline = stateMs(now) + (Number(config.values?.["docker.waitTimeoutSec"]) || 120) * 1000;
      for (;;) {
        try { await probes.dockerDaemon(); io.line("Docker engine is responding"); return { ready: true }; } catch {}
        if (stateMs(now) > deadline) throw controlError(504, "docker_wait_timeout", "Docker did not become ready in time.");
        await sleep(Number(options.pollMs) || 2000);
      }
    },

    async "install-download-cli"(_ctx, io) {
      io.line("running install-download-cli.ps1");
      await execute(env.POWERSHELL_EXE || "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(aiRoot, "scripts", "install-download-cli.ps1")], { cwd: aiRoot, timeout: 10 * 60 * 1000 });
      return { installed: true };
    },

    async "mcp-build"(_ctx, io) {
      const config = await loadConfig();
      const registry = options.registry || componentsApi.loadComponentRegistry({ aiRoot, config });
      const pkg = (registry.packages || []).find((item) => item.dir === "platform-mcp" && item.build);
      if (!pkg) throw controlError(404, "build_unknown", "platform-mcp declares no build.");
      const directory = path.join(aiRoot, pkg.dir);
      return withStoppedComponent("platform-mcp", async () => {
        io.line("npm run build");
        await execute(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build"], { cwd: directory, timeout: 10 * 60 * 1000 });
        const stamp = { srcSha256: hashBuildInputs(directory, pkg.build.inputs), builtAt: new Date(stateMs(now)).toISOString(), node: process.version };
        const file = path.join(directory, pkg.build.stamp);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, `${JSON.stringify(stamp, null, 2)}\n`);
        return { built: true, srcSha256: stamp.srcSha256 };
      }, io);
    },

    // npm-ci is the staged node_modules swap of 06 §9.3 (OPS-11a). Until that
    // module is injected the fix reports itself unavailable instead of guessing.
    async "npm-ci"() {
      throw controlError(501, "fix_unavailable", "The staged dependency install is provided by the deploy post-steps; run `npm ci` through them.");
    },

    // Runtime key files (06 §4.5) go through importLegacy, which reads back
    // before it replaces the file with the stub; the MCP key goes through the hook.
    async "secrets-migrate"({ check }, io) {
      const result = { migrated: [], failed: [] };
      for (const file of (check.data?.files || []).filter((item) => item.migratable)) {
        const full = path.join(aiRoot, file.path);
        try {
          if (file.kind === "runtime-keys") {
            const owner = file.path.split("/")[0];
            const namespace = LEGACY_NAMESPACES[owner] || `runtime.legacy-${require("node:crypto").createHash("sha256").update(file.path).digest("hex").slice(0, 8)}`;
            await secretStoreApi.createSecretStore({ aiRoot, namespace }).importLegacy({ file: full });
          } else if (file.kind === "env-file-key") {
            const stores = new Map();
            const store = (namespace) => { if (!stores.has(namespace)) stores.set(namespace, secretStoreApi.createSecretStore({ aiRoot, namespace })); return stores.get(namespace); };
            const vault = { get: (namespace, name) => store(namespace).get(name), set: (namespace, name, value) => store(namespace).set(name, value) };
            for (const namespace of ["platform"]) await store(namespace).load();
            const prepared = await platformMcpHook.prepare({ aiRoot, secrets: vault });
            if (prepared.blocked) throw Object.assign(new Error("MCP key migration was blocked."), { code: prepared.blocked.reason });
          } else continue;
          result.migrated.push(file.path);
          io.line(`${file.path}: migrated`);
        } catch (error) {
          result.failed.push({ path: file.path, code: String(error?.code || "migrate_failed") });
          io.line(`${file.path}: ${String(error?.code || "migrate_failed")}`);
        }
      }
      if (result.failed.length) throw controlError(500, "secrets_migrate_failed", `${result.failed.length} file(s) could not be migrated; they were left unchanged.`, result);
      return result;
    },
  };
  Object.assign(executors, options.executors || {});

  // ---- prepare / execute / run ------------------------------------------------------------------

  async function prepare(body = {}) {
    const checkId = String(body.checkId || "");
    if (!/^[a-z]+\.[A-Za-z0-9.*_-]+$/.test(checkId)) throw controlError(400, "invalid_check", "checkId is required.");
    const report = await (options.runDoctor || doctorApi.runDoctor)({ ...doctorOptions(), ids: [checkId], groups: undefined });
    const check = report.checks.find((item) => item.id === checkId);
    if (!check) throw controlError(404, "check_unknown", `Unknown check ${checkId}.`);
    const fixes = collectFixes(check);
    const fixId = body.fixId === undefined || body.fixId === null ? check.fix?.id : String(body.fixId);
    const fix = fixes.find((item) => item.id === fixId);
    if (!fix) throw controlError(404, "fix_unknown", `${checkId} offers no fix ${fixId || ""}.`.trim(), { available: fixes.map((item) => item.id) });
    if (fix.risk === "manual") {
      throw controlError(400, "fix_manual_only", "This fix is manual; the platform never runs it.", { command: fix.command || null, docs: fix.docs || null, label: fix.label });
    }
    if (fix.risk === "confirm") {
      const confirmed = body.confirm === true || body.yes === true || (typeof options.prompt === "function" && (await options.prompt(fix, check)) === true);
      if (!confirmed) throw controlError(400, "confirm_required", "This fix needs confirmation (confirm:true, --yes or an interactive yes).", { fixId: fix.id, label: fix.label });
    }
    const executor = executors[fixKind(fix)];
    if (typeof executor !== "function") throw controlError(501, "fix_unavailable", `No executor exists for fix ${fix.id}.`);
    return { checkId, check, fix, executor };
  }

  async function executePlan(plan, io = {}) {
    const lines = [];
    const sink = { line: io.line || ((text) => lines.push(String(text))), progress: io.progress || (() => {}) };
    const result = await plan.executor({ fix: plan.fix, check: plan.check }, sink);
    return { checkId: plan.checkId, fixId: plan.fix.id, ...(result && typeof result === "object" ? { result } : {}) };
  }

  return { prepare, execute: executePlan, runFix: async (body, io) => executePlan(await prepare(body), io), collectFixes, executors };
}

function runFix(body, options = {}) {
  return createFixRunner(options).runFix(body, { line: options.line, progress: options.progress });
}

module.exports = { createFixRunner, runFix, collectFixes };
