const path = require("node:path");

function cleanDownloadSource(value) {
  const source = String(value || "huggingface").toLowerCase();
  if (source === "huggingface" || source === "modelscope") return source;
  const error = new Error(`Unsupported download source: ${source}`);
  error.status = 400;
  throw error;
}

function normalizeRemoteQuantFilter(value) {
  const raw = String(value || "").trim();
  if (!raw || ["all", "any", "auto"].includes(raw.toLowerCase())) return "";
  if (/原始|BF16\/FP16/i.test(raw)) return "";
  const upper = raw.replace(/\s+/g, "_").replace(/-/g, "_").toUpperCase();
  const aliases = {
    BASE: "",
    QUANT: "quantized",
    QUANTIZED: "quantized",
    "4BIT": "INT4",
    BNB_4BIT: "BNB-4bit",
    BNB4BIT: "BNB-4bit",
    MODEL_OPT_FP4: "NVFP4",
    MODELOPT_FP4: "NVFP4",
    NVFP4_FP4: "NVFP4",
    FP4_NVFP4: "NVFP4",
    NVFP4_MTP: "NVFP4",
    MTP_NVFP4: "NVFP4",
    MXFP4_MTP: "MXFP4",
    MTP_MXFP4: "MXFP4",
    FP8_MTP: "FP8",
    MTP_FP8: "FP8",
    MTP_GGUF: "GGUF",
    GGUF_MTP: "GGUF",
    AWQ_INT4: "AWQ",
    GPTQ_INT4: "GPTQ",
    Q4KM: "Q4_K_M",
    Q5KM: "Q5_K_M",
    Q8: "Q8_0",
    IQ4XS: "IQ4_XS",
  };
  return Object.prototype.hasOwnProperty.call(aliases, upper) ? aliases[upper] : upper;
}

function normalizeDownloadModelReference(model, precision) {
  const raw = String(model || "").trim();
  const match = raw.match(/^([^:\s]+\/[^:\s]+):([A-Za-z0-9_.+-]+)$/);
  if (!match) {
    return { model: raw, precision: normalizeRemoteQuantFilter(precision) };
  }
  return {
    model: match[1],
    precision: normalizeRemoteQuantFilter(precision) || normalizeRemoteQuantFilter(match[2]),
  };
}

function buildDownloadIncludePatterns(precision) {
  const value = normalizeRemoteQuantFilter(precision);
  if (!value || value === "quantized") return [];
  if (value === "GGUF") return ["*.gguf"];
  if (value === "Q4") return ["*Q4*.gguf", "*IQ4*.gguf"];
  if (value === "IQ4") return ["*IQ4*.gguf"];
  if (/^I?Q[2-8](?:_[A-Z0-9]+)*$/.test(value)) return [`*${value}*.gguf`];
  return [];
}

function matchesDownloadPrecisionFile(filename, precision) {
  const name = String(filename || "");
  const normalizedName = name.replace(/[-.\s]+/g, "_").toUpperCase();
  const value = normalizeRemoteQuantFilter(precision);
  if (!value) return true;
  if (value === "GGUF") return name.toLowerCase().endsWith(".gguf");
  if (value === "Q4") return name.toLowerCase().endsWith(".gguf") && /(^|_)I?Q4/.test(normalizedName);
  if (value === "IQ4") return name.toLowerCase().endsWith(".gguf") && /(^|_)IQ4/.test(normalizedName);
  return name.toLowerCase().endsWith(".gguf") && normalizedName.includes(value);
}

function filterDownloadSiblings(siblings, precision) {
  const includePatterns = buildDownloadIncludePatterns(precision);
  if (!includePatterns.length) return siblings;
  const matched = siblings.filter((file) => matchesDownloadPrecisionFile(file.rfilename, precision));
  return matched.length ? matched : siblings;
}

function buildDownloadEnv(hfCache, env = process.env) {
  return {
    ...env,
    HF_HOME: hfCache,
    HUGGINGFACE_HUB_CACHE: path.join(hfCache, "hub"),
    MODELSCOPE_CACHE: path.join(hfCache, "modelscope"),
  };
}

function createDownloadCommandBuilder(options = {}) {
  const {
    hfCli,
    modelScopeCli,
    hfCache,
    modelsRoot,
    env = process.env,
    cleanRequired = (value, name) => {
      const text = String(value || "").trim();
      if (!text) throw new Error(`${name} is required`);
      return text;
    },
    resolveModelPath = (value) => value,
    safeOutputName = (value) => String(value || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_"),
  } = options;

  function buildConfiguredDownloadCommand(source, model, localDir, commandOptions = {}) {
    return buildDownloadCommand({
      source,
      model,
      localDir,
      precision: commandOptions.precision,
      hfCli,
      modelScopeCli,
    });
  }

  function buildDownloadSpecFromJob(job) {
    const meta = job.meta || {};
    const model = cleanRequired(meta.model, "model");
    const source = cleanDownloadSource(meta.source || "huggingface");
    const precision = String(meta.precision || "");
    const outputName = safeOutputName(meta.outputName || model.replace(/[\\/]/g, "__"));
    const localDir = resolveModelPath(meta.localDir || path.join(modelsRoot, outputName));
    const download = buildConfiguredDownloadCommand(source, model, localDir, { precision });
    return {
      command: download.command,
      args: download.args,
      options: {
        env: buildDownloadEnv(hfCache, env),
        title: job.title || `Download ${model} (${download.label})`,
        meta: {
          ...meta,
          model,
          source,
          precision,
          outputName,
          localDir,
        },
        progressDir: localDir,
        expectedBytes: meta.expectedBytes || null,
        countExistingProgress: true,
      },
    };
  }

  return {
    buildDownloadCommand: buildConfiguredDownloadCommand,
    buildDownloadSpecFromJob,
  };
}

function buildDownloadCommand({ source, model, localDir, precision, hfCli, modelScopeCli }) {
  if (source === "modelscope") {
    return {
      command: modelScopeCli,
      args: ["download", "--model", model, "--local_dir", localDir],
      label: "ModelScope",
    };
  }
  const includePatterns = buildDownloadIncludePatterns(precision);
  const includeArgs = includePatterns.flatMap((pattern) => ["--include", pattern]);
  return {
    command: hfCli,
    args: ["download", model, ...includeArgs, "--local-dir", localDir],
    label: "Hugging Face",
    includePatterns,
  };
}

module.exports = {
  cleanDownloadSource,
  normalizeRemoteQuantFilter,
  normalizeDownloadModelReference,
  buildDownloadIncludePatterns,
  matchesDownloadPrecisionFile,
  filterDownloadSiblings,
  buildDownloadEnv,
  createDownloadCommandBuilder,
  buildDownloadCommand,
};
