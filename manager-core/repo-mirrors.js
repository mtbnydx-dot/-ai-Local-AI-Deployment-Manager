"use strict";

const { loadReferenceFile } = require("./reference-data");

const MIRRORS_FILE = "repo-mirrors.json";
let cache = null;

function loadRepoMirrors(options = {}) {
  if (cache && !options.force) return cache;
  const loaded = loadReferenceFile(MIRRORS_FILE, options.now);
  const data = loaded.value && typeof loaded.value === "object" ? loaded.value : {};
  cache = {
    ...loaded,
    organizations: data.organizations && typeof data.organizations === "object" ? data.organizations : {},
    repositories: data.repositories && typeof data.repositories === "object" ? data.repositories : {},
  };
  return cache;
}

function clearRepoMirrorsCache() {
  cache = null;
}

// Candidate ModelScope ids for a Hugging Face repository, most likely first.
// The same id is always the last resort because many organisations publish
// under an identical namespace on both hubs.
function suggestModelScopeRepo(hfRepo, options = {}) {
  const repo = String(hfRepo || "").trim();
  const [organization, ...rest] = repo.split("/");
  const name = rest.join("/");
  if (!organization || !name) return { repo, candidates: [], confidence: "" };
  const mirrors = loadRepoMirrors(options);
  const explicit = mirrors.repositories[repo];
  if (explicit) return { repo, candidates: [explicit], confidence: "mapped" };
  const namespaces = mirrors.organizations[organization]
    || Object.entries(mirrors.organizations).find(([key]) => key.toLowerCase() === organization.toLowerCase())?.[1]
    || [];
  const candidates = [];
  for (const namespace of Array.isArray(namespaces) ? namespaces : [namespaces]) {
    if (namespace && !candidates.includes(`${namespace}/${name}`)) candidates.push(`${namespace}/${name}`);
  }
  if (!candidates.includes(repo)) candidates.push(repo);
  return { repo, candidates, confidence: namespaces.length ? "organization" : "same-name" };
}

module.exports = {
  REPO_MIRRORS_FILE: MIRRORS_FILE,
  clearRepoMirrorsCache,
  loadRepoMirrors,
  suggestModelScopeRepo,
};
