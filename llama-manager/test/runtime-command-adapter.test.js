const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The runtime-command wrapper over the llamacpp adapter (docs/overhaul/
// 01-engines.md §5, §7, ENG-4): which runtime a launch resolves to, and with
// it the runtime.features that replaced supportsB10630Controls; the Muse
// recipe; replayed log lines on failure; the re-exported helpers.

// No installed <AI_ROOT>/config runtime manifest may leak into these assertions.
const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llama-runtime-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const runtimeCommand = require("../lib/runtime-command");
const llamacpp = require("../../manager-core/engines/adapters/llamacpp");
const runtimeManifest = require("../../manager-core/runtime-manifest");

const MUSE_IMAGE = "local/llama.cpp:server-cuda-muse-62bf73d";

function createBuilder(config = {}, launch = null) {
  const logs = [];
  const builder = runtimeCommand.createLlamaRuntimeCommandBuilder({
    CONFIG: { containerName: "llama-local", managerId: "llama-manager", hfCache: "C:/cache", modelsRoot: "C:/store", image: "llama:pinned", museImage: MUSE_IMAGE, ...config },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: (_job, line) => logs.push(line),
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: () => ["127.0.0.1:8080:8080"],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    normalizeGpuIds: (value) => value,
    normalizeDefaultTrueBoolean: (value, fallback) => value ?? fallback,
    windowsPathToContainerPath: (value) => String(value).replace("C:/store", "/models"),
    resolveLaunchModel: () => launch || ({ modelArg: "/models/qwen/model.gguf", effectiveLoadFormat: "gguf", ggufFiles: [] }),
  });
  return { ...builder, logs };
}

function baseOptions(extra = {}) {
  return {
    model: "C:/store/qwen/model.gguf", port: 8080, networkAccess: "local", serviceHost: "127.0.0.1",
    gpuDeviceIds: ["0"], textOnlyMode: true, multiGpuMode: "none", mainGpu: 0, name: "qwen",
    maxModelLen: 8192, maxNumSeqs: 1, batchSize: 2048, ubatchSize: 512, gpuLayers: -1,
    cacheTypeK: "f16", cacheTypeV: "f16", flashAttention: "auto", reasoning: "auto", reasoningFormat: "auto",
    reasoningEffort: "high",
    ...extra,
  };
}

test("the configured default image runs the manifest llama runtime and its b10630 controls", () => {
  const builder = createBuilder();
  const { ctx } = builder.planLlamaLaunch({}, baseOptions());
  assert.equal(ctx.runtime.runtimeId, "llamacpp@b10630");
  assert.equal(ctx.runtime.manifestKey, "llama");
  assert.equal(ctx.runtime.image, "llama:pinned");
  assert.equal(ctx.runtime.default, true);
  assert.deepEqual(ctx.runtime.features, { reasoningEffort: true, mmprojDevice: true });
  const { runArgs, runtimeImage } = builder.buildLlamaRuntimeCommand({}, baseOptions());
  assert.equal(runtimeImage, "llama:pinned");
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--reasoning-effort"), runArgs.indexOf("--reasoning-effort") + 2), ["--reasoning-effort", "high"]);
});

test("an image the manifest does not know is a custom runtime with no gated controls", () => {
  const builder = createBuilder();
  const opts = baseOptions({ runtimeImage: "example/llama:custom", textOnlyMode: false, mmproj: "C:/store/qwen/mmproj.gguf", mmprojDevice: "CUDA0" });
  const { ctx } = builder.planLlamaLaunch({}, opts);
  assert.equal(ctx.runtime.runtimeId, "llamacpp@custom");
  assert.equal(ctx.runtime.manifestKey, null);
  assert.deepEqual(ctx.runtime.features, {});
  const { runArgs, runtimeImage } = builder.buildLlamaRuntimeCommand({}, opts);
  assert.equal(runtimeImage, "example/llama:custom");
  assert.equal(runArgs.includes("--reasoning-effort"), false);
  assert.equal(runArgs.includes("--mmproj-device"), false);
  assert.ok(runArgs.includes("ai.manager.reasoning-effort=default"));
  assert.ok(runArgs.includes("ai.manager.mmproj-device=auto"));
  assert.ok(builder.logs.includes("Runtime example/llama:custom predates --reasoning-effort; requested high was left at template default."));
  assert.ok(builder.logs.includes("Runtime example/llama:custom predates --mmproj-device; requested CUDA0 was left at auto."));
});

test("the Muse image keeps the retired runtime's features, the pinned image keeps b10630's", () => {
  const builder = createBuilder();
  const muse = builder.planLlamaLaunch({}, baseOptions({ runtimeImage: MUSE_IMAGE })).ctx.runtime;
  assert.equal(muse.runtimeId, "llamacpp@muse-62bf73d");
  assert.deepEqual(muse.features, { reasoningEffort: false, mmprojDevice: false });
  assert.equal(builder.buildLlamaRuntimeCommand({}, baseOptions({ runtimeImage: MUSE_IMAGE })).runArgs.includes("--reasoning-effort"), false);

  // The manifest's own b10630 image is that runtime even when CONFIG.image is overridden.
  const pinnedImage = runtimeManifest.runtimeImageReference("llama");
  const pinned = builder.planLlamaLaunch({}, baseOptions({ runtimeImage: pinnedImage })).ctx.runtime;
  assert.equal(pinned.runtimeId, "llamacpp@b10630");
  assert.equal(pinned.image, pinnedImage);
  assert.equal(pinned.default, false);
  assert.ok(builder.buildLlamaRuntimeCommand({}, baseOptions({ runtimeImage: pinnedImage })).runArgs.includes("--reasoning-effort"));
});

test("a Muse Glimmer model applies the llama-muse-glimmer recipe", () => {
  const launch = { modelArg: "/models/muse/muse.gguf", effectiveLoadFormat: "gguf", ggufFiles: [], selectedModel: { architecture: "muse-glimmer" } };
  const builder = createBuilder({}, launch);
  const { plan, ctx } = builder.planLlamaLaunch({}, baseOptions({ model: "C:/store/muse" }));
  assert.equal(plan.recipe.id, "llama-muse-glimmer");
  assert.equal(ctx.runtime.runtimeId, "llamacpp@muse-62bf73d");
  const { runArgs, runtimeImage } = builder.buildLlamaRuntimeCommand({}, baseOptions({ model: "C:/store/muse" }));
  assert.equal(runtimeImage, MUSE_IMAGE);
  assert.deepEqual(runArgs.slice(-6), ["--temp", "1", "--top-p", "0.95", "--top-k", "64"]);
  assert.ok(builder.logs.includes(`Muse Glimmer runtime image: ${MUSE_IMAGE}`));

  // Without a Muse image configured the default image runs, as before.
  const fallback = createBuilder({ museImage: undefined }, launch);
  const result = fallback.buildLlamaRuntimeCommand({}, baseOptions({ model: "C:/store/muse" }));
  assert.equal(result.runtimeImage, "llama:pinned");
  assert.ok(result.runArgs.includes("--reasoning-effort"));
  assert.equal(fallback.logs.some((line) => line.includes("runtime image")), false);
  assert.ok(fallback.logs.includes("Muse Glimmer sampling defaults: temp=1, top-p=0.95, top-k=64."));

  // A model without the architecture or name gets no recipe.
  assert.equal(createBuilder().planLlamaLaunch({}, baseOptions()).plan.recipe, null);
});

test("a failed build still writes the lines logged before the failure", () => {
  const builder = createBuilder();
  assert.throws(
    () => builder.buildLlamaRuntimeCommand({ id: "serve-x" }, baseOptions({ textOnlyMode: false })),
    /Multimodal mode requires an mmproj GGUF file/,
  );
  assert.deepEqual(builder.logs, ["GGUF model: using /models/qwen/model.gguf"]);
});

test("the wrapper re-exports the adapter's helpers", () => {
  assert.equal(runtimeCommand.normalizeLlamaSpeculativeMode, llamacpp.normalizeLlamaSpeculativeMode);
  assert.equal(runtimeCommand.clampSpeculativeTokens, llamacpp.clampSpeculativeTokens);
  assert.equal(runtimeCommand.optionalSamplingNumber, llamacpp.optionalSamplingNumber);
  assert.equal(createBuilder().formatDockerPublishArgs, llamacpp.formatDockerPublishArgs);
  assert.equal(runtimeCommand.normalizeLlamaSpeculativeMode("auto", "C:/store/qwen-MTP.gguf"), "draft-mtp");
  assert.equal(runtimeCommand.clampSpeculativeTokens(40), 16);
});
