import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import type { AuditLogger } from "./audit.js";
import { audited, auditRejected } from "./audit.js";
import { formatToolPayload } from "./format.js";
import type { PlatformDataSource } from "./platform-client.js";
import { cleanText } from "./redaction.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import {
  DiagnosticsInputSchema,
  DiagnosticsOutputSchema,
  GpuStatusInputSchema,
  GpuStatusOutputSchema,
  LocalModelsInputSchema,
  LocalModelsOutputSchema,
  JobsInputSchema,
  JobsOutputSchema,
  MemoryEstimateInputSchema,
  MemoryEstimateOutputSchema,
  OverviewInputSchema,
  OverviewOutputSchema,
  PerformanceInputSchema,
  PerformanceOutputSchema,
  RoutePreviewInputSchema,
  RoutePreviewOutputSchema,
  RunningModelsInputSchema,
  RunningModelsOutputSchema,
  SecurityPostureInputSchema,
  SecurityPostureOutputSchema,
  SearchHealthInputSchema,
  SearchHealthOutputSchema,
  WebSearchInputSchema,
  WebSearchOutputSchema,
  type ResponseFormat,
} from "./schemas.js";

export type PlatformMcpServerDependencies = {
  dataSource: PlatformDataSource;
  auditLogger: AuditLogger;
  maxResponseChars: number;
  defaultClientId?: string;
  searchRateLimiter?: SearchRateLimiter;
};

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const READ_ONLY_OPEN_WORLD_ANNOTATIONS = {
  ...READ_ONLY_ANNOTATIONS,
  openWorldHint: true,
} as const;

export class SearchRateLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();
  private globalBucket: { startedAt: number; count: number } | null = null;

  constructor(private readonly limitPerMinute: number) {}

  consume(id: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
    if (!this.globalBucket || now - this.globalBucket.startedAt >= 60_000) {
      this.globalBucket = { startedAt: now, count: 0 };
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.startedAt >= 60_000) this.buckets.delete(key);
      }
    }
    const globalLimit = this.limitPerMinute * 4;
    if (this.globalBucket.count >= globalLimit) {
      return { ok: false, retryAfterSeconds: this.retryAfter(this.globalBucket.startedAt, now) };
    }

    const existing = this.buckets.get(id);
    if (!existing || now - existing.startedAt >= 60_000) {
      this.buckets.set(id, { startedAt: now, count: 1 });
      this.globalBucket.count += 1;
      return { ok: true };
    }
    if (existing.count >= this.limitPerMinute) {
      return { ok: false, retryAfterSeconds: this.retryAfter(existing.startedAt, now) };
    }
    existing.count += 1;
    this.globalBucket.count += 1;
    return { ok: true };
  }

  private retryAfter(startedAt: number, now: number): number {
    return Math.max(1, Math.ceil((60_000 - (now - startedAt)) / 1000));
  }
}

function clientId(ctx: ServerContext, fallback: string): string {
  const value = ctx.http?.authInfo?.clientId || ctx.sessionId || fallback;
  return cleanText(value, 120).replace(/[^A-Za-z0-9_.:@/-]/g, "_") || fallback;
}

function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error ? cleanText(error.message, 800) : "The platform request failed.";
  return {
    isError: true,
    content: [{
      type: "text",
      text: `The read-only platform query failed: ${message} Check that the relevant local manager is running, then retry.`,
    }],
  };
}

async function execute<T extends Record<string, unknown>>(
  dependencies: PlatformMcpServerDependencies,
  toolName: string,
  title: string,
  responseFormat: ResponseFormat,
  ctx: ServerContext,
  operation: () => Promise<T>,
): Promise<CallToolResult> {
  try {
    const output = await audited(
      dependencies.auditLogger,
      toolName,
      clientId(ctx, dependencies.defaultClientId || "local-mcp-client"),
      operation,
    );
    return {
      content: [{
        type: "text",
        text: formatToolPayload(title, output, responseFormat, dependencies.maxResponseChars),
      }],
      structuredContent: output,
    };
  } catch (error) {
    return toolError(error);
  }
}

export function createPlatformMcpServer(dependencies: PlatformMcpServerDependencies): McpServer {
  const searchRateLimiter = dependencies.searchRateLimiter ?? new SearchRateLimiter(20);
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    title: "Local AI Platform (read-only)",
    description: "Safe local AI operations, planning, diagnostics, and rate-limited web search without lifecycle mutations.",
  });

  server.registerTool(
    "local_ai_get_overview",
    {
      title: "Get Local AI Platform Overview",
      description: "Use this first for a compact, read-only snapshot of the platform entry, manager availability, running-model count, aggregate GPU memory, and search-gateway health. It never starts, stops, downloads, deletes, or reconfigures anything. Use the more specific tools for model lists, metrics, or diagnostic detail.",
      inputSchema: OverviewInputSchema,
      outputSchema: OverviewOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ response_format }, ctx) => execute(
      dependencies,
      "local_ai_get_overview",
      "Local AI Platform Overview",
      response_format,
      ctx,
      () => dependencies.dataSource.getOverview() as Promise<Record<string, unknown>>,
    ),
  );

  server.registerTool(
    "local_ai_list_running_models",
    {
      title: "List Running Local Models",
      description: "List models currently attached to running or known vLLM/llama.cpp instances, including lifecycle state, served port, maximum context length, and advertised capabilities. Use engine='vllm' or engine='llama' to narrow results. This reports runtime state only; it does not list every model stored on disk.",
      inputSchema: RunningModelsInputSchema,
      outputSchema: RunningModelsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ engine, response_format }, ctx) => execute(
      dependencies,
      "local_ai_list_running_models",
      "Running Local Models",
      response_format,
      ctx,
      () => dependencies.dataSource.listRunningModels(engine) as Promise<Record<string, unknown>>,
    ),
  );

  server.registerTool(
    "local_ai_get_gpu_status",
    {
      title: "Get GPU Memory Status",
      description: "Return a read-only GPU memory summary used by the local model fleet: total, used, free, reserved, safely allocatable memory, warning threshold, and per-device values. Memory utilization is derived from used/total memory and is not the instantaneous CUDA compute-utilization percentage.",
      inputSchema: GpuStatusInputSchema,
      outputSchema: GpuStatusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ response_format }, ctx) => execute(
      dependencies,
      "local_ai_get_gpu_status",
      "GPU Memory Status",
      response_format,
      ctx,
      () => dependencies.dataSource.getGpuStatus() as Promise<Record<string, unknown>>,
    ),
  );

  server.registerTool(
    "local_ai_list_local_models",
    {
      title: "List Local Model Inventory",
      description: "Page through the safe model inventory exposed by the vLLM and llama.cpp managers. inventory='local' lists verified local model folders/files; inventory='cached' lists download-cache entries; inventory='all' combines both. Paths and launch commands are deliberately omitted. Use offset plus limit until has_more is false.",
      inputSchema: LocalModelsInputSchema,
      outputSchema: LocalModelsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ engine, inventory, limit, offset, response_format }, ctx) => execute(
      dependencies,
      "local_ai_list_local_models",
      "Local Model Inventory",
      response_format,
      ctx,
      () => dependencies.dataSource.listLocalModels({ engine, inventory, limit, offset }) as Promise<Record<string, unknown>>,
    ),
  );

  server.registerTool(
    "local_ai_get_performance",
    {
      title: "Get Local Inference Performance",
      description: "Return bounded, read-only manager metrics for requests, tokens, throughput, latency, cache behavior, speculative decoding, context use, and startup facts. Set include_models=false for only aggregate manager data. Historical manager counters may include models that are not currently running; pair with local_ai_list_running_models when the distinction matters.",
      inputSchema: PerformanceInputSchema,
      outputSchema: PerformanceOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ engine, include_models, response_format }, ctx) => execute(
      dependencies,
      "local_ai_get_performance",
      "Local Inference Performance",
      response_format,
      ctx,
      () => dependencies.dataSource.getPerformance({ engine, includeModels: include_models }) as Promise<Record<string, unknown>>,
    ),
  );

  server.registerTool(
    "local_ai_get_diagnostics",
    {
      title: "Get Local AI Diagnostics",
      description: "Read health checks and bounded diagnostic summaries from one or both managers. warnings_only=true hides passing checks. Runtime log text is excluded by default; include_recent_logs=true returns at most log_lines redacted lines per manager. The tool cannot repair, restart, or change a service.",
      inputSchema: DiagnosticsInputSchema,
      outputSchema: DiagnosticsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ engine, warnings_only, include_recent_logs, log_lines, response_format }, ctx) => execute(
      dependencies,
      "local_ai_get_diagnostics",
      "Local AI Diagnostics",
      response_format,
      ctx,
      () => dependencies.dataSource.getDiagnostics({
        engine,
        warningsOnly: warnings_only,
        includeRecentLogs: include_recent_logs,
        logLines: log_lines,
      }) as Promise<Record<string, unknown>>,
    ),
  );

  server.registerTool(
    "local_ai_get_search_health",
    {
      title: "Get Search Gateway Health",
      description: "Report whether the existing local search gateway is reachable and healthy, along with its configured search mode, authentication requirement, and maximum result count. This is an operational health check only; it does not perform a web search and does not expose gateway credentials or upstream URLs.",
      inputSchema: SearchHealthInputSchema,
      outputSchema: SearchHealthOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ response_format }, ctx) => execute(
      dependencies,
      "local_ai_get_search_health",
      "Search Gateway Health",
      response_format,
      ctx,
      () => dependencies.dataSource.getSearchHealth() as Promise<Record<string, unknown>>,
    ),
  );

  server.registerTool(
    "local_ai_search_web",
    {
      title: "Search the Web Through Local SearXNG",
      description: `Search the web through the platform's existing authenticated search gateway and self-hosted SearXNG service.

Use this for current facts, release notes, news, prices, documentation discovery, or source URLs. Results include bounded titles, URLs, snippets, engines, categories, dates, and optional direct answers. It does not fetch arbitrary URLs or modify any external system. Search queries may be sent to the SearXNG engines selected by the operator, so do not include secrets or private prompt content. Calls are rate-limited per MCP client and by a server-wide hard ceiling.

Returns the standard envelope plus data={query,searched_at,count,answers,results}. If results are weak, refine query, language, time_range, engines, or categories rather than increasing beyond ten results.`,
      inputSchema: WebSearchInputSchema,
      outputSchema: WebSearchOutputSchema,
      annotations: READ_ONLY_OPEN_WORLD_ANNOTATIONS,
    },
    async ({ query, max_results, language, time_range, engines, categories, safesearch, response_format }, ctx) => {
      const id = clientId(ctx, dependencies.defaultClientId || "local-mcp-client");
      const rate = searchRateLimiter.consume(id);
      if (!rate.ok) {
        await auditRejected(dependencies.auditLogger, "local_ai_search_web", id, "rate_limited");
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Web-search rate limit reached for this client. Retry in ${rate.retryAfterSeconds} seconds or narrow an earlier result set.`,
          }],
        };
      }
      return execute(
        dependencies,
        "local_ai_search_web",
        "Web Search Results",
        response_format,
        ctx,
        () => dependencies.dataSource.searchWeb({
          query,
          maxResults: max_results,
          language,
          timeRange: time_range,
          engines,
          categories,
          safesearch,
        }) as Promise<Record<string, unknown>>,
      );
    },
  );

  server.registerTool(
    "local_ai_list_jobs",
    {
      title: "List Local AI Jobs",
      description: `Page through safe summaries of vLLM and llama.cpp download, serve, benchmark, and test jobs.

Use this to answer whether a model download or launch succeeded, what recently failed, or which manager handled a workflow. Logs, command lines, absolute paths, process IDs, and job metadata are deliberately omitted. Filter by engine, lifecycle status, and job_type; then use offset and limit until has_more is false.

Returns data={engine_filter,status_filter,type_filter,total,count,offset,has_more,next_offset,jobs}. This tool never cancels, pauses, resumes, starts, or retries a job.`,
      inputSchema: JobsInputSchema,
      outputSchema: JobsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ engine, status, job_type, limit, offset, response_format }, ctx) => execute(
      dependencies,
      "local_ai_list_jobs",
      "Local AI Jobs",
      response_format,
      ctx,
      () => dependencies.dataSource.listJobs({ engine, status, jobType: job_type, limit, offset }) as Promise<Record<string, unknown>>,
    ),
  );

  server.registerTool(
    "local_ai_preview_route",
    {
      title: "Preview Local Model Routing",
      description: `Preview which running manager, instance, and model would receive a request without sending an inference request.

Use this before configuring a client or diagnosing automatic routing. Specify an optional served model ID plus the required capability and client protocol. The result explains whether a route was selected and why, while omitting model filesystem roots and credentials. An unsuccessful preview is a planning result, not a model launch request.

Returns data={selected,status,capability,reason,error,request,manager,instance,model}.`,
      inputSchema: RoutePreviewInputSchema,
      outputSchema: RoutePreviewOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ model, engine, protocol, capability, response_format }, ctx) => execute(
      dependencies,
      "local_ai_preview_route",
      "Local Model Route Preview",
      response_format,
      ctx,
      () => dependencies.dataSource.previewRoute({ model, engine, protocol, capability }) as Promise<Record<string, unknown>>,
    ),
  );

  server.registerTool(
    "local_ai_estimate_memory",
    {
      title: "Estimate Model Memory Fit",
      description: `Estimate whether a proposed vLLM or llama.cpp model configuration fits the GPUs currently reported by the platform.

Use this before downloading or launching a model. Provide parameter count, context length, precision, parallel sequences, utilization, and optional offload/speculative-decoding assumptions. The estimator reuses the manager's planning logic and current free GPU memory; it does not inspect an arbitrary file or launch anything. NVFP4/int4 uses 0.5 bytes per parameter, FP8/int8 uses 1, and FP16/BF16 uses 2. Treat the result as a planning estimate and validate with a bounded launch test later.

Returns normalized memory totals, fit status, overflow, offload recommendations, and explicit assumptions.`,
      inputSchema: MemoryEstimateInputSchema,
      outputSchema: MemoryEstimateOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      engine, params_b, context_tokens, precision, bytes_per_param, parallel_sequences,
      gpu_memory_utilization, cpu_offload_gb, kv_offload_gb, speculative_mode,
      speculative_tokens, response_format,
    }, ctx) => execute(
      dependencies,
      "local_ai_estimate_memory",
      "Model Memory Fit Estimate",
      response_format,
      ctx,
      () => dependencies.dataSource.estimateMemory({
        engine,
        paramsB: params_b,
        contextTokens: context_tokens,
        precision,
        bytesPerParam: bytes_per_param,
        parallelSequences: parallel_sequences,
        gpuMemoryUtilization: gpu_memory_utilization,
        cpuOffloadGb: cpu_offload_gb,
        kvOffloadGb: kv_offload_gb,
        speculativeMode: speculative_mode,
        speculativeTokens: speculative_tokens,
      }) as Promise<Record<string, unknown>>,
    ),
  );

  server.registerTool(
    "local_ai_get_security_posture",
    {
      title: "Get Local AI Exposure and Security Posture",
      description: `Combine the unified entry policy, manager exposure checks, MCP transport boundary, and search authentication into one redacted security posture.

Use this before exposing a model to LAN/public clients or when diagnosing authentication and CORS behavior. It reports only policy booleans, bind scope classifications, rate limits, and safe finding titles. It omits API keys, previews, client IDs, filesystem paths, upstream URLs, and raw addresses. warnings_only=true keeps only actionable findings.

Returns overall=secure|warn|fail plus entry, MCP, search, per-manager posture, and findings. It does not change firewall, proxy, CORS, key, or exposure settings.`,
      inputSchema: SecurityPostureInputSchema,
      outputSchema: SecurityPostureOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ engine, warnings_only, response_format }, ctx) => execute(
      dependencies,
      "local_ai_get_security_posture",
      "Local AI Security Posture",
      response_format,
      ctx,
      () => dependencies.dataSource.getSecurityPosture({ engine, warningsOnly: warnings_only }) as Promise<Record<string, unknown>>,
    ),
  );

  return server;
}
