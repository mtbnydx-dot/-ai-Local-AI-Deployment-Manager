"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("..");
const { AUDIT_RETENTION_DEFAULTS, groupAuditChains, planAuditRetention } = require("../telemetry/audit-chain");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-14T12:00:00.000Z");

// An entry in the shape listAuditExports returns.
function entry(auditId, { mode = "incremental", chatCount = 1, ageMs = 0, now = NOW, messageCount = chatCount, mdBytes = 0 } = {}) {
  return {
    auditId,
    auditDir: path.join(os.tmpdir(), "audit-chain-unused", auditId),
    createdAt: new Date(now - ageMs).toISOString(),
    mode,
    chatCount,
    messageCount,
    mdBytes,
  };
}

const removedPairs = (plan) => plan.remove.map((item) => [item.auditId, item.reason]);

// Export trees live under the OS temp folder.
async function auditRootFor(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "audit-chain-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeEntries(root, entries) {
  for (const item of entries) {
    const dir = path.join(root, item.auditId);
    await fsp.mkdir(dir, { recursive: true });
    const manifest = {
      ok: true,
      auditId: item.auditId,
      createdAt: item.createdAt,
      mode: item.mode,
      summary: { chat_count: item.chatCount, message_count: item.messageCount, incremental: item.mode === "incremental" },
    };
    await fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  }
}

function createStore(root, extra = {}) {
  return core.createAuditStore({
    auditRoot: root,
    auditPasswordFile: path.join(root, "audit-admin-password.txt"),
    openWebuiContainer: "open-webui",
    serviceContainer: "runtime",
    managerName: "vllm-manager",
    getContainerStatus: async () => ({ exists: true }),
    docker: async () => ({ stdout: "", stderr: "" }),
    onLog: () => {},
    ...extra,
  });
}

async function remainingIds(store) {
  return (await store.listAuditExports()).map((item) => item.auditId);
}

// The P0-OBS-6 prune loop as it shipped in audit-store.js, kept verbatim as
// the reference the planner is compared with. `exports` is newest first.
function p0ReferenceReasons(exports, { maxExports, maxAgeDays }, now) {
  const reasons = exports.map(() => "");
  if (exports.length <= 1) return reasons;
  const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * DAY_MS : 0;
  const newestFullIndex = exports.findIndex((item) => item.mode === "full");
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
    reasons[index] = reason;
  }
  return reasons;
}

// Deterministic generator for the layout sweeps (mulberry32).
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLayout(random) {
  const count = Math.floor(random() * 15);
  const ages = new Set();
  while (ages.size < count) ages.add(Math.floor(random() * 120 * 24) * HOUR_MS + 1);
  return Array.from(ages)
    .sort((a, b) => a - b)
    .map((ageMs, index) => entry(`x${String(index).padStart(2, "0")}`, {
      mode: random() < 0.3 ? "full" : "incremental",
      chatCount: random() < 0.3 ? 0 : 1 + Math.floor(random() * 4),
      ageMs,
    }));
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

// The live layout (docs/overhaul/04 §16.2): 30 exports taken every six hours,
// newest first. 22 are empty incrementals; the only full export with counts is
// at position 26, and the seven non-empty incrementals are all newer than it.
const LIVE_NON_EMPTY = new Set([1, 4, 9, 13, 17, 21, 24]);
const LIVE_FULL_POSITION = 26;
function liveLayout(now = NOW) {
  const entries = [];
  for (let position = 1; position <= 30; position += 1) {
    const ageMs = position * 6 * HOUR_MS;
    const auditId = `live-${String(position).padStart(2, "0")}`;
    if (position === LIVE_FULL_POSITION) entries.push(entry(`${auditId}-full`, { mode: "full", chatCount: 42, messageCount: 640, ageMs, now }));
    else if (LIVE_NON_EMPTY.has(position)) entries.push(entry(`${auditId}-inc`, { chatCount: 3, ageMs, now }));
    else entries.push(entry(`${auditId}-empty`, { chatCount: 0, ageMs, now }));
  }
  return entries;
}

// Ten weekly chains, newest first: c0 is the active chain. Each chain is a
// full export and two incrementals; nothing is old or numerous enough for the
// count and age rules.
function weeklyChains(count = 10, now = NOW) {
  const entries = [];
  for (let chain = 0; chain < count; chain += 1) {
    entries.push(entry(`c${chain}-inc2`, { ageMs: (7 * chain + 1) * DAY_MS, now }));
    entries.push(entry(`c${chain}-inc1`, { ageMs: (7 * chain + 2) * DAY_MS, now }));
    entries.push(entry(`c${chain}-full`, { mode: "full", chatCount: 10, ageMs: (7 * chain + 3) * DAY_MS, now }));
  }
  return entries;
}

const P0_POLICY = { maxExports: 30, maxAgeDays: 90, rebaselineDays: 7, maxChains: 8 };

test("every P0-OBS-6 retention case gives the same result through planAuditRetention", async (t) => {
  // audit-retention.test.js, case by case, with the default chain cap.
  const cases = [
    {
      name: "the newest full and every newer export are kept beyond the count",
      exports: [
        entry("e5-inc", { ageMs: 1 * DAY_MS }),
        entry("e4-inc", { ageMs: 2 * DAY_MS }),
        entry("e3-inc", { ageMs: 3 * DAY_MS }),
        entry("e2-full", { mode: "full", ageMs: 4 * DAY_MS }),
        entry("e1-inc", { ageMs: 5 * DAY_MS }),
        entry("e0-full", { mode: "full", ageMs: 6 * DAY_MS }),
      ],
      policy: { maxExports: 2, maxAgeDays: 0 },
      keep: ["e5-inc", "e4-inc", "e3-inc", "e2-full"],
      remove: [["e1-inc", "max-exports"], ["e0-full", "max-exports"]],
    },
    {
      name: "exports older than the newest full are pruned by age, the chain never is",
      exports: [
        entry("chain-inc", { ageMs: 100 * DAY_MS }),
        entry("chain-full", { mode: "full", ageMs: 120 * DAY_MS }),
        entry("old-full", { mode: "full", ageMs: 200 * DAY_MS }),
      ],
      policy: { maxExports: 30, maxAgeDays: 90 },
      keep: ["chain-inc", "chain-full"],
      remove: [["old-full", "max-age"]],
    },
    {
      name: "without a full export incrementals are never pruned, but empty ones are",
      exports: [
        entry("i4-empty-newest", { chatCount: 0, ageMs: 1 * DAY_MS }),
        entry("i3", { ageMs: 100 * DAY_MS }),
        entry("i2-empty", { chatCount: 0, ageMs: 200 * DAY_MS }),
        entry("i1", { ageMs: 300 * DAY_MS }),
      ],
      policy: { maxExports: 1, maxAgeDays: 1 },
      keep: ["i4-empty-newest", "i3", "i1"],
      remove: [["i2-empty", "empty-incremental"]],
    },
    {
      name: "an empty incremental older than the newest full is pruned within the limits",
      exports: [
        entry("c-full", { mode: "full", ageMs: 1 * DAY_MS }),
        entry("b-empty", { chatCount: 0, ageMs: 2 * DAY_MS }),
        entry("a-inc", { ageMs: 3 * DAY_MS }),
      ],
      policy: { maxExports: 30, maxAgeDays: 90 },
      keep: ["c-full", "a-inc"],
      remove: [["b-empty", "empty-incremental"]],
    },
    {
      // security-hardening.test.js: full, incremental, forced full, maxExports 2.
      name: "chain-aware count cap after a forced full export",
      exports: [
        entry("f3-full", { mode: "full", ageMs: 1000 }),
        entry("i2-inc", { ageMs: 2000 }),
        entry("f1-full", { mode: "full", ageMs: 3000 }),
      ],
      policy: { maxExports: 2 },
      keep: ["f3-full", "i2-inc"],
      remove: [["f1-full", "max-exports"]],
    },
    {
      name: "a single export is never pruned",
      exports: [entry("only-empty", { chatCount: 0, ageMs: 400 * DAY_MS })],
      policy: { maxExports: 1, maxAgeDays: 1 },
      keep: ["only-empty"],
      remove: [],
    },
  ];

  for (const item of cases) {
    const policy = { ...P0_POLICY, ...item.policy };
    // The input order must not matter: the planner sorts newest first itself.
    for (const exports of [item.exports, item.exports.slice().reverse()]) {
      const plan = planAuditRetention(exports, policy, NOW);
      assert.deepEqual(plan.keep, item.keep, item.name);
      assert.deepEqual(removedPairs(plan), item.remove, item.name);
    }
    // The planner removes exactly what the P0 loop removes here.
    const reference = p0ReferenceReasons(item.exports, policy, NOW);
    assert.deepEqual(
      item.exports.map((value, index) => [value.auditId, reference[index]]).filter(([, reason]) => reason),
      item.remove,
      item.name,
    );

    // pruneAuditExports deletes what the plan names, and nothing else.
    const root = await auditRootFor(t);
    await writeEntries(root, item.exports);
    const store = createStore(root);
    const result = await store.pruneAuditExports({
      auditMaxExports: policy.maxExports,
      auditMaxAgeDays: policy.maxAgeDays,
      now: NOW,
    });
    assert.deepEqual(result.removed.map((value) => [value.auditId, value.reason]), item.remove, item.name);
    assert.deepEqual(await remainingIds(store), item.keep, item.name);
    assert.equal(result.kept, item.keep.length);
  }
});

test("the planner matches the P0-OBS-6 loop on random layouts, and also drops empty incrementals inside the newest chain", () => {
  const random = seededRandom(20261014);
  for (let round = 0; round < 600; round += 1) {
    const exports = randomLayout(random);
    const policy = {
      maxExports: pick(random, [0, 1, 2, 3, 5, 30]),
      maxAgeDays: pick(random, [0, 1, 5, 30, 90]),
      rebaselineDays: 7,
      maxChains: 0,
    };
    const reference = p0ReferenceReasons(exports, policy, NOW);
    const newestFullIndex = exports.findIndex((item) => item.mode === "full");
    // The one rule P0-OBS-6 stated but its loop skipped: an empty incremental
    // is prunable anywhere except as the newest export.
    const expected = exports
      .map((item, index) => {
        if (reference[index]) return [item.auditId, reference[index]];
        if (index >= 1 && index <= newestFullIndex && item.mode === "incremental" && item.chatCount === 0) return [item.auditId, "empty-incremental"];
        return null;
      })
      .filter(Boolean);
    const plan = planAuditRetention(exports, policy, NOW);
    assert.deepEqual(removedPairs(plan), expected, `round ${round}`);
    assert.equal(plan.keep.length + plan.remove.length, exports.length);

    // The default cap changes nothing while there are at most eight chains.
    if (exports.filter((item) => item.mode === "full").length <= AUDIT_RETENTION_DEFAULTS.maxChains) {
      assert.deepEqual(planAuditRetention(exports, { ...policy, maxChains: 8 }, NOW), plan, `round ${round}`);
    }
  }
});

test("the live layout keeps the baseline and its non-empty incrementals under every chain cap", async (t) => {
  const exports = liveLayout();
  assert.equal(exports.length, 30);
  assert.equal(exports.filter((item) => item.chatCount === 0).length, 22);
  assert.equal(exports.findIndex((item) => item.mode === "full"), LIVE_FULL_POSITION - 1);

  const keep = ["live-01-inc", "live-04-inc", "live-09-inc", "live-13-inc", "live-17-inc", "live-21-inc", "live-24-inc", "live-26-full"];
  const removeIds = exports.map((item) => item.auditId).filter((id) => id.endsWith("-empty"));
  for (const maxChains of [1, 2, 8, 100]) {
    const plan = planAuditRetention(exports, { ...P0_POLICY, maxChains }, NOW);
    assert.deepEqual(plan.keep, keep, `maxChains ${maxChains}`);
    assert.deepEqual(removedPairs(plan), removeIds.map((id) => [id, "empty-incremental"]), `maxChains ${maxChains}`);
    assert.deepEqual(plan.warnings, []);
    assert.equal(plan.needsRebaseline, false, "the baseline is 6.5 days old");
  }

  const [chain] = groupAuditChains(exports);
  assert.equal(groupAuditChains(exports).length, 1);
  assert.equal(chain.fullAuditId, "live-26-full");
  assert.equal(chain.active, true);
  assert.equal(chain.incrementals, 25);
  assert.equal(chain.chats, 42 + 7 * 3);

  // The same layout on disk, pruned by the store with the default policy.
  const root = await auditRootFor(t);
  await writeEntries(root, exports);
  const store = createStore(root);
  const result = await store.pruneAuditExports({ now: NOW });
  assert.deepEqual(await remainingIds(store), keep);
  assert.equal(result.removed.length, 22);
  assert.ok(result.removed.every((item) => item.reason === "empty-incremental"));
  // A second run has nothing left to do.
  assert.deepEqual((await store.pruneAuditExports({ now: NOW })).removed, []);
});

test("maxChains removes whole chains older than the newest maxChains", async (t) => {
  const exports = weeklyChains(10);
  const chainIds = (from, to) => {
    const ids = [];
    for (let chain = from; chain < to; chain += 1) ids.push(`c${chain}-inc2`, `c${chain}-inc1`, `c${chain}-full`);
    return ids;
  };

  const capped = planAuditRetention(exports, P0_POLICY, NOW);
  assert.deepEqual(capped.keep, chainIds(0, 8));
  assert.deepEqual(removedPairs(capped), chainIds(8, 10).map((id) => [id, "max-chains"]));

  const two = planAuditRetention(exports, { ...P0_POLICY, maxChains: 2 }, NOW);
  assert.deepEqual(two.keep, chainIds(0, 2));
  assert.deepEqual(removedPairs(two), chainIds(2, 10).map((id) => [id, "max-chains"]));

  const one = planAuditRetention(exports, { ...P0_POLICY, maxChains: 1 }, NOW);
  assert.deepEqual(one.keep, chainIds(0, 1), "1 keeps the active chain only");

  const off = planAuditRetention(exports, { ...P0_POLICY, maxChains: 0 }, NOW);
  assert.deepEqual(off.remove, [], "0 disables the cap");

  // The P0 reasons win where both apply; the cap takes the rest of the chain.
  const counted = planAuditRetention(exports, { ...P0_POLICY, maxExports: 25, maxChains: 8 }, NOW);
  assert.deepEqual(removedPairs(counted), [
    ["c8-inc2", "max-chains"],
    ["c8-inc1", "max-exports"],
    ["c8-full", "max-exports"],
    ["c9-inc2", "max-exports"],
    ["c9-inc1", "max-exports"],
    ["c9-full", "max-exports"],
  ]);

  // Incrementals older than every kept chain go with the removed chains.
  const orphaned = [...weeklyChains(3), entry("pre-chain-inc", { ageMs: 30 * DAY_MS })];
  assert.deepEqual(removedPairs(planAuditRetention(orphaned, { ...P0_POLICY, maxChains: 2 }, NOW)), [
    ["c2-inc2", "max-chains"],
    ["c2-inc1", "max-chains"],
    ["c2-full", "max-chains"],
    ["pre-chain-inc", "max-chains"],
  ]);
  // With no more chains than the cap they stay, under the P0 rules.
  assert.deepEqual(planAuditRetention(orphaned, P0_POLICY, NOW).remove, []);

  // Through the store: auditMaxChains reaches the planner.
  const root = await auditRootFor(t);
  await writeEntries(root, exports);
  const store = createStore(root, { auditMaxChains: 3 });
  const result = await store.pruneAuditExports({ now: NOW });
  assert.deepEqual(await remainingIds(store), chainIds(0, 3));
  assert.deepEqual(result.removed.map((item) => item.reason), chainIds(3, 10).map(() => "max-chains"));
});

test("the cap never removes the active chain or a full export a kept incremental depends on", () => {
  const random = seededRandom(7);
  for (let round = 0; round < 600; round += 1) {
    const exports = randomLayout(random);
    const policy = {
      maxExports: pick(random, [0, 2, 4, 30]),
      maxAgeDays: pick(random, [0, 10, 90]),
      rebaselineDays: 7,
      maxChains: pick(random, [1, 2, 3, 8]),
    };
    const plan = planAuditRetention(exports, policy, NOW);
    const reasons = new Map(plan.remove.map((item) => [item.auditId, item.reason]));
    const byId = new Map(exports.map((item) => [item.auditId, item]));
    const chains = groupAuditChains(exports);
    if (exports.length) assert.equal(reasons.has(exports[0].auditId), false, "the newest export is kept");
    if (chains.length) {
      for (const auditId of chains[0].auditIds) {
        if (byId.get(auditId).chatCount > 0) assert.equal(reasons.has(auditId), false, `round ${round}: the active chain is kept`);
      }
    }
    for (const chain of chains) {
      if (reasons.get(chain.fullAuditId) !== "max-chains") continue;
      for (const auditId of chain.auditIds) assert.ok(reasons.has(auditId), `round ${round}: ${auditId} lost its full export to the cap`);
    }
    const keptChains = chains.filter((chain) => !reasons.has(chain.fullAuditId)).length;
    assert.ok(keptChains <= policy.maxChains, `round ${round}: ${keptChains} chains kept`);
  }

  // The count rule alone can still strand an incremental (P0-OBS-6 behaviour,
  // kept); the plan says so, and a cap of one chain removes it.
  const stranded = [
    entry("f3-full", { mode: "full", ageMs: 1000 }),
    entry("i2-inc", { ageMs: 2000 }),
    entry("f1-full", { mode: "full", ageMs: 3000 }),
  ];
  const plan = planAuditRetention(stranded, { ...P0_POLICY, maxExports: 2 }, NOW);
  assert.deepEqual(plan.warnings.map((item) => [item.code, item.auditIds]), [["orphaned_incrementals", ["i2-inc"]]]);
  assert.deepEqual(removedPairs(planAuditRetention(stranded, { ...P0_POLICY, maxExports: 2, maxChains: 1 }, NOW)), [
    ["i2-inc", "max-chains"],
    ["f1-full", "max-exports"],
  ]);
});

test("groupAuditChains groups each full export with the incrementals after it", () => {
  const exports = [
    entry("d-inc", { chatCount: 2, messageCount: 5, mdBytes: 100, ageMs: 1 * HOUR_MS }),
    entry("c-full", { mode: "full", chatCount: 9, messageCount: 40, mdBytes: 900, ageMs: 2 * HOUR_MS }),
    entry("b-empty", { chatCount: 0, ageMs: 3 * HOUR_MS }),
    { ...entry("a-legacy", { chatCount: 4, ageMs: 4 * HOUR_MS }), mode: "" },
    entry("pre-inc", { ageMs: 5 * HOUR_MS }),
  ];
  assert.deepEqual(groupAuditChains(exports.slice().reverse()), [
    {
      fullAuditId: "c-full",
      createdAt: exports[1].createdAt,
      updatedAt: exports[0].createdAt,
      auditIds: ["d-inc", "c-full"],
      incrementals: 1,
      chats: 11,
      messages: 45,
      bytes: 1000,
      active: true,
    },
    {
      // A legacy export without a mode counts as full.
      fullAuditId: "a-legacy",
      createdAt: exports[3].createdAt,
      updatedAt: exports[2].createdAt,
      auditIds: ["b-empty", "a-legacy"],
      incrementals: 1,
      chats: 4,
      messages: 4,
      bytes: 0,
      active: false,
    },
  ]);
  assert.deepEqual(groupAuditChains([]), []);
  assert.deepEqual(groupAuditChains([entry("only-inc")]), [], "incrementals without a full form no chain");

  const plan = planAuditRetention([entry("i2"), entry("i1", { ageMs: 1000 })], P0_POLICY, NOW);
  assert.deepEqual(plan.warnings.map((item) => item.code), ["no_full_export"]);
  assert.deepEqual(plan.keep, ["i2", "i1"]);
  const long = planAuditRetention([entry("i3"), entry("i2", { ageMs: 1 }), entry("i1", { ageMs: 2 }), entry("f", { mode: "full", ageMs: 3 })], { ...P0_POLICY, maxExports: 2 }, NOW);
  assert.deepEqual(long.warnings.map((item) => [item.code, item.kept]), [["over_max_exports", 4]], "the newest chain is not split");
});

test("needsRebaseline follows AI_AUDIT_REBASELINE_DAYS only", async (t) => {
  const exports = [
    entry("inc", { ageMs: 1 * DAY_MS }),
    entry("full", { mode: "full", ageMs: 6 * DAY_MS }),
    ...weeklyChains(10).map((item) => ({ ...item, auditId: `old-${item.auditId}`, createdAt: new Date(Date.parse(item.createdAt) - 30 * DAY_MS).toISOString() })),
  ];
  const at = (rebaselineDays, extra = {}) => planAuditRetention(exports, { ...P0_POLICY, ...extra, rebaselineDays }, NOW).needsRebaseline;
  assert.equal(at(7), false);
  assert.equal(at(5), true);
  assert.equal(at(0), false, "0 disables it");
  assert.equal(at(5.9), true, "fractional days count");
  // No other policy field moves it.
  for (const extra of [{ maxChains: 1 }, { maxChains: 0 }, { maxExports: 1 }, { maxAgeDays: 1 }, { maxExports: 0, maxAgeDays: 0 }]) {
    assert.equal(at(7, extra), false);
    assert.equal(at(5, extra), true);
  }
  assert.equal(planAuditRetention([entry("inc")], { rebaselineDays: 7 }, NOW).needsRebaseline, true, "no full export");
  assert.equal(planAuditRetention([], { rebaselineDays: 7 }, NOW).needsRebaseline, true);
  assert.equal(planAuditRetention([entry("inc")], { rebaselineDays: 0 }, NOW).needsRebaseline, false);

  // The environment variable reaches the plan through auditRetentionSettings,
  // and auditMaxChains has no environment variable.
  const previous = { rebaseline: process.env.AI_AUDIT_REBASELINE_DAYS };
  t.after(() => {
    if (previous.rebaseline === undefined) delete process.env.AI_AUDIT_REBASELINE_DAYS;
    else process.env.AI_AUDIT_REBASELINE_DAYS = previous.rebaseline;
  });
  process.env.AI_AUDIT_REBASELINE_DAYS = "5";
  assert.equal(planAuditRetention(exports, core.auditRetentionSettings({}), NOW).needsRebaseline, true);
  process.env.AI_AUDIT_REBASELINE_DAYS = "0";
  assert.equal(planAuditRetention(exports, core.auditRetentionSettings({}), NOW).needsRebaseline, false);
  process.env.AI_AUDIT_REBASELINE_DAYS = "10";
  assert.equal(planAuditRetention(exports, core.auditRetentionSettings({ auditMaxChains: 1 }), NOW).needsRebaseline, false);
  assert.equal(core.auditRetentionSettings({}).maxChains, 8);
  assert.equal(core.DEFAULT_AUDIT_MAX_CHAINS, 8);
  assert.equal(core.auditRetentionSettings({ auditMaxChains: 3 }).maxChains, 3);

  // The exporter decides with the same rule: with AI_AUDIT_REBASELINE_DAYS=10
  // an 8-day-old full export is still the base of the next incremental.
  const root = await auditRootFor(t);
  const store = createStore(root, { docker: exporterDocker({ calls: [] }) });
  const first = await store.exportOpenWebuiAudit("manual", {});
  const manifestFile = path.join(first.auditDir, "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestFile, "utf8"));
  manifest.createdAt = new Date(Date.now() - 8 * DAY_MS).toISOString();
  await fsp.writeFile(manifestFile, JSON.stringify(manifest), "utf8");
  assert.equal((await store.exportOpenWebuiAudit("model-stop", {})).mode, "incremental");
  process.env.AI_AUDIT_REBASELINE_DAYS = "7";
  const rebased = await store.exportOpenWebuiAudit("model-unload", {});
  assert.equal(rebased.mode, "full");
  assert.equal(rebased.rebaseline, true);
});

// A fake docker for the exporter. The python step can be held open with
// state.gate, and state.started is called once it runs.
function exporterDocker(state) {
  let updatedAt = 100;
  return async (args) => {
    state.calls.push(args);
    if (args[0] === "exec" && args[2] === "python") {
      state.started?.();
      if (state.gate) await state.gate;
      updatedAt += 100;
      return {
        stdout: JSON.stringify({
          ok: true,
          incremental: args.length > 5,
          since_updated_at: args[5] === undefined ? null : Number(args[5]),
          chat_count: 1,
          total_chat_count: 1,
          message_count: 1,
          max_updated_at: updatedAt,
          files: [],
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
}

const pythonRuns = (state) => state.calls.filter((args) => args[0] === "exec" && args[2] === "python").length;

test("concurrent exports from both managers give one export_in_progress", async (t) => {
  const root = await auditRootFor(t);
  const state = { calls: [] };
  const vllm = createStore(root, { docker: exporterDocker(state), managerName: "vllm-manager" });
  const llama = createStore(root, { docker: exporterDocker(state), managerName: "llama-manager" });

  const results = await Promise.all([vllm.exportOpenWebuiAudit("manual", {}), llama.exportOpenWebuiAudit("manual", {})]);
  const busy = results.filter((item) => item.reason === "export_in_progress");
  assert.equal(busy.length, 1);
  assert.deepEqual({ ...busy[0], message: undefined }, { ok: false, skipped: true, reason: "export_in_progress", message: undefined });
  assert.equal(results.filter((item) => item.ok === true && item.auditId).length, 1);
  assert.equal(pythonRuns(state), 1, "only one exporter ran");
  assert.equal(fs.existsSync(path.join(root, core.AUDIT_EXPORT_LOCK_FILE)), false, "the lock is released");

  // While one export holds the lock, the other manager and pruning skip.
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  let open;
  state.gate = new Promise((resolve) => { open = resolve; });
  state.started = started;
  const first = vllm.exportOpenWebuiAudit("model-stop", {});
  await running;
  const lock = JSON.parse(await fsp.readFile(path.join(root, core.AUDIT_EXPORT_LOCK_FILE), "utf8"));
  assert.deepEqual(Object.keys(lock).sort(), ["at", "owner", "pid"]);
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.owner, "vllm-manager");
  assert.ok(Number.isFinite(Date.parse(lock.at)));
  assert.equal((await llama.exportOpenWebuiAudit("model-unload", {})).reason, "export_in_progress");
  const pruned = await llama.pruneAuditExports({ now: NOW });
  assert.equal(pruned.reason, "export_in_progress");
  assert.equal(pruned.skipped, true);
  assert.deepEqual(pruned.removed, []);
  open();
  assert.equal((await first).mode, "incremental");
  state.gate = null;
  assert.equal(fs.existsSync(path.join(root, core.AUDIT_EXPORT_LOCK_FILE)), false);

  // Once released, the other manager exports again.
  const after = await llama.exportOpenWebuiAudit("model-unload", {});
  assert.equal(after.ok, true);
  assert.equal(after.mode, "incremental");
  assert.equal(pythonRuns(state), 3);

  // A failed run releases the lock as well.
  const failing = createStore(root, { docker: async (args) => (args[2] === "python" ? { stdout: "", stderr: "boom", error: new Error("exit 1") } : { stdout: "", stderr: "" }) });
  await assert.rejects(failing.exportOpenWebuiAudit("manual", {}), /audit export failed/);
  assert.equal(fs.existsSync(path.join(root, core.AUDIT_EXPORT_LOCK_FILE)), false);
});

test("a held lock is respected, a stale or dead-pid lock is broken and logged", async (t) => {
  async function withLock(t, content, { mtimeAgeMs = 0, extra = {} } = {}) {
    const root = await auditRootFor(t);
    const lockFile = path.join(root, core.AUDIT_EXPORT_LOCK_FILE);
    await fsp.writeFile(lockFile, content, "utf8");
    if (mtimeAgeMs) {
      const when = new Date(Date.now() - mtimeAgeMs);
      await fsp.utimes(lockFile, when, when);
    }
    const state = { calls: [] };
    const logs = [];
    const store = createStore(root, { docker: exporterDocker(state), onLog: (line) => logs.push(line), ...extra });
    return { root, lockFile, state, logs, store };
  }
  const lockText = (pid, ageMs, owner = "llama-manager") => `${JSON.stringify({ pid, at: new Date(Date.now() - ageMs).toISOString(), owner })}\n`;

  // A fresh lock of a live process holds: nothing runs and the lock stays.
  const heldText = lockText(process.pid, 60 * 1000);
  const held = await withLock(t, heldText);
  assert.equal((await held.store.exportOpenWebuiAudit("manual", {})).reason, "export_in_progress");
  assert.equal((await held.store.pruneAuditExports({ now: NOW })).reason, "export_in_progress");
  assert.equal(pythonRuns(held.state), 0);
  assert.equal(await fsp.readFile(held.lockFile, "utf8"), heldText);
  assert.deepEqual(held.logs, []);

  // Older than 30 minutes: broken, logged, and the export runs.
  const stale = await withLock(t, lockText(process.pid, 31 * 60 * 1000));
  const staleRun = await stale.store.exportOpenWebuiAudit("manual", {});
  assert.equal(staleRun.ok, true);
  assert.equal(pythonRuns(stale.state), 1);
  assert.equal(stale.logs.length, 1);
  assert.match(stale.logs[0], /broke a stale export lock \(older than 30 minutes; pid \d+, owner llama-manager/);
  assert.equal(fs.existsSync(stale.lockFile), false);

  // Held by a process that has exited: broken at once, through the real
  // process probe.
  const exited = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
  assert.ok(Number.isInteger(exited.pid) && exited.pid > 0);
  const dead = await withLock(t, lockText(exited.pid, 1000));
  const deadRun = await dead.store.exportOpenWebuiAudit("model-stop", {});
  assert.equal(deadRun.ok, true);
  assert.equal(dead.logs.length, 1);
  assert.match(dead.logs[0], new RegExp(`owner process has exited; pid ${exited.pid}`));
  // Pruning breaks it the same way.
  const deadPrune = await withLock(t, lockText(exited.pid, 1000));
  const prunedResult = await deadPrune.store.pruneAuditExports({ now: NOW });
  assert.deepEqual(prunedResult.removed, []);
  assert.equal(prunedResult.reason, undefined);
  assert.equal(deadPrune.logs.length, 1);

  // A lock caught before its first write has no content; its file time
  // decides.
  const blank = await withLock(t, "");
  assert.equal((await blank.store.exportOpenWebuiAudit("manual", {})).reason, "export_in_progress");
  const blankOld = await withLock(t, "", { mtimeAgeMs: 31 * 60 * 1000 });
  assert.equal((await blankOld.store.exportOpenWebuiAudit("manual", {})).ok, true);
  assert.match(blankOld.logs[0], /older than 30 minutes; pid unknown, owner unknown/);

  // Another process breaks the same stale lock first and takes a fresh one:
  // that lock is put back and this caller skips.
  const fresh = lockText(process.pid, 0, "vllm-manager");
  const raced = await withLock(t, lockText(424242, 1000), {
    extra: {
      isProcessAlive: (pid) => {
        if (pid === 424242) fs.writeFileSync(path.join(raced.root, core.AUDIT_EXPORT_LOCK_FILE), fresh, "utf8");
        return pid !== 424242;
      },
    },
  });
  assert.equal((await raced.store.exportOpenWebuiAudit("manual", {})).reason, "export_in_progress");
  assert.equal(await fsp.readFile(raced.lockFile, "utf8"), fresh);
  assert.equal(pythonRuns(raced.state), 0);
  assert.deepEqual(raced.logs, []);
  const leftovers = (await fsp.readdir(raced.root)).filter((name) => name.endsWith(".stale"));
  assert.deepEqual(leftovers, []);

  // A lock taken over while an export ran is left alone on release.
  const taken = await withLock(t, lockText(process.pid, 31 * 60 * 1000));
  const foreign = lockText(process.pid, 0, "llama-manager");
  taken.state.started = () => fs.writeFileSync(taken.lockFile, foreign, "utf8");
  assert.equal((await taken.store.exportOpenWebuiAudit("manual", {})).ok, true);
  assert.equal(await fsp.readFile(taken.lockFile, "utf8"), foreign);
});
