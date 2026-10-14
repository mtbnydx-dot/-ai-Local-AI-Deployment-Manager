"use strict";

// The Hugging Face mirror (03 §4.2): the same API as huggingface.co at
// sources.mirrorEndpoint, with credentials switched off for good. The
// provider never calls a token source, sendsCredentials is false, and its
// fetchImpl throws credential_host_violation when a caller tries to attach a
// token or an authorization header (a mirror must never see a Hugging Face
// credential). Gated repositories therefore report access.status
// "official_required" upstream of here (HUB-10).

const { DEFAULT_TIMEOUT_MS } = require("./http");
const { createHuggingFaceProvider } = require("./huggingface");

const DEFAULT_MIRROR_ENDPOINT = "https://hf-mirror.com";

/**
 * createHfMirrorProvider({ endpoint, fetchImpl, cache, clock, timeoutMs })
 * → HubProvider with id "hf-mirror".
 */
function createHfMirrorProvider(options = {}) {
  return createHuggingFaceProvider({
    id: "hf-mirror",
    endpoint: options.endpoint || DEFAULT_MIRROR_ENDPOINT,
    fetchImpl: options.fetchImpl,
    getToken: () => "",
    credentials: false,
    cache: options.cache,
    clock: options.clock,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    userAgent: options.userAgent,
  });
}

module.exports = { DEFAULT_MIRROR_ENDPOINT, createHfMirrorProvider };
