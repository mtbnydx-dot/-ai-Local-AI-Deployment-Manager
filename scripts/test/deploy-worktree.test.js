"use strict";

// scripts/deploy-worktree.ps1 (06 §9.3, OPS-11a): the new parameters, the
// post-deploy hand-off, and the promise that deployment-manifest.json keeps its
// shape so Get-LiveDrift (PowerShell 5.1) and the Node port still read it.
// The script itself is never run against a real live root here.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "deploy-worktree.ps1");
const text = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
const steps = require("../../manager-core/platform/deploy-steps");
const versionApi = require("../../manager-core/platform/version");

const MANIFEST_KEYS = ["schemaVersion", "deployedAt", "sourceWorktree", "branch", "commit", "liveRoot", "archive", "archiveSha256", "includeLocalExtensions", "liveDrift", "files"];

function orderedBlocks(source, variable) {
  const blocks = [];
  const pattern = new RegExp(`\\$${variable} = \\[ordered\\]@\\{\\n([\\s\\S]*?)\\n\\}`, "g");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    blocks.push(Array.from(match[1].matchAll(/^\s+([A-Za-z0-9]+) = /gm), (entry) => entry[1]));
  }
  return blocks;
}

test("deploy-worktree.ps1 declares -Restart, -NoPrune and -SkipPostDeploy", () => {
  assert.match(text, /\[ValidateSet\('none', 'changed', 'all'\)\]\n\s+\[string\]\$Restart = 'none'/);
  assert.match(text, /\[switch\]\$NoPrune/);
  assert.match(text, /\[switch\]\$SkipPostDeploy/);
  // The existing switches are untouched.
  for (const name of ["LiveRoot", "Version", "SkipTests", "AllowDirty", "IncludeLocalExtensions", "AllowLiveDrift", "DriftOnly"]) {
    assert.match(text, new RegExp(`\\$${name}\\b`));
  }
  assert.match(text, /SupportsShouldProcess = \$true, ConfirmImpact = 'High'/);
});

test("the manifest keeps schemaVersion 1 and its key order; the -WhatIf plan manifest has the same shape", () => {
  const blocks = orderedBlocks(text, "(?:manifest|planManifest)");
  assert.equal(blocks.length, 2, "the real manifest and the -WhatIf plan manifest");
  for (const keys of blocks) assert.deepEqual(keys, MANIFEST_KEYS);
  assert.match(text, /\$manifest \| ConvertTo-Json -Depth 6 \| Set-Content -LiteralPath \$manifestPath -Encoding UTF8/);
  assert.match(text, /schemaVersion = 1/);
});

test("post-deploy runs from the newly deployed CLI after the manifest is written, and -WhatIf only previews", () => {
  const manifestWrite = text.indexOf("Set-Content -LiteralPath $manifestPath -Encoding UTF8");
  const realCall = text.indexOf("Invoke-PostDeploy -CliRoot $liveFull -AiRoot $liveFull -ManifestPath $manifestPath");
  assert.ok(manifestWrite > 0 && realCall > manifestWrite, "the real call comes after the manifest write");
  assert.match(text, /Invoke-PostDeploy -CliRoot \$sourceRoot -AiRoot \$liveFull -ManifestPath \$planPath -Preview/);
  assert.match(text, /'post-deploy', '--manifest', \$ManifestPath, '--restart', \$Restart/);
  assert.match(text, /if \(\$NoPrune\) \{ \$cliArgs \+= '--no-prune' \}/);
  assert.match(text, /if \(\$Preview\) \{ \$cliArgs \+= '--dry-run' \}/);
  assert.match(text, /\$env:AI_ROOT = \$AiRoot/);
  assert.match(text, /Files are deployed; post-steps failed: \{0\}; run: platform post-deploy --manifest/);
  // -SkipPostDeploy copies the files and nothing else.
  assert.match(text, /if \(\$SkipPostDeploy\) \{\n\s+Write-Host 'Files deployed\. Post-deploy steps were skipped/);
  // The preview never writes into the live root: the plan manifest is in the staging folder.
  assert.match(text, /\$planPath = Join-Path \$releaseRoot 'plan-deployment-manifest\.json'/);
});

// Get-LiveDrift as shipped, evaluated by Windows PowerShell on a manifest that
// post-deploy has just processed.
test("Get-LiveDrift still parses the manifest after post-deploy", { skip: process.platform !== "win32" }, async (t) => {
  const start = text.indexOf("function Get-LiveDrift {");
  assert.ok(start > 0);
  const end = text.indexOf("\n}\n", start) + 3;
  const driftFunction = text.slice(start, end);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const put = (rel, content) => {
    const file = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  put("scripts/kept.js", "kept");
  put("scripts/edited.js", "edited by hand");
  put("scripts/stale.js", "stale");
  const dir = path.join(root, "artifacts", "worktree-deploy-backups", "20261014-100000-bbbbbbbbbbbb");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "deployment-manifest.json");
  const record = (p, content, action) => ({ path: p, kind: "release", action, beforeSha256: null, afterSha256: sha(content) });
  const manifest = {
    schemaVersion: 1, deployedAt: "2026-10-14T10:00:00.1234567+08:00", sourceWorktree: "<SOURCE>", branch: "feature/example",
    commit: "c0146a7d2f1e5b9a8c7d6e5f4a3b2c1d0e9f8a7b", liveRoot: root, archive: "<RELEASE>\\local-model-service-platform-v0.2.0-git-c0146a7d2f1e.zip",
    archiveSha256: "a".repeat(64), includeLocalExtensions: false, liveDrift: [],
    files: [record("scripts\\kept.js", "kept", "created"), record("scripts\\edited.js", "edited", "created")],
  };
  fs.writeFileSync(file, `﻿${JSON.stringify(manifest, null, 4).replace(/\n/g, "\r\n")}`);
  const bytes = fs.readFileSync(file);

  const result = await steps.executePostDeploy({
    aiRoot: root, manifest, manifestFile: file, registry: { packages: [], components: [] },
    allManifests: versionApi.readDeploymentManifests(root), npm: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(result.ok, true, JSON.stringify(result.failed));
  assert.ok(fs.readFileSync(file).equals(bytes), "post-deploy never rewrites the manifest");

  const script = `$ErrorActionPreference = 'Stop'\n${driftFunction}\n$drift = @(Get-LiveDrift -LiveRootPath $env:FIXTURE_ROOT)\n$drift | ConvertTo-Json -Compress -AsArray`;
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
    input: script, encoding: "utf8", env: { ...process.env, FIXTURE_ROOT: root }, windowsHide: true,
  });
  if (ps.error || ps.status !== 0) {
    // Windows PowerShell 5.1 has no -AsArray; fall back to the default shape.
    const fallback = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      input: `$ErrorActionPreference = 'Stop'\n${driftFunction}\n@(Get-LiveDrift -LiveRootPath $env:FIXTURE_ROOT) | ConvertTo-Json -Compress`,
      encoding: "utf8", env: { ...process.env, FIXTURE_ROOT: root }, windowsHide: true,
    });
    assert.equal(fallback.status, 0, fallback.stderr);
    ps.stdout = fallback.stdout;
  }
  const parsed = JSON.parse(ps.stdout);
  const drift = Array.isArray(parsed) ? parsed : [parsed];
  assert.deepEqual(drift.map((item) => item.path), ["scripts\\edited.js"]);
  assert.equal(drift[0].deployedSha256, sha("edited"));
  assert.equal(drift[0].liveSha256, sha("edited by hand"));
  // The Node port agrees.
  const node = versionApi.computeLiveDrift(root);
  assert.deepEqual(node.map((item) => item.path), ["scripts\\edited.js"]);
});
