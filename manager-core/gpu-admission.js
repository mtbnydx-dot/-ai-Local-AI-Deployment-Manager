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
          "GPU admission is busy; parallel launch was not started and existing containers were not changed.",
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

function normalizeAdmissionState(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createGpuAdmissionError(
      "vram_admission_state_unavailable",
      "GPU admission state is invalid; parallel launch is blocked without changing existing containers.",
      503,
      { safetyPolicy: "fail_closed_parallel" },
    );
  }
  if (value.leases !== undefined && (!value.leases || typeof value.leases !== "object" || Array.isArray(value.leases))) {
    throw createGpuAdmissionError(
      "vram_admission_state_unavailable",
      "GPU admission lease data is invalid; parallel launch is blocked without changing existing containers.",
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

function selectAdmissionGpus(gpus, request = {}) {
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
      `Selected GPU telemetry is unavailable: ${missing.join(", ")}. Parallel launch is blocked without changing existing containers.`,
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

function requestedMbForGpu(request, gpu) {
  const byGpu = request.requestedMbByGpu && typeof request.requestedMbByGpu === "object"
    ? request.requestedMbByGpu
    : null;
  const mapped = byGpu
    ? gpu.aliases.map((id) => Number(byGpu[id])).find((value) => Number.isFinite(value) && value > 0)
    : null;
  const requestedMb = Number(request.requestedMb);
  const fraction = Number(request.requestedFraction);
  const candidates = Number.isFinite(mapped) && mapped > 0 ? [mapped] : [requestedMb];
  if (Number.isFinite(fraction) && fraction > 0 && fraction <= 1) candidates.push(gpu.totalMb * fraction);
  const trustworthy = candidates.filter((value) => Number.isFinite(value) && value > 0);
  if (trustworthy.length) return Math.ceil(Math.max(...trustworthy));
  throw createGpuAdmissionError(
    "vram_estimate_unavailable",
    "A trustworthy VRAM reservation estimate is unavailable; parallel launch is blocked without changing existing containers.",
    422,
    {
      safetyPolicy: "fail_closed_parallel",
      estimatePolicy: String(request.estimatePolicy || "missing"),
    },
  );
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

  async function readState() {
    try {
      const stored = await readJsonFile(stateFile, { version: ADMISSION_STATE_VERSION, leases: {} });
      return normalizeAdmissionState(stored);
    } catch (error) {
      if (error?.code === "vram_admission_state_unavailable") throw error;
      throw createGpuAdmissionError(
        "vram_admission_state_unavailable",
        "GPU admission state cannot be read safely; parallel launch is blocked without changing existing containers.",
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

  async function withAdmissionLock(work) {
    await fsp.mkdir(root, { recursive: true });
    const releaseLock = await acquireAdmissionDirectoryLock(lockDir, { timeoutMs: lockTimeoutMs, staleMs: staleLockMs });
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

  async function acquireUnlocked(request = {}) {
      const nowMs = now();
      const state = await readState();
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
          "Live GPU telemetry is unavailable; parallel launch is blocked without changing existing containers.",
          503,
          { safetyPolicy: "fail_closed_parallel", cause: String(error?.message || "gpu_probe_failed") },
        );
      }
      const gpus = normalizeGpuTelemetry(status || {});
      if (status?.ok === false || !gpus.length) {
        if (expiredLeaseIds.length) await saveState(state, nowMs);
        throw createGpuAdmissionError(
          "vram_telemetry_unavailable",
          "Live per-GPU memory telemetry is unavailable; parallel launch is blocked without changing existing containers.",
          503,
          { safetyPolicy: "fail_closed_parallel", cause: String(status?.text || "no_gpu_memory_data") },
        );
      }
      const selected = selectAdmissionGpus(gpus, request);
      if (!selected.length) {
        throw createGpuAdmissionError(
          "gpu_selection_unavailable",
          "No GPU is available for the requested parallel instance.",
          503,
          { safetyPolicy: "fail_closed_parallel" },
        );
      }

      const decisions = selected.map((gpu) => {
        const pendingMb = activeReservedMb(state, gpu.key, retiredLeaseIds);
        const requestedMb = requestedMbForGpu(request, gpu);
        const freeBudgetMb = Math.floor(gpu.freeMb - reserveMb - pendingMb);
        const thresholdBudgetMb = Math.floor((gpu.totalMb * maxUtilization) - gpu.usedMb - pendingMb - startupMarginMb);
        const availableMb = Math.max(0, Math.min(freeBudgetMb, thresholdBudgetMb));
        return {
          gpuId: gpu.key,
          gpuIndex: gpu.id,
          name: gpu.name,
          totalMb: gpu.totalMb,
          usedMb: gpu.usedMb,
          freeMb: gpu.freeMb,
          pendingMb,
          requestedMb,
          availableMb,
          freeBudgetMb: Math.max(0, freeBudgetMb),
          thresholdBudgetMb: Math.max(0, thresholdBudgetMb),
        };
      });
      const rejected = decisions.filter((decision) => decision.requestedMb > decision.availableMb);
      if (rejected.length) {
        if (expiredLeaseIds.length) await saveState(state, nowMs);
        throw createGpuAdmissionError(
          "insufficient_vram",
          `Parallel launch needs ${Math.max(...rejected.map((item) => item.requestedMb))} MiB on a selected GPU, but the safe admission budget is ${Math.min(...rejected.map((item) => item.availableMb))} MiB. Existing model containers were not changed.`,
          409,
          {
            safetyPolicy: "fail_closed_parallel",
            reserveMb,
            maxUtilizationPct: Math.round(maxUtilization * 10000) / 100,
            startupMarginMb,
            engine: String(request.engine || ""),
            instanceId: String(request.instanceId || ""),
            estimatePolicy: String(request.estimatePolicy || "configured_gpu_fraction"),
            gpus: decisions,
          },
        );
      }

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
        requestedTotalMb: decisions.reduce((sum, item) => sum + item.requestedMb, 0),
        reservations: decisions.map((item) => ({ gpuId: item.gpuId, gpuIndex: item.gpuIndex, requestedMb: item.requestedMb })),
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
    return withAdmissionLock(() => acquireUnlocked(request));
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
        const lease = await acquireUnlocked(request);
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
    });
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
  defaultGpuAdmissionRoot,
  defaultGpuAdmissionPolicyFile,
  normalizeMaxUtilization,
  normalizeGpuAdmissionPolicy,
  normalizeGpuTelemetry,
  createGpuAdmissionError,
  acquireAdmissionDirectoryLock,
  createGpuAdmissionController,
};
