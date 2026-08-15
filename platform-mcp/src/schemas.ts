import * as z from "zod/v4";

export const ResponseFormatSchema = z.enum(["markdown", "json"])
  .default("markdown")
  .describe("Response text format. Structured content is returned in both modes.");

export const EngineSelectorSchema = z.enum(["all", "vllm", "llama"])
  .default("all")
  .describe("Limit results to vLLM, llama.cpp, or include both managers.");

export const OverviewInputSchema = z.object({
  response_format: ResponseFormatSchema,
}).strict();

export const RunningModelsInputSchema = z.object({
  engine: EngineSelectorSchema,
  response_format: ResponseFormatSchema,
}).strict();

export const GpuStatusInputSchema = z.object({
  response_format: ResponseFormatSchema,
}).strict();

export const LocalModelsInputSchema = z.object({
  engine: EngineSelectorSchema,
  inventory: z.enum(["local", "cached", "all"])
    .default("local")
    .describe("Choose verified local model folders, download-cache entries, or both."),
  limit: z.number().int().min(1).max(50).default(20)
    .describe("Maximum model records to return, from 1 through 50."),
  offset: z.number().int().min(0).max(100000).default(0)
    .describe("Number of matching records to skip."),
  response_format: ResponseFormatSchema,
}).strict();

export const PerformanceInputSchema = z.object({
  engine: EngineSelectorSchema,
  include_models: z.boolean().default(true)
    .describe("Include up to ten per-model metric summaries."),
  response_format: ResponseFormatSchema,
}).strict();

export const DiagnosticsInputSchema = z.object({
  engine: EngineSelectorSchema,
  warnings_only: z.boolean().default(false)
    .describe("Return only warning and failure checks when true."),
  include_recent_logs: z.boolean().default(false)
    .describe("Include a small redacted tail of runtime log lines when true."),
  log_lines: z.number().int().min(1).max(20).default(8)
    .describe("Maximum number of redacted recent log lines per manager."),
  response_format: ResponseFormatSchema,
}).strict();

export const SearchHealthInputSchema = z.object({
  response_format: ResponseFormatSchema,
}).strict();

const GpuDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  total_mb: z.number(),
  used_mb: z.number(),
  free_mb: z.number(),
  allocatable_mb: z.number(),
  utilization_percent: z.number(),
}).strict();

export const GpuSummarySchema = z.object({
  total_mb: z.number(),
  used_mb: z.number(),
  free_mb: z.number(),
  allocatable_mb: z.number(),
  reserve_mb: z.number(),
  warning_threshold_percent: z.number(),
  utilization_percent: z.number(),
  devices: z.array(GpuDeviceSchema),
}).strict();

const RunningModelSchema = z.object({
  id: z.string(),
  engine: z.enum(["vllm", "llama"]),
  instance_id: z.string(),
  container_name: z.string(),
  lifecycle_state: z.string(),
  status: z.string(),
  max_model_len: z.number().nullable(),
  capabilities: z.array(z.string()),
}).strict();

const RunningInstanceSchema = z.object({
  engine: z.enum(["vllm", "llama"]),
  instance_id: z.string(),
  container_name: z.string(),
  lifecycle_state: z.string(),
  running: z.boolean(),
  status: z.string(),
  port: z.number().nullable(),
  models: z.array(RunningModelSchema),
}).strict();

const ManagerSummarySchema = z.object({
  id: z.enum(["vllm", "llama"]),
  name: z.string(),
  online: z.boolean(),
  healthy: z.boolean(),
  runtime_running: z.boolean(),
  model_count: z.number().int().nonnegative(),
  error: z.string().nullable(),
}).strict();

export const SearchSummarySchema = z.object({
  online: z.boolean(),
  healthy: z.boolean(),
  mode: z.string().nullable(),
  auth_required: z.boolean().nullable(),
  max_results: z.number().nullable(),
  error: z.string().nullable(),
}).strict();

const EnvelopeFields = {
  ok: z.boolean(),
  partial: z.boolean(),
  generated_at: z.string(),
  warnings: z.array(z.string()),
};

export const OverviewOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    service_entry: z.object({
      online: z.boolean(),
      uptime_seconds: z.number().nullable(),
      bind_host: z.string().nullable(),
      port: z.number().nullable(),
    }).strict(),
    managers: z.array(ManagerSummarySchema),
    running_model_count: z.number().int().nonnegative(),
    gpu: GpuSummarySchema.nullable(),
    gateway_base: z.string().nullable(),
    search: SearchSummarySchema,
  }).strict(),
}).strict();

export const RunningModelsOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    engine_filter: z.enum(["all", "vllm", "llama"]),
    total_models: z.number().int().nonnegative(),
    instances: z.array(RunningInstanceSchema),
  }).strict(),
}).strict();

export const GpuStatusOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    gpu: GpuSummarySchema.nullable(),
  }).strict(),
}).strict();

const LocalModelSchema = z.object({
  engine: z.enum(["vllm", "llama"]),
  inventory: z.enum(["local", "cached"]),
  id: z.string(),
  label: z.string(),
  size_bytes: z.number().nullable(),
  modified_at: z.string().nullable(),
  format: z.string().nullable(),
  runnable: z.boolean().nullable(),
  verification_status: z.string().nullable(),
  issues: z.array(z.string()),
}).strict();

export const LocalModelsOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    engine_filter: z.enum(["all", "vllm", "llama"]),
    inventory_filter: z.enum(["local", "cached", "all"]),
    total: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_offset: z.number().int().nonnegative().nullable(),
    models: z.array(LocalModelSchema),
  }).strict(),
}).strict();

const MetricValueSchema = z.union([z.number(), z.boolean(), z.string(), z.null()]);
const MetricRecordSchema = z.record(z.string(), MetricValueSchema);

const ModelPerformanceSchema = z.object({
  name: z.string(),
  requests: MetricRecordSchema,
  tokens: MetricRecordSchema,
  speed: MetricRecordSchema,
  latency: MetricRecordSchema,
  cache: MetricRecordSchema,
  speculative: MetricRecordSchema,
  context: MetricRecordSchema,
}).strict();

const ManagerPerformanceSchema = z.object({
  engine: z.enum(["vllm", "llama"]),
  available: z.boolean(),
  updated_at: z.string().nullable(),
  requests: MetricRecordSchema,
  tokens: MetricRecordSchema,
  speed: MetricRecordSchema,
  latency: MetricRecordSchema,
  cache: MetricRecordSchema,
  speculative: MetricRecordSchema,
  context: MetricRecordSchema,
  facts: MetricRecordSchema,
  models: z.array(ModelPerformanceSchema),
  error: z.string().nullable(),
}).strict();

export const PerformanceOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    engine_filter: z.enum(["all", "vllm", "llama"]),
    managers: z.array(ManagerPerformanceSchema),
  }).strict(),
}).strict();

const HealthCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["ok", "warn", "fail"]),
  message: z.string().nullable(),
}).strict();

const ManagerDiagnosticsSchema = z.object({
  engine: z.enum(["vllm", "llama"]),
  available: z.boolean(),
  score: z.number().nullable(),
  stage: z.string().nullable(),
  checks: z.array(HealthCheckSchema),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
  recent_logs: z.array(z.string()),
  error: z.string().nullable(),
}).strict();

export const DiagnosticsOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    engine_filter: z.enum(["all", "vllm", "llama"]),
    managers: z.array(ManagerDiagnosticsSchema),
  }).strict(),
}).strict();

export const SearchHealthOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    search: SearchSummarySchema,
  }).strict(),
}).strict();

export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;
export type EngineSelector = z.infer<typeof EngineSelectorSchema>;
export type OverviewOutput = z.infer<typeof OverviewOutputSchema>;
export type RunningModelsOutput = z.infer<typeof RunningModelsOutputSchema>;
export type GpuStatusOutput = z.infer<typeof GpuStatusOutputSchema>;
export type LocalModelsOutput = z.infer<typeof LocalModelsOutputSchema>;
export type PerformanceOutput = z.infer<typeof PerformanceOutputSchema>;
export type DiagnosticsOutput = z.infer<typeof DiagnosticsOutputSchema>;
export type SearchHealthOutput = z.infer<typeof SearchHealthOutputSchema>;
