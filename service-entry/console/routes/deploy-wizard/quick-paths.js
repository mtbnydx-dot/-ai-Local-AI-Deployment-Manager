// The ways into the wizard other than the first step (07 §6.3 "Quick paths"):
//   ?model=<ref>&engine=<id>&recipe=<id>   a model (folder path, or hf:owner/name[@rev]), engine and recipe
//   ?clone=<launchId>&manager=<id>         the stored launch spec of a deployment
//   ?draft=<id>                            a draft kept in this tab (a finished download links here)
//   ?profile=<id>&manager=<id>             a saved profile; applying it always shows a DiffTable first
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

/** What the query asks the page to load: { kind: "draft"|"clone"|"profile"|"seed"|"none", ... }. */
export function quickPathOf(query = {}) {
  if (text(query.draft)) return { kind: "draft", id: text(query.draft) };
  if (text(query.clone) && text(query.manager)) return { kind: "clone", launchId: text(query.clone), managerId: text(query.manager) };
  if (text(query.profile) && text(query.manager)) return { kind: "profile", profileId: text(query.profile), managerId: text(query.manager) };
  return draftSeedFromQuery(query) ? { kind: "seed", seed: draftSeedFromQuery(query) } : { kind: "none" };
}

/** The draft a stored launch starts (GET /api/m/:id/launches/:launchId, 01 §15). */
export async function loadLaunchDraft(api, managerId, launchId, seed = {}) {
  const body = await api.manager(managerId).get(`/launches/${enc(launchId)}`);
  const record = body?.launch ?? body?.record ?? body;
  return fromLaunchRecord({ managerId, ...record }, { ...seed, managerId });
}

/** The draft a saved profile starts, with the engine's catalog for the legacy field mapping. */
export async function loadProfileDraft(api, managerId, profileId, seed = {}) {
  const body = await api.manager(managerId).get("/tools/profiles");
  const profiles = [...(Array.isArray(body?.profiles) ? body.profiles : []), ...(Array.isArray(body?.builtin) ? body.builtin : [])];
  const profile = profiles.find((item) => String(item?.id) === profileId);
  if (!profile) return null;
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

export function blankDraft(seed) {
  return createDraft(seed || {});
}
