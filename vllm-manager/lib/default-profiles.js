const engines = require("../../manager-core/engines");

// The builtin launch profiles are recipe data (manager-core/data/recipes, the
// recipes whose profile.managerId is "vllm", in profile.order; docs/overhaul/
// 01-engines.md §10.3, ENG-6). normalizeLaunchConfig is the manager's own
// normaliser; options carry modelsRoot (the models directory the profiles'
// model folders live under) and imageFor (the manager's image per manifest
// runtime key).
function createVllmDefaultLaunchProfiles(normalizeLaunchConfig, options = {}) {
  return engines.recipes.builtinProfiles("vllm", { ...options, normalize: normalizeLaunchConfig });
}

module.exports = {
  createVllmDefaultLaunchProfiles,
};
