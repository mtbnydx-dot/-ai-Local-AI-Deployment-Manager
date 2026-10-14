"use strict";

// Role detection and companion pairing (docs/overhaul/02-models.md §7).
//
// detectRole(facts, inv, ctx) evaluates the §7 rules in order, the first match
// wins, and returns { role, runnable, evidence[] }; the evidence entries back
// /role/value and /role/runnable. writeRole(facts, result, ctx) stores the
// role and the `compatibleWith` block of a companion (draft, mtp-head, mmproj,
// adapter) on the fact set, so every value lands with evidence.
//
// pairCompanions(cards) matches companions to mains from finished ModelCards.
// A pairing is "detected": the console offers it and never applies it silently.
//
// `ctx` carries what the collector already holds:
//   config     parsed config.json or null
//   gguf       the ggufFacts() result or null ({ kv, file, ... })
//   stats      the tensor stats ({ byClass, classCounts }) or null
//   file       the requested single-file GGUF name or null
// `facts` is the FactSet (its data and evidence hold the topology written so
// far); `inv` is the folder inventory.

const path = require("node:path");
const { fileEntry, filesOfKind } = require("./inventory");

const ROLES = Object.freeze(["main", "draft", "mtp-head", "mmproj", "adapter", "embedding", "reranker", "tooling-only"]);
const RUNNABLE_ROLES = Object.freeze(["main", "embedding", "reranker"]);
const DRAFT_ARCHITECTURE = /(Draft|Eagle\d?|DFlash|DSpark|Medusa)(Model|ForCausalLM)?$/i;
const DRAFT_CONFIG_KEYS = Object.freeze(["dflash_config", "eagle_config", "num_target_layers"]);
const EMBEDDING_ARCHITECTURE = /(EmbeddingModel|^BertModel|^XLMRobertaModel)$/;
const PROJECTOR_ARCHITECTURE = /Projector/i;
const SEQUENCE_CLASSIFICATION = /ForSequenceClassification$/;
const LM_ARCHITECTURE = /(ForCausalLM|ForConditionalGeneration|LMHeadModel|ForMaskedLM)$/;
const GGUF_POOLING = Object.freeze({ 1: "mean", 2: "cls", 3: "last", 4: "rank" });
const EMBEDDING_POOLING = new Set(["mean", "cls", "last"]);
const CONFIDENCE_RANK = Object.freeze({ declared: 3, detected: 2, "name-heuristic": 1 });

const COPY = Object.freeze({
  toolingOnly: {
    zh: "文件夹里没有 config.json，根目录也没有可加载的权重（只有脚本、文档或自定义子目录），不能启动。",
    en: "No config.json and no loadable weights at the folder root (scripts, notes or a custom subfolder layout only); it cannot be launched.",
  },
  adapter: { zh: "这是适配器（LoRA）文件。", en: "This is an adapter (LoRA) file." },
  mmproj: { zh: "这是多模态投影文件。", en: "This is a vision/audio projector file." },
  draft: { zh: "这是推测解码草稿模型。", en: "This is a speculative-decoding draft model." },
  draftName: { zh: "仅凭文件名判断为草稿模型。", en: "Judged a draft model from the file name only." },
  mtpHead: { zh: "文件里只有 MTP 张量，没有自己的词嵌入和输出层。", en: "Only MTP tensors, with no embedding or output layer of its own." },
  embedding: { zh: "这是向量（embedding）模型。", en: "This is an embedding model." },
  reranker: { zh: "这是重排（rerank）模型。", en: "This is a reranker model." },
  rerankName: { zh: "仅凭名称判断为重排模型。", en: "Judged a reranker from the name only." },
  main: { zh: "有权重和输出层（或共享词嵌入），可作为主模型。", en: "Weights with an LM head (or tied embeddings): a main model." },
  mainArchitecture: { zh: "架构是生成式语言模型。", en: "The architecture is a generative language model." },
  unknown: { zh: "有权重，但没有输出层，也不属于已知的附属类型，角色未知。", en: "Weights without an LM head and no known companion type; the role is unknown." },
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value) {
  const number = Number(value);
  return typeof value !== "boolean" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function fileSource(ref) {
  return { kind: "file", ref };
}

function ggufSource(file, key) {
  return { kind: "gguf", ref: key ? `${file}#${key}` : file };
}

function configSource(pointer) {
  return fileSource(pointer ? `config.json#${pointer}` : "config.json");
}

function architecturesOf(config) {
  const value = config?.architectures;
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function weightEntries(inv) {
  return inv.files.filter((entry) => !entry.name.includes("/") && entry.kind.startsWith("weights:"));
}

function ggufPoolingType(kv, arch) {
  const raw = kv[`${arch}.pooling_type`];
  if (typeof raw === "number") return GGUF_POOLING[raw] || null;
  if (typeof raw === "string") return raw.toLowerCase();
  return null;
}

function numLabels(config) {
  const declared = positiveInt(config?.num_labels);
  if (declared) return declared;
  if (isPlainObject(config?.id2label)) return Object.keys(config.id2label).length || null;
  return null;
}

function entry(fact, value, source, confidence, note) {
  return { fact, value, source, confidence, note };
}

function folderName(inv, ctx) {
  return String(ctx.file ? path.posix.basename(ctx.file) : path.basename(inv.dir || "")).toLowerCase();
}

/**
 * detectRole(facts, inv, ctx) -> { role, runnable, evidence: [{fact, value,
 * source, confidence, note}] }. role is null (runnable false) when weights are
 * present but nothing in §7 matches.
 */
function detectRole(facts, inv, ctx = {}) {
  const config = isPlainObject(ctx.config) ? ctx.config : null;
  const gguf = ctx.gguf || null;
  const kv = gguf?.kv || {};
  const arch = String(kv["general.architecture"] || "").toLowerCase();
  const generalType = String(kv["general.type"] || "").toLowerCase();
  const architectures = architecturesOf(config);
  const stats = ctx.stats || null;
  const byClass = stats?.byClass || {};
  const ggufFile = gguf?.file || ctx.file || null;
  const rootWeights = weightEntries(inv);
  const result = (role, evidence) => ({
    role,
    runnable: RUNNABLE_ROLES.includes(role),
    evidence: evidence.map((item) => ({ ...item, fact: "/role/value" })),
  });

  // 1. tooling-only
  const hasConfig = Boolean(fileEntry(inv, "config.json")) && !ctx.file;
  if (!hasConfig && !rootWeights.length) {
    return result("tooling-only", [entry("/role/value", "tooling-only", fileSource(null), "detected", COPY.toolingOnly)]);
  }

  // 2. adapter
  const adapterSignals = [];
  if (!ctx.file && fileEntry(inv, "adapter_config.json")) {
    adapterSignals.push(entry("/role/value", "adapter", fileSource("adapter_config.json"), "declared", COPY.adapter));
  }
  if (generalType === "adapter") adapterSignals.push(entry("/role/value", "adapter", ggufSource(ggufFile, "general.type"), "declared", COPY.adapter));
  if (adapterSignals.length) return result("adapter", adapterSignals);

  // 3. mmproj
  const mmprojSignals = [];
  if (generalType === "mmproj" || generalType === "projector") {
    mmprojSignals.push(entry("/role/value", "mmproj", ggufSource(ggufFile, "general.type"), "declared", COPY.mmproj));
  }
  const clipKey = Object.keys(kv).find((key) => key.startsWith("clip."));
  if (clipKey) mmprojSignals.push(entry("/role/value", "mmproj", ggufSource(ggufFile, clipKey), "declared", COPY.mmproj));
  if (arch === "clip") mmprojSignals.push(entry("/role/value", "mmproj", ggufSource(ggufFile, "general.architecture"), "declared", COPY.mmproj));
  if (architectures.some((name) => PROJECTOR_ARCHITECTURE.test(name))) {
    mmprojSignals.push(entry("/role/value", "mmproj", configSource("/architectures"), "declared", COPY.mmproj));
  }
  if (mmprojSignals.length) return result("mmproj", mmprojSignals);
  if (gguf && /^mmproj(?:[-_.]|$)/i.test(path.posix.basename(ggufFile || ""))) {
    return result("mmproj", [entry("/role/value", "mmproj", fileSource(ggufFile), "name-heuristic", COPY.mmproj)]);
  }

  // 4. draft
  const draftSignals = [];
  if (architectures.some((name) => DRAFT_ARCHITECTURE.test(name))) {
    draftSignals.push(entry("/role/value", "draft", configSource("/architectures"), "declared", COPY.draft));
  }
  for (const key of DRAFT_CONFIG_KEYS) {
    if (config && Object.hasOwn(config, key) && config[key] !== null) {
      draftSignals.push(entry("/role/value", "draft", configSource(`/${key}`), "declared", COPY.draft));
    }
  }
  if (generalType === "draft") draftSignals.push(entry("/role/value", "draft", ggufSource(ggufFile, "general.type"), "declared", COPY.draft));
  if (/^dflash/.test(arch)) draftSignals.push(entry("/role/value", "draft", ggufSource(ggufFile, "general.architecture"), "declared", COPY.draft));
  if (draftSignals.length) return result("draft", draftSignals);
  if (gguf && /(?:dflash|draft)/i.test(path.posix.basename(ggufFile || ""))) {
    return result("draft", [entry("/role/value", "draft", fileSource(ggufFile), "name-heuristic", COPY.draftName)]);
  }

  // 5. mtp-head
  const classCounts = stats?.classCounts || {};
  const classified = Object.values(classCounts).reduce((sum, count) => sum + count, 0);
  const mtpTensors = classCounts.mtp || 0;
  const modelType = typeof config?.model_type === "string" ? config.model_type : "";
  if (mtpTensors > 0 && mtpTensors === classified) {
    return result("mtp-head", [entry("/role/value", "mtp-head", { kind: "tensor-table", ref: stats.ref || null }, "detected", COPY.mtpHead)]);
  }
  if (/_mtp$/i.test(modelType)) {
    return result("mtp-head", [entry("/role/value", "mtp-head", configSource("/model_type"), "detected", COPY.mtpHead)]);
  }

  // 6. embedding
  const hasLmHead = (byClass.lmHead || 0) > 0;
  const embeddingSignals = [];
  if (!ctx.file && fileEntry(inv, "modules.json") && fileEntry(inv, "1_Pooling/config.json")) {
    embeddingSignals.push(entry("/role/value", "embedding", fileSource("modules.json"), "declared", COPY.embedding));
  }
  if (architectures.some((name) => EMBEDDING_ARCHITECTURE.test(name)) && !hasLmHead) {
    embeddingSignals.push(entry("/role/value", "embedding", configSource("/architectures"), "detected", COPY.embedding));
  }
  const pooling = gguf ? ggufPoolingType(kv, arch) : null;
  if (pooling && EMBEDDING_POOLING.has(pooling) && kv[`${arch}.attention.causal`] !== true) {
    embeddingSignals.push(entry("/role/value", "embedding", ggufSource(ggufFile, `${arch}.pooling_type`), "declared", COPY.embedding));
  }
  if (embeddingSignals.length) return result("embedding", embeddingSignals);

  // 7. reranker
  const rerankSignals = [];
  if (architectures.some((name) => SEQUENCE_CLASSIFICATION.test(name)) && numLabels(config) === 1) {
    rerankSignals.push(entry("/role/value", "reranker", configSource("/architectures"), "declared", COPY.reranker));
  }
  if (pooling === "rank") rerankSignals.push(entry("/role/value", "reranker", ggufSource(ggufFile, `${arch}.pooling_type`), "declared", COPY.reranker));
  if (rerankSignals.length) return result("reranker", rerankSignals);
  if (folderName(inv, ctx).includes("rerank")) {
    return result("reranker", [entry("/role/value", "reranker", { kind: "name", ref: null }, "name-heuristic", COPY.rerankName)]);
  }

  // 8. main
  const hasWeights = rootWeights.length > 0 || filesOfKind(inv, "weights:safetensors").length > 0 || filesOfKind(inv, "weights:bin").length > 0;
  if (hasWeights) {
    const tied = config?.tie_word_embeddings !== false && (byClass.embedding || 0) > 0;
    if (hasLmHead || tied) {
      const where = stats?.ref ? { kind: "tensor-table", ref: stats.ref } : fileSource(null);
      return result("main", [entry("/role/value", "main", where, "detected", COPY.main)]);
    }
    if (!stats && architectures.some((name) => LM_ARCHITECTURE.test(name))) {
      return result("main", [entry("/role/value", "main", configSource("/architectures"), "detected", COPY.mainArchitecture)]);
    }
  }
  return { role: null, runnable: false, evidence: [entry("/role/value", null, fileSource(null), "detected", COPY.unknown)] };
}

function bestEvidence(items) {
  return items.reduce((best, item) => (!best || (CONFIDENCE_RANK[item.confidence] || 0) > (CONFIDENCE_RANK[best.confidence] || 0) ? item : best), null);
}

// Copies the evidence of an existing fact to another pointer.
function copyFact(facts, fromPointer, toPointer) {
  const value = facts.get(fromPointer);
  const evidence = facts.evidence.find((item) => item.fact === fromPointer);
  if (value === undefined || value === null || !evidence) return false;
  return facts.set(toPointer, value, evidence.source, evidence.confidence, evidence.note);
}

function writeCompatibleWith(facts, role, ctx) {
  const config = isPlainObject(ctx.config) ? ctx.config : null;
  const kv = ctx.gguf?.kv || {};
  const ggufFile = ctx.gguf?.file || ctx.file || null;
  if (role === "mmproj") {
    // The projector's output dimension is what has to match the main's hidden size.
    for (const key of ["clip.vision.projection_dim", "clip.audio.projection_dim"]) {
      if (positiveInt(kv[key])) {
        facts.set("/compatibleWith/projectionDim", positiveInt(kv[key]), ggufSource(ggufFile, key), "declared");
        return;
      }
    }
    if (config) {
      const vision = isPlainObject(config.vision_config) ? config.vision_config : null;
      if (positiveInt(config.out_hidden_size)) facts.set("/compatibleWith/projectionDim", positiveInt(config.out_hidden_size), configSource("/out_hidden_size"), "declared");
      else if (positiveInt(vision?.out_hidden_size)) facts.set("/compatibleWith/projectionDim", positiveInt(vision.out_hidden_size), configSource("/vision_config/out_hidden_size"), "declared");
    }
    return;
  }
  if (role === "adapter") {
    copyFact(facts, "/identity/baseModel", "/compatibleWith/baseModel");
    return;
  }
  // draft and mtp-head
  copyFact(facts, "/topology/hiddenSize", "/compatibleWith/hiddenSize");
  copyFact(facts, "/topology/vocabSize", "/compatibleWith/vocabSize");
  if (config) {
    const dflash = isPlainObject(config.dflash_config) ? config.dflash_config : null;
    const eagle = isPlainObject(config.eagle_config) ? config.eagle_config : null;
    const candidates = [
      [config.num_target_layers, "/num_target_layers"],
      [dflash?.num_target_layers, "/dflash_config/num_target_layers"],
      [eagle?.num_target_layers, "/eagle_config/num_target_layers"],
    ];
    const found = candidates.find(([value]) => positiveInt(value));
    if (found) facts.set("/compatibleWith/targetLayers", positiveInt(found[0]), configSource(found[1]), "declared");
  }
}

/**
 * Stores the role (and a companion's compatibleWith) on the fact set. Call it
 * after the topology and identity facts are written.
 */
function writeRole(facts, result, ctx = {}) {
  if (!result.role) {
    const note = result.evidence[0];
    facts.support("/role", note.source, note.confidence, note.note);
    return result;
  }
  const primary = bestEvidence(result.evidence);
  facts.set("/role/value", result.role, primary.source, primary.confidence, primary.note);
  facts.set("/role/runnable", result.runnable, primary.source, primary.confidence, primary.note);
  for (const item of result.evidence) {
    if (item !== primary) facts.support("/role/value", item.source, item.confidence, item.note);
  }
  if (["draft", "mtp-head", "mmproj", "adapter"].includes(result.role)) writeCompatibleWith(facts, result.role, ctx);
  return result;
}

// ---------------------------------------------------------------------------
// Pairing (card side)

function cardDir(card) {
  const ref = card?.ref;
  return ref && ref.kind === "local" && typeof ref.path === "string" ? ref.path : null;
}

function normalizeName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// null: cannot tell (a value is unknown); true / false: known to match / differ.
function compare(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  return left === right;
}

function mainRepoNames(card) {
  return [card.ref?.repo, card.origin?.repo, card.identity?.baseModel, card.identity?.displayName]
    .map(normalizeName).filter(Boolean);
}

/**
 * Compatibility of one companion with one main (both cards):
 * { ok, strict, checks }. `strict` demands every field known (the
 * cross-folder rule); a companion in the main's own folder only has to
 * contradict nothing.
 */
function companionMatch(companion, main, { strict }) {
  const need = companion.compatibleWith || {};
  const role = companion.role?.value;
  const top = main.topology || {};
  const checks = {};
  if (role === "adapter") {
    const names = mainRepoNames(main);
    checks.baseModel = need.baseModel ? names.includes(normalizeName(need.baseModel)) : null;
  } else {
    checks.vocabSize = compare(need.vocabSize, top.vocabSize);
    if (role === "mmproj") {
      checks.projectionDim = compare(need.projectionDim, top.hiddenSize);
    } else {
      checks.hiddenSize = compare(need.hiddenSize, top.hiddenSize);
      checks.targetLayers = compare(need.targetLayers, top.layers);
    }
  }
  const values = Object.values(checks);
  if (values.includes(false)) return { ok: false, checks };
  if (!strict) return { ok: true, checks };
  // Cross-folder: vocabSize (when the companion has one) and the hidden-size
  // link must both be known and equal; a missing targetLayers is allowed.
  const hiddenLink = role === "mmproj" ? checks.projectionDim : role === "adapter" ? checks.baseModel : checks.hiddenSize;
  if (hiddenLink !== true) return { ok: false, checks };
  if (role !== "adapter" && need.vocabSize && checks.vocabSize !== true) return { ok: false, checks };
  return { ok: true, checks };
}

/**
 * pairCompanions(cards) -> Pairing[]:
 *   { companion: cardId, main: cardId, role, basis: "same-folder" | "shape",
 *     confidence: "detected", checks }
 * A companion is a card with role draft, mtp-head, mmproj or adapter; a main is
 * a card with role main. Same-folder pairs (one folder holding a main GGUF and
 * its mmproj or draft GGUF) come first; the rest follow the §7 rule: equal
 * vocabSize and (equal hiddenSize, or a projector dimension equal to the main's
 * hiddenSize) and a targetLayers that is absent or equal to the main's layers.
 * The order is stable: same-folder first, then by main cardId, then companion.
 */
function pairCompanions(cards) {
  const list = Array.isArray(cards) ? cards.filter((card) => card && typeof card === "object") : [];
  const mains = list.filter((card) => card.role?.value === "main");
  const companions = list.filter((card) => ["draft", "mtp-head", "mmproj", "adapter"].includes(card.role?.value));
  const pairings = [];
  for (const companion of companions) {
    const dir = cardDir(companion);
    for (const main of mains) {
      if (companion.cardId === main.cardId) continue;
      const sameFolder = dir !== null && dir === cardDir(main) && companion.format?.kind === "gguf" && main.format?.kind === "gguf";
      const match = companionMatch(companion, main, { strict: !sameFolder });
      if (!match.ok) continue;
      pairings.push({
        companion: companion.cardId,
        main: main.cardId,
        role: companion.role.value,
        basis: sameFolder ? "same-folder" : "shape",
        confidence: "detected",
        checks: match.checks,
      });
    }
  }
  const rank = (pairing) => (pairing.basis === "same-folder" ? 0 : 1);
  pairings.sort((left, right) => rank(left) - rank(right)
    || (left.main < right.main ? -1 : left.main > right.main ? 1 : 0)
    || (left.companion < right.companion ? -1 : left.companion > right.companion ? 1 : 0));
  return pairings;
}

module.exports = {
  COPY,
  DRAFT_ARCHITECTURE,
  ROLES,
  RUNNABLE_ROLES,
  detectRole,
  pairCompanions,
  writeRole,
};
