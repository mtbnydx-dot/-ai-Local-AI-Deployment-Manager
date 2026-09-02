"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = require("..");

async function tempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "gpu-admission-"));
}

async function removeRoot(root) {
  await fsp.rm(root, { recursive: true, force: true });
}

function telemetry(gpus) {
  return async () => ({ ok: true, gpus });
}

function runChildAcquire(root) {
  const modulePath = path.resolve(__dirname, "..", "gpu-admission.js");
  const source = `
    const { createGpuAdmissionController } = require(${JSON.stringify(modulePath)});
    const controller = createGpuAdmissionController({
      root: process.argv[1],
      managerId: process.argv[2],
      reserveMb: 8000,
      maxUtilizationPct: 85,
      startupMarginMb: 1000,
      leaseTtlMs: 60000,
      getGpuStatus: async () => ({ ok: true, gpus: [{ id: "0", totalMb: 100000, usedMb: 70000 }] }),
    });
    controller.acquire({ engine: process.argv[2], instanceId: "parallel", requestedMb: 9000 })
      .then(() => process.stdout.write("granted"))
      .catch((error) => process.stdout.write(error.code || "error"));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source, root, `manager-${cryptoSafeSuffix()}`], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
      else resolve(stdout.trim());
    });
  });
}

function cryptoSafeSuffix() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test("manager-core exports the host GPU admission controller", () => {
  assert.equal(typeof core.createGpuAdmissionController, "function");
  assert.equal(core.DEFAULT_MAX_UTILIZATION_PCT, 85);
});

test("cross-process atomic admission prevents two managers from overselling the same GPU", async () => {
  const root = await tempRoot();
  try {
    const results = await Promise.all([runChildAcquire(root), runChildAcquire(root)]);
    assert.deepEqual(results.sort(), ["granted", "insufficient_vram"]);
    const controller = core.createGpuAdmissionController({
      root,
      getGpuStatus: telemetry([{ id: "0", totalMb: 100000, usedMb: 70000 }]),
    });
    const state = await controller.inspect();
    assert.equal(Object.keys(state.leases).length, 1);
    assert.equal(Object.values(state.leases)[0].reservations[0].gpuId, "0");
    assert.equal(Object.values(state.leases)[0].reservations[0].gpuIndex, "0");
  } finally {
    await removeRoot(root);
  }
});

test("admission applies reserve and the 85 percent ceiling per GPU", async () => {
  const root = await tempRoot();
  try {
    const controller = core.createGpuAdmissionController({
      root,
      reserveMb: 8192,
      maxUtilizationPct: 85,
      startupMarginMb: 1024,
      getGpuStatus: telemetry([{ id: "0", totalMb: 97887, usedMb: 72682 }]),
    });
    await assert.rejects(
      () => controller.acquire({ engine: "vllm", instanceId: "vision", requestedMb: 20000 }),
      (error) => {
        assert.equal(error.code, "insufficient_vram");
        assert.equal(error.status, 409);
        assert.equal(error.details.maxUtilizationPct, 85);
        assert.ok(error.details.gpus[0].availableMb < 10000);
        assert.equal(error.details.gpus[0].requestedMb, 20000);
        return true;
      },
    );
  } finally {
    await removeRoot(root);
  }
});

test("admission reloads the shared reserve and safety line before every new launch", async () => {
  const root = await tempRoot();
  const policyFile = path.join(root, "fleet-settings.json");
  try {
    await core.writeJsonFile(policyFile, { reserveMb: 1000, maxUtilizationPct: 90 });
    const controller = core.createGpuAdmissionController({
      root: path.join(root, "leases"),
      policyFile,
      startupMarginMb: 0,
      getGpuStatus: telemetry([{ id: "0", totalMb: 10000, usedMb: 7000 }]),
    });
    assert.deepEqual(await controller.getPolicy(), { reserveMb: 1000, maxUtilizationPct: 90 });
    const granted = await controller.acquire({ engine: "vllm", instanceId: "first", requestedMb: 1500 });
    await granted.release("policy-test");

    await core.writeJsonFile(policyFile, { reserveMb: 2000, maxUtilizationPct: 90 });
    await assert.rejects(
      () => controller.acquire({ engine: "vllm", instanceId: "reserve-block", requestedMb: 1500 }),
      (error) => error.code === "insufficient_vram"
        && error.details.reserveMb === 2000
        && error.details.maxUtilizationPct === 90,
    );

    await core.writeJsonFile(policyFile, { reserveMb: 0, maxUtilizationPct: 80 });
    await assert.rejects(
      () => controller.acquire({ engine: "vllm", instanceId: "threshold-block", requestedMb: 1500 }),
      (error) => error.code === "insufficient_vram"
        && error.details.reserveMb === 0
        && error.details.maxUtilizationPct === 80,
    );
  } finally {
    await removeRoot(root);
  }
});

test("an unreadable shared policy fails closed without changing existing containers", async () => {
  const root = await tempRoot();
  const policyFile = path.join(root, "fleet-settings.json");
  try {
    await fsp.writeFile(policyFile, "{broken", "utf8");
    const controller = core.createGpuAdmissionController({
      root: path.join(root, "leases"),
      policyFile,
      getGpuStatus: telemetry([{ id: "0", totalMb: 10000, usedMb: 1000 }]),
    });
    await assert.rejects(
      () => controller.acquire({ requestedMb: 1000 }),
      (error) => error.code === "vram_admission_policy_unavailable"
        && error.status === 503
        && error.details.safetyPolicy === "fail_closed_parallel",
    );
  } finally {
    await removeRoot(root);
  }
});

test("pending reservations are isolated by GPU identifier", async () => {
  const root = await tempRoot();
  try {
    const controller = core.createGpuAdmissionController({
      root,
      reserveMb: 1000,
      maxUtilizationPct: 90,
      startupMarginMb: 500,
      getGpuStatus: telemetry([
        { id: "0", uuid: "GPU-A", totalMb: 24000, usedMb: 4000 },
        { id: "1", uuid: "GPU-B", totalMb: 24000, usedMb: 4000 },
      ]),
    });
    const first = await controller.acquire({ gpuIds: ["0"], requestedMb: 12000, instanceId: "a" });
    const second = await controller.acquire({ gpuIds: ["1"], requestedMb: 12000, instanceId: "b" });
    assert.equal(first.reservations[0].gpuId, "GPU-A");
    assert.equal(second.reservations[0].gpuId, "GPU-B");
    await first.release("test-finished");
    await second.release("test-finished");
    assert.equal(Object.keys((await controller.inspect()).leases).length, 0);
  } finally {
    await removeRoot(root);
  }
});

test("per-GPU estimates cannot be undercut by a smaller configured fraction", async () => {
  const root = await tempRoot();
  try {
    const controller = core.createGpuAdmissionController({
      root,
      reserveMb: 1000,
      maxUtilizationPct: 90,
      startupMarginMb: 500,
      getGpuStatus: telemetry([{ id: "0", totalMb: 24000, usedMb: 2000 }]),
    });
    const lease = await controller.acquire({
      gpuIds: ["0"],
      requestedFraction: 0.1,
      requestedMbByGpu: { "0": 9000 },
      estimatePolicy: "local_model_size",
    });
    assert.equal(lease.reservations[0].requestedMb, 9000);
    await lease.release("test-finished");
  } finally {
    await removeRoot(root);
  }
});

test("stale admission locks are retired atomically only after their owner is gone", async () => {
  const root = await tempRoot();
  const lockDir = path.join(root, "admission.lock");
  try {
    await fsp.mkdir(lockDir);
    await fsp.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ token: "orphan", pid: 2147483647 }), "utf8");
    const old = new Date(Date.now() - 20_000);
    await fsp.utimes(lockDir, old, old);
    await fsp.utimes(path.join(lockDir, "owner.json"), old, old);
    const release = await core.acquireAdmissionDirectoryLock(lockDir, { timeoutMs: 2000, staleMs: 10_000 });
    const owner = JSON.parse(await fsp.readFile(path.join(lockDir, "owner.json"), "utf8"));
    assert.notEqual(owner.token, "orphan");
    await release();
    await assert.rejects(() => fsp.stat(lockDir), { code: "ENOENT" });
  } finally {
    await removeRoot(root);
  }
});

test("an unreadable stale owner cannot retire a successor live lock", async () => {
  const root = await tempRoot();
  const lockDir = path.join(root, "admission.lock");
  const ownerFile = path.join(lockDir, "owner.json");
  const oldDir = `${lockDir}.old`;
  const originalReadFile = fsp.readFile;
  try {
    await fsp.mkdir(lockDir);
    await fsp.writeFile(ownerFile, JSON.stringify({ token: "dead-old", pid: 2147483647 }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(lockDir, old, old);
    await fsp.utimes(ownerFile, old, old);

    let injected = false;
    fsp.readFile = async function readFileWithReplacement(file, ...args) {
      if (!injected && path.resolve(String(file)) === path.resolve(ownerFile)) {
        injected = true;
        await fsp.rename(lockDir, oldDir);
        await fsp.mkdir(lockDir);
        await fsp.writeFile(ownerFile, JSON.stringify({ token: "live-replacement", pid: process.pid }), "utf8");
        const error = new Error("simulated Windows sharing violation");
        error.code = "EACCES";
        throw error;
      }
      return originalReadFile.call(this, file, ...args);
    };

    await assert.rejects(
      () => core.acquireAdmissionDirectoryLock(lockDir, { timeoutMs: 1000, staleMs: 10_000 }),
      { code: "vram_admission_lock_timeout" },
    );
    fsp.readFile = originalReadFile;
    const owner = JSON.parse(await fsp.readFile(ownerFile, "utf8"));
    assert.equal(owner.token, "live-replacement");
  } finally {
    fsp.readFile = originalReadFile;
    await removeRoot(root);
  }
});

test("an owner write failure does not leave an ownerless admission lock", async () => {
  const root = await tempRoot();
  const lockDir = path.join(root, "admission.lock");
  const ownerFile = path.join(lockDir, "owner.json");
  const originalWriteFile = fsp.writeFile;
  try {
    fsp.writeFile = async function failOwnerWrite(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(ownerFile)) {
        const error = new Error("simulated owner write failure");
        error.code = "EACCES";
        throw error;
      }
      return originalWriteFile.call(this, file, ...args);
    };
    await assert.rejects(
      () => core.acquireAdmissionDirectoryLock(lockDir, { timeoutMs: 1000, staleMs: 10_000 }),
      { code: "EACCES" },
    );
    await assert.rejects(() => fsp.stat(lockDir), { code: "ENOENT" });
  } finally {
    fsp.writeFile = originalWriteFile;
    await removeRoot(root);
  }
});

test("empty GPU selection uses one GPU unless the engine explicitly requests all visible GPUs", async () => {
  const root = await tempRoot();
  try {
    const controller = core.createGpuAdmissionController({
      root,
      reserveMb: 1000,
      maxUtilizationPct: 90,
      startupMarginMb: 500,
      getGpuStatus: telemetry([
        { id: "0", totalMb: 24000, usedMb: 2000 },
        { id: "1", totalMb: 24000, usedMb: 2000 },
      ]),
    });
    const single = await controller.acquire({ requestedMb: 1000, instanceId: "single" });
    assert.deepEqual(single.reservations.map((item) => item.gpuId), ["0"]);
    await single.release("test-finished");
    const all = await controller.acquire({ requestedMb: 1000, instanceId: "tensor", useAllGpus: true });
    assert.deepEqual(all.reservations.map((item) => item.gpuId), ["0", "1"]);
    await all.release("test-finished");
  } finally {
    await removeRoot(root);
  }
});

test("expired pending leases are reclaimed and committed leases keep only a short cooldown", async () => {
  const root = await tempRoot();
  let nowMs = Date.parse("2026-08-05T00:00:00.000Z");
  try {
    const controller = core.createGpuAdmissionController({
      root,
      now: () => nowMs,
      leaseTtlMs: 60000,
      committedCooldownMs: 30000,
      reserveMb: 1000,
      maxUtilizationPct: 90,
      startupMarginMb: 500,
      getGpuStatus: telemetry([{ id: "0", totalMb: 24000, usedMb: 4000 }]),
    });
    const crashed = await controller.acquire({ requestedMb: 12000, instanceId: "crashed" });
    await assert.rejects(() => controller.acquire({ requestedMb: 12000, instanceId: "blocked" }), { code: "insufficient_vram" });
    nowMs += 60001;
    const recovered = await controller.acquire({ requestedMb: 12000, instanceId: "recovered" });
    assert.notEqual(recovered.id, crashed.id);
    await recovered.commit({ jobId: "serve-1", containerName: "vllm-local-recovered" });
    let state = await controller.inspect();
    assert.equal(Object.keys(state.leases).length, 1);
    assert.equal(Object.values(state.leases)[0].state, "committed");
    nowMs += 30001;
    state = await controller.inspect();
    assert.equal(Object.keys(state.leases).length, 0);
  } finally {
    await removeRoot(root);
  }
});

test("replacement admission stops the target under the global lock and retires only its old lease", async () => {
  const root = await tempRoot();
  let usedMb = 0;
  try {
    const controller = core.createGpuAdmissionController({
      root,
      reserveMb: 1000,
      maxUtilizationPct: 90,
      startupMarginMb: 500,
      committedCooldownMs: 30_000,
      getGpuStatus: telemetry([{ id: "0", totalMb: 40_000, get usedMb() { return usedMb; } }]),
    });
    // telemetry() captures this object; update its live getter between phases.
    const oldLease = await controller.acquire({ requestedMb: 16_000, instanceId: "old" });
    await oldLease.commit({ containerName: "vllm-local" });
    usedMb = 16_000;
    await assert.rejects(
      () => controller.acquire({ requestedMb: 16_000, instanceId: "double-counted" }),
      { code: "insufficient_vram" },
    );

    let rolledBack = false;
    await assert.rejects(
      () => controller.acquireAfterPrepare({
        requestedMb: 38_000,
        instanceId: "too-large",
        retireLeaseIds: [oldLease.id],
      }, async () => {
        usedMb = 0;
        return {
          async rollback() {
            rolledBack = true;
            usedMb = 16_000;
          },
        };
      }),
      { code: "insufficient_vram" },
    );
    assert.equal(rolledBack, true);
    assert.equal(Object.hasOwn((await controller.inspect()).leases, oldLease.id), true);

    const prepared = await controller.acquireAfterPrepare({
      requestedMb: 16_000,
      instanceId: "replacement",
      retireLeaseIds: [oldLease.id],
    }, async () => {
      usedMb = 0;
      return { marker: "old-container-stopped" };
    });
    assert.equal(prepared.context.marker, "old-container-stopped");
    const state = await controller.inspect();
    assert.equal(Object.hasOwn(state.leases, oldLease.id), false);
    assert.deepEqual(Object.keys(state.leases), [prepared.lease.id]);
    await prepared.lease.release("test-finished");
  } finally {
    await removeRoot(root);
  }
});

test("renew keeps a long model load reservation alive past its original expiry", async () => {
  const root = await tempRoot();
  let nowMs = Date.parse("2026-08-05T01:00:00.000Z");
  try {
    const controller = core.createGpuAdmissionController({
      root,
      now: () => nowMs,
      leaseTtlMs: 60000,
      reserveMb: 1000,
      maxUtilizationPct: 90,
      startupMarginMb: 500,
      getGpuStatus: telemetry([{ id: "0", totalMb: 24000, usedMb: 4000 }]),
    });
    const loading = await controller.acquire({ requestedMb: 12000, instanceId: "slow-load" });
    nowMs += 50000;
    assert.equal((await loading.renew()).renewed, true);
    nowMs += 20000;
    await assert.rejects(() => controller.acquire({ requestedMb: 12000, instanceId: "must-wait" }), { code: "insufficient_vram" });
    await loading.release("test-finished");
  } finally {
    await removeRoot(root);
  }
});

test("missing telemetry fails closed with a structured error", async () => {
  const root = await tempRoot();
  try {
    const controller = core.createGpuAdmissionController({
      root,
      getGpuStatus: async () => ({ ok: false, text: "nvidia-smi missing", gpus: [] }),
    });
    await assert.rejects(
      () => controller.acquire({ requestedMb: 1000 }),
      (error) => error.code === "vram_telemetry_unavailable"
        && error.status === 503
        && error.details.safetyPolicy === "fail_closed_parallel",
    );
  } finally {
    await removeRoot(root);
  }
});

test("runtime routes preserve structured admission errors", async () => {
  const routes = new Map();
  const app = {
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    get(route, handler) { routes.set(`GET ${route}`, handler); },
  };
  core.registerRuntimeRoutes(app, {
    startRuntime: async () => {
      throw core.createGpuAdmissionError("insufficient_vram", "not enough safe VRAM", 409, { availableMb: 9000 });
    },
  });
  const response = {
    statusCode: 0,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await routes.get("POST /api/start")({ body: {} }, response);
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.payload, {
    error: "not enough safe VRAM",
    code: "insufficient_vram",
    details: { availableMb: 9000 },
  });
});
