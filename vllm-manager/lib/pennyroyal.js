const engines = require("../../manager-core/engines");
const runtimeManifest = require("../../manager-core/runtime-manifest");

// The Pennyroyal v2.5.1 profile is the recipe `pennyroyal-v251`
// (manager-core/data/recipes, docs/overhaul/01-engines.md §10.3, ENG-6): its
// constraints, launch data, memory formula and builtin profile are data. This
// module only re-exports that data under the names the tests and the golden
// capture import (ENG-23): the recipe's values and the recipe functions bound
// to its id. No manager code branches on the Pennyroyal image; the image
// selects the recipe through the runtime manifest (legacy-aliases
// RUNTIME_RECIPES).
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

// The recipe memory the SGLang memory model reserves for this profile
// (memory-models.js recipeMemory, 01-engines §12): the measured MiB of the
// 524K qualified profile scaled by the shared KV pool actually requested, and
// the recipe's estimatePolicy. The managers ask recipes.pinnedRecipeMemory for
// whatever image they launch; this is the same answer for the Pennyroyal image.
function pennyroyalRecipeMemory(options = {}) {
  return recipes().pinnedRecipeMemory("sglang", PENNYROYAL_IMAGE, options);
}

function pennyroyalVramReservationMb(options = {}) {
  return pennyroyalRecipeMemory(options)?.measuredMiB ?? PENNYROYAL_VRAM_RESERVATION_MIB;
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
  PENNYROYAL_VRAM_RESERVATION_MIB, pennyroyalVramReservationMb, pennyroyalRecipeMemory,
  PENNYROYAL_TOKENIZER_SHA256, PENNYROYAL_ROPE_OVERRIDE,
  pennyroyalOptionErrors, createPennyroyalPreset, pennyroyalLaunchFixed };
