"use strict";

// Windows process primitives (06 §5.6). Importing this module does no I/O;
// parsers and an injected execFile keep fixture tests independent of the host.
const childProcess = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

function validPid(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid < 1 || pid > 0xffffffff) throw Object.assign(new Error("Invalid process id."), { code: "invalid_pid" });
  return pid;
}

function splitEndpoint(value) {
  const match = /^(?:\[(.*)\]|(.*)):(\d+|\*)$/.exec(value);
  if (!match) return null;
  const port = match[3] === "*" ? 0 : Number(match[3]);
  if (port > 65535) return null;
  return { address: match[1] ?? match[2], port };
}

function parseNetstat(text) {
  const listeners = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const protocol = columns[0]?.toUpperCase();
    if (protocol !== "TCP" && protocol !== "UDP") continue;
    const local = splitEndpoint(columns[1] || "");
    const state = protocol === "TCP" ? columns[3] : "BOUND";
    const pid = Number(columns[protocol === "TCP" ? 4 : 3]);
    if (!local || !Number.isInteger(pid) || pid < 1) continue;
    // UDP sockets have no state column. Connected TCP sockets are not listeners.
    if (protocol === "TCP" && !/^(?:LISTENING|侦听|正在侦听|监听)$/i.test(state || "")) continue;
    listeners.push({ protocol: protocol.toLowerCase(), ...local, pid, state: protocol === "TCP" ? "LISTENING" : state });
  }
  return listeners;
}

function csvFields(line) {
  const fields = [];
  let value = "", quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { fields.push(value); value = ""; }
    else value += char;
  }
  fields.push(value);
  return fields;
}

function parseTasklist(text) {
  const processes = [];
  for (const line of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const fields = csvFields(line.trim());
    const pid = Number(fields[1]);
    if (fields.length < 2 || !fields[0] || !Number.isInteger(pid) || pid < 1) continue;
    processes.push({ pid, imageName: fields[0] });
  }
  return processes;
}

function parseCim(text) {
  const source = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!source) return [];
  const parsed = JSON.parse(source);
  if (parsed === null) return [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    const pid = Number(row.pid ?? row.ProcessId);
    if (!Number.isInteger(pid) || pid < 1) return null;
    const rawCreatedAt = row.processCreatedAt ?? row.CreationDate;
    const createdAt = Date.parse(rawCreatedAt);
    return {
      pid,
      processCreatedAt: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : null,
      exe: String(row.exe ?? row.ExecutablePath ?? ""),
      commandLine: String(row.commandLine ?? row.CommandLine ?? ""),
      parentPid: Number(row.parentPid ?? row.ParentProcessId) || 0,
    };
  }).filter(Boolean);
}

function matchesIdentity(identity, info) {
  if (!identity || !info || Number(identity.pid) !== Number(info.pid)) return false;
  const expectedTime = Date.parse(identity.processCreatedAt), actualTime = Date.parse(info.processCreatedAt);
  if (!Number.isFinite(expectedTime) || !Number.isFinite(actualTime) || Math.abs(expectedTime - actualTime) > 1000) return false;
  const expectedExe = path.win32.basename(String(identity.exe || "")).toLowerCase();
  return Boolean(expectedExe) && expectedExe === path.win32.basename(String(info.exe || "")).toLowerCase();
}

function createWinproc({ execFile = childProcess.execFile, platform = process.platform, powershellExe = "powershell.exe" } = {}) {
  const run = promisify(execFile);
  async function execute(command, args) {
    if (platform !== "win32") throw Object.assign(new Error("Windows process inspection is unavailable on this platform."), { code: "windows_only" });
    const result = await run(command, args, { windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    return typeof result === "string" ? result : result.stdout || "";
  }
  async function listListeners() { return parseNetstat(await execute("netstat.exe", ["-ano"])); }
  async function imageNames(pids) {
    const rows = parseTasklist(await execute("tasklist.exe", ["/FO", "CSV", "/NH"]));
    const selected = pids === undefined ? null : new Set((Array.isArray(pids) ? pids : [pids]).map(validPid));
    return Object.fromEntries(rows.filter((row) => !selected || selected.has(row.pid)).map((row) => [row.pid, row.imageName]));
  }
  async function processInfo(pids) {
    const scalar = !Array.isArray(pids);
    const selected = [...new Set((scalar ? [pids] : pids).map(validPid))];
    if (!selected.length) return [];
    const filter = selected.map((pid) => `ProcessId=${pid}`).join(" OR ");
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; processCreatedAt=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); exe=$_.ExecutablePath; commandLine=$_.CommandLine; parentPid=$_.ParentProcessId } }) | ConvertTo-Json -Compress`;
    const rows = parseCim(await execute(powershellExe, ["-NoProfile", "-NonInteractive", "-Command", script]));
    const matching = rows.filter((row) => selected.includes(row.pid));
    return scalar ? matching[0] || null : matching;
  }
  async function killTree(pid, { identity, tree = true, force = true } = {}) {
    pid = validPid(pid);
    const current = await processInfo(pid);
    if (!current) return { ok: true, stopped: true, reason: "vanished" };
    if (!matchesIdentity(identity, current)) return { ok: false, state: "unknown", reason: "identity-mismatch" };
    const args = ["/PID", String(pid), ...(tree ? ["/T"] : []), ...(force ? ["/F"] : [])];
    await execute("taskkill.exe", args);
    return { ok: true, stopped: true, reason: "killed-by-supervisor" };
  }
  return { listListeners, processInfo, killTree, imageNames };
}

const defaultWinproc = createWinproc();
module.exports = { createWinproc, parseNetstat, parseTasklist, parseCim, matchesIdentity, ...defaultWinproc };
