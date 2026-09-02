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
