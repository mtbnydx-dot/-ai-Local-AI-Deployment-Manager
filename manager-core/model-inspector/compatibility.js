"use strict";

// Compatibility matrix (docs/overhaul/02-models.md section 9, MOD-11): one row
// per (engineId, runtimeId) for a ModelCard. The rules R1-R13 are collected
// in order and the verdict is the worst level (block > warn > unknown > ok).
//
// `ok` needs support evidence: a verified-on-host record or a successful probe
// for (contentDigest, runtimeId), a runtime-facts registry hit for the declared
// architecture, or a family matched by declared identity whose engine support
// is verified/documented and whose minimum version/build is satisfied.
// Name-heuristic family matches never count. Without evidence the best
// verdict is `unknown`, with the actions probe and override.
//
// The function is synchronous and pure over its inputs: callers read the
// runtime facts (engines.runtimeFacts.get is async), host records and probe
// results first and pass them in. Defaults come from the engine registry, the
// layered knowledge and process.env.

const knowledgeModule = require("./knowledge");
const fitModule = require("./fit");
const templateSignatures = require("./template-signatures");
const { familyToV1Entry } = require("./migrate-v1");

const LEVEL_RANK = Object.freeze({ info: 0, ok: 0, unknown: 1, warn: 2, block: 3 });
const SUPPORTING = new Set(["verified", "documented"]);
const BLOCKING_SUPPORT = new Set(["blocked", "unsupported"]);
// Card role -> descriptor capabilities.roles value (02 section 9). Every other
// role is never standalone-servable.
const ROLE_TO_DESCRIPTOR = Object.freeze({ main: "chat", embedding: "embedding", reranker: "rerank" });
// Descriptor artifactFormats entries that mean "Hugging Face style weights".
const HF_FORMATS = new Set(["safetensors", "fp8", "nvfp4", "awq", "gptq"]);
const PREVIEW = Object.freeze({ contextLength: 4096, concurrency: 1 });
const GIB = 1024 ** 3;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function t(zh, en) {
  return { zh, en };
}

function bilingualFrom(value, fallback) {
  if (isPlainObject(value) && (value.zh || value.en)) return t(value.zh || value.en, value.en || value.zh);
  if (typeof value === "string" && value.trim()) {
    // Data strings are written in one language; the other side keeps the generic text.
    return /[㐀-鿿]/.test(value) ? t(value, fallback.en) : t(fallback.zh, value);
  }
  return fallback;
}

function labelOf(family) {
  const label = family?.label;
  if (isPlainObject(label)) return t(label.zh || label.en || family.id, label.en || label.zh || family.id);
  return t(String(label || family?.id || ""), String(label || family?.id || ""));
}

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function envFlagEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizePlatform(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["wsl", "wsl2", "win32", "windows", "windows-docker"].includes(text)) return "wsl";
  return text;
}

function parseNumber(value) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : null;
}

// "5.8.0.dev0" -> [5, 8]; null when there is no leading number.
function majorMinor(value) {
  const match = String(value ?? "").match(/(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function versionParts(value) {
  const match = String(value ?? "").trim().match(/^v?(\d+(?:\.\d+)*)/i);
  return match ? match[1].split(".").map(Number) : null;
}

function compareParts(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function buildNumberOf(ref) {
  const fromRelease = Number(ref?.release?.build);
  if (Number.isFinite(fromRelease) && fromRelease > 0) return fromRelease;
  const match = String(ref?.version || "").match(/^b(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

// ---------------------------------------------------------------------------
// Inputs

function lookup(source, key) {
  if (!source || key === null || key === undefined) return null;
  if (typeof source === "function") return source(key) ?? null;
  if (source instanceof Map) return source.get(key) ?? null;
  if (isPlainObject(source)) return source[key] ?? null;
  return null;
}

function toList(source, filter) {
  if (Array.isArray(source)) return source;
  if (typeof source === "function") {
    const value = source(filter);
    return Array.isArray(value) ? value : [];
  }
  if (source instanceof Map) return [...source.values()];
  return [];
}

function descriptorMap(descriptors) {
  const list = Array.isArray(descriptors) ? descriptors
    : descriptors instanceof Map ? [...descriptors.values()]
      : isPlainObject(descriptors) ? Object.entries(descriptors).map(([id, descriptor]) => ({ id, ...descriptor }))
        : [];
  return new Map(list.filter((item) => isPlainObject(item) && item.id).map((item) => [item.id, item]));
}

function registryDefaults(options) {
  let registry = options.registry || null;
  const need = !options.descriptors || !options.runtimes;
  if (!registry && need) {
    try {
      registry = require("../engines/registry").getEngineRegistry();
    } catch {
      registry = null;
    }
  }
  const descriptors = options.descriptors ? descriptorMap(options.descriptors) : descriptorMap(registry ? registry.list() : []);
  let runtimes = options.runtimes;
  if (!Array.isArray(runtimes)) {
    runtimes = [];
    for (const id of descriptors.keys()) {
      try {
        runtimes.push(...(registry ? registry.runtimesFor(id) : []));
      } catch {
        // An engine without runtimes (external) contributes no runtime rows.
      }
    }
  }
  return { descriptors, runtimes };
}

// ---------------------------------------------------------------------------
// Card facts

function cardFacts(card) {
  const identity = isPlainObject(card.identity) ? card.identity : {};
  const quant = isPlainObject(card.quant) ? card.quant : {};
  const formatKind = typeof card.format?.kind === "string" ? card.format.kind : "";
  const gguf = formatKind === "gguf";
  const architectures = gguf
    ? [identity.ggufArchitecture].filter(Boolean)
    : (Array.isArray(identity.architectures) ? identity.architectures : []).filter(Boolean);
  const roleValue = card.role?.value || "main";
  return {
    identity,
    quant,
    formatKind,
    gguf,
    architectures: architectures.map(String),
    archPointer: gguf ? "/identity/ggufArchitecture" : "/identity/architectures",
    roleValue,
    runnable: card.role?.runnable !== false,
    method: String(quant.method || "").toLowerCase(),
    algo: String(quant.algo || "").toLowerCase(),
    autoMap: isPlainObject(card.customCode?.autoMap) && Object.keys(card.customCode.autoMap).length ? card.customCode.autoMap : null,
  };
}

function quantCandidates(facts) {
  const { method, algo } = facts;
  if (!method || method === "none" || method === "gguf") return [];
  const out = new Set([method]);
  if (method === "modelopt") {
    out.add("modelopt");
    if (algo.includes("fp4")) out.add("modelopt_fp4");
    if (algo.includes("fp8")) out.add("modelopt");
  }
  if (method === "bnb" || method === "bitsandbytes") {
    out.add("bitsandbytes");
    out.add("bnb");
  }
  if (method === "compressed-tensors") out.add("compressed_tensors");
  if (method === "auto-round") out.add("auto_round");
  return [...out];
}

function isBnb(facts) {
  return facts.method === "bitsandbytes" || facts.method === "bnb";
}

function isNvfp4(facts) {
  return /nvfp4|modelopt_fp4/.test(`${facts.method} ${facts.algo}`);
}

function isFp8(facts) {
  return !isNvfp4(facts) && (facts.method === "fp8" || facts.algo === "fp8");
}

// The descriptor artifactFormats entry that a quantization maps to, if any.
function quantFormatOf(facts) {
  if (isNvfp4(facts)) return "nvfp4";
  if (isFp8(facts)) return "fp8";
  if (facts.method === "awq") return "awq";
  if (facts.method === "gptq") return "gptq";
  return null;
}

function hostGpus(host) {
  return (Array.isArray(host?.gpus) ? host.gpus : []).map((gpu, index) => ({
    id: String(gpu?.id ?? gpu?.index ?? index),
    name: gpu?.name || null,
    computeCap: parseNumber(gpu?.computeCap ?? gpu?.computeCapability),
    raw: gpu,
  }));
}

// ---------------------------------------------------------------------------
// Row evaluation

function createRow(engineId, runtimeId) {
  return { engineId, runtimeId, verdict: "ok", supportEvidence: [], reasons: [], actions: [], fitPreview: null };
}

function addReason(row, code, level, message, evidence = null) {
  row.reasons.push({ code, level, message, evidence });
}

function worst(reasons) {
  let best = "ok";
  for (const reason of reasons) {
    if ((LEVEL_RANK[reason.level] ?? 0) > LEVEL_RANK[best]) best = reason.level;
  }
  return best;
}

function formatAccepted(kind, formats) {
  const has = (name) => formats.has(name);
  const hf = [...HF_FORMATS].some(has);
  switch (kind) {
    case "safetensors": case "pytorch-bin": return hf;
    case "gguf": return has("gguf");
    case "exl3": return has("exl3");
    case "mixed": return hf || has("gguf");
    default: return true;
  }
}

function blockApplies(block, ctx) {
  if (!Array.isArray(block.engines) || !block.engines.includes(ctx.engineId)) return false;
  if (block.unlessEnv && envFlagEnabled(ctx.env[block.unlessEnv])) return false;
  const when = isPlainObject(block.when) ? block.when : {};
  if (when.hostPlatform !== undefined && normalizePlatform(when.hostPlatform) !== ctx.platform) return false;
  // modelTypes and architecturePatterns together identify the model: either may match.
  const identityKeys = ["modelTypes", "architecturePatterns"].filter((key) => Array.isArray(when[key]) && when[key].length);
  if (identityKeys.length) {
    const types = [ctx.facts.identity.modelType, ctx.facts.identity.textModelType].filter(Boolean).map((item) => String(item).toLowerCase());
    const architectures = (Array.isArray(ctx.facts.identity.architectures) ? ctx.facts.identity.architectures : []).map(String);
    const hit = identityKeys.some((key) => {
      if (key === "modelTypes") return when.modelTypes.some((item) => types.includes(String(item).toLowerCase()));
      return when.architecturePatterns.some((source) => {
        const compiled = knowledgeModule.compileSafeRegex(String(source), "i");
        return compiled.ok && architectures.some((name) => compiled.regexp.test(name));
      });
    });
    if (!hit) return false;
  }
  return true;
}

function knowledgeEvidence(ctx) {
  const { match, familyEngine, ref, row } = ctx;
  if (!match.entry || match.confidence === "name-heuristic" || !familyEngine) return null;
  if (!SUPPORTING.has(familyEngine.support)) return null;
  const family = match.entry;
  const requiredRuntime = family.requires?.runtimeId;
  if (requiredRuntime && String(requiredRuntime).split("@")[0] === ctx.engineId && requiredRuntime !== row.runtimeId) {
    const name = labelOf(family);
    addReason(row, "runtime_not_validated", "warn",
      t(`${name.zh} 只在运行时 ${requiredRuntime} 上验证过；当前运行时未验证。`,
        `${name.en} was validated only on runtime ${requiredRuntime}; this runtime is not validated.`),
      "/identity/modelType");
    return null;
  }
  const minimumBuild = Number(familyEngine.minimumBuild || 0);
  if (minimumBuild > 0) {
    const build = buildNumberOf(ref);
    if (!build) {
      addReason(row, "runtime_version_unverified", "unknown",
        t(`需要 llama.cpp b${minimumBuild} 或更新，但无法读取当前运行时的构建号。`, `Needs llama.cpp b${minimumBuild} or newer, but this runtime's build number is unknown.`));
      return null;
    }
    if (build < minimumBuild) {
      addReason(row, "runtime_below_minimum", "block",
        t(`${labelOf(family).zh} 需要 llama.cpp b${minimumBuild} 或更新；当前运行时为 b${build}。`,
          `${labelOf(family).en} needs llama.cpp b${minimumBuild} or newer; this runtime is b${build}.`));
      return null;
    }
  }
  if (familyEngine.minimumVersion) {
    const need = versionParts(familyEngine.minimumVersion);
    const have = versionParts(ref?.version);
    if (!have || !need) {
      addReason(row, "runtime_version_unverified", "unknown",
        t(`需要 ${ctx.engineId} ${familyEngine.minimumVersion} 或更新，但无法确定当前运行时的版本。`,
          `Needs ${ctx.engineId} ${familyEngine.minimumVersion} or newer, but this runtime's version is unknown.`));
      return null;
    }
    if (compareParts(have, need) < 0) {
      addReason(row, "runtime_below_minimum", "block",
        t(`${labelOf(family).zh} 需要 ${ctx.engineId} ${familyEngine.minimumVersion} 或更新；当前运行时为 ${ref.version}。`,
          `${labelOf(family).en} needs ${ctx.engineId} ${familyEngine.minimumVersion} or newer; this runtime is ${ref.version}.`));
      return null;
    }
  }
  return { kind: "knowledge", ref: `families/${family.id}#${ctx.engineId}`, confidence: familyEngine.support };
}

function hostRecordEvidence(card, row, hostRecords) {
  if (!card.contentDigest) return null;
  const records = toList(hostRecords, card.contentDigest);
  for (const record of records) {
    if (!isPlainObject(record) || record.contentDigest !== card.contentDigest) continue;
    if (record.runtimeId !== row.runtimeId) continue;
    const results = Array.isArray(record.results) ? record.results : [];
    if (results.some((item) => item?.status === "pass")) {
      return { kind: "verified-on-host", ref: String(record.id || `${card.contentDigest.slice(0, 19)}@${row.runtimeId}`), confidence: "verified-on-host" };
    }
  }
  return null;
}

function findProbe(card, row, probes) {
  if (!card.contentDigest) return null;
  const key = `${card.contentDigest.replace(/^sha256:/, "").slice(0, 12)}@${row.runtimeId}`;
  const direct = lookup(Array.isArray(probes) ? null : probes, key);
  if (isPlainObject(direct)) return { key, probe: direct };
  for (const probe of toList(probes, key)) {
    if (!isPlainObject(probe) || probe.runtimeId !== row.runtimeId) continue;
    if (probe.contentDigest && probe.contentDigest !== card.contentDigest) continue;
    if (!probe.contentDigest && probe.key !== key) continue;
    return { key, probe };
  }
  return null;
}

function parserWarnings(card, engineId, descriptor, facts, row, knowledge) {
  let resolved;
  try {
    resolved = templateSignatures.resolveParsersSync(card, engineId, {
      knowledge, descriptor, facts, runtimeId: row.runtimeId, quantMethod: card.quant?.method,
    });
  } catch {
    return;
  }
  for (const warning of resolved.warnings || []) {
    if (warning.code !== "parser_not_in_image") continue;
    addReason(row, "parser_not_in_image", "warn",
      t(`运行时 ${row.runtimeId} 的镜像里没有${warning.kind === "tool" ? "工具调用" : "思考"}解析器 “${warning.parser}”。`,
        `The ${warning.kind === "tool" ? "tool-call" : "reasoning"} parser "${warning.parser}" is not available in the image of ${row.runtimeId}.`),
      warning.kind === "tool" ? "/template/toolFormat" : "/template/reasoningFormat");
  }
}

function fitValues(engineId, gpuCount, offload, card) {
  const values = { contextLength: PREVIEW.contextLength, concurrency: PREVIEW.concurrency };
  if ((engineId === "vllm" || engineId === "sglang") && gpuCount > 1) values.tensorParallel = gpuCount;
  if (!offload) return values;
  if (engineId === "vllm") {
    const bytes = Number(card.weights?.totalBytes || card.format?.weightBytes || 0);
    values["vllm.cpuOffloadGb"] = Math.max(1, Math.ceil(bytes / GIB));
  } else if (engineId === "llamacpp") {
    values["llamacpp.gpuLayers"] = 0;
    values["llamacpp.nCpuMoe"] = Number(card.topology?.layers || 0);
  } else if (engineId === "sglang") {
    values["sglang.pleOffloadEmbedding"] = true;
  }
  return values;
}

// R11: contextLength 4096, concurrency 1, first as is and, when that fails,
// with the engine's maximum offload. Memoised per engine for one call.
function fitPreviewFor(card, engineId, host, gpus, options, cache) {
  if (!gpus.length || !card.weights?.totalBytes) return null;
  if (cache.has(engineId)) return cache.get(engineId);
  const hostInput = { gpus: gpus.map((gpu) => gpu.raw), ramBytes: host.ramBytes, ramFreeBytes: host.ramFreeBytes, platform: host.platform };
  const run = (offload) => {
    try {
      return fitModule.estimateFit({
        card, engineId, gpuIds: gpus.map((gpu) => gpu.id), values: fitValues(engineId, gpus.length, offload, card),
        host: hostInput, budgetBasis: "empty-gpu", instanceMode: "parallel",
      }, { ...(options.fit || {}), suggestions: false });
    } catch {
      return null;
    }
  };
  let preview = null;
  const plain = run(false);
  if (plain) {
    if (plain.status !== "fail") {
      preview = { fit: plain, preview: { minimalFits: true, needsOffload: false, status: plain.status } };
    } else {
      const offloaded = run(true);
      preview = offloaded && offloaded.status !== "fail"
        ? { fit: offloaded, preview: { minimalFits: true, needsOffload: true, status: offloaded.status } }
        : { fit: offloaded || plain, preview: { minimalFits: false, needsOffload: true, status: "fail" } };
    }
  }
  cache.set(engineId, preview);
  return preview;
}

function evaluateRow(card, ref, descriptor, shared) {
  const { facts, match, family, knowledge, options, env, platform, gpus } = shared;
  const engineId = ref.engineId;
  const row = createRow(engineId, ref.runtimeId);
  const runtimeFacts = lookup(options.runtimeFacts, ref.runtimeId);
  const registries = isPlainObject(runtimeFacts?.registries) ? runtimeFacts.registries : null;
  const release = isPlainObject(ref.release) ? ref.release : {};
  const formats = new Set(Array.isArray(descriptor.artifactFormats) ? descriptor.artifactFormats : []);
  const roles = Array.isArray(descriptor.capabilities?.roles) ? descriptor.capabilities.roles : [];
  const familyEngine = family?.engines?.[engineId] && isPlainObject(family.engines[engineId]) ? family.engines[engineId] : null;
  const label = family ? labelOf(family) : t(facts.identity.modelType || "", facts.identity.modelType || "");
  const ctx = { engineId, facts, match, familyEngine, ref, row, env, platform };

  if (ref.status === "retired") {
    addReason(row, "runtime_retired", "info", t("该运行时已退役，仅保留作回滚。", "This runtime is retired and kept only for rollback."));
  }

  // R1: weights format against the descriptor and the image's plugins.
  if (facts.formatKind === "none") {
    addReason(row, "format_not_supported", "block", t("没有可加载的权重文件。", "There are no loadable weight files."), "/format/kind");
  } else if (facts.formatKind && !formatAccepted(facts.formatKind, formats)) {
    addReason(row, "format_not_supported", "block",
      t(`${engineId} 不能加载 ${facts.formatKind} 格式的权重。`, `${engineId} cannot load ${facts.formatKind} weights.`), "/format/kind");
  } else if (facts.formatKind === "gguf" && registries?.plugins?.gguf === false) {
    addReason(row, "gguf_plugin_missing", "block",
      t(`运行时 ${ref.runtimeId} 的镜像不带 GGUF 支持。`, `The image of ${ref.runtimeId} has no GGUF support.`), "/format/kind");
  }

  // Rules about how the weights would load are moot when the format cannot load at all.
  const moot = row.reasons.some((reason) => reason.code === "format_not_supported" || reason.code === "gguf_plugin_missing");

  // R2: blocked family support and policy blocks (data in the family entry).
  if (match.entry && familyEngine && BLOCKING_SUPPORT.has(familyEngine.support)) {
    addReason(row, "family_blocked", "block",
      bilingualFrom(familyEngine.unsupportedReason || match.entry.download?.reason,
        t(`${label.zh} 不能在 ${engineId} 上启动。`, `${label.en} cannot be started on ${engineId}.`)),
      "/identity/modelType");
  }
  for (const block of Array.isArray(match.entry?.blocks) ? match.entry.blocks : []) {
    if (!blockApplies(block, ctx)) continue;
    addReason(row, block.code || "family_blocked", "block",
      bilingualFrom(block.reason, t(`${label.zh} 在此主机上被策略阻断。`, `${label.en} is blocked by policy on this host.`)),
      "/identity/modelType");
  }

  // R3: role.
  const mapped = ROLE_TO_DESCRIPTOR[facts.roleValue];
  if (!mapped || !facts.runnable) {
    addReason(row, "role_not_servable", "block",
      t(`角色 ${facts.roleValue} 不能单独作为服务启动。`, `A model with role ${facts.roleValue} cannot be served on its own.`), "/role/value");
  } else if (!roles.includes(mapped)) {
    addReason(row, "role_unsupported", "block",
      t(`${engineId} 不支持 ${mapped} 类模型。`, `${engineId} does not serve ${mapped} models.`), "/role/value");
  }

  // R4: compute capability of every selected GPU, and the Blackwell CUDA floor.
  const requirements = [
    { code: "compute_capability", value: parseNumber(match.entry?.requires?.minimumComputeCapability), who: label },
    { code: "compute_capability_runtime", value: parseNumber(release.minimumComputeCapability), who: t(ref.runtimeId, ref.runtimeId) },
  ];
  for (const requirement of requirements) {
    if (!requirement.value) continue;
    const below = gpus.filter((gpu) => gpu.computeCap !== null && gpu.computeCap < requirement.value);
    if (!below.length) continue;
    addReason(row, requirement.code, "block",
      t(`${requirement.who.zh} 需要 SM ${requirement.value.toFixed(1)} 或更新；GPU ${below.map((gpu) => `${gpu.id}（SM ${gpu.computeCap.toFixed(1)}）`).join("、")} 不满足。`,
        `${requirement.who.en} needs SM ${requirement.value.toFixed(1)} or newer; GPU ${below.map((gpu) => `${gpu.id} (SM ${gpu.computeCap.toFixed(1)})`).join(", ")} does not qualify.`));
  }
  const cudaNeed = versionParts(release.minimumBlackwellCudaVersion);
  const cudaHave = versionParts(release.cudaVersion);
  const blackwell = gpus.filter((gpu) => gpu.computeCap !== null && gpu.computeCap >= 10);
  if (cudaNeed && cudaHave && blackwell.length && compareParts(cudaHave, cudaNeed) < 0) {
    addReason(row, "blackwell_cuda", "block",
      t(`GPU ${blackwell.map((gpu) => gpu.id).join("、")} 需要 CUDA ${release.minimumBlackwellCudaVersion}+，运行时声明 CUDA ${release.cudaVersion}。`,
        `GPU ${blackwell.map((gpu) => gpu.id).join(", ")} needs CUDA ${release.minimumBlackwellCudaVersion}+; the runtime declares CUDA ${release.cudaVersion}.`));
  }

  // R5: quantization method against the image's registry.
  const candidates = quantCandidates(facts);
  if (!moot && candidates.length && !facts.gguf && !isBnb(facts)) {
    const methods = Array.isArray(registries?.quantMethods) ? registries.quantMethods : null;
    if (methods) {
      const known = new Set(methods.map(normalizeKey));
      if (!candidates.some((name) => known.has(normalizeKey(name)))) {
        addReason(row, "quant_not_in_runtime", "block",
          t(`运行时 ${ref.runtimeId} 不支持量化方法 ${facts.method}${facts.algo ? `（${facts.quant.algo}）` : ""}。`,
            `Runtime ${ref.runtimeId} does not support the quantization method ${facts.method}.`), "/quant/method");
      }
    } else {
      const format = quantFormatOf(facts);
      if (!(format && formats.has(format))) {
        addReason(row, "quant_unverified", "unknown",
          t(`未获取运行时 ${ref.runtimeId} 的量化方法清单，无法确认支持 ${facts.method}。`,
            `The quantization methods of ${ref.runtimeId} are unknown, so ${facts.method} support cannot be confirmed.`), "/quant/method");
      }
    }
  }

  // R6: BitsAndBytes needs the out-of-tree plugin (facts first, then the manifest).
  if (!moot && isBnb(facts) && !facts.gguf) {
    const plugin = typeof registries?.plugins?.bnb === "boolean" ? registries.plugins.bnb
      : typeof release.bitsAndBytesPlugin === "boolean" ? release.bitsAndBytesPlugin : null;
    if (plugin === false) {
      addReason(row, "bitsandbytes_plugin_missing", "block",
        t(`运行时 ${ref.runtimeId} 的镜像不包含 BitsAndBytes 插件，BNB 权重无法启动。`,
          `The image of ${ref.runtimeId} has no BitsAndBytes plugin, so BNB weights cannot start.`), "/quant/method");
    } else if (plugin === null) {
      addReason(row, "bitsandbytes", "warn",
        t("BNB 加载依赖 BitsAndBytes 插件，请确认镜像已安装。", "BNB loading needs the BitsAndBytes plugin; confirm the image has it."), "/quant/method");
    }
  }

  // R7: hardware-emulated precisions.
  const caps = gpus.map((gpu) => gpu.computeCap).filter((cap) => cap !== null);
  const lowest = caps.length ? Math.min(...caps) : null;
  if (moot) {
    // no precision question when the weights cannot load
  } else if (lowest !== null && isNvfp4(facts) && lowest < 10) {
    addReason(row, "nvfp4_emulated", "warn",
      t(`NVFP4 权重在 SM ${lowest.toFixed(1)} 上走模拟路径（慢速回退）。`, `NVFP4 weights run emulated (slow fallback) on SM ${lowest.toFixed(1)}.`), "/quant/algo");
  } else if (lowest !== null && isFp8(facts) && lowest < 8.9) {
    addReason(row, "fp8_emulated", "warn",
      t(`FP8 权重在 SM ${lowest.toFixed(1)} 上走模拟路径（慢速回退）。`, `FP8 weights run emulated (slow fallback) on SM ${lowest.toFixed(1)}.`), "/quant/algo");
  }

  // R8-R10: architecture against the registry, remote code, Transformers version.
  const architectures = Array.isArray(registries?.architectures) ? new Set(registries.architectures.map((item) => String(item).toLowerCase())) : null;
  const archHit = architectures ? facts.architectures.find((name) => architectures.has(name.toLowerCase())) : null;
  const nativeGguf = facts.gguf && engineId === "llamacpp";
  if (moot) {
    // nothing to check against the registry
  } else if (archHit) {
    row.supportEvidence.push({ kind: "probe", ref: `registries/${ref.runtimeId}#${archHit}`, confidence: "detected" });
  } else if (facts.autoMap && !facts.gguf) {
    addReason(row, "needs_trust_remote_code", "warn",
      t("该模型需要 trust_remote_code（会执行仓库内的 Python 代码），请先审阅。", "This model needs trust_remote_code (it runs Python code from the repository); review it first."),
      "/customCode/autoMap");
  } else if (architectures && facts.architectures.length) {
    addReason(row, "arch_not_in_runtime", facts.gguf && !nativeGguf ? "unknown" : "block",
      t(`运行时 ${ref.runtimeId} 的架构清单里没有 ${facts.architectures.join("、")}。`,
        `Runtime ${ref.runtimeId} does not list the architecture ${facts.architectures.join(", ")}.`), facts.archPointer);
  }
  if (!moot && !archHit && !facts.gguf && engineId !== "llamacpp") {
    const runtimeTransformers = majorMinor(registries?.transformersVersion || release.transformersVersion);
    const cardTransformers = majorMinor(facts.identity.transformersVersion);
    if (runtimeTransformers && cardTransformers
      && (cardTransformers[0] > runtimeTransformers[0] || (cardTransformers[0] === runtimeTransformers[0] && cardTransformers[1] > runtimeTransformers[1]))) {
      addReason(row, "transformers_newer", "warn",
        t(`模型使用 Transformers ${facts.identity.transformersVersion} 保存，运行时只带 ${registries?.transformersVersion || release.transformersVersion}。`,
          `The model was saved with Transformers ${facts.identity.transformersVersion}; the runtime ships ${registries?.transformersVersion || release.transformersVersion}.`),
        "/identity/transformersVersion");
    }
  }

  // R11: fit preview on the selected GPUs and RAM.
  const preview = moot ? null : fitPreviewFor(card, engineId, shared.host, gpus, options, shared.fitCache);
  if (preview) {
    row.fitPreview = { ...preview.preview };
    if (!preview.preview.minimalFits) {
      addReason(row, "does_not_fit", "block",
        t("即使最大程度卸载到内存，所选 GPU 与内存也放不下该模型。", "The model does not fit the selected GPUs and RAM even with maximum offload."), "/weights/totalBytes");
    } else if (preview.preview.needsOffload) {
      addReason(row, "fits_with_offload", "warn",
        t("需要把部分权重卸载到内存才能放下，速度会下降。", "It fits only by offloading weights to RAM, which is slower."), "/weights/totalBytes");
    }
  }

  // R12: requested context against the native context (information only).
  const goal = Number(options.goal?.contextLength || 0);
  const native = Number(card.context?.native || 0);
  if (goal > 0 && native > 0 && goal > native) {
    addReason(row, "context_exceeds_native", "info",
      t(`请求的上下文 ${goal} 超过模型原生上下文 ${native}。`, `The requested context ${goal} exceeds the model's native context ${native}.`), "/context/native");
  }

  // R13: parser for the detected template in the image.
  if (!moot && !facts.gguf && engineId !== "llamacpp") parserWarnings(card, engineId, descriptor, runtimeFacts, row, knowledge);

  // Probe results for this (contentDigest, runtimeId).
  const probe = findProbe(card, row, options.probes);
  if (probe) {
    const verdict = probe.probe.verdict || (probe.probe.ok === true ? "supported" : "");
    if (verdict === "supported") {
      row.supportEvidence.push({ kind: "probe", ref: probe.key, confidence: "detected" });
    } else if (verdict === "unsupported") {
      addReason(row, "probe_unsupported", "block",
        t(`预检探针显示运行时 ${ref.runtimeId} 不支持该模型。`, `The dry probe shows runtime ${ref.runtimeId} does not support this model.`));
    } else if (verdict === "needs-remote-code" && !row.reasons.some((reason) => reason.code === "needs_trust_remote_code")) {
      addReason(row, "needs_trust_remote_code", "warn",
        t("预检探针显示需要 trust_remote_code。", "The dry probe shows trust_remote_code is needed."), "/customCode/autoMap");
    }
  }

  // Support evidence (section 9): host record, probe, registry hit, family.
  const hostEvidence = hostRecordEvidence(card, row, options.hostRecords);
  if (hostEvidence) row.supportEvidence.unshift(hostEvidence);
  const known = knowledgeEvidence(ctx);
  if (known) row.supportEvidence.push(known);

  if (!row.supportEvidence.length) {
    if (!match.entry || match.confidence === "name-heuristic") {
      const identity = facts.gguf ? facts.identity.ggufArchitecture : (facts.identity.modelType || facts.architectures[0]);
      addReason(row, "arch_not_in_knowledge", "unknown",
        match.entry
          ? t("只能按名称推断出模型家族（未验证），不算支持证据。", "The family is only inferred from the name (unverified), which is not support evidence.")
          : t(`${identity || "该架构"} 不在已验证的架构列表中。`, `${identity || "This architecture"} is not in the verified architecture list.`),
        facts.gguf ? "/identity/ggufArchitecture" : "/identity/modelType");
    } else if (!row.reasons.some((reason) => (LEVEL_RANK[reason.level] ?? 0) >= LEVEL_RANK.unknown)) {
      addReason(row, "support_unverified", "unknown",
        t(`${label.zh} 在 ${engineId} 上没有已验证或已文档化的支持记录。`, `${label.en} has no verified or documented support on ${engineId}.`));
    }
  }

  row.verdict = worst(row.reasons);
  if (row.verdict === "ok" && !row.supportEvidence.length) row.verdict = "unknown";
  if (row.verdict === "unknown") {
    row.actions.push(
      { kind: "probe", label: t("运行预检探针", "Run dry probe") },
      { kind: "override", label: t("为此模型覆盖", "Override for this model") },
    );
  }
  return row;
}

function externalRow(ref) {
  const row = createRow("external", ref.runtimeId || "external");
  addReason(row, "external_not_inspected", "unknown",
    t("外部端点上的模型不会被检查，无法判断兼容性。", "Models on external endpoints are not inspected, so compatibility is unknown."));
  row.verdict = "unknown";
  return row;
}

/**
 * evaluateCompatibility(card, {runtimes, runtimeFacts, descriptors, host,
 * knowledge, hostRecords, probes, env, goal, fit}) -> CompatibilityRow[]
 *
 * runtimes: runtime refs {engineId, runtimeId, version, status, release}
 * (default: the engine registry's runtimes). runtimeFacts: Map, object or
 * function runtimeId -> {flags, registries} | null. host: {gpus (the selected
 * GPUs), ramBytes, ramFreeBytes, platform}. hostRecords / probes: arrays,
 * Maps or functions. goal: {contextLength}. fit: estimateFit options.
 */
function evaluateCompatibility(card, options = {}) {
  if (!isPlainObject(card)) return [];
  const opts = isPlainObject(options) ? options : {};
  const { descriptors, runtimes } = registryDefaults(opts);
  const knowledge = opts.knowledge || knowledgeModule.loadKnowledge();
  const match = knowledgeModule.matchFamily(card, knowledge);
  const host = isPlainObject(opts.host) ? opts.host : {};
  const shared = {
    facts: cardFacts(card),
    match,
    family: match.entry,
    knowledge,
    options: opts,
    env: opts.env || process.env,
    host,
    platform: normalizePlatform(host.platform || process.platform),
    gpus: hostGpus(host),
    fitCache: new Map(),
  };
  const rows = [];
  for (const ref of runtimes) {
    const descriptor = descriptors.get(ref?.engineId);
    if (!descriptor || descriptor.id === "external") continue;
    rows.push(evaluateRow(card, ref, descriptor, shared));
  }
  if (descriptors.has("external")) {
    const external = runtimes.find((ref) => ref?.engineId === "external");
    rows.push(externalRow(external || {}));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// GGUF architecture lookup for llama-manager (P0-15)

/**
 * ggufArchitectureSupport(architecture, {knowledge}) -> the family whose
 * match.ggufArchitectures (families v2) lists the GGUF general.architecture,
 * with its llama.cpp section projected to the v1 view the llama-manager
 * checks read (supported, unsupportedReason, minimumBuild, speculative).
 * Declared identity only: no name heuristics. {family: null} when unlisted.
 */
function ggufArchitectureSupport(architecture, options = {}) {
  const arch = String(architecture || "").trim().toLowerCase();
  const none = { architecture: arch, family: null, id: "", label: "", matchedBy: "", llamacpp: null };
  if (!arch) return none;
  const knowledge = options.knowledge || knowledgeModule.loadKnowledge();
  const match = knowledgeModule.matchFamily({ identity: { ggufArchitecture: arch } }, knowledge);
  if (!match.entry) return none;
  const view = familyToV1Entry(match.entry);
  const clauses = match.matchedBy.filter((item) => item !== "ggufArchitectures");
  return {
    architecture: arch,
    family: match.entry,
    id: match.entry.id,
    label: view.label || match.entry.id,
    matchedBy: ["gguf", ...clauses].join("+"),
    llamacpp: view.llama || null,
  };
}

module.exports = {
  evaluateCompatibility,
  ggufArchitectureSupport,
  ROLE_TO_DESCRIPTOR,
};
