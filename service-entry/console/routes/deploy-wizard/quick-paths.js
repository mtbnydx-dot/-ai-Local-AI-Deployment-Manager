// The ways into the wizard other than the first step (07 §6.3 "Quick paths"):
//   ?model=<ref>&engine=<id>&recipe=<id>   a model (folder path, or hf:owner/name[@rev]), engine and recipe
//   ?clone=<launchId>&manager=<id>         the stored launch spec of a deployment
//   ?draft=<id>                            a draft kept in this tab (a finished download links here)
//   ?profile=<id>&manager=<id>             a saved profile; applying it always shows a DiffTable first
//   ?manager=<id>&from=recent[&recent=<n>] the n-th recent launch of a manager (start-last-used; opens Review)
//   ?step=<id>                             the step to open (relaunch and start-last-used open Review)

import { STEP_IDS, createDraft, fromLaunchRecord, fromLegacyProfile, parseModelParam } from "../../lib/wizard-state.js";

const enc = encodeURIComponent;
// The engine a manager hosts when a profile does not name one (00 D3).
const DEFAULT_ENGINE = Object.freeze({ vllm: "vllm", llama: "llamacpp" });

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** The draft fields the query names, or null when it names none. */
export function draftSeedFromQuery(query = {}) {
  const seed = {};
  const modelRef = parseModelParam(query.model);
  if (modelRef) seed.modelRef = modelRef;
  if (text(query.engine)) seed.engineId = text(query.engine);
  if (text(query.manager)) seed.managerId = text(query.manager);
  if (text(query.recipe)) seed.recipeId = text(query.recipe);
  if (STEP_IDS.includes(query.step)) seed.step = query.step;
  return Object.keys(seed).length ? seed : null;
}

/** What the query asks the page to load: { kind: "draft"|"clone"|"profile"|"recent"|"seed"|"none", ... }. */
export function quickPathOf(query = {}) {
  if (text(query.draft)) return { kind: "draft", id: text(query.draft) };
  if (text(query.clone) && text(query.manager)) return { kind: "clone", launchId: text(query.clone), managerId: text(query.manager) };
  if (text(query.profile) && text(query.manager)) return { kind: "profile", profileId: text(query.profile), managerId: text(query.manager) };
  if (text(query.from) === "recent" && text(query.manager) && !text(query.model)) {
    const index = Number.parseInt(text(query.recent), 10);
    return { kind: "recent", managerId: text(query.manager), index: Number.isInteger(index) && index >= 0 ? index : 0 };
  }
  return draftSeedFromQuery(query) ? { kind: "seed", seed: draftSeedFromQuery(query) } : { kind: "none" };
}

/** The draft a stored launch starts (GET /api/m/:id/launches/:launchId, 01 §15). */
export async function loadLaunchDraft(api, managerId, launchId, seed = {}) {
  const body = await api.manager(managerId).get(`/launches/${enc(launchId)}`);
  const record = body?.launch ?? body?.record ?? body;
  return fromLaunchRecord({ managerId, ...record }, { ...seed, managerId });
}

// A legacy flat config (profile or recent launch) as a draft, with the engine's catalog for the field mapping.
async function draftFromLegacy(api, managerId, profile, seed) {
  const engineId = text(profile.engineId) || text(profile.config?.engine) || DEFAULT_ENGINE[managerId] || managerId;
  let catalog = null;
  try {
    catalog = await api.manager(managerId).get(`/engines/${enc(engineId)}/schema`);
  } catch {
    catalog = null;
  }
  const draft = fromLegacyProfile(profile, catalog, { managerId, seed });
  return { draft, profile, catalog };
}

/** The draft a saved profile starts, with the engine's catalog for the legacy field mapping. */
export async function loadProfileDraft(api, managerId, profileId, seed = {}) {
  const body = await api.manager(managerId).get("/tools/profiles");
  const profiles = [...(Array.isArray(body?.profiles) ? body.profiles : []), ...(Array.isArray(body?.builtin) ? body.builtin : [])];
  const profile = profiles.find((item) => String(item?.id) === profileId);
  return profile ? draftFromLegacy(api, managerId, profile, seed) : null;
}

/**
 * The draft of the n-th recent launch of a manager (GET /api/m/:id/recent-launches, newest first):
 * start-last-used. An entry that names its stored launch starts from that spec; an older one
 * starts from its flat config. Returns null when the manager has no such launch.
 */
export async function loadRecentDraft(api, managerId, index, seed = {}) {
  const body = await api.manager(managerId).get("/recent-launches");
  const entries = Array.isArray(body?.launches) ? body.launches : Array.isArray(body?.items) ? body.items : [];
  const entry = entries[index];
  if (!entry || typeof entry !== "object") return null;
  if (text(entry.launchId)) {
    try {
      return await loadLaunchDraft(api, managerId, text(entry.launchId), seed);
    } catch {
      // The stored launch is gone: the flat config below still starts the draft.
    }
  }
  const config = entry.config && typeof entry.config === "object" ? { ...entry.config } : {};
  if (!text(config.model) && text(entry.model)) config.model = entry.model;
  if (!text(config.name) && text(entry.name)) config.name = entry.name;
  if (!text(config.instanceMode) && text(entry.instanceMode)) config.instanceMode = entry.instanceMode;
  if (!text(config.instanceId) && text(entry.instanceId)) config.instanceId = entry.instanceId;
  if (!text(config.model)) return null;
  return (await draftFromLegacy(api, managerId, { id: text(entry.launchId) || `recent-${index}`, config }, seed)).draft;
}

export function blankDraft(seed) {
  return createDraft(seed || {});
}
