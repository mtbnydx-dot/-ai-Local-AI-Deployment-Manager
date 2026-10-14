const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("../../manager-core/test/helpers/engine-golden-stubs");

// 01-engines §8.3: today's llama.cpp builder, builtin profiles and
// launch-request normalisation reproduce every llama golden fixture. The
// adapters get their own engines-golden test; this one is deleted in ENG-23.
harness.prepareGoldenEnvironment();
const fixtures = harness.loadGoldenFixtures().filter((fixture) => fixture.manager === "llama");
const byCode = new Map(fixtures.map((fixture) => [fixture.id.split("-").slice(0, 2).join("-"), fixture]));

const EXPECTED_CODES = ["G-L1", "G-L2", "G-L3", "P-L01", "P-L02", "P-L03", "P-L04", "P-L05", "R-L1", "R-L2"];

test("the llama golden set holds every builder, profile and request case", () => {
  assert.deepEqual([...byCode.keys()].sort(), [...EXPECTED_CODES].sort());
  assert.equal(fixtures.length, EXPECTED_CODES.length);
  for (const fixture of fixtures) {
    assert.equal(fixture.schemaVersion, 1, fixture.id);
    assert.ok(Array.isArray(fixture.history) && fixture.history.length > 0, fixture.id);
  }
});

for (const fixture of fixtures) {
  test(`${fixture.id} is reproduced by the current llama-manager code`, async () => {
    assert.deepEqual(await harness.runGoldenFixture(fixture), fixture.expect);
  });
}

// A delivered key is recorded as the placeholder of its fake value, so these
// assertions fail if the code hands the redaction marker on instead of the key.
test("llama goldens pin the secret channel by name and hold no key value", () => {
  for (const fixture of fixtures) {
    const text = JSON.stringify(fixture);
    for (const secret of Object.values(harness.FAKE_SECRETS)) assert.equal(text.includes(secret), false, fixture.id);
    if (fixture.kind === "builder" || fixture.kind === "profile") {
      assert.ok(Array.isArray(fixture.expect.secretEnvNames), fixture.id);
      assert.deepEqual(Object.keys(fixture.expect.secretEnv), fixture.expect.secretEnvNames, fixture.id);
    }
  }
  const keyed = byCode.get("G-L2");
  assert.equal(keyed.input.opts.llamaApiKey, "<secret:apiKey>");
  assert.deepEqual(keyed.expect.secretEnvNames, ["HF_TOKEN", "LLAMA_API_KEY"]);
  assert.deepEqual(keyed.expect.secretEnv, { HF_TOKEN: "<secret:hfToken>", LLAMA_API_KEY: "<secret:apiKey>" });
  const imageIndex = keyed.expect.runArgs.indexOf(keyed.expect.runtimeImage);
  assert.deepEqual(keyed.expect.runArgs.slice(imageIndex - 4, imageIndex), ["-e", "HF_TOKEN", "-e", "LLAMA_API_KEY"]);
  assert.equal(keyed.expect.runArgs.includes("--api-key"), false);
  assert.equal(JSON.stringify(keyed.expect.runArgs).includes("<secret:"), false);
  const request = byCode.get("R-L1").expect;
  assert.equal(request.runOptions.llamaApiKey, "<secret:apiKey>");
  assert.equal(request.runOptions.runtimeApiKeyRef, "ref-<secret:apiKey>");
});

// Host paths keep the separators the manager emits: the model library and
// cache roots are native Windows paths in the mount arguments and job metadata.
test("llama profile goldens hold the host path separators the manager emits", { skip: process.platform !== "win32" && "the goldens are captured on Windows" }, () => {
  for (const code of ["P-L01", "P-L02", "P-L03", "P-L04", "P-L05"]) {
    const { expect, input } = byCode.get(code);
    assert.ok(expect.runArgs.includes(`${harness.CANONICAL_ROOT_BACKSLASH}\\models:/models`), code);
    assert.ok(expect.runArgs.includes(`${harness.CANONICAL_ROOT_BACKSLASH}\\ai\\cache\\huggingface:/root/.cache/huggingface`), code);
    assert.equal(expect.jobMeta.model, input.model, code);
    assert.equal(expect.jobMeta.resolvedModel, `${harness.CANONICAL_ROOT_BACKSLASH}\\models\\Qwen3-8B-GGUF\\Qwen3-8B-Q4_K_M.gguf`, code);
  }
});
