const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLlamaGpuPlan, normalizeLlamaSplitMode, suggestTensorSplit } = require("../lib/gpu-plan");

const heteroGpus = [
  { id: "0", index: 0, name: "NVIDIA RTX PRO 6000 Blackwell", totalMb: 98304, usedMb: 4096, util: 10, temp: 55 },
  { id: "1", index: 1, name: "NVIDIA GeForce RTX 5090", totalMb: 32768, usedMb: 2048, util: 5, temp: 50 },
];

test("llama GPU plan recommends light offload split for 96GB plus 5090", () => {
  const plan = buildLlamaGpuPlan({ ok: true, gpus: heteroGpus }, ["0", "1"], 0.92, "layer", "0");

  assert.equal(plan.ok, true);
  assert.equal(plan.hetero, true);
  assert.equal(plan.recommendedMode, "layer");
  assert.equal(plan.recommendedTensorSplit, "72,16");
  assert.equal(plan.memoryTensorSplit, "88,29");
  assert.equal(plan.mainGpu, 0);
  assert.equal(plan.mainGpuHostId, "0");
  assert.equal(plan.selected[0].usableGb, 88.3);
  assert.equal(plan.selected[1].usableGb, 29);
  assert.ok(plan.profiles.some((profile) => profile.id === "hetero-layer-capacity" && profile.tensorSplit === "88,29"));
});

test("llama GPU plan maps host main GPU IDs to visible indexes", () => {
  const plan = buildLlamaGpuPlan({ ok: true, gpus: heteroGpus }, ["0", "1"], 0.92, "row", "1");

  assert.equal(plan.recommendedTensorSplit, "88,29");
  assert.equal(plan.mainGpu, 1);
  assert.equal(plan.mainGpuHostId, "1");
  assert.match(plan.summary, /row split 88,29/);
});

test("llama GPU plan handles single GPU and split mode aliases", () => {
  assert.equal(normalizeLlamaSplitMode("single"), "none");
  assert.equal(normalizeLlamaSplitMode("pipeline"), "layer");
  assert.equal(normalizeLlamaSplitMode("bad"), "layer");

  const plan = buildLlamaGpuPlan({ ok: true, gpus: heteroGpus }, ["1"], 0.92, "tensor", "0");
  assert.equal(plan.recommendedMode, "none");
  assert.equal(plan.recommendedTensorSplit, "");
  assert.equal(plan.mainGpuHostId, "1");
  assert.equal(suggestTensorSplit(heteroGpus, ["0", "1"], 0.92, "layer"), "72,16");
});
