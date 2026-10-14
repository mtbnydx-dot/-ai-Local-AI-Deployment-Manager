// 07 §2.2 integrity of the one vendor tree, shared-public/vendor/, that the
// console (5176) and the public portal (5186) load. VENDOR.json is the single
// source: every file it lists exists with its sha256 and size, nothing else sits
// in the tree, every package keeps its LICENSE, and a vendored module imports
// only listed files by relative path. The vendoring script and the lucide
// generator are also exercised offline on temp folders.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import lucideSubset from "../../../scripts/build-lucide-subset.cjs";
import * as vendoring from "../../../scripts/vendor-browser-libs.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VENDOR_ROOT = path.join(ROOT, "shared-public", "vendor");
const MANIFEST_FILE = path.join(VENDOR_ROOT, "VENDOR.json");
const CONSOLE_UI = path.join(ROOT, "service-entry", "console", "ui");
const manifestText = fs.readFileSync(MANIFEST_FILE, "utf8");
const manifest = JSON.parse(manifestText);

// 07 C1 pins these versions; changing one is a deliberate upgrade (§16 item 1).
const PINNED = { htm: "3.1.1", lucide: "0.454.0", preact: "10.29.8", "qrcode-generator": "2.0.4", uplot: "1.6.32" };
const VENDOR_DIRS = { htm: "htm", lucide: "lucide", preact: "preact", "qrcode-generator": "qrcode", uplot: "uplot" };
const SPDX_KEYWORDS = { MIT: /\bMIT\b/, ISC: /\bISC\b/, "Apache-2.0": /Apache License[\s\S]*Version 2\.0/ };
const HOOKS_REWRITE = { from: "\"preact\"", to: "\"./preact.module.js\"" };
const MODULE_FILE = /\.(?:m?js)$/;
// The release privacy scan's forbidden file names (build-github-release.ps1).
const FORBIDDEN_NAME = /(\.pem$|\.key$|id_rsa|id_ed25519|credential|\.secret\.json$|service-api-key\.json$|\.sqlite3?(?:-(?:wal|shm))?$|\.db(?:-(?:wal|shm))?$|\.jsonl$)/i;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function listed() {
  return manifest.packages.flatMap((entry) => entry.files.map((file) => ({ entry, file, rel: `${entry.dir}/${file.path}` })));
}

function walk(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

/** Specifiers of static imports and exports, side-effect imports and import() calls. */
function importSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\b[\s\w$*{},]*?\bfrom\s*(["'])([^"'\n]*)\1/g,
    /\bimport\s*(["'])([^"'\n]*)\1/g,
    /\bimport\s*\(\s*(["'`])([^"'`\n]*)\1/g,
  ];
  return patterns.flatMap((pattern) => Array.from(source.matchAll(pattern), (match) => match[2]));
}

/** The release privacy scan's needles: user and machine names, the profile and the project root. */
function privacyNeedles() {
  const needles = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim()) needles.add(value.trim().toLowerCase());
  };
  try {
    add(os.userInfo().username);
  } catch {
    // No passwd entry for this uid; the environment names below still apply.
  }
  add(os.hostname());
  add(os.homedir());
  add(process.env.USERNAME);
  add(process.env.COMPUTERNAME);
  add(process.env.USERPROFILE);
  add(ROOT);
  return [...needles];
}

/** The privacy scan's credential patterns, read from the release build script. */
function credentialPatterns() {
  const script = fs.readFileSync(path.join(ROOT, "build-github-release.ps1"), "utf8");
  const block = /\$credentialPatterns = @\(\r?\n([\s\S]*?)\r?\n\)/.exec(script);
  assert.ok(block, "build-github-release.ps1 holds $credentialPatterns");
  return block[1].split(/\r?\n/).map((line) => line.trim().replace(/,$/, "")).filter(Boolean)
    .map((item) => new RegExp(item.replace(/^'|'$/g, "").replace(/''/g, "'"), "i"));
}

function exportName(name) {
  return name.split("-").filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

test("VENDOR.json has the schemaVersion 1 shape and the pinned packages", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(manifest.asOf)), "asOf is a date");
  assert.equal(manifest.staleAfterDays, 180);
  assert.deepEqual(manifest.packages.map((entry) => entry.name), Object.keys(PINNED));
  for (const entry of manifest.packages) {
    assert.equal(entry.version, PINNED[entry.name], `${entry.name} version`);
    assert.equal(entry.dir, `${VENDOR_DIRS[entry.name]}/${entry.version}`, `${entry.name} dir`);
    assert.ok(SPDX_KEYWORDS[entry.license], `${entry.name} has a known SPDX license, not ${entry.license}`);
    assert.ok(entry.source, `${entry.name} records its source`);
    assert.ok(entry.files.length > 0 && Object.keys(entry.entries).length > 0, `${entry.name} lists files and entries`);
  }
  // Both writers produce this canonical form, so a hand edit that drifts from it shows up here.
  assert.equal(manifestText, lucideSubset.serializeVendorManifest(manifest), "VENDOR.json is not in the canonical form the vendoring scripts write");
});

test("every listed file exists with its sha256 and size", () => {
  for (const { file, rel } of listed()) {
    const full = path.join(VENDOR_ROOT, ...rel.split("/"));
    assert.ok(fs.existsSync(full), `${rel} is missing`);
    const bytes = fs.readFileSync(full);
    assert.equal(bytes.length, file.bytes, `${rel} size`);
    assert.equal(sha256(bytes), file.sha256, `${rel} sha256; re-run the vendoring script instead of editing vendored files`);
  }
});

test("the vendor tree holds only VENDOR.json and the files it lists", () => {
  const expected = new Set(listed().map(({ rel }) => rel));
  const unlisted = walk(VENDOR_ROOT).filter((rel) => rel !== "VENDOR.json" && !expected.has(rel));
  assert.deepEqual(unlisted, [], "unlisted files in shared-public/vendor (a stale version folder?)");
});

test("each package has a non-empty LICENSE naming its SPDX license", () => {
  for (const entry of manifest.packages) {
    const licenses = entry.files.filter((file) => /^licen[cs]e/i.test(file.path));
    assert.ok(licenses.length > 0, `${entry.name} lists no LICENSE`);
    for (const license of licenses) {
      const text = fs.readFileSync(path.join(VENDOR_ROOT, ...entry.dir.split("/"), license.path), "utf8");
      assert.ok(text.trim().length > 200, `${entry.name} ${license.path} is empty or truncated`);
      assert.match(text, SPDX_KEYWORDS[entry.license], `${entry.name} ${license.path} does not name ${entry.license}`);
    }
  }
});

test("every entries and styles target is a listed file, and importMap mirrors the entries", () => {
  const files = new Set(listed().map(({ rel }) => rel));
  const importMap = {};
  for (const entry of manifest.packages) {
    for (const [specifier, file] of Object.entries(entry.entries)) {
      assert.ok(files.has(`${entry.dir}/${file}`), `${specifier} -> ${entry.dir}/${file} is not a listed file`);
      assert.match(file, MODULE_FILE, `${specifier} is served by a module file`);
      importMap[specifier] = `${entry.dir}/${file}`;
    }
  }
  for (const [name, target] of Object.entries(manifest.styles)) {
    assert.ok(files.has(target), `styles.${name} -> ${target} is not a listed file`);
    assert.match(target, /\.css$/, `styles.${name} is a stylesheet`);
  }
  assert.equal(manifest.styles.uplot, "uplot/1.6.32/uPlot.min.css");
  assert.deepEqual(manifest.importMap, importMap);
});

test("console/ui/vendor.js and vendor-lazy.js reference exactly the VENDOR.json entries", (t) => {
  const files = ["vendor.js", "vendor-lazy.js"].map((name) => path.join(CONSOLE_UI, name));
  if (!files.some((file) => fs.existsSync(file))) {
    t.skip("console/ui/vendor.js and vendor-lazy.js do not exist yet (07 CON-4 adds them)");
    return;
  }
  for (const file of files) assert.ok(fs.existsSync(file), `${path.relative(ROOT, file)} is missing`);
  const referenced = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bvendor\/([a-z0-9-]+\/\d[^/"'`\s]*\/[^"'`\s)]+)/g)) referenced.add(match[1]);
  }
  const entryTargets = manifest.packages.flatMap((entry) => Object.values(entry.entries).map((file) => `${entry.dir}/${file}`));
  const allowed = new Set([...entryTargets, ...Object.values(manifest.styles)]);
  assert.deepEqual([...referenced].filter((target) => !allowed.has(target)).sort(), [], "vendor paths that are not VENDOR.json entries or styles");
  assert.deepEqual(entryTargets.filter((target) => !referenced.has(target)).sort(), [], "VENDOR.json entries that console/ui/vendor*.js never reference");
});

test("the import scan flags bare and remote specifiers and ignores prose", () => {
  assert.deepEqual(importSpecifiers('import{options as n}from"preact";'), ["preact"]);
  assert.deepEqual(importSpecifiers("export * from 'x';\nimport a, { b } from \"https://cdn.example/x.js\";"), ["x", "https://cdn.example/x.js"]);
  assert.deepEqual(importSpecifiers('import "side-effect";\nconst m = await import("lazy");'), ["side-effect", "lazy"]);
  assert.deepEqual(importSpecifiers('import{options as n}from"./preact.module.js";'), ["./preact.module.js"]);
  // uPlot's comments say: is a "from" band edge.
  assert.deepEqual(importSpecifiers('// is a "from" band edge\nconst from = "x";\nArray.from("abc");'), []);
});

test("no vendored file has a bare or remote import, a source map comment or a CDN URL", () => {
  const files = new Set(listed().map(({ rel }) => rel));
  for (const { rel } of listed()) {
    const source = fs.readFileSync(path.join(VENDOR_ROOT, ...rel.split("/")), "utf8");
    assert.doesNotMatch(source, /sourceMappingURL/, `${rel} keeps a source map comment`);
    assert.doesNotMatch(source, /\/\/unpkg/i, `${rel} names unpkg`);
    assert.doesNotMatch(source, /\bcdn\./i, `${rel} names a CDN`);
    if (!MODULE_FILE.test(rel)) continue;
    for (const specifier of importSpecifiers(source)) {
      assert.match(specifier, /^\.\.?\//, `${rel} imports the bare or remote specifier ${JSON.stringify(specifier)}`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
      assert.ok(files.has(target), `${rel} imports ${specifier}, which is not a listed file`);
    }
  }
});

test("the hooks rewrite is applied exactly once and recorded", () => {
  const preact = manifest.packages.find((entry) => entry.name === "preact");
  const hooks = preact.files.find((file) => file.path === "hooks.module.js");
  assert.equal(hooks.from, "hooks/dist/hooks.module.js");
  assert.deepEqual(hooks.rewrites, [HOOKS_REWRITE]);
  const source = fs.readFileSync(path.join(VENDOR_ROOT, "preact", "10.29.8", "hooks.module.js"), "utf8");
  assert.equal(source.split(HOOKS_REWRITE.to).length - 1, 1, "the rewritten import appears once");
  assert.equal(source.split(HOOKS_REWRITE.from).length - 1, 0, "the bare import is gone");
  assert.deepEqual(importSpecifiers(source), ["./preact.module.js"]);
  // No other vendored file is rewritten.
  const rewritten = listed().filter(({ file }) => file.rewrites).map(({ rel }) => rel);
  assert.deepEqual(rewritten, ["preact/10.29.8/hooks.module.js"]);
});

test("no vendored file holds what the release privacy scan rejects", () => {
  const needles = privacyNeedles();
  const patterns = credentialPatterns();
  assert.ok(patterns.length > 0);
  for (const rel of walk(VENDOR_ROOT)) {
    const bytes = fs.readFileSync(path.join(VENDOR_ROOT, ...rel.split("/")));
    for (const text of [bytes.toString("utf8"), bytes.toString("latin1")]) {
      const lower = text.toLowerCase();
      // Needle values stay out of the message, like the release scan's output.
      assert.ok(!needles.some((needle) => lower.includes(needle)), `${rel} contains a user, machine or project path name; pick another patch version`);
      for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${rel} matches a credential pattern`);
    }
  }
  for (const rel of walk(VENDOR_ROOT)) {
    const name = path.posix.basename(rel);
    assert.ok(!FORBIDDEN_NAME.test(name) && !/^\.env(?:\.|$)/i.test(name), `${rel} has a file name the privacy scan forbids`);
  }
});

test("re-running build-lucide-subset.cjs writes identical bytes", () => {
  const first = lucideSubset.buildLucideSubsets(ROOT);
  const second = lucideSubset.buildLucideSubsets(ROOT);
  assert.deepEqual(second.outputs, first.outputs, "two runs over one tree differ");
  assert.deepEqual(first.outputs.map(({ file }) => path.relative(ROOT, file).split(path.sep).join("/")), [
    "shared-public/js/lucide.min.js",
    "shared-public/vendor/lucide/0.454.0/icons.js",
    "shared-public/vendor/VENDOR.json",
  ]);
  for (const { file, content } of first.outputs) {
    const current = fs.readFileSync(file, "utf8");
    assert.ok(current === content, `${path.relative(ROOT, file)} is stale; run node scripts/build-lucide-subset.cjs`);
  }
});

test("the lucide module carries Lucide's own nodes for the console's icons", async () => {
  const lucide = require(path.join(ROOT, "scripts", "vendor", "lucide.full.min.js"));
  // A data: URL loads the file as an ES module: shared-public/vendor has no
  // package.json type marker, and browsers never need one.
  const source = fs.readFileSync(path.join(VENDOR_ROOT, "lucide", "0.454.0", "icons.js"), "utf8");
  const subset = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.deepEqual(Object.keys(subset.icons), lucideSubset.consoleIconNames(ROOT));
  for (const name of lucideSubset.consoleBaseIcons) assert.ok(subset.icons[name], `base icon ${name}`);
  assert.deepEqual(subset.defaultAttributes, lucide.Activity[1]);
  for (const [name, nodes] of Object.entries(subset.icons)) {
    const spec = lucide[exportName(name)];
    assert.deepEqual(nodes, spec[2], name);
    assert.deepEqual(spec[1], subset.defaultAttributes, `${name} uses the shared <svg> attributes`);
  }
});

test("the console scan finds icon(), <Icon name>, htm's <${Icon} name> and icon props", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lucide-scan-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "service-entry", "console", "components", "probe.js");
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, [
    'const a = icon("server");',
    "const b = html`<${Icon} size=16 name=\"cpu\" />`;",
    'const c = "<Icon name=\'boxes\'>";',
    'const nav = [{ path: "/overview", icon: "layout-dashboard" }];',
    "const d = html`<${EmptyState} icon=\"inbox\" />`;",
    'const ignored = html`<input name="model-id" data-icon="not-an-icon" /><${IconButton} name="also-not">`;',
  ].join("\n"));
  const names = lucideSubset.consoleIconNames(root);
  for (const name of ["server", "cpu", "boxes", "layout-dashboard", "inbox", ...lucideSubset.consoleBaseIcons]) assert.ok(names.includes(name), name);
  for (const name of ["model-id", "not-an-icon", "also-not"]) assert.ok(!names.includes(name), name);
  assert.deepEqual(names, [...names].sort());
});

// The vendoring pipeline, offline: a fixture tarball folder stands in for npm pack.

async function writeTree(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const full = path.join(root, ...relativePath.split("/"));
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, content);
  }
}

const MIT_TEXT = "The MIT License (MIT)\n\nCopyright (c) fixture\n\nPermission is hereby granted, free of charge.\n";

function preactFixture(hooks = 'import{options as n}from"preact";export const x=n;\n//# sourceMappingURL=hooks.module.js.map\n') {
  return {
    "package/package.json": JSON.stringify({ name: "preact", version: "10.29.8", license: "MIT" }),
    "package/dist/preact.module.js": "export const options={};\n//# sourceMappingURL=preact.module.js.map\n",
    "package/hooks/dist/hooks.module.js": hooks,
    "package/LICENSE": MIT_TEXT,
  };
}

test("preparePackage strips source maps, applies the hooks rewrite once and records it", async (t) => {
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vendor-prepare-"));
  t.after(() => fs.promises.rm(work, { recursive: true, force: true }));
  await writeTree(work, preactFixture());
  const prepared = vendoring.preparePackage({ name: "preact", version: "10.29.8", packageDir: path.join(work, "package"), integrity: "sha512-fixture" });
  assert.equal(prepared.entry.dir, "preact/10.29.8");
  assert.equal(prepared.entry.source, "npm:preact@10.29.8");
  assert.equal(prepared.entry.integrity, "sha512-fixture");
  assert.deepEqual(prepared.entry.entries, { preact: "preact.module.js", "preact/hooks": "hooks.module.js" });
  const hooks = prepared.files.find((file) => file.path === "hooks.module.js").content.toString("utf8");
  assert.equal(hooks, 'import{options as n}from"./preact.module.js";export const x=n;\n');
  const record = prepared.entry.files.find((file) => file.path === "hooks.module.js");
  assert.deepEqual(record.rewrites, [HOOKS_REWRITE]);
  assert.equal(record.sha256, sha256(Buffer.from(hooks)));
  assert.equal(record.bytes, Buffer.byteLength(hooks));
  assert.equal(prepared.files.find((file) => file.path === "preact.module.js").content.toString("utf8"), "export const options={};\n");
  assert.deepEqual(prepared.entry.files.map((file) => file.path), ["preact.module.js", "hooks.module.js", "LICENSE"]);
});

test("a rewrite that misses or hits twice, a wrong tarball or license, and a missing LICENSE all stop vendoring", async (t) => {
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vendor-refuse-"));
  t.after(() => fs.promises.rm(work, { recursive: true, force: true }));
  const attempt = async (name, files, spec = { name: "preact", version: "10.29.8" }) => {
    const dir = path.join(work, name);
    await writeTree(dir, files);
    return () => vendoring.preparePackage({ ...spec, packageDir: path.join(dir, "package") });
  };
  assert.throws(await attempt("none", preactFixture("export const x=1;\n")), /must match exactly once, found 0/);
  assert.throws(await attempt("twice", preactFixture('import"preact";import{a}from"preact";\n')), /must match exactly once, found 2/);
  assert.throws(await attempt("version", preactFixture(), { name: "preact", version: "10.29.9" }), /holds preact@10\.29\.8, not preact@10\.29\.9/);
  assert.throws(await attempt("license", { ...preactFixture(), "package/package.json": JSON.stringify({ name: "preact", version: "10.29.8", license: "GPL-3.0" }) }), /declares the license "GPL-3\.0"/);
  const { "package/LICENSE": _license, ...unlicensed } = preactFixture();
  assert.throws(await attempt("unlicensed", unlicensed), /ships no LICENSE file/);
  assert.throws(() => vendoring.applyRewrites("a", [{ from: "b", to: "c" }], "probe"), /probe: the rewrite "b" -> "c" must match exactly once, found 0/);
});

test("qrcode-generator gets the MIT LICENSE its source notice names", async (t) => {
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vendor-qrcode-"));
  t.after(() => fs.promises.rm(work, { recursive: true, force: true }));
  const notice = "// Copyright (c) 2009 Kazuhiko Arase\n// Licensed under the MIT license:\nexport const qrcode = () => {};\nexport default qrcode;\n";
  await writeTree(work, {
    "package/package.json": JSON.stringify({ name: "qrcode-generator", version: "2.0.4", license: "MIT" }),
    "package/dist/qrcode.mjs": notice,
  });
  const prepared = vendoring.preparePackage({ name: "qrcode-generator", version: "2.0.4", packageDir: path.join(work, "package") });
  assert.equal(prepared.entry.dir, "qrcode/2.0.4");
  const license = prepared.files.find((file) => file.path === "LICENSE").content.toString("utf8");
  assert.equal(license, vendoring.mitLicenseText("Copyright (c) 2009 Kazuhiko Arase"));
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2009 Kazuhiko Arase\n/);
  assert.match(prepared.entry.files.find((file) => file.path === "LICENSE").generated, /tarball ships no LICENSE/);

  await fs.promises.writeFile(path.join(work, "package", "dist", "qrcode.mjs"), "export default () => {};\n");
  assert.throws(() => vendoring.preparePackage({ name: "qrcode-generator", version: "2.0.4", packageDir: path.join(work, "package") }), /no longer says/);
});

test("stripSourceMaps removes line and block source-map comments only", () => {
  assert.equal(vendoring.stripSourceMaps("a();\n//# sourceMappingURL=a.js.map\n"), "a();\n");
  assert.equal(vendoring.stripSourceMaps("a();\n//# sourceMappingURL=a.js.map"), "a();\n");
  assert.equal(vendoring.stripSourceMaps(".a{}\n/*# sourceMappingURL=a.css.map */\n"), ".a{}\n");
  assert.equal(vendoring.stripSourceMaps("const s = 'see //# notes';\n"), "const s = 'see //# notes';\n");
});

test("parseSpec takes only known packages at exact versions", () => {
  assert.deepEqual(vendoring.parseSpec("qrcode-generator@2.0.4"), { name: "qrcode-generator", version: "2.0.4" });
  assert.throws(() => vendoring.parseSpec("preact@^10.29.8"), /exact version/);
  assert.throws(() => vendoring.parseSpec("preact"), /exact version/);
  assert.throws(() => vendoring.parseSpec("react@19.0.0"), /not a vendored package/);
  assert.throws(() => vendoring.parseSpec("preact@10.29.8 && calc"), /exact version/);
});

test("main vendors through an injected pack, keeps lucide and rebuilds the import map", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vendor-main-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const fixtures = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vendor-main-pack-"));
  t.after(() => fs.promises.rm(fixtures, { recursive: true, force: true }));
  await writeTree(path.join(fixtures, "preact"), preactFixture());
  await writeTree(path.join(fixtures, "uplot"), {
    "package/package.json": JSON.stringify({ name: "uplot", version: "1.6.32", license: "MIT" }),
    "package/dist/uPlot.esm.js": "export default function uPlot() {}\n",
    "package/dist/uPlot.min.css": ".uplot{display:block}",
    "package/LICENSE": MIT_TEXT,
  });
  const packed = [];
  const pack = (spec, workDir) => {
    packed.push(spec);
    const name = spec.split("@")[0];
    fs.cpSync(path.join(fixtures, name, "package"), path.join(workDir, "package"), { recursive: true });
    return { packageDir: path.join(workDir, "package"), integrity: `sha512-${name}` };
  };
  const lucideEntry = manifest.packages.find((entry) => entry.name === "lucide");
  await writeTree(root, {
    "shared-public/vendor/VENDOR.json": lucideSubset.serializeVendorManifest({
      schemaVersion: 1, asOf: "2026-01-01", staleAfterDays: 180,
      packages: [lucideEntry, { name: "preact", version: "10.0.0", dir: "preact/10.0.0", entries: { preact: "preact.module.js" }, files: [] }],
      styles: { uplot: "uplot/1.0.0/uPlot.min.css" },
    }),
  });

  assert.equal(vendoring.main(["preact@10.29.8", "uplot@1.6.32"], { root, today: new Date(2026, 9, 14), pack }), 0);
  assert.deepEqual(packed, ["preact@10.29.8", "uplot@1.6.32"]);
  const written = JSON.parse(fs.readFileSync(path.join(root, "shared-public", "vendor", "VENDOR.json"), "utf8"));
  assert.equal(written.asOf, "2026-10-14");
  assert.deepEqual(written.packages.map((entry) => `${entry.name}@${entry.version}`), ["lucide@0.454.0", "preact@10.29.8", "uplot@1.6.32"]);
  assert.deepEqual(written.packages[0], lucideEntry);
  assert.deepEqual(written.styles, { uplot: "uplot/1.6.32/uPlot.min.css" });
  assert.deepEqual(written.importMap, {
    lucide: "lucide/0.454.0/icons.js",
    preact: "preact/10.29.8/preact.module.js",
    "preact/hooks": "preact/10.29.8/hooks.module.js",
    uplot: "uplot/1.6.32/uPlot.esm.js",
  });
  assert.equal(fs.readFileSync(path.join(root, "shared-public", "vendor", "preact", "10.29.8", "hooks.module.js"), "utf8"),
    'import{options as n}from"./preact.module.js";export const x=n;\n');

  // Usage errors return 2 and touch nothing; a failing pack writes nothing.
  assert.equal(vendoring.main(["preact@latest"], { root, pack }), 2);
  assert.equal(vendoring.main(["preact@10.29.8", "preact@10.29.8"], { root, pack }), 2);
  assert.equal(vendoring.main([], { root, pack }), 2);
  const before = fs.readFileSync(path.join(root, "shared-public", "vendor", "VENDOR.json"), "utf8");
  assert.throws(() => vendoring.main(["htm@3.1.1"], { root, pack: () => { throw new Error("offline"); } }), /offline/);
  assert.equal(fs.readFileSync(path.join(root, "shared-public", "vendor", "VENDOR.json"), "utf8"), before);
  assert.ok(!fs.existsSync(path.join(root, "shared-public", "vendor", "htm")));
});
