"use strict";
// Exposure scan, external probe and legacy detection (05 §13.2, §13.3, PUB-19).
//
// A factual, read-only report of what is reachable from where: which ports
// listen on which interfaces, which firewall profiles are on, whether a
// forwarder (netsh portproxy, a legacy proxy script, a tunnel pointed at a
// manager) bypasses the entry, and whether the public hostname really reaches
// the PUBLIC listener through a trusted proxy. Nothing here changes the
// machine: the probes are Get-* cmdlets, `netsh ... show`, `docker ps` and
// GETs, the legacy detector only stats and reads files, and every finding is
// advice for the owner to act on.
//
//   - Probes run one at a time through execFile with fixed argument arrays and
//     a timeout each (10 s). A probe that times out, fails or is unsupported
//     makes the checks that depend on it `unknown`, never a guess.
//   - Command lines of the owning processes are matched against signatures and
//     then discarded; they can carry secrets and are never returned or logged.
//   - The parsers (parseListeners, parseFirewall, parsePortProxy,
//     parseDockerPs, parseProcesses, parseTunnelTargets, classifyProcess) are
//     pure and golden-tested. They throw ExposureParseError on output they do
//     not understand, so a garbled probe reads as `unknown` instead of "empty".
//   - A scan is cached for 60 s and serialised; evaluate() is pure over a
//     snapshot, so a new probe result or event count updates the checks
//     without running the OS commands again.
//   - Off Windows the scan answers `unsupported` (every check `unknown`)
//     without throwing.
//
// The external probe (§13.3) registers a nonce, fetches
// `${baseUrl}/status.json?probe=<nonce>` and asks the probe recorder which
// socket and forwarded header the PUBLIC listener saw for it. The recorder
// (createProbeRecorder) is the in-memory half the PUBLIC listener writes to;
// it only records nonces the probe registered, and forgets them after 60 s.

const nodeCrypto = require("node:crypto");
const nodeDns = require("node:dns");
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeTls = require("node:tls");
const { execFile } = require("node:child_process");

const { ipInCidrs, normalizeSocketAddress, parseCidrList } = require("./trusted-proxy");

const PROBE_TIMEOUT_MS = 10_000;
const SCAN_TTL_MS = 60_000;
const NONCE_TTL_MS = 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DAY_MS = 86_400_000;
const CLOUDFLARED_METRICS_PORT = 20241; // deploy/cloudflare/compose.yaml publishes 127.0.0.1:20241 -> 2000
const LEGACY_PROXY_PORT = 55177;
const ADMIN_PORT_RANGE = Object.freeze([5176, 5177, 5178]);
const MANAGER_WILDCARD_PORTS = Object.freeze([5177, 5178, 5180, 5190, 7000]);
const MAX_PIDS = 64;
const MAX_CONFIG_FILE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 50;
const TLS_WARN_DAYS = 14;
const KEY_UNUSED_DAYS = 30;

const KEY_FILE_REL = "vllm-manager/logs/.last-public-service-key.txt";
const ARCHIVE_DIR_NAME = "ai-exposure-archive";

// Every check of §13.2, in the order the console lists them.
const CHECK_IDS = Object.freeze([
  "public_listener",
  "admin_bind",
  "wildcard_listeners",
  "firewall_profiles",
  "legacy_proxy",
  "tunnel_running",
  "tunnel_ready",
  "tunnel_target",
  "external_probe",
  "tls",
  "dns",
  "trusted_proxy_match",
  "managers_gateway_only",
  "admin_via_proxy",
  "keys_hygiene",
  "plaintext_key_files",
  "router_snapshots",
  "upnp",
]);
const STATES = Object.freeze(["ok", "warn", "fail", "unknown", "manual"]);

// The probes, as fixed argument arrays (§13.2). Nothing is interpolated into
// a command line except process ids, which are validated integers.
const POWERSHELL = "powershell.exe";
const POWERSHELL_ARGS = Object.freeze(["-NoProfile", "-NonInteractive", "-Command"]);
const LISTENERS_SCRIPT = "Get-NetTCPConnection -State Listen | Select LocalAddress,LocalPort,OwningProcess | ConvertTo-Json";
const FIREWALL_SCRIPT = "Get-NetFirewallProfile | Select Name,Enabled | ConvertTo-Json";
const PORTPROXY_COMMAND = Object.freeze({ file: "netsh", args: Object.freeze(["interface", "portproxy", "show", "all"]) });
const DOCKER_COMMAND = Object.freeze({ file: "docker", args: Object.freeze(["ps", "--format", "{{json .}}"]) });

function processScript(pids) {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  // Single quotes survive execFile's Windows argument quoting unchanged.
  return `Get-CimInstance Win32_Process -Filter '${filter}' | Select ProcessId,Name,CommandLine | ConvertTo-Json`;
}

class ExposureParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExposureParseError";
    this.code = "exposure_parse_failed";
  }
}

// ---- parsers (pure) ----------------------------------------------------------

function parseJsonRows(input, what) {
  if (input === null || input === undefined) return [];
  let value = input;
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    const text = String(value).replace(/^\uFEFF/, "").trim();
    if (!text) return [];
    try {
      value = JSON.parse(text);
    } catch {
      throw new ExposureParseError(`The ${what} output is not JSON.`);
    }
  }
  if (value === null) return [];
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === "object" && !Array.isArray(row));
  // ConvertTo-Json prints a single row as an object, not an array.
  if (typeof value === "object") return [value];
  throw new ExposureParseError(`The ${what} output has an unexpected shape.`);
}

function field(row, name) {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(row)) if (key.toLowerCase() === lower) return row[key];
  return undefined;
}

function integer(value, min, max) {
  const number = typeof value === "number" ? value : /^\d+$/.test(String(value ?? "").trim()) ? Number(String(value).trim()) : NaN;
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function addressScope(address) {
  const text = String(address || "").toLowerCase();
  if (text === "0.0.0.0" || text === "::" || text === "*" || text === "[::]") return "wildcard";
  if (/^127\./.test(text) || text === "::1" || text === "localhost") return "loopback";
  if (/^::ffff:127\./.test(text)) return "loopback";
  return "lan";
}

function cleanAddress(value) {
  // Zone ids ("fe80::1%12") and brackets are not part of the address.
  return String(value ?? "").trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
}

/**
 * Get-NetTCPConnection -State Listen | Select LocalAddress,LocalPort,OwningProcess
 * -> [{ address, port, pid, scope: "wildcard"|"loopback"|"lan" }], sorted by
 * port, address and pid, duplicates dropped.
 */
function parseListeners(input) {
  const seen = new Set();
  const rows = [];
  for (const row of parseJsonRows(input, "listener")) {
    const port = integer(field(row, "LocalPort"), 1, 65535);
    const address = cleanAddress(field(row, "LocalAddress"));
    if (port === null || !address) continue;
    const pid = integer(field(row, "OwningProcess"), 0, 2 ** 31 - 1) ?? 0;
    const key = `${address}|${port}|${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ address, port, pid, scope: addressScope(address) });
  }
  return rows.sort((a, b) => a.port - b.port || a.address.localeCompare(b.address) || a.pid - b.pid);
}

// Get-NetFirewallProfile.Enabled is a GpoBoolean: True/False/NotConfigured, as
// a boolean or as 1/0/2 depending on the PowerShell edition.
function firewallEnabled(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return null;
}

/** Get-NetFirewallProfile | Select Name,Enabled -> [{ name, enabled: true|false|null }]. */
function parseFirewall(input) {
  const rows = [];
  for (const row of parseJsonRows(input, "firewall")) {
    const name = String(field(row, "Name") ?? "").trim();
    if (!name) continue;
    rows.push({ name, enabled: firewallEnabled(field(row, "Enabled")) });
  }
  return rows;
}

/**
 * `netsh interface portproxy show all` -> [{ family, listenAddress,
 * listenPort, connectAddress, connectPort }]. The table rows are numeric, so
 * localized headers do not matter.
 */
function parsePortProxy(text) {
  const rows = [];
  let family = "ipv4";
  for (const line of String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const row = /^\s*(\S+)\s+(\d{1,5})\s+(\S+)\s+(\d{1,5})\s*$/.exec(line);
    if (row) {
      const listenPort = integer(row[2], 1, 65535);
      const connectPort = integer(row[4], 1, 65535);
      if (listenPort !== null && connectPort !== null) {
        rows.push({ family, listenAddress: cleanAddress(row[1]), listenPort, connectAddress: cleanAddress(row[3]), connectPort });
      }
      continue;
    }
    if (/ipv6/i.test(line)) family = "ipv6";
    else if (/ipv4/i.test(line)) family = "ipv4";
  }
  return rows;
}

function parseDockerPorts(text) {
  const out = [];
  for (const part of String(text ?? "").split(",")) {
    const match = /^\s*(?:(\[[0-9a-fA-F:]+\]|[0-9.]+):)?(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(tcp|udp)\s*$/.exec(part);
    if (!match) continue;
    const hostIp = match[1] ? cleanAddress(match[1]) : "0.0.0.0";
    const first = Number(match[2]);
    const last = match[3] ? Number(match[3]) : first;
    const containerFirst = Number(match[4]);
    for (let offset = 0; offset <= Math.min(last - first, 63); offset += 1) {
      out.push({ hostIp, hostPort: first + offset, containerPort: containerFirst + offset, proto: match[6] });
    }
  }
  return out;
}

/**
 * `docker ps --format "{{json .}}"` lines -> [{ id, name, image, state,
 * status, ports: [{ hostIp, hostPort, containerPort, proto }], managed }].
 * Command, Labels and Mounts can carry tokens, so they are dropped here;
 * `managed` only records that the platform's ai.* labels are present.
 */
function parseDockerPs(input) {
  const lines = Array.isArray(input) ? input : String(input ?? "").split(/\r?\n/);
  const rows = [];
  for (const entry of lines) {
    let row = entry;
    if (typeof entry === "string") {
      const text = entry.replace(/^\uFEFF/, "").trim();
      if (!text) continue;
      try {
        row = JSON.parse(text);
      } catch {
        throw new ExposureParseError("A docker ps line is not JSON.");
      }
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const names = String(field(row, "Names") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    rows.push({
      id: String(field(row, "ID") ?? "").slice(0, 12),
      name: names[0] || "",
      image: String(field(row, "Image") ?? "").replace(/@sha256:[0-9a-f]+$/i, ""),
      state: String(field(row, "State") ?? "").toLowerCase(),
      status: String(field(row, "Status") ?? ""),
      ports: parseDockerPorts(field(row, "Ports")),
      managed: /(?:^|[,\s])ai\.(?:manager|sglang|runtime)\./.test(String(field(row, "Labels") ?? "")),
    });
  }
  return rows;
}

// The processes the scan can name. `legacy` ones are the exposure tooling the
// platform retires (§13.2 legacy_proxy). Matching looks at file names only.
const PROCESS_SIGNATURES = Object.freeze([
  { id: "manager-public-proxy", legacy: true, cmdline: /(?:^|[\\/\s"'])manager-public-proxy\.js(?=$|[\s"'])/i },
  { id: "public-port-proxy", legacy: true, cmdline: /(?:^|[\\/\s"'])public-port-proxy\.js(?=$|[\s"'])/i },
  { id: "upnp-port-map", legacy: true, cmdline: /(?:^|[\\/\s"'])upnp-port-map\.js(?=$|[\s"'])/i },
  { id: "service-entry", cmdline: /service-entry[\\/]server\.js(?=$|[\s"'])/i },
  { id: "vllm-manager", cmdline: /vllm-manager[\\/]server\.js(?=$|[\s"'])/i },
  { id: "llama-manager", cmdline: /llama-manager[\\/]server\.js(?=$|[\s"'])/i },
  { id: "platform-mcp", cmdline: /platform-mcp[\\/][^\s"']*\.js(?=$|[\s"'])/i },
  { id: "cloudflared", name: /^cloudflared(?:\.exe)?$/i },
  { id: "caddy", name: /^caddy(?:\.exe)?$/i },
  { id: "docker-backend", name: /^(?:com\.docker\.backend|wslrelay|vpnkit)(?:\.exe)?$/i },
]);
const LEGACY_SIGNATURE_IDS = Object.freeze(PROCESS_SIGNATURES.filter((item) => item.legacy).map((item) => item.id));

/** classifyProcess(name, cmdline) -> signatureId | null. The command line is only matched, never kept. */
function classifyProcess(name, cmdline) {
  const processName = String(name ?? "");
  const line = String(cmdline ?? "");
  for (const signature of PROCESS_SIGNATURES) {
    if (signature.cmdline && line && signature.cmdline.test(line)) return signature.id;
    if (signature.name && signature.name.test(processName)) return signature.id;
  }
  return null;
}

/**
 * Get-CimInstance Win32_Process | Select ProcessId,Name,CommandLine ->
 * [{ pid, name, signature }]. The command line is classified and discarded.
 */
function parseProcesses(input) {
  const rows = [];
  for (const row of parseJsonRows(input, "process")) {
    const pid = integer(field(row, "ProcessId"), 0, 2 ** 31 - 1);
    if (pid === null) continue;
    const name = String(field(row, "Name") ?? "");
    rows.push({ pid, name, signature: classifyProcess(name, field(row, "CommandLine")) });
  }
  return rows.sort((a, b) => a.pid - b.pid);
}

const TUNNEL_DIRECTIVE_RE = /^(?:-\s*)?(reverse_proxy|proxy_pass|to|service|url)\b\s*:?\s*(.*)$/i;
const TUNNEL_ADDRESS_RE = /(?:^|[\s,"'(])(?:https?:\/\/)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]*):(\d{1,5})(?=$|[\s/,"')}])/g;

/**
 * Where a Caddyfile or a cloudflared config sends traffic: the host:port of
 * every reverse_proxy / proxy_pass / to / service / url directive ->
 * [{ directive, host, port, line }]. Comments and ${placeholders} are skipped.
 */
function parseTunnelTargets(text) {
  const targets = [];
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    const directive = TUNNEL_DIRECTIVE_RE.exec(line);
    if (!directive) return;
    // ${placeholders} and cloudflared's http_status:404 are not upstreams.
    const rest = directive[2].replace(/\$\{[^}]*\}/g, "").replace(/http_status:\d+/gi, "");
    TUNNEL_ADDRESS_RE.lastIndex = 0;
    let match;
    while ((match = TUNNEL_ADDRESS_RE.exec(rest)) !== null) {
      const port = integer(match[2], 1, 65535);
      if (port === null) continue;
      targets.push({ directive: directive[1].toLowerCase(), host: cleanAddress(match[1]) || "localhost", port, line: index + 1 });
    }
  });
  return targets;
}

// ---- legacy artifacts (read-only) -------------------------------------------

const LEGACY_SCRIPTS = Object.freeze([
  { relPath: "vllm-manager/manager-public-proxy.js", risk: "high", recommendation: "access.legacy.script_public_proxy" },
  { relPath: "vllm-manager/public-port-proxy.js", risk: "high", recommendation: "access.legacy.script_public_proxy" },
  { relPath: "vllm-manager/upnp-port-map.js", risk: "high", recommendation: "access.legacy.script_upnp" },
  { relPath: "vllm-manager/start-manager-public-proxy.cmd", risk: "medium", recommendation: "access.legacy.script_launcher" },
  { relPath: "vllm-manager/stop-manager-public-proxy.cmd", risk: "medium", recommendation: "access.legacy.script_launcher" },
]);
const ACCESS_LOG_REL = "vllm-manager/logs/manager-public-proxy-access.log";
const CLOUDFLARE_DIR_REL = "deploy/cloudflare";
// What PUB-20 tracks in deploy/cloudflare; anything else there is the owner's
// untracked legacy tunnel setup.
const TRACKED_CLOUDFLARE_FILES = Object.freeze(["README.md", "compose.yaml", "config.yml.template", "cloudflared.env.example"]);
const ROUTER_SNAPSHOT_RE = /^router-.*\.html$/i;

function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

// A copyable PowerShell Move-Item into an archive folder next to the root.
// The owner runs it; the platform never does.
function moveCommand(aiRoot, relPath) {
  const source = relPath.replace(/\//g, "\\");
  return [
    `$root = ${psQuote(aiRoot)}`,
    `$archive = Join-Path (Split-Path -Parent $root) ${psQuote(ARCHIVE_DIR_NAME)}`,
    "New-Item -ItemType Directory -Force -Path $archive | Out-Null",
    `Move-Item -LiteralPath (Join-Path $root ${psQuote(source)}) -Destination $archive`,
  ].join("; ");
}

function readOnlyFs(fs) {
  const source = fs || nodeFs;
  const need = (name) => {
    if (typeof source[name] !== "function") throw new TypeError(`detectLegacyArtifacts needs fs.${name}.`);
    return source[name].bind(source);
  };
  return { existsSync: need("existsSync"), statSync: need("statSync"), readdirSync: need("readdirSync"), readFileSync: need("readFileSync") };
}

function countOccurrences(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/**
 * detectLegacyArtifacts(aiRoot, fs) -> Finding[]
 * Finding = { id, relPath, kind: "script"|"config"|"log"|"snapshot"|"secret-file",
 *   risk: "high"|"medium", evidence, recommendation: i18nKey, suggestedCommand }.
 * Reports only; nothing is deleted, moved or stopped, and the fs object is
 * only asked to stat, list and read. The plaintext key file and
 * deploy/cloudflare/secrets are never read.
 */
function detectLegacyArtifacts(aiRoot, fs) {
  const io = readOnlyFs(fs);
  const root = String(aiRoot || "");
  const findings = [];
  const abs = (relPath) => nodePath.join(root, ...relPath.split("/"));
  const stat = (relPath) => {
    try {
      return io.statSync(abs(relPath));
    } catch {
      return null;
    }
  };
  const add = (relPath, kind, risk, evidence, recommendation) => {
    findings.push({
      id: `legacy.${relPath.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase()}`,
      relPath,
      kind,
      risk,
      evidence,
      recommendation,
      suggestedCommand: moveCommand(root, relPath),
    });
  };

  for (const script of LEGACY_SCRIPTS) {
    const info = stat(script.relPath);
    if (info?.isFile()) add(script.relPath, "script", script.risk, `File present (${info.size} bytes).`, script.recommendation);
  }

  const log = stat(ACCESS_LOG_REL);
  if (log?.isFile()) {
    let evidence = `Log present (${log.size} bytes).`;
    if (log.size <= MAX_SNAPSHOT_BYTES) {
      try {
        const lines = countOccurrences(String(io.readFileSync(abs(ACCESS_LOG_REL), "latin1")), "\n");
        evidence = `Log present (${log.size} bytes, ${lines} lines). Contents are not returned.`;
      } catch {
        // Size only.
      }
    }
    add(ACCESS_LOG_REL, "log", "medium", evidence, "access.legacy.log_public_proxy");
  }

  const cloudflare = stat(CLOUDFLARE_DIR_REL);
  if (cloudflare?.isDirectory()) {
    let names = [];
    try {
      names = io.readdirSync(abs(CLOUDFLARE_DIR_REL)).map(String);
    } catch {
      names = [];
    }
    const untracked = names.filter((name) => !TRACKED_CLOUDFLARE_FILES.includes(name)).sort();
    const secrets = untracked.filter((name) => name.toLowerCase() === "secrets");
    const others = untracked.filter((name) => name.toLowerCase() !== "secrets");
    if (others.length) {
      add(CLOUDFLARE_DIR_REL, "config", "high", `Untracked legacy tunnel files: ${others.slice(0, 12).join(", ")}${others.length > 12 ? ", ..." : ""}.`, "access.legacy.config_tunnel");
    }
    if (secrets.length) {
      add(`${CLOUDFLARE_DIR_REL}/${secrets[0]}`, "secret-file", "high", "Directory present. Its contents are never read.", "access.legacy.secrets_tunnel");
    }
  }

  let rootNames = [];
  try {
    rootNames = io.readdirSync(root).map(String);
  } catch {
    rootNames = [];
  }
  for (const name of rootNames.filter((item) => ROUTER_SNAPSHOT_RE.test(item)).sort().slice(0, MAX_SNAPSHOT_FILES)) {
    const info = stat(name);
    if (!info?.isFile()) continue;
    const counted = countStok(io, abs(name), info.size);
    add(name, "snapshot", "high", counted === null
      ? `Router page snapshot (${info.size} bytes; too large to scan).`
      : `Router page snapshot (${info.size} bytes) with ${counted} stok= occurrence(s). Values are not returned.`, "access.legacy.snapshot_router");
  }

  const keyFile = stat(KEY_FILE_REL);
  if (keyFile?.isFile()) {
    add(KEY_FILE_REL, "secret-file", "high", `Plaintext key file present (${keyFile.size} bytes). Contents are not read.`, "access.legacy.secret_key_file");
  }
  return findings.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// Occurrences of the router session token marker, never its value.
function countStok(io, file, size) {
  if (size > MAX_SNAPSHOT_BYTES) return null;
  try {
    return countOccurrences(String(io.readFileSync(file, "latin1")), "stok=");
  } catch {
    return null;
  }
}

// ---- probes ------------------------------------------------------------------

function withTimeout(task, ms, onTimeout) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Aborting is best effort.
      }
      reject(Object.assign(new Error("The probe timed out."), { code: "probe_timeout" }));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(task), timeout]).finally(() => clearTimeout(timer));
}

function defaultExec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });
}

function stdoutOf(result) {
  if (typeof result === "string") return result;
  if (Buffer.isBuffer(result)) return result.toString("utf8");
  return String(result?.stdout ?? "");
}

function reasonOf(error) {
  if (error?.code === "probe_timeout" || error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  if (error instanceof ExposureParseError) return "unparseable";
  return "failed";
}

// A probe result: { ok: true, data } or { ok: false, reason, code? }.
async function step(task, ms, onTimeout) {
  try {
    return { ok: true, data: await withTimeout(task, ms, onTimeout) };
  } catch (error) {
    return { ok: false, reason: reasonOf(error), code: typeof error?.code === "string" ? error.code : undefined };
  }
}

function safeStat(fs, file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function readTunnelConfigs(aiRoot, fs) {
  const io = readOnlyFs(fs);
  const candidates = [];
  const publicDir = nodePath.join(aiRoot, "config", "public");
  try {
    for (const name of io.readdirSync(publicDir).map(String).sort().slice(0, 20)) {
      if (/\.ya?ml$/i.test(name) || /^caddyfile/i.test(name)) candidates.push(`config/public/${name}`);
    }
  } catch {
    // No generated files yet.
  }
  for (const name of ["Caddyfile", "config.yml", "config.yaml"]) candidates.push(`${CLOUDFLARE_DIR_REL}/${name}`);
  const files = [];
  for (const relPath of candidates) {
    const file = nodePath.join(aiRoot, ...relPath.split("/"));
    const info = safeStat(io, file);
    if (!info?.isFile() || info.size > MAX_CONFIG_FILE_BYTES) continue;
    try {
      files.push({ relPath, targets: parseTunnelTargets(io.readFileSync(file, "utf8")) });
    } catch {
      // An unreadable file is simply not evidence.
    }
  }
  return files;
}

function listenerPorts(listeners, ports) {
  return listeners.filter((row) => ports.includes(row.port));
}

/**
 * collectSnapshot(options) -> Snapshot. Runs the probes one at a time and
 * never throws: each probe is { ok: true, data } or { ok: false, reason }.
 */
async function collectSnapshot(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const platform = options.platform || process.platform;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : PROBE_TIMEOUT_MS;
  const exec = typeof options.exec === "function" ? options.exec : defaultExec;
  const fetchFn = typeof options.fetch === "function" ? options.fetch : globalThis.fetch;
  const fs = options.fs || nodeFs;
  const aiRoot = String(options.aiRoot || "");
  const config = options.config || {};
  const supported = platform === "win32";
  const snapshot = { atMs: now(), platform, supported, probes: {}, files: null, legacy: [], enginePorts: Array.isArray(options.enginePorts) ? options.enginePorts.slice() : [] };
  if (!supported) return snapshot;

  const run = (file, args) => exec(file, args, { timeout: timeoutMs });
  const unknown = (reason) => ({ ok: false, reason });

  snapshot.probes.listeners = await step(async () => parseListeners(stdoutOf(await run(POWERSHELL, [...POWERSHELL_ARGS, LISTENERS_SCRIPT]))), timeoutMs);

  // Only the processes that own a port the checks look at; their command
  // lines are classified inside parseProcesses and dropped.
  const interesting = new Set([
    config.listeners?.public?.port || 5186,
    config.listeners?.admin?.port || 5176,
    LEGACY_PROXY_PORT,
    ...MANAGER_WILDCARD_PORTS,
    ...(Array.isArray(options.enginePorts) ? options.enginePorts : []),
  ]);
  if (snapshot.probes.listeners.ok) {
    const pids = Array.from(new Set(snapshot.probes.listeners.data.filter((row) => interesting.has(row.port) && row.pid > 0).map((row) => row.pid))).sort((a, b) => a - b).slice(0, MAX_PIDS);
    snapshot.probes.processes = pids.length
      ? await step(async () => parseProcesses(stdoutOf(await run(POWERSHELL, [...POWERSHELL_ARGS, processScript(pids)]))), timeoutMs)
      : { ok: true, data: [] };
  } else {
    snapshot.probes.processes = unknown("dependency");
  }

  snapshot.probes.firewall = await step(async () => parseFirewall(stdoutOf(await run(POWERSHELL, [...POWERSHELL_ARGS, FIREWALL_SCRIPT]))), timeoutMs);
  snapshot.probes.portproxy = await step(async () => parsePortProxy(stdoutOf(await run(PORTPROXY_COMMAND.file, [...PORTPROXY_COMMAND.args]))), timeoutMs);
  snapshot.probes.docker = await step(async () => parseDockerPs(stdoutOf(await run(DOCKER_COMMAND.file, [...DOCKER_COMMAND.args]))), timeoutMs);

  const tunnel = snapshot.probes.docker.ok ? snapshot.probes.docker.data.find((container) => /cloudflared/i.test(`${container.image} ${container.name}`)) : null;
  if (tunnel && tunnel.state === "running" && fetchFn) {
    const controller = new AbortController();
    snapshot.probes.ready = await step(async () => {
      const port = Number.isInteger(options.cloudflaredMetricsPort) ? options.cloudflaredMetricsPort : CLOUDFLARED_METRICS_PORT;
      const response = await fetchFn(`http://127.0.0.1:${port}/ready`, { signal: controller.signal, redirect: "manual" });
      try {
        await response.body?.cancel?.();
      } catch {
        // The status is all that matters.
      }
      return { status: Number(response.status) };
    }, timeoutMs, () => controller.abort());
  } else {
    snapshot.probes.ready = unknown("no_tunnel");
  }

  snapshot.legacy = safeDetect(aiRoot, fs);
  snapshot.files = {
    tunnelConfigs: safeCall(() => readTunnelConfigs(aiRoot, fs), []),
    keyFileExists: Boolean(safeStat(readOnlyFs(fs), nodePath.join(aiRoot, ...KEY_FILE_REL.split("/")))?.isFile()),
  };

  // dns: the public hostname must resolve (checked once per snapshot).
  const host = hostnameOf(config.listeners?.public?.baseUrl || config.publicOrigin);
  if (host && typeof (options.lookup || nodeDns.promises?.lookup) === "function") {
    const lookup = options.lookup || ((name) => nodeDns.promises.lookup(name, { all: true }));
    snapshot.probes.dns = await step(async () => {
      const found = await lookup(host);
      const list = Array.isArray(found) ? found : found ? [found] : [];
      return { host, resolved: list.length > 0 };
    }, timeoutMs);
    if (!snapshot.probes.dns.ok && ["ENOTFOUND", "ENODATA", "EAI_NODATA", "EAI_NONAME"].includes(snapshot.probes.dns.code)) {
      snapshot.probes.dns = { ok: true, data: { host, resolved: false } };
    }
  } else {
    snapshot.probes.dns = unknown(host ? "no_resolver" : "no_public_base_url");
  }
  return snapshot;
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function safeDetect(aiRoot, fs) {
  return safeCall(() => detectLegacyArtifacts(aiRoot, fs), []);
}

function hostnameOf(url) {
  if (!url) return "";
  try {
    return new URL(String(url)).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

// ---- evaluation (pure) -------------------------------------------------------

function makeCheck(id, state, evidence, extra = {}) {
  return { id, state, title: `access.check.${id}`, evidence: String(evidence ?? "").slice(0, 400), fix: `access.fix.${id}`, ...extra };
}

function probeEvidence(probe) {
  const reason = probe?.reason || "failed";
  return reason === "timeout" ? "The probe timed out." : reason === "unsupported" ? "Not supported on this platform." : reason === "unparseable" ? "The probe output was not understood." : "The probe could not run.";
}

function isWildcardHost(host) {
  return ["", "0.0.0.0", "::", "[::]", "*"].includes(String(host ?? "").trim().toLowerCase());
}

function hostPort(address, port) {
  return `${String(address).includes(":") ? `[${address}]` : address}:${port}`;
}

function describeRows(rows) {
  return rows.map((row) => hostPort(row.address, row.port)).join(", ");
}

function privateAddress(ip) {
  const text = String(ip || "");
  if (/^(?:10\.|127\.|192\.168\.|169\.254\.)/.test(text)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(text)) return true;
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(text)) return true;
  return text === "::1" || /^f[cd][0-9a-f]{2}:/i.test(text) || /^fe80:/i.test(text);
}

function ownersOf(snapshot, rows) {
  const processes = snapshot.probes.processes?.ok ? snapshot.probes.processes.data : [];
  const out = [];
  for (const row of rows) {
    const found = processes.find((item) => item.pid === row.pid);
    if (found?.signature) out.push(`${found.signature} (pid ${row.pid})`);
  }
  return Array.from(new Set(out));
}

function accessCidrs(config) {
  if (config?.trustedCidrs) return config.trustedCidrs;
  return parseCidrList(config?.trustedProxies?.cidrs || []).cidrs;
}

function keyHygiene(keys, nowMs) {
  const active = (Array.isArray(keys) ? keys : []).filter((key) => key && key.status === "active");
  const wildcard = active.filter((key) => Array.isArray(key.allowedOrigins) && key.allowedOrigins.includes("*"));
  const noExpiry = active.filter((key) => !key.expiresAt && Array.isArray(key.listeners) && key.listeners.includes("public") && !["internal", "owner"].includes(key.class));
  const unused = active.filter((key) => {
    const last = Date.parse(key.lastUsedAt || key.createdAt || "");
    return Number.isFinite(last) && nowMs - last > KEY_UNUSED_DAYS * DAY_MS;
  });
  const ids = (list) => list.slice(0, 20).map((key) => key.id);
  return {
    wildcardOrigins: ids(wildcard),
    noExpiry: ids(noExpiry),
    unused: ids(unused),
    counts: { wildcardOrigins: wildcard.length, noExpiry: noExpiry.length, unused: unused.length },
  };
}

/**
 * evaluate(snapshot, { config, signals, probe, now }) -> ExposureReport.
 * signals: { keys?, adminViaProxy24h?, directManagerCalls24h? } (null/absent = unknown).
 */
function evaluate(snapshot, options = {}) {
  const config = options.config || {};
  const signals = options.signals || {};
  const nowMs = (typeof options.now === "function" ? options.now : Date.now)();
  const probe = options.probe || null;
  const at = new Date(snapshot.atMs).toISOString();
  const supported = snapshot.supported;
  const checks = [];

  if (!supported) {
    for (const id of CHECK_IDS) {
      checks.push(id === "upnp" ? makeCheck(id, "manual", "UPnP port mappings live in the router; check its admin page.") : makeCheck(id, "unknown", "Not supported on this platform."));
    }
    return finish(snapshot, at, checks, [], probe, "unsupported");
  }

  const probes = snapshot.probes;
  const listeners = probes.listeners?.ok ? probes.listeners.data : null;
  const firewall = probes.firewall?.ok ? probes.firewall.data : null;
  const portproxy = probes.portproxy?.ok ? probes.portproxy.data : null;
  const docker = probes.docker?.ok ? probes.docker.data : null;
  const processes = probes.processes?.ok ? probes.processes.data : null;
  const add = (id, state, evidence, extra) => checks.push(makeCheck(id, state, evidence, extra));
  const unknownOf = (id, p) => add(id, "unknown", probeEvidence(p));

  // public_listener
  const publicConfig = config.listeners?.public || { enabled: true, host: "127.0.0.1", port: 5186 };
  if (publicConfig.enabled === false) {
    add("public_listener", "ok", "The PUBLIC listener is disabled in the settings.");
  } else if (!listeners) {
    unknownOf("public_listener", probes.listeners);
  } else {
    const rows = listenerPorts(listeners, [publicConfig.port]);
    const owners = ownersOf(snapshot, rows);
    const ownerText = owners.length ? ` Held by ${owners.join(", ")}.` : "";
    if (!rows.length) {
      add("public_listener", "fail", `Port ${publicConfig.port} is not listening.`);
    } else if (!isWildcardHost(publicConfig.host) && rows.some((row) => row.scope === "wildcard")) {
      add("public_listener", "fail", `Port ${publicConfig.port} is bound to a wildcard address although listeners.public.host is ${publicConfig.host}: another process holds it or a forwarder exists.${ownerText}`);
    } else {
      add("public_listener", "ok", `Port ${publicConfig.port} listens on ${describeRows(rows)}.${ownerText}`);
    }
  }

  // admin_bind
  const adminPort = config.listeners?.admin?.port || 5176;
  if (!listeners) {
    unknownOf("admin_bind", probes.listeners);
  } else {
    const rows = listenerPorts(listeners, [adminPort]);
    if (!rows.length) add("admin_bind", "unknown", `Port ${adminPort} is not listening.`);
    else if (rows.some((row) => row.scope === "wildcard") && config.adminLanBound !== true) {
      add("admin_bind", "fail", `Port ${adminPort} is on a wildcard address but ADMIN is not LAN-bound by the settings.`);
    } else {
      add("admin_bind", "ok", rows.some((row) => row.scope === "wildcard") ? `Port ${adminPort} is LAN-bound by the settings.` : `Port ${adminPort} listens on ${describeRows(rows)}.`);
    }
  }

  // firewall_profiles and wildcard_listeners
  const enginePorts = new Set([
    ...(Array.isArray(snapshot.enginePorts) ? snapshot.enginePorts : []),
    ...(docker ? docker.filter((container) => container.managed).flatMap((container) => container.ports.map((port) => port.hostPort)) : []),
  ]);
  const watched = [...MANAGER_WILDCARD_PORTS, ...enginePorts];
  const disabledProfiles = firewall ? firewall.filter((profile) => profile.enabled === false).map((profile) => profile.name) : [];
  const exposed = listeners ? listenerPorts(listeners, watched).filter((row) => row.scope === "wildcard") : [];
  const exposedPorts = Array.from(new Set(exposed.map((row) => row.port))).sort((a, b) => a - b);
  if (!listeners) {
    unknownOf("wildcard_listeners", probes.listeners);
  } else if (!exposedPorts.length) {
    add("wildcard_listeners", "ok", "No manager or engine port listens on all interfaces.");
  } else if (disabledProfiles.length) {
    add("wildcard_listeners", "fail", `Ports ${exposedPorts.join(", ")} listen on all interfaces while the ${disabledProfiles.join(", ")} firewall profile is off.`);
  } else {
    add("wildcard_listeners", "warn", `Ports ${exposedPorts.join(", ")} listen on all interfaces${firewall ? "; the firewall is on" : "; the firewall state is unknown"}.`);
  }
  if (!firewall) {
    unknownOf("firewall_profiles", probes.firewall);
  } else if (!firewall.length) {
    add("firewall_profiles", "unknown", "No firewall profile was reported.");
  } else if (disabledProfiles.length) {
    add("firewall_profiles", exposedPorts.length ? "fail" : "warn", `Disabled profile(s): ${disabledProfiles.join(", ")}${exposedPorts.length ? `, with wildcard listeners on ${exposedPorts.join(", ")}` : ""}.`);
  } else if (firewall.some((profile) => profile.enabled === null)) {
    add("firewall_profiles", "unknown", "A firewall profile has no defined state.");
  } else {
    add("firewall_profiles", "ok", `All ${firewall.length} firewall profiles are enabled.`);
  }

  // legacy_proxy
  {
    const hits = [];
    if (processes) {
      for (const item of processes) if (LEGACY_SIGNATURE_IDS.includes(item.signature)) hits.push(`process ${item.signature} (pid ${item.pid})`);
    }
    if (listeners && listeners.some((row) => row.port === LEGACY_PROXY_PORT)) hits.push(`port ${LEGACY_PROXY_PORT} is listening`);
    if (portproxy) {
      for (const row of portproxy) {
        if (ADMIN_PORT_RANGE.includes(row.connectPort)) hits.push(`portproxy ${hostPort(row.listenAddress, row.listenPort)} -> ${hostPort(row.connectAddress, row.connectPort)}`);
      }
    }
    if (hits.length) add("legacy_proxy", "fail", hits.join("; "));
    else if (processes && listeners && portproxy) add("legacy_proxy", "ok", "No legacy proxy process, port 55177 listener or portproxy rule to 5176-5178.");
    else add("legacy_proxy", "unknown", "Some probes did not complete, so a legacy forwarder cannot be ruled out.");
  }

  // tunnel_running, tunnel_ready
  const tunnel = docker ? docker.find((container) => /cloudflared/i.test(`${container.image} ${container.name}`)) : null;
  if (!docker) {
    unknownOf("tunnel_running", probes.docker);
  } else if (!tunnel) {
    add("tunnel_running", "unknown", "No cloudflared container (normal for the Caddy and LAN topologies).");
  } else if (tunnel.state === "running") {
    add("tunnel_running", "ok", `Container ${tunnel.name || tunnel.id} is running (${tunnel.status || "up"}).`);
  } else {
    add("tunnel_running", "fail", `Container ${tunnel.name || tunnel.id} is ${tunnel.state || "not running"}.`);
  }
  const ready = probes.ready;
  if (!tunnel || tunnel.state !== "running") {
    add("tunnel_ready", "unknown", "No running cloudflared container to ask.");
  } else if (ready?.ok) {
    if (ready.data.status === 200) add("tunnel_ready", "ok", "cloudflared reports ready (HTTP 200).");
    else add("tunnel_ready", "fail", `cloudflared /ready answered HTTP ${ready.data.status}.`);
  } else if (ready?.reason === "timeout") {
    unknownOf("tunnel_ready", ready);
  } else {
    add("tunnel_ready", "fail", "cloudflared /ready could not be reached.");
  }

  // tunnel_target
  {
    const configs = snapshot.files?.tunnelConfigs || [];
    const bad = [];
    for (const file of configs) {
      for (const target of file.targets) {
        if (ADMIN_PORT_RANGE.includes(target.port)) bad.push({ relPath: file.relPath, port: target.port });
      }
    }
    const withTargets = configs.filter((file) => file.targets.length);
    if (bad.length) {
      const admin = bad.every((item) => item.port === 5176);
      const lead = admin ? "tunnel_targets_admin_listener" : "legacy_tunnel_bypasses_entry";
      add("tunnel_target", "fail", `${lead}: ${bad.slice(0, 4).map((item) => `${item.relPath} -> :${item.port}`).join("; ")}`);
    } else if (withTargets.length) {
      add("tunnel_target", "ok", `${withTargets.map((file) => file.relPath).join(", ")} send traffic to ${Array.from(new Set(withTargets.flatMap((file) => file.targets.map((target) => target.port)))).sort((a, b) => a - b).map((port) => `:${port}`).join(", ")} only.`);
    } else {
      add("tunnel_target", "unknown", "No local tunnel or proxy config to read (a token tunnel is configured in the dashboard).");
    }
  }

  // external_probe, tls, trusted_proxy_match
  if (!probe) {
    add("external_probe", "unknown", "The external probe has not been run.");
  } else if (probe.error && probe.error.hairpin) {
    add("external_probe", "unknown", `The public URL could not be reached from this machine (${probe.error.code}); a router without hairpin NAT looks like this.`);
  } else if (probe.error) {
    add("external_probe", "fail", `The probe failed (${probe.error.code}).`);
  } else if (!(probe.status >= 200 && probe.status < 400)) {
    add("external_probe", "fail", `The public URL answered HTTP ${probe.status}.`);
  } else if (!probe.nonceObserved) {
    add("external_probe", "fail", "The PUBLIC listener never saw the probe nonce: the public hostname does not reach it.");
  } else if (!probe.observed?.viaProxy || !probe.observed?.headerUsed) {
    add("external_probe", "fail", "The probe arrived without a trusted forwarded client-address header.");
  } else {
    add("external_probe", "ok", `Reached PUBLIC through a proxy in ${probe.latencyMs} ms (header ${probe.observed.headerUsed}${probe.observed.country ? `, country ${probe.observed.country}` : ""}).`);
  }
  if (!probe?.tls?.validTo) {
    add("tls", "unknown", probe ? "No certificate information (plain HTTP or the TLS check failed)." : "The external probe has not been run.");
  } else {
    const validTo = Date.parse(probe.tls.validTo);
    if (!Number.isFinite(validTo)) add("tls", "unknown", "The certificate expiry could not be read.");
    else if (validTo < nowMs) add("tls", "fail", `The certificate expired on ${probe.tls.validTo}.`);
    else if (validTo - nowMs < TLS_WARN_DAYS * DAY_MS) add("tls", "warn", `The certificate expires in ${Math.max(0, Math.floor((validTo - nowMs) / DAY_MS))} day(s) (${probe.tls.validTo}).`);
    else add("tls", "ok", `The certificate is valid until ${probe.tls.validTo}.`);
  }
  {
    const dns = probes.dns;
    if (!dns?.ok) add("dns", "unknown", dns?.reason === "no_public_base_url" ? "No public base URL is configured (LAN only)." : probeEvidence(dns));
    else if (dns.data.resolved) add("dns", "ok", `${dns.data.host} resolves.`);
    else add("dns", "fail", `${dns.data.host} does not resolve.`);
  }
  if (!probe?.observed?.socketIp) {
    add("trusted_proxy_match", "unknown", probe ? "The probe did not reach PUBLIC, so the proxy address is unknown." : "The external probe has not been run.");
  } else if (ipInCidrs(probe.observed.socketIp, accessCidrs(config))) {
    add("trusted_proxy_match", "ok", `The probe arrived from ${probe.observed.socketIp}, which is in trustedProxies.cidrs.`);
  } else {
    const offer = privateAddress(probe.observed.socketIp)
      ? { offer: { kind: "trust_cidr", cidr: `${probe.observed.socketIp}/${probe.observed.socketIp.includes(":") ? 128 : 32}`, section: "trustedProxies", field: "cidrs" } }
      : {};
    add("trusted_proxy_match", "fail", `The probe arrived from ${probe.observed.socketIp}, which is not in trustedProxies.cidrs.`, offer);
  }

  // managers_gateway_only
  {
    const mode = config.public?.managersGatewayOnly || "warn";
    const direct = Number.isFinite(signals.directManagerCalls24h) ? signals.directManagerCalls24h : null;
    if (mode === "enforce") add("managers_gateway_only", "ok", "Managers accept calls from the entry only.");
    else if (mode === "off") add("managers_gateway_only", "fail", "Managers accept direct unsigned calls (public.managersGatewayOnly is off).");
    else add("managers_gateway_only", "warn", direct === null ? "Managers still accept direct unsigned calls (mode warn)." : `Managers still accept direct unsigned calls (mode warn); ${direct} in the last 24 h.`);
  }

  // admin_via_proxy
  {
    const count = Number.isFinite(signals.adminViaProxy24h) ? signals.adminViaProxy24h : null;
    if (count === null) add("admin_via_proxy", "unknown", "No admin_via_proxy event source is available.");
    else if (count > 0) add("admin_via_proxy", "fail", `${count} request(s) reached ADMIN through a proxy in the last 24 h.`);
    else add("admin_via_proxy", "ok", "No request reached ADMIN through a proxy in the last 24 h.");
  }

  // keys_hygiene
  if (!Array.isArray(signals.keys)) {
    add("keys_hygiene", "unknown", "The key store is not available.");
  } else {
    const hygiene = keyHygiene(signals.keys, nowMs);
    const { counts } = hygiene;
    if (counts.wildcardOrigins || counts.noExpiry || counts.unused) {
      add("keys_hygiene", "warn", `${counts.wildcardOrigins} key(s) allow any origin, ${counts.noExpiry} public key(s) never expire, ${counts.unused} key(s) unused for ${KEY_UNUSED_DAYS} days.`, {
        keys: { wildcardOrigins: hygiene.wildcardOrigins, noExpiry: hygiene.noExpiry, unused: hygiene.unused },
      });
    } else {
      add("keys_hygiene", "ok", `${signals.keys.filter((key) => key?.status === "active").length} active key(s) look tidy.`);
    }
  }

  // plaintext_key_files, router_snapshots (from the legacy scan)
  add("plaintext_key_files", snapshot.files?.keyFileExists ? "fail" : "ok", snapshot.files?.keyFileExists ? `${KEY_FILE_REL} exists.` : "No plaintext public key file.");
  {
    const snapshots = snapshot.legacy.filter((finding) => finding.kind === "snapshot");
    const stok = snapshots.reduce((sum, finding) => sum + (Number(/with (\d+) stok=/.exec(finding.evidence)?.[1]) || 0), 0);
    add("router_snapshots", snapshots.length ? "warn" : "ok", snapshots.length ? `${snapshots.length} router-*.html file(s) with ${stok} stok= occurrence(s).` : "No router page snapshots.");
  }
  add("upnp", "manual", "UPnP port mappings live in the router; check its admin page.");

  return finish(snapshot, at, checks, snapshot.legacy, probe, "ok");
}

// ---- exposure map ------------------------------------------------------------

const STATE_RANK = Object.freeze({ ok: 0, manual: 0, unknown: 1, warn: 2, fail: 3 });

function worstState(checks, ids) {
  let worst = null;
  for (const id of ids) {
    const found = checks.find((check) => check.id === id);
    if (!found) continue;
    if (!worst || STATE_RANK[found.state] > STATE_RANK[worst.state]) worst = found;
  }
  return worst ? { state: worst.state === "manual" ? "unknown" : worst.state, evidence: worst.evidence } : { state: "unknown", evidence: "" };
}

function buildMap(checks) {
  const nodes = [
    { id: "internet", label: "Internet", kind: "network" },
    { id: "edge", label: "Cloudflare / Caddy", kind: "proxy" },
    { id: "public", label: "PUBLIC listener", kind: "listener" },
    { id: "admin", label: "ADMIN listener", kind: "listener" },
    { id: "managers", label: "Managers", kind: "service" },
    { id: "engines", label: "Engines", kind: "service" },
    { id: "lan", label: "LAN", kind: "network" },
    { id: "loopback", label: "This machine", kind: "network" },
  ];
  const edge = (from, to, ids) => ({ from, to, ...worstState(checks, ids) });
  const edges = [
    edge("internet", "edge", ["tunnel_running", "tunnel_ready", "tls", "dns"]),
    edge("edge", "public", ["tunnel_target", "external_probe", "trusted_proxy_match", "public_listener"]),
    edge("edge", "admin", ["admin_via_proxy"]),
    edge("edge", "managers", ["legacy_proxy", "tunnel_target"]),
    edge("public", "managers", ["managers_gateway_only"]),
    edge("admin", "managers", ["managers_gateway_only"]),
    edge("managers", "engines", ["wildcard_listeners"]),
    edge("lan", "admin", ["admin_bind"]),
    edge("lan", "public", ["public_listener"]),
    edge("lan", "managers", ["wildcard_listeners", "firewall_profiles"]),
    edge("loopback", "admin", ["admin_bind"]),
  ];
  return { nodes, edges };
}

function finish(snapshot, at, checks, legacy, probe, status) {
  const summary = { ok: 0, warn: 0, fail: 0, unknown: 0, manual: 0 };
  for (const check of checks) summary[check.state] += 1;
  return {
    at,
    status,
    platform: snapshot.platform,
    summary,
    checks,
    legacy: legacy.map((finding) => ({ ...finding })),
    map: buildMap(checks),
    probe: probe || null,
  };
}

/**
 * runExposureScan({ aiRoot, config, exec, fetch, now, platform, fs, lookup,
 *   signals, probe, timeoutMs, enginePorts, cloudflaredMetricsPort }) -> Promise<ExposureReport>
 * One scan without a cache. Never rejects.
 */
async function runExposureScan(options = {}) {
  return evaluate(await collectSnapshot(options), options);
}

// ---- probe recorder (the PUBLIC half of §13.3) --------------------------------

/**
 * createProbeRecorder({ now, ttlMs, maxEntries }) -> { expect, observe, get, forget, size }
 * The external probe registers a nonce with expect(); the PUBLIC listener
 * calls observe() when /status.json?probe=<nonce> arrives. Only registered
 * nonces are recorded (first arrival wins) and each lives ttlMs (60 s), so
 * strangers cannot fill the table.
 */
function createProbeRecorder({ now = Date.now, ttlMs = NONCE_TTL_MS, maxEntries = 64 } = {}) {
  const entries = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [nonce, entry] of entries) if (entry.registeredAt < cutoff) entries.delete(nonce);
  }

  return {
    expect(nonce) {
      if (!NONCE_RE.test(String(nonce))) return false;
      prune();
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(String(nonce), { registeredAt: now(), observed: null });
      return true;
    },
    observe(nonce, observation = {}) {
      if (!NONCE_RE.test(String(nonce))) return false;
      prune();
      const entry = entries.get(String(nonce));
      if (!entry || entry.observed) return false;
      entry.observed = {
        at: new Date(now()).toISOString(),
        socketIp: observation.socketIp ? String(observation.socketIp) : null,
        viaProxy: observation.viaProxy === true,
        headerUsed: observation.headerUsed ? String(observation.headerUsed) : "",
        country: observation.country ? String(observation.country) : "",
        forwardedOnUntrusted: observation.forwardedOnUntrusted === true,
      };
      return true;
    },
    get(nonce) {
      prune();
      const entry = entries.get(String(nonce));
      return entry?.observed ? { ...entry.observed } : null;
    },
    forget(nonce) {
      entries.delete(String(nonce));
    },
    size() {
      prune();
      return entries.size;
    },
  };
}

// ---- external probe ----------------------------------------------------------

const HAIRPIN_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "timeout"]);

function errorCodeOf(error) {
  const code = error?.cause?.code || error?.code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError" || error?.code === "probe_timeout") return "timeout";
  return typeof code === "string" && /^[A-Za-z0-9_]{2,40}$/.test(code) ? code : "fetch_failed";
}

function defaultTlsProbe({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // Only the certificate dates are read; no request is sent over the socket.
    const socket = nodeTls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      try {
        const certificate = socket.getPeerCertificate();
        const validTo = certificate?.valid_to ? new Date(certificate.valid_to) : null;
        resolve({ validTo: validTo && Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null, authorized: socket.authorized === true });
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(Object.assign(new Error("TLS probe timed out."), { code: "probe_timeout" }));
    });
    socket.once("error", reject);
  });
}

/**
 * runProbe({ baseUrl, recorder, fetch, tlsProbe, now, randomBytes, timeoutMs }) -> Promise<ProbeResult>
 * ProbeResult = { url, at, status, latencyMs, nonceObserved,
 *   observed: { viaProxy, headerUsed, socketIp, country, forwardedOnUntrusted },
 *   tls: { validTo, authorized } | null, error: { code, hairpin } | null }
 * Never rejects; a base URL that is not http(s) is a TypeError the caller
 * turns into a 400 before calling.
 */
async function runProbe(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : PROBE_TIMEOUT_MS;
  const fetchFn = typeof options.fetch === "function" ? options.fetch : globalThis.fetch;
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : nodeCrypto.randomBytes;
  const recorder = options.recorder;
  if (!recorder || typeof recorder.expect !== "function") throw new TypeError("runProbe needs a probe recorder.");
  const base = new URL(String(options.baseUrl || ""));
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new TypeError("The probe base URL must be http(s).");
  const nonce = randomBytes(16).toString("base64url");
  const target = new URL("/status.json", base.origin);
  target.searchParams.set("probe", nonce);
  recorder.expect(nonce);

  const result = { url: target.toString(), at: new Date(now()).toISOString(), status: 0, latencyMs: 0, nonceObserved: false, observed: { viaProxy: false, headerUsed: "", socketIp: null, country: "", forwardedOnUntrusted: false }, tls: null, error: null };
  const started = now();
  const controller = new AbortController();
  try {
    const response = await withTimeout(() => fetchFn(target.toString(), { signal: controller.signal, redirect: "manual", headers: { accept: "application/json" } }), timeoutMs, () => controller.abort());
    result.status = Number(response.status) || 0;
    result.latencyMs = Math.max(0, now() - started);
    try {
      await response.body?.cancel?.();
    } catch {
      // The status line is enough.
    }
  } catch (error) {
    result.latencyMs = Math.max(0, now() - started);
    const code = errorCodeOf(error);
    result.error = { code, hairpin: HAIRPIN_CODES.has(code) };
  }
  const seen = recorder.get(nonce);
  if (seen) {
    result.nonceObserved = true;
    result.observed = { viaProxy: seen.viaProxy, headerUsed: seen.headerUsed, socketIp: seen.socketIp, country: seen.country, forwardedOnUntrusted: seen.forwardedOnUntrusted };
  }
  if (base.protocol === "https:" && !result.error) {
    const tlsProbe = typeof options.tlsProbe === "function" ? options.tlsProbe : defaultTlsProbe;
    try {
      const cert = await withTimeout(() => tlsProbe({ host: base.hostname, port: Number(base.port) || 443, timeoutMs }), timeoutMs);
      result.tls = { validTo: cert?.validTo || null, authorized: cert?.authorized === true };
    } catch {
      result.tls = null;
    }
  }
  return result;
}

// ---- scanner (cache, serialisation, probe memory) ----------------------------

/**
 * createExposureScanner({ aiRoot, getConfig, getSignals, exec, fetch, lookup,
 *   tlsProbe, fs, now, platform, timeoutMs, ttlMs, enginePorts,
 *   cloudflaredMetricsPort, recorder, randomBytes, logger })
 *   -> { report({ force }), cached(), probe(), lastProbe(), recorder }
 *
 * getConfig() returns the AccessConfig; getSignals() the live facts the OS
 * cannot tell (keys, event counts). report() reuses a snapshot younger than
 * ttlMs (60 s) and serialises concurrent scans; cached() never scans, so the
 * /api/security checklist can call it on every request.
 */
function createExposureScanner(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const ttlMs = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : SCAN_TTL_MS;
  const recorder = options.recorder || createProbeRecorder({ now });
  const getConfig = typeof options.getConfig === "function" ? options.getConfig : () => ({});
  const getSignals = typeof options.getSignals === "function" ? options.getSignals : () => ({});
  const logger = options.logger || null;
  let snapshot = null;
  let inFlight = null;
  let lastProbe = null;
  let lastSignals = {};

  async function signals() {
    try {
      lastSignals = (await getSignals()) || {};
      return lastSignals;
    } catch (error) {
      logger?.warn?.(`exposure scan: signals unavailable: ${error?.code || error?.name || "error"}`);
      return {};
    }
  }

  function scanOptions(config) {
    return {
      aiRoot: options.aiRoot,
      config,
      exec: options.exec,
      fetch: options.fetch,
      lookup: options.lookup,
      fs: options.fs,
      now,
      platform: options.platform,
      timeoutMs: options.timeoutMs,
      enginePorts: options.enginePorts,
      cloudflaredMetricsPort: options.cloudflaredMetricsPort,
    };
  }

  async function evaluateNow() {
    const config = getConfig() || {};
    return evaluate(snapshot, { config, signals: await signals(), probe: lastProbe, now });
  }

  async function report({ force = false } = {}) {
    if (!force && snapshot && now() - snapshot.atMs < ttlMs) return evaluateNow();
    if (!inFlight) {
      inFlight = (async () => {
        const config = getConfig() || {};
        snapshot = await collectSnapshot(scanOptions(config));
      })().finally(() => {
        inFlight = null;
      });
    }
    await inFlight;
    return evaluateNow();
  }

  return {
    recorder,
    report,
    // The report of the last scan with today's signals, or null before the
    // first one. Never scans and never throws (security.js calls it).
    cached() {
      if (!snapshot) return null;
      try {
        const config = getConfig() || {};
        return evaluate(snapshot, { config, signals: lastSignals, probe: lastProbe, now });
      } catch {
        return null;
      }
    },
    async probe() {
      const config = getConfig() || {};
      const baseUrl = config.listeners?.public?.baseUrl || config.publicOrigin || "";
      lastProbe = await runProbe({
        baseUrl,
        recorder,
        fetch: options.fetch,
        tlsProbe: options.tlsProbe,
        now,
        randomBytes: options.randomBytes,
        timeoutMs: options.timeoutMs,
      });
      return lastProbe;
    },
    lastProbe() {
      return lastProbe;
    },
  };
}

module.exports = {
  CHECK_IDS,
  CLOUDFLARED_METRICS_PORT,
  ExposureParseError,
  KEY_FILE_REL,
  LEGACY_SIGNATURE_IDS,
  NONCE_RE,
  PROBE_TIMEOUT_MS,
  SCAN_TTL_MS,
  STATES,
  classifyProcess,
  collectSnapshot,
  createExposureScanner,
  createProbeRecorder,
  detectLegacyArtifacts,
  evaluate,
  parseDockerPs,
  parseFirewall,
  parseListeners,
  parsePortProxy,
  parseProcesses,
  parseTunnelTargets,
  runExposureScan,
  runProbe,
};
