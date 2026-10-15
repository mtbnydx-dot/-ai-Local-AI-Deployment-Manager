"use strict";

// Chat template signatures and parser resolution (docs/overhaul/02-models.md
// 8.3 and 8.6, MOD-7): fixture templates map to signature ids, resolveParsers
// precedence, the runtime parser lists read through a stub runtimeFacts.get,
// and the rule that an unknown parser is never dropped silently. Everything is
// read from the bundled knowledge and the committed model-card fixtures; no
// engine, Docker or live data is touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The process-wide registries read bundled data only.
const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "template-signatures-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const { createKnowledgeLoader } = require("../model-inspector/knowledge");
const signatures = require("../model-inspector/template-signatures");

const FIXTURES = path.join(__dirname, "fixtures", "model-cards");
const knowledge = createKnowledgeLoader({ aiRoot: EMPTY_CONFIG_DIR }).load();

function fixtureTemplate(id) {
  return fs.readFileSync(path.join(FIXTURES, id, "chat_template.jinja"), "utf8");
}

function tokenizerTemplate(id) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, id, "tokenizer_config.json"), "utf8")).chat_template;
}

function ggufTemplate(id) {
  const header = JSON.parse(fs.readFileSync(path.join(FIXTURES, id, "gguf-header.json"), "utf8"));
  let found = null;
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.key === "tokenizer.chat_template" && typeof node.value === "string") found = node.value;
    for (const child of Object.values(node)) walk(child);
  })(header);
  return found;
}

const NO_PARSERS = { capabilities: { autoParsers: { tool: null, reasoning: null } } };
const AUTO_PARSERS = { capabilities: { autoParsers: { tool: "auto", reasoning: "auto" } } };

function qwen38Card(extra = {}) {
  return {
    identity: { modelType: "qwen3_5", textModelType: "qwen3_5_text", architectures: ["Qwen3_5ForConditionalGeneration"] },
    quant: { method: "fp8" },
    template: { signatureId: "qwen38-xml-effort" },
    ...extra,
  };
}

function facts({ tool = null, reasoning = null, registries = null } = {}) {
  const flags = [];
  if (tool) flags.push({ flag: "--tool-call-parser", aliases: [], choices: tool });
  if (reasoning) flags.push({ flag: "--reasoning-parser", aliases: [], choices: reasoning });
  return { schemaVersion: 1, engineId: "vllm", runtimeId: "vllm@stub", imageId: `sha256:${"a".repeat(64)}`, flags: flags.length ? { flags } : null, registries };
}

// ----- matchTemplate

test("Qwen3.8 templates map to qwen38-xml-effort by their exact sha256, whatever the fine-tune", () => {
  for (const id of ["qwen38-27b-fp8", "qwen38-27b-fp8-indexed", "qwen38-flashnext-nvfp4"]) {
    const match = signatures.matchTemplate(fixtureTemplate(id), knowledge);
    assert.equal(match.signatureId, "qwen38-xml-effort", id);
    assert.equal(match.exact, true, id);
    assert.equal(match.toolFormat, "qwen-xml-function");
    assert.equal(match.reasoningFormat, "think-tags");
    assert.equal(match.thinking.effortKwarg, "reasoning_effort");
    assert.deepEqual(match.thinking.effortValues, ["xhigh", "medium", "low"]);
    assert.equal(match.parsers.vllm.tool, "qwen3_coder");
  }
});

test("the hash ignores CRLF, and an edited Qwen3.8 template still matches by its features", () => {
  const text = fixtureTemplate("qwen38-27b-fp8");
  assert.equal(signatures.matchTemplate(text.replace(/\r?\n/g, "\r\n"), knowledge).exact, true);
  const edited = signatures.matchTemplate(`${text}\n{#- local edit -#}`, knowledge);
  assert.equal(edited.signatureId, "qwen38-xml-effort");
  assert.equal(edited.exact, false);
  assert.ok(edited.features.includes("<function="));
  assert.ok(edited.features.includes("/reasoning_effort/"));
});

test("the Qwen3.6 template, which has no reasoning_effort, matches qwen-xml-function by features", () => {
  const match = signatures.matchTemplate(fixtureTemplate("qwen36-35b-a3b-fp8"), knowledge);
  assert.equal(match.signatureId, "qwen-xml-function");
  assert.equal(match.exact, false);
  assert.deepEqual(match.features.slice(0, 3), ["<tool_call>", "<function=", "<parameter="]);
  assert.equal(match.thinking.effortKwarg, undefined);
});

test("DeepSeek-V4 DSML, Harmony, Gemma 4, GLM, Llama 3, Mistral, Kimi and DeepSeek-V3 templates map to their signatures", () => {
  const cases = [
    [ggufTemplate("deepseek-v4-flash-q2k-gguf"), "deepseek-dsml", "deepseek-dsml"],
    [fixtureTemplate("syn-gpt-oss-20b"), "harmony", "harmony"],
    [fixtureTemplate("syn-gemma4"), "gemma4", "gemma"],
    [fixtureTemplate("syn-glm45-air"), "glm-arg-key", "glm-arg-key"],
    [fixtureTemplate("syn-nemotron3-nano"), "qwen-xml-function", "qwen-xml-function"],
    [tokenizerTemplate("syn-llama3-8b"), "llama3-json", "llama3-json"],
    [tokenizerTemplate("syn-mistral-small"), "mistral-tool-calls", "mistral"],
    [tokenizerTemplate("syn-kimi-k2"), "kimi-tool-section", "kimi-k2"],
    [tokenizerTemplate("syn-mla-deepseek-v3"), "deepseek-v3-markers", "deepseek-v3"],
  ];
  for (const [text, signatureId, toolFormat] of cases) {
    assert.equal(typeof text, "string");
    const match = signatures.matchTemplate(text, knowledge);
    assert.equal(match.signatureId, signatureId);
    assert.equal(match.toolFormat, toolFormat);
    assert.equal(match.exact, false);
  }
});

test("a template with Hermes JSON calls is hermes-json and one with tags only is think-only, never the XML signatures", () => {
  const hermes = "{%- for tool in tools %}{{ tool | tojson }}{% endfor %}<tool_call>\n{\"name\": \"x\"}\n</tool_call>";
  assert.equal(signatures.matchTemplate(hermes, knowledge).signatureId, "hermes-json");
  assert.equal(signatures.matchTemplate("<think>\n{{ content }}", knowledge).signatureId, "think-only");
});

test("no template, an unmatched template and a missing knowledge object leave every field null", () => {
  const none = { signatureId: null, exact: null, features: [], toolFormat: null, reasoningFormat: null, thinking: null, parsers: null };
  assert.deepEqual(signatures.matchTemplate("", knowledge), none);
  assert.deepEqual(signatures.matchTemplate(null, knowledge), none);
  assert.deepEqual(signatures.matchTemplate("{{ messages }}", knowledge), none);
  assert.deepEqual(signatures.matchTemplate("<tool_call>", undefined), none);
});

test("a more specific entry beats a broader one, a higher priority beats specificity, and unsafe regexes never match", () => {
  const broad = { id: "broad", features: { all: ["<tool_call>"] }, toolFormat: "broad" };
  const narrow = { id: "narrow", features: { all: ["<tool_call>", "<x>"] }, toolFormat: "narrow" };
  const text = "<tool_call><x>";
  assert.equal(signatures.matchTemplate(text, { templateSignatures: [broad, narrow] }).signatureId, "narrow");
  assert.equal(signatures.matchTemplate(text, { templateSignatures: [broad, narrow, { ...broad, id: "boosted", priority: 10 }] }).signatureId, "boosted");
  const unsafe = { id: "unsafe", features: { all: ["a"], regex: ["(a+)+$"] } };
  assert.equal(signatures.matchTemplate("aaaaaaaaaaaaaaaaaaaaaaaa!", { templateSignatures: [unsafe] }).signatureId, null);
});

test("matching works through the process-wide core.models.parsers namespace", () => {
  assert.equal(typeof core.models.parsers.matchTemplate, "function");
  assert.equal(typeof core.models.parsers.resolveParsers, "function");
  const match = core.models.parsers.matchTemplate(fixtureTemplate("qwen38-27b-fp8"), knowledge);
  assert.equal(match.signatureId, "qwen38-xml-effort");
});

test("readLocalTemplate follows the inspector's lookup order and never throws", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "template-signatures-dir-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(signatures.readLocalTemplate(dir), null);
  assert.equal(signatures.readLocalTemplate(path.join(dir, "missing")), null);
  fs.writeFileSync(path.join(dir, "tokenizer_config.json"), JSON.stringify({ chat_template: [{ name: "rag", template: "R" }, { name: "default", template: "D" }] }));
  assert.deepEqual(signatures.readLocalTemplate(dir), { text: "D", source: "tokenizer_config.json" });
  fs.writeFileSync(path.join(dir, "chat_template.jinja"), "J");
  assert.deepEqual(signatures.readLocalTemplate(dir), { text: "J", source: "chat_template.jinja" });
  fs.rmSync(path.join(dir, "chat_template.jinja"));
  fs.writeFileSync(path.join(dir, "tokenizer_config.json"), "{ not json");
  assert.equal(signatures.readLocalTemplate(dir), null);
});

// ----- resolveParsers

test("without lists, the family parsers answer with source knowledge and auto tool choice follows the tool parser", async () => {
  const result = await signatures.resolveParsers(qwen38Card(), "vllm", { knowledge, descriptor: NO_PARSERS });
  assert.deepEqual(Object.keys(result).slice(0, 3), ["toolCallParser", "reasoningParser", "autoToolChoice"]);
  assert.equal(result.toolCallParser.value, "qwen3_coder");
  assert.equal(result.toolCallParser.source, "knowledge");
  assert.equal(result.reasoningParser.value, "qwen3");
  assert.equal(result.autoToolChoice.value, true);
  assert.equal(result.familyId, "qwen3.8");
  assert.equal(result.signatureId, "qwen38-xml-effort");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.tool, result.toolCallParser);
  assert.equal(JSON.parse(JSON.stringify(result)).tool, undefined);
});

test("precedence: per-model override, then family, then template, then descriptor autoParsers, then empty with a warning", () => {
  const card = qwen38Card();
  const base = { knowledge, descriptor: NO_PARSERS };

  const override = signatures.resolveParsersSync(card, "vllm", { ...base, override: { tool: "hermes", reasoning: "deepseek_r1" } });
  assert.equal(override.toolCallParser.value, "hermes");
  assert.equal(override.toolCallParser.source, "model-override");
  assert.equal(override.reasoningParser.source, "model-override");

  // A family without parsers for the engine falls through to the template signature.
  const sglang = signatures.resolveParsersSync(card, "sglang", base);
  assert.deepEqual([sglang.toolCallParser.value, sglang.toolCallParser.source], ["qwen3_coder", "template"]);
  assert.deepEqual([sglang.reasoningParser.value, sglang.reasoningParser.source], ["qwen3", "template"]);

  // Neither family nor template: the descriptor's autoParsers.
  const unknown = { identity: { modelType: "totally_unknown" }, template: { signatureId: null } };
  const engineAuto = signatures.resolveParsersSync(unknown, "llamacpp", { knowledge, descriptor: AUTO_PARSERS });
  assert.deepEqual([engineAuto.toolCallParser.value, engineAuto.toolCallParser.source], ["auto", "engine-auto"]);
  assert.match(engineAuto.toolCallParser.reason, /由引擎按模板自动识别/);
  assert.equal(engineAuto.autoToolChoice.value, true);

  const empty = signatures.resolveParsersSync(unknown, "vllm", { knowledge, descriptor: NO_PARSERS });
  assert.deepEqual([empty.toolCallParser.value, empty.toolCallParser.source], ["", "none"]);
  assert.equal(empty.autoToolChoice.value, false);
  assert.deepEqual(empty.warnings.map((item) => [item.code, item.kind]), [["parser_unknown", "tool"], ["parser_unknown", "reasoning"]]);
});

test("a template with explicit null vLLM parsers (DSML) falls through to the descriptor, and its sglang parsers apply", () => {
  const card = { identity: { modelType: "totally_unknown" }, template: { signatureId: "deepseek-dsml" } };
  const vllm = signatures.resolveParsersSync(card, "vllm", { knowledge, descriptor: NO_PARSERS });
  assert.equal(vllm.toolCallParser.value, "");
  assert.equal(vllm.warnings.length, 2);
  const sglang = signatures.resolveParsersSync(card, "sglang", { knowledge, descriptor: NO_PARSERS });
  assert.deepEqual([sglang.toolCallParser.value, sglang.toolCallParser.source], ["deepseekv4", "template"]);
});

test("a descriptor capabilities.autoParsers string is used verbatim when nothing else answers", () => {
  const unknown = { identity: { modelType: "totally_unknown" } };
  const result = signatures.resolveParsersSync(unknown, "vllm", {
    knowledge,
    descriptor: { capabilities: { autoParsers: { tool: "auto", reasoning: null } } },
  });
  assert.deepEqual([result.toolCallParser.value, result.toolCallParser.source], ["auto", "engine-auto"]);
  assert.deepEqual([result.reasoningParser.value, result.reasoningParser.source], ["", "none"]);
  assert.deepEqual(result.warnings.map((item) => item.kind), ["reasoning"]);
});

test("parsersByQuant: ModelOpt/NVFP4 weights use qwen3_xml for the tool parser, others keep qwen3_coder", () => {
  const card = {
    identity: { modelType: "qwen3_5_moe", textModelType: "qwen3_5_moe_text" },
    template: { signatureId: "qwen-xml-function" },
    quant: { method: "modelopt" },
  };
  const modelopt = signatures.resolveParsersSync(card, "vllm", { knowledge, descriptor: NO_PARSERS });
  assert.equal(modelopt.familyId, "qwen3.5-3.6");
  assert.deepEqual([modelopt.toolCallParser.value, modelopt.toolCallParser.source], ["qwen3_xml", "knowledge"]);
  assert.match(modelopt.toolCallParser.reason, /modelopt/);
  assert.equal(modelopt.reasoningParser.value, "qwen3");
  const viaContext = signatures.resolveParsersSync({ ...card, quant: {} }, "vllm", { knowledge, descriptor: NO_PARSERS, quantMethod: "ModelOpt" });
  assert.equal(viaContext.toolCallParser.value, "qwen3_xml");
  const fp8 = signatures.resolveParsersSync({ ...card, quant: { method: "fp8" } }, "vllm", { knowledge, descriptor: NO_PARSERS });
  assert.equal(fp8.toolCallParser.value, "qwen3_coder");
});

// Migrated from vllm-manager/test/model-capabilities.test.js (MOD-21): parsers
// follow the declared checkpoint and its quantization, never a name.
test("parsers by checkpoint format: Qwen3.6 NVFP4 is qwen3_xml, Qwen3.8 NVFP4 keeps qwen3_coder, Qwen3-8B is not Qwen3.8", () => {
  const resolve = (identity, method) => signatures.resolveParsersSync({ identity, quant: { method } }, "vllm", { knowledge, descriptor: NO_PARSERS });
  const qwen36 = resolve({ modelType: null, architectures: ["Qwen3_5MoeForConditionalGeneration"] }, "modelopt");
  assert.deepEqual([qwen36.familyId, qwen36.toolCallParser.value, qwen36.reasoningParser.value], ["qwen3.5-3.6", "qwen3_xml", "qwen3"]);
  const qwen36Fp8 = resolve({ modelType: null, architectures: ["Qwen3_5ForConditionalGeneration"] }, "fp8");
  assert.equal(qwen36Fp8.toolCallParser.value, "qwen3_coder");
  const qwen38 = resolve({ modelType: null, architectures: ["Qwen3_8ForConditionalGeneration"] }, "modelopt");
  assert.deepEqual([qwen38.familyId, qwen38.toolCallParser.value], ["qwen3.8", "qwen3_coder"]);
  const qwen3EightB = signatures.resolveParsersSync({ identity: { modelType: null, architectures: ["Qwen3ForCausalLM"], displayName: "Qwen3-8B" }, quant: { method: "fp8" } }, "vllm", { knowledge, descriptor: NO_PARSERS });
  assert.notEqual(qwen3EightB.familyId, "qwen3.8");
  assert.notEqual(qwen3EightB.toolCallParser.value, "qwen3_coder", "Qwen3-8B must not be mistaken for the Qwen3.8 family");
});

test("parser lists come from a stub engines.runtimeFacts.get: introspected choices first, then probe registries", async () => {
  const calls = [];
  const stored = facts({ tool: ["hermes", "qwen3_coder"], registries: { toolParsers: ["only-registry"], reasoningParsers: ["qwen3", "deepseek_r1"] } });
  const runtimeFacts = {
    async get(runtimeId) {
      calls.push(runtimeId);
      return stored;
    },
  };
  const lists = signatures.parserLists(stored);
  assert.deepEqual(lists.tool, { names: ["hermes", "qwen3_coder"], from: "introspected" });
  assert.deepEqual(lists.reasoning, { names: ["qwen3", "deepseek_r1"], from: "registries" });

  const result = await signatures.resolveParsers(qwen38Card(), "vllm", { knowledge, descriptor: NO_PARSERS, runtimeFacts, runtimeId: "vllm@stub" });
  assert.deepEqual(calls, ["vllm@stub"]);
  assert.equal(result.toolCallParser.value, "qwen3_coder");
  assert.equal(result.toolCallParser.listSource, "introspected");
  assert.equal(result.reasoningParser.value, "qwen3");
  assert.equal(result.reasoningParser.listSource, "registries");
  assert.deepEqual(result.warnings, []);
});

test("a parser the runtime does not list is replaced by the descriptor's autoParsers value, or empty with a warning, and is reported", async () => {
  const runtimeFacts = { get: async () => facts({ tool: ["hermes"], reasoning: ["deepseek_r1"] }) };
  const ctx = { knowledge, runtimeFacts, runtimeId: "vllm@stub", image: "example/vllm:old" };

  const replaced = await signatures.resolveParsers(qwen38Card(), "vllm", { ...ctx, descriptor: AUTO_PARSERS });
  assert.deepEqual([replaced.toolCallParser.value, replaced.toolCallParser.source, replaced.toolCallParser.requested], ["auto", "engine-auto", "qwen3_coder"]);
  assert.deepEqual([replaced.reasoningParser.value, replaced.reasoningParser.source, replaced.reasoningParser.requested], ["auto", "engine-auto", "qwen3"]);
  assert.equal(replaced.autoToolChoice.value, true);
  assert.deepEqual(replaced.warnings.map((item) => [item.code, item.kind, item.parser]), [["parser_not_in_image", "tool", "qwen3_coder"], ["parser_not_in_image", "reasoning", "qwen3"]]);
  assert.match(replaced.warnings[0].message, /example\/vllm:old/);
  assert.match(replaced.warnings[0].message, /qwen3_coder/);

  const dropped = await signatures.resolveParsers(qwen38Card(), "vllm", { ...ctx, descriptor: NO_PARSERS });
  assert.equal(dropped.toolCallParser.value, "");
  assert.equal(dropped.toolCallParser.source, "none");
  assert.equal(dropped.toolCallParser.requested, "qwen3_coder");
  assert.equal(dropped.autoToolChoice.value, false);
  assert.equal(dropped.warnings.filter((item) => item.code === "parser_not_in_image").length, 2);
  assert.equal(dropped.warnings.some((item) => item.code === "parser_unknown"), false);
});

test("an override naming a parser the image lacks is not silently dropped either", async () => {
  const runtimeFacts = { get: async () => facts({ tool: ["hermes"], reasoning: ["qwen3"] }) };
  const result = await signatures.resolveParsers(qwen38Card(), "vllm", {
    knowledge, runtimeFacts, runtimeId: "vllm@stub", descriptor: NO_PARSERS, override: { tool: "made_up" },
  });
  assert.equal(result.toolCallParser.value, "");
  assert.equal(result.toolCallParser.requested, "made_up");
  assert.deepEqual(result.warnings.map((item) => [item.code, item.parser, item.source]), [["parser_not_in_image", "made_up", "model-override"]]);
  assert.equal(result.reasoningParser.value, "qwen3");
});

test("a template alternative that the image lists is used when the primary is missing", async () => {
  const runtimeFacts = { get: async () => facts({ tool: ["hermes", "qwen3_xml"], reasoning: ["qwen3"] }) };
  const card = { identity: { modelType: "totally_unknown" }, template: { signatureId: "qwen38-xml-effort" } };
  const result = await signatures.resolveParsers(card, "vllm", { knowledge, runtimeFacts, runtimeId: "vllm@stub", descriptor: NO_PARSERS });
  assert.deepEqual([result.toolCallParser.value, result.toolCallParser.source, result.toolCallParser.requested], ["qwen3_xml", "template", "qwen3_coder"]);
  assert.deepEqual(result.warnings, []);
});

test("engine keywords (auto, none) are never looked up in the lists", async () => {
  const runtimeFacts = { get: async () => facts({ tool: ["hermes"], reasoning: ["qwen3"] }) };
  const card = { identity: { modelType: "totally_unknown" }, template: { signatureId: "gemma4" } };
  const result = await signatures.resolveParsers(card, "llamacpp", { knowledge, runtimeFacts, runtimeId: "llamacpp@stub", descriptor: AUTO_PARSERS });
  assert.deepEqual([result.toolCallParser.value, result.toolCallParser.source], ["auto", "template"]);
  assert.deepEqual(result.warnings, []);
});

test("facts that cannot be read, or hold no lists, accept the value as given", async () => {
  const failing = { get: async () => { throw new Error("runtime_image_missing"); } };
  for (const runtimeFacts of [failing, { get: async () => null }, { get: async () => facts() }]) {
    const result = await signatures.resolveParsers(qwen38Card(), "vllm", { knowledge, runtimeFacts, runtimeId: "vllm@stub", descriptor: NO_PARSERS });
    assert.equal(result.toolCallParser.value, "qwen3_coder");
    assert.equal(result.toolCallParser.listSource, null);
    assert.deepEqual(result.warnings, []);
  }
});

test("the template text decides the family when the card carries none, and a card without it still resolves", () => {
  const card = {
    identity: { modelType: "qwen3_5", textModelType: "qwen3_5_text" },
    quant: { method: "fp8" },
  };
  const withText = signatures.resolveParsersSync(card, "vllm", { knowledge, descriptor: NO_PARSERS, templateText: fixtureTemplate("qwen38-27b-fp8") });
  assert.equal(withText.familyId, "qwen3.8");
  assert.equal(withText.signatureId, "qwen38-xml-effort");
  const withoutText = signatures.resolveParsersSync(card, "vllm", { knowledge, descriptor: NO_PARSERS });
  assert.equal(withoutText.familyId, "qwen3.5-3.6");
});

test("an override can switch automatic tool choice off explicitly", () => {
  const result = signatures.resolveParsersSync(qwen38Card(), "vllm", { knowledge, descriptor: NO_PARSERS, override: { enableAutoToolChoice: false } });
  assert.deepEqual([result.autoToolChoice.value, result.autoToolChoice.source], [false, "model-override"]);
  assert.equal(result.toolCallParser.value, "qwen3_coder");
});
