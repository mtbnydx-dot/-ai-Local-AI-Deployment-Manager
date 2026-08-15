const SECRET_KEY_PATTERN = /(authorization|api[_-]?key|token|password|secret|keyhash)/i;

export function cleanText(value: unknown, maxChars = 1000): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/\b(?:hf_|sk-)[A-Za-z0-9_-]{8,}\b/g, "***")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=***")
    .trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 20))}… [truncated]`;
}

export function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth limit]";
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactUnknown(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    output[key] = redactUnknown(item, depth + 1);
  }
  return output;
}
