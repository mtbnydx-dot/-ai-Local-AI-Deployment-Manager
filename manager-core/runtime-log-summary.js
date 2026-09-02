const { extractLogIssues } = require("./job-utils");
const { readDockerRuntimeLogs } = require("./runtime-request-utils");

async function summarizeDockerRuntimeLogs(options = {}) {
  const docker = options.docker;
  const containerName = options.containerName;
  if (typeof docker !== "function" || !containerName) {
    throw new Error("summarizeDockerRuntimeLogs requires docker and containerName.");
  }
  const text = await readDockerRuntimeLogs({
    docker,
    containerName,
    tail: options.tail,
    minTail: options.minTail || 40,
    maxTail: options.maxTail || 2000,
    defaultTail: 420,
    maxBuffer: Number(options.maxBuffer || 8 * 1024 * 1024),
  });
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const classifyIssue = typeof options.classifyIssue === "function" ? options.classifyIssue : defaultClassifyIssue;
  const issueHint = typeof options.issueHint === "function" ? options.issueHint : (() => "");
  const detectStage = typeof options.detectStage === "function" ? options.detectStage : defaultDetectStage;
  const buildSuggestions = typeof options.buildSuggestions === "function" ? options.buildSuggestions : defaultSuggestions;
  const issues = extractLogIssues(text).map((message) => ({
    severity: classifyIssue(message),
    message,
    hint: issueHint(message),
  }));
  const stage = detectStage(text);
  return {
    ok: !issues.some((item) => item.severity === "error"),
    generatedAt: new Date().toISOString(),
    stage,
    lineCount: lines.length,
    issues,
    recent: lines.slice(-Number(options.recentLines || 12)),
    suggestions: buildSuggestions(issues, stage),
  };
}

function defaultClassifyIssue(message) {
  return /out of memory|traceback|fatal|runtimeerror|failed|exception|cuda error/i.test(String(message || "")) ? "error" : "warn";
}

function defaultDetectStage(text) {
  if (!String(text || "").trim()) return "no container logs";
  if (/error|traceback|failed/i.test(text)) return "error";
  return "starting / waiting";
}

function defaultSuggestions(issues, stage) {
  if (!issues.length) return ["当前日志没有明显错误。"];
  if (stage !== "API ready") return ["打开日志页查看完整上下文，必要时用保守启动方案重试。"];
  return ["当前日志没有明显错误。"];
}

module.exports = {
  summarizeDockerRuntimeLogs,
};
