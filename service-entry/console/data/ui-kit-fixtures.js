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
