const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { compactTimestamp, parseJsonSafe, shellQuote } = require("./common-utils");
const { ensureDirs, hashFilesInDir, readJsonFileTolerant, writeJsonFile } = require("./file-utils");
const { timingSafeEqualText } = require("./secrets");
const { safeOutputName } = require("./settings-stores");
const { OPENWEBUI_AUDIT_EXPORTER } = require("./openwebui-audit-exporter");
const { AUDIT_RETENTION_DEFAULTS, planAuditRetention } = require("./telemetry/audit-chain");

const DEFAULT_AUDIT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_AUDIT_MAX_EXPORTS = AUDIT_RETENTION_DEFAULTS.maxExports;
const DEFAULT_AUDIT_MAX_AGE_DAYS = AUDIT_RETENTION_DEFAULTS.maxAgeDays;
const DEFAULT_AUDIT_REBASELINE_DAYS = AUDIT_RETENTION_DEFAULTS.rebaselineDays;
const DEFAULT_AUDIT_MAX_CHAINS = AUDIT_RETENTION_DEFAULTS.maxChains;
const AUDIT_CURSOR_FILE = ".audit-cursor.json";
const AUDIT_EXPORT_LOCK_FILE = ".audit-export.lock";
const AUDIT_EXPORT_LOCK_STALE_MS = 30 * 60 * 1000;
const EXPORT_IN_PROGRESS_MESSAGE = "另一个审计导出正在进行，本次已跳过。 / Another audit export is in progress; this run was skipped.";

function auditRetentionSettings(options = {}) {
  const maxExports = Number(options.auditMaxExports ?? process.env.AI_AUDIT_MAX_EXPORTS ?? DEFAULT_AUDIT_MAX_EXPORTS);
  const maxAgeDays = Number(options.auditMaxAgeDays ?? process.env.AI_AUDIT_MAX_AGE_DAYS ?? DEFAULT_AUDIT_MAX_AGE_DAYS);
  const rebaselineDays = Number(options.auditRebaselineDays ?? process.env.AI_AUDIT_REBASELINE_DAYS ?? DEFAULT_AUDIT_REBASELINE_DAYS);
  const maxChains = Number(options.auditMaxChains ?? DEFAULT_AUDIT_MAX_CHAINS);
  return {
    // 0 disables the respective limit.
    maxExports: Number.isFinite(maxExports) && maxExports >= 0 ? Math.floor(maxExports) : DEFAULT_AUDIT_MAX_EXPORTS,
    maxAgeDays: Number.isFinite(maxAgeDays) && maxAgeDays >= 0 ? Math.floor(maxAgeDays) : DEFAULT_AUDIT_MAX_AGE_DAYS,
    // An automatic export becomes a full one once the newest full export is
    // older than this; 0 disables rebaselining.
    rebaselineDays: Number.isFinite(rebaselineDays) && rebaselineDays >= 0 ? rebaselineDays : DEFAULT_AUDIT_REBASELINE_DAYS,
    // Whole export chains kept (audit.retention.maxChains); it has no
    // environment variable.
    maxChains: Number.isFinite(maxChains) && maxChains >= 0 ? Math.floor(maxChains) : DEFAULT_AUDIT_MAX_CHAINS,
  };
}

// process.kill(pid, 0) only probes; EPERM means the process exists but
// belongs to someone else.
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function createAuditStore(options = {}) {
  const auditRoot = options.auditRoot;
  const auditPasswordFile = options.auditPasswordFile;
  const legacyPasswordFiles = Array.isArray(options.legacyPasswordFiles) ? options.legacyPasswordFiles : [];
  const sessionTtlMs = Number(options.sessionTtlMs || DEFAULT_AUDIT_SESSION_TTL_MS);
  const sessions = new Map();
  let passwordCache = null;

  const cursorFile = path.join(auditRoot, AUDIT_CURSOR_FILE);
  const lockFile = path.join(auditRoot, AUDIT_EXPORT_LOCK_FILE);
  const lockOwner = options.managerName || "local-manager";
  const processAlive = typeof options.isProcessAlive === "function" ? options.isProcessAlive : isProcessAlive;
  const onLog = typeof options.onLog === "function" ? options.onLog : (message) => console.log(message);
  const nowMs = () => (typeof options.now === "function" ? options.now() : Date.now());

  async function readAuditCursor() {
    const value = await readJsonFileTolerant(cursorFile, {});
    return value && typeof value === "object" ? value : {};
  }

  async function writeAuditCursor(value) {
    await writeJsonFile(cursorFile, value);
  }

  // One exporter at a time per audit root (docs/overhaul/04 §16.1). Both
  // managers share the root and its cursor, so the lock is a file next to
  // them, created with wx and holding {pid, at, owner}. Exports and pruning
  // take it; a held lock means the caller skips with export_in_progress. A
  // lock older than 30 minutes, or one whose process has exited, is broken
  // and logged. Returns null while someone else holds it.
  async function acquireExportLock() {
    const text = `${JSON.stringify({ pid: process.pid, at: new Date(nowMs()).toISOString(), owner: lockOwner })}\n`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fsp.writeFile(lockFile, text, { encoding: "utf8", flag: "wx" });
        return { release: () => releaseExportLock(text) };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const held = await inspectExportLock();
      if (held.gone) continue;
      if (!held.stale || !(await breakExportLock(held))) return null;
    }
    return null;
  }

  async function inspectExportLock() {
    const [raw, stat] = await Promise.all([
      fsp.readFile(lockFile, "utf8").catch(() => null),
      fsp.stat(lockFile).catch(() => null),
    ]);
    if (raw === null && !stat) return { gone: true };
    const parsed = parseJsonSafe(raw, null);
    const info = parsed && typeof parsed === "object" ? parsed : {};
    const pid = Number(info.pid);
    const atMs = Date.parse(info.at || "");
    // A lock caught between its creation and its first write has no content
    // yet; its file time stands in for "at".
    const sinceMs = Number.isFinite(atMs) ? atMs : Number(stat?.mtimeMs);
    const ageMs = nowMs() - sinceMs;
    let stale = "";
    if (Number.isInteger(pid) && pid > 0 && !processAlive(pid)) stale = "owner process has exited";
    else if (Number.isFinite(ageMs) && Math.abs(ageMs) > AUDIT_EXPORT_LOCK_STALE_MS) stale = "older than 30 minutes";
    return { raw, pid: Number.isInteger(pid) ? pid : null, owner: String(info.owner || ""), at: String(info.at || ""), stale };
  }

  // The stale lock is first moved aside, which is atomic, and only counts as
  // broken when the moved file is still the one that was judged stale. When
  // another process broke it first and already holds a fresh lock, that lock
  // is put back (link never overwrites) and this caller treats it as held.
  async function breakExportLock(held) {
    const aside = `${lockFile}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.stale`;
    try {
      await fsp.rename(lockFile, aside);
    } catch (error) {
      return error.code === "ENOENT";
    }
    const moved = await fsp.readFile(aside, "utf8").catch(() => null);
    if (moved !== held.raw) {
      // Without hard links (FAT, exFAT) a plain rename is the best effort.
      await fsp.link(aside, lockFile).catch((error) => (error.code === "EEXIST" ? null : fsp.rename(aside, lockFile).catch(() => {})));
      await fsp.rm(aside, { force: true }).catch(() => {});
      return false;
    }
    await fsp.rm(aside, { force: true }).catch(() => {});
    onLog(`audit-export: broke a stale export lock (${held.stale}; pid ${held.pid ?? "unknown"}, owner ${held.owner || "unknown"}, taken ${held.at || "unknown"})`);
    return true;
  }

  async function releaseExportLock(text) {
    // A lock that was broken and taken again meanwhile is not ours to remove.
    const current = await fsp.readFile(lockFile, "utf8").catch(() => null);
    if (current !== text) return;
    // A scanner briefly holding the fresh file must not leave the lock
    // behind for 30 minutes, so a busy file is retried.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fsp.unlink(lockFile);
        return;
      } catch (error) {
        if (error.code === "ENOENT") return;
        if (attempt >= 5 || !["EBUSY", "EPERM", "EACCES"].includes(error.code)) {
          onLog(`audit-export: could not release the export lock: ${error.code || error.message}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }

  function exportInProgress() {
    return { ok: false, skipped: true, reason: "export_in_progress", message: EXPORT_IN_PROGRESS_MESSAGE };
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
    const container = await options.getContainerStatus(openWebuiContainer);
    if (!container.exists) {
      return {
        ok: false,
        skipped: true,
        reason: `Open WebUI container not found: ${openWebuiContainer}`,
        auditRoot,
      };
    }

    const lock = await acquireExportLock();
    if (!lock) return exportInProgress();
    try {
      return await writeOpenWebuiAudit(reason, context);
    } finally {
      await lock.release();
    }
  }

  // Runs with the export lock held.
  async function writeOpenWebuiAudit(reason, context) {
    const openWebuiContainer = options.openWebuiContainer;
    const serviceContainer = options.serviceContainer;
    const cursor = await readAuditCursor();
    let full = context.full === true || (context.full === undefined && reason === "manual");
    // Incrementals are only useful on top of a full export, so an automatic
    // run rebaselines once the newest full is missing or too old. The rule is
    // the retention planner's, so there is exactly one.
    let rebaseline = false;
    const settings = auditRetentionSettings(options);
    if (!full && context.full === undefined && settings.rebaselineDays > 0) {
      if (planAuditRetention(await listAuditExports(), settings, nowMs()).needsRebaseline) {
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
      const pruned = await pruneExportsLocked().catch(() => ({ removed: [] }));
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

    const pruned = await pruneExportsLocked().catch(() => ({ removed: [] }));

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
  // is both a disk problem and a privacy one. The rules are chain-aware and
  // live in telemetry/audit-chain.js#planAuditRetention: the newest full
  // export and its chain are never removed, older exports are pruned by count
  // and age, empty incrementals always go except the newest export, and only
  // the newest maxChains chains are kept. Pruning takes the export lock.
  async function pruneAuditExports(overrides = {}) {
    await ensureDirs(auditRoot);
    const lock = await acquireExportLock();
    if (!lock) return { ...exportInProgress(), removed: [] };
    try {
      return await pruneExportsLocked(overrides);
    } finally {
      await lock.release();
    }
  }

  // Runs with the export lock held; deletes exactly what the plan names.
  async function pruneExportsLocked(overrides = {}) {
    const settings = auditRetentionSettings({ ...options, ...overrides });
    const exports = await listAuditExports();
    const plan = planAuditRetention(exports, settings, overrides.now ?? nowMs());
    const byId = new Map(exports.map((item) => [item.auditId, item]));
    const removed = [];
    for (const { auditId, reason } of plan.remove) {
      const target = path.resolve(byId.get(auditId).auditDir);
      // Never step outside the audit root.
      if (!target.startsWith(path.resolve(auditRoot) + path.sep)) continue;
      await fsp.rm(target, { recursive: true, force: true });
      removed.push({ auditId, reason });
    }
    return { removed, kept: exports.length - removed.length, warnings: plan.warnings };
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
  DEFAULT_AUDIT_MAX_CHAINS,
  AUDIT_CURSOR_FILE,
  AUDIT_EXPORT_LOCK_FILE,
  AUDIT_EXPORT_LOCK_STALE_MS,
  auditRetentionSettings,
  createAuditStore,
  normalizeAuditPassword,
  cleanAuditId,
  hashText,
};
