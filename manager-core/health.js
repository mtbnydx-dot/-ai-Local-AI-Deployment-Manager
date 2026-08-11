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

function healthCheck(id, label, status, detail, actions = []) {
  return { id, label, status, detail: String(detail || ""), actions };
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

async function commandHealth(id, label, command, args = ["--help"], options = {}) {
  const missingStatus = options.missingStatus || "fail";
  const execFileAsync = options.execFileAsync;
  if (!command) return healthCheck(id, label, missingStatus, "未配置命令路径");
  if (typeof execFileAsync !== "function") return healthCheck(id, label, missingStatus, "execFileAsync is not configured");
  try {
    const out = await execFileAsync(command, args, { rejectOnError: false, timeout: options.timeout || 8000, maxBuffer: options.maxBuffer || 256 * 1024 });
    const text = `${out.stdout}${out.stderr}`.trim().split(/\r?\n/)[0] || command;
    return healthCheck(id, label, out.error ? "warn" : "ok", text);
  } catch (error) {
    return healthCheck(id, label, missingStatus, error.message);
  }
}

function createHealthProbe(options = {}) {
  return {
    healthCheck,
    directoryHealth: (id, label, dir) => directoryHealth(id, label, dir, { ensureDirs: options.ensureDirs }),
    commandHealth: (id, label, command, args = ["--help"], missingStatus = "fail") => commandHealth(id, label, command, args, {
      execFileAsync: options.execFileAsync,
      missingStatus,
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
  healthCheck,
  directoryHealth,
  commandHealth,
  createHealthProbe,
};
