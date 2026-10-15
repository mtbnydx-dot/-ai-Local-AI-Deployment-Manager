"use strict";

// Layered model knowledge (docs/overhaul/02-models.md §8, MOD-5): precedence
// bundled < legacy v1 < packs < user < per-model, $merge and $delete, invalid
// and unsafe entries skipped and reported, a corrupt user file never breaks
// startup, descriptor error-signature additions, the `stage` alias,
// heuristic-hit persistence and the manager route module. Every directory is
// a temp directory; no engine, Docker or live data is touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The process-wide engine registry and parameter catalogs read bundled data only.
const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const knowledgeModule = require("../model-inspector/knowledge");
const { registerModelInspectorRoutes, normalizeRouteDeps } = require("../model-inspector-routes");
const { DEFAULT_TENSOR_CLASSES } = require("../model-inspector/detectors/topology");

const { createKnowledgeLoader, checkRegexSafety, prepareLogLines, LOG_LINE_MAX, LOG_LINES_MAX } = knowledgeModule;
const KIND_FILES = { families: "families.json", "template-signatures": "template-signatures.json", "error-signatures": "error-signatures.json" };
const DIGEST = /^sha256:[0-9a-f]{64}$/;

// ----- helpers

function tempDir(t, prefix = "knowledge-layers-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Imported packs are stored as <packId>@<sha12>.json (02 §8.1).
function packFile(packId, sha12) {
  return `${packId}${String.fromCharCode(64)}${sha12}.json`;
}

function writeJson(dir, name, value) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function fileOf(kind, entries, extra = {}) {
  return { schemaVersion: kind === "families" ? 2 : 1, kind, asOf: "2026-10-14", staleAfterDays: 365, ...extra, entries };
}

function family(id, extra = {}) {
  return { id, match: { modelTypes: [`${id}_t`] }, ...extra };
}

function signature(id, extra = {}) {
  return { id, code: id.replace(/-/g, "_"), engines: ["vllm"], phase: "weights", regex: `boom ${id}`, ...extra };
}

// A knowledge environment: bundled files, <config>/knowledge.d and a cache dir.
function environment(t, { families = [], templates = [], errors = [] } = {}) {
  const root = tempDir(t);
  const env = {
    root,
    bundledDir: path.join(root, "bundled"),
    configDir: path.join(root, "config"),
    cacheDir: path.join(root, "cache"),
  };
  writeJson(env.bundledDir, KIND_FILES.families, fileOf("families", families, { tensorClasses: [], capabilityIdAliases: {} }));
  writeJson(env.bundledDir, KIND_FILES["template-signatures"], fileOf("template-signatures", templates));
  writeJson(env.bundledDir, KIND_FILES["error-signatures"], fileOf("error-signatures", errors));
  fs.mkdirSync(env.configDir, { recursive: true });
  env.user = (name, value) => writeJson(path.join(env.configDir, "knowledge.d"), name, value);
  env.pack = (name, value) => writeJson(path.join(env.configDir, "knowledge.d", "packs"), name, value);
  env.model = (name, value) => writeJson(path.join(env.configDir, "knowledge.d", "models"), name, value);
  env.v1 = (value) => writeJson(env.configDir, "model-capabilities.json", value);
  return env;
}

function loaderFor(t, env, extra = {}) {
  const loader = createKnowledgeLoader({
    bundledDir: env.bundledDir,
    configDir: env.configDir,
    cacheDir: env.cacheDir,
    aiRoot: env.root,
    registry: null,
    paramIds: null,
    recheckMs: 0,
    flushIntervalMs: 0,
    ...extra,
  });
  t.after(() => loader.close());
  return loader;
}

function card(extra = {}) {
  return {
    contentDigest: `sha256:${"a".repeat(64)}`,
    ref: { kind: "local", path: "/models/some-folder" },
    identity: { modelType: null, textModelType: null, architectures: [], ggufArchitecture: null, displayName: null },
    template: { signatureId: null },
    quant: { method: null },
    ...extra,
  };
}

function cardOf(modelType, extra = {}) {
  return card({ identity: { modelType, architectures: [], ggufArchitecture: null }, ...extra });
}

function errorsOf(loader, code) {
  return loader.status().errors.filter((item) => item.code === code);
}

// ----- the bundled skeleton

test("the bundled skeleton loads cleanly, carries the header fields and the tensor class table", () => {
  const loader = createKnowledgeLoader({ configDir: EMPTY_CONFIG_DIR, cacheDir: EMPTY_CONFIG_DIR, registry: null, paramIds: null });
  const status = loader.status();
  assert.equal(status.domain, "models");
  assert.deepEqual(status.errors, []);
  assert.equal(status.layers[0].layer, "bundled");
  assert.deepEqual(status.layers.map((layer) => layer.layer), ["bundled", "legacy-v1", "pack", "user", "model"]);
  assert.deepEqual(status.layers[0].files.map((file) => [file.name, file.kind]), [
    ["families.json", "families"],
    ["template-signatures.json", "template-signatures"],
    ["error-signatures.json", "error-signatures"],
  ]);
  for (const file of status.layers[0].files) {
    assert.match(file.asOf, /^\d{4}-\d{2}-\d{2}$/, file.name);
    assert.ok(file.staleAfterDays > 0, file.name);
  }
  assert.match(status.digest, DIGEST);
  // The table topology.js uses today moved into the data file unchanged (02 §5).
  assert.deepEqual(
    loader.tensorClasses().map((item) => ({ class: item.class, patterns: item.patterns, layerGroup: item.layerGroup })),
    DEFAULT_TENSOR_CLASSES.map((item) => ({ class: item.class, patterns: [...item.patterns], layerGroup: item.layerGroup })),
  );
});

test("the three bundled schemas compile and the skeleton files carry the schema versions of §8", () => {
  const { schemas, errors } = knowledgeModule.loadSchemas();
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(schemas).sort(), ["error-signatures", "families", "template-signatures"]);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(knowledgeModule.BUNDLED_KNOWLEDGE_DIR, name), "utf8"));
  assert.equal(read("families.json").schemaVersion, 2);
  assert.equal(read("template-signatures.json").schemaVersion, 1);
  assert.equal(read("error-signatures.json").schemaVersion, 1);
});

test("status shows display paths only: no absolute path, user name or temp directory", (t) => {
  const env = environment(t, { families: [family("alpha")] });
  env.user("mine.json", fileOf("families", [family("beta")]));
  env.user("broken.json", "{ nope");
  const loader = loaderFor(t, env);
  const text = JSON.stringify(loader.status());
  assert.ok(!text.toLowerCase().includes(os.tmpdir().toLowerCase().replace(/\\/g, "\\\\")), "temp dir leaked");
  assert.ok(!text.toLowerCase().includes(env.root.toLowerCase().replace(/\\/g, "\\\\")), "root leaked");
  assert.ok(!/[A-Za-z]:[\\/]/.test(text.replace(/\\\\/g, "\\")), "a drive path leaked");
  assert.ok(text.includes("<AI_ROOT>/config/knowledge.d"));
});

// ----- precedence

test("precedence bundled < legacy v1 < packs < user < per-model", (t) => {
  const contextOf = (loader, c = cardOf("alpha_t")) => loader.matchFamily(c).entry?.contextMax;
  const env = environment(t, { families: [family("alpha", { contextMax: 1000, label: { en: "Bundled" } })] });
  const convertV1 = () => ({
    families: fileOf("families", [family("alpha", { contextMax: 2000, label: { en: "V1" } })]),
    capabilityIdAliases: { "old-alpha": "alpha" },
  });
  assert.equal(contextOf(loaderFor(t, env, { convertV1 })), 1000);

  env.v1({ schemaVersion: 1, entries: [] });
  assert.equal(contextOf(loaderFor(t, env, { convertV1 })), 2000);
  assert.equal(loaderFor(t, env, { convertV1 }).familyIdForCapabilityId("old-alpha"), "alpha");

  env.pack(packFile("p", "abc123abc123"), fileOf("families", [family("alpha", { contextMax: 3000 })]));
  assert.equal(contextOf(loaderFor(t, env, { convertV1 })), 3000);

  env.user("mine.json", fileOf("families", [family("alpha", { contextMax: 4000, label: { en: "Mine" } })]));
  const loader = loaderFor(t, env, { convertV1 });
  assert.equal(contextOf(loader), 4000);
  const merged = loader.entries("families").find((entry) => entry.id === "alpha");
  assert.equal(merged.layer, "user");
  assert.deepEqual(merged.overrides, ["bundled", "legacy-v1", "pack"]);

  // A pack never beats the owner's file, whatever the file names say.
  env.pack(packFile("zzz", "fffffffffff"), fileOf("families", [family("alpha", { contextMax: 3500 })]));
  assert.equal(contextOf(loaderFor(t, env, { convertV1 })), 4000);

  // The per-model layer applies to the models it selects, and only to them.
  env.model("one.json", fileOf("families", [{ id: "alpha", match: { contentDigest: `sha256:${"b".repeat(64)}` }, contextMax: 5000 }]));
  const perModel = loaderFor(t, env, { convertV1 });
  assert.equal(contextOf(perModel, cardOf("alpha_t", { contentDigest: `sha256:${"b".repeat(64)}` })), 5000);
  assert.equal(contextOf(perModel, cardOf("alpha_t")), 4000);
  const selected = perModel.matchFamily(cardOf("alpha_t", { contentDigest: `sha256:${"b".repeat(64)}` }));
  assert.equal(selected.layer, "model");
  assert.ok(selected.matchedBy.includes("model-override"));
});

test("a later file of the same layer wins by file name order; the first duplicate inside one file is kept", (t) => {
  const env = environment(t);
  env.user("a.json", fileOf("families", [family("alpha", { contextMax: 1 })]));
  env.user("b.json", fileOf("families", [family("alpha", { contextMax: 2 })]));
  env.user("c.json", fileOf("families", [family("beta", { contextMax: 1 }), family("beta", { contextMax: 2 })]));
  const loader = loaderFor(t, env);
  assert.equal(loader.matchFamily(cardOf("alpha_t")).entry.contextMax, 2);
  assert.equal(loader.matchFamily(cardOf("beta_t")).entry.contextMax, 1);
  assert.equal(errorsOf(loader, "duplicate_id").length, 1);
});

test("$merge deep merges objects and replaces arrays; without it the whole entry is replaced", (t) => {
  const bundled = family("alpha", {
    contextMax: 1000,
    notes: ["one", "two"],
    engines: { vllm: { support: "verified", parsers: { tool: "a", reasoning: "r" } }, sglang: { support: "documented" } },
  });
  const env = environment(t, { families: [bundled] });
  env.user("merge.json", fileOf("families", [{
    id: "alpha", $merge: "deep", notes: ["only"], engines: { vllm: { parsers: { tool: "b" } } },
  }]));
  const merged = loaderFor(t, env).matchFamily(cardOf("alpha_t")).entry;
  assert.equal(merged.contextMax, 1000, "untouched keys survive");
  assert.deepEqual(merged.notes, ["only"], "arrays replace");
  assert.deepEqual(merged.engines.vllm, { support: "verified", parsers: { tool: "b", reasoning: "r" } });
  assert.deepEqual(merged.engines.sglang, { support: "documented" });
  assert.equal(merged.$merge, undefined);

  env.user("merge.json", fileOf("families", [{ id: "alpha", match: { modelTypes: ["alpha_t"] }, engines: { vllm: { parsers: { tool: "c" } } } }]));
  const replaced = loaderFor(t, env).matchFamily(cardOf("alpha_t")).entry;
  assert.equal(replaced.contextMax, undefined, "no $merge: the whole entry is replaced");
  assert.deepEqual(replaced.engines, { vllm: { parsers: { tool: "c" } } });
});

test("$merge onto a missing base is a plain entry, and a merged result that breaks the schema keeps the base", (t) => {
  const env = environment(t, { families: [family("alpha", { contextMax: 1000 })] });
  env.user("a.json", fileOf("families", [
    { id: "gamma", $merge: "deep", match: { modelTypes: ["gamma_t"] } },
    { id: "alpha", $merge: "deep", priority: "high" },
  ]));
  const loader = loaderFor(t, env);
  assert.equal(loader.matchFamily(cardOf("gamma_t")).entry.id, "gamma");
  assert.equal(loader.matchFamily(cardOf("alpha_t")).entry.contextMax, 1000);
  assert.equal(errorsOf(loader, "invalid_entry").length, 1);
});

test("$delete hides a lower layer's entry, for every kind, and a lower layer comes back when the delete goes", (t) => {
  const env = environment(t, {
    families: [family("alpha"), family("beta")],
    templates: [{ id: "tpl", sha256: ["c".repeat(16)] }],
    errors: [signature("sig-a"), signature("sig-b")],
  });
  env.user("hide.json", fileOf("families", [{ id: "alpha", $delete: true }]));
  env.user("hide-sigs.json", fileOf("error-signatures", [{ id: "sig-a", $delete: true }]));
  env.user("hide-tpl.json", fileOf("template-signatures", [{ id: "tpl", $delete: true }, { id: "never-existed", $delete: true }]));
  const loader = loaderFor(t, env);
  assert.equal(loader.matchFamily(cardOf("alpha_t")).entry, null);
  assert.equal(loader.matchFamily(cardOf("beta_t")).entry.id, "beta");
  assert.deepEqual(loader.errorSignatures("vllm").map((item) => item.id), ["sig-b"]);
  assert.deepEqual(loader.entries("template-signatures"), []);
  assert.deepEqual(loader.status().errors, []);
  assert.deepEqual(loader.status().layers.find((layer) => layer.layer === "user").deleted.sort(), ["alpha", "sig-a", "tpl"]);

  fs.rmSync(path.join(env.configDir, "knowledge.d", "hide.json"));
  assert.equal(loader.matchFamily(cardOf("alpha_t")).entry.id, "alpha", "edits are picked up without a restart");
});

test("a per-model override cannot $delete, and only families can be scoped", (t) => {
  const env = environment(t, { families: [family("alpha")] });
  env.model("a.json", fileOf("families", [{ id: "alpha", $delete: true }]));
  env.model("b.json", fileOf("error-signatures", [signature("sig-a")]));
  const loader = loaderFor(t, env);
  assert.equal(errorsOf(loader, "delete_not_scoped").length, 1);
  assert.equal(errorsOf(loader, "kind_not_scoped").length, 1);
  assert.equal(loader.matchFamily(cardOf("alpha_t")).entry.id, "alpha");
});

// ----- invalid and unsafe entries

test("invalid entries are skipped and reported while their neighbours load", (t) => {
  const env = environment(t);
  env.user("mixed.json", fileOf("families", [
    family("good"),
    { id: "bad id!", match: { modelTypes: ["x"] } },
    { match: { modelTypes: ["x"] } },
    { id: "no-match" },
    { id: "empty-match", match: {} },
    { id: "bad-type", match: { modelTypes: "qwen" } },
    { id: "bad-priority", match: { modelTypes: ["x"] }, priority: "high" },
    { id: "bad-where", match: { modelTypes: ["x"], where: [{ path: "no-slash", op: "in" }] } },
    "not an object",
    family("also-good"),
  ]));
  const loader = loaderFor(t, env);
  assert.deepEqual(loader.entries("families").map((entry) => entry.id), ["good", "also-good"]);
  const errors = loader.status().errors;
  const ids = errors.map((item) => item.entryId);
  for (const id of ["bad id!", "no-match", "empty-match", "bad-type", "bad-priority", "bad-where"]) assert.ok(ids.includes(id), id);
  assert.ok(errors.every((item) => item.layer === "user" && item.file.endsWith("/mixed.json")), "errors name the file");
  const file = loader.status().layers.find((layer) => layer.layer === "user").files[0];
  assert.equal(file.entries, 2);
  assert.equal(file.errors.length, errors.length);
});

test("unsafe regular expressions are rejected in every kind, with a code the status reports", (t) => {
  const env = environment(t);
  const long = "a".repeat(301);
  env.user("fam.json", fileOf("families", [
    { id: "ok", match: { namePatterns: ["qwen3[._]?8(?![0-9])"] } },
    { id: "nested", match: { namePatterns: ["(a+)+$"] } },
    { id: "back", match: { architecturePatterns: ["(a)\\1"] } },
    { id: "long", match: { namePatterns: [long] } },
    { id: "where", match: { modelTypes: ["x"], where: [{ path: "/identity/displayName", op: "matches", value: "(x*)*" }] } },
  ]));
  env.user("sig.json", fileOf("error-signatures", [
    signature("sig-ok", { regex: "address already in use" }),
    signature("sig-bad", { regex: "(.+)+x" }),
    signature("sig-flags", { regex: "x", flags: "g" }),
    signature("sig-syntax", { regex: "(unclosed" }),
  ]));
  env.user("tpl.json", fileOf("template-signatures", [
    { id: "tpl-ok", features: { all: ["<tool_call>"], regex: ["reasoning_effort"] } },
    { id: "tpl-bad", features: { regex: ["(a|b*)*c"] } },
  ]));
  const loader = loaderFor(t, env);
  assert.deepEqual(loader.entries("families").map((entry) => entry.id), ["ok"]);
  assert.deepEqual(loader.entries("error-signatures").map((entry) => entry.id), ["sig-ok"]);
  assert.deepEqual(loader.entries("template-signatures").map((entry) => entry.id), ["tpl-ok"]);
  const byId = Object.fromEntries(loader.status().errors.map((item) => [item.entryId, item.code]));
  assert.equal(byId.nested, "unsafe_regex");
  assert.equal(byId.back, "unsafe_regex");
  assert.equal(byId.long, "invalid_entry", "the schema caps the length before the safety check");
  assert.equal(byId.where, "unsafe_regex");
  assert.equal(byId["sig-bad"], "unsafe_regex");
  assert.equal(byId["sig-flags"], "invalid_entry");
  assert.equal(byId["sig-syntax"], "unsafe_regex");
  assert.equal(byId["tpl-bad"], "unsafe_regex");
});

test("checkRegexSafety: length, backreferences, nested quantifiers, flags and syntax", () => {
  const safe = [
    "CUDA out of memory|out of memory",
    "unknown model architecture: '([^']+)'",
    "failed to allocate (CUDA\\d+) buffer of size (\\d+)",
    "qwen3[._]?8(?![0-9])",
    "(?:larger than the maximum number of tokens|No available memory)",
    "mamba cache align|block_size .*batched_tokens",
    "(a|b)?c",
    "(ab){2}",
    "[(+*]+",
    "\\(a+\\)+",
  ];
  for (const source of safe) assert.equal(checkRegexSafety(source, "i"), null, source);
  const unsafe = {
    "(a+)+": "regex_nested_quantifier",
    "(a*)*": "regex_nested_quantifier",
    "((a+)b)+": "regex_nested_quantifier",
    "(?:a{2,})+": "regex_nested_quantifier",
    "(a|b+)*": "regex_nested_quantifier",
    "(a)\\1": "regex_backreference",
    "(?<n>a)\\k<n>": "regex_backreference",
    [`${"x".repeat(301)}`]: "regex_too_long",
    "(oops": "regex_invalid",
    "": "regex_invalid",
  };
  for (const [source, code] of Object.entries(unsafe)) assert.equal(checkRegexSafety(source, "")?.code, code, source.slice(0, 30));
  assert.equal(checkRegexSafety("x", "g")?.code, "regex_flags");
  assert.equal(checkRegexSafety("x", "ii")?.code, "regex_flags");
  assert.equal(checkRegexSafety("x", "ims"), null);
  assert.equal(knowledgeModule.compileSafeRegex("(a+)+").ok, false);
  assert.ok(knowledgeModule.compileSafeRegex("a+b", "i").regexp.test("AAB"));
});

test("log scanning is bounded: the last 4000 lines, each cut to 2000 characters", () => {
  const lines = Array.from({ length: LOG_LINES_MAX + 25 }, (_, index) => (index === 0 ? "x".repeat(LOG_LINE_MAX + 50) : `line ${index}`));
  const prepared = prepareLogLines(lines.join("\n"));
  assert.equal(prepared.length, LOG_LINES_MAX);
  assert.equal(prepared[0], "line 25");
  assert.equal(prepareLogLines("y".repeat(LOG_LINE_MAX * 2))[0].length, LOG_LINE_MAX);
  assert.deepEqual(prepareLogLines(null), [""]);
});

// ----- corrupt files never break startup

test("startup never throws on a corrupt config/knowledge.d file; the other files still load", (t) => {
  const env = environment(t, { families: [family("alpha")] });
  env.user("a-good.json", fileOf("families", [family("beta")]));
  env.user("b-truncated.json", '{ "kind": "families", "entries": [ { "id": "x", ');
  env.user("c-empty.json", "   ");
  env.user("d-array.json", "[1, 2, 3]");
  env.user("e-kind.json", { kind: "recipes", entries: [] });
  env.user("f-entries.json", { kind: "families", entries: "nope" });
  env.user("g-version.json", { kind: "families", schemaVersion: 1, entries: [family("zeta")] });
  env.user("h-garbage.json", Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x80]).toString("latin1"));
  fs.writeFileSync(path.join(env.configDir, "knowledge.d", "i-big.json"), Buffer.alloc(1024 * 1024 + 10, 0x20));
  fs.mkdirSync(path.join(env.configDir, "knowledge.d", "j-directory.json"));
  env.pack(packFile("broken", "000000000000"), "not json at all");
  env.model("broken.json", "{");
  env.v1("{ broken v1");

  const loader = loaderFor(t, env, { convertV1: () => { throw new Error("must not be called for an unparsable file"); } });
  assert.doesNotThrow(() => loader.load({ force: true }));
  assert.deepEqual(loader.entries("families").map((entry) => entry.id), ["alpha", "beta"]);
  const status = loader.status();
  const codes = new Set(status.errors.map((item) => item.code));
  for (const code of ["invalid_json", "empty_file", "not_an_object", "unknown_kind", "invalid_header", "file_too_large"]) assert.ok(codes.has(code), code);
  const user = status.layers.find((layer) => layer.layer === "user");
  assert.deepEqual(user.files.map((file) => file.name), [
    "a-good.json", "b-truncated.json", "c-empty.json", "d-array.json", "e-kind.json", "f-entries.json", "g-version.json", "h-garbage.json", "i-big.json",
  ]);
  assert.equal(user.files[0].entries, 1);
  assert.equal(status.lastGoodDigest, null, "no load without an error yet");
});

test("a missing or unreadable bundled file is reported, the other bundled files still load", (t) => {
  const env = environment(t, { families: [family("alpha")] });
  fs.rmSync(path.join(env.bundledDir, "template-signatures.json"));
  fs.writeFileSync(path.join(env.bundledDir, "error-signatures.json"), JSON.stringify(fileOf("families", [])));
  const loader = loaderFor(t, env);
  assert.deepEqual(loader.entries("families").map((entry) => entry.id), ["alpha"]);
  assert.deepEqual(loader.status().errors.map((item) => item.code).sort(), ["kind_mismatch", "missing"]);
});

test("a configDir that does not exist, or a knowledge.d that is a file, loads the bundled layer alone", (t) => {
  const env = environment(t, { families: [family("alpha")] });
  fs.rmSync(env.configDir, { recursive: true, force: true });
  assert.deepEqual(loaderFor(t, env).status().errors, []);
  fs.mkdirSync(env.configDir, { recursive: true });
  fs.writeFileSync(path.join(env.configDir, "knowledge.d"), "i am a file");
  const loader = loaderFor(t, env);
  assert.equal(loader.matchFamily(cardOf("alpha_t")).entry.id, "alpha");
  assert.doesNotThrow(() => loader.status());
});

test("the legacy v1 layer reports instead of throwing: no converter yet, a throwing converter, bad output", (t) => {
  const env = environment(t, { families: [family("alpha")] });
  env.v1({ schemaVersion: 1, entries: [] });
  const noConverter = loaderFor(t, env, { convertV1: undefined });
  const info = noConverter.status().errors.find((item) => item.code === "converter_unavailable");
  // Without migrate-v1.js (MOD-6) the file is noted at info level and does not count as an error.
  if (info) assert.equal(info.severity, "info");
  const throwing = loaderFor(t, env, { convertV1: () => { throw new Error("boom"); } });
  assert.equal(errorsOf(throwing, "conversion_failed").length, 1);
  assert.equal(throwing.matchFamily(cardOf("alpha_t")).entry.id, "alpha");
  const bad = loaderFor(t, env, { convertV1: () => ({ nothing: true }) });
  assert.equal(errorsOf(bad, "conversion_failed").length, 1);
  const warned = loaderFor(t, env, { convertV1: () => ({ families: fileOf("families", []), warnings: ["image moved to a recipe"] }) });
  assert.equal(warned.status().errors.find((item) => item.code === "v1_warning").severity, "warning");
});

test("a failed load still answers: status and matching never throw", (t) => {
  const env = environment(t);
  const loader = loaderFor(t, env, {
    // A registry whose listing explodes must not take the loader down.
    registry: { errorSignatureAdditions() { throw new Error("registry exploded"); } },
  });
  assert.doesNotThrow(() => loader.status());
  assert.equal(errorsOf(loader, "descriptor_additions_failed").length, 1);
  assert.equal(loader.matchFamily(null).entry, null);
  assert.equal(loader.matchFamily({}).entry, null);
  assert.deepEqual(loader.errorSignatures("vllm"), []);
});

// ----- engine descriptor additions and the `stage` alias

test("registry.errorSignatureAdditions() is merged into the bundled layer with engines defaulted", (t) => {
  const env = environment(t, { errors: [signature("llama-oom", { code: "cuda_buffer_alloc", engines: ["llamacpp"] })] });
  const additions = [
    { engineId: "vllm", id: "vllm-flag-unknown", stage: "container", rootCause: true, regex: "unrecognized arguments: (\\S+)", title: { en: "Unknown flag {1}" } },
    { engineId: "sglang", id: "sglang-flag-unknown", code: "flag_unknown", phase: "container", regex: "unrecognized arguments", engines: ["sglang"] },
    { id: "generic-addition", regex: "something generic", phase: "api" },
  ];
  let calls = 0;
  const registry = { errorSignatureAdditions() { calls += 1; return additions; } };
  const loader = loaderFor(t, env, { registry });
  assert.deepEqual(loader.status().errors, []);
  const forVllm = loader.errorSignatures("vllm");
  assert.deepEqual(forVllm.map((item) => item.id), ["vllm-flag-unknown", "generic-addition"], "engine-specific entries come before generic ones");
  const added = forVllm[0];
  assert.deepEqual(added.engines, ["vllm"], "engines defaults to the descriptor id");
  assert.equal(added.phase, "container", "stage was accepted as phase");
  assert.equal(added.stage, undefined);
  assert.equal(added.code, "vllm_flag_unknown", "a missing code is derived from the id");
  assert.equal(added.layer, "bundled");
  assert.ok(added.regexp instanceof RegExp);
  assert.ok(added.regexp.test("error: UNRECOGNIZED ARGUMENTS: --foo"));
  assert.deepEqual(forVllm[1].engines, ["*"]);
  assert.deepEqual(loader.errorSignatures("llamacpp").map((item) => item.id), ["llama-oom", "generic-addition"]);
  assert.deepEqual(loader.errorSignatures("sglang").map((item) => item.id), ["sglang-flag-unknown", "generic-addition"]);
  assert.equal(loader.errorSignatures().length, 4, "without an engine id every signature is listed");
  const descriptors = loader.status().layers[0].files.find((file) => file.name === "engine descriptors");
  assert.equal(descriptors.entries, 3);
  assert.ok(calls >= 1);

  // The keyed form { engineId: [entries] } is accepted too.
  const keyed = loaderFor(t, env, { registry: { errorSignatureAdditions: () => ({ vllm: [{ id: "keyed", regex: "k" }] }) } });
  assert.deepEqual(keyed.errorSignatures("vllm").map((item) => [item.id, item.engines]), [["keyed", ["vllm"]]]);
});

test("owner layers override a descriptor addition by id, and $delete hides it", (t) => {
  const additions = [
    { engineId: "vllm", id: "vllm-flag-unknown", phase: "container", regex: "unrecognized", title: { en: "From the descriptor" } },
    { engineId: "vllm", id: "vllm-other", phase: "container", regex: "other" },
  ];
  const env = environment(t);
  env.user("owner.json", fileOf("error-signatures", [
    { id: "vllm-flag-unknown", $merge: "deep", title: { en: "From the owner" }, hint: { en: "Check the flag." } },
    { id: "vllm-other", $delete: true },
  ]));
  const loader = loaderFor(t, env, { registry: { errorSignatureAdditions: () => additions } });
  const [only] = loader.errorSignatures("vllm");
  assert.deepEqual(loader.errorSignatures("vllm").map((item) => item.id), ["vllm-flag-unknown"]);
  assert.equal(only.title.en, "From the owner");
  assert.equal(only.regex, "unrecognized", "deep merge keeps the descriptor's pattern");
  assert.equal(only.layer, "user");
});

test("an addition whose code duplicates a bundled knowledge entry is dropped and reported as duplicate_code", (t) => {
  const env = environment(t, { errors: [signature("cuda-oom", { code: "cuda_oom", engines: ["*"], regex: "out of memory" })] });
  const additions = [
    { engineId: "vllm", id: "vllm-oom-again", code: "cuda_oom", phase: "kv", regex: "OOM!" },
    { engineId: "vllm", id: "cuda-oom", code: "other_code", phase: "kv", regex: "OOM?" },
    { engineId: "vllm", id: "vllm-ok", code: "vllm_ok", phase: "kv", regex: "fine" },
    // Two descriptors may share a code between themselves.
    { engineId: "sglang", id: "sglang-ok", code: "vllm_ok", phase: "kv", regex: "fine too" },
  ];
  const loader = loaderFor(t, env, { registry: { errorSignatureAdditions: () => additions } });
  assert.deepEqual(loader.entries("error-signatures").map((item) => item.id), ["cuda-oom", "vllm-ok", "sglang-ok"]);
  const duplicate = errorsOf(loader, "duplicate_code");
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].entryId, "vllm-oom-again");
  assert.equal(duplicate[0].file, "engine descriptors");
  assert.equal(errorsOf(loader, "duplicate_id").length, 1);
});

test("the deprecated `stage` key is accepted as `phase` in every layer; a conflict is reported", (t) => {
  const env = environment(t, { errors: [{ ...signature("sig-a"), phase: undefined, stage: "kv" }] });
  env.user("owner.json", fileOf("error-signatures", [
    { ...signature("sig-b"), phase: undefined, stage: "api" },
    { ...signature("sig-c"), phase: "api", stage: "api" },
    { ...signature("sig-d"), phase: "api", stage: "kv" },
    { ...signature("sig-e"), phase: undefined, stage: "nowhere" },
  ]));
  const loader = loaderFor(t, env);
  const byId = Object.fromEntries(loader.entries("error-signatures").map((item) => [item.id, item]));
  assert.equal(byId["sig-a"].phase, "kv");
  assert.equal(byId["sig-b"].phase, "api");
  assert.equal(byId["sig-c"].phase, "api");
  assert.equal(byId["sig-a"].stage, undefined);
  assert.equal(byId["sig-d"], undefined);
  assert.equal(byId["sig-e"], undefined);
  assert.equal(errorsOf(loader, "phase_stage_conflict").length, 1);
  assert.equal(errorsOf(loader, "invalid_entry").length, 1);
});

test("suggestion params must exist in an engine parameter catalog", (t) => {
  const env = environment(t);
  env.user("sigs.json", fileOf("error-signatures", [
    signature("known", { suggestions: [{ kind: "param", param: "contextLength", to: "planner" }, { kind: "param", param: "vllm.maxNumBatchedTokens", to: "planner" }, { kind: "probe" }] }),
    signature("unknown", { suggestions: [{ kind: "param", param: "noSuchParameter", to: 1 }] }),
  ]));
  // Default: the bundled 01 catalogs (the process-wide catalog reads bundled data under AI_REFERENCE_DATA_DIR).
  const loader = loaderFor(t, env, { paramIds: undefined });
  assert.deepEqual(loader.entries("error-signatures").map((item) => item.id), ["known"]);
  assert.equal(errorsOf(loader, "unknown_param")[0].entryId, "unknown");
  // A set of ids replaces the catalogs; null skips the check.
  assert.equal(loaderFor(t, env, { paramIds: new Set(["noSuchParameter", "contextLength", "vllm.maxNumBatchedTokens"]) }).entries("error-signatures").length, 2);
  assert.equal(loaderFor(t, env, { paramIds: null }).entries("error-signatures").length, 2);
});

// ----- matching

test("matchFamily: declared identity gates, clauses discriminate, the most specific entry wins", (t) => {
  const env = environment(t, {
    families: [
      family("generic", { match: { modelTypes: ["qwen3_5"] }, priority: 0 }),
      family("specific", {
        match: { modelTypes: ["qwen3_5"], require: [{ templateSignature: ["qwen38-xml-effort"] }], where: [{ path: "/topology/hiddenSize", op: "in", value: [5120, 2560] }] },
      }),
      family("boosted", { match: { modelTypes: ["boosted_t"] }, priority: 5 }),
      family("boosted-too", { match: { modelTypes: ["boosted_t"], where: [{ path: "/topology/layers", op: "gte", value: 1 }] } }),
      family("gguf", { match: { ggufArchitectures: ["deepseek4"] } }),
      family("arch", { match: { architecturePatterns: ["^museglimmer"] } }),
    ],
  });
  const loader = loaderFor(t, env);
  const qwen = (extra = {}) => cardOf("qwen3_5", { topology: { hiddenSize: 5120, layers: 64 }, template: { signatureId: "qwen38-xml-effort" }, ...extra });
  const found = loader.matchFamily(qwen());
  assert.equal(found.entry.id, "specific");
  assert.equal(found.confidence, "detected", "a template clause was needed");
  assert.ok(found.matchedBy.includes("modelTypes") && found.matchedBy.includes("templateSignature"));
  assert.equal(found.matchedByText, found.matchedBy.join("+"));
  assert.equal(loader.matchFamily(qwen({ template: { signatureId: "other" } })).entry.id, "generic");
  assert.equal(loader.matchFamily(qwen({ topology: { hiddenSize: 1 }, template: { signatureId: "qwen38-xml-effort" } })).entry.id, "generic");
  assert.equal(loader.matchFamily(qwen()).confidence, "detected");
  assert.equal(loader.matchFamily(cardOf("qwen3_5")).confidence, "declared");
  assert.equal(loader.matchFamily(cardOf("boosted_t", { topology: { layers: 2 } })).entry.id, "boosted", "priority beats clause count");
  assert.equal(loader.matchFamily(cardOf("unrelated")).entry, null);
  assert.equal(loader.matchFamily(card({ identity: { ggufArchitecture: "deepseek4", architectures: [] } })).entry.id, "gguf");
  assert.equal(loader.matchFamily(card({ identity: { architectures: ["MuseGlimmerForCausalLM"] } })).entry.id, "arch");
  assert.equal(loader.matchFamily(cardOf("qwen3_5")).knowledgeConfidence, null);
});

test("matchFamily: name patterns are the last resort and only for cards that declare no identity", (t) => {
  const env = environment(t, {
    families: [
      family("named", { confidence: "verified", match: { modelTypes: ["named_t"], namePatterns: ["^named[- ]model"] } }),
      family("only-name", { match: { namePatterns: ["only[-_]name"] } }),
    ],
  });
  const loader = loaderFor(t, env);
  const unnamed = card({ identity: { displayName: "Named Model 7B", architectures: [] } });
  const byName = loader.matchFamily(unnamed);
  assert.equal(byName.entry.id, "named");
  assert.equal(byName.confidence, "name-heuristic");
  assert.equal(byName.knowledgeConfidence, "verified", "the entry's own confidence is reported separately");
  assert.deepEqual(byName.matchedBy, ["namePatterns"]);
  // A card that declares anything is not matched by name.
  assert.equal(loader.matchFamily(cardOf("other_t", { identity: { modelType: "other_t", displayName: "Named Model 7B" } })).entry, null);
  assert.equal(loader.matchFamily(cardOf("other_t", { identity: { modelType: "other_t", displayName: "only-name" } })).entry, null);
  // The folder name counts when the card has no display name.
  assert.equal(loader.matchFamily(card({ ref: { kind: "local", path: "/models/Only_Name-7B" } })).entry.id, "only-name");
  assert.equal(loader.matchFamily(card({ ref: { kind: "hf", repo: "someone/named-model-fp8" }, identity: {} })).entry.id, "named");
});

test("heuristic hits are persisted to knowledge-hits.json and add up across loaders", async (t) => {
  const env = environment(t, { families: [family("named", { match: { namePatterns: ["^named"] } }), family("declared")] });
  const loader = loaderFor(t, env);
  const unnamed = card({ identity: { displayName: "named-7b", architectures: [] } });
  loader.matchFamily(unnamed);
  loader.matchFamily(unnamed);
  loader.matchFamily(cardOf("declared_t"));
  assert.equal(loader.status().heuristicHits.total, 2, "pending hits show in the status before the flush");
  assert.ok(!fs.existsSync(path.join(env.cacheDir, "knowledge-hits.json")), "nothing is written per match");
  assert.deepEqual(loader.flushHits(), { ok: true, written: 1 });
  const stored = JSON.parse(fs.readFileSync(path.join(env.cacheDir, "knowledge-hits.json"), "utf8"));
  assert.deepEqual(stored.hits, { "families:named": 2 });
  assert.equal(stored.schemaVersion, 1);

  // A second process (the other manager) adds to the same file instead of overwriting it.
  const other = loaderFor(t, env);
  other.matchFamily(unnamed);
  other.flushHits();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.cacheDir, "knowledge-hits.json"), "utf8")).hits, { "families:named": 3 });
  const hits = loaderFor(t, env).status().heuristicHits;
  assert.deepEqual(hits.entries, [{ kind: "families", id: "named", count: 3 }]);
  assert.equal(hits.total, 3);

  // A corrupt counters file is ignored and rewritten.
  fs.writeFileSync(path.join(env.cacheDir, "knowledge-hits.json"), "{ not json");
  const third = loaderFor(t, env);
  assert.equal(third.status().heuristicHits.total, 0);
  third.matchFamily(unnamed);
  assert.equal(third.flushHits().ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.cacheDir, "knowledge-hits.json"), "utf8")).hits, { "families:named": 1 });
});

test("heuristic hits are flushed on a timer without being asked", async (t) => {
  const env = environment(t, { families: [family("named", { match: { namePatterns: ["^named"] } })] });
  const loader = loaderFor(t, env, { flushIntervalMs: 20 });
  loader.matchFamily(card({ identity: { displayName: "named-7b", architectures: [] } }));
  const file = path.join(env.cacheDir, "knowledge-hits.json");
  for (let attempt = 0; attempt < 100 && !fs.existsSync(file); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(file), "the timer wrote the counters");
});

test("a counters file that cannot be written is reported in the status, never thrown", (t) => {
  const env = environment(t, { families: [family("named", { match: { namePatterns: ["^named"] } })] });
  fs.mkdirSync(env.cacheDir, { recursive: true });
  // The cache path is a directory where the file should be, so the rename fails.
  fs.mkdirSync(path.join(env.cacheDir, "knowledge-hits.json"));
  const loader = loaderFor(t, env);
  loader.matchFamily(card({ identity: { displayName: "named-7b", architectures: [] } }));
  assert.equal(loader.flushHits().ok, false);
  const hits = loader.status().heuristicHits;
  assert.ok(hits.error);
  assert.equal(hits.total, 1, "the count is kept for the next flush");
});

test("per-model overrides select by contentDigest, repo or path, merge by id, and the model folder file is read-only knowledge", (t) => {
  const bundled = family("alpha", { contextMax: 1000, engines: { vllm: { support: "verified", parsers: { tool: "a", reasoning: "r" } } } });
  const env = environment(t, { families: [bundled] });
  const digest = `sha256:${"d".repeat(64)}`;
  env.model("by-digest.json", fileOf("families", [{ id: "alpha", $merge: "deep", match: { contentDigest: digest }, engines: { vllm: { parsers: { tool: "hermes" } } } }]));
  env.model("by-repo.json", fileOf("families", [{ id: "alpha", $merge: "deep", match: { repo: "Someone/Alpha-FP8" }, contextMax: 2000 }]));
  env.model("by-path.json", fileOf("families", [{ id: "alpha", match: { path: "/Models/Alpha-7B/" }, contextMax: 3000, label: "Standalone" }]));
  env.model("bad-selector.json", fileOf("families", [{ id: "alpha", match: { contentDigest: digest, repo: "a/b" } }, { id: "alpha2", match: { modelTypes: ["x"] } }]));
  const loader = loaderFor(t, env);

  const byDigest = loader.matchFamily(cardOf("alpha_t", { contentDigest: digest })).entry;
  assert.equal(byDigest.engines.vllm.parsers.tool, "hermes");
  assert.equal(byDigest.engines.vllm.parsers.reasoning, "r", "deep merge onto the family");
  assert.equal(byDigest.contextMax, 1000);
  assert.equal(loader.matchFamily(cardOf("alpha_t")).entry.engines.vllm.parsers.tool, "a", "other models are untouched");

  const byRepo = loader.matchFamily(cardOf("alpha_t", { ref: { kind: "hf", repo: "someone/alpha-fp8" } }));
  assert.equal(byRepo.entry.contextMax, 2000);
  assert.equal(byRepo.layer, "model");
  const viaOrigin = loader.matchFamily(cardOf("alpha_t", { origin: { source: "hf", repo: "someone/alpha-fp8" } }));
  assert.equal(viaOrigin.entry.contextMax, 2000);

  const byPath = loader.matchFamily(cardOf("alpha_t", { ref: { kind: "local", path: ["", "models", "alpha-7b"].join("\\") } })).entry;
  assert.equal(byPath.contextMax, 3000);
  assert.equal(byPath.engines, undefined, "no $merge: the standalone override replaces the family for that model");

  // A model matched by nothing else can still be given a family by a path override.
  const standalone = loader.matchFamily(card({ ref: { kind: "local", path: "/Models/Alpha-7B" } }));
  assert.equal(standalone.entry.id, "alpha");
  assert.equal(errorsOf(loader, "invalid_entry").length, 2, "two selectors in one match, and a family match in the model layer");

  // <modelDir>/.platform/model.json
  const modelDir = path.join(env.root, "models", "folder");
  fs.mkdirSync(path.join(modelDir, ".platform"), { recursive: true });
  const folderCard = cardOf("alpha_t", { ref: { kind: "local", path: modelDir } });
  fs.writeFileSync(path.join(modelDir, ".platform", "model.json"), JSON.stringify(fileOf("families", [{ id: "alpha", $merge: "deep", contextMax: 4000, match: { repo: "ignored/x" } }, { id: "bad id", contextMax: 1 }])));
  assert.equal(loader.matchFamily(folderCard).entry.contextMax, 4000);
  assert.equal(loader.matchFamily(folderCard).layer, "model");
  // The owner's central file beats the file next to the weights.
  env.model("central.json", fileOf("families", [{ id: "alpha", $merge: "deep", match: { path: modelDir }, contextMax: 6000 }]));
  assert.equal(loader.matchFamily(folderCard).entry.contextMax, 6000);
  // A corrupt folder file is ignored.
  fs.writeFileSync(path.join(modelDir, ".platform", "model.json"), "{ nope");
  fs.rmSync(path.join(env.configDir, "knowledge.d", "models", "central.json"));
  assert.equal(loader.matchFamily(folderCard).entry.contextMax, 1000);
});

test("familyIdForCapabilityId resolves aliases and family ids, and refuses anything else", (t) => {
  const env = environment(t, { families: [family("alpha")] });
  writeJson(env.bundledDir, KIND_FILES.families, fileOf("families", [family("alpha")], { capabilityIdAliases: { "old-alpha": "alpha", "__proto__": "alpha", "bad id": "alpha" } }));
  const loader = loaderFor(t, env);
  assert.equal(loader.familyIdForCapabilityId("old-alpha"), "alpha");
  assert.equal(loader.familyIdForCapabilityId("alpha"), "alpha");
  assert.equal(loader.familyIdForCapabilityId("missing"), null);
  assert.equal(loader.familyIdForCapabilityId("__proto__"), null);
  assert.equal(loader.familyIdForCapabilityId("constructor"), null);
  assert.equal(loader.familyIdForCapabilityId(7), null);
  assert.equal(errorsOf(loader, "invalid_alias").length, 1, "the unsafe key never reaches the table; an invalid id is reported");
  assert.equal(Object.getPrototypeOf({}).alpha, undefined);
});

test("the tensor class table follows the layers: the highest usable table wins, unsafe classes are dropped", (t) => {
  const env = environment(t);
  env.user("classes.json", fileOf("families", [], {
    tensorClasses: [
      { class: "experts", patterns: ["\\.my_experts\\."], layerGroup: 1 },
      { class: "bad", patterns: ["(a+)+"] },
      { class: "also bad", patterns: ["x"] },
    ],
  }));
  const loader = loaderFor(t, env);
  assert.deepEqual(loader.tensorClasses().map((item) => item.class), ["experts"]);
  assert.equal(errorsOf(loader, "unsafe_regex").length, 1);
  assert.equal(errorsOf(loader, "invalid_entry").length, 1);
  // Nothing usable anywhere: the table topology.js ships with.
  const bare = environment(t);
  writeJson(bare.bundledDir, KIND_FILES.families, fileOf("families", []));
  assert.equal(loaderFor(t, bare).tensorClasses().length, DEFAULT_TENSOR_CLASSES.length);
});

test("edited files are picked up without a restart, and the last good digest survives a bad edit", (t) => {
  const env = environment(t, { families: [family("alpha", { contextMax: 1 })] });
  let clock = 1_000_000;
  const loader = loaderFor(t, env, { recheckMs: 1000, now: () => clock });
  const first = loader.load();
  assert.equal(loader.status().lastGoodDigest, first.digest);
  env.user("edit.json", fileOf("families", [family("alpha", { contextMax: 2 })]));
  assert.equal(loader.matchFamily(cardOf("alpha_t")).entry.contextMax, 1, "inside the recheck window the cached load is used");
  clock += 1500;
  assert.equal(loader.matchFamily(cardOf("alpha_t")).entry.contextMax, 2);
  const good = loader.load().digest;
  assert.notEqual(good, first.digest);
  env.user("edit.json", "{ broken");
  clock += 1500;
  const after = loader.status();
  assert.equal(loader.matchFamily(cardOf("alpha_t")).entry.contextMax, 1, "a corrupt file is skipped, the layers below stay in force");
  assert.equal(after.digest, first.digest);
  assert.equal(after.lastGoodDigest, good, "the last error-free load stays on record");
  assert.ok(after.errors.some((item) => item.code === "invalid_json"));
});

test("stale files are flagged by asOf and staleAfterDays; entries without a fixture are listed", (t) => {
  const env = environment(t, { families: [family("with-fixture", { fixtures: ["qwen38-27b-fp8"] }), family("without-fixture")] });
  writeJson(env.bundledDir, KIND_FILES["error-signatures"], fileOf("error-signatures", [], { asOf: "2020-01-01", staleAfterDays: 30 }));
  env.user("odd-date.json", fileOf("families", [family("beta")], { asOf: "yesterday", staleAfterDays: 0 }));
  const loader = loaderFor(t, env, { now: () => Date.parse("2026-10-15T00:00:00Z") });
  const status = loader.status();
  assert.deepEqual(status.staleFiles, ["<AI_ROOT>/bundled/error-signatures.json"]);
  assert.deepEqual(status.entriesWithoutFixture, ["without-fixture"]);
  const odd = status.layers.find((layer) => layer.layer === "user").files[0];
  assert.equal(odd.entries, 1, "an invalid asOf does not discard the file");
  assert.equal(odd.asOf, "");
  assert.equal(odd.warnings.length, 2);
  assert.ok(status.errors.some((item) => item.code === "invalid_metadata" && item.severity === "warning"));
  assert.equal(status.digest === status.lastGoodDigest, true, "warnings do not count as a failed load");
});

test("prototype-polluting keys in entries never reach Object.prototype", (t) => {
  const env = environment(t, { families: [family("alpha", { engines: { vllm: { support: "verified" } } })] });
  env.user("evil.json", '{"kind":"families","entries":[{"id":"alpha","$merge":"deep","__proto__":{"polluted":true},"engines":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}]}');
  const loader = loaderFor(t, env);
  loader.load({ force: true });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.ok(loader.matchFamily(cardOf("alpha_t")).entry);
});

// ----- namespace wiring

test("core.models.knowledge is the namespace of §3.1, and the routes are not in the flat export list", () => {
  assert.equal(typeof core.models.knowledge.load, "function");
  assert.equal(typeof core.models.knowledge.status, "function");
  assert.equal(typeof core.models.knowledge.matchFamily, "function");
  assert.equal(typeof core.models.knowledge.errorSignatures, "function");
  assert.equal(typeof core.models.knowledge.familyIdForCapabilityId, "function");
  assert.equal(typeof core.models.knowledge.registerStatusProvider, "function");
  assert.equal(typeof core.registerModelInspectorRoutes, "function");
  assert.ok(!core.MODULES.some((name) => name.includes("model-inspector")));
  assert.doesNotThrow(() => core.mergeExports(core.MODULES));
});

// ----- the manager route module

function recordingApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
  };
}

function callStatus(app) {
  const res = fakeResponse();
  app.routes.get("GET /api/knowledge/status")({ headers: {}, query: {} }, res);
  return res;
}

test("GET /api/knowledge/status answers 200 with the models, engines and launch-params domains", (t) => {
  const env = environment(t, { families: [family("alpha")] });
  const loader = loaderFor(t, env);
  const app = recordingApp();
  const registry = core.engines.createEngineRegistry({ overrideDir: path.join(env.root, "engines"), env: {} });
  const paramCatalog = core.engines.createParamCatalog({ overrideDir: path.join(env.root, "launch-params") });
  const context = registerModelInspectorRoutes(app, { managerId: "vllm", knowledge: loader, registry, paramCatalog });
  assert.ok(app.routes.has("GET /api/knowledge/status"));
  assert.equal(context.managerId, "vllm");
  const res = callStatus(app);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.body.ok, true);
  assert.equal(res.body.managerId, "vllm");
  assert.deepEqual(res.body.domains.map((domain) => domain.domain), ["models", "engines", "launch-params"]);
  assert.match(res.body.digest, DIGEST);
  assert.equal(res.body.digest, res.body.domains[0].digest);
  const engines = res.body.domains.find((domain) => domain.domain === "engines");
  assert.deepEqual(engines.layers.map((layer) => layer.layer), ["bundled", "user"]);
  assert.ok(engines.layers[0].files.length >= 3);
  assert.deepEqual(engines.errors, []);
  const text = JSON.stringify(res.body).toLowerCase();
  assert.ok(!text.includes(env.root.toLowerCase().replace(/\\/g, "\\\\")), "no temp path in the answer");
  assert.ok(!text.includes(os.tmpdir().toLowerCase().replace(/\\/g, "\\\\")), "no temp path in the answer");
});

test("the status route stays 200 when a knowledge file or an engine override is corrupt", (t) => {
  const env = environment(t, { families: [family("alpha")] });
  env.user("corrupt.json", "{ broken");
  const overrideDir = path.join(env.root, "engines");
  writeJson(overrideDir, "bad.json", "{ nope");
  const loader = loaderFor(t, env);
  const app = recordingApp();
  registerModelInspectorRoutes(app, {
    managerId: "llama",
    knowledge: loader,
    registry: core.engines.createEngineRegistry({ overrideDir, env: {} }),
  });
  const res = callStatus(app);
  assert.equal(res.statusCode, 200);
  const models = res.body.domains.find((domain) => domain.domain === "models");
  assert.ok(models.errors.some((item) => item.code === "invalid_json" && item.file === "<AI_ROOT>/config/knowledge.d/corrupt.json"));
  const engines = res.body.domains.find((domain) => domain.domain === "engines");
  assert.ok(engines.errors.some((item) => item.code === "invalid_json" && /bad\.json$/.test(item.file)));
  assert.equal(res.body.managerId, "llama");
});

test("a status provider that throws, or a loader that cannot be read, is listed as unavailable with a 200", (t) => {
  const env = environment(t);
  const loader = loaderFor(t, env);
  const dispose = knowledgeModule.registerStatusProvider("recipes", () => { throw new Error("provider exploded"); });
  t.after(dispose);
  const app = recordingApp();
  registerModelInspectorRoutes(app, { managerId: "vllm", knowledge: loader });
  const res = callStatus(app);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.domains.find((domain) => domain.domain === "recipes"), {
    domain: "recipes", unavailable: true, layers: [], errors: [{ file: "", entryId: "", code: "status_failed", message: "provider exploded" }],
  });

  const broken = recordingApp();
  registerModelInspectorRoutes(broken, { managerId: "vllm", knowledge: { status() { throw new Error("loader exploded"); } } });
  const failed = callStatus(broken);
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.body.ok, true);
  assert.equal(failed.body.domains[0].unavailable, true);
  dispose();
});

test("registerStatusProvider validates its arguments and returns a disposer", () => {
  assert.throws(() => knowledgeModule.registerStatusProvider("models", () => ({})), TypeError);
  assert.throws(() => knowledgeModule.registerStatusProvider("Bad Domain", () => ({})), TypeError);
  assert.throws(() => knowledgeModule.registerStatusProvider("extra", "nope"), TypeError);
  const dispose = knowledgeModule.registerStatusProvider("extra", () => ({ layers: [{ layer: "bundled" }] }));
  const names = () => knowledgeModule.collectStatusDomains({ status: () => ({ domain: "models", digest: "x" }) }).map((domain) => domain.domain);
  assert.equal(names()[0], "models");
  assert.ok(names().includes("extra"));
  dispose();
  assert.ok(!names().includes("extra"));
});

test("route deps are normalized once: manager id, deny-by-default local gate, job functions, docker, instances, data dir", () => {
  const createJob = () => "job";
  const docker = () => "docker";
  const listInstances = () => [];
  const deps = normalizeRouteDeps({
    managerId: "vllm-manager",
    isLocalRequest: () => true,
    jobs: { createJob, appendLog() {}, finishJob() {}, failJob() {}, setJobProgress() {} },
    docker,
    listInstances,
    dataDir: "/data",
  });
  assert.equal(deps.managerId, "vllm");
  assert.equal(deps.isLocalRequest(), true);
  assert.equal(deps.jobs.createJob, createJob);
  assert.equal(deps.docker, docker);
  assert.equal(deps.listInstances, listInstances);
  assert.equal(deps.dataDir, "/data");
  assert.ok(Object.isFrozen(deps) && Object.isFrozen(deps.jobs));

  const flat = normalizeRouteDeps({ managerId: "llama", createJob, failJob: () => {} });
  assert.equal(flat.jobs.createJob, createJob, "flat job functions are accepted too");
  assert.equal(flat.jobs.appendLog, null);
  assert.equal(flat.isLocalRequest({}), false, "deny by default");
  assert.equal(flat.docker, null);
  assert.equal(flat.dataDir, null);
  assert.throws(() => normalizeRouteDeps({ managerId: "tts" }), /unknown managerId/);
  assert.throws(() => normalizeRouteDeps({}), TypeError);
  assert.throws(() => normalizeRouteDeps({ managerId: "entry" }), TypeError);
});

test("the route module hands the manager's engine registry to the process-wide loader", (t) => {
  core.models.knowledge.clearCache();
  t.after(() => core.models.knowledge.clearCache());
  const registry = { errorSignatureAdditions: () => [{ engineId: "vllm", id: "route-added", regex: "boom", phase: "api" }] };
  registerModelInspectorRoutes(recordingApp(), { managerId: "vllm", registry });
  assert.ok(core.models.knowledge.errorSignatures("vllm").some((item) => item.id === "route-added"));
  assert.ok(core.models.knowledge.status().layers[0].files.some((file) => file.name === "engine descriptors"));
});
