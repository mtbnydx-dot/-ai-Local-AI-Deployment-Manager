"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRuntimeFacts } = require("../engines/runtime-facts");
const { createEngineRegistry } = require("../engines/registry");

const ID_A = `sha256:${"a".repeat(64)}`;
const ID_B = `sha256:${"b".repeat(64)}`;
const RUNTIME = "vllm@0.28.0";

function store(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-facts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = createEngineRegistry({ overrideDir: path.join(root, "config"), env: {} });
  let id = ID_A;
  let time = 0;
  let calls = 0;
  const facts = createRuntimeFacts({ aiRoot: root, registry, now: () => time, resolveImageId: async () => { calls += 1; return id; }, ...extra });
  return { root, facts, setId: (value) => { id = value; }, advance: (ms) => { time += ms; }, calls: () => calls };
}

test("core.engines exports the single runtimeFacts get and put API", () => {
  assert.equal(typeof require("..").engines.runtimeFacts.get, "function");
  assert.equal(typeof require("..").engines.runtimeFacts.put, "function");
});

test("flags and MOD-13-shaped registries round-trip by section and image ID", async (t) => {
  const { facts, root } = store(t);
  assert.equal(await facts.get(RUNTIME), null);
  const flags = { capturedAt: "2026-10-14T00:00:00Z", argv: ["--help"], rawSha256: "d".repeat(64), flags: [{ flag: "--model", aliases: [], choices: [] }] };
  const registries = { capturedAt: "2026-10-14T00:01:00Z", architectures: ["ExampleForCausalLM"], quantizers: ["fp8"], parsers: { tool: ["hermes"], reasoning: ["auto"] }, apiKeyEnv: "VLLM_API_KEY" };
  await facts.put(RUNTIME, "flags", flags);
  await facts.put(RUNTIME, "registries", registries);
  assert.deepEqual(await facts.get(RUNTIME), { schemaVersion: 1, engineId: "vllm", runtimeId: RUNTIME, imageId: ID_A, flags, registries });
  const directory = path.join(root, ".runtime", "engine-flags", "vllm");
  assert.deepEqual(fs.readdirSync(directory), [`${"a".repeat(16)}.json`]);
  assert.equal(fs.existsSync(path.join(root, "cache", "runtime-facts")), false);
  await facts.put(RUNTIME, "flags", null);
  assert.equal((await facts.get(RUNTIME)).flags, null);
  assert.deepEqual((await facts.get(RUNTIME)).registries, registries);
});

test("a tag repointed after the 60 second identity TTL returns null and preserves the old image facts", async (t) => {
  const fixture = store(t);
  await fixture.facts.put(RUNTIME, "flags", { flags: [{ flag: "--old" }] });
  fixture.setId(ID_B);
  fixture.advance(60_001);
  assert.equal(await fixture.facts.get(RUNTIME), null);
  await fixture.facts.put(RUNTIME, "flags", { flags: [{ flag: "--new" }] });
  assert.equal((await fixture.facts.get(RUNTIME)).imageId, ID_B);
  fixture.setId(ID_A);
  fixture.facts.clear();
  assert.equal((await fixture.facts.get(RUNTIME)).flags.flags[0].flag, "--old");
});

test("identity reads are single-flight and cached while writes always re-inspect", async (t) => {
  const fixture = store(t);
  await Promise.all([fixture.facts.get(RUNTIME), fixture.facts.get(RUNTIME)]);
  assert.equal(fixture.calls(), 1);
  await fixture.facts.get(RUNTIME);
  assert.equal(fixture.calls(), 1);
  await fixture.facts.put(RUNTIME, "registries", { architectures: [] });
  assert.equal(fixture.calls(), 2);
});

test("a retag during a probe cannot write results against the wrong image", async (t) => {
  const { facts, setId } = store(t);
  setId(ID_B);
  await assert.rejects(facts.put(RUNTIME, "flags", { flags: [] }, { imageId: ID_A }), { code: "runtime_image_changed" });
  assert.equal(await facts.get(RUNTIME), null);
});

test("missing images and invalid sections do not create cache files", async (t) => {
  const { root, facts, setId } = store(t);
  setId(null);
  assert.equal(await facts.get(RUNTIME), null);
  await assert.rejects(facts.put(RUNTIME, "flags", {}), { code: "runtime_image_missing" });
  await assert.rejects(facts.put(RUNTIME, "other", {}), { code: "invalid_facts_section" });
  assert.equal(fs.existsSync(path.join(root, ".runtime")), false);
});

test("corrupt files and truncated-ID collisions never apply to another full image ID", async (t) => {
  const { facts, root, setId } = store(t);
  await facts.put(RUNTIME, "flags", { flags: [] });
  const file = path.join(root, ".runtime", "engine-flags", "vllm", `${"a".repeat(16)}.json`);
  setId(`sha256:${"a".repeat(16)}${"b".repeat(48)}`);
  facts.clear();
  assert.equal(await facts.get(RUNTIME), null);
  setId(ID_A);
  facts.clear();
  fs.writeFileSync(file, "broken");
  assert.equal(await facts.get(RUNTIME), null);
});

test("simultaneous section writes retain both sections and leave no temporary files", async (t) => {
  const { facts, root } = store(t);
  await Promise.all([facts.put(RUNTIME, "flags", { flags: [] }), facts.put(RUNTIME, "registries", { architectures: ["test"] })]);
  const value = await facts.get(RUNTIME);
  assert.deepEqual(value.flags, { flags: [] });
  assert.deepEqual(value.registries, { architectures: ["test"] });
  assert.equal(fs.readdirSync(path.join(root, ".runtime", "engine-flags", "vllm")).length, 1);
});

test("Docker image inspect uses the configured WSL command with fake exec", async (t) => {
  const calls = [];
  const { facts } = store(t, {
    resolveImageId: undefined,
    dockerConfig: { dockerExe: "wsl.exe", dockerArgsPrefix: ["-d", "fixture", "--exec", "docker"] },
    execFileAsync: async (...args) => { calls.push(args); return { stdout: `${ID_A}\n` }; },
  });
  await facts.get(RUNTIME);
  assert.deepEqual(calls[0].slice(0, 2), ["wsl.exe", ["-d", "fixture", "--exec", "docker", "image", "inspect", "--format", "{{.Id}}", facts.resolveRuntime(RUNTIME).image]]);
  assert.equal(calls[0][2].windowsHide, true);
});
