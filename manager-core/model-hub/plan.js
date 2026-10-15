"use strict";

// The plan sheet (03 §13.4): everything the console shows before a download
// starts, computed without side effects. index.js resolves a request (fresh
// manifest, selection, target); buildPlan() turns that into the plan body and
// createPlanCache() keeps plans for 10 minutes so POST /downloads can take a
// planId and re-validate it.
//
//   createPlanner({ fit, disk, settings, queue, auth, discovery, clock })
//     → { build(resolved, input, { withFit }) → PlanBody (without ok, planId, expiresAt) }
//   createPlanCache({ clock, ttlMs = 10 min, max = 64 }) → { put(entry), get(id), delete(id), size }
//
// Blocking items stop the download (disk, gated access, the folder already
// being downloaded); warnings do not (custom code, a duplicate, a model that
// will not fit, a source change).

const crypto = require("node:crypto");
const { describeHubError } = require("./errors");
const { computeFilesetHash, identityKeyFor } = require("./library");
const { TERMINAL_STATES } = require("./queue");
const { inspectionProviderFor } = require("./search");
const { DEFAULT_CONTEXT_TOKENS } = require("./fit");

const PLAN_TTL_MS = 10 * 60 * 1000;
const PLAN_CACHE_MAX = 64;
const ETA_SAMPLE = 5;
const GIB = 1024 ** 3;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function newPlanId() {
  const bytes = crypto.randomBytes(16);
  let id = "";
  for (const byte of bytes) id += BASE32[byte % 32];
  return `pln_${id}`;
}

function gb(bytes) {
  return `${(Number(bytes) / GIB).toFixed(1)} GB`;
}

function pathKey(value) {
  return String(value || "").replace(/[\\/]+$/, "").toLowerCase();
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A small LRU of plans with a TTL; ids are unguessable (pln_ + 16 base32). */
function createPlanCache({ clock = Date, ttlMs = PLAN_TTL_MS, max = PLAN_CACHE_MAX } = {}) {
  const plans = new Map();
  const now = () => clock.now();

  function sweep() {
    const at = now();
    for (const [id, entry] of plans) if (entry.expiresAtMs <= at) plans.delete(id);
  }

  return {
    put(entry) {
      sweep();
      const planId = newPlanId();
      const createdAtMs = now();
      const stored = { ...entry, planId, createdAtMs, expiresAtMs: createdAtMs + ttlMs };
      plans.set(planId, stored);
      while (plans.size > max) plans.delete(plans.keys().next().value);
      return { planId, expiresAt: new Date(stored.expiresAtMs).toISOString() };
    },
    // A hit refreshes the LRU position, not the expiry.
    get(planId) {
      sweep();
      const entry = plans.get(String(planId || ""));
      if (!entry) return null;
      plans.delete(entry.planId);
      plans.set(entry.planId, entry);
      return entry;
    },
    delete(planId) {
      return plans.delete(String(planId || ""));
    },
    get size() {
      sweep();
      return plans.size;
    },
  };
}

function gatedCopy(status) {
  if (status === "login_required") {
    const copy = describeHubError("hf_login_required");
    return { code: "hf_login_required", message: "This repository is gated and needs a Hugging Face login.", hint: copy?.hint?.en || "Sign in to Hugging Face first.", actions: ["sign-in"] };
  }
  if (status === "approval_required") {
    const copy = describeHubError("hf_approval_required");
    return { code: "hf_approval_required", message: "This repository is gated and your account has not been granted access yet.", hint: copy?.hint?.en || "Request access on the model page.", actions: ["open-approval"] };
  }
  return {
    code: "gated_official_required",
    message: "This repository is gated and can only be downloaded from the official Hugging Face endpoint.",
    hint: "Switch the source to the official endpoint and sign in.",
    actions: ["switch-source"],
  };
}

function createPlanner(options = {}) {
  const fit = options.fit;
  const disk = options.disk || null;
  const getSettings = typeof options.settings === "function" ? options.settings : () => ({});
  const queue = options.queue || null;
  const auth = options.auth || null;
  const discovery = options.discovery;
  const runAfter = options.runAfter || null;

  function openJobs() {
    try {
      return queue ? queue.list({ limit: 200 }).jobs || [] : [];
    } catch {
      return [];
    }
  }

  function recentSpeeds(source) {
    try {
      const jobs = queue ? queue.list({ state: "ready", limit: 200 }).jobs || [] : [];
      return jobs
        .filter((job) => job.transfer?.options?.source === source && Number(job.progress?.speedEmaBps) > 0)
        .sort((a, b) => String(b.finishedAt || "").localeCompare(String(a.finishedAt || "")))
        .slice(0, ETA_SAMPLE)
        .map((job) => Number(job.progress.speedEmaBps));
    } catch {
      return [];
    }
  }

  async function accessFor(resolved, artifactKey) {
    const manifest = resolved.manifest;
    const base = { gated: Boolean(manifest.gated), status: "not_required", credentialMode: resolved.credentialMode, authorizationUrl: null };
    if (!manifest.gated || resolved.namespace !== "huggingface") return base;
    if (resolved.source !== "huggingface") return { ...base, status: "official_required" };
    if (resolved.credentialMode === "none") return { ...base, status: "login_required" };
    if (!auth || typeof auth.access !== "function") return { ...base, status: "unknown" };
    try {
      const result = await auth.access({ repo: resolved.repo, artifactKey, revision: resolved.revision, tokenRef: resolved.tokenRef || undefined });
      const status = { granted: "granted", login_required: "login_required", invalid_token: "login_required", approval_required: "approval_required" }[result?.status] || "unknown";
      return { ...base, status, authorizationUrl: result?.authorizationUrl || null };
    } catch {
      return { ...base, status: "unknown" };
    }
  }

  // What the library and the queue already hold for this selection.
  function existingFor(resolved, states) {
    const { namespace, repo, artifact, manifest, localDir } = resolved;
    const files = artifact.files.map((file) => ({ path: file.path, size: Number(file.size) || 0, sha256: file.sha256 || null, gitOid: file.gitOid || null }));
    const identity = identityKeyFor({ provider: namespace, repo, revisionSha: manifest.revisionSha, confidence: "declared" }, files.length ? computeFilesetHash(files) : null);
    const entries = states.entriesFor(namespace, repo);
    const same = identity ? entries.find((entry) => entry.identityKey === identity && entry.verification?.status !== "fail") : null;
    if (same) {
      const here = pathKey(same.path) === pathKey(localDir);
      return {
        state: here ? "present" : "duplicate-elsewhere",
        entryId: same.id || null,
        message: here
          ? "These exact files are already in this folder."
          : `The same files are already in the library${same.rootLabel ? ` (${same.rootLabel})` : ""}.`,
      };
    }
    const state = states.forArtifact(namespace, repo, { artifactKey: artifact.artifactKey, quant: artifact.quant, format: artifact.format }, manifest.revisionSha);
    const message = {
      absent: "",
      present: "An older copy of this selection is already in the library.",
      partial: "An unfinished copy or download of this model exists.",
      "update-available": "A copy of this model is in the library; this revision is newer.",
    }[state.state] || "";
    return { state: state.state, entryId: state.entryId, message };
  }

  /**
   * build(resolved, input, { withFit }) → the plan body (03 §13.4) without
   * ok, planId and expiresAt. `resolved` is index.js's resolved request.
   */
  async function build(resolved, input = {}, { withFit = true } = {}) {
    const settings = getSettings() || {};
    const { artifact, manifest } = resolved;
    const states = await discovery.libraryStates();
    const existing = existingFor(resolved, states);
    const totalBytes = Number(artifact.totalBytes) || 0;
    const bytesToDownload = existing.state === "present" ? 0 : totalBytes;

    // Target and disk.
    const volume = resolved.volume || null;
    let free = null;
    if (disk && typeof disk.freeBytes === "function") {
      try {
        const measured = await Promise.resolve(disk.freeBytes(resolved.localDir, { target: { volume } }));
        free = Number.isFinite(Number(measured)) && measured !== null ? Number(measured) : null;
      } catch {
        free = null;
      }
    }
    const reserve = free !== null && disk && typeof disk.reserveBytes === "function" ? Number(disk.reserveBytes(free, settings)) : null;
    const jobs = openJobs();
    const queued = jobs
      .filter((job) => !TERMINAL_STATES.includes(job.state) && job.state !== "paused" && (job.target?.volume || null) === volume)
      .reduce((sum, job) => sum + Math.max(0, (Number(job.artifact?.totalBytes) || 0) - (Number(job.progress?.bytesDone) || 0)), 0);
    const target = {
      rootId: resolved.root?.id || null,
      rootLabel: resolved.root?.label || null,
      localDir: resolved.localDir,
      volume,
      freeBytes: free,
      reserveBytes: reserve,
      queuedOnVolumeBytes: queued,
      freeAfterBytes: free === null ? null : free - queued - bytesToDownload,
    };

    const access = await accessFor(resolved, artifact.artifactKey);

    // Fit and compatibility from the selected artifact's own card.
    let fitBody = {};
    let compatibility = [];
    let card = null;
    if (withFit) {
      const request = isPlainObject(input.fit) ? input.fit : {};
      const contextTokens = Number(request.contextTokens) > 0 ? Number(request.contextTokens) : DEFAULT_CONTEXT_TOKENS;
      const gpuIds = Array.isArray(request.gpuIds) && request.gpuIds.length ? request.gpuIds.map(String) : null;
      const engineId = request.engineId ? String(request.engineId) : fit.engineFor(artifact.format);
      card = await fit.inspect({
        provider: inspectionProviderFor(resolved.metadata, manifest),
        namespace: resolved.namespace,
        repo: resolved.repo,
        revision: resolved.revision,
        revisionSha: manifest.revisionSha,
        files: artifact.files.map((file) => file.path),
      });
      const paramsB = (Number(manifest.structured?.safetensors?.total) || Number(manifest.structured?.gguf?.total) || 0) / 1e9;
      fitBody = await fit.fitFor({
        card,
        legacy: !card && paramsB > 0 && artifact.weightBytes > 0 ? { paramsB, bytesPerParam: artifact.weightBytes / (paramsB * 1e9) } : null,
        bytes: artifact.weightBytes,
        format: artifact.format,
        engineId,
        contextTokens,
        gpuIds,
      });
      compatibility = await fit.compatibilityFor(card);
    }

    // ETA: the median speed of the last five finished jobs from this source.
    const basisBps = median(recentSpeeds(resolved.source));
    const eta = basisBps && bytesToDownload > 0
      ? { seconds: Math.ceil(bytesToDownload / basisBps), basisBps: Math.round(basisBps), basis: "recent-average" }
      : { seconds: bytesToDownload === 0 ? 0 : null, basisBps: basisBps ? Math.round(basisBps) : null, basis: basisBps ? "recent-average" : "unknown" };

    // Download & Run (03 §11): the advisory prospective plan from the remote card.
    // A manager that cannot plan it throws 422 run_after_unavailable.
    const runAfterBody = input.runAfter && runAfter && typeof runAfter.advise === "function"
      ? await runAfter.advise({ request: input.runAfter, card })
      : (input.runAfter ?? null);

    const blocking = [];
    const warnings = [];
    if (free !== null && reserve !== null && bytesToDownload > free - reserve) {
      blocking.push({
        code: "disk_full",
        message: `The target drive has ${gb(free)} free; this download needs ${gb(bytesToDownload)} and the drive keeps a ${gb(reserve)} reserve.`,
        hint: "Choose another model folder or free some space.",
        actions: ["choose-root", "open-storage"],
      });
    } else if (free !== null && reserve !== null && queued > 0 && bytesToDownload > free - reserve - queued) {
      warnings.push({
        code: "disk_queue_pressure",
        message: `Downloads already queued for this drive need ${gb(queued)}; this one will wait for them to finish.`,
      });
    }
    if (["login_required", "approval_required", "official_required"].includes(access.status)) blocking.push(gatedCopy(access.status));
    else if (access.gated && access.status === "unknown") {
      warnings.push({ code: "access_unchecked", message: "Access to this gated repository could not be checked; the download may need a login or approval." });
    }
    const running = jobs.find((job) => job.target?.localDir && pathKey(job.target.localDir) === pathKey(resolved.localDir));
    if (running) {
      blocking.push({
        code: "already_downloading",
        message: "This folder is already being downloaded.",
        hint: "Wait for the running download, or pick another folder name.",
        actions: ["open-downloads"],
        existingJobId: running.id,
      });
    }
    if (artifact.customCodeFiles?.length) {
      warnings.push({
        code: "custom_code",
        message: "This repository ships Python files that run with trust_remote_code",
        files: [...artifact.customCodeFiles],
      });
    }
    if (existing.state === "present" || existing.state === "duplicate-elsewhere") {
      warnings.push({ code: "duplicate", message: existing.message, entryId: existing.entryId });
    }
    if (fitBody.label === "wont-fit") warnings.push({ code: "fit_wont_fit", message: "This selection is estimated not to fit in GPU memory at the chosen context." });
    else if (fitBody.label === "spills") warnings.push({ code: "fit_spills", message: "This selection fits only by spilling into system memory, which is slower." });
    if (artifact.complete === false) warnings.push({ code: "incomplete_shards", message: "The shard set of this selection is incomplete." });
    for (const note of resolved.notes || []) warnings.push({ code: "source_changed", message: note });
    for (const warning of manifest.warnings || []) {
      if (warning?.code === "mirror_fallback") warnings.push({ code: "mirror_fallback", message: warning.message?.en || "Metadata came from the mirror." });
    }

    return {
      artifact: {
        artifactKey: artifact.artifactKey,
        files: artifact.files.map((file) => ({ path: file.path, size: Number(file.size) || 0, role: file.role || "weight" })),
        totalBytes,
        bytesToDownload,
        revisionSha: manifest.revisionSha || null,
      },
      target,
      existing,
      source: { chosen: resolved.source, endpoint: resolved.endpoint, reason: resolved.sourceReason, probe: null },
      access,
      fit: fitBody,
      compatibility,
      eta,
      runAfter: runAfterBody,
      blocking,
      warnings,
    };
  }

  return { build };
}

module.exports = { PLAN_CACHE_MAX, PLAN_TTL_MS, createPlanCache, createPlanner, newPlanId };
