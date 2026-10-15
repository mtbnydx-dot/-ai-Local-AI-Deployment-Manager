"use strict";
// Admin access APIs (05 §13.1, PUB-18): platform keys, presets, the legacy
// key migration, the access audit, the public settings, announcements and
// public model metadata. A route module (07 §2.7) on the ADMIN listener.
// PUB-19 adds the exposure report, scan and external probe (§13.2, §13.3)
// and the security views and bans under /api/security/*. PUB-20 adds the deploy
// template preview and write (§13.3, §14).
//
// Every route is owner-only: a read needs an owner session or a machine
// principal inside its scope, a write goes through auth.checkWrite() (owner
// plus CSRF, or a machine principal such as system:cli, which carries no
// ambient credential). The key store audits its own changes; this file adds
// the audit rows for the actions the store does not see (bulk revoke,
// migration apply). A secret is returned once, in the create and rotate
// responses, and is never logged or audited.

const core = require("../../manager-core");
const policy = require("./key-policy");
const keyMigration = require("./key-migration");
const { KeysStoreError } = require("./keys-store");
const { createSecurityOverview } = require("./security-overview");
const deployTemplates = require("./deploy-templates");
const { READ_SECTIONS, WRITABLE_SECTIONS, loadAccessConfig, updateAccessSection } = require("./public-config");

const OWNER = "05";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_BULK_REVOKE = 200;
const ROTATE_OVERLAPS = Object.freeze([0, 3600, 86400, 604800]);
const DAY_MS = 86_400_000;
const DEFAULT_EXPIRING_DAYS = 30;

const BASE_SCOPES = Object.freeze(["models.read", "self.read"]);
const FRIEND_SCOPES = Object.freeze([
  ...BASE_SCOPES, "chat", "completions", "responses", "messages", "embeddings", "self.rotate", "self.origins",
]);

// §6.6. `labelKey`/`descriptionKey` are keys of the console's `access` i18n
// area. expiresInDays null means the key never expires. Limits not listed
// stay null and fall back to public.defaults.
const PRESETS = Object.freeze([
  {
    id: "friend",
    class: "friend",
    scopes: FRIEND_SCOPES,
    models: ["*"],
    listeners: ["public"],
    limits: { rpm: 30, tpm: 100_000, maxConcurrent: 2, dailyTokens: 2_000_000, maxOutputTokens: 8192 },
    expiresInDays: 90,
    requiresCustomer: false,
  },
  {
    id: "trial-7d",
    class: "trial",
    scopes: [...BASE_SCOPES, "chat", "messages"],
    models: ["*"],
    listeners: ["public"],
    limits: { rpm: 10, tpm: 50_000, maxConcurrent: 1, dailyTokens: 500_000, maxOutputTokens: 4096 },
    expiresInDays: 7,
    requiresCustomer: false,
  },
  {
    id: "paid",
    class: "customer",
    scopes: [...FRIEND_SCOPES, "audio.speech"],
    models: ["*"],
    listeners: ["public"],
    limits: { rpm: 60, tpm: 400_000, maxConcurrent: 4, maxOutputTokens: 16_384 },
    expiresInDays: 365,
    requiresCustomer: true,
  },
  {
    id: "internal-app",
    class: "internal",
    scopes: [...BASE_SCOPES, "chat", "completions", "embeddings", "audio.speech"],
    models: ["*"],
    listeners: ["public", "admin"],
    limits: { rpm: 600, maxConcurrent: 16 },
    expiresInDays: null,
    requiresCustomer: false,
  },
  {
    id: "owner-device",
    class: "owner",
    scopes: policy.SCOPES,
    models: ["*"],
    listeners: ["public", "admin"],
    limits: { rpm: 600, maxConcurrent: 16 },
    expiresInDays: null,
    requiresCustomer: false,
  },
].map((preset) => Object.freeze({
  ...preset,
  scopes: Object.freeze(preset.scopes.slice()),
  models: Object.freeze(preset.models.slice()),
  listeners: Object.freeze(preset.listeners.slice()),
  limits: Object.freeze({ ...preset.limits }),
  labelKey: `access.preset.${preset.id}.title`,
  descriptionKey: `access.preset.${preset.id}.description`,
})));

// Non-GET routes this module answers; server.js registers the GETs with a
// wildcard. They are owner-only, which deny-by-default applies anyway.
const ACCESS_ADMIN_WRITE_ROUTES = Object.freeze([
  ["POST", "/api/access/keys"],
  ["PATCH", "/api/access/keys/:id"],
  ["POST", "/api/access/keys/:id/rotate"],
  ["POST", "/api/access/keys/:id/revoke"],
  ["POST", "/api/access/keys/bulk-revoke"],
  ["POST", "/api/access/migration/plan"],
  ["POST", "/api/access/migration/apply"],
  ["PATCH", "/api/public/settings"],
  ["POST", "/api/public/announcements"],
  ["PATCH", "/api/public/announcements/:id"],
  ["DELETE", "/api/public/announcements/:id"],
  ["PUT", "/api/public/models/:modelId/meta"],
  ["POST", "/api/public/exposure/scan"],
  ["POST", "/api/public/probe"],
  ["POST", "/api/public/templates/write"],
  ["POST", "/api/security/bans"],
  ["DELETE", "/api/security/bans/:subject"],
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function envelope(status, code, message, extra = {}) {
  const { errors, ...rest } = extra;
  return {
    status,
    body: { ok: false, error: { code, message, ...rest }, ...(Array.isArray(errors) && errors.length ? { errors } : {}) },
  };
}

function fieldError(field, code, message) {
  return envelope(400, "invalid_field", message, { errors: [{ field, code, message }] });
}

function presetById(id) {
  return PRESETS.find((preset) => preset.id === id) || null;
}

function presetView(preset) {
  return {
    id: preset.id,
    class: preset.class,
    scopes: preset.scopes.slice(),
    models: preset.models.slice(),
    listeners: preset.listeners.slice(),
    limits: { ...preset.limits },
    expiresInDays: preset.expiresInDays,
    requiresCustomer: preset.requiresCustomer,
    labelKey: preset.labelKey,
    descriptionKey: preset.descriptionKey,
  };
}

// The create input of one preset: its values first, the request's own fields
// over them. `preset` itself becomes the labels.preset marker.
function applyPreset(body, now) {
  const { preset: presetId, ...input } = body;
  if (presetId === undefined || presetId === null || presetId === "") return { input };
  const preset = typeof presetId === "string" ? presetById(presetId) : null;
  if (!preset) return { error: fieldError("preset", "invalid", `Unknown preset. Use one of: ${PRESETS.map((item) => item.id).join(", ")}.`) };
  const merged = {
    class: preset.class,
    scopes: preset.scopes.slice(),
    models: preset.models.slice(),
    listeners: preset.listeners.slice(),
    ...input,
    limits: { ...preset.limits, ...(isPlainObject(input.limits) ? input.limits : {}) },
    labels: { ...(isPlainObject(input.labels) ? input.labels : {}), preset: preset.id },
  };
  if (input.expiresAt === undefined && preset.expiresInDays) {
    merged.expiresAt = new Date(now() + preset.expiresInDays * DAY_MS).toISOString();
  }
  if (preset.requiresCustomer && !merged.customerId) {
    return { error: fieldError("customerId", "required", `The ${preset.id} preset needs a billing customer.`) };
  }
  return { input: merged };
}

function wildcardHost(host) {
  return ["", "0.0.0.0", "::", "[::]"].includes(String(host || "").toLowerCase());
}

// Where a client reaches PUBLIC: the configured https base URL, else the
// listener's own address (LAN-only installs have no base URL).
function publicOrigin(config) {
  if (config?.publicOrigin) return String(config.publicOrigin).replace(/\/+$/, "");
  const listener = config?.listeners?.public || {};
  const host = wildcardHost(listener.host) ? "127.0.0.1" : String(listener.host);
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${listener.port || 5186}`;
}

// The invite block of a created key (§13.1). The snippet carries the secret
// because the owner copies it to the key's holder; the response is the only
// place it appears.
function buildShare({ config, secret, recommendedModel }) {
  const origin = publicOrigin(config);
  const openaiBase = `${origin}/v1`;
  const model = recommendedModel || "auto";
  const snippetCurl = [
    `curl ${openaiBase}/chat/completions \\`,
    `  -H "Authorization: Bearer ${secret}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] })}'`,
  ].join("\n");
  return { openaiBase, anthropicBase: `${origin}/anthropic`, portalUrl: `${origin}/`, recommendedModel: recommendedModel || null, snippetCurl };
}

// The sections GET /api/public/settings shows (§13.1); exposure is read-only.
function settingsView(config) {
  const out = {};
  for (const name of READ_SECTIONS) out[name] = config[name];
  return {
    config: out,
    sources: config.sources || {},
    issues: Array.isArray(config.issues) ? config.issues : [],
    warnings: Array.isArray(config.warnings) ? config.warnings : [],
    etag: config.etag,
  };
}

function expiringDays(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value).trim().toLowerCase();
  if (text === "true") return DEFAULT_EXPIRING_DAYS;
  if (text === "false") return undefined;
  return Number(text);
}

function migrationPlanView(planned) {
  const plan = planned?.plan || {};
  return {
    inserts: (Array.isArray(plan.inserts) ? plan.inserts : []).map((record) => ({
      keyId: record.id,
      name: record.name,
      source: record.legacy?.source || null,
    })),
    skipped: Array.isArray(plan.skipped) ? plan.skipped : [],
    warnings: [...(Array.isArray(plan.warnings) ? plan.warnings : []), ...(Array.isArray(planned?.warnings) ? planned.warnings : [])],
  };
}

/**
 * createAccessRoutes({ auth, sendJson, readJsonObjectBody, getStore, getSecurity, getBus,
 *   migration, settings, exposure, securityOverview, logger, now }) -> { handle(req, res, url) }
 *
 * getStore() returns the access store or throws (store unavailable).
 * migration is { plan(), apply() } (server.js binds the managers' files and
 * the billing bindings); settings is { readSection, writeSection } (OPS-3);
 * exposure is an exposure-scan.js scanner ({ report, probe }); securityOverview
 * is { overview(query), events(query) } (security-overview.js), made from the
 * store, the bus and the config when not given.
 */
function createAccessRoutes(options = {}) {
  const { auth, sendJson, readJsonObjectBody } = options;
  const logger = options.logger || console;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const getStore = typeof options.getStore === "function" ? options.getStore : () => null;
  const getSecurity = typeof options.getSecurity === "function" ? options.getSecurity : () => null;
  const getBus = typeof options.getBus === "function" ? options.getBus : () => null;
  const migration = options.migration || null;
  const settings = options.settings || {};
  const exposure = options.exposure || null;
  const templatesAiRoot = options.aiRoot || "";
  const templatesFs = options.templatesFs || undefined;
  const templateSources = options.templates || undefined;

  function store() {
    const target = getStore();
    if (!target) throw new KeysStoreError("access_store_unavailable", "The access store is not available.", 503);
    return target;
  }

  function actorOf(req) {
    const who = auth.principal(req) || {};
    const socket = String(req?.socket?.remoteAddress || "");
    const ip = typeof core.normalizeRemoteAddress === "function" ? core.normalizeRemoteAddress(socket) : socket;
    return { actor: String(who.principal || who.role || "owner"), ip: ip || null };
  }

  // null when the caller may proceed, else { status, body }.
  function authorize(req, write) {
    if (write) {
      let allowed;
      try {
        allowed = auth.checkWrite(req) || {};
      } catch {
        allowed = { ok: false, status: 401, code: "admin_session_required" };
      }
      if (allowed.ok) return null;
      return envelope(Number(allowed.status) || 403, String(allowed.code || "management_local_only"), String(allowed.message || "This action needs the console owner."));
    }
    const who = auth.principal(req) || {};
    if (who.role === "owner" || who.role === "system") return null;
    if (who.role === "viewer") return envelope(403, "owner_required", "This view needs the console owner.");
    return envelope(401, "admin_session_required", "Pair this device to use the console.");
  }

  function failure(error) {
    if (error instanceof KeysStoreError) {
      return envelope(error.status || 400, error.code, error.message, { errors: error.errors });
    }
    if (error && typeof error.status === "number" && error.status >= 400 && error.status < 500) {
      return envelope(error.status, error.status === 413 ? "request_too_large" : "invalid_request", String(error.message || "The request is invalid."));
    }
    try {
      logger.error?.(core.redactSecrets(`access-routes: ${error?.stack || error?.message || error}`));
    } catch {
      // Logging never breaks a request.
    }
    return envelope(500, "internal_error", "Service entry error.");
  }

  async function body(req) {
    return readJsonObjectBody(req, MAX_BODY_BYTES);
  }

  function audit(target, req, entry) {
    const { actor, ip } = actorOf(req);
    try {
      target.appendAudit({ actor, actorIp: ip, ...entry });
    } catch (error) {
      logger.warn?.(core.redactSecrets(`access-routes: the access audit could not be written: ${error?.message || error}`));
    }
  }

  function accessConfig() {
    const security = getSecurity();
    if (security && typeof security.accessConfig === "function") return security.accessConfig();
    return loadAccessConfig({ readSection: settings.readSection });
  }

  const security = options.securityOverview || createSecurityOverview({ getStore: store, getBus, getConfig: accessConfig, now });

  // ---- keys ---------------------------------------------------------------

  function listKeys(url) {
    const target = store();
    const q = url.searchParams;
    const query = {};
    for (const [param, name] of [["status", "status"], ["class", "class"], ["customer", "customerId"], ["q", "q"], ["cursor", "cursor"]]) {
      if (q.get(param)) query[name] = q.get(param);
    }
    const days = expiringDays(q.get("expiring"));
    if (days !== undefined) query.expiringWithinDays = days;
    if (q.get("limit")) {
      const limit = Number(q.get("limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fieldError("limit", "out_of_range", "limit must be an integer between 1 and 200.");
      query.limit = limit;
    }
    const page = target.listKeys(query);
    return { status: 200, body: { ok: true, items: page.items, nextCursor: page.nextCursor, counts: target.countKeys() } };
  }

  async function createKey(req) {
    const target = store();
    const applied = applyPreset(await body(req), now);
    if (applied.error) return applied.error;
    const { actor, ip } = actorOf(req);
    const created = target.createKey(applied.input, { actor, ip });
    let recommendedModel = null;
    try {
      recommendedModel = target.listModelMeta().find((meta) => meta.recommended && !meta.hidden)?.modelId || null;
    } catch {
      recommendedModel = null;
    }
    const share = buildShare({ config: accessConfig(), secret: created.secret, recommendedModel });
    return { status: 201, body: { ok: true, key: created.key, secret: created.secret, share } };
  }

  function getKey(id) {
    const target = store();
    const key = target.getKey(id);
    if (!key) return envelope(404, "key_not_found", "Key not found.");
    const offset = accessConfig().public?.quotaTzOffsetMinutes;
    const usage = target.getUsage(id, typeof offset === "number" ? { tzOffsetMinutes: offset } : {});
    return { status: 200, body: { ok: true, key, usage: { day: usage.day, month: usage.month, dayResetsAt: usage.dayResetsAt, monthResetsAt: usage.monthResetsAt } } };
  }

  async function patchKey(req, id) {
    const target = store();
    const { actor, ip } = actorOf(req);
    const patch = await body(req);
    return { status: 200, body: { ok: true, key: target.updateKey(id, patch, { actor, ip }) } };
  }

  async function rotateKey(req, id) {
    const target = store();
    const input = await body(req);
    const overlapSeconds = input.overlapSeconds === undefined ? 0 : input.overlapSeconds;
    if (!ROTATE_OVERLAPS.includes(overlapSeconds)) {
      return fieldError("overlapSeconds", "invalid", `overlapSeconds must be one of ${ROTATE_OVERLAPS.join(", ")}.`);
    }
    const { actor, ip } = actorOf(req);
    const rotated = target.rotateKey(id, { overlapSeconds, actor, ip });
    return { status: 200, body: { ok: true, key: rotated.key, secret: rotated.secret } };
  }

  async function revokeKey(req, id) {
    const target = store();
    const input = await body(req);
    const key = target.getKey(id);
    if (!key) return envelope(404, "key_not_found", "Key not found.");
    if (typeof input.confirmName !== "string" || !input.confirmName) {
      return envelope(400, "confirm_required", "Type the key name to revoke it.", { errors: [{ field: "confirmName", code: "required", message: "Type the key name to revoke it." }] });
    }
    if (input.confirmName !== key.name) {
      return envelope(400, "confirm_mismatch", "The typed name does not match the key.", { errors: [{ field: "confirmName", code: "mismatch", message: "The typed name does not match the key." }] });
    }
    const { actor, ip } = actorOf(req);
    return { status: 200, body: { ok: true, key: target.revokeKey(id, { actor, ip }) } };
  }

  async function bulkRevoke(req) {
    const target = store();
    const input = await body(req);
    const ids = Array.isArray(input.keyIds) ? Array.from(new Set(input.keyIds.map((item) => (typeof item === "string" ? item.trim() : "")))) : null;
    if (!ids || !ids.length || ids.some((item) => !item) || ids.length > MAX_BULK_REVOKE) {
      return fieldError("keyIds", "invalid", `keyIds must list 1 to ${MAX_BULK_REVOKE} key ids.`);
    }
    const expected = `REVOKE ${ids.length}`;
    if (input.confirm !== expected) {
      return envelope(400, "confirm_mismatch", `Type "${expected}" to revoke these keys.`, { errors: [{ field: "confirm", code: "mismatch", message: `Type "${expected}" to revoke these keys.` }] });
    }
    const missing = ids.filter((item) => !target.getKey(item));
    if (missing.length) {
      return envelope(404, "key_not_found", "Some keys do not exist; nothing was revoked.", { errors: missing.map((item) => ({ field: "keyIds", code: "not_found", message: `No key ${item}.` })) });
    }
    const { actor, ip } = actorOf(req);
    let revoked = 0;
    for (const id of ids) {
      if (target.getKey(id).status === "revoked") continue;
      target.revokeKey(id, { actor, ip, reason: "bulk revoke" });
      revoked += 1;
    }
    audit(target, req, { action: "key.bulk_revoke", targetType: "key", targetId: null, details: { requested: ids.length, revoked, keyIds: ids.slice(0, 50) } });
    return { status: 200, body: { ok: true, revoked } };
  }

  // ---- migration ----------------------------------------------------------

  function migrationReport() {
    return { status: 200, body: { ok: true, report: keyMigration.readMigrationReport(store()) } };
  }

  async function migrationPlan() {
    store();
    if (!migration || typeof migration.plan !== "function") return envelope(503, "migration_unavailable", "The key migration is not available.");
    return { status: 200, body: { ok: true, plan: migrationPlanView(await migration.plan()) } };
  }

  async function migrationApply(req) {
    const target = store();
    const input = await body(req);
    if (input.confirm !== true) {
      return envelope(400, "confirm_required", "Send {confirm:true} to apply the migration.", { errors: [{ field: "confirm", code: "required", message: "Send {confirm:true} to apply the migration." }] });
    }
    if (!migration || typeof migration.apply !== "function") return envelope(503, "migration_unavailable", "The key migration is not available.");
    const outcome = await migration.apply();
    const report = outcome?.report || keyMigration.readMigrationReport(target);
    const inserted = Array.isArray(outcome?.inserted) ? outcome.inserted.length : 0;
    audit(target, req, { action: "migration.apply", targetType: "migration", targetId: "keys", details: { inserted, complete: outcome?.complete !== false } });
    return { status: 200, body: { ok: true, report } };
  }

  // ---- audit --------------------------------------------------------------

  function listAudit(url) {
    const q = url.searchParams;
    const query = {};
    if (q.get("cursor")) query.cursor = q.get("cursor");
    if (q.get("action")) query.action = q.get("action");
    if (q.get("target")) query.targetId = q.get("target");
    if (q.get("limit")) {
      const limit = Number(q.get("limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fieldError("limit", "out_of_range", "limit must be an integer between 1 and 200.");
      query.limit = limit;
    }
    const page = store().listAudit(query);
    return { status: 200, body: { ok: true, items: page.items, nextCursor: page.nextCursor } };
  }

  // ---- settings -----------------------------------------------------------

  function getSettings() {
    return { status: 200, body: { ok: true, ...settingsView(accessConfig()) } };
  }

  async function patchSettings(req) {
    const input = await body(req);
    const etag = String(req.headers?.["if-match"] || "").trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
    if (!etag) {
      return envelope(428, "etag_required", "Load the settings first and send their etag in If-Match, so a concurrent change is not overwritten.");
    }
    if (typeof input.section !== "string" || !WRITABLE_SECTIONS.includes(input.section)) {
      return fieldError("section", "unknown_section", `section must be one of ${WRITABLE_SECTIONS.join(", ")}.`);
    }
    if (typeof settings.writeSection !== "function") return envelope(503, "settings_unavailable", "The settings writer is not available.");
    const target = (() => {
      try {
        return store();
      } catch {
        return null;
      }
    })();
    const { actor, ip } = actorOf(req);
    const result = await updateAccessSection(input.section, input.patch, {
      etag,
      actor,
      actorIp: ip,
      writeSection: settings.writeSection,
      readSection: settings.readSection,
      store: target,
      bus: getBus(),
      logger,
    });
    if (!result.ok) {
      const status = Number(result.status) || 400;
      const message = String(result.error?.message || "The settings were not saved.");
      return {
        status,
        body: {
          ok: false,
          error: { code: result.code || result.error?.code || "config_invalid", message },
          errors: Array.isArray(result.errors) ? result.errors : [],
          ...(result.etag ? { etag: result.etag } : {}),
        },
      };
    }
    try {
      getSecurity()?.refreshAccessConfig?.();
    } catch {
      // The adapter re-reads on its own within seconds.
    }
    const view = result.config ? settingsView(result.config) : null;
    return {
      status: 200,
      body: {
        ok: true,
        config: view ? view.config : undefined,
        etag: result.etag,
        restartRequired: result.restartRequired || [],
        changed: result.changed || [],
        ...(result.warnings ? { warnings: result.warnings } : {}),
      },
    };
  }

  // ---- announcements and model meta ---------------------------------------

  async function createAnnouncement(req) {
    const target = store();
    const { actor, ip } = actorOf(req);
    return { status: 201, body: { ok: true, announcement: target.createAnnouncement(await body(req), { actor, ip }) } };
  }

  async function updateAnnouncement(req, id) {
    const target = store();
    const { actor, ip } = actorOf(req);
    return { status: 200, body: { ok: true, announcement: target.updateAnnouncement(id, await body(req), { actor, ip }) } };
  }

  function deleteAnnouncement(req, id) {
    const target = store();
    const { actor, ip } = actorOf(req);
    if (!target.removeAnnouncement(id, { actor, ip })) return envelope(404, "announcement_not_found", "Announcement not found.");
    return { status: 200, body: { ok: true, removed: true, id } };
  }

  async function putModelMeta(req, modelId) {
    const target = store();
    const { actor, ip } = actorOf(req);
    return { status: 200, body: { ok: true, meta: target.upsertModelMeta(modelId, await body(req), { actor, ip }) } };
  }

  // ---- exposure scan and probe (§13.2, §13.3) -------------------------------

  // The audit row of a scan or probe. The report itself is never audited.
  function auditAction(req, action, details = {}) {
    try {
      audit(store(), req, { action, targetType: "exposure", targetId: null, details });
    } catch {
      // The report is still returned when the audit store is unavailable.
    }
  }

  async function exposureReport(force) {
    if (!exposure) return envelope(503, "exposure_unavailable", "The exposure scan is not available.");
    return { status: 200, body: { ok: true, report: await exposure.report({ force }) } };
  }

  async function exposureScan(req) {
    const outcome = await exposureReport(true);
    if (outcome.body.ok) auditAction(req, "exposure.scan", { status: outcome.body.report.status, ...outcome.body.report.summary });
    return outcome;
  }

  function probeView(probe) {
    return {
      url: probe.url,
      at: probe.at,
      status: probe.status,
      latencyMs: probe.latencyMs,
      nonceObserved: probe.nonceObserved,
      observed: {
        viaProxy: probe.observed.viaProxy,
        headerUsed: probe.observed.headerUsed,
        socketIp: probe.observed.socketIp,
        country: probe.observed.country,
        forwardedOnUntrusted: probe.observed.forwardedOnUntrusted,
      },
      tls: probe.tls ? { validTo: probe.tls.validTo, authorized: probe.tls.authorized } : null,
      error: probe.error || null,
    };
  }

  async function exposureProbe(req) {
    if (!exposure) return envelope(503, "exposure_unavailable", "The exposure scan is not available.");
    const config = accessConfig();
    if (!(config.listeners?.public?.baseUrl || config.publicOrigin)) {
      return envelope(400, "public_base_url_required", "Set listeners.public.baseUrl to the public https address first; the probe calls that address.");
    }
    const probe = await exposure.probe();
    auditAction(req, "exposure.probe", { status: probe.status, nonceObserved: probe.nonceObserved, viaProxy: probe.observed.viaProxy, error: probe.error?.code || null });
    return { status: 200, body: { ok: true, probe: probeView(probe) } };
  }

  // ---- deploy templates (§13.3, §14) ------------------------------------------

  function templateFailure(error) {
    if (!(error instanceof deployTemplates.TemplateError)) throw error;
    if (error.code === "invalid_topology") return fieldError("topology", "invalid", error.message);
    if (error.code === "invalid_domain" && /webuiDomain/.test(error.message)) return fieldError("webuiDomain", "invalid", error.message);
    return envelope(error.status || 400, error.code, error.message, error.existing ? { existing: error.existing } : {});
  }

  function templatePlan(topology, webuiDomain) {
    return deployTemplates.planTemplates({
      topology,
      baseUrl: accessConfig().listeners?.public?.baseUrl || "",
      config: webuiDomain ? { webuiDomain } : {},
      ...(templateSources ? { templates: templateSources } : {}),
    });
  }

  async function templatesPreview(url) {
    try {
      const plan = templatePlan(url.searchParams.get("topology") || "", url.searchParams.get("webuiDomain") || "");
      return { status: 200, body: { ok: true, files: plan.files, commands: plan.commands } };
    } catch (error) {
      return templateFailure(error);
    }
  }

  async function templatesWrite(req) {
    const input = await body(req);
    if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") return fieldError("overwrite", "invalid", "overwrite must be true or false.");
    if (input.webuiDomain !== undefined && typeof input.webuiDomain !== "string") return fieldError("webuiDomain", "invalid", "webuiDomain must be a hostname.");
    try {
      const plan = templatePlan(typeof input.topology === "string" ? input.topology : "", input.webuiDomain || "");
      const result = await deployTemplates.writeTemplateFiles({
        aiRoot: templatesAiRoot,
        files: plan.files,
        overwrite: input.overwrite === true,
        ...(templatesFs ? { fsApi: templatesFs } : {}),
      });
      auditAction(req, "templates.write", { topology: input.topology, overwrite: input.overwrite === true, written: result.written });
      return { status: 200, body: { ok: true, written: result.written } };
    } catch (error) {
      return templateFailure(error);
    }
  }

  // ---- security views and bans (§13.3) ---------------------------------------

  function securityOverviewRoute(url) {
    return security.overview({ from: url.searchParams.get("from") || undefined, to: url.searchParams.get("to") || undefined })
      .then((overview) => ({ status: 200, body: overview }));
  }

  async function securityEvents(url) {
    let limit;
    if (url.searchParams.get("limit")) {
      limit = Number(url.searchParams.get("limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fieldError("limit", "out_of_range", "limit must be an integer between 1 and 200.");
    }
    const events = await security.events({ type: url.searchParams.get("type") || undefined, cursor: url.searchParams.get("cursor") || undefined, limit });
    return { status: 200, body: events };
  }

  function listBansRoute(url) {
    const includeExpired = ["1", "true"].includes(String(url.searchParams.get("includeExpired") || "").toLowerCase());
    return { status: 200, body: { ok: true, items: store().listBans({ includeExpired }) } };
  }

  // A ban must never lock the owner out of the console they are using.
  function coversCaller(input, callerIp) {
    if (!callerIp || (input.kind !== "ip" && input.kind !== "cidr")) return false;
    const caller = policy.parseIp(callerIp);
    if (!caller) return false;
    if (input.kind === "ip") return policy.normalizeIp(String(input.subject ?? "")) === policy.normalizeIp(callerIp);
    const rule = policy.parseIpRule(input.subject);
    return Boolean(rule && policy.ipMatchesRule(caller, rule));
  }

  function publishSecurity(data) {
    try {
      getBus()?.publish?.("security", data);
    } catch {
      // The event bus never fails a request.
    }
  }

  async function createBan(req) {
    const target = store();
    const input = await body(req);
    const { actor, ip } = actorOf(req);
    if (coversCaller(input, ip)) {
      const message = "That ban would cover the address you are using.";
      return envelope(400, "cannot_ban_self", message, { errors: [{ field: "subject", code: "covers_caller", message }] });
    }
    const ban = target.upsertBan({
      subject: input.subject,
      kind: input.kind,
      reason: input.reason,
      expiresAt: input.expiresAt,
      source: "admin",
    }, { actor, ip });
    publishSecurity({ kind: "ban", severity: "warning", subject: ban.subject, banKind: ban.kind, source: "admin", expiresAt: ban.expiresAt });
    return { status: 201, body: { ok: true, ban } };
  }

  function removeBan(req, subject) {
    const target = store();
    const { actor, ip } = actorOf(req);
    if (!target.removeBan(subject, { actor, ip })) return envelope(404, "ban_not_found", "Ban not found.");
    publishSecurity({ kind: "unban", severity: "info", subject, source: "admin" });
    return { status: 200, body: { ok: true, removed: true, subject } };
  }

  // ---- dispatch -----------------------------------------------------------

  function decode(segment) {
    try {
      return decodeURIComponent(segment);
    } catch {
      return null;
    }
  }

  // [method, regex, handler(req, url, ...params)]. Order matters where a
  // literal segment (bulk-revoke) shares a prefix with an id.
  const ROUTES = [
    ["GET", /^\/api\/access\/keys$/, (req, url) => listKeys(url)],
    ["POST", /^\/api\/access\/keys$/, (req) => createKey(req)],
    ["POST", /^\/api\/access\/keys\/bulk-revoke$/, (req) => bulkRevoke(req)],
    ["GET", /^\/api\/access\/keys\/([^/]+)$/, (req, url, id) => getKey(id)],
    ["PATCH", /^\/api\/access\/keys\/([^/]+)$/, (req, url, id) => patchKey(req, id)],
    ["POST", /^\/api\/access\/keys\/([^/]+)\/rotate$/, (req, url, id) => rotateKey(req, id)],
    ["POST", /^\/api\/access\/keys\/([^/]+)\/revoke$/, (req, url, id) => revokeKey(req, id)],
    ["GET", /^\/api\/access\/presets$/, () => ({ status: 200, body: { ok: true, presets: PRESETS.map(presetView) } })],
    ["GET", /^\/api\/access\/migration$/, () => migrationReport()],
    ["POST", /^\/api\/access\/migration\/plan$/, () => migrationPlan()],
    ["POST", /^\/api\/access\/migration\/apply$/, (req) => migrationApply(req)],
    ["GET", /^\/api\/access\/audit$/, (req, url) => listAudit(url)],
    ["GET", /^\/api\/public\/settings$/, () => getSettings()],
    ["PATCH", /^\/api\/public\/settings$/, (req) => patchSettings(req)],
    ["GET", /^\/api\/public\/announcements$/, () => ({ status: 200, body: { ok: true, items: store().listAnnouncements() } })],
    ["POST", /^\/api\/public\/announcements$/, (req) => createAnnouncement(req)],
    ["PATCH", /^\/api\/public\/announcements\/([^/]+)$/, (req, url, id) => updateAnnouncement(req, id)],
    ["DELETE", /^\/api\/public\/announcements\/([^/]+)$/, (req, url, id) => deleteAnnouncement(req, id)],
    ["GET", /^\/api\/public\/models\/([^/]+)\/meta$/, (req, url, id) => ({ status: 200, body: { ok: true, modelId: id, meta: store().getModelMeta(id) } })],
    ["PUT", /^\/api\/public\/models\/([^/]+)\/meta$/, (req, url, id) => putModelMeta(req, id)],
    ["GET", /^\/api\/public\/exposure$/, () => exposureReport(false)],
    ["POST", /^\/api\/public\/exposure\/scan$/, (req) => exposureScan(req)],
    ["POST", /^\/api\/public\/probe$/, (req) => exposureProbe(req)],
    ["GET", /^\/api\/public\/templates$/, (req, url) => templatesPreview(url)],
    ["POST", /^\/api\/public\/templates\/write$/, (req) => templatesWrite(req)],
    ["GET", /^\/api\/security\/overview$/, (req, url) => securityOverviewRoute(url)],
    ["GET", /^\/api\/security\/events$/, (req, url) => securityEvents(url)],
    ["GET", /^\/api\/security\/bans$/, (req, url) => listBansRoute(url)],
    ["POST", /^\/api\/security\/bans$/, (req) => createBan(req)],
    ["DELETE", /^\/api\/security\/bans\/([^/]+)$/, (req, url, subject) => removeBan(req, subject)],
  ];

  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/access/") && !pathname.startsWith("/api/public/") && !pathname.startsWith("/api/security/")) return false;
    const method = String(req.method || "GET").toUpperCase();
    let matched = null;
    let known = false;
    for (const [routeMethod, regex, handler] of ROUTES) {
      const found = regex.exec(pathname);
      if (!found) continue;
      known = true;
      if (routeMethod !== method) continue;
      matched = { handler, params: found.slice(1).map(decode) };
      break;
    }
    // Paths another package owns fall through; so does a method this module does not serve on a path it does.
    if (!matched) {
      if (!known) return false;
      const refused = authorize(req, method !== "GET" && method !== "HEAD");
      if (refused) sendJson(res, refused.body, refused.status);
      else sendJson(res, envelope(405, "method_not_allowed", "That method is not allowed here.").body, 405);
      return true;
    }
    const write = method !== "GET" && method !== "HEAD";
    const refused = authorize(req, write);
    if (refused) {
      sendJson(res, refused.body, refused.status);
      return true;
    }
    if (matched.params.some((item) => item === null || item === "")) {
      sendJson(res, fieldError("id", "invalid", "The id in the path is invalid.").body, 400);
      return true;
    }
    let outcome;
    try {
      outcome = await matched.handler(req, url, ...matched.params);
    } catch (error) {
      outcome = failure(error);
    }
    sendJson(res, outcome.body, outcome.status);
    return true;
  }

  return { handle };
}

function registerAccessRoutes(registry, warn = () => {}) {
  for (const [method, path] of ACCESS_ADMIN_WRITE_ROUTES) {
    try {
      registry.registerAdminOnly({ owner: OWNER, method, path });
    } catch (error) {
      warn(`access-routes: ${method} ${path} was not declared and stays owner-only: ${error?.message || error}`);
    }
  }
}

// Route module (07 §2.7). server.js puts getAccessStore, accessMigration and
// accessSettings on ctx; a missing one answers 503 on its routes.
function mount(ctx) {
  const auth = ctx?.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function" || !auth.viewerRegistry) {
    throw new Error("access-routes: ctx.auth is missing");
  }
  const logger = ctx.logger || console;
  registerAccessRoutes(auth.viewerRegistry, (line) => {
    try {
      (typeof logger.warn === "function" ? logger.warn : console.warn).call(logger, core.redactSecrets(String(line)));
    } catch {
      // Logging never breaks the mount.
    }
  });
  const routes = createAccessRoutes({
    auth,
    sendJson: ctx.sendJson,
    readJsonObjectBody: ctx.readJsonObjectBody,
    getStore: () => (typeof ctx.getAccessStore === "function" ? ctx.getAccessStore() : null),
    getSecurity: () => ctx.security || null,
    getBus: () => ctx.bus || null,
    migration: ctx.accessMigration || null,
    exposure: ctx.exposure || null,
    aiRoot: ctx.aiRoot || "",
    securityOverview: ctx.securityOverview || null,
    settings: ctx.accessSettings || {
      readSection: (name) => core.platform.readSection(name, { ...(ctx.aiRoot ? { aiRoot: ctx.aiRoot } : {}), env: process.env }),
      writeSection: (name, patch, writeOptions) => core.platform.writeSection(name, patch, { ...(ctx.aiRoot ? { aiRoot: ctx.aiRoot } : {}), ...writeOptions }),
    },
    logger,
    now: typeof ctx.now === "function" ? ctx.now : Date.now,
  });
  return {
    handle: routes.handle,
    close() {},
  };
}

module.exports = {
  ACCESS_ADMIN_WRITE_ROUTES,
  MAX_BULK_REVOKE,
  PRESETS,
  ROTATE_OVERLAPS,
  applyPreset,
  buildShare,
  createAccessRoutes,
  mount,
  name: "access",
  registerAccessRoutes,
};
