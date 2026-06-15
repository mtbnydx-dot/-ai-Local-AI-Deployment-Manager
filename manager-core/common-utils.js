function compactTimestamp(date = new Date()) {
  return new Date(date).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseJsonSafe(text, fallback = null) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function globalRegex(regex) {
  if (regex instanceof RegExp) {
    const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
    return new RegExp(regex.source, flags);
  }
  return new RegExp(String(regex), "g");
}

function lastCapture(text, regex, groupIndex = 1) {
  const matcher = globalRegex(regex);
  const source = String(text || "");
  let match;
  let value = null;
  while ((match = matcher.exec(source))) {
    if (match[groupIndex] !== undefined) value = match[groupIndex];
    if (match[0] === "") matcher.lastIndex += 1;
  }
  return value;
}

function lastIntegerMatch(text, regex, groupIndex = 1) {
  const value = lastCapture(text, regex, groupIndex);
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function lastFloatMatch(text, regex, groupIndex = 1) {
  const value = lastCapture(text, regex, groupIndex);
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function countUniqueCaptures(text, regex, groupIndex = 1) {
  const matcher = globalRegex(regex);
  const source = String(text || "");
  const values = new Set();
  let match;
  while ((match = matcher.exec(source))) {
    if (match[groupIndex]) values.add(String(match[groupIndex]));
    if (match[0] === "") matcher.lastIndex += 1;
  }
  return values.size;
}

function averageCapture(text, regex, multiplier = 1, groupIndex = 1) {
  const matcher = globalRegex(regex);
  const source = String(text || "");
  let match;
  let total = 0;
  let count = 0;
  while ((match = matcher.exec(source))) {
    const value = Number(String(match[groupIndex] || "").replace(/,/g, ""));
    if (Number.isFinite(value)) {
      total += value * multiplier;
      count += 1;
    }
    if (match[0] === "") matcher.lastIndex += 1;
  }
  return count ? total / count : null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function cleanRequired(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name} is required`);
    error.status = 400;
    throw error;
  }
  return text;
}

function cleanOptionalLaunchArg(value) {
  return String(value || "").trim();
}

function normalizeGpuIds(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return Array.from(new Set(raw.map(String).filter((item) => /^\d+$/.test(item))));
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.max(1, Math.floor(number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return number;
}

function optionalNonNegativeNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  return nonNegativeNumber(value, 0);
}

function normalizeNetworkAccess(value) {
  return String(value || "local").toLowerCase() === "lan" ? "lan" : "local";
}

function normalizeKvCacheDtype(value) {
  const dtype = String(value || "auto").toLowerCase();
  return new Set(["auto", "fp8", "fp8_e5m2", "fp8_e4m3"]).has(dtype) ? dtype : "auto";
}

function normalizeClientPreset(value) {
  const preset = String(value || "openwebui").trim().toLowerCase();
  return new Set(["openwebui", "claude-code", "claude-cowork", "generic"]).has(preset) ? preset : "generic";
}

module.exports = {
  compactTimestamp,
  parseJsonSafe,
  globalRegex,
  lastCapture,
  lastIntegerMatch,
  lastFloatMatch,
  countUniqueCaptures,
  averageCapture,
  shellQuote,
  cleanRequired,
  cleanOptionalLaunchArg,
  normalizeGpuIds,
  positiveInt,
  clampNumber,
  nonNegativeNumber,
  optionalNonNegativeNumber,
  normalizeNetworkAccess,
  normalizeKvCacheDtype,
  normalizeClientPreset,
};
