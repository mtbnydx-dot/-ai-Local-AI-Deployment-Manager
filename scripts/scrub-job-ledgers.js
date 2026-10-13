"use strict";

// Finds and removes plaintext secrets in the managers' persisted ledgers
// (docs/overhaul/08 P0-5, owner action A1).
//
//   node scripts/scrub-job-ledgers.js            dry run: counts only, nothing changes
//   node scripts/scrub-job-ledgers.js --apply    rewrite ledgers that hold matches
//
// Flags and exit codes are a contract (later work extends the scan set only):
//   --apply           rewrite files (default is a dry run; there is no --write)
//   --force           rewrite even while a manager port accepts connections
//   --root <dir>      platform root (default: the folder above scripts/)
//   --include <glob>  extra files relative to the root, repeatable
//   exit 0 clean, 2 matches found (dry run) or left in backups, 1 error
//
// Scans <root>/*/logs/*.json. Secret stores (runtime-api-keys.json and any
// { version, secrets } file) are listed as skipped and never rewritten.
// <root>/backups/* is reported and never changed, because rewriting a
// snapshot would break its manifest hashes. Output is counts and relative
// names only.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const {
  collectSecretStoreValues,
  isSecretStoreFile,
  scanLedgerFile,
  scrubLedgerFile,
} = require("../manager-core/ledger-scrub");

const USAGE = [
  "Usage: node scripts/scrub-job-ledgers.js [--apply] [--force] [--root <dir>] [--include <glob>]...",
  "  Without --apply nothing is changed. Stop the managers before --apply.",
].join("\n");

// The managers whose running process would overwrite a scrubbed ledger.
const MANAGER_PORTS = Object.freeze({
  "vllm-manager": { env: "VLLM_MANAGER_PORT", port: 5177 },
  "llama-manager": { env: "LLAMA_MANAGER_PORT", port: 5178 },
});

const SKIPPED_TOP_LEVEL = new Set(["backups", "node_modules", "worktrees"]);
const MAX_WALK_DEPTH = 8;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { apply: false, force: false, root: "", include: [], help: false };
  const takeValue = (name, inline, index) => {
    if (inline !== undefined) return { value: inline, next: index };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value.`);
    return { value, next: index + 1 };
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index]);
    const [flag, inline] = raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    if (flag === "--apply" && inline === undefined) options.apply = true;
    else if (flag === "--force" && inline === undefined) options.force = true;
    else if ((flag === "--help" || flag === "-h") && inline === undefined) options.help = true;
    else if (flag === "--root") {
      const taken = takeValue(flag, inline, index);
      options.root = taken.value;
      index = taken.next;
    } else if (flag === "--include") {
      const taken = takeValue(flag, inline, index);
      options.include.push(taken.value);
      index = taken.next;
    } else {
      throw new UsageError(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function toRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

// One path segment of an --include glob: "*" and "?" stay inside the segment.
function segmentToRegExp(segment) {
  const source = segment.split("").map((char) => {
    if (char === "*") return "[^/]*";
    if (char === "?") return "[^/]";
    return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
}

function splitGlob(glob) {
  return String(glob).replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== ".");
}

async function listDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
}

async function walkFiles(dir, depth, visit) {
  if (depth > MAX_WALK_DEPTH) return;
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walkFiles(full, depth + 1, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}

// Expands a glob segment by segment, so only folders that can still match
// are read. "**" matches zero or more folders.
async function expandGlob(dir, segments, index, depth, found) {
  if (index >= segments.length || depth > MAX_WALK_DEPTH) return;
  const segment = segments[index];
  const last = index === segments.length - 1;
  if (segment === "**") {
    await expandGlob(dir, segments, index + 1, depth, found);
    for (const entry of await listDir(dir)) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
      if (depth === 0 && SKIPPED_TOP_LEVEL.has(entry.name)) continue;
      await expandGlob(path.join(dir, entry.name), segments, index, depth + 1, found);
    }
    return;
  }
  const matcher = segmentToRegExp(segment);
  for (const entry of await listDir(dir)) {
    if (!matcher.test(entry.name)) continue;
    if (depth === 0 && SKIPPED_TOP_LEVEL.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (last) {
      if (entry.isFile()) found.add(full);
    } else if (entry.isDirectory()) {
      await expandGlob(full, segments, index + 1, depth + 1, found);
    }
  }
}

// <root>/*/logs/*.json plus the --include globs. Backups and worktrees are
// never part of the scan set, and dot-folders are skipped by the default scan.
async function listLedgerFiles(root, includes) {
  const files = new Set();
  for (const entry of await listDir(root)) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_TOP_LEVEL.has(entry.name)) continue;
    for (const logEntry of await listDir(path.join(root, entry.name, "logs"))) {
      if (logEntry.isFile() && /\.json$/i.test(logEntry.name)) files.add(path.join(root, entry.name, "logs", logEntry.name));
    }
  }
  for (const glob of includes) await expandGlob(root, splitGlob(glob), 0, 0, files);
  return Array.from(files).sort((left, right) => toRelative(root, left).localeCompare(toRelative(root, right)));
}

async function listBackupFiles(root) {
  const files = [];
  await walkFiles(path.join(root, "backups"), 0, (file) => {
    if (/\.json$/i.test(file)) files.push(file);
  });
  return files.sort((left, right) => toRelative(root, left).localeCompare(toRelative(root, right)));
}

async function readJsonQuietly(file) {
  try {
    return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

// Exact values from every secret store in the scan set and the environment,
// so a key echoed without a recognisable shape is still found.
async function collectExactSecrets(files, env) {
  const secrets = new Set();
  for (const file of files) {
    const parsed = await readJsonQuietly(file);
    if (!isSecretStoreFile(file, parsed)) continue;
    for (const value of collectSecretStoreValues(parsed)) secrets.add(value);
  }
  for (const name of ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"]) {
    if (env[name]) secrets.add(String(env[name]));
  }
  return Array.from(secrets);
}

function probeTcpPort(port, host = "127.0.0.1", timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function managerPort(manager, env) {
  const spec = MANAGER_PORTS[manager];
  if (!spec) return null;
  const value = Number(env[spec.env] || spec.port);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : spec.port;
}

function plural(count, word) {
  if (count === 1) return `1 ${word}`;
  return `${count} ${word}${/(?:ch|sh|s|x)$/.test(word) ? "es" : "s"}`;
}

function describeError(error) {
  // fs errors embed absolute paths in their message; report the code only.
  return error?.code ? String(error.code) : "error";
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env || process.env;
  const out = deps.stdout || ((line) => process.stdout.write(`${line}\n`));
  const err = deps.stderr || ((line) => process.stderr.write(`${line}\n`));
  const probePort = deps.probePort || probeTcpPort;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(error.message);
    err(USAGE);
    return 1;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    err("The --root folder does not exist.");
    return 1;
  }
  for (const glob of options.include) {
    if (path.isAbsolute(glob) || glob.split(/[\\/]/).includes("..")) {
      err("--include takes a glob relative to --root.");
      return 1;
    }
  }

  let errors = 0;
  const ledgerFiles = await listLedgerFiles(root, options.include);
  const backupFiles = await listBackupFiles(root);
  const secrets = await collectExactSecrets([...ledgerFiles, ...backupFiles], env);

  out(options.apply
    ? "scrub-job-ledgers: apply mode."
    : "scrub-job-ledgers: dry run, nothing is changed. Run with --apply to rewrite.");

  const scans = [];
  for (const file of ledgerFiles) {
    try {
      scans.push(await scanLedgerFile(file, { secrets }));
    } catch (error) {
      errors += 1;
      err(`  ${toRelative(root, file)}: unreadable (${describeError(error)})`);
    }
  }

  if (options.apply) {
    // A running manager would overwrite the scrubbed file from memory.
    const managers = new Set(scans
      .filter((scan) => scan.matches > 0 && !scan.skipped)
      .map((scan) => toRelative(root, scan.file).split("/")[0]));
    const running = [];
    for (const manager of managers) {
      const port = managerPort(manager, env);
      if (port && await probePort(port)) running.push({ manager, port });
    }
    if (running.length && !options.force) {
      for (const item of running) err(`Refused: ${item.manager} is running on port ${item.port}. Stop it first, or pass --force.`);
      err("Nothing was changed.");
      return 1;
    }
    for (const item of running) out(`Warning: ${item.manager} is running on port ${item.port}; rewriting anyway (--force).`);
  }

  let ledgerMatches = 0;
  let filesWithMatches = 0;
  let remaining = 0;
  let rewritten = 0;
  let storesSkipped = 0;
  for (const scan of scans) {
    const name = toRelative(root, scan.file);
    if (scan.skipped === "secret_store") {
      storesSkipped += 1;
      out(`  ${name}: skipped (secret store, never rewritten)`);
      continue;
    }
    if (!scan.matches) continue;
    ledgerMatches += scan.matches;
    filesWithMatches += 1;
    if (scan.skipped) {
      remaining += scan.matches;
      out(`  ${name}: ${plural(scan.matches, "match")}, not valid JSON, left unchanged`);
      continue;
    }
    if (!options.apply) {
      remaining += scan.matches;
      out(`  ${name}: ${plural(scan.matches, "match")}`);
      continue;
    }
    try {
      const result = await scrubLedgerFile(scan.file, { secrets, apply: true });
      if (result.written) rewritten += 1;
      out(`  ${name}: ${plural(result.matches, "match")} redacted, rewritten`);
    } catch (error) {
      errors += 1;
      remaining += scan.matches;
      err(`  ${name}: rewrite failed (${describeError(error)})`);
    }
  }

  let backupMatches = 0;
  let backupFilesWithMatches = 0;
  if (backupFiles.length) out("Backups (reported only, never changed):");
  for (const file of backupFiles) {
    const name = toRelative(root, file);
    try {
      const scan = await scanLedgerFile(file, { secrets });
      if (scan.skipped === "secret_store") {
        out(`  ${name}: skipped (secret store)`);
        continue;
      }
      if (!scan.matches) continue;
      backupMatches += scan.matches;
      backupFilesWithMatches += 1;
      out(`  ${name}: ${plural(scan.matches, "match")}`);
    } catch (error) {
      errors += 1;
      err(`  ${name}: unreadable (${describeError(error)})`);
    }
  }

  out(`Summary: scanned ${plural(scans.length, "ledger file")}; ${plural(ledgerMatches, "match")} in ${plural(filesWithMatches, "file")}`
    + (options.apply ? `, ${plural(rewritten, "file")} rewritten` : "")
    + `; ${plural(backupMatches, "match")} in ${plural(backupFilesWithMatches, "backup file")}`
    + `; ${plural(storesSkipped, "secret store")} skipped.`);
  if (ledgerMatches || backupMatches) {
    out("Key rotation: treat every key that was found as exposed. Restart the affected models with new keys and update their clients.");
    out("密钥轮换：已发现的密钥都应视为已泄露。请用新密钥重新启动相关模型并更新客户端。");
    if (backupMatches) out("Backup snapshots can be deleted whole once the keys are rotated; editing them would break their manifests.");
  }
  if (errors) return 1;
  return remaining || backupMatches ? 2 : 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`scrub-job-ledgers failed (${describeError(error)}).\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, splitGlob, segmentToRegExp, MANAGER_PORTS };
