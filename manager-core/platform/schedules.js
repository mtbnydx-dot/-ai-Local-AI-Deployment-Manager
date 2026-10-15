"use strict";

// Nightly and backup report readers (06 §7.2 ops.nightly / ops.backup, and the
// schedules route of 06 §10.2). Windows PowerShell 5.1 writes both files with
// `Set-Content -Encoding UTF8`, so every reader strips a BOM (V14). Nothing
// here writes, and a corrupt file is skipped instead of throwing.
const nodeFs = require("node:fs");
const path = require("node:path");

const NIGHTLY_DIR = "artifacts/nightly";
const NIGHTLY_KEEP = 30;
const BACKUP_FORMAT = "local-ai-platform-backup-v2";
const REPORT_PATTERN = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.json$/;
const BACKUP_STAMP_PATTERN = /^\d{8}-\d{4}$/;
const HOUR_MS = 3600 * 1000;

function readJsonFile(fsImpl, file) {
  try {
    const parsed = JSON.parse(String(fsImpl.readFileSync(file, "utf8")).replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stampDate(stamp) {
  const match = REPORT_PATTERN.exec(`${stamp}.json`);
  return match ? { date: `${match[1]}-${match[2]}-${match[3]}`, iso: `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00` } : null;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function timeOf(...values) {
  for (const value of values) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return null;
}

function nowMs(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value.getTime() : Number(value ?? Date.now());
}

function ageHours(at, now) {
  return at === null ? null : Math.max(0, Math.round(((nowMs(now) - at) / HOUR_MS) * 10) / 10);
}

function normalizeReport(report, stamp) {
  const time = timeOf(report.finishedAt, report.startedAt);
  return {
    stamp,
    at: Number.isFinite(time) ? new Date(time).toISOString() : null,
    // A report that does not say ok:true is a failing night.
    ok: report.ok === true,
    passed: count(report.passed),
    failed: count(report.failed),
  };
}

/**
 * artifacts/nightly/latest.json plus the newest 30 stamped reports ->
 * { available, ok, passed, failed, at, ageHours, streak, since, trend }.
 * `streak` counts consecutive failing nights from the newest report and
 * `since` is the date of the oldest of them. `trend` is oldest first.
 */
function readNightly(aiRoot, { now = Date.now, fs: fsImpl = nodeFs } = {}) {
  const directory = path.join(aiRoot, NIGHTLY_DIR);
  let names = [];
  try { names = fsImpl.readdirSync(directory); } catch { names = []; }
  const stamps = names.filter((name) => REPORT_PATTERN.test(name)).map((name) => name.slice(0, -5)).sort().reverse().slice(0, NIGHTLY_KEEP);
  const reports = [];
  for (const stamp of stamps) {
    const body = readJsonFile(fsImpl, path.join(directory, `${stamp}.json`));
    if (body) reports.push(normalizeReport(body, stamp));
  }
  const latestBody = readJsonFile(fsImpl, path.join(directory, "latest.json"));
  const latest = latestBody ? normalizeReport(latestBody, null) : reports[0] || null;
  if (!latest) return { available: false, ok: null, passed: 0, failed: 0, at: null, ageHours: null, streak: 0, since: null, trend: [] };
  let streak = 0;
  for (const report of reports) {
    if (report.ok) break;
    streak += 1;
  }
  const oldest = streak ? reports[streak - 1] : null;
  return {
    available: true,
    ok: latest.ok,
    passed: latest.passed,
    failed: latest.failed,
    at: latest.at,
    ageHours: ageHours(latest.at ? Date.parse(latest.at) : null, now),
    streak,
    since: oldest ? (stampDate(oldest.stamp)?.date || (oldest.at || "").slice(0, 10) || null) : null,
    trend: reports.slice().reverse().map((report) => ({ at: report.at || stampDate(report.stamp)?.iso || null, ok: report.ok, passed: report.passed, failed: report.failed })),
  };
}

/** Newest backups/<stamp>/backup-manifest.json -> { available, stamp, at, ageHours, format, formatOk, files, warnings }. */
function readBackup(aiRoot, { now = Date.now, fs: fsImpl = nodeFs } = {}) {
  const directory = path.join(aiRoot, "backups");
  let names = [];
  try { names = fsImpl.readdirSync(directory); } catch { names = []; }
  for (const stamp of names.filter((name) => BACKUP_STAMP_PATTERN.test(name)).sort().reverse()) {
    const manifest = readJsonFile(fsImpl, path.join(directory, stamp, "backup-manifest.json"));
    if (!manifest) continue;
    const at = timeOf(manifest.at, stampDate(`${stamp}`)?.iso);
    return {
      available: true,
      stamp,
      at: at === null ? null : new Date(at).toISOString(),
      ageHours: ageHours(at, now),
      format: typeof manifest.format === "string" ? manifest.format : null,
      formatOk: manifest.format === BACKUP_FORMAT,
      files: Array.isArray(manifest.files) ? manifest.files.length : 0,
      warnings: Array.isArray(manifest.warnings) ? manifest.warnings.length : 0,
    };
  }
  return { available: false, stamp: null, at: null, ageHours: null, format: null, formatOk: false, files: 0, warnings: 0 };
}

module.exports = { NIGHTLY_DIR, NIGHTLY_KEEP, BACKUP_FORMAT, readNightly, readBackup };
