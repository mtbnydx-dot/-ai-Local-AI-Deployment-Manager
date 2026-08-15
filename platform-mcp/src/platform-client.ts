import type { PlatformMcpConfig, ManagerTarget } from "./config.js";
import { FixedHttpClient, UpstreamRequestError, type JsonObject } from "./http-client.js";
import { cleanText } from "./redaction.js";
import {
  DiagnosticsOutputSchema,
  GpuStatusOutputSchema,
  LocalModelsOutputSchema,
  OverviewOutputSchema,
  PerformanceOutputSchema,
  RunningModelsOutputSchema,
  SearchHealthOutputSchema,
  type DiagnosticsOutput,
  type EngineSelector,
  type GpuStatusOutput,
  type LocalModelsOutput,
  type OverviewOutput,
  type PerformanceOutput,
  type RunningModelsOutput,
  type SearchHealthOutput,
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
}

type SettledJson = { ok: true; data: JsonObject } | { ok: false; error: string };

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
  const online = !error;
  return {
    online,
    healthy: online && booleanValue(health.ok, false),
    mode: nullableString(health.searchMode ?? health.mode),
    auth_required: online && typeof health.authRequired === "boolean" ? health.authRequired : null,
    max_results: online ? nullableNumber(health.maxResults) : null,
    error,
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

export class LocalPlatformClient implements PlatformDataSource {
  private readonly config: PlatformMcpConfig;
  private readonly http: FixedHttpClient;

  constructor(config: PlatformMcpConfig, http?: FixedHttpClient) {
    this.config = config;
    this.http = http ?? new FixedHttpClient({
      timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxUpstreamBytes,
    });
  }

  private async safeGet(service: string, baseUrl: URL, pathname: string): Promise<SettledJson> {
    try {
      return { ok: true, data: await this.http.getJson(service, baseUrl, pathname) };
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
}
