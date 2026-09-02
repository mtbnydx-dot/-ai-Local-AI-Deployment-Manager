"use strict";

// Turns a repository file list into the quantization choices a GGUF download
// actually offers: one row per quant tag with its total size (multi-part shards
// grouped), plus the companion files (mmproj vision projectors, DFlash / draft
// models) the llama manager can load next to the main weights.

const QUANT_TAG = /(?:^|[-_.])((?:I?Q)[1-8](?:_[A-Z0-9]+)*|F16|BF16|F32|FP16|MXFP4|NVFP4|UD-[A-Z0-9_]+)(?=[-_.]|$)/i;
const SHARD_PATTERN = /-(\d{5})-of-(\d{5})\.gguf$/i;
const MMPROJ_PATTERN = /mmproj/i;
const DRAFT_PATTERN = /dflash|draft|eagle|mtp/i;

function normalizeSiblings(siblings) {
  return (Array.isArray(siblings) ? siblings : [])
    .map((item) => ({
      name: String(item?.name || item?.rfilename || "").trim(),
      size: Number(item?.size || item?.lfs?.size || 0) || 0,
    }))
    .filter((item) => item.name && item.name.toLowerCase().endsWith(".gguf"));
}

function quantTagOf(name) {
  const base = String(name || "").split("/").pop().replace(/\.gguf$/i, "").replace(SHARD_PATTERN, "");
  const match = base.match(QUANT_TAG);
  return match ? match[1].toUpperCase() : "";
}

function shardInfo(name) {
  const match = String(name || "").match(SHARD_PATTERN);
  return match ? { index: Number(match[1]), total: Number(match[2]) } : null;
}

function classify(name) {
  if (MMPROJ_PATTERN.test(name)) return "mmproj";
  if (DRAFT_PATTERN.test(name)) return "draft";
  return "main";
}

function fitFor(bytes, options = {}) {
  const totalMb = Number(options.gpuTotalMb || 0);
  if (!(bytes > 0) || !(totalMb > 0)) return { status: "unknown", ratio: null, note: "未读取到显存信息。" };
  const overheadMb = Number(options.overheadMb ?? 1024);
  const kvMb = Number(options.kvReserveMb ?? 2048);
  const neededMb = bytes / (1024 * 1024) * 1.05 + overheadMb + kvMb;
  const ratio = neededMb / totalMb;
  if (ratio <= 0.85) return { status: "fits", ratio, note: `约占显存 ${(ratio * 100).toFixed(0)}%，可以整模型放进 GPU。` };
  if (ratio <= 1) return { status: "tight", ratio, note: `约占显存 ${(ratio * 100).toFixed(0)}%，上下文需要保守，或放部分层到 CPU。` };
  return { status: "exceeds", ratio, note: `需要约 ${(neededMb / 1024).toFixed(1)} GB，超过显存，只能把部分层放到 CPU。` };
}

function listGgufVariants(siblings, options = {}) {
  const files = normalizeSiblings(siblings);
  const groups = new Map();
  const companions = { mmproj: [], draft: [] };
  const other = [];
  for (const file of files) {
    const role = classify(file.name);
    if (role !== "main") {
      companions[role].push({ ...file, quant: quantTagOf(file.name) });
      continue;
    }
    const quant = quantTagOf(file.name);
    if (!quant) {
      other.push(file);
      continue;
    }
    // Shards live in sub-directories on some repos (Q4_K_M/model-00001-of-00003.gguf);
    // the directory name is part of the identity so two quant folders never merge.
    const directory = file.name.includes("/") ? file.name.slice(0, file.name.lastIndexOf("/")) : "";
    const key = `${directory}|${quant}`;
    if (!groups.has(key)) groups.set(key, { quant, directory, files: [], bytes: 0, shards: 0, expectedShards: 0 });
    const group = groups.get(key);
    group.files.push(file);
    group.bytes += file.size;
    const shard = shardInfo(file.name);
    if (shard) {
      group.shards += 1;
      group.expectedShards = Math.max(group.expectedShards, shard.total);
    }
  }
  const variants = Array.from(groups.values())
    .map((group) => ({
      quant: group.quant,
      directory: group.directory,
      files: group.files.sort((a, b) => a.name.localeCompare(b.name)),
      bytes: group.bytes,
      fileCount: group.files.length,
      multiPart: group.shards > 0,
      complete: group.shards === 0 || group.shards === group.expectedShards,
      fit: fitFor(group.bytes, options),
      // vLLM only loads single-file GGUF; the llama manager handles shards.
      vllmLoadable: group.shards === 0 && group.files.length === 1,
    }))
    .sort((a, b) => a.bytes - b.bytes || a.quant.localeCompare(b.quant));
  return {
    variants,
    mmproj: companions.mmproj.sort((a, b) => a.size - b.size),
    drafts: companions.draft.sort((a, b) => a.size - b.size),
    other,
    totalFiles: files.length,
  };
}

// The download form takes "repo:QUANT"; companions need explicit include
// patterns because the quant filter excludes them.
function buildVariantDownloadPlan(model, variant, options = {}) {
  const includeExtras = [];
  if (options.includeMmproj) includeExtras.push("*mmproj*.gguf");
  if (options.includeDraft) includeExtras.push("*dflash*.gguf", "*draft*.gguf", "*eagle*.gguf");
  return {
    model: variant?.quant ? `${model}:${variant.quant}` : model,
    precision: variant?.quant || "",
    includeExtras,
  };
}

module.exports = {
  buildVariantDownloadPlan,
  fitFor,
  listGgufVariants,
  quantTagOf,
};
