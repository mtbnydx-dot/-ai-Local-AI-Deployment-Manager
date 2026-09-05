"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

function verifyBackup(directory) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "backup-manifest.json"), "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Backup contains no files");
  for (const item of manifest.files) {
    const file = path.resolve(root, item.path);
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Backup path escapes its directory");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (digest !== String(item.sha256).toLowerCase()) throw new Error(`Hash mismatch: ${item.path}`);
    if (item.kind === "sqlite") {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const result = db.prepare("PRAGMA integrity_check").all();
        if (result.length !== 1 || Object.values(result[0])[0] !== "ok") throw new Error(`SQLite integrity failure: ${item.path}`);
      } finally { db.close(); }
    }
  }
  return manifest.files.length;
}
if (require.main === module) console.log(`Verified ${verifyBackup(process.argv[2])} backup files and SQLite integrity.`);
module.exports = { verifyBackup };
