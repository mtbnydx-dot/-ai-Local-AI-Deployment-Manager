import type { PlatformDataSource } from "../src/platform-client.js";
import type {
  DiagnosticsOutput,
  EngineSelector,
  GpuStatusOutput,
  LocalModelsOutput,
  OverviewOutput,
  PerformanceOutput,
  RunningModelsOutput,
  SearchHealthOutput,
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
}
