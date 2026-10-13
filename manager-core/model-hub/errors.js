"use strict";

// Download failure taxonomy. These codes are the platform's download-failure
// vocabulary: the hub (03) extends this table with derived codes whose
// baseCode is one of the codes below, and the retry policy and UI key on
// baseCode. Rules are checked in table order and the first match wins.
//
// The classifier is pure (no I/O). `text` is the tail of the failing
// attempt's log plus job.error; it never needs to see a token, and nothing
// it returns echoes the input text.

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

module.exports = {
  DOWNLOAD_ERROR_CODES,
  classifyDownloadFailure,
  describeDownloadError,
  formatDownloadErrorTitle,
  isDownloadErrorCode,
};
