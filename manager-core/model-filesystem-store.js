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
      models.push({
        kind: "local",
        id: entry.name,
        label: entry.name,
        path: fullPath,
        launchModel: fullPath,
        size: await dirSize(fullPath),
        modified: stats.mtime.toISOString(),
        hasConfig: hasRecognizedConfig(fullPath),
        hasGguf: ggufFiles.length > 0,
        ggufFiles,
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
        size: await dirSize(fullPath),
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
    const buildIssues = typeof options.buildIssues === "function" ? options.buildIssues : defaultVerificationIssues;
    const issues = buildIssues(summary, finding);
    return {
      ok: !issues.some((item) => item.severity === "fail"),
      status: issues.length ? "warn" : "ok",
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
  return [...files].sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];
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
        files.push({ path: full, name: entry.name, size: itemStat?.size || 0 });
      }
      if (files.length > maxFiles) break;
    }
  }
  if (stat.isDirectory()) await walk(resolved);
  else files.push({ path: resolved, name: path.basename(resolved), size: stat.size });
  return files;
}

function buildModelFileSummary(files, root) {
  const lowerNames = files.map((item) => item.name.toLowerCase());
  const safetensors = files.filter((item) => item.name.toLowerCase().endsWith(".safetensors"));
  const gguf = files.filter((item) => item.name.toLowerCase().endsWith(".gguf"));
  return {
    fileCount: files.length,
    size: files.reduce((sum, item) => sum + item.size, 0),
    hasConfig: lowerNames.includes("config.json") || lowerNames.includes("params.json"),
    hasTokenizer: lowerNames.some((name) => name.includes("tokenizer")),
    safetensors: safetensors.length,
    gguf: gguf.length,
    largestFiles: files.sort((a, b) => b.size - a.size).slice(0, 8).map((item) => ({
      name: path.relative(root, item.path) || item.name,
      size: item.size,
    })),
  };
}

function defaultVerificationIssues(summary, makeFinding = finding) {
  const issues = [];
  if (!summary.hasConfig && !summary.gguf) issues.push(makeFinding("warn", "缺少模型配置", "没有 config.json/params.json；如果不是 GGUF，推理服务可能无法启动。"));
  if (!summary.hasTokenizer && !summary.gguf) issues.push(makeFinding("warn", "缺少 tokenizer", "未发现 tokenizer 文件；远程 repo 启动可能会补取，本地离线启动可能失败。"));
  if (!summary.safetensors && !summary.gguf) issues.push(makeFinding("warn", "未发现权重文件", "没有 .safetensors 或 .gguf 文件。"));
  return issues;
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
  defaultVerificationIssues,
};
