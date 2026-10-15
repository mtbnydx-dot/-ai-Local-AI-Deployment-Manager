// /system/updates and /system/ops models (06 §9.5, §10.2; 07 §6.13): the pure
// parts of the Updates and Operations pages.
//
// GET /api/platform/version answers {version, build: {commit, contentHash},
// node, packages, newerCommits, drift: {count, checkedAt}}; newerCommits is
// countNewerCommits()'s {available, behind, head, deployed, ref, error?} (an
// older entry sent a bare number). GET /api/platform/deploys answers
// {deployments: [{stamp, commit, branch, deployedAt, counts}]}, the pending
// restarts are the supervisor's {pendingRestarts: [{id, reason, queuedAt,
// deadline}]}, and GET /api/platform/schedules answers {nightly: {latest,
// trend, streak, since}, backup: {latest, ageHours, files}, tasks}. Nothing
// here touches the DOM, the cache or the network.

export const TREND_DAYS = 30;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finite(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
}

/** A commit id for display: the first 12 characters. */
export function shortCommit(commit) {
  const value = text(commit);
  return value ? value.slice(0, 12) : "";
}

/** The newer-commit count: {behind, available, head, deployed, error}; behind is null when it could not be counted. */
export function newerCommits(raw) {
  if (isPlainObject(raw)) {
    const behind = finite(raw.behind);
    return {
      behind,
      available: raw.available === true || (behind !== null && behind > 0),
      head: shortCommit(raw.head),
      deployed: shortCommit(raw.deployed),
      error: isPlainObject(raw.error) ? text(raw.error.code) || "unknown" : "",
    };
  }
  const behind = finite(raw);
  return { behind, available: behind !== null && behind > 0, head: "", deployed: "", error: "" };
}

/** The drift summary: {count, checkedAt}. */
export function driftOf(raw) {
  const drift = isPlainObject(raw) ? raw : {};
  return { count: Math.max(0, finite(drift.count) ?? 0), checkedAt: text(drift.checkedAt) || null };
}

/** The version document as the page shows it. */
export function normalizeVersion(raw) {
  const body = isPlainObject(raw) ? raw : {};
  return {
    version: text(body.version),
    commit: shortCommit(body.build?.commit),
    contentHash: text(body.build?.contentHash),
    node: text(body.node),
    packages: (Array.isArray(body.packages) ? body.packages : []).filter(isPlainObject).map((item) => ({ dir: text(item.dir), version: text(item.version) })).filter((item) => item.dir),
    newer: newerCommits(body.newerCommits),
    drift: driftOf(body.drift),
  };
}

/** Deploy history rows, newest first as the backend sends them. */
export function normalizeDeploys(raw) {
  const list = Array.isArray(raw?.deployments) ? raw.deployments : Array.isArray(raw) ? raw : [];
  return list.filter(isPlainObject).map((item) => {
    const counts = isPlainObject(item.counts) ? item.counts : {};
    return {
      stamp: text(item.stamp),
      commit: shortCommit(item.commit),
      branch: text(item.branch),
      deployedAt: text(item.deployedAt) || null,
      created: finite(counts.created) ?? 0,
      updated: finite(counts.updated) ?? 0,
      unchanged: finite(counts.unchanged) ?? 0,
      pruned: finite(counts.pruned) ?? 0,
    };
  });
}

/** Pending restarts: [{id, reason, queuedAt, deadline}]. */
export function normalizePending(raw) {
  const list = Array.isArray(raw?.pendingRestarts) ? raw.pendingRestarts : Array.isArray(raw) ? raw : [];
  return list.filter(isPlainObject).map((item) => ({ id: text(item.id), reason: text(item.reason), queuedAt: text(item.queuedAt) || null, deadline: text(item.deadline) || null })).filter((item) => item.id);
}

/**
 * The nightly trend as exactly `days` slots, oldest first: older days with no
 * report are `missing` and come first, so the newest report is the last bar.
 * @returns {{ at, state: "pass"|"fail"|"missing", passed, failed }[]}
 */
export function trendBars(trend, days = TREND_DAYS) {
  const list = (Array.isArray(trend) ? trend : []).filter(isPlainObject).slice(-days).map((item) => ({
    at: text(item.at) || null,
    state: item.ok === true ? "pass" : "fail",
    passed: finite(item.passed) ?? 0,
    failed: finite(item.failed) ?? 0,
  }));
  const gaps = Array.from({ length: Math.max(0, days - list.length) }, () => ({ at: null, state: "missing", passed: 0, failed: 0 }));
  return [...gaps, ...list];
}

/** Bar height in percent: the total steps relative to the largest run (a floor keeps every bar visible). */
export function barHeights(bars) {
  const totals = bars.map((bar) => bar.passed + bar.failed);
  const max = Math.max(1, ...totals);
  return bars.map((bar, index) => (bar.state === "missing" ? 8 : Math.max(18, Math.round((totals[index] / max) * 100))));
}

/** The schedules document as the Operations page shows it. */
export function normalizeSchedules(raw) {
  const body = isPlainObject(raw) ? raw : {};
  const nightly = isPlainObject(body.nightly) ? body.nightly : {};
  const backup = isPlainObject(body.backup) ? body.backup : {};
  const latest = isPlainObject(nightly.latest) ? nightly.latest : null;
  const backupLatest = isPlainObject(backup.latest) ? backup.latest : null;
  return {
    nightly: {
      latest: latest ? { ok: latest.ok === true, passed: finite(latest.passed) ?? 0, failed: finite(latest.failed) ?? 0, at: text(latest.at) || null, ageHours: finite(latest.ageHours) } : null,
      bars: trendBars(nightly.trend),
      streak: Math.max(0, finite(nightly.streak) ?? 0),
      since: text(nightly.since) || null,
    },
    backup: {
      latest: backupLatest ? { stamp: text(backupLatest.stamp), at: text(backupLatest.at) || null, format: text(backupLatest.format), formatOk: backupLatest.formatOk === true, warnings: finite(backupLatest.warnings) ?? 0 } : null,
      ageHours: finite(backup.ageHours),
      files: finite(backup.files) ?? 0,
    },
    tasks: isPlainObject(body.tasks) ? body.tasks : {},
  };
}

/** A scheduled task (the doctor's probe row) as the table shows it, or null when it is not registered. */
export function normalizeTask(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    state: text(raw.state),
    lastRunTime: text(raw.lastRunTime) || null,
    lastResult: finite(raw.lastResult ?? raw.lastTaskResult),
    nextRunTime: text(raw.nextRunTime) || null,
  };
}

/** The autostart status: the doctor's `ops.autostart` data ({method, registered, pathMatches, state}). */
export function normalizeAutostart(raw) {
  const data = isPlainObject(raw) ? raw : {};
  const registered = data.registered === true;
  return {
    registered,
    method: text(data.method) || null,
    pathMatches: data.pathMatches === true,
    state: text(data.state) || null,
    // "none" | "stale" (registered for another folder) | "registered"
    status: !registered ? "none" : data.pathMatches === true ? "registered" : "stale",
  };
}
