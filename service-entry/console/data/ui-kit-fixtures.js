// Sample data for the /system/ui-kit page (routes/system/ui-kit.js): plain
// values and no copy. Kept out of the route module so the route's own static
// weight stays under the 60 KB route budget (07 §11).

export const GIB = 1024 ** 3;
export const STATUSES = ["ok", "warn", "error", "info", "neutral", "unknown", "loading"];
export const LEVELS = ["success", "error", "info", "warn"];
export const VARIANTS = ["default", "primary", "danger", "ghost"];
export const TABS = ["one", "two", "three"].map((id) => ({ id, disabled: id === "three" }));
export const STEPS = ["pending", "active", "done", "error", "skipped"].map((state) => ({ id: state, state, label: state, durationMs: state === "done" ? 4200 : undefined }));
export const DIFF = [
  { label: "contextLength", from: 32768, to: 65536, source: "recipe" },
  { label: "kvCacheDtype", from: "auto", to: "fp8", source: "user" },
  { label: "port", from: 8000, to: 8000, source: "default" },
];
export const PARTS = [{ id: "w", label: "weights", value: 42 * GIB }, { id: "kv", label: "kv", value: 12 * GIB }, { id: "o", label: "other", value: 3 * GIB }];

// Data components (CON-7a): rows for the DataTable, a growing log feed for the
// LogViewer and a hostile-but-harmless README for the MarkdownViewer.
export const TABLE_ROWS = [
  { id: "r1", name: "qwen-32b", gpu: 61.5, tokens: 38.6, note: "=SUM(A1:A9)" },
  { id: "r2", name: "llama-8b", gpu: 12, tokens: 91.2, note: "plain" },
  { id: "r3", name: "gemma-27b", gpu: null, tokens: 22.1, note: "+cmd" },
  { id: "r4", name: "phi-4", gpu: 33.3, tokens: null, note: "say \"hi\", ok" },
];

export function bigRows(count = 2000) {
  return Array.from({ length: count }, (_, index) => ({ id: `big-${index}`, n: index + 1, name: `model-${String(index).padStart(4, "0")}`, score: (index * 7919) % 1000 }));
}

const LOG_LEVELS = ["INFO", "INFO", "WARNING", "INFO", "ERROR"];
export function logLine(index) {
  return `2026-10-15T10:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z ${LOG_LEVELS[index % LOG_LEVELS.length]} step ${index} done`;
}

/** A load() for LogViewer: the first call returns `initial` lines, each later call one more. */
export function createLogFeed(initial = 60) {
  let next = 0;
  return async () => {
    const count = next === 0 ? initial : 1;
    const lines = Array.from({ length: count }, (_, offset) => logLine(next + offset));
    next += count;
    return { lines, cursor: String(next) };
  };
}

export const MARKDOWN_SAMPLE = [
  "# Release notes",
  "",
  "Plain **bold**, *italic*, `code` and a [safe link](https://example.invalid/docs) next to a [bad link](javascript:alert(1)).",
  "",
  "<script>alert(1)</script>",
  "",
  "![remote](https://example.invalid/pixel.png)",
  "",
  "- first",
  "- second",
  "  - nested",
  "",
  "| name | value |",
  "| --- | ---: |",
  "| a | 1 |",
  "",
  "```sh",
  "platform doctor --fresh",
  "```",
].join("\n");
