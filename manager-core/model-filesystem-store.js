const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { ensureDirs } = require("./file-utils");
const { safeOutputName } = require("./settings-stores");

function createModelFilesystemStore(options = {}) {
  const modelsRoot = options.modelsRoot;
  const hfCache = options.hfCache;
  if (!modelsRoot || !hfCache) {
    throw new Error("createModelFilesystemStore requires modelsRoot and hfCache.");
  }
  const sizeCache = new Map();
  const sizeCacheTtlMs = Math.max(1000, Number(options.sizeCacheTtlMs || 5 * 60 * 1000));

  async function cachedDirSize(fullPath, stats) {
    const cached = sizeCache.get(fullPath);
    const now = Date.now();
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.expiresAt > now) return cached.size;
    const size = await dirSize(fullPath);
    sizeCache.set(fullPath, { size, mtimeMs: stats.mtimeMs, expiresAt: now + sizeCacheTtlMs });
    return size;
  }

  function resolveModelsRootChild(target) {
    const root = path.resolve(modelsRoot);
    const resolved = path.resolve(String(target || ""));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      const error = new Error("download path must be inside models root");
      error.status = 400;
      throw error;
    }
    return resolved;
  }

  function describeLocalModelPath(value) {
    if (!path.isAbsolute(value)) return null;
    const resolved = path.resolve(value);
    const root = path.resolve(modelsRoot);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    return {
      path: resolved,
      stat,
      ggufFiles: stat.isDirectory() ? findGgufFilesSync(resolved, 20) : [],
    };
  }

  async function listLocalModels() {
    await ensureDirs(modelsRoot);
    const entries = await fsp.readdir(modelsRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());
    const models = [];
    for (const entry of dirs) {
      const fullPath = path.join(modelsRoot, entry.name);
      const stats = await fsp.stat(fullPath);
      const ggufFiles = findGgufFilesSync(fullPath, 12);
      const verification = await verifyDownloadedModel({ localDir: fullPath });
      models.push({
        kind: "local",
        id: entry.name,
        label: entry.name,
        path: fullPath,
        launchModel: fullPath,
        size: await cachedDirSize(fullPath, stats),
        modified: stats.mtime.toISOString(),
        hasConfig: hasRecognizedConfig(fullPath),
        hasGguf: ggufFiles.length > 0,
        ggufFiles,
        runnable: verification.ok,
        verificationStatus: verification.status,
        verificationIssues: verification.issues,
        modelFormat: verification.modelFormat,
      });
    }
    return models.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async function listCachedModels() {
    const hubRoot = path.join(hfCache, "hub");
    if (!fs.existsSync(hubRoot)) return [];
    const entries = await fsp.readdir(hubRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("models--"));
    const models = [];
    for (const entry of dirs) {
      const repoId = entry.name.replace(/^models--/, "").replace(/--/g, "/");
      const fullPath = path.join(hubRoot, entry.name);
      const stats = await fsp.stat(fullPath);
      models.push({
        kind: "cached",
        id: repoId,
        label: repoId,
        path: fullPath,
        launchModel: repoId,
        size: await cachedDirSize(fullPath, stats),
        modified: stats.mtime.toISOString(),
      });
    }
    return models.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async function listModelCollections() {
    const [local, cached] = await Promise.all([
      listLocalModels(),
      listCachedModels(),
    ]);
    return { local, cached };
  }

  async function verifyDownloadedModel(input = {}, options = {}) {
    const outputName = String(input.outputName || "").trim();
    const localDir = input.localDir ? path.resolve(String(input.localDir)) : path.join(modelsRoot, safeOutputName(outputName));
    const resolved = resolveModelsRootChild(localDir);
    const exists = fs.existsSync(resolved);
    if (!exists) {
      return {
        ok: false,
        status: "missing",
        path: resolved,
        issues: [finding("fail", options.missingTitle || "目录不存在", resolved)],
      };
    }
    const stat = await fsp.stat(resolved);
    const files = await collectModelFiles(resolved, stat, Number(options.maxFiles || 5000));
    const summary = buildModelFileSummary(files, resolved);
    const requiredIssues = defaultVerificationIssues(summary, finding, options);
    const customIssues = typeof options.buildIssues === "function"
      ? options.buildIssues(summary, finding)
      : [];
    const issues = deduplicateFindings([...requiredIssues, ...(customIssues || [])]);
    const ok = !issues.some((item) => item.severity === "fail");
    return {
      ok,
      status: ok ? (issues.length ? "warn" : "ok") : "fail",
      path: resolved,
      ...summary,
      issues,
    };
  }

  return {
    chooseGgufFile,
    describeLocalModelPath,
    dirSize,
    findGgufFilesSync,
    hasRecognizedConfig,
    listCachedModels,
    listLocalModels,
    listModelCollections,
    looksLikeGgufReference,
    resolveModelsRootChild,
    scanDownloadProgress,
    verifyDownloadedModel,
  };
}

function hasRecognizedConfig(dir) {
  return fs.existsSync(path.join(dir, "config.json")) || fs.existsSync(path.join(dir, "params.json"));
}

function looksLikeGgufReference(value) {
  const lower = String(value || "").toLowerCase();
  return lower.endsWith(".gguf") || lower.includes("-gguf:") || /:[iq]?q\d(?:_[a-z0-9]+)*$/i.test(value);
}

function findGgufFilesSync(dir, limit = 20) {
  const results = [];
  const walk = (current) => {
    if (results.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".cache" || entry.name === ".git") continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
        let size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          size = 0;
        }
        results.push({ path: fullPath, name: path.relative(dir, fullPath), size });
      }
    }
  };
  walk(dir);
  return results.sort((a, b) => b.size - a.size);
}

function chooseGgufFile(files) {
  const list = [...files];
  const modelFiles = list.filter((item) => !/(?:^|[\\/])mmproj[^\\/]*\.gguf$/i.test(String(item.path || item.name || "")));
  const candidates = modelFiles.length ? modelFiles : list;
  const firstShard = candidates.find((item) => /-00001-of-\d+\.gguf$/i.test(String(item.path || item.name || "")));
  if (firstShard) return firstShard;
  return candidates.sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];
}

async function dirSize(target) {
  let total = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) total += (await fsp.stat(full)).size;
      } catch {
        // Ignore files that change while scanning.
      }
    }
  }
  await walk(target);
  return total;
}

async function collectModelFiles(resolved, stat, maxFiles = 5000) {
  const files = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const itemStat = await fsp.stat(full).catch(() => null);
        files.push({
          path: full,
          name: entry.name,
          relativePath: normalizeRelativePath(path.relative(resolved, full) || entry.name),
          size: itemStat?.size || 0,
        });
      }
      if (files.length > maxFiles) break;
    }
  }
  if (stat.isDirectory()) await walk(resolved);
  else files.push({
    path: resolved,
    name: path.basename(resolved),
    relativePath: path.basename(resolved),
    size: stat.size,
  });
  return files;
}

function buildModelFileSummary(files, root) {
  const normalizedFiles = files.map((item) => ({
    ...item,
    relativePath: normalizeRelativePath(item.relativePath || path.relative(root, item.path) || item.name),
  }));
  const payloadFiles = normalizedFiles.filter((item) => !isCachePath(item.relativePath));
  const lowerNames = payloadFiles.map((item) => item.name.toLowerCase());
  const safetensors = payloadFiles.filter((item) => item.name.toLowerCase().endsWith(".safetensors"));
  const pytorchWeights = payloadFiles.filter((item) => /(?:^|[._-])(?:pytorch_model|model|weights?)(?:[._-].*)?\.bin$/i.test(item.name));
  const gguf = payloadFiles.filter((item) => item.name.toLowerCase().endsWith(".gguf"));
  const incompleteFiles = normalizedFiles.filter((item) => item.name.toLowerCase().endsWith(".incomplete"));
  const zeroByteWeightFiles = [...safetensors, ...pytorchWeights, ...gguf]
    .filter((item) => item.size === 0)
    .map((item) => item.relativePath);
  const invalidWeightFiles = [
    ...safetensors.map(validateSafetensorsHeader).filter(Boolean),
    ...gguf.map(validateGgufHeader).filter(Boolean),
  ];
  const indexSummary = inspectWeightIndexes(payloadFiles, root);
  const configFile = payloadFiles.find((item) => item.name.toLowerCase() === "config.json");
  const configResult = readJsonObject(configFile?.path);
  const modelFormat = detectModelFormat({
    root,
    config: configResult.value,
    safetensors,
    pytorchWeights,
    gguf,
  });
  return {
    fileCount: payloadFiles.length,
    storageFileCount: normalizedFiles.length,
    size: payloadFiles.reduce((sum, item) => sum + item.size, 0),
    storageSize: normalizedFiles.reduce((sum, item) => sum + item.size, 0),
    hasConfig: lowerNames.includes("config.json") || lowerNames.includes("params.json"),
    hasTokenizer: lowerNames.some((name) => name.includes("tokenizer")),
    safetensors: safetensors.length,
    pytorchWeights: pytorchWeights.length,
    gguf: gguf.length,
    modelFormat,
    incomplete: incompleteFiles.length,
    incompleteBytes: incompleteFiles.reduce((sum, item) => sum + item.size, 0),
    incompleteFiles: incompleteFiles.slice(0, 20).map((item) => item.relativePath),
    zeroByteWeightFiles,
    invalidWeightFiles,
    configParseError: configFile && configResult.error ? configResult.error : "",
    ...indexSummary,
    largestFiles: [...normalizedFiles].sort((a, b) => b.size - a.size).slice(0, 8).map((item) => ({
      name: item.relativePath,
      size: item.size,
    })),
  };
}

function defaultVerificationIssues(summary, makeFinding = finding, _options = {}) {
  const issues = [];
  if (!summary.hasConfig && !summary.gguf) issues.push(makeFinding("fail", "缺少模型配置", "没有 config.json/params.json；本地模型不能安全启动。"));
  if (!summary.hasTokenizer && !summary.gguf) issues.push(makeFinding("warn", "缺少 tokenizer", "未发现 tokenizer 文件；远程 repo 启动可能会补取，本地离线启动可能失败。"));
  if (!summary.safetensors && !summary.pytorchWeights && !summary.gguf) issues.push(makeFinding("fail", "未发现权重文件", "没有可识别的 .safetensors、PyTorch .bin 或 .gguf 权重。"));
  if (summary.modelFormat === "mlx") issues.push(makeFinding("fail", "MLX 权重不兼容 vLLM", "该目录是 Apple MLX/affine 量化格式，只能使用 mlx-lm 等 MLX 运行时，不能交给 vLLM。"));
  if (summary.incomplete) {
    // huggingface_hub can leave orphaned cache fragments after an interrupted
    // download even when every indexed weight shard has been finalized. Those
    // fragments are storage residue, not evidence that the model is incomplete.
    const incompleteIsBlocking = Boolean(summary.missingWeightFiles?.length) || (!summary.safetensors && !summary.pytorchWeights && !summary.gguf);
    issues.push(makeFinding(incompleteIsBlocking ? "fail" : "warn", incompleteIsBlocking ? "下载尚未完成" : "存在下载缓存残留", `发现 ${summary.incomplete} 个 .incomplete 文件（${summary.incompleteBytes} 字节）。${incompleteIsBlocking ? "请继续下载或清理残留后重新校验。" : "正式权重分片完整，可启动；建议清理或续传该缓存残留。"}`));
  }
  if (summary.missingWeightFiles?.length) issues.push(makeFinding("fail", "权重分片缺失", `缺少 ${summary.missingWeightFiles.length} 个分片：${summary.missingWeightFiles.slice(0, 8).join(", ")}`));
  if (summary.malformedWeightIndexes?.length) issues.push(makeFinding("fail", "权重索引损坏", summary.malformedWeightIndexes.join("；")));
  if (summary.zeroByteWeightFiles?.length) issues.push(makeFinding("fail", "存在空权重文件", summary.zeroByteWeightFiles.slice(0, 8).join(", ")));
  if (summary.invalidWeightFiles?.length) issues.push(makeFinding("fail", "权重文件头无效", summary.invalidWeightFiles.slice(0, 8).join("；")));
  if (summary.configParseError) issues.push(makeFinding("fail", "config.json 无法解析", summary.configParseError));
  return issues;
}

async function scanDownloadProgress(target) {
  const root = path.resolve(String(target || ""));
  let finalizedBytes = 0;
  let partialBytes = 0;
  let finalizedFiles = 0;
  let incompleteFiles = 0;
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = await fsp.stat(full).catch(() => null);
      const size = stats?.size || 0;
      const relative = normalizeRelativePath(path.relative(root, full));
      if (entry.name.toLowerCase().endsWith(".incomplete")) {
        incompleteFiles += 1;
        partialBytes += size;
      } else if (!isCachePath(relative)) {
        finalizedFiles += 1;
        finalizedBytes += size;
      }
    }
  }
  await walk(root);
  return {
    finalizedBytes,
    partialBytes,
    downloadedBytes: finalizedBytes + partialBytes,
    finalizedFiles,
    incompleteFiles,
  };
}

function inspectWeightIndexes(files, root) {
  const byRelative = new Set(files.map((item) => normalizeRelativePath(item.relativePath).toLowerCase()));
  const expected = new Set();
  const malformedWeightIndexes = [];
  const indexes = files.filter((item) => /\.(?:safetensors|bin)\.index\.json$/i.test(item.name));
  for (const indexFile of indexes) {
    const parsed = readJsonObject(indexFile.path);
    const weightMap = parsed.value?.weight_map;
    if (parsed.error || !weightMap || typeof weightMap !== "object") {
      malformedWeightIndexes.push(`${indexFile.relativePath}: ${parsed.error || "缺少 weight_map"}`);
      continue;
    }
    for (const value of Object.values(weightMap)) {
      if (typeof value === "string" && value.trim()) expected.add(normalizeRelativePath(value));
    }
  }
  for (const item of files) {
    const match = item.name.match(/^(.*-)(\d+)(-of-)(\d+)(\.(?:safetensors|bin))$/i);
    if (!match) continue;
    const total = Number(match[4]);
    const width = match[2].length;
    const parent = normalizeRelativePath(path.dirname(item.relativePath));
    for (let index = 1; index <= total; index += 1) {
      const filename = `${match[1]}${String(index).padStart(width, "0")}${match[3]}${match[4]}${match[5]}`;
      expected.add(parent === "." ? filename : `${parent}/${filename}`);
    }
  }
  const expectedWeightFileNames = [...expected].sort();
  const missingWeightFiles = expectedWeightFileNames.filter((item) => !byRelative.has(item.toLowerCase()));
  return {
    weightIndexFiles: indexes.map((item) => normalizeRelativePath(path.relative(root, item.path) || item.name)),
    expectedWeightFiles: expectedWeightFileNames.length,
    expectedWeightFileNames,
    missingWeightFiles,
    malformedWeightIndexes,
  };
}

function detectModelFormat({ root, config, safetensors, pytorchWeights, gguf }) {
  const quantization = config?.quantization;
  const looksLikeMlx = /(?:^|[-_.])mlx(?:$|[-_.])/i.test(path.basename(root || ""))
    || Boolean(quantization && typeof quantization === "object"
      && !config?.quantization_config
      && (quantization.mode === "affine" || (quantization.bits && quantization.group_size)));
  if (looksLikeMlx) return "mlx";
  if (gguf.length && !safetensors.length && !pytorchWeights.length) return "gguf";
  if (safetensors.length) return "safetensors";
  if (pytorchWeights.length) return "pytorch";
  return "unknown";
}

function validateSafetensorsHeader(file) {
  if (!file?.path || file.size === 0) return "";
  if (file.size < 10) return `${file.relativePath}: 文件过小，缺少 safetensors 头`;
  try {
    const fd = fs.openSync(file.path, "r");
    const header = Buffer.alloc(8);
    try {
      if (fs.readSync(fd, header, 0, 8, 0) !== 8) return `${file.relativePath}: 无法读取 safetensors 头`;
    } finally {
      fs.closeSync(fd);
    }
    const headerBytes = header.readBigUInt64LE(0);
    if (headerBytes < 2n || headerBytes > BigInt(file.size - 8)) return `${file.relativePath}: safetensors 头长度越界`;
  } catch (error) {
    return `${file.relativePath}: ${error.message}`;
  }
  return "";
}

function validateGgufHeader(file) {
  if (!file?.path || file.size === 0) return "";
  if (file.size < 8) return `${file.relativePath}: 文件过小，缺少 GGUF 头`;
  try {
    const fd = fs.openSync(file.path, "r");
    const header = Buffer.alloc(4);
    try {
      fs.readSync(fd, header, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (header.toString("ascii") !== "GGUF") return `${file.relativePath}: magic 不是 GGUF`;
  } catch (error) {
    return `${file.relativePath}: ${error.message}`;
  }
  return "";
}

function readJsonObject(file) {
  if (!file) return { value: null, error: "" };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return { value: value && typeof value === "object" ? value : null, error: "" };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function isCachePath(relativePath) {
  return normalizeRelativePath(relativePath).split("/").some((part) => part === ".cache" || part === ".git");
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function deduplicateFindings(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const key = `${item?.severity}|${item?.title}|${item?.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finding(severity, title, detail) {
  return { severity, title, detail: String(detail || "") };
}

module.exports = {
  buildModelFileSummary,
  chooseGgufFile,
  collectModelFiles,
  createModelFilesystemStore,
  dirSize,
  findGgufFilesSync,
  hasRecognizedConfig,
  looksLikeGgufReference,
  scanDownloadProgress,
  defaultVerificationIssues,
};
