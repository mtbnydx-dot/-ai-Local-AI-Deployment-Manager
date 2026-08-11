const COMPATIBILITY_SEVERITY_RANK = {
  ok: 0,
  info: 1,
  warn: 2,
  fail: 3,
};

const MODEL_REPO_PATTERN = /^[\w.-]+\/[\w.-]+/;

function normalizeCompatibilitySeverity(value) {
  const severity = String(value || "info").trim().toLowerCase();
  return Object.hasOwn(COMPATIBILITY_SEVERITY_RANK, severity) ? severity : "info";
}

function compatibilityFinding(severity, title, detail) {
  return {
    severity: normalizeCompatibilitySeverity(severity),
    title: String(title || ""),
    detail: String(detail || ""),
  };
}

function summarizeCompatibilityFindings(findings = []) {
  const worst = (Array.isArray(findings) ? findings : []).reduce((current, item) => {
    const severity = normalizeCompatibilitySeverity(item?.severity);
    return COMPATIBILITY_SEVERITY_RANK[severity] > COMPATIBILITY_SEVERITY_RANK[current] ? severity : current;
  }, "ok");
  return {
    ok: worst !== "fail",
    severity: worst,
  };
}

function buildCompatibilityReport(options = {}) {
  const summary = summarizeCompatibilityFindings(options.findings);
  return {
    ok: summary.ok,
    severity: summary.severity,
    model: String(options.model || ""),
    generatedAt: options.generatedAt || new Date().toISOString(),
    findings: Array.isArray(options.findings) ? options.findings : [],
    recommendations: options.recommendations || {},
    remote: options.remote || null,
  };
}

async function fetchRemoteCompatibilityInfo(options = {}) {
  const model = String(options.model || "").trim();
  const local = options.local || null;
  const remoteEnabled = options.remoteEnabled !== false;
  const findings = Array.isArray(options.findings) ? options.findings : [];
  const makeFinding = options.makeFinding || compatibilityFinding;
  if (local || !remoteEnabled || !MODEL_REPO_PATTERN.test(model) || typeof options.getHuggingFaceModelInfo !== "function") {
    return null;
  }
  const modelInfoId = String(options.modelInfoId || model).trim();
  const remote = await options.getHuggingFaceModelInfo(modelInfoId).catch((error) => ({ error: error.message }));
  if (remote?.error) {
    findings.push(makeFinding("warn", "远程元数据未取到", remote.error));
    return remote;
  }
  findings.push(makeFinding("ok", "Hugging Face 元数据可用", `${remote.label || model} · ${remote.lastModified || ""}`));
  if (remote.gated) findings.push(makeFinding("warn", "gated 模型", "下载和启动前需要配置 HF_TOKEN。"));
  if (typeof options.onInfo === "function") {
    await options.onInfo(remote, findings);
  }
  return remote;
}

module.exports = {
  COMPATIBILITY_SEVERITY_RANK,
  compatibilityFinding,
  summarizeCompatibilityFindings,
  buildCompatibilityReport,
  fetchRemoteCompatibilityInfo,
};
