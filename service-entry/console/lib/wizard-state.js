// Wizard state (07 §6.3): the pure half of /deployments/new. A Draft is what
// the user has decided so far; planRequest and launchRequest turn it into the
// 01 LaunchRequestV2 the manager plans and launches, so a plan always equals
// the launch. Nothing here touches the DOM or storage: the page reads and
// writes the draft through lib/storage.js and hands the text to
// serializeDraft / parseDraft.
//
// Draft = { v: 1, id: "wd_…", step, modelRef, engineId, managerId, runtimeId,
//   recipeId, goal, instance: { mode, targetInstanceId, instanceId, servedName,
//   port }, gpus: ["0"], values: {}, extraArgs: [], extraEnv: {}, access:
//   { networkAccess, apiKey }, acknowledge: [] }
//   modelRef  null | { kind: "local", entryId, path, cardId? }
//             | { kind: "remote", source, repo, revision, cardId? }
//   values    explicit user values { paramId: value | { value, source: "planner" } };
//             null is "unset". A secret never lives here once saved.
//   extraEnv  { NAME: value | null }; null is a value that must be retyped.
//   legacy    optional, set by fromLegacyProfile: what the profile held that
//             the draft has no field for ({ unmapped, secrets, consumed, runtimeImage }).

export const DRAFT_VERSION = 1;
export const DRAFT_STORAGE_KEY = "console.wizard.draft";
export const DOWNLOADS_STORAGE_KEY = "console.wizard.downloads";

/** The seven wizard steps; stepStatus reports the first six, Launch is the run itself. */
export const STEP_IDS = Object.freeze(["model", "engine", "resources", "capabilities", "access", "review", "launch"]);
export const STATUS_STEPS = Object.freeze(STEP_IDS.slice(0, 6));
export const GOALS = Object.freeze(["max-context", "balanced", "throughput", "low-vram"]);
export const INSTANCE_MODES = Object.freeze(["replace", "parallel"]);
export const NETWORK_ACCESS = Object.freeze(["local", "lan"]);
export const API_KEY_MODES = Object.freeze(["auto", "none"]);

/**
 * The step each 01 catalog group is edited on (07 §6.3). `lora` is seeded by
 * 01 but not named by 07; adapters are a capability, so they join step 4.
 */
export const GROUP_STEPS = Object.freeze({
  model: "model",
  capacity: "resources",
  memory: "resources",
  parallelism: "resources",
  "runtime-expert": "resources",
  "reasoning-tools": "capabilities",
  speculative: "capabilities",
  multimodal: "capabilities",
  sampling: "capabilities",
  lora: "capabilities",
  "network-security": "access",
});

/** Roles a deployment can serve on its own (02 §9): draft, mmproj, adapter, mtp-head and tooling-only never are. */
export const SERVABLE_ROLES = Object.freeze(["main", "embedding", "reranker"]);

export function isServableRole(role) {
  return SERVABLE_ROLES.includes(role);
}

/** An unknown group lands on Resources under this heading. */
export const OTHER_GROUP = "other";

const SECRET_NAME = /(?:api[-_]?key|token|secret|password|passwd)$/i;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function unwrap(entry) {
  if (isPlainObject(entry) && Object.hasOwn(entry, "value") && typeof entry.source === "string" && Object.keys(entry).length === 2) return entry.value;
  return entry;
}

// ---------------------------------------------------------------------------
// Groups and steps

/** The step a catalog group belongs to; an unknown group is a Resources "Other" group. */
export function stepOfGroup(groupId) {
  return Object.hasOwn(GROUP_STEPS, groupId) ? GROUP_STEPS[groupId] : "resources";
}

export function isKnownGroup(groupId) {
  return Object.hasOwn(GROUP_STEPS, groupId);
}

/** The group ids to show on one step, in catalog order; Resources also takes every unknown group last. */
export function groupsForStep(catalog, step) {
  const groups = (Array.isArray(catalog?.groups) ? catalog.groups : []).filter((group) => isPlainObject(group) && typeof group.id === "string");
  const ordered = [...groups].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  return ordered.filter((group) => stepOfGroup(group.id) === step).map((group) => group.id);
}

/** Group ids the catalog has that 07 does not know; they show under "Other". */
export function unknownGroups(catalog) {
  return (Array.isArray(catalog?.groups) ? catalog.groups : []).map((group) => group?.id).filter((id) => typeof id === "string" && !isKnownGroup(id));
}

function paramIndex(catalog) {
  return new Map((Array.isArray(catalog?.params) ? catalog.params : []).filter((param) => param && typeof param.id === "string").map((param) => [param.id, param]));
}

// "llamacpp.overrideTensor[0].pattern" belongs to "llamacpp.overrideTensor": cut the path from the right until a param id matches.
function paramOfField(field, byId) {
  let candidate = String(field || "");
  while (candidate) {
    if (byId.has(candidate)) return byId.get(candidate);
    const cut = Math.max(candidate.lastIndexOf("."), candidate.lastIndexOf("["));
    if (cut <= 0) break;
    candidate = candidate.slice(0, cut);
  }
  return null;
}

/** The step a field error, warning or blocker field points at. */
export function stepOfField(field, catalog) {
  const name = String(field || "");
  if (!name) return "review";
  if (name === "model" || name.startsWith("model.") || name === "prospective") return "model";
  if (["engineId", "runtimeId", "recipeId", "recipe", "runtime", "acknowledge"].includes(name) || name.startsWith("runtime.")) return "engine";
  if (name === "instance.networkAccess" || name === "apiKey") return "access";
  if (name === "instance" || name.startsWith("instance.") || name.startsWith("extraArgs") || name.startsWith("extraEnv")) return "resources";
  if (name === "onConflict" || name === "expectedPlanHash") return "review";
  const param = paramOfField(name, paramIndex(catalog));
  return param ? stepOfGroup(param.group) : "resources";
}

const BLOCKER_STEPS = Object.freeze({
  experimental_ack_required: "engine",
  recipe_blocked: "engine",
  insufficient_vram: "resources",
  instance_conflict: "resources",
  image_pull_required: "review",
  runtime_local_build_missing: "review",
});

/** The step a plan blocker is fixed on (default Review, where the image step lives). */
export function stepOfBlocker(blocker) {
  const code = text(blocker?.code);
  if (Object.hasOwn(BLOCKER_STEPS, code)) return BLOCKER_STEPS[code];
  return blocker?.field ? stepOfField(blocker.field) : "review";
}

// ---------------------------------------------------------------------------
// Draft

function newDraftId(random) {
  let id = "";
  for (let index = 0; index < 12; index += 1) id += BASE32[Math.floor(random() * 32) % 32];
  return `wd_${id}`;
}

function normalizeModelRef(raw) {
  if (!isPlainObject(raw)) return null;
  const cardId = text(raw.cardId) || undefined;
  if (raw.kind === "remote") {
    const repo = text(raw.repo);
    if (!repo) return null;
    return { kind: "remote", source: text(raw.source) || "huggingface", repo, revision: text(raw.revision) || "main", ...(cardId ? { cardId } : {}) };
  }
  if (raw.kind === "local") {
    const path = text(raw.path);
    if (!path) return null;
    return { kind: "local", entryId: text(raw.entryId) || null, path, ...(cardId ? { cardId } : {}) };
  }
  return null;
}

function normalizePort(value) {
  if (value === null || value === undefined || value === "") return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function stringList(value) {
  return (Array.isArray(value) ? value : []).filter((item) => typeof item === "string" || typeof item === "number").map((item) => String(item).trim()).filter(Boolean);
}

function normalizeEnv(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [name, value] of Object.entries(raw)) {
    if (!name) continue;
    out[name] = typeof value === "string" ? value : value === null || value === undefined ? null : String(value);
  }
  return out;
}

/** A well-formed draft from anything: unknown fields are dropped, missing ones defaulted. */
export function normalizeDraft(raw, { random = Math.random } = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const instance = isPlainObject(source.instance) ? source.instance : {};
  const access = isPlainObject(source.access) ? source.access : {};
  const draft = {
    v: DRAFT_VERSION,
    id: /^wd_[a-z0-9]{6,32}$/.test(text(source.id)) ? text(source.id) : newDraftId(random),
    step: STEP_IDS.includes(source.step) ? source.step : "model",
    modelRef: normalizeModelRef(source.modelRef),
    engineId: text(source.engineId),
    managerId: text(source.managerId),
    runtimeId: text(source.runtimeId),
    recipeId: text(source.recipeId),
    goal: GOALS.includes(source.goal) ? source.goal : null,
    instance: {
      mode: INSTANCE_MODES.includes(instance.mode) ? instance.mode : "replace",
      targetInstanceId: text(instance.targetInstanceId),
      instanceId: text(instance.instanceId),
      servedName: text(instance.servedName),
      port: normalizePort(instance.port),
    },
    gpus: [...new Set(stringList(source.gpus))],
    values: isPlainObject(source.values) ? clone(source.values) : {},
    extraArgs: stringList(source.extraArgs),
    extraEnv: normalizeEnv(source.extraEnv),
    access: {
      networkAccess: NETWORK_ACCESS.includes(access.networkAccess) ? access.networkAccess : "local",
      apiKey: API_KEY_MODES.includes(access.apiKey) ? access.apiKey : "auto",
    },
    acknowledge: [...new Set(stringList(source.acknowledge))],
  };
  if (isPlainObject(source.legacy)) draft.legacy = clone(source.legacy);
  return draft;
}

/** createDraft(seed): a fresh draft; the seed may set any field (quick paths, clones). */
export function createDraft(seed = {}, options = {}) {
  return normalizeDraft(seed, options);
}

/** A copy of the draft with `patch` merged in (instance and access merge one level deep). */
export function patchDraft(draft, patch = {}) {
  const next = { ...draft, ...patch };
  if (patch.instance) next.instance = { ...draft.instance, ...patch.instance };
  if (patch.access) next.access = { ...draft.access, ...patch.access };
  return normalizeDraft(next, { random: () => 0 });
}

/** The draft with one explicit value set; null, undefined and "" unset it. */
export function setValue(draft, id, value) {
  const values = { ...draft.values };
  if (value === undefined || value === null || value === "") delete values[id];
  else values[id] = value;
  return { ...draft, values };
}

/** Whether the user has decided anything worth asking about before leaving. */
export function isDirty(draft) {
  if (!draft) return false;
  return Boolean(draft.modelRef || draft.engineId || draft.gpus.length || draft.extraArgs.length || Object.keys(draft.values).length
    || Object.keys(draft.extraEnv).length || draft.instance.servedName || draft.instance.instanceId || draft.instance.port);
}

/** Whether a plan can be asked for: a manager, an engine and a model (a local path, or a remote card id). */
export function planReady(draft) {
  if (!draft?.managerId || !draft.engineId || !draft.modelRef) return false;
  return draft.modelRef.kind === "remote" ? Boolean(draft.modelRef.cardId) : Boolean(draft.modelRef.path);
}

// ---------------------------------------------------------------------------
// Requests

function secretIdsOf(catalog) {
  return new Set((Array.isArray(catalog?.params) ? catalog.params : []).filter((param) => param?.secret === true).map((param) => param.id));
}

function isSecretId(id, secrets) {
  return secrets.has(id) || SECRET_NAME.test(id);
}

/**
 * The 01 LaunchRequestV2 for POST /api/m/:managerId/launch/plan. Only what the
 * user decided goes in: unset values, empty lists and defaults are left out, so
 * the manager's own defaults and the recipe stay in charge. A remote model adds
 * `prospective: true` and `model: { card }` (00 §9.2); the card is the full
 * ModelCard when `options.card` has it (the manager needs the object), else
 * the card id. The API key is never in the draft (the manager's secret store
 * makes one), and a secret param typed into `values` travels as its own
 * request field, as 01 requires.
 */
export function planRequest(draft, { card, catalog } = {}) {
  const request = {};
  if (draft.engineId) request.engineId = draft.engineId;
  if (draft.runtimeId) request.runtimeId = draft.runtimeId;
  if (draft.recipeId) request.recipeId = draft.recipeId;

  const model = {};
  const remote = draft.modelRef?.kind === "remote";
  if (remote) {
    const reference = card ?? draft.modelRef.cardId;
    if (reference) model.card = reference;
    request.prospective = true;
  } else if (draft.modelRef?.path) {
    model.ref = draft.modelRef.path;
  }
  if (draft.instance.servedName) model.servedName = draft.instance.servedName;
  request.model = model;

  const instance = { mode: draft.instance.mode };
  const slot = draft.instance.mode === "replace" ? draft.instance.targetInstanceId || draft.instance.instanceId : draft.instance.instanceId;
  if (slot) instance.id = slot;
  if (draft.instance.port !== null) instance.port = draft.instance.port;
  instance.networkAccess = draft.access.networkAccess;
  if (draft.gpus.length) instance.gpuIds = [...draft.gpus];
  request.instance = instance;

  const secrets = secretIdsOf(catalog);
  const values = {};
  for (const [id, raw] of Object.entries(draft.values)) {
    const value = unwrap(raw);
    if (value === undefined || value === null) continue;
    if (isSecretId(id, secrets)) {
      if (value !== "") request[id] = value;
      continue;
    }
    values[id] = clone(raw);
  }
  request.values = values;

  if (draft.extraArgs.length) request.extraArgs = [...draft.extraArgs];
  const env = Object.fromEntries(Object.entries(draft.extraEnv).filter(([, value]) => typeof value === "string"));
  if (Object.keys(env).length) request.extraEnv = env;
  if (draft.acknowledge.length) request.acknowledge = [...draft.acknowledge];
  return request;
}

/** planRequest plus the plan the user reviewed (00 §9.2); without a planHash (a manager before ENG-2) the field is left out. */
export function launchRequest(draft, plan, options = {}) {
  const request = planRequest(draft, options);
  if (typeof plan?.planHash === "string" && plan.planHash) request.expectedPlanHash = plan.planHash;
  return request;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

/** A stable JSON text of a request body, for dedupe only; the server's planHash is the identity. */
export function requestKey(body) {
  return JSON.stringify(stable(body ?? null));
}

/** The draft with a server suggestion applied; `param` is a catalog id or one of the request fields below. */
export function applySuggestion(draft, { param, value } = {}) {
  const name = text(param);
  if (!name) return draft;
  if (name === "instance.port") return patchDraft(draft, { instance: { port: value } });
  if (name === "instance.id") return patchDraft(draft, { instance: draft.instance.mode === "replace" ? { targetInstanceId: String(value) } : { instanceId: String(value) } });
  if (name === "model.servedName") return patchDraft(draft, { instance: { servedName: String(value ?? "") } });
  if (name === "instance.networkAccess") return patchDraft(draft, { access: { networkAccess: value } });
  return setValue(draft, name, value);
}

/** The draft without one explicit value. */
export function resetParam(draft, id) {
  const values = { ...draft.values };
  delete values[id];
  return { ...draft, values };
}

// ---------------------------------------------------------------------------
// Model references

/** The body of POST /api/models/inspect for a model reference (02 §17). */
export function inspectRequest(modelRef) {
  if (modelRef?.kind === "remote") return { source: modelRef.source || "huggingface", repo: modelRef.repo, revision: modelRef.revision || "main" };
  return { path: modelRef?.path || "" };
}

/** The reference a card stands for, keeping the card id so the next step needs no second inspect. */
export function modelRefFromCard(card, previous = null) {
  const ref = isPlainObject(card?.ref) ? card.ref : {};
  const cardId = text(card?.cardId) || undefined;
  if (ref.kind === "hf" || ref.kind === "modelscope") {
    return normalizeModelRef({ kind: "remote", source: ref.kind === "hf" ? "huggingface" : "modelscope", repo: ref.repo, revision: ref.revision || "main", cardId });
  }
  if (ref.kind === "local" && text(ref.path)) {
    const path = ref.file ? `${text(ref.path).replace(/[\\/]+$/, "")}/${ref.file}` : text(ref.path);
    return normalizeModelRef({ kind: "local", entryId: previous?.kind === "local" ? previous.entryId : null, path: previous?.kind === "local" && previous.path ? previous.path : path, cardId });
  }
  return previous ? normalizeModelRef({ ...previous, cardId }) : null;
}

/** The reference a resolved link (POST /api/hub/resolve-link: { provider, repo, revision }) stands for. */
export function modelRefFromLink(resolved) {
  if (!isPlainObject(resolved) || !text(resolved.repo)) return null;
  const provider = text(resolved.provider).toLowerCase();
  return normalizeModelRef({
    kind: "remote",
    source: provider.startsWith("model") ? "modelscope" : "huggingface",
    repo: resolved.repo,
    revision: resolved.revision || "main",
  });
}

/** `?model=` of a quick path: `hf:owner/name[@revision]` is a repository, anything else a folder path. */
export function parseModelParam(value) {
  const raw = text(value);
  if (!raw) return null;
  const remote = /^(hf|ms):([^@\s]+)(?:@(\S+))?$/i.exec(raw);
  if (remote) {
    return normalizeModelRef({ kind: "remote", source: remote[1].toLowerCase() === "ms" ? "modelscope" : "huggingface", repo: remote[2], revision: remote[3] || "main" });
  }
  return normalizeModelRef({ kind: "local", entryId: null, path: raw });
}

/** Whether the path looks like a folder or file on this machine (as opposed to a link). */
export function looksLikePath(value) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/|~)/.test(text(value));
}

// ---------------------------------------------------------------------------
// Status per step

const RANK = { ok: 0, warn: 1, error: 2 };

function issueField(item) {
  return typeof item?.field === "string" ? item.field : typeof item?.path === "string" ? item.path : typeof item?.param === "string" ? item.param : "";
}

/**
 * Where a plan's problems land: { model, engine, resources, capabilities,
 * access, review }, each ok | warn | error. A step is an error when the draft
 * is incomplete for it or a plan error, blocker or `block` verdict points at
 * it; warn for warnings and for a remote model (a prospective plan cannot be
 * launched). Review summarises: an error when any step is, warn when any step
 * warns or there is no plan yet.
 */
export function stepStatus(draft, plan, catalog) {
  const status = Object.fromEntries(STATUS_STEPS.map((step) => [step, "ok"]));
  const bump = (step, level) => {
    if (Object.hasOwn(status, step) && RANK[level] > RANK[status[step]]) status[step] = level;
  };
  if (!draft?.modelRef) bump("model", "error");
  else if (draft.modelRef.kind === "remote") bump("model", "warn");
  if (!draft?.engineId || !draft?.managerId) bump("engine", "error");
  if (draft?.access?.networkAccess === "lan" && draft.access.apiKey === "none") bump("access", "warn");

  if (plan && isPlainObject(plan)) {
    for (const item of Array.isArray(plan.errors) ? plan.errors : []) bump(stepOfField(issueField(item), catalog), "error");
    for (const item of Array.isArray(plan.blockers) ? plan.blockers : []) bump(stepOfBlocker(item), "error");
    for (const item of Array.isArray(plan.warnings) ? plan.warnings : []) bump(stepOfField(issueField(item), catalog), "warn");
    if (plan.admission?.verdict === "block") bump("resources", "error");
    else if (plan.admission?.verdict === "warn") bump("resources", "warn");
    if (plan.ok === false && !STATUS_STEPS.slice(0, 5).some((step) => status[step] === "error")) bump("review", "error");
  }
  const others = STATUS_STEPS.slice(0, 5).map((step) => status[step]);
  if (others.includes("error")) bump("review", "error");
  else if (others.includes("warn") || !plan) bump("review", "warn");
  return status;
}

// ---------------------------------------------------------------------------
// Plan loop

/**
 * The debounced, deduped plan requests of usePlan (07 §6.3). `send(managerId,
 * body, { signal })` posts the plan request. A change schedules a request after
 * `debounceMs`; a request whose key equals the one in flight or the one the
 * current plan answered is not sent again; a newer request aborts the older
 * one and an answer to an older request is ignored. An `ok:false` plan is a
 * plan (HTTP 200) and replaces the last one; a thrown error (400, transport)
 * is `status:"error"` and keeps the last plan.
 *
 * state: { status: "idle"|"updating"|"ready"|"error", plan, planKey, error, requests }
 */
export function createPlanLoop({
  send,
  debounceMs = 250,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (id) => globalThis.clearTimeout(id),
  onChange,
} = {}) {
  let state = { status: "idle", plan: null, planKey: null, error: null, requests: 0 };
  let timer = null;
  let controller = null;
  let inflightKey = null;
  let sequence = 0;
  let disposed = false;

  function set(patch) {
    state = { ...state, ...patch };
    if (!disposed && typeof onChange === "function") onChange(state);
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  async function fire(managerId, body, key) {
    timer = null;
    controller?.abort();
    controller = typeof AbortController === "function" ? new AbortController() : null;
    sequence += 1;
    const mine = sequence;
    inflightKey = key;
    set({ status: "updating", requests: state.requests + 1 });
    try {
      const plan = await send(managerId, body, { signal: controller?.signal });
      if (mine !== sequence || disposed) return;
      inflightKey = null;
      set({ status: "ready", plan, planKey: key, error: null });
    } catch (error) {
      if (mine !== sequence || disposed) return;
      inflightKey = null;
      if (error?.code === "aborted") return;
      set({ status: "error", error });
    }
  }

  return {
    get state() {
      return state;
    },
    /** Ask for the plan of `body`; the same body twice, or one the plan already answers, sends nothing. */
    request(managerId, body) {
      if (disposed) return;
      const key = `${managerId}\n${requestKey(body)}`;
      cancelTimer();
      if (key === inflightKey) {
        if (state.status !== "updating") set({ status: "updating" });
        return;
      }
      if (key === state.planKey && state.status !== "error") {
        // Back to the request the plan answers (typed and undone inside the debounce).
        if (state.status !== "ready") {
          controller?.abort();
          sequence += 1;
          inflightKey = null;
          set({ status: "ready" });
        }
        return;
      }
      if (state.status !== "updating") set({ status: "updating" });
      timer = setTimer(() => fire(managerId, body, key), debounceMs);
    },
    /** Sends the same request again now (the banner's Retry, a finished image pull). */
    refresh(managerId, body) {
      if (disposed) return;
      cancelTimer();
      fire(managerId, body, `${managerId}\n${requestKey(body)}`);
    },
    /** The draft cannot be planned (yet): drop pending work, keep the last plan. */
    pause() {
      cancelTimer();
      controller?.abort();
      sequence += 1;
      inflightKey = null;
      if (state.status === "updating") set({ status: state.plan ? "ready" : "idle" });
    },
    dispose() {
      disposed = true;
      cancelTimer();
      controller?.abort();
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence

function scrubArgs(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const flag = String(arg).replace(/^-+/, "").split("=")[0];
    if (/^-/.test(arg) && SECRET_NAME.test(flag)) {
      if (!String(arg).includes("=") && index + 1 < args.length && !/^-/.test(args[index + 1])) index += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * The draft as it may be stored in sessionStorage: no secret param value, no
 * secret-looking argument, and no extraEnv value (only the names stay, as
 * null, so they must be retyped after a reload).
 */
export function sanitizeDraft(draft, catalog) {
  const secrets = secretIdsOf(catalog);
  const values = {};
  for (const [id, value] of Object.entries(draft.values || {})) {
    if (!isSecretId(id, secrets)) values[id] = clone(value);
  }
  const extraEnv = Object.fromEntries(Object.keys(draft.extraEnv || {}).map((name) => [name, null]));
  const copy = { ...clone(draft), values, extraEnv, extraArgs: scrubArgs(draft.extraArgs || []) };
  return copy;
}

export function serializeDraft(draft, catalog) {
  return JSON.stringify(sanitizeDraft(draft, catalog));
}

/** The draft in stored text, or null when the text is not a v1 draft. */
export function parseDraft(textValue, options = {}) {
  if (typeof textValue !== "string" || !textValue) return null;
  try {
    const raw = JSON.parse(textValue);
    if (!isPlainObject(raw) || raw.v !== DRAFT_VERSION || !/^wd_[a-z0-9]{6,32}$/.test(text(raw.id))) return null;
    return normalizeDraft(raw, options);
  } catch {
    return null;
  }
}

// jobId → draftId for "Download first": when that job's `downloads` event
// reaches ready, the console links back to /deployments/new?draft=<id>.

export function parseDownloads(textValue) {
  try {
    const raw = JSON.parse(textValue || "{}");
    if (!isPlainObject(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([job, draft]) => typeof job === "string" && /^wd_[a-z0-9]{6,32}$/.test(String(draft))));
  } catch {
    return {};
  }
}

export function rememberDownload(map, jobId, draftId) {
  const id = text(jobId);
  if (!id || !/^wd_[a-z0-9]{6,32}$/.test(text(draftId))) return { ...map };
  const entries = Object.entries({ ...map, [id]: draftId }).slice(-20);
  return Object.fromEntries(entries);
}

export function draftForJob(map, jobId) {
  return Object.hasOwn(map || {}, jobId) ? map[jobId] : null;
}

export function forgetDownload(map, jobId) {
  const next = { ...map };
  delete next[jobId];
  return next;
}

// ---------------------------------------------------------------------------
// From stored launches and profiles

/** The draft a LaunchStore record (01 §15) starts: its spec, without anything secret. */
export function fromLaunchRecord(record, seed = {}) {
  const spec = isPlainObject(record?.spec) ? record.spec : {};
  const model = isPlainObject(spec.model) ? spec.model : {};
  const instance = isPlainObject(spec.instance) ? spec.instance : {};
  const slot = text(instance.id);
  const parallel = instance.mode === "parallel" || (instance.mode === "add" && slot && slot !== "primary");
  const values = {};
  for (const [id, raw] of Object.entries(isPlainObject(spec.values) ? spec.values : {})) {
    if (!isSecretId(id, new Set())) values[id] = clone(raw);
  }
  return createDraft({
    ...seed,
    modelRef: text(model.ref) ? { kind: "local", entryId: null, path: text(model.ref) } : null,
    engineId: spec.engineId,
    managerId: record?.managerId || seed.managerId,
    runtimeId: spec.runtimeId,
    recipeId: spec.recipeId,
    instance: {
      mode: parallel ? "parallel" : "replace",
      targetInstanceId: parallel ? "" : slot,
      instanceId: parallel ? slot : "",
      servedName: model.servedName,
      port: instance.port,
    },
    gpus: instance.gpuIds,
    values,
    extraArgs: spec.extraArgs,
    extraEnv: Object.fromEntries(Object.keys(isPlainObject(spec.extraEnv) ? spec.extraEnv : {}).map((name) => [name, null])),
    access: { networkAccess: instance.networkAccess, apiKey: "auto" },
  });
}

const TRUE_TEXT = /^(?:true|on|yes|1)$/i;
const FALSE_TEXT = /^(?:false|off|no|0)$/i;

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" && TRUE_TEXT.test(value.trim())) return true;
  if (typeof value === "string" && FALSE_TEXT.test(value.trim())) return false;
  return value;
}

function blank(value) {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function legacyFields(param) {
  return [param.legacy?.field, ...(Array.isArray(param.legacy?.aliases) ? param.legacy.aliases : [])].filter((name) => typeof name === "string" && name);
}

function present(config, field) {
  return Object.hasOwn(config, field) && config[field] !== undefined;
}

// The first field holding a value wins; a blank one still counts when nothing else is set.
function readRaw(config, param) {
  let empty = null;
  for (const name of legacyFields(param)) {
    if (!present(config, name)) continue;
    if (!blank(config[name])) return { found: true, value: config[name], fields: [name] };
    empty = empty || { found: true, value: config[name], fields: [name] };
  }
  return empty || { found: false };
}

function decodeScalar(param, raw) {
  if (blank(raw)) return null;
  let value = raw;
  if (param.type === "int" || param.type === "float") {
    if (typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw.trim())) value = Number(raw.trim());
  } else if (param.type === "bool" || param.type === "tristate") {
    value = toBool(raw);
  }
  if (param.legacy.unset !== undefined && value === param.legacy.unset) return null;
  return value;
}

// The same codecs as manager-core/engines/legacy-aliases.js: direct, invertedBool, prefixCachingPair, defaultTrueBool.
function decodeParam(param, config) {
  const codec = param.legacy?.codec || "direct";
  const fields = legacyFields(param).filter((name) => present(config, name));
  if (!fields.length) return { found: false };
  if (codec === "invertedBool") {
    const raw = readRaw(config, param);
    return { found: true, value: toBool(raw.value) === true ? false : null, fields: legacyFields(param).filter((name) => present(config, name)) };
  }
  if (codec === "prefixCachingPair") {
    const [enableField, disableField] = legacyFields(param);
    const hasEnable = present(config, enableField);
    const hasDisable = Boolean(disableField) && present(config, disableField);
    let value;
    if (hasDisable && toBool(config[disableField]) === true) value = false;
    else if (hasEnable) value = toBool(config[enableField]) === true ? true : null;
    else value = true;
    return { found: true, value, fields };
  }
  if (codec === "defaultTrueBool") {
    const off = fields.some((name) => config[name] === false || config[name] === 0 || (typeof config[name] === "string" && FALSE_TEXT.test(config[name].trim())));
    return { found: true, value: !off, fields };
  }
  const raw = readRaw(config, param);
  return raw.found ? { found: true, value: decodeScalar(param, raw.value), fields: legacyFields(param).filter((name) => present(config, name)) } : { found: false };
}

const LEGACY_ENGINES = Object.freeze({ llama: "llamacpp", "llama.cpp": "llamacpp" });

/**
 * The draft a stored profile starts. A v2 profile brings sparse `values`; a v1
 * profile brings the flat legacy `config` (camelCase, sglang*), which the
 * catalog's `legacy` entries (field, aliases, codec, unset) turn into param
 * ids. Nothing is dropped silently: `draft.legacy` lists the config keys that
 * became values or request fields (`consumed`), those the draft has no field
 * for (`unmapped`, verbatim), the names of secrets (`secrets`; their values are
 * never copied) and a `runtimeImage` the registry must resolve.
 */
export function fromLegacyProfile(profile, catalog, { managerId = "", seed = {} } = {}) {
  const source = isPlainObject(profile) ? profile : {};
  const config = isPlainObject(source.config) ? source.config : {};
  const params = (Array.isArray(catalog?.params) ? catalog.params : []).filter((param) => param && param.legacy && typeof param.legacy === "object");
  const values = {};
  const consumed = new Set();
  const secrets = [];
  for (const param of params) {
    if (param.secret) {
      for (const name of legacyFields(param)) if (present(config, name)) secrets.push(name);
      continue;
    }
    const decoded = decodeParam(param, config);
    if (!decoded.found) continue;
    values[param.id] = decoded.value;
    for (const name of decoded.fields || []) consumed.add(name);
  }
  if (isPlainObject(source.values)) {
    for (const [id, raw] of Object.entries(source.values)) {
      if (!isSecretId(id, secretIdsOf(catalog))) values[id] = clone(raw);
    }
  }

  const request = {};
  const take = (field) => {
    if (present(config, field)) consumed.add(field);
    return config[field];
  };
  if (!blank(take("model"))) request.modelRef = { kind: "local", entryId: null, path: String(config.model).trim() };
  const instance = {};
  const port = take("port");
  if (!blank(port)) instance.port = port;
  const mode = take("instanceMode");
  if (INSTANCE_MODES.includes(mode)) instance.mode = mode;
  const slot = take("instanceId");
  if (!blank(slot)) instance[instance.mode === "parallel" ? "instanceId" : "targetInstanceId"] = String(slot);
  request.instance = instance;
  const network = take("networkAccess");
  if (NETWORK_ACCESS.includes(network)) request.access = { networkAccess: network };
  const engine = take("engine");
  const gpuField = take("gpuDeviceIds");
  const gpus = Array.isArray(gpuField) ? gpuField : typeof gpuField === "string" ? gpuField.split(",") : [];
  const image = take("runtimeImage");

  const engineId = text(source.engineId) || text(catalog?.engineId) || LEGACY_ENGINES[text(engine)] || text(engine);
  const unmapped = {};
  for (const [name, value] of Object.entries(config)) {
    if (consumed.has(name) || secrets.includes(name)) continue;
    if (SECRET_NAME.test(name)) {
      secrets.push(name);
      continue;
    }
    unmapped[name] = clone(value);
  }
  const draft = createDraft({
    ...seed,
    ...request,
    engineId,
    managerId: managerId || seed.managerId,
    recipeId: source.recipeId,
    gpus,
    values,
  });
  draft.legacy = {
    consumed: [...consumed].sort(),
    unmapped,
    secrets: [...new Set(secrets)].sort(),
    ...(!blank(image) ? { runtimeImage: String(image) } : {}),
  };
  return draft;
}

// ---------------------------------------------------------------------------
// Comparing values

function describeValue(value) {
  const plain = unwrap(value);
  if (plain === undefined || plain === null) return "";
  if (typeof plain === "string") return plain;
  return JSON.stringify(plain);
}

/**
 * DiffTable rows for two value maps ({ id: value | { value, source } }): one row
 * per param whose value differs, ordered by the catalog, labelled with the
 * param's label in `locale`. `source` is the new side's provenance when it has one.
 */
export function diffValues(a, b, catalog, { locale = "en-US" } = {}) {
  const left = isPlainObject(a) ? a : {};
  const right = isPlainObject(b) ? b : {};
  const byId = paramIndex(catalog);
  const order = new Map([...byId.keys()].map((id, index) => [id, index]));
  const ids = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  const rows = [];
  for (const id of ids) {
    const from = unwrap(left[id]);
    const to = unwrap(right[id]);
    if (sameValue(from ?? null, to ?? null)) continue;
    const label = byId.get(id)?.label;
    const short = locale.startsWith("zh") ? "zh" : "en";
    const name = isPlainObject(label) ? label[locale] || label[short] || label.en || label.zh : typeof label === "string" ? label : "";
    rows.push({
      id,
      label: name || id,
      from: describeValue(left[id]),
      to: describeValue(right[id]),
      ...(isPlainObject(right[id]) && typeof right[id].source === "string" ? { source: right[id].source } : {}),
    });
  }
  return rows.sort((x, y) => (order.get(x.id) ?? 1e6) - (order.get(y.id) ?? 1e6) || x.id.localeCompare(y.id));
}
