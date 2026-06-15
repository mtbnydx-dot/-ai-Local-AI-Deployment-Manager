const fs = require("fs");
const { spawn, execFile } = require("child_process");
const { parseJsonSafe } = require("./common-utils");
const { formatBytes } = require("./job-utils");

function createDockerRuntime(options = {}) {
  const dockerExe = options.dockerExe || "docker";
  const dockerDesktopExe = options.dockerDesktopExe || "";
  const execFileCommand = options.execFileCommand || execFile;
  const spawnCommand = options.spawnCommand || spawn;
  const fsExists = options.fsExists || fs.existsSync;
  const wait = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const parseJson = options.parseJsonSafe || parseJsonSafe;
  const formatSize = options.formatBytes || formatBytes;

  function execFileAsync(file, args, execOptions = {}) {
    return new Promise((resolve, reject) => {
      execFileCommand(file, args, { windowsHide: true, ...execOptions }, (error, stdout, stderr) => {
        if (error && execOptions.rejectOnError !== false) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "", error });
      });
    });
  }

  function docker(args, dockerOptions = {}) {
    return execFileAsync(dockerExe, args, dockerOptions);
  }

  async function getDockerVersion() {
    try {
      const out = await docker(["--version"]);
      const cli = out.stdout.trim();
      const daemon = await checkDockerDaemon();
      return {
        ok: daemon.ok,
        cliOk: true,
        daemonOk: daemon.ok,
        text: daemon.ok ? `${cli} · daemon ${daemon.version}` : `${cli} · ${daemon.error}`,
        daemonError: daemon.ok ? null : daemon.raw || daemon.error,
      };
    } catch (error) {
      return { ok: false, cliOk: false, daemonOk: false, text: error.message };
    }
  }

  async function waitForDockerDaemon(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      const out = await docker(["info", "--format", "{{.ServerVersion}}"], { rejectOnError: false, timeout: 8000 });
      const version = out.stdout.trim();
      if (!out.error && version) return { ok: true, version };
      lastError = out.stderr.trim() || out.error?.message || "Docker daemon is not ready.";
      await wait(2000);
    }
    return { ok: false, error: lastError };
  }

  async function checkDockerDaemon() {
    const out = await docker(["info", "--format", "{{.ServerVersion}}"], { rejectOnError: false, timeout: 8000 });
    const version = out.stdout.trim();
    if (!out.error && version) return { ok: true, version };
    const raw = out.stderr.trim() || out.error?.message || "Docker daemon is not ready.";
    return {
      ok: false,
      error: formatDockerDaemonError(raw),
      raw,
    };
  }

  async function ensureDockerDaemonRunning(timeoutMs = 120000) {
    const current = await checkDockerDaemon();
    if (current.ok) return { ...current, alreadyRunning: true };
    if (!dockerDesktopExe || !fsExists(dockerDesktopExe)) {
      return {
        ok: false,
        alreadyRunning: false,
        error: "Docker Desktop 未启动，且没有找到 Docker Desktop.exe，请检查 Docker Desktop 安装路径。",
        raw: current.raw || current.error,
      };
    }
    const child = spawnCommand(dockerDesktopExe, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    if (child?.unref) child.unref();
    const readiness = await waitForDockerDaemon(timeoutMs);
    if (readiness.ok) {
      return {
        ok: true,
        alreadyRunning: false,
        exe: dockerDesktopExe,
        version: readiness.version,
      };
    }
    const raw = readiness.error || current.raw || current.error;
    return {
      ok: false,
      alreadyRunning: false,
      exe: dockerDesktopExe,
      error: formatDockerDaemonError(raw),
      raw,
    };
  }

  async function startDockerDesktop(query = {}, timeoutMs = 120000) {
    const current = await checkDockerDaemon();
    if (current.ok) {
      return { ok: true, alreadyRunning: true, ready: true, serverVersion: current.version, message: "Docker daemon 已经可用。" };
    }
    if (!dockerDesktopExe || !fsExists(dockerDesktopExe)) {
      const error = new Error("没有找到 Docker Desktop.exe，请检查 Docker Desktop 安装路径。");
      error.status = 404;
      throw error;
    }
    if (String(query.dryRun || "") === "1") {
      return {
        ok: true,
        dryRun: true,
        exe: dockerDesktopExe,
        message: "Docker Desktop 可由管理器启动。",
      };
    }
    const readiness = await ensureDockerDaemonRunning(timeoutMs);
    return {
      ok: readiness.ok,
      alreadyRunning: Boolean(readiness.alreadyRunning),
      exe: dockerDesktopExe,
      ready: readiness.ok,
      serverVersion: readiness.version || null,
      error: readiness.ok ? null : readiness.error,
      message: readiness.ok
        ? readiness.alreadyRunning ? "Docker daemon 已经可用。" : "已启动 Docker Desktop，Docker 引擎已经可用。"
        : readiness.error,
    };
  }

  async function getImageStatus(image) {
    try {
      const out = await docker(["image", "inspect", image, "--format", "{{.Id}}\t{{.Size}}\t{{json .RepoTags}}\t{{json .RepoDigests}}"], { rejectOnError: false });
      const line = out.stdout.trim();
      if (out.error) {
        const raw = out.stderr.trim() || out.error.message;
        return { ok: false, text: formatDockerDaemonError(raw), reason: "docker-daemon", raw };
      }
      if (!line) return { ok: false, text: "missing" };
      const [id, size, tagsJson, digestsJson] = line.split("\t");
      const refs = [
        ...parseJson(tagsJson, []),
        ...parseJson(digestsJson, []),
      ].filter(Boolean);
      const display = refs.includes(image) ? image : refs[0] || image;
      return { ok: true, text: `${display}\t${formatSize(Number(size) || 0)}`, id, refs };
    } catch (error) {
      return { ok: false, text: error.message };
    }
  }

  return {
    execFileAsync,
    docker,
    getDockerVersion,
    waitForDockerDaemon,
    checkDockerDaemon,
    ensureDockerDaemonRunning,
    startDockerDesktop,
    getImageStatus,
    formatDockerDaemonError,
    normalizeDockerContainerName,
    normalizeDockerTimestamp,
    timestampToSeconds,
  };
}

function formatDockerDaemonError(raw) {
  const text = String(raw || "").trim();
  if (/dockerDesktopLinuxEngine|pipe/i.test(text)) {
    return "Docker Desktop 引擎未就绪。请先用页面的一键 Docker 按钮启动 Docker Desktop，等状态变为可用后再启动模型。";
  }
  if (/cannot connect|daemon|not ready/i.test(text)) {
    return `Docker daemon 未就绪：${text}`;
  }
  return text || "Docker daemon 未就绪。";
}

function normalizeDockerContainerName(value) {
  return String(value || "")
    .split(",")[0]
    .replace(/^\//, "")
    .trim();
}

function normalizeDockerTimestamp(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("0001-")) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timestampToSeconds(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date.getTime() / 1000;
}

module.exports = {
  createDockerRuntime,
  formatDockerDaemonError,
  normalizeDockerContainerName,
  normalizeDockerTimestamp,
  timestampToSeconds,
};
