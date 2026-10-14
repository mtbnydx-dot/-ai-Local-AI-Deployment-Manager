"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("..");
const { main } = require("../../scripts/scrub-job-ledgers.js");

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "scrub-job-ledgers.js");
// Obviously fake values, assembled at runtime (release privacy scan).
const FAKE_KEY = "fake-scrub-key-0123456789abcdef";
const FAKE_HF = ["hf", "FAKEtoken0for0scrub0tests00"].join("_");

function ledger(lines, extra = {}) {
  return {
    version: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
    jobs: [{ id: "job-1", type: "serve", title: "Start", status: "failed", logs: lines, meta: { model: "org/model" }, ...extra }],
  };
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// A platform-shaped tree under the OS temp folder (rule 1.8): two managers,
// their secret stores, a clean file and one backup snapshot.
async function buildTree(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "scrub-ledgers-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const files = {
    ledger: path.join(root, "vllm-manager", "logs", "jobs-ledger.json"),
    store: path.join(root, "vllm-manager", "logs", "runtime-api-keys.json"),
    shapedStore: path.join(root, "llama-manager", "logs", "keys-by-shape.json"),
    clean: path.join(root, "llama-manager", "logs", "stats-ledger.json"),
    backup: path.join(root, "backups", "20261001-033000-000", "vllm-manager", "logs", "jobs-ledger.json"),
    backupStore: path.join(root, "backups", "20261001-033000-000", "vllm-manager", "logs", "runtime-api-keys.json"),
  };
  const dirtyLedger = ledger([
    `> docker run --name rt image serve --api-key ${FAKE_KEY}`,
    `engine echoed ${FAKE_KEY} at start`,
    "clean line",
  ], { error: `Command failed: docker run -e HF_TOKEN=${FAKE_HF} image` });
  const storeValue = { version: 1, secrets: { "11111111-2222-3333-4444-555555555555": { secret: FAKE_KEY, createdAt: "2026-10-01T00:00:00.000Z" } } };
  await writeJson(files.ledger, dirtyLedger);
  await writeJson(files.store, storeValue);
  await writeJson(files.shapedStore, { version: 2, secrets: { ref: { secret: `api_key=${FAKE_KEY}` } } });
  await writeJson(files.clean, { version: 1, clients: { local: { requests: 3 } } });
  await writeJson(files.backup, dirtyLedger);
  await writeJson(files.backupStore, storeValue);
  return { root, files };
}

async function snapshot(files) {
  const entries = await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await fsp.readFile(file)]));
  return Object.fromEntries(entries);
}

async function runMain(args, extra = {}) {
  const stdout = [];
  const stderr = [];
  const probed = [];
  const openPorts = new Set(extra.openPorts || []);
  const code = await main(args, {
    env: extra.env || {},
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    probePort: async (port) => {
      probed.push(port);
      return openPorts.has(port);
    },
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), probed };
}

function assertPrivateOutput(output, root) {
  assert.equal(output.includes(FAKE_KEY), false, "no fixture key in the output");
  assert.equal(output.includes(FAKE_HF), false, "no fixture token in the output");
  assert.equal(output.includes(root), false, "no absolute root in the output");
  assert.equal(/[A-Za-z]:[\\/]/.test(output), false, "no drive-letter path in the output");
}

test("secret stores are recognised by name and by shape", () => {
  assert.equal(core.isSecretStoreFile("x/logs/runtime-api-keys.json", null), true);
  assert.equal(core.isSecretStoreFile("x/logs/runtime-secrets.json", null), true);
  assert.equal(core.isSecretStoreFile("x/logs/other.json", { version: 1, secrets: {} }), true);
  assert.equal(core.isSecretStoreFile("x/logs/jobs-ledger.json", { version: 1, jobs: [] }), false);
  assert.equal(core.isSecretStoreFile("x/logs/odd.json", { secrets: [] }), false);
  assert.deepEqual(core.collectSecretStoreValues({ version: 1, secrets: { a: { secret: "one" }, b: { secret: "" }, c: null } }), ["one"]);
});

test("scanLedgerFile counts, scrubLedgerFile rewrites, and a store is never written", async (t) => {
  const { files } = await buildTree(t);
  const before = await fsp.readFile(files.ledger, "utf8");
  const scan = await core.scanLedgerFile(files.ledger, { secrets: [FAKE_KEY] });
  assert.deepEqual(scan, { file: files.ledger, matches: 3 });
  assert.equal(await fsp.readFile(files.ledger, "utf8"), before, "a scan changes nothing");

  const dry = await core.scrubLedgerFile(files.ledger, { secrets: [FAKE_KEY] });
  assert.equal(dry.written, false);
  const applied = await core.scrubLedgerFile(files.ledger, { secrets: [FAKE_KEY], apply: true });
  assert.deepEqual(applied, { file: files.ledger, matches: 3, written: true });
  const text = await fsp.readFile(files.ledger, "utf8");
  assert.equal(text.includes(FAKE_KEY), false);
  assert.equal(text.includes(FAKE_HF), false);
  const saved = JSON.parse(text);
  assert.deepEqual(saved.jobs[0].logs, ["> docker run --name rt image serve --api-key <redacted>", "engine echoed <redacted> at start", "clean line"]);
  assert.equal(saved.jobs[0].meta.model, "org/model");
  assert.equal((await core.scanLedgerFile(files.ledger, { secrets: [FAKE_KEY] })).matches, 0);
  const leftovers = (await fsp.readdir(path.dirname(files.ledger))).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
  assert.deepEqual(leftovers, [], "the atomic rewrite leaves no temp file");

  const storeBefore = await fsp.readFile(files.store);
  const storeResult = await core.scrubLedgerFile(files.store, { secrets: [FAKE_KEY], apply: true });
  assert.deepEqual(storeResult, { file: files.store, matches: 0, skipped: "secret_store", written: false });
  assert.deepEqual(await fsp.readFile(files.store), storeBefore);
});

test("the CLI dry run is the default, reports counts and relative names only, and exits 2", async (t) => {
  const { root, files } = await buildTree(t);
  const before = await snapshot(files);
  const result = await runMain(["--root", root]);
  assert.equal(result.code, 2);
  assert.deepEqual(result.probed, [], "a dry run probes no ports");
  assert.match(result.stdout, /dry run/);
  assert.match(result.stdout, /vllm-manager\/logs\/jobs-ledger\.json: 3 matches/);
  assert.match(result.stdout, /vllm-manager\/logs\/runtime-api-keys\.json: skipped \(secret store/);
  assert.match(result.stdout, /llama-manager\/logs\/keys-by-shape\.json: skipped \(secret store/);
  assert.match(result.stdout, /backups\/20261001-033000-000\/vllm-manager\/logs\/jobs-ledger\.json: 3 matches/);
  assert.doesNotMatch(result.stdout, /stats-ledger/);
  assert.match(result.stdout, /Key rotation/);
  assertPrivateOutput(`${result.stdout}\n${result.stderr}`, root);
  assert.deepEqual(await snapshot(files), before, "a dry run changes no file");
});

test("--apply rewrites ledgers atomically, keeps stores byte-identical and never writes backups", async (t) => {
  const { root, files } = await buildTree(t);
  const before = await snapshot(files);
  const result = await runMain(["--apply", "--root", root]);
  assert.equal(result.code, 2, "matches remain in the backup snapshot");
  assert.deepEqual(result.probed, [5177], "only the manager whose files change is probed");
  assert.match(result.stdout, /jobs-ledger\.json: 3 matches redacted, rewritten/);
  assertPrivateOutput(`${result.stdout}\n${result.stderr}`, root);

  const after = await snapshot(files);
  assert.equal(after.ledger.toString("utf8").includes(FAKE_KEY), false);
  assert.deepEqual(after.store, before.store);
  assert.deepEqual(after.shapedStore, before.shapedStore);
  assert.deepEqual(after.clean, before.clean);
  assert.deepEqual(after.backup, before.backup);
  assert.deepEqual(after.backupStore, before.backupStore);

  await fsp.rm(path.join(root, "backups"), { recursive: true, force: true });
  const rerun = await runMain(["--root", root]);
  assert.equal(rerun.code, 0, "a scrubbed tree without backups is clean");
});

test("--apply refuses while a manager port is open unless --force", async (t) => {
  const { root, files } = await buildTree(t);
  const before = await snapshot(files);
  const refused = await runMain(["--apply", "--root", root], { openPorts: [5177] });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Refused: vllm-manager is running on port 5177/);
  assert.deepEqual(await snapshot(files), before, "nothing is written when refused");

  const overridden = await runMain(["--apply", "--root", root], { openPorts: [15177], env: { VLLM_MANAGER_PORT: "15177" } });
  assert.equal(overridden.code, 1, "the port comes from the environment");
  assert.deepEqual(overridden.probed, [15177]);

  const forced = await runMain(["--apply", "--force", "--root", root], { openPorts: [5177] });
  assert.equal(forced.code, 2);
  assert.match(forced.stdout, /rewriting anyway \(--force\)/);
  assert.equal((await fsp.readFile(files.ledger, "utf8")).includes(FAKE_KEY), false);
});

test("--include adds files, and unknown flags such as --write exit 1", async (t) => {
  const { root } = await buildTree(t);
  await fsp.rm(path.join(root, "backups"), { recursive: true, force: true });
  await fsp.rm(path.join(root, "vllm-manager", "logs", "jobs-ledger.json"));
  const extra = path.join(root, "vllm-manager", "data", "launch-store.json");
  await writeJson(extra, { launches: [{ argv: ["--api-key", FAKE_KEY] }] });
  assert.equal((await runMain(["--root", root])).code, 0);
  const included = await runMain(["--root", root, "--include", "*/data/*.json"]);
  assert.equal(included.code, 2);
  assert.match(included.stdout, /vllm-manager\/data\/launch-store\.json: 1 match/);
  assert.equal((await runMain(["--root", root, "--include=**/launch-*.json"])).code, 2);

  for (const args of [["--write"], ["--bogus"], ["--root"], ["--include", "/abs/*.json"], ["--root", path.join(root, "missing")]]) {
    const result = await runMain(args);
    assert.equal(result.code, 1, `exit 1 for ${args[0]}`);
  }
  assert.equal((await runMain(["--help"])).code, 0);
});

test("the script runs as a CLI with the documented exit codes", async (t) => {
  const { root } = await buildTree(t);
  const env = { ...process.env };
  delete env.HF_TOKEN;
  delete env.HUGGING_FACE_HUB_TOKEN;
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
  const dry = await run(["--root", root]);
  assert.equal(dry.code, 2);
  assert.match(dry.stdout, /jobs-ledger\.json: 3 matches/);
  assertPrivateOutput(`${dry.stdout}\n${dry.stderr}`, root);
  assert.equal((await run(["--write", "--root", root])).code, 1);
});

test("ENG-15 scan set: launch-store.json is scanned by default and .runtime/launch-files leftovers are reported", async (t) => {
  const { root } = await buildTree(t);
  await fsp.rm(path.join(root, "backups"), { recursive: true, force: true });
  await fsp.rm(path.join(root, "vllm-manager", "logs", "jobs-ledger.json"));
  const store = path.join(root, "llama-manager", "logs", "launch-store.json");
  await writeJson(store, { schemaVersion: 1, launches: [{ launchId: "lch_FIXTURE", resolved: { argvRedacted: ["--api-key", FAKE_KEY] } }] });
  const leftover = path.join(root, ".runtime", "launch-files", "lch_FIXTURE", "tabby.yml");
  await fsp.mkdir(path.dirname(leftover), { recursive: true });
  await fsp.writeFile(leftover, `api_key: ${FAKE_KEY}\n`, "utf8");
  const before = await snapshot({ store, leftover });

  const dry = await runMain(["--root", root]);
  assert.equal(dry.code, 2);
  assert.match(dry.stdout, /llama-manager\/logs\/launch-store\.json: 1 match/);
  assert.match(dry.stdout, /\.runtime\/launch-files\/lch_FIXTURE\/tabby\.yml: leftover launch file/);
  assertPrivateOutput(`${dry.stdout}\n${dry.stderr}`, root);
  assert.deepEqual(await snapshot({ store, leftover }), before, "a dry run changes nothing");

  const applied = await runMain(["--root", root, "--apply"]);
  assert.equal(applied.code, 2, "the leftover launch file keeps the exit code at 2");
  const after = await snapshot({ store, leftover });
  assert.equal(after.store.includes(FAKE_KEY), false, "--apply scrubs the launch store");
  assert.deepEqual(after.leftover, before.leftover, "a launch file is reported, never rewritten");
  assertPrivateOutput(`${applied.stdout}\n${applied.stderr}`, root);

  await fsp.rm(path.join(root, ".runtime"), { recursive: true, force: true });
  assert.equal((await runMain(["--root", root])).code, 0);
  assert.equal((await runMain(["--root", root, "--dry-run"])).code, 1, "no --dry-run flag");
  assert.equal((await runMain(["--root", root, "--write"])).code, 1, "no --write flag");
});
