const engines = require("../../manager-core/engines");
const runtimeManifest = require("../../manager-core/runtime-manifest");

// The Pennyroyal v2.5.1 profile is the recipe `pennyroyal-v251`
// (manager-core/data/recipes, docs/overhaul/01-engines.md §10.3, ENG-6): its
// constraints, launch data, memory formula and builtin profile are data. This
// module keeps the names the manager and its tests import and answers them from
// that recipe and the runtime manifest; the preset is scoped to the one
// immutable, locally qualified image, and other SGLang/Flash-Next images keep
// their existing compatibility rules.
const RECIPE_ID = "pennyroyal-v251";
const MANIFEST_KEY = "sglangPennyroyal";

function recipes() {
  return engines.recipes;
}

function pennyroyalRecipe() {
  const recipe = recipes().getRecipeStore().get(RECIPE_ID);
  if (!recipe) throw new Error(`The bundled recipe ${RECIPE_ID} is not available.`);
  return recipe;
}

const PENNYROYAL_IMAGE = runtimeManifest.runtimeImageReference(MANIFEST_KEY);
const bundled = pennyroyalRecipe();
const PENNYROYAL_CACHE_VOLUME = /source=([^,]+)/.exec(bundled.slots?.cacheMount || "")?.[1] || "";
const PENNYROYAL_TOKENIZER_SHA256 = bundled.validation.find((rule) => rule.kind === "tokenizerSha256").sha256;
const PENNYROYAL_ROPE_OVERRIDE = bundled.fixedArgs[bundled.fixedArgs.indexOf("--json-model-override-args") + 1];
// Qualified 524K/TP1 profile peaked at ~86,855 MiB excluding the desktop.
// Admission adds its existing OS reserve and startup margin on top of this.
// SGLang's mem-fraction-static is not a vLLM whole-device reservation fraction.
const PENNYROYAL_VRAM_RESERVATION_MIB = recipes().measuredMemoryMiB(bundled, { sglangMaxTotalTokens: 524288 });
// The profile's launch form, as the old PENNYROYAL_DEFAULTS spelled it.
const PENNYROYAL_DEFAULTS = Object.freeze(recipes().profileLegacyConfig(bundled));

function isPennyroyalImage(image) {
  const text = String(image || "").trim();
  if (!text) return false;
  try {
    return engines.getEngineRegistry().resolveRuntime("sglang", { image: text }).manifestKey === MANIFEST_KEY;
  } catch {
    return false;
  }
}

// The reserved VRAM of the 524K qualified profile, scaled by the shared KV
// pool actually requested (memory.measuredMiB of the recipe).
function pennyroyalVramReservationMb(options = {}) {
  const reserved = recipes().measuredMemoryMiB(RECIPE_ID, {
    sglangMaxTotalTokens: options.sglangMaxTotalTokens,
    maxModelLen: options.maxModelLen || options.contextTokens,
  });
  return reserved ?? PENNYROYAL_VRAM_RESERVATION_MIB;
}

function pennyroyalOptionErrors(options = {}) {
  return recipes().legacyOptionErrors(RECIPE_ID, options);
}

function createPennyroyalPreset(options = {}) {
  return recipes().presetFromRecipe(RECIPE_ID, options, {}, {});
}

// The qualified launch data of the Pennyroyal profile in the recipe "fixed"
// shape the SGLang adapter consumes through its slots (01-engines §7).
function pennyroyalLaunchFixed(options = {}) {
  return recipes().renderLaunchFixed(pennyroyalRecipe(), { opts: options });
}

module.exports = { PENNYROYAL_IMAGE, PENNYROYAL_CACHE_VOLUME, PENNYROYAL_DEFAULTS,
  PENNYROYAL_VRAM_RESERVATION_MIB, pennyroyalVramReservationMb,
  PENNYROYAL_TOKENIZER_SHA256, PENNYROYAL_ROPE_OVERRIDE,
  isPennyroyalImage, pennyroyalOptionErrors, createPennyroyalPreset, pennyroyalLaunchFixed };
