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

const SAFETENSORS_QUANT_VALUES = new Set(["FP8", "AWQ", "GPTQ", "NVFP4", "MXFP4"]);

function modelReferenceDeclaresPrecision(model, precision) {
  const value = normalizeRemoteQuantFilter(precision);
  if (!SAFETENSORS_QUANT_VALUES.has(value)) return false;
  const repoName = String(model || "").trim().split("/").pop() || "";
  const tokens = repoName.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  return tokens.includes(value);
}

function buildDownloadIncludePatterns(precision, model = "") {
  const value = normalizeRemoteQuantFilter(precision);
  if (!value || value === "quantized") return [];
  if (value === "GGUF") return ["*.gguf"];
  if (value === "Q4") return ["*Q4*.gguf", "*IQ4*.gguf"];
  if (value === "IQ4") return ["*IQ4*.gguf"];
  if (/^I?Q[2-8](?:_[A-Z0-9]+)*$/.test(value)) return [`*${value}*.gguf`];
  if (SAFETENSORS_QUANT_VALUES.has(value)) {
    // Dedicated quantized repositories usually keep generic shard names such as
    // model-00001-of-00007.safetensors. Filtering those shards by "FP8"/"AWQ"
    // would silently exclude every weight file, so download the full repository.
    if (modelReferenceDeclaresPrecision(model, value)) return [];
    return [
      `*${value}*.safetensors`,
      `*${value.toLowerCase()}*.safetensors`,
      "*.json",
      "*.txt",
      "*.jinja",
      "tokenizer*",
      "config*",
      "generation*",
      "preprocessor*",
      "special_tokens*",
    ];
  }
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
  if (SAFETENSORS_QUANT_VALUES.has(value)) {
    const base = path.basename(name);
    const isSidecar = /\.(json|txt|jinja|model)$/i.test(name)
      || /^(tokenizer|config|generation|preprocessor|special_tokens|chat_template)/i.test(base);
    if (isSidecar) return true;
    return /\.(safetensors|bin)$/i.test(name) && normalizedName.includes(value);
  }
  return name.toLowerCase().endsWith(".gguf") && normalizedName.includes(value);
}

function filterDownloadSiblings(siblings, precision, model = "") {
  const includePatterns = buildDownloadIncludePatterns(precision, model);
  if (!includePatterns.length) return siblings;
  return siblings.filter((file) => matchesDownloadPrecisionFile(file.rfilename, precision));
}

function selectDownloadSiblings(siblings, precision, model = "") {
  const includePatterns = buildDownloadIncludePatterns(precision, model);
  const files = Array.isArray(siblings) ? siblings : [];
  if (!includePatterns.length) {
    return {
      siblings: files,
      includePatterns,
      filtered: false,
      matched: files.length,
      total: files.length,
    };
  }
  const matched = files.filter((file) => matchesDownloadPrecisionFile(file.rfilename, precision));
  return {
    siblings: matched,
    includePatterns,
    filtered: true,
    matched: matched.length,
    total: files.length,
  };
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];
const PYTHON_DIRECT_DNS_PATH = path.join(__dirname, "python-direct-dns");

function buildDownloadEnv(hfCache, env = process.env, options = {}) {
  const downloadEnv = {
    ...env,
    HF_HOME: hfCache,
    HUGGINGFACE_HUB_CACHE: path.join(hfCache, "hub"),
    MODELSCOPE_CACHE: path.join(hfCache, "modelscope"),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    NO_COLOR: "1",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "0",
    TERM: "dumb",
    HF_HUB_DISABLE_PROGRESS_BARS: "1",
    TQDM_DISABLE: "1",
  };
  if (options.source === "modelscope") {
    for (const key of PROXY_ENV_KEYS) delete downloadEnv[key];
    downloadEnv.NO_PROXY = "*";
    downloadEnv.no_proxy = "*";
    downloadEnv.MODELSCOPE_DIRECT_DNS = "1";
    downloadEnv.MODELSCOPE_DIRECT_DNS_SERVERS = downloadEnv.MODELSCOPE_DIRECT_DNS_SERVERS || "223.5.5.5,119.29.29.29,1.1.1.1";
    downloadEnv.PYTHONPATH = [PYTHON_DIRECT_DNS_PATH, downloadEnv.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }
  if (options.hfMirror) {
    downloadEnv.HF_ENDPOINT = options.hfEndpoint || "https://hf-mirror.com";
  }
  if (options.hfTransfer) {
    // huggingface_hub 1.x uses Xet for large files; hf_transfer is deprecated.
    downloadEnv.HF_XET_HIGH_PERFORMANCE = "1";
  }
  return downloadEnv;
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
        env: buildDownloadEnv(hfCache, env, { source }),
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
  const includePatterns = buildDownloadIncludePatterns(precision, model);
  if (source === "modelscope") {
    const includeArgs = includePatterns.flatMap((pattern) => ["--include", pattern]);
    return {
      command: modelScopeCli,
      args: ["download", "--model", model, "--local_dir", localDir, ...includeArgs],
      label: "ModelScope",
      includePatterns,
    };
  }
  // Use --include=PATTERN on Windows. Passing PATTERN as the next argv item lets
  // Click expand globs against the manager working directory before hf sees it.
  const includeArgs = includePatterns.map((pattern) => `--include=${pattern}`);
  return {
    command: hfCli,
    args: ["download", model, ...includeArgs, "--local-dir", localDir],
    label: "Hugging Face",
    includePatterns,
  };
}

function assertDownloadDiskSpace(expectedBytes, freeBytes, formatBytes = (value) => String(value)) {
  const needed = Number(expectedBytes || 0);
  const free = Number(freeBytes || 0);
  if (!(needed > 0) || !(free > 0)) return;
  const reserve = Math.max(free * 0.05, 10 * 1024 ** 3);
  if (needed > free - reserve) {
    const error = new Error(`磁盘空间不足：预计下载 ${formatBytes(needed)}，模型盘剩余 ${formatBytes(free)}。请清理磁盘或更换模型目录后再试。`);
    error.status = 400;
    error.code = "download_disk_full";
    throw error;
  }
}

function missingDownloadCliError(command, source) {
  const name = String(source || "").toLowerCase() === "modelscope" ? "modelscope" : "hf";
  const error = new Error(`${name} CLI 未安装（期望路径 ${command || name}）。请先安装对应命令行工具后再下载。`);
  error.status = 400;
  error.code = "download_cli_missing";
  return error;
}

module.exports = {
  cleanDownloadSource,
  normalizeRemoteQuantFilter,
  normalizeDownloadModelReference,
  modelReferenceDeclaresPrecision,
  buildDownloadIncludePatterns,
  matchesDownloadPrecisionFile,
  filterDownloadSiblings,
  selectDownloadSiblings,
  buildDownloadEnv,
  createDownloadCommandBuilder,
  buildDownloadCommand,
  assertDownloadDiskSpace,
  missingDownloadCliError,
};
