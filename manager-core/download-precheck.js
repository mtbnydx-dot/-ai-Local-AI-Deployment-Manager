"use strict";

// Pre-download compatibility check. Compatibility used to be decided at launch
// time, after the weights were already on disk; this runs the same policy
// (capability matrix + runtime manifest + GPU probe) on the remote repository
// metadata that the size estimate already fetches, so a blocked checkpoint is
// refused before a download job exists.

const matrix = require("./model-capability-matrix");
const { getRuntimeRelease } = require("./runtime-manifest");

const SEVERITY_RANK = { ok: 0, info: 1, warn: 2, block: 3 };
const SHARD_PATTERN = /-(\d{5})-of-(\d{5})\.gguf$/i;

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

function assessDownloadCompatibility(input = {}) {
  const engine = String(input.engine || "vllm").toLowerCase() === "llama" ? "llama" : "vllm";
  const model = String(input.model || "").trim();
  const config = input.config && typeof input.config === "object" ? input.config : null;
  const files = normalizeSiblings(input.siblings);
  const format = describeFormat(files);
  const runtime = input.runtime || getRuntimeRelease(engine === "llama" ? "llama" : "vllm") || {};
  const gpu = input.gpu || null;
  const findings = [];

  const ggufArchitecture = String(input.ggufArchitecture || "").trim().toLowerCase();
  const capability = matrix.resolveModelCapabilityEntry({ model, config: config || {}, ggufArchitecture });
  const quantMethod = quantizationFromConfig(config) || (config ? "" : quantizationFromName(model));
  const engineCapabilities = capability.entry ? matrix.resolveEngineCapabilities(capability.entry, engine, { quantMethod, model }) : null;

  if (!config && !ggufArchitecture) {
    findings.push(finding("info", "identity_unknown", "未读取到 config.json", capability.entry
      ? `按仓库名推断为 ${capability.label}；下载后会用 config.json / GGUF 元数据重新判定。`
      : "无法从远端读取 config.json，架构与解析器将在下载后按本地文件判定。"));
  } else if (capability.entry) {
    findings.push(finding("ok", "identity", "架构识别", `${capability.label}（${capability.matchedBy === "name" ? "按名称推断" : "按声明识别"}，矩阵置信度：${capability.confidence}）。`));
  } else {
    findings.push(finding("info", "identity_unlisted", "能力矩阵未收录", `${matrix.configIdentity(config || {}).architectures[0] || ggufArchitecture || "未知架构"}：不会自动填写 parser 或推测解码；启动前请核对引擎文档。`));
  }

  if (capability.entry?.download?.level && capability.entry.download.level !== "ok") {
    findings.push(finding(capability.entry.download.level, "matrix_download_rule", capability.label, capability.entry.download.reason || ""));
  }
  if (engineCapabilities?.supported === false) {
    findings.push(finding("block", engineCapabilities.unsupportedCode || "engine_unsupported", `${engine === "llama" ? "llama.cpp" : "vLLM"} 不支持`, engineCapabilities.unsupportedReason || `${capability.label} 无法在该引擎启动。`));
  }

  if (/^(?:bitsandbytes|bnb)(?:$|[_-])/.test(quantMethod)) {
    if (engine === "llama") {
      findings.push(finding("block", "bitsandbytes_not_gguf", "BitsAndBytes 权重", "llama.cpp 只能加载 GGUF；BNB 4bit 权重无法直接运行，请选择该模型的 GGUF 仓库。"));
    } else if (runtime.bitsAndBytesPlugin === false) {
      findings.push(finding("block", "bitsandbytes_plugin_missing", "BitsAndBytes 权重被阻断", `当前 vLLM ${runtime.version || ""} 镜像不包含 vllm-bnb-plugin，BNB checkpoint 启动会失败。请改用 FP8 / NVFP4 / AWQ / GPTQ 或原始精度仓库。`));
    } else {
      findings.push(finding("warn", "bitsandbytes", "BitsAndBytes 权重", "BNB 加载依赖 vllm-bnb-plugin，请确认镜像已安装。"));
    }
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

  if (engine === "vllm" && (config?.auto_map || engineCapabilities?.forceTrustRemoteCode)) {
    findings.push(finding("info", "trust_remote_code", "需要 trust_remote_code", "该模型带自定义建模代码，启动时会自动开启 trust-remote-code。"));
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

  const requiredCompute = Number(capability.entry?.requires?.minimumComputeCapability || 0);
  const gpuCompute = Number(gpu?.computeCap || gpu?.computeCapability || gpu?.gpus?.[0]?.computeCap || 0);
  if (requiredCompute && gpuCompute && gpuCompute < requiredCompute) {
    findings.push(finding("block", "compute_capability", "GPU 架构不满足", `${capability.label} 需要 SM ${requiredCompute.toFixed(1)} 或更新，当前 GPU 为 SM ${gpuCompute.toFixed(1)}。`));
  }
  if (gpuCompute >= 10 && runtime.cudaVersion && runtime.minimumBlackwellCudaVersion
    && compareVersionStrings(runtime.cudaVersion, runtime.minimumBlackwellCudaVersion) < 0) {
    findings.push(finding("block", "blackwell_cuda", "运行时 CUDA 过旧", `SM ${gpuCompute} 需要 CUDA ${runtime.minimumBlackwellCudaVersion}+，当前运行时声明 CUDA ${runtime.cudaVersion}。`));
  }

  const bytes = Number(input.bytes || 0);
  const totalMb = Number(gpu?.totalMb || 0);
  if (bytes > 0 && totalMb > 0) {
    const weightMb = bytes / (1024 * 1024);
    if (weightMb > totalMb * 0.95) {
      findings.push(finding("warn", "vram_exceeded", "权重体积超过显存", engine === "llama"
        ? `权重约 ${(weightMb / 1024).toFixed(1)} GB，显存 ${(totalMb / 1024).toFixed(0)} GB：需要把部分层放到 CPU，或选择更小的量化。`
        : `权重约 ${(weightMb / 1024).toFixed(1)} GB，显存 ${(totalMb / 1024).toFixed(0)} GB：需要 CPU offload 或更低精度的量化仓库。`));
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
      confidence: capability.confidence,
    },
    findings,
  };
}

module.exports = {
  assessDownloadCompatibility,
  quantizationFromConfig,
  quantizationFromName,
};
