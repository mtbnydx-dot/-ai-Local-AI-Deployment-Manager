"use strict";

const GENERIC_MODEL_IDS = Object.freeze(["", "auto", "current", "default", "local-current", "local-default"]);
const GENERIC_MODEL_ID_SET = new Set(GENERIC_MODEL_IDS);
const DEFAULT_CLAUDE_MODEL_ALIASES = Object.freeze([
  "claude-opus-4-7",
  "claude-opus-4.7",
  "claude-sonnet-4-6",
  "claude-sonnet-4.6",
  "claude-haiku-4-5",
  "claude-haiku-4.5",
  "local",
]);
const CAPABILITY_ORDER = ["text", "vision", "audio", "embedding", "rerank", "tools"];
const DEFAULT_GPU_RESERVE_MB = 8192;
const DEFAULT_GPU_MAX_UTILIZATION_PCT = 85;
const MAX_GPU_RESERVE_MB = 262144;

function normalizeFleetMode(value) {
  const mode = String(value || "multimodal").trim().toLowerCase();
  return new Set(["multimodal", "balanced", "throughput", "manual", "text"]).has(mode)
    ? mode
    : "multimodal";
}

function normalizeFleetMaxUtilizationPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_GPU_MAX_UTILIZATION_PCT;
  const percent = number <= 1 ? number * 100 : number;
  return Math.round(Math.min(99, Math.max(10, percent)) * 100) / 100;
}

function normalizeFleetSettings(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const reserve = Number(input.reserveMb);
  const preferEngine = ["vllm", "llama"].includes(String(input.preferEngine || "").toLowerCase())
    ? String(input.preferEngine).toLowerCase()
    : "auto";
  return {
    mode: normalizeFleetMode(input.mode),
    reserveMb: Number.isFinite(reserve)
      ? Math.min(MAX_GPU_RESERVE_MB, Math.max(0, Math.round(reserve)))
      : DEFAULT_GPU_RESERVE_MB,
    maxUtilizationPct: normalizeFleetMaxUtilizationPct(input.maxUtilizationPct),
    preferEngine,
  };
}

function normalizeCapability(value) {
  const text = String(value || "").trim().toLowerCase().replaceAll("_", "-");
  if (!text) return "";
  if (/rerank|reranker|cross-encoder|text-ranking|score/.test(text)) return "rerank";
  if (/embed|feature-extraction|sentence-similarity|semantic-search|vector/.test(text)) return "embedding";
  if (/audio|speech|whisper|asr|transcri|text-to-speech|tts|wav2vec|clap/.test(text)) return "audio";
  if (/vision|visual|image|video|multimodal|multi-modal|image-to-text|image-text/.test(text)) return "vision";
  if (/tool|function/.test(text)) return "tools";
  if (/text|chat|generation|completion|language|causal-lm|code/.test(text)) return "text";
  return "";
}

function collectCapabilityTokens(value, output = []) {
  if (value === null || value === undefined) return output;
  if (typeof value === "string") {
    output.push(...value.split(/[\s,;|]+/).filter(Boolean));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCapabilityTokens(item, output);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (item === true) output.push(key);
      else if (typeof item === "string" || Array.isArray(item)) collectCapabilityTokens(item, output);
    }
  }
  return output;
}

function orderedCapabilities(values) {
  const found = new Set(values.map(normalizeCapability).filter(Boolean));
  return CAPABILITY_ORDER.filter((capability) => found.has(capability));
}

function inferModelCapabilities(model = {}) {
  const item = typeof model === "string" ? { id: model } : (model && typeof model === "object" ? model : {});
  const explicitTokens = [];
  collectCapabilityTokens(item.capabilities, explicitTokens);
  collectCapabilityTokens(item.tasks ?? item.task ?? item.pipeline_tag ?? item.pipelineTag, explicitTokens);
  collectCapabilityTokens(item.inputModalities ?? item.input_modalities ?? item.modalities, explicitTokens);
  const explicit = orderedCapabilities(explicitTokens);
  if (explicit.length) return explicit;

  const name = [item.id, item.name, item.root, item.model_type, item.architecture]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const inferred = [];
  if (/(?:^|[^a-z0-9])(?:vl|vlm)(?:[^a-z0-9]|$)|vision|visual|multimodal|multi-modal|llava|bakllava|internvl|qwen[^\s/]*-vl|qwen-vl|pixtral|minicpm-v|moondream|florence|ocr|image/.test(name)) inferred.push("vision");
  const reranker = /rerank|reranker|cross-encoder/.test(name);
  if (!reranker && /embed|embedding|bge(?:-|\b)|nomic-embed|sentence-transform|(?:^|[/_-])e5(?:[/_-]|$)|(?:^|[/_-])gte(?:[/_-]|$)/.test(name)) inferred.push("embedding");
  if (reranker) inferred.push("rerank");
  if (/audio|whisper|speech|asr|transcri|tts|wav2vec|clap/.test(name)) inferred.push("audio");
  if (/(qwen|functionary|command-r|tool)/.test(name) && !/(embed|rerank)/.test(name)) inferred.push("tools");
  if (!inferred.length || /text|chat|instruct|coder|code|llm|qwen|llama|gemma|mistral|deepseek/.test(name)) inferred.unshift("text");
  return orderedCapabilities(inferred);
}

function bodyContainsType(value, predicates, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") return false;
  if (Array.isArray(value)) return value.some((item) => bodyContainsType(item, predicates, depth + 1));
  if (typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = String(key).toLowerCase().replaceAll("-", "_");
    const typeValue = normalizedKey === "type" ? String(item || "").toLowerCase().replaceAll("-", "_") : "";
    if (predicates.some((predicate) => predicate(normalizedKey, typeValue, item))) return true;
    if (bodyContainsType(item, predicates, depth + 1)) return true;
  }
  return false;
}

function inferRequestCapability({ route = {}, body = {} } = {}) {
  const path = String(typeof route === "string" ? route : route.path || route.rest || route.pathname || "").toLowerCase();
  if (/\/(?:embeddings?|pooling)(?:\/|$)/.test(`/${path.replace(/^\/+/, "")}`)) return "embedding";
  if (/\/(?:rerank|score|classify)(?:\/|$)/.test(`/${path.replace(/^\/+/, "")}`)) return "rerank";
  if (/\/(?:audio|speech|transcriptions?|translations?)(?:\/|$)/.test(`/${path.replace(/^\/+/, "")}`)) return "audio";

  const hasAudio = bodyContainsType(body, [
    (key, type) => ["input_audio", "audio", "audio_url"].includes(key) || ["input_audio", "audio"].includes(type),
  ]);
  if (hasAudio) return "audio";
  const hasVision = bodyContainsType(body, [
    (key, type) => ["image_url", "input_image", "image", "video_url", "input_video"].includes(key)
      || ["image_url", "input_image", "image", "input_video", "video"].includes(type),
  ]);
  if (hasVision) return "vision";
  return Array.isArray(body?.tools) && body.tools.length ? "tools" : "text";
}

function normalizeInstanceLifecycleState(instance = {}, running = false, status = "") {
  const explicit = String(instance.lifecycleState || instance.lifecycle_state || "").trim().toLowerCase();
  if (["ready", "loading", "stopped", "crashed", "degraded"].includes(explicit)) return explicit;
  const text = String(status || "").trim().toLowerCase();
  const exitCode = text.match(/exited\s*\((\d+)\)/)?.[1];
  if (running) {
    if (/starting|loading|initializ|created|restarting/.test(text)) return "loading";
    if (/unhealthy|degraded|oom|error|failed/.test(text)) return "degraded";
    return "ready";
  }
  if (/starting|loading|initializ|created|restarting/.test(text)) return "loading";
  if ((exitCode !== undefined && Number(exitCode) !== 0) || /dead|crash|oom|error|failed/.test(text)) return "crashed";
  return "stopped";
}

function isLastKnownModel(model) {
  return Boolean(model && typeof model === "object" && model.lastKnown === true);
}

function hasOnlyLastKnownModels(instance = {}) {
  const models = Array.isArray(instance.models) ? instance.models : [];
  return models.length > 0 && models.every(isLastKnownModel);
}

function normalizeManagerInstances(manager = {}, payload = {}) {
  const source = Array.isArray(payload?.instances)
    ? payload.instances
    : payload?.container
      ? [{
        id: "primary",
        primary: true,
        containerName: payload.container.name,
        running: payload.container.running,
        status: payload.container.status,
        port: payload.endpoint?.port,
        localBaseUrl: payload.endpoint?.localUrl,
        lanBaseUrl: payload.endpoint?.lanUrl,
        models: payload.servedModels || payload.models || [],
      }]
      : [];
  const managerId = String(manager.id || manager.engine || manager.name || "manager").trim().toLowerCase();
  return source.map((instance) => {
    const instanceId = String(instance.id || instance.instanceId || instance.containerName || "primary");
    const containerName = instance.containerName || instance.container?.name || "";
    const running = instance?.running === true || instance?.container?.running === true;
    const status = instance.status || instance.container?.status || (running ? "running" : "stopped");
    const rawModels = Array.isArray(instance.models) ? instance.models : Array.isArray(instance.servedModels) ? instance.servedModels : [];
    const models = rawModels.map((model) => {
      const item = typeof model === "string" ? { id: model } : { ...(model || {}) };
      return {
        ...item,
        manager_engine: managerId,
        instance_id: instanceId,
        container_name: containerName,
        capabilities: inferModelCapabilities(item),
      };
    }).filter((model) => String(model.id || "").trim());
    const detectedLifecycleState = normalizeInstanceLifecycleState(instance, running, status);
    return {
      id: instanceId,
      fleetId: `${managerId}:${instanceId}`,
      instanceId,
      instanceMode: instance.instanceMode || (instance.primary ? "replace" : "parallel"),
      primary: Boolean(instance.primary),
      manager,
      managerId,
      managerName: manager.name || managerId,
      engine: managerId,
      manager_engine: managerId,
      containerName,
      running,
      status,
      lifecycleState: hasOnlyLastKnownModels({ models }) && detectedLifecycleState === "ready"
        ? "loading"
        : detectedLifecycleState,
      image: instance.image || instance.container?.image || "",
      port: Number(instance.port || instance.endpoint?.port || 0) || null,
      localBaseUrl: instance.localBaseUrl || instance.endpoint?.localUrl || null,
      lanBaseUrl: instance.lanBaseUrl || instance.endpoint?.lanUrl || null,
      gpuIds: Array.isArray(instance.gpuIds) ? instance.gpuIds.map(String) : [],
      priority: Number.isFinite(Number(instance.priority)) ? Number(instance.priority) : 0,
      models,
    };
  });
}

function isRoutableInstance(instance = {}) {
  if (instance?.running !== true) return false;
  if (hasOnlyLastKnownModels(instance)) return false;
  const lifecycleState = normalizeInstanceLifecycleState(instance, true, instance.status || instance.container?.status || "");
  return lifecycleState === "ready";
}

function flattenCatalogModels(instances = []) {
  const output = [];
  const seen = new Set();
  for (const instance of Array.isArray(instances) ? instances : []) {
    if (!isRoutableInstance(instance)) continue;
    const managerId = String(instance.manager_engine || instance.manager?.id || "manager").toLowerCase();
    const instanceId = String(instance.instanceId || instance.id || instance.containerName || "primary");
    for (const source of Array.isArray(instance.models) ? instance.models : []) {
      if (isLastKnownModel(source)) continue;
      const model = typeof source === "string" ? { id: source } : { ...(source || {}) };
      const id = String(model.id || "").trim();
      if (!id) continue;
      const key = `${managerId}\0${instanceId.toLowerCase()}\0${id.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        ...model,
        id,
        object: model.object || "model",
        owned_by: model.owned_by || managerId,
        manager_engine: managerId,
        instance_id: instanceId,
        container_name: instance.containerName || "",
        capabilities: inferModelCapabilities(model),
      });
    }
  }
  return output;
}

function catalogCandidates(catalogs = []) {
  const candidates = [];
  for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
    const manager = catalog.manager || {};
    const managerId = String(manager.id || catalog.manager_engine || catalog.engine || "manager").toLowerCase();
    const allInstances = Array.isArray(catalog.instances) ? catalog.instances : [];
    const instances = allInstances.filter(isRoutableInstance);
    const models = Array.isArray(catalog.models) ? catalog.models : flattenCatalogModels(instances);
    for (const source of models) {
      if (isLastKnownModel(source)) continue;
      const model = typeof source === "string" ? { id: source } : source;
      const instanceId = String(model?.instance_id || model?.instanceId || "primary");
      const declaredInstance = allInstances.find((item) => String(item.instanceId || item.id) === instanceId);
      const instance = declaredInstance || (!allInstances.length
        ? { id: instanceId, instanceId, primary: instanceId === "primary", running: catalog.running !== false }
        : null);
      if (!isRoutableInstance(instance) || catalog.running === false) continue;
      candidates.push({
        catalog,
        manager,
        managerId,
        instance,
        model: { ...model, capabilities: inferModelCapabilities(model) },
        capabilities: inferModelCapabilities(model),
      });
    }
  }
  return candidates;
}

function targetError(error, capability, status, reason) {
  return { manager: null, instance: null, model: null, capability, reason, message: reason, error, status };
}

function selectFleetTarget(catalogs, request = {}) {
  const route = request.route || { protocol: request.protocol, path: request.path };
  const protocol = String(request.protocol || route.protocol || "openai").toLowerCase();
  const engine = String(request.engine || route.engine || "auto").toLowerCase();
  const requestedModel = String(request.requestedModel ?? request.body?.model ?? "").trim();
  const generic = GENERIC_MODEL_ID_SET.has(requestedModel.toLowerCase());
  const claudeAliasSource = Array.isArray(request.claudeAliases)
    ? request.claudeAliases
    : DEFAULT_CLAUDE_MODEL_ALIASES;
  const claudeAliases = new Set(claudeAliasSource.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean));
  const claudeCompatibilityAlias = protocol === "claude" && claudeAliases.has(requestedModel.toLowerCase());
  const capability = request.capability || inferRequestCapability({ route: { ...route, path: request.path || route.path || route.rest }, body: request.body || {} });
  const mode = normalizeFleetMode(request.mode);
  let candidates = catalogCandidates(catalogs);
  if (["vllm", "llama"].includes(engine)) candidates = candidates.filter((item) => item.managerId === engine);

  if (!generic) {
    const value = requestedModel.toLowerCase();
    const exact = candidates.filter((candidate) => {
      const model = candidate.model;
      const ids = [model.id, model.root, ...(Array.isArray(model.aliases) ? model.aliases : [])]
        .map((item) => String(item || "").toLowerCase())
        .filter(Boolean);
      return ids.includes(value);
    });
    if (!exact.length && !claudeCompatibilityAlias) {
      return targetError("model_not_available", capability, 404, `Requested model ${requestedModel} is not available in the running fleet.`);
    }
    if (exact.length) candidates = exact;
  }

  let capable = candidates.filter((candidate) => candidate.capabilities.includes(capability));
  // Tool schemas still work with a normal chat model when no dedicated
  // function-calling profile is advertised. Prefer an explicit tools model,
  // but preserve the existing text gateway as a safe compatibility fallback.
  if (!capable.length && capability === "tools") {
    capable = candidates.filter((candidate) => candidate.capabilities.includes("text"));
  }
  if (!capable.length) {
    return targetError("capability_not_available", capability, 503, `No running model provides the required ${capability} capability.`);
  }

  const preferredEngine = String(request.preferEngine || "").toLowerCase();
  capable.sort((a, b) => {
    const exactA = !generic && String(a.model.id).toLowerCase() === requestedModel.toLowerCase() ? 1 : 0;
    const exactB = !generic && String(b.model.id).toLowerCase() === requestedModel.toLowerCase() ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;
    if (preferredEngine && preferredEngine !== "auto") {
      const prefA = a.managerId === preferredEngine ? 1 : 0;
      const prefB = b.managerId === preferredEngine ? 1 : 0;
      if (prefA !== prefB) return prefB - prefA;
    }
    if (mode === "throughput" && ["text", "tools"].includes(capability)) {
      const throughputA = a.managerId === "vllm" ? 1 : 0;
      const throughputB = b.managerId === "vllm" ? 1 : 0;
      if (throughputA !== throughputB) return throughputB - throughputA;
    }
    if (mode === "balanced") {
      const primaryA = Number(Boolean(a.instance.primary));
      const primaryB = Number(Boolean(b.instance.primary));
      if (primaryA !== primaryB) return primaryB - primaryA;
    }
    if (mode === "multimodal" && capability === "text") {
      const specialistA = a.capabilities.length === 1 ? 1 : 0;
      const specialistB = b.capabilities.length === 1 ? 1 : 0;
      if (specialistA !== specialistB) return specialistB - specialistA;
    }
    const priorityA = Number(a.instance.priority || a.model.priority || 0);
    const priorityB = Number(b.instance.priority || b.model.priority || 0);
    if (priorityA !== priorityB) return priorityB - priorityA;
    return Number(Boolean(b.instance.primary)) - Number(Boolean(a.instance.primary));
  });
  const selected = capable[0];
  return {
    manager: selected.manager,
    instance: selected.instance,
    model: selected.model,
    capability,
    reason: generic ? `generic_${capability}` : claudeCompatibilityAlias ? "claude_compat_alias" : "explicit_model",
    policy: { mode, preferEngine: preferredEngine || "auto" },
    error: null,
    status: 200,
  };
}

function rewriteRequestModelBody(buffer, modelId, parsedBody = null) {
  if (buffer === undefined || buffer === null || !String(modelId || "").trim()) return buffer;
  const wasBuffer = Buffer.isBuffer(buffer);
  const text = wasBuffer ? buffer.toString("utf8") : String(buffer);
  if (!text.trim()) return buffer;
  try {
    const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
      ? parsedBody
      : JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return buffer;
    if (String(body.model || "") === String(modelId)) return buffer;
    const output = JSON.stringify({ ...body, model: String(modelId) });
    return wasBuffer ? Buffer.from(output, "utf8") : output;
  } catch {
    return buffer;
  }
}

function gpuPhysicalKey(gpu) {
  const uuid = String(gpu?.uuid || gpu?.gpuUuid || "").trim();
  if (uuid) return `uuid:${uuid}`;
  const pci = String(gpu?.pciBusId || gpu?.pci || gpu?.busId || "").trim();
  if (pci) return `pci:${pci}`;
  return "";
}

function findMatchingGpuKey(byId, gpu, managerId) {
  const physical = gpuPhysicalKey(gpu);
  if (physical && byId.has(physical)) return physical;
  const sourceId = String(gpu.id ?? gpu.index ?? "0");
  const totalMb = Number(gpu.totalMb || 0);
  for (const [key, current] of byId) {
    if (String(current.sourceId || current.id) !== sourceId) continue;
    const currentTotal = Number(current.totalMb || 0);
    if (currentTotal > 0 && totalMb > 0 && Math.abs(currentTotal - totalMb) / Math.max(currentTotal, totalMb) <= 0.02) {
      return key;
    }
  }
  return physical || `${managerId || "manager"}:${sourceId}`;
}

function normalizeGpuMemory(resources, reserveMb, maxUtilizationPct) {
  const entries = Array.isArray(resources) ? resources : resources ? [resources] : [];
  const candidates = [];
  for (const entry of entries) {
    const managerId = String(entry?.manager_engine || entry?.managerId || "").trim();
    const aggregate = entry?.gpuMemory || entry?.resources?.gpuMemory || entry?.gpu || entry;
    if (Array.isArray(aggregate?.gpus)) {
      candidates.push(...aggregate.gpus.map((gpu, index) => ({
        ...gpu,
        id: gpu.id ?? gpu.index ?? String(index),
        managerId: gpu.managerId || managerId,
      })));
    } else if (Number(aggregate?.totalMb || 0) > 0) {
      // Both managers report the same single physical GPU. Give aggregate
      // readings a stable ID so they are de-duplicated instead of summed.
      candidates.push({
        ...aggregate,
        id: aggregate.id ?? aggregate.index ?? "0",
        managerId: aggregate.managerId || managerId,
      });
    }
  }
  const byId = new Map();
  for (const [index, gpu] of candidates.entries()) {
    const sourceId = String(gpu.id ?? gpu.index ?? index);
    const key = findMatchingGpuKey(byId, { ...gpu, id: sourceId }, gpu.managerId);
    const totalMb = Number(gpu.totalMb || 0);
    const usedMb = Number(gpu.usedMb || 0);
    const current = byId.get(key);
    const nextTotal = Math.max(Number(current?.totalMb || 0), totalMb);
    const nextUsed = Math.max(Number(current?.usedMb || 0), usedMb);
    byId.set(key, {
      id: current?.id || sourceId,
      sourceId,
      name: gpu.name || current?.name || "",
      totalMb: nextTotal,
      usedMb: nextUsed,
      freeMb: Math.max(0, nextTotal - nextUsed),
    });
  }
  const warningThresholdPct = normalizeFleetMaxUtilizationPct(maxUtilizationPct);
  const gpus = [...byId.values()].map((gpu) => {
    const warningLimitMb = Math.floor(gpu.totalMb * (warningThresholdPct / 100));
    const reserveHeadroomMb = Math.max(0, gpu.freeMb - reserveMb);
    const warningHeadroomMb = Math.max(0, warningLimitMb - gpu.usedMb);
    const allocatableMb = Math.max(0, Math.min(reserveHeadroomMb, warningHeadroomMb));
    return {
      ...gpu,
      warningLimitMb,
      allocatableMb,
      availableMb: allocatableMb,
    };
  });
  const totalMb = gpus.reduce((sum, gpu) => sum + gpu.totalMb, 0);
  const usedMb = gpus.reduce((sum, gpu) => sum + gpu.usedMb, 0);
  const freeMb = gpus.reduce((sum, gpu) => sum + gpu.freeMb, 0);
  const allocatableMb = gpus.reduce((sum, gpu) => sum + gpu.allocatableMb, 0);
  return {
    totalMb,
    usedMb,
    freeMb,
    reserveMb,
    availableMb: allocatableMb,
    allocatableMb,
    warningThresholdPct,
    gpus,
  };
}

function buildFleetSnapshot({ catalogs = [], resources = [], settings = {}, gatewayBase = "" } = {}) {
  const normalizedSettings = normalizeFleetSettings(settings);
  const instances = (Array.isArray(catalogs) ? catalogs : []).flatMap((catalog) => Array.isArray(catalog.instances) ? catalog.instances : []);
  const residentModels = (Array.isArray(catalogs) ? catalogs : []).flatMap((catalog) => {
    const models = (Array.isArray(catalog.models) ? catalog.models : flattenCatalogModels(catalog.instances || []))
      .filter((model) => !isLastKnownModel(model));
    return models.map((model) => ({
      model: model.id,
      manager_engine: model.manager_engine || catalog.manager?.id || "",
      instance_id: model.instance_id || "primary",
      capabilities: inferModelCapabilities(model),
      localBaseUrl: (catalog.instances || []).find((instance) => String(instance.instanceId || instance.id) === String(model.instance_id || "primary"))?.localBaseUrl || null,
    }));
  });
  const capabilityCounts = Object.fromEntries(CAPABILITY_ORDER.map((capability) => [
    capability,
    residentModels.filter((slot) => slot.capabilities.includes(capability)).length,
  ]));
  const slots = [
    {
      id: "vision",
      label: "视觉模型槽位",
      role: "视觉 / 图像理解",
      capability: "vision",
      state: capabilityCounts.vision ? "loaded" : "empty",
      status: capabilityCounts.vision ? "已加载" : "待加载",
      managerId: "vllm",
    },
    {
      id: "embedding",
      label: "Embedding / Reranker 槽位",
      role: "向量 / 检索增强",
      capability: "embedding",
      state: capabilityCounts.embedding || capabilityCounts.rerank ? "loaded" : "empty",
      status: capabilityCounts.embedding || capabilityCounts.rerank ? "已加载" : "待加载",
      managerId: "vllm",
    },
  ];
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    settings: normalizedSettings,
    gpuMemory: normalizeGpuMemory(
      resources,
      normalizedSettings.reserveMb,
      normalizedSettings.maxUtilizationPct,
    ),
    instances,
    slots,
    gatewayBase: String(gatewayBase || "").replace(/\/$/, ""),
    routing: {
      mode: normalizedSettings.mode,
      genericModelIds: [...GENERIC_MODEL_IDS],
      capabilityCounts,
    },
  };
}

module.exports = {
  DEFAULT_GPU_RESERVE_MB,
  DEFAULT_GPU_MAX_UTILIZATION_PCT,
  MAX_GPU_RESERVE_MB,
  GENERIC_MODEL_IDS,
  DEFAULT_CLAUDE_MODEL_ALIASES,
  normalizeFleetMode,
  normalizeFleetMaxUtilizationPct,
  normalizeFleetSettings,
  inferModelCapabilities,
  inferRequestCapability,
  normalizeInstanceLifecycleState,
  isLastKnownModel,
  hasOnlyLastKnownModels,
  normalizeManagerInstances,
  isRoutableInstance,
  flattenCatalogModels,
  selectFleetTarget,
  rewriteRequestModelBody,
  buildFleetSnapshot,
};
