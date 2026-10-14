"use strict";

const PINNED_IMAGE = `fixture/runtime@sha256:${"a".repeat(64)}`;
const EXPERIMENTAL_IMAGE = "fixture/experimental:one";
const LOCAL_IMAGE = "fixture/local:one";
const AT = "2026-10-14T08:00:00.000Z";

function fixture(root) {
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
  };
  return { aiRoot: root, env: {}, platform: "win32", config: { values: { "paths.hfHome": `${root}/hf-cache` } }, registry, probes, now: () => new Date(AT), getSecrets: () => [] };
}

function normalized(report, root) {
  // Golden fixtures never contain a host path, and normalize native slashes.
  const serialized = JSON.stringify(report);
  const roots = [...new Set([root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")])];
  let output = serialized;
  for (const value of roots) output = output.split(JSON.stringify(value).slice(1, -1)).join("<AI_ROOT>");
  return JSON.parse(output.replace(/\\\\/g, "/"));
}

module.exports = { fixture, normalized, PINNED_IMAGE, EXPERIMENTAL_IMAGE, LOCAL_IMAGE, AT };
