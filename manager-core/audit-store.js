const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { compactTimestamp, parseJsonSafe, shellQuote } = require("./common-utils");
const { ensureDirs, hashFilesInDir, readJsonFileTolerant, writeJsonFile } = require("./file-utils");
const { timingSafeEqualText } = require("./secrets");
const { safeOutputName } = require("./settings-stores");
const { OPENWEBUI_AUDIT_EXPORTER } = require("./openwebui-audit-exporter");

const DEFAULT_AUDIT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_AUDIT_MAX_EXPORTS = 30;
const DEFAULT_AUDIT_MAX_AGE_DAYS = 90;
const DEFAULT_AUDIT_REBASELINE_DAYS = 7;
const AUDIT_CURSOR_FILE = ".audit-cursor.json";
const DAY_MS = 24 * 60 * 60 * 1000;

function auditRetentionSettings(options = {}) {
  const maxExports = Number(options.auditMaxExports ?? process.env.AI_AUDIT_MAX_EXPORTS ?? DEFAULT_AUDIT_MAX_EXPORTS);
  const maxAgeDays = Number(options.auditMaxAgeDays ?? process.env.AI_AUDIT_MAX_AGE_DAYS ?? DEFAULT_AUDIT_MAX_AGE_DAYS);
  const rebaselineDays = Number(options.auditRebaselineDays ?? process.env.AI_AUDIT_REBASELINE_DAYS ?? DEFAULT_AUDIT_REBASELINE_DAYS);
  return {
    // 0 disables the respective limit.
    maxExports: Number.isFinite(maxExports) && maxExports >= 0 ? Math.floor(maxExports) : DEFAULT_AUDIT_MAX_EXPORTS,
    maxAgeDays: Number.isFinite(maxAgeDays) && maxAgeDays >= 0 ? Math.floor(maxAgeDays) : DEFAULT_AUDIT_MAX_AGE_DAYS,
    // An automatic export becomes a full one once the newest full export is
    // older than this; 0 disables rebaselining.
    rebaselineDays: Number.isFinite(rebaselineDays) && rebaselineDays >= 0 ? rebaselineDays : DEFAULT_AUDIT_REBASELINE_DAYS,
  };
}

function createAuditStore(options = {}) {
  const auditRoot = options.auditRoot;
  const auditPasswordFile = options.auditPasswordFile;
  const legacyPasswordFiles = Array.isArray(options.legacyPasswordFiles) ? options.legacyPasswordFiles : [];
  const sessionTtlMs = Number(options.sessionTtlMs || DEFAULT_AUDIT_SESSION_TTL_MS);
  const sessions = new Map();
  let passwordCache = null;

  const cursorFile = path.join(auditRoot, AUDIT_CURSOR_FILE);

  async function readAuditCursor() {
    const value = await readJsonFileTolerant(cursorFile, {});
    return value && typeof value === "object" ? value : {};
  }

  async function writeAuditCursor(value) {
    await writeJsonFile(cursorFile, value);
  }

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
        mode: manifest.mode || (manifest.summary?.incremental ? "incremental" : "full"),
        chatCount: manifest.summary?.chat_count || manifest.chatCount || 0,
        totalChatCount: manifest.summary?.total_chat_count ?? null,
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

  // reason "manual" from the UI defaults to a full export; automatic exports
  // triggered by stop/unload are incremental, so a busy machine stops writing a
  // complete copy of the conversation history several times an hour.
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

    const cursor = await readAuditCursor();
    let full = context.full === true || (context.full === undefined && reason === "manual");
    // Incrementals are only useful on top of a full export, so an automatic
    // run rebaselines once the newest full is missing or too old.
    let rebaseline = false;
    const { rebaselineDays } = auditRetentionSettings(options);
    if (!full && context.full === undefined && rebaselineDays > 0) {
      const newestFull = (await listAuditExports()).find((item) => item.mode === "full");
      const createdMs = Date.parse(newestFull?.createdAt || "");
      const now = typeof options.now === "function" ? options.now() : Date.now();
      if (!newestFull || !Number.isFinite(createdMs) || now - createdMs > rebaselineDays * DAY_MS) {
        full = true;
        rebaseline = true;
      }
    }
    const since = full ? "" : String(cursor.maxUpdatedAt ?? "");

    const auditId = `${compactTimestamp()}-${safeOutputName(reason)}-${safeOutputName(serviceContainer)}`;
    const auditDir = path.join(auditRoot, auditId);
    await ensureDirs(auditDir);

    const scriptPath = path.join(auditDir, "openwebui_audit_export.py");
    const remoteScript = `/tmp/openwebui_audit_export_${auditId}.py`;
    const remoteDir = `/tmp/openwebui_audit_${auditId}`;
    await fsp.writeFile(scriptPath, OPENWEBUI_AUDIT_EXPORTER, "utf8");
    await options.docker(["cp", scriptPath, `${openWebuiContainer}:${remoteScript}`]);
    const execArgs = ["exec", openWebuiContainer, "python", remoteScript, remoteDir];
    if (since) execArgs.push(since);
    const run = await options.docker(execArgs, { rejectOnError: false });
    if (run.error) {
      // A folder without a manifest would otherwise be listed as a full export.
      await fsp.rm(auditDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Open WebUI audit export failed: ${run.stderr || run.stdout || run.error.message}`);
    }
    const summary = parseJsonSafe(String(run.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1), {});
    // An incremental run that found no changed chats writes no folder; the
    // cursor only records that the run happened.
    const emptyIncremental = Boolean(summary.incremental) && Number(summary.chat_count || 0) === 0;
    if (!emptyIncremental) await options.docker(["cp", `${openWebuiContainer}:${remoteDir}/.`, auditDir]);
    await options.docker(["exec", openWebuiContainer, "sh", "-lc", `rm -rf ${shellQuote(remoteDir)} ${shellQuote(remoteScript)}`], { rejectOnError: false });

    if (emptyIncremental) {
      await fsp.rm(auditDir, { recursive: true, force: true });
      const lastHeartbeatAt = new Date().toISOString();
      await writeAuditCursor({
        ...cursor,
        version: 1,
        maxUpdatedAt: summary.max_updated_at ?? cursor.maxUpdatedAt ?? null,
        lastHeartbeatAt,
      }).catch(() => {});
      const pruned = await pruneAuditExports().catch(() => ({ removed: [] }));
      return {
        ok: true,
        skipped: true,
        empty: true,
        reason: "没有新的对话，未写入审计目录。 / No new conversations; no audit folder was written.",
        mode: "incremental",
        chatCount: 0,
        totalChatCount: summary.total_chat_count ?? 0,
        messageCount: 0,
        lastHeartbeatAt,
        pruned: pruned.removed,
      };
    }
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
      mode: summary.incremental ? "incremental" : "full",
      rebaseline,
      sinceUpdatedAt: summary.since_updated_at ?? null,
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

    // Only advance the cursor after the export is durable on disk.
    if (summary.max_updated_at !== undefined && summary.max_updated_at !== null) {
      await writeAuditCursor({
        ...cursor,
        version: 1,
        maxUpdatedAt: summary.max_updated_at,
        updatedAt: new Date().toISOString(),
        lastAuditId: auditId,
      }).catch(() => {});
    }

    const pruned = await pruneAuditExports().catch(() => ({ removed: [] }));

    return {
      ok: true,
      auditId,
      auditDir,
      mode: manifest.mode,
      rebaseline,
      chatCount: summary.chat_count || 0,
      totalChatCount: summary.total_chat_count ?? summary.chat_count ?? 0,
      messageCount: summary.message_count || 0,
      files: hashes.map((item) => item.relative),
      pruned: pruned.removed,
    };
  }

  // Retention. Exports hold full conversation text, so unbounded accumulation
  // is both a disk problem and a privacy one. Retention is chain-aware: an
  // incremental export is only readable on top of the full export before it,
  // so the newest full export and every export newer than it are never
  // removed. Older exports are pruned by count and age. An empty incremental
  // holds nothing and is always prunable, except the newest export. Without
  // any full export, non-empty incrementals are never pruned.
  async function pruneAuditExports(overrides = {}) {
    const { maxExports, maxAgeDays } = auditRetentionSettings({ ...options, ...overrides });
    const exports = await listAuditExports();
    if (exports.length <= 1) return { removed: [], kept: exports.length };
    const now = overrides.now ?? Date.now();
    const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * DAY_MS : 0;
    // listAuditExports is newest-first.
    const newestFullIndex = exports.findIndex((item) => item.mode === "full");
    const removed = [];
    for (let index = 1; index < exports.length; index += 1) {
      if (newestFullIndex >= 0 && index <= newestFullIndex) continue;
      const item = exports[index];
      const emptyIncremental = item.mode === "incremental" && Number(item.chatCount || 0) === 0;
      let reason = "";
      if (emptyIncremental) {
        reason = "empty-incremental";
      } else if (newestFullIndex >= 0) {
        const tooMany = maxExports > 0 && index >= maxExports;
        const createdMs = Date.parse(item.createdAt || "");
        const tooOld = maxAgeMs > 0 && Number.isFinite(createdMs) && now - createdMs > maxAgeMs;
        reason = tooMany ? "max-exports" : tooOld ? "max-age" : "";
      }
      if (!reason) continue;
      const target = path.resolve(item.auditDir);
      // Never step outside the audit root.
      if (!target.startsWith(path.resolve(auditRoot) + path.sep)) continue;
      await fsp.rm(target, { recursive: true, force: true });
      removed.push({ auditId: item.auditId, reason });
    }
    return { removed, kept: exports.length - removed.length };
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
    pruneAuditExports,
    readAuditCursor,
    writeAuditCursor,
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
  DEFAULT_AUDIT_MAX_EXPORTS,
  DEFAULT_AUDIT_MAX_AGE_DAYS,
  DEFAULT_AUDIT_REBASELINE_DAYS,
  AUDIT_CURSOR_FILE,
  auditRetentionSettings,
  createAuditStore,
  normalizeAuditPassword,
  cleanAuditId,
  hashText,
};
