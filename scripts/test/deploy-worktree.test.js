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

// Evaluate only the shipped bridge and its failure handling, never a deploy.
// The native child is a temporary Node CLI, including real stderr output.
for (const nativeExitCode of [0, 23]) {
  test(`Windows PowerShell 5 post-deploy tolerates stderr and preserves native exit ${nativeExitCode}`, { skip: process.platform !== "win32" }, (t) => {
    const functionStart = text.indexOf("function Invoke-PostDeploy {");
    const functionEnd = text.indexOf("\n}\n", functionStart) + 3;
    assert.ok(functionStart > 0 && functionEnd > functionStart);
    const callStart = text.indexOf("$postDeployCode = Invoke-PostDeploy -CliRoot $liveFull");
    const callEnd = text.indexOf("\nif ($Restart -eq 'none')", callStart);
    assert.ok(callStart > 0 && callEnd > callStart);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "post-deploy ps5-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "platformctl.js"), [
      'console.error("fixture MCP build progress on stderr");',
      'console.log("FIXTURE_CHILD:" + JSON.stringify({args:process.argv.slice(2),aiRoot:process.env.AI_ROOT}));',
      'process.exit(Number(process.env.FIXTURE_EXIT_CODE));',
    ].join("\n"));
    const harness = path.join(root, "bridge-test.ps1");
    // A captured deploy log promotes native stderr into PS5 error records.
    fs.writeFileSync(harness, [
      "$ErrorActionPreference = 'Stop'",
      "$Restart = 'none'",
      "$NoPrune = $true",
      "$env:AI_ROOT = 'fixture-original-root'",
      "$env:NODE_EXE = $env:FIXTURE_NODE",
      "$liveFull = $env:FIXTURE_ROOT",
      "$manifestPath = Join-Path $liveFull 'deployment-manifest.json'",
      "$backupRoot = Join-Path $liveFull 'no-backup'",
      text.slice(functionStart, functionEnd),
      "$failure = $null",
      "try {",
      ". {",
      text.slice(callStart, callEnd),
      "} 2>&1 | Out-Host",
      "} catch { $failure = $_.Exception.Message }",
      "[pscustomobject]@{psMajor=$PSVersionTable.PSVersion.Major;psEdition=$PSVersionTable.PSEdition;nativeCode=$postDeployCode;preference=[string]$ErrorActionPreference;aiRoot=$env:AI_ROOT;failure=$failure} | ConvertTo-Json -Compress | ForEach-Object { Write-Output ('FIXTURE_RESULT:' + $_) }",
      "if ($failure) { exit 1 }",
    ].join("\n"));
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath")),
      FIXTURE_ROOT: root, FIXTURE_NODE: process.execPath, FIXTURE_EXIT_CODE: String(nativeExitCode),
    };
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], { env, encoding: "utf8", windowsHide: true, timeout: 60000 });
    assert.ifError(result.error);
    const read = (prefix) => JSON.parse(result.stdout.split(/\r?\n/).find((line) => line.startsWith(prefix))?.slice(prefix.length) || "null");
    const report = read("FIXTURE_RESULT:");
    assert.ok(report, result.stderr || result.stdout);
    assert.equal(report.psMajor, 5, "this regression runs in Windows PowerShell, not pwsh");
    assert.equal(report.psEdition, "Desktop");
    assert.equal(report.nativeCode, nativeExitCode, result.stderr);
    assert.equal(report.preference, "Stop");
    assert.equal(report.aiRoot, "fixture-original-root");
    const child = read("FIXTURE_CHILD:");
    assert.equal(child.aiRoot, root);
    assert.deepEqual(child.args, ["post-deploy", "--manifest", path.join(root, "deployment-manifest.json"), "--restart", "none", "--no-prune"]);
    assert.match(result.stdout + result.stderr, /fixture MCP build progress on stderr/);
    assert.equal(result.status, nativeExitCode === 0 ? 0 : 1, result.stderr);
    if (nativeExitCode === 0) assert.equal(report.failure, null);
    else assert.match(report.failure, /Files are deployed; post-steps failed: unknown; run: platform post-deploy --manifest/);
  });
}

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
  // Windows PowerShell 5.1 below a pwsh 7 session must not inherit pwsh's PSModulePath: it then
  // cannot load its own utility module and Get-FileHash is "not recognized".
  const psEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath")), FIXTURE_ROOT: root };
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
    input: script, encoding: "utf8", env: psEnv, windowsHide: true,
  });
  if (ps.error || ps.status !== 0) {
    // Windows PowerShell 5.1 has no -AsArray; fall back to the default shape.
    const fallback = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      input: `$ErrorActionPreference = 'Stop'\n${driftFunction}\n@(Get-LiveDrift -LiveRootPath $env:FIXTURE_ROOT) | ConvertTo-Json -Compress`,
      encoding: "utf8", env: psEnv, windowsHide: true,
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
