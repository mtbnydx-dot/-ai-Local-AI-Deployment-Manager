"use strict";

// Published capabilities (docs/overhaul/02-models.md section 16, MOD-18): the
// Instance.capabilities object derived from a ModelCard, the launch values and
// a host record, and the fleet tokens built from it. Temp directories only.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "capabilities-reference-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_DIR;
test.after(() => fs.rmSync(EMPTY_DIR, { recursive: true, force: true }));

const core = require("..");
const { deriveCapabilities, capabilityTokens, publishLaunchCapabilities, annotateLocalModels } = require("../model-inspector/capabilities");
const { createEngineRegistry } = require("../engines/registry");
const { createInstanceCatalog } = require("../engines/instances");
const { createLaunchStore } = require("../engines/launch-store");
const { managerHooks } = require("../model-inspector/manager-hooks");

const FLEET_TOKENS = ["text", "vision", "audio", "embedding", "rerank", "tools"];
const LAUNCH_ID = "lch_7q2m4k5xwb3d5f6g2h3j";

// The captured Qwen3.8 card; other roles are variations of it (only the fields a role changes).
function card(name) {
  const qwen = structuredClone(require("./fixtures/model-cards/qwen38-27b-fp8/expected-card.json"));
  if (name === "embedding") return { ...qwen, role: { value: "embedding", runnable: true }, modalities: { ...qwen.modalities, input: ["text"] } };
  if (name === "reranker") return { ...qwen, role: { value: "reranker", runnable: true }, modalities: { ...qwen.modalities, input: ["text"] } };
  if (name === "draft") return { ...qwen, role: { value: "draft", runnable: false } };
  return qwen;
}

function record(results) {
  return { id: "qr_aaaaaaaaaaaaaaaaaaaa", results };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mod18-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a vision-capable Qwen3.8 publishes vision unless the launch loads the language model only", () => {
  const qwen = card();
  assert.ok(qwen.modalities.input.includes("image"));
  const full = deriveCapabilities(qwen, { contextLength: 131072, toolCallParser: "qwen3_xml", reasoningParser: "qwen3" });
  assert.equal(full.text, true);
  assert.equal(full.vision, true);
  assert.equal(full.tools, true);
  assert.equal(full.reasoning, true);
  assert.equal(full.maxContext, 131072);

  assert.equal(deriveCapabilities(qwen, { "vllm.languageModelOnly": true }).vision, false);
  assert.equal(deriveCapabilities(qwen, { "vllm.languageModelOnly": { value: true, source: "user" } }).vision, false);
  assert.equal(deriveCapabilities(qwen, { "llamacpp.textOnly": true, "llamacpp.mmproj": "mmproj.gguf" }).vision, false);
  // The same launch without the flag still publishes vision.
  assert.equal(deriveCapabilities(qwen, { "vllm.languageModelOnly": false }).vision, true);
});

test("llama.cpp publishes vision only when a projector is loaded", () => {
  const qwen = card();
  assert.equal(deriveCapabilities(qwen, { "llamacpp.textOnly": false, "llamacpp.mmproj": "mmproj-F16.gguf" }).vision, true);
  assert.equal(deriveCapabilities(qwen, { "llamacpp.mmproj": "mmproj-F16.gguf" }).vision, true);
  assert.equal(deriveCapabilities(qwen, { "llamacpp.contextLength": 8192, "llamacpp.textOnly": true }).vision, false);
  assert.equal(deriveCapabilities(qwen, { "llamacpp.flashAttention": true }).vision, false);
  assert.equal(deriveCapabilities(qwen, {}, null, { engineId: "llamacpp" }).vision, false);
});

test("a card without an image modality never publishes vision, and the role decides text, embedding and rerank", () => {
  const embedding = card("embedding");
  const caps = deriveCapabilities(embedding, {});
  assert.equal(caps.vision, false);
  assert.equal(caps.text, false);
  assert.equal(caps.embedding, true);
  assert.equal(caps.tools, false);

  const reranker = card("reranker");
  const rerank = deriveCapabilities(reranker, {});
  assert.equal(rerank.rerank, true);
  assert.equal(rerank.text, false);

  const draft = card("draft");
  const none = deriveCapabilities(draft, { toolCallParser: "qwen3_xml" });
  assert.deepEqual(capabilityTokens(none), []);
});

test("tools follow the resolved parser (llama.cpp: a known template tool format) and reasoning the reasoning format", () => {
  const qwen = card();
  assert.equal(deriveCapabilities(qwen, {}).tools, false);
  assert.equal(deriveCapabilities(qwen, { toolCallParser: "" }).tools, false);
  assert.equal(deriveCapabilities(qwen, { toolCallParser: "none" }).tools, false);
  assert.equal(deriveCapabilities(qwen, { toolCallParser: "hermes" }).tools, true);
  assert.equal(deriveCapabilities(qwen, { autoToolChoice: true }).tools, true);

  const llama = structuredClone(qwen);
  llama.template.toolFormat = "xml-tags";
  llama.template.reasoningFormat = "think-tags";
  assert.equal(deriveCapabilities(llama, { "llamacpp.textOnly": true }).tools, true);
  assert.equal(deriveCapabilities(llama, { "llamacpp.textOnly": true }).reasoning, true);
  assert.equal(deriveCapabilities(llama, { "llamacpp.textOnly": true, "llamacpp.reasoningFormat": "none" }).reasoning, false);
  llama.template.toolFormat = "unknown";
  llama.template.reasoningFormat = "none";
  const bare = deriveCapabilities(llama, { "llamacpp.textOnly": true });
  assert.equal(bare.tools, false);
  assert.equal(bare.reasoning, false);
  assert.equal(deriveCapabilities(llama, { "llamacpp.textOnly": true, toolCallParser: "auto" }).tools, true);
});

test("a failed tool check unpublishes tools; a pass or an unrelated failure leaves them", () => {
  const qwen = card();
  const values = { toolCallParser: "hermes", reasoningParser: "qwen3" };
  assert.equal(deriveCapabilities(qwen, values).tools, true);

  const failed = deriveCapabilities(qwen, values, record([{ check: "chat", status: "pass" }, { check: "tool-call", status: "fail" }]));
  assert.equal(failed.tools, false);
  assert.equal(failed.text, true);
  assert.equal(failed.vision, true);
  assert.equal(capabilityTokens(failed).includes("tools"), false);

  assert.equal(deriveCapabilities(qwen, values, record([{ check: "tool-call", status: "pass" }])).tools, true);
  assert.equal(deriveCapabilities(qwen, values, record([{ check: "tool-call", status: "warn" }, { check: "needle", status: "fail" }])).tools, true);
  assert.equal(deriveCapabilities(qwen, values, record([{ check: "vision", status: "fail" }])).vision, false);
  assert.equal(deriveCapabilities(qwen, values, record([{ check: "reasoning-split", status: "fail" }])).reasoning, false);
  // The card itself is untouched: failed checks never remove declared facts.
  assert.ok(qwen.modalities.input.includes("image"));
  // A list of records applies every failure.
  const many = deriveCapabilities(qwen, values, [record([{ check: "tool-call", status: "fail" }]), record([{ check: "vision", status: "fail" }])]);
  assert.equal(many.tools, false);
  assert.equal(many.vision, false);
  assert.equal(deriveCapabilities(qwen, values, "not a record").tools, true);
});

test("capabilityTokens speaks the model-fleet vocabulary in fleet order", () => {
  const caps = { text: true, vision: true, audio: false, embedding: false, rerank: false, tools: true, reasoning: true, maxContext: 8192 };
  assert.deepEqual(capabilityTokens(caps), ["text", "vision", "tools"]);
  assert.deepEqual(capabilityTokens({ tools: true, text: true }), ["text", "tools"]);
  assert.deepEqual(capabilityTokens(null), []);
  for (const token of capabilityTokens({ text: true, vision: true, audio: true, embedding: true, rerank: true, tools: true, reasoning: true })) {
    assert.ok(FLEET_TOKENS.includes(token));
  }
  const fleet = require("../../service-entry/lib/model-fleet");
  // The fleet reads the tokens back as an explicit list, so published tokens round-trip.
  assert.deepEqual(fleet.inferModelCapabilities({ id: "x", capabilities: capabilityTokens(caps) }), ["text", "vision", "tools"]);
});

test("core.models exposes the capabilities namespace", () => {
  assert.equal(core.models.capabilities.deriveCapabilities, deriveCapabilities);
  assert.equal(core.models.capabilities.capabilityTokens, capabilityTokens);
});

function launchKit(t, values) {
  const root = tempRoot(t);
  const registry = createEngineRegistry({ overrideDir: path.join(root, "config"), env: {} });
  const launchStore = createLaunchStore({ file: path.join(root, "launch-store.json"), managerId: "vllm", registry });
  launchStore.create({
    engineId: "vllm",
    runtimeId: null,
    model: { ref: "fixture-model", servedName: "qwen3.8" },
    instance: { mode: "replace", id: "primary", port: 8000, gpuIds: ["0"] },
    values,
  }, { launchId: LAUNCH_ID, source: "ui", status: "running", containerName: "vllm-local" });
  const catalog = createInstanceCatalog({ registry, managerId: "vllm", launchStore });
  const container = {
    name: "vllm-local",
    image: "example/vllm:1",
    status: "Up 1 minute",
    running: true,
    manager: "vllm-local",
    engine: "vllm",
    labels: { "ai.manager": "vllm-local", "ai.manager.engine": "vllm", "ai.manager.engine-id": "vllm", "ai.manager.launch-id": LAUNCH_ID },
  };
  const legacy = { id: "primary", containerName: "vllm-local", running: true, models: [{ id: "qwen3.8", root: "fixture-model", maxModelLen: 4096 }] };
  return { launchStore, catalog, container, legacy };
}

test("publishing writes resolved.capabilities, which the instance summary then carries", (t) => {
  const { launchStore, catalog, container, legacy } = launchKit(t, { contextLength: 65536, toolCallParser: "hermes" });
  assert.equal(catalog.typed(legacy, container).capabilitySource, "descriptor");

  const qwen = card();
  const caps = publishLaunchCapabilities({ launchStore, launchId: LAUNCH_ID, card: qwen });
  assert.equal(caps.vision, true);
  assert.equal(caps.tools, true);
  assert.equal(caps.maxContext, 65536);
  const typed = catalog.typed(legacy, container);
  assert.equal(typed.capabilitySource, "published");
  assert.deepEqual(typed.capabilities, caps);

  // A failed tool check republishes without tools.
  const after = publishLaunchCapabilities({ launchStore, launchId: LAUNCH_ID, card: qwen, hostRecord: record([{ check: "tool-call", status: "fail" }]) });
  assert.equal(after.tools, false);
  assert.equal(catalog.typed(legacy, container).capabilities.tools, false);

  assert.equal(publishLaunchCapabilities({ launchStore, launchId: "lch_zzzzzzzzzzzzzzzzzzzz", card: qwen }), null);
  assert.equal(publishLaunchCapabilities({ launchStore: null, launchId: LAUNCH_ID, card: qwen }), null);
});

test("a launch with the language model only publishes no vision on the instance", (t) => {
  const { launchStore, catalog, container, legacy } = launchKit(t, { "vllm.languageModelOnly": true });
  publishLaunchCapabilities({ launchStore, launchId: LAUNCH_ID, card: card() });
  const typed = catalog.typed(legacy, container);
  assert.equal(typed.capabilities.vision, false);
  assert.equal(typed.capabilities.text, true);
});

test("afterReady publishes the capabilities of the launch once the card resolves", async (t) => {
  const { launchStore, catalog, container, legacy } = launchKit(t, { toolCallParser: "hermes" });
  const calls = [];
  const hooks = managerHooks({
    managerId: "vllm",
    launchStore,
    onCapabilities: () => calls.push("changed"),
    resolveModelPath: (ref) => (ref === "fixture-model" ? "/fixture/model" : null),
    inspectLocal: async () => card(),
    log: () => {},
  });
  await hooks.afterReady({ launchId: LAUNCH_ID, managerId: "vllm" });
  assert.deepEqual(calls, ["changed"]);
  const typed = catalog.typed(legacy, container);
  assert.equal(typed.capabilitySource, "published");
  assert.equal(typed.capabilities.vision, true);
  assert.equal(typed.capabilities.tools, true);

  // A model that cannot be inspected leaves the record alone and never throws.
  const missing = managerHooks({ managerId: "vllm", launchStore, resolveModelPath: () => null, log: () => {} });
  await missing.afterReady({ launchId: LAUNCH_ID });
  const none = managerHooks({ managerId: "vllm", log: () => {} });
  assert.equal(await none.afterReady({ launchId: LAUNCH_ID }), null);
});

test("annotateLocalModels adds fleet tokens from each card and leaves unreadable models alone", async () => {
  const cards = { "/m/vl": card(), "/m/emb": card("embedding") };
  const inspectLocal = async (target) => {
    if (!cards[target]) throw new Error("not a model");
    return cards[target];
  };
  const input = { cached: [{ name: "c" }], local: [{ name: "vl", path: "/m/vl" }, { name: "emb", path: "/m/emb" }, { name: "bad", path: "/m/bad" }, { name: "nopath" }] };
  const out = await annotateLocalModels(input, { inspectLocal });
  assert.deepEqual(out.local[0].capabilities, ["text", "vision"]);
  assert.equal(out.local[0].capabilitySource, "card");
  assert.deepEqual(out.local[1].capabilities, ["embedding"]);
  assert.equal(out.local[2].capabilities, undefined);
  assert.equal(out.local[3].capabilities, undefined);
  assert.deepEqual(out.cached, input.cached);
  assert.equal(await annotateLocalModels(null), null);
});
