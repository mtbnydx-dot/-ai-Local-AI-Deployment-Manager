"use strict";

// Generic appended emission of catalog parameters (docs/overhaul/01-engines.md
// §6.1, §9.2, §9.4, ENG-17). The tier-1 adapters keep building the legacy
// engine args in today's order; the parameters that did not exist before P1
// (emit.mode "catalog") are appended after them by this one function, in the
// catalog's own parameter order (group, then `order`), and only when set. An
// unset parameter emits nothing, so a launch that sets none of them keeps
// today's argv byte for byte.
//
// What it reads, all through arguments (no I/O besides the cached bundled
// catalog when the caller passes none):
//   catalog   a loaded catalog (loadCatalog(engineId, { runtime, introspected })),
//             else the process-wide one for ctx.runtime
//   values    effective values by param id, plain or { value, source }
//   toContainerPath, runtime   from the adapter ctx
//   existingArgs   the engine args built so far: a flag already there is never
//             emitted twice, which is how a recipe's fixed args win
//   skip(param)    true to leave a parameter out (a recipe supplied its group)

const paramCatalog = require("../param-catalog");

// Methods vLLM builds a --speculative-config for. "off", "auto" and "dspark"
// emit nothing: recipes (vllm.speculativeConfig) own those.
const VLLM_SPECULATIVE_METHODS = new Set(["eagle3", "draft_model", "ngram", "mtp", "qwen3_next_mtp"]);
const DEFAULT_SPECULATIVE_TOKENS = 3;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrap(entry) {
  return isPlainObject(entry) && Object.hasOwn(entry, "value") && Object.hasOwn(entry, "source") ? entry.value : entry;
}

function isFlagToken(token) {
  return typeof token === "string" && /^--?[A-Za-z][A-Za-z0-9._-]*$/.test(token);
}

function isUnset(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function positiveInteger(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function jsonArg(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function scalarArg(param, value, toContainerPath) {
  const transform = param.emit.transform;
  if (transform === "containerPath") return String(toContainerPath(String(value)));
  if (transform === "jsonStringify") return JSON.stringify(value);
  return String(value);
}

// --- list and composite formats (emit.format) --------------------------------

const FORMATS = Object.freeze({
  // -ot <regex>=<buffer>, one flag per item.
  "tensor-override": (items, { flag }) => items.flatMap((item) => [flag, `${item.pattern}=${item.buffer}`]),
  // --lora path, or --lora-scaled path scale when the item has a scale.
  "lora-scaled": (items, { flag, toContainerPath }) => items.flatMap((item) => (
    item.scale === undefined || item.scale === null || item.scale === ""
      ? [flag, String(toContainerPath(String(item.path)))]
      : [`${flag}-scaled`, String(toContainerPath(String(item.path))), String(item.scale)]
  )),
  // --enable-lora --lora-modules name=path ...: one flag, all modules.
  "lora-modules": (items, { flag, toContainerPath }) => [
    "--enable-lora",
    flag,
    ...items.map((item) => `${item.name}=${toContainerPath(String(item.path))}`),
  ],
  // --speculative-config {method, model, num_speculative_tokens} (vLLM).
  "speculative-config": (method, { flag, read, toContainerPath }) => {
    const name = String(method).trim().toLowerCase();
    if (!VLLM_SPECULATIVE_METHODS.has(name)) return [];
    const config = { method: name };
    const draft = read("speculative.draftModel");
    if (!isUnset(draft)) config.model = String(toContainerPath(String(draft)));
    config.num_speculative_tokens = positiveInteger(read("speculative.numTokens")) || DEFAULT_SPECULATIVE_TOKENS;
    return [flag, JSON.stringify(config)];
  },
});

function mapped(map, value) {
  const key = String(value);
  if (Object.hasOwn(map, key)) return map[key];
  const lower = key.toLowerCase();
  const hit = Object.keys(map).find((name) => name.toLowerCase() === lower);
  return hit === undefined ? null : map[hit];
}

// A parameter's value -> its argv tokens ([] when the value emits nothing).
function render(param, value, { read, toContainerPath }) {
  const emit = param.emit;
  const flag = param.flag || emit.flag;
  const format = emit.format ? FORMATS[emit.format] : null;
  switch (emit.kind) {
    case "flag-bool":
      return value === true && flag ? [flag] : [];
    case "bool-pair":
      if (value === true) return emit.flag ? [emit.flag] : [];
      if (value === false) return emit.falseFlag ? [emit.falseFlag] : [];
      return [];
    case "flag-value": {
      if (emit.map) return [...(mapped(emit.map, value) || [])];
      if (emit.via && typeof value === "boolean") {
        // A switch that carries another parameter's value (--ep-size = TP).
        return value === true && flag ? [flag, String(positiveInteger(read(emit.via)) || 1)] : [];
      }
      return flag ? [flag, scalarArg(param, value, toContainerPath)] : [];
    }
    case "json":
      if (format) return format(value, { flag, read, toContainerPath });
      return flag ? [flag, jsonArg(value)] : [];
    case "csv":
      return flag ? [flag, Array.isArray(value) ? value.join(",") : String(value)] : [];
    case "repeat": {
      const items = Array.isArray(value) ? value : [value];
      if (format) return format(items, { flag, read, toContainerPath });
      return flag ? items.flatMap((item) => [flag, scalarArg(param, item, toContainerPath)]) : [];
    }
    default:
      return [];
  }
}

function defaultCatalog(engineId, ctx) {
  return paramCatalog.loadCatalog(engineId, { runtime: ctx?.runtime || null, introspected: ctx?.introspected || null });
}

/**
 * emitCatalogArgs({ engineId, ctx, values, existingArgs?, skip? }) → string[]
 * The argv tokens of every catalog-mode parameter that has a value, in catalog
 * order. See the header for what each argument is.
 */
function emitCatalogArgs({ engineId, ctx = {}, values = {}, existingArgs = [], skip = null } = {}) {
  const catalog = ctx.catalog || defaultCatalog(engineId, ctx);
  const read = (id) => {
    const value = unwrap(Object.hasOwn(values, id) ? values[id] : undefined);
    return value === undefined ? null : value;
  };
  const toContainerPath = typeof ctx.toContainerPath === "function" ? ctx.toContainerPath : (value) => value;
  const exprCtx = { param: read, user: read, fact: ctx.facts || {} };
  const seen = new Set((Array.isArray(existingArgs) ? existingArgs : []).filter(isFlagToken));
  const out = [];
  for (const param of catalog.params) {
    const emit = param.emit;
    if (!emit || emit.mode !== "catalog" || ["none", "env"].includes(emit.kind)) continue;
    if (skip && skip(param)) continue;
    if (param.availability?.state === "unavailable") continue;
    const value = read(param.id);
    if (isUnset(value)) continue;
    if ((emit.omitWhen || []).some((omitted) => omitted !== null && omitted === value)) continue;
    const applies = catalog.compiled?.get(param.id)?.appliesWhen;
    if (applies?.ok && applies.run(exprCtx) === false) continue;
    const tokens = render(param, value, { read, toContainerPath });
    if (!tokens.length) continue;
    if (isFlagToken(tokens[0]) && seen.has(tokens[0])) continue;
    if (isFlagToken(tokens[0])) seen.add(tokens[0]);
    out.push(...tokens);
  }
  return out;
}

/** skip(param) for "a recipe already supplied the speculative args": leave the whole group out. */
function skipSpeculativeWhen(args, flag) {
  const supplied = Array.isArray(args) && args.includes(flag);
  return (param) => supplied && param.group === "speculative";
}

module.exports = {
  FORMATS,
  VLLM_SPECULATIVE_METHODS,
  emitCatalogArgs,
  skipSpeculativeWhen,
};
