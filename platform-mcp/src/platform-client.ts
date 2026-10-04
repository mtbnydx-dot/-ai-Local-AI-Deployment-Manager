import type { PlatformMcpConfig, ManagerTarget } from "./config.js";
import { FixedHttpClient, UpstreamRequestError, type JsonObject } from "./http-client.js";
import { cleanText } from "./redaction.js";
import { UpstreamCache } from "./upstream-cache.js";
import {
  DiagnosticsOutputSchema,
  GpuStatusOutputSchema,
  LocalModelsOutputSchema,
  BenchmarkCompareOutputSchema,
  BenchmarkRunsOutputSchema,
  IdleStateOutputSchema,
  JobsOutputSchema,
  MemoryEstimateOutputSchema,
  OverviewOutputSchema,
  PerformanceOutputSchema,
  RoutePreviewOutputSchema,
  RunningModelsOutputSchema,
  SecurityPostureOutputSchema,
  SearchHealthOutputSchema,
  FindSearchResultOutputSchema,
  OpenWebPageOutputSchema,
  ReadSearchResultOutputSchema,
  ResearchWebOutputSchema,
  WebSearchOutputSchema,
  type BenchmarkCompareOutput,
  type BenchmarkRunsOutput,
  type DiagnosticsOutput,
  type EngineSelector,
  type IdleStateOutput,
  type GpuStatusOutput,
  type JobsOutput,
  type LocalModelsOutput,
  type MemoryEstimateOutput,
  type OverviewOutput,
  type PerformanceOutput,
  type RoutePreviewOutput,
  type RunningModelsOutput,
  type SecurityPostureOutput,
  type SearchHealthOutput,
  type FindSearchResultOutput,
  type OpenWebPageOutput,
  type ReadSearchResultOutput,
  type ResearchWebOutput,
  type WebSearchOutput,
} from "./schemas.js";

type Obj = Record<string, unknown>;
type MetricValue = number | boolean | string | null;

export interface PlatformDataSource {
  getOverview(): Promise<OverviewOutput>;
  listRunningModels(engine: EngineSelector): Promise<RunningModelsOutput>;
  getGpuStatus(): Promise<GpuStatusOutput>;
  listLocalModels(options: {
    engine: EngineSelector;
    inventory: "local" | "cached" | "all";
    limit: number;
    offset: number;
  }): Promise<LocalModelsOutput>;
  getPerformance(options: { engine: EngineSelector; includeModels: boolean }): Promise<PerformanceOutput>;
  getDiagnostics(options: {
    engine: EngineSelector;
    warningsOnly: boolean;
    includeRecentLogs: boolean;
    logLines: number;
  }): Promise<DiagnosticsOutput>;
  getSearchHealth(): Promise<SearchHealthOutput>;
  listBenchmarks(options: {
    engine: EngineSelector;
    model: string;
    limit: number;
    offset: number;
  }): Promise<BenchmarkRunsOutput>;
  compareBenchmarks(options: { runIds: string[]; baselineId: string }): Promise<BenchmarkCompareOutput>;
  getIdleState(options: { engine: EngineSelector }): Promise<IdleStateOutput>;
  searchWeb(options: {
    query: string;
    maxResults: number;
    language: string;
    timeRange: "none" | "day" | "month" | "year";
    engines: string[];
    categories: string[];
    safesearch: 0 | 1 | 2;
    preferredDomains: string[];
    includeDomains: string[];
    excludeDomains: string[];
    maxPerDomain: number;
    preferredSourceTypes: string[];
  }): Promise<WebSearchOutput>;
  researchWeb(options: {
    queries: Array<{ id?: string; query: string; preferred_source_types?: string[] }>;
    maxResultsPerQuery: number;
    maxSources: number;
    language: string;
    timeRange: "none" | "day" | "month" | "year";
    engines: string[];
    categories: string[];
    safesearch: 0 | 1 | 2;
    preferredDomains: string[];
    includeDomains: string[];
    excludeDomains: string[];
    maxPerDomain: number;
    preferredSourceTypes: string[];
    sourceStrategy: "balanced" | "relevance" | "primary";
  }): Promise<ResearchWebOutput>;
  openWebPages(options: {
    urls: string[];
    maxCharsPerUrl: number;
    maxTotalChars: number;
  }): Promise<OpenWebPageOutput>;
  readSearchResults(options: {
    searchId: string;
    resultIds: string[];
    maxCharsPerResult: number;
    maxTotalChars: number;
  }): Promise<ReadSearchResultOutput>;
  findInSearchResult(options: {
    searchId: string;
    resultId: string;
    pattern: string;
    matchMode: "phrase" | "all_terms";
    caseSensitive: boolean;
    maxMatches: number;
    contextChars: number;
  }): Promise<FindSearchResultOutput>;
  listJobs(options: {
    engine: EngineSelector;
    status: string;
    jobType: string;
    limit: number;
    offset: number;
  }): Promise<JobsOutput>;
  previewRoute(options: {
    model: string;
    engine: "auto" | "vllm" | "llama";
    protocol: "openai" | "claude" | "opencode";
    capability: "text" | "tools" | "vision" | "audio" | "embedding" | "rerank";
  }): Promise<RoutePreviewOutput>;
  estimateMemory(options: {
    engine: "vllm" | "llama";
    paramsB: number;
    contextTokens: number;
    precision: "fp32" | "fp16_bf16" | "fp8_int8" | "int4_nvfp4" | "custom";
    bytesPerParam: number | null;
    parallelSequences: number;
    gpuMemoryUtilization: number;
    cpuOffloadGb: number;
    kvOffloadGb: number;
    speculativeMode: "off" | "mtp" | "draft";
    speculativeTokens: number;
  }): Promise<MemoryEstimateOutput>;
  getSecurityPosture(options: { engine: EngineSelector; warningsOnly: boolean }): Promise<SecurityPostureOutput>;
}

type SettledJson = { ok: true; data: JsonObject } | { ok: false; error: string };
type SettledArray = { ok: true; data: unknown[] } | { ok: false; error: string };

function object(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? cleanText(value, 1000) : fallback;
}

function nullableString(value: unknown): string | null {
  const result = stringValue(value).trim();
  return result ? result : null;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function generatedAt(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  }
  return new Date().toISOString();
}

function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof UpstreamRequestError) return cleanText(error.message, 500);
  if (error instanceof Error) return cleanText(error.message, 500);
  return fallback;
}

function normalizeEngine(value: unknown, fallback: "vllm" | "llama"): "vllm" | "llama" {
  return value === "llama" ? "llama" : value === "vllm" ? "vllm" : fallback;
}

/**
 * The bearer token is reduced to whether one was sent: two callers with
 * different tokens must not share a cached reply, but the token itself never
 * belongs in a map key.
 */
function cacheKey(shape: string, baseUrl: URL, pathname: string, bearerToken: string): string {
  return `${shape} ${baseUrl.origin} ${pathname} ${bearerToken ? "auth" : "anon"}`;
}

function selectedManagers(config: PlatformMcpConfig, engine: EngineSelector): ManagerTarget[] {
  return config.managers.filter((manager) => engine === "all" || manager.id === engine);
}

function metricRecord(value: unknown, maxEntries = 40): Record<string, MetricValue> {
  const output: Record<string, MetricValue> = {};
  for (const [key, item] of Object.entries(object(value)).slice(0, maxEntries)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) continue;
    if (item === null || typeof item === "number" || typeof item === "boolean") {
      output[key] = typeof item === "number" && !Number.isFinite(item) ? null : item;
    } else if (typeof item === "string") {
      output[key] = cleanText(item, 200);
    }
  }
  return output;
}

function mapGpu(value: unknown) {
  const gpu = object(value);
  const total = Math.max(0, numberValue(gpu.totalMb));
  const used = Math.max(0, numberValue(gpu.usedMb));
  const free = Math.max(0, numberValue(gpu.freeMb, Math.max(0, total - used)));
  const reserve = Math.max(0, numberValue(gpu.reserveMb));
  const allocatable = Math.max(0, numberValue(gpu.allocatableMb ?? gpu.availableMb, Math.max(0, free - reserve)));
  const threshold = Math.max(0, Math.min(100, numberValue(gpu.warningThresholdPct, 95)));
  const devices = array(gpu.gpus).map((item, index) => {
    const device = object(item);
    const deviceTotal = Math.max(0, numberValue(device.totalMb));
    const deviceUsed = Math.max(0, numberValue(device.usedMb));
    const deviceFree = Math.max(0, numberValue(device.freeMb, Math.max(0, deviceTotal - deviceUsed)));
    return {
      id: stringValue(device.id ?? device.index, String(index)),
      name: stringValue(device.name, `GPU ${index}`) || `GPU ${index}`,
      total_mb: deviceTotal,
      used_mb: deviceUsed,
      free_mb: deviceFree,
      allocatable_mb: Math.max(0, numberValue(device.allocatableMb ?? device.availableMb, deviceFree)),
      utilization_percent: deviceTotal ? Math.round((deviceUsed / deviceTotal) * 10000) / 100 : 0,
    };
  });
  return {
    total_mb: total,
    used_mb: used,
    free_mb: free,
    allocatable_mb: allocatable,
    reserve_mb: reserve,
    warning_threshold_percent: threshold,
    utilization_percent: total ? Math.round((used / total) * 10000) / 100 : 0,
    devices,
  };
}

function mapSearch(value: unknown, error: string | null = null) {
  const health = object(value);
  const state = object(health.searchState ?? health.search_state);
  const lastSearch = object(state.lastSearch ?? state.last_search);
  const metrics = object(state.metrics);
  const online = !error;
  return {
    online,
    healthy: online && booleanValue(health.ok, false),
    mode: nullableString(health.searchMode ?? health.mode),
    auth_required: online && typeof health.authRequired === "boolean" ? health.authRequired : null,
    max_results: online ? nullableNumber(health.maxResults) : null,
    state: ["healthy", "degraded", "unavailable"].includes(stringValue(state.state))
      ? stringValue(state.state) as "healthy" | "degraded" | "unavailable"
      : null,
    default_engines: array(state.defaultEngines ?? state.default_engines).map((item) => safeDisplayText(item, 64)).filter(Boolean),
    chinese_engines: array(state.chineseEngines ?? state.chinese_engines).map((item) => safeDisplayText(item, 64)).filter(Boolean),
    fallback_engines: array(state.fallbackEngines ?? state.fallback_engines).map((item) => safeDisplayText(item, 64)).filter(Boolean),
    available_default_engines: array(state.availableDefaultEngines ?? state.available_default_engines)
      .map((item) => safeDisplayText(item, 64)).filter(Boolean),
    cooldowns: mapEngineStates(state.cooldowns),
    cache_entries: Math.max(0, numberValue(state.cacheEntries ?? state.cache_entries)),
    active_backend_requests: Math.max(0, numberValue(state.activeBackendRequests ?? state.active_backend_requests)),
    queued_backend_requests: Math.max(0, numberValue(state.queuedBackendRequests ?? state.queued_backend_requests)),
    session_count: Math.max(0, numberValue(state.sessionCount ?? state.session_count)),
    last_search: Object.keys(lastSearch).length ? {
      searched_at: generatedAt(lastSearch.searchedAt ?? lastSearch.searched_at),
      quality: searchQuality(lastSearch.quality),
      count: Math.max(0, numberValue(lastSearch.count)),
      partial: booleanValue(lastSearch.partial),
      available: booleanValue(lastSearch.available),
    } : null,
    metrics: {
      searches: Math.max(0, numberValue(metrics.searches)),
      research_requests: Math.max(0, numberValue(metrics.researchRequests ?? metrics.research_requests)),
      cache_hits: Math.max(0, numberValue(metrics.cacheHits ?? metrics.cache_hits)),
      coalesced_requests: Math.max(0, numberValue(metrics.coalescedRequests ?? metrics.coalesced_requests)),
      backend_requests: Math.max(0, numberValue(metrics.backendRequests ?? metrics.backend_requests)),
      backend_failures: Math.max(0, numberValue(metrics.backendFailures ?? metrics.backend_failures)),
      zero_result_searches: Math.max(0, numberValue(metrics.zeroResultSearches ?? metrics.zero_result_searches)),
      weak_searches: Math.max(0, numberValue(metrics.weakSearches ?? metrics.weak_searches)),
      pages_read: Math.max(0, numberValue(metrics.pagesRead ?? metrics.pages_read)),
      page_read_failures: Math.max(0, numberValue(metrics.pageReadFailures ?? metrics.page_read_failures)),
      page_cache_hits: Math.max(0, numberValue(metrics.pageCacheHits ?? metrics.page_cache_hits)),
      page_finds: Math.max(0, numberValue(metrics.pageFinds ?? metrics.page_finds)),
      page_find_failures: Math.max(0, numberValue(metrics.pageFindFailures ?? metrics.page_find_failures)),
    },
    error,
  };
}

function searchQuality(value: unknown): "good" | "mixed" | "weak" | "empty" {
  const quality = stringValue(value).toLowerCase();
  return quality === "good" || quality === "mixed" || quality === "weak" || quality === "empty" ? quality : "empty";
}

function mapEngineStates(value: unknown) {
  return array(value).map((raw) => {
    const item = object(raw);
    const engine = safeDisplayText(item.engine, 64);
    if (!engine) return null;
    return {
      engine,
      reason: safeDisplayText(item.reason, 200) || "unresponsive",
      retry_after_seconds: Math.max(0, Math.trunc(numberValue(item.retryAfterSeconds ?? item.retry_after_seconds))),
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null).slice(0, 20);
}

function mapEngineDistribution(value: unknown): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(object(value)).slice(0, 20)) {
    const safeKey = safeDisplayText(key, 64).replace(/[^A-Za-z0-9_.-]/g, "");
    if (safeKey) output[safeKey] = Math.max(0, Math.trunc(numberValue(count)));
  }
  return output;
}

function sourceType(value: unknown): "official" | "academic" | "documentation" | "news" | "organization" | "community" | "commercial" | "other" {
  const result = stringValue(value).toLowerCase();
  return ["official", "academic", "documentation", "news", "organization", "community", "commercial"].includes(result)
    ? result as "official" | "academic" | "documentation" | "news" | "organization" | "community" | "commercial"
    : "other";
}

function primarySourceLikelihood(value: unknown): "high" | "medium" | "unknown" {
  const result = stringValue(value).toLowerCase();
  return result === "high" || result === "medium" ? result : "unknown";
}

function mapSourceTypeCoverage(value: unknown): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(object(value)).slice(0, 8)) {
    const safeKey = sourceType(key);
    output[safeKey] = Math.max(0, Math.trunc(numberValue(count)));
  }
  return output;
}

function mapSearchResults(value: unknown, limit: number) {
  return array(value).map((raw, index) => {
    const item = object(raw);
    const url = safeExternalUrl(item.url);
    if (!url) return null;
    const parsed = new URL(url);
    const engines = array(item.engines).map((engine) => safeDisplayText(engine, 64)).filter(Boolean);
    const fallbackEngine = nullableString(item.engine);
    if (!engines.length && fallbackEngine) engines.push(...fallbackEngine.split(",").map((engine) => safeDisplayText(engine, 64)).filter(Boolean));
    const relevance = Math.max(0, Math.min(1, numberValue(item.relevance)));
    return {
      result_id: safeDisplayText(item.resultId ?? item.result_id, 30) || `r${index + 1}`,
      title: safeDisplayText(item.title ?? item.url, 240),
      url,
      domain: safeDisplayText(item.domain, 253) || parsed.hostname.toLowerCase(),
      content: safeDisplayText(item.content ?? item.snippet, 1200),
      engine: fallbackEngine,
      engines: Array.from(new Set(engines)).slice(0, 12),
      score: nullableNumber(item.score),
      relevance,
      low_relevance: typeof item.lowRelevance === "boolean" ? item.lowRelevance : booleanValue(item.low_relevance, relevance < 0.12),
      category: nullableString(item.category),
      published_at: nullableString(item.publishedDate ?? item.published_at ?? item.published_date),
      matched_queries: array(item.matchedQueries ?? item.matched_queries).map((query) => safeDisplayText(query, 40)).filter(Boolean).slice(0, 6),
      source_type: sourceType(item.sourceType ?? item.source_type),
      source_type_reason: safeDisplayText(item.sourceTypeReason ?? item.source_type_reason, 100) || "unclassified",
      primary_source_likelihood: primarySourceLikelihood(item.primarySourceLikelihood ?? item.primary_source_likelihood),
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null).slice(0, limit);
}

function mapSearchEnvelope(payloadValue: unknown, fallbackQuery: string, maxResults: number) {
  const payload = object(payloadValue);
  const engineStatus = object(payload.engineStatus ?? payload.engine_status);
  const results = mapSearchResults(payload.results, maxResults);
  return {
    ok: booleanValue(payload.ok, booleanValue(payload.available, true)),
    partial: booleanValue(payload.partial),
    generated_at: generatedAt(payload.searchedAt ?? payload.searched_at),
    warnings: array(payload.warnings).map((value) => safeDisplayText(value, 500)).filter(Boolean).slice(0, 20),
    data: {
      search_id: safeDisplayText(payload.searchId ?? payload.search_id, 100),
      expires_in_seconds: Math.max(1, Math.trunc(numberValue(payload.expiresInSeconds ?? payload.expires_in_seconds, 900))),
      query: safeDisplayText(payload.query, 500) || fallbackQuery,
      searched_at: generatedAt(payload.searchedAt ?? payload.searched_at),
      count: results.length,
      total_candidates: Math.max(results.length, Math.trunc(numberValue(payload.totalCandidates ?? payload.total_candidates, results.length))),
      unique_candidates: Math.max(results.length, Math.trunc(numberValue(payload.uniqueCandidates ?? payload.unique_candidates, results.length))),
      quality: searchQuality(payload.quality ?? (results.length ? "mixed" : "empty")),
      available: booleanValue(payload.available, true),
      cache_hit: booleanValue(payload.cacheHit ?? payload.cache_hit),
      coalesced: booleanValue(payload.coalesced),
      fallback_used: booleanValue(payload.fallbackUsed ?? payload.fallback_used),
      fallback_reason: nullableString(payload.fallbackReason ?? payload.fallback_reason),
      answers: array(payload.answers).map((value) => safeDisplayText(value, 700)).filter(Boolean).slice(0, 6),
      corrections: array(payload.corrections).map((value) => safeDisplayText(value, 240)).filter(Boolean).slice(0, 8),
      suggestions: array(payload.suggestions).map((value) => safeDisplayText(value, 240)).filter(Boolean).slice(0, 12),
      source_domains: array(payload.sourceDomains ?? payload.source_domains).map((value) => safeDisplayText(value, 253)).filter(Boolean).slice(0, 40),
      source_type_coverage: mapSourceTypeCoverage(payload.sourceTypeCoverage ?? payload.source_type_coverage),
      engine_status: {
        requested: array(engineStatus.requested).map((value) => safeDisplayText(value, 64)).filter(Boolean),
        attempted: array(engineStatus.attempted).map((value) => safeDisplayText(value, 64)).filter(Boolean),
        used: array(engineStatus.used).map((value) => safeDisplayText(value, 64)).filter(Boolean),
        distribution: mapEngineDistribution(engineStatus.distribution),
        unresponsive: mapEngineStates(engineStatus.unresponsive),
        cooled_down: mapEngineStates(engineStatus.cooledDown ?? engineStatus.cooled_down),
      },
      results,
    },
  };
}

/**
 * The manager stores runs with camelCase keys; the MCP surface publishes
 * snake_case. A run without a parseable timestamp is dropped rather than
 * published with a made-up one.
 */
function mapBenchmarkRun(raw: unknown, engine: "vllm" | "llama") {
  const run = object(raw);
  const at = nullableString(run.at);
  if (!at || Number.isNaN(Date.parse(at))) return null;
  const load = object(run.load);
  const config: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(object(run.config))) {
    if (typeof value === "number" && Number.isFinite(value)) config[key] = value;
    else if (typeof value === "boolean") config[key] = value;
    else if (typeof value === "string" && value) config[key] = safeDisplayText(value, 200);
  }
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(object(run.metrics))) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) metrics[key] = parsed;
  }
  return {
    engine,
    id: safeDisplayText(run.id, 64) || "unknown",
    at,
    model: safeDisplayText(run.model, 300),
    label: safeDisplayText(run.label, 120),
    config,
    load: {
      requests: numberValue(load.requests),
      concurrency: numberValue(load.concurrency),
      max_tokens: numberValue(load.maxTokens),
      stream: booleanValue(load.stream),
      warmup_requests: numberValue(load.warmupRequests),
      failed_requests: numberValue(load.failedRequests),
      total_output_tokens: numberValue(load.totalOutputTokens),
    },
    metrics,
  };
}

function mapRunningInstances(fleetValue: unknown, filter: EngineSelector) {
  const fleet = object(fleetValue);
  return array(fleet.instances)
    .map((item) => object(item))
    .filter((item) => {
      const engine = normalizeEngine(item.engine ?? item.managerId ?? object(item.manager).id, "vllm");
      return filter === "all" || engine === filter;
    })
    .map((item) => {
      const engine = normalizeEngine(item.engine ?? item.managerId ?? object(item.manager).id, "vllm");
      const instanceId = stringValue(item.instanceId ?? item.id, "primary");
      const containerName = stringValue(item.containerName, "");
      const lifecycle = stringValue(item.lifecycleState, booleanValue(item.running) ? "running" : "stopped");
      const models = array(item.models).map((modelValue) => {
        const model = object(modelValue);
        return {
          id: stringValue(model.id, "unknown-model"),
          engine,
          instance_id: instanceId,
          container_name: containerName,
          lifecycle_state: lifecycle,
          status: stringValue(item.status, lifecycle),
          max_model_len: nullableNumber(model.maxModelLen),
          capabilities: array(model.capabilities).map((capability) => stringValue(capability)).filter(Boolean).slice(0, 20),
        };
      });
      return {
        engine,
        instance_id: instanceId,
        container_name: containerName,
        lifecycle_state: lifecycle,
        running: booleanValue(item.running),
        status: stringValue(item.status, lifecycle),
        port: nullableNumber(item.port),
        models,
      };
    });
}

function mapModelPerformance(value: unknown) {
  const model = object(value);
  return {
    name: stringValue(model.name, "unknown-model"),
    requests: metricRecord(model.requests),
    tokens: metricRecord(model.tokens),
    speed: metricRecord(model.speed),
    latency: metricRecord(model.latency),
    cache: metricRecord(model.cache),
    speculative: metricRecord(model.speculative),
    context: metricRecord(model.context),
  };
}

function safeDisplayText(value: unknown, maxLength = 500): string {
  return cleanText(value, maxLength)
    .replace(/[A-Za-z]:\\[^\r\n\t"']+/g, "[local path]")
    .replace(/\/(?:models|root|home|workspace)\/[^\s"']+/gi, "[local path]")
    .slice(0, maxLength)
    .trim();
}

function safeExternalUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value || ""));
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || isPrivateHostname(url.hostname)) return null;
    url.hash = "";
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

function isPrivateHostname(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (["localhost", "0.0.0.0", "::", "::1"].includes(host)) return true;
  if ([".localhost", ".local", ".internal", ".lan", ".home"].some((suffix) => host.endsWith(suffix))) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return true;
    const first = octets[0] ?? 999;
    const second = octets[1] ?? 999;
    return first === 0 || first === 10 || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first >= 224;
  }
  if (host.includes(":")) {
    return /^(?:f[cd]|fe[89ab])/i.test(host) || /^::ffff:(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(host);
  }
  return false;
}

function mapExtractedDocument(raw: unknown, maxChars: number) {
  const item = object(raw);
  const url = safeExternalUrl(item.url);
  if (!url) return null;
  const finalUrl = item.finalUrl ?? item.final_url;
  const safeFinalUrl = finalUrl ? safeExternalUrl(finalUrl) : null;
  const canonicalValue = item.canonicalUrl ?? item.canonical_url;
  const safeCanonicalUrl = canonicalValue ? safeExternalUrl(canonicalValue) : null;
  const content = safeDisplayText(item.content, maxChars);
  const headings = array(item.headings).map((rawHeading) => {
    const heading = object(rawHeading);
    const level = Math.max(1, Math.min(6, Math.trunc(numberValue(heading.level, 1))));
    const text = safeDisplayText(heading.text, 240);
    return text ? { level, text } : null;
  }).filter((heading): heading is NonNullable<typeof heading> => heading !== null).slice(0, 40);
  const confidenceValue = stringValue(item.metadataConfidence ?? item.metadata_confidence).toLowerCase();
  const metadataConfidence = confidenceValue === "high" || confidenceValue === "medium" || confidenceValue === "low"
    ? confidenceValue
    : null;
  const documentValue = stringValue(item.documentType ?? item.document_type).toLowerCase();
  const documentTypes = ["html_article", "html_page", "plain_text", "markdown", "csv", "json", "xml_feed", "pdf"] as const;
  const documentType = documentTypes.includes(documentValue as typeof documentTypes[number])
    ? documentValue as typeof documentTypes[number]
    : null;
  return {
    title: safeDisplayText(item.title, 300),
    url,
    final_url: safeFinalUrl,
    domain: safeDisplayText(item.domain, 253) || new URL(safeFinalUrl || url).hostname,
    description: safeDisplayText(item.description, 600),
    author: nullableString(safeDisplayText(item.author, 300)),
    site_name: nullableString(safeDisplayText(item.siteName ?? item.site_name, 200)),
    published_at: nullableString(item.publishedAt ?? item.published_at),
    modified_at: nullableString(item.modifiedAt ?? item.modified_at),
    canonical_url: safeCanonicalUrl,
    language: nullableString(safeDisplayText(item.language, 40)),
    content_type: nullableString(item.contentType ?? item.content_type),
    document_type: documentType,
    extraction_method: nullableString(safeDisplayText(item.extractionMethod ?? item.extraction_method, 80)),
    metadata_confidence: metadataConfidence,
    headings,
    json_ld_types: array(item.jsonLdTypes ?? item.json_ld_types).map((value) => safeDisplayText(value, 100)).filter(Boolean).slice(0, 20),
    content,
    char_count: content.length,
    source_char_count: Math.max(content.length, Math.trunc(numberValue(item.sourceCharCount ?? item.source_char_count, content.length))),
    word_count: Math.max(0, Math.trunc(numberValue(item.wordCount ?? item.word_count))),
    page_count: nullableNumber(item.pageCount ?? item.page_count) == null ? null : Math.max(0, Math.trunc(numberValue(item.pageCount ?? item.page_count))),
    pages_read: nullableNumber(item.pagesRead ?? item.pages_read) == null ? null : Math.max(0, Math.trunc(numberValue(item.pagesRead ?? item.pages_read))),
    truncated: booleanValue(item.truncated),
    error: nullableString(item.error),
  };
}

function progressPercent(value: unknown): number | null {
  const direct = nullableNumber(value);
  if (direct !== null) return Math.max(0, Math.min(100, direct));
  const source = object(value);
  const candidate = nullableNumber(source.percent ?? source.percentage ?? source.progressPercent);
  return candidate === null ? null : Math.max(0, Math.min(100, candidate));
}

function round(value: unknown, digits = 3): number | null {
  const number = nullableNumber(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function bytesForPrecision(
  precision: "fp32" | "fp16_bf16" | "fp8_int8" | "int4_nvfp4" | "custom",
  custom: number | null,
): number {
  if (precision === "custom") return custom ?? 1;
  return { fp32: 4, fp16_bf16: 2, fp8_int8: 1, int4_nvfp4: 0.5 }[precision];
}

function findingStatus(value: unknown): "ok" | "warn" | "fail" {
  const normalized = stringValue(value).toLowerCase();
  if (normalized === "ok" || normalized === "pass") return "ok";
  if (normalized === "fail" || normalized === "error") return "fail";
  return "warn";
}

function safeFindingTitle(value: unknown, fallback = "Configuration finding"): string {
  const source = object(value);
  return safeDisplayText(source.title ?? source.message ?? source.kind ?? value, 300) || fallback;
}

function hostScope(value: unknown, publishedHosts: unknown): "loopback" | "lan" | "unknown" {
  const hosts = [stringValue(value), ...array(publishedHosts).map((item) => stringValue(object(item).host))].filter(Boolean);
  if (!hosts.length) return "unknown";
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  return hosts.every((host) => loopback.has(host.toLowerCase())) ? "loopback" : "lan";
}

export class LocalPlatformClient implements PlatformDataSource {
  private readonly config: PlatformMcpConfig;
  private readonly http: FixedHttpClient;
  private readonly cache: UpstreamCache;

  constructor(config: PlatformMcpConfig, http?: FixedHttpClient, cache?: UpstreamCache) {
    this.config = config;
    this.http = http ?? new FixedHttpClient({
      timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxUpstreamBytes,
    });
    this.cache = cache ?? new UpstreamCache({ ttlMs: config.cacheTtlMs });
  }

  cacheStats(): ReturnType<UpstreamCache["stats"]> {
    return this.cache.stats();
  }

  private assertSearchConfigured(): void {
    if (!this.config.searchGatewayApiKey) {
      throw new Error(
        "Web search is not configured for MCP. Start the service with start-platform-mcp.cmd, "
        + "or provide PLATFORM_MCP_SEARCH_GATEWAY_API_KEY through the client's secret store.",
      );
    }
  }

  /**
   * Reads an upstream endpoint through the short-lived cache. Several tools
   * read the same endpoint, and an agent commonly calls several of them to
   * answer one question, so without this a single turn costs the managers
   * three or four identical requests.
   */
  private async safeGet(service: string, baseUrl: URL, pathname: string, bearerToken = ""): Promise<SettledJson> {
    try {
      const data = await this.cache.run(
        cacheKey("json", baseUrl, pathname, bearerToken),
        () => this.http.getJson(service, baseUrl, pathname, { bearerToken }),
      );
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: safeMessage(error, `${service} is unavailable.`) };
    }
  }

  private async safePost(service: string, baseUrl: URL, pathname: string, body: JsonObject): Promise<SettledJson> {
    try {
      return { ok: true, data: await this.http.postJson(service, baseUrl, pathname, body) };
    } catch (error) {
      return { ok: false, error: safeMessage(error, `${service} is unavailable.`) };
    }
  }

  private async safeGetArray(service: string, baseUrl: URL, pathname: string): Promise<SettledArray> {
    try {
      const data = await this.cache.run(
        cacheKey("array", baseUrl, pathname, ""),
        () => this.http.getJsonArray(service, baseUrl, pathname),
      );
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: safeMessage(error, `${service} is unavailable.`) };
    }
  }

  async getOverview(): Promise<OverviewOutput> {
    const [statusResult, fleetResult, searchResult] = await Promise.all([
      this.safeGet("service entry", this.config.serviceEntryUrl, "/api/status"),
      this.safeGet("service fleet", this.config.serviceEntryUrl, "/api/fleet"),
      this.safeGet("search gateway", this.config.searchGatewayUrl, "/health"),
    ]);
    const warnings = [statusResult, fleetResult, searchResult]
      .filter((result): result is { ok: false; error: string } => !result.ok)
      .map((result) => result.error);
    const status = statusResult.ok ? statusResult.data : {};
    const fleet = fleetResult.ok ? fleetResult.data : {};
    const entry = object(status.entry);
    const instances = mapRunningInstances(fleet, "all");
    const modelCounts = new Map<"vllm" | "llama", number>([["vllm", 0], ["llama", 0]]);
    for (const instance of instances) modelCounts.set(instance.engine, (modelCounts.get(instance.engine) || 0) + instance.models.length);
    const managers = array(status.managers).map((value) => {
      const manager = object(value);
      const id = normalizeEngine(manager.id, "vllm");
      const processInfo = object(manager.process);
      const runtime = object(manager.runtime);
      const container = object(runtime.container);
      const online = booleanValue(processInfo.portListening, booleanValue(manager.ok));
      const runtimeRunning = booleanValue(container.running);
      return {
        id,
        name: stringValue(manager.name, id === "vllm" ? "vLLM Manager" : "llama.cpp Manager"),
        online,
        healthy: online && !stringValue(manager.error),
        runtime_running: runtimeRunning,
        model_count: modelCounts.get(id) || 0,
        error: nullableString(manager.error),
      };
    });
    const searchError = searchResult.ok ? null : searchResult.error;
    return OverviewOutputSchema.parse({
      ok: statusResult.ok && fleetResult.ok,
      partial: warnings.length > 0,
      generated_at: generatedAt(fleet.updatedAt),
      warnings,
      data: {
        service_entry: {
          online: statusResult.ok,
          uptime_seconds: nullableNumber(entry.uptimeSeconds),
          bind_host: nullableString(entry.host),
          port: nullableNumber(entry.port),
        },
        managers,
        running_model_count: instances.reduce((total, instance) => total + instance.models.length, 0),
        gpu: fleetResult.ok && Object.keys(object(fleet.gpuMemory)).length ? mapGpu(fleet.gpuMemory) : null,
        gateway_base: nullableString(fleet.gatewayBase),
        search: mapSearch(searchResult.ok ? searchResult.data : {}, searchError),
      },
    });
  }

  async listRunningModels(engine: EngineSelector): Promise<RunningModelsOutput> {
    const result = await this.safeGet("service fleet", this.config.serviceEntryUrl, "/api/fleet");
    const instances = result.ok ? mapRunningInstances(result.data, engine) : [];
    return RunningModelsOutputSchema.parse({
      ok: result.ok,
      partial: false,
      generated_at: generatedAt(result.ok ? result.data.updatedAt : null),
      warnings: result.ok ? [] : [result.error],
      data: {
        engine_filter: engine,
        total_models: instances.reduce((total, instance) => total + instance.models.length, 0),
        instances,
      },
    });
  }

  async getGpuStatus(): Promise<GpuStatusOutput> {
    const result = await this.safeGet("service fleet", this.config.serviceEntryUrl, "/api/fleet");
    const gpuValue = result.ok ? result.data.gpuMemory : null;
    return GpuStatusOutputSchema.parse({
      ok: result.ok,
      partial: false,
      generated_at: generatedAt(result.ok ? result.data.updatedAt : null),
      warnings: result.ok ? [] : [result.error],
      data: { gpu: gpuValue && Object.keys(object(gpuValue)).length ? mapGpu(gpuValue) : null },
    });
  }

  async listLocalModels(options: {
    engine: EngineSelector;
    inventory: "local" | "cached" | "all";
    limit: number;
    offset: number;
  }): Promise<LocalModelsOutput> {
    const targets = selectedManagers(this.config, options.engine);
    const results = await Promise.all(targets.map(async (target) => ({
      target,
      result: await this.safeGet(target.name, target.baseUrl, "/api/models"),
    })));
    const warnings: string[] = [];
    const models: Array<{
      engine: "vllm" | "llama";
      inventory: "local" | "cached";
      id: string;
      label: string;
      size_bytes: number | null;
      modified_at: string | null;
      format: string | null;
      runnable: boolean | null;
      verification_status: string | null;
      issues: string[];
    }> = [];
    for (const { target, result } of results) {
      if (!result.ok) {
        warnings.push(result.error);
        continue;
      }
      const kinds: Array<"local" | "cached"> = options.inventory === "all"
        ? ["local", "cached"]
        : [options.inventory];
      for (const kind of kinds) {
        for (const raw of array(result.data[kind])) {
          const model = object(raw);
          const issues = array(model.verificationIssues).map((issueValue) => {
            const issue = object(issueValue);
            return cleanText([stringValue(issue.title), stringValue(issue.detail)].filter(Boolean).join(": "), 500);
          }).filter(Boolean).slice(0, 20);
          models.push({
            engine: target.id,
            inventory: kind,
            id: stringValue(model.id, "unknown-model"),
            label: stringValue(model.label ?? model.id, "unknown-model"),
            size_bytes: nullableNumber(model.size),
            modified_at: nullableString(model.modified),
            format: nullableString(model.modelFormat),
            runnable: kind === "local" && typeof model.runnable === "boolean" ? model.runnable : null,
            verification_status: kind === "local" ? nullableString(model.verificationStatus) : null,
            issues,
          });
        }
      }
    }
    models.sort((a, b) => a.engine.localeCompare(b.engine) || a.inventory.localeCompare(b.inventory) || a.id.localeCompare(b.id));
    const page = models.slice(options.offset, options.offset + options.limit);
    const nextOffset = options.offset + page.length < models.length ? options.offset + page.length : null;
    const successes = results.filter(({ result }) => result.ok).length;
    return LocalModelsOutputSchema.parse({
      ok: successes > 0,
      partial: warnings.length > 0 && successes > 0,
      generated_at: new Date().toISOString(),
      warnings,
      data: {
        engine_filter: options.engine,
        inventory_filter: options.inventory,
        total: models.length,
        count: page.length,
        offset: options.offset,
        has_more: nextOffset !== null,
        next_offset: nextOffset,
        models: page,
      },
    });
  }

  async getPerformance(options: { engine: EngineSelector; includeModels: boolean }): Promise<PerformanceOutput> {
    const targets = selectedManagers(this.config, options.engine);
    const results = await Promise.all(targets.map(async (target) => ({
      target,
      result: await this.safeGet(target.name, target.baseUrl, "/api/stats"),
    })));
    const warnings: string[] = [];
    const managers = results.map(({ target, result }) => {
      if (!result.ok) {
        warnings.push(result.error);
        return {
          engine: target.id,
          available: false,
          updated_at: null,
          requests: {}, tokens: {}, speed: {}, latency: {}, cache: {}, speculative: {}, context: {}, facts: {}, models: [],
          error: result.error,
        };
      }
      const totals = object(result.data.totals);
      return {
        engine: target.id,
        available: true,
        updated_at: nullableString(result.data.updatedAt),
        requests: metricRecord(totals.requests),
        tokens: metricRecord(totals.tokens),
        speed: metricRecord(totals.speed),
        latency: metricRecord(totals.latency),
        cache: metricRecord(totals.cache),
        speculative: metricRecord(totals.speculative),
        context: metricRecord(totals.context),
        facts: metricRecord(result.data.facts),
        models: options.includeModels ? array(result.data.models).slice(0, 10).map(mapModelPerformance) : [],
        error: null,
      };
    });
    const successes = managers.filter((manager) => manager.available).length;
    return PerformanceOutputSchema.parse({
      ok: successes > 0,
      partial: warnings.length > 0 && successes > 0,
      generated_at: generatedAt(...managers.map((manager) => manager.updated_at)),
      warnings,
      data: { engine_filter: options.engine, managers },
    });
  }

  async getDiagnostics(options: {
    engine: EngineSelector;
    warningsOnly: boolean;
    includeRecentLogs: boolean;
    logLines: number;
  }): Promise<DiagnosticsOutput> {
    const targets = selectedManagers(this.config, options.engine);
    const results = await Promise.all(targets.map(async (target) => ({
      target,
      result: await this.safeGet(target.name, target.baseUrl, "/api/tools/health"),
    })));
    const warnings: string[] = [];
    const managers = results.map(({ target, result }) => {
      if (!result.ok) {
        warnings.push(result.error);
        return {
          engine: target.id,
          available: false,
          score: null,
          stage: null,
          checks: [],
          issues: [],
          suggestions: [],
          recent_logs: [],
          error: result.error,
        };
      }
      const logSummary = object(result.data.logSummary);
      const checks = array(result.data.checks).map((checkValue) => {
        const check = object(checkValue);
        const rawStatus = stringValue(check.status).toLowerCase();
        const status: "ok" | "warn" | "fail" = rawStatus === "ok"
          ? "ok"
          : rawStatus === "fail" || rawStatus === "error"
            ? "fail"
            : "warn";
        return {
          id: stringValue(check.id, "unknown-check"),
          label: stringValue(check.label, stringValue(check.id, "Unknown check")),
          status,
          message: nullableString(check.detail ?? check.message),
        };
      }).filter((check) => !options.warningsOnly || check.status !== "ok");
      const issues = array(logSummary.issues).map((issueValue) => {
        const issue = object(issueValue);
        return cleanText([stringValue(issue.message), stringValue(issue.hint)].filter(Boolean).join(" — "), 800);
      }).filter(Boolean).slice(0, 20);
      const suggestions = array(logSummary.suggestions).map((value) => cleanText(value, 500)).filter(Boolean).slice(0, 20);
      const recentLogs = options.includeRecentLogs
        ? array(logSummary.recent).slice(-options.logLines).map((value) => cleanText(value, 1000)).filter(Boolean)
        : [];
      return {
        engine: target.id,
        available: true,
        score: nullableNumber(result.data.score),
        stage: nullableString(logSummary.stage),
        checks,
        issues,
        suggestions,
        recent_logs: recentLogs,
        error: null,
      };
    });
    const successes = managers.filter((manager) => manager.available).length;
    return DiagnosticsOutputSchema.parse({
      ok: successes > 0,
      partial: warnings.length > 0 && successes > 0,
      generated_at: generatedAt(...results.filter(({ result }) => result.ok).map(({ result }) => result.ok ? result.data.generatedAt : null)),
      warnings,
      data: { engine_filter: options.engine, managers },
    });
  }

  async getSearchHealth(): Promise<SearchHealthOutput> {
    const result = await this.safeGet("search gateway", this.config.searchGatewayUrl, "/health");
    const error = result.ok ? null : result.error;
    return SearchHealthOutputSchema.parse({
      ok: result.ok,
      partial: false,
      generated_at: new Date().toISOString(),
      warnings: error ? [error] : [],
      data: { search: mapSearch(result.ok ? result.data : {}, error) },
    });
  }

  /**
   * Benchmark history lives in each manager's own ledger, so this fans out and
   * merges. A manager that predates the ledger answers 404; that lands in
   * `warnings` with `partial` set rather than failing the call, because the
   * other engine's history is still worth returning.
   */
  async listBenchmarks(options: {
    engine: EngineSelector;
    model: string;
    limit: number;
    offset: number;
  }): Promise<BenchmarkRunsOutput> {
    const targets = selectedManagers(this.config, options.engine);
    const query = options.model ? `?model=${encodeURIComponent(options.model)}&limit=50` : "?limit=50";
    const responses = await Promise.all(targets.map(async (target) => ({
      target,
      result: await this.safeGet(target.name, target.baseUrl, `/api/benchmarks${query}`),
    })));
    const warnings: string[] = [];
    const runs: BenchmarkRunsOutput["data"]["runs"] = [];
    const models = new Set<string>();
    for (const { target, result } of responses) {
      if (!result.ok) {
        warnings.push(result.error);
        continue;
      }
      for (const name of array(result.data.models)) {
        const label = safeDisplayText(name, 300);
        if (label) models.add(label);
      }
      for (const raw of array(result.data.runs)) {
        const run = mapBenchmarkRun(raw, target.id);
        if (run) runs.push(run);
      }
    }
    runs.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
    const page = runs.slice(options.offset, options.offset + options.limit);
    const nextOffset = options.offset + page.length < runs.length ? options.offset + page.length : null;
    const successes = responses.filter(({ result }) => result.ok).length;
    return BenchmarkRunsOutputSchema.parse({
      ok: successes > 0,
      partial: warnings.length > 0 && successes > 0,
      generated_at: new Date().toISOString(),
      warnings,
      data: {
        engine_filter: options.engine,
        model_filter: options.model,
        total: runs.length,
        count: page.length,
        offset: options.offset,
        has_more: nextOffset !== null,
        next_offset: nextOffset,
        models: Array.from(models).sort(),
        runs: page,
      },
    });
  }

  /**
   * Run IDs do not say which manager recorded them, so both are asked and the
   * first manager that knows all of the requested runs answers. Comparing
   * across engines is deliberately not merged here: the two engines' metrics
   * come from different load generators and are not comparable number for
   * number.
   */
  async compareBenchmarks(options: { runIds: string[]; baselineId: string }): Promise<BenchmarkCompareOutput> {
    const targets = selectedManagers(this.config, "all");
    const ids = options.runIds.join(",");
    const baseline = options.baselineId ? `&baselineId=${encodeURIComponent(options.baselineId)}` : "";
    const responses = await Promise.all(targets.map(async (target) => ({
      target,
      result: await this.safeGet(
        target.name,
        target.baseUrl,
        `/api/benchmarks/compare?ids=${encodeURIComponent(ids)}${baseline}`,
      ),
    })));
    const warnings: string[] = [];
    let best: { target: ManagerTarget; data: Obj; found: number } | null = null;
    for (const { target, result } of responses) {
      if (!result.ok) {
        warnings.push(result.error);
        continue;
      }
      const found = array(result.data.runs).length;
      if (!best || found > best.found) best = { target, data: result.data, found };
    }
    if (!best || !best.found) {
      return BenchmarkCompareOutputSchema.parse({
        ok: false,
        partial: warnings.length > 0,
        generated_at: new Date().toISOString(),
        warnings: warnings.length
          ? warnings
          : ["None of the requested run IDs exist. List runs again to get current IDs."],
        data: {
          baseline_id: "",
          missing_run_ids: options.runIds,
          runs: [],
          differing_config: [],
          metrics: [],
        },
      });
    }
    const runs = array(best.data.runs)
      .map((raw) => mapBenchmarkRun(raw, best!.target.id))
      .filter((run): run is NonNullable<typeof run> => run !== null);
    const present = new Set(runs.map((run) => run.id));
    const missing = options.runIds.filter((id) => !present.has(id));
    const configKeys = array(best.data.configKeys).map((key) => stringValue(key)).filter(Boolean);
    return BenchmarkCompareOutputSchema.parse({
      ok: true,
      partial: warnings.length > 0 || missing.length > 0,
      generated_at: new Date().toISOString(),
      warnings: missing.length
        ? [...warnings, `${missing.length} requested run ID(s) were not found and are listed in missing_run_ids.`]
        : warnings,
      data: {
        baseline_id: stringValue(best.data.baselineId),
        missing_run_ids: missing,
        runs,
        differing_config: configKeys.map((key) => ({
          key,
          values: runs.map((run) => ({
            run_id: run.id,
            value: run.config[key] ?? null,
          })),
        })),
        metrics: array(best.data.metrics).map((raw) => {
          const metric = object(raw);
          return {
            key: stringValue(metric.key),
            better: stringValue(metric.better) === "lower" ? "lower" as const : "higher" as const,
            baseline: numberValue(metric.baseline),
            values: array(metric.values).map((valueRaw) => {
              const entry = object(valueRaw);
              return {
                run_id: stringValue(entry.id),
                value: numberValue(entry.value),
                delta_percent: round(entry.deltaPercent, 2),
                improved: typeof entry.improved === "boolean" ? entry.improved : null,
              };
            }),
          };
        }),
      },
    });
  }

  /**
   * Reports the idle-release policy and which runtimes it has already put to
   * sleep. Read-only by design: restoring a sleeping runtime starts a
   * container and competes for GPU memory, so it stays a console action.
   */
  async getIdleState(options: { engine: EngineSelector }): Promise<IdleStateOutput> {
    const targets = selectedManagers(this.config, options.engine);
    const responses = await Promise.all(targets.map(async (target) => ({
      target,
      result: await this.safeGet(target.name, target.baseUrl, "/api/idle-unload"),
    })));
    const warnings: string[] = [];
    const engines: IdleStateOutput["data"]["engines"] = [];
    const released: IdleStateOutput["data"]["released"] = [];
    for (const { target, result } of responses) {
      if (!result.ok) {
        warnings.push(result.error);
        engines.push({
          engine: target.id,
          enabled: false,
          idle_minutes: null,
          min_vram_mb: null,
          excluded_models: [],
          error: result.error,
        });
        continue;
      }
      const settings = object(result.data.settings);
      engines.push({
        engine: target.id,
        enabled: booleanValue(settings.enabled),
        idle_minutes: nullableNumber(settings.idleMinutes),
        min_vram_mb: nullableNumber(settings.minVramMb),
        excluded_models: array(settings.excludeModels)
          .map((model) => safeDisplayText(model, 300))
          .filter(Boolean),
        error: null,
      });
      for (const raw of array(result.data.sleeping)) {
        const item = object(raw);
        released.push({
          engine: target.id,
          id: safeDisplayText(item.id, 160) || "unknown",
          model: safeDisplayText(item.model, 300),
          released_at: nullableString(item.sleptAt),
          released_vram_mb: nullableNumber(item.vramMb),
          idle_minutes: round(item.idleMinutes, 1),
          restorable: booleanValue(item.hasConfig),
          wake_error: nullableString(safeDisplayText(item.wakeError, 300)),
        });
      }
    }
    const successes = responses.filter(({ result }) => result.ok).length;
    return IdleStateOutputSchema.parse({
      ok: successes > 0,
      partial: warnings.length > 0 && successes > 0,
      generated_at: new Date().toISOString(),
      warnings,
      data: {
        engine_filter: options.engine,
        engines,
        released_count: released.length,
        released_vram_mb: released.reduce((total, item) => total + (item.released_vram_mb || 0), 0),
        released,
      },
    });
  }

  async searchWeb(options: {
    query: string;
    maxResults: number;
    language: string;
    timeRange: "none" | "day" | "month" | "year";
    engines: string[];
    categories: string[];
    safesearch: 0 | 1 | 2;
    preferredDomains: string[];
    includeDomains: string[];
    excludeDomains: string[];
    maxPerDomain: number;
    preferredSourceTypes: string[];
  }): Promise<WebSearchOutput> {
    this.assertSearchConfigured();
    const params = new URLSearchParams({
      q: options.query,
      max_results: String(options.maxResults),
      safesearch: String(options.safesearch),
    });
    if (options.language) params.set("language", options.language);
    if (options.timeRange !== "none") params.set("time_range", options.timeRange);
    if (options.engines.length) params.set("engines", options.engines.join(","));
    if (options.categories.length) params.set("categories", options.categories.join(","));
    if (options.preferredDomains?.length) params.set("preferred_domains", options.preferredDomains.join(","));
    if (options.includeDomains?.length) params.set("include_domains", options.includeDomains.join(","));
    if (options.excludeDomains?.length) params.set("exclude_domains", options.excludeDomains.join(","));
    if (options.maxPerDomain && options.maxPerDomain !== 3) params.set("max_per_domain", String(options.maxPerDomain));
    if (options.preferredSourceTypes.length) params.set("preferred_source_types", options.preferredSourceTypes.join(","));

    const payload = await this.http.getJson(
      "search gateway",
      this.config.searchGatewayUrl,
      `/search?${params.toString()}`,
      { bearerToken: this.config.searchGatewayApiKey },
    );
    return WebSearchOutputSchema.parse(mapSearchEnvelope(payload, options.query, options.maxResults));
  }

  async researchWeb(options: {
    queries: Array<{ id?: string; query: string; preferred_source_types?: string[] }>;
    maxResultsPerQuery: number;
    maxSources: number;
    language: string;
    timeRange: "none" | "day" | "month" | "year";
    engines: string[];
    categories: string[];
    safesearch: 0 | 1 | 2;
    preferredDomains: string[];
    includeDomains: string[];
    excludeDomains: string[];
    maxPerDomain: number;
    preferredSourceTypes: string[];
    sourceStrategy: "balanced" | "relevance" | "primary";
  }): Promise<ResearchWebOutput> {
    this.assertSearchConfigured();
    const payload = await this.http.postJson(
      "search gateway",
      this.config.searchGatewayUrl,
      "/research",
      {
        queries: options.queries.map((item, index) => ({
          id: item.id || `q${index + 1}`,
          query: item.query,
          preferred_source_types: item.preferred_source_types || [],
        })),
        max_results_per_query: options.maxResultsPerQuery,
        max_sources: options.maxSources,
        language: options.language,
        time_range: options.timeRange === "none" ? "" : options.timeRange,
        engines: options.engines,
        categories: options.categories,
        safesearch: options.safesearch,
        preferred_domains: options.preferredDomains,
        include_domains: options.includeDomains,
        exclude_domains: options.excludeDomains,
        max_per_domain: options.maxPerDomain,
        preferred_source_types: options.preferredSourceTypes,
        source_strategy: options.sourceStrategy,
      },
      { bearerToken: this.config.searchGatewayApiKey, timeoutMs: Math.max(this.config.timeoutMs, 90000) },
    );
    const mapped = mapSearchEnvelope(payload, options.queries.map((item) => item.query).join(" | "), options.maxSources);
    const coverage = array(payload.queryCoverage ?? payload.query_coverage).map((raw, index) => {
      const item = object(raw);
      const qualityValue = stringValue(item.quality);
      return {
        id: safeDisplayText(item.id, 40) || options.queries[index]?.id || `q${index + 1}`,
        query: safeDisplayText(item.query, 500) || options.queries[index]?.query || "",
        count: Math.max(0, Math.trunc(numberValue(item.count))),
        quality: qualityValue === "unavailable" ? "unavailable" as const : searchQuality(qualityValue),
        cache_hit: booleanValue(item.cacheHit ?? item.cache_hit),
        error: nullableString(item.error),
      };
    }).slice(0, 8);
    const strategyValue = stringValue(payload.sourceStrategy ?? payload.source_strategy);
    const sourceStrategy = strategyValue === "relevance" || strategyValue === "primary" ? strategyValue : "balanced";
    const coverageGaps = array(payload.coverageGaps ?? payload.coverage_gaps).map(sourceType).slice(0, 8);
    return ResearchWebOutputSchema.parse({
      ...mapped,
      data: {
        ...mapped.data,
        source_strategy: sourceStrategy,
        coverage_gaps: coverageGaps,
        query_coverage: coverage,
      },
    });
  }

  async openWebPages(options: {
    urls: string[];
    maxCharsPerUrl: number;
    maxTotalChars: number;
  }): Promise<OpenWebPageOutput> {
    this.assertSearchConfigured();
    const payload = await this.http.postJson(
      "search gateway",
      this.config.searchGatewayUrl,
      "/open",
      {
        urls: options.urls,
        max_chars_per_url: options.maxCharsPerUrl,
        max_total_chars: options.maxTotalChars,
      },
      { bearerToken: this.config.searchGatewayApiKey, timeoutMs: Math.max(this.config.timeoutMs, 45000) },
    );
    const documents = array(payload.documents).map((raw, index) => {
      const item = object(raw);
      const document = mapExtractedDocument(raw, options.maxCharsPerUrl);
      if (!document) return null;
      return {
        request_id: safeDisplayText(item.requestId ?? item.request_id, 30) || `u${index + 1}`,
        ...document,
      };
    }).filter((item): item is NonNullable<typeof item> => item !== null).slice(0, 3);
    return OpenWebPageOutputSchema.parse({
      ok: booleanValue(payload.ok, documents.some((item) => !item.error)),
      partial: booleanValue(payload.partial),
      generated_at: new Date().toISOString(),
      warnings: array(payload.warnings).map((value) => safeDisplayText(value, 500)).filter(Boolean).slice(0, 10),
      data: {
        count: documents.length,
        readable_count: documents.filter((item) => !item.error).length,
        documents,
      },
    });
  }

  async readSearchResults(options: {
    searchId: string;
    resultIds: string[];
    maxCharsPerResult: number;
    maxTotalChars: number;
  }): Promise<ReadSearchResultOutput> {
    this.assertSearchConfigured();
    const payload = await this.http.postJson(
      "search gateway",
      this.config.searchGatewayUrl,
      "/read",
      {
        search_id: options.searchId,
        result_ids: options.resultIds,
        max_chars_per_result: options.maxCharsPerResult,
        max_total_chars: options.maxTotalChars,
      },
      { bearerToken: this.config.searchGatewayApiKey, timeoutMs: Math.max(this.config.timeoutMs, 45000) },
    );
    const documents = array(payload.documents).map((raw, index) => {
      const item = object(raw);
      const document = mapExtractedDocument(raw, options.maxCharsPerResult);
      if (!document) return null;
      return {
        result_id: safeDisplayText(item.resultId ?? item.result_id, 30) || options.resultIds[index] || `r${index + 1}`,
        ...document,
      };
    }).filter((item): item is NonNullable<typeof item> => item !== null).slice(0, 3);
    return ReadSearchResultOutputSchema.parse({
      ok: booleanValue(payload.ok, documents.some((item) => !item.error)),
      partial: booleanValue(payload.partial),
      generated_at: new Date().toISOString(),
      warnings: array(payload.warnings).map((value) => safeDisplayText(value, 500)).filter(Boolean).slice(0, 10),
      data: {
        search_id: safeDisplayText(payload.searchId ?? payload.search_id, 100) || options.searchId,
        count: documents.length,
        readable_count: documents.filter((item) => !item.error).length,
        documents,
      },
    });
  }

  async findInSearchResult(options: {
    searchId: string;
    resultId: string;
    pattern: string;
    matchMode: "phrase" | "all_terms";
    caseSensitive: boolean;
    maxMatches: number;
    contextChars: number;
  }): Promise<FindSearchResultOutput> {
    this.assertSearchConfigured();
    const payload = await this.http.postJson(
      "search gateway",
      this.config.searchGatewayUrl,
      "/find",
      {
        search_id: options.searchId,
        result_id: options.resultId,
        pattern: options.pattern,
        match_mode: options.matchMode,
        case_sensitive: options.caseSensitive,
        max_matches: options.maxMatches,
        context_chars: options.contextChars,
      },
      { bearerToken: this.config.searchGatewayApiKey, timeoutMs: Math.max(this.config.timeoutMs, 45000) },
    );
    const url = safeExternalUrl(payload.url);
    if (!url) throw new UpstreamRequestError("search gateway", "returned an invalid result URL", 502);
    const finalUrlValue = payload.finalUrl ?? payload.final_url;
    const matches = array(payload.matches).map((raw, index) => {
      const item = object(raw);
      const pageNumber = nullableNumber(item.pageNumber ?? item.page_number);
      return {
        match_index: Math.max(1, Math.trunc(numberValue(item.matchIndex ?? item.match_index, index + 1))),
        start_char: Math.max(0, Math.trunc(numberValue(item.startChar ?? item.start_char))),
        end_char: Math.max(0, Math.trunc(numberValue(item.endChar ?? item.end_char))),
        page_number: pageNumber == null ? null : Math.max(1, Math.trunc(pageNumber)),
        context: safeDisplayText(item.context, Math.min(1800, options.contextChars * 2 + 400)),
      };
    }).filter((item) => item.context).slice(0, options.maxMatches);
    const modeValue = stringValue(payload.matchMode ?? payload.match_mode);
    return FindSearchResultOutputSchema.parse({
      ok: booleanValue(payload.ok),
      partial: booleanValue(payload.partial),
      generated_at: new Date().toISOString(),
      warnings: array(payload.warnings).map((value) => safeDisplayText(value, 500)).filter(Boolean).slice(0, 10),
      data: {
        search_id: safeDisplayText(payload.searchId ?? payload.search_id, 100) || options.searchId,
        result_id: safeDisplayText(payload.resultId ?? payload.result_id, 30) || options.resultId,
        title: safeDisplayText(payload.title, 300),
        url,
        final_url: finalUrlValue ? safeExternalUrl(finalUrlValue) : null,
        domain: safeDisplayText(payload.domain, 253) || new URL(url).hostname,
        document_type: nullableString(safeDisplayText(payload.documentType ?? payload.document_type, 40)),
        page_count: nullableNumber(payload.pageCount ?? payload.page_count) == null ? null : Math.max(0, Math.trunc(numberValue(payload.pageCount ?? payload.page_count))),
        pages_read: nullableNumber(payload.pagesRead ?? payload.pages_read) == null ? null : Math.max(0, Math.trunc(numberValue(payload.pagesRead ?? payload.pages_read))),
        pattern: safeDisplayText(payload.pattern, 200) || options.pattern,
        match_mode: modeValue === "all_terms" ? "all_terms" : "phrase",
        case_sensitive: booleanValue(payload.caseSensitive ?? payload.case_sensitive),
        match_count: matches.length,
        content_truncated: booleanValue(payload.contentTruncated ?? payload.content_truncated),
        matches,
        error: nullableString(payload.error),
      },
    });
  }

  async listJobs(options: {
    engine: EngineSelector;
    status: string;
    jobType: string;
    limit: number;
    offset: number;
  }): Promise<JobsOutput> {
    const targets = selectedManagers(this.config, options.engine);
    const responses = await Promise.all(targets.map(async (target) => ({
      target,
      result: await this.safeGetArray(target.name, target.baseUrl, "/api/jobs?fields=summary"),
    })));
    const warnings: string[] = [];
    const jobs: JobsOutput["data"]["jobs"] = [];
    for (const { target, result } of responses) {
      if (!result.ok) {
        warnings.push(result.error);
        continue;
      }
      for (const raw of result.data) {
        const job = object(raw);
        const status = stringValue(job.status, "unknown").toLowerCase();
        const type = stringValue(job.type, "unknown").toLowerCase();
        if (options.status !== "all" && status !== options.status) continue;
        if (options.jobType !== "all" && type !== options.jobType) continue;
        jobs.push({
          engine: target.id,
          id: safeDisplayText(job.id, 160) || "unknown-job",
          type,
          title: safeDisplayText(job.title, 240) || type,
          status,
          created_at: nullableString(job.createdAt),
          updated_at: nullableString(job.updatedAt),
          finished_at: nullableString(job.finishedAt),
          progress_percent: progressPercent(job.progress),
          error: nullableString(safeDisplayText(job.error, 500)),
        });
      }
    }
    jobs.sort((left, right) => Date.parse(right.updated_at || right.created_at || "") - Date.parse(left.updated_at || left.created_at || ""));
    const page = jobs.slice(options.offset, options.offset + options.limit);
    const nextOffset = options.offset + page.length < jobs.length ? options.offset + page.length : null;
    const successes = responses.filter(({ result }) => result.ok).length;
    return JobsOutputSchema.parse({
      ok: successes > 0,
      partial: warnings.length > 0 && successes > 0,
      generated_at: new Date().toISOString(),
      warnings,
      data: {
        engine_filter: options.engine,
        status_filter: options.status,
        type_filter: options.jobType,
        total: jobs.length,
        count: page.length,
        offset: options.offset,
        has_more: nextOffset !== null,
        next_offset: nextOffset,
        jobs: page,
      },
    });
  }

  async previewRoute(options: {
    model: string;
    engine: "auto" | "vllm" | "llama";
    protocol: "openai" | "claude" | "opencode";
    capability: "text" | "tools" | "vision" | "audio" | "embedding" | "rerank";
  }): Promise<RoutePreviewOutput> {
    const result = await this.safePost("service entry", this.config.serviceEntryUrl, "/api/fleet/route-preview", {
      model: options.model,
      engine: options.engine,
      protocol: options.protocol,
      capability: options.capability,
    });
    const payload = result.ok ? result.data : {};
    const manager = object(payload.manager);
    const instance = object(payload.instance);
    const model = object(payload.model);
    return RoutePreviewOutputSchema.parse({
      ok: result.ok,
      partial: false,
      generated_at: new Date().toISOString(),
      warnings: result.ok ? [] : [result.error],
      data: {
        selected: result.ok && booleanValue(payload.ok, false),
        status: result.ok ? numberValue(payload.status, booleanValue(payload.ok) ? 200 : 503) : 503,
        capability: stringValue(payload.capability, options.capability),
        reason: stringValue(payload.reason),
        error: result.ok ? nullableString(payload.error ?? payload.message) : result.error,
        request: {
          engine: stringValue(object(payload.request).engine, options.engine),
          protocol: stringValue(object(payload.request).protocol, options.protocol),
          requested_model: nullableString(object(payload.request).requestedModel ?? options.model),
        },
        manager: Object.keys(manager).length ? {
          id: stringValue(manager.id),
          name: stringValue(manager.name, stringValue(manager.id)),
        } : null,
        instance: Object.keys(instance).length ? {
          id: stringValue(instance.instanceId ?? instance.id, "primary"),
          status: stringValue(instance.status),
          port: nullableNumber(instance.port),
        } : null,
        model: Object.keys(model).length ? {
          id: stringValue(model.id),
          capabilities: array(model.capabilities).map((value) => stringValue(value)).filter(Boolean).slice(0, 20),
        } : null,
      },
    });
  }

  async estimateMemory(options: {
    engine: "vllm" | "llama";
    paramsB: number;
    contextTokens: number;
    precision: "fp32" | "fp16_bf16" | "fp8_int8" | "int4_nvfp4" | "custom";
    bytesPerParam: number | null;
    parallelSequences: number;
    gpuMemoryUtilization: number;
    cpuOffloadGb: number;
    kvOffloadGb: number;
    speculativeMode: "off" | "mtp" | "draft";
    speculativeTokens: number;
  }): Promise<MemoryEstimateOutput> {
    const fleetResult = await this.safeGet("service fleet", this.config.serviceEntryUrl, "/api/fleet");
    if (!fleetResult.ok) throw new Error(fleetResult.error);
    const gpu = mapGpu(fleetResult.data.gpuMemory);
    const selectedGpus = gpu.devices.map((device) => ({
      id: device.id,
      name: device.name,
      totalMb: device.total_mb,
      usedMb: device.used_mb,
      freeMb: device.free_mb,
    }));
    const bytesPerParam = bytesForPrecision(options.precision, options.bytesPerParam);
    const manager = this.config.managers.find((target) => target.id === options.engine);
    if (!manager) throw new Error(`No ${options.engine} manager is configured.`);
    const body: JsonObject = {
      paramsB: options.paramsB,
      contextTokens: options.engine === "vllm"
        ? options.contextTokens * options.parallelSequences
        : options.contextTokens,
      bytesPerParam,
      selectedGpus,
      gpuMemoryUtilization: options.gpuMemoryUtilization,
      cpuOffloadGb: options.cpuOffloadGb,
      kvOffloadGb: options.kvOffloadGb,
      maxNumSeqs: options.parallelSequences,
      multiGpuMode: selectedGpus.length > 1 ? "tensor" : "single",
      tensorParallelSize: Math.max(1, selectedGpus.length),
      speculativeMode: options.speculativeMode,
      numSpeculativeTokens: options.speculativeTokens,
    };
    const estimate = await this.safePost(manager.name, manager.baseUrl, "/api/memory-estimate", body);
    if (!estimate.ok) throw new Error(estimate.error);
    const plan = object(estimate.data.plan);
    const recommendations = object(estimate.data.recommendations);
    const rawStatus = stringValue(recommendations.status ?? plan.status, "warn").toLowerCase();
    const status: "ok" | "warn" | "fail" = rawStatus === "ok" ? "ok" : rawStatus === "fail" ? "fail" : "warn";
    const suggestionList = array(recommendations.suggestions)
      .map((value) => safeDisplayText(value, 600)).filter(Boolean).slice(0, 12);
    return MemoryEstimateOutputSchema.parse({
      ok: true,
      partial: false,
      generated_at: new Date().toISOString(),
      warnings: [],
      data: {
        engine: options.engine,
        status,
        summary: safeDisplayText(recommendations.summary, 300) || status,
        gpu_count: gpu.devices.length,
        total_gpu_gb: round(gpu.devices.reduce((sum, device) => sum + device.total_mb, 0) / 1024) ?? 0,
        free_gpu_gb: round(gpu.devices.reduce((sum, device) => sum + device.free_mb, 0) / 1024) ?? 0,
        params_b: options.paramsB,
        context_tokens: options.contextTokens,
        precision: options.precision,
        bytes_per_param: bytesPerParam,
        weights_gb: round(plan.weightsGb),
        kv_cache_gb: round(plan.kvGb),
        overhead_per_gpu_gb: round(plan.overheadPerGpuGb),
        peak_per_gpu_gb: round(plan.perGpuGb ?? plan.peakGpuGb),
        overflow_per_gpu_gb: round(recommendations.overflowPerGpuGb ?? plan.overflowPerGpuGb),
        recommended_cpu_offload_gb: round(recommendations.cpuOffloadGb ?? plan.recommendedCpuOffloadGb),
        recommended_kv_offload_gb: round(recommendations.kvOffloadingSize ?? plan.recommendedKvOffloadGb),
        recommendations: suggestionList,
        assumptions: [
          `Weights use ${bytesPerParam} bytes per parameter (${options.precision}).`,
          `Context is ${options.contextTokens} tokens across ${options.parallelSequences} sequence slot(s).`,
          "Current manager-reported GPU free memory is used; the result is a planning estimate, not a launch guarantee.",
        ],
      },
    });
  }

  async getSecurityPosture(options: { engine: EngineSelector; warningsOnly: boolean }): Promise<SecurityPostureOutput> {
    const targets = selectedManagers(this.config, options.engine);
    const [entryResult, searchResult, managerResults] = await Promise.all([
      this.safeGet("service entry security", this.config.serviceEntryUrl, "/api/security"),
      this.safeGet("search gateway", this.config.searchGatewayUrl, "/health"),
      Promise.all(targets.map(async (target) => ({
        target,
        result: await this.safeGet(target.name, target.baseUrl, "/api/service-exposure"),
      }))),
    ]);
    const warnings: string[] = [];
    const findings: SecurityPostureOutput["data"]["findings"] = [];
    const entry = object(entryResult.ok ? entryResult.data.security : {});
    const keyStore = object(entry.keyStore);
    if (!entryResult.ok) warnings.push(entryResult.error);
    if (!searchResult.ok) warnings.push(searchResult.error);
    if (entryResult.ok) {
      for (const issue of array(entry.configIssues).slice(0, 20)) {
        findings.push({ scope: "service-entry", status: "fail", title: safeFindingTitle(issue) });
      }
      for (const warning of array(entry.warnings).slice(0, 20)) {
        findings.push({ scope: "service-entry", status: "warn", title: safeFindingTitle(warning, "Security warning") });
      }
      if (booleanValue(entry.lanMode) && !booleanValue(entry.apiKeyEnforced)) {
        findings.push({ scope: "service-entry", status: "fail", title: "LAN mode is active without enforced API-key authentication." });
      }
      if (booleanValue(entry.allowLanAdmin)) {
        findings.push({ scope: "service-entry", status: "warn", title: "LAN management access is enabled." });
      }
      if (!booleanValue(keyStore.readable, false)) {
        findings.push({ scope: "service-entry", status: "fail", title: "The runtime API-key store is not readable." });
      }
    } else {
      findings.push({ scope: "service-entry", status: "fail", title: "Security status is unavailable." });
    }

    const managers: SecurityPostureOutput["data"]["managers"] = [];
    for (const { target, result } of managerResults) {
      if (!result.ok) {
        warnings.push(result.error);
        findings.push({ scope: target.id, status: "fail", title: `${target.name} exposure status is unavailable.` });
        managers.push({
          engine: target.id,
          config_ok: false,
          enabled: false,
          exposure_mode: "unknown",
          require_api_key: false,
          runtime_running: false,
          remote_management_allowed: false,
          service_scope: "unknown",
          direct_runtime_exposed: false,
          rate_limit_rpm: null,
          max_concurrent_requests: null,
          issues: [{ scope: target.id, status: "fail", title: "Exposure status is unavailable." }],
        });
        continue;
      }
      const settings = object(result.data.settings);
      const configHealth = object(result.data.configHealth);
      const actual = object(result.data.actual);
      const actualManager = object(actual.manager);
      const service = object(actual.service);
      const scope = hostScope(service.boundHost, service.dockerPublishedHosts);
      const directRuntimeExposed = scope === "lan" && !booleanValue(service.runtimeApiKeyRequired);
      const securityChecks = array(result.data.checks).map((raw) => {
        const check = object(raw);
        return {
          scope: target.id,
          status: findingStatus(check.status),
          title: safeDisplayText(check.title, 300),
        };
      }).filter((finding) => /api|key|cors|公网|局域网|远程|直连|网关|管理|https|鉴权|限流|access|exposure|remote|direct|security/i.test(finding.title)).slice(0, 50);
      const issues = securityChecks.filter((finding) => finding.status !== "ok");
      findings.push(...(options.warningsOnly ? issues : securityChecks));
      if (directRuntimeExposed && !issues.some((finding) => /直连|direct/i.test(finding.title))) {
        const finding = { scope: target.id, status: "warn" as const, title: "A LAN-published runtime port bypasses the authenticated manager gateway." };
        issues.push(finding);
        findings.push(finding);
      }
      managers.push({
        engine: target.id,
        config_ok: booleanValue(configHealth.ok, false),
        enabled: booleanValue(settings.enabled),
        exposure_mode: stringValue(settings.exposureMode, "unknown"),
        require_api_key: booleanValue(settings.requireApiKey),
        runtime_running: booleanValue(service.running),
        remote_management_allowed: booleanValue(actualManager.remoteManagementAllowed),
        service_scope: scope,
        direct_runtime_exposed: directRuntimeExposed,
        rate_limit_rpm: nullableNumber(settings.rateLimitRpm),
        max_concurrent_requests: nullableNumber(settings.maxConcurrentRequests),
        issues,
      });
    }

    const search = mapSearch(searchResult.ok ? searchResult.data : {}, searchResult.ok ? null : searchResult.error);
    if (!search.online || !search.healthy) findings.push({ scope: "search", status: "fail", title: "Search gateway health check failed." });
    else if (search.auth_required !== true) findings.push({ scope: "search", status: "warn", title: "Search gateway does not report required authentication." });
    const filteredFindings = options.warningsOnly ? findings.filter((finding) => finding.status !== "ok") : findings;
    const overall = filteredFindings.some((finding) => finding.status === "fail")
      ? "fail"
      : filteredFindings.some((finding) => finding.status === "warn") ? "warn" : "secure";
    const visibleFindings = filteredFindings.slice(0, 100);
    const successfulManagers = managerResults.filter(({ result }) => result.ok).length;
    return SecurityPostureOutputSchema.parse({
      ok: entryResult.ok && successfulManagers > 0,
      partial: warnings.length > 0 && (entryResult.ok || successfulManagers > 0),
      generated_at: new Date().toISOString(),
      warnings,
      data: {
        overall,
        entry: {
          lan_mode: booleanValue(entry.lanMode),
          api_key_enforced: booleanValue(entry.apiKeyEnforced),
          allow_lan_admin: booleanValue(entry.allowLanAdmin),
          cors_mode: stringValue(entry.corsMode, "unknown"),
          trust_token_active: booleanValue(entry.trustTokenActive),
          key_store_readable: booleanValue(keyStore.readable),
        },
        mcp: { loopback_only: true, auth_required: this.config.requireAuth, read_only: true },
        search,
        managers,
        findings: visibleFindings,
      },
    });
  }
}
