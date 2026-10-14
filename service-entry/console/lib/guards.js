// Runtime guards for API responses (07 §3.4).
//
// A lenient DSL: objects may carry keys the guard does not name, and an
// invalid array item is dropped and counted instead of failing the whole
// response, so one bad instance never blanks a list. A guard is a function
// (value, path, ctx) -> { ok, value }; check() runs one and collects the
// errors as { path, expected, got }.

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createContext() {
  return { errors: [], dropped: 0 };
}

function fail(ctx, path, expected, value) {
  ctx.errors.push({ path, expected, got: describe(value) });
  return { ok: false };
}

function makeGuard(expected, run) {
  const guard = (value, path = "$", ctx = createContext()) => run(value, path, ctx);
  guard.expected = expected;
  return guard;
}

function primitive(expected, test) {
  return makeGuard(expected, (value, path, ctx) => (test(value) ? { ok: true, value } : fail(ctx, path, expected, value)));
}

export const str = primitive("string", (value) => typeof value === "string");
export const num = primitive("number", (value) => typeof value === "number" && Number.isFinite(value));
export const int = primitive("integer", (value) => Number.isInteger(value));
export const bool = primitive("boolean", (value) => typeof value === "boolean");
export const iso = primitive("ISO date", (value) => typeof value === "string" && value.length >= 4 && !Number.isNaN(Date.parse(value)));
export const any = makeGuard("any", (value) => ({ ok: true, value }));

/** The key may be absent (undefined); present values must pass `guard`. */
export function opt(guard) {
  return makeGuard(`${guard.expected}?`, (value, path, ctx) => (value === undefined ? { ok: true, value } : guard(value, path, ctx)));
}

/** null passes; anything else must pass `guard`. */
export function nullable(guard) {
  return makeGuard(`${guard.expected}|null`, (value, path, ctx) => (value === null ? { ok: true, value } : guard(value, path, ctx)));
}

/** One of the listed literal values (compared with ===). */
export function oneOf(...values) {
  const expected = values.map((value) => JSON.stringify(value)).join("|");
  return makeGuard(expected, (value, path, ctx) => (values.includes(value) ? { ok: true, value } : fail(ctx, path, expected, value)));
}

/**
 * An array of `guard`. With dropInvalid (the default) an invalid item is
 * left out and counted in `dropped`; without it the array fails.
 */
export function arr(guard, { dropInvalid = true } = {}) {
  return makeGuard(`array<${guard.expected}>`, (value, path, ctx) => {
    if (!Array.isArray(value)) return fail(ctx, path, `array<${guard.expected}>`, value);
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      const itemCtx = createContext();
      const result = guard(value[index], `${path}[${index}]`, itemCtx);
      ctx.dropped += itemCtx.dropped;
      if (result.ok) {
        out.push(result.value);
      } else if (dropInvalid) {
        ctx.dropped += 1;
      } else {
        ctx.errors.push(...itemCtx.errors);
        return { ok: false };
      }
    }
    return { ok: true, value: out };
  });
}

/**
 * A plain object whose named keys pass their guards. Keys the shape does not
 * name are kept unchanged; an `opt` key that is absent stays absent.
 */
export function obj(shape) {
  const names = Object.keys(shape);
  return makeGuard("object", (value, path, ctx) => {
    if (!isPlainObject(value)) return fail(ctx, path, "object", value);
    const out = { ...value };
    for (const name of names) {
      const result = shape[name](value[name], `${path}.${name}`, ctx);
      if (!result.ok) return { ok: false };
      if (result.value !== undefined) out[name] = result.value;
    }
    return { ok: true, value: out };
  });
}

/** A plain object used as a map; every value must pass `guard`. */
export function record(guard) {
  return makeGuard(`record<${guard.expected}>`, (value, path, ctx) => {
    if (!isPlainObject(value)) return fail(ctx, path, `record<${guard.expected}>`, value);
    const out = {};
    for (const [name, item] of Object.entries(value)) {
      const result = guard(item, `${path}.${name}`, ctx);
      if (!result.ok) return { ok: false };
      out[name] = result.value;
    }
    return { ok: true, value: out };
  });
}

/** `guard` plus a predicate over its result; `expected` names the rule in errors. */
export function refine(guard, predicate, expected) {
  return makeGuard(expected, (value, path, ctx) => {
    const result = guard(value, path, ctx);
    if (!result.ok) return result;
    let passed = false;
    try {
      passed = Boolean(predicate(result.value));
    } catch {
      passed = false;
    }
    return passed ? result : fail(ctx, path, expected, value);
  });
}

/**
 * Runs `guard` over `value`.
 * @returns {{ ok: boolean, value: any, errors: Array<{path, expected, got}>, dropped: number }}
 */
export function check(guard, value) {
  const ctx = createContext();
  let result;
  try {
    result = guard(value, "$", ctx);
  } catch {
    result = { ok: false };
    ctx.errors.push({ path: "$", expected: guard?.expected || "guard", got: describe(value) });
  }
  return { ok: Boolean(result.ok), value: result.ok ? result.value : undefined, errors: ctx.errors, dropped: ctx.dropped };
}
