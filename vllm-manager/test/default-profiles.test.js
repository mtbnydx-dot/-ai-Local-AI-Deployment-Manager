const test = require("node:test");
const assert = require("node:assert/strict");
const { createVllmDefaultLaunchProfiles } = require("../lib/default-profiles");

test("vLLM default profiles keep builtin IDs and normalize configs", () => {
  const normalized = [];
  const profiles = createVllmDefaultLaunchProfiles((config) => {
    normalized.push(config);
    return { ...config, normalized: true };
  });

  assert.equal(profiles.length, 5);
  assert.deepEqual(profiles.map((profile) => profile.id), [
    "blackwell-96gb-256k",
    "claude-long-context-64k",
    "claude-maximum-context",
    "openwebui-chat",
    "low-vram-safe",
  ]);
  assert.equal(normalized.length, profiles.length);
  assert.equal(profiles.every((profile) => profile.source === "builtin"), true);
  assert.equal(profiles.every((profile) => profile.config.normalized), true);

  const pro6000 = profiles.find((profile) => profile.id === "blackwell-96gb-256k");
  assert.equal(pro6000.config.maxModelLen, 262144);
  assert.equal(pro6000.config.maxNumSeqs, 1);
  assert.equal(pro6000.config.kvCacheDtype, "fp8");
  assert.deepEqual(pro6000.config.gpuDeviceIds, ["0"]);
  assert.equal(pro6000.config.clientPreset, "claude-cowork");
});
