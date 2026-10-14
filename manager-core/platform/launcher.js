"use strict";

// Spawn and stop mechanics only (06 §5.1, §5.6). Ordering, readiness, restarts
// and desired state belong to the supervisor. Tests inject all process I/O.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const winprocDefault = require("./winproc");
const logFiles = require("./logs");
const { createSecretRedactor } = require("../secret-redactor");
const { allSecretValues } = require("../secret-store");
const { createInternalClient } = require("../internal-auth");

function failure(code, extra = {}) { return { ok: false, code, ...extra }; }

function createLauncher(options = {}) {
  const aiRoot = path.resolve(options.aiRoot || path.join(__dirname, "../.."));
  const stateDir = path.join(aiRoot, ".runtime", "platform", "state");
  const spawn = options.spawn || childProcess.spawn;
  const run = promisify(options.execFile || childProcess.execFile);
  const winproc = options.winproc || winprocDefault;
  const logs = options.logs || logFiles;
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = Math.max(1, Number(options.pollMs) || 100);
  const redactor = options.redactor || createSecretRedactor({ getSecrets: options.getSecrets || (() => allSecretValues(aiRoot)) });

  function identityFile(id) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(String(id || ""))) throw Object.assign(new Error("Invalid component id."), { code: "invalid_component_id" });
    return path.join(stateDir, `${id}.json`);
  }
  function operation(id, message) {
    if (typeof options.appendLog === "function") options.appendLog({ at: new Date(now()).toISOString(), id, message: redactor.redact(String(message)) });
  }
  function readIdentity(id) {
    try { return JSON.parse(fs.readFileSync(identityFile(id), "utf8").replace(/^\uFEFF/, "")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function writeIdentity(record) {
    const file = identityFile(record.id);
    fs.mkdirSync(stateDir, { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(redactor.redactValue(record), null, 2)}\n`, { flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return record;
  }
  async function verifyIdentity(record) {
    if (!record || !Number.isInteger(record.pid) || record.pid < 1) return { ok: false, state: "unknown", reason: "identity-mismatch" };
    const current = await winproc.processInfo(record.pid);
    if (!current) return { ok: true, stopped: true, reason: "vanished" };
    return winprocDefault.matchesIdentity(record, current)
      ? { ok: true, stopped: false, current }
      : { ok: false, state: "unknown", reason: "identity-mismatch" };
  }

  async function execute(argv, component) {
    if (!Array.isArray(argv) || !argv.length || argv.some((value) => typeof value !== "string")) throw new Error("Invalid process command.");
    if (redactor.redact(argv.join(" ")) !== argv.join(" ")) throw Object.assign(new Error("A secret cannot be passed in process arguments."), { code: "secret_in_argv" });
    return run(argv[0], argv.slice(1), { cwd: component.cwd || aiRoot, env: component.env || process.env, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  }
  function composeCommand(component, action) {
    const docker = Array.isArray(options.dockerCommand) ? options.dockerCommand : [options.dockerExe || "docker"];
    if (component.stop?.container && action !== "up") return [...docker, "stop", component.stop.container];
    if (!component.compose?.file) throw new Error("A compose file is required.");
    return [...docker, "compose", "-f", component.compose.file, ...(component.compose.project ? ["-p", component.compose.project] : []), action, ...(action === "up" ? ["-d"] : [])];
  }

  async function start(component, startOptions = {}) {
    identityFile(component.id);
    if (component.detectOnly || component.kind === "external" || component.kind === "listener") return failure("detect_only_component");
    if (component.blocked) return failure("component_blocked", { blocked: component.blocked });
    if (component.kind === "compose") {
      await execute(composeCommand(component, "up"), component);
      return { ok: true, id: component.id, kind: "compose" };
    }
    const command = component.command || component.argv?.[0];
    const args = component.args || component.argv?.slice(1) || [];
    if (typeof command !== "string" || !command || !Array.isArray(args) || args.some((value) => typeof value !== "string")) return failure("invalid_command");
    if (redactor.redact([command, ...args].join(" ")) !== [command, ...args].join(" ")) return failure("secret_in_argv");
    const previous = readIdentity(component.id);
    if (previous) {
      const verified = await verifyIdentity(previous);
      if (!verified.ok) return failure("identity_mismatch", verified);
      if (!verified.stopped) return { ok: true, existing: true, identity: previous };
    }
    const directory = component.logDir || path.join(aiRoot, "logs", component.id);
    logs.rotateOnStart(directory, component.id, startOptions.keep ?? options.keep ?? 5);
    const files = component.logs || { out: path.join(directory, `${component.id}.out.log`), err: path.join(directory, `${component.id}.err.log`) };
    const descriptors = [];
    let child;
    try {
      for (const file of [files.out, files.err]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        descriptors.push(fs.openSync(file, "a"));
      }
      child = spawn(command, args, { cwd: component.cwd || aiRoot, env: component.env || process.env, detached: true, windowsHide: true, stdio: ["ignore", ...descriptors] });
      await once(child, "spawn");
      child.unref?.();
    } finally { descriptors.forEach((fd) => fs.closeSync(fd)); }
    const startedAt = new Date(now()).toISOString();
    let info = null;
    const deadline = now() + (Number(startOptions.identityTimeoutMs) || 2000);
    do {
      info = await winproc.processInfo(child.pid);
      if (info?.processCreatedAt && info.exe) break;
      if (now() >= deadline) break;
      await sleep(pollMs);
    } while (true);
    if (!info?.processCreatedAt || !info.exe) return failure("process_identity_unavailable", { id: component.id, pid: child.pid, child });
    const record = {
      schemaVersion: 1, id: component.id, pid: child.pid,
      processCreatedAt: info.processCreatedAt, exe: info.exe, commandLine: redactor.redact(info.commandLine || ""),
      spawnedBy: startOptions.spawnedBy || "supervisor", startedAt,
      configHash: startOptions.configHash || crypto.createHash("sha256").update(JSON.stringify({ command, args, cwd: component.cwd, env: component.env })).digest("hex"),
      buildCommit: startOptions.buildCommit || options.buildCommit || null, logFiles: files,
    };
    writeIdentity(record);
    operation(component.id, "spawned");
    return { ok: true, child, identity: record };
  }

  async function waitForExit(record, graceSec) {
    const deadline = now() + Math.max(0, Number(graceSec) || 0) * 1000;
    while (true) {
      const verified = await verifyIdentity(record);
      if (!verified.ok || verified.stopped) return verified;
      if (now() >= deadline) return verified;
      await sleep(Math.min(pollMs, deadline - now()));
    }
  }
  async function requestShutdown(component, stop) {
    const requestOptions = { method: "POST", timeoutMs: 2000, auth: stop.auth, principal: "system:supervisor" };
    if (typeof options.requestStop === "function") return options.requestStop(stop.http, requestOptions);
    if (stop.auth === "system") {
      const target = new URL(stop.http);
      const client = options.entryClient || createInternalClient({ aiRoot, baseUrl: target.origin, principal: "system:supervisor", timeoutMs: 2000, fetchFn: options.fetchFn, readKey: options.readInternalKey });
      try { return await client.request("POST", `${target.pathname}${target.search}`); }
      catch (error) { if (error.code !== "internal_key_unavailable") throw error; }
      operation(component.id, "entry_shutdown_unsigned");
    }
    const response = await (options.fetchFn || fetch)(stop.http, { method: "POST", signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return { status: response.status, ok: response.ok };
  }
  async function stop(component, stopOptions = {}) {
    const strategy = component.stop?.strategy || "kill";
    if (component.detectOnly || component.kind === "external" || component.kind === "listener" || strategy === "never") return failure("detect_only_component");
    if (strategy === "compose") {
      if (stopOptions.explicit !== true) return failure("explicit_action_required");
      const action = component.stop?.action || "stop";
      if (!["stop", "down"].includes(action)) return failure("invalid_stop_strategy");
      await execute(composeCommand(component, action), component);
      operation(component.id, `compose ${action}`);
      return { ok: true, stopped: true, reason: "requested" };
    }
    if (!["http-then-kill", "script-then-kill", "kill"].includes(strategy)) return failure("invalid_stop_strategy");
    const record = stopOptions.identity || readIdentity(component.id);
    if (record && record.id !== component.id) return failure("identity_mismatch", { state: "unknown", reason: "identity-mismatch" });
    const verified = await verifyIdentity(record);
    if (!verified.ok || verified.stopped) return verified;
    if (strategy !== "kill") {
      try {
        if (strategy === "http-then-kill") await requestShutdown(component, component.stop);
        else await execute(component.stop.script, component);
      } catch (error) { operation(component.id, `${strategy} failed: ${error.message}`); }
      const waited = await waitForExit(record, component.stop.graceSec ?? 15);
      if (!waited.ok || waited.stopped) return waited.stopped ? { ...waited, reason: "requested" } : waited;
    }
    // Recheck after the grace period; winproc checks once more immediately
    // before taskkill so a recycled PID can never be targeted by a stale record.
    const fresh = await verifyIdentity(record);
    if (!fresh.ok || fresh.stopped) return fresh;
    const killed = await winproc.killTree(record.pid, { identity: record, tree: component.stop?.tree !== false, force: true });
    if (!killed.ok) return killed;
    operation(component.id, "killed-by-supervisor");
    return { ...killed, stopped: true, reason: "killed-by-supervisor" };
  }
  async function adopt(component, info, adoptionOptions = {}) {
    if (!info?.processCreatedAt || !info.exe || !Number.isInteger(info.pid)) return failure("process_identity_unavailable");
    const record = {
      schemaVersion: 1, id: component.id, pid: info.pid, processCreatedAt: info.processCreatedAt,
      exe: info.exe, commandLine: redactor.redact(info.commandLine || ""), spawnedBy: "adopted",
      startedAt: new Date(now()).toISOString(), configHash: adoptionOptions.configHash || null,
      buildCommit: adoptionOptions.buildCommit || options.buildCommit || null, logFiles: component.logs || {},
    };
    writeIdentity(record);
    return { ok: true, identity: record };
  }
  return { start, stop, adopt, readIdentity, writeIdentity, verifyIdentity };
}

module.exports = { createLauncher };
