"use strict";

// Chat template signatures and parser resolution (docs/overhaul/02-models.md
// 8.3 and 8.6, MOD-7).
//
// matchTemplate fingerprints a chat template against the layered
// "template-signatures" knowledge: an exact sha256 wins, then the feature
// clauses (all / any / none / regex) with the most specific entry first. The
// template text is untrusted: only literal substring checks and regexes that
// passed the knowledge layer's safety check ever run on it, and it is capped.
//
// resolveParsers answers which tool-call and reasoning parser an engine should
// use for a model, with the source of the answer, and never drops a value
// silently: a name the runtime image does not list is replaced by the engine's
// own auto detection (or empty) and a warning names the image and the parser.
// Precedence: per-model override, family engine parsers (quant-scoped first),
// template signature, the descriptor's capabilities.autoParsers, empty.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const knowledgeModule = require("./knowledge");

const MAX_TEMPLATE_CHARS = 1024 * 1024;
const MAX_TEMPLATE_FILE_BYTES = 4 * 1024 * 1024;
const KINDS = Object.freeze(["tool", "reasoning"]);
// The catalog ids the results are keyed by (01 launch parameter catalogs).
const CATALOG_IDS = Object.freeze({ tool: "toolCallParser", reasoning: "reasoningParser", autoToolChoice: "autoToolChoice" });
const PARSER_FLAGS = Object.freeze({ tool: "--tool-call-parser", reasoning: "--reasoning-parser" });
// Values the engines interpret themselves; they are not parser names to look up.
const ENGINE_KEYWORDS = new Set(["auto", "none"]);

const REASON = Object.freeze({
  override: "set for this model / 为此模型单独指定",
  knowledge: "from the model family knowledge / 来自模型家族知识库",
  knowledgeQuant: (rule) => `from the model family knowledge for ${rule} weights / 来自模型家族知识库（${rule} 权重）`,
  template: (id) => `from the chat template signature ${id} / 来自聊天模板签名 ${id}`,
  engineAuto: "engine detects from the chat template / 由引擎按模板自动识别",
  unknown: "no parser is known for this model; pick a parser or run the probe / 未知解析器，请手动选择或运行探测",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function sha256Of(text) {
  return crypto.createHash("sha256").update(normalizeText(text), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Template matching

function signatureRecords(knowledge) {
  const records = knowledge?.records?.["template-signatures"];
  if (Array.isArray(records)) {
    return records
      .filter((record) => isPlainObject(record?.entry))
      .map((record, index) => ({ entry: record.entry, layerRank: Number(record.layerRank) || 0, order: Number.isFinite(record.order) ? record.order : index }));
  }
  // A plain list of entries (tests, callers that merged the layers themselves).
  const entries = Array.isArray(knowledge?.templateSignatures) ? knowledge.templateSignatures : Array.isArray(knowledge) ? knowledge : [];
  return entries.filter(isPlainObject).map((entry, index) => ({ entry, layerRank: 0, order: index }));
}

function featureEvaluation(entry, text) {
  const features = isPlainObject(entry.features) ? entry.features : null;
  if (!features) return null;
  const all = Array.isArray(features.all) ? features.all : [];
  const any = Array.isArray(features.any) ? features.any : [];
  const none = Array.isArray(features.none) ? features.none : [];
  const regex = Array.isArray(features.regex) ? features.regex : [];
  if (!all.length && !any.length && !regex.length) return null;
  const matched = [];
  for (const token of all) {
    if (!text.includes(token)) return null;
    matched.push(token);
  }
  if (any.length) {
    const hit = any.find((token) => text.includes(token));
    if (hit === undefined) return null;
    matched.push(hit);
  }
  for (const token of none) if (text.includes(token)) return null;
  const flags = typeof entry.flags === "string" ? entry.flags : "";
  for (const source of regex) {
    const compiled = knowledgeModule.compileSafeRegex(source, flags);
    if (!compiled.ok || !compiled.regexp.test(text)) return null;
    matched.push(`/${source}/`);
  }
  // Specificity counts what must be present; exclusions only narrow an entry.
  return { matched, clauses: all.length + (any.length ? 1 : 0) + regex.length };
}

function shaMatches(entry, sha) {
  return (Array.isArray(entry.sha256) ? entry.sha256 : []).some((prefix) => typeof prefix === "string" && prefix.length >= 16 && sha.startsWith(prefix.toLowerCase()));
}

function resultOf(entry, exact, features) {
  return {
    signatureId: entry.id,
    exact,
    features,
    toolFormat: entry.toolFormat ?? null,
    reasoningFormat: entry.reasoningFormat ?? null,
    thinking: entry.thinking ? JSON.parse(JSON.stringify(entry.thinking)) : null,
    parsers: entry.parsers ? JSON.parse(JSON.stringify(entry.parsers)) : null,
  };
}

function noTemplateMatch() {
  return { signatureId: null, exact: null, features: [], toolFormat: null, reasoningFormat: null, thinking: null, parsers: null };
}

function compareCandidates(left, right) {
  const priority = (right.record.entry.priority || 0) - (left.record.entry.priority || 0);
  if (priority) return priority;
  const clauses = right.clauses - left.clauses;
  if (clauses) return clauses;
  const layer = right.record.layerRank - left.record.layerRank;
  if (layer) return layer;
  return left.record.order - right.record.order;
}

/**
 * matchTemplate(templateText, knowledge) -> {signatureId, exact, features,
 * toolFormat, reasoningFormat, thinking, parsers}. `knowledge` is the result of
 * knowledge.load(). `exact` is true only for a sha256 hit; a feature match is
 * `exact:false`; no match leaves every field null.
 */
function matchTemplate(templateText, knowledge) {
  if (typeof templateText !== "string" || !templateText.length) return noTemplateMatch();
  const records = signatureRecords(knowledge);
  if (!records.length) return noTemplateMatch();
  const sha = sha256Of(templateText);
  const exactHits = records.filter((record) => shaMatches(record.entry, sha)).map((record) => ({ record, clauses: 0 }));
  if (exactHits.length) {
    exactHits.sort(compareCandidates);
    return resultOf(exactHits[0].record.entry, true, [`sha256:${sha.slice(0, 16)}`]);
  }
  const text = normalizeText(templateText.length > MAX_TEMPLATE_CHARS ? templateText.slice(0, MAX_TEMPLATE_CHARS) : templateText);
  const candidates = [];
  for (const record of records) {
    const verdict = featureEvaluation(record.entry, text);
    if (verdict) candidates.push({ record, clauses: verdict.clauses, matched: verdict.matched });
  }
  if (!candidates.length) return noTemplateMatch();
  candidates.sort(compareCandidates);
  return resultOf(candidates[0].record.entry, false, candidates[0].matched);
}

function templateById(signatureId, knowledge) {
  const record = signatureRecords(knowledge).find((item) => item.entry.id === signatureId);
  return record ? resultOf(record.entry, null, []) : null;
}

/**
 * readLocalTemplate(dir) -> {text, source} | null. Same lookup order as the
 * inspector's template detector (chat_template.jinja, tokenizer_config.json
 * string or named list, chat_template.json) for callers that only have a
 * model directory. Never throws; oversized files are skipped.
 */
function readLocalTemplate(dir) {
  if (!dir || typeof dir !== "string") return null;
  const read = (name) => {
    try {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_TEMPLATE_FILE_BYTES) return null;
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const jinja = read("chat_template.jinja");
  if (jinja) return { text: jinja, source: "chat_template.jinja" };
  const tokenizer = read("tokenizer_config.json");
  if (tokenizer) {
    try {
      const value = JSON.parse(tokenizer).chat_template;
      if (typeof value === "string" && value.length) return { text: value, source: "tokenizer_config.json" };
      if (Array.isArray(value)) {
        const named = value.filter((item) => item && typeof item.name === "string" && typeof item.template === "string");
        const chosen = named.find((item) => item.name === "default") || named[0];
        if (chosen) return { text: chosen.template, source: "tokenizer_config.json" };
      }
    } catch {
      // A broken tokenizer_config.json is the inspector's finding, not ours.
    }
  }
  const processor = read("chat_template.json");
  if (processor) {
    try {
      const value = JSON.parse(processor).chat_template;
      if (typeof value === "string" && value.length) return { text: value, source: "chat_template.json" };
    } catch {
      // Same as above.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parser lists from the runtime facts (01 17)

function indexFlags(flagsSection) {
  const list = Array.isArray(flagsSection?.flags) ? flagsSection.flags : Array.isArray(flagsSection) ? flagsSection : null;
  if (!list) return null;
  const index = new Map();
  for (const entry of list) {
    if (!entry || typeof entry.flag !== "string") continue;
    index.set(entry.flag, entry);
    for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) if (typeof alias === "string" && !index.has(alias)) index.set(alias, entry);
  }
  return index;
}

function nameList(value) {
  if (!Array.isArray(value)) return null;
  const names = value.filter((item) => typeof item === "string" && item.length);
  return names.length ? names : null;
}

/**
 * parserLists(facts) -> {tool: {names, from} | null, reasoning: ...}. The
 * introspected `choices` of --tool-call-parser / --reasoning-parser come first,
 * then the probe registries (toolParsers / reasoningParsers). A null kind means
 * the runtime does not say, so nothing can be checked.
 */
function parserLists(facts) {
  const index = indexFlags(facts?.flags);
  const registries = isPlainObject(facts?.registries) ? facts.registries : null;
  const lists = { tool: null, reasoning: null };
  for (const kind of KINDS) {
    const choices = nameList(index?.get(PARSER_FLAGS[kind])?.choices);
    if (choices) {
      lists[kind] = { names: choices, from: "introspected" };
      continue;
    }
    const registered = nameList(registries?.[kind === "tool" ? "toolParsers" : "reasoningParsers"]);
    if (registered) lists[kind] = { names: registered, from: "registries" };
  }
  return lists;
}

// ---------------------------------------------------------------------------
// Parser resolution

function quantRuleMatches(rule, haystack) {
  return String(rule).split("|").map((item) => item.trim().toLowerCase()).filter(Boolean).some((item) => haystack.includes(item));
}

function parserName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bilingual(en, zh) {
  return `${en} / ${zh}`;
}

function candidateFor(kind, sources) {
  for (const source of sources) {
    const value = parserName(source.parsers?.[kind]);
    if (value) return { value, source: source.source, reason: source.reason, alternatives: Array.isArray(source.alternatives) ? source.alternatives : [] };
  }
  return null;
}

function buildSources({ ctx, family, engineId, template, haystack }) {
  const sources = [];
  if (isPlainObject(ctx.override)) {
    sources.push({ source: "model-override", reason: REASON.override, parsers: ctx.override });
  }
  const engine = isPlainObject(family?.engines?.[engineId]) ? family.engines[engineId] : null;
  const familySource = ctx.familySource || "knowledge";
  if (engine?.parsersByQuant && isPlainObject(engine.parsersByQuant)) {
    for (const [rule, parsers] of Object.entries(engine.parsersByQuant)) {
      if (isPlainObject(parsers) && quantRuleMatches(rule, haystack)) {
        sources.push({ source: familySource, reason: REASON.knowledgeQuant(rule), parsers, alternatives: engine.parsers?.alternatives });
      }
    }
  }
  if (engine?.parsers) sources.push({ source: familySource, reason: REASON.knowledge, parsers: engine.parsers, alternatives: engine.parsers.alternatives });
  const templateParsers = template?.parsers?.[engineId];
  if (templateParsers) {
    sources.push({ source: "template", reason: REASON.template(template.signatureId), parsers: templateParsers, alternatives: templateParsers.alternatives });
  }
  return sources;
}

function resolveKind(kind, { sources, descriptor, lists, runtimeId, image, warnings }) {
  const list = lists[kind];
  const listSource = list ? list.from : null;
  const finish = (entry) => ({ ...entry, listSource });
  const candidate = candidateFor(kind, sources);
  let requested = null;
  if (candidate) {
    const known = ENGINE_KEYWORDS.has(candidate.value.toLowerCase()) || !list || list.names.includes(candidate.value);
    if (known) return finish({ value: candidate.value, source: candidate.source, reason: candidate.reason });
    const alternative = candidate.alternatives.find((name) => typeof name === "string" && list.names.includes(name));
    if (alternative) {
      return finish({
        value: alternative,
        source: candidate.source,
        reason: bilingual(`${candidate.value} is not in the runtime; its alternative ${alternative} is`, `运行时没有 ${candidate.value}，改用备选 ${alternative}`),
        requested: candidate.value,
      });
    }
    requested = candidate.value;
    warnings.push({
      code: "parser_not_in_image",
      kind,
      parser: candidate.value,
      source: candidate.source,
      runtimeId: runtimeId || null,
      image: image || null,
      message: bilingual(
        `The ${kind === "tool" ? "tool-call" : "reasoning"} parser "${candidate.value}" is not available in ${image || runtimeId || "this runtime image"}`,
        `${kind === "tool" ? "工具调用" : "思考"}解析器 “${candidate.value}” 不在 ${image || runtimeId || "该运行时镜像"} 中`,
      ),
    });
  }
  const auto = parserName(descriptor?.capabilities?.autoParsers?.[kind]);
  if (auto) {
    return finish({ value: auto, source: "engine-auto", reason: REASON.engineAuto, ...(requested ? { requested } : {}) });
  }
  if (!requested) {
    warnings.push({
      code: "parser_unknown",
      kind,
      parser: null,
      source: null,
      runtimeId: runtimeId || null,
      image: image || null,
      message: REASON.unknown,
    });
  }
  return finish({ value: "", source: "none", reason: REASON.unknown, ...(requested ? { requested } : {}) });
}

function withAliases(result) {
  // Catalog ids are the keys; the shorter spec names stay readable but are not
  // serialized, so a JSON response carries each answer once.
  Object.defineProperty(result, "tool", { value: result.toolCallParser, enumerable: false });
  Object.defineProperty(result, "reasoning", { value: result.reasoningParser, enumerable: false });
  Object.defineProperty(result, "enableAutoToolChoice", { value: result.autoToolChoice, enumerable: false });
  return result;
}

/**
 * resolveParsersSync(card, engineId, ctx): the pure part. ctx: {facts (the
 * runtime-facts value, or null), runtimeId, image, descriptor, quantMethod,
 * model, override: {tool, reasoning, enableAutoToolChoice}, knowledge, family,
 * templateText, template}.
 */
function resolveParsersSync(card, engineId, ctx = {}) {
  const subject = isPlainObject(card) ? card : {};
  const knowledge = ctx.knowledge || knowledgeModule.loadKnowledge();
  let template = isPlainObject(ctx.template) && "signatureId" in ctx.template ? ctx.template : null;
  if (!template && typeof ctx.templateText === "string" && ctx.templateText) template = matchTemplate(ctx.templateText, knowledge);
  if (!template && subject.template?.signatureId) template = templateById(subject.template.signatureId, knowledge);
  if (!template && typeof subject.template?.text === "string" && subject.template.text) template = matchTemplate(subject.template.text, knowledge);
  const signatureId = template?.signatureId || subject.template?.signatureId || null;

  let family = ctx.family || null;
  let familyMatch = null;
  if (!family) {
    const matchCard = signatureId && subject.template?.signatureId !== signatureId
      ? { ...subject, template: { ...(subject.template || {}), signatureId } }
      : subject;
    familyMatch = knowledgeModule.matchFamily(matchCard, knowledge);
    family = familyMatch.entry || null;
  }

  const quant = subject.quant || {};
  const haystack = [ctx.quantMethod, quant.method, quant.algo, ctx.model].map((item) => String(item || "").toLowerCase()).join(" ");
  const sources = buildSources({
    ctx: { ...ctx, familySource: familyMatch?.matchedBy?.includes("model-override") ? "model-override" : "knowledge" },
    family,
    engineId,
    template,
    haystack,
  });
  const lists = parserLists(ctx.facts);
  const warnings = [];
  const env = { sources, descriptor: ctx.descriptor, lists, runtimeId: ctx.runtimeId || ctx.facts?.runtimeId || null, image: ctx.image || null, warnings };
  const tool = resolveKind("tool", env);
  const reasoning = resolveKind("reasoning", env);

  let autoToolChoice;
  if (ctx.override && typeof ctx.override.enableAutoToolChoice === "boolean") {
    autoToolChoice = { value: ctx.override.enableAutoToolChoice, source: "model-override", reason: REASON.override };
  } else {
    autoToolChoice = {
      value: tool.value !== "",
      source: tool.source,
      reason: tool.value !== "" ? bilingual("a tool-call parser is set", "已设置工具调用解析器") : bilingual("no tool-call parser, so automatic tool choice is off", "没有工具调用解析器，自动工具选择关闭"),
    };
  }

  return withAliases({
    [CATALOG_IDS.tool]: tool,
    [CATALOG_IDS.reasoning]: reasoning,
    [CATALOG_IDS.autoToolChoice]: autoToolChoice,
    engineId,
    runtimeId: env.runtimeId,
    familyId: family?.id || null,
    signatureId,
    warnings,
  });
}

/**
 * resolveParsers(card, engineId, {runtimeFacts, runtimeId, ...}) ->
 * {toolCallParser, reasoningParser, autoToolChoice: {value, source, reason},
 * warnings, ...}. Reads the parser lists through runtimeFacts.get(runtimeId)
 * (the engines.runtimeFacts store, or a stub with the same get); a read that
 * fails or finds nothing leaves the lists unknown, which accepts the value as
 * given.
 */
async function resolveParsers(card, engineId, ctx = {}) {
  let facts = ctx.facts;
  if (facts === undefined) {
    facts = null;
    if (ctx.runtimeFacts && typeof ctx.runtimeFacts.get === "function" && ctx.runtimeId) {
      try {
        facts = (await ctx.runtimeFacts.get(ctx.runtimeId)) || null;
      } catch {
        facts = null;
      }
    }
  }
  return resolveParsersSync(card, engineId, { ...ctx, facts });
}

module.exports = {
  CATALOG_IDS,
  ENGINE_KEYWORDS,
  matchTemplate,
  parserLists,
  readLocalTemplate,
  resolveParsers,
  resolveParsersSync,
  templateSha256: sha256Of,
};
