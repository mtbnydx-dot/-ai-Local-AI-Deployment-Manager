// The rules behind the download plan sheet (07 §6.4, 03 §13.4): the request a
// form becomes, the choices a repository offers (artifacts, companions,
// roots), the free-space bars, and what a blocker or a failed planning call
// lets the person fix. Pure, so it can be tested without a DOM.

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function bytesOf(value) {
  const number = Number(value);
  return number > 0 ? number : 0;
}

export const PLAN_SOURCES = Object.freeze(["auto", "huggingface", "hf-mirror", "modelscope"]);

/** The sources a repository of a provider can be fetched from (03 §6.2): a ModelScope repository only comes from ModelScope. */
export function sourceChoices(provider) {
  return provider === "modelscope" ? ["auto", "modelscope"] : ["auto", "huggingface", "hf-mirror"];
}

/**
 * POST /api/hub/plan body (03 §13.4) of the sheet's form: `{ provider, repo,
 * artifactKey, companions, rootId, outputName, source, credentialMode, hfToken,
 * remember, runAfter: { engineId } | null, priority }`. An empty choice is
 * left out so the hub's default (the default root, `owner-name`, `auto`)
 * applies. The token is only sent for a temporary-token plan.
 */
export function planRequest(form) {
  const token = form.credentialMode === "temp-token" ? text(form.hfToken).trim() : "";
  return {
    provider: form.provider,
    repo: form.repo,
    revision: text(form.revision) || "main",
    selection: { artifactKey: form.artifactKey, companions: list(form.companions), files: null },
    target: { rootId: text(form.rootId) || null, outputName: text(form.outputName).trim() || null },
    source: PLAN_SOURCES.includes(form.source) ? form.source : "auto",
    credential: { mode: form.credentialMode === "temp-token" && token ? "temp-token" : "auto", ...(token ? { hfToken: token, remember: form.remember === true } : {}) },
    runAfter: isObject(form.runAfter) && text(form.runAfter.engineId)
      ? { engineId: form.runAfter.engineId, managerId: null, recipeId: null, values: {}, acceptWarnings: false, allowReplace: false }
      : null,
    priority: ["high", "normal", "low"].includes(form.priority) ? form.priority : "normal",
  };
}

// A short fingerprint (FNV-1a), so a changed token plans again without the token being part of the key.
function fingerprint(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return value ? (hash >>> 0).toString(16) : "";
}

/** A key that is equal for equal plans, without the token, so identical requests are sent once. */
export function planKey(body) {
  const credential = isObject(body.credential) ? { mode: body.credential.mode, token: fingerprint(body.credential.hfToken), remember: body.credential.remember === true } : null;
  return JSON.stringify({ ...body, credential });
}

/**
 * The artifacts of a repository detail (03 §13.3) as the quant radio table:
 * label, size, fit at the planned context, engines, library state and the
 * companion files it lists.
 */
export function artifactChoices(artifacts) {
  return list(artifacts).filter((item) => isObject(item) && text(item.artifactKey)).map((item) => ({
    key: item.artifactKey,
    label: text(item.label) || text(item.quant) || item.artifactKey,
    format: text(item.format),
    bytes: bytesOf(item.bytes),
    fileCount: Number(item.fileCount) || 0,
    complete: item.complete !== false,
    fit: isObject(item.fit) ? { label: text(item.fit.label) || "unknown", spill: item.fit.spill === true, neededMb: bytesOf(item.fit.neededMb) } : null,
    engines: list(item.engines).map((engine) => (isObject(engine) ? text(engine.engineId) : text(engine))).filter(Boolean),
    recommended: item.recommended === true,
    libraryState: text(item.library?.state) || "absent",
    companions: companionsOf(item),
  }));
}

/** `[{ path, kind: "mmproj" | "draft", size }]` of an artifact's companions (03 §13.3). */
export function companionsOf(artifact) {
  const out = [];
  for (const kind of ["mmproj", "draft"]) {
    for (const file of list(artifact?.companions?.[kind])) {
      const path = isObject(file) ? text(file.path) : text(file);
      if (path) out.push({ path, kind, size: isObject(file) ? bytesOf(file.size) : 0 });
    }
  }
  return out;
}

/** The companions a sheet starts with: the first projector (a vision model needs it), no draft model. */
export function defaultCompanions(companions) {
  const first = list(companions).find((item) => item.kind === "mmproj");
  return first ? [first.path] : [];
}

/** The artifact a sheet starts on: the one in the URL, else the recommended one, else the first complete one. */
export function initialArtifact(choices, wanted = "") {
  return (choices.find((choice) => choice.key === wanted)
    || choices.find((choice) => choice.recommended)
    || choices.find((choice) => choice.complete)
    || choices[0] || null)?.key || "";
}

/** The engine a "Download & deploy" starts: the first the artifact is known to run on. */
export function deployEngine(choice) {
  return choice?.engines?.[0] || "";
}

/** The roots a download can go to: registered, online and not hidden (03 §13.5). */
export function rootChoices(usage) {
  return list(usage?.roots).filter((root) => isObject(root) && text(root.id) && root.hidden !== true && root.online !== false)
    .map((root) => ({ id: root.id, label: text(root.label) || root.id, volume: text(root.volume), freeBytes: root.freeBytes == null ? null : bytesOf(root.freeBytes), totalBytes: root.totalBytes == null ? null : bytesOf(root.totalBytes), default: root.default === true }));
}

/**
 * The before/after bars of the target drive. Before: what is on the drive and
 * what is free. After: the same plus the bytes queued downloads still write and
 * this download. `total` is the drive size when the usage knows it, else the
 * free space (so the bar then shows only what the download takes).
 */
export function freeSpaceBars(plan, root) {
  const target = isObject(plan?.target) ? plan.target : {};
  const free = target.freeBytes == null ? null : bytesOf(target.freeBytes);
  if (free === null) return null;
  const total = bytesOf(root?.totalBytes) || free;
  const used = Math.max(0, total - free);
  const queued = bytesOf(target.queuedOnVolumeBytes);
  const download = bytesOf(plan?.artifact?.bytesToDownload);
  return {
    total,
    freeBytes: free,
    reserveBytes: target.reserveBytes == null ? null : bytesOf(target.reserveBytes),
    freeAfterBytes: target.freeAfterBytes == null ? Math.max(0, free - queued - download) : target.freeAfterBytes,
    before: [{ id: "used", value: used }],
    after: [{ id: "used", value: used }, { id: "queued", value: queued }, { id: "download", value: download }],
    overflows: used + queued + download > total,
  };
}

/** Whether the plan finds the files already on disk (a second copy needs `allowDuplicate`). */
export function duplicateState(plan) {
  const state = text(plan?.existing?.state);
  return { state: state || "absent", warn: ["present", "duplicate-elsewhere", "partial", "update-available"].includes(state), duplicate: state === "present" || state === "duplicate-elsewhere" };
}

// The actions an API error (planning or queueing) leaves the person, by code. A blocker brings its own `actions[]`.
const ERROR_ACTIONS = Object.freeze({
  already_downloading: ["open-downloads"],
  already_in_library: ["open-library"],
  target_occupied: ["choose-root"],
  disk_full: ["choose-root", "open-storage"],
  filter_no_match: ["pick-artifact"],
  repo_not_found: ["check-id"],
  revision_not_found: ["check-id"],
  hf_login_required: ["sign-in"],
  hf_auth_invalid: ["sign-in"],
  hf_approval_required: ["open-approval"],
  gated_official_required: ["switch-source"],
  token_requires_local: [],
});

/**
 * A failed POST /plan or POST /downloads as a blocker `{ code, message, hint,
 * actions[], existingJobId?, entryId? }`: a 422 `plan_blocked` carries the
 * list in `details.blocking`; anything else becomes one entry.
 */
export function blockersFromError(error) {
  const details = isObject(error?.details) ? error.details : {};
  if (Array.isArray(details.blocking) && details.blocking.length) return details.blocking.map(normalizeBlocker);
  const code = text(error?.code) || "plan_failed";
  return [normalizeBlocker({
    code,
    message: text(error?.message),
    hint: text(error?.hint),
    actions: ERROR_ACTIONS[code] || [],
    existingJobId: details.existingJobId,
    entryId: details.entryId,
  })];
}

/** `{ code, message, hint, actions, existingJobId, entryId }` of one `blocking[]` entry. */
export function normalizeBlocker(blocker) {
  const entry = isObject(blocker) ? blocker : {};
  const code = text(entry.code) || "blocked";
  return {
    code,
    message: text(entry.message),
    hint: text(entry.hint),
    actions: list(entry.actions).map(text).filter(Boolean),
    existingJobId: text(entry.existingJobId),
    entryId: text(entry.entryId),
    local: false,
  };
}

/** Whether a planning error means the plan sheet should plan again (the plan expired or the repository changed). */
export function replanCode(error) {
  return error?.code === "plan_not_found" || error?.code === "plan_changed";
}

/** The source to offer when the chosen one fails: the next of the usual three. */
export function alternateSource(current) {
  if (current === "hf-mirror") return "huggingface";
  if (current === "modelscope") return "huggingface";
  return "hf-mirror";
}

/** Latency text rows of POST /sources/probe: `[{ source, ok, ms }]` sorted by speed, failures last. */
export function probeRows(probe) {
  return list(probe?.sources).filter((row) => isObject(row) && text(row.source)).map((row) => ({
    source: row.source, ok: row.ok === true, ms: Number.isFinite(Number(row.ms)) ? Math.round(Number(row.ms)) : null, recommended: probe.recommended === row.source,
  })).sort((a, b) => (a.ok === b.ok ? (a.ms ?? Infinity) - (b.ms ?? Infinity) : a.ok ? -1 : 1));
}
