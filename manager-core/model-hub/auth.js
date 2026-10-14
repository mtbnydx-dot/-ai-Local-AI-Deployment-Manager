"use strict";

// Hugging Face login status, the gated-access check and the shared probe file
// (03 §12). This wraps hf-auth.js (createHfAuthService, unchanged) for both
// engines, so the vLLM-only login card and the llama/vLLM probe drift end here.
//
// - login() opens the local PowerShell window of the official CLI. The token
//   is typed there and never passes through the web UI or this process.
// - access() probes the FIRST WEIGHT FILE of the selected artifact, not
//   config.json, so it also works for GGUF repos and gated weight files.
// - A temporary token reaches this module only as a tokenRef the caller
//   already obtained from the token vault; the value is resolved here, handed
//   to the CLI's environment and never returned.

const { createHfAuthService } = require("../hf-auth");
const { HubError } = require("./errors");
const { listArtifacts, resolveSelection } = require("./selection");
const { createHuggingFaceProvider } = require("./providers/huggingface");

const OFFICIAL_ENDPOINT = "https://huggingface.co";
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const WEIGHT_RE = /\.(?:gguf|safetensors|bin|pt)$/i;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function byPath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The file an access or speed probe should read: the first weight file (in
 * path order, so shard 00001) of the selected artifact. Without an
 * artifactKey it is the first artifact the manifest lists, and a manifest
 * without recognisable artifacts falls back to its first weight-looking file,
 * then to its first file. Returns null for an empty manifest.
 */
function pickProbeFile(manifest, { artifactKey = "" } = {}) {
  const key = text(artifactKey);
  let weights = [];
  if (key) {
    const selected = resolveSelection(manifest, { artifactKey: key });
    weights = (selected.files || []).filter((file) => file.role === "weight").map((file) => file.path);
  } else {
    const first = listArtifacts(manifest)[0];
    if (first) weights = first.files.filter((file) => file.role === "weight").map((file) => file.path);
  }
  const paths = (Array.isArray(manifest?.files) ? manifest.files : []).map((file) => text(file?.path)).filter(Boolean);
  if (!weights.length) weights = paths.filter((filePath) => WEIGHT_RE.test(filePath));
  if (weights.length) return weights.sort(byPath)[0];
  return paths.sort(byPath)[0] || null;
}

function accessStatusForProviderError(error, tokenSent) {
  switch (error?.code) {
    case "repo_not_found":
    case "revision_not_found":
      return "not_found";
    case "hf_approval_required":
      return "approval_required";
    case "hf_auth_invalid":
      return tokenSent ? "invalid_token" : "login_required";
    default:
      return "check_failed";
  }
}

/**
 * createHubAuth({ hfCli, hfHome, service, providers, fetchImpl, tokens,
 * execFileImpl, execFileSyncImpl, platform, baseEnv, logger })
 *   → { status({ tokenRef }), login(), access({ repo, artifactKey, revision, tokenRef }), probeFile(...) }
 * `service` replaces the hf-auth service (tests). `providers` is the hub's
 * createProviders() result; a manifest read with a temporary token uses a
 * one-off official provider so the token never enters a shared cache.
 */
function createHubAuth(options = {}) {
  const tokens = options.tokens || null;
  const providers = options.providers || null;
  const logger = options.logger || console;
  const service = options.service || createHfAuthService({
    hfCli: options.hfCli,
    hfHome: options.hfHome,
    ...(options.execFileImpl ? { execFileImpl: options.execFileImpl } : {}),
    ...(options.execFileSyncImpl ? { execFileSyncImpl: options.execFileSyncImpl } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
  });

  // The token a request carries: a tokenRef from the vault. An unknown or
  // expired ref is a hard error, not a silent downgrade to the cached login.
  function tokenOf(tokenRef) {
    if (tokenRef === undefined || tokenRef === null || tokenRef === "") return "";
    const value = tokens ? tokens.resolve(tokenRef) : null;
    if (!value) throw new HubError("hf_token_expired", "The temporary Hugging Face token is no longer available. Enter it again.", { status: 409 });
    return value;
  }

  async function status({ tokenRef } = {}) {
    const result = await service.getStatus({ token: tokenOf(tokenRef) });
    return {
      connected: Boolean(result.connected),
      username: result.username || null,
      orgs: Array.isArray(result.orgs) ? result.orgs : [],
      source: result.source || null,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  function login() {
    try {
      return service.launchLogin();
    } catch (error) {
      throw new HubError(String(error?.code || "hf_login_failed"), String(error?.message || "The Hugging Face login window could not be opened."), { status: Number(error?.status) || 500 });
    }
  }

  async function manifestFor(repo, revision, token) {
    if (token) {
      const provider = createHuggingFaceProvider({ endpoint: OFFICIAL_ENDPOINT, fetchImpl: options.fetchImpl, getToken: () => token, cache: null });
      return provider.getRepo(repo, { revision });
    }
    if (!providers) throw new HubError("hub_unavailable", "The model providers are not available.", { status: 503 });
    return providers.get("huggingface").getRepo(repo, { revision });
  }

  /**
   * The probe file for `repo` (see pickProbeFile), read from the official
   * manifest. Provider failures propagate.
   */
  async function probeFile({ repo, artifactKey = "", revision = "main", tokenRef } = {}) {
    const manifest = await manifestFor(repo, revision, tokenOf(tokenRef));
    return pickProbeFile(manifest, { artifactKey });
  }

  async function access({ repo, artifactKey = "", revision = "main", tokenRef } = {}) {
    const name = text(repo);
    if (!REPO_RE.test(name)) {
      throw new HubError("invalid_request", "A Hugging Face repository id like owner/model is required.", { status: 400, details: { field: "repo" } });
    }
    const token = tokenOf(tokenRef);
    let file;
    try {
      file = pickProbeFile(await manifestFor(name, text(revision) || "main", token), { artifactKey });
    } catch (error) {
      if (error instanceof HubError) throw error;
      if (error?.name === "ProviderError") {
        const reason = accessStatusForProviderError(error, Boolean(token));
        logger?.debug?.(`[hub] access probe could not list ${name}: ${error.code}`);
        return { granted: false, status: reason, username: null, authorizationUrl: reason === "approval_required" ? `${OFFICIAL_ENDPOINT}/${name}` : null };
      }
      throw error;
    }
    if (!file) return { granted: false, status: "check_failed", username: null, authorizationUrl: null };
    const result = await service.checkRepoAccess(name, { token, probeFile: file });
    return {
      granted: Boolean(result.granted),
      status: String(result.status || "check_failed"),
      username: result.username || null,
      authorizationUrl: result.status === "approval_required" ? `${OFFICIAL_ENDPOINT}/${name}` : null,
    };
  }

  return { status, login, access, probeFile, hasCachedToken: () => service.hasCachedToken() };
}

module.exports = {
  OFFICIAL_ENDPOINT,
  REPO_RE,
  accessStatusForProviderError,
  createHubAuth,
  pickProbeFile,
};
