"use strict";

// Legacy key migration (docs/overhaul/05-public.md §6.7) and the compat key
// summaries behind GET /api/keys and /api/status (§13.1).
//
// The managers' service-clients.json and service-exposure-settings.json are
// read, never written: every client and every global key becomes one row of
// the platform access store under a stable key_id, with the same sha256 hash,
// so no key is reissued. The pieces are separate so each can be used alone:
//   - planKeyMigration() is pure. Its output is the golden test and the body
//     of POST /api/access/migration/plan (PUB-18).
//   - applyKeyMigration() imports a plan in one store transaction. It is
//     idempotent by key_id and key_hash, so a re-run is a no-op.
//   - runKeyMigration() is the entry-start glue: read the files, list the
//     billing bindings, plan, apply, mark access_meta['migration.v1'].
// Reports and warnings carry ids, names and codes only, never a hash.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const servicePolicy = require("../../manager-core/service-policy");
const { REDACTED, redactValue } = require("../../manager-core/secret-redactor");
const policy = require("./key-policy");
const { normalizeKeyInput } = require("./keys-store");
const { summarizeServiceKeys } = require("./key-overview");

const MIGRATION_MARKER = "migration.v1";
const MIGRATION_REPORT = "migration.report";
const REPORT_VERSION = 1;
// What a legacy key could reach through the gateway. PUBLIC never routes
// audio.clone or mcp (key-policy ADMIN_ONLY_SCOPES), so nothing new is exposed.
const LEGACY_SCOPES = Object.freeze([
  "models.read", "chat", "completions", "responses", "embeddings", "messages",
  "audio.speech", "audio.clone", "search", "mcp", "self.read",
]);
const LEGACY_LISTENERS = Object.freeze(["public", "admin"]);
const LEGACY_FILES = Object.freeze({
  settings: "service-exposure-settings.json",
  clients: "service-clients.json",
});
const SOURCE_CLIENTS = "service-clients";
const SOURCE_GLOBAL = "service-exposure";
const PLATFORM_GROUP = "platform";
const PLATFORM_GROUP_NAME = "平台密钥 / Platform keys";
// key_id suffix rule of §6.7; anything else is rewritten to m<sha8>.
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
// billing-store identifier(): a client id the billing ledger can bind.
const BILLING_CLIENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MANAGER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const KEY_HASH_RE = /^[a-f0-9]{64}$/;
const HEX64_RE = /[a-f0-9]{64}/i;
const HEX64_RUN_RE = /[a-f0-9]{64}/gi;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIST_PAGE = 200;
const BINDINGS_PAGE = 1000;

function list(value) {
  return Array.isArray(value) ? value : [];
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sha8(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 8);
}

// The legacy clients of one manager: a ledger object ({ clients: [] }) as the
// file stores it, or a bare array.
function legacyClients(value) {
  if (Array.isArray(value)) return value;
  return list(plainObject(value).clients);
}

function isoOrNull(value) {
  return servicePolicy.normalizeDateText(value) || null;
}

function displayName(value, fallback) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return text || fallback;
}

function notesText(value) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 2000);
  return text || null;
}

// The legacy preview ("sk-vllm...ab12") stays; anything that is not a short
// printable label is dropped and the store shows "…".
function previewText(value) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!text || text.length > 64) return null;
  return HEX64_RE.test(text) ? null : text;
}

function legacyHash(value) {
  const hash = String(value ?? "").trim().toLowerCase();
  return KEY_HASH_RE.test(hash) ? hash : "";
}

// The global key's hash: the stored hash, or the hash of a plaintext key left
// by a pre-hash settings file (the same rule as normalizeServiceExposureSecret).
function globalKeyHash(settings) {
  if (settings.apiKeyHash) return legacyHash(settings.apiKeyHash);
  const plaintext = String(settings.apiKey ?? "").trim();
  return plaintext ? servicePolicy.hashServiceApiKey(plaintext) : "";
}

function hasGlobalKey(settings) {
  return Boolean(settings.apiKeyHash || settings.apiKey);
}

// rpm, concurrency, queue and timeouts with the legacy defaults the managers
// enforced; tpm and the token caps stay null (§6.7).
function legacyLimits(source) {
  const normalized = servicePolicy.normalizeServiceClient({
    id: "limits",
    rateLimitRpm: source.rateLimitRpm,
    maxConcurrentRequests: source.maxConcurrentRequests,
    maxQueuedRequests: source.maxQueuedRequests,
    queueTimeoutSeconds: source.queueTimeoutSeconds,
    requestTimeoutSeconds: source.requestTimeoutSeconds,
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  return {
    rpm: Math.round(normalized.rateLimitRpm),
    tpm: null,
    maxConcurrent: Math.round(normalized.maxConcurrentRequests),
    maxQueued: Math.round(normalized.maxQueuedRequests),
    queueTimeoutSeconds: Math.round(normalized.queueTimeoutSeconds),
    requestTimeoutSeconds: Math.round(normalized.requestTimeoutSeconds),
    dailyTokens: null,
    monthlyTokens: null,
    dailyRequests: null,
    maxOutputTokens: null,
  };
}

// allowedModels, or ["*"] when empty. A pattern the store cannot hold is
// dropped with a warning; a list that loses every entry stays restricted ([]).
function legacyModels(allowedModels, onDropped) {
  const items = servicePolicy.normalizeCsvList(allowedModels);
  if (!items.length || items.includes("*")) return ["*"];
  const models = [];
  for (const item of items) {
    if (item.length > 200 || /\s/.test(item) || item === "!") {
      onDropped(item);
      continue;
    }
    if (!models.some((model) => model.toLowerCase() === item.toLowerCase())) models.push(item);
  }
  return models;
}

// The manager's allowedOrigins when its CORS mode is (effectively)
// restricted; otherwise none, with cors_open_not_migrated (O10). A wildcard
// or an origin with a path cannot be carried by a migrated key.
function legacyOrigins(managerId, settings) {
  if (servicePolicy.resolveEffectiveCorsMode(settings) === "open") {
    return { origins: [], warnings: [{ code: "cors_open_not_migrated", managerId }] };
  }
  const origins = [];
  const warnings = [];
  for (const raw of servicePolicy.normalizeCsvList(settings.allowedOrigins)) {
    const origin = policy.normalizeOrigin(raw);
    if (!origin || origin === "*") {
      warnings.push({ code: "origin_not_migrated", managerId, origin: String(raw).slice(0, 200) });
      continue;
    }
    if (!origins.includes(origin) && origins.length < 50) origins.push(origin);
  }
  return { origins, warnings };
}

// Active bindings by (billing scope, service client id) → customer id.
function bindingIndex(bindings) {
  const index = new Map();
  for (const item of list(bindings)) {
    if (!item || typeof item !== "object" || item.active === false || item.active === 0) continue;
    const scope = String(item.managerId ?? "").trim().toLowerCase();
    const clientId = String(item.serviceClientId ?? item.clientId ?? "").trim();
    const customerId = String(item.customerId ?? "").trim().toLowerCase();
    if (!scope || !clientId || !UUID_RE.test(customerId)) continue;
    index.set(`${scope}\n${clientId}`, customerId);
  }
  return index;
}

// Checks a record with the store's own normalizer, so a planned insert can
// never make importKeys throw and roll back the whole migration.
function validationErrors(record) {
  const { keyHash, preview, createdAt, lastUsedAt, ...fields } = record;
  try {
    normalizeKeyInput(fields, { mode: "create" });
    return null;
  } catch (error) {
    const errors = Array.isArray(error?.errors) ? error.errors : [];
    return errors.length ? errors.map((item) => item.field || "") : [String(error?.code || "invalid")];
  }
}

/**
 * planKeyMigration({ managers: [{ id, billingId, settings, clients }], bindings, existingKeyIds })
 *   -> { inserts, skipped, warnings }
 *
 * Pure. Managers are taken in the given (MANAGERS) order, each global key
 * before its clients, which is the order the legacy gateway matched them in.
 * `inserts` are store.importKeys() records; `skipped` and `warnings` name
 * keys by id and never carry a hash.
 */
function planKeyMigration(input = {}) {
  const managers = list(input.managers);
  const customers = bindingIndex(input.bindings);
  const existing = new Set(Array.from(input.existingKeyIds || [], (id) => String(id)));
  const records = [];
  const skipped = [];
  const warnings = [];
  const byHash = new Map();
  const principals = new Set();

  for (const manager of managers) {
    const managerId = String(manager?.id ?? "").trim().toLowerCase();
    if (!MANAGER_ID_RE.test(managerId)) {
      skipped.push({ keyId: null, managerId: String(manager?.id ?? ""), clientId: null, source: null, reason: "invalid_manager" });
      continue;
    }
    const billingScope = String(manager.billingId || `${managerId}-manager`).trim().toLowerCase();
    const settings = plainObject(manager.settings);
    const { origins, warnings: originWarnings } = legacyOrigins(managerId, settings);
    const managerWarningsAt = warnings.length;
    const plannedIds = new Set();
    const seenClientIds = new Set();
    let touched = false;

    // One candidate (global key or client) through the shared rules: hash
    // duplicates, billing principal, store validation, registration.
    const consider = (candidate) => {
      const { record, clientId, source } = candidate;
      const first = byHash.get(record.keyHash);
      if (first) {
        if (first.managerId === managerId) {
          skipped.push({ keyId: record.id, managerId, clientId, source, reason: "duplicate_key_hash", duplicateOf: first.record.id });
          return;
        }
        // One record per secret: it reaches both managers and keeps the
        // first manager's principal. The warning names the binding that lost.
        const pattern = `${managerId}:*`;
        if (!first.record.fleetAllow.includes(pattern)) first.record.fleetAllow.push(pattern);
        warnings.push({
          code: "duplicate_key_across_managers",
          managerId: first.managerId,
          keyId: first.record.id,
          duplicate: {
            managerId,
            clientId,
            keyId: record.id,
            billing: { ...record.billing },
            customerId: record.customerId || null,
          },
        });
        touched = true;
        return;
      }
      const principal = `${record.billing.scope}\n${record.billing.clientId}`;
      if (principals.has(principal)) {
        skipped.push({ keyId: record.id, managerId, clientId, source, reason: "duplicate_billing_principal" });
        return;
      }
      const invalidFields = validationErrors(record);
      if (invalidFields) {
        skipped.push({ keyId: record.id, managerId, clientId, source, reason: "invalid_record", fields: invalidFields });
        return;
      }
      for (const warning of candidate.warnings) warnings.push(warning);
      byHash.set(record.keyHash, { managerId, record });
      principals.add(principal);
      plannedIds.add(record.id);
      records.push(record);
      touched = true;
    };

    if (hasGlobalKey(settings)) {
      const keyId = `${managerId}.global`;
      const keyHash = globalKeyHash(settings);
      if (!keyHash) {
        skipped.push({ keyId, managerId, clientId: null, source: SOURCE_GLOBAL, reason: "unusable_hash" });
      } else {
        const billingClientId = `global-${keyHash.slice(0, 24)}`;
        consider({
          clientId: null,
          source: SOURCE_GLOBAL,
          warnings: [{ code: "global_key_converted", managerId, keyId }],
          record: {
            id: keyId,
            name: `Global key (${managerId})`,
            status: "active",
            class: "owner",
            customerId: customers.get(`${billingScope}\n${billingClientId}`) || null,
            scopes: [...LEGACY_SCOPES],
            models: ["*"],
            fleetAllow: [`${managerId}:*`],
            listeners: [...LEGACY_LISTENERS],
            limits: legacyLimits(settings),
            allowedOrigins: [...origins],
            expiresAt: null,
            billing: { scope: billingScope, clientId: billingClientId },
            ttsOwner: `${managerId}:${billingClientId}`,
            legacy: { managerId, clientId: billingClientId, source: SOURCE_GLOBAL },
            keyHash,
            preview: previewText(settings.apiKeyPreview),
            createdAt: null,
            lastUsedAt: null,
          },
        });
      }
    }

    for (const raw of legacyClients(manager.clients)) {
      const client = servicePolicy.normalizeServiceClient(raw);
      if (!client) {
        skipped.push({ keyId: null, managerId, clientId: null, source: SOURCE_CLIENTS, reason: "missing_client_id" });
        continue;
      }
      const clientId = client.id;
      const natural = CLIENT_ID_RE.test(clientId) ? `${managerId}.${clientId}` : "";
      const hashedId = `${managerId}.m${sha8(clientId)}`;
      if (seenClientIds.has(clientId)) {
        skipped.push({ keyId: natural || hashedId, managerId, clientId, source: SOURCE_CLIENTS, reason: "duplicate_client_id" });
        continue;
      }
      seenClientIds.add(clientId);
      // A client id that cannot be a key_id suffix, or one that collides
      // with "<managerId>.global", gets the hashed form.
      const keyId = natural && !plannedIds.has(natural) ? natural : hashedId;
      const keyHash = legacyHash(client.keyHash);
      if (!keyHash) {
        skipped.push({ keyId, managerId, clientId, source: SOURCE_CLIENTS, reason: "unusable_hash" });
        continue;
      }
      if (plannedIds.has(keyId)) {
        skipped.push({ keyId, managerId, clientId, source: SOURCE_CLIENTS, reason: "duplicate_key_id" });
        continue;
      }
      const billingClientId = BILLING_CLIENT_RE.test(clientId) ? clientId : `m${sha8(clientId)}`;
      const customerId = customers.get(`${billingScope}\n${billingClientId}`) || null;
      const candidateWarnings = [];
      if (keyId !== natural) {
        candidateWarnings.push({
          code: "client_id_rewritten",
          managerId,
          keyId,
          clientId,
          reason: natural ? "reserved" : "invalid_characters",
          ...(billingClientId !== clientId ? { billingClientId } : {}),
        });
      }
      const models = legacyModels(client.allowedModels, (pattern) => {
        candidateWarnings.push({ code: "model_pattern_dropped", managerId, keyId, pattern: pattern.slice(0, 200) });
      });
      consider({
        clientId,
        source: SOURCE_CLIENTS,
        warnings: candidateWarnings,
        record: {
          id: keyId,
          name: displayName(client.name, displayName(clientId, keyId)),
          status: client.enabled === false ? "disabled" : "active",
          class: customerId ? "customer" : "friend",
          customerId,
          scopes: [...LEGACY_SCOPES],
          models,
          fleetAllow: [`${managerId}:*`],
          listeners: [...LEGACY_LISTENERS],
          limits: legacyLimits(client),
          allowedOrigins: [...origins],
          expiresAt: client.expiresAt || null,
          notes: notesText(client.notes),
          billing: { scope: billingScope, clientId: billingClientId },
          ttsOwner: `${managerId}:${billingClientId}`,
          legacy: {
            managerId,
            clientId,
            source: SOURCE_CLIENTS,
            usage: client.usage,
            lastUsedAt: isoOrNull(plainObject(raw).lastUsedAt),
          },
          keyHash,
          preview: previewText(client.keyPreview),
          createdAt: isoOrNull(plainObject(raw).createdAt),
          lastUsedAt: isoOrNull(plainObject(raw).lastUsedAt),
        },
      });
    }

    // Manager-wide warnings (CORS) matter only when the manager had a key.
    if (touched && originWarnings.length) warnings.splice(managerWarningsAt, 0, ...originWarnings);
  }

  const inserts = [];
  for (const record of records) {
    if (existing.has(record.id)) {
      skipped.push({
        keyId: record.id,
        managerId: record.legacy.managerId,
        clientId: record.legacy.source === SOURCE_CLIENTS ? record.legacy.clientId : null,
        source: record.legacy.source,
        reason: "key_exists",
      });
      continue;
    }
    inserts.push(record);
  }
  return { inserts, skipped, warnings };
}

// Codes that apply to one key: its own warnings, plus its manager's
// manager-wide ones (CORS), which every key of that manager inherits.
function warningCodesFor(record, warnings) {
  const managerId = record.legacy?.managerId;
  const codes = [];
  for (const warning of warnings) {
    const own = warning.keyId === record.id;
    const managerWide = !warning.keyId && warning.managerId === managerId && warning.code !== "legacy_file_unreadable";
    if ((own || managerWide) && !codes.includes(warning.code)) codes.push(warning.code);
  }
  return codes;
}

// Hash-free by construction; the final pass is belt and braces for owner
// text (names, odd client ids) that happens to look like a secret.
function scrubReport(report) {
  const redacted = redactValue(report);
  const text = JSON.stringify(redacted).replace(HEX64_RUN_RE, REDACTED);
  return JSON.parse(text);
}

function buildMigrationReport(plan, result, options = {}) {
  const inserts = list(plan?.inserts);
  const warnings = [...list(plan?.warnings), ...list(options.warnings)];
  const inserted = new Set(result.inserted);
  const keys = inserts.filter((record) => inserted.has(record.id)).map((record) => ({
    keyId: record.id,
    name: record.name,
    source: record.legacy?.source || null,
    warnings: warningCodesFor(record, warnings),
  }));
  const skipped = [
    ...list(plan?.skipped),
    ...result.skipped.map((item) => ({ keyId: item.id, reason: item.reason })),
  ];
  return scrubReport({
    version: REPORT_VERSION,
    at: options.at,
    actor: options.actor,
    complete: options.complete !== false,
    counts: { planned: inserts.length, inserted: keys.length, skipped: skipped.length, warnings: warnings.length },
    keys,
    skipped,
    warnings,
  });
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/**
 * applyKeyMigration(store, plan, { actor = "migration", now, complete, warnings })
 *   -> { inserted, skipped, report }
 *
 * The rows go in through store.importKeys, one transaction that skips any id,
 * hash or billing principal already present. The report is written when this
 * run inserted something or none exists yet, and the migration.v1 marker once
 * a complete run has happened, so applying again changes nothing.
 */
function applyKeyMigration(store, plan, options = {}) {
  if (!store || typeof store.importKeys !== "function") throw new TypeError("applyKeyMigration needs an access store.");
  const actor = options.actor || "migration";
  const at = nowIso(options.now);
  const result = store.importKeys(list(plan?.inserts), { actor });
  const report = buildMigrationReport(plan, result, { at, actor, complete: options.complete, warnings: options.warnings });
  if (result.inserted.length || store.getMeta(MIGRATION_REPORT) === null) store.setMeta(MIGRATION_REPORT, report);
  if (options.complete !== false && store.getMeta(MIGRATION_MARKER) === null) store.setMeta(MIGRATION_MARKER, at);
  return { inserted: result.inserted, skipped: result.skipped, report };
}

function readMigrationReport(store) {
  const text = store.getMeta(MIGRATION_REPORT);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Reads one manager's two legacy files (read-only). A missing file is "no
// keys"; a file that exists but cannot be read or parsed is an issue, and
// the caller leaves that manager for a later run.
async function readLegacyKeyFiles(manager, options = {}) {
  const readFile = typeof options.readFile === "function" ? options.readFile : fs.readFile;
  const out = { settings: null, clients: null, issues: [] };
  if (!manager?.root) return out;
  for (const [field, name] of Object.entries(LEGACY_FILES)) {
    let text;
    try {
      text = await readFile(path.join(String(manager.root), "logs", name), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") out.issues.push({ file: name, code: String(error?.code || "read_failed") });
      continue;
    }
    try {
      const parsed = JSON.parse(String(text).replace(/^﻿/, ""));
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      out[field] = parsed;
    } catch {
      out.issues.push({ file: name, code: "invalid_json" });
    }
  }
  return out;
}

// Every key of the store, through the hash-free listKeys pages.
function listStoreKeys(store) {
  const keys = [];
  let cursor = null;
  do {
    const page = store.listKeys({ limit: LIST_PAGE, ...(cursor ? { cursor } : {}) });
    keys.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return keys;
}

// Every credential binding of a billing store (active or not).
function listBillingBindings(billingStore) {
  const bindings = [];
  for (let offset = 0; ; offset += BINDINGS_PAGE) {
    const page = billingStore.listCredentialBindings({ limit: BINDINGS_PAGE, offset });
    bindings.push(...page);
    if (page.length < BINDINGS_PAGE) return bindings;
  }
}

/**
 * runKeyMigration({ store, managers: [{ id, billingId, root }], listBindings, readFile, force, actor, now })
 *   -> { ran: false, reason } | { ran: true, complete, plan, inserted, skipped, report }
 *
 * Runs once: when access_meta['migration.v1'] is present it does nothing
 * unless `force`. A manager whose legacy file cannot be read is left out and
 * the marker stays unset, so the next start retries it; the rows already
 * imported are skipped then. Without the billing bindings nothing runs,
 * because a bound customer would otherwise be imported as a friend.
 */
async function runKeyMigration(options = {}) {
  const store = options.store;
  if (!store || typeof store.getMeta !== "function") throw new TypeError("runKeyMigration needs an access store.");
  if (!options.force && store.getMeta(MIGRATION_MARKER) !== null) return { ran: false, reason: "already_migrated" };
  const runWarnings = [];
  const managers = [];
  for (const manager of list(options.managers)) {
    const files = await readLegacyKeyFiles(manager, { readFile: options.readFile });
    if (files.issues.length) {
      for (const issue of files.issues) runWarnings.push({ code: "legacy_file_unreadable", managerId: String(manager.id), file: issue.file, reason: issue.code });
      continue;
    }
    managers.push({ id: manager.id, billingId: manager.billingId, settings: files.settings, clients: files.clients });
  }
  const bindings = typeof options.listBindings === "function" ? await options.listBindings() : list(options.bindings);
  const plan = planKeyMigration({ managers, bindings, existingKeyIds: listStoreKeys(store).map((key) => key.id) });
  const complete = runWarnings.length === 0;
  const applied = applyKeyMigration(store, plan, { actor: options.actor || "migration", now: options.now, complete, warnings: runWarnings });
  return { ran: true, complete, plan, ...applied };
}

// ---- compat summaries (GET /api/keys, /api/status `keys`) -----------------

// A store key in the legacy client shape key-overview.js reads.
function compatClient(key) {
  const legacy = plainObject(key.legacy);
  const models = list(key.models);
  return {
    id: legacy.source === SOURCE_CLIENTS && legacy.clientId ? String(legacy.clientId) : key.id,
    name: key.name,
    enabled: key.status === "active",
    createdAt: key.createdAt || null,
    lastUsedAt: key.lastUsedAt || null,
    expiresAt: key.expiresAt || null,
    // The legacy "all models" was an empty list.
    allowedModels: models.length === 1 && models[0] === "*" ? [] : models,
    rateLimitRpm: key.limits?.rpm ?? null,
  };
}

/**
 * buildCompatKeyManagers(keys, managers) -> virtual managers for
 * summarizeServiceKeys(). Keys are grouped by legacy.managerId, or under
 * "platform" for keys created on the platform; revoked keys are gone, as a
 * deleted legacy client was. A converted global key marks its manager's
 * globalKey instead of listing as a client. `managers` are the status
 * entries (id, name, baseUrl, servicePageUrl, process) in MANAGERS order.
 */
function buildCompatKeyManagers(keys, managers = [], options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const groups = new Map();
  const group = (id, base = null) => {
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        name: base?.name || id,
        baseUrl: base?.baseUrl || "",
        servicePageUrl: base?.servicePageUrl || "",
        process: { portListening: Boolean(base?.process?.portListening) },
        globalKey: false,
        clients: [],
      });
    }
    return groups.get(id);
  };
  for (const manager of list(managers)) if (manager?.id) group(String(manager.id), manager);
  const platform = { name: PLATFORM_GROUP_NAME, process: { portListening: true } };
  const platformKeys = [];
  for (const key of list(keys)) {
    if (!key || key.status === "revoked") continue;
    const legacy = plainObject(key.legacy);
    if (!legacy.managerId) {
      platformKeys.push(key);
      continue;
    }
    const target = group(String(legacy.managerId));
    if (legacy.source === SOURCE_GLOBAL) {
      if (key.status === "active" && !policy.isExpired(key.expiresAt, nowMs)) target.globalKey = true;
      continue;
    }
    target.clients.push(compatClient(key));
  }
  if (platformKeys.length) {
    const target = group(PLATFORM_GROUP, platform);
    for (const key of platformKeys) target.clients.push(compatClient(key));
  }
  return Array.from(groups.values()).map((item) => ({
    id: item.id,
    name: item.name,
    baseUrl: item.baseUrl,
    servicePageUrl: item.servicePageUrl,
    process: item.process,
    exposure: { settings: { hasApiKey: item.globalKey } },
    clients: { clients: item.clients },
  }));
}

// The /api/keys summary, same shape as today, computed from the store.
function summarizeStoreKeys(store, managers = [], options = {}) {
  return summarizeServiceKeys(buildCompatKeyManagers(listStoreKeys(store), managers, options), options);
}

module.exports = {
  LEGACY_FILES,
  LEGACY_SCOPES,
  MIGRATION_MARKER,
  MIGRATION_REPORT,
  PLATFORM_GROUP,
  applyKeyMigration,
  buildCompatKeyManagers,
  buildMigrationReport,
  listBillingBindings,
  listStoreKeys,
  planKeyMigration,
  readLegacyKeyFiles,
  readMigrationReport,
  runKeyMigration,
  summarizeStoreKeys,
};
