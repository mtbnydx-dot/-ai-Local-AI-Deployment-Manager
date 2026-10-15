"use strict";

// Pre-download compatibility check. Compatibility used to be decided at launch
// time, after the weights were already on disk; this runs the same policy
// (capability matrix + runtime manifest + GPU probe) on the remote repository
// metadata that the size estimate already fetches, so a blocked checkpoint is
// refused before a download job exists.

const matrix = require("./model-capability-matrix");
const { getRuntimeRelease } = require("./runtime-manifest");
const knowledgeModule = require("./model-inspector/knowledge");
const { evaluateCompatibility } = require("./model-inspector/compatibility");

const SEVERITY_RANK = { ok: 0, info: 1, warn: 2, block: 3 };
const SHARD_PATTERN = /-(\d{5})-of-(\d{5})\.gguf$/i;
// zh source strings; the UI translates them through shared-public/js/i18n-common.js
// ("Inferred from the name (unverified)", "Enable trust-remote-code in the
// launch options (this runs Python code from the repository).").
const NAME_INFERRED_CONFIDENCE = "按名称推断（未验证）";
const TRUST_REMOTE_CODE_DETAIL = "需要在启动参数中勾选 trust-remote-code（会执行仓库内的 Python 代码）。";

function finding(severity, code, title, detail, extra = {}) {
  return { severity, code, title, detail, ...extra };
}

function maxSeverity(findings) {
  return findings.reduce((current, item) => (SEVERITY_RANK[item.severity] > SEVERITY_RANK[current] ? item.severity : current), "ok");
}

function normalizeSiblings(siblings) {
  return (Array.isArray(siblings) ? siblings : [])
    .map((item) => ({
      name: String(item?.name || item?.rfilename || "").trim(),
      size: Number(item?.size || item?.lfs?.size || 0) || 0,
    }))
    .filter((item) => item.name);
}

function describeFormat(files) {
  const lower = files.map((file) => file.name.toLowerCase());
  return {
    hasGguf: lower.some((name) => name.endsWith(".gguf")),
    hasSafetensors: lower.some((name) => name.endsWith(".safetensors")),
    hasPytorchBin: lower.some((name) => /\.(bin|pt|pth)$/.test(name)),
    hasConfig: lower.includes("config.json"),
    hasTokenizer: lower.some((name) => /^tokenizer(?:\.json|_config\.json|\.model)$/.test(name)),
    ggufFiles: files.filter((file) => file.name.toLowerCase().endsWith(".gguf")),
  };
}

function quantizationFromConfig(config = {}) {
  const quant = config?.quantization_config || {};
  return String(quant.quant_method || quant.quant_algo || quant.method || "").trim().toLowerCase();
}

function quantizationFromName(model = "") {
  const text = String(model || "").toLowerCase();
  if (/bnb|bitsandbytes/.test(text)) return "bitsandbytes";
  if (/nvfp4|modelopt/.test(text)) return "modelopt_fp4";
  if (/mxfp4/.test(text)) return "mxfp4";
  if (/fp8/.test(text)) return "fp8";
  if (/awq/.test(text)) return "awq";
  if (/gptq/.test(text)) return "gptq";
  return "";
}

function compareVersionStrings(left, right) {
  const parse = (value) => (String(value || "").match(/\d+(?:\.\d+)*/)?.[0] || "").split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function precisionGgufFiles(ggufFiles, precision) {
  const value = String(precision || "").replace(/[-.\s]+/g, "_").toUpperCase();
  if (!value || value === "GGUF" || value === "QUANTIZED") return ggufFiles;
  return ggufFiles.filter((file) => file.name.replace(/[-.\s]+/g, "_").toUpperCase().includes(value));
}

const ENGINE_IDS = Object.freeze({ llama: "llamacpp", vllm: "vllm" });
// Row reasons that become findings, with the finding title. Everything else a
// row says is either a legacy finding already (formats, blocked families,
// trust_remote_code, VRAM) or not a download-time matter.
const ROW_FINDINGS = Object.freeze({
  compute_capability: "GPU 架构不满足",
  compute_capability_runtime: "运行时不支持该 GPU",
  blackwell_cuda: "运行时 CUDA 过旧",
  bitsandbytes_plugin_missing: "BitsAndBytes 权重被阻断",
  bitsandbytes: "BitsAndBytes 权重",
  quant_not_in_runtime: "运行时不支持该量化",
  nvfp4_emulated: "NVFP4 将走慢速回退",
  fp8_emulated: "FP8 将走慢速回退",
  arch_not_in_runtime: "运行时不认识该架构",
  transformers_newer: "Transformers 版本偏新",
  runtime_below_minimum: "运行时版本过旧",
  diffusion_gemma_windows: "DiffusionGemma 在 Windows 下被阻断",
});

function normalizeEngine(value) {
  return ["llama", "llamacpp", "llama.cpp"].includes(String(value || "").toLowerCase()) ? "llama" : "vllm";
}

function gpuList(input) {
  const source = Array.isArray(input.gpus) && input.gpus.length ? input.gpus
    : Array.isArray(input.gpu?.gpus) ? input.gpu.gpus
      : input.gpu ? [input.gpu] : [];
  return source.filter((item) => item && typeof item === "object").map((item, index) => ({
    id: String(item.id ?? item.index ?? index),
    computeCap: item.computeCap ?? item.computeCapability ?? null,
    totalMb: Number(item.totalMb || 0) || 0,
  }));
}

function versionKey(value) {
  return String(value || "").trim().toLowerCase().replace(/^v/, "");
}

// Every runtime of the engine: the one the caller names (a manifest release or
// a runtime ref) plus the registry's, so a checkpoint is judged against all of
// them and refused only when none can run it. Retired runtimes are left out.
function runtimeRefs(input, engine, engineId) {
  const named = Array.isArray(input.runtimes) ? input.runtimes : input.runtime ? [input.runtime] : [];
  const refs = [];
  const add = (ref) => {
    if (refs.some((other) => other.runtimeId === ref.runtimeId || (ref.version && versionKey(other.version) === versionKey(ref.version)))) return;
    refs.push(ref);
  };
  for (const item of named) {
    if (!item || typeof item !== "object") continue;
    if (item.runtimeId && item.engineId) {
      add(item);
      continue;
    }
    const version = String(item.version || item.compatVersion || "");
    add({ engineId, runtimeId: item.runtimeId || `${engineId}@${versionKey(version) || "custom"}`, version, status: item.status || "pinned", release: item });
  }
  if (!Array.isArray(input.runtimes)) {
    try {
      for (const ref of require("./engines/registry").getEngineRegistry().runtimesFor(engineId)) {
        if (ref.status !== "retired") add(ref);
      }
    } catch {
      // The registry is optional here; the named runtime alone is judged.
    }
  }
  if (!refs.length) {
    const release = getRuntimeRelease(engine === "llama" ? "llama" : "vllm") || {};
    add({ engineId, runtimeId: `${engineId}@${versionKey(release.version) || "default"}`, version: String(release.version || ""), status: "pinned", release });
  }
  return refs;
}

function nestedConfigs(config) {
  return [config?.text_config, config?.language_config, config?.llm_config].filter((item) => item && typeof item === "object");
}

function cardQuant(quantMethod, config) {
  const algo = String(config?.quantization_config?.quant_algo || "").trim();
  const lower = quantMethod.toLowerCase();
  if (/^(?:modelopt_fp4|nvfp4)$/.test(lower)) return { method: "modelopt", algo: "NVFP4" };
  if (lower === "modelopt") return { method: "modelopt", algo: algo.toUpperCase() };
  if (lower === "fp8") return { method: "fp8", algo: "FP8" };
  if (lower === "bnb") return { method: "bitsandbytes", algo: "" };
  return { method: lower || "none", algo };
}

// The pre-download ModelCard-shaped facts the matrix rules read: what the
// remote config.json and the file list declare, with no template, topology
// or weight arithmetic (those arrive with a real remote card via input.card).
function liteCard({ model, config, files, format, ggufArchitecture, quantMethod }) {
  const nested = nestedConfigs(config);
  const architectures = [config, ...nested].flatMap((item) => (Array.isArray(item?.architectures) ? item.architectures : [])).map(String);
  let kind = "";
  if (format.hasGguf && (format.hasSafetensors || format.hasPytorchBin)) kind = "mixed";
  else if (format.hasGguf) kind = "gguf";
  else if (format.hasSafetensors) kind = "safetensors";
  else if (format.hasPytorchBin) kind = "pytorch-bin";
  const hiddenSize = [config, ...nested].map((item) => item?.hidden_size).find((value) => Number.isFinite(value));
  const autoMap = config?.auto_map && typeof config.auto_map === "object" ? config.auto_map : null;
  return {
    schema: "modelcard/v1",
    cardId: null,
    contentDigest: null,
    ref: { kind: "hf", repo: model },
    format: kind ? { kind, weightFiles: files.length } : {},
    role: { value: "main", runnable: true },
    identity: {
      modelType: config?.model_type || null,
      textModelType: nested.map((item) => item.model_type).find(Boolean) || null,
      architectures,
      ggufArchitecture: ggufArchitecture || null,
      transformersVersion: config?.transformers_version || null,
      displayName: String(model || "").split("/").pop() || null,
    },
    topology: { hiddenSize: hiddenSize ?? null },
    quant: cardQuant(quantMethod, config),
    template: {},
    customCode: { autoMap, files: [], trustRemoteCodeRequired: Boolean(autoMap) },
  };
}

// One finding per row reason code, judged across all runtimes of the engine:
// block only when every runtime blocks it, otherwise warn and name the
// runtimes that do.
function rowFindings(rows) {
  const groups = new Map();
  for (const row of rows) {
    for (const reason of row.reasons) {
      if (!ROW_FINDINGS[reason.code] || !["warn", "block"].includes(reason.level)) continue;
      if (!groups.has(reason.code)) groups.set(reason.code, []);
      groups.get(reason.code).push({ row, reason });
    }
  }
  const findings = [];
  for (const [code, hits] of groups) {
    const blocked = hits.filter((hit) => hit.reason.level === "block");
    const everywhere = blocked.length === rows.length;
    const severity = blocked.length && everywhere ? "block" : "warn";
    const runtimes = [...new Set(hits.map((hit) => hit.row.runtimeId))];
    const suffix = blocked.length && !everywhere
      ? `（仅在 ${runtimes.join("、")} 上被阻断，其他运行时可以使用）`
      : rows.length > 1 && runtimes.length < rows.length ? `（运行时：${runtimes.join("、")}）` : "";
    findings.push(finding(severity, code, ROW_FINDINGS[code], `${hits[0].reason.message.zh}${suffix}`, { runtimes }));
  }
  return findings;
}

function assessDownloadCompatibility(input = {}) {
  const engine = normalizeEngine(input.engine);
  const engineId = ENGINE_IDS[engine];
  const model = String(input.model || "").trim();
  const remoteCard = input.card && typeof input.card === "object" ? input.card : null;
  const cardIdentity = remoteCard?.identity || {};
  // A real remote card (inspectRemote) stands in for config.json when the
  // caller has no config of its own.
  const config = input.config && typeof input.config === "object" ? input.config
    : remoteCard && (cardIdentity.modelType || cardIdentity.architectures?.length)
      ? { model_type: cardIdentity.modelType || undefined, architectures: cardIdentity.architectures || undefined }
      : null;
  const files = normalizeSiblings(Array.isArray(input.siblings) && input.siblings.length ? input.siblings : remoteCard?.remote?.siblings);
  const format = describeFormat(files);
  const runtimes = runtimeRefs(input, engine, engineId);
  const gpus = gpuList(input);
  const findings = [];

  const ggufArchitecture = String(input.ggufArchitecture || cardIdentity.ggufArchitecture || "").trim().toLowerCase();
  // Declared identity first: the repository name is consulted only when the
  // config and the GGUF header declare nothing (02 section 8.2).
  const declared = matrix.configIdentity(config || {});
  const hasDeclaredIdentity = Boolean(declared.modelTypes.length || declared.architectures.length || ggufArchitecture);
  const capability = matrix.resolveModelCapabilityEntry({ model, config: config || {}, ggufArchitecture, allowNameFallback: !hasDeclaredIdentity });
  const cardMethod = remoteCard?.quant?.method && remoteCard.quant.method !== "none" ? String(remoteCard.quant.method).toLowerCase() : "";
  const quantMethod = quantizationFromConfig(config) || cardMethod || (config ? "" : quantizationFromName(model));
  const engineCapabilities = capability.entry ? matrix.resolveEngineCapabilities(capability.entry, engine, { quantMethod, model }) : null;

  const card = remoteCard || liteCard({ model, config, files, format, ggufArchitecture, quantMethod });
  let descriptor = null;
  try {
    descriptor = require("./engines/registry").getEngineRegistry().get(engineId);
  } catch {
    descriptor = null;
  }
  const rows = descriptor
    ? evaluateCompatibility(card, {
      descriptors: [descriptor],
      runtimes,
      runtimeFacts: input.runtimeFacts,
      host: { gpus, platform: input.platform },
      env: input.env,
    })
    : [];
  // The fact confidence of the identity match: a name match is a heuristic,
  // never the knowledge entry's own (matrix) confidence.
  const matched = capability.entry ? knowledgeModule.matchFamily(card, knowledgeModule.loadKnowledge()) : null;
  const factConfidence = !capability.entry ? ""
    : capability.matchedBy === "name" ? "name-heuristic"
      : matched?.entry && matched.confidence && matched.confidence !== "name-heuristic" ? matched.confidence : "declared";

  if (!config && !ggufArchitecture) {
    findings.push(finding("info", "identity_unknown", "未读取到 config.json", capability.entry
      ? `按仓库名推断为 ${capability.label}；下载后会用 config.json / GGUF 元数据重新判定。`
      : "无法从远端读取 config.json，架构与解析器将在下载后按本地文件判定。"));
  } else if (capability.entry) {
    // A name match proves nothing about the checkpoint, so it never borrows the
    // matrix entry's confidence.
    findings.push(finding("ok", "identity", "架构识别", capability.matchedBy === "name"
      ? `${capability.label}，置信度：${NAME_INFERRED_CONFIDENCE}。`
      : `${capability.label}（按声明识别，矩阵置信度：${capability.confidence}）。`));
  } else {
    // Unlisted is unknown, never compatible (00 section 4.4): a warning, not a note.
    findings.push(finding("warn", "identity_unlisted", "能力矩阵未收录", `${matrix.configIdentity(config || {}).architectures[0] || ggufArchitecture || "未知架构"}：不会自动填写 parser 或推测解码；启动前请核对引擎文档。`));
  }

  if (capability.entry?.download?.level && capability.entry.download.level !== "ok") {
    findings.push(finding(capability.entry.download.level, "matrix_download_rule", capability.label, capability.entry.download.reason || ""));
  }
  if (engineCapabilities?.supported === false) {
    findings.push(finding("block", engineCapabilities.unsupportedCode || "engine_unsupported", `${engine === "llama" ? "llama.cpp" : "vLLM"} 不支持`, engineCapabilities.unsupportedReason || `${capability.label} 无法在该引擎启动。`));
  }

  if (/^(?:bitsandbytes|bnb)(?:$|[_-])/.test(quantMethod) && engine === "llama") {
    findings.push(finding("block", "bitsandbytes_not_gguf", "BitsAndBytes 权重", "llama.cpp 只能加载 GGUF；BNB 4bit 权重无法直接运行，请选择该模型的 GGUF 仓库。"));
  }

  if (files.length) {
    if (engine === "llama" && !format.hasGguf) {
      findings.push(finding("block", "llama_requires_gguf", "仓库没有 GGUF 文件", "llama.cpp 需要 GGUF 权重；请选择同模型的 GGUF 仓库（例如 unsloth / bartowski 发布）。"));
    }
    if (engine === "vllm" && format.hasGguf && !format.hasSafetensors && !format.hasPytorchBin) {
      const selected = precisionGgufFiles(format.ggufFiles, input.precision);
      const mainFiles = selected.filter((file) => !/mmproj|draft|dflash|eagle/i.test(file.name));
      const sharded = mainFiles.some((file) => SHARD_PATTERN.test(file.name));
      if (sharded && mainFiles.length > 1) {
        findings.push(finding("block", "vllm_gguf_sharded", "多分片 GGUF", "vLLM 只支持单文件 GGUF；这个量化被切成多个分片，请改用 llama.cpp 管理器，或选择单文件量化。"));
      } else {
        findings.push(finding("warn", "vllm_gguf_experimental", "GGUF 仓库", "vLLM 的 GGUF 支持是实验性的，还需要原始模型的 tokenizer/config。通常在 llama.cpp 上运行更稳。"));
      }
    }
    if (engine === "vllm" && !format.hasConfig && !format.hasGguf) {
      findings.push(finding("warn", "missing_config", "缺少 config.json", "仓库里没有 config.json，vLLM 无法识别模型结构。"));
    }
  }

  // Launch only enables trust-remote-code from the checkbox or a preset; this
  // finding must not promise that it happens on its own.
  if (engine === "vllm" && (config?.auto_map || engineCapabilities?.forceTrustRemoteCode)) {
    findings.push(finding("info", "trust_remote_code", "需要 trust_remote_code", TRUST_REMOTE_CODE_DETAIL));
  }
  if (engineCapabilities?.requiredPluginFile) {
    const present = files.some((file) => file.name.toLowerCase().endsWith(engineCapabilities.requiredPluginFile.toLowerCase()));
    findings.push(finding(present ? "ok" : "warn", "plugin_file", `需要 ${engineCapabilities.requiredPluginFile}`, present
      ? "仓库自带解析器插件，下载后即可使用。"
      : "仓库里没有这个解析器插件文件，下载后需要手动放进模型目录。"));
  }
  if (engineCapabilities?.image) {
    const runtimeEntry = getRuntimeRelease(engineCapabilities.image);
    findings.push(finding("info", "special_runtime", "专用运行时", `${capability.label} 会使用 ${runtimeEntry?.label || engineCapabilities.image}${runtimeEntry?.localBuild ? "（本地构建镜像，缺失时可用 " + (runtimeEntry.build?.script || "重建脚本") + " 重建）" : ""}。`));
  }

  // Compute capability, BitsAndBytes plugin, Blackwell CUDA, quantization and
  // architecture checks come from the matrix rows: every runtime of the engine,
  // every selected GPU.
  findings.push(...rowFindings(rows));

  const bytes = Number(input.bytes || 0);
  const totalMb = gpus.reduce((sum, item) => sum + item.totalMb, 0);
  if (bytes > 0 && totalMb > 0) {
    const weightMb = bytes / (1024 * 1024);
    const where = gpus.length > 1 ? `${gpus.length} 张 GPU 合计 ${(totalMb / 1024).toFixed(0)} GB` : `显存 ${(totalMb / 1024).toFixed(0)} GB`;
    if (weightMb > totalMb * 0.95) {
      findings.push(finding("warn", "vram_exceeded", "权重体积超过显存", engine === "llama"
        ? `权重约 ${(weightMb / 1024).toFixed(1)} GB，${where}：需要把部分层放到 CPU，或选择更小的量化。`
        : `权重约 ${(weightMb / 1024).toFixed(1)} GB，${where}：需要 CPU offload 或更低精度的量化仓库。`));
    } else if (weightMb > totalMb * 0.8) {
      findings.push(finding("info", "vram_tight", "显存偏紧", `权重约 ${(weightMb / 1024).toFixed(1)} GB，留给 KV cache 的显存有限，上下文需要保守设置。`));
    }
  }

  if (capability.entry?.contextMax) {
    findings.push(finding("info", "context_max", "上下文上限", `该架构验证过的最大上下文为 ${Number(capability.entry.contextMax).toLocaleString("en-US")} tokens。`));
  }
  if (input.gated) {
    findings.push(finding("info", "gated", "需要 Hugging Face 授权", "仓库为 gated，下载前需要本机已登录并接受条款。"));
  }

  const level = maxSeverity(findings);
  return {
    ok: level !== "block",
    level,
    engine,
    model,
    quantMethod,
    format: {
      hasGguf: format.hasGguf,
      hasSafetensors: format.hasSafetensors,
      hasConfig: format.hasConfig,
      fileCount: files.length,
    },
    capability: {
      id: capability.id,
      label: capability.label,
      matchedBy: capability.matchedBy,
      heuristic: capability.heuristic,
      // The fact confidence (declared, detected, name-heuristic); the knowledge
      // entry's own confidence is reported separately.
      confidence: factConfidence,
      knowledgeConfidence: capability.confidence,
    },
    runtimes: runtimes.map((ref) => ref.runtimeId),
    findings,
  };
}

module.exports = {
  assessDownloadCompatibility,
  quantizationFromConfig,
  quantizationFromName,
};
