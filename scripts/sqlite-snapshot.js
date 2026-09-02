"use strict";
// Consistent copy of a SQLite database that another process may hold open:
//   node scripts/sqlite-snapshot.js <source.sqlite> <destination.sqlite>
// Uses VACUUM INTO on a read-only connection, so WAL content is included and
// the live database is never locked for writers longer than a read transaction.
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  console.error("usage: sqlite-snapshot.js <source> <destination>");
  process.exit(2);
}
fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
if (fs.existsSync(destination)) fs.unlinkSync(destination);
const db = new DatabaseSync(source, { readOnly: true });
try {
  const target = path.resolve(destination).replace(/\\/g, "/").replace(/'/g, "''");
  db.exec(`VACUUM INTO '${target}'`);
} finally {
  db.close();
}
