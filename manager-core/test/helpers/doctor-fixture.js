"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readNightly } = require("../../platform/schedules");

const PINNED_IMAGE = `fixture/runtime@sha256:${"a".repeat(64)}`;
const EXPERIMENTAL_IMAGE = "fixture/experimental:one";
const LOCAL_IMAGE = "fixture/local:one";
const AT = "2026-10-14T08:00:00.000Z";

const BOM = "﻿";

// Windows PowerShell 5.1 writes BOM-prefixed UTF-8 with CRLF and a 7-digit
// fractional second; the readers must cope (V14). 30 nights, all failing.
function writeNightlyFixtures(root, { nights = 30, ok = false } = {}) {
  const directory = path.join(root, "artifacts", "nightly");
  fs.mkdirSync(directory, { recursive: true });
  const newest = Date.UTC(2026, 9, 14, 3, 0, 0);
  for (let i = 0; i < nights; i += 1) {
    const started = new Date(newest - i * 86400000);
    const stamp = `${started.toISOString().slice(0, 10).replace(/-/g, "")}-0300`;
    const body = `${BOM}${JSON.stringify({ startedAt: started.toISOString().replace("Z", "+00:00"), finishedAt: new Date(started.getTime() + 300000).toISOString().replace(".000Z", ".0000000+00:00"), root: "<AI_ROOT>", ok, passed: ok ? 7 : 5, failed: ok ? 0 : 2, steps: [] }, null, 2).replace(/\n/g, "\r\n")}`;
    fs.writeFileSync(path.join(directory, `${stamp}.json`), body);
    if (i === 0) fs.writeFileSync(path.join(directory, "latest.json"), body);
  }
}

function fixture(root) {
  writeNightlyFixtures(root);
  const registry = {
    requirements: { node: "^22.22.2 || ^24.15.0 || >=26.0.0", python: ">=3.10" },
    packages: [
      { dir: "vllm-manager", live: true, components: ["vllm-manager"] },
      { dir: "platform-mcp", live: true, components: ["platform-mcp"], build: { inputs: ["src/**/*.ts", "package.json"], stamp: "dist/.build-stamp.json" } },
      { dir: ".", live: false, components: [] },
    ],
    components: [],
  };
  const runtimes = [
    { runtimeId: "vllm@1.0.0", engineId: "vllm", image: PINNED_IMAGE, status: "pinned", pullPolicy: "auto", release: { minimumDriverVersions: { win32: "580.88", linux: "580.65.06" }, minimumComputeCapability: "7.5" } },
    { runtimeId: "sglang@experimental", engineId: "sglang", image: EXPERIMENTAL_IMAGE, status: "experimental", pullPolicy: "explicit", release: { minimumComputeCapability: "12.0" } },
    { runtimeId: "sglang@local", engineId: "sglang", image: LOCAL_IMAGE, status: "pinned", pullPolicy: "auto", localBuild: true, release: { minimumComputeCapability: "12.0", build: { script: "scripts/rebuild-fixture.ps1" } } },
    { runtimeId: "vllm@retired", engineId: "vllm", image: "fixture/retired:one", status: "retired", release: { retired: true, minimumDriverVersions: { win32: "999.99" } } },
  ];
  const probes = {
    isWorktree: false, nodeVersion: "v24.16.0", sqlite: true,
    dependencyState: () => ({ installed: true, lockHash: "lock-fixture", recordedHash: "lock-fixture", versionsMatch: true }),
    mcpBuild: { exists: true, currentHash: "build-fixture", stampHash: "build-fixture", running: false },
    downloadCli: { present: false }, tool: (name) => ({ present: true, version: { python: "3.11.9", pwsh: "7.5.0", git: "2.50.0" }[name] }),
    dockerCli: { present: true, version: "Docker version fixture" }, dockerDaemon: { ready: false },
    wsl: { distributions: [{ name: "docker-desktop", state: "Running", version: 2 }] },
    wslConfig: { exists: true, memoryGb: 64, swapGb: 0, totalMemoryGb: 128 },
    nvidia: { gpus: [{ name: "Fixture GPU", driverVersion: "581.15", computeCapability: "12.0", memoryMb: 98304 }] },
    runtimes,
    images: (rows) => rows.map((row) => ({ image: row.image, present: row.image !== PINNED_IMAGE })),
    gpuDocker: { ok: true },
    modelRoots: [{ id: "legacy", path: `${root}/models` }],
    dockerData: `${root}/docker-data`,
    diskSpace: (directory) => ({ path: directory, measuredPath: directory, exists: true, freeGb: 128, totalGb: 512 }),
    writable: (directories) => directories.map((directory) => ({ path: directory, writable: true })),
    // network
    resolvedComponents: [
      { id: "entry", kind: "node", cwd: `${root}/service-entry`, command: "node.exe", args: ["server.js"], ports: [{ name: "admin", port: 5176, bind: "127.0.0.1", enabled: true }] },
      { id: "service-entry-public", kind: "listener", parent: "entry", ports: [{ name: "public", port: 5186, bind: "127.0.0.1", enabled: true }] },
      { id: "vllm-manager", kind: "node", cwd: `${root}/vllm-manager`, command: "node.exe", args: ["server.js"], ports: [{ name: "api", port: 5177, bind: "127.0.0.1", enabled: true }] },
      { id: "llama-manager", kind: "node", cwd: `${root}/llama-manager`, command: "node.exe", args: ["server.js"], ports: [{ name: "api", port: 5178, bind: "127.0.0.1", enabled: true }] },
      { id: "search-gateway", kind: "compose", ports: [{ name: "http", port: 5180, bind: "127.0.0.1", enabled: true }] },
      { id: "legacy-claude-proxy", kind: "external", detectOnly: true, ports: [{ name: "http", port: 8001, bind: "127.0.0.1", enabled: true }] },
    ],
    listeners: [{ protocol: "tcp", address: "127.0.0.1", port: 5177, pid: 4101 }],
    processes: [{ pid: 4101, exe: "C:/Program Files/nodejs/node.exe", commandLine: `node.exe ${root}/vllm-manager/server.js`, processCreatedAt: "2026-10-14T06:00:00.000Z" }],
    identityRecords: [{ id: "vllm-manager", pid: 4101, processCreatedAt: "2026-10-14T06:00:00.000Z", exe: "C:/Program Files/nodejs/node.exe" }],
    imageNames: {}, runKeys: {}, firewall: [], userEnvNames: [], secretNames: [],
    // security
    keySummary: { available: true, active: 1, total: 1 },
    secretStores: [{ namespace: "runtime.vllm", file: ".runtime/secrets/runtime.vllm.json", protection: "dpapi-user", entries: 2, parse: "ok", unprotect: "ok", acl: { checked: true, wide: false } }],
    plaintextSecrets: [{ path: "vllm-manager/logs/runtime-api-keys.json", kind: "runtime-keys", migratable: true }],
    // ops
    supervisor: { running: false }, tasks: [],
    nightly: () => readNightly(root, { now: () => new Date(AT) }),
    backup: { available: true, stamp: "20261014-0200", at: "2026-10-14T02:00:00.000Z", ageHours: 6, format: "local-ai-platform-backup-v2", formatOk: true, files: 120, warnings: 0 },
    drift: [{ path: "service-entry/server.js", deployedSha256: "a".repeat(64), liveSha256: "b".repeat(64) }],
    version: { source: "version.json", version: "0.2.0-git-abcdef012345", shortCommit: "abcdef012345", branch: "main", deployedAt: "2026-10-13T12:00:00.000Z" },
    newerCommits: { available: true, behind: 2, head: "c".repeat(40), deployed: "d".repeat(40), ref: "refs/heads/main", fetched: false },
    logsSize: { bytes: 4096, files: 3, truncated: false },
  };
  return { aiRoot: root, env: {}, platform: "win32", config: { values: { "paths.hfHome": `${root}/hf-cache`, "listeners.admin.lan": false, "listeners.admin.port": 5176, "listeners.public.lan": false, "listeners.public.port": 5186, "listeners.public.baseUrl": "", "exposure.requireApiKey": "auto", "managers.vllm.host": "127.0.0.1", "managers.vllm.port": 5177, "managers.llama.host": "127.0.0.1", "managers.llama.port": 5178, "search.upstreamBaseUrl": "http://host.docker.internal:5186/v1" }, sources: {}, errors: [], warnings: [] }, registry, probes, now: () => new Date(AT), getSecrets: () => [] };
}

function normalized(report, root) {
  // Golden fixtures never contain a host path, and normalize native slashes.
  const serialized = JSON.stringify(report);
  const roots = [...new Set([root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")])];
  let output = serialized;
  for (const value of roots) output = output.split(JSON.stringify(value).slice(1, -1)).join("<AI_ROOT>");
  return JSON.parse(output.replace(/\\\\/g, "/"));
}

module.exports = { fixture, normalized, writeNightlyFixtures, PINNED_IMAGE, EXPERIMENTAL_IMAGE, LOCAL_IMAGE, AT };
