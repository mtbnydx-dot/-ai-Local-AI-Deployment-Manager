// Rules of wizard steps 4 and 5 (07 §6.3): the template-format rows of the
// "Detected template format" card, the companion models (draft head, MTP head,
// vision projector) that pair with the chosen model (02 §7), and what the
// Access step says about the network, the key and the gateway. Pure; the
// steps draw it.

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Roles that are companions of a main model and are offered as pairing candidates. */
export const COMPANION_ROLES = Object.freeze(["draft", "mtp-head", "mmproj"]);

/** The catalog parameter a companion of `role` fills for an engine: the draft model path, or the llama.cpp projector. */
export function companionParam(role, engineId) {
  if (role === "mmproj") return engineId === "llamacpp" ? "llamacpp.mmproj" : "";
  if (role === "draft" || role === "mtp-head") return "speculative.draftModel";
  return "";
}

/**
 * Whether a companion card pairs with a main card (02 §7): the vocabularies are
 * equal, the hidden sizes are equal (a projector may instead match through its
 * output dimension) and the target layer count is absent or equal.
 */
export function pairsWith(main, companion) {
  const hidden = Number(main?.topology?.hiddenSize);
  const vocab = Number(main?.topology?.vocabSize);
  const layers = Number(main?.topology?.layers);
  const link = isObject(companion?.compatibleWith) ? companion.compatibleWith : null;
  if (!link || !(vocab > 0) || Number(link.vocabSize) !== vocab) return false;
  const size = Number(link.hiddenSize);
  if (!(size > 0) || (size !== hidden && !(Number(link.projectionDim) === hidden))) return false;
  const target = Number(link.targetLayers);
  return !(target > 0) || target === layers;
}

/** The library entries that can be companions: { cardId, role, path, name }. */
export function companionEntries(entries) {
  return list(entries).filter(isObject).map((entry) => ({
    cardId: text(entry.card?.cardId),
    role: text(typeof entry.card?.role === "string" ? entry.card.role : entry.card?.role?.value),
    path: text(entry.path),
    name: text(entry.displayName) || text(entry.name) || text(entry.path),
  })).filter((entry) => entry.cardId && entry.path && COMPANION_ROLES.includes(entry.role));
}

/** Template rows of the card for the "Detected template format" card: { id, pointer, value, mono }. Unknown and none are left out. */
export function templateRows(card) {
  const template = isObject(card?.template) ? card.template : {};
  const rows = [];
  const add = (id, pointer, value, mono = true) => {
    const shown = text(value);
    if (shown && shown !== "none") rows.push({ id, pointer, value: shown, mono });
  };
  add("toolFormat", "/template/toolFormat", template.toolFormat);
  add("reasoningFormat", "/template/reasoningFormat", template.reasoningFormat);
  add("source", "/template/source", template.source);
  add("signature", "/template/signatureId", template.signatureId);
  add("thinking", "/template/thinking", template.thinking?.kwarg);
  return rows;
}

/**
 * What the Access step warns about: { lanWithoutKey } is the red warning (07 §6.3
 * step 5); { gateway } says whether the model can be reached through the gateway.
 */
export function accessIssues(draft) {
  const lan = draft?.access?.networkAccess === "lan";
  return { lanWithoutKey: lan && draft?.access?.apiKey === "none", lan };
}

/** The idle-unload policy of a manager (`GET /api/idle-unload` → settings) in terms of this model. */
export function idleSummary(settings, servedName) {
  if (!isObject(settings)) return null;
  const excluded = list(settings.excludeModels).map(String);
  const name = text(servedName);
  return {
    enabled: settings.enabled === true,
    idleMinutes: Number(settings.idleMinutes) || 0,
    wakeOnDemand: settings.wakeOnDemand === true,
    excluded: Boolean(name) && excluded.includes(name),
  };
}
