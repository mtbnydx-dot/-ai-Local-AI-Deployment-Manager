"use strict";

// Engine registry identity rules (docs/overhaul/01-engines.md §3, §5, §25):
// unknown_engine, the legacy mapping table, hostedBy, manifest runtimeIds,
// runtimeForImage parity with vllm-manager's knownRuntimeImageMetadata, and
// pull policy per runtime.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// No installed <AI_ROOT>/config file may leak into these assertions.
const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const manifest = require("../runtime-manifest");

const BUNDLED_MANIFEST = path.join(__dirname, "..", "data", "runtime-manifest.json");

// Every key of the bundled JSON manifest and the one runtimeId it maps to. A new
// manifest key must be added here, with its engine's runtimes.allowed entry.
const EXPECTED_RUNTIME_IDS = Object.freeze({
  vllm: "vllm@0.28.0",
  vllmQwenMoe: "vllm@nightly-a16dbd5b",
  vllmGemma: "vllm@v74b5964f",
  sglang: "sglang@0.5.17",
  sglangFlashNext: "sglang@qwen38flashnext-sm120-dac5523d",
  sglangPennyroyal: "sglang@pennyroyal-v2.5.1",
  sglangFlashNextNvme: "sglang@flashnext-nvme-ple-20260831",
  llama: "llamacpp@b10630",
  llamaMuse: "llamacpp@muse-62bf73d",
});

// The image literals knownRuntimeImageMetadata matched (vllm-manager/server.js).
const IMAGES = Object.freeze({
  vllmDefault: "vllm/vllm-openai@sha256:2286e8533ca8b6bc777594bae30524f1426ba46ca21797524e06df6a94b06635",
  vllmManifestDigest: "vllm/vllm-openai@sha256:61fc8a896b0a4fbbbdc063bc4b0dbc25ce98e02b5050c24aeb7830ac02039b14",
  vllmTag: "vllm/vllm-openai:v0.28.0",
  sglangDefault: "lmsysorg/sglang@sha256:3ea7c6d74312d964edbcf9b3819425ea42117eb967ef1cfec632a70c926027df",
  sglangTag: "lmsysorg/sglang:0.5.17",
  sglangLatestRuntime: "lmsysorg/sglang:latest-runtime",
  flashNext: "local/sglang:qwen38flashnext-sm120-dac5523d",
  qwenMoe: "vllm/vllm-openai@sha256:754a391fb40c6106327042b97f4d3e32ec00376f3f3542bbc9fa9f4f06a95fbb",
  gemma: "vllm/vllm-openai@sha256:9c719fc0c869092c7d0533f8357d6985a38d5ff03b20ffb6a4620c2b4806dd4b",
  pennyroyal: "ghcr.io/jpezzulli/sglang-rtxpro6000:v2.5.1@sha256:76258532b1c01f7583fbe951f90b80903db931030291db9db4e5a68b28567866",
});

function withManifestOverride(t, runtimes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-manifest-"));
  fs.writeFileSync(path.join(dir, manifest.RUNTIME_MANIFEST_FILE), JSON.stringify({ asOf: "2026-10-14", runtimes }));
  process.env.AI_REFERENCE_DATA_DIR = dir;
  manifest.clearRuntimeManifestCache();
  t.after(() => {
    process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
    manifest.clearRuntimeManifestCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function emptyOverrideDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-override-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createRegistry(t, options = {}) {
  return core.engines.createEngineRegistry({ overrideDir: emptyOverrideDir(t), env: {}, ...options });
}

test("require() throws 400 unknown_engine and never coerces", (t) => {
  const registry = createRegistry(t);
  assert.equal(registry.require("sglang").id, "sglang");
  for (const value of ["nope", "VLLM", "llama", "", undefined, null, 7, "vllm "]) {
    assert.throws(() => registry.require(value), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "unknown_engine");
      assert.match(error.message, /Unknown inference engine/);
      return true;
    }, String(value));
  }
});

test("legacy engine values map through the §3 table in both directions", (t) => {
  const registry = createRegistry(t);
  const cases = [
    ["vllm", "vllm", "vllm"],
    ["sglang", "vllm", "sglang"],
    ["SGLang", "vllm-manager", "sglang"],
    ["llama", "llama", "llamacpp"],
    ["llama", "llama-manager", "llamacpp"],
    ["", "vllm", "vllm"],
    [undefined, "vllm", "vllm"],
    ["", "llama", "llamacpp"],
    ["llamacpp", "llama", "llamacpp"],
    ["mystery-engine", "vllm", "unknown"],
    ["lmdeploy", "vllm", "unknown"],
    ["", "nowhere", "unknown"],
  ];
  for (const [value, managerId, expected] of cases) {
    assert.equal(registry.fromLegacy(value, managerId), expected, `${value} @ ${managerId}`);
  }
  assert.equal(registry.toLegacy("vllm"), "vllm");
  assert.equal(registry.toLegacy("sglang"), "sglang");
  assert.equal(registry.toLegacy("llamacpp"), "llama");
});

test("hostedBy lists the engines each manager hosts", (t) => {
  const registry = createRegistry(t);
  assert.deepEqual(registry.hostedBy("vllm"), ["vllm", "sglang"]);
  assert.deepEqual(registry.hostedBy("vllm-manager"), ["vllm", "sglang"]);
  assert.deepEqual(registry.hostedBy("llama"), ["llamacpp"]);
  assert.deepEqual(registry.hostedBy("entry"), []);
  assert.deepEqual(registry.hostedBy("other"), []);
  assert.deepEqual(registry.list().map((descriptor) => descriptor.id), ["vllm", "sglang", "llamacpp"]);
});

test("every key of the bundled JSON manifest maps to exactly one runtimeId and engineId", (t) => {
  manifest.clearRuntimeManifestCache();
  const bundled = JSON.parse(fs.readFileSync(BUNDLED_MANIFEST, "utf8"));
  assert.deepEqual(Object.keys(bundled.runtimes).sort(), Object.keys(EXPECTED_RUNTIME_IDS).sort());
  assert.deepEqual(manifest.listRuntimeIdentityErrors({ force: true }), []);

  const registry = createRegistry(t);
  const runtimes = manifest.listRuntimes();
  const seenRuntimeIds = new Set();
  for (const [key, entry] of Object.entries(bundled.runtimes)) {
    assert.ok(entry.engineId, `${key} names its engineId explicitly`);
    assert.ok(entry.status, `${key} names its status explicitly`);
    const refs = runtimes.filter((ref) => ref.manifestKey === key);
    assert.equal(refs.length, 1, key);
    const [ref] = refs;
    assert.equal(ref.runtimeId, EXPECTED_RUNTIME_IDS[key], key);
    assert.equal(ref.engineId, entry.engineId, key);
    assert.ok(ref.runtimeId.startsWith(`${entry.engineId}@`), key);
    assert.equal(seenRuntimeIds.has(ref.runtimeId), false, `${ref.runtimeId} is unique`);
    seenRuntimeIds.add(ref.runtimeId);
    // Exactly one engine allows the key, and it is the key's own engine.
    const owners = registry.list().filter((descriptor) => descriptor.runtimes.allowed.includes(key)).map((descriptor) => descriptor.id);
    assert.deepEqual(owners, [entry.engineId], key);
    assert.ok(registry.runtimesFor(entry.engineId).some((item) => item.manifestKey === key), key);
  }
  assert.deepEqual(registry.errors(), []);

  const nvme = runtimes.find((ref) => ref.manifestKey === "sglangFlashNextNvme");
  assert.equal(nvme.runtimeId, "sglang@flashnext-nvme-ple-20260831");
  assert.equal(nvme.status, "experimental");
  assert.equal(nvme.localBuild, true);
  assert.deepEqual(nvme.features, {});
  assert.equal(runtimes.find((ref) => ref.manifestKey === "llamaMuse").status, "retired");
  assert.deepEqual(runtimes.find((ref) => ref.manifestKey === "sglangPennyroyal").features, { pleOffload: true, nextnFrSpec: true });
  assert.deepEqual(runtimes.find((ref) => ref.manifestKey === "llama").features, { reasoningEffort: true, mmprojDevice: true });
  assert.equal(runtimes.find((ref) => ref.manifestKey === "sglangFlashNext").compatVersion, "0.5.17");
});

test("runtimeIds drop a leading v only from dotted release numbers", () => {
  assert.equal(core.engines.runtimeIdFor("vllm", "v0.28.0"), "vllm@0.28.0");
  assert.equal(core.engines.runtimeIdFor("vllm", "v74b5964f"), "vllm@v74b5964f");
  assert.equal(core.engines.runtimeIdFor("sglang", "0.5.17"), "sglang@0.5.17");
  assert.equal(core.engines.runtimeIdFor("sglang", "qwen38flashnext-sm120-dac5523d"), "sglang@qwen38flashnext-sm120-dac5523d");
  assert.equal(core.engines.runtimeIdFor("llamacpp", "b10630"), "llamacpp@b10630");
  assert.equal(core.engines.runtimeIdFor("vllm", ""), "");
});

test("runtimeForImage covers every former knownRuntimeImageMetadata case", () => {
  manifest.clearRuntimeManifestCache();
  const lookup = (image) => core.engines.runtimeForImage(image);
  for (const image of [IMAGES.vllmDefault, IMAGES.vllmManifestDigest, IMAGES.vllmTag]) {
    const ref = lookup(image);
    assert.equal(ref?.manifestKey, "vllm", image);
    assert.equal(ref.release.transformersVersion, "5.15.1");
    assert.equal(ref.release.version, "v0.28.0");
  }
  for (const image of [IMAGES.sglangDefault, IMAGES.sglangTag, IMAGES.sglangLatestRuntime]) {
    const ref = lookup(image);
    assert.equal(ref?.manifestKey, "sglang", image);
    assert.equal(ref.release.version, "0.5.17");
  }
  // Local builds inherit their base release with their own (empty) digests.
  const flashNext = lookup(IMAGES.flashNext);
  assert.equal(flashNext.manifestKey, "sglangFlashNext");
  assert.equal(flashNext.release.version, "qwen38flashnext-sm120-dac5523d");
  assert.equal(flashNext.release.manifestDigest, "");
  assert.equal(flashNext.release.platformDigest, "");
  assert.equal(flashNext.release.minimumComputeCapability, "12.0");
  assert.deepEqual(flashNext.release.minimumDriverVersions, { win32: "580.88", linux: "580.65.06" });

  const qwenMoe = lookup(IMAGES.qwenMoe);
  assert.equal(qwenMoe.manifestKey, "vllmQwenMoe");
  assert.equal(qwenMoe.release.transformersVersion, "5.12.1");
  assert.equal(qwenMoe.release.platformDigest, IMAGES.qwenMoe.split("@")[1]);
  assert.equal(qwenMoe.release.manifestDigest, "");
  assert.equal(qwenMoe.release.minimumComputeCapability, "7.5", "inherits the vLLM release gate");
  assert.equal(qwenMoe.release.revision, "a16dbd5b8572d4128be9f10b9dcff4999b594b25");

  const gemma = lookup(IMAGES.gemma);
  assert.equal(gemma.manifestKey, "vllmGemma");
  assert.equal(gemma.release.transformersVersion, "5.10.2");
  assert.equal(gemma.release.platformDigest, IMAGES.gemma.split("@")[1]);
  assert.equal(gemma.compatVersion, null);

  assert.equal(lookup(IMAGES.pennyroyal).manifestKey, "sglangPennyroyal");
  assert.equal(lookup(IMAGES.pennyroyal.replace(":v2.5.1@", "@")).manifestKey, "sglangPennyroyal", "same repository and digest without the tag");
  assert.equal(lookup(`docker.io/${IMAGES.sglangDefault}`).manifestKey, "sglang");
  assert.equal(lookup(IMAGES.vllmTag.toUpperCase()).manifestKey, "vllm");
  assert.equal(lookup("sglang-flashnext-sm120:local").manifestKey, "sglangFlashNextNvme");
  assert.equal(lookup("vllm/vllm-openai:latest"), null);
  assert.equal(lookup("example/custom-engine:1"), null);
  assert.equal(lookup(""), null);
});

test("resolveRuntime selects by runtimeId, manifest key or image and fails with unknown_runtime", () => {
  manifest.clearRuntimeManifestCache();
  assert.equal(core.engines.resolveRuntime("sglang", { runtimeId: "sglang@pennyroyal-v2.5.1" }).manifestKey, "sglangPennyroyal");
  assert.equal(core.engines.resolveRuntime("llamacpp", { manifestKey: "llama" }).runtimeId, "llamacpp@b10630");
  assert.equal(core.engines.resolveRuntime("vllm", { image: IMAGES.gemma }).runtimeId, "vllm@v74b5964f");
  const custom = core.engines.resolveRuntime("vllm", { image: "example/custom-vllm:1" });
  assert.equal(custom.custom, true);
  assert.equal(custom.runtimeId, "vllm@custom");
  assert.deepEqual(custom.features, {}, "an unknown image assumes no gated feature");
  for (const [engineId, selector] of [
    ["sglang", { runtimeId: "sglang@9.9.9" }],
    ["sglang", { manifestKey: "llama" }],
    ["vllm", { image: IMAGES.sglangDefault }],
    ["vllm", {}],
  ]) {
    assert.throws(() => core.engines.resolveRuntime(engineId, selector), (error) => error.code === "unknown_runtime" && error.status === 404);
  }
});

test("env image overrides replace a slot's image and keep its identity and features", (t) => {
  const envImage = "ghcr.io/ggml-org/llama.cpp:server-cuda-b10700";
  const registry = createRegistry(t, { env: { LLAMA_IMAGE: envImage, SGLANG_IMAGE: "" } });
  const [llama, muse] = registry.runtimesFor("llamacpp");
  assert.equal(llama.runtimeId, "llamacpp@b10630");
  assert.equal(llama.image, envImage);
  assert.equal(llama.imageOverrideEnv, "LLAMA_IMAGE");
  assert.deepEqual(llama.features, { reasoningEffort: true, mmprojDevice: true });
  assert.equal(llama.pullPolicy, "auto", "env overrides of a tier-1 slot keep today's implicit pull");
  assert.equal(muse.imageOverrideEnv, null);
  assert.equal(registry.runtimesFor("sglang")[0].image, IMAGES.sglangDefault, "an empty env value is ignored");

  assert.equal(registry.resolveRuntime("llamacpp", { image: envImage }).manifestKey, "llama");
  assert.equal(registry.resolveRuntime("llamacpp").manifestKey, "llama", "no selector gives the default runtime");
  assert.equal(registry.resolveRuntime("sglang", { image: IMAGES.flashNext }).manifestKey, "sglangFlashNext");
  const custom = registry.resolveRuntime("vllm", { image: "example/custom-vllm:1" });
  assert.equal(custom.custom, true);
  assert.equal(custom.pullPolicy, "explicit");
  assert.throws(() => registry.resolveRuntime("vllm", { image: IMAGES.flashNext }), (error) => error.code === "unknown_runtime");
  assert.throws(() => registry.resolveRuntime("nope", {}), (error) => error.code === "unknown_engine");
});

test("pull policy is auto for pinned runtimes of stable tier-1 engines and explicit otherwise", (t) => {
  manifest.clearRuntimeManifestCache();
  const registry = createRegistry(t);
  const policies = Object.fromEntries(["vllm", "sglang", "llamacpp"].flatMap((engineId) => (
    registry.runtimesFor(engineId).map((ref) => [ref.runtimeId, ref.pullPolicy])
  )));
  assert.deepEqual(policies, {
    "vllm@0.28.0": "auto",
    "vllm@nightly-a16dbd5b": "auto",
    "vllm@v74b5964f": "auto",
    "sglang@0.5.17": "auto",
    // A local build cannot be pulled; a missing one becomes a plan blocker later.
    "sglang@qwen38flashnext-sm120-dac5523d": "auto",
    "sglang@pennyroyal-v2.5.1": "auto",
    "sglang@flashnext-nvme-ple-20260831": "explicit",
    "llamacpp@b10630": "auto",
    "llamacpp@muse-62bf73d": "explicit",
  });

  // An experimental engine never pulls implicitly, whatever its runtimes are.
  const overrideDir = emptyOverrideDir(t);
  fs.writeFileSync(path.join(overrideDir, "sglang.json"), JSON.stringify({ id: "sglang", status: "experimental" }));
  const experimental = core.engines.createEngineRegistry({ overrideDir, env: {} });
  assert.ok(experimental.runtimesFor("sglang").every((ref) => ref.pullPolicy === "explicit"));
});

test("a runtime-manifest override is mapped too: tags read unpinned, engineId is inferred, gaps are reported", (t) => {
  withManifestOverride(t, {
    llama: { version: "b10700", build: 10700, image: "ghcr.io/ggml-org/llama.cpp:server-cuda-b10700" },
    sglangLab: { version: "0.5.21", repository: "lmsysorg/sglang", platformDigest: `sha256:${"a".repeat(64)}` },
    mystery: { version: "1.0.0", image: "example/mystery:1.0.0" },
    vllmCopy: { engineId: "vllm", version: "0.28.0", image: "example/vllm-copy:0.28.0" },
  });
  const refs = manifest.listRuntimes({ force: true });
  const llama = refs.find((ref) => ref.manifestKey === "llama");
  assert.equal(llama.runtimeId, "llamacpp@b10700");
  assert.equal(llama.status, "unpinned");
  assert.equal(llama.compatVersion, "b10700");
  const lab = refs.find((ref) => ref.manifestKey === "sglangLab");
  assert.equal(lab.engineId, "sglang", "inferred from the key prefix");
  assert.equal(lab.status, "pinned");
  assert.deepEqual(manifest.listRuntimeIdentityErrors().map((item) => `${item.manifestKey}:${item.code}`).sort(), [
    "mystery:runtime_engine_unknown",
    "vllmCopy:duplicate_runtime_id",
  ]);
  assert.equal(refs.some((ref) => ref.manifestKey === "mystery" || ref.manifestKey === "vllmCopy"), false);

  const registry = createRegistry(t);
  assert.equal(registry.runtimesFor("llamacpp")[0].pullPolicy, "explicit", "an unpinned runtime is never pulled implicitly");
  const manifestErrors = registry.errors().filter((item) => item.source === "manifest").map((item) => item.code).sort();
  assert.deepEqual(manifestErrors, ["duplicate_runtime_id", "runtime_engine_unknown"]);
});

test("a broken runtime-manifest override is reported by the registry, not fatal", (t) => {
  const dir = withManifestOverride(t, {});
  fs.writeFileSync(path.join(dir, manifest.RUNTIME_MANIFEST_FILE), "{ broken");
  manifest.clearRuntimeManifestCache();
  const registry = createRegistry(t);
  assert.deepEqual(registry.runtimesFor("vllm")[0].runtimeId, "vllm@0.28.0", "the fallback table still serves");
  const manifestErrors = registry.errors().filter((item) => item.code === "manifest_invalid");
  assert.equal(manifestErrors.length, 1);
  assert.equal(path.basename(manifestErrors[0].file), manifest.RUNTIME_MANIFEST_FILE);
});

test("the namespace hangs off manager-core without flat exports", () => {
  assert.equal(typeof core.engines.createEngineRegistry, "function");
  assert.equal(typeof core.engines.registerEngineRoutes, "function");
  assert.equal(core.createEngineRegistry, undefined);
  assert.equal(core.validateDescriptor, undefined);
  assert.equal(core.engines.getEngineRegistry(), core.engines.getEngineRegistry(), "one process-wide registry");
  core.engines.clearEngineRegistryCache();
});
