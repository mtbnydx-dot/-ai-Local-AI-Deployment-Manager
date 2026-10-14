"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createChecks } = require("../platform/checks/env");

const REQUIREMENTS = { node: "^22.22.2 || ^24.15.0 || >=26.0.0", python: ">=3.10" };
const PACKAGES = [
  { dir: "vllm-manager", live: true, components: ["vllm-manager"] },
  { dir: "llama-manager", live: true, components: ["llama-manager"] },
  { dir: "platform-mcp", live: true, components: ["platform-mcp"], build: { script: "build", stamp: "dist/.build-stamp.json" } },
  { dir: "search-gateway", live: false },
  { dir: ".", live: false },
];

function fixture(overrides = {}) {
  const calls = [];
  const probes = {
    nodeVersion: "v24.16.0",
    sqlite: true,
    dependencyState: { installed: true, lockHash: "lock-a", recordedHash: "lock-a", versionsMatch: null },
    mcpBuild: { exists: true, currentHash: "src-a", stampHash: "src-a", running: false },
    downloadCli: { present: true, path: "D:/fixture/venvs/download-cli/Scripts/hf.exe" },
    tool: (name) => ({ present: true, version: { python: "3.12.6", pwsh: "7.4.5", git: "2.47.0" }[name] }),
    ...overrides.probes,
  };
  const ctx = {
    aiRoot: "D:/fixture", config: {}, env: {}, platform: "win32", isWorktree: false, deep: false,
    registry: { requirements: REQUIREMENTS, packages: PACKAGES, components: [] },
    value: (_key, fallback) => fallback,
    probe: async (name, ...args) => {
      calls.push({ name, args });
      const result = probes[name];
      if (result instanceof Error) throw result;
      return typeof result === "function" ? result(...args) : result;
    },
    fix: (checkId, id, risk, zh, en, docs, extra = {}) => ({
      id, risk, label: { "zh-CN": zh, "en-US": en }, command: `platform doctor --fix=${checkId}`, docs, ...extra,
    }),
    ...overrides,
  };
  const checks = createChecks(ctx);
  return {
    checks, calls,
    run: async (id) => {
      const item = checks.find((candidate) => candidate.id === id);
      assert.ok(item, `Missing check ${id}`);
      return item.run();
    },
  };
}

test("environment checks have stable bilingual identities and construction performs no probes", async () => {
  const world = fixture();
  assert.deepEqual(world.calls, []);
  assert.deepEqual(world.checks.map(({ id }) => id), [
    "env.node-version", "env.node-sqlite", "env.deps.vllm-manager", "env.deps.llama-manager", "env.deps.platform-mcp",
    "env.mcp-dist", "env.download-cli", "env.python", "env.pwsh", "env.git",
  ]);
  for (const item of world.checks) {
    assert.equal(item.group, "env");
    assert.ok(item.title["zh-CN"]);
    assert.ok(item.title["en-US"]);
    const result = await item.run();
    assert.ok(["ok", "info"].includes(result.status), item.id);
    assert.equal(typeof result.detail, "string");
    assert.equal(typeof result.data, "object");
    assert.equal(result.fix, undefined);
  }
});

test("live roots check live package dependencies and worktrees also check test dependencies", () => {
  const world = fixture({ isWorktree: true });
  assert.deepEqual(world.checks.filter(({ id }) => id.startsWith("env.deps.")).map(({ id }) => id), [
    "env.deps.vllm-manager", "env.deps.llama-manager", "env.deps.platform-mcp", "env.deps.search-gateway", "env.deps.root",
  ]);
});

test("the Node range accepts the documented versions and rejects unsupported boundaries", async () => {
  for (const version of ["v22.22.2", "22.23.0", "24.15.0", "24.16.0", "26.0.0", "27.1.0"]) {
    const result = await fixture({ probes: { nodeVersion: version } }).run("env.node-version");
    assert.equal(result.status, "ok", version);
  }
  for (const version of ["22.22.1", "23.0.0", "24.14.9", "25.0.0", "26.0.0-rc.1", "unknown", ""]) {
    const result = await fixture({ probes: { nodeVersion: version } }).run("env.node-version");
    assert.equal(result.status, "fail", version);
    assert.equal(result.fix.risk, "manual");
    assert.deepEqual(result.actions, ["install-node"]);
    assert.match(result.detail, /24 LTS/);
  }
});

test("Node requirements are taken from the registry", async () => {
  const result = await fixture({
    registry: { requirements: { node: ">=28.0.0" }, packages: [] }, probes: { nodeVersion: "27.0.0" },
  }).run("env.node-version");
  assert.equal(result.status, "fail");
  assert.equal(result.data.requirement, ">=28.0.0");
});

test("the SQLite DatabaseSync probe has a blocking failure with a manual fix", async () => {
  const result = await fixture({ probes: { sqlite: false } }).run("env.node-sqlite");
  assert.equal(result.status, "fail");
  assert.deepEqual(result.data, { available: false });
  assert.equal(result.fix.risk, "manual");
  assert.deepEqual(result.actions, ["install-node"]);
});

test("a recorded dependency hash verifies an installed package without requiring the fallback", async () => {
  const world = fixture();
  const result = await world.run("env.deps.vllm-manager");
  assert.equal(result.status, "ok");
  assert.equal(result.data.verification, "deps-state");
  assert.equal(result.data.versionsMatch, null);
  assert.equal(world.calls[0].args[0], PACKAGES[0]);
});

test("missing dependencies fail even when a matching install was previously recorded", async () => {
  const result = await fixture({ probes: {
    dependencyState: { installed: false, lockHash: "lock-a", recordedHash: "lock-a", versionsMatch: true },
  } }).run("env.deps.vllm-manager");
  assert.equal(result.status, "fail");
  assert.equal(result.data.reason, "dependencies-missing");
  assert.equal(result.fix.id, "npm-ci");
  assert.equal(result.fix.risk, "confirm");
  assert.equal(result.fix.package, "vllm-manager");
  assert.deepEqual(result.fix.components, ["vllm-manager"]);
});

test("a changed dependency lock fails even if fallback package versions match", async () => {
  const result = await fixture({ probes: {
    dependencyState: { installed: true, lockHash: "lock-b", recordedHash: "lock-a", versionsMatch: true },
  } }).run("env.deps.llama-manager");
  assert.equal(result.status, "fail");
  assert.equal(result.data.reason, "lock-mismatch");
  assert.equal(result.data.verification, "deps-state");
  assert.deepEqual(result.actions, ["npm-ci"]);
});

test("missing dependency records use matching installed-lock versions as a fallback", async () => {
  const result = await fixture({ probes: {
    dependencyState: { installed: true, lockHash: "lock-a", recordedHash: null, versionsMatch: true },
  } }).run("env.deps.vllm-manager");
  assert.equal(result.status, "ok");
  assert.equal(result.data.verification, "installed-lock");
  assert.match(result.detail, /deps-state.json/);
});

test("missing dependency records with mismatched installed versions fail", async () => {
  const result = await fixture({ probes: {
    dependencyState: { installed: true, lockHash: "lock-a", recordedHash: null, versionsMatch: false },
  } }).run("env.deps.vllm-manager");
  assert.equal(result.status, "fail");
  assert.equal(result.data.reason, "installed-lock-mismatch");
});

test("missing dependency records and an unavailable installed lock fail closed", async () => {
  const result = await fixture({ probes: {
    dependencyState: { installed: true, lockHash: "lock-a", recordedHash: null, versionsMatch: null },
  } }).run("env.deps.vllm-manager");
  assert.equal(result.status, "fail");
  assert.equal(result.data.reason, "installed-lock-unavailable");
});

test("a missing package lock cannot be verified by stale records or fallback versions", async () => {
  for (const recordedHash of [null, "lock-a"]) {
    const result = await fixture({ probes: {
      dependencyState: { installed: true, lockHash: null, recordedHash, versionsMatch: true },
    } }).run("env.deps.vllm-manager");
    assert.equal(result.status, "fail");
    assert.equal(result.data.reason, "lock-missing");
  }
});

test("root test dependencies retain the literal package path for staged installation", async () => {
  const result = await fixture({ isWorktree: true, probes: {
    dependencyState: { installed: false, lockHash: "lock-a", recordedHash: null, versionsMatch: null },
  } }).run("env.deps.root");
  assert.equal(result.fix.package, ".");
  assert.deepEqual(result.fix.components, []);
});

test("a missing MCP entry point fails and building a stopped MCP is automatic", async () => {
  const world = fixture({ probes: { mcpBuild: { exists: false, currentHash: "src-a", stampHash: "src-a", running: false } } });
  const result = await world.run("env.mcp-dist");
  assert.equal(result.status, "fail");
  assert.equal(result.fix.id, "mcp-build");
  assert.equal(result.fix.risk, "auto");
  assert.deepEqual(result.fix.components, ["platform-mcp"]);
  assert.equal(world.calls[0].args[0], PACKAGES[2]);
});

test("a stale MCP build warns and rebuilding a running MCP needs confirmation", async () => {
  const result = await fixture({ probes: { mcpBuild: { exists: true, currentHash: "src-b", stampHash: "src-a", running: true } } }).run("env.mcp-dist");
  assert.equal(result.status, "warn");
  assert.equal(result.fix.risk, "confirm");
  assert.deepEqual(result.actions, ["mcp-build"]);
});

test("a missing MCP build stamp or unavailable input hash warns instead of passing", async () => {
  for (const state of [
    { exists: true, currentHash: "src-a", stampHash: null, running: false },
    { exists: true, currentHash: null, stampHash: null, running: false },
  ]) {
    const result = await fixture({ probes: { mcpBuild: state } }).run("env.mcp-dist");
    assert.equal(result.status, "warn");
    assert.equal(result.fix.risk, "auto");
  }
});

test("an unregistered MCP package skips without invoking its build probe", async () => {
  const world = fixture({ registry: { requirements: REQUIREMENTS, packages: [] } });
  const result = await world.run("env.mcp-dist");
  assert.equal(result.status, "skip");
  assert.deepEqual(world.calls, []);
});

test("an available download CLI passes without needing a host Python", async () => {
  const world = fixture({ probes: { tool: new Error("must not probe Python") } });
  const result = await world.run("env.download-cli");
  assert.equal(result.status, "ok");
  assert.equal(result.data.path, "D:/fixture/venvs/download-cli/Scripts/hf.exe");
  assert.equal(world.calls.length, 1);
});

test("a missing download CLI with a supported Python offers a confirmed installation", async () => {
  const result = await fixture({ probes: { downloadCli: { present: false } } }).run("env.download-cli");
  assert.equal(result.status, "warn");
  assert.equal(result.data.python.supported, true);
  assert.equal(result.fix.id, "install-download-cli");
  assert.equal(result.fix.risk, "confirm");
  assert.deepEqual(result.fix.requires, { python: ">=3.10" });
});

test("download CLI installation states the missing or old Python prerequisite", async () => {
  for (const python of [
    { present: false, version: null }, { present: true, version: "3.9.19" }, { present: true, version: null },
  ]) {
    const result = await fixture({ probes: { downloadCli: { present: false }, tool: python } }).run("env.download-cli");
    assert.equal(result.status, "warn");
    assert.equal(result.data.python.supported, false);
    assert.match(result.detail, /Install Python >=3\.10 before/);
  }
});

test("Python version parsing accepts CLI output and enforces the registry range", async () => {
  const result = await fixture({ probes: { tool: { present: true, version: "Python 3.10.0" } } }).run("env.python");
  assert.equal(result.status, "info");
  assert.equal(result.data.supported, true);
  assert.equal(result.fix, undefined);
  const stricter = await fixture({ registry: { requirements: { ...REQUIREMENTS, python: ">=3.13" }, packages: [] } }).run("env.python");
  assert.equal(stricter.status, "info");
  assert.equal(stricter.data.supported, false);
  assert.equal(stricter.fix.risk, "manual");
});

test("optional tools report presence and version as information", async () => {
  const world = fixture();
  for (const name of ["python", "pwsh", "git"]) {
    const result = await world.run(`env.${name}`);
    assert.equal(result.status, "info", name);
    assert.equal(result.data.present, true, name);
    assert.ok(result.data.version, name);
    assert.equal(result.fix, undefined, name);
  }
});

test("missing optional tools remain informational and offer manual instructions", async () => {
  const world = fixture({ probes: { tool: { present: false, version: null } } });
  for (const name of ["python", "pwsh", "git"]) {
    const result = await world.run(`env.${name}`);
    assert.equal(result.status, "info", name);
    assert.equal(result.data.present, false, name);
    assert.equal(result.fix.risk, "manual", name);
    assert.deepEqual(result.actions, [`install-${name}`]);
  }
});

test("probe failures propagate to the doctor runner without being converted into success or skip", async () => {
  for (const [id, probe] of [
    ["env.node-version", "nodeVersion"], ["env.node-sqlite", "sqlite"], ["env.deps.vllm-manager", "dependencyState"],
    ["env.mcp-dist", "mcpBuild"], ["env.download-cli", "downloadCli"], ["env.python", "tool"],
  ]) {
    const failure = new Error(`fixture probe failed: ${probe}`);
    await assert.rejects(fixture({ probes: { [probe]: failure } }).run(id), (error) => error === failure, id);
  }
});
