"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runDoctor, createDefaultProbes } = require("../platform/doctor");
const { fixture, PINNED_IMAGE, EXPERIMENTAL_IMAGE, LOCAL_IMAGE } = require("./helpers/doctor-fixture");
const { createEngineRegistry } = require("../engines/registry");

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-runtime-storage-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
async function result(options, id) { const report = await runDoctor({ ...options, ids: [id] }); assert.equal(report.checks.length, 1); return report.checks[0]; }

test("Docker CLI and daemon checks distinguish available, missing and stopped without fixes executing", async (t) => {
  const options = fixture(temporary(t));
  options.probes.dockerCli = { present: false };
  assert.equal((await result(options, "runtime.docker-cli")).status, "fail");
  assert.equal((await result(options, "runtime.docker-cli")).fix.risk, "manual");
  options.probes.dockerCli = { present: true, version: "fixture" };
  assert.equal((await result(options, "runtime.docker-cli")).status, "ok");
  assert.equal((await result(options, "runtime.docker-daemon")).fix.id, "start-docker");
  options.probes.dockerDaemon = { ready: true };
  assert.equal((await result(options, "runtime.docker-daemon")).status, "ok");
});

test("WSL checks support custom distro precedence, WSL 1/missing warnings and non-Windows skip", async (t) => {
  const options = fixture(temporary(t)); options.env.DOCKER_WSL_DISTRO = "fixture-custom";
  options.config.values["docker.wslDistro"] = "ignored-config";
  options.probes.wsl = { distributions: [{ name: "fixture-custom", version: 2 }] };
  assert.equal((await result(options, "runtime.wsl")).status, "ok");
  options.probes.wsl = { distributions: [{ name: "fixture-custom", version: 1 }] };
  assert.equal((await result(options, "runtime.wsl")).status, "warn");
  options.probes.wsl = { distributions: [] };
  assert.equal((await result(options, "runtime.wsl")).status, "warn");
  options.platform = "linux";
  assert.equal((await result(options, "runtime.wsl")).status, "skip");
  assert.equal((await result(options, "runtime.wslconfig")).status, "skip");
});

test("WSL configuration evaluates file/default memory, custom thresholds and malformed values", async (t) => {
  const options = fixture(temporary(t));
  options.probes.wslConfig = { exists: false, memoryGb: null, swapGb: null, totalMemoryGb: 128 };
  let check = await result(options, "runtime.wslconfig");
  assert.equal(check.status, "ok"); assert.equal(check.data.effectiveMemoryGb, 64); assert.equal(check.data.memorySource, "host-default");
  options.config.values["doctor.wslMinMemoryGb"] = 96;
  check = await result(options, "runtime.wslconfig");
  assert.equal(check.status, "warn"); assert.equal(check.fix.risk, "manual"); assert.match(check.data.suggested, /memory=96GB/);
  options.probes.wslConfig = { exists: true, memoryGb: 128, swapGb: 0, invalid: ["swap"] };
  assert.equal((await result(options, "runtime.wslconfig")).status, "warn");
  options.probes.wslConfig = { exists: false, memoryGb: null, swapGb: null, totalMemoryGb: null };
  assert.equal((await result(options, "runtime.wslconfig")).status, "warn");
});

test("driver checks use inherited release requirements and list only affected active runtimes", async (t) => {
  const options = fixture(temporary(t));
  options.probes.nvidia = { gpus: [{ driverVersion: "579.99", computeCapability: "12.0", name: "Fixture GPU" }] };
  let check = await result(options, "runtime.nvidia-driver");
  assert.equal(check.status, "fail"); assert.deepEqual(check.data.affected.map((row) => row.runtimeId), ["vllm@1.0.0"]);
  options.probes.nvidia = { gpus: [{ driverVersion: "581.15", computeCapability: "8.0", name: "Fixture GPU" }] };
  check = await result(options, "runtime.nvidia-driver");
  assert.equal(check.status, "fail"); assert.deepEqual(check.data.affected.map((row) => row.runtimeId), ["sglang@experimental", "sglang@local"]);
  options.probes.nvidia.gpus.push({ driverVersion: "581.15", computeCapability: "12.0", name: "Suitable fixture GPU" });
  assert.equal((await result(options, "runtime.nvidia-driver")).status, "ok");
  options.probes.nvidia = { gpus: [] };
  assert.equal((await result(options, "runtime.nvidia-driver")).status, "fail");
});

test("missing images distinguish stable auto-pull, experimental explicit-pull and local rebuild metadata", async (t) => {
  const options = fixture(temporary(t));
  options.probes.images = (rows) => rows.map((row) => ({ image: row.image, present: false }));
  const check = await result(options, "runtime.images");
  assert.equal(check.status, "warn");
  const rows = check.data.runtimes;
  assert.equal(rows.find((row) => row.image === PINNED_IMAGE).pullPolicy, "auto");
  const experimental = rows.find((row) => row.image === EXPERIMENTAL_IMAGE);
  assert.equal(experimental.pullPolicy, "explicit"); assert.equal(experimental.fix.via, "manager");
  assert.equal(experimental.fix.apiCall.method, "POST"); assert.equal(experimental.fix.risk, "confirm");
  const local = rows.find((row) => row.image === LOCAL_IMAGE);
  assert.equal(local.pullPolicy, "local-build"); assert.equal(local.fix.risk, "manual");
  assert.equal(local.fix.buildScript, "scripts/rebuild-fixture.ps1"); assert.equal(local.fix.apiCall, undefined);
  assert.equal(rows.some((row) => row.runtimeId.includes("retired")), false);
  assert.equal(check.actions.length, 3);
});

test("images report all present, partially unknown, unavailable and empty catalogs honestly", async (t) => {
  const options = fixture(temporary(t));
  options.probes.images = (rows) => rows.map((row) => ({ image: row.image, present: true }));
  assert.equal((await result(options, "runtime.images")).status, "ok");
  options.probes.images = (rows) => rows.map((row, i) => ({ image: row.image, present: i ? true : null }));
  assert.equal((await result(options, "runtime.images")).status, "warn");
  options.probes.images = (rows) => rows.map((row) => ({ image: row.image, present: null }));
  assert.equal((await result(options, "runtime.images")).status, "skip");
  options.probes.runtimes = [];
  assert.equal((await result(options, "runtime.images")).status, "skip");
});

test("AI root free-space checks use the 5 GiB hard floor and configurable warning threshold", async (t) => {
  const options = fixture(temporary(t));
  options.probes.diskSpace = { freeGb: 4.99, exists: true };
  assert.equal((await result(options, "storage.ai-root")).status, "fail");
  options.probes.diskSpace = { freeGb: 5, exists: true };
  assert.equal((await result(options, "storage.ai-root")).status, "warn");
  options.config.values["doctor.minFreeGb.aiRoot"] = 5;
  assert.equal((await result(options, "storage.ai-root")).status, "ok");
  options.probes.diskSpace = { freeGb: 128, exists: false };
  assert.equal((await result(options, "storage.ai-root")).status, "warn");
  options.probes.diskSpace = { freeGb: null, exists: true };
  assert.equal((await result(options, "storage.ai-root")).status, "fail");
});

test("model roots aggregate each registered volume and skip an explicitly empty list", async (t) => {
  const options = fixture(temporary(t));
  options.probes.modelRoots = [{ id: "one", path: "one" }, { id: "two", path: "two" }];
  options.probes.diskSpace = (directory) => ({ freeGb: directory === "two" ? 49 : 128, exists: true });
  const check = await result(options, "storage.model-roots");
  assert.equal(check.status, "warn"); assert.deepEqual(check.data.disks.map((disk) => disk.id), ["one", "two"]);
  options.probes.modelRoots = [];
  assert.equal((await result(options, "storage.model-roots")).status, "skip");
});

test("HF cache uses effective config before env and Docker data may be unsupported", async (t) => {
  const options = fixture(temporary(t)); options.env.HF_HOME = "ignored-env-cache";
  let check = await result(options, "storage.hf-cache");
  assert.ok(check.data.disks[0].path.endsWith("/hf-cache"));
  delete options.config.values["paths.hfHome"];
  check = await result(options, "storage.hf-cache"); assert.equal(check.data.disks[0].path, "ignored-env-cache");
  options.probes.diskSpace = { freeGb: 20, exists: true };
  assert.equal((await result(options, "storage.hf-cache")).status, "warn");
  assert.equal((await result(options, "storage.docker-data")).status, "warn");
  options.probes.dockerData = null;
  assert.equal((await result(options, "storage.docker-data")).status, "skip");
});

test("writable failures return mkdirs metadata without invoking any repair", async (t) => {
  const options = fixture(temporary(t));
  options.probes.writable = (directories) => directories.map((directory, index) => ({ path: directory, writable: index !== 1, ...(index === 1 ? { code: "EACCES" } : {}) }));
  const check = await result(options, "storage.writable");
  assert.equal(check.status, "fail"); assert.equal(check.fix.id, "mkdirs"); assert.equal(check.fix.risk, "auto");
  assert.equal(fs.existsSync(path.join(options.aiRoot, "logs")), false);
});

test("default model roots use BOM-safe storageReadJson, always include legacy, and never initialize records", (t) => {
  const root = temporary(t), defaults = createDefaultProbes({ aiRoot: root, env: {}, platform: "win32", value: () => "" });
  assert.deepEqual(defaults.modelRoots(), [{ id: "legacy", path: path.join(root, "models") }]);
  const directory = path.join(root, "service-entry", "data"), file = path.join(directory, "model-storage.json");
  assert.equal(fs.existsSync(file), false);
  fs.mkdirSync(directory, { recursive: true });
  const bytes = `\uFEFF${JSON.stringify({ roots: [{ id: "extra", path: path.join(root, "other-models") }] })}`;
  fs.writeFileSync(file, bytes);
  assert.equal(defaults.modelRoots().length, 2);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(fs.existsSync(path.join(root, "models")), false);
});

test("default diskSpace measures the nearest existing ancestor without creating the path", async (t) => {
  const root = temporary(t), defaults = createDefaultProbes({ aiRoot: root, env: {}, platform: "win32" });
  const missing = path.join(root, "missing", "nested");
  const measured = await defaults.diskSpace(missing);
  assert.equal(measured.measuredPath, root); assert.equal(measured.exists, false);
  assert.ok(Number.isFinite(measured.freeGb) && measured.freeGb >= 0);
  assert.equal(fs.existsSync(missing), false);
});

test("image inspection preserves missing-image evidence and does not call Docker mutation commands", async (t) => {
  const calls = [], defaults = createDefaultProbes({ aiRoot: temporary(t), env: {}, platform: "win32", value: () => "" }, { execFile(command, args, options, callback) {
    calls.push(args);
    if (args.at(-1) === "fixture/missing:one") callback(new Error("inspection failed"), "", "Error: No such image: fixture/missing:one");
    else callback(new Error("daemon offline"), "", "Cannot connect to the Docker daemon");
  } });
  const states = await defaults.images([{ image: "fixture/missing:one" }, { image: "fixture/unknown:one" }]);
  assert.equal(states[0].present, false); assert.equal(states[1].present, null);
  assert.ok(calls.every((args) => args[0] === "image" && args[1] === "inspect"));
});

test("custom storage file and separate manager legacy roots are honored, deduplicated and left unchanged", (t) => {
  const root = temporary(t), customFile = path.join(root, "custom-storage.json");
  const vllm = path.join(root, "vllm-models"), llama = path.join(root, "llama-models"), extra = path.join(root, "registered-models");
  const bytes = `\uFEFF${JSON.stringify({ roots: [{ id: "duplicate", path: vllm.toUpperCase() }, { id: "extra", path: extra }] })}`;
  fs.writeFileSync(customFile, bytes);
  const env = { MODEL_STORAGE_FILE: customFile, VLLM_MODELS_ROOT: vllm, LLAMA_MODELS_ROOT: llama };
  const defaults = createDefaultProbes({ aiRoot: root, env, platform: "win32" });
  assert.deepEqual(defaults.modelRoots(), [{ id: "legacy-vllm", path: vllm }, { id: "legacy-llama", path: llama }, { id: "extra", path: extra }]);
  assert.equal(fs.readFileSync(customFile, "utf8"), bytes);
  assert.equal(fs.existsSync(path.join(root, "service-entry", "data", "model-storage.json")), false);
  const sameRoot = createDefaultProbes({ aiRoot: root, env: { ...env, LLAMA_MODELS_ROOT: vllm.toUpperCase() }, platform: "win32" });
  assert.equal(sameRoot.modelRoots().filter((entry) => entry.path.toLowerCase() === vllm.toLowerCase()).length, 1);
  assert.equal(sameRoot.modelRoots()[0].id, "legacy");
  const caseSensitive = createDefaultProbes({ aiRoot: root, env: { MODEL_STORAGE_FILE: customFile, VLLM_MODELS_ROOT: vllm, LLAMA_MODELS_ROOT: vllm.toUpperCase() }, platform: "linux" });
  assert.equal(caseSensitive.modelRoots().filter((entry) => entry.path.toLowerCase() === vllm.toLowerCase()).length, 2);
});

test("image policy consumes registry pullPolicy for unpinned and non-stable tier-1 engines", async (t) => {
  const options = fixture(temporary(t)), registry = createEngineRegistry();
  // Descriptor arguments keep this policy evaluation pure, with no registry
  // loading or host configuration access.
  const cases = [
    { runtimeId: "vllm@unpinned", engineId: "vllm", status: "unpinned", descriptor: { tier: 1, status: "stable" } },
    { runtimeId: "sglang@nonstable", engineId: "sglang", status: "pinned", descriptor: { tier: 1, status: "experimental" } },
    { runtimeId: "template@pinned", engineId: "template", status: "pinned", descriptor: { tier: 2, status: "stable" } },
  ];
  options.probes.runtimes = cases.map((row) => ({ runtimeId: row.runtimeId, engineId: row.engineId, status: row.status, image: `fixture/${row.engineId}:one`, release: {}, pullPolicy: registry.pullPolicy(row.descriptor, row) }));
  options.probes.images = (rows) => rows.map((row) => ({ image: row.image, present: false }));
  const check = await result(options, "runtime.images");
  assert.equal(check.status, "warn");
  assert.ok(check.data.runtimes.every((row) => row.pullPolicy === "explicit"));
  assert.ok(check.data.runtimes.every((row) => row.note.includes("explicit pull")));
});

test("default Docker and Git execution receive the supplied environment without replacement", async (t) => {
  const root = temporary(t), env = { DOCKER_HOST: "fixture-docker-host", PATH: "fixture-path", FIXTURE_MARKER: "yes" }, calls = [];
  const defaults = createDefaultProbes({ aiRoot: root, env, platform: "win32", value: () => "" }, { execFile(command, args, options, callback) { calls.push({ command, args, options }); callback(null, "fixture version 2.50.0", ""); } });
  await Promise.all([defaults.dockerCli(), defaults.tool("git")]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.env === env));
  assert.equal(calls.find((call) => call.command === "git").options.env.PATH, "fixture-path");
  assert.equal(calls.find((call) => call.args.includes("--version") && call.command !== "git").options.env.DOCKER_HOST, "fixture-docker-host");
});

test("manifest snapshots honor two temporary roots concurrently without changing env or the original module cache", async (t) => {
  const roots = [temporary(t), temporary(t)], versions = ["9.1.0", "9.2.0"];
  for (let i = 0; i < roots.length; i += 1) {
    fs.mkdirSync(path.join(roots[i], "config"));
    fs.writeFileSync(path.join(roots[i], "config", "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, asOf: "2026-10-14", staleAfterDays: 90, runtimes: { vllm: { version: versions[i], engineId: "vllm", image: `fixture/root-${i}:one`, status: "unpinned" } } }));
  }
  const original = require("../runtime-manifest"), cached = original.loadRuntimeManifest();
  const cachedIds = original.listRuntimes().map((row) => row.runtimeId);
  const environment = { AI_ROOT: process.env.AI_ROOT, AI_REFERENCE_DATA_DIR: process.env.AI_REFERENCE_DATA_DIR };
  const options = roots.map((root) => {
    const configured = fixture(root);
    delete configured.probes.runtimes;
    configured.ids = ["runtime.images"];
    configured.probes.images = (rows) => rows.map((row) => ({ image: row.image, present: true }));
    return configured;
  });
  const reports = await Promise.all(options.map(runDoctor));
  for (let i = 0; i < reports.length; i += 1) {
    const runtime = reports[i].checks[0].data.runtimes.find((row) => row.runtimeId === `vllm@${versions[i]}`);
    assert.ok(runtime); assert.equal(runtime.image, `fixture/root-${i}:one`); assert.equal(runtime.pullPolicy, "explicit");
  }
  assert.equal(original.loadRuntimeManifest(), cached);
  assert.deepEqual(original.listRuntimes().map((row) => row.runtimeId), cachedIds);
  assert.deepEqual({ AI_ROOT: process.env.AI_ROOT, AI_REFERENCE_DATA_DIR: process.env.AI_REFERENCE_DATA_DIR }, environment);
  options[0].env.AI_REFERENCE_DATA_DIR = path.join(roots[1], "config");
  const redirected = await runDoctor(options[0]);
  assert.ok(redirected.checks[0].data.runtimes.some((row) => row.runtimeId === "vllm@9.2.0"));
});

test("the manifest snapshot Node child receives the scoped root and injected caller environment", async (t) => {
  const root = temporary(t), env = { AI_ROOT: "ignored-root", AI_REFERENCE_DATA_DIR: "fixture-reference-dir", PATH: "fixture-path" }, calls = [];
  const snapshot = { runtimes: [{ manifestKey: "vllm", runtimeId: "vllm@fixture", engineId: "vllm", image: "fixture/runtime:one", status: "unpinned", release: {} }], errors: [], description: {} };
  const defaults = createDefaultProbes({ aiRoot: root, env, platform: "win32" }, { execFile(command, args, options, callback) { calls.push({ command, args, options }); callback(null, JSON.stringify(snapshot), ""); } });
  const runtimes = await defaults.runtimes();
  assert.equal(runtimes[0].pullPolicy, "explicit");
  assert.equal(calls.length, 1); assert.equal(calls[0].command, process.execPath); assert.equal(calls[0].args[0], "-e");
  assert.equal(calls[0].options.env.AI_ROOT, root); assert.equal(calls[0].options.env.AI_REFERENCE_DATA_DIR, env.AI_REFERENCE_DATA_DIR); assert.equal(calls[0].options.env.PATH, env.PATH);
  assert.equal(env.AI_ROOT, "ignored-root");
});
