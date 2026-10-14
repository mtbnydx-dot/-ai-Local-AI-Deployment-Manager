"use strict";

// Python `fnmatch.translate` semantics for the CLI `--include=PATTERN` filters
// (docs/overhaul/03-hub.md section 5). `*` crosses `/`, `?` is one character,
// `[seq]` / `[!seq]` are character sets, and everything else is literal. The
// translation follows CPython 3.12 so the hub can prove, before it starts a
// transfer, that a compiled pattern list selects exactly the planned files.

const REGEXP_SPECIAL = /[\\^$.*+?()[\]{}|/-]/g;

function escapeRegExpChar(char) {
  return char.replace(REGEXP_SPECIAL, "\\$&");
}

// Translate the body of one `[...]` set (between the brackets) the way CPython
// does: `!` negates, empty ranges are dropped, backslashes and hyphens are
// escaped, and a leading `^` or `[` is escaped.
function translateSet(stuffSource) {
  let stuff;
  if (!stuffSource.includes("-")) {
    stuff = stuffSource.replace(/\\/g, "\\\\");
  } else {
    const chunks = [];
    let start = 0;
    let k = stuffSource[0] === "!" ? 2 : 1;
    for (;;) {
      k = stuffSource.indexOf("-", k);
      if (k < 0) break;
      chunks.push(stuffSource.slice(start, k));
      start = k + 1;
      k += 3;
    }
    const last = stuffSource.slice(start);
    if (last) chunks.push(last);
    else chunks[chunks.length - 1] += "-";
    // Remove empty (reversed) ranges, which are invalid in a regular expression.
    for (let index = chunks.length - 1; index > 0; index -= 1) {
      if (chunks[index - 1].slice(-1) > chunks[index][0]) {
        chunks[index - 1] = chunks[index - 1].slice(0, -1) + chunks[index].slice(1);
        chunks.splice(index, 1);
      }
    }
    stuff = chunks.map((chunk) => chunk.replace(/\\/g, "\\\\").replace(/-/g, "\\-")).join("-");
  }
  stuff = stuff.replace(/[&~|\]]/g, "\\$&");
  if (!stuff) return "(?!)";
  if (stuff === "!") return "[\\s\\S]";
  if (stuff[0] === "!") return `[^${stuff.slice(1)}]`;
  if (stuff[0] === "^" || stuff[0] === "[") return `[\\${stuff}]`;
  return `[${stuff}]`;
}

/**
 * fnmatchToRegExp(pattern, { ignoreCase = false }) -> RegExp anchored at both
 * ends. Matching is case sensitive like `fnmatchcase`; pass `ignoreCase` to
 * model `fnmatch.fnmatch` on Windows, which lower-cases both sides.
 */
function fnmatchToRegExp(pattern, { ignoreCase = false } = {}) {
  const source = String(pattern ?? "");
  const chars = Array.from(source);
  const total = chars.length;
  let index = 0;
  let result = "";
  while (index < total) {
    const char = chars[index];
    index += 1;
    if (char === "*") {
      while (index < total && chars[index] === "*") index += 1;
      result += "[\\s\\S]*";
    } else if (char === "?") {
      result += "[\\s\\S]";
    } else if (char === "[") {
      let end = index;
      if (end < total && chars[end] === "!") end += 1;
      if (end < total && chars[end] === "]") end += 1;
      while (end < total && chars[end] !== "]") end += 1;
      if (end >= total) {
        result += "\\[";
      } else {
        result += translateSet(chars.slice(index, end).join(""));
        index = end + 1;
      }
    } else {
      result += escapeRegExpChar(char);
    }
  }
  return new RegExp(`^(?:${result})$`, ignoreCase ? "i" : "");
}

/**
 * escapeFnmatch(name) -> a pattern that matches exactly `name`: `[` becomes
 * `[[]`, `*` becomes `[*]` and `?` becomes `[?]`. One pass, so the brackets the
 * escape adds are never escaped again.
 */
function escapeFnmatch(name) {
  return String(name ?? "").replace(/[[*?]/g, (char) => `[${char}]`);
}

module.exports = {
  escapeFnmatch,
  fnmatchToRegExp,
};
