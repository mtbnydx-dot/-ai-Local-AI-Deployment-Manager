// The rules behind the CompatMatrix (07 §6.3 step 2, 02 §9, R-UI-2), pure so
// they can be tested without a DOM: what a row shows (never green without
// evidence), which rows can be chosen, which one is recommended and why, and
// how one GPU's fit reads. components/compat-matrix.js draws the result.

export const VERDICTS = Object.freeze(["ok", "warn", "block", "unknown"]);
export const VERDICT_STATUS = Object.freeze({ ok: "ok", warn: "warn", block: "error", unknown: "unknown" });
const VERDICT_ORDER = Object.freeze({ ok: 0, warn: 1, unknown: 2, block: 3 });
const FIT_RANK = Object.freeze({ ok: 0, warn: 1, fail: 2 });

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What a row shows: an `ok` without `supportEvidence` is unknown, never green (R-UI-2); a bad verdict is unknown. */
export function displayVerdict(row) {
  const verdict = VERDICTS.includes(row?.verdict) ? row.verdict : "unknown";
  if (verdict === "ok" && !list(row?.supportEvidence).length) return "unknown";
  return verdict;
}

export function rowKey(row) {
  return `${row?.engineId || ""}::${row?.runtimeId || ""}`;
}

/** engineId → { managerId, label, status, tier, runtimes: Map } from GET /api/engines. */
export function engineIndex(response) {
  const out = new Map();
  for (const engine of list(isObject(response) ? response.engines : response)) {
    if (!isObject(engine) || typeof engine.engineId !== "string") continue;
    out.set(engine.engineId, {
      engineId: engine.engineId,
      managerId: typeof engine.managerId === "string" ? engine.managerId : "",
      label: engine.label,
      status: typeof engine.status === "string" ? engine.status : "",
      tier: engine.tier,
      runtimes: new Map(list(engine.runtimes).filter((runtime) => isObject(runtime) && typeof runtime.runtimeId === "string").map((runtime) => [runtime.runtimeId, runtime])),
    });
  }
  return out;
}

/** Whether a launch of this engine needs `acknowledge: ["experimental-engine"]` (01 §11). */
export function isExperimental(meta) {
  return meta?.status === "experimental" || meta?.tier === 2 || meta?.tier === "experimental";
}

/**
 * The rows to draw, best verdict first. External endpoints are not models
 * served by a launch, so they are left out. `selectable` is a runnable row
 * (ok or warn) whose engine has a host manager.
 */
export function viewRows(rows, engines) {
  const index = engines instanceof Map ? engines : engineIndex(engines);
  const views = list(rows).filter((row) => isObject(row) && typeof row.engineId === "string" && row.engineId !== "external").map((row, order) => {
    const meta = index.get(row.engineId) || null;
    const verdict = displayVerdict(row);
    const runtime = meta?.runtimes.get(row.runtimeId) || null;
    return {
      key: rowKey(row),
      order,
      engineId: row.engineId,
      runtimeId: typeof row.runtimeId === "string" ? row.runtimeId : "",
      managerId: meta?.managerId || "",
      label: meta?.label,
      experimental: isExperimental(meta),
      verdict,
      rawVerdict: row.verdict,
      evidence: list(row.supportEvidence),
      reasons: list(row.reasons),
      fit: isObject(row.fitPreview) ? row.fitPreview.status || null : null,
      runtime,
      selectable: (verdict === "ok" || verdict === "warn") && Boolean(meta?.managerId),
      canOverride: verdict === "unknown" && Boolean(meta?.managerId),
    };
  });
  return views.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.order - b.order);
}

/**
 * The row the wizard recommends: runnable (never unknown or blocked), the one
 * that fits best, a stable engine, then the runtime marked default. Null when
 * nothing qualifies.
 */
export function recommendedKey(views) {
  const candidates = list(views).filter((view) => view.selectable);
  if (!candidates.length) return null;
  const fit = (view) => (Object.hasOwn(FIT_RANK, view.fit) ? FIT_RANK[view.fit] : 1);
  const best = [...candidates].sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]
    || fit(a) - fit(b)
    || Number(a.experimental) - Number(b.experimental)
    || Number(!a.runtime?.default) - Number(!b.runtime?.default)
    || a.order - b.order)[0];
  return best.key;
}

/**
 * Why a row is the pick, as keys below `models.wizard.engine.why.` (the "Why this engine" panel):
 * what makes it runnable, the evidence behind that, how it fits, and which defaults it follows.
 */
export function whyReasons(view) {
  if (!view) return [];
  const out = [];
  if (view.verdict === "ok" || view.verdict === "warn") out.push(`verdict.${view.verdict}`);
  if (view.evidence?.length) out.push("evidence");
  if (view.fit === "ok" || view.fit === "warn") out.push(`fit.${view.fit}`);
  if (!view.experimental) out.push("stable");
  if (view.runtime?.default) out.push("defaultRuntime");
  return out;
}

/** One GPU's fit badge from the rows of a compatibility request made for that GPU alone: ok, warn (needs offload or spill), fail, unknown. */
export function fitBadgeFor(rows) {
  const statuses = list(rows).map((row) => (isObject(row?.fitPreview) ? row.fitPreview.status : null)).filter((status) => Object.hasOwn(FIT_RANK, status));
  if (!statuses.length) return "unknown";
  if (statuses.includes("ok")) return "ok";
  if (statuses.includes("warn")) return "warn";
  return "fail";
}
