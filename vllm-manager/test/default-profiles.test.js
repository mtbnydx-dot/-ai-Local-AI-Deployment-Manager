const test = require("node:test");
const assert = require("node:assert/strict");
const { createVllmDefaultLaunchProfiles } = require("../lib/default-profiles");

test("vLLM default profiles keep builtin IDs and normalize configs", () => {
  const normalized = [];
  const profiles = createVllmDefaultLaunchProfiles((config) => {
    normalized.push(config);
    return { ...config, normalized: true };
  });

  assert.equal(profiles.length, 8);
  assert.deepEqual(profiles.map((profile) => profile.id), [
    "qwen38-vllm-mtp3-quality",
    "qwen38-sglang-dspark-fastest",
    "qwen38-nvfp4-capacity",
    "blackwell-96gb-256k",
    "claude-long-context-64k",
    "claude-maximum-context",
    "openwebui-chat",
    "low-vram-safe",
  ]);
  assert.equal(normalized.length, profiles.length);
  assert.equal(profiles.every((profile) => profile.source === "builtin"), true);
  assert.equal(profiles.every((profile) => profile.config.normalized), true);
  assert.equal(profiles.find((profile) => profile.id === "blackwell-96gb-256k").requirements.minSingleGpuMemoryGb, 80);

  const pro6000 = profiles.find((profile) => profile.id === "blackwell-96gb-256k");
  assert.equal(pro6000.config.maxModelLen, 262144);
  assert.equal(pro6000.config.maxNumSeqs, 1);
  assert.equal(pro6000.config.kvCacheDtype, "fp8");
  assert.deepEqual(pro6000.config.gpuDeviceIds, ["0"]);
  assert.equal(pro6000.config.clientPreset, "claude-cowork");
  const stable = profiles.find((profile) => profile.id === "qwen38-vllm-mtp3-quality");
  assert.equal(stable.config.engine, "vllm");
  assert.equal(stable.config.speculativeMode, "mtp");
  assert.equal(stable.config.numSpeculativeTokens, 3);
  assert.equal(stable.config.enablePrefixCaching, true);

  const fastest = profiles.find((profile) => profile.id === "qwen38-sglang-dspark-fastest");
  assert.equal(fastest.config.engine, "sglang");
  assert.equal(fastest.config.speculativeMode, "dspark");
  assert.equal(fastest.config.dsparkBlockSize, 7);
});
