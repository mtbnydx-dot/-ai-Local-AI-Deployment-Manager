"use strict";

// Read-only external probes for the network, security and ops checks (06 §7.2).
// createDefaultProbes merges these into the 9a probe set. Tests inject their
// own probes or execFile, so nothing here needs a real Windows host. Nothing
// here repairs, kills or registers anything; the deep search probe is the only
// one that enters a container and it only opens a TCP socket.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const componentsApi = require("./components");
const { controlEndpoint } = require("./control");
const { createWinproc } = require("./winproc");
const schedules = require("./schedules");
const versionApi = require("./version");
const secretStoreApi = require("../secret-store");

const SEARCH_CONTAINER = "local-ai-search-gateway";
const WIDE_PRINCIPALS = /(?:^|[\\\s(])(?:Everyone|Users|Authenticated Users|INTERACTIVE|NETWORK)(?::|\s|$)|\*S-1-1-0|\*S-1-5-32-545|\*S-1-5-11/i;
const LOGS_SCAN_LIMIT = 200000;
const SCAN_DIRS = ["", "config", "vllm-manager", "llama-manager", "service-entry", "platform-mcp", "search-gateway", ".runtime/platform-mcp"];
const SEARCH_PROBE_SCRIPT = "const s=require('net').connect({host:process.argv[1],port:Number(process.argv[2]),timeout:2000});s.on('connect',()=>{process.stdout.write('ok');s.destroy()});s.on('error',()=>process.exit(2));s.on('timeout',()=>process.exit(3))";

// PowerShell 5.1 serializes DateTime as "\/Date(ms)\/"; 7 as ISO text.
function dateIso(value) {
  if (!value) return null;
  const legacy = /\/Date\((-?\d+)/.exec(String(value));
  const time = legacy ? Number(legacy[1]) : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function asList(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function names(directory) { try { return fs.readdirSync(directory); } catch { return []; } }
function readJsonSafe(file) {
  try { return JSON.parse(String(fs.readFileSync(file, "utf8")).replace(/^﻿/, "")); } catch { return null; }
}

function directorySize(root, limit = LOGS_SCAN_LIMIT) {
  let bytes = 0, files = 0, truncated = false;
  const stack = [root];
  while (stack.length && !truncated) {
    const directory = stack.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      files += 1;
      if (files > limit) { truncated = true; break; }
      try { bytes += fs.statSync(full).size; } catch {}
    }
  }
  return { bytes, files, truncated };
}

function aclWide(text) {
  return String(text || "").split(/\r?\n/).some((line) => WIDE_PRINCIPALS.test(line));
}

function createOpsProbes(ctx, { execute, docker, windowsFacts, execFile, options = {} }) {
  const { aiRoot, env, platform } = ctx;
  const winproc = createWinproc({ execFile, platform, powershellExe: env.POWERSHELL_EXE || "powershell.exe" });
  const facts = () => (ctx.probe ? ctx.probe("windowsFacts") : windowsFacts());

  async function scanPlaintext() {
    const found = [];
    const add = (relative, kind, migratable) => found.push({ path: relative.split(path.sep).join("/"), kind, migratable });
    for (const directory of SCAN_DIRS) {
      const base = path.join(aiRoot, directory), logs = path.join(base, "logs");
      const rel = (...parts) => path.join(directory, ...parts);
      if (fs.existsSync(path.join(logs, ".last-public-service-key.txt"))) add(rel("logs", ".last-public-service-key.txt"), "public-service-key", false);
      if (fs.existsSync(path.join(logs, "audit-admin-password.txt"))) add(rel("logs", "audit-admin-password.txt"), "audit-admin-password", false);
      for (const name of ["runtime-api-keys.json", "runtime-secrets.json"]) {
        const body = readJsonSafe(path.join(logs, name));
        if (body && !body.migratedTo && Object.keys(body.secrets || {}).length) add(rel("logs", name), "runtime-keys", true);
      }
      try {
        const text = fs.readFileSync(path.join(base, "server.env"), "utf8");
        if (/^\s*[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/im.test(text)) add(rel("server.env"), "env-file-key", directory === ".runtime/platform-mcp");
      } catch {}
      for (const [folder, parts] of [[base, []], [logs, ["logs"]]]) {
        for (const name of names(folder)) {
          if (/-secrets\.json$/i.test(name) && name !== "runtime-secrets.json") add(rel(...parts, name), "secrets-file", false);
        }
      }
    }
    return found;
  }

  async function secretStores() {
    const directory = secretStoreApi.secretsDirectory(aiRoot);
    const rows = [];
    for (const name of names(directory).filter((entry) => entry.endsWith(".json")).sort()) {
      const file = path.join(directory, name), namespace = name.slice(0, -5);
      const row = { namespace, file: path.relative(aiRoot, file).split(path.sep).join("/"), protection: null, entries: 0, parse: "ok", unprotect: "skipped", acl: { checked: false, wide: false } };
      try {
        const body = JSON.parse(String(fs.readFileSync(file, "utf8")).replace(/^﻿/, ""));
        row.protection = body.protection || null;
        row.entries = Object.keys(body.entries || {}).length;
      } catch { row.parse = "error"; }
      if (row.parse === "ok" && row.entries) {
        try { await secretStoreApi.createSecretStore({ aiRoot, namespace }).load(); row.unprotect = "ok"; } catch (error) { row.unprotect = "error"; row.code = String(error?.code || "unprotect_failed"); }
      }
      try {
        if (platform === "win32") row.acl = { checked: true, wide: aclWide(await execute("icacls.exe", [file])) };
        else row.acl = { checked: true, wide: (fs.statSync(file).mode & 0o077) !== 0 };
      } catch { row.acl = { checked: false, wide: false }; }
      rows.push(row);
    }
    return rows;
  }

  return {
    resolvedComponents() {
      return (ctx.registry?.components || []).map((spec) => {
        const base = { id: spec.id, parent: spec.parent || null, detectOnly: Boolean(spec.detectOnly), deprecated: Boolean(spec.deprecated) };
        try {
          const resolved = componentsApi.resolveComponent(spec, { aiRoot, config: ctx.config });
          return { ...base, kind: resolved.kind, disabled: Boolean(spec.disabled), cwd: resolved.cwd || null, command: resolved.command || null, args: resolved.args || [], ports: (resolved.ports || []).map((port) => ({ name: port.name, port: Number(port.port), bind: port.bind, enabled: port.enabled !== false })) };
        } catch {
          return { ...base, kind: spec.kind, disabled: true, unresolved: true, cwd: null, command: null, args: [], ports: [] };
        }
      });
    },
    listeners: () => winproc.listListeners(),
    imageNames: (pids) => winproc.imageNames(pids),
    async processes() {
      const data = await facts();
      return asList(data.processes).map((row) => ({ pid: Number(row.ProcessId ?? row.pid), exe: String(row.ExecutablePath ?? row.exe ?? ""), commandLine: String(row.CommandLine ?? row.commandLine ?? ""), processCreatedAt: dateIso(row.CreationDate ?? row.processCreatedAt) })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
    },
    identityRecords() {
      const directory = path.join(aiRoot, ".runtime", "platform", "state");
      return names(directory).filter((name) => name.endsWith(".json")).map((name) => readJsonSafe(path.join(directory, name))).filter((row) => row && row.id && Number.isInteger(row.pid)).map((row) => ({ id: row.id, pid: row.pid, processCreatedAt: row.processCreatedAt || null, exe: row.exe || "" }));
    },
    supervisor() {
      const endpoint = controlEndpoint(aiRoot, { platform });
      return new Promise((resolve) => {
        const socket = net.connect(endpoint);
        const done = (running) => { socket.destroy(); resolve({ running, endpoint: path.basename(endpoint) }); };
        socket.setTimeout(800, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
      });
    },
    async tasks() {
      return asList((await facts()).tasks).map((task) => ({ name: task.TaskName, state: String(task.State ?? ""), actions: asList(task.Actions).map((action) => ({ execute: action.Execute || "", arguments: action.Arguments || "" })), lastRunTime: dateIso(task.LastRunTime), lastResult: task.LastTaskResult ?? null, nextRunTime: dateIso(task.NextRunTime) }));
    },
    async runKeys() { return Object.assign({}, ...asList((await facts()).runKeys).map((entry) => entry || {})); },
    async firewall() {
      return asList((await facts()).firewall).map((rule) => ({ name: rule.Name, profile: String(rule.Profile ?? ""), protocol: String(rule.Protocol ?? ""), localPort: String(rule.LocalPort ?? ""), program: String(rule.Program ?? "") }));
    },
    async userEnvNames() { return asList((await facts()).userEnvNames).map(String); },
    nightly: () => schedules.readNightly(aiRoot, { now: ctx.now }),
    backup: () => schedules.readBackup(aiRoot, { now: ctx.now }),
    drift: () => versionApi.computeLiveDrift(aiRoot),
    version: () => versionApi.readVersion(aiRoot),
    newerCommits: () => versionApi.countNewerCommits(aiRoot, { branch: ctx.value?.("updates.branch", "main"), fetch: options.fetchUpdates === true }),
    logsSize: () => directorySize(path.join(aiRoot, "logs")),
    secretStores,
    plaintextSecrets: scanPlaintext,
    async secretNames() {
      const store = secretStoreApi.createSecretStore({ aiRoot, namespace: "platform" });
      await store.load();
      return store.list().map((item) => ({ namespace: "platform", name: item.name }));
    },
    async keySummary() {
      const file = path.join(aiRoot, "service-entry", "data", "platform-access.sqlite");
      if (!fs.existsSync(file)) return { available: true, active: 0, total: 0 };
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const rows = db.prepare("SELECT status, COUNT(*) AS n FROM api_keys GROUP BY status").all();
        return { available: true, active: Number(rows.find((row) => row.status === "active")?.n || 0), total: rows.reduce((sum, row) => sum + Number(row.n), 0) };
      } finally { db.close(); }
    },
    async searchUpstream({ host, port }) {
      if (host !== "host.docker.internal" || !Number.isInteger(Number(port))) throw Object.assign(new Error("Unsafe search upstream probe."), { code: "unsafe_search_probe" });
      try {
        await docker(["exec", SEARCH_CONTAINER, "node", "-e", SEARCH_PROBE_SCRIPT, host, String(port)], { timeout: 6000 });
        return { reachable: true };
      } catch (error) {
        if (/no such container|is not running/i.test(`${error.message} ${error.stderr || ""}`)) return { reachable: null, reason: "container_not_running" };
        if (["ENOENT", "ENOTDIR"].includes(error.code)) return { reachable: null, reason: "docker_unavailable" };
        return { reachable: false };
      }
    },
  };
}

module.exports = { createOpsProbes, aclWide, dateIso, SEARCH_CONTAINER };
