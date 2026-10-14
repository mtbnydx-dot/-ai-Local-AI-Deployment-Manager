"use strict";

// Download failure taxonomy. These codes are the platform's download-failure
// vocabulary: the hub (03) extends this table with derived codes whose
// baseCode is one of the codes below, and the retry policy and UI key on
// baseCode. Rules are checked in table order and the first match wins.
//
// The classifier is pure (no I/O). `text` is the tail of the failing
// attempt's log plus job.error; it never needs to see a token, and nothing
// it returns echoes the input text.
//
// Everything from "Model hub extension" down is 03's (HUB-16): the transfer
// wrapper with its three refinements, the data file, the retry policy and
// the error class. It only adds to this module; the table above and its
// exports are 08's and stay as they are.

const fs = require("node:fs");
const path = require("node:path");
const { redactSecrets } = require("../secret-redactor");
const referenceData = require("../reference-data");

const RULES = [
  {
    code: "stall",
    retryable: true,
    title: { zh: "下载停滞", en: "Download stalled" },
    hint: { zh: "下载长时间无进度，已自动重试。", en: "No progress for a long time; retrying automatically." },
    match: ({ meta }) => meta.stalled === true,
  },
  {
    code: "verify_failed",
    retryable: true,
    title: { zh: "文件校验失败", en: "File verification failed" },
    hint: { zh: "文件校验失败，将重新下载受影响的文件。", en: "File verification failed; affected files will be downloaded again." },
    // The managers' own post-download checks report in these words.
    match: ({ meta, text }) => Boolean(meta.verifyFailed)
      || /Download verification failed|模型完整性校验失败|权重文件缺失/i.test(text),
  },
  {
    code: "checksum_mismatch",
    retryable: true,
    title: { zh: "文件校验和不一致", en: "Checksum mismatch" },
    hint: { zh: "文件校验失败，将重新下载受影响的文件。", en: "File verification failed; affected files will be downloaded again." },
    match: ({ text }) => /sha256 mismatch|checksum|Consistency check failed|SHA256 校验失败|SHA256 不符/i.test(text),
  },
  {
    code: "cli_missing",
    retryable: false,
    title: { zh: "未找到下载工具", en: "Download tool not found" },
    hint: { zh: "未找到下载工具，请运行 install-download-cli.cmd。", en: "Download tool not found. Run install-download-cli.cmd." },
    // Only a spawn ENOENT means the CLI is missing; a file ENOENT inside a
    // running download is a different failure.
    match: ({ error, errorCode, exitCode, text }) => (
      (errorCode === "ENOENT" && (!error?.syscall || /^spawn/i.test(String(error.syscall))))
      || errorCode === "download_cli_missing"
      || exitCode === 9009
      || exitCode === 127
      || /is not recognized as an internal or external command|command not found|\bspawn\b[^\n]*\bENOENT\b|CLI 未安装/i.test(text)
    ),
  },
  {
    code: "disk_full",
    retryable: false,
    title: { zh: "磁盘空间不足", en: "Disk full" },
    hint: { zh: "目标磁盘空间不足，请清理或换一个模型存储位置。", en: "The target disk is full. Free space or choose another model storage location." },
    match: ({ errorCode, text }) => errorCode === "ENOSPC"
      || errorCode === "download_disk_full"
      || /No space left on device|ENOSPC|not enough space on the disk|磁盘空间不足/i.test(text),
  },
  {
    code: "hf_approval_required",
    retryable: false,
    title: { zh: "需要申请访问权限", en: "Access approval required" },
    hint: { zh: "需要先在 Hugging Face 模型页申请访问权限并等待批准。", en: "Request access on the Hugging Face model page and wait for approval." },
    match: ({ text }) => /GatedRepoError|awaiting a review|is restricted|Cannot access gated repo|403 Client Error/i.test(text),
  },
  {
    code: "hf_auth_invalid",
    retryable: false,
    title: { zh: "Hugging Face Token 无效", en: "Invalid Hugging Face token" },
    hint: { zh: "Hugging Face Token 无效，请重新登录 hf 或填写新的 Token。", en: "The Hugging Face token is invalid. Log in to hf again or enter a new token." },
    // huggingface_hub raises RepositoryNotFoundError with a 401 status for
    // anonymous requests to missing repos; the exception class is the more
    // specific signal, so those fall through to repo_not_found.
    match: ({ text }) => /401 Client Error|Invalid (user )?token|invalid credentials/i.test(text)
      && !/RepositoryNotFoundError|RevisionNotFoundError|Repository Not Found/i.test(text),
  },
  {
    code: "hf_token_expired",
    retryable: false,
    title: { zh: "下载 Token 已失效", en: "Download token expired" },
    hint: {
      zh: "下载所需的 Token 已失效（管理器重启后不保留），请重新发起下载并填写 Token。",
      en: "The token for this download is gone (it is not kept across manager restarts). Start the download again and enter the token.",
    },
    // Raised by buildDownloadSpecFromJob when meta.transfer.tokenRef no longer
    // resolves (tokens are memory-only).
    match: ({ errorCode, meta }) => errorCode === "hf_token_expired" || meta.errorCode === "hf_token_expired",
  },
  {
    code: "repo_not_found",
    retryable: false,
    title: { zh: "仓库不存在", en: "Repository not found" },
    hint: { zh: "仓库不存在或无权查看，请检查模型 ID。", en: "Repository not found or not visible. Check the model id." },
    // The hub reports a missing revision with a 404 too; let the specific
    // exception class win.
    match: ({ text }) => /RepositoryNotFoundError|Repository Not Found|404 Client Error/i.test(text)
      && !/RevisionNotFoundError|Revision Not Found/i.test(text),
  },
  {
    code: "revision_not_found",
    retryable: false,
    title: { zh: "版本不存在", en: "Revision not found" },
    hint: { zh: "指定的版本不存在。", en: "The requested revision does not exist." },
    match: ({ text }) => /RevisionNotFoundError|Revision Not Found/i.test(text),
  },
  {
    code: "filter_no_match",
    retryable: false,
    title: { zh: "没有匹配的文件", en: "No matching files" },
    hint: {
      zh: "所选精度没有匹配的文件，请换一个精度或选择“原始仓库”。",
      en: "No files match the selected precision. Pick another precision or \"original repository\".",
    },
    match: ({ meta }) => meta.errorCode === "filter_no_match",
  },
  {
    code: "rate_limited",
    retryable: true,
    retryDelayFactor: 4,
    minRetryDelaySeconds: 120,
    title: { zh: "请求过于频繁", en: "Rate limited" },
    hint: { zh: "请求过于频繁，稍后自动重试。", en: "Rate limited; retrying later." },
    // A bare "429" would also match sizes such as "429 MB" in the managers'
    // own estimate line, so the status code only counts next to HTTP wording.
    match: ({ text }) => /\b429 Client Error|(?:HTTP|status)\D{0,16}\b429\b|Too Many Requests|rate[ -]?limit/i.test(text),
  },
  {
    code: "network_unreachable",
    retryable: true,
    title: { zh: "网络连接失败", en: "Network unreachable" },
    hint: { zh: "网络连接失败，将自动重试；若持续失败可开启/关闭镜像。", en: "Network error; retrying. If it keeps failing, toggle the mirror." },
    match: ({ errorCode, text }) => ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(errorCode)
      || /ConnectionError|ConnectTimeout|Max retries exceeded|getaddrinfo|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|SSLError|ReadTimeout|name resolution/i.test(text),
  },
  {
    code: "unknown",
    retryable: true,
    title: { zh: "下载失败", en: "Download failed" },
    hint: { zh: "下载失败，查看日志了解详情。", en: "Download failed. See the log for details." },
    match: () => true,
  },
];

const RULES_BY_CODE = new Map(RULES.map((rule) => [rule.code, rule]));
const DOWNLOAD_ERROR_CODES = Object.freeze(RULES.map((rule) => rule.code));

function describeRule(rule) {
  return {
    code: rule.code,
    baseCode: rule.code,
    retryable: rule.retryable,
    retryDelayFactor: rule.retryDelayFactor || 1,
    minRetryDelaySeconds: rule.minRetryDelaySeconds || 0,
    title: { ...rule.title },
    hint: { ...rule.hint },
  };
}

/** Table entry for a known code; unknown codes describe as `unknown`. */
function describeDownloadError(code) {
  return describeRule(RULES_BY_CODE.get(String(code || "")) || RULES_BY_CODE.get("unknown"));
}

function isDownloadErrorCode(code) {
  return RULES_BY_CODE.has(String(code || ""));
}

/** @returns {{ code, baseCode, retryable, retryDelayFactor, minRetryDelaySeconds, title:{zh,en}, hint:{zh,en} }}
 *  baseCode === code for every P0 code; 03 adds derived codes whose baseCode is a P0 code. */
function classifyDownloadFailure({ text = "", exitCode = null, error = null, meta = {} } = {}) {
  const errorMessage = error && typeof error === "object" ? String(error.message || "") : "";
  const input = {
    text: [String(text || ""), errorMessage].filter(Boolean).join("\n"),
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    error: error && typeof error === "object" ? error : null,
    errorCode: error && typeof error === "object" && error.code != null ? String(error.code) : "",
    meta: meta && typeof meta === "object" ? meta : {},
  };
  return describeRule(RULES.find((rule) => rule.match(input)));
}

/** Single "<zh> / <en>" string, the form the legacy UIs render as is. */
function formatDownloadErrorTitle(result) {
  const title = result?.title || describeDownloadError("unknown").title;
  return `${title.zh} / ${title.en}`;
}


// ---------------------------------------------------------------------------
// Model hub extension (03 §6.3)
// ---------------------------------------------------------------------------

// Each refinement is a narrower case of exactly one 08 code. The set and the
// bases are fixed here; the data file can only change matchers and copy.
const HUB_REFINEMENT_BASES = Object.freeze({
  network_timeout: "network_unreachable",
  hf_login_required: "hf_auth_invalid",
  transfer_empty: "filter_no_match",
});
const HUB_REFINEMENT_CODES = Object.freeze(Object.keys(HUB_REFINEMENT_BASES));
const HUB_ERROR_CODES = Object.freeze([...DOWNLOAD_ERROR_CODES, ...HUB_REFINEMENT_CODES]);

// What the UI offers next, by code (the action ids of 03 §6.3 / §19).
const HUB_ERROR_ACTIONS = Object.freeze({
  stall: Object.freeze(["resume", "switch-source"]),
  verify_failed: Object.freeze(["retry"]),
  checksum_mismatch: Object.freeze(["retry"]),
  cli_missing: Object.freeze(["install-cli"]),
  disk_full: Object.freeze(["free-space", "choose-root"]),
  hf_approval_required: Object.freeze(["open-approval"]),
  hf_auth_invalid: Object.freeze(["sign-in"]),
  hf_token_expired: Object.freeze(["enter-token"]),
  repo_not_found: Object.freeze(["check-id"]),
  revision_not_found: Object.freeze(["check-id"]),
  filter_no_match: Object.freeze(["pick-artifact"]),
  rate_limited: Object.freeze([]),
  network_unreachable: Object.freeze(["switch-source"]),
  unknown: Object.freeze(["view-log"]),
  network_timeout: Object.freeze(["switch-source"]),
  hf_login_required: Object.freeze(["sign-in"]),
  transfer_empty: Object.freeze(["view-log", "pick-artifact"]),
});

// HTTP status of each code in the 00 §4.2 envelope.
const HUB_ERROR_STATUS = Object.freeze({
  hf_approval_required: 403,
  hf_auth_invalid: 401,
  hf_login_required: 401,
  hf_token_expired: 409,
  repo_not_found: 404,
  revision_not_found: 404,
  filter_no_match: 422,
  transfer_empty: 422,
  rate_limited: 429,
  network_unreachable: 502,
  network_timeout: 504,
  disk_full: 507,
  cli_missing: 503,
});

const TRANSFER_ERRORS_FILE = "hub-transfer-errors.json";
const TRANSFER_ERRORS_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ATTEMPTS = 3;
const STDERR_LINES_FOR_CLASSIFIER = 60;
const MAX_PATTERN_LENGTH = 400;
const MAX_DETAIL_LENGTH = 300;
const JITTER = 0.2;
const REMEDY_KEYS = Object.freeze({ xet: ["high-performance", "default", "off"] });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isBilingual(value) {
  return isPlainObject(value) && nonEmptyString(value.zh) && nonEmptyString(value.en);
}

function compilePattern(source) {
  if (!nonEmptyString(source) || source.length > MAX_PATTERN_LENGTH) return null;
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

function shortValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const one = String(text === undefined ? "" : text).replace(/\s+/g, " ");
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

// --- the data file ---------------------------------------------------------

function whenIssue(when, allowed) {
  if (!isPlainObject(when)) return "when must be an object";
  for (const key of Object.keys(when)) {
    if (!allowed.includes(key)) return `when.${key} is not supported`;
  }
  if (when.text !== undefined && !compilePattern(when.text)) return "when.text is not a valid pattern";
  if (when.credentialMode !== undefined
    && !(Array.isArray(when.credentialMode) && when.credentialMode.length && when.credentialMode.every(nonEmptyString))) {
    return "when.credentialMode must be a list of names";
  }
  if (when.cachedToken !== undefined && typeof when.cachedToken !== "boolean") return "when.cachedToken must be true or false";
  if (when.signal !== undefined && !(nonEmptyString(when.signal) && /^[A-Za-z][A-Za-z0-9]*$/.test(when.signal))) return "when.signal must be a signal name";
  return "";
}

// Returns "" for a valid entry, otherwise the reason it is dropped.
function sectionEntryIssue(section, entry) {
  if (!isPlainObject(entry)) return "the entry must be an object";
  if (section === "patterns") {
    if (!isDownloadErrorCode(entry.code)) return `"${shortValue(entry.code)}" is not a download error code`;
    return compilePattern(entry.match) ? "" : "match is not a valid pattern";
  }
  if (section === "remedies") {
    if (!isDownloadErrorCode(entry.code)) return `"${shortValue(entry.code)}" is not a download error code`;
    const issue = whenIssue(entry.when, ["text"]);
    if (issue) return issue;
    if (!entry.when.text) return "when.text is required";
    if (!isPlainObject(entry.set) || !Object.keys(entry.set).length) return "set must name the options to change";
    for (const [key, value] of Object.entries(entry.set)) {
      if (!REMEDY_KEYS[key] || !REMEDY_KEYS[key].includes(value)) return `set.${key} is not a supported option change`;
    }
    if (!Number.isInteger(entry.maxTimes) || entry.maxTimes < 1 || entry.maxTimes > 5) return "maxTimes must be an integer from 1 to 5";
    return "";
  }
  if (section === "refinements") {
    if (!HUB_REFINEMENT_CODES.includes(entry.code)) return `"${shortValue(entry.code)}" is not a hub refinement code`;
    if (entry.base !== HUB_REFINEMENT_BASES[entry.code]) return `${entry.code} refines ${HUB_REFINEMENT_BASES[entry.code]}, not "${shortValue(entry.base)}"`;
    const issue = whenIssue(entry.when, ["text", "credentialMode", "cachedToken", "signal"]);
    if (issue) return issue;
    if (!Object.keys(entry.when).length) return "when must name at least one condition";
    if (typeof entry.retryable !== "boolean") return "retryable must be true or false";
    if (!isBilingual(entry.title)) return "title needs zh and en text";
    if (!isBilingual(entry.hint)) return "hint needs zh and en text";
    return "";
  }
  return "unknown section";
}

function keyedEntryIssue(section, key, value) {
  if (!isDownloadErrorCode(key)) return `"${shortValue(key)}" is not a download error code`;
  if (section === "classes") return /^[a-z][a-z_]*$/.test(String(value)) ? "" : "the class must be a lower-case name";
  return Number.isInteger(value) && value >= 0 && value <= 10 ? "" : "the cap must be an integer from 0 to 10";
}

function mergeRefinement(base, override) {
  if (!base) return override;
  return {
    ...base,
    ...override,
    when: isPlainObject(override.when) ? { ...(base.when || {}), ...override.when } : base.when,
    title: isPlainObject(override.title) ? { ...base.title, ...override.title } : base.title,
    hint: isPlainObject(override.hint) ? { ...base.hint, ...override.hint } : base.hint,
  };
}

function orderRefinements(list) {
  return HUB_REFINEMENT_CODES.map((code) => list.find((entry) => entry.code === code)).filter(Boolean);
}

// Folds one document into `state` entry by entry. An invalid entry is
// dropped on its own (an invalid override entry leaves the bundled one in
// place) and reported; the rest of the document still applies.
function applyDocument(state, document, { file, label, errors }) {
  const report = (code, message) => errors.push({ file, name: TRANSFER_ERRORS_FILE, code, message: `${label}: ${message}` });
  for (const section of ["classes", "maxAttempts"]) {
    if (document[section] === undefined) continue;
    if (!isPlainObject(document[section])) {
      report("invalid_entry", `${section} must be an object; it was ignored.`);
      continue;
    }
    for (const [key, value] of Object.entries(document[section])) {
      const issue = keyedEntryIssue(section, key, value);
      if (issue) {
        report(isDownloadErrorCode(key) ? "invalid_entry" : "unknown_code", `${section}.${shortValue(key)}: ${issue}; the entry was dropped.`);
      } else {
        state[section][key] = value;
      }
    }
  }
  for (const section of ["patterns", "refinements", "remedies"]) {
    if (document[section] === undefined) continue;
    if (!Array.isArray(document[section])) {
      report("invalid_entry", `${section} must be a list; it was ignored.`);
      continue;
    }
    const accepted = [];
    document[section].forEach((raw, index) => {
      const entry = section === "refinements" && isPlainObject(raw)
        ? mergeRefinement(state.refinements.find((item) => item.code === raw.code), raw)
        : raw;
      const issue = sectionEntryIssue(section, entry);
      if (issue) {
        const unknownCode = isPlainObject(raw) && nonEmptyString(raw.code)
          && !(section === "refinements" ? HUB_REFINEMENT_CODES : DOWNLOAD_ERROR_CODES).includes(raw.code);
        report(unknownCode ? "unknown_code" : "invalid_entry", `${section}[${index}]: ${issue}; the entry was dropped.`);
      } else {
        accepted.push(entry);
      }
    });
    // A later document replaces the earlier entries that have the same code.
    const codes = new Set(accepted.map((entry) => entry.code));
    const kept = state[section].filter((entry) => !codes.has(entry.code));
    state[section] = section === "refinements" ? orderRefinements([...kept, ...accepted]) : [...kept, ...accepted];
  }
}

function readJsonDocument(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { error: { code: "unreadable", message: `${path.basename(file)} could not be read.` } };
  }
  if (!text.trim()) return { error: { code: "corrupt", message: `${path.basename(file)} is empty.` } };
  try {
    const value = JSON.parse(text);
    if (!isPlainObject(value)) return { error: { code: "corrupt", message: `${path.basename(file)} must hold a JSON object.` } };
    return { value };
  } catch {
    return { error: { code: "corrupt", message: `${path.basename(file)} is not valid JSON.` } };
  }
}

/**
 * Loads the bundled data file and the optional user override
 * (<AI_ROOT>/config/hub-transfer-errors.json, or AI_REFERENCE_DATA_DIR as for
 * the other reference tables), merged by code. Never throws: an entry that
 * does not validate is dropped and reported in `errors[]` (the shape of
 * /api/hub/status `dataErrors[]`).
 * @returns {{ data, errors: Array<{file,name,code,message}>, freshness, bundledPath, userPath, source }}
 */
function loadTransferErrorData({ bundledDir, userDir, now } = {}) {
  const bundledPath = path.join(bundledDir || referenceData.BUNDLED_DIR, TRANSFER_ERRORS_FILE);
  const userPath = path.join(userDir || referenceData.userDataDir(), TRANSFER_ERRORS_FILE);
  const errors = [];
  const state = { classes: {}, maxAttempts: {}, patterns: [], refinements: [], remedies: [] };
  let meta = {};
  let source = "bundled";

  const documents = [
    { file: bundledPath, label: "bundled data" },
    { file: userPath, label: "override" },
  ];
  for (const { file, label } of documents) {
    const read = readJsonDocument(file);
    if (read.missing) continue;
    if (read.error) {
      errors.push({ file, name: TRANSFER_ERRORS_FILE, code: read.error.code, message: `${label}: ${read.error.message}` });
      continue;
    }
    if (read.value.schemaVersion !== TRANSFER_ERRORS_SCHEMA_VERSION) {
      errors.push({ file, name: TRANSFER_ERRORS_FILE, code: "unsupported_schema", message: `${label}: schemaVersion must be ${TRANSFER_ERRORS_SCHEMA_VERSION}; the file was ignored.` });
      continue;
    }
    applyDocument(state, read.value, { file, label, errors });
    if (label === "override") source = "user";
    if (nonEmptyString(read.value.asOf) || read.value.staleAfterDays !== undefined) {
      meta = { asOf: read.value.asOf ?? meta.asOf, staleAfterDays: read.value.staleAfterDays ?? meta.staleAfterDays };
    }
  }

  const data = {
    schemaVersion: TRANSFER_ERRORS_SCHEMA_VERSION,
    asOf: meta.asOf || "",
    staleAfterDays: Number(meta.staleAfterDays) > 0 ? Number(meta.staleAfterDays) : null,
    classes: state.classes,
    maxAttempts: state.maxAttempts,
    patterns: state.patterns.map((entry) => ({ code: entry.code, match: entry.match, re: compilePattern(entry.match) })),
    refinements: state.refinements.map((entry) => ({
      code: entry.code,
      base: entry.base,
      retryable: entry.retryable,
      title: { ...entry.title },
      hint: { ...entry.hint },
      when: {
        ...entry.when,
        ...(entry.when.text ? { textRe: compilePattern(entry.when.text) } : {}),
      },
    })),
    remedies: state.remedies.map((entry) => ({
      code: entry.code,
      set: { ...entry.set },
      maxTimes: entry.maxTimes,
      when: { text: entry.when.text, textRe: compilePattern(entry.when.text) },
    })),
  };
  return { data, errors, freshness: referenceData.describeFreshness(data, now), bundledPath, userPath, source };
}

let dataCache = null;

/** The loaded data for callers that do not carry their own (cached). */
function getTransferErrorData({ force = false, ...options } = {}) {
  if (!dataCache || force) dataCache = loadTransferErrorData(options);
  return dataCache.data;
}

function clearTransferErrorDataCache() {
  dataCache = null;
}

// --- descriptions ----------------------------------------------------------

function classOf(data, baseCode) {
  return data?.classes?.[baseCode] || "unknown";
}

/** Table entry for any hub code: an 08 code or one of the refinements. */
function describeHubError(code, data = getTransferErrorData()) {
  const refinement = (data?.refinements || []).find((entry) => entry.code === String(code || ""));
  if (refinement) {
    const base = describeDownloadError(refinement.base);
    return {
      ...base,
      code: refinement.code,
      baseCode: refinement.base,
      retryable: refinement.retryable,
      title: { ...refinement.title },
      hint: { ...refinement.hint },
      class: classOf(data, refinement.base),
      actions: [...HUB_ERROR_ACTIONS[refinement.code]],
    };
  }
  const entry = describeDownloadError(code);
  return { ...entry, class: classOf(data, entry.baseCode), actions: [...(HUB_ERROR_ACTIONS[entry.code] || [])] };
}

function maxAttemptsFor(data, code, baseCode, retryable) {
  if (!retryable) return 0;
  const cap = data?.maxAttempts?.[code] ?? data?.maxAttempts?.[baseCode];
  return Number.isInteger(cap) ? cap : DEFAULT_MAX_ATTEMPTS;
}

// --- the transfer wrapper --------------------------------------------------

function tailLines(stderrTail, count) {
  let lines;
  if (Array.isArray(stderrTail)) lines = stderrTail.map((line) => String(line ?? ""));
  else if (typeof stderrTail === "string") lines = stderrTail.split(/\r?\n/);
  else lines = [];
  return lines.slice(-count);
}

function refinementApplies(entry, context) {
  const { when } = entry;
  if (when.textRe && !when.textRe.test(context.text)) return false;
  if (when.credentialMode && !when.credentialMode.includes(context.credentialMode)) return false;
  if (when.cachedToken !== undefined && context.cachedToken !== when.cachedToken) return false;
  if (when.signal && !context.signals[when.signal]) return false;
  return true;
}

// The last line (from the end) that explains the failure: it classifies, on
// its own, to the 08 code the failure ended up with, or matches the pattern
// or refinement that chose it.
function findDetailLine(lines, { baseCode, patternEntry, refinement }) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (patternEntry?.re?.test(line)) return line;
    if (refinement?.when?.textRe?.test(line)) return line;
    if (baseCode !== "unknown" && classifyDownloadFailure({ text: line }).code === baseCode) return line;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) return lines[index];
  }
  return "";
}

function parseRetryAfter(text) {
  const match = /Retry-After["']?\s*[:=]\s*["']?(\d{1,6})\b/i.exec(text);
  return match ? Number(match[1]) : null;
}

function intersects(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const set = new Set(b.map(String));
  return a.some((item) => set.has(String(item)));
}

/**
 * Classifies a failed transfer attempt (03 §6.3). 08's classifier supplies
 * the code, retryability and copy; the hub data adds the class, caps, extra
 * patterns for `unknown`, the three refinements and the option remedy.
 * Pure: the data comes from `options.data` (default: the bundled file plus
 * the override). `detail` is the last matching stderr line, redacted.
 * @returns {{ code, baseCode, class, retryable, retryDelayFactor, minRetryDelaySeconds, retryAfterSeconds,
 *   title:{zh,en}, hint:{zh,en}, actions: string[], detail: string,
 *   retry: { auto: boolean, maxAttempts: number }, remedy: null|{code,set,maxTimes} }}
 */
function classifyTransferFailure(input = {}, options = {}) {
  const data = options.data || getTransferErrorData();
  const job = isPlainObject(input.job) ? input.job : {};
  const signals = isPlainObject(input.signals) ? input.signals : {};
  const lines = tailLines(input.stderrTail, STDERR_LINES_FOR_CLASSIFIER);
  const text = lines.join("\n");

  // The 60 s resolving-step timeout has no stderr; it is a timed-out connection.
  let spawnError = input.spawnError || null;
  if (!spawnError && signals.resolveTimeout) {
    spawnError = Object.assign(new Error("ETIMEDOUT: the resolving step timed out after 60 s"), { code: "ETIMEDOUT" });
  }
  const errorMessage = spawnError && typeof spawnError === "object" ? String(spawnError.message || "") : "";

  const base = classifyDownloadFailure({
    text,
    exitCode: input.exitCode,
    error: spawnError,
    meta: {
      stalled: signals.stalled,
      verifyFailed: signals.verifyFailed,
      transfer: { tokenRef: job.transfer?.tokenRef ?? null },
      errorCode: signals.errorCode,
    },
  });

  let baseCode = base.code;
  let patternEntry = null;
  // HF codes cannot come from ModelScope, so there its 401/403 text is looked
  // at again (03 §6.3: the pattern maps them to repo_not_found).
  const reconsider = baseCode === "unknown"
    || (input.source === "modelscope" && (baseCode === "hf_approval_required" || baseCode === "hf_auth_invalid"));
  if (reconsider) {
    patternEntry = (data.patterns || []).find((entry) => entry.re && entry.re.test(text)) || null;
    if (patternEntry) baseCode = patternEntry.code;
  }
  const baseDescription = baseCode === base.code ? base : describeDownloadError(baseCode);

  const fullText = errorMessage ? `${text}\n${errorMessage}` : text;
  const context = {
    text: fullText,
    signals,
    credentialMode: signals.credentialMode ?? job.transfer?.credentialMode,
    cachedToken: signals.cachedToken ?? job.transfer?.cachedToken,
  };
  const refinement = (data.refinements || []).find((entry) => entry.base === baseCode && refinementApplies(entry, context)) || null;

  const code = refinement ? refinement.code : baseCode;
  let retryable = refinement ? refinement.retryable : baseDescription.retryable;
  // The same file failing its checksum twice will not be fixed by a third download.
  if (code === "checksum_mismatch"
    && intersects(signals.badFiles, signals.previousBadFiles ?? job.retry?.badFiles)) {
    retryable = false;
  }
  const maxAttempts = maxAttemptsFor(data, code, baseCode, retryable);

  const matched = findDetailLine(lines, { baseCode, patternEntry, refinement });
  const detail = redactSecrets(String(matched || errorMessage).trim().slice(0, MAX_DETAIL_LENGTH), { secrets: signals.secrets });

  const remedyEntry = (data.remedies || []).find((entry) => entry.code === baseCode && entry.when.textRe?.test(fullText)) || null;

  return {
    code,
    baseCode,
    class: classOf(data, baseCode),
    retryable,
    retryDelayFactor: baseDescription.retryDelayFactor,
    minRetryDelaySeconds: baseDescription.minRetryDelaySeconds,
    retryAfterSeconds: parseRetryAfter(text),
    title: refinement ? { ...refinement.title } : { ...baseDescription.title },
    hint: refinement ? { ...refinement.hint } : { ...baseDescription.hint },
    actions: [...(HUB_ERROR_ACTIONS[code] || [])],
    detail,
    retry: { auto: retryable && maxAttempts > 0, maxAttempts },
    remedy: remedyEntry ? { code: remedyEntry.code, set: { ...remedyEntry.set }, maxTimes: remedyEntry.maxTimes } : null,
  };
}

// --- retry policy ----------------------------------------------------------

function settingAt(settings, key, fallback) {
  if (isPlainObject(settings) && Object.hasOwn(settings, key)) return settings[key];
  let current = settings;
  for (const segment of key.split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return fallback;
    current = current[segment];
  }
  return current === undefined ? fallback : current;
}

function numberSetting(settings, key, fallback) {
  const value = Number(settingAt(settings, key, fallback));
  return Number.isFinite(value) ? value : fallback;
}

/** `min(maxDelay, base * 2^(attempt-1)) * factor`, with +-20 % jitter, in seconds. */
function backoffSeconds({ attempt, baseDelaySeconds = 10, maxDelaySeconds = 600, retryDelayFactor = 1, random = Math.random }) {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const capped = Math.min(maxDelaySeconds, baseDelaySeconds * 2 ** Math.min(exponent, 30));
  const jitter = 1 + (random() * 2 - 1) * JITTER;
  return capped * (retryDelayFactor || 1) * jitter;
}

function remedyFor(error, job, attempt) {
  const remedy = error.remedy;
  if (!remedy || !isPlainObject(remedy.set)) return null;
  const key = Object.keys(remedy.set)[0];
  const reason = `${remedy.code}/${key}`;
  const history = Array.isArray(job.transfer?.optionsHistory) ? job.transfer.optionsHistory : [];
  const applied = history.filter((entry) => entry?.reason === reason).length;
  if (applied >= (remedy.maxTimes || 1)) return null;
  if (Object.entries(remedy.set).every(([name, value]) => job.transfer?.[name] === value)) return null;
  return { reason, set: { ...remedy.set }, attempt };
}

/**
 * Decides whether a failed attempt is retried automatically (03 §6.3).
 * `error` is a classifyTransferFailure result or a HubError; `job.retry`
 * carries `{ count }`; `settings` is the hub settings. A setting can only
 * switch retries off or shorten them: a code that 08 or a refinement marks
 * non-retryable never retries, whatever the settings say.
 * @returns {{ retry: boolean, reason: string, code: string, class: string, attempt: number, max: number,
 *   delayMs: number, nextAt: string|null, remedy: null|{reason,set,attempt} }}
 */
function retryDecision(error, job = {}, settings = {}, options = {}) {
  const data = options.data || getTransferErrorData();
  const failure = error && typeof error === "object" ? error : {};
  const jobState = isPlainObject(job) ? job : {};
  const code = String(failure.code || "unknown");
  const described = describeHubError(code, data);
  const baseCode = String(failure.baseCode || described.baseCode);
  const retryable = typeof failure.retryable === "boolean" ? failure.retryable : described.retryable;
  const errorClass = String(failure.class || classOf(data, baseCode));
  const attempt = Math.max(0, Number(jobState.retry?.count) || 0) + 1;

  const settingsMax = Math.max(0, Math.min(10, Math.floor(numberSetting(settings, "retry.maxAttempts", DEFAULT_MAX_ATTEMPTS))));
  let max = Math.min(settingsMax, maxAttemptsFor(data, code, baseCode, retryable));
  const result = (retry, reason, extra = {}) => ({
    retry,
    reason,
    code,
    class: errorClass,
    attempt,
    max,
    delayMs: 0,
    nextAt: null,
    remedy: null,
    ...extra,
  });

  if (!retryable) return result(false, "not_retryable");
  if (settingsMax === 0) return result(false, "disabled");
  const classSwitch = settingAt(settings, `retry.perClass.${errorClass}`, true);
  if (classSwitch === false) return result(false, "class_disabled");
  if (classSwitch === "once") max = Math.min(max, 1);
  if (attempt > max) return result(false, "exhausted");

  const seconds = backoffSeconds({
    attempt,
    baseDelaySeconds: numberSetting(settings, "retry.baseDelaySeconds", 10),
    maxDelaySeconds: numberSetting(settings, "retry.maxDelaySeconds", 600),
    retryDelayFactor: Number(failure.retryDelayFactor) || described.retryDelayFactor || 1,
    random: typeof options.random === "function" ? options.random : Math.random,
  });
  const floor = Number(failure.minRetryDelaySeconds ?? described.minRetryDelaySeconds) || 0;
  const retryAfter = Number(options.retryAfterSeconds ?? failure.retryAfterSeconds) || 0;
  const delayMs = Math.round(Math.max(seconds, floor, retryAfter) * 1000);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return result(true, "retry", {
    delayMs,
    nextAt: new Date(now + delayMs).toISOString(),
    remedy: remedyFor(failure, jobState, attempt),
  });
}

// --- the error class and the envelope --------------------------------------

function describeKnownCode(code) {
  return HUB_ERROR_CODES.includes(code) ? describeHubError(code) : null;
}

/** An error that carries a hub code; route code turns it into the 00 §4.2 envelope. */
class HubError extends Error {
  constructor(code, message, { status, hint, details, cause, retryable } = {}) {
    super(String(message || describeKnownCode(code)?.title.en || code), cause ? { cause } : undefined);
    this.name = "HubError";
    this.code = String(code || "unknown");
    this.status = Number.isInteger(status) ? status : (HUB_ERROR_STATUS[this.code] || 500);
    if (hint !== undefined) this.hint = hint;
    if (details !== undefined) this.details = details;
    if (typeof retryable === "boolean") this.retryable = retryable;
  }

  /** From a classifyTransferFailure result. */
  static fromFailure(failure, options = {}) {
    return new HubError(failure.code, failure.title.en, {
      status: options.status,
      hint: failure.hint.en,
      retryable: failure.retryable,
      details: {
        baseCode: failure.baseCode,
        class: failure.class,
        retryable: failure.retryable,
        actions: [...failure.actions],
        title: { ...failure.title },
        hint: { ...failure.hint },
        ...(failure.detail ? { detail: failure.detail } : {}),
      },
    });
  }
}

/**
 * `{ status, body }` for any failure. `body` is the 00 §4.2 envelope
 * `{ ok: false, error: { code, message, hint?, details? } }` with message and
 * hint redacted; `status` is the HTTP status.
 */
function toEnvelope(err) {
  const source = err && typeof err === "object" ? err : { message: String(err ?? "") };
  const code = String(source.code || "unknown");
  const known = describeKnownCode(code);
  const message = String(source.message || source.title?.en || known?.title.en || "The operation failed.");
  const hint = typeof source.hint === "string" ? source.hint : (source.hint?.en || known?.hint.en || "");
  const status = Number.isInteger(source.status) ? source.status : (HUB_ERROR_STATUS[code] || 500);
  const error = { code, message: redactSecrets(message) };
  if (hint) error.hint = redactSecrets(String(hint));
  if (source.details !== undefined) {
    error.details = source.details;
  } else if (known && source.title) {
    error.details = { baseCode: source.baseCode, class: source.class, actions: source.actions, title: source.title, hint: source.hint };
  }
  return { status, body: { ok: false, error } };
}

module.exports = {
  DOWNLOAD_ERROR_CODES,
  HUB_ERROR_ACTIONS,
  HUB_ERROR_CODES,
  HUB_ERROR_STATUS,
  HUB_REFINEMENT_BASES,
  HUB_REFINEMENT_CODES,
  HubError,
  TRANSFER_ERRORS_FILE,
  backoffSeconds,
  classifyDownloadFailure,
  classifyTransferFailure,
  clearTransferErrorDataCache,
  describeDownloadError,
  describeHubError,
  formatDownloadErrorTitle,
  getTransferErrorData,
  isDownloadErrorCode,
  loadTransferErrorData,
  retryDecision,
  toEnvelope,
};
