const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { compactTimestamp, parseJsonSafe, shellQuote } = require("./common-utils");
const { ensureDirs, hashFilesInDir } = require("./file-utils");
const { timingSafeEqualText } = require("./secrets");
const { safeOutputName } = require("./settings-stores");
const { OPENWEBUI_AUDIT_EXPORTER } = require("./openwebui-audit-exporter");

const DEFAULT_AUDIT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function createAuditStore(options = {}) {
  const auditRoot = options.auditRoot;
  const auditPasswordFile = options.auditPasswordFile;
  const legacyPasswordFiles = Array.isArray(options.legacyPasswordFiles) ? options.legacyPasswordFiles : [];
  const sessionTtlMs = Number(options.sessionTtlMs || DEFAULT_AUDIT_SESSION_TTL_MS);
  const sessions = new Map();
  let passwordCache = null;

  async function verifyAuditPassword(candidate) {
    const entered = normalizeAuditPassword(candidate);
    const candidates = await getAuditPasswordCandidates();
    return candidates.some((expected) => timingSafeEqualText(entered, normalizeAuditPassword(expected)));
  }

  async function getAuditPassword() {
    const envPassword = normalizeAuditPassword(options.envPassword !== undefined ? options.envPassword : process.env.AI_AUDIT_ADMIN_PASSWORD || "");
    if (envPassword) return envPassword;
    if (passwordCache) return passwordCache;

    await ensureDirs(path.dirname(auditPasswordFile));
    try {
      const existing = normalizeAuditPassword(await fsp.readFile(auditPasswordFile, "utf8"));
      if (existing) {
        passwordCache = existing;
        return existing;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const randomBytes = options.randomBytes || crypto.randomBytes;
    const generated = randomBytes(24).toString("base64url");
    try {
      await fsp.writeFile(auditPasswordFile, generated, { encoding: "utf8", flag: "wx" });
      passwordCache = generated;
      return generated;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = normalizeAuditPassword(await fsp.readFile(auditPasswordFile, "utf8"));
      if (!existing) throw new Error(`Audit password file is empty: ${auditPasswordFile}`);
      passwordCache = existing;
      return existing;
    }
  }

  async function getAuditPasswordCandidates() {
    const candidates = [await getAuditPassword()];
    for (const file of legacyPasswordFiles) {
      if (path.resolve(file) === path.resolve(auditPasswordFile)) continue;
      const value = normalizeAuditPassword(await fsp.readFile(file, "utf8").catch(() => ""));
      if (value) candidates.push(value);
    }
    return Array.from(new Set(candidates));
  }

  function createAuditSession() {
    cleanupAuditSessions();
    const randomBytes = options.randomBytes || crypto.randomBytes;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + sessionTtlMs;
    sessions.set(hashText(token), { createdAt: Date.now(), expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  function getAuditAuth(req) {
    const header = String(req.get("authorization") || "");
    const match = header.match(/^Bearer\s+(.+)$/i);
    return { token: match ? match[1].trim() : "" };
  }

  function requireAuditAuth(req) {
    cleanupAuditSessions();
    const { token } = getAuditAuth(req);
    if (!token) return { ok: false, status: 401, message: "需要先输入审计密码。" };
    const key = hashText(token);
    const session = sessions.get(key);
    if (!session || session.expiresAt < Date.now()) {
      sessions.delete(key);
      return { ok: false, status: 401, message: "审计登录已过期，请重新输入密码。" };
    }
    session.expiresAt = Date.now() + sessionTtlMs;
    return { ok: true };
  }

  function destroyAuditSession(token) {
    return sessions.delete(hashText(token));
  }

  function cleanupAuditSessions() {
    const now = Date.now();
    for (const [key, session] of sessions.entries()) {
      if (!session || session.expiresAt < now) sessions.delete(key);
    }
  }

  async function listAuditExports() {
    await ensureDirs(auditRoot);
    const entries = await fsp.readdir(auditRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const exports = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const auditId = entry.name;
      const auditDir = path.join(auditRoot, auditId);
      const manifest = parseJsonSafe(await fsp.readFile(path.join(auditDir, "manifest.json"), "utf8").catch(() => ""), {});
      const mdPath = path.join(auditDir, "openwebui-chats-full.md");
      const mdStat = await fsp.stat(mdPath).catch(() => null);
      exports.push({
        auditId,
        auditDir,
        reason: manifest.reason || "",
        manager: manifest.manager || "",
        createdAt: manifest.createdAt || mdStat?.mtime?.toISOString() || "",
        openWebuiContainer: manifest.openWebuiContainer || options.openWebuiContainer,
        serviceContainer: manifest.serviceContainer || "",
        chatCount: manifest.summary?.chat_count || manifest.chatCount || 0,
        messageCount: manifest.summary?.message_count || manifest.messageCount || 0,
        mdFile: mdStat ? "openwebui-chats-full.md" : "",
        mdBytes: mdStat?.size || 0,
        files: Array.isArray(manifest.summary?.files) ? manifest.summary.files : [],
      });
    }
    return exports.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function getAuditMarkdownPath(auditIdValue) {
    const auditId = cleanAuditId(auditIdValue);
    const root = path.resolve(auditRoot);
    const auditDir = path.resolve(root, auditId);
    if (!auditDir.startsWith(root + path.sep)) {
      const error = new Error("Invalid audit folder.");
      error.status = 400;
      throw error;
    }
    const file = path.join(auditDir, "openwebui-chats-full.md");
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      const error = new Error("未找到该审计记录的 Markdown 文件。");
      error.status = 404;
      throw error;
    }
    return file;
  }

  async function exportOpenWebuiAudit(reason = "manual", context = {}) {
    await ensureDirs(auditRoot);
    const openWebuiContainer = options.openWebuiContainer;
    const serviceContainer = options.serviceContainer;
    const container = await options.getContainerStatus(openWebuiContainer);
    if (!container.exists) {
      return {
        ok: false,
        skipped: true,
        reason: `Open WebUI container not found: ${openWebuiContainer}`,
        auditRoot,
      };
    }

    const auditId = `${compactTimestamp()}-${safeOutputName(reason)}-${safeOutputName(serviceContainer)}`;
    const auditDir = path.join(auditRoot, auditId);
    await ensureDirs(auditDir);

    const scriptPath = path.join(auditDir, "openwebui_audit_export.py");
    const remoteScript = `/tmp/openwebui_audit_export_${auditId}.py`;
    const remoteDir = `/tmp/openwebui_audit_${auditId}`;
    await fsp.writeFile(scriptPath, OPENWEBUI_AUDIT_EXPORTER, "utf8");
    await options.docker(["cp", scriptPath, `${openWebuiContainer}:${remoteScript}`]);
    const run = await options.docker(["exec", openWebuiContainer, "python", remoteScript, remoteDir], { rejectOnError: false });
    if (run.error) {
      throw new Error(`Open WebUI audit export failed: ${run.stderr || run.stdout || run.error.message}`);
    }
    await options.docker(["cp", `${openWebuiContainer}:${remoteDir}/.`, auditDir]);
    await options.docker(["exec", openWebuiContainer, "sh", "-lc", `rm -rf ${shellQuote(remoteDir)} ${shellQuote(remoteScript)}`], { rejectOnError: false });

    const summary = parseJsonSafe(run.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1), {});
    const manifest = {
      ok: true,
      auditId,
      reason,
      manager: context.manager || options.managerName || "local-manager",
      createdAt: new Date().toISOString(),
      auditDir,
      openWebuiContainer,
      serviceContainer,
      context,
      summary,
      notice: "This folder may contain full Open WebUI conversation records. Keep it access-controlled and use it only for authorized audit or incident response.",
    };

    await fsp.writeFile(path.join(auditDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fsp.writeFile(path.join(auditDir, "README.txt"), [
      "Open WebUI audit export",
      "",
      "This folder may contain full conversation records and should be access-controlled.",
      "Files are generated locally for authorized audit or incident response.",
      "Do not publish or share raw contents unless you have the legal authority to do so.",
      "",
      `Created: ${manifest.createdAt}`,
      `Reason: ${reason}`,
    ].join("\n"), "utf8");
    const hashes = await hashFilesInDir(auditDir);
    await fsp.writeFile(path.join(auditDir, "SHA256SUMS.txt"), `${hashes.map((item) => `${item.sha256}  ${item.relative}`).join("\n")}\n`, "utf8");

    return {
      ok: true,
      auditId,
      auditDir,
      chatCount: summary.chat_count || 0,
      messageCount: summary.message_count || 0,
      files: hashes.map((item) => item.relative),
    };
  }

  return {
    getAuditPassword,
    getAuditPasswordCandidates,
    verifyAuditPassword,
    createAuditSession,
    getAuditAuth,
    requireAuditAuth,
    destroyAuditSession,
    cleanupAuditSessions,
    listAuditExports,
    getAuditMarkdownPath,
    exportOpenWebuiAudit,
    cleanAuditId,
    normalizeAuditPassword,
    hashText,
  };
}

function normalizeAuditPassword(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim();
}

function cleanAuditId(value) {
  const auditId = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(auditId)) {
    const error = new Error("Invalid audit id.");
    error.status = 400;
    throw error;
  }
  return auditId;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

module.exports = {
  DEFAULT_AUDIT_SESSION_TTL_MS,
  createAuditStore,
  normalizeAuditPassword,
  cleanAuditId,
  hashText,
};
