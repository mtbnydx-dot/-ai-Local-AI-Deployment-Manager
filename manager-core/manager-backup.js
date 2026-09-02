"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

function backupChecksum(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function normalizeBackupId(value) {
  const id = path.basename(String(value || ""));
  if (!/^manager-backup-[0-9TZ.-]+\.json$/i.test(id)) throw new Error("Invalid backup id.");
  return id;
}

function createManagerBackupStore(options = {}) {
  const managerId = String(options.managerId || "local-manager");
  const backupDir = options.backupDir;
  const files = Object.fromEntries(Object.entries(options.files || {}).filter(([, file]) => file));
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  if (!backupDir || typeof readJsonFile !== "function" || typeof writeJsonFile !== "function") {
    throw new Error("createManagerBackupStore requires backupDir, readJsonFile, and writeJsonFile.");
  }

  async function createManagerBackup() {
    const createdAt = new Date().toISOString();
    const entries = [];
    for (const [key, file] of Object.entries(files)) {
      const data = await readJsonFile(file, undefined);
      if (data === undefined) continue;
      entries.push({ key, data });
    }
    const payload = { version: 1, managerId, createdAt, entries };
    const backup = { ...payload, sha256: backupChecksum(payload) };
    const id = `manager-backup-${createdAt.replace(/[:]/g, "-")}.json`;
    await fsp.mkdir(backupDir, { recursive: true });
    await writeJsonFile(path.join(backupDir, id), backup);
    return summarizeBackup(id, backup);
  }

  async function listManagerBackups() {
    await fsp.mkdir(backupDir, { recursive: true });
    const names = (await fsp.readdir(backupDir)).filter((name) => /^manager-backup-.*\.json$/i.test(name));
    const backups = [];
    for (const id of names) {
      const backup = await readJsonFile(path.join(backupDir, id), null);
      if (backup) backups.push(summarizeBackup(id, backup));
    }
    return { ok: true, backupDir, backups: backups.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) };
  }

  async function getManagerBackup(id) {
    const normalizedId = normalizeBackupId(id);
    const backup = await readJsonFile(path.join(backupDir, normalizedId), null);
    if (!backup) {
      const error = new Error("Backup not found.");
      error.status = 404;
      throw error;
    }
    validateBackup(backup);
    return { id: normalizedId, backup };
  }

  async function restoreManagerBackup(id) {
    const { backup } = await getManagerBackup(id);
    const restored = [];
    for (const entry of backup.entries) {
      const target = files[entry.key];
      if (!target) continue;
      await writeJsonFile(target, entry.data);
      restored.push(entry.key);
    }
    return {
      ok: true,
      restored,
      createdAt: backup.createdAt,
      restartRequired: true,
      message: "Manager settings restored. Restart the manager to reload process-local settings; running model containers were not changed.",
    };
  }

  function validateBackup(backup) {
    if (!backup || backup.version !== 1 || !Array.isArray(backup.entries)) throw new Error("Unsupported backup format.");
    if (backup.managerId !== managerId) throw new Error(`Backup belongs to ${backup.managerId || "another manager"}.`);
    const payload = { version: backup.version, managerId: backup.managerId, createdAt: backup.createdAt, entries: backup.entries };
    if (backupChecksum(payload) !== backup.sha256) throw new Error("Backup checksum verification failed.");
  }

  function summarizeBackup(id, backup) {
    const payload = { version: backup.version, managerId: backup.managerId, createdAt: backup.createdAt, entries: backup.entries || [] };
    return {
      id,
      managerId: backup.managerId,
      createdAt: backup.createdAt,
      entryCount: Array.isArray(backup.entries) ? backup.entries.length : 0,
      sha256: backup.sha256 || backupChecksum(payload),
      valid: Boolean(backup.sha256 && backup.sha256 === backupChecksum(payload)),
    };
  }

  return {
    createManagerBackup,
    listManagerBackups,
    getManagerBackup,
    restoreManagerBackup,
  };
}

module.exports = {
  backupChecksum,
  normalizeBackupId,
  createManagerBackupStore,
};
