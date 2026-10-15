"use strict";

// A launch plan and a fit report the same memory (docs/overhaul/02-models.md
// §10.1, §21.2, MOD-9b): for 3 fixture cards x 3 engines, estimateFit and
// the 01 launch planner (POST /api/launch/plan's resolver) fed the same card,
// values and fake host give identical perGpuMb, policy and admissionRequestMb.
// A model:{card} request gets artifact inputs without any file on disk. Also
// covers planFacts, managerHooks and the cached artifactFor.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plan-fit-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");

const CARDS = path.join(__dirname, "fixtures", "model-cards");
const FIXTURES = ["qwen38-27b-fp8", "qwen38-flashnext-nvfp4", "deepseek-v4-flash-q2k-gguf"];
const ENGINES = [["vllm", "vllm"], ["vllm", "sglang"], ["llama", "llamacpp"]];
const GPUS = Object.freeze([{ id: "0", index: "0", name: "GPU 0", totalMb: 97887, usedMb: 600 }]);
const HOST = Object.freeze({ gpus: GPUS.map((gpu) => ({ ...gpu, freeMb: gpu.totalMb - gpu.usedMb })) });

function fixtureCard(id) {
  const card = structuredClone(require(path.join(CARDS, id, "expected-card.json")));
  card.cardId = `mc_${id.replace(/[^a-z0-9]/g, "").padEnd(20, "a").slice(0, 20)}`;
  return card;
}

function planner(managerId, modelFacts, { gpus = GPUS } = {}) {
  return core.engines.createLaunchPlanner({
    managerId,
    // The manager's own normalisation is not what is under test: a stub with
    // the run options the resolver reads.
    normalize: async () => ({
      runOptions: { instanceMode: "parallel", containerName: "plan-fit", port: 8100, gpuDeviceIds: ["0"] },
      jobMeta: {},
      admissionRequest: { requestedFraction: 0.7, estimatePolicy: "legacy_stub" },
      memory: null,
    }),
    getHostGpus: async () => gpus,
    modelFacts,
  });
}

function plainValues(values) {
  return Object.fromEntries(Object.entries(values).map(([id, entry]) => [id, entry && typeof entry === "object" && "value" in entry ? entry.value : entry]));
}

const VALUES = Object.freeze({ contextLength: 65536, concurrency: 2 });

for (const fixture of FIXTURES) {
  for (const [managerId, engineId] of ENGINES) {
    test(`plan and fit agree: ${fixture} on ${engineId}`, async () => {
      const card = fixtureCard(fixture);
      const hooks = core.models.managerHooks({});
      const plan = await planner(managerId, hooks.modelFacts).plan({
        engineId,
        model: { ref: "/fixture/models/not-on-disk", card },
        instance: { mode: "parallel", gpuIds: ["0"] },
        values: Object.fromEntries(Object.entries(VALUES).map(([id, value]) => [id, { value }])),
      });
      assert.deepEqual(plan.errors, []);
      assert.ok(plan.memory, "the plan has a memory block");
      assert.equal(plan.memory.artifact.contentDigest, card.contentDigest);
      assert.ok(plan.memory.artifact.cardId, "the card id rides along");

      const fit = core.models.fit.estimateFit({
        card,
        engineId,
        gpuIds: ["0"],
        values: plainValues(plan.values),
        host: HOST,
        budgetBasis: "now",
        instanceMode: "parallel",
      }, { suggestions: false });

      assert.deepEqual(plan.memory.perGpuMb, fit.perGpuMb);
      assert.equal(plan.memory.policy, fit.policy);
      assert.equal(plan.memory.admissionRequestMb, fit.admissionRequestMb);
      assert.deepEqual(plan.memory.breakdown, fit.breakdown);
      assert.ok(Object.values(fit.perGpuMb).every((mb) => mb > 0), "a non-trivial estimate");
    });
  }
}

test("a prospective request carrying only model:{card} gets artifact inputs from planFacts", async () => {
  const card = fixtureCard("qwen38-27b-fp8");
  const facts = await core.models.planFacts({ card }, { engineId: "vllm", hostFacts: HOST });
  assert.equal(facts.cardId, card.cardId);
  assert.equal(facts.contentDigest, card.contentDigest);
  assert.equal(facts.card.cardId, card.cardId);
  assert.equal(typeof facts.familyId === "string" || facts.familyId === null, true);
  const artifact = facts.artifactFor({ contextLength: 262144, concurrency: 1 }, ["0"]);
  assert.equal(artifact.schema, "artifact-memory-inputs/v1");
  assert.equal(artifact.kvBytesPerToken, 65536, "Qwen3.8-27B: 16 full layers, 4 KV heads, 256 dim, bf16");
  assert.equal(artifact.stateBytesPerSeq, 153944064);
  assert.ok(artifact.weightsMb > 25000 && artifact.weightsMb < 35000);
  assert.deepEqual(artifact, core.models.fit.fitMemoryInputs({
    card, engineId: "vllm", gpuIds: ["0"], host: HOST, values: { contextLength: 262144, concurrency: 1 },
  }).artifact, "the same artifact estimateFit builds");
});

test("artifactFor is cached per card, engine, paramsKey, GPU ids and values", async () => {
  const card = fixtureCard("qwen38-27b-fp8");
  const facts = await core.models.planFacts({ card }, { engineId: "vllm", hostFacts: HOST });
  const first = facts.artifactFor({ contextLength: 32768, concurrency: 1 }, ["0"]);
  assert.equal(facts.artifactFor({ contextLength: 32768, concurrency: 1 }, ["0"]), first, "same inputs, same object");
  assert.notEqual(facts.artifactFor({ contextLength: 65536, concurrency: 1 }, ["0"]), first);
  assert.notEqual(facts.artifactFor({ contextLength: 32768, concurrency: 1, "vllm.cpuOffloadGb": 8 }, ["0"]), first, "other values change the artifact");
});

test("a folder ref is inspected through the manager's resolver; an unresolvable or card-less ref gives no facts", async () => {
  const card = fixtureCard("qwen38-27b-fp8");
  const calls = [];
  const hooks = core.models.managerHooks({
    resolveModelPath: (ref) => (ref === "known" ? "/fixture/models/known" : null),
    inspectLocal: async (target, options) => { calls.push([target, options.depth]); return card; },
  });
  const facts = await hooks.modelFacts({ ref: "known" }, { engineId: "vllm", hostFacts: HOST });
  assert.equal(facts.cardId, card.cardId);
  assert.deepEqual(calls, [["/fixture/models/known", "full"]]);
  assert.equal(await hooks.modelFacts({ ref: "unknown" }, { engineId: "vllm", hostFacts: HOST }), null);
  assert.equal(await hooks.modelFacts({}, { engineId: "vllm", hostFacts: HOST }), null);
  assert.equal(await hooks.modelFacts(null, { engineId: "vllm", hostFacts: HOST }), null);
  const failing = core.models.managerHooks({ resolveModelPath: () => "/x", inspectLocal: async () => { throw new Error("boom"); } });
  assert.equal(await failing.modelFacts({ ref: "x" }, { engineId: "vllm", hostFacts: HOST }), null);
});

test("managerHooks returns all four callbacks and every one is a safe no-op until its package lands", async () => {
  const hooks = core.models.managerHooks({ managerId: "vllm", dataDir: "<DATA_DIR>", gpuStatus: async () => ({ gpus: [] }) });
  assert.deepEqual(Object.keys(hooks).sort(), ["afterReady", "calibrationFor", "classifyFailure", "modelFacts"]);
  assert.equal(hooks.calibrationFor({}, "vllm", "vllm@x", "1|1|auto|-"), null);
  assert.equal(await hooks.afterReady({ launchId: "lch_x" }), null);
  assert.equal(hooks.classifyFailure("", { engineId: "vllm", phase: "start" }), null);
});

test("without modelFacts, or with a model that has no card, the plan keeps the legacy memory view", async () => {
  const none = await planner("vllm", null).plan({
    engineId: "vllm",
    model: { ref: "/fixture/models/x" },
    instance: { mode: "parallel", gpuIds: ["0"] },
    values: { contextLength: { value: 8192 } },
  });
  assert.deepEqual(none.memory.perGpuMb, {});
  assert.equal(none.memory.artifact, undefined);
  const hooks = core.models.managerHooks({ resolveModelPath: () => null });
  const cardless = await planner("vllm", hooks.modelFacts).plan({
    engineId: "vllm",
    model: { ref: "/fixture/models/x" },
    instance: { mode: "parallel", gpuIds: ["0"] },
    values: { contextLength: { value: 8192 } },
  });
  assert.equal(cardless.memory.artifact, undefined);
  assert.deepEqual(cardless.memory.perGpuMb, {});
});

test("the plan's artifact estimate is plan-mode only and never changes the admission request the launch makes", async () => {
  const card = fixtureCard("qwen38-27b-fp8");
  const hooks = core.models.managerHooks({});
  let calls = 0;
  const counting = (model, options) => { calls += 1; return hooks.modelFacts(model, options); };
  const p = planner("vllm", counting);
  const request = {
    engineId: "vllm",
    model: { ref: "/fixture/models/not-on-disk", card },
    instance: { mode: "parallel", gpuIds: ["0"] },
    values: { contextLength: { value: 8192 } },
  };
  const plan = await p.plan(request);
  assert.equal(calls, 1);
  assert.equal(plan.legacy.admissionRequest.estimatePolicy, "legacy_stub", "the manager's admission request is untouched");
  await p.launch(request).catch(() => {});
  assert.equal(calls, 1, "a launch does not inspect the model for the plan view");
});
