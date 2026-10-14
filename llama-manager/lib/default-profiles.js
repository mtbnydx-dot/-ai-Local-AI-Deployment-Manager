const engines = require("../../manager-core/engines");

// The builtin launch profiles are recipe data (manager-core/data/recipes, the
// scenario recipes whose profile.managerId is "llama", in profile.order;
// docs/overhaul/01-engines.md §10.3, ENG-6). normalizeLaunchConfig is the
// manager's own normaliser.
function createLlamaDefaultLaunchProfiles(normalizeLaunchConfig, options = {}) {
  return engines.recipes.builtinProfiles("llama", { ...options, normalize: normalizeLaunchConfig });
}

module.exports = {
  createLlamaDefaultLaunchProfiles,
};
