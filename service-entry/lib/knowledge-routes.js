"use strict";

// Layered model knowledge at the entry (02 §8, §17, §19, MOD-15), mounted by
// one line in the entry's route-mount table.
//
//   GET    /api/knowledge                          merged entries of one kind with layer, matches and hits
//   GET    /api/knowledge/status                   every domain; always 200; manager domains over the proxy
//   POST   /api/knowledge/import                   {url|content}: preview, then {confirm:true, sha256} writes the pack
//   DELETE /api/knowledge/packs/:packId            x-confirm: delete
//   PUT    /api/knowledge/overrides/models/:cardId per-model override (match = the card's contentDigest)
//   POST   /api/knowledge/reload                   re-reads the layers now
//
// Imported packs are layer 3 (below the owner's own files), written to
// <AI_ROOT>/config/knowledge.d/packs/<packId>@<sha12>.json only after the owner
// confirmed the exact bytes by sha256; a pack is never applied automatically.
// A pack URL must be https, resolve to public addresses only (the connection
// is pinned to the address that was checked), refuse redirects, answer JSON
// and stay under 1 MiB. Candidate files are validated by a throwaway loader
// in a temp directory, so an invalid pack or override never reaches the real
// layers. Writes are owner-only (auth.checkWrite); 05's guard already holds
// viewers to the registered GET rows below. Errors use the 00 §4.2 envelope.

const crypto = require("node:crypto");
const dns = require("node:dns");
const fs = require("node:fs");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const core = require("../../manager-core");
const knowledgeModule = require("../../manager-core/model-inspector/knowledge");
const { redactSecrets } = require("../../manager-core/secret-redactor");
const { resolvePrincipal } = require("./engine-routes");
const {
  defaultReadJsonObjectBody, defaultSendJson, errorBody, fieldError, requestIdOf,
} = require("./model-card-routes");

const OWNER = "02";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PACK_BYTES = 1024 * 1024;
// A pack travels inside a JSON body, which escapes quotes and newlines.
const MAX_IMPORT_BODY_BYTES = MAX_PACK_BYTES * 2 + 4096;
const MANAGER_TIMEOUT_MS = 2000;
const FETCH_TIMEOUT_MS = 10000;
const MAX_MATCH_CARDS = 300;
const MANAGER_DOMAINS = Object.freeze(["engines", "recipes", "launch-params"]);
const READ_METHODS = new Set(["GET", "HEAD"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CARD_PATTERN = /^mc_[a-z2-7]{20}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FATAL_PACK_CODES = new Set(["invalid_json", "not_an_object", "unknown_kind", "invalid_header", "schema_unavailable", "empty_file", "file_too_large", "unreadable", "not_a_file"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256Of(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function basenameOf(value) {
  const text = String(value || "");
  return text.split(/[\\/]/).filter(Boolean).pop() || text;
}

// --- redaction (02 §17) ------------------------------------------------------------

const DRIVE_PATH_RE = /(^|[^A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|*?,;]*/g;
const UNC_PATH_RE = /\\\\[^\s"'<>|,;]+/g;

// An error message keeps its text; a path inside it shrinks to its last segment.
function scrubMessage(text) {
  const shorten = (match, lead = "") => `${lead}${basenameOf(match.slice(lead.length))}`;
  return redactSecrets(String(text ?? "").replace(DRIVE_PATH_RE, shorten).replace(UNC_PATH_RE, (match) => basenameOf(match)));
}

function redactIssue(item) {
  if (!isPlainObject(item)) return item;
  const out = { ...item };
  if (typeof out.file === "string") out.file = basenameOf(out.file);
  if (typeof out.message === "string") out.message = scrubMessage(out.message);
  return out;
}

function redactLayer(layer) {
  if (!isPlainObject(layer)) return layer;
  const out = { ...layer };
  // The directory behind a layer is the layer's name for a viewer.
  if ("path" in out) out.path = String(layer.layer || "");
  if (Array.isArray(layer.files)) {
    out.files = layer.files.map((file) => {
      if (!isPlainObject(file)) return file;
      const copy = { ...file };
      if (typeof copy.name === "string") copy.name = basenameOf(copy.name);
      for (const key of ["errors", "warnings"]) {
        if (Array.isArray(copy[key])) copy[key] = copy[key].map(redactIssue);
      }
      return copy;
    });
  }
  return out;
}

/** GET /api/knowledge/status for a viewer: layer paths become layer names, file names basenames, messages path-free. */
function redactKnowledgeStatusForViewer(body) {
  if (!isPlainObject(body) || !Array.isArray(body.domains)) return body;
  return {
    ...body,
    domains: body.domains.map((domain) => {
      if (!isPlainObject(domain)) return domain;
      const out = { ...domain };
      if (Array.isArray(domain.layers)) out.layers = domain.layers.map(redactLayer);
      if (Array.isArray(domain.errors)) out.errors = domain.errors.map(redactIssue);
      if (Array.isArray(domain.staleFiles)) out.staleFiles = domain.staleFiles.map(basenameOf);
      return out;
    }),
  };
}

/** GET /api/knowledge for a viewer: no file and no sources; the layer name stays. */
function redactKnowledgeForViewer(body) {
  if (!isPlainObject(body) || !Array.isArray(body.entries)) return body;
  return {
    ...body,
    entries: body.entries.map((entry) => {
      if (!isPlainObject(entry)) return entry;
      const { file: _file, sources: _sources, ...rest } = entry;
      return rest;
    }),
  };
}

const viewerRoutes = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/knowledge", redact: redactKnowledgeForViewer }),
  Object.freeze({ method: "GET", path: "/api/knowledge/status", redact: redactKnowledgeStatusForViewer }),
]);

const adminOnlyRoutes = Object.freeze([
  Object.freeze({ method: "POST", path: "/api/knowledge/import" }),
  Object.freeze({ method: "DELETE", path: "/api/knowledge/packs/:packId" }),
  Object.freeze({ method: "PUT", path: "/api/knowledge/overrides/models/:cardId" }),
  Object.freeze({ method: "POST", path: "/api/knowledge/reload" }),
]);

/** Registers viewerRoutes and adminOnlyRoutes in 05's registry; a row that cannot be registered stays owner-only. */
function registerKnowledgeRoutes(registry, warn = () => {}) {
  const registrations = [
    ...viewerRoutes.map((route) => () => registry.registerRoute({ owner: OWNER, method: route.method, path: route.path, redact: route.redact })),
    ...adminOnlyRoutes.map((route) => () => registry.registerAdminOnly({ owner: OWNER, method: route.method, path: route.path })),
  ];
  for (const register of registrations) {
    try {
      register();
    } catch (error) {
      warn(`knowledge-routes: a viewer registry entry was not registered and stays owner-only: ${error?.message || error}`);
    }
  }
}

// --- pack URLs (02 §19) --------------------------------------------------------------------

function codedError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

const BLOCKED_ADDRESSES = (() => {
  const list = new net.BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ]) list.addSubnet(address, prefix, "ipv4");
  for (const [address, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]]) {
    list.addSubnet(address, prefix, "ipv6");
  }
  return list;
})();

// The IPv4 address an IPv6 text embeds (::ffff:a.b.c.d, ::ffff:7f00:1, 64:ff9b::a.b.c.d), or "".
function embeddedIpv4(address) {
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return "";
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** True for an address that is not a public unicast address (loopback, private, link-local, ...). */
function isBlockedAddress(address) {
  const text = String(address || "").trim().replace(/^\[|\]$/g, "");
  const family = net.isIP(text);
  if (!family) return true;
  if (family === 6) {
    const embedded = embeddedIpv4(text);
    if (embedded) return BLOCKED_ADDRESSES.check(embedded, "ipv4");
    return BLOCKED_ADDRESSES.check(text.toLowerCase(), "ipv6");
  }
  return BLOCKED_ADDRESSES.check(text, "ipv4");
}

/**
 * Fetches a knowledge pack: https only, every resolved address public, the
 * connection pinned to the first one, no redirects, JSON content type, at most
 * maxBytes. Options (tests): lookup(hostname) -> [{address, family}], request
 * (https.request), timeoutMs, maxBytes. Resolves { text }.
 */
async function fetchPackText(urlText, options = {}) {
  let url;
  try {
    url = new URL(String(urlText));
  } catch {
    throw codedError(400, "invalid_url", "The pack URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw codedError(400, "invalid_url", "A pack URL must use https.");
  if (url.username || url.password) throw codedError(400, "invalid_url", "A pack URL must not carry credentials.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const maxBytes = options.maxBytes || MAX_PACK_BYTES;
  const lookup = typeof options.lookup === "function" ? options.lookup : (name) => dns.promises.lookup(name, { all: true, verbatim: true });
  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      addresses = await lookup(hostname);
    } catch {
      throw codedError(502, "pack_fetch_failed", "The pack host could not be resolved.");
    }
  }
  if (!Array.isArray(addresses) || !addresses.length) throw codedError(502, "pack_fetch_failed", "The pack host could not be resolved.");
  if (addresses.some((item) => isBlockedAddress(item?.address))) {
    throw codedError(400, "url_not_allowed", "The pack host resolves to a loopback, private or link-local address.");
  }
  const target = addresses[0];
  const request = typeof options.request === "function" ? options.request : https.request;
  const timeoutMs = options.timeoutMs || FETCH_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const call = request({
      protocol: "https:",
      host: hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: net.isIP(hostname) ? undefined : hostname,
      headers: { accept: "application/json", "user-agent": "local-ai-platform-knowledge", host: url.host },
      lookup: (_name, lookupOptions, callback) => {
        if (lookupOptions && lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      },
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400) {
        response.resume();
        finish(reject, codedError(502, "pack_fetch_failed", "The pack URL redirects, which is refused; use the final address."));
        return;
      }
      if (status !== 200) {
        response.resume();
        finish(reject, codedError(502, "pack_fetch_failed", `The pack host answered HTTP ${status}.`));
        return;
      }
      if (!/\bjson\b/i.test(String(response.headers?.["content-type"] || ""))) {
        response.resume();
        finish(reject, codedError(400, "pack_invalid", "The pack URL did not answer with a JSON content type."));
        return;
      }
      const declared = Number(response.headers?.["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.resume();
        finish(reject, codedError(413, "pack_too_large", `A pack may be at most ${maxBytes} bytes.`));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          call.destroy();
          finish(reject, codedError(413, "pack_too_large", `A pack may be at most ${maxBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(resolve, { text: Buffer.concat(chunks, total).toString("utf8") }));
      response.on("error", () => finish(reject, codedError(502, "pack_fetch_failed", "The pack download was interrupted.")));
    });
    timer = setTimeout(() => {
      call.destroy();
      finish(reject, codedError(502, "pack_fetch_failed", "The pack host did not answer in time."));
    }, timeoutMs);
    timer.unref?.();
    call.on("error", () => finish(reject, codedError(502, "pack_fetch_failed", "The pack host could not be reached.")));
    call.end();
  });
}

// --- files ------------------------------------------------------------------------------------

async function writeFileAtomic(file, text) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(temp, text, "utf8");
    await fs.promises.rename(temp, file);
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// "/engines/vllm/parsers.tool must be ..." -> {field: "engines.vllm.parsers.tool", message: "must be ..."}.
function fieldErrorsFrom(issues) {
  const out = [];
  for (const issue of issues) {
    const parts = String(issue.message || "").split("; ");
    for (const part of parts) {
      const found = /^(\/\S*)\s+(.*)$/.exec(part);
      out.push(fieldError(found ? found[1].slice(1).replace(/\//g, ".") || (issue.entryId || "entry") : issue.entryId || "entry", String(issue.code || "invalid"), scrubMessage(found ? found[2] : part)));
    }
  }
  return out;
}

/**
 * createKnowledgeRoutes({ auth, sendJson, readJsonObjectBody, managerClient, managers, loader, models,
 *   cacheDir, fetchPack, logger, now }) -> { handle(req, res, url) -> Promise<boolean>, close() }.
 * `loader` is the knowledge loader whose config directory receives packs and
 * overrides (default: the process-wide loader of core.models.knowledge).
 */
function createKnowledgeRoutes(options = {}) {
  const auth = options.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function") {
    throw new TypeError("createKnowledgeRoutes needs the request-auth seam");
  }
  const sendJson = typeof options.sendJson === "function" ? options.sendJson : defaultSendJson;
  const readJsonObjectBody = typeof options.readJsonObjectBody === "function" ? options.readJsonObjectBody : defaultReadJsonObjectBody;
  const logger = options.logger || console;
  const models = options.models || core.models;
  const managers = Array.isArray(options.managers) ? options.managers : [];
  const now = typeof options.now === "function" ? options.now : Date.now;
  const fetchPack = typeof options.fetchPack === "function" ? options.fetchPack : (url) => fetchPackText(url, options.fetch || {});
  let queue = Promise.resolve();

  const getLoader = () => options.loader || models.knowledge.getLoader();

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks a request.
    }
  }

  function send(res, status, body, requestId) {
    sendJson(res, body, status, requestId ? { "x-request-id": requestId } : {});
  }

  function sendError(res, status, code, message, extra, requestId) {
    send(res, status, errorBody(code, message, extra), requestId);
  }

  // One write at a time: packs, overrides and deletes never interleave.
  function serialize(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  // --- a throwaway loader over candidate files

  /**
   * Loads `files` ({ "packs/x.json": text }) on top of the bundled knowledge in
   * a temp directory. Returns { knowledge, loader, status, cleanup }.
   */
  async function trialLoad(files) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "knowledge-trial-"));
    const cleanup = async () => {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
    };
    try {
      const configDir = path.join(root, "config");
      for (const [name, text] of Object.entries(files)) await writeFileAtomic(path.join(configDir, "knowledge.d", ...name.split("/")), text);
      const real = getLoader();
      const loader = knowledgeModule.createKnowledgeLoader({
        bundledDir: real.bundledDir,
        configDir,
        aiRoot: root,
        cacheDir: path.join(root, "cache"),
        registry: null,
        recheckMs: 0,
        flushIntervalMs: 0,
      });
      const knowledge = loader.load({ force: true });
      return { knowledge, loader, status: loader.status(), cleanup: async () => { loader.close(); await cleanup(); } };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  // --- GET /api/knowledge

  function cardsDir() {
    return options.cacheDir || models.cache.defaultCacheDir();
  }

  // cardId lists per entry id: the families / template signatures the cached cards match.
  function matchesFor(kind) {
    const matches = new Map();
    if (kind === "error-signatures") return matches;
    let names = [];
    try {
      names = fs.readdirSync(cardsDir()).filter((name) => /^mc_[a-z2-7]{20}\.json$/.test(name)).slice(0, MAX_MATCH_CARDS);
    } catch {
      return matches;
    }
    const loader = getLoader();
    for (const name of names) {
      let card = null;
      try {
        card = models.getCard(name.slice(0, -5), { cacheDir: cardsDir() });
      } catch {
        card = null;
      }
      if (!card) continue;
      let id = null;
      try {
        id = kind === "families" ? loader.matchFamily(card)?.entry?.id : card.template?.signatureId;
      } catch {
        id = null;
      }
      if (!id) continue;
      if (!matches.has(id)) matches.set(id, []);
      matches.get(id).push(card.cardId);
    }
    return matches;
  }

  function listKnowledge(res, url, requestId) {
    const kind = url.searchParams.get("kind") || "families";
    if (!knowledgeModule.KINDS.includes(kind)) {
      sendError(res, 400, "unknown_kind", `kind must be one of ${knowledgeModule.KINDS.join(", ")}.`, undefined, requestId);
      return;
    }
    const query = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 200);
    const withMatches = ["1", "true"].includes(url.searchParams.get("withMatches"));
    const loader = getLoader();
    let entries = loader.entries(kind);
    if (query) entries = entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(query));
    const hits = new Map();
    try {
      for (const item of loader.status().heuristicHits?.entries || []) {
        if (item.kind === kind) hits.set(item.id, item.count);
      }
    } catch {
      // Counters are statistics.
    }
    const matches = withMatches ? matchesFor(kind) : null;
    send(res, 200, {
      ok: true,
      kind,
      entries: entries.map((entry) => ({
        ...entry,
        ...(matches ? { matches: matches.get(entry.id) || [] } : {}),
        heuristicHits: hits.get(entry.id) || 0,
      })),
    }, requestId);
  }

  // --- GET /api/knowledge/status

  function ownDomains() {
    try {
      return knowledgeModule.collectStatusDomains(getLoader());
    } catch (error) {
      return [{ domain: "models", unavailable: true, layers: [], errors: [{ file: "", entryId: "", code: "status_failed", message: String(error?.message || error) }] }];
    }
  }

  async function knowledgeStatus(res, requestId) {
    const domains = ownDomains();
    const have = new Set(domains.map((item) => item.domain));
    const managerStates = [];
    const client = typeof options.managerClient === "function" ? options.managerClient() : options.managerClient;
    const answers = await Promise.all(managers.map(async (manager) => {
      if (!client || typeof client.get !== "function") return { manager, failure: "manager_client_unavailable" };
      try {
        const result = await client.get(manager.id, "knowledge/status", { timeoutMs: MANAGER_TIMEOUT_MS, requestId });
        if (result?.ok && isPlainObject(result.data) && Array.isArray(result.data.domains)) return { manager, data: result.data };
        return { manager, failure: String(result?.code || "manager_unreachable") };
      } catch {
        return { manager, failure: "manager_unreachable" };
      }
    }));
    for (const { manager, data, failure } of answers) {
      managerStates.push({ managerId: manager.id, ok: !failure, ...(failure ? { code: failure } : {}) });
      if (failure) continue;
      for (const domain of data.domains) {
        if (!isPlainObject(domain) || typeof domain.domain !== "string" || domain.domain === "models" || have.has(domain.domain)) continue;
        have.add(domain.domain);
        domains.push({ ...domain, managerId: manager.id });
      }
    }
    for (const name of MANAGER_DOMAINS) {
      if (!have.has(name)) domains.push({ domain: name, unavailable: true, layers: [], errors: [] });
    }
    const modelsDomain = domains.find((item) => item.domain === "models");
    send(res, 200, { ok: true, domains, digest: modelsDomain?.digest || null, managers: managerStates }, requestId);
  }

  // --- POST /api/knowledge/import

  async function packText(body) {
    if (typeof body.url === "string") {
      const fetched = await fetchPack(body.url.trim());
      return String(fetched?.text ?? "");
    }
    if (typeof body.content === "string") return body.content;
    return `${JSON.stringify(body.content, null, 2)}\n`;
  }

  function validateImportBody(body) {
    const errors = [];
    const hasUrl = body.url !== undefined && body.url !== null;
    const hasContent = body.content !== undefined && body.content !== null;
    if (hasUrl === hasContent) errors.push(fieldError("url", hasUrl ? "conflict" : "required", "Give either url or content."));
    if (hasUrl && (typeof body.url !== "string" || !body.url.trim() || body.url.length > 2048)) errors.push(fieldError("url", "invalid", "url must be an https URL."));
    if (hasContent && typeof body.content !== "string" && !isPlainObject(body.content)) errors.push(fieldError("content", "invalid", "content must be the pack as JSON text or an object."));
    if (body.confirm !== undefined && typeof body.confirm !== "boolean") errors.push(fieldError("confirm", "invalid", "confirm must be true or false."));
    if (body.confirm === true && !SHA256_PATTERN.test(String(body.sha256 || ""))) errors.push(fieldError("sha256", "required", "Confirm with the sha256 of the preview."));
    return errors;
  }

  function packIdOf(value, sha) {
    const given = value?.pack?.id;
    if (given === undefined || given === null) return `${String(value.kind)}-${sha.slice(0, 8)}`;
    return typeof given === "string" && ID_PATTERN.test(given) ? given : null;
  }

  async function previewPack(text, sha) {
    let value;
    try {
      value = JSON.parse(text.replace(/^﻿/, ""));
    } catch (error) {
      throw codedError(400, "pack_invalid", "The pack is not valid JSON.", { errors: [fieldError("content", "invalid_json", scrubMessage(error.message))] });
    }
    if (!isPlainObject(value) || !knowledgeModule.KINDS.includes(value.kind)) {
      throw codedError(400, "pack_invalid", `A pack is a knowledge file whose kind is one of ${knowledgeModule.KINDS.join(", ")}.`, { errors: [fieldError("kind", "unknown_kind", "kind is missing or unknown.")] });
    }
    const packId = packIdOf(value, sha);
    if (!packId) throw codedError(400, "pack_invalid", "pack.id must be 1-64 characters: letters, digits, dot, underscore or hyphen.", { errors: [fieldError("pack.id", "invalid", "pack.id is not a valid id.")] });
    const file = `packs/${packId}@${sha.slice(0, 12)}.json`;
    const trial = await trialLoad({ [file]: text });
    try {
      const issues = trial.status.errors.filter((item) => item.layer === "pack" && item.severity !== "warning");
      const fatal = issues.filter((item) => FATAL_PACK_CODES.has(item.code));
      if (fatal.length) throw codedError(400, "pack_invalid", "The pack is not a valid knowledge file.", { errors: fieldErrorsFrom(fatal) });
      const current = new Map(getLoader().entries(value.kind).map((entry) => [entry.id, entry]));
      const valid = trial.loader.entries(value.kind).filter((entry) => entry.layer === "pack").map((entry) => entry.id);
      const packLayer = trial.status.layers.find((layer) => layer.layer === "pack");
      return {
        packId,
        kind: value.kind,
        file,
        diff: {
          added: valid.filter((id) => !current.has(id)),
          replaced: valid.filter((id) => current.has(id)),
          deleted: Array.isArray(packLayer?.deleted) ? [...packLayer.deleted] : [],
          invalidEntries: issues.map((item) => ({ entryId: item.entryId || "", code: item.code, message: scrubMessage(item.message) })),
        },
      };
    } finally {
      await trial.cleanup();
    }
  }

  async function importPack(req, res, requestId) {
    let body;
    try {
      body = await readJsonObjectBody(req, MAX_IMPORT_BODY_BYTES);
    } catch (error) {
      if (Number(error?.status) === 413) sendError(res, 413, "pack_too_large", `A pack may be at most ${MAX_PACK_BYTES} bytes.`, undefined, requestId);
      else sendError(res, 400, "invalid_json", "The request body must be a JSON object.", undefined, requestId);
      return;
    }
    const errors = validateImportBody(body);
    if (errors.length) {
      sendError(res, 400, "invalid_request", "The import request is not valid.", { errors }, requestId);
      return;
    }
    try {
      const text = await packText(body);
      if (Buffer.byteLength(text) > MAX_PACK_BYTES) throw codedError(413, "pack_too_large", `A pack may be at most ${MAX_PACK_BYTES} bytes.`);
      const sha = sha256Of(text);
      if (body.confirm === true && body.sha256 !== sha) {
        throw codedError(409, "sha_mismatch", "The pack changed since the preview.", { hint: "Preview the pack again and confirm that version." });
      }
      const preview = await previewPack(text, sha);
      if (body.confirm !== true) {
        send(res, 200, { ok: true, packId: preview.packId, sha256: sha, kind: preview.kind, bytes: Buffer.byteLength(text), diff: preview.diff }, requestId);
        return;
      }
      if (!preview.diff.added.length && !preview.diff.replaced.length && !preview.diff.deleted.length) {
        throw codedError(400, "pack_invalid", "The pack has no usable entries.", { errors: preview.diff.invalidEntries.map((item) => fieldError(item.entryId || "entries", item.code, item.message)) });
      }
      const written = await serialize(async () => {
        const loader = getLoader();
        const dir = path.join(loader.knowledgeDir, "packs");
        const target = path.join(dir, path.basename(preview.file));
        await writeFileAtomic(target, text);
        // Re-importing a pack replaces its earlier versions.
        for (const name of await fs.promises.readdir(dir).catch(() => [])) {
          if (name.startsWith(`${preview.packId}@`) && name.endsWith(".json") && path.join(dir, name) !== target) await fs.promises.rm(path.join(dir, name), { force: true });
        }
        return loader.load({ force: true }).digest;
      });
      send(res, 200, { ok: true, packId: preview.packId, sha256: sha, kind: preview.kind, diff: preview.diff, digest: written }, requestId);
    } catch (error) {
      if (!sendCoded(res, error, requestId)) sendInternal(res, error, "import", requestId);
    }
  }

  // --- DELETE /api/knowledge/packs/:packId

  async function deletePack(req, res, packId, requestId) {
    if (String(req.headers?.["x-confirm"] || "").toLowerCase() !== "delete") {
      sendError(res, 400, "confirmation_required", "Deleting a pack needs the header x-confirm: delete.", undefined, requestId);
      return;
    }
    if (!ID_PATTERN.test(packId)) {
      sendError(res, 404, "pack_not_found", "No imported pack has this id.", undefined, requestId);
      return;
    }
    const removed = await serialize(async () => {
      const loader = getLoader();
      const dir = path.join(loader.knowledgeDir, "packs");
      const names = (await fs.promises.readdir(dir).catch(() => [])).filter((name) => name.startsWith(`${packId}@`) && name.endsWith(".json"));
      for (const name of names) await fs.promises.rm(path.join(dir, name), { force: true });
      if (names.length) loader.load({ force: true });
      return names.length;
    });
    if (!removed) {
      sendError(res, 404, "pack_not_found", "No imported pack has this id.", undefined, requestId);
      return;
    }
    send(res, 200, { ok: true }, requestId);
  }

  // --- PUT /api/knowledge/overrides/models/:cardId

  async function putOverride(req, res, cardId, requestId) {
    let body;
    try {
      body = await readJsonObjectBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (Number(error?.status) === 413) sendError(res, 413, "request_too_large", `The request body may be at most ${MAX_BODY_BYTES} bytes.`, undefined, requestId);
      else sendError(res, 400, "invalid_json", "The request body must be a JSON object.", undefined, requestId);
      return;
    }
    let card = null;
    if (CARD_PATTERN.test(cardId)) {
      try {
        card = models.getCard(cardId, { cacheDir: cardsDir() });
      } catch {
        card = null;
      }
    }
    if (!card) {
      sendError(res, 404, "card_not_found", "No model card is known under this id.", { hint: "Call POST /api/models/inspect for the model first." }, requestId);
      return;
    }
    if (typeof card.contentDigest !== "string" || !card.contentDigest) {
      sendError(res, 422, "invalid_override", "The card has no content digest to select the model by.", { errors: [fieldError("match", "no_content_digest", "Inspect the model again.")] }, requestId);
      return;
    }
    const loader = getLoader();
    let id = typeof body.id === "string" && body.id ? body.id : "";
    if (!id) {
      try {
        id = card.identity?.familyId || loader.matchFamily(card)?.entry?.id || "";
      } catch {
        id = "";
      }
    }
    if (!id) {
      sendError(res, 422, "invalid_override", "The override has no id.", { errors: [fieldError("id", "required", "Name the family entry to override.")] }, requestId);
      return;
    }
    const { match: _ignored, ...rest } = body;
    const entry = { ...rest, id, match: { contentDigest: card.contentDigest } };
    const text = `${JSON.stringify({
      schemaVersion: knowledgeModule.SCHEMA_VERSIONS.families,
      kind: "families",
      asOf: new Date(now()).toISOString().slice(0, 10),
      entries: [entry],
    }, null, 2)}\n`;
    try {
      const trial = await trialLoad({ [`models/${cardId}.json`]: text });
      let issues;
      try {
        issues = trial.status.errors.filter((item) => item.layer === "model" && item.severity !== "warning");
      } finally {
        await trial.cleanup();
      }
      if (issues.length) {
        sendError(res, 422, "invalid_override", "The override is not valid.", { errors: fieldErrorsFrom(issues) }, requestId);
        return;
      }
      const file = await serialize(async () => {
        const target = path.join(loader.knowledgeDir, "models", `${cardId}.json`);
        await writeFileAtomic(target, text);
        loader.load({ force: true });
        return loader.display(target);
      });
      send(res, 200, { ok: true, file }, requestId);
    } catch (error) {
      if (!sendCoded(res, error, requestId)) sendInternal(res, error, "override", requestId);
    }
  }

  // --- POST /api/knowledge/reload

  async function reload(req, res, requestId) {
    req.resume?.();
    const digest = await serialize(async () => getLoader().load({ force: true }).digest);
    send(res, 200, { ok: true, digest }, requestId);
  }

  // --- dispatch

  function sendCoded(res, error, requestId) {
    const status = Number(error?.status);
    const code = String(error?.code || "");
    if (!code || !Number.isInteger(status) || status < 400 || status > 599) return false;
    sendError(res, status, code, redactSecrets(String(error.message)), { hint: error.hint, errors: error.errors }, requestId);
    return true;
  }

  function sendInternal(res, error, what, requestId) {
    warn(`knowledge-routes: ${what} failed: ${error?.stack || error?.message || error}`);
    sendError(res, 500, "internal_error", "Service entry error.", undefined, requestId);
  }

  function writeRefusal(req, who) {
    if (who.kind === "none") return [401, "admin_session_required", "This needs the console owner. Open the console on this machine."];
    if (who.kind !== "owner") return [403, "principal_route_forbidden", `${who.principal || "This caller"} may not change knowledge.`];
    let allowed;
    try {
      allowed = auth.checkWrite(req) || {};
    } catch {
      allowed = { ok: false, status: 401, code: "admin_session_required" };
    }
    if (allowed.ok) return null;
    return [Number(allowed.status) || 403, String(allowed.code || "management_local_only"), String(allowed.message || "This action needs the console owner.")];
  }

  function match(pathname) {
    if (pathname === "/api/knowledge") return { name: "list", methods: ["GET"] };
    if (pathname === "/api/knowledge/status") return { name: "status", methods: ["GET"] };
    if (pathname === "/api/knowledge/import") return { name: "import", methods: ["POST"] };
    if (pathname === "/api/knowledge/reload") return { name: "reload", methods: ["POST"] };
    const decoded = (value) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };
    const pack = /^\/api\/knowledge\/packs\/([^/]+)$/.exec(pathname);
    if (pack) return { name: "pack", id: decoded(pack[1]), methods: ["DELETE"] };
    const override = /^\/api\/knowledge\/overrides\/models\/([^/]+)$/.exec(pathname);
    if (override) return { name: "override", id: decoded(override[1]), methods: ["PUT"] };
    return null;
  }

  async function handle(req, res, url) {
    const pathname = String(url?.pathname || "");
    if (!pathname.startsWith("/api/knowledge")) return false;
    const route = match(pathname);
    if (!route) return false;
    const requested = String(req.method || "GET").toUpperCase();
    const method = requested === "HEAD" ? "GET" : requested;
    const requestId = requestIdOf(req);
    if (!route.methods.includes(method)) {
      req.resume?.();
      sendJson(res, errorBody("method_not_allowed", `${requested} is not supported on ${pathname}.`), 405, { allow: route.methods.join(", "), "x-request-id": requestId });
      return true;
    }
    const who = resolvePrincipal(auth, req);
    try {
      if (READ_METHODS.has(requested)) {
        if (who.kind === "none" || who.kind === "machine") {
          req.resume?.();
          if (who.kind === "machine") sendError(res, 403, "principal_route_forbidden", `${who.principal || "This principal"} may not call ${requested} ${pathname}.`, undefined, requestId);
          else sendError(res, 401, "admin_session_required", "This needs the console owner. Open the console on this machine.", { hint: "pair" }, requestId);
          return true;
        }
        if (route.name === "list") listKnowledge(res, url, requestId);
        else await knowledgeStatus(res, requestId);
        return true;
      }
      const refused = writeRefusal(req, who);
      if (refused) {
        req.resume?.();
        sendError(res, refused[0], refused[1], refused[2], undefined, requestId);
        return true;
      }
      if (route.name === "import") await importPack(req, res, requestId);
      else if (route.name === "pack") await deletePack(req, res, route.id, requestId);
      else if (route.name === "override") await putOverride(req, res, route.id, requestId);
      else await reload(req, res, requestId);
    } catch (error) {
      sendInternal(res, error, `${requested} ${pathname}`, requestId);
    }
    return true;
  }

  return { handle, close() {} };
}

// Route module (07 §2.7). ctx.knowledge carries test seams (loader, fetchPack,
// fetch, cacheDir, models); by default everything is the live platform's.
function mount(ctx) {
  const auth = ctx?.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function" || !auth.viewerRegistry) {
    throw new Error("knowledge-routes: ctx.auth is missing");
  }
  const logger = ctx.logger || console;
  registerKnowledgeRoutes(auth.viewerRegistry, (line) => {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks the mount.
    }
  });
  const seams = isPlainObject(ctx.knowledge) ? ctx.knowledge : {};
  const routes = createKnowledgeRoutes({
    ...seams,
    auth,
    sendJson: ctx.sendJson,
    readJsonObjectBody: ctx.readJsonObjectBody,
    managers: Array.isArray(ctx.managers) ? ctx.managers : [],
    managerClient: () => ctx.managerClient,
    logger,
    now: typeof ctx.now === "function" ? ctx.now : Date.now,
  });
  return { handle: routes.handle, close: routes.close };
}

module.exports = {
  adminOnlyRoutes,
  createKnowledgeRoutes,
  fetchPackText,
  isBlockedAddress,
  mount,
  name: "knowledge",
  redactKnowledgeForViewer,
  redactKnowledgeStatusForViewer,
  registerKnowledgeRoutes,
  viewerRoutes,
};
