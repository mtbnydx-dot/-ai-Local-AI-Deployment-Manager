"use strict";

// Audit export retention (docs/overhaul/04 §16.2). This is the one retention
// policy: P0-OBS-6's chain-aware rules, moved here unchanged, plus a cap on
// the number of export chains. Both exported functions are pure. They take the
// export list in the shape listAuditExports returns and never touch the disk;
// audit-store.js#pruneAuditExports deletes what the plan names.
//
// A chain is one full export plus every incremental after it, up to the next
// full export. An incremental only holds the chats changed since the run
// before it, so it is complete only on top of its chain's full export. That
// is why the chain, not the single export, is what the cap removes.

const DAY_MS = 24 * 60 * 60 * 1000;

// 0 disables the respective limit, as with the environment variables.
const AUDIT_RETENTION_DEFAULTS = Object.freeze({
  maxExports: 30,
  maxAgeDays: 90,
  rebaselineDays: 7,
  maxChains: 8,
});

const WARNING_MESSAGES = {
  no_full_export: "没有完整基线导出，增量导出不会被清理。 / No full baseline export exists, so incremental exports are not pruned.",
  orphaned_incrementals: "部分保留的增量导出缺少其完整基线。 / Some kept incremental exports no longer have their full baseline export.",
  over_max_exports: "保留的导出多于数量上限，因为最新的导出链不会被拆开。 / More exports are kept than the count limit, because the newest chain is never split.",
};

// Legacy exports without a mode count as full (the listAuditExports fallback).
function isFullExport(item) {
  return !item.mode || item.mode === "full";
}

function isEmptyIncremental(item) {
  return item.mode === "incremental" && Number(item.chatCount || 0) === 0;
}

// Newest first, the order listAuditExports returns. Array#sort is stable, so
// a list that is already in that order keeps it.
function sortNewestFirst(exports) {
  return (Array.isArray(exports) ? exports : [])
    .filter((item) => item && typeof item === "object")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function retentionLimit(value, fallback, integer = true) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return integer ? Math.floor(number) : number;
}

function normalizeRetentionPolicy(policy = {}) {
  const source = policy && typeof policy === "object" ? policy : {};
  return {
    maxExports: retentionLimit(source.maxExports, AUDIT_RETENTION_DEFAULTS.maxExports),
    maxAgeDays: retentionLimit(source.maxAgeDays, AUDIT_RETENTION_DEFAULTS.maxAgeDays),
    // Fractional days are allowed, as P0-OBS-6 allowed them.
    rebaselineDays: retentionLimit(source.rebaselineDays, AUDIT_RETENTION_DEFAULTS.rebaselineDays, false),
    maxChains: retentionLimit(source.maxChains, AUDIT_RETENTION_DEFAULTS.maxChains),
  };
}

// Walks the newest-first list once. Exports seen before a full export are
// newer than it and older than the previous full, so they belong to its chain.
// Whatever is left after the oldest full export belongs to no chain.
function splitChains(sorted) {
  const chains = [];
  let pending = [];
  sorted.forEach((item, index) => {
    if (!isFullExport(item)) {
      pending.push(index);
      return;
    }
    chains.push({ fullIndex: index, memberIndexes: [...pending, index] });
    pending = [];
  });
  return { chains, unchained: pending };
}

function describeChain(sorted, chain, active) {
  const members = chain.memberIndexes.map((index) => sorted[index]);
  const full = sorted[chain.fullIndex];
  const total = (field) => members.reduce((sum, item) => sum + (Number(item[field]) || 0), 0);
  return {
    fullAuditId: full.auditId,
    createdAt: full.createdAt || "",
    updatedAt: members[0].createdAt || "",
    auditIds: members.map((item) => item.auditId),
    incrementals: members.length - 1,
    chats: total("chatCount"),
    messages: total("messageCount"),
    bytes: total("mdBytes"),
    active,
  };
}

// Chains newest first. The first chain, the one of the newest full export, is
// the active chain that new incrementals extend.
function groupAuditChains(exports) {
  const sorted = sortNewestFirst(exports);
  return splitChains(sorted).chains.map((chain, index) => describeChain(sorted, chain, index === 0));
}

// P0-OBS-6's trigger, and the only rebaseline rule: an automatic export turns
// into a full one once the newest full export is missing or older than
// rebaselineDays (AI_AUDIT_REBASELINE_DAYS). 0 disables it.
function needsAuditRebaseline(sorted, rebaselineDays, now) {
  if (!(rebaselineDays > 0)) return false;
  const newestFull = sorted.find(isFullExport);
  const createdMs = Date.parse(newestFull?.createdAt || "");
  return !newestFull || !Number.isFinite(createdMs) || now - createdMs > rebaselineDays * DAY_MS;
}

function retentionWarning(code, extra = {}) {
  return { code, message: WARNING_MESSAGES[code], ...extra };
}

// Returns {keep, remove:[{auditId, reason}], warnings, needsRebaseline}. keep
// and remove are newest first; reasons are empty-incremental, max-exports,
// max-age and max-chains.
//
// P0-OBS-6's rules: the newest export is always kept. An empty incremental
// holds nothing and is always prunable. The newest full export and every
// export newer than it are kept. Older exports are pruned by count (counted
// over the whole list) and by age. Without any full export, non-empty
// incrementals are never pruned.
//
// The chain cap comes on top: chains older than the newest maxChains are
// removed whole, together with any incremental older than every kept chain.
// It never splits a chain, so the active chain always stays and a full export
// never goes while a kept incremental of its chain stays.
function planAuditRetention(exports, policy = {}, now = Date.now()) {
  const settings = normalizeRetentionPolicy(policy);
  const sorted = sortNewestFirst(exports);
  const reasons = sorted.map(() => "");
  const { chains, unchained } = splitChains(sorted);
  const newestFullIndex = chains.length ? chains[0].fullIndex : -1;

  if (sorted.length > 1) {
    const maxAgeMs = settings.maxAgeDays > 0 ? settings.maxAgeDays * DAY_MS : 0;
    for (let index = 1; index < sorted.length; index += 1) {
      const item = sorted[index];
      if (isEmptyIncremental(item)) {
        reasons[index] = "empty-incremental";
        continue;
      }
      if (newestFullIndex < 0 || index <= newestFullIndex) continue;
      const tooMany = settings.maxExports > 0 && index >= settings.maxExports;
      const createdMs = Date.parse(item.createdAt || "");
      const tooOld = maxAgeMs > 0 && Number.isFinite(createdMs) && now - createdMs > maxAgeMs;
      reasons[index] = tooMany ? "max-exports" : tooOld ? "max-age" : "";
    }

    if (settings.maxChains > 0 && chains.length > settings.maxChains) {
      const cutoff = chains[settings.maxChains - 1].fullIndex;
      for (let index = cutoff + 1; index < sorted.length; index += 1) {
        if (!reasons[index]) reasons[index] = "max-chains";
      }
    }
  }

  const keep = [];
  const remove = [];
  sorted.forEach((item, index) => {
    if (reasons[index]) remove.push({ auditId: item.auditId, reason: reasons[index] });
    else keep.push(item.auditId);
  });

  const warnings = [];
  if (sorted.length && !chains.length) warnings.push(retentionWarning("no_full_export"));
  if (chains.length) {
    // The count and age rules may remove an older chain's full export while a
    // newer incremental of that chain is still within the limits.
    const orphaned = [];
    const keptWithoutBase = (indexes) => indexes.forEach((index) => {
      if (!reasons[index] && !isFullExport(sorted[index]) && !isEmptyIncremental(sorted[index])) orphaned.push(sorted[index].auditId);
    });
    for (const chain of chains) {
      if (reasons[chain.fullIndex]) keptWithoutBase(chain.memberIndexes);
    }
    keptWithoutBase(unchained);
    if (orphaned.length) warnings.push(retentionWarning("orphaned_incrementals", { auditIds: orphaned }));
  }
  if (settings.maxExports > 0 && keep.length > settings.maxExports) {
    warnings.push(retentionWarning("over_max_exports", { kept: keep.length, maxExports: settings.maxExports }));
  }

  return {
    keep,
    remove,
    warnings,
    needsRebaseline: needsAuditRebaseline(sorted, settings.rebaselineDays, now),
  };
}

module.exports = {
  AUDIT_RETENTION_DEFAULTS,
  groupAuditChains,
  planAuditRetention,
};
