"use strict";

// Model hub artifacts, selection and include compilation (docs/overhaul/03-hub.md
// section 5, HUB-4). Pure functions only: no network, no filesystem outside
// the recorded fixtures. Goldens are regenerated with UPDATE_GOLDEN=1.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { normalizeRepoInfo } = require("../model-hub/providers/huggingface");
const { escapeFnmatch, fnmatchToRegExp } = require("../model-hub/fnmatch");
const {
  assertSafeRepoPath,
  compileIncludePatterns,
  listArtifacts,
  resolveSelection,
  selectionFromLegacy,
} = require("../model-hub/selection");
const { HubError } = require("../model-hub/errors");
const downloadUtils = require("../download-utils");

const FIXTURES = path.join(__dirname, "fixtures", "hub");
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";
const FIXED_NOW = Date.parse("2026-10-14T08:00:00.000Z");
const WEIGHT_RE = /\.(gguf|safetensors|bin|pt)$/i;

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

function hfManifest(name) {
  return normalizeRepoInfo(readFixture(`${name}.json`), { repo: `example-org/${name}`, now: FIXED_NOW });
}

const MANIFESTS = {
  "hf-gguf-multiquant": () => hfManifest("hf-gguf-multiquant"),
  "hf-fp8-generic-shards": () => hfManifest("hf-fp8-generic-shards"),
  "hf-mixed": () => hfManifest("hf-mixed"),
  "ms-sharded-manifest": () => readFixture("ms-sharded-manifest.json"),
};

function pathsOf(manifest) {
  return manifest.files.map((file) => file.path);
}

function catchError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function rejects(fn, code, status = 422) {
  const error = catchError(fn);
  assert.ok(error instanceof HubError, `expected HubError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return error;
}

// ---------------------------------------------------------------------------
// Artifact goldens

for (const [name, load] of Object.entries(MANIFESTS)) {
  test(`artifact golden: ${name}`, () => {
    const artifacts = listArtifacts(load());
    const file = path.join(FIXTURES, `${name}.artifacts.golden.json`);
    if (UPDATE_GOLDEN) fs.writeFileSync(file, `${JSON.stringify(artifacts, null, 2)}\n`);
    assert.deepEqual(artifacts, JSON.parse(fs.readFileSync(file, "utf8")));
  });

  test(`no artifact without a weight file: ${name}`, () => {
    const artifacts = listArtifacts(load(), { includeIncomplete: true });
    assert.ok(artifacts.length > 0);
    for (const artifact of artifacts) {
      const weights = artifact.files.filter((file) => file.role === "weight");
      assert.ok(weights.length > 0, artifact.artifactKey);
      assert.equal(weights.length, artifact.fileCount);
      assert.equal(artifact.unsafePaths.length, 0);
      const resolved = resolveSelection(load(), { artifactKey: artifact.artifactKey });
      assert.equal(resolved.artifactKey, artifact.artifactKey);
      assert.ok(resolved.weightCount > 0);
    }
  });
}

test("artifact keys follow the section 5 grammar and the shard rules", () => {
  const gguf = listArtifacts(MANIFESTS["hf-gguf-multiquant"]());
  assert.deepEqual(gguf.map((artifact) => artifact.artifactKey), [
    "gguf:|Q2_K", "gguf:|Q4_K_M", "gguf:|Q5_K_M", "gguf:|Q8_0", "gguf:BF16|BF16",
  ]);
  const bf16 = gguf.find((artifact) => artifact.artifactKey === "gguf:BF16|BF16");
  assert.equal(bf16.multiPart, true);
  assert.equal(bf16.fileCount, 2);
  assert.deepEqual(bf16.companions.mmproj.map((file) => file.path), ["mmproj-F16.gguf"]);
  const mixed = listArtifacts(MANIFESTS["hf-mixed"]());
  assert.deepEqual(mixed.map((artifact) => artifact.artifactKey), ["gguf:|Q4_K_M", "st:", "st:fp8"]);
  assert.deepEqual(listArtifacts(MANIFESTS["hf-fp8-generic-shards"]()).map((artifact) => artifact.artifactKey), ["st:"]);
});

test("incomplete shard sets are skipped unless accepted", () => {
  const manifest = {
    repo: "o/r",
    files: [
      { path: "m-Q4_K_M-00001-of-00003.gguf", size: 10 },
      { path: "m-Q4_K_M-00003-of-00003.gguf", size: 10 },
      { path: "m-Q8_0.gguf", size: 20 },
    ],
  };
  assert.deepEqual(listArtifacts(manifest).map((artifact) => artifact.artifactKey), ["gguf:|Q8_0"]);
  const all = listArtifacts(manifest, { includeIncomplete: true });
  assert.equal(all.find((artifact) => artifact.artifactKey === "gguf:|Q4_K_M").complete, false);
  const error = rejects(() => resolveSelection(manifest, { artifactKey: "gguf:|Q4_K_M" }), "artifact_not_found");
  assert.equal(error.details.reason, "incomplete_shards");
  assert.equal(resolveSelection(manifest, { artifactKey: "gguf:|Q4_K_M", acceptIncomplete: true }).complete, false);
});

test("sidecars come from the artifact directory and the root; py files only with auto_map", () => {
  const mixed = MANIFESTS["hf-mixed"]();
  const fp8 = resolveSelection(mixed, { artifactKey: "st:fp8" });
  assert.deepEqual(fp8.files.map((file) => file.path), [
    "README.md", "config.json", "configuration_example.py", "fp8/config.json",
    "fp8/model-00001-of-00002.safetensors", "fp8/model-00002-of-00002.safetensors",
    "fp8/model.safetensors.index.json", "modeling_example.py", "tokenizer.model", "tokenizer_config.json",
  ]);
  assert.deepEqual(fp8.customCodeFiles, ["configuration_example.py", "modeling_example.py"]);
  const quant = resolveSelection(mixed, { artifactKey: "gguf:|Q4_K_M" });
  assert.deepEqual(quant.customCodeFiles, []);
  assert.ok(!quant.files.some((file) => file.path.endsWith(".py")));
  const noMap = { ...mixed, structured: { ...mixed.structured, config: {} } };
  assert.deepEqual(resolveSelection(noMap, { artifactKey: "st:fp8" }).customCodeFiles, []);
  assert.ok(!resolveSelection(noMap, { artifactKey: "st:" }).files.some((file) => file.path.endsWith(".py")));
  // Tokenizer vocabulary files travel with the weights.
  const generic = resolveSelection(MANIFESTS["hf-fp8-generic-shards"](), { artifactKey: "st:" });
  for (const needed of ["vocab.json", "merges.txt", "tokenizer.json", "config.json", "model.safetensors.index.json"]) {
    assert.ok(generic.files.some((file) => file.path === needed), needed);
  }
  assert.ok(!generic.files.some((file) => file.path === ".gitattributes"));
});

// ---------------------------------------------------------------------------
// resolveSelection

test("resolveSelection returns the job artifact shape", () => {
  const manifest = MANIFESTS["hf-gguf-multiquant"]();
  const resolved = resolveSelection(manifest, { artifactKey: "gguf:|Q4_K_M", companions: ["mmproj-F16.gguf"] });
  assert.equal(resolved.kind, "gguf-quant");
  assert.equal(resolved.format, "gguf");
  assert.equal(resolved.quant, "Q4_K_M");
  assert.deepEqual(resolved.companions, ["mmproj-F16.gguf"]);
  assert.deepEqual(resolved.files.map((file) => [file.path, file.role]), [
    ["Example-8B-Q4_K_M.gguf", "weight"],
    ["README.md", "sidecar"],
    ["config.json", "sidecar"],
    ["mmproj-F16.gguf", "companion"],
  ]);
  assert.equal(resolved.totalBytes, resolved.files.reduce((total, file) => total + file.size, 0));
  assert.equal(resolved.weightBytes, 5027783488);
  assert.deepEqual(resolveSelection(manifest, { artifactKey: "gguf:|Q4_K_M" }).companions, []);
});

test("custom selections: explicit files, stable key, sidecars added", () => {
  const manifest = MANIFESTS["hf-gguf-multiquant"]();
  const picked = resolveSelection(manifest, { files: ["Example-8B-Q8_0.gguf", "Example-8B-Q2_K.gguf"] });
  assert.equal(picked.kind, "custom");
  assert.match(picked.artifactKey, /^custom:[0-9a-f]{8}$/);
  const reordered = resolveSelection(manifest, { files: ["Example-8B-Q2_K.gguf", "Example-8B-Q8_0.gguf", "Example-8B-Q2_K.gguf"] });
  assert.equal(reordered.artifactKey, picked.artifactKey);
  assert.deepEqual(picked.files.map((file) => file.path), [
    "Example-8B-Q2_K.gguf", "Example-8B-Q8_0.gguf", "README.md", "config.json",
  ]);
  assert.equal(picked.weightCount, 2);
  rejects(() => resolveSelection(manifest, { artifactKey: "custom:00000000", files: ["Example-8B-Q8_0.gguf"] }), "artifact_not_found");
  const again = resolveSelection(manifest, { artifactKey: picked.artifactKey, files: ["Example-8B-Q8_0.gguf", "Example-8B-Q2_K.gguf"] });
  assert.equal(again.artifactKey, picked.artifactKey);
  const withCompanion = resolveSelection(manifest, { files: ["Example-8B-Q8_0.gguf", "mmproj-F16.gguf"] });
  assert.deepEqual(withCompanion.companions, ["mmproj-F16.gguf"]);
  assert.equal(withCompanion.weightCount, 1);
});

test("artifact_not_found lists the available keys", () => {
  const manifest = MANIFESTS["hf-gguf-multiquant"]();
  const error = rejects(() => resolveSelection(manifest, { artifactKey: "gguf:|Q3_K_S" }), "artifact_not_found");
  assert.ok(error.details.available.includes("gguf:|Q4_K_M"));
  rejects(() => resolveSelection(manifest, {}), "artifact_not_found");
  rejects(() => resolveSelection(manifest, { artifactKey: "custom:abcdef01" }), "artifact_not_found");
});

test("file_not_in_manifest for files and companions", () => {
  const manifest = MANIFESTS["hf-gguf-multiquant"]();
  rejects(() => resolveSelection(manifest, { files: ["Example-8B-Q9_9.gguf"] }), "file_not_in_manifest");
  rejects(() => resolveSelection(manifest, { files: ["Example-8B-Q8_0.gguf", "missing.json"] }), "file_not_in_manifest");
  rejects(() => resolveSelection(manifest, { artifactKey: "gguf:|Q8_0", companions: ["mmproj-F32.gguf"] }), "file_not_in_manifest");
  const notCompanion = rejects(
    () => resolveSelection(manifest, { artifactKey: "gguf:|Q8_0", companions: ["Example-8B-Q2_K.gguf"] }),
    "file_not_in_manifest",
  );
  assert.equal(notCompanion.details.reason, "not_a_companion");
});

test("unsafe_path is checked before membership and also covers unsafe artifact files", () => {
  const manifest = MANIFESTS["hf-gguf-multiquant"]();
  rejects(() => resolveSelection(manifest, { files: ["../Example-8B-Q8_0.gguf"] }), "unsafe_path");
  rejects(() => resolveSelection(manifest, { files: ["/etc/model.gguf"] }), "unsafe_path");
  rejects(() => resolveSelection(manifest, { files: ["C:/model.gguf"] }), "unsafe_path");
  rejects(() => resolveSelection(manifest, { artifactKey: "gguf:|Q8_0", companions: ["a/../mmproj.gguf"] }), "unsafe_path");
  // An unsafe file outside the artifact does not block it...
  const outside = {
    repo: "o/r",
    files: [
      { path: "model-Q4_K_M.gguf", size: 1 },
      { path: "docs/stream:evil.json", size: 1 },
      { path: "con.json", size: 1 },
    ],
  };
  assert.equal(resolveSelection(outside, { artifactKey: "gguf:|Q4_K_M" }).weightCount, 1);
  // ...one inside it does, and the listing flags it.
  const inside = { repo: "o/r", files: [{ path: "m-Q4_K_M.gguf", size: 1 }, { path: "README.", size: 1 }] };
  assert.deepEqual(listArtifacts(inside)[0].unsafePaths, ["README."]);
  rejects(() => resolveSelection(inside, { artifactKey: "gguf:|Q4_K_M" }), "unsafe_path");
  rejects(() => resolveSelection(inside, { files: ["README."] }), "unsafe_path");
});

test("assertSafeRepoPath rules", () => {
  const ok = ["model.gguf", "dir/sub/model-00001-of-00002.safetensors", "a[1]/b (2)/c.json", ".gitattributes", "console.txt", "com10.txt"];
  for (const value of ok) assert.equal(assertSafeRepoPath(value), value);
  const bad = {
    "": "empty",
    "../x": "dot_segment",
    "a/../x": "dot_segment",
    "./x": "dot_segment",
    "/abs": "absolute",
    "C:/x": "drive_letter",
    "c:x": "drive_letter",
    "ab:c": "colon",
    "a:b": "drive_letter",
    "file.txt:stream": "colon",
    "a\\b": "backslash",
    "a//b": "empty_segment",
    "a/": "empty_segment",
    "a\u0000b": "control_character",
    "a\nb": "control_character",
    "dir/name.": "trailing_dot_or_space",
    "dir /x": "trailing_dot_or_space",
    "con": "reserved_name",
    "dir/NUL.txt": "reserved_name",
    "Com1.json": "reserved_name",
    "lpt9": "reserved_name",
    "aux.tar.gz": "reserved_name",
  };
  for (const [value, reason] of Object.entries(bad)) {
    const error = rejects(() => assertSafeRepoPath(value), "unsafe_path");
    assert.equal(error.details.reason, reason, JSON.stringify(value));
  }
  rejects(() => assertSafeRepoPath(null), "unsafe_path");
  rejects(() => assertSafeRepoPath(42), "unsafe_path");
  // 240 characters from the root, counting the local directory the path goes under.
  const long = `${"d/".repeat(100)}f`;
  assert.equal(long.length, 201);
  assert.equal(assertSafeRepoPath(long), long);
  assert.equal(rejects(() => assertSafeRepoPath(long, { reserve: 40 }), "unsafe_path").details.reason, "too_long");
  assert.equal(assertSafeRepoPath(long, { reserve: 39 }), long);
  assert.equal(rejects(() => assertSafeRepoPath("x".repeat(241)), "unsafe_path").details.reason, "too_long");
});

test("filter_no_match: a selection with no weight file carries the available artifacts", () => {
  const manifest = MANIFESTS["hf-gguf-multiquant"]();
  const error = rejects(() => resolveSelection(manifest, { files: ["README.md", "config.json"] }), "filter_no_match");
  assert.deepEqual(error.details.available, ["gguf:|Q2_K", "gguf:|Q4_K_M", "gguf:|Q5_K_M", "gguf:|Q8_0", "gguf:BF16|BF16"]);
  assert.ok(error.details.suggestions.every((item) => item.artifactKey && item.label && item.bytes > 0));
  rejects(() => resolveSelection({ repo: "o/r", files: [{ path: "README.md", size: 1 }] }, { files: ["README.md"] }), "filter_no_match");
});

// ---------------------------------------------------------------------------
// Legacy precision mapping

function legacyWeightSet(manifest, precision, repo = manifest.repo) {
  const siblings = manifest.files.map((file) => ({ rfilename: file.path }));
  return new Set(downloadUtils.selectDownloadSiblings(siblings, precision, repo, []).siblings
    .map((file) => file.rfilename)
    .filter((name) => WEIGHT_RE.test(name)));
}

function selectedWeights(manifest, selection) {
  const resolved = resolveSelection(manifest, selection);
  return new Set(resolved.files.filter((file) => WEIGHT_RE.test(file.path) && file.role !== "companion").map((file) => file.path));
}

test("legacy precision keeps the intent of buildDownloadIncludePatterns (core.test.js cases)", () => {
  const gguf = MANIFESTS["hf-gguf-multiquant"]();
  // Q4 -> every Q4 and IQ4 file; Q8_0 -> only Q8_0.
  const q4 = selectionFromLegacy({ precision: "Q4", repo: gguf.repo }, gguf);
  assert.equal(q4.artifactKey, "gguf:|Q4_K_M");
  assert.deepEqual(selectedWeights(gguf, q4), legacyWeightSet(gguf, "Q4"));
  const q8 = selectionFromLegacy({ precision: "Q8_0", repo: gguf.repo }, gguf);
  assert.equal(q8.artifactKey, "gguf:|Q8_0");
  assert.deepEqual(selectedWeights(gguf, q8), legacyWeightSet(gguf, "Q8_0"));
  assert.equal(selectionFromLegacy({ precision: "q4km", repo: gguf.repo }, gguf).artifactKey, "gguf:|Q4_K_M");
  assert.equal(selectionFromLegacy({ precision: "BF16", repo: gguf.repo }, gguf).artifactKey, "gguf:BF16|BF16");

  const family = {
    repo: "o/r",
    files: ["m-Q4_K_M.gguf", "m-Q4_0.gguf", "m-IQ4_XS.gguf", "m-Q5_K_M.gguf", "m-Q6_K.gguf", "config.json"].map((p) => ({ path: p, size: 5 })),
  };
  const familySelection = selectionFromLegacy({ precision: "Q4", repo: family.repo }, family);
  assert.equal(familySelection.artifactKey, null);
  assert.deepEqual(new Set(familySelection.files), new Set(["m-IQ4_XS.gguf", "m-Q4_0.gguf", "m-Q4_K_M.gguf"]));
  assert.deepEqual(selectedWeights(family, familySelection), legacyWeightSet(family, "Q4"));
  const iq4 = selectionFromLegacy({ precision: "IQ4", repo: family.repo }, family);
  assert.equal(iq4.artifactKey, "gguf:|IQ4_XS");
  assert.deepEqual(selectedWeights(family, iq4), legacyWeightSet(family, "IQ4"));

  // FP8 declared by the repo name -> the whole safetensors artifact (generic shard names).
  const fp8 = MANIFESTS["hf-fp8-generic-shards"]();
  const declaredRepo = "orcarouter/Qwen3.8-27B-Uncensored-FP8";
  assert.deepEqual(downloadUtils.buildDownloadIncludePatterns("FP8", declaredRepo), []);
  const declared = selectionFromLegacy({ precision: "FP8", repo: declaredRepo }, fp8);
  assert.equal(declared.artifactKey, "st:");
  assert.deepEqual(selectedWeights(fp8, declared), legacyWeightSet(fp8, "FP8", declaredRepo));

  // ...and an undeclared FP8 asks for files whose names carry it, plus sidecars.
  const mixed = MANIFESTS["hf-mixed"]();
  const undeclared = selectionFromLegacy({ precision: "FP8", repo: "fp8-owner/model" }, mixed);
  assert.equal(undeclared.artifactKey, null);
  assert.deepEqual(undeclared.files, ["fp8/model-00001-of-00002.safetensors", "fp8/model-00002-of-00002.safetensors"]);
  assert.deepEqual(selectedWeights(mixed, undeclared), legacyWeightSet(mixed, "FP8", "fp8-owner/model"));
  const resolved = resolveSelection(mixed, undeclared);
  assert.ok(resolved.files.some((file) => file.path === "fp8/config.json"));
  assert.ok(resolved.files.some((file) => file.path === "tokenizer_config.json"));
});

test("legacy: empty precision is the whole repo, GGUF is every gguf, extras pick companions", () => {
  const gguf = MANIFESTS["hf-gguf-multiquant"]();
  const whole = selectionFromLegacy({ precision: "", repo: gguf.repo }, gguf);
  assert.equal(whole.artifactKey, null);
  assert.deepEqual(new Set(whole.files), new Set(pathsOf(gguf)));
  const wholePaths = resolveSelection(gguf, whole).files.map((file) => file.path);
  assert.deepEqual(compileIncludePatterns(wholePaths, pathsOf(gguf)), { mode: "all" });
  assert.equal(selectionFromLegacy({ precision: "\u539f\u59cb BF16/FP16", repo: gguf.repo }, gguf).files.length, pathsOf(gguf).length);

  const all = selectionFromLegacy({ precision: "GGUF", repo: gguf.repo }, gguf);
  assert.deepEqual(new Set(all.files), new Set(pathsOf(gguf).filter((p) => p.endsWith(".gguf"))));

  const withExtras = selectionFromLegacy({ precision: "Q8_0", includeExtras: ["*mmproj*.gguf", "*draft*.gguf"], repo: gguf.repo }, gguf);
  assert.deepEqual(withExtras.companions, ["mmproj-F16.gguf"]);
  assert.deepEqual(resolveSelection(gguf, withExtras).companions, ["mmproj-F16.gguf"]);
  assert.deepEqual(selectionFromLegacy({ precision: "Q8_0", includeExtras: ["*eagle*.gguf"], repo: gguf.repo }, gguf).companions, []);
});

test("legacy: zero weight files -> filter_no_match with quant suggestions", () => {
  const gguf = MANIFESTS["hf-gguf-multiquant"]();
  for (const precision of ["Q6_K", "IQ2_XS", "Q3"]) {
    const error = rejects(() => selectionFromLegacy({ precision, repo: gguf.repo }, gguf), "filter_no_match");
    assert.deepEqual(error.details.suggestions.map((item) => item.label), ["Q2_K", "Q4_K_M", "Q5_K_M", "Q8_0", "BF16"]);
    assert.deepEqual(error.details.suggestions.map((item) => item.bytes).slice(0, 2), [3282141632, 5027783488]);
  }
  rejects(() => selectionFromLegacy({ precision: "AWQ", repo: "o/r" }, gguf), "filter_no_match");
  rejects(() => selectionFromLegacy({ precision: "Q4", repo: "o/r" }, MANIFESTS["hf-fp8-generic-shards"]()), "filter_no_match");
  rejects(() => selectionFromLegacy({ precision: "", repo: "o/r" }, { repo: "o/r", files: [{ path: "README.md", size: 1 }] }), "filter_no_match");
});

// ---------------------------------------------------------------------------
// fnmatch

// Recorded with CPython 3.12 `fnmatch.fnmatchcase(name, pattern)`.
const PYTHON_PARITY = {
  names: ["a","b","ab","axb","a/b","a[b","a*b","a?b","x","]","[","*","?","dir/x","dir/sub/y.gguf","m-Q4_K_M.gguf","m-IQ4_XS.gguf","m-q4_k_m.gguf","cx","dx","-","e","a\b","a&b","a-b","a.b","1.json","12.json","model-00001-of-00003.safetensors","model-0001-of-00003.safetensors","a]b","x[","[a-","[ab","\n","a\nb","]a"],
  cases: {
    "*": ["a","b","ab","axb","a/b","a[b","a*b","a?b","x","]","[","*","?","dir/x","dir/sub/y.gguf","m-Q4_K_M.gguf","m-IQ4_XS.gguf","m-q4_k_m.gguf","cx","dx","-","e","a\b","a&b","a-b","a.b","1.json","12.json","model-00001-of-00003.safetensors","model-0001-of-00003.safetensors","a]b","x[","[a-","[ab","\n","a\nb","]a"],
    "?": ["a","b","x","]","[","*","?","-","e","\n"],
    "a*b": ["ab","axb","a/b","a[b","a*b","a?b","a&b","a-b","a.b","a]b","a\nb"],
    "a**b": ["ab","axb","a/b","a[b","a*b","a?b","a&b","a-b","a.b","a]b","a\nb"],
    "[abc]": ["a","b"],
    "[!abc]": ["x","]","[","*","?","-","e","\n"],
    "[a-c]x": ["cx"],
    "[]]": ["]"],
    "[!]]": ["a","b","x","[","*","?","-","e","\n"],
    "[": ["["],
    "a[b": ["a[b"],
    "[[]": ["["],
    "[*]": ["*"],
    "[?]": ["?"],
    "dir/*": ["dir/x","dir/sub/y.gguf"],
    "*.gguf": ["dir/sub/y.gguf","m-Q4_K_M.gguf","m-IQ4_XS.gguf","m-q4_k_m.gguf"],
    "*Q4*.gguf": ["m-Q4_K_M.gguf","m-IQ4_XS.gguf"],
    "[z-a]": [],
    "[a-]": ["a","-"],
    "[!": [],
    "[]": [],
    "[^a]": ["a"],
    "a\b": ["a\b"],
    "[a&&b]": ["a","b"],
    "[a--b]": ["b"],
    "[a-c-e]": ["a","b","-","e"],
    "[!a-c]": ["x","]","[","*","?","-","e","\n"],
    "model-[0-9][0-9][0-9][0-9][0-9]-of-*.safetensors": ["model-00001-of-00003.safetensors"],
    "?.json": ["1.json"],
    "*/*": ["a/b","dir/x","dir/sub/y.gguf"],
    "a[[]b": ["a[b"],
    "a[*]b": ["a*b"],
    "a[?]b": ["a?b"],
    "[]a]": ["a","]"],
    "[!]a]": ["b","x","[","*","?","-","e","\n"],
    "x[": ["x["],
    "[a-": ["[a-"],
    "[ab": ["[ab"],
    "[b-a]x": [],
  },
};

test("fnmatchToRegExp matches Python fnmatchcase on a recorded corpus", () => {
  for (const [pattern, expected] of Object.entries(PYTHON_PARITY.cases)) {
    const re = fnmatchToRegExp(pattern);
    const actual = PYTHON_PARITY.names.filter((name) => re.test(name));
    assert.deepEqual(actual, expected, `pattern ${JSON.stringify(pattern)}`);
  }
});

test("fnmatch: * crosses /, ? and sets are single characters, ignoreCase models Windows", () => {
  assert.ok(fnmatchToRegExp("*.gguf").test("dir/sub/x.gguf"));
  assert.ok(fnmatchToRegExp("dir/*").test("dir/a/b"));
  assert.ok(!fnmatchToRegExp("dir/*").test("dirx/a"));
  assert.ok(fnmatchToRegExp("a?c").test("a/c"));
  assert.ok(!fnmatchToRegExp("*.GGUF").test("x.gguf"));
  assert.ok(fnmatchToRegExp("*.GGUF", { ignoreCase: true }).test("x.gguf"));
  assert.ok(!fnmatchToRegExp("a").test("a\n"));
  assert.ok(fnmatchToRegExp("a*").test("a\nb"));
});

test("escapeFnmatch escapes [ * ? exactly once and round-trips", () => {
  assert.equal(escapeFnmatch("a[1]*?.gguf"), "a[[]1][*][?].gguf");
  assert.equal(escapeFnmatch("plain-name_1.json"), "plain-name_1.json");
  for (const name of ["a[1].gguf", "[", "[]", "[!x]", "*", "?", "a*b?c[d]", "x]y", "[[]", "dir[1]/f*.bin", "a-b", "[a-c]"]) {
    const re = fnmatchToRegExp(escapeFnmatch(name));
    assert.ok(re.test(name), name);
    assert.ok(!re.test(`${name}x`), name);
    assert.ok(!re.test(`x${name}`), name);
  }
  assert.ok(!fnmatchToRegExp(escapeFnmatch("a*b")).test("aXb"));
  assert.ok(!fnmatchToRegExp(escapeFnmatch("a?b")).test("aXb"));
  assert.ok(!fnmatchToRegExp(escapeFnmatch("[ab]")).test("a"));
});

// ---------------------------------------------------------------------------
// compileIncludePatterns

function applyPatterns(patterns, all, ignoreCase = false) {
  const regexps = patterns.map((pattern) => fnmatchToRegExp(pattern, { ignoreCase }));
  return all.filter((filePath) => regexps.some((re) => re.test(filePath)));
}

function cost(patterns) {
  return patterns.reduce((total, pattern) => total + "--include=".length + pattern.length + 3, 0);
}

function assertCompilesExactly(selected, all, options) {
  const compiled = compileIncludePatterns(selected, all, options);
  if (compiled.mode === "all") {
    assert.equal(new Set(selected).size, new Set(all).size);
    return compiled;
  }
  assert.equal(compiled.mode, "include");
  const expected = [...new Set(selected)].sort();
  for (const ignoreCase of [false, true]) {
    assert.deepEqual(applyPatterns(compiled.patterns, all, ignoreCase).sort(), expected);
  }
  assert.deepEqual(compiled.batches.flat(), compiled.patterns);
  const budget = options?.argvBudget ?? 24000;
  for (const batch of compiled.batches) {
    assert.ok(batch.length === 1 || cost(batch) <= budget, `batch cost ${cost(batch)} > ${budget}`);
    for (const matched of applyPatterns(batch, all)) assert.ok(expected.includes(matched));
  }
  return compiled;
}

test("compile: selected == all is mode all", () => {
  const manifest = MANIFESTS["hf-mixed"]();
  assert.deepEqual(compileIncludePatterns(pathsOf(manifest), pathsOf(manifest)), { mode: "all" });
  assert.deepEqual(compileIncludePatterns([...pathsOf(manifest)].reverse(), pathsOf(manifest)), { mode: "all" });
});

test("compile: dir/*, *QUANT*.gguf and exact escaped names", () => {
  const gguf = MANIFESTS["hf-gguf-multiquant"]();
  const all = pathsOf(gguf);
  const q4 = resolveSelection(gguf, { artifactKey: "gguf:|Q4_K_M" }).files.map((file) => file.path);
  assert.deepEqual(compileIncludePatterns(q4, all).patterns, ["*Q4_K_M*.gguf", "README.md", "config.json"]);

  // BF16 shards live in a directory that holds nothing else: dir/*.
  const bf16 = resolveSelection(gguf, { artifactKey: "gguf:BF16|BF16" }).files.map((file) => file.path);
  assert.deepEqual(compileIncludePatterns(bf16, all).patterns, ["BF16/*", "README.md", "config.json"]);

  const odd = {
    repo: "o/r",
    files: ["dir[1]/a*.bin", "dir[1]/b?.bin", "dir[1]/c.json", "other/x.bin", "root.json"].map((p) => ({ path: p, size: 1 })),
  };
  const compiled = assertCompilesExactly(["dir[1]/a*.bin", "dir[1]/c.json"], pathsOf(odd));
  assert.deepEqual(compiled.patterns, ["dir[[]1]/a[*].bin", "dir[[]1]/c.json"]);
  const whole = assertCompilesExactly(["dir[1]/a*.bin", "dir[1]/b?.bin", "dir[1]/c.json"], pathsOf(odd));
  assert.deepEqual(whole.patterns, ["dir[[]1]/*"]);
});

test("compile: an over-matching quant glob falls back to a scoped glob, then to names", () => {
  const all = ["a/m-Q4_K_M.gguf", "b/m-Q4_K_M.gguf", "m-Q8_0.gguf", "config.json"];
  assert.deepEqual(assertCompilesExactly(["a/m-Q4_K_M.gguf", "b/m-Q4_K_M.gguf"], all).patterns, ["*Q4_K_M*.gguf"]);
  assert.deepEqual(assertCompilesExactly(["a/m-Q4_K_M.gguf"], all).patterns, ["a/*Q4_K_M*.gguf"]);
  // A lower-case file name is not matched by the upper-case tag, so names are used.
  const lower = ["x-q4_k_m.gguf", "x-q8_0.gguf", "config.json"];
  assert.deepEqual(assertCompilesExactly(["x-q4_k_m.gguf"], lower).patterns, ["x-q4_k_m.gguf"]);
  // The CLI is case-insensitive on Windows: names that collide only by case cannot be isolated.
  rejects(() => compileIncludePatterns(["a/Model.bin"], ["a/Model.bin", "a/model.bin"]), "selection_compile_error", 500);
});

test("compile: invalid inputs are internal errors, never a silent download", () => {
  const all = ["a.bin", "b.bin"];
  rejects(() => compileIncludePatterns([], all), "selection_compile_error", 500);
  rejects(() => compileIncludePatterns(["c.bin"], all), "selection_compile_error", 500);
});

test("compile: argv batching at 24k", () => {
  const all = Array.from({ length: 2000 }, (_, index) => `layers/part-${String(index).padStart(5, "0")}-of-02000-with-a-fairly-long-name.safetensors`);
  all.push("config.json");
  const selected = all.filter((_, index) => index % 2 === 0 && index < 2000);
  const compiled = assertCompilesExactly(selected, all);
  assert.ok(cost(compiled.patterns) > 24000, "the fixture must exceed one command");
  assert.ok(compiled.batches.length >= 2);
  for (const batch of compiled.batches) assert.ok(cost(batch) <= 24000);
  assert.equal(compiled.batches.flat().length, 1000);
  assert.equal(compileIncludePatterns(selected.slice(0, 10), all).batches.length, 1);
  assert.ok(assertCompilesExactly(selected.slice(0, 10), all, { argvBudget: 200 }).batches.length > 1);
});

// A seeded generator: every failure reports its seed.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIR_POOL = ["", "", "BF16", "Q4_K_M", "Q8_0", "fp8", "a[1]", "x y", "v2/unet", "v2/vae", "star*dir", "q?dir", "UD-Q4_K_XL", "weights"];
const STEM_POOL = [
  "model", "Model", "m-Q4_K_M", "m-Q8_0", "m-IQ4_XS", "m-q4_k_m", "x[1]", "a*b", "c?d", "tok-ens", "UD-Q4_K_XL", "BF16",
  "README", "config", "m-Q4_K_M-00001-of-00003", "m-Q4_K_M-00002-of-00003", "m-Q4_K_M-00003-of-00003",
];
const EXT_POOL = [".gguf", ".gguf", ".safetensors", ".bin", ".json", ".md", ".txt", ".model", ""];

function randomManifest(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const count = 1 + Math.floor(random() * 40);
  const seen = new Set();
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const dir = pick(DIR_POOL);
    const filePath = `${dir ? `${dir}/` : ""}${pick(STEM_POOL)}${pick(EXT_POOL)}`;
    // The CLI matches case-insensitively on Windows; case-only twins cannot exist on its disks.
    if (seen.has(filePath.toLowerCase())) continue;
    seen.add(filePath.toLowerCase());
    files.push(filePath);
  }
  return files;
}

function randomSelection(random, all) {
  const mode = Math.floor(random() * 5);
  const dirs = [...new Set(all.map((p) => p.slice(0, Math.max(0, p.lastIndexOf("/")))))];
  let chosen;
  if (mode === 0) {
    chosen = all.filter(() => random() < 0.5);
  } else if (mode === 1) {
    const dir = dirs[Math.floor(random() * dirs.length)];
    chosen = all.filter((p) => dir && p.startsWith(`${dir}/`));
  } else if (mode === 2) {
    chosen = all.filter((p) => p.endsWith(".gguf") && random() < 0.7);
  } else if (mode === 3) {
    chosen = all.filter(() => random() < 0.9);
  } else {
    chosen = [all[Math.floor(random() * all.length)]];
  }
  return chosen.length ? chosen : [all[0]];
}

test("property: compileIncludePatterns selects exactly the selection (500 seeds)", () => {
  let includeCases = 0;
  let allCases = 0;
  let globCases = 0;
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = mulberry32(seed);
    const all = randomManifest(random);
    const selected = randomSelection(random, all);
    const budget = seed % 3 === 0 ? 120 : 24000;
    try {
      const compiled = assertCompilesExactly(selected, all, { argvBudget: budget });
      if (compiled.mode === "all") {
        allCases += 1;
      } else {
        includeCases += 1;
        if (compiled.patterns.some((pattern) => pattern.replace(/\[[*?[]\]/g, "").includes("*"))) globCases += 1;
      }
    } catch (error) {
      error.message = `seed ${seed}: ${error.message}`;
      throw error;
    }
  }
  assert.ok(includeCases > 300, `include cases ${includeCases}`);
  assert.ok(allCases > 0);
  assert.ok(globCases > 100, `glob cases ${globCases}`);
});
