/**
 * Enforces one response budget across both channels a tool answers on.
 *
 * `maxResponseChars` used to bound only the rendered text while
 * `structuredContent` carried the untouched payload, so the configured limit
 * did not bound what actually reached the caller — and the truncation note
 * claimed the structured side "remains bounded", which was not true. The
 * budget is now applied to the payload itself, before either channel is
 * built, and what was dropped is reported in the envelope's own `warnings`.
 *
 * Trimming only shortens arrays and strings, so a trimmed payload still
 * satisfies the published output schema. Where a payload carries the
 * project's pagination envelope, the companion counters are kept coherent so
 * the caller can resume from `next_offset` instead of silently losing records.
 */

export type BudgetResult<T> = {
  /** Serializes within the limit, or carries a warning saying why it cannot. */
  payload: T;
  truncated: boolean;
  chars: number;
  /** True when even the floor-trimmed payload does not fit. */
  overBudget: boolean;
};

/** Below this an array is left alone; dropping the last item or two saves little. */
const MIN_ARRAY_ITEMS = 1;
/** Strings shorter than this are never cut; the noise is not worth the bytes. */
const STRING_FLOOR = 240;
/** Deepest level walked. Payloads here are shallow; this only stops cycles. */
const MAX_DEPTH = 12;
const MAX_ROUNDS = 64;
/** Room held back for the notes that explain a trim, which ship inside the payload. */
const NOTE_ALLOWANCE_CHARS = 400;
/** A string at or above this share of the payload is shortened before records are dropped. */
const DOMINANT_STRING_SHARE = 0.1;

type ArrayTarget = { kind: "array"; parent: Record<string, unknown>; key: string; path: string; original: number };
type StringTarget = { kind: "string"; parent: Record<string, unknown> | unknown[]; key: string | number; path: string; original: number };
type Target = ArrayTarget | StringTarget;

export function applyResponseBudget<T extends Record<string, unknown>>(payload: T, maxChars: number): BudgetResult<T> {
  const limit = Math.max(500, Math.trunc(maxChars) || 0);
  let serialized = measure(payload);
  if (serialized <= limit) {
    return { payload, truncated: false, chars: serialized, overBudget: false };
  }
  // The notes are part of the payload, so the trimming target leaves room for
  // them. Without this the annotated payload ends up larger than the limit
  // that the trimming was supposed to enforce.
  const trimTarget = Math.max(Math.floor(limit / 2), limit - NOTE_ALLOWANCE_CHARS);

  // Only the copy is trimmed; the caller's payload (and any cached upstream
  // object behind it) is left intact.
  const working = structuredClone(payload) as T;
  const targets = collectTargets(working);
  const trimmedArrays = new Map<string, { kept: number; original: number }>();
  const trimmedStrings = new Map<string, { kept: number; original: number }>();

  for (let round = 0; round < MAX_ROUNDS && serialized > trimTarget; round += 1) {
    const victim = largestTarget(targets, serialized);
    if (!victim) break;
    if (victim.kind === "array") {
      const current = victim.parent[victim.key] as unknown[];
      const kept = Math.max(MIN_ARRAY_ITEMS, Math.floor(current.length / 2));
      if (kept >= current.length) {
        drop(targets, victim);
        continue;
      }
      victim.parent[victim.key] = current.slice(0, kept);
      repairPagination(victim.parent, kept);
      trimmedArrays.set(victim.path, { kept, original: victim.original });
    } else {
      const container = victim.parent as Record<string | number, unknown>;
      const current = String(container[victim.key]);
      const kept = Math.max(STRING_FLOOR, Math.floor(current.length / 2));
      if (kept >= current.length) {
        drop(targets, victim);
        continue;
      }
      container[victim.key] = `${current.slice(0, kept)}…`;
      trimmedStrings.set(victim.path, { kept, original: victim.original });
    }
    serialized = measure(working);
  }

  const notes: string[] = [];
  for (const [path, info] of trimmedArrays) {
    notes.push(
      `Response budget: ${path} holds ${info.kept} of ${info.original} records. `
      + "Narrow the filters, or page with offset and limit, to see the rest.",
    );
  }
  for (const [path, info] of trimmedStrings) {
    notes.push(
      `Response budget: ${path} was cut to ${info.kept} of ${info.original} characters. `
      + "Request a smaller slice, or search inside the page, to read the rest.",
    );
  }

  const annotated = notes.length ? annotate(working, notes) : working;
  let finalChars = measure(annotated);
  if (finalChars > limit) {
    // Arrays are already at one item and strings at the floor, so the rest is
    // required fields. Dropping those would break the published schema, so the
    // payload is returned intact and the caller is told the limit was not met
    // rather than being handed a quietly oversized reply.
    const over = annotate(working, [
      ...notes,
      `Response budget: this reply is ${finalChars} characters against a ${limit}-character limit, `
      + "and could not be trimmed further without dropping required fields. "
      + "Raise PLATFORM_MCP_MAX_RESPONSE_CHARS, or request less in one call.",
    ]);
    finalChars = measure(over);
    return { payload: over, truncated: true, chars: finalChars, overBudget: true };
  }
  return { payload: annotated, truncated: notes.length > 0, chars: finalChars, overBudget: false };
}

/**
 * Records a trim where the caller already looks for caveats: every payload
 * carries `warnings`, so the note goes there rather than in a field only this
 * server knows about.
 */
function annotate<T extends Record<string, unknown>>(payload: T, notes: string[]): T {
  const existing = Array.isArray(payload.warnings) ? payload.warnings as string[] : [];
  return { ...payload, truncated: true, warnings: [...existing, ...notes] };
}

/**
 * Keeps `count`, `has_more`, and `next_offset` describing what was actually
 * returned, so a caller that resumes from `next_offset` gets the records the
 * budget dropped rather than skipping them.
 */
function repairPagination(parent: Record<string, unknown>, kept: number): void {
  if (typeof parent.count === "number") parent.count = kept;
  if (typeof parent.has_more === "boolean") parent.has_more = true;
  if (typeof parent.offset === "number" && "next_offset" in parent) parent.next_offset = parent.offset + kept;
}

function collectTargets(root: Record<string, unknown>): Target[] {
  const targets: Target[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "string" && item.length > STRING_FLOOR) {
          targets.push({ kind: "string", parent: value, key: index, path: `${path}[${index}]`, original: item.length });
          return;
        }
        walk(item, `${path}[${index}]`, depth + 1);
      });
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      const childPath = path ? `${path}.${key}` : key;
      if (Array.isArray(item)) {
        if (item.length > MIN_ARRAY_ITEMS) {
          targets.push({ kind: "array", parent: record, key, path: childPath, original: item.length });
        }
        walk(item, childPath, depth + 1);
        continue;
      }
      if (typeof item === "string") {
        if (item.length > STRING_FLOOR) {
          targets.push({ kind: "string", parent: record, key, path: childPath, original: item.length });
        }
        continue;
      }
      walk(item, childPath, depth + 1);
    }
  };
  walk(root, "", 0);
  return targets;
}

/**
 * Chooses what to shorten next.
 *
 * Shortening a long string and dropping a record are not equivalent losses. A
 * dropped record takes its identity with it — the URL, title, and metadata
 * that let a caller go back for the rest — while a shortened string keeps the
 * record and loses only its tail, which every tool that returns long text can
 * re-request through its own character arguments.
 *
 * So a string is shortened first when it is a large share of the payload, as
 * an extracted page's text is. A string that is a small share, like a job
 * title, is left alone: halving hundreds of those would not reach the budget,
 * and records are the right thing to drop there because pagination can
 * resume from where the trim stopped.
 */
function largestTarget(targets: Target[], totalChars: number): Target | null {
  let bestString: Target | null = null;
  let bestStringCost = 0;
  let bestArray: Target | null = null;
  let bestArrayCost = 0;
  for (const target of targets) {
    const container = target.parent as Record<string | number, unknown>;
    const value = container[target.key];
    if (target.kind === "array") {
      const cost = Array.isArray(value) ? measure(value) : 0;
      if (cost > bestArrayCost) {
        bestArrayCost = cost;
        bestArray = target;
      }
      continue;
    }
    const cost = String(value ?? "").length;
    if (cost > bestStringCost) {
      bestStringCost = cost;
      bestString = target;
    }
  }
  if (bestString && bestStringCost >= totalChars * DOMINANT_STRING_SHARE) return bestString;
  return bestArray ?? bestString;
}

function drop(targets: Target[], target: Target): void {
  const index = targets.indexOf(target);
  if (index >= 0) targets.splice(index, 1);
}

function measure(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}
