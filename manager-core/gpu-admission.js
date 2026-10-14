"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { readJsonFile, writeJsonFile } = require("./file-utils");

const ADMISSION_STATE_VERSION = 1;
const DEFAULT_RESERVE_MB = 8192;
const DEFAULT_MAX_UTILIZATION_PCT = 85;
const MAX_RESERVE_MB = 262144;
const DEFAULT_STARTUP_MARGIN_MB = 1024;
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_COMMITTED_COOLDOWN_MS = 30 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 45 * 1000;
const DEFAULT_STALE_LOCK_MS = 30 * 1000;
// Below this budget a capped SGLang pool is not clamped; the launch is refused.
const DEFAULT_MIN_CLAMP_MB = 4096;
const SGLANG_FRACTION_OF_FREE_ESTIMATE_POLICY = "sglang_mem_fraction_static_of_free";
const STATIC_FRACTION_OF_FREE_POLICY = "static-fraction-of-free";

function defaultGpuAdmissionRoot() {
  const configured = String(process.env.MODEL_GPU_ADMISSION_ROOT || "").trim();
  return configured
    ? path.resolve(path.join(__dirname, ".."), configured)
    : path.join(__dirname, "..", ".runtime", "gpu-admission");
}

function defaultGpuAdmissionPolicyFile() {
  const configured = String(process.env.MODEL_GPU_ADMISSION_POLICY_FILE || "").trim();
  if (configured) {
    return path.resolve(path.isAbsolute(configured) ? configured : path.join(__dirname, "..", configured));
  }
  return path.join(__dirname, "..", "service-entry", "data", "fleet-settings.json");
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = finiteNumber(value, fallback);
  return Math.max(0, Math.round(number));
}

function normalizeMaxUtilization(value = DEFAULT_MAX_UTILIZATION_PCT) {
  const number = finiteNumber(value, DEFAULT_MAX_UTILIZATION_PCT);
  const ratio = number > 1 ? number / 100 : number;
  return Math.min(0.99, Math.max(0.1, ratio));
}

function normalizeGpuAdmissionPolicy(value = {}, fallback = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const fallbackReserveMb = Math.min(MAX_RESERVE_MB, nonNegativeInteger(fallback.reserveMb, DEFAULT_RESERVE_MB));
  const reserveInput = Number(input.reserveMb);
  const reserveMb = Number.isFinite(reserveInput)
    ? Math.min(MAX_RESERVE_MB, nonNegativeInteger(reserveInput, fallbackReserveMb))
    : fallbackReserveMb;
  const fallbackMaxUtilizationPct = normalizeMaxUtilization(fallback.maxUtilizationPct) * 100;
  const maxUtilizationPct = normalizeMaxUtilization(
    input.maxUtilizationPct === undefined ? fallbackMaxUtilizationPct : input.maxUtilizationPct,
  ) * 100;
  return {
    reserveMb,
    maxUtilizationPct: Math.round(maxUtilizationPct * 100) / 100,
  };
}

function createGpuAdmissionError(code, message, status = 503, details = {}) {
  const error = new Error(String(message || code || "GPU admission failed."));
  error.code = String(code || "gpu_admission_failed");
  error.status = Number(status || 503);
  error.details = details && typeof details === "object" ? details : {};
  return error;
}

// Fail-closed messages name the launch that was refused, so a replacement is
// never described as a parallel launch.
function launchPhrase(mode) {
  return mode === "replace" ? "replacement launch" : "parallel launch";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function retireAdmissionLock(lockDir, expectedToken = "") {
  // Without an owner token there is no filesystem compare-and-swap primitive
  // that can prove the directory is still the stale one we inspected. Failing
  // closed here prevents an unreadable/ownerless stale path from racing with a
  // successor and renaming that successor's live lock.
  if (!expectedToken) return false;
  // Several managers may notice the same dead owner together. Serialize the
  // retirement by the observed token; otherwise waiter A can rename the stale
  // directory, a successor can acquire the now-free path, and waiter B can
  // accidentally rename that successor using its earlier observation.
  const claimKey = crypto.createHash("sha256").update(expectedToken).digest("hex").slice(0, 32);
  const claimDir = `${lockDir}.retire-claim-${claimKey}`;
  try {
    await fsp.mkdir(claimDir);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  const ownerFile = path.join(lockDir, "owner.json");
  try {
    try {
      const owner = JSON.parse(await fsp.readFile(ownerFile, "utf8"));
      if (owner?.token !== expectedToken) return false;
    } catch {
      return false;
    }
    const retiredDir = `${lockDir}.retired-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fsp.rename(lockDir, retiredDir);
    } catch (error) {
      if (["ENOENT", "EEXIST", "EPERM", "EACCES"].includes(error?.code)) return false;
      throw error;
    }
    try {
      const movedOwner = JSON.parse(await fsp.readFile(path.join(retiredDir, "owner.json"), "utf8"));
      if (movedOwner?.token !== expectedToken) {
        // Never delete a directory whose identity changed unexpectedly.
        const identityError = new Error("GPU admission lock identity changed during retirement.");
        identityError.code = "GPU_ADMISSION_LOCK_IDENTITY_CHANGED";
        throw identityError;
      }
      await fsp.rm(retiredDir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error?.code === "GPU_ADMISSION_LOCK_IDENTITY_CHANGED") throw error;
      // An unreadable moved owner is retained rather than deleted.
      return false;
    }
  } finally {
    await fsp.rmdir(claimDir).catch(() => {});
  }
}

async function acquireAdmissionDirectoryLock(lockDir, options = {}) {
  const timeoutMs = Math.max(1000, nonNegativeInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS));
  const staleMs = Math.max(10000, nonNegativeInteger(options.staleMs, DEFAULT_STALE_LOCK_MS));
  const heartbeatMs = Math.max(1000, Math.min(10000, Math.floor(staleMs / 4)));
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const ownerFile = path.join(lockDir, "owner.json");
  while (true) {
    let createdLockDir = false;
    try {
      await fsp.mkdir(lockDir);
      createdLockDir = true;
      await fsp.writeFile(
        ownerFile,
        `${JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      break;
    } catch (error) {
      if (createdLockDir) {
        // Remove only the exact directory we just created, and only while it is
        // still empty. rmdir fails closed if an owner file or successor has
        // appeared, avoiding a recursive delete race.
        await fsp.rmdir(lockDir).catch(() => {});
        throw error;
      }
      if (error.code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = await fsp.stat(lockDir);
        if (Date.now() - stat.mtimeMs > staleMs) {
          let owner = null;
          try {
            owner = JSON.parse(await fsp.readFile(ownerFile, "utf8"));
          } catch {}
          // A slow but live admission must never be stolen. For an orphan, an
          // atomic rename retires exactly the stale directory before cleanup,
          // so a newly-created lock cannot be recursively deleted by a waiter.
          if (owner?.token && !isProcessAlive(owner?.pid) && await retireAdmissionLock(lockDir, owner.token)) continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw createGpuAdmissionError(
          "vram_admission_lock_timeout",
          `GPU admission is busy; ${launchPhrase(options.mode)} was not started and existing containers were not changed.`,
          503,
          { safetyPolicy: "fail_closed_parallel", timeoutMs },
        );
      }
      await delay(25 + Math.floor(Math.random() * 25));
    }
  }
  const heartbeat = setInterval(() => {
    const stamp = new Date();
    Promise.allSettled([
      fsp.utimes(lockDir, stamp, stamp),
      fsp.utimes(ownerFile, stamp, stamp),
    ]).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();
  return async () => {
    clearInterval(heartbeat);
    try {
      const owner = JSON.parse(await fsp.readFile(ownerFile, "utf8"));
      if (owner?.token === token) await retireAdmissionLock(lockDir, token);
    } catch {}
  };
}

function normalizeGpuTelemetry(status = {}) {
  const source = Array.isArray(status?.gpus) && status.gpus.length
    ? status.gpus
    : Number(status?.totalMb || 0) > 0
      ? [{
        id: status.id ?? status.index ?? "0",
        uuid: status.uuid,
        name: status.name,
        totalMb: status.totalMb,
        usedMb: status.usedMb,
        freeMb: status.freeMb,
      }]
      : [];
  return source.map((gpu, index) => {
    const totalMb = nonNegativeInteger(gpu?.totalMb, 0);
    const usedMb = Math.min(totalMb, nonNegativeInteger(gpu?.usedMb, 0));
    const computedFreeMb = Math.max(0, totalMb - usedMb);
    const reportedFreeMb = Number(gpu?.freeMb);
    const freeMb = Number.isFinite(reportedFreeMb)
      ? Math.max(0, Math.min(computedFreeMb, Math.round(reportedFreeMb)))
      : computedFreeMb;
    const id = String(gpu?.id ?? gpu?.index ?? index);
    const uuid = String(gpu?.uuid || gpu?.gpuUuid || gpu?.gpu_uuid || "").trim();
    return {
      id,
      uuid,
      key: uuid || id,
      aliases: Array.from(new Set([uuid, id, String(gpu?.index ?? "")].filter(Boolean))),
      name: String(gpu?.name || ""),
      totalMb,
      usedMb,
      freeMb,
    };
  }).filter((gpu) => gpu.totalMb > 0);
}

function normalizeAdmissionState(value = {}, mode = "parallel") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createGpuAdmissionError(
      "vram_admission_state_unavailable",
      `GPU admission state is invalid; ${launchPhrase(mode)} is blocked without changing existing containers.`,
      503,
      { safetyPolicy: "fail_closed_parallel" },
    );
  }
  if (value.leases !== undefined && (!value.leases || typeof value.leases !== "object" || Array.isArray(value.leases))) {
    throw createGpuAdmissionError(
      "vram_admission_state_unavailable",
      `GPU admission lease data is invalid; ${launchPhrase(mode)} is blocked without changing existing containers.`,
      503,
      { safetyPolicy: "fail_closed_parallel" },
    );
  }
  const leases = value.leases || {};
  return {
    version: ADMISSION_STATE_VERSION,
    updatedAt: String(value.updatedAt || ""),
    leases: { ...leases },
  };
}

function pruneExpiredLeases(state, nowMs) {
  const expired = [];
  for (const [leaseId, lease] of Object.entries(state.leases || {})) {
    const expiresAtMs = Date.parse(String(lease?.expiresAt || ""));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      delete state.leases[leaseId];
      expired.push(leaseId);
    }
  }
  return expired;
}

function activeReservedMb(state, gpuKey, excludedLeaseIds = new Set()) {
  let total = 0;
  for (const [leaseId, lease] of Object.entries(state.leases || {})) {
    if (excludedLeaseIds.has(String(leaseId))) continue;
    for (const reservation of Array.isArray(lease?.reservations) ? lease.reservations : []) {
      if (String(reservation?.gpuId || "") === String(gpuKey)) {
        total += nonNegativeInteger(reservation.requestedMb, 0);
      }
    }
  }
  return total;
}

function selectAdmissionGpus(gpus, request = {}, mode = "parallel") {
  const requestedIds = Array.from(new Set((Array.isArray(request.gpuIds) ? request.gpuIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
  if (!requestedIds.length) return request.useAllGpus ? gpus : gpus.slice(0, 1);
  const selected = [];
  const missing = [];
  for (const requested of requestedIds) {
    const match = gpus.find((gpu) => gpu.aliases.includes(requested));
    if (!match) missing.push(requested);
    else if (!selected.some((gpu) => gpu.key === match.key)) selected.push(match);
  }
  if (missing.length) {
    throw createGpuAdmissionError(
      "gpu_selection_unavailable",
      `Selected GPU telemetry is unavailable: ${missing.join(", ")}. ${mode === "replace" ? "Replacement" : "Parallel"} launch is blocked without changing existing containers.`,
      503,
      {
        safetyPolicy: "fail_closed_parallel",
        missingGpuIds: missing,
        availableGpuIds: gpus.map((gpu) => gpu.key),
      },
    );
  }
  return selected;
}

function fractionInRange(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : null;
}

function admissionGpuAliases(gpu) {
  return Array.isArray(gpu?.aliases) && gpu.aliases.length
    ? gpu.aliases
    : [String(gpu?.key ?? gpu?.id ?? "")].filter(Boolean);
}

function requestedMbForGpu(request, gpu, pendingMb = 0, mode = "parallel") {
  const byGpu = request.requestedMbByGpu && typeof request.requestedMbByGpu === "object"
    ? request.requestedMbByGpu
    : null;
  const mapped = byGpu
    ? admissionGpuAliases(gpu).map((id) => Number(byGpu[id])).find((value) => Number.isFinite(value) && value > 0)
    : null;
  const requestedMb = Number(request.requestedMb);
  const fraction = Number(request.requestedFraction);
  const candidates = Number.isFinite(mapped) && mapped > 0 ? [mapped] : [requestedMb];
  if (Number.isFinite(fraction) && fraction > 0 && fraction <= 1) candidates.push(gpu.totalMb * fraction);
  const fractionOfFree = fractionInRange(request.requestedFractionOfFree);
  // SGLang's mem-fraction-static applies to the memory that is free when the
  // engine starts, so the base is today's free memory minus what peers hold.
  // With nothing free the request still needs at least 1 MiB and is refused.
  if (fractionOfFree) candidates.push(Math.max(1, (finiteNumber(gpu.freeMb, 0) - pendingMb) * fractionOfFree));
  const trustworthy = candidates.filter((value) => Number.isFinite(value) && value > 0);
  if (trustworthy.length) return Math.ceil(Math.max(...trustworthy));
  throw createGpuAdmissionError(
    "vram_estimate_unavailable",
    `A trustworthy VRAM reservation estimate is unavailable; ${launchPhrase(mode)} is blocked without changing existing containers.`,
    422,
    {
      safetyPolicy: "fail_closed_parallel",
      estimatePolicy: String(request.estimatePolicy || "missing"),
    },
  );
}

// The knob a user turns to shrink the request: SGLang mem-fraction-static
// (fraction of free memory), vLLM gpu-memory-utilization (fraction of the
// device), or none for measured and GGUF estimates.
function admissionKnob(request = {}) {
  if (fractionInRange(request.requestedFractionOfFree)) return "fraction-of-free";
  if (fractionInRange(request.requestedFraction)) return "device-fraction";
  return "";
}

// The catalog params (01-engines §9) a console focuses to shrink a refused
// request, each with a suggested value (01 §12, ENG-12). Additive to the P0
// insufficient_vram details: SGLang's static fraction and KV pool cap, the
// device fraction of vLLM, and llama.cpp's planning headroom.
const SUGGESTED_POOL_TOKENS = 131072;

function admissionKnobs(request = {}, maxFraction = null) {
  const knob = admissionKnob(request);
  const suggestion = Number.isFinite(Number(maxFraction)) && Number(maxFraction) > 0 ? Number(maxFraction) : null;
  if (knob === "fraction-of-free") {
    const contextTokens = nonNegativeInteger(request.maxModelLen, 0);
    return [
      { param: "sglang.memFractionStatic", suggestion },
      { param: "sglang.maxTotalTokens", suggestion: contextTokens ? Math.min(contextTokens, SUGGESTED_POOL_TOKENS) : SUGGESTED_POOL_TOKENS },
    ];
  }
  if (knob === "device-fraction") {
    const engine = String(request.engine || "").toLowerCase();
    const param = engine === "llama" || engine === "llamacpp" ? "llamacpp.planningUtilization" : "vllm.gpuMemoryUtilization";
    return [{ param, suggestion }];
  }
  return [];
}

function largestPassingFraction(request, { totalMb, freeMb, pendingMb, availableMb }) {
  const knob = admissionKnob(request);
  const base = knob === "fraction-of-free" ? freeMb - pendingMb : knob === "device-fraction" ? totalMb : 0;
  if (!(base > 0)) return null;
  return Math.min(1, Math.floor((availableMb / base) * 1000) / 1000);
}

/**
 * Pure per-GPU admission decision shared by the admission controller and the
 * /api/memory-estimate preview, so the two cannot disagree.
 * reservedMb is what the lease holds: availableMb when a capped pool is
 * clamped, otherwise requestedMb.
 */
function decideGpuReservation(request = {}, gpu = {}, options = {}) {
  const pendingMb = nonNegativeInteger(options.pendingMb, 0);
  const reserveMb = nonNegativeInteger(options.reserveMb, DEFAULT_RESERVE_MB);
  const maxUtilization = normalizeMaxUtilization(options.maxUtilization ?? DEFAULT_MAX_UTILIZATION_PCT);
  const startupMarginMb = nonNegativeInteger(options.startupMarginMb, DEFAULT_STARTUP_MARGIN_MB);
  const totalMb = finiteNumber(gpu.totalMb, 0);
  const usedMb = finiteNumber(gpu.usedMb, 0);
  const freeMb = finiteNumber(gpu.freeMb, Math.max(0, totalMb - usedMb));
  const requestedMb = requestedMbForGpu(request, gpu, pendingMb, options.mode);
  const freeBudgetMb = Math.floor(freeMb - reserveMb - pendingMb);
  const thresholdBudgetMb = Math.floor((totalMb * maxUtilization) - usedMb - pendingMb - startupMarginMb);
  const availableMb = Math.max(0, Math.min(freeBudgetMb, thresholdBudgetMb));
  const poolCappedTokens = nonNegativeInteger(request.poolCappedTokens, 0);
  const minClampMb = nonNegativeInteger(request.minClampMb ?? DEFAULT_MIN_CLAMP_MB, DEFAULT_MIN_CLAMP_MB);
  const fits = requestedMb <= availableMb;
  // A capped KV pool lets the engine run inside a smaller reservation, so an
  // oversized fraction is clamped to the safe budget instead of refused.
  const clamped = !fits && poolCappedTokens > 0 && availableMb > 0 && availableMb >= minClampMb;
  return {
    requestedMb,
    availableMb,
    freeBudgetMb: Math.max(0, freeBudgetMb),
    thresholdBudgetMb: Math.max(0, thresholdBudgetMb),
    reservedMb: clamped ? availableMb : requestedMb,
    clamped,
    verdict: fits ? "ok" : clamped ? "warn" : "block",
    maxFraction: largestPassingFraction(request, { totalMb, freeMb, pendingMb, availableMb }),
  };
}

/**
 * Bilingual "<zh> / <en>" text for a decision: the mode-aware refusal for
 * "block", the clamp warning for "warn", and "" for "ok".
 */
function formatGpuAdmissionMessage(decision = {}, request = {}, { mode = "parallel" } = {}) {
  const requestedMb = nonNegativeInteger(decision.requestedMb, 0);
  const availableMb = nonNegativeInteger(decision.availableMb, 0);
  if (decision.verdict === "warn") {
    const tokens = nonNegativeInteger(request.poolCappedTokens, 0);
    return `SGLang 静态显存比例按空闲显存折算需要 ${requestedMb} MiB，超过安全预算 ${availableMb} MiB；因 KV 池已限制为 ${tokens} tokens，按 ${availableMb} MiB 预留并继续启动。`
      + ` / SGLang's static memory fraction of free memory would take ${requestedMb} MiB, above the safe budget of ${availableMb} MiB. The KV pool is capped at ${tokens} tokens, so the launch continues with a ${availableMb} MiB reservation.`;
  }
  if (decision.verdict !== "block") return "";
  const replace = mode === "replace";
  const zhLaunch = replace ? "替换启动" : "并行启动";
  const enLaunch = replace ? "Replacement launch" : "Parallel launch";
  const knob = admissionKnob(request);
  const maxFraction = Number(decision.maxFraction);
  let zhHint = "";
  let enHint = "";
  if (knob && Number.isFinite(maxFraction) && maxFraction > 0) {
    if (knob === "fraction-of-free") {
      zhHint = `请把「静态显存比例（mem-fraction-static）」降到 ${maxFraction} 以下，或设置 KV 池上限（max-total-tokens）。`;
      enHint = ` Lower the static memory fraction (mem-fraction-static) to ${maxFraction} or below, or cap the KV pool (max-total-tokens).`;
    } else {
      zhHint = `请把「显存预留比例（gpu-memory-utilization）」降到 ${maxFraction} 以下。`;
      enHint = ` Lower the GPU memory reservation (gpu-memory-utilization) to ${maxFraction} or below.`;
    }
  }
  return `${zhLaunch}需要 ${requestedMb} MiB，安全预算只有 ${availableMb} MiB。${zhHint}现有模型容器未改动。`
    + ` / ${enLaunch} needs ${requestedMb} MiB but the safe budget is ${availableMb} MiB.${enHint} Existing model containers were not changed.`;
}

/**
 * The per-GPU decisions of one request against a lease-state snapshot, shared
 * by acquire and the side-effect-free evaluate so the two cannot disagree.
 * Throws gpu_selection_unavailable like the acquire path always did.
 */
function admissionDecisions(request, gpus, { state, mode, retiredLeaseIds, reserveMb, maxUtilization, startupMarginMb }) {
  const selected = selectAdmissionGpus(gpus, request, mode);
  if (!selected.length) {
    throw createGpuAdmissionError(
      "gpu_selection_unavailable",
      `No GPU is available for the requested ${mode === "replace" ? "replacement" : "parallel"} instance.`,
      503,
      { safetyPolicy: "fail_closed_parallel" },
    );
  }

  const decisions = selected.map((gpu) => {
    const pendingMb = activeReservedMb(state, gpu.key, retiredLeaseIds);
    const decision = decideGpuReservation(request, gpu, { pendingMb, reserveMb, maxUtilization, startupMarginMb, mode });
    return {
      gpuId: gpu.key,
      gpuIndex: gpu.id,
      name: gpu.name,
      totalMb: gpu.totalMb,
      usedMb: gpu.usedMb,
      freeMb: gpu.freeMb,
      pendingMb,
      requestedMb: decision.requestedMb,
      availableMb: decision.availableMb,
      freeBudgetMb: decision.freeBudgetMb,
      thresholdBudgetMb: decision.thresholdBudgetMb,
      reservedMb: decision.reservedMb,
      clamped: decision.clamped,
      verdict: decision.verdict,
      maxFraction: decision.maxFraction,
    };
  });
  // A fraction must pass on every selected GPU, so the smallest one wins;
  // one GPU without a usable base means no fraction passes at all.
  const maxFractions = decisions.map((item) => item.maxFraction);
  const maxFraction = maxFractions.some((value) => value === null) ? null : Math.min(...maxFractions);
  const worstOf = (items) => ({
    requestedMb: Math.max(...items.map((item) => item.requestedMb)),
    availableMb: Math.min(...items.map((item) => item.availableMb)),
    maxFraction,
  });
  return { decisions, maxFraction, worstOf };
}

// Memory a replaced container gives back, by GPU alias (index, uuid or key),
// applied to the telemetry a replace-mode preview reads before anything stops.
function applyReleasedMemory(gpus, releasedMbByGpu) {
  if (!releasedMbByGpu || typeof releasedMbByGpu !== "object") return gpus;
  return gpus.map((gpu) => {
    const releasedMb = admissionGpuAliases(gpu)
      .map((id) => Number(releasedMbByGpu[id]))
      .find((value) => Number.isFinite(value) && value > 0);
    if (!releasedMb) return gpu;
    const usedMb = Math.max(0, gpu.usedMb - Math.round(releasedMb));
    return { ...gpu, usedMb, freeMb: Math.min(gpu.totalMb, gpu.freeMb + (gpu.usedMb - usedMb)) };
  });
}

function publicLeaseSummary(lease) {
  return {
    id: lease.id,
    state: lease.state,
    managerId: lease.managerId,
    engine: lease.engine,
    instanceId: lease.instanceId,
    containerName: lease.containerName,
    model: lease.model,
    policy: lease.policy,
    estimatePolicy: lease.estimatePolicy,
    requestedTotalMb: lease.requestedTotalMb,
    // Leases written before clamp-and-warn read as a plain "ok" admission.
    verdict: lease.verdict === "warn" ? "warn" : "ok",
    clamped: Boolean(lease.clamped),
    ...(lease.warning ? { warning: String(lease.warning) } : {}),
    reservations: lease.reservations.map((reservation) => ({ ...reservation })),
    createdAt: lease.createdAt,
    expiresAt: lease.expiresAt,
  };
}

function createGpuAdmissionController(options = {}) {
  const root = path.resolve(options.root || defaultGpuAdmissionRoot());
  const stateFile = path.join(root, "leases.json");
  const lockDir = path.join(root, "admission.lock");
  const getGpuStatus = options.getGpuStatus;
  const managerId = String(options.managerId || "local-manager");
  const explicitReserveMb = options.reserveMb;
  const explicitMaxUtilizationPct = options.maxUtilizationPct;
  const fallbackPolicy = normalizeGpuAdmissionPolicy({}, {
    reserveMb: process.env.MODEL_GPU_ADMISSION_RESERVE_MB,
    maxUtilizationPct: process.env.MODEL_GPU_ADMISSION_MAX_UTILIZATION_PCT,
  });
  const configuredPolicy = normalizeGpuAdmissionPolicy({
    ...(explicitReserveMb === undefined ? {} : { reserveMb: explicitReserveMb }),
    ...(explicitMaxUtilizationPct === undefined ? {} : { maxUtilizationPct: explicitMaxUtilizationPct }),
  }, fallbackPolicy);
  const policyFile = options.policyFile === false || options.policyFile === null
    ? ""
    : path.resolve(options.policyFile || defaultGpuAdmissionPolicyFile());
  const policyProvider = typeof options.getPolicy === "function" ? options.getPolicy : null;
  const startupMarginMb = nonNegativeInteger(options.startupMarginMb ?? process.env.MODEL_GPU_ADMISSION_STARTUP_MARGIN_MB, DEFAULT_STARTUP_MARGIN_MB);
  const leaseTtlMs = Math.max(60_000, nonNegativeInteger(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS));
  const committedCooldownMs = Math.max(0, nonNegativeInteger(options.committedCooldownMs, DEFAULT_COMMITTED_COOLDOWN_MS));
  const lockTimeoutMs = Math.max(1000, nonNegativeInteger(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS));
  const staleLockMs = Math.max(10000, nonNegativeInteger(options.staleLockMs, DEFAULT_STALE_LOCK_MS));
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  async function getPolicy() {
    let stored = {};
    try {
      stored = policyProvider
        ? await policyProvider()
        : policyFile
          ? await readJsonFile(policyFile, {})
          : {};
    } catch (error) {
      throw createGpuAdmissionError(
        "vram_admission_policy_unavailable",
        "GPU admission policy cannot be read safely; new model launches are blocked without changing existing containers.",
        503,
        { safetyPolicy: "fail_closed_parallel", cause: String(error?.code || error?.message || "policy_read_failed") },
      );
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw createGpuAdmissionError(
        "vram_admission_policy_unavailable",
        "GPU admission policy is invalid; new model launches are blocked without changing existing containers.",
        503,
        { safetyPolicy: "fail_closed_parallel", cause: "invalid_policy_shape" },
      );
    }
    return normalizeGpuAdmissionPolicy({
      ...stored,
      ...(explicitReserveMb === undefined ? {} : { reserveMb: explicitReserveMb }),
      ...(explicitMaxUtilizationPct === undefined ? {} : { maxUtilizationPct: explicitMaxUtilizationPct }),
    }, fallbackPolicy);
  }

  async function readState(mode = "parallel") {
    try {
      const stored = await readJsonFile(stateFile, { version: ADMISSION_STATE_VERSION, leases: {} });
      return normalizeAdmissionState(stored, mode);
    } catch (error) {
      if (error?.code === "vram_admission_state_unavailable") throw error;
      throw createGpuAdmissionError(
        "vram_admission_state_unavailable",
        `GPU admission state cannot be read safely; ${launchPhrase(mode)} is blocked without changing existing containers.`,
        503,
        { safetyPolicy: "fail_closed_parallel", cause: String(error?.code || error?.message || "read_failed") },
      );
    }
  }

  async function saveState(state, nowMs = now()) {
    state.version = ADMISSION_STATE_VERSION;
    state.updatedAt = new Date(nowMs).toISOString();
    await writeJsonFile(stateFile, state);
  }

  async function withAdmissionLock(work, { mode = "parallel" } = {}) {
    await fsp.mkdir(root, { recursive: true });
    const releaseLock = await acquireAdmissionDirectoryLock(lockDir, { timeoutMs: lockTimeoutMs, staleMs: staleLockMs, mode });
    try {
      return await work();
    } finally {
      await releaseLock();
    }
  }

  function decorateLease(record) {
    const summary = publicLeaseSummary(record);
    return {
      ...summary,
      summary,
      ttlMs: leaseTtlMs,
      heartbeatIntervalMs: Math.max(10_000, Math.min(60_000, Math.floor(leaseTtlMs / 3))),
      renew: () => renew(record.id),
      commit: (metadata = {}) => commit(record.id, metadata),
      release: (reason = "released") => release(record.id, reason),
      startHeartbeat({ onError = () => {} } = {}) {
        const intervalMs = Math.max(10_000, Math.min(60_000, Math.floor(leaseTtlMs / 3)));
        const timer = setInterval(() => {
          renew(record.id).catch(onError);
        }, intervalMs);
        timer.unref?.();
        return () => clearInterval(timer);
      },
    };
  }

  async function acquireUnlocked(request = {}, context = {}) {
      const nowMs = now();
      const mode = String(context.mode || request.instanceMode || "parallel").toLowerCase() === "replace" ? "replace" : "parallel";
      const state = await readState(mode);
      const expiredLeaseIds = pruneExpiredLeases(state, nowMs);
      const policy = await getPolicy();
      const reserveMb = policy.reserveMb;
      const maxUtilization = normalizeMaxUtilization(policy.maxUtilizationPct);
      const retiredLeaseIds = new Set((Array.isArray(request.retireLeaseIds) ? request.retireLeaseIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean));
      let status;
      try {
        status = await getGpuStatus?.();
      } catch (error) {
        if (expiredLeaseIds.length) await saveState(state, nowMs);
        throw createGpuAdmissionError(
          "vram_telemetry_unavailable",
          `Live GPU telemetry is unavailable; ${launchPhrase(mode)} is blocked without changing existing containers.`,
          503,
          { safetyPolicy: "fail_closed_parallel", cause: String(error?.message || "gpu_probe_failed") },
        );
      }
      const gpus = normalizeGpuTelemetry(status || {});
      if (status?.ok === false || !gpus.length) {
        if (expiredLeaseIds.length) await saveState(state, nowMs);
        throw createGpuAdmissionError(
          "vram_telemetry_unavailable",
          `Live per-GPU memory telemetry is unavailable; ${launchPhrase(mode)} is blocked without changing existing containers.`,
          503,
          { safetyPolicy: "fail_closed_parallel", cause: String(status?.text || "no_gpu_memory_data") },
        );
      }
      const { decisions, maxFraction, worstOf } = admissionDecisions(request, gpus, {
        state, mode, retiredLeaseIds, reserveMb, maxUtilization, startupMarginMb,
      });
      const rejected = decisions.filter((decision) => decision.verdict === "block");
      if (rejected.length) {
        if (expiredLeaseIds.length) await saveState(state, nowMs);
        throw createGpuAdmissionError(
          "insufficient_vram",
          formatGpuAdmissionMessage({ ...worstOf(rejected), verdict: "block" }, request, { mode }),
          409,
          {
            safetyPolicy: "fail_closed_parallel",
            mode,
            maxFraction,
            reserveMb,
            maxUtilizationPct: Math.round(maxUtilization * 10000) / 100,
            startupMarginMb,
            engine: String(request.engine || ""),
            instanceId: String(request.instanceId || ""),
            estimatePolicy: String(request.estimatePolicy || "configured_gpu_fraction"),
            gpus: decisions,
            knobs: admissionKnobs(request, maxFraction),
          },
        );
      }
      const clampedDecisions = decisions.filter((decision) => decision.clamped);
      const warning = clampedDecisions.length
        ? formatGpuAdmissionMessage({ ...worstOf(clampedDecisions), verdict: "warn" }, request, { mode })
        : "";

      // Replacement admission runs only after the exact target container has
      // been stopped under the same global lock. Its old cooldown/pending lease
      // is therefore no longer protecting live VRAM and can be retired as part
      // of the same state transaction that creates the successor lease.
      for (const leaseId of retiredLeaseIds) delete state.leases[leaseId];

      const leaseId = crypto.randomUUID();
      const expiresAt = new Date(nowMs + leaseTtlMs).toISOString();
      const record = {
        id: leaseId,
        state: "pending",
        managerId: String(request.managerId || managerId),
        engine: String(request.engine || ""),
        instanceId: String(request.instanceId || "parallel").slice(0, 120),
        containerName: String(request.containerName || "").slice(0, 160),
        model: String(request.model || "").slice(0, 240),
        policy: "host_atomic_vram_admission",
        estimatePolicy: String(request.estimatePolicy || "configured_gpu_fraction"),
        // requestedMb is the reserved amount, which is what peers count as
        // pending; estimateMb keeps the unclamped request for diagnostics.
        requestedTotalMb: decisions.reduce((sum, item) => sum + item.reservedMb, 0),
        verdict: clampedDecisions.length ? "warn" : "ok",
        clamped: clampedDecisions.length > 0,
        ...(warning ? { warning } : {}),
        reservations: decisions.map((item) => ({
          gpuId: item.gpuId,
          gpuIndex: item.gpuIndex,
          requestedMb: item.reservedMb,
          estimateMb: item.requestedMb,
          availableMb: item.availableMb,
          reservedMb: item.reservedMb,
          clamped: item.clamped,
          verdict: item.verdict,
        })),
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
        expiresAt,
        pid: process.pid,
      };
      state.leases[leaseId] = record;
      await saveState(state, nowMs);
      return decorateLease(record);
  }

  async function acquire(request = {}) {
    return withAdmissionLock(() => acquireUnlocked(request), { mode: request.instanceMode });
  }

  async function acquireAfterPrepare(request = {}, prepare = null) {
    if (typeof prepare !== "function") throw new TypeError("prepare is required");
    return withAdmissionLock(async () => {
      let context = null;
      try {
        // The old container is stopped while every other manager is excluded
        // from admission. Telemetry and the successor reservation are then
        // committed before the lock is released, so no peer can claim the
        // temporarily freed VRAM in between.
        context = await prepare(request);
        const lease = await acquireUnlocked(request, { mode: "replace" });
        return { lease, context };
      } catch (error) {
        if (context && typeof context.rollback === "function") {
          try {
            await context.rollback(error);
          } catch (rollbackError) {
            error.rollbackError = rollbackError;
          }
        }
        throw error;
      }
    }, { mode: "replace" });
  }

  /**
   * evaluate(request, { mode?, releasedMbByGpu? }) → the admission decision a
   * launch would get now, for the launch plan (01-engines §11 step 9). It
   * reads the leases, the policy and live telemetry, takes no lock and writes
   * nothing: expired leases are only ignored, never pruned. A replace-mode
   * preview runs before the old container stops, so the target container's
   * own leases are not counted and releasedMbByGpu (what it holds now) is
   * added back to the telemetry. Problems that would fail acquire with
   * something other than insufficient_vram give verdict "unknown" with their
   * code instead of throwing.
   * → { verdict: ok|warn|block|unknown, code?, message, mode, clamped,
   *     requestedMb, reservedMb, availableMb, maxFraction, gpus[] }
   */
  async function evaluate(request = {}, options = {}) {
    const mode = String(options.mode || request.instanceMode || "parallel").toLowerCase() === "replace" ? "replace" : "parallel";
    const result = {
      verdict: "unknown",
      message: "",
      mode,
      clamped: false,
      requestedMb: null,
      reservedMb: null,
      availableMb: null,
      maxFraction: null,
      gpus: [],
    };
    try {
      const nowMs = now();
      const state = await readState(mode);
      pruneExpiredLeases(state, nowMs);
      const policy = await getPolicy();
      let status;
      try {
        status = await getGpuStatus?.();
      } catch (error) {
        throw createGpuAdmissionError("vram_telemetry_unavailable", `Live GPU telemetry is unavailable: ${error?.message || "gpu_probe_failed"}`, 503);
      }
      const gpus = applyReleasedMemory(normalizeGpuTelemetry(status || {}), options.releasedMbByGpu);
      if (status?.ok === false || !gpus.length) {
        throw createGpuAdmissionError("vram_telemetry_unavailable", "Live per-GPU memory telemetry is unavailable.", 503);
      }
      const excluded = new Set((Array.isArray(request.retireLeaseIds) ? request.retireLeaseIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean));
      const target = String(request.containerName || "");
      if (mode === "replace" && target) {
        for (const [leaseId, lease] of Object.entries(state.leases || {})) {
          if (String(lease?.containerName || "") === target) excluded.add(leaseId);
        }
      }
      const { decisions, maxFraction, worstOf } = admissionDecisions(request, gpus, {
        state,
        mode,
        retiredLeaseIds: excluded,
        reserveMb: policy.reserveMb,
        maxUtilization: normalizeMaxUtilization(policy.maxUtilizationPct),
        startupMarginMb,
      });
      const rejected = decisions.filter((decision) => decision.verdict === "block");
      const clampedDecisions = decisions.filter((decision) => decision.clamped);
      const verdict = rejected.length ? "block" : clampedDecisions.length ? "warn" : "ok";
      const worst = rejected.length ? rejected : clampedDecisions;
      return {
        ...result,
        verdict,
        message: worst.length ? formatGpuAdmissionMessage({ ...worstOf(worst), verdict }, request, { mode }) : "",
        clamped: clampedDecisions.length > 0,
        requestedMb: decisions.reduce((sum, item) => sum + item.requestedMb, 0),
        reservedMb: decisions.reduce((sum, item) => sum + item.reservedMb, 0),
        availableMb: Math.min(...decisions.map((item) => item.availableMb)),
        maxFraction,
        gpus: decisions,
      };
    } catch (error) {
      return { ...result, code: String(error?.code || "vram_admission_unavailable"), message: String(error?.message || error) };
    }
  }

  async function renew(leaseId) {
    return withAdmissionLock(async () => {
      const nowMs = now();
      const state = await readState();
      pruneExpiredLeases(state, nowMs);
      const lease = state.leases[leaseId];
      if (!lease || lease.state !== "pending") {
        await saveState(state, nowMs);
        return { renewed: false, id: leaseId };
      }
      lease.updatedAt = new Date(nowMs).toISOString();
      lease.expiresAt = new Date(nowMs + leaseTtlMs).toISOString();
      await saveState(state, nowMs);
      return { renewed: true, id: leaseId, expiresAt: lease.expiresAt };
    });
  }

  async function commit(leaseId, metadata = {}) {
    return withAdmissionLock(async () => {
      const nowMs = now();
      const state = await readState();
      pruneExpiredLeases(state, nowMs);
      const lease = state.leases[leaseId];
      if (!lease) {
        await saveState(state, nowMs);
        return { committed: false, id: leaseId };
      }
      if (committedCooldownMs <= 0) {
        delete state.leases[leaseId];
      } else {
        lease.state = "committed";
        lease.jobId = String(metadata.jobId || lease.jobId || "").slice(0, 120);
        lease.containerName = String(metadata.containerName || lease.containerName || "").slice(0, 160);
        lease.committedAt = new Date(nowMs).toISOString();
        lease.updatedAt = lease.committedAt;
        lease.expiresAt = new Date(nowMs + committedCooldownMs).toISOString();
      }
      await saveState(state, nowMs);
      return { committed: true, id: leaseId, cooldownUntil: state.leases[leaseId]?.expiresAt || null };
    });
  }

  async function release(leaseId, reason = "released") {
    return withAdmissionLock(async () => {
      const nowMs = now();
      const state = await readState();
      pruneExpiredLeases(state, nowMs);
      const existed = Boolean(state.leases[leaseId]);
      if (existed) delete state.leases[leaseId];
      await saveState(state, nowMs);
      return { released: existed, id: leaseId, reason: String(reason || "released") };
    });
  }

  async function inspect() {
    return withAdmissionLock(async () => {
      const nowMs = now();
      const state = await readState();
      const expiredLeaseIds = pruneExpiredLeases(state, nowMs);
      if (expiredLeaseIds.length) await saveState(state, nowMs);
      return JSON.parse(JSON.stringify(state));
    });
  }

  return {
    root,
    stateFile,
    policyFile,
    reserveMb: configuredPolicy.reserveMb,
    maxUtilizationPct: configuredPolicy.maxUtilizationPct,
    startupMarginMb,
    leaseTtlMs,
    committedCooldownMs,
    acquire,
    acquireAfterPrepare,
    evaluate,
    renew,
    commit,
    release,
    inspect,
    getPolicy,
  };
}

module.exports = {
  ADMISSION_STATE_VERSION,
  DEFAULT_RESERVE_MB,
  DEFAULT_MAX_UTILIZATION_PCT,
  MAX_RESERVE_MB,
  DEFAULT_STARTUP_MARGIN_MB,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_COMMITTED_COOLDOWN_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STALE_LOCK_MS,
  DEFAULT_MIN_CLAMP_MB,
  SGLANG_FRACTION_OF_FREE_ESTIMATE_POLICY,
  STATIC_FRACTION_OF_FREE_POLICY,
  defaultGpuAdmissionRoot,
  defaultGpuAdmissionPolicyFile,
  normalizeMaxUtilization,
  normalizeGpuAdmissionPolicy,
  normalizeGpuTelemetry,
  decideGpuReservation,
  formatGpuAdmissionMessage,
  admissionKnobs,
  createGpuAdmissionError,
  acquireAdmissionDirectoryLock,
  createGpuAdmissionController,
};
