"use strict";

// Artifacts and selection (docs/overhaul/03-hub.md section 5, HUB-4). An
// artifact is always a concrete file list taken from the repository manifest,
// so a selection that reaches the queue cannot be empty by construction.
// `compileIncludePatterns` turns that list into CLI `--include=PATTERN`
// arguments and proves, with the same fnmatch semantics the CLI uses, that the
// patterns select exactly the planned files.

const crypto = require("node:crypto");
const { listGgufVariants, quantTagOf } = require("../gguf-variants");
const { normalizeRemoteQuantFilter } = require("../download-utils");
const { HubError } = require("./errors");
const { escapeFnmatch, fnmatchToRegExp } = require("./fnmatch");

const DEFAULT_ARGV_BUDGET = 24000;
const MAX_LOCAL_PATH = 240;
const INCLUDE_ARG_OVERHEAD = "--include=".length + 3; // quotes and the separating space

const GGUF_RE = /\.gguf$/i;
const ST_WEIGHT_RE = /\.(?:safetensors|bin|pt)$/i;
const WEIGHT_RE = /\.(?:gguf|safetensors|bin|pt)$/i;
const MMPROJ_RE = /mmproj/i;
const DRAFT_RE = /dflash|draft|eagle|mtp/i;
const SAFETENSORS_QUANT_VALUES = new Set(["FP8", "AWQ", "GPTQ", "NVFP4", "MXFP4"]);

// Basename patterns for the files added to every artifact (section 5). The
// tokenizer vocabulary files and `*.index.json` go beyond the spec's list: a
// BPE tokenizer cannot load without vocab/merges, and `.bin` shards need their
// index as much as safetensors shards do.
const SIDECAR_RES = [
  /^config.*\.json$/i,
  /^generation_config\.json$/i,
  /^tokenizer/i,
  /^special_tokens_map\.json$/i,
  /\.jinja$/i,
  /^chat_template/i,
  /^preprocessor/i,
  /^processor/i,
  /\.model$/i,
  /\.tiktoken$/i,
  /^readme/i,
  /^license/i,
  /\.index\.json$/i,
  /^vocab[^/]*\.(?:json|txt)$/i,
  /^merges\.txt$/i,
  /^added_tokens\.json$/i,
];
const PY_RE = /\.py$/i;
const RESERVED_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul", "conin$", "conout$",
  ...Array.from({ length: 10 }, (_, index) => `com${index}`),
  ...Array.from({ length: 10 }, (_, index) => `lpt${index}`),
]);

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function baseOf(filePath) {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

function dirOf(filePath) {
  const index = filePath.lastIndexOf("/");
  return index < 0 ? "" : filePath.slice(0, index);
}

function pathOf(entry) {
  return typeof entry === "string" ? entry : String(entry?.path ?? "");
}

function unique(values) {
  return Array.from(new Set(values));
}

function sum(files) {
  return files.reduce((total, file) => total + (Number.isFinite(file.size) ? file.size : 0), 0);
}

/** Why a repository path is unsafe to write below a models root, or null. */
function unsafeReason(filePath, { reserve = 0 } = {}) {
  if (typeof filePath !== "string" || !filePath) return "empty";
  if (filePath.length + Math.max(0, Number(reserve) || 0) > MAX_LOCAL_PATH) return "too_long";
  if (/[\u0000-\u001f\u007f]/.test(filePath)) return "control_character";
  if (filePath.includes("\\")) return "backslash";
  if (filePath.startsWith("/")) return "absolute";
  if (filePath.includes(":")) return /^[a-zA-Z]:/.test(filePath) ? "drive_letter" : "colon";
  for (const segment of filePath.split("/")) {
    if (!segment) return "empty_segment";
    if (segment === "." || segment === "..") return "dot_segment";
    if (/[. ]$/.test(segment)) return "trailing_dot_or_space";
    if (RESERVED_DEVICE_NAMES.has(segment.split(".")[0].trim().toLowerCase())) return "reserved_name";
  }
  return null;
}

/**
 * assertSafeRepoPath(p, { reserve }) -> p. Throws 422 `unsafe_path` unless `p`
 * is a relative POSIX path that is safe on Windows (section 17). `reserve` is
 * the length of the local directory the path is written under, so the whole
 * local path stays within 240 characters.
 */
function assertSafeRepoPath(filePath, options = {}) {
  const reason = unsafeReason(filePath, options);
  if (reason) {
    throw new HubError("unsafe_path", "The repository file path is not safe to write locally.", {
      status: 422,
      details: { path: typeof filePath === "string" ? filePath.slice(0, 300) : "", reason },
    });
  }
  return filePath;
}

function manifestFiles(manifest) {
  const seen = new Map();
  for (const raw of Array.isArray(manifest?.files) ? manifest.files : []) {
    const filePath = typeof raw?.path === "string" ? raw.path : "";
    if (filePath && !seen.has(filePath)) seen.set(filePath, raw);
  }
  return seen;
}

function fileView(file, role) {
  return {
    path: file.path,
    size: Number.isFinite(file.size) ? file.size : null,
    sha256: file.sha256 || null,
    gitOid: file.gitOid || null,
    lfs: Boolean(file.lfs),
    role,
  };
}

function hasAutoMap(manifest, card) {
  const fromManifest = manifest?.structured?.config?.auto_map;
  const fromCard = card?.config?.auto_map;
  return Boolean((fromManifest && typeof fromManifest === "object") || (fromCard && typeof fromCard === "object"));
}

function companionRoleOf(filePath) {
  if (!GGUF_RE.test(filePath)) return null;
  if (MMPROJ_RE.test(filePath)) return "mmproj";
  if (DRAFT_RE.test(filePath)) return "draft";
  return null;
}

function companionsOf(files) {
  const result = { mmproj: [], draft: [] };
  for (const file of files.values()) {
    const role = companionRoleOf(file.path);
    if (role) result[role].push({ path: file.path, size: Number.isFinite(file.size) ? file.size : null });
  }
  result.mmproj.sort((a, b) => compare(a.path, b.path));
  result.draft.sort((a, b) => compare(a.path, b.path));
  return result;
}

// Sidecars sit directly in the artifact's directory or in the repo root.
function sidecarsFor(files, directories, { customCode }) {
  const wanted = new Set(["", ...directories]);
  const result = [];
  for (const file of files.values()) {
    if (WEIGHT_RE.test(file.path) || !wanted.has(dirOf(file.path))) continue;
    const base = baseOf(file.path);
    if (SIDECAR_RES.some((re) => re.test(base)) || (customCode && PY_RE.test(base))) result.push(file);
  }
  return result;
}

function assemble(manifest, files, { kind, artifactKey, label, quant = null, directory = "", weights, directories, multiPart = false, complete = true, card }) {
  const gguf = weights.every((file) => GGUF_RE.test(file.path));
  const customCode = !gguf && hasAutoMap(manifest, card);
  const weightPaths = new Set(weights.map((file) => file.path));
  const sidecars = sidecarsFor(files, directories, { customCode }).filter((file) => !weightPaths.has(file.path));
  const all = [
    ...weights.map((file) => fileView(file, "weight")),
    ...sidecars.map((file) => fileView(file, "sidecar")),
  ].sort((a, b) => compare(a.path, b.path));
  const weightBytes = sum(weights);
  return {
    artifactKey,
    kind,
    label,
    format: gguf ? "gguf" : (weights.some((file) => /\.safetensors$/i.test(file.path)) ? "safetensors" : "pytorch"),
    quant,
    directory,
    bytes: weightBytes,
    fileCount: weights.length,
    multiPart,
    complete,
    totalBytes: weightBytes + sum(sidecars),
    files: all,
    customCodeFiles: customCode ? sidecars.filter((file) => PY_RE.test(file.path)).map((file) => file.path).sort(compare) : [],
    unsafePaths: all.filter((file) => unsafeReason(file.path)).map((file) => file.path),
  };
}

function customKeyOf(paths) {
  return `custom:${crypto.createHash("sha256").update([...paths].sort(compare).join("\n")).digest("hex").slice(0, 8)}`;
}

/**
 * listArtifacts(manifest, { card, includeIncomplete }) -> Artifact[]. One
 * `gguf-quant` per quant group and directory (shards grouped) and one
 * `safetensors-full` per weight directory that has a config or an index.
 * Incomplete shard sets are skipped unless `includeIncomplete`. Companions
 * (mmproj, draft) are listed on GGUF artifacts and never added implicitly.
 */
function listArtifacts(manifest, { card = null, includeIncomplete = false } = {}) {
  const files = manifestFiles(manifest);
  const companions = companionsOf(files);
  const result = [];

  const variants = listGgufVariants(Array.from(files.values()).map((file) => ({ name: file.path, size: file.size || 0 }))).variants;
  for (const variant of variants) {
    if (!variant.complete && !includeIncomplete) continue;
    const weights = variant.files.map((file) => files.get(file.name)).sort((a, b) => compare(a.path, b.path));
    result.push({
      ...assemble(manifest, files, {
        kind: "gguf-quant",
        artifactKey: `gguf:${variant.directory}|${variant.quant}`,
        label: variant.quant,
        quant: variant.quant,
        directory: variant.directory,
        weights,
        directories: [variant.directory],
        multiPart: variant.multiPart,
        complete: variant.complete,
        card,
      }),
      companions: { mmproj: companions.mmproj.map((c) => ({ ...c })), draft: companions.draft.map((c) => ({ ...c })) },
    });
  }

  const byDirectory = new Map();
  for (const file of files.values()) {
    if (!ST_WEIGHT_RE.test(file.path)) continue;
    const directory = dirOf(file.path);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(file);
  }
  for (const directory of Array.from(byDirectory.keys()).sort(compare)) {
    const prefix = directory ? `${directory}/` : "";
    const describesModel = files.has(`${prefix}config.json`)
      || Array.from(files.keys()).some((filePath) => dirOf(filePath) === directory && /.index.json$/i.test(filePath));
    if (!describesModel) continue;
    const weights = byDirectory.get(directory).sort((a, b) => compare(a.path, b.path));
    result.push({
      ...assemble(manifest, files, {
        kind: "safetensors-full",
        artifactKey: `st:${directory}`,
        label: directory || "safetensors",
        directory,
        weights,
        directories: [directory],
        multiPart: weights.length > 1,
        card,
      }),
      companions: { mmproj: [], draft: [] },
    });
  }
  return result;
}

function suggestionsOf(artifacts) {
  return artifacts.map((artifact) => ({
    artifactKey: artifact.artifactKey,
    label: artifact.label,
    quant: artifact.quant,
    bytes: artifact.bytes,
  }));
}

function noMatchError(message, manifest, extra = {}) {
  const artifacts = listArtifacts(manifest, { includeIncomplete: true });
  return new HubError("filter_no_match", message, {
    status: 422,
    details: { available: artifacts.map((artifact) => artifact.artifactKey), suggestions: suggestionsOf(artifacts), ...extra },
  });
}

function resolved(artifact, companionFiles, extras = {}) {
  const files = [...artifact.files, ...companionFiles.map((file) => fileView(file, "companion"))]
    .sort((a, b) => compare(a.path, b.path));
  for (const file of files) assertSafeRepoPath(file.path);
  return {
    artifactKey: artifact.artifactKey,
    kind: artifact.kind,
    format: artifact.format,
    quant: artifact.quant,
    directory: artifact.directory,
    companions: companionFiles.map((file) => file.path).sort(compare),
    files,
    weightCount: artifact.fileCount,
    weightBytes: artifact.bytes,
    totalBytes: sum(files),
    multiPart: artifact.multiPart,
    complete: artifact.complete,
    customCodeFiles: artifact.customCodeFiles,
    ...extras,
  };
}

function requestedCompanions(manifest, files, selection) {
  const requested = Array.isArray(selection?.companions) ? unique(selection.companions.map(String)) : [];
  return requested.map((requestedPath) => {
    assertSafeRepoPath(requestedPath);
    const file = files.get(requestedPath);
    if (!file) throw notInManifest(requestedPath);
    if (!companionRoleOf(requestedPath)) throw notInManifest(requestedPath, "not_a_companion");
    return file;
  });
}

function notInManifest(filePath, reason = "absent") {
  return new HubError("file_not_in_manifest", "The file is not part of this repository revision.", {
    status: 422,
    details: { path: String(filePath).slice(0, 300), reason },
  });
}

/**
 * resolveSelection(manifest, { artifactKey, companions, files, acceptIncomplete })
 * -> the job `artifact` shape (key, kind, format, quant, companions, files with
 * roles, byte totals). Rejects with 422 `artifact_not_found`,
 * `file_not_in_manifest`, `unsafe_path` or `filter_no_match`. A non-null
 * `files` array is a `custom` selection and takes precedence over a non-custom
 * `artifactKey`.
 */
function resolveSelection(manifest, selection = {}, { card = null } = {}) {
  const files = manifestFiles(manifest);
  const input = selection && typeof selection === "object" ? selection : {};
  const companionFiles = requestedCompanions(manifest, files, input);

  if (Array.isArray(input.files)) {
    const paths = unique(input.files.map(pathOf));
    const chosen = paths.map((filePath) => {
      assertSafeRepoPath(filePath);
      const file = files.get(filePath);
      if (!file) throw notInManifest(filePath);
      return file;
    });
    if (!chosen.some((file) => WEIGHT_RE.test(file.path))) {
      throw noMatchError("The selected files contain no model weight file.", manifest);
    }
    const artifactKey = customKeyOf(chosen.map((file) => file.path));
    if (typeof input.artifactKey === "string" && input.artifactKey.startsWith("custom:") && input.artifactKey !== artifactKey) {
      throw new HubError("artifact_not_found", "The custom selection does not match the requested artifact key.", {
        status: 422,
        details: { artifactKey: input.artifactKey, expected: artifactKey },
      });
    }
    const artifact = assemble(manifest, files, {
      kind: "custom",
      artifactKey,
      label: artifactKey,
      weights: chosen.filter((file) => WEIGHT_RE.test(file.path)),
      directories: unique(chosen.map((file) => dirOf(file.path))),
      multiPart: chosen.length > 1,
      card,
    });
    // Files chosen explicitly are kept even when they are not sidecars.
    const known = new Set(artifact.files.map((file) => file.path));
    const additions = [...chosen, ...companionFiles].filter((file) => !known.has(file.path));
    const merged = { ...artifact, files: [...artifact.files, ...additions.map((file) => fileView(file, "sidecar"))] };
    const companionPaths = merged.files.filter((file) => companionRoleOf(file.path) || companionFiles.some((c) => c.path === file.path)).map((file) => file.path);
    const result = resolved(merged, []);
    const files2 = result.files.map((file) => (companionPaths.includes(file.path) ? { ...file, role: "companion" } : file));
    return { ...result, files: files2, companions: companionPaths.sort(compare), weightCount: chosen.filter((file) => WEIGHT_RE.test(file.path) && !companionRoleOf(file.path)).length };
  }

  const key = typeof input.artifactKey === "string" ? input.artifactKey : "";
  const artifacts = listArtifacts(manifest, { card, includeIncomplete: true });
  const artifact = artifacts.find((candidate) => candidate.artifactKey === key);
  if (!artifact) {
    throw new HubError("artifact_not_found", "The requested artifact is not offered by this repository.", {
      status: 422,
      details: { artifactKey: key.slice(0, 300), available: artifacts.map((candidate) => candidate.artifactKey) },
    });
  }
  if (!artifact.complete && input.acceptIncomplete !== true) {
    throw new HubError("artifact_not_found", "The artifact has an incomplete shard set.", {
      status: 422,
      details: { artifactKey: key, reason: "incomplete_shards", available: artifacts.filter((c) => c.complete).map((c) => c.artifactKey) },
    });
  }
  if (!artifact.fileCount) throw noMatchError("The artifact contains no model weight file.", manifest);
  return resolved(artifact, companionFiles);
}

function globMatchers(globs) {
  return (Array.isArray(globs) ? globs : [globs]).map((glob) => String(glob || "").trim()).filter(Boolean)
    .map((glob) => fnmatchToRegExp(glob, { ignoreCase: true }));
}

function legacyFamilyMatcher(value) {
  if (/^IQ\d/.test(value)) return (tag) => tag === value || tag.startsWith(`${value}_`);
  if (/^Q\d/.test(value)) return (tag) => {
    const bare = tag.replace(/^I/, "");
    return bare === value || bare.startsWith(`${value}_`);
  };
  return (tag) => tag === value;
}

/**
 * selectionFromLegacy({ precision, includeExtras, repo }, manifest) -> a
 * selection for resolveSelection (section 5, "Legacy precision"). It keeps the
 * intent of the old `buildDownloadIncludePatterns`: a GGUF quant label picks the
 * matching quant artifact(s), a safetensors precision picks the repo's
 * safetensors artifact when the repo name declares it (or only the files whose
 * names carry it), `includeExtras` globs pick companions, and an empty
 * precision is the whole repo. Zero weight files -> 422 `filter_no_match` with
 * `details.suggestions`.
 */
function selectionFromLegacy({ precision = "", includeExtras = [], repo = "" } = {}, manifest) {
  const files = manifestFiles(manifest);
  const value = normalizeRemoteQuantFilter(precision);
  const label = value.replace(/^UD_/, "");
  const artifacts = listArtifacts(manifest, { includeIncomplete: true });
  const ggufArtifacts = artifacts.filter((artifact) => artifact.kind === "gguf-quant");
  const stArtifacts = artifacts.filter((artifact) => artifact.kind === "safetensors-full");

  const matchers = globMatchers(includeExtras);
  const companions = matchers.length
    ? Array.from(files.keys()).filter((filePath) => companionRoleOf(filePath)
      && matchers.some((re) => re.test(filePath) || re.test(baseOf(filePath)))).sort(compare)
    : [];

  const fromArtifacts = (picked) => {
    if (picked.length === 1) {
      return { artifactKey: picked[0].artifactKey, companions, files: null, acceptIncomplete: !picked[0].complete };
    }
    const paths = unique(picked.flatMap((artifact) => artifact.files.filter((file) => file.role === "weight").map((file) => file.path))).sort(compare);
    return { artifactKey: null, companions, files: paths, acceptIncomplete: true };
  };
  const wholeRepo = () => {
    const paths = Array.from(files.keys()).sort(compare);
    if (!paths.some((filePath) => WEIGHT_RE.test(filePath))) throw noMatchError("The repository contains no model weight file.", manifest, { precision: value });
    return { artifactKey: null, companions: [], files: paths, acceptIncomplete: true };
  };
  const none = () => noMatchError(`No file in this repository matches the requested precision${value ? ` "${value}"` : ""}.`, manifest, { precision: value });

  if (!value || value === "quantized") return wholeRepo();
  if (value === "GGUF") {
    const paths = Array.from(files.keys()).filter((filePath) => GGUF_RE.test(filePath)).sort(compare);
    if (!paths.length) throw none();
    return { artifactKey: null, companions: [], files: paths, acceptIncomplete: true };
  }
  if (SAFETENSORS_QUANT_VALUES.has(value)) {
    if (modelNameDeclares(repo || manifest?.repo, value)) {
      if (stArtifacts.length) return fromArtifacts(stArtifacts);
      return wholeRepo();
    }
    const named = Array.from(files.keys()).filter((filePath) => ST_WEIGHT_RE.test(filePath)
      && filePath.replace(/[-.\s]+/g, "_").toUpperCase().includes(value)).sort(compare);
    if (named.length) return { artifactKey: null, companions, files: named, acceptIncomplete: true };
  }
  const matches = legacyFamilyMatcher(label);
  const picked = ggufArtifacts.filter((artifact) => matches((artifact.quant || "").replace(/^UD-/, "")));
  if (picked.length) return fromArtifacts(picked);
  // A label that is not a quant at all ("BF16", "INT4") on a repo without GGUF
  // files was "download everything" before; keep that.
  if (!SAFETENSORS_QUANT_VALUES.has(value) && !/^I?Q\d/.test(value) && !ggufArtifacts.length) return wholeRepo();
  throw none();
}

function modelNameDeclares(repo, value) {
  const name = String(repo || "").trim().split("/").pop() || "";
  return name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).includes(value);
}

function fnmatchAny(regexps, filePath) {
  return regexps.some((re) => re.test(filePath));
}

function matchedSet(patterns, all, ignoreCase) {
  const regexps = patterns.map((pattern) => fnmatchToRegExp(pattern, { ignoreCase }));
  return new Set(all.filter((filePath) => fnmatchAny(regexps, filePath)));
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

// The CLI matches with `fnmatch.fnmatch`, which is case-insensitive on
// Windows, so a pattern list must be exact in both modes.
function patternsExact(patterns, all, selectedSet) {
  return [false, true].every((ignoreCase) => sameSet(matchedSet(patterns, all, ignoreCase), selectedSet));
}

function directoriesOf(filePath) {
  const result = [];
  let dir = dirOf(filePath);
  while (dir) {
    result.push(dir);
    dir = dirOf(dir);
  }
  return result;
}

function buildGreedyPatterns(selected, all, selectedSet) {
  const patterns = [];
  const coveredDirs = [];
  const underCovered = (filePath) => coveredDirs.some((dir) => filePath.startsWith(`${dir}/`));

  const candidateDirs = unique(selected.flatMap(directoriesOf))
    .sort((a, b) => a.split("/").length - b.split("/").length || compare(a, b));
  for (const dir of candidateDirs) {
    if (underCovered(`${dir}/x`)) continue;
    const below = all.filter((filePath) => filePath.startsWith(`${dir}/`));
    if (below.length >= 2 && below.every((filePath) => selectedSet.has(filePath))) {
      patterns.push(`${escapeFnmatch(dir)}/*`);
      coveredDirs.push(dir);
    }
  }

  const remaining = selected.filter((filePath) => !underCovered(filePath));
  const groups = new Map();
  for (const filePath of remaining) {
    if (!GGUF_RE.test(filePath)) continue;
    const quant = quantTagOf(baseOf(filePath));
    if (!quant) continue;
    const groupKey = `${dirOf(filePath)}|${quant}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { quant, directory: dirOf(filePath), files: [] });
    groups.get(groupKey).files.push(filePath);
  }
  const covered = new Set();
  for (const groupKey of Array.from(groups.keys()).sort(compare)) {
    const group = groups.get(groupKey);
    if (group.files.every((filePath) => covered.has(filePath))) continue;
    const candidates = [`*${escapeFnmatch(group.quant)}*.gguf`];
    if (group.directory) candidates.push(`${escapeFnmatch(group.directory)}/*${escapeFnmatch(group.quant)}*.gguf`);
    for (const candidate of candidates) {
      const re = fnmatchToRegExp(candidate);
      const re2 = fnmatchToRegExp(candidate, { ignoreCase: true });
      const matched = all.filter((filePath) => re.test(filePath));
      const matchedLoose = all.filter((filePath) => re2.test(filePath));
      if (group.files.every((filePath) => re.test(filePath))
        && matchedLoose.every((filePath) => selectedSet.has(filePath)) && matched.length) {
        patterns.push(candidate);
        for (const filePath of matched) covered.add(filePath);
        break;
      }
    }
  }
  for (const filePath of remaining) {
    if (!covered.has(filePath)) patterns.push(escapeFnmatch(filePath));
  }
  return patterns;
}

function batchPatterns(patterns, argvBudget) {
  const batches = [];
  let current = [];
  let used = 0;
  for (const pattern of patterns) {
    const cost = INCLUDE_ARG_OVERHEAD + pattern.length;
    if (current.length && used + cost > argvBudget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(pattern);
    used += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * compileIncludePatterns(selected, all, { argvBudget = 24000 }) ->
 * `{ mode: "all" }` (no `--include`) or `{ mode: "include", patterns, batches }`.
 * `selected` and `all` are paths (or objects with `path`). The patterns are
 * proven, with `fnmatchToRegExp`, to select exactly `selected` out of `all`;
 * otherwise exact escaped names are used, and a mismatch after that throws
 * `selection_compile_error`. `batches` split `patterns` so no command exceeds
 * `argvBudget` characters of `--include=PAT` arguments; they run sequentially.
 */
function compileIncludePatterns(selectedInput, allInput, { argvBudget = DEFAULT_ARGV_BUDGET } = {}) {
  const all = unique((Array.isArray(allInput) ? allInput : []).map(pathOf)).sort(compare);
  const selected = unique((Array.isArray(selectedInput) ? selectedInput : []).map(pathOf)).sort(compare);
  const allSet = new Set(all);
  const selectedSet = new Set(selected);
  const fail = (message, details) => new HubError("selection_compile_error", message, { status: 500, details });

  if (!selected.length) throw fail("The selection is empty.");
  const stray = selected.filter((filePath) => !allSet.has(filePath));
  if (stray.length) throw fail("The selection contains files that are not in the manifest.", { files: stray.slice(0, 10) });
  if (selected.length === all.length) return { mode: "all" };

  let patterns = buildGreedyPatterns(selected, all, selectedSet);
  if (!patternsExact(patterns, all, selectedSet)) {
    patterns = selected.map(escapeFnmatch);
    if (!patternsExact(patterns, all, selectedSet)) {
      throw fail("The include patterns do not select exactly the planned files.", { selected: selected.length });
    }
  }
  const budget = Math.max(1, Number(argvBudget) || DEFAULT_ARGV_BUDGET);
  return { mode: "include", patterns, batches: batchPatterns(patterns, budget) };
}

module.exports = {
  DEFAULT_ARGV_BUDGET,
  MAX_LOCAL_PATH,
  assertSafeRepoPath,
  compileIncludePatterns,
  listArtifacts,
  resolveSelection,
  selectionFromLegacy,
  unsafeReason,
};
