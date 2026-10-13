const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureDirs } = require("./file-utils");
const { isPortListening } = require("./network");

async function readPidFilePid(file) {
  try {
    const text = (await fs.readFile(file, "utf8")).trim();
    const pid = Number(text.split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function preparePidFile(pidFile, label = "manager") {
  await fs.mkdir(path.dirname(pidFile), { recursive: true });
  const pid = await readPidFilePid(pidFile);
  if (!pid) {
    await fs.unlink(pidFile).catch(() => {});
    return { removed: false, pid: null, stale: false };
  }
  if (pid !== process.pid && !isProcessAlive(pid)) {
    await fs.unlink(pidFile).catch(() => {});
    return { removed: true, pid, stale: true, label };
  }
  return { removed: false, pid, stale: false };
}

async function writePidFile(pidFile, pid = process.pid) {
  await fs.mkdir(path.dirname(pidFile), { recursive: true });
  await fs.writeFile(pidFile, `${pid}\n`, "utf8");
}

async function buildProcessHealth(options = {}) {
  const pidFilePid = options.pidFile ? await readPidFilePid(options.pidFile) : null;
  const portListening = options.port ? await isPortListening(options.host || "127.0.0.1", options.port, options.timeoutMs || 700) : null;
  return {
    ok: true,
    engine: options.engine || "",
    managerId: options.managerId || "",
    host: options.host || "127.0.0.1",
    port: Number(options.port || 0),
    currentPid: process.pid,
    pidFile: options.pidFile || "",
    pidFilePid,
    pidFileAlive: pidFilePid ? isProcessAlive(pidFilePid) : false,
    pidFileMatches: pidFilePid === process.pid,
    stalePidFile: Boolean(pidFilePid && pidFilePid !== process.pid && !isProcessAlive(pidFilePid)),
    portListening,
    uptimeSeconds: process.uptime(),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

// Remediation actions a health check can offer (08 P0-23). `actions` keeps
// the bare ids (must-keep); `actionDetails` describes each one for the UI.
// An "api" action is a request the UI may send itself, and only the routes
// in this allowlist qualify; a "command" action is text the user copies and
// runs. Anything else is dropped.
const HEALTH_API_ACTION_ALLOWLIST = Object.freeze(["POST /api/docker/start"]);

function healthActionDetail(id, options = {}) {
  if (id === "start-docker") {
    return { id, kind: "api", method: "POST", path: "/api/docker/start", label: { zh: "启动 Docker", en: "Start Docker" } };
  }
  if (id === "pull-image") {
    const image = String(options.image || "").trim();
    // local/ images are built on this machine and are never pulled.
    if (!image || /\s/.test(image) || /^local\//i.test(image)) return null;
    const platform = String(options.platform || "").trim();
    const platformArg = platform && !/\s/.test(platform) ? `--platform ${platform} ` : "";
    return { id, kind: "command", command: `docker pull ${platformArg}${image}`, label: { zh: "复制拉取命令", en: "Copy pull command" } };
  }
  if (id === "install-download-cli") {
    return {
      id,
      kind: "command",
      command: "install-download-cli.cmd",
      label: { zh: "安装下载工具：运行 install-download-cli.cmd", en: "Install the download tool: run install-download-cli.cmd" },
    };
  }
  return null;
}

function isAllowedHealthAction(detail) {
  if (!detail || typeof detail !== "object" || !detail.id || !detail.label) return false;
  if (detail.kind === "api") return HEALTH_API_ACTION_ALLOWLIST.includes(`${String(detail.method || "").toUpperCase()} ${detail.path}`);
  return detail.kind === "command" && typeof detail.command === "string" && detail.command.length > 0;
}

function healthActionDetails(ids = [], options = {}) {
  return (Array.isArray(ids) ? ids : [ids])
    .map((id) => healthActionDetail(id, options))
    .filter(isAllowedHealthAction);
}

// actionDetails is added only when there is one, so a check without
// remediation keeps its previous shape.
function healthCheck(id, label, status, detail, actions = [], actionDetails = []) {
  const check = { id, label, status, detail: String(detail || ""), actions };
  const details = (Array.isArray(actionDetails) ? actionDetails : []).filter(isAllowedHealthAction);
  if (details.length) check.actionDetails = details;
  return check;
}

async function directoryHealth(id, label, dir, options = {}) {
  const ensure = options.ensureDirs || ensureDirs;
  try {
    await ensure(dir);
    await fs.access(dir, fsSync.constants.R_OK | fsSync.constants.W_OK);
    return healthCheck(id, label, "ok", dir);
  } catch (error) {
    return healthCheck(id, label, "fail", `${dir}: ${error.message}`);
  }
}

// options.actionDetails are remediation steps, so they are attached only
// while the command is missing or failing.
async function commandHealth(id, label, command, args = ["--help"], options = {}) {
  const missingStatus = options.missingStatus || "fail";
  const execFileAsync = options.execFileAsync;
  const remediation = options.actionDetails || [];
  if (!command) return healthCheck(id, label, missingStatus, "未配置命令路径", [], remediation);
  if (typeof execFileAsync !== "function") return healthCheck(id, label, missingStatus, "execFileAsync is not configured", [], remediation);
  try {
    const out = await execFileAsync(command, args, { rejectOnError: false, timeout: options.timeout || 8000, maxBuffer: options.maxBuffer || 256 * 1024 });
    const text = `${out.stdout}${out.stderr}`.trim().split(/\r?\n/)[0] || command;
    return healthCheck(id, label, out.error ? "warn" : "ok", text, [], out.error ? remediation : []);
  } catch (error) {
    return healthCheck(id, label, missingStatus, error.message, [], remediation);
  }
}

function createHealthProbe(options = {}) {
  return {
    healthCheck,
    directoryHealth: (id, label, dir) => directoryHealth(id, label, dir, { ensureDirs: options.ensureDirs }),
    commandHealth: (id, label, command, args = ["--help"], missingStatus = "fail", actionDetails = []) => commandHealth(id, label, command, args, {
      execFileAsync: options.execFileAsync,
      missingStatus,
      actionDetails,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
    }),
  };
}

module.exports = {
  readPidFilePid,
  isProcessAlive,
  preparePidFile,
  writePidFile,
  buildProcessHealth,
  HEALTH_API_ACTION_ALLOWLIST,
  healthActionDetail,
  healthActionDetails,
  healthCheck,
  directoryHealth,
  commandHealth,
  createHealthProbe,
};
