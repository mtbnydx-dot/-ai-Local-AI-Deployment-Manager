#!/usr/bin/env node
"use strict";
// Fails when a *.cmd or *.ps1 file starts with a UTF-8 BOM or has a line that
// ends in a bare LF. cmd.exe reads a BOM as part of the first command (the
// first line fails as an unknown command), and LF-only batch files break
// labels and ^ continuations. The repository stores these files as CRLF
// through .gitattributes, so the check reads the working-tree bytes.
//
//   node scripts/check-script-encoding.js          the repository this script lives in
//   node scripts/check-script-encoding.js <dir>    another tree (a temp dir works too)
//
// Inside a git work tree the files come from `git ls-files` (tracked plus
// untracked-but-not-ignored, so a new script is caught before its commit).
// An explicit <dir> outside git is walked. The default root outside git (a
// deployed live root or an extracted release) is skipped with exit code 2,
// because it also holds untracked machine-local scripts this check does not
// own; test-all reports that as a skipped step.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const SCRIPT_PATTERN = /\.(cmd|ps1)$/i;
const SKIP_DIRECTORIES = new Set(["node_modules", ".git"]);
// Existing TTS scripts saved with a BOM. They carry Chinese text and are run
// by Windows PowerShell as well as pwsh, so the BOM stays until they are
// rewritten as ASCII. New files must not be added here.
const ALLOW_BOM = new Set([
  "tts-platform/scripts/start_all.ps1",
  "tts-platform/scripts/start_gateway.ps1",
  "tts-platform/scripts/status.ps1",
]);

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function gitScriptFiles(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const files = new Set(result.stdout.split("\0").filter((file) => SCRIPT_PATTERN.test(file)));
  return Array.from(files).sort();
}

function walkScriptFiles(root) {
  const files = [];
  const pending = [""];
  while (pending.length) {
    const relativeDir = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true })) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) pending.push(relativePath);
      } else if (entry.isFile() && SCRIPT_PATTERN.test(entry.name)) {
        files.push(toPosix(relativePath));
      }
    }
  }
  return files.sort();
}

function inspectBuffer(buffer) {
  const problems = [];
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    problems.push({ kind: "bom", message: "starts with a UTF-8 BOM" });
  }
  let line = 1;
  let firstLfLine = 0;
  let lfOnly = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    if (index === 0 || buffer[index - 1] !== 0x0d) {
      lfOnly += 1;
      if (!firstLfLine) firstLfLine = line;
    }
    line += 1;
  }
  if (lfOnly) {
    problems.push({ kind: "lf", message: `${lfOnly} line(s) end in LF without CR (first: line ${firstLfLine})` });
  }
  return problems;
}

/** Checks repository-relative script paths under root. Missing files (deleted but still in the index) are skipped. */
function checkScriptEncoding(files, { root = DEFAULT_ROOT, allowBom = ALLOW_BOM } = {}) {
  const problems = [];
  let checked = 0;
  for (const file of files) {
    const fullPath = path.join(root, file);
    let buffer;
    try {
      buffer = fs.readFileSync(fullPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    checked += 1;
    for (const problem of inspectBuffer(buffer)) {
      if (problem.kind === "bom" && allowBom.has(toPosix(file))) continue;
      problems.push({ file: toPosix(file), ...problem });
    }
  }
  return { checked, problems };
}

function main(argv) {
  const explicitRoot = argv[0] ? path.resolve(argv[0]) : "";
  const root = explicitRoot || DEFAULT_ROOT;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    return 1;
  }
  let files = gitScriptFiles(root);
  let source = "git";
  if (!files) {
    if (!explicitRoot) {
      console.log("Script encoding check skipped: this tree is not a git work tree, so tracked scripts cannot be told apart from local ones.");
      return 2;
    }
    files = walkScriptFiles(root);
    source = "directory walk";
  }
  const { checked, problems } = checkScriptEncoding(files, { root });
  for (const problem of problems) console.log(`  ${problem.file}: ${problem.message}`);
  console.log(`Checked ${checked} .cmd/.ps1 file(s) (${source}); ${problems.length} problem(s).`);
  if (problems.length) {
    console.log("Fix: save the file as UTF-8 without a BOM and with CRLF line endings.");
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { ALLOW_BOM, checkScriptEncoding, inspectBuffer, walkScriptFiles };
