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

// A small parameter catalog and launch plan for the SchemaForm section: one
// param per widget, a recipe lock, a planner value and a suggestion. English
// copy only (a missing zh text falls back to en); the real catalogs come from
// GET /api/engines/:engineId/schema.
const text = (en) => ({ en });
export const SCHEMA_FORM_CATALOG = {
  engineId: "demo",
  catalogVersion: "demo",
  facts: {},
  groups: [
    { id: "model", order: 10, label: text("Model") },
    { id: "capacity", order: 20, label: text("Capacity") },
    { id: "advanced", order: 30, label: text("Advanced") },
  ],
  notApplicable: ["demo.unused"],
  params: [
    { id: "servedName", group: "model", level: "basic", order: 10, type: "string", label: text("Served name"), summary: text("The model name clients send."), flag: "--served-model-name", legacy: { domId: "servedName" } },
    { id: "trustRemoteCode", group: "model", level: "advanced", order: 20, type: "bool", label: text("Trust remote code"), summary: text("Run code shipped with the model.") },
    { id: "tokenizer", group: "model", level: "expert", order: 30, type: "path", label: text("Tokenizer folder"), summary: text("Use a tokenizer from another folder.") },
    { id: "contextLength", group: "capacity", level: "basic", order: 10, type: "int", unit: "tokens", range: { min: 1, max: 1048576, step: 1 }, platformDefaultValue: 8192, label: text("Request token limit"), summary: text("The most tokens one request may use."), help: { what: text("Prompt and output together."), whenToChange: text("For long documents."), tradeoffs: text("More KV memory.") }, flag: "--context-length" },
    { id: "kvCacheDtype", group: "capacity", level: "basic", order: 20, type: "enum", choices: [{ value: "auto", label: text("Auto") }, { value: "fp8", label: text("FP8") }, { value: "bf16", label: text("BF16") }], engineDefault: "auto", label: text("KV cache type"), summary: text("How cached keys and values are stored.") },
    { id: "reasoningParser", group: "capacity", level: "basic", order: 30, type: "enum", choices: ["qwen3", "deepseek_r1", "glm45", "gpt_oss", "kimi_k2", "minimax"].map((value) => ({ value })), label: text("Reasoning parser"), summary: text("Splits thinking from the answer.") },
    { id: "temperature", group: "capacity", level: "advanced", order: 40, type: "float", range: { min: 0, max: 2, step: 0.05 }, label: text("Temperature"), summary: text("Default sampling temperature.") },
    { id: "prefixCaching", group: "advanced", level: "basic", order: 10, type: "tristate", label: text("Prefix caching"), summary: text("Default keeps the engine behaviour.") },
    { id: "chatTemplateKwargs", group: "advanced", level: "advanced", order: 20, type: "json", label: text("Template options"), summary: text("Extra values for the chat template.") },
    { id: "lora.adapters", group: "advanced", level: "advanced", order: 30, type: "list", item: { maxItems: 4, fields: { name: { type: "string", required: true }, path: { type: "string", required: true } } }, label: text("LoRA adapters"), summary: text("One row per adapter.") },
    { id: "extraArgs", group: "advanced", level: "expert", order: 40, type: "list", label: text("Extra arguments"), summary: text("One argument token per row.") },
    { id: "extraEnv", group: "advanced", level: "expert", order: 50, type: "kv", label: text("Extra environment"), summary: text("Names and values.") },
    { id: "apiKey", group: "advanced", level: "basic", order: 60, type: "string", secret: true, label: text("Direct API key"), summary: text("Write-only; never shown again.") },
    { id: "demo.when", group: "advanced", level: "advanced", order: 70, type: "int", appliesWhen: { gt: [{ param: "contextLength" }, 100000] }, label: text("Long-context option"), summary: text("Shown only for long contexts.") },
  ],
};
export const SCHEMA_FORM_PLAN = {
  ok: false,
  recipe: { id: "demo", status: "verified", locks: [{ param: "trustRemoteCode", value: true, reason: text("The architecture needs repository code.") }] },
  values: {
    contextLength: { value: 8192, source: "platform-default" },
    kvCacheDtype: { value: "fp8", source: "planner", reason: text("Planner: fits more context.") },
    trustRemoteCode: { value: true, source: "recipe" },
  },
  errors: [{ field: "temperature", code: "out_of_range", message: text("Too hot."), suggestion: { value: 2, why: text("The highest allowed value.") } }],
  warnings: [],
};
export const SCHEMA_FORM_VALUES = { temperature: 3 };
