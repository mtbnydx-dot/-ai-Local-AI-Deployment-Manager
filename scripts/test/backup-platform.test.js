"use strict";

// scripts/backup-platform.ps1 never copies a secret (06 OPS-3b, §2.2): the
// deny list (.runtime\secrets\*, *\logs\runtime-api-keys.json,
// logs\runtime-secrets.json, .runtime\platform-mcp\server.env) wins over the
// include globs. The test lists a fixture root with -ListOnly, which writes
// nothing and registers nothing.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPT = path.resolve(__dirname, "..", "backup-platform.ps1");

// Windows PowerShell 5.1 below a pwsh 7 session must not inherit pwsh's
// PSModulePath (see release-manifest.test.js). The TTS and telemetry variables would point
// the listing outside the fixture root.
function scriptEnv() {
  const drop = new Set(["psmodulepath", "tts_env_file", "tts_data_root", "ai_telemetry_db"]);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !drop.has(name.toLowerCase())));
}

function hasWindowsPowerShell() {
  if (process.platform !== "win32") return false;
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"], { env: scriptEnv(), windowsHide: true, timeout: 60000 });
  return !probe.error && probe.status === 0;
}

async function writeFile(root, relativePath, content) {
  const full = path.join(root, ...relativePath.split("/"));
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf8");
}

test("the backup listing of a fixture root excludes every denied secret path", { timeout: 180000, skip: !hasWindowsPowerShell() && "the backup script needs Windows PowerShell" }, async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "backup-platform-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  const backups = path.join(base, "backups");
  const allowed = {
    "service-entry/data/platform-billing.sqlite": "",
    "service-entry/data/telemetry.sqlite": "",
    "service-entry/data/keys.json": "{}",
    "vllm-manager/logs/jobs-ledger.json": "{}",
    "vllm-manager/logs/launch-profiles.json": "{}",
    "llama-manager/logs/recent-launches.json": "{}",
    "search-gateway/.env": "SEARCH_PORT=5180\n",
    "tts-platform/.env": "TTS_PORT=7000\n",
  };
  const denied = {
    ".runtime/secrets/runtime.vllm.json": '{"schemaVersion":1}',
    ".runtime/secrets/platform-control.json": '{"schemaVersion":1}',
    "vllm-manager/logs/runtime-api-keys.json": '{"version":1,"secrets":{}}',
    "llama-manager/logs/runtime-api-keys.json": '{"version":1,"secrets":{}}',
    "logs/runtime-secrets.json": '{"version":1,"secrets":{}}',
    "vllm-manager/logs/runtime-secrets.json": '{"version":1,"secrets":{}}',
    ".runtime/platform-mcp/server.env": "PLATFORM_MCP_API_KEY=fixture-mcp-key-0001\n",
  };
  for (const [relativePath, content] of Object.entries({ ...allowed, ...denied })) await writeFile(root, relativePath, content);

  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT,
    "-Root", root, "-BackupRoot", backups, "-ListOnly",
  ], { encoding: "utf8", env: scriptEnv(), windowsHide: true, timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
  const sources = (Array.isArray(listed) ? listed : [listed]).map((entry) => String(entry.source).split("\\").join("/")).sort();

  assert.deepEqual(sources, Object.keys(allowed).sort());
  for (const relativePath of Object.keys(denied)) assert.equal(sources.includes(relativePath), false, relativePath);
  assert.equal(fs.existsSync(backups), false, "-ListOnly writes nothing");
});
