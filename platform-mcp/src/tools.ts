import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import type { AuditLogger } from "./audit.js";
import { audited } from "./audit.js";
import { formatToolPayload } from "./format.js";
import type { PlatformDataSource } from "./platform-client.js";
import { cleanText } from "./redaction.js";
import {
  DiagnosticsInputSchema,
  DiagnosticsOutputSchema,
  GpuStatusInputSchema,
  GpuStatusOutputSchema,
  LocalModelsInputSchema,
  LocalModelsOutputSchema,
  OverviewInputSchema,
  OverviewOutputSchema,
  PerformanceInputSchema,
  PerformanceOutputSchema,
  RunningModelsInputSchema,
  RunningModelsOutputSchema,
  SearchHealthInputSchema,
  SearchHealthOutputSchema,
  type ResponseFormat,
} from "./schemas.js";

export type PlatformMcpServerDependencies = {
  dataSource: PlatformDataSource;
  auditLogger: AuditLogger;
  maxResponseChars: number;
  defaultClientId?: string;
};

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

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
  const server = new McpServer({
    name: "local-ai-platform",
    version: "0.1.0",
    title: "Local AI Platform (read-only)",
    description: "Safe operational visibility for the local vLLM, llama.cpp, GPU, model inventory, and search services.",
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

  return server;
}
