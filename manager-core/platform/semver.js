"use strict";

// A small semver range check (docs/overhaul/06-ops.md §2.1) for the
// requirements the platform states about itself, such as the Node range
// "^22.22.2 || ^24.15.0 || >=26.0.0" (V15). It covers the npm range forms
// those requirements use: ||, space-separated comparators, ^, ~, >=, >, <=, <,
// =, partial versions (24, 24.15) and x/* wildcards. Plain CommonJS with no
// dependencies, so `platform doctor` can load it on an unsupported Node.

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL_PATTERN = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const COMPARATOR_PATTERN = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/;

/** "24.16.0" or "v24.16.0" -> { major, minor, patch, prerelease[] }, or null. */
function parseVersion(text) {
  const match = VERSION_PATTERN.exec(String(text ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  // A release is newer than any of its prereleases.
  if (!left.length) return 1;
  if (!right.length) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference) return Math.sign(difference);
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

/** -1, 0 or 1. Throws TypeError for text that is not a full version. */
function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  if (!a || !b) throw new TypeError(`Not a version: ${JSON.stringify(a ? right : left)}`);
  for (const part of ["major", "minor", "patch"]) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function version(major, minor, patch, prerelease = []) {
  return { major, minor, patch, prerelease };
}

function wildcard(part) {
  return part === undefined || /^[xX*]$/.test(part);
}

// One comparator ("^24.15.0", ">=26", "24.x") -> a list of { op, version }
// bounds that must all hold.
function expandComparator(text) {
  const match = COMPARATOR_PATTERN.exec(text);
  if (!match) return null;
  const operator = match[1] || "";
  const partial = PARTIAL_PATTERN.exec(match[2].trim());
  if (!partial) return null;
  const [, majorText, minorText, patchText, prereleaseText] = partial;
  if (wildcard(majorText)) {
    return operator === "<" || operator === ">" ? [{ op: "<", version: version(0, 0, 0) }] : [];
  }
  const major = Number(majorText);
  const minor = wildcard(minorText) ? null : Number(minorText);
  const patch = minor === null || wildcard(patchText) ? null : Number(patchText);
  const prerelease = prereleaseText && patch !== null ? prereleaseText.split(".") : [];
  const floor = version(major, minor ?? 0, patch ?? 0, prerelease);
  switch (operator) {
    case "^": {
      let ceiling;
      if (major > 0 || minor === null) ceiling = version(major + 1, 0, 0);
      else if (minor > 0 || patch === null) ceiling = version(0, minor + 1, 0);
      else ceiling = version(0, 0, patch + 1);
      return [{ op: ">=", version: floor }, { op: "<", version: ceiling }];
    }
    case "~": {
      const ceiling = minor === null ? version(major + 1, 0, 0) : version(major, minor + 1, 0);
      return [{ op: ">=", version: floor }, { op: "<", version: ceiling }];
    }
    case ">=":
      return [{ op: ">=", version: floor }];
    case "<":
      return [{ op: "<", version: floor }];
    case ">":
      if (minor === null) return [{ op: ">=", version: version(major + 1, 0, 0) }];
      if (patch === null) return [{ op: ">=", version: version(major, minor + 1, 0) }];
      return [{ op: ">", version: floor }];
    case "<=":
      if (minor === null) return [{ op: "<", version: version(major + 1, 0, 0) }];
      if (patch === null) return [{ op: "<", version: version(major, minor + 1, 0) }];
      return [{ op: "<=", version: floor }];
    default:
      if (minor === null) return [{ op: ">=", version: floor }, { op: "<", version: version(major + 1, 0, 0) }];
      if (patch === null) return [{ op: ">=", version: floor }, { op: "<", version: version(major, minor + 1, 0) }];
      return [{ op: "=", version: floor }];
  }
}

/** Parses a range into alternatives of bounds, or null when it does not parse. */
function parseRange(range) {
  const text = String(range ?? "").trim();
  if (!text) return null;
  const alternatives = [];
  for (const part of text.split("||")) {
    // ">= 24.15.0" is one comparator; join an operator to the version after it.
    const tokens = part.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    const bounds = [];
    for (const token of tokens) {
      const expanded = expandComparator(token);
      if (!expanded) return null;
      bounds.push(...expanded);
    }
    alternatives.push(bounds);
  }
  return alternatives;
}

function holds(bound, candidate) {
  const order = compareVersions(candidate, bound.version);
  switch (bound.op) {
    case ">=": return order >= 0;
    case ">": return order > 0;
    case "<=": return order <= 0;
    case "<": return order < 0;
    default: return order === 0;
  }
}

/** Whether `range` parses. */
function validRange(range) {
  return parseRange(range) !== null;
}

/**
 * Whether a version satisfies a range. A prerelease satisfies an alternative
 * only when one of its bounds names a prerelease of the same major.minor.patch
 * (the npm rule). Unparseable input returns false; it never throws.
 */
function satisfies(versionText, range) {
  const candidate = parseVersion(versionText);
  const alternatives = parseRange(range);
  if (!candidate || !alternatives) return false;
  return alternatives.some((bounds) => {
    if (!bounds.every((bound) => holds(bound, candidate))) return false;
    if (!candidate.prerelease.length) return true;
    return bounds.some(({ version: bound }) => bound.prerelease.length
      && bound.major === candidate.major && bound.minor === candidate.minor && bound.patch === candidate.patch);
  });
}

module.exports = {
  parseVersion,
  compareVersions,
  parseRange,
  validRange,
  satisfies,
};
