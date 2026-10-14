"use strict";

// Informational speed probe across the three sources (03 §13, POST
// /sources/probe). It times a ranged read of the first weight file with
// manager-core/mirror-probe.js and sends no credential anywhere: the probe
// takes no token, so nothing can reach hf-mirror.com or ModelScope. It never
// persists settings; the answer is cached for 10 minutes per repo and file.

const { probeHfMirrorSpeed } = require("../mirror-probe");
const { HubError } = require("./errors");
const { REPO_RE } = require("./auth");

const PROBE_CACHE_MS = 10 * 60 * 1000;
const SOURCE_IDS = Object.freeze({ official: "huggingface", mirror: "hf-mirror", modelscope: "modelscope" });

function encodePath(filePath) {
  return String(filePath).split("/").map(encodeURIComponent).join("/");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// One probe entry in the hub's vocabulary; the legacy fields (label, status,
// bytes, repo) stay for the manager shim's golden shape (03 §15).
function normalizeSource(raw) {
  return {
    source: SOURCE_IDS[raw.source] || raw.source,
    label: raw.label || null,
    ok: Boolean(raw.ok),
    status: Number(raw.status) || 0,
    ms: Number(raw.ms) || 0,
    bytes: Number(raw.bytes) || 0,
    bytesPerSec: Number(raw.bytesPerSec) || 0,
    error: raw.ok ? null : String(raw.error || "unreachable"),
    repo: raw.repo || null,
  };
}

/**
 * createSourceProbe({ auth, fetchImpl, clock, probe, ttlMs })
 *   → { probe({ repo, artifactKey, revision, refresh }) }
 * `auth.probeFile` picks the file; without a repo the probe reads the small
 * default file of mirror-probe.js. `probe` replaces probeHfMirrorSpeed (tests).
 */
function createSourceProbe(options = {}) {
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : PROBE_CACHE_MS;
  const run = typeof options.probe === "function" ? options.probe : probeHfMirrorSpeed;
  const cache = new Map();

  async function measure(repo, file) {
    const raw = await run({ fetchImpl: options.fetchImpl, ...(repo ? { model: repo } : {}), ...(file ? { file: encodePath(file) } : {}) });
    const sources = (Array.isArray(raw.sources) ? raw.sources : []).map(normalizeSource);
    return {
      ok: Boolean(raw.ok),
      repo: raw.repo || repo || null,
      file: file || raw.file || null,
      sources,
      recommended: SOURCE_IDS[raw.recommended] || "huggingface",
      at: new Date(clock.now()).toISOString(),
    };
  }

  async function probe({ repo = "", artifactKey = "", revision = "main", refresh = false } = {}) {
    const name = String(repo || "").trim();
    if (name && !REPO_RE.test(name)) {
      throw new HubError("invalid_request", "repo must look like owner/model.", { status: 400, details: { field: "repo" } });
    }
    if (artifactKey && !name) {
      throw new HubError("invalid_request", "artifactKey needs a repo.", { status: 400, details: { field: "artifactKey" } });
    }
    let file = null;
    if (name) {
      try {
        file = await options.auth.probeFile({ repo: name, artifactKey, revision });
      } catch (error) {
        // An unreadable manifest must not stop an informational probe; the
        // shared default file still times the three hosts.
        if (error instanceof HubError && error.status < 500) throw error;
        file = null;
      }
    }
    const key = `${name}|${file || ""}`;
    const hit = cache.get(key);
    if (!refresh && hit && clock.now() - hit.storedAt < ttlMs) return clone(hit.value);
    const value = await measure(file ? name : "", file);
    cache.set(key, { storedAt: clock.now(), value });
    return clone(value);
  }

  return { probe };
}

module.exports = { PROBE_CACHE_MS, createSourceProbe };
