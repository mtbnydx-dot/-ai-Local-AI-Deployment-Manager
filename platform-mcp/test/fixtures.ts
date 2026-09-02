import type { PlatformDataSource } from "../src/platform-client.js";
import type {
  DiagnosticsOutput,
  EngineSelector,
  GpuStatusOutput,
  JobsOutput,
  LocalModelsOutput,
  MemoryEstimateOutput,
  OverviewOutput,
  PerformanceOutput,
  RoutePreviewOutput,
  RunningModelsOutput,
  SecurityPostureOutput,
  SearchHealthOutput,
  FindSearchResultOutput,
  OpenWebPageOutput,
  ReadSearchResultOutput,
  ResearchWebOutput,
  WebSearchOutput,
} from "../src/schemas.js";

export const FIXED_AT = "2026-08-15T00:00:00.000Z";

export const fixtureGpu = {
  total_mb: 98304,
  used_mb: 65536,
  free_mb: 32768,
  allocatable_mb: 24576,
  reserve_mb: 8192,
  warning_threshold_percent: 90,
  utilization_percent: 66.67,
  devices: [{
    id: "0",
    name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
    total_mb: 98304,
    used_mb: 65536,
    free_mb: 32768,
    allocatable_mb: 24576,
    utilization_percent: 66.67,
  }],
};

const runningInstances: RunningModelsOutput["data"]["instances"] = [{
  engine: "vllm",
  instance_id: "primary",
  container_name: "vllm-local",
  lifecycle_state: "ready",
  running: true,
  status: "healthy",
  port: 8000,
  models: [{
    id: "qwen-qwen3.8-27b-fp8",
    engine: "vllm",
    instance_id: "primary",
    container_name: "vllm-local",
    lifecycle_state: "ready",
    status: "healthy",
    max_model_len: 262144,
    capabilities: ["text", "tools"],
  }],
}, {
  engine: "llama",
  instance_id: "primary",
  container_name: "llama-local",
  lifecycle_state: "stopped",
  running: false,
  status: "not running",
  port: 8001,
  models: [],
}];

const inventory: LocalModelsOutput["data"]["models"] = [{
  engine: "vllm",
  inventory: "local",
  id: "Qwen-Qwen3.8-27B-FP8",
  label: "Qwen 3.8 27B FP8",
  size_bytes: 30890059808,
  modified_at: "2026-08-14T15:05:02.540Z",
  format: "safetensors",
  runnable: true,
  verification_status: "ok",
  issues: [],
}, {
  engine: "vllm",
  inventory: "local",
  id: "RadixArk-Qwen3.8-27B-DSpark",
  label: "Qwen 3.8 27B DSpark",
  size_bytes: 2718610283,
  modified_at: "2026-08-14T16:30:29.654Z",
  format: "safetensors",
  runnable: true,
  verification_status: "warn",
  issues: ["Missing tokenizer"],
}, {
  engine: "vllm",
  inventory: "cached",
  id: "Qwen-Qwen3.8-27B",
  label: "Qwen/Qwen3.8-27B cache",
  size_bytes: 55600000000,
  modified_at: "2026-08-13T12:00:00.000Z",
  format: null,
  runnable: null,
  verification_status: null,
  issues: [],
}, {
  engine: "llama",
  inventory: "local",
  id: "Muse-Glimmer-30B-GGUF",
  label: "Muse Glimmer 30B GGUF",
  size_bytes: 19653957984,
  modified_at: "2026-08-10T11:33:46.339Z",
  format: "gguf",
  runnable: true,
  verification_status: "ok",
  issues: [],
}, {
  engine: "llama",
  inventory: "cached",
  id: "DeepSeek-V4-Flash-GGUF",
  label: "DeepSeek V4 Flash GGUF cache",
  size_bytes: 22000000000,
  modified_at: "2026-08-09T08:00:00.000Z",
  format: null,
  runnable: null,
  verification_status: null,
  issues: [],
}];

export class FixturePlatformDataSource implements PlatformDataSource {
  async getOverview(): Promise<OverviewOutput> {
    return {
      ok: true,
      partial: false,
      generated_at: FIXED_AT,
      warnings: [],
      data: {
        service_entry: { online: true, uptime_seconds: 3600, bind_host: "127.0.0.1", port: 5176 },
        managers: [{
          id: "vllm",
          name: "vLLM Manager",
          online: true,
          healthy: true,
          runtime_running: true,
          model_count: 1,
          error: null,
        }, {
          id: "llama",
          name: "llama.cpp Manager",
          online: true,
          healthy: true,
          runtime_running: false,
          model_count: 0,
          error: null,
        }],
        running_model_count: 1,
        gpu: fixtureGpu,
        gateway_base: "http://127.0.0.1:5176/gateway/auto/openai/v1",
        search: { online: true, healthy: true, mode: "hybrid", auth_required: true, max_results: 10, error: null },
      },
    };
  }

  async listRunningModels(engine: EngineSelector): Promise<RunningModelsOutput> {
    const instances = runningInstances.filter((instance) => engine === "all" || instance.engine === engine);
    return {
      ok: true,
      partial: false,
      generated_at: FIXED_AT,
      warnings: [],
      data: {
        engine_filter: engine,
        total_models: instances.reduce((total, instance) => total + instance.models.length, 0),
        instances,
      },
    };
  }

  async getGpuStatus(): Promise<GpuStatusOutput> {
    return { ok: true, partial: false, generated_at: FIXED_AT, warnings: [], data: { gpu: fixtureGpu } };
  }

  async listLocalModels(options: {
    engine: EngineSelector;
    inventory: "local" | "cached" | "all";
    limit: number;
    offset: number;
  }): Promise<LocalModelsOutput> {
    const filtered = inventory.filter((model) => (
      (options.engine === "all" || model.engine === options.engine)
      && (options.inventory === "all" || model.inventory === options.inventory)
    ));
    const page = filtered.slice(options.offset, options.offset + options.limit);
    const nextOffset = options.offset + page.length < filtered.length ? options.offset + page.length : null;
    return {
      ok: true,
      partial: false,
      generated_at: FIXED_AT,
      warnings: [],
      data: {
        engine_filter: options.engine,
        inventory_filter: options.inventory,
        total: filtered.length,
        count: page.length,
        offset: options.offset,
        has_more: nextOffset !== null,
        next_offset: nextOffset,
        models: page,
      },
    };
  }

  async getPerformance(options: { engine: EngineSelector; includeModels: boolean }): Promise<PerformanceOutput> {
    const allManagers: PerformanceOutput["data"]["managers"] = [{
      engine: "vllm",
      available: true,
      updated_at: FIXED_AT,
      requests: { total: 42, success: 40, error: 2, aborted: 0 },
      tokens: { prompt: 12000, generation: 6000, cachedPrompt: 3000, total: 18000 },
      speed: { recentOutputTokensPerSecond: 72.5, recentPromptTokensPerSecond: 310.25 },
      latency: { avgTtftSeconds: 0.22, avgE2eSeconds: 8.4 },
      cache: { prefixQueries: 20, prefixHits: 10, prefixHitRate: 0.5 },
      speculative: { enabled: false, acceptanceRate: 0 },
      context: { activeTokens: 4096, capacityTokens: 262144, kvUsagePercent: 1.56 },
      facts: { maxModelLen: 262144, modelLoadSeconds: 48.2 },
      models: options.includeModels ? [{
        name: "qwen-qwen3.8-27b-fp8",
        requests: { total: 42 },
        tokens: { total: 18000 },
        speed: { recentOutputTokensPerSecond: 72.5 },
        latency: { avgTtftSeconds: 0.22 },
        cache: { prefixHitRate: 0.5 },
        speculative: { enabled: false },
        context: { maxModelLen: 262144 },
      }] : [],
      error: null,
    }, {
      engine: "llama",
      available: true,
      updated_at: FIXED_AT,
      requests: { total: 8, success: 8, error: 0, aborted: 0 },
      tokens: { prompt: 2000, generation: 1000, cachedPrompt: 0, total: 3000 },
      speed: { recentOutputTokensPerSecond: 25 },
      latency: { avgTtftSeconds: 0.65 },
      cache: { prefixHitRate: 0 },
      speculative: {},
      context: { activeTokens: 0, capacityTokens: 131072, kvUsagePercent: 0 },
      facts: {},
      models: [],
      error: null,
    }];
    const managers = allManagers.filter((manager) => options.engine === "all" || manager.engine === options.engine);
    return {
      ok: true,
      partial: false,
      generated_at: FIXED_AT,
      warnings: [],
      data: { engine_filter: options.engine, managers },
    };
  }

  async getDiagnostics(options: {
    engine: EngineSelector;
    warningsOnly: boolean;
    includeRecentLogs: boolean;
    logLines: number;
  }): Promise<DiagnosticsOutput> {
    const allManagers: DiagnosticsOutput["data"]["managers"] = [{
      engine: "vllm",
      available: true,
      score: 95,
      stage: "ready",
      checks: [{ id: "docker", label: "Docker", status: "ok", message: "ready" }],
      issues: [],
      suggestions: [],
      recent_logs: options.includeRecentLogs ? ["runtime ready"].slice(-options.logLines) : [],
      error: null,
    }, {
      engine: "llama",
      available: true,
      score: 80,
      stage: "stopped",
      checks: [{ id: "container", label: "llama container", status: "warn", message: "not running" }],
      issues: ["No active llama.cpp container"],
      suggestions: ["Start a model only when llama.cpp inference is needed."],
      recent_logs: options.includeRecentLogs ? ["container absent"].slice(-options.logLines) : [],
      error: null,
    }];
    const managers = allManagers.filter((manager) => options.engine === "all" || manager.engine === options.engine)
      .map((manager) => options.warningsOnly
        ? { ...manager, checks: manager.checks.filter((check) => check.status !== "ok") }
        : manager);
    return {
      ok: true,
      partial: false,
      generated_at: FIXED_AT,
      warnings: [],
      data: { engine_filter: options.engine, managers },
    };
  }

  async getSearchHealth(): Promise<SearchHealthOutput> {
    return {
      ok: true,
      partial: false,
      generated_at: FIXED_AT,
      warnings: [],
      data: { search: { online: true, healthy: true, mode: "hybrid", auth_required: true, max_results: 10, error: null } },
    };
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
    const results = [{
      result_id: "r1",
      title: "MCP TypeScript SDK v2",
      url: "https://github.com/modelcontextprotocol/typescript-sdk",
      domain: "github.com",
      content: "The stable v2 SDK implements the 2026-07-28 MCP specification.",
      engine: "github",
      engines: ["github"],
      score: 1,
      relevance: 0.98,
      low_relevance: false,
      category: "it",
      published_at: "2026-07-28",
      matched_queries: [],
      source_type: "documentation" as const,
      source_type_reason: "documentation_or_repository",
      primary_source_likelihood: "high" as const,
    }].slice(0, options.maxResults);
    return {
      ok: true,
      partial: false,
      generated_at: FIXED_AT,
      warnings: [],
      data: {
        search_id: "11111111-1111-4111-8111-111111111111",
        expires_in_seconds: 900,
        query: options.query,
        searched_at: FIXED_AT,
        count: results.length,
        total_candidates: results.length,
        unique_candidates: results.length,
        quality: "good",
        available: true,
        cache_hit: false,
        coalesced: false,
        fallback_used: false,
        fallback_reason: null,
        answers: [],
        corrections: [],
        suggestions: [],
        source_domains: ["github.com"],
        source_type_coverage: { documentation: results.length },
        engine_status: {
          requested: ["github"], attempted: ["github"], used: ["github"],
          distribution: { github: results.length }, unresponsive: [], cooled_down: [],
        },
        results,
      },
    };
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
    const base = await this.searchWeb({
      query: options.queries.map((item) => item.query).join(" | "),
      maxResults: options.maxSources,
      language: options.language,
      timeRange: options.timeRange,
      engines: options.engines,
      categories: options.categories,
      safesearch: options.safesearch,
      preferredDomains: options.preferredDomains,
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
      maxPerDomain: options.maxPerDomain,
      preferredSourceTypes: options.preferredSourceTypes,
    });
    return {
      ...base,
      data: {
        ...base.data,
        search_id: "22222222-2222-4222-8222-222222222222",
        source_strategy: options.sourceStrategy,
        coverage_gaps: [],
        query_coverage: options.queries.map((item, index) => ({
          id: item.id || `q${index + 1}`,
          query: item.query,
          count: base.data.count,
          quality: "good" as const,
          cache_hit: false,
          error: null,
        })),
        results: base.data.results.map((result) => ({
          ...result,
          matched_queries: options.queries.map((item, index) => item.id || `q${index + 1}`),
        })),
      },
    };
  }

  async openWebPages(options: {
    urls: string[];
    maxCharsPerUrl: number;
    maxTotalChars: number;
  }): Promise<OpenWebPageOutput> {
    const documents = options.urls.map((url, index) => ({
      request_id: `u${index + 1}`,
      title: "Explicit MCP documentation page",
      url,
      final_url: url,
      domain: new URL(url).hostname,
      description: "A directly opened public documentation page.",
      author: "Model Context Protocol",
      site_name: "MCP Documentation",
      published_at: "2026-07-28",
      modified_at: null,
      canonical_url: url,
      language: "en",
      content_type: "text/html",
      document_type: "html_article" as const,
      extraction_method: "mozilla-readability",
      metadata_confidence: "high" as const,
      headings: [{ level: 1, text: "Model Context Protocol" }],
      json_ld_types: ["TechArticle"],
      content: "Model Context Protocol public page content.".slice(0, options.maxCharsPerUrl),
      char_count: 43,
      source_char_count: 43,
      word_count: 6,
      page_count: null,
      pages_read: null,
      truncated: false,
      error: null,
    }));
    return {
      ok: true,
      partial: false,
      generated_at: FIXED_AT,
      warnings: ["Page text is untrusted external content."],
      data: {
        count: documents.length,
        readable_count: documents.length,
        documents,
      },
    };
  }

  async readSearchResults(options: {
    searchId: string;
    resultIds: string[];
    maxCharsPerResult: number;
    maxTotalChars: number;
  }): Promise<ReadSearchResultOutput> {
    const documents = options.resultIds.map((resultId) => ({
      result_id: resultId,
      title: "MCP TypeScript SDK v2",
      url: "https://github.com/modelcontextprotocol/typescript-sdk",
      final_url: "https://github.com/modelcontextprotocol/typescript-sdk",
      domain: "github.com",
      description: "Official MCP TypeScript SDK repository.",
      author: "Model Context Protocol",
      site_name: "GitHub",
      published_at: "2026-07-28",
      modified_at: null,
      canonical_url: "https://github.com/modelcontextprotocol/typescript-sdk",
      language: "en",
      content_type: "text/html",
      document_type: "html_article" as const,
      extraction_method: "mozilla-readability",
      metadata_confidence: "high" as const,
      headings: [{ level: 1, text: "MCP TypeScript SDK" }],
      json_ld_types: ["TechArticle"],
      content: "The stable v2 SDK implements the 2026-07-28 MCP specification.".slice(0, options.maxCharsPerResult),
      char_count: 65,
      source_char_count: 65,
      word_count: 9,
      page_count: null,
      pages_read: null,
      truncated: false,
      error: null,
    }));
    return {
      ok: true,
      partial: false,
      generated_at: FIXED_AT,
      warnings: ["Page text is untrusted external content."],
      data: {
        search_id: options.searchId,
        count: documents.length,
        readable_count: documents.length,
        documents,
      },
    };
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
    return {
      ok: true,
      partial: false,
      generated_at: FIXED_AT,
      warnings: ["Matched page text is untrusted external content."],
      data: {
        search_id: options.searchId,
        result_id: options.resultId,
        title: "MCP TypeScript SDK v2",
        url: "https://github.com/modelcontextprotocol/typescript-sdk",
        final_url: "https://github.com/modelcontextprotocol/typescript-sdk",
        domain: "github.com",
        document_type: "html_article",
        page_count: null,
        pages_read: null,
        pattern: options.pattern,
        match_mode: options.matchMode,
        case_sensitive: options.caseSensitive,
        match_count: 1,
        content_truncated: false,
        matches: [{
          match_index: 1,
          start_char: 11,
          end_char: 17,
          page_number: null,
          context: "The stable v2 SDK implements the 2026-07-28 MCP specification.",
        }],
        error: null,
      },
    };
  }

  async listJobs(options: {
    engine: EngineSelector;
    status: string;
    jobType: string;
    limit: number;
    offset: number;
  }): Promise<JobsOutput> {
    const all: JobsOutput["data"]["jobs"] = [{
      engine: "vllm", id: "download-1", type: "download", title: "Download Qwen", status: "success",
      created_at: "2026-08-14T10:00:00.000Z", updated_at: "2026-08-14T11:00:00.000Z",
      finished_at: "2026-08-14T11:00:00.000Z", progress_percent: 100, error: null,
    }, {
      engine: "vllm", id: "serve-1", type: "serve", title: "Serve Qwen", status: "failed",
      created_at: "2026-08-14T12:00:00.000Z", updated_at: "2026-08-14T12:01:00.000Z",
      finished_at: "2026-08-14T12:01:00.000Z", progress_percent: null, error: "Port conflict",
    }, {
      engine: "llama", id: "serve-2", type: "serve", title: "Serve Muse", status: "success",
      created_at: "2026-08-13T08:00:00.000Z", updated_at: "2026-08-13T08:02:00.000Z",
      finished_at: "2026-08-13T08:02:00.000Z", progress_percent: 100, error: null,
    }];
    const filtered = all.filter((job) => (
      (options.engine === "all" || job.engine === options.engine)
      && (options.status === "all" || job.status === options.status)
      && (options.jobType === "all" || job.type === options.jobType)
    ));
    const page = filtered.slice(options.offset, options.offset + options.limit);
    const nextOffset = options.offset + page.length < filtered.length ? options.offset + page.length : null;
    return {
      ok: true, partial: false, generated_at: FIXED_AT, warnings: [],
      data: {
        engine_filter: options.engine, status_filter: options.status, type_filter: options.jobType,
        total: filtered.length, count: page.length, offset: options.offset,
        has_more: nextOffset !== null, next_offset: nextOffset, jobs: page,
      },
    };
  }

  async previewRoute(options: {
    model: string;
    engine: "auto" | "vllm" | "llama";
    protocol: "openai" | "claude" | "opencode";
    capability: "text" | "tools" | "vision" | "audio" | "embedding" | "rerank";
  }): Promise<RoutePreviewOutput> {
    return {
      ok: true, partial: false, generated_at: FIXED_AT, warnings: [],
      data: {
        selected: true, status: 200, capability: options.capability, reason: "explicit_model", error: null,
        request: { engine: options.engine, protocol: options.protocol, requested_model: options.model || null },
        manager: { id: "vllm", name: "vLLM Manager" },
        instance: { id: "primary", status: "healthy", port: 8000 },
        model: { id: options.model || "qwen-qwen3.8-27b-fp8", capabilities: ["text", "tools"] },
      },
    };
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
    const bytes = options.precision === "custom" ? options.bytesPerParam || 1 : {
      fp32: 4, fp16_bf16: 2, fp8_int8: 1, int4_nvfp4: 0.5,
    }[options.precision];
    return {
      ok: true, partial: false, generated_at: FIXED_AT, warnings: [],
      data: {
        engine: options.engine, status: "ok", summary: "预计可运行", gpu_count: 1,
        total_gpu_gb: 96, free_gpu_gb: 32, params_b: options.paramsB,
        context_tokens: options.contextTokens, precision: options.precision, bytes_per_param: bytes,
        weights_gb: 25.15, kv_cache_gb: 8, overhead_per_gpu_gb: 3, peak_per_gpu_gb: 36.15,
        overflow_per_gpu_gb: 0, recommended_cpu_offload_gb: 0, recommended_kv_offload_gb: 0,
        recommendations: ["当前配置预计可运行，并保留了基本运行时余量。"],
        assumptions: [`Weights use ${bytes} bytes per parameter (${options.precision}).`],
      },
    };
  }

  async getSecurityPosture(options: { engine: EngineSelector; warningsOnly: boolean }): Promise<SecurityPostureOutput> {
    const finding = { scope: "vllm", status: "warn" as const, title: "A LAN-published runtime port bypasses the authenticated manager gateway." };
    const allManagers: SecurityPostureOutput["data"]["managers"] = [{
      engine: "vllm", config_ok: true, enabled: true, exposure_mode: "reverse-proxy",
      require_api_key: true, runtime_running: true, remote_management_allowed: false,
      service_scope: "lan", direct_runtime_exposed: true, rate_limit_rpm: 30,
      max_concurrent_requests: 2, issues: [finding],
    }, {
      engine: "llama", config_ok: true, enabled: true, exposure_mode: "reverse-proxy",
      require_api_key: true, runtime_running: false, remote_management_allowed: false,
      service_scope: "loopback", direct_runtime_exposed: false, rate_limit_rpm: 30,
      max_concurrent_requests: 2, issues: [],
    }];
    return {
      ok: true, partial: false, generated_at: FIXED_AT, warnings: [],
      data: {
        overall: "warn",
        entry: { lan_mode: false, api_key_enforced: false, allow_lan_admin: false, cors_mode: "deny", trust_token_active: true, key_store_readable: true },
        mcp: { loopback_only: true, auth_required: true, read_only: true },
        search: { online: true, healthy: true, mode: "hybrid", auth_required: true, max_results: 10, error: null },
        managers: allManagers.filter((manager) => options.engine === "all" || manager.engine === options.engine),
        findings: options.engine === "all" || options.engine === "vllm" ? [finding] : [],
      },
    };
  }
}
