#!/usr/bin/env node
// Vendors the browser libraries of the console and the public portal into the
// one vendor tree, shared-public/vendor/<dir>/<version>/ (00 §9.16, 07 §2.2).
// Dev-only: install and test never run it. An engineer with network access runs
//
//   node scripts/vendor-browser-libs.mjs preact@10.29.8 htm@3.1.1 uplot@1.6.32 qrcode-generator@2.0.4
//
// For each spec it runs npm pack in a new empty temp folder and extracts the
// tarball with tar, so no package code ever runs. It copies the files PACKAGES
// lists plus LICENSE*, strips source-map comments, applies the listed
// exact-match rewrites (each must hit exactly once) and records the
// post-processing sha256 and size in shared-public/vendor/VENDOR.json. Nothing
// is written until every spec has been packed and checked. The generated lucide
// subset is listed in VENDOR.json too; scripts/build-lucide-subset.cjs writes it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lucideSubset from "./build-lucide-subset.cjs";

const { fileRecord, readVendorManifest, serializeVendorManifest } = lucideSubset;

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STALE_AFTER_DAYS = 180;
const SPEC_PATTERN = /^((?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+)$/;
const LICENSE_FILE = /^licen[cs]e(?:[.-].*)?$/i;
const USAGE = "Usage: node scripts/vendor-browser-libs.mjs <package>@<exact version> ...\n" +
  "Example: node scripts/vendor-browser-libs.mjs preact@10.29.8 htm@3.1.1 uplot@1.6.32 qrcode-generator@2.0.4";

/**
 * What to take from each tarball. `dir` is the folder under shared-public/vendor/
 * (the version is appended), `entries` maps a module specifier to the file that
 * serves it and `styles` names stylesheets for VENDOR.json's top-level styles.
 */
export const PACKAGES = {
  preact: {
    dir: "preact",
    license: "MIT",
    entries: { preact: "preact.module.js", "preact/hooks": "hooks.module.js" },
    files: [
      { path: "preact.module.js", from: "dist/preact.module.js" },
      // The one bare import in the tree. The console loads modules without an
      // import map (07 C1b), so the hooks import the core file by relative path.
      { path: "hooks.module.js", from: "hooks/dist/hooks.module.js", rewrites: [{ from: "\"preact\"", to: "\"./preact.module.js\"" }] },
    ],
  },
  htm: {
    dir: "htm",
    license: "Apache-2.0",
    entries: { htm: "htm.module.js" },
    files: [{ path: "htm.module.js", from: "dist/htm.module.js" }],
  },
  uplot: {
    dir: "uplot",
    license: "MIT",
    entries: { uplot: "uPlot.esm.js" },
    styles: { uplot: "uPlot.min.css" },
    files: [
      { path: "uPlot.esm.js", from: "dist/uPlot.esm.js" },
      { path: "uPlot.min.css", from: "dist/uPlot.min.css" },
    ],
  },
  "qrcode-generator": {
    dir: "qrcode",
    license: "MIT",
    entries: { "qrcode-generator": "qrcode.mjs" },
    files: [{ path: "qrcode.mjs", from: "dist/qrcode.mjs" }],
    // The 2.0.4 tarball ships no LICENSE file; the source header carries the
    // copyright and the MIT notice, so LICENSE is the MIT text for that notice.
    licenseFallback: { notice: "dist/qrcode.mjs", copyright: "Copyright (c) 2009 Kazuhiko Arase", mustContain: "Licensed under the MIT license" },
  },
};

class UsageError extends Error {}

/** "name@1.2.3" -> { name, version }; only PACKAGES names and exact versions. */
export function parseSpec(spec) {
  const match = SPEC_PATTERN.exec(String(spec || ""));
  if (!match) throw new UsageError(`"${spec}" is not <package>@<exact version>, for example preact@10.29.8`);
  if (!Object.hasOwn(PACKAGES, match[1])) {
    throw new UsageError(`${match[1]} is not a vendored package; known packages: ${Object.keys(PACKAGES).join(", ")}`);
  }
  return { name: match[1], version: match[2] };
}

/** Removes //# sourceMappingURL= lines and /*# sourceMappingURL= *\/ comments. */
export function stripSourceMaps(text) {
  return text
    .replace(/^[ \t]*\/\/[#@][ \t]*sourceMappingURL=.*(?:\r?\n|$)/gm, "")
    .replace(/[ \t]*\/\*[#@][ \t]*sourceMappingURL=[^*]*\*\/[ \t]*(?:\r?\n)?/g, "");
}

/** Applies exact-match rewrites; each `from` must occur exactly once. */
export function applyRewrites(text, rewrites = [], label = "file") {
  let result = text;
  for (const rewrite of rewrites) {
    const hits = result.split(rewrite.from).length - 1;
    if (hits !== 1) {
      throw new Error(`${label}: the rewrite ${JSON.stringify(rewrite.from)} -> ${JSON.stringify(rewrite.to)} must match exactly once, found ${hits}`);
    }
    result = result.replace(rewrite.from, () => rewrite.to);
  }
  return result;
}

export function mitLicenseText(copyright) {
  return [
    "MIT License",
    "",
    copyright,
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    "of this software and associated documentation files (the \"Software\"), to deal",
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
    "",
  ].join("\n");
}

/** A regular file inside the extracted package; links and escapes are refused. */
function readPackageFile(packageDir, relativePath) {
  const base = path.resolve(packageDir);
  const full = path.resolve(base, ...relativePath.split("/"));
  if (!full.startsWith(base + path.sep)) throw new Error(`${relativePath} points outside the package`);
  if (!fs.existsSync(full)) throw new Error(`the tarball has no ${relativePath}`);
  if (!fs.lstatSync(full).isFile()) throw new Error(`${relativePath} in the tarball is not a regular file`);
  return fs.readFileSync(full);
}

/**
 * Turns one extracted package (the tarball's package/ folder) into its
 * VENDOR.json entry and the bytes to write under <dir>/<version>/. Writes nothing.
 */
export function preparePackage({ name, version, packageDir, integrity }) {
  const config = PACKAGES[name];
  if (!config) throw new UsageError(`${name} is not a vendored package`);
  const label = `${name}@${version}`;
  const pkg = JSON.parse(readPackageFile(packageDir, "package.json").toString("utf8"));
  if (pkg.name !== name || pkg.version !== version) throw new Error(`the tarball holds ${pkg.name}@${pkg.version}, not ${label}`);
  if (pkg.license !== config.license) {
    throw new Error(`${label} declares the license ${JSON.stringify(pkg.license)}, not ${config.license}; review it before vendoring`);
  }

  const files = config.files.map((file) => {
    const text = applyRewrites(stripSourceMaps(readPackageFile(packageDir, file.from).toString("utf8")), file.rewrites, `${label} ${file.from}`);
    return { path: file.path, content: Buffer.from(text, "utf8"), record: { from: file.from, ...(file.rewrites ? { rewrites: file.rewrites } : {}) } };
  });
  const licenses = fs.readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const license of licenses) files.push({ path: license, content: readPackageFile(packageDir, license), record: { from: license } });
  if (!licenses.length) {
    const fallback = config.licenseFallback;
    if (!fallback) throw new Error(`${label} ships no LICENSE file`);
    const notice = readPackageFile(packageDir, fallback.notice).toString("utf8");
    for (const needle of [fallback.copyright, fallback.mustContain]) {
      if (!notice.includes(needle)) throw new Error(`${label} ${fallback.notice} no longer says "${needle}"; check its license by hand`);
    }
    files.push({
      path: "LICENSE",
      content: Buffer.from(mitLicenseText(fallback.copyright), "utf8"),
      record: { generated: `MIT text for the notice in ${fallback.notice}; the tarball ships no LICENSE file` },
    });
  }

  const dir = `${config.dir}/${version}`;
  const entry = {
    name,
    version,
    license: config.license,
    source: `npm:${label}`,
    ...(integrity ? { integrity } : {}),
    dir,
    entries: { ...config.entries },
    files: files.map((file) => fileRecord(file.path, file.content, file.record)),
  };
  const styles = Object.fromEntries(Object.entries(config.styles || {}).map(([key, file]) => [key, `${dir}/${file}`]));
  return { entry, styles, files: files.map(({ path: filePath, content }) => ({ path: filePath, content })) };
}

/** Replaces <vendorRoot>/<dir>/ with the prepared files. */
export function writePackage(vendorRoot, prepared) {
  const target = path.join(vendorRoot, ...prepared.entry.dir.split("/"));
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const file of prepared.files) fs.writeFileSync(path.join(target, file.path), file.content);
  return target;
}

/** VENDOR.json with the prepared packages replacing any earlier version of themselves. */
export function mergeVendorManifest(manifest, preparedList, { asOf }) {
  const names = new Set(preparedList.map((prepared) => prepared.entry.name));
  const styles = { ...(manifest.styles || {}) };
  for (const prepared of preparedList) {
    const prefix = `${PACKAGES[prepared.entry.name].dir}/`;
    for (const [key, target] of Object.entries(styles)) if (target.startsWith(prefix)) delete styles[key];
    Object.assign(styles, prepared.styles);
  }
  return {
    ...manifest,
    schemaVersion: 1,
    asOf,
    staleAfterDays: manifest.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS,
    packages: (manifest.packages || []).filter((entry) => !names.has(entry.name)).concat(preparedList.map((prepared) => prepared.entry)),
    styles,
  };
}

/** npm pack into workDir, then tar -xzf there; returns the package folder and the tarball integrity. */
export function packAndExtract(spec, workDir) {
  // spec matched SPEC_PATTERN, so it is safe on a shell command line.
  const pack = spawnSync(`npm pack ${spec} --json --ignore-scripts`, { cwd: workDir, shell: true, encoding: "utf8", windowsHide: true });
  if (pack.error || pack.status !== 0) {
    throw new Error(`npm pack ${spec} failed: ${pack.error ? pack.error.message : String(pack.stderr).trim()}`);
  }
  const [info] = JSON.parse(pack.stdout);
  if (!info || !/^[\w.@-]+\.tgz$/.test(info.filename || "")) throw new Error(`npm pack ${spec} reported no tarball`);
  // A bare file name, so GNU tar never reads a drive letter as a remote host.
  const extract = spawnSync("tar", ["-xzf", info.filename], { cwd: workDir, encoding: "utf8", windowsHide: true });
  if (extract.error || extract.status !== 0) {
    throw new Error(`tar could not extract ${info.filename}: ${extract.error ? extract.error.message : String(extract.stderr).trim()}`);
  }
  return { packageDir: path.join(workDir, "package"), integrity: info.integrity };
}

function localDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function main(argv, { root = DEFAULT_ROOT, today = new Date(), pack = packAndExtract } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let specs;
  try {
    if (!argv.length) throw new UsageError("name at least one package");
    specs = argv.map(parseSpec);
    const seen = new Set();
    for (const spec of specs) {
      if (seen.has(spec.name)) throw new UsageError(`${spec.name} is listed twice`);
      seen.add(spec.name);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }

  const vendorRoot = path.join(root, "shared-public", "vendor");
  const manifestFile = path.join(vendorRoot, "VENDOR.json");
  const manifest = fs.existsSync(manifestFile)
    ? readVendorManifest(manifestFile)
    : { schemaVersion: 1, staleAfterDays: DEFAULT_STALE_AFTER_DAYS, packages: [], styles: {} };
  const preparedList = [];
  for (const spec of specs) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-browser-libs-"));
    try {
      const { packageDir, integrity } = pack(`${spec.name}@${spec.version}`, workDir);
      preparedList.push(preparePackage({ ...spec, packageDir, integrity }));
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  for (const prepared of preparedList) {
    writePackage(vendorRoot, prepared);
    console.log(`Vendored ${prepared.entry.source} into shared-public/vendor/${prepared.entry.dir} (${prepared.files.length} files).`);
    const versionsRoot = path.join(vendorRoot, PACKAGES[prepared.entry.name].dir);
    for (const other of fs.readdirSync(versionsRoot)) {
      if (other !== prepared.entry.version) console.log(`Note: shared-public/vendor/${PACKAGES[prepared.entry.name].dir}/${other} is no longer listed; delete it in the same commit.`);
    }
  }
  fs.writeFileSync(manifestFile, serializeVendorManifest(mergeVendorManifest(manifest, preparedList, { asOf: localDate(today) })));
  console.log("Updated shared-public/vendor/VENDOR.json. Run npm test in service-entry for the vendor integrity test.");
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = path.resolve(process.argv[1]);
  return process.platform === "win32" ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isMainModule()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}
