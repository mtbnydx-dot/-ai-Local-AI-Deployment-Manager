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

// Chart fixtures: one value per minute from a fixed instant, so the render is the same in every run.
export const CHART_START = 1760342400;
export const CHART_X = Array.from({ length: 60 }, (_unused, index) => CHART_START + index * 60);
const wave = (base, swing, phase, gap = null) => CHART_X.map((_at, index) => (gap && index >= gap[0] && index <= gap[1] ? null : Math.round((base + swing * Math.sin((index + phase) / 6)) * 10) / 10));
// A collection gap in the middle of the first series, and a lone point between two gaps in the second.
export const CHART_LINE = [
  { id: "ttft_p50", label: "TTFT p50", unit: "ms", values: wave(420, 80, 0, [22, 27]) },
  { id: "ttft_p95", label: "TTFT p95", unit: "ms", values: wave(900, 160, 3).map((value, index) => (index === 40 || index === 42 ? null : value)) },
];
export const CHART_STACK = [
  { id: "2xx", label: "2xx", unit: "req", values: wave(120, 30, 0) },
  { id: "4xx", label: "4xx", unit: "req", values: wave(14, 5, 2) },
  { id: "5xx", label: "5xx", unit: "req", values: wave(4, 3, 5, [30, 31]) },
];
export const CHART_ANNOTATIONS = [
  { at: (CHART_START + 10 * 60) * 1000, kind: "launch", label: "ready in 545 s" },
  { at: (CHART_START + 25 * 60) * 1000, kind: "config", label: "context 64K" },
  { at: (CHART_START + 38 * 60) * 1000, kind: "restart", label: "vllm:primary" },
  { at: (CHART_START + 50 * 60) * 1000, kind: "alert", label: "ttft_p95" },
];
export const GPU_BARS = [
  { gpu: { id: "gpu0", name: "GPU 0", totalMb: 98304 }, budgetMb: 88474, admissionMb: 70000, segments: [{ kind: "weights", mb: 41000 }, { kind: "kv", mb: 22000 }, { kind: "activations", mb: 4200 }, { kind: "draft", mb: 3000 }, { kind: "mmproj", mb: 1800 }, { kind: "overhead", mb: 1500 }] },
  { gpu: { id: "gpu1", name: "GPU 1", totalMb: 98304 }, budgetMb: 80000, admissionMb: 88000, otherTenantsMb: 6000, segments: [{ kind: "weights", mb: 52000 }, { kind: "kv", mb: 30000 }, { kind: "activations", mb: 5000 }] },
];
