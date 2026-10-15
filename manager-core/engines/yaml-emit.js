"use strict";

// Minimal YAML emitter for generated launch files (docs/overhaul/01-engines.md
// §19.1, ENG-18). The docker-template adapter writes engine config files (a
// TensorRT-LLM extra_llm_api_options file, TabbyAPI's config.yml and
// api_tokens.yml) and must not depend on a YAML library, so this emits exactly
// the subset it needs: maps, lists and scalars, in block style, with every
// string quoted (keys included). Quoting every string means a value such as
// "no", "on", "1e3" or "null" can never be read back as another type, and a
// user-supplied string can never become YAML syntax.
//
//   emitYaml(value, { indent = 2 }) → text ending in one newline
//
// Supported: null, booleans, finite numbers, strings, arrays, plain objects.
// undefined map entries are skipped. Anything else (functions, symbols, NaN,
// Infinity, class instances, circular data) throws a TypeError, so a bad value
// fails the launch instead of producing a file the engine reads differently.

const MAX_DEPTH = 32;
// Characters that stay as they are inside a double-quoted YAML scalar.
const PLAIN_ESCAPES = Object.freeze({ '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" });

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** One string as a double-quoted YAML scalar. */
function quote(text) {
  let out = '"';
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (Object.hasOwn(PLAIN_ESCAPES, char)) out += PLAIN_ESCAPES[char];
    // C0 controls, DEL, C1 controls and the Unicode line separators are escaped
    // so no reader folds them into a line break.
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0xfeff) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += char;
  }
  return `${out}"`;
}

function scalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("YAML cannot carry a non-finite number.");
    return String(value);
  }
  if (typeof value === "string") return quote(value);
  throw new TypeError(`YAML cannot carry a ${typeof value} value.`);
}

function isScalar(value) {
  return value === null || ["boolean", "number", "string"].includes(typeof value);
}

function emitNode(value, depth, step, seen) {
  if (depth > MAX_DEPTH) throw new TypeError("YAML value is nested too deeply.");
  if (isScalar(value)) return [scalar(value)];
  if (seen.has(value)) throw new TypeError("YAML cannot carry circular data.");
  seen.add(value);
  try {
    const pad = " ".repeat(step);
    if (Array.isArray(value)) {
      if (!value.length) return ["[]"];
      const lines = [];
      for (const item of value) {
        if (item === undefined) throw new TypeError("YAML lists cannot hold undefined.");
        const child = emitNode(item, depth + 1, step, seen);
        if (isScalar(item) || !child.length || child[0] === "[]" || child[0] === "{}") lines.push(`- ${child[0]}`);
        else {
          // "- " plus the first line of a nested block; the rest line up under it.
          lines.push(`- ${child[0]}`);
          for (const rest of child.slice(1)) lines.push(`  ${rest}`);
        }
      }
      return lines;
    }
    if (isPlainObject(value)) {
      const entries = Object.entries(value).filter(([, item]) => item !== undefined);
      if (!entries.length) return ["{}"];
      const lines = [];
      for (const [key, item] of entries) {
        const head = `${quote(key)}:`;
        const child = emitNode(item, depth + 1, step, seen);
        const inline = isScalar(item) || child[0] === "[]" || child[0] === "{}";
        if (inline) lines.push(`${head} ${child[0]}`);
        else {
          lines.push(head);
          for (const line of child) lines.push(`${pad}${line}`);
        }
      }
      return lines;
    }
    throw new TypeError("YAML can carry only maps, lists and scalars.");
  } finally {
    seen.delete(value);
  }
}

/** value → YAML text (block style, every string quoted, one trailing newline). */
function emitYaml(value, options = {}) {
  const step = Number.isInteger(options.indent) && options.indent >= 1 && options.indent <= 8 ? options.indent : 2;
  if (value === undefined) throw new TypeError("YAML cannot carry undefined.");
  return `${emitNode(value, 0, step, new Set()).join("\n")}\n`;
}

module.exports = { emitYaml, quote };
