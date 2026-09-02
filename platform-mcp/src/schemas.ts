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

const SearchTokenSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/)
  .describe("A safe SearXNG engine or category token without spaces or punctuation.");

const SearchDomainSchema = z.string().trim().min(1).max(253)
  .regex(/^(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+$/)
  .describe("A hostname or parent domain without scheme, path, port, or wildcard.");

export const SearchSourceTypeSchema = z.enum([
  "official", "academic", "documentation", "news", "organization", "community", "commercial", "other",
]);

const SearchTuningInputShape = {
  language: z.string().trim().max(24).regex(/^[A-Za-z0-9_.-]*$/).default("")
    .describe("Optional SearXNG language token such as en, zh-CN, or all."),
  time_range: z.enum(["none", "day", "month", "year"]).default("none")
    .describe("Optional recency filter. Use none for no time filter."),
  engines: z.array(SearchTokenSchema).max(5).default([])
    .describe("Optional allowlist of up to five SearXNG engine names."),
  categories: z.array(SearchTokenSchema).max(5).default([])
    .describe("Optional allowlist of up to five SearXNG categories."),
  safesearch: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1)
    .describe("SearXNG safe-search level: 0 off, 1 moderate, or 2 strict."),
  preferred_domains: z.array(SearchDomainSchema).max(10).default([])
    .describe("Boost results from these domains without excluding other sources."),
  include_domains: z.array(SearchDomainSchema).max(10).default([])
    .describe("Return only results from these domains or their subdomains."),
  exclude_domains: z.array(SearchDomainSchema).max(20).default([])
    .describe("Discard results from these domains or their subdomains."),
  max_per_domain: z.number().int().min(1).max(6).default(3)
    .describe("Maximum selected results from one domain before diversity fallback."),
  preferred_source_types: z.array(SearchSourceTypeSchema).max(8).default([])
    .describe("Boost these broad source classes without treating the classification as a credibility guarantee."),
};

export const WebSearchInputSchema = z.object({
  query: z.string().trim().min(2).max(500)
    .describe("Natural-language web search query, from 2 through 500 characters."),
  max_results: z.number().int().min(1).max(20).default(8)
    .describe("Maximum normalized search results to return, from 1 through 20."),
  ...SearchTuningInputShape,
  response_format: ResponseFormatSchema,
}).strict();

const ResearchQuerySchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_.-]+$/)
    .optional().describe("Optional stable query label used in coverage; defaults to q1, q2, and so on."),
  query: z.string().trim().min(2).max(500)
    .describe("A focused search query representing one angle of the research task."),
  preferred_source_types: z.array(SearchSourceTypeSchema).max(4).default([])
    .describe("Optional source classes preferred for this query angle."),
}).strict();

export const ResearchWebInputSchema = z.object({
  queries: z.array(ResearchQuerySchema).min(1).max(8)
    .describe("One through eight complementary, non-secret web queries."),
  max_results_per_query: z.number().int().min(2).max(15).default(8)
    .describe("Candidate results retained per query before cross-query merging."),
  max_sources: z.number().int().min(3).max(40).default(18)
    .describe("Maximum deduplicated, domain-diverse sources in the merged result."),
  source_strategy: z.enum(["balanced", "relevance", "primary"]).default("balanced")
    .describe("balanced covers multiple source classes, relevance preserves score order, and primary favors likely first-party evidence."),
  ...SearchTuningInputShape,
  response_format: ResponseFormatSchema,
}).strict();

export const ReadSearchResultInputSchema = z.object({
  search_id: z.string().trim().min(16).max(100)
    .describe("Opaque search_id returned by local_ai_search_web or local_ai_research_web."),
  result_ids: z.array(z.string().regex(/^r[1-9]\d*$/)).min(1).max(3)
    .describe("One through three result_id values from that exact search result set."),
  max_chars_per_result: z.number().int().min(1000).max(15000).default(8000)
    .describe("Maximum extracted text characters per page."),
  max_total_chars: z.number().int().min(2000).max(30000).default(24000)
    .describe("Maximum extracted text characters across all selected pages."),
  response_format: ResponseFormatSchema,
}).strict();

function isObviouslyPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (["localhost", "0.0.0.0", "::", "::1"].includes(normalized)) return true;
  if ([".localhost", ".local", ".internal", ".lan", ".home"].some((suffix) => normalized.endsWith(suffix))) return true;
  const octets = normalized.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const first = octets[0] ?? 999;
    const second = octets[1] ?? 999;
    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first >= 224;
  }
  if (!normalized.includes(":")) return false;
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb");
}

const PublicHttpUrlSchema = z.string().trim().min(8).max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      const expectedPort = url.protocol === "https:" ? "443" : "80";
      return ["http:", "https:"].includes(url.protocol)
        && !url.username
        && !url.password
        && !isObviouslyPrivateHostname(url.hostname)
        && (!url.port || url.port === expectedPort);
    } catch {
      return false;
    }
  }, "URL must use public HTTP(S), contain no credentials, avoid local/private hosts, and use a standard port.");

export const OpenWebPageInputSchema = z.object({
  urls: z.array(PublicHttpUrlSchema).min(1).max(3)
    .describe("One through three explicit public HTTP(S) URLs supplied by the user or already known from a trusted source."),
  max_chars_per_url: z.number().int().min(1000).max(15000).default(8000)
    .describe("Maximum extracted text characters per URL."),
  max_total_chars: z.number().int().min(2000).max(30000).default(24000)
    .describe("Maximum extracted text characters across all opened URLs."),
  response_format: ResponseFormatSchema,
}).strict();

export const FindSearchResultInputSchema = z.object({
  search_id: z.string().trim().min(16).max(100)
    .describe("Opaque search_id returned by local_ai_search_web or local_ai_research_web."),
  result_id: z.string().regex(/^r[1-9]\d*$/)
    .describe("One result_id from that exact search result set."),
  pattern: z.string().trim().min(2).max(200)
    .describe("Literal phrase or a short set of terms to locate within the extracted page text."),
  match_mode: z.enum(["phrase", "all_terms"]).default("phrase")
    .describe("phrase finds the exact phrase; all_terms finds paragraphs containing every supplied term."),
  case_sensitive: z.boolean().default(false)
    .describe("Match letter case exactly when true."),
  max_matches: z.number().int().min(1).max(10).default(5)
    .describe("Maximum matching passages returned."),
  context_chars: z.number().int().min(80).max(800).default(320)
    .describe("Context characters included on each side of a match."),
  response_format: ResponseFormatSchema,
}).strict();

export const JobsInputSchema = z.object({
  engine: EngineSelectorSchema,
  status: z.enum(["all", "queued", "running", "paused", "success", "failed", "cancelled"])
    .default("all")
    .describe("Filter jobs by lifecycle status."),
  job_type: z.enum(["all", "download", "serve", "benchmark", "test"])
    .default("all")
    .describe("Filter jobs by workflow type."),
  limit: z.number().int().min(1).max(50).default(20)
    .describe("Maximum job summaries to return, from 1 through 50."),
  offset: z.number().int().min(0).max(100000).default(0)
    .describe("Number of matching jobs to skip."),
  response_format: ResponseFormatSchema,
}).strict();

export const RoutePreviewInputSchema = z.object({
  model: z.string().trim().max(200).default("")
    .describe("Optional explicit served model ID. Leave empty to preview automatic routing."),
  engine: z.enum(["auto", "vllm", "llama"]).default("auto")
    .describe("Requested engine or auto for fleet selection."),
  protocol: z.enum(["openai", "claude", "opencode"]).default("openai")
    .describe("Client protocol whose route should be previewed."),
  capability: z.enum(["text", "tools", "vision", "audio", "embedding", "rerank"]).default("text")
    .describe("Capability required by the request."),
  response_format: ResponseFormatSchema,
}).strict();

export const MemoryEstimateInputSchema = z.object({
  engine: z.enum(["vllm", "llama"])
    .describe("Runtime whose estimator and memory model should be used."),
  params_b: z.number().min(0.1).max(1000)
    .describe("Model parameter count in billions, for example 27 for a 27B model."),
  context_tokens: z.number().int().min(512).max(2097152).default(32768)
    .describe("Requested context length in tokens."),
  precision: z.enum(["fp32", "fp16_bf16", "fp8_int8", "int4_nvfp4", "custom"]).default("fp8_int8")
    .describe("Weight storage assumption used to derive bytes per parameter."),
  bytes_per_param: z.number().min(0.125).max(4).nullable().default(null)
    .describe("Required only for precision=custom; otherwise leave null."),
  parallel_sequences: z.number().int().min(1).max(64).default(1)
    .describe("Concurrent sequence slots included in the KV-cache estimate."),
  gpu_memory_utilization: z.number().min(0.1).max(0.99).default(0.85)
    .describe("Maximum fraction of each selected GPU that the runtime may use."),
  cpu_offload_gb: z.number().min(0).max(512).default(0)
    .describe("Planned CPU weight offload per GPU in GiB."),
  kv_offload_gb: z.number().min(0).max(512).default(0)
    .describe("Planned total KV-cache offload in GiB; currently used by vLLM estimates."),
  speculative_mode: z.enum(["off", "mtp", "draft"]).default("off")
    .describe("Reserve memory for speculative decoding when it is explicitly planned."),
  speculative_tokens: z.number().int().min(1).max(16).default(3)
    .describe("Speculative tokens per step when speculative_mode is enabled."),
  response_format: ResponseFormatSchema,
}).strict().superRefine((value, context) => {
  if (value.precision === "custom" && value.bytes_per_param === null) {
    context.addIssue({ code: "custom", path: ["bytes_per_param"], message: "bytes_per_param is required when precision is custom." });
  }
});

export const SecurityPostureInputSchema = z.object({
  engine: EngineSelectorSchema,
  warnings_only: z.boolean().default(false)
    .describe("Return only warning/failure findings when true."),
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

export const SearchQualitySchema = z.enum(["good", "mixed", "weak", "empty"]);

const SearchEngineStateSchema = z.object({
  engine: z.string(),
  reason: z.string(),
  retry_after_seconds: z.number().int().nonnegative(),
}).strict();

const SearchMetricsSchema = z.object({
  searches: z.number().int().nonnegative(),
  research_requests: z.number().int().nonnegative(),
  cache_hits: z.number().int().nonnegative(),
  coalesced_requests: z.number().int().nonnegative(),
  backend_requests: z.number().int().nonnegative(),
  backend_failures: z.number().int().nonnegative(),
  zero_result_searches: z.number().int().nonnegative(),
  weak_searches: z.number().int().nonnegative(),
  pages_read: z.number().int().nonnegative(),
  page_read_failures: z.number().int().nonnegative(),
  page_cache_hits: z.number().int().nonnegative(),
  page_finds: z.number().int().nonnegative(),
  page_find_failures: z.number().int().nonnegative(),
}).strict();

export const SearchSummarySchema = z.object({
  online: z.boolean(),
  healthy: z.boolean(),
  mode: z.string().nullable(),
  auth_required: z.boolean().nullable(),
  max_results: z.number().nullable(),
  state: z.enum(["healthy", "degraded", "unavailable"]).nullable().optional(),
  default_engines: z.array(z.string()).optional(),
  chinese_engines: z.array(z.string()).optional(),
  fallback_engines: z.array(z.string()).optional(),
  available_default_engines: z.array(z.string()).optional(),
  cooldowns: z.array(SearchEngineStateSchema).optional(),
  cache_entries: z.number().int().nonnegative().optional(),
  active_backend_requests: z.number().int().nonnegative().optional(),
  queued_backend_requests: z.number().int().nonnegative().optional(),
  session_count: z.number().int().nonnegative().optional(),
  last_search: z.object({
    searched_at: z.string(),
    quality: SearchQualitySchema,
    count: z.number().int().nonnegative(),
    partial: z.boolean(),
    available: z.boolean(),
  }).strict().nullable().optional(),
  metrics: SearchMetricsSchema.optional(),
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

const SearchEngineStatusSchema = z.object({
  requested: z.array(z.string()),
  attempted: z.array(z.string()),
  used: z.array(z.string()),
  distribution: z.record(z.string(), z.number().int().nonnegative()),
  unresponsive: z.array(SearchEngineStateSchema),
  cooled_down: z.array(SearchEngineStateSchema),
}).strict();

const WebSearchResultSchema = z.object({
  result_id: z.string(),
  title: z.string(),
  url: z.string(),
  domain: z.string(),
  content: z.string(),
  engine: z.string().nullable(),
  engines: z.array(z.string()),
  score: z.number().nullable(),
  relevance: z.number().min(0).max(1),
  low_relevance: z.boolean(),
  category: z.string().nullable(),
  published_at: z.string().nullable(),
  matched_queries: z.array(z.string()),
  source_type: SearchSourceTypeSchema,
  source_type_reason: z.string(),
  primary_source_likelihood: z.enum(["high", "medium", "unknown"]),
}).strict();

export const WebSearchOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    search_id: z.string(),
    expires_in_seconds: z.number().int().positive(),
    query: z.string(),
    searched_at: z.string(),
    count: z.number().int().nonnegative(),
    total_candidates: z.number().int().nonnegative(),
    unique_candidates: z.number().int().nonnegative(),
    quality: SearchQualitySchema,
    available: z.boolean(),
    cache_hit: z.boolean(),
    coalesced: z.boolean(),
    fallback_used: z.boolean(),
    fallback_reason: z.string().nullable(),
    answers: z.array(z.string()),
    corrections: z.array(z.string()),
    suggestions: z.array(z.string()),
    source_domains: z.array(z.string()),
    source_type_coverage: z.record(z.string(), z.number().int().nonnegative()),
    engine_status: SearchEngineStatusSchema,
    results: z.array(WebSearchResultSchema),
  }).strict(),
}).strict();

export const ResearchWebOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    search_id: z.string(),
    expires_in_seconds: z.number().int().positive(),
    query: z.string(),
    searched_at: z.string(),
    count: z.number().int().nonnegative(),
    total_candidates: z.number().int().nonnegative(),
    unique_candidates: z.number().int().nonnegative(),
    quality: SearchQualitySchema,
    available: z.boolean(),
    cache_hit: z.boolean(),
    coalesced: z.boolean(),
    fallback_used: z.boolean(),
    fallback_reason: z.string().nullable(),
    answers: z.array(z.string()),
    corrections: z.array(z.string()),
    suggestions: z.array(z.string()),
    source_domains: z.array(z.string()),
    source_strategy: z.enum(["balanced", "relevance", "primary"]),
    source_type_coverage: z.record(z.string(), z.number().int().nonnegative()),
    coverage_gaps: z.array(SearchSourceTypeSchema),
    engine_status: SearchEngineStatusSchema,
    query_coverage: z.array(z.object({
      id: z.string(),
      query: z.string(),
      count: z.number().int().nonnegative(),
      quality: z.union([SearchQualitySchema, z.literal("unavailable")]),
      cache_hit: z.boolean(),
      error: z.string().nullable(),
    }).strict()),
    results: z.array(WebSearchResultSchema),
  }).strict(),
}).strict();

const ExtractedDocumentFields = {
  title: z.string(),
  url: z.string(),
  final_url: z.string().nullable(),
  domain: z.string(),
  description: z.string(),
  author: z.string().nullable(),
  site_name: z.string().nullable(),
  published_at: z.string().nullable(),
  modified_at: z.string().nullable(),
  canonical_url: z.string().nullable(),
  language: z.string().nullable(),
  content_type: z.string().nullable(),
  document_type: z.enum(["html_article", "html_page", "plain_text", "markdown", "csv", "json", "xml_feed", "pdf"]).nullable(),
  extraction_method: z.string().nullable(),
  metadata_confidence: z.enum(["high", "medium", "low"]).nullable(),
  headings: z.array(z.object({ level: z.number().int().min(1).max(6), text: z.string() }).strict()),
  json_ld_types: z.array(z.string()),
  content: z.string(),
  char_count: z.number().int().nonnegative(),
  source_char_count: z.number().int().nonnegative(),
  word_count: z.number().int().nonnegative(),
  page_count: z.number().int().nonnegative().nullable(),
  pages_read: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  error: z.string().nullable(),
};

const SearchResultDocumentSchema = z.object({
  result_id: z.string(),
  ...ExtractedDocumentFields,
}).strict();

const OpenedWebDocumentSchema = z.object({
  request_id: z.string(),
  ...ExtractedDocumentFields,
}).strict();

export const ReadSearchResultOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    search_id: z.string(),
    count: z.number().int().nonnegative(),
    readable_count: z.number().int().nonnegative(),
    documents: z.array(SearchResultDocumentSchema),
  }).strict(),
}).strict();

export const OpenWebPageOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    count: z.number().int().nonnegative(),
    readable_count: z.number().int().nonnegative(),
    documents: z.array(OpenedWebDocumentSchema),
  }).strict(),
}).strict();

export const FindSearchResultOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    search_id: z.string(),
    result_id: z.string(),
    title: z.string(),
    url: z.string(),
    final_url: z.string().nullable(),
    domain: z.string(),
    document_type: z.string().nullable(),
    page_count: z.number().int().nonnegative().nullable(),
    pages_read: z.number().int().nonnegative().nullable(),
    pattern: z.string(),
    match_mode: z.enum(["phrase", "all_terms"]),
    case_sensitive: z.boolean(),
    match_count: z.number().int().nonnegative(),
    content_truncated: z.boolean(),
    matches: z.array(z.object({
      match_index: z.number().int().positive(),
      start_char: z.number().int().nonnegative(),
      end_char: z.number().int().nonnegative(),
      page_number: z.number().int().positive().nullable(),
      context: z.string(),
    }).strict()),
    error: z.string().nullable(),
  }).strict(),
}).strict();

const JobSummarySchema = z.object({
  engine: z.enum(["vllm", "llama"]),
  id: z.string(),
  type: z.string(),
  title: z.string(),
  status: z.string(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  progress_percent: z.number().nullable(),
  error: z.string().nullable(),
}).strict();

export const JobsOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    engine_filter: z.enum(["all", "vllm", "llama"]),
    status_filter: z.string(),
    type_filter: z.string(),
    total: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_offset: z.number().int().nonnegative().nullable(),
    jobs: z.array(JobSummarySchema),
  }).strict(),
}).strict();

export const RoutePreviewOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    selected: z.boolean(),
    status: z.number().int(),
    capability: z.string(),
    reason: z.string(),
    error: z.string().nullable(),
    request: z.object({
      engine: z.string(),
      protocol: z.string(),
      requested_model: z.string().nullable(),
    }).strict(),
    manager: z.object({ id: z.string(), name: z.string() }).strict().nullable(),
    instance: z.object({ id: z.string(), status: z.string(), port: z.number().nullable() }).strict().nullable(),
    model: z.object({ id: z.string(), capabilities: z.array(z.string()) }).strict().nullable(),
  }).strict(),
}).strict();

export const MemoryEstimateOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    engine: z.enum(["vllm", "llama"]),
    status: z.enum(["ok", "warn", "fail"]),
    summary: z.string(),
    gpu_count: z.number().int().nonnegative(),
    total_gpu_gb: z.number(),
    free_gpu_gb: z.number(),
    params_b: z.number(),
    context_tokens: z.number().int(),
    precision: z.string(),
    bytes_per_param: z.number(),
    weights_gb: z.number().nullable(),
    kv_cache_gb: z.number().nullable(),
    overhead_per_gpu_gb: z.number().nullable(),
    peak_per_gpu_gb: z.number().nullable(),
    overflow_per_gpu_gb: z.number().nullable(),
    recommended_cpu_offload_gb: z.number().nullable(),
    recommended_kv_offload_gb: z.number().nullable(),
    recommendations: z.array(z.string()),
    assumptions: z.array(z.string()),
  }).strict(),
}).strict();

const SecurityFindingSchema = z.object({
  scope: z.string(),
  status: z.enum(["ok", "warn", "fail"]),
  title: z.string(),
}).strict();

export const SecurityPostureOutputSchema = z.object({
  ...EnvelopeFields,
  data: z.object({
    overall: z.enum(["secure", "warn", "fail"]),
    entry: z.object({
      lan_mode: z.boolean(),
      api_key_enforced: z.boolean(),
      allow_lan_admin: z.boolean(),
      cors_mode: z.string(),
      trust_token_active: z.boolean(),
      key_store_readable: z.boolean(),
    }).strict(),
    mcp: z.object({ loopback_only: z.boolean(), auth_required: z.boolean(), read_only: z.boolean() }).strict(),
    search: SearchSummarySchema,
    managers: z.array(z.object({
      engine: z.enum(["vllm", "llama"]),
      config_ok: z.boolean(),
      enabled: z.boolean(),
      exposure_mode: z.string(),
      require_api_key: z.boolean(),
      runtime_running: z.boolean(),
      remote_management_allowed: z.boolean(),
      service_scope: z.enum(["loopback", "lan", "unknown"]),
      direct_runtime_exposed: z.boolean(),
      rate_limit_rpm: z.number().nullable(),
      max_concurrent_requests: z.number().nullable(),
      issues: z.array(SecurityFindingSchema),
    }).strict()),
    findings: z.array(SecurityFindingSchema),
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
export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;
export type ResearchWebOutput = z.infer<typeof ResearchWebOutputSchema>;
export type ReadSearchResultOutput = z.infer<typeof ReadSearchResultOutputSchema>;
export type OpenWebPageOutput = z.infer<typeof OpenWebPageOutputSchema>;
export type FindSearchResultOutput = z.infer<typeof FindSearchResultOutputSchema>;
export type JobsOutput = z.infer<typeof JobsOutputSchema>;
export type RoutePreviewOutput = z.infer<typeof RoutePreviewOutputSchema>;
export type MemoryEstimateOutput = z.infer<typeof MemoryEstimateOutputSchema>;
export type SecurityPostureOutput = z.infer<typeof SecurityPostureOutputSchema>;
