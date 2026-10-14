const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("../../manager-core/test/helpers/engine-golden-stubs");

// 01-engines §8.3: today's vLLM/SGLang builders, runtime presets, builtin
// profiles and launch-request normalisation reproduce every vllm golden
// fixture. The adapters get their own engines-golden test; this one is deleted
// in ENG-23.
harness.prepareGoldenEnvironment();
const fixtures = harness.loadGoldenFixtures().filter((fixture) => fixture.manager === "vllm");
const byCode = new Map(fixtures.map((fixture) => [fixture.id.split("-").slice(0, 2).join("-"), fixture]));

const EXPECTED_CODES = [
  "G-V1", "G-V2", "G-V3a", "G-V3b", "G-V4", "G-S1", "G-S2", "G-S3",
  "PRE-01", "PRE-02", "PRE-03", "PRE-04", "PRE-05", "PRE-06", "PRE-07", "PRE-08", "PRE-09", "PRE-10",
  "PRE-11", "PRE-12", "PRE-13", "PRE-14", "PRE-15", "PRE-16a", "PRE-16b", "PRE-17", "PRE-18", "PRE-19",
  "P-V01", "P-V02", "P-V03", "P-V04", "P-V05", "P-V06", "P-V07", "P-V08", "P-V09", "P-V10",
  "R-V1", "R-V2", "R-V3",
];

test("the vLLM golden set holds every builder, preset, profile and request case", () => {
  assert.deepEqual([...byCode.keys()].sort(), [...EXPECTED_CODES].sort());
  assert.equal(fixtures.length, EXPECTED_CODES.length);
  for (const fixture of fixtures) {
    assert.equal(fixture.schemaVersion, 1, fixture.id);
    assert.ok(Array.isArray(fixture.history) && fixture.history.length > 0, fixture.id);
  }
});

for (const fixture of fixtures) {
  test(`${fixture.id} is reproduced by the current vllm-manager code`, async () => {
    assert.deepEqual(await harness.runGoldenFixture(fixture), fixture.expect);
  });
}

test("vLLM goldens pin the secret channel by name and hold no key value", () => {
  for (const fixture of fixtures) {
    const text = JSON.stringify(fixture);
    for (const secret of Object.values(harness.FAKE_SECRETS)) assert.equal(text.includes(secret), false, fixture.id);
    if (fixture.kind === "builder" || fixture.kind === "profile") assert.ok(Array.isArray(fixture.expect.secretEnvNames), fixture.id);
  }
  const vllmKey = byCode.get("G-V1");
  assert.equal(vllmKey.input.opts.vllmApiKey, "<secret:apiKey>");
  assert.deepEqual(vllmKey.expect.secretEnvNames, ["HF_TOKEN", "VLLM_API_KEY"]);
  assert.deepEqual(vllmKey.expect.runArgs.slice(vllmKey.expect.runArgs.indexOf("VLLM_API_KEY") - 1, vllmKey.expect.runArgs.indexOf("VLLM_API_KEY") + 1), ["-e", "VLLM_API_KEY"]);
  assert.equal(vllmKey.expect.runArgs.includes("--api-key"), false);
  // SGLang keeps --api-key in argv (08 O1); the fixture holds only the marker.
  const sglangKey = byCode.get("G-S3").expect;
  assert.equal(sglangKey.runArgs[sglangKey.runArgs.indexOf("--api-key") + 1], harness.REDACTED);
  assert.deepEqual(sglangKey.secretEnvNames, []);
  const request = byCode.get("R-V1").expect;
  assert.equal(request.runOptions.vllmApiKey, harness.REDACTED);
  assert.equal(request.runOptions.runtimeApiKeyRef, `ref-${harness.REDACTED}`);
});
