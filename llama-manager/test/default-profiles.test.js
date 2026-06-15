const test = require("node:test");
const assert = require("node:assert/strict");
const { createLlamaDefaultLaunchProfiles } = require("../lib/default-profiles");

test("llama default profiles keep builtin IDs and normalize configs", () => {
  const normalized = [];
  const profiles = createLlamaDefaultLaunchProfiles((config) => {
    normalized.push(config);
    return { ...config, normalized: true };
  });

  assert.equal(profiles.length, 5);
  assert.deepEqual(profiles.map((profile) => profile.id), [
    "llama-96gb-single-256k",
    "llama-hetero-64k-safe",
    "llama-hetero-256k-max",
    "llama-openwebui-daily",
    "llama-single-gpu-debug",
  ]);
  assert.equal(normalized.length, profiles.length);
  assert.equal(profiles.every((profile) => profile.source === "builtin"), true);
  assert.equal(profiles.every((profile) => profile.config.normalized), true);

  const hetero = profiles.find((profile) => profile.id === "llama-hetero-256k-max");
  assert.equal(hetero.config.maxModelLen, 262144);
  assert.equal(hetero.config.maxNumSeqs, 1);
  assert.equal(hetero.config.cacheTypeK, "q4_0");
  assert.equal(hetero.config.cacheTypeV, "q4_0");
  assert.deepEqual(hetero.config.gpuDeviceIds, ["0", "1"]);
  assert.equal(hetero.config.tensorSplit, "28,15");
});
