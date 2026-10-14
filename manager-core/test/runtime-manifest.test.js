const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const manifest = require("../runtime-manifest");

test.afterEach(() => {
  delete process.env.AI_REFERENCE_DATA_DIR;
  manifest.clearRuntimeManifestCache();
});

test("bundled runtime manifest validates and matches the pinned defaults", () => {
  const loaded = manifest.loadRuntimeManifest({ force: true });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.source, "bundled");
  assert.deepEqual(loaded.validation, { ok: true, errors: [] });
  assert.equal(loaded.usingFallback, false);
  assert.equal(loaded.runtimes.vllm.version, "v0.28.0");
  assert.equal(manifest.runtimeImageReference("vllm"), "vllm/vllm-openai@sha256:2286e8533ca8b6bc777594bae30524f1426ba46ca21797524e06df6a94b06635");
  assert.equal(manifest.runtimeImageReference("sglangFlashNext"), "local/sglang:qwen38flashnext-sm120-dac5523d");
  assert.equal(manifest.getRuntimeRelease("llama").build, 10630);
  assert.match(manifest.getRuntimeRelease("sglangFlashNext").build.context, /build-sources/);
  assert.ok(Object.isFrozen(loaded.runtimes.vllm), "runtime entries are frozen like the old constants");
  // Every bundled entry names its engine and maps to exactly one runtimeId (01-engines §5).
  assert.deepEqual(loaded.identity.errors, []);
  for (const [id, runtime] of Object.entries(loaded.runtimes)) {
    assert.ok(runtime.engineId, `${id}.engineId`);
    assert.ok(manifest.RUNTIME_STATUSES.includes(runtime.status), `${id}.status`);
    assert.equal(typeof runtime.features, "object", `${id}.features`);
    assert.ok(Object.hasOwn(runtime, "compatVersion"), `${id}.compatVersion`);
    assert.equal(loaded.identity.refs.get(id).runtimeId, manifest.runtimeIdFor(runtime.engineId, runtime.version));
  }
  assert.equal(manifest.runtimeImageReference("sglangPennyroyal"), "ghcr.io/jpezzulli/sglang-rtxpro6000:v2.5.1@sha256:76258532b1c01f7583fbe951f90b80903db931030291db9db4e5a68b28567866");
  assert.equal(manifest.runtimeImageReference("vllmQwenMoe"), "vllm/vllm-openai@sha256:754a391fb40c6106327042b97f4d3e32ec00376f3f3542bbc9fa9f4f06a95fbb");
  assert.equal(manifest.getRuntimeRelease("sglangFlashNextNvme").status, "experimental");
  const described = manifest.describeRuntimeManifest();
  assert.equal(described.runtimes.find((runtime) => runtime.id === "llama").runtimeId, "llamacpp@b10630");
  assert.deepEqual(described.identityErrors, []);
});

test("the fallback table maps every runtime to the same identity as the bundled data", () => {
  const bundled = manifest.loadRuntimeManifest({ force: true });
  for (const [id, runtime] of Object.entries(manifest.FALLBACK_RUNTIMES)) {
    assert.ok(bundled.runtimes[id], `${id} exists in the bundled data`);
    assert.equal(runtime.engineId, bundled.runtimes[id].engineId, id);
    assert.equal(manifest.runtimeIdFor(runtime.engineId, runtime.version), bundled.identity.refs.get(id).runtimeId, id);
    assert.deepEqual(runtime.features, bundled.runtimes[id].features, id);
  }
  assert.deepEqual(Object.keys(manifest.FALLBACK_RUNTIMES).sort(), Object.keys(bundled.runtimes).sort());
});

test("validation checks the registry identity fields", () => {
  const result = manifest.validateRuntimeManifest({
    runtimes: {
      a: { version: "1", repository: "x", engineId: "Not An Id" },
      b: { version: "1", repository: "x", status: "stable" },
      c: { version: "1", repository: "x", features: ["pleOffload"] },
      d: { version: "1", repository: "x", compatVersion: 5 },
      e: { version: "1", repository: "x", features: { nested: { deep: true } } },
      f: { version: "1", repository: "x", imageAliases: "x:latest" },
      ok: { version: "1", repository: "x", engineId: "sglang", status: "unpinned", compatVersion: null, features: { pleOffload: true } },
    },
  });
  assert.equal(result.ok, false);
  for (const fragment of ["a.engineId", "b.status", "c.features", "d.compatVersion", "e.features.nested", "f.imageAliases"]) {
    assert.ok(result.errors.some((item) => item.startsWith(fragment)), fragment);
  }
  assert.equal(result.errors.some((item) => item.startsWith("ok")), false);
});

test("the FlashNext local build records everything a rebuild needs", () => {
  const flashNext = manifest.getRuntimeRelease("sglangFlashNext", { force: true });
  assert.equal(flashNext.localBuild, true);
  assert.match(flashNext.baseImage, /^docker\.io\/lmsysorg\/sglang@sha256:[0-9a-f]{64}$/);
  assert.equal(flashNext.patch.commit, "dac5523d1e5d2f4297fec40ef02fc76fb0f662d1");
  assert.equal(flashNext.build.script, "scripts/rebuild-sglang-flashnext.ps1");
  const paths = manifest.resolveBuildPaths(flashNext, "D:/AI");
  assert.equal(path.basename(paths.dockerfile), "Dockerfile");
  assert.ok(paths.context.replaceAll("\\", "/").endsWith("artifacts/build-sources/sglang-qwen38-sm120-dac5523d"));
});

test("validation reports malformed digests and local builds without a context", () => {
  const result = manifest.validateRuntimeManifest({
    runtimes: {
      vllm: { version: "v1", repository: "x", platformDigest: "sha256:short" },
      custom: { localBuild: true, image: "local/x:1" },
      empty: {},
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("vllm.platformDigest")));
  assert.ok(result.errors.some((item) => item.includes("custom: local builds must record build.context")));
  assert.ok(result.errors.some((item) => item.includes("empty: needs version or image")));
});

test("a user override under the config directory replaces individual runtimes and keeps the rest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-manifest-"));
  fs.writeFileSync(path.join(dir, manifest.RUNTIME_MANIFEST_FILE), JSON.stringify({
    asOf: "2026-09-03",
    runtimes: { llama: { version: "b10700", build: 10700, image: "ghcr.io/ggml-org/llama.cpp:server-cuda-b10700" } },
  }));
  process.env.AI_REFERENCE_DATA_DIR = dir;
  const loaded = manifest.loadRuntimeManifest({ force: true });
  assert.equal(loaded.source, "user");
  assert.equal(loaded.runtimes.llama.build, 10700);
  assert.equal(loaded.runtimes.llama.image, "ghcr.io/ggml-org/llama.cpp:server-cuda-b10700");
  assert.equal(loaded.runtimes.vllm.version, "v0.28.0", "untouched runtimes fall back to the bundled values");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a broken user manifest keeps the fallback table and says so", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-manifest-bad-"));
  fs.writeFileSync(path.join(dir, manifest.RUNTIME_MANIFEST_FILE), "{ not json");
  process.env.AI_REFERENCE_DATA_DIR = dir;
  const loaded = manifest.loadRuntimeManifest({ force: true });
  assert.equal(loaded.runtimes.vllm.version, "v0.28.0");
  assert.match(String(loaded.error), /JSON|Unexpected/i);
  const described = manifest.describeRuntimeManifest();
  assert.ok(described.runtimes.some((runtime) => runtime.id === "sglangFlashNext" && runtime.localBuild));
  fs.rmSync(dir, { recursive: true, force: true });
});
