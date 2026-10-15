"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { previewPriceTemplateApplications } = require("./billing-price-templates");

const MICROCREDS_PER_MILLION_TOKENS = 1_000_000n;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENFORCEMENT_MODES = new Set(["shadow", "hard"]);
const CUSTOMER_STATUSES = new Set(["active", "suspended", "closed"]);
const USAGE_SOURCES = new Set(["reported", "estimated", "missing"]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "timeout", "disconnected", "ambiguous"]);
const TERMINAL_STATE_ALIASES = new Map([
  ["aborted", "cancelled"],
  ["timed_out", "timeout"],
]);
const MAX_TZ_OFFSET_MINUTES = 14 * 60;
const STORED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CREDENTIAL_LOOKUP_TTL_MS = 60_000;
const CREDENTIAL_LOOKUP_MAX_ENTRIES = 1024;
const USAGE_SUMMARY_MAX_LIMIT = 1000;
const USAGE_SUMMARY_MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000;
const USAGE_SUMMARY_QUERY_KEYS = ["kind", "groupBy", "from", "to", "customerId", "managerId", "tzOffsetMinutes", "limit"];
// summarizeUsage GROUP BY whitelist (04 §15). Every name maps to a fixed
// column expression, so request input never reaches the SQL text; the time
// keys only add the validated integer tz offset to strftime.
const USAGE_SUMMARY_GROUP_BY = Object.freeze([
  "customer", "model", "manager", "endpoint", "day", "hour", "month",
  "terminal_state", "usage_source", "decision_code", "enforcement_mode",
]);
const USAGE_SUMMARY_TIME_FORMATS = Object.freeze({ day: "%Y-%m-%d", hour: "%Y-%m-%dT%H:00", month: "%Y-%m" });
const USAGE_SUMMARY_SOURCES = Object.freeze({
  llm: Object.freeze({
    table: "billing_usage_events",
    dimensions: Object.freeze({
      customer: { column: "u.customer_id", field: "customerId" },
      model: { column: "u.model", field: "model" },
      manager: { column: "u.manager_id", field: "managerId" },
      endpoint: { column: "u.endpoint", field: "endpoint" },
      terminal_state: { column: "u.terminal_state", field: "terminalState" },
      usage_source: { column: "u.usage_source", field: "usageSource" },
      decision_code: { column: "u.decision_code", field: "decisionCode" },
      enforcement_mode: { column: "u.enforcement_mode", field: "enforcementMode" },
    }),
    metrics: `
      COUNT(*) AS requests,
      COALESCE(SUM(u.ok), 0) AS ok_requests,
      COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(u.cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
      COALESCE(SUM(u.projected_microcredits), 0) AS projected_microcredits,
      COALESCE(SUM(u.charged_microcredits), 0) AS charged_microcredits,
      COALESCE(SUM(CASE WHEN u.usage_source='estimated' THEN 1 ELSE 0 END), 0) AS estimated_usage_requests,
      COALESCE(SUM(CASE WHEN u.enforcement_mode='shadow' THEN 1 ELSE 0 END), 0) AS shadow_requests`,
    shape: (row) => ({
      requests: Number(row?.requests || 0),
      ok: Number(row?.ok_requests || 0),
      inputTokens: Number(row?.input_tokens || 0),
      cachedInputTokens: Number(row?.cached_input_tokens || 0),
      outputTokens: Number(row?.output_tokens || 0),
      totalTokens: Number(row?.total_tokens || 0),
      projectedMicrocredits: decimal(row?.projected_microcredits || 0),
      chargedMicrocredits: decimal(row?.charged_microcredits || 0),
      estimatedUsageRequests: Number(row?.estimated_usage_requests || 0),
      shadowRequests: Number(row?.shadow_requests || 0),
    }),
  }),
  // TTS rows have no model, terminal state or token columns: "model" is the
  // TTS engine, "usage_source" is how the audio duration was obtained, and
  // terminal_state is rejected rather than guessed from the HTTP status.
  tts: Object.freeze({
    table: "billing_tts_usage_events",
    dimensions: Object.freeze({
      customer: { column: "u.customer_id", field: "customerId" },
      model: { column: "u.engine", field: "model" },
      manager: { column: "u.manager_id", field: "managerId" },
      endpoint: { column: "u.endpoint", field: "endpoint" },
      usage_source: { column: "u.duration_source", field: "usageSource" },
      decision_code: { column: "u.decision_code", field: "decisionCode" },
      enforcement_mode: { column: "u.enforcement_mode", field: "enforcementMode" },
    }),
    metrics: `
      COUNT(*) AS requests,
      COALESCE(SUM(u.ok), 0) AS ok_requests,
      COALESCE(SUM(u.characters), 0) AS characters,
      COALESCE(SUM(u.audio_ms), 0) AS audio_ms,
      COALESCE(SUM(u.projected_microcredits), 0) AS projected_microcredits,
      COALESCE(SUM(u.charged_microcredits), 0) AS charged_microcredits,
      COALESCE(SUM(CASE WHEN u.duration_source='missing' THEN 1 ELSE 0 END), 0) AS missing_duration_requests,
      COALESCE(SUM(CASE WHEN u.enforcement_mode='shadow' THEN 1 ELSE 0 END), 0) AS shadow_requests`,
    shape: (row) => ({
      requests: Number(row?.requests || 0),
      ok: Number(row?.ok_requests || 0),
      characters: Number(row?.characters || 0),
      audioMs: Number(row?.audio_ms || 0),
      projectedMicrocredits: decimal(row?.projected_microcredits || 0),
      chargedMicrocredits: decimal(row?.charged_microcredits || 0),
      missingDurationRequests: Number(row?.missing_duration_requests || 0),
      shadowRequests: Number(row?.shadow_requests || 0),
    }),
  }),
});

class BillingStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "BillingStoreError";
    this.code = code;
    this.status = status;
  }
}

function createBillingStore(options = {}) {
  const DatabaseSync = options.DatabaseSync || require("node:sqlite").DatabaseSync;
  if (typeof DatabaseSync !== "function") {
    throw new BillingStoreError("billing_sqlite_unavailable", "SQLite DatabaseSync is unavailable.", 503);
  }
  const file = normalizeDatabaseFile(options.file || ":memory:");
  const clock = typeof options.clock === "function" ? options.clock : () => new Date();
  const randomUUID = typeof options.randomUUID === "function" ? options.randomUUID : crypto.randomUUID;
  const defaultEnforcementMode = normalizeEnforcementMode(options.defaultEnforcementMode || "shadow");
  const reservationTtlSeconds = boundedInteger(options.reservationTtlSeconds ?? 7200, "reservationTtlSeconds", 60, 86400);
  const busyTimeoutMs = boundedInteger(options.busyTimeoutMs ?? 5000, "busyTimeoutMs", 100, 60000);
  const defaultTzOffsetMinutes = clampTzOffsetMinutes(options.tzOffsetMinutes ?? process.env.BILLING_TZ_OFFSET_MINUTES ?? 0);

  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  let closed = false;
  // lookupCustomerForCredential runs on the telemetry hot path; bindings change
  // rarely, so answers (including "unbound") are reused for 60 s and dropped
  // whenever this store rebinds a credential or edits a customer.
  const credentialCustomerCache = new Map();

  configureDatabase(db, busyTimeoutMs);
  ensureSchema(db);

  function nowDate() {
    const value = clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new BillingStoreError("billing_clock_invalid", "Billing clock returned an invalid time.", 500);
    return date;
  }

  function nowIso() {
    return nowDate().toISOString();
  }

  function uuid(value, name = "id", { generate = false } = {}) {
    const candidate = String(value || (generate ? randomUUID() : "")).trim().toLowerCase();
    if (!UUID_RE.test(candidate)) throw new BillingStoreError("billing_invalid_uuid", `${name} must be a UUID.`);
    return candidate;
  }

  function assertOpen() {
    if (closed) throw new BillingStoreError("billing_store_closed", "Billing store is closed.", 503);
  }

  function prepare(sql) {
    assertOpen();
    const statement = db.prepare(sql);
    statement.setReadBigInts?.(true);
    return statement;
  }

  function transaction(operation) {
    assertOpen();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function insertAudit({ actorId = "system", action, targetType, targetId, customerId = null, details = {} }) {
    const at = nowIso();
    const auditId = uuid(null, "auditId", { generate: true });
    const safeDetails = safeAuditDetails(details);
    prepare(`
      INSERT INTO billing_admin_audit
        (audit_id, at, actor_id, action, target_type, target_id, customer_id, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditId,
      at,
      text(actorId, "actorId", 1, 128),
      identifier(action, "action", 1, 80),
      identifier(targetType, "targetType", 1, 40),
      text(targetId, "targetId", 1, 128),
      customerId ? uuid(customerId, "customerId") : null,
      JSON.stringify(safeDetails),
    );
    return auditId;
  }

  function createPlan(input = {}) {
    rejectUnknownKeys(input, [
      "planId", "code", "name", "currency", "monthlyPriceMicrocredits", "includedMicrocredits",
      "periodCreditLimitMicrocredits", "monthlyTokenLimit", "periodTokenLimit", "monthlyRequestLimit",
      "periodRequestLimit", "enforcementMode", "active", "actorId",
      "ttsPerMinuteMicrocredits", "ttsPerThousandCharsMicrocredits",
    ], "plan");
    const ttsPerMinute = optionalNonNegativeInt64(input.ttsPerMinuteMicrocredits, "ttsPerMinuteMicrocredits") ?? 0n;
    const ttsPerThousandChars = optionalNonNegativeInt64(input.ttsPerThousandCharsMicrocredits, "ttsPerThousandCharsMicrocredits") ?? 0n;
    const planId = uuid(input.planId, "planId", { generate: true });
    const code = planCode(input.code || `plan-${planId.slice(0, 8)}`);
    const name = text(input.name, "name", 1, 120);
    const currency = currencyCode(input.currency || "CREDITS");
    const enforcementMode = normalizeEnforcementMode(input.enforcementMode || "shadow");
    const monthlyPrice = optionalNonNegativeInt64(input.monthlyPriceMicrocredits, "monthlyPriceMicrocredits") ?? 0n;
    const included = optionalNonNegativeInt64(
      input.includedMicrocredits ?? input.periodCreditLimitMicrocredits,
      "includedMicrocredits",
    );
    const tokenLimit = optionalQuotaInt64(input.monthlyTokenLimit ?? input.periodTokenLimit, "monthlyTokenLimit");
    const requestLimit = optionalQuotaInt64(input.monthlyRequestLimit ?? input.periodRequestLimit, "monthlyRequestLimit");
    const active = booleanInteger(input.active, true, "active");
    const at = nowIso();
    const actorId = input.actorId || "system";
    return transaction(() => {
      try {
        prepare(`
          INSERT INTO billing_plans
            (plan_id, code, name, currency, monthly_price_microcredits, included_microcredits,
             monthly_token_limit, monthly_request_limit, enforcement_mode, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(planId, code, name, currency, monthlyPrice, included, tokenLimit, requestLimit, enforcementMode, active, at, at);
      } catch (error) {
        throw sqliteConstraint(error, "billing_plan_conflict", "Plan code or id already exists.");
      }
      prepare("UPDATE billing_plans SET tts_per_minute_microcredits=?, tts_per_thousand_chars_microcredits=? WHERE plan_id=?")
        .run(ttsPerMinute, ttsPerThousandChars, planId);
      insertAudit({ actorId, action: "plan.create", targetType: "plan", targetId: planId, details: { code, name, ttsPerMinuteMicrocredits: decimal(ttsPerMinute), ttsPerThousandCharsMicrocredits: decimal(ttsPerThousandChars) } });
      return getPlan(planId);
    });
  }

  function updatePlan(planIdInput, patch = {}) {
    const planId = uuid(planIdInput, "planId");
    const current = getPlanRow(planId);
    if (!current) throw new BillingStoreError("billing_plan_not_found", "Plan not found.", 404);
    const next = {
      code: patch.code === undefined ? current.code : planCode(patch.code),
      name: patch.name === undefined ? current.name : text(patch.name, "name", 1, 120),
      currency: patch.currency === undefined ? current.currency : currencyCode(patch.currency),
      monthlyPrice: patch.monthlyPriceMicrocredits === undefined
        ? current.monthly_price_microcredits
        : nonNegativeInt64(patch.monthlyPriceMicrocredits, "monthlyPriceMicrocredits"),
      included: patch.includedMicrocredits === undefined && patch.periodCreditLimitMicrocredits === undefined
        ? current.included_microcredits
        : optionalNonNegativeInt64(patch.includedMicrocredits ?? patch.periodCreditLimitMicrocredits, "includedMicrocredits"),
      tokenLimit: patch.monthlyTokenLimit === undefined && patch.periodTokenLimit === undefined
        ? current.monthly_token_limit
        : optionalQuotaInt64(patch.monthlyTokenLimit ?? patch.periodTokenLimit, "monthlyTokenLimit"),
      requestLimit: patch.monthlyRequestLimit === undefined && patch.periodRequestLimit === undefined
        ? current.monthly_request_limit
        : optionalQuotaInt64(patch.monthlyRequestLimit ?? patch.periodRequestLimit, "monthlyRequestLimit"),
      enforcementMode: patch.enforcementMode === undefined ? current.enforcement_mode : normalizeEnforcementMode(patch.enforcementMode),
      active: patch.active === undefined ? current.active : booleanInteger(patch.active, true, "active"),
      ttsPerMinute: patch.ttsPerMinuteMicrocredits === undefined
        ? BigInt(current.tts_per_minute_microcredits || 0)
        : (optionalNonNegativeInt64(patch.ttsPerMinuteMicrocredits, "ttsPerMinuteMicrocredits") ?? 0n),
      ttsPerThousandChars: patch.ttsPerThousandCharsMicrocredits === undefined
        ? BigInt(current.tts_per_thousand_chars_microcredits || 0)
        : (optionalNonNegativeInt64(patch.ttsPerThousandCharsMicrocredits, "ttsPerThousandCharsMicrocredits") ?? 0n),
    };
    rejectUnknownKeys(patch, [
      "code", "name", "currency", "monthlyPriceMicrocredits", "includedMicrocredits", "periodCreditLimitMicrocredits",
      "monthlyTokenLimit", "periodTokenLimit", "monthlyRequestLimit", "periodRequestLimit", "enforcementMode", "active", "actorId",
      "ttsPerMinuteMicrocredits", "ttsPerThousandCharsMicrocredits",
    ], "plan patch");
    return transaction(() => {
      try {
        prepare(`
          UPDATE billing_plans SET
            code=?, name=?, currency=?, monthly_price_microcredits=?, included_microcredits=?,
            monthly_token_limit=?, monthly_request_limit=?, enforcement_mode=?, active=?, updated_at=?,
            tts_per_minute_microcredits=?, tts_per_thousand_chars_microcredits=?
          WHERE plan_id=?
        `).run(
          next.code, next.name, next.currency, next.monthlyPrice, next.included, next.tokenLimit,
          next.requestLimit, next.enforcementMode, next.active, nowIso(),
          next.ttsPerMinute, next.ttsPerThousandChars, planId,
        );
      } catch (error) {
        throw sqliteConstraint(error, "billing_plan_conflict", "Plan code already exists.");
      }
      insertAudit({ actorId: patch.actorId || "system", action: "plan.update", targetType: "plan", targetId: planId, details: publicPlanFields(next) });
      return getPlan(planId);
    });
  }

  function getPlan(planIdInput) {
    const row = getPlanRow(uuid(planIdInput, "planId"));
    if (!row) return null;
    return planFromRow(row);
  }

  function getPlanRow(planId) {
    return prepare("SELECT * FROM billing_plans WHERE plan_id=?").get(planId) || null;
  }

  function listPlans(query = {}) {
    const { limit, offset } = pagination(query);
    const params = [];
    let sql = "SELECT * FROM billing_plans";
    if (query.active !== undefined) {
      sql += " WHERE active=?";
      params.push(booleanInteger(query.active, true, "active"));
    }
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(BigInt(limit), BigInt(offset));
    return prepare(sql).all(...params).map(planFromRow);
  }

  function createCustomer(input = {}) {
    rejectUnknownKeys(input, [
      "customerId", "externalRef", "name", "status", "planId", "enforcementMode", "creditLimitMicrocredits",
      "monthlyTokenLimit", "monthlyRequestLimit", "notes", "actorId", "ttsDailySecondsLimit",
    ], "customer");
    const ttsDailySecondsLimit = optionalQuotaInt64(input.ttsDailySecondsLimit, "ttsDailySecondsLimit");
    const customerId = uuid(input.customerId, "customerId", { generate: true });
    const externalRef = nullableText(input.externalRef, "externalRef", 128);
    const name = text(input.name, "name", 1, 120);
    const status = normalizeCustomerStatus(input.status || "active");
    const planId = input.planId ? uuid(input.planId, "planId") : null;
    const enforcementMode = input.enforcementMode === undefined || input.enforcementMode === null || input.enforcementMode === ""
      ? null
      : normalizeEnforcementMode(input.enforcementMode);
    const creditLimit = optionalQuotaInt64(input.creditLimitMicrocredits, "creditLimitMicrocredits");
    const tokenLimit = optionalQuotaInt64(input.monthlyTokenLimit, "monthlyTokenLimit");
    const requestLimit = optionalQuotaInt64(input.monthlyRequestLimit, "monthlyRequestLimit");
    const notes = optionalText(input.notes, "notes", 1000);
    const at = nowIso();
    return transaction(() => {
      if (planId && !getPlanRow(planId)) throw new BillingStoreError("billing_plan_not_found", "Plan not found.", 404);
      try {
        prepare(`
          INSERT INTO billing_customers
            (customer_id, external_ref, name, status, plan_id, enforcement_mode, credit_limit_microcredits,
             monthly_token_limit, monthly_request_limit, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(customerId, externalRef, name, status, planId, enforcementMode, creditLimit, tokenLimit, requestLimit, notes, at, at);
      } catch (error) {
        throw sqliteConstraint(error, "billing_customer_conflict", "Customer id or external reference already exists.");
      }
      prepare("UPDATE billing_customers SET tts_daily_seconds_limit=? WHERE customer_id=?").run(ttsDailySecondsLimit, customerId);
      insertAudit({ actorId: input.actorId || "system", action: "customer.create", targetType: "customer", targetId: customerId, customerId, details: { externalRef, name, status, planId, enforcementMode, creditLimitMicrocredits: decimal(creditLimit), monthlyTokenLimit: decimal(tokenLimit), monthlyRequestLimit: decimal(requestLimit) } });
      return getCustomer(customerId);
    });
  }

  function updateCustomer(customerIdInput, patch = {}) {
    const customerId = uuid(customerIdInput, "customerId");
    const current = getCustomerRow(customerId);
    if (!current) throw new BillingStoreError("billing_customer_not_found", "Customer not found.", 404);
    rejectUnknownKeys(patch, ["externalRef", "name", "status", "planId", "enforcementMode", "creditLimitMicrocredits", "monthlyTokenLimit", "monthlyRequestLimit", "notes", "actorId", "ttsDailySecondsLimit"], "customer patch");
    const planId = patch.planId === undefined
      ? current.plan_id
      : patch.planId === null || patch.planId === "" ? null : uuid(patch.planId, "planId");
    const enforcementMode = patch.enforcementMode === undefined
      ? current.enforcement_mode
      : patch.enforcementMode === null || patch.enforcementMode === "" || patch.enforcementMode === "inherit"
        ? null
        : normalizeEnforcementMode(patch.enforcementMode);
    const next = {
      externalRef: patch.externalRef === undefined ? current.external_ref : nullableText(patch.externalRef, "externalRef", 128),
      name: patch.name === undefined ? current.name : text(patch.name, "name", 1, 120),
      status: patch.status === undefined ? current.status : normalizeCustomerStatus(patch.status),
      planId,
      enforcementMode,
      creditLimit: patch.creditLimitMicrocredits === undefined
        ? current.credit_limit_microcredits
        : optionalQuotaInt64(patch.creditLimitMicrocredits, "creditLimitMicrocredits"),
      tokenLimit: patch.monthlyTokenLimit === undefined
        ? current.monthly_token_limit
        : optionalQuotaInt64(patch.monthlyTokenLimit, "monthlyTokenLimit"),
      requestLimit: patch.monthlyRequestLimit === undefined
        ? current.monthly_request_limit
        : optionalQuotaInt64(patch.monthlyRequestLimit, "monthlyRequestLimit"),
      notes: patch.notes === undefined ? current.notes : optionalText(patch.notes, "notes", 1000),
      ttsDailySecondsLimit: patch.ttsDailySecondsLimit === undefined
        ? (current.tts_daily_seconds_limit === null || current.tts_daily_seconds_limit === undefined ? null : BigInt(current.tts_daily_seconds_limit))
        : optionalQuotaInt64(patch.ttsDailySecondsLimit, "ttsDailySecondsLimit"),
    };
    const updated = transaction(() => {
      if (planId && !getPlanRow(planId)) throw new BillingStoreError("billing_plan_not_found", "Plan not found.", 404);
      try {
        prepare(`
          UPDATE billing_customers SET
            external_ref=?, name=?, status=?, plan_id=?, enforcement_mode=?, credit_limit_microcredits=?,
            monthly_token_limit=?, monthly_request_limit=?, notes=?, updated_at=?, tts_daily_seconds_limit=?
          WHERE customer_id=?
        `).run(next.externalRef, next.name, next.status, planId, enforcementMode, next.creditLimit, next.tokenLimit, next.requestLimit, next.notes, nowIso(), next.ttsDailySecondsLimit, customerId);
      } catch (error) {
        throw sqliteConstraint(error, "billing_customer_conflict", "Customer external reference already exists.");
      }
      insertAudit({ actorId: patch.actorId || "system", action: "customer.update", targetType: "customer", targetId: customerId, customerId, details: { externalRef: next.externalRef, name: next.name, status: next.status, planId, enforcementMode, creditLimitMicrocredits: decimal(next.creditLimit), monthlyTokenLimit: decimal(next.tokenLimit), monthlyRequestLimit: decimal(next.requestLimit) } });
      return getCustomer(customerId);
    });
    credentialCustomerCache.clear();
    return updated;
  }

  function updateCustomerPolicy(customerId, patch = {}) {
    rejectUnknownKeys(patch, ["planId", "enforcementMode", "creditLimitMicrocredits", "monthlyTokenLimit", "monthlyRequestLimit", "status", "actorId", "ttsDailySecondsLimit"], "customer policy patch");
    return updateCustomer(customerId, patch);
  }

  function getCustomer(customerIdInput) {
    const customerId = uuid(customerIdInput, "customerId");
    const row = getCustomerRow(customerId);
    if (!row) return null;
    const wallet = walletState(customerId);
    return customerFromRow(row, wallet);
  }

  function getCustomerRow(customerId) {
    return prepare("SELECT * FROM billing_customers WHERE customer_id=?").get(customerId) || null;
  }

  function listCustomers(query = {}) {
    const { limit, offset } = pagination(query);
    const params = [];
    let sql = "SELECT * FROM billing_customers";
    if (query.status !== undefined) {
      sql += " WHERE status=?";
      params.push(normalizeCustomerStatus(query.status));
    }
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(BigInt(limit), BigInt(offset));
    return prepare(sql).all(...params).map((row) => customerFromRow(row, walletState(row.customer_id)));
  }

  // Read-only billing snapshot of one customer for /v1/me (05 §6.4), or null
  // when the customer does not exist. `at` picks the billing month (store tz
  // offset); the balance is the current wallet balance. Period spend is what
  // the month's LLM and TTS usage cost: the debit for Hard rows, the projected
  // cost for Shadow rows, which are never charged.
  function getCustomerSummary(customerIdInput, options = {}) {
    rejectUnknownKeys(options, ["at"], "customer summary options");
    const customerId = uuid(customerIdInput, "customerId");
    const atDate = isBlank(options.at) ? nowDate() : usageSummaryInstant(options.at, "at", defaultTzOffsetMinutes);
    const customer = prepare(`
      SELECT c.enforcement_mode AS customer_enforcement_mode, p.enforcement_mode AS plan_enforcement_mode
      FROM billing_customers c
      LEFT JOIN billing_plans p ON p.plan_id=c.plan_id
      WHERE c.customer_id=?
    `).get(customerId);
    if (!customer) return null;
    const period = monthPeriod(atDate, defaultTzOffsetMinutes);
    const spendSql = (table) => `
      SELECT COALESCE(SUM(CASE WHEN enforcement_mode='hard' THEN charged_microcredits ELSE projected_microcredits END), 0) AS total
      FROM ${table} WHERE customer_id=? AND at>=? AND at<?
    `;
    const llmSpend = prepare(spendSql("billing_usage_events")).get(customerId, period.start, period.end);
    const ttsSpend = prepare(spendSql("billing_tts_usage_events")).get(customerId, period.start, period.end);
    const balance = prepare("SELECT COALESCE(SUM(delta_microcredits), 0) AS total FROM billing_wallet_ledger WHERE customer_id=?").get(customerId);
    return {
      enforcementMode: customer.customer_enforcement_mode || customer.plan_enforcement_mode || defaultEnforcementMode,
      balanceMicrocredits: decimal(BigInt(balance?.total || 0)),
      periodSpendMicrocredits: decimal(BigInt(llmSpend?.total || 0) + BigInt(ttsSpend?.total || 0)),
      period,
    };
  }

  function bindCredential(input = {}) {
    const customerId = uuid(input.customerId, "customerId");
    const managerId = managerIdentifier(input.managerId);
    const serviceClientId = clientIdentifier(input.serviceClientId ?? input.clientId);
    const label = optionalText(input.label, "label", 120);
    const active = booleanInteger(input.active, true, "active");
    const at = nowIso();
    const binding = transaction(() => {
      if (!getCustomerRow(customerId)) throw new BillingStoreError("billing_customer_not_found", "Customer not found.", 404);
      const existing = prepare("SELECT binding_id FROM billing_credential_bindings WHERE manager_id=? AND service_client_id=?").get(managerId, serviceClientId);
      const bindingId = existing?.binding_id || uuid(input.bindingId, "bindingId", { generate: true });
      prepare(`
        INSERT INTO billing_credential_bindings
          (binding_id, customer_id, manager_id, service_client_id, label, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(manager_id, service_client_id) DO UPDATE SET
          customer_id=excluded.customer_id, label=excluded.label, active=excluded.active, updated_at=excluded.updated_at
      `).run(bindingId, customerId, managerId, serviceClientId, label, active, at, at);
      insertAudit({ actorId: input.actorId || "system", action: existing ? "credential.rebind" : "credential.bind", targetType: "credential_binding", targetId: bindingId, customerId, details: { managerId, serviceClientId, label, active: Boolean(active) } });
      return credentialBindingFromRow(getBindingRow(managerId, serviceClientId));
    });
    credentialCustomerCache.clear();
    return binding;
  }

  // Read-only: the active binding's customer for a (manager, service client)
  // pair, or null. Invalid identifiers answer null instead of throwing because
  // the caller is the telemetry recorder, which must never fail a request.
  function lookupCustomerForCredential(managerIdInput, clientIdInput) {
    let managerId;
    let clientId;
    try {
      managerId = managerIdentifier(managerIdInput);
      clientId = clientIdentifier(clientIdInput);
    } catch {
      return null;
    }
    const key = `${managerId}\n${clientId}`;
    const nowMs = nowDate().getTime();
    const cached = credentialCustomerCache.get(key);
    if (cached && nowMs < cached.expiresAt && nowMs >= cached.expiresAt - CREDENTIAL_LOOKUP_TTL_MS) {
      return cached.value ? { ...cached.value } : null;
    }
    const row = prepare(`
      SELECT b.binding_id, b.customer_id, c.status AS customer_status
      FROM billing_credential_bindings b
      JOIN billing_customers c ON c.customer_id=b.customer_id
      WHERE b.manager_id=? AND b.service_client_id=? AND b.active=1
    `).get(managerId, clientId);
    const value = row
      ? { customerId: row.customer_id, customerStatus: row.customer_status, bindingId: row.binding_id }
      : null;
    credentialCustomerCache.delete(key);
    if (credentialCustomerCache.size >= CREDENTIAL_LOOKUP_MAX_ENTRIES) {
      credentialCustomerCache.delete(credentialCustomerCache.keys().next().value);
    }
    credentialCustomerCache.set(key, { value, expiresAt: nowMs + CREDENTIAL_LOOKUP_TTL_MS });
    return value ? { ...value } : null;
  }

  function getBindingRow(managerId, serviceClientId) {
    return prepare(`
      SELECT b.*, c.status AS customer_status, c.plan_id, c.enforcement_mode AS customer_enforcement_mode,
             c.credit_limit_microcredits, c.monthly_token_limit AS customer_monthly_token_limit,
             c.monthly_request_limit AS customer_monthly_request_limit,
             c.tts_daily_seconds_limit,
             p.enforcement_mode AS plan_enforcement_mode, p.active AS plan_active,
             p.included_microcredits, p.monthly_token_limit AS plan_monthly_token_limit,
             p.monthly_request_limit AS plan_monthly_request_limit
      FROM billing_credential_bindings b
      JOIN billing_customers c ON c.customer_id=b.customer_id
      LEFT JOIN billing_plans p ON p.plan_id=c.plan_id
      WHERE b.manager_id=? AND b.service_client_id=?
    `).get(managerId, serviceClientId) || null;
  }

  function listCredentialBindings(query = {}) {
    const { limit, offset } = pagination(query, 200);
    const where = [];
    const params = [];
    if (query.customerId) { where.push("b.customer_id=?"); params.push(uuid(query.customerId, "customerId")); }
    if (query.active !== undefined) { where.push("b.active=?"); params.push(booleanInteger(query.active, true, "active")); }
    const sql = `
      SELECT b.* FROM billing_credential_bindings b
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY b.created_at DESC LIMIT ? OFFSET ?
    `;
    params.push(BigInt(limit), BigInt(offset));
    return prepare(sql).all(...params).map(credentialBindingFromRow);
  }

  function adjustBalance(input = {}) {
    const customerId = uuid(input.customerId, "customerId");
    const rawDelta = input.deltaMicrocredits ?? input.amountMicrocredits;
    const delta = signedInt64(rawDelta, "deltaMicrocredits");
    if (delta === 0n) throw new BillingStoreError("billing_zero_adjustment", "Balance adjustment must be non-zero.");
    const reason = text(input.reason, "reason", 1, 500);
    const idempotencyKey = input.idempotencyKey
      ? text(input.idempotencyKey, "idempotencyKey", 8, 128)
      : uuid(null, "idempotencyKey", { generate: true });
    return transaction(() => {
      if (!getCustomerRow(customerId)) throw new BillingStoreError("billing_customer_not_found", "Customer not found.", 404);
      const existing = prepare("SELECT * FROM billing_wallet_ledger WHERE idempotency_key=?").get(idempotencyKey);
      if (existing) {
        if (existing.customer_id !== customerId || existing.delta_microcredits !== delta) {
          throw new BillingStoreError("billing_idempotency_conflict", "Idempotency key was already used for a different adjustment.", 409);
        }
        return ledgerFromRow(existing, true);
      }
      const entryId = uuid(null, "entryId", { generate: true });
      const at = nowIso();
      prepare(`
        INSERT INTO billing_wallet_ledger
          (entry_id, at, customer_id, entry_type, delta_microcredits, request_id, idempotency_key, reason, actor_id)
        VALUES (?, ?, ?, 'adjustment', ?, NULL, ?, ?, ?)
      `).run(entryId, at, customerId, delta, idempotencyKey, reason, text(input.actorId || "system", "actorId", 1, 128));
      insertAudit({ actorId: input.actorId || "system", action: "wallet.adjust", targetType: "wallet_entry", targetId: entryId, customerId, details: { deltaMicrocredits: delta.toString(), reason, idempotencyKey } });
      return ledgerFromRow(prepare("SELECT * FROM billing_wallet_ledger WHERE entry_id=?").get(entryId), false);
    });
  }

  function upsertPrice(input = {}) {
    return transaction(() => writePrice(input));
  }

  function writePrice(input = {}, internal = {}) {
    const planId = input.planId ? uuid(input.planId, "planId") : null;
    const managerId = normalizePriceScope(input.managerId || "*", "managerId");
    const model = normalizePriceScope(input.model ?? input.modelPattern, "model");
    const inputRate = nonNegativeInt64(
      input.inputPerMillionMicrocredits ?? input.inputMicrocreditsPerMillion,
      "inputPerMillionMicrocredits",
    );
    const outputRate = nonNegativeInt64(
      input.outputPerMillionMicrocredits ?? input.outputMicrocreditsPerMillion,
      "outputPerMillionMicrocredits",
    );
    const cachedRate = optionalNonNegativeInt64(
      input.cachedInputPerMillionMicrocredits ?? input.cachedInputMicrocreditsPerMillion,
      "cachedInputPerMillionMicrocredits",
    ) ?? inputRate;
    const fixed = optionalNonNegativeInt64(input.fixedRequestMicrocredits, "fixedRequestMicrocredits") ?? 0n;
    const active = strictBoolean(input.active, true, "active");
    const actorId = internal.actorId || input.actorId || "system";
    const sourceTemplateId = nullableText(internal.sourceTemplateId, "sourceTemplateId", 160);
    const sourceCatalogVersion = nullableText(internal.sourceCatalogVersion, "sourceCatalogVersion", 80);
    const sourceSnapshotDate = nullableText(internal.sourceSnapshotDate, "sourceSnapshotDate", 40);
    const sourceUrl = nullableText(internal.sourceUrl, "sourceUrl", 1000);
    if (planId && !getPlanRow(planId)) throw new BillingStoreError("billing_plan_not_found", "Plan not found.", 404);
    const current = prepare(`
      SELECT * FROM billing_model_prices
      WHERE ((plan_id=? ) OR (plan_id IS NULL AND ? IS NULL)) AND manager_id=? AND model_pattern=? AND effective_to IS NULL
    `).get(planId, planId, managerId, model);
    if (!active) {
      if (!current) throw new BillingStoreError("billing_price_not_found", "Active price not found.", 404);
      const at = nowIso();
      prepare("UPDATE billing_model_prices SET effective_to=? WHERE price_id=? AND effective_to IS NULL").run(at, current.price_id);
      insertAudit({ actorId, action: "price.deactivate", targetType: "model_price", targetId: current.price_id, details: { planId, managerId, model } });
      return priceFromRow(prepare("SELECT * FROM billing_model_prices WHERE price_id=?").get(current.price_id), false);
    }
    if (current
      && current.input_per_million_microcredits === inputRate
      && current.output_per_million_microcredits === outputRate
      && current.cached_input_per_million_microcredits === cachedRate
      && current.fixed_request_microcredits === fixed
      && current.source_template_id === sourceTemplateId
      && current.source_catalog_version === sourceCatalogVersion
      && current.source_snapshot_date === sourceSnapshotDate
      && current.source_url === sourceUrl) return priceFromRow(current, true);
    const at = nowIso();
    if (current) prepare("UPDATE billing_model_prices SET effective_to=? WHERE price_id=? AND effective_to IS NULL").run(at, current.price_id);
    const priceId = uuid(input.priceId, "priceId", { generate: true });
    prepare(`
      INSERT INTO billing_model_prices
        (price_id, plan_id, manager_id, model_pattern, input_per_million_microcredits,
         output_per_million_microcredits, cached_input_per_million_microcredits,
         fixed_request_microcredits, source_template_id, source_catalog_version,
         source_snapshot_date, source_url, effective_from, effective_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(priceId, planId, managerId, model, inputRate, outputRate, cachedRate, fixed, sourceTemplateId, sourceCatalogVersion, sourceSnapshotDate, sourceUrl, at, at);
    insertAudit({ actorId, action: current ? "price.replace" : "price.create", targetType: "model_price", targetId: priceId, details: { planId, managerId, model, inputPerMillionMicrocredits: inputRate.toString(), outputPerMillionMicrocredits: outputRate.toString(), cachedInputPerMillionMicrocredits: cachedRate.toString(), fixedRequestMicrocredits: fixed.toString(), replacesPriceId: current?.price_id || null, sourceTemplateId, sourceCatalogVersion, sourceSnapshotDate } });
    return priceFromRow(prepare("SELECT * FROM billing_model_prices WHERE price_id=?").get(priceId), false);
  }

  function applyPriceTemplates(input = {}) {
    const preview = previewPriceTemplateApplications(input, { clock: nowDate });
    return transaction(() => {
      const appliedAt = nowIso();
      const appliedItems = preview.items.map((item) => ({
        ...item,
        price: writePrice({
          planId: item.planId,
          managerId: item.managerId,
          modelPattern: item.modelPattern,
          inputPerMillionMicrocredits: item.inputPerMillionMicrocredits,
          cachedInputPerMillionMicrocredits: item.cachedInputPerMillionMicrocredits,
          outputPerMillionMicrocredits: item.outputPerMillionMicrocredits,
          fixedRequestMicrocredits: item.fixedRequestMicrocredits,
        }, {
          actorId: "local-admin",
          sourceTemplateId: item.templateId,
          sourceCatalogVersion: item.catalogVersion,
          sourceSnapshotDate: item.snapshotDate,
          sourceUrl: item.sourceUrl,
        }),
      }));
      const auditId = insertAudit({
        actorId: "local-admin",
        action: "price_template.apply",
        targetType: "price_template_batch",
        targetId: uuid(null, "templateBatchId", { generate: true }),
        details: {
          catalogVersion: preview.catalogVersion,
          creditsPerUsd: preview.creditsPerUsd,
          markupBps: preview.markupBps,
          count: appliedItems.length,
          templateIds: appliedItems.map((item) => item.templateId),
        },
      });
      return {
        ...preview,
        actorId: "local-admin",
        appliedAt,
        auditId,
        items: appliedItems,
      };
    });
  }

  function listPrices(query = {}) {
    const { limit, offset } = pagination(query, 200);
    const where = [];
    const params = [];
    if (query.planId !== undefined) {
      if (query.planId === null || query.planId === "") where.push("plan_id IS NULL");
      else { where.push("plan_id=?"); params.push(uuid(query.planId, "planId")); }
    }
    if (query.active !== undefined) where.push(booleanInteger(query.active, true, "active") ? "effective_to IS NULL" : "effective_to IS NOT NULL");
    const sql = `SELECT * FROM billing_model_prices ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY effective_from DESC LIMIT ? OFFSET ?`;
    params.push(BigInt(limit), BigInt(offset));
    return prepare(sql).all(...params).map(priceFromRow);
  }

  function resolvePrice(planId, managerId, model, at) {
    const candidates = prepare(`
      SELECT * FROM billing_model_prices
      WHERE (plan_id=? OR plan_id IS NULL)
        AND (manager_id=? OR manager_id='*')
        AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)
    `).all(planId, managerId, at, at)
      .filter((price) => modelGlobMatches(price.model_pattern, model));
    candidates.sort((left, right) => comparePriceSpecificity(left, right, planId, managerId, model));
    return candidates[0] || null;
  }

  // Read-only: the price a plan puts on one model now, in microcredits per
  // million tokens, or null. planId null is the default plan (prices that
  // name no plan). Used by the public model list (05 §8.3); never throws on a
  // missing price.
  function resolveModelPrice(input = {}) {
    const model = String(input.model || "").trim();
    if (!model) return null;
    const row = resolvePrice(input.planId || null, String(input.managerId || ""), model, isBlank(input.at) ? nowIso() : new Date(input.at).toISOString());
    if (!row) return null;
    const price = priceFromRow(row);
    return {
      input: price.inputPerMillionMicrocredits,
      cachedInput: price.cachedInputPerMillionMicrocredits,
      output: price.outputPerMillionMicrocredits,
    };
  }

  function authorizeRequest(input = {}) {
    const request = normalizeAuthorizeInput(input, uuid);
    return transaction(() => {
      const authorizationTime = nowDate();
      const authorizationAt = authorizationTime.toISOString();
      prepare(`
        UPDATE billing_request_reservations
        SET status='released', settled_at=?
        WHERE status='authorized' AND expires_at<=?
      `).run(authorizationAt, authorizationAt);
      const existing = getReservationRow(request.requestId);
      if (existing) {
        assertReservationIdentity(existing, request);
        return authorizationFromRow(existing, true);
      }

      const atDate = authorizationTime;
      const at = atDate.toISOString();
      // The binding is looked up under the credential's billing scope (05 §6.4);
      // the price below still resolves for the manager that serves the request.
      const binding = getBindingRow(request.credentialManagerId, request.clientId);
      const period = monthPeriod(atDate, defaultTzOffsetMinutes);
      const base = {
        ...request,
        reservationId: uuid(null, "reservationId", { generate: true }),
        at,
        expiresAt: new Date(atDate.getTime() + reservationTtlSeconds * 1000).toISOString(),
        period,
      };

      if (!binding || Number(binding.active) !== 1) {
        const allowed = defaultEnforcementMode === "shadow";
        const row = insertReservation({
          ...base,
          binding: null,
          enforcementMode: defaultEnforcementMode,
          allowed,
          code: allowed ? "billing_unbound_shadow" : "billing_credential_unbound",
          message: allowed ? "Credential is not billing-bound; request allowed in shadow mode." : "Credential is not bound to a billing customer.",
          reserved: 0n,
          price: null,
        });
        return authorizationFromRow(row, false);
      }

      const enforcementMode = binding.customer_enforcement_mode || binding.plan_enforcement_mode || defaultEnforcementMode;
      if (binding.customer_status !== "active") {
        const row = insertReservation({ ...base, binding, enforcementMode, allowed: false, code: "billing_customer_inactive", message: "Billing customer is not active.", reserved: 0n, price: null });
        return authorizationFromRow(row, false);
      }
      if (binding.plan_id && Number(binding.plan_active) !== 1) {
        const row = insertReservation({ ...base, binding, enforcementMode, allowed: enforcementMode === "shadow", code: enforcementMode === "shadow" ? "billing_plan_inactive_shadow" : "billing_plan_inactive", message: "Billing plan is not active.", reserved: 0n, price: null });
        return authorizationFromRow(row, false);
      }

      const price = resolvePrice(binding.plan_id, request.managerId, request.model, at);
      if (!price) {
        const allowed = enforcementMode === "shadow";
        const row = insertReservation({ ...base, binding, enforcementMode, allowed, code: allowed ? "billing_price_missing_shadow" : "billing_price_not_configured", message: "No matching billing price is configured.", reserved: 0n, price: null });
        return authorizationFromRow(row, false);
      }

      const reserved = calculateMicrocredits({
        inputTokens: request.estimatedInputTokens,
        outputTokens: request.maxOutputTokens,
        cachedInputTokens: request.cachedInputTokens,
      }, price);
      const limits = limitState(binding, period, reserved, request.estimatedInputTokens + request.maxOutputTokens, at);
      const overLimit = limits.reasons[0] || null;
      const allowed = enforcementMode === "shadow" || !overLimit;
      const code = overLimit
        ? enforcementMode === "shadow" ? `${overLimit}_shadow` : overLimit
        : "billing_authorized";
      const message = overLimit
        ? enforcementMode === "shadow" ? "Billing limit would be exceeded; request allowed in shadow mode." : limitMessage(overLimit)
        : "Billing authorization granted.";
      const row = insertReservation({ ...base, binding, enforcementMode, allowed, code, message, reserved, price });
      return authorizationFromRow(row, false);
    });
  }

  function insertReservation(input) {
    const binding = input.binding;
    const price = input.price;
    prepare(`
      INSERT INTO billing_request_reservations
        (request_id, reservation_id, external_request_id, manager_id, service_client_id, customer_id,
         binding_id, plan_id, price_id, model, endpoint, stream, enforcement_mode, allowed, decision_code,
         decision_message, status, estimated_input_tokens, max_output_tokens, cached_input_tokens,
         reservation_microcredits, price_input_per_million, price_output_per_million, price_cached_input_per_million,
         price_fixed_request, period_key, period_start, period_end, authorized_at, expires_at, settled_at,
         credential_manager_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      input.requestId, input.reservationId, input.externalRequestId || null, input.managerId, input.clientId,
      binding?.customer_id || null, binding?.binding_id || null, binding?.plan_id || null, price?.price_id || null,
      input.model, input.endpoint, input.stream ? 1 : 0, input.enforcementMode, input.allowed ? 1 : 0,
      input.code, input.message, input.allowed ? "authorized" : "denied", input.estimatedInputTokens,
      input.maxOutputTokens, input.cachedInputTokens, input.reserved,
      price?.input_per_million_microcredits ?? 0n, price?.output_per_million_microcredits ?? 0n,
      price?.cached_input_per_million_microcredits ?? 0n, price?.fixed_request_microcredits ?? 0n,
      input.period.key, input.period.start, input.period.end, input.at, input.expiresAt,
      input.credentialManagerId,
    );
    return getReservationRow(input.requestId);
  }

  function settleRequest(input = {}) {
    const settlement = normalizeSettlementInput(input, uuid);
    return transaction(() => {
      const existingUsage = getUsageRow(settlement.requestId);
      if (existingUsage) {
        assertUsageIdentity(existingUsage, settlement, getReservationRow(settlement.requestId));
        return settlementFromRow(existingUsage, true);
      }
      const reservation = getReservationRow(settlement.requestId);
      if (!reservation) throw new BillingStoreError("billing_reservation_not_found", "Billing reservation not found.", 404);
      assertReservationIdentity(reservation, settlement);
      if (reservation.status === "denied") {
        return {
          ok: true,
          settled: false,
          replayed: false,
          requestId: reservation.request_id,
          allowed: false,
          bound: Boolean(reservation.customer_id),
          enforcementMode: reservation.enforcement_mode,
          customerId: reservation.customer_id || null,
          code: reservation.decision_code,
          message: reservation.decision_message,
          projectedMicrocredits: "0",
          chargedMicrocredits: "0",
        };
      }

      const missing = settlement.usageSource === "missing";
      const completed = settlement.ok === true && settlement.terminalState === "completed";
      // A client disconnect or timeout must not become a free-inference switch:
      // when the upstream reported usage (or the gateway produced a bounded
      // estimate from bytes already streamed), charge those consumed tokens.
      // Truly missing/ambiguous usage remains non-billable and releases the
      // reservation so uncertainty is never silently charged as zero tokens.
      const hasMeasuredConsumption = !missing && settlement.totalTokens > 0n;
      const billable = !missing && settlement.terminalState !== "ambiguous" && (completed || hasMeasuredConsumption);
      const priceSnapshot = {
        input_per_million_microcredits: reservation.price_input_per_million,
        output_per_million_microcredits: reservation.price_output_per_million,
        cached_input_per_million_microcredits: reservation.price_cached_input_per_million,
        fixed_request_microcredits: reservation.price_fixed_request,
      };
      const projected = billable && reservation.price_id
        ? calculateMicrocredits(settlement, priceSnapshot)
        : 0n;
      const charged = billable && reservation.enforcement_mode === "hard" && reservation.customer_id
        ? projected
        : 0n;
      const at = nowIso();
      const usageId = uuid(null, "usageId", { generate: true });
      prepare(`
        INSERT INTO billing_usage_events
          (usage_id, at, request_id, external_request_id, customer_id, manager_id, service_client_id,
           model, endpoint, stream, response_status, ok, terminal_state, usage_source, input_tokens,
           output_tokens, total_tokens, cached_input_tokens, projected_microcredits, charged_microcredits,
           enforcement_mode, decision_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        usageId, at, settlement.requestId, reservation.external_request_id || settlement.externalRequestId || null,
        reservation.customer_id, settlement.managerId, settlement.clientId, settlement.model,
        reservation.endpoint, reservation.stream, settlement.status, settlement.ok ? 1 : 0,
        missing && settlement.terminalState === "completed" ? "ambiguous" : settlement.terminalState,
        settlement.usageSource, settlement.inputTokens, settlement.outputTokens, settlement.totalTokens,
        settlement.cachedInputTokens, projected, charged, reservation.enforcement_mode, reservation.decision_code,
      );
      if (charged > 0n) {
        prepare(`
          INSERT INTO billing_wallet_ledger
            (entry_id, at, customer_id, entry_type, delta_microcredits, request_id, idempotency_key, reason, actor_id)
          VALUES (?, ?, ?, 'usage_debit', ?, ?, ?, ?, 'billing')
        `).run(
          uuid(null, "entryId", { generate: true }), at, reservation.customer_id, -charged,
          settlement.requestId, `usage:${settlement.requestId}`, "Settled model usage.",
        );
      }
      prepare("UPDATE billing_request_reservations SET status=?, settled_at=? WHERE request_id=?")
        .run(billable ? "settled" : "released", at, settlement.requestId);
      return settlementFromRow(getUsageRow(settlement.requestId), false);
    });
  }

  function getReservationRow(requestId) {
    return prepare("SELECT * FROM billing_request_reservations WHERE request_id=?").get(requestId) || null;
  }

  function getUsageRow(requestId) {
    return prepare("SELECT * FROM billing_usage_events WHERE request_id=?").get(requestId) || null;
  }

  function getRequest(requestIdInput) {
    const requestId = uuid(requestIdInput, "requestId");
    const reservation = getReservationRow(requestId);
    if (!reservation) return null;
    const usage = getUsageRow(requestId);
    return { authorization: authorizationFromRow(reservation, true), settlement: usage ? settlementFromRow(usage, true) : null };
  }

  function limitState(binding, period, requestedMicrocredits, requestedTokens, at) {
    const customerId = binding.customer_id;
    const wallet = walletState(customerId);
    // 账期越长行数越多；配额判断只要合计值，聚合交给 SQLite（readBigInts 下
    // 整数 SUM 返回精确 BigInt），不再把整个账期的行搬进 JS。
    const authorized = prepare(`
      SELECT COUNT(*) AS row_count,
             COALESCE(SUM(reservation_microcredits), 0) AS reserved_credits,
             COALESCE(SUM(estimated_input_tokens + max_output_tokens), 0) AS reserved_tokens
      FROM billing_request_reservations
      WHERE customer_id=? AND enforcement_mode='hard' AND status='authorized' AND period_key=? AND expires_at>?
    `).get(customerId, period.key, at);
    const usage = prepare(`
      SELECT COUNT(*) AS row_count,
             COALESCE(SUM(projected_microcredits), 0) AS spent_credits,
             COALESCE(SUM(total_tokens), 0) AS spent_tokens
      FROM billing_usage_events
      WHERE customer_id=? AND at>=? AND at<?
        AND usage_source!='missing'
        AND terminal_state!='ambiguous'
        AND ((ok=1 AND terminal_state='completed') OR total_tokens>0)
    `).get(customerId, period.start, period.end);
    const ttsPending = prepare("SELECT COALESCE(SUM(reserved),0) AS total FROM billing_tts_reservations WHERE customer_id=? AND mode='hard' AND status='pending'").get(customerId);
    const ttsSpent = prepare("SELECT COALESCE(SUM(charged_microcredits),0) AS total FROM billing_tts_usage_events WHERE customer_id=? AND at>=? AND at<?").get(customerId, period.start, period.end);
    const reservedCredits = BigInt(authorized?.reserved_credits || 0) + BigInt(ttsPending.total);
    const reservedTokens = BigInt(authorized?.reserved_tokens || 0);
    const spentCredits = BigInt(usage?.spent_credits || 0) + BigInt(ttsSpent.total);
    const spentTokens = BigInt(usage?.spent_tokens || 0);
    // Request quota counts each effective settled usage once, including failed,
    // cancelled, disconnected, or timed-out requests with measured token
    // consumption. Missing/ambiguous and unmeasured failures do not consume the
    // quota. Each live Hard reservation counts once, as does this candidate.
    const requestCount = BigInt(usage?.row_count || 0) + BigInt(authorized?.row_count || 0) + 1n;
    // included_microcredits is a plan allowance/marketing field, not a hard cap.
    // Only an explicit customer credit limit constrains paid usage.
    const effectiveCreditLimit = binding.credit_limit_microcredits;
    const effectiveTokenLimit = minimumNullable(binding.customer_monthly_token_limit, binding.plan_monthly_token_limit);
    const effectiveRequestLimit = minimumNullable(binding.customer_monthly_request_limit, binding.plan_monthly_request_limit);
    const reasons = [];
    if (wallet.balance - wallet.reserved < requestedMicrocredits) reasons.push("billing_insufficient_balance");
    if (effectiveCreditLimit !== null && spentCredits + reservedCredits + requestedMicrocredits > effectiveCreditLimit) reasons.push("billing_period_credit_limit");
    if (effectiveTokenLimit !== null && spentTokens + reservedTokens + requestedTokens > effectiveTokenLimit) reasons.push("billing_period_token_limit");
    if (effectiveRequestLimit !== null && requestCount > effectiveRequestLimit) reasons.push("billing_period_request_limit");
    return { reasons, wallet, spentCredits, reservedCredits, spentTokens, reservedTokens };
  }

  function walletState(customerId) {
    // 钱包账本是 append-only 的，余额用 SQL 聚合拿合计，避免随账本增长
    // 在每个请求路径上线性扫描（readBigInts 下 SUM 返回精确 BigInt）。
    const balanceRow = prepare("SELECT COALESCE(SUM(delta_microcredits), 0) AS total FROM billing_wallet_ledger WHERE customer_id=?").get(customerId);
    const reservedRow = prepare(`
      SELECT COALESCE(SUM(reservation_microcredits), 0) AS total FROM billing_request_reservations
      WHERE customer_id=? AND enforcement_mode='hard' AND status='authorized' AND expires_at>?
    `).get(customerId, nowIso());
    const balance = BigInt(balanceRow?.total || 0);
    const ttsReserved = prepare("SELECT COALESCE(SUM(reserved),0) AS total FROM billing_tts_reservations WHERE customer_id=? AND mode='hard' AND status='pending'").get(customerId);
    const reserved = BigInt(reservedRow?.total || 0) + BigInt(ttsReserved?.total || 0);
    return { balance, reserved, available: balance - reserved };
  }

  function listUsage(query = {}) {
    const { limit, offset } = pagination(query, 200);
    const where = [];
    const params = [];
    const window = String(query.window || "all").trim().toLowerCase();
    if (!["day", "month", "all"].includes(window)) throw new BillingStoreError("billing_invalid_window", "window must be day, month, or all.");
    if (window !== "all") {
      const current = nowDate();
      const tzOffsetMinutes = query.tzOffsetMinutes == null
        ? defaultTzOffsetMinutes
        : clampTzOffsetMinutes(query.tzOffsetMinutes);
      const period = window === "month"
        ? monthPeriod(current, tzOffsetMinutes)
        : null;
      const start = window === "month"
        ? new Date(period.start)
        : new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()) - tzOffsetMinutes * 60 * 1000);
      const end = window === "month"
        ? new Date(period.end)
        : new Date(start.getTime() + 24 * 60 * 60 * 1000);
      where.push("at>=? AND at<?");
      params.push(start.toISOString(), end.toISOString());
    }
    if (query.customerId) { where.push("customer_id=?"); params.push(uuid(query.customerId, "customerId")); }
    if (query.requestId) { where.push("request_id=?"); params.push(uuid(query.requestId, "requestId")); }
    // Keyset paging on (at, usage_id): usage_id breaks ties between rows
    // settled in the same millisecond, so pages never repeat or skip a row.
    if (query.cursor !== undefined && query.cursor !== null && query.cursor !== "") {
      const cursor = decodeUsageCursor(query.cursor);
      where.push("(at<? OR (at=? AND usage_id<?))");
      params.push(cursor.at, cursor.at, cursor.usageId);
    }
    const sql = `SELECT * FROM billing_usage_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, usage_id DESC LIMIT ? OFFSET ?`;
    params.push(BigInt(limit), BigInt(offset));
    return prepare(sql).all(...params).map(usageFromRow);
  }

  // GROUP BY over the immutable usage tables (04 §15). Read-only: it only
  // prepares SELECT statements and never opens a transaction. Microcredit
  // sums come back from SQLite as exact BigInts (readBigInts) and leave as
  // decimal strings; totals cover the whole filtered range even when the
  // grouped rows are truncated at `limit`.
  function summarizeUsage(query = {}) {
    rejectUnknownKeys(query, USAGE_SUMMARY_QUERY_KEYS, "usage summary query");
    const kind = usageSummaryKind(query.kind);
    const source = USAGE_SUMMARY_SOURCES[kind];
    const groupBy = usageSummaryGroupBy(query.groupBy, kind);
    const tzOffsetMinutes = query.tzOffsetMinutes === undefined || query.tzOffsetMinutes === null || query.tzOffsetMinutes === ""
      ? defaultTzOffsetMinutes
      : strictTzOffsetMinutes(query.tzOffsetMinutes);
    const range = usageSummaryRange(query.from, query.to, tzOffsetMinutes, nowDate());
    const limit = boundedInteger(query.limit ?? USAGE_SUMMARY_MAX_LIMIT, "limit", 1, USAGE_SUMMARY_MAX_LIMIT);
    const where = ["u.at>=?", "u.at<?"];
    const params = [range.from, range.to];
    if (query.customerId) { where.push("u.customer_id=?"); params.push(uuid(query.customerId, "customerId")); }
    if (query.managerId) { where.push("u.manager_id=?"); params.push(managerIdentifier(query.managerId)); }
    const whereSql = where.join(" AND ");

    let rows = [];
    let truncated = false;
    if (groupBy.length) {
      // The only value interpolated into the SQL is the integer offset that
      // strictTzOffsetMinutes validated; everything else is a fixed string.
      const modifier = `${tzOffsetMinutes < 0 ? "-" : "+"}${Math.abs(tzOffsetMinutes)} minutes`;
      const keys = groupBy.map((name, index) => {
        const format = USAGE_SUMMARY_TIME_FORMATS[name];
        return format
          ? { name, field: name, time: true, sql: `strftime('${format}', u.at, '${modifier}') AS g${index}` }
          : { name, field: source.dimensions[name].field, time: false, sql: `${source.dimensions[name].column} AS g${index}` };
      });
      const withCustomer = groupBy.includes("customer");
      const ordinals = keys.map((_, index) => index + 1);
      // Time keys run chronologically; within a bucket the busiest groups come
      // first, so truncation drops the smallest groups, never a whole period.
      const orderBy = [
        ...ordinals.filter((_, index) => keys[index].time).map((ordinal) => `${ordinal} ASC`),
        "COUNT(*) DESC",
        ...ordinals.filter((_, index) => !keys[index].time).map((ordinal) => `${ordinal} ASC`),
      ];
      const found = prepare(`
        SELECT ${keys.map((key) => key.sql).join(", ")}${withCustomer ? ", MAX(c.name) AS customer_name" : ""},
               ${source.metrics}
        FROM ${source.table} u
        ${withCustomer ? "LEFT JOIN billing_customers c ON c.customer_id=u.customer_id" : ""}
        WHERE ${whereSql}
        GROUP BY ${ordinals.join(", ")}
        ORDER BY ${orderBy.join(", ")}
        LIMIT ?
      `).all(...params, BigInt(limit + 1));
      truncated = found.length > limit;
      rows = found.slice(0, limit).map((row) => {
        const output = {};
        keys.forEach((key, index) => {
          const value = row[`g${index}`];
          output[key.field] = value === null || value === undefined ? null : String(value);
          if (key.name === "customer") output.customerName = row.customer_name ?? null;
        });
        return { ...output, ...source.shape(row) };
      });
    }
    const totals = prepare(`SELECT ${source.metrics} FROM ${source.table} u WHERE ${whereSql}`).get(...params);
    return {
      ok: true,
      kind,
      groupBy,
      from: range.from,
      to: range.to,
      tzOffsetMinutes,
      rows,
      totals: source.shape(totals),
      truncated,
    };
  }

  // Read-only drill-down for a gateway request id (04 §11.6): the latest usage
  // event whose external_request_id is any of the given ids (request_id and
  // manager_request_id), plus its reservation decision, or null.
  function getUsageByExternalRequestId(input) {
    const ids = [...new Set((Array.isArray(input) ? input : [input])
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean))];
    if (!ids.length) return null;
    if (ids.length > 8 || ids.some((id) => id.length > 128)) {
      throw new BillingStoreError("billing_invalid_input", "externalRequestId must be at most 8 ids of at most 128 characters.");
    }
    const row = prepare(`
      SELECT * FROM billing_usage_events
      WHERE external_request_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY at DESC, usage_id DESC
      LIMIT 1
    `).get(...ids);
    if (!row) return null;
    const reservation = getReservationRow(row.request_id);
    return {
      usage: usageFromRow(row),
      reservation: reservation
        ? {
          enforcementMode: reservation.enforcement_mode,
          decisionCode: reservation.decision_code,
          reservationMicrocredits: decimal(reservation.reservation_microcredits),
        }
        : null,
    };
  }

  function listLedger(query = {}) {
    const { limit, offset } = pagination(query, 200);
    const where = [];
    const params = [];
    if (query.customerId) { where.push("customer_id=?"); params.push(uuid(query.customerId, "customerId")); }
    const sql = `SELECT * FROM billing_wallet_ledger ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ? OFFSET ?`;
    params.push(BigInt(limit), BigInt(offset));
    return prepare(sql).all(...params).map((row) => ledgerFromRow(row, false));
  }

  function listAuditEvents(query = {}) {
    const { limit, offset } = pagination(query, 200);
    const where = [];
    const params = [];
    if (query.customerId) { where.push("customer_id=?"); params.push(uuid(query.customerId, "customerId")); }
    const sql = `SELECT * FROM billing_admin_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ? OFFSET ?`;
    params.push(BigInt(limit), BigInt(offset));
    return prepare(sql).all(...params).map(auditFromRow);
  }

  function getOverview() {
    const overviewDate = nowDate();
    const overviewAt = overviewDate.toISOString();
    const period = monthPeriod(overviewDate, defaultTzOffsetMinutes);
    const customers = prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END), 0) AS active FROM billing_customers").get();
    const credentials = prepare("SELECT COALESCE(SUM(CASE WHEN active=1 THEN 1 ELSE 0 END), 0) AS active FROM billing_credential_bindings").get();
    const lifetimeUsage = prepare(`
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(total_tokens), 0) AS tokens,
             COALESCE(SUM(projected_microcredits), 0) AS projected,
             COALESCE(SUM(charged_microcredits), 0) AS charged
      FROM billing_usage_events
    `).get();
    const periodUsage = prepare(`
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(total_tokens), 0) AS tokens,
             COALESCE(SUM(projected_microcredits), 0) AS cost,
             COALESCE(SUM(charged_microcredits), 0) AS charged
      FROM billing_usage_events WHERE at>=? AND at<?
    `).get(period.start, period.end);
    const ledgerTotal = prepare("SELECT COALESCE(SUM(delta_microcredits), 0) AS total FROM billing_wallet_ledger").get();
    const reservationsTotal = prepare("SELECT COALESCE(SUM(reservation_microcredits), 0) AS total FROM billing_request_reservations WHERE enforcement_mode='hard' AND status='authorized' AND expires_at>?").get(overviewAt);
    const balanceMicrocredits = decimal(BigInt(ledgerTotal?.total || 0));
    const ttsReserved = prepare("SELECT COALESCE(SUM(reserved),0) AS total FROM billing_tts_reservations WHERE mode='hard' AND status='pending'").get();
    const reservedMicrocredits = decimal(BigInt(reservationsTotal?.total || 0) + BigInt(ttsReserved?.total || 0));
    const availableMicrocredits = (BigInt(balanceMicrocredits) - BigInt(reservedMicrocredits)).toString();
    const activeCustomers = Number(customers?.active || 0);
    const activeCredentials = Number(credentials?.active || 0);
    const periodTokens = decimal(BigInt(periodUsage?.tokens || 0));
    const periodCostMicrocredits = decimal(BigInt(periodUsage?.cost || 0));
    return {
      ok: true,
      updatedAt: overviewAt,
      customerCount: Number(customers?.total || 0),
      activeCustomerCount: activeCustomers,
      activeCustomers,
      credentialCount: activeCredentials,
      activeCredentials,
      balanceMicrocredits,
      reservedMicrocredits,
      availableMicrocredits,
      periodTokens,
      periodCostMicrocredits,
      summary: {
        customers: Number(customers?.total || 0),
        activeCustomers,
        activeCredentials,
        balanceMicrocredits,
        availableMicrocredits,
        periodTokens,
        periodCostMicrocredits,
      },
      customers: { total: Number(customers?.total || 0), active: activeCustomers },
      usage: {
        requests: Number(lifetimeUsage?.requests || 0),
        tokens: decimal(BigInt(lifetimeUsage?.tokens || 0)),
        projectedMicrocredits: decimal(BigInt(lifetimeUsage?.projected || 0)),
        chargedMicrocredits: decimal(BigInt(lifetimeUsage?.charged || 0)),
      },
      period: {
        key: period.key,
        start: period.start,
        end: period.end,
        requests: Number(periodUsage?.requests || 0),
        tokens: periodTokens,
        projectedMicrocredits: periodCostMicrocredits,
        chargedMicrocredits: decimal(BigInt(periodUsage?.charged || 0)),
      },
      wallet: {
        balanceMicrocredits,
        reservedMicrocredits,
        availableMicrocredits,
      },
      recentUsage: listUsage({ limit: 20 }),
      tts: getTtsOverview(),
    };
  }

  // --- TTS usage (F3) -------------------------------------------------------

  function authorizeTtsRequest(input = {}) {
    const requestId = uuid(input.requestId, "requestId");
    const managerId = managerIdentifier(input.managerId || "tts");
    const clientId = clientIdentifier(input.clientId);
    const characters = nonNegativeInt64(input.characters ?? 0, "characters");
    const estimatedMs = nonNegativeInt64(input.estimatedMs ?? 1000, "estimatedMs");
    return transaction(() => {
      const existing = prepare("SELECT * FROM billing_tts_reservations WHERE request_id=?").get(requestId);
      if (existing) {
        if (existing.manager_id !== managerId || existing.client_id !== clientId) throw new BillingStoreError("billing_identity_mismatch", "Reservation identity mismatch", 409);
        return { allowed: existing.status !== "denied", requestId, code: existing.code };
      }
      const binding = resolveTtsBinding(managerId, clientId);
      const plan = binding?.plan_id ? getPlanRow(binding.plan_id) : null;
      const mode = binding?.customer_enforcement_mode || binding?.plan_enforcement_mode || defaultEnforcementMode;
      const minuteRate = BigInt(plan?.tts_per_minute_microcredits || 0);
      const charRate = BigInt(plan?.tts_per_thousand_chars_microcredits || 0);
      const reserved = ceilDiv(estimatedMs * minuteRate, 60000n) + ceilDiv(characters * charRate, 1000n);
      const reasons = [];
      if (binding) {
        if (binding.customer_status !== "active") reasons.push("billing_customer_inactive");
        if (plan && Number(plan.active) !== 1) reasons.push("billing_plan_inactive");
        if (!plan && mode === "hard") reasons.push("billing_plan_missing");
        const quota = ttsQuotaForBinding(binding, nowDate());
        const pending = prepare("SELECT COALESCE(SUM(estimated_ms),0) AS total FROM billing_tts_reservations WHERE customer_id=? AND status='pending' AND mode='hard'").get(binding.customer_id);
        if (quota.limitSeconds !== null && quota.usedSeconds * 1000 + Number(pending.total) + Number(estimatedMs) > quota.limitSeconds * 1000) reasons.push("billing_tts_daily_limit");
        if (walletState(binding.customer_id).available < reserved) reasons.push("billing_insufficient_balance");
        if (binding.credit_limit_microcredits !== null) {
          const period = monthPeriod(nowDate(), defaultTzOffsetMinutes);
          const spent = prepare("SELECT COALESCE(SUM(charged_microcredits),0) AS total FROM billing_tts_usage_events WHERE customer_id=? AND at>=? AND at<?").get(binding.customer_id, period.start, period.end);
          const llm = prepare("SELECT COALESCE(SUM(charged_microcredits),0) AS total FROM billing_usage_events WHERE customer_id=? AND at>=? AND at<?").get(binding.customer_id, period.start, period.end);
          if (BigInt(spent.total) + BigInt(llm.total) + walletState(binding.customer_id).reserved + reserved > binding.credit_limit_microcredits) reasons.push("billing_period_credit_limit");
        }
      }
      const allowed = mode !== "hard" || reasons.length === 0;
      const code = reasons[0] || (binding ? "billing_authorized" : "billing_unbound");
      prepare(`INSERT INTO billing_tts_reservations
        (request_id,manager_id,client_id,customer_id,mode,status,code,reserved,estimated_ms,minute_rate,char_rate,created_at,meter)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(requestId, managerId, clientId, binding?.customer_id || null, mode,
          allowed ? "pending" : "denied", code, reserved, estimatedMs, minuteRate, charRate, nowIso(),
          JSON.stringify({ requestId, managerId, clientId, characters: Number(characters), engine: input.engine || "unknown", endpoint: input.endpoint || "/v1/audio/speech" }));
      return { allowed, requestId, code, reservedMicrocredits: reserved.toString(), estimatedMs: Number(estimatedMs) };
    });
  }

  function listPendingTtsRequests() {
    return prepare("SELECT meter,created_at FROM billing_tts_reservations WHERE status='pending' ORDER BY created_at LIMIT 100").all()
      .map((row) => ({ ...JSON.parse(row.meter), createdAt: row.created_at }));
  }

  // Resolves the billing customer behind a service key the same way token
  // billing does: through the (manager, service client) credential binding.
  function resolveTtsBinding(managerId, clientId) {
    const binding = getBindingRow(managerId, clientId);
    if (!binding || Number(binding.active) !== 1) return null;
    return binding;
  }

  function ttsQuotaForBinding(binding, atDate) {
    const period = dayPeriod(atDate, defaultTzOffsetMinutes);
    const usage = prepare(`
      SELECT COUNT(*) AS row_count, COALESCE(SUM(audio_ms), 0) AS audio_ms, COALESCE(SUM(characters), 0) AS characters
      FROM billing_tts_usage_events
      WHERE customer_id=? AND at>=? AND at<? AND ok=1
    `).get(binding.customer_id, period.start, period.end);
    const usedMs = BigInt(usage?.audio_ms || 0);
    const limitSeconds = binding.tts_daily_seconds_limit === null || binding.tts_daily_seconds_limit === undefined
      ? null
      : BigInt(binding.tts_daily_seconds_limit);
    const usedSeconds = Number(usedMs) / 1000;
    const remainingSeconds = limitSeconds === null ? null : Math.max(0, Number(limitSeconds) - usedSeconds);
    return { period, requests: Number(usage?.row_count || 0), characters: Number(usage?.characters || 0), usedSeconds, limitSeconds: limitSeconds === null ? null : Number(limitSeconds), remainingSeconds };
  }

  function getTtsQuotaState(input = {}) {
    const managerId = managerIdentifier(input.managerId || "tts");
    const clientId = clientIdentifier(input.clientId);
    const atDate = nowDate();
    const binding = resolveTtsBinding(managerId, clientId);
    if (!binding) {
      return { bound: false, allowed: true, enforcementMode: defaultEnforcementMode, code: "billing_unbound", customerId: null, limitSeconds: null, usedSeconds: 0, remainingSeconds: null, period: dayPeriod(atDate, defaultTzOffsetMinutes).key };
    }
    const enforcementMode = binding.customer_enforcement_mode || binding.plan_enforcement_mode || defaultEnforcementMode;
    const quota = ttsQuotaForBinding(binding, atDate);
    const exceeded = quota.limitSeconds !== null && quota.usedSeconds >= quota.limitSeconds;
    const inactive = binding.customer_status !== "active";
    const allowed = enforcementMode === "shadow" || (!exceeded && !inactive);
    return {
      bound: true,
      allowed,
      enforcementMode,
      code: inactive ? "billing_customer_inactive" : exceeded ? (enforcementMode === "shadow" ? "billing_tts_daily_limit_shadow" : "billing_tts_daily_limit") : "billing_authorized",
      customerId: binding.customer_id,
      period: quota.period.key,
      requestsToday: quota.requests,
      charactersToday: quota.characters,
      limitSeconds: quota.limitSeconds,
      usedSeconds: quota.usedSeconds,
      remainingSeconds: quota.remainingSeconds,
    };
  }

  function recordTtsUsage(input = {}) {
    const requestId = uuid(input.requestId, "requestId");
    const managerId = managerIdentifier(input.managerId || "tts");
    const clientId = clientIdentifier(input.clientId);
    const engine = identifier(input.engine || "unknown", "engine", 1, 80);
    const endpoint = text(input.endpoint || "/v1/audio/speech", "endpoint", 1, 200);
    const characters = nonNegativeInt64(input.characters ?? 0, "characters");
    const audioMs = nonNegativeInt64(input.audioMs ?? 0, "audioMs");
    const durationSource = ["reported", "measured", "missing"].includes(input.durationSource) ? input.durationSource : (audioMs > 0n ? "measured" : "missing");
    const status = boundedInteger(input.status ?? 200, "status", 0, 599);
    const ok = Boolean(input.ok ?? (status >= 200 && status < 300));
    const externalRequestId = optionalText(input.externalRequestId, "externalRequestId", 128);
    return transaction(() => {
      const existing = prepare("SELECT * FROM billing_tts_usage_events WHERE request_id=?").get(requestId);
      if (existing) return ttsUsageFromRow(existing, true);
      const reservation = prepare("SELECT * FROM billing_tts_reservations WHERE request_id=?").get(requestId);
      if (reservation && (reservation.manager_id !== managerId || reservation.client_id !== clientId || reservation.status === "denied")) {
        throw new BillingStoreError("billing_identity_mismatch", "Invalid TTS reservation", 409);
      }
      const atDate = nowDate();
      const at = atDate.toISOString();
      const binding = resolveTtsBinding(managerId, clientId);
      let enforcementMode = defaultEnforcementMode;
      let code = "billing_unbound_shadow";
      let projected = 0n;
      let charged = 0n;
      let customerId = null;
      if (binding) {
        customerId = binding.customer_id;
        enforcementMode = binding.customer_enforcement_mode || binding.plan_enforcement_mode || defaultEnforcementMode;
        const plan = binding.plan_id ? getPlanRow(binding.plan_id) : null;
        const perMinute = BigInt(plan?.tts_per_minute_microcredits || 0);
        const perThousandChars = BigInt(plan?.tts_per_thousand_chars_microcredits || 0);
        if (ok) {
          projected = ceilDiv(audioMs * perMinute, 60_000n) + ceilDiv(characters * perThousandChars, 1000n);
        }
        const hasPrice = perMinute > 0n || perThousandChars > 0n;
        code = !plan ? "billing_plan_missing" : !hasPrice ? "billing_tts_price_not_configured" : "billing_tts_settled";
        charged = enforcementMode === "hard" && ok ? projected : 0n;
      }
      if (reservation) {
        customerId = reservation.customer_id;
        enforcementMode = reservation.mode;
        projected = ok ? ceilDiv(audioMs * reservation.minute_rate, 60000n) + ceilDiv(characters * reservation.char_rate, 1000n) : 0n;
        charged = enforcementMode === "hard" && customerId ? projected : 0n;
        if (charged > 0n) {
          const wallet = walletState(customerId);
          const available = wallet.available + reservation.reserved;
          if (charged > available) {
            charged = available > 0n ? available : 0n;
            code = "billing_tts_balance_capped";
          }
        }
        prepare("UPDATE billing_tts_reservations SET status='settled' WHERE request_id=?").run(requestId);
      }
      const usageId = uuid(null, "usageId", { generate: true });
      prepare(`
        INSERT INTO billing_tts_usage_events
          (usage_id, at, request_id, external_request_id, customer_id, manager_id, service_client_id, engine, endpoint,
           response_status, ok, characters, audio_ms, duration_source, projected_microcredits, charged_microcredits,
           enforcement_mode, decision_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        usageId, at, requestId, externalRequestId || null, customerId, managerId, clientId, engine, endpoint,
        status, ok ? 1 : 0, characters, audioMs, durationSource, projected, charged, enforcementMode, code,
      );
      if (charged > 0n) {
        prepare(`
          INSERT INTO billing_wallet_ledger
            (entry_id, at, customer_id, entry_type, delta_microcredits, request_id, idempotency_key, reason, actor_id)
          VALUES (?, ?, ?, 'usage_debit', ?, NULL, ?, ?, 'billing')
        `).run(uuid(null, "entryId", { generate: true }), at, customerId, -charged, `tts:${requestId}`, "Settled TTS usage.");
      }
      return ttsUsageFromRow(prepare("SELECT * FROM billing_tts_usage_events WHERE request_id=?").get(requestId), false);
    });
  }

  function listTtsUsage(query = {}) {
    const { limit, offset } = pagination(query, 100);
    const where = [];
    const params = [];
    if (query.customerId) { where.push("customer_id=?"); params.push(uuid(query.customerId, "customerId")); }
    if (query.clientId) { where.push("service_client_id=?"); params.push(clientIdentifier(query.clientId)); }
    const sql = `SELECT * FROM billing_tts_usage_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ? OFFSET ?`;
    params.push(BigInt(limit), BigInt(offset));
    return prepare(sql).all(...params).map((row) => ttsUsageFromRow(row, true));
  }

  function getTtsOverview() {
    const period = monthPeriod(nowDate(), defaultTzOffsetMinutes);
    const lifetime = prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(audio_ms), 0) AS audio_ms, COALESCE(SUM(characters), 0) AS characters, COALESCE(SUM(projected_microcredits), 0) AS projected, COALESCE(SUM(charged_microcredits), 0) AS charged FROM billing_tts_usage_events").get();
    const current = prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(audio_ms), 0) AS audio_ms, COALESCE(SUM(characters), 0) AS characters, COALESCE(SUM(projected_microcredits), 0) AS projected, COALESCE(SUM(charged_microcredits), 0) AS charged FROM billing_tts_usage_events WHERE at>=? AND at<?").get(period.start, period.end);
    const shape = (row) => ({
      requests: Number(row?.requests || 0),
      audioSeconds: Number(BigInt(row?.audio_ms || 0)) / 1000,
      characters: Number(BigInt(row?.characters || 0)),
      projectedMicrocredits: decimal(BigInt(row?.projected || 0)),
      chargedMicrocredits: decimal(BigInt(row?.charged || 0)),
    });
    return { lifetime: shape(lifetime), period: { key: period.key, ...shape(current) } };
  }

  function writeAdminAudit(input = {}) {
    return transaction(() => {
      const auditId = insertAudit(input);
      return auditFromRow(prepare("SELECT * FROM billing_admin_audit WHERE audit_id=?").get(auditId));
    });
  }

  function getPragmas() {
    return {
      journalMode: String(prepare("PRAGMA journal_mode").get()?.journal_mode || ""),
      foreignKeys: Number(prepare("PRAGMA foreign_keys").get()?.foreign_keys || 0),
      busyTimeoutMs: Number(prepare("PRAGMA busy_timeout").get()?.timeout || 0),
      synchronous: Number(prepare("PRAGMA synchronous").get()?.synchronous || 0),
    };
  }

  function close() {
    if (closed) return;
    db.close();
    closed = true;
  }

  return {
    file,
    authorizeRequest,
    settleRequest,
    createPlan,
    updatePlan,
    getPlan,
    listPlans,
    createCustomer,
    updateCustomer,
    updateCustomerPolicy,
    getCustomer,
    getCustomerSummary,
    listCustomers,
    bindCredential,
    listCredentialBindings,
    adjustBalance,
    upsertPrice,
    applyPriceTemplates,
    listPrices,
    resolveModelPrice,
    getRequest,
    listUsage,
    summarizeUsage,
    getUsageByExternalRequestId,
    lookupCustomerForCredential,
    listLedger,
    listAuditEvents,
    writeAdminAudit,
    getOverview,
    getTtsQuotaState,
    authorizeTtsRequest,
    listPendingTtsRequests,
    recordTtsUsage,
    listTtsUsage,
    getTtsOverview,
    getDashboard: getOverview,
    getPragmas,
    close,
  };
}

function configureDatabase(db, busyTimeoutMs) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${busyTimeoutMs};
    PRAGMA synchronous = FULL;
  `);
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_tts_reservations (
      request_id TEXT PRIMARY KEY, manager_id TEXT NOT NULL, client_id TEXT NOT NULL,
      customer_id TEXT, mode TEXT NOT NULL, status TEXT NOT NULL, code TEXT NOT NULL,
      reserved INTEGER NOT NULL, estimated_ms INTEGER NOT NULL, minute_rate INTEGER NOT NULL,
      char_rate INTEGER NOT NULL, created_at TEXT NOT NULL, meter TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS billing_tts_pending_idx ON billing_tts_reservations(status,created_at);
    CREATE INDEX IF NOT EXISTS billing_tts_customer_idx ON billing_tts_reservations(customer_id,status);
    CREATE TABLE IF NOT EXISTS billing_plans (
      plan_id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      monthly_price_microcredits INTEGER NOT NULL CHECK(monthly_price_microcredits >= 0),
      included_microcredits INTEGER CHECK(included_microcredits IS NULL OR included_microcredits >= 0),
      monthly_token_limit INTEGER CHECK(monthly_token_limit IS NULL OR monthly_token_limit >= 0),
      monthly_request_limit INTEGER CHECK(monthly_request_limit IS NULL OR monthly_request_limit >= 0),
      enforcement_mode TEXT NOT NULL CHECK(enforcement_mode IN ('shadow','hard')),
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_customers (
      customer_id TEXT PRIMARY KEY,
      external_ref TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','suspended','closed')),
      plan_id TEXT REFERENCES billing_plans(plan_id) ON DELETE RESTRICT,
      enforcement_mode TEXT CHECK(enforcement_mode IS NULL OR enforcement_mode IN ('shadow','hard')),
      credit_limit_microcredits INTEGER CHECK(credit_limit_microcredits IS NULL OR credit_limit_microcredits >= 0),
      monthly_token_limit INTEGER CHECK(monthly_token_limit IS NULL OR monthly_token_limit >= 0),
      monthly_request_limit INTEGER CHECK(monthly_request_limit IS NULL OR monthly_request_limit >= 0),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_credential_bindings (
      binding_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES billing_customers(customer_id) ON DELETE RESTRICT,
      manager_id TEXT NOT NULL,
      service_client_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(manager_id, service_client_id)
    );
    CREATE TABLE IF NOT EXISTS billing_model_prices (
      price_id TEXT PRIMARY KEY,
      plan_id TEXT REFERENCES billing_plans(plan_id) ON DELETE RESTRICT,
      manager_id TEXT NOT NULL,
      model_pattern TEXT NOT NULL,
      input_per_million_microcredits INTEGER NOT NULL CHECK(input_per_million_microcredits >= 0),
      output_per_million_microcredits INTEGER NOT NULL CHECK(output_per_million_microcredits >= 0),
      cached_input_per_million_microcredits INTEGER NOT NULL CHECK(cached_input_per_million_microcredits >= 0),
      fixed_request_microcredits INTEGER NOT NULL CHECK(fixed_request_microcredits >= 0),
      source_template_id TEXT,
      source_catalog_version TEXT,
      source_snapshot_date TEXT,
      source_url TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      created_at TEXT NOT NULL,
      CHECK(effective_to IS NULL OR effective_to >= effective_from)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_active_price_scope
      ON billing_model_prices(COALESCE(plan_id,''), manager_id, model_pattern) WHERE effective_to IS NULL;
    CREATE INDEX IF NOT EXISTS idx_billing_price_lookup
      ON billing_model_prices(plan_id, manager_id, model_pattern, effective_from, effective_to);
    CREATE TABLE IF NOT EXISTS billing_request_reservations (
      request_id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL UNIQUE,
      external_request_id TEXT,
      manager_id TEXT NOT NULL,
      service_client_id TEXT NOT NULL,
      customer_id TEXT REFERENCES billing_customers(customer_id) ON DELETE RESTRICT,
      binding_id TEXT REFERENCES billing_credential_bindings(binding_id) ON DELETE RESTRICT,
      plan_id TEXT REFERENCES billing_plans(plan_id) ON DELETE RESTRICT,
      price_id TEXT REFERENCES billing_model_prices(price_id) ON DELETE RESTRICT,
      model TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      stream INTEGER NOT NULL CHECK(stream IN (0,1)),
      enforcement_mode TEXT NOT NULL CHECK(enforcement_mode IN ('shadow','hard')),
      allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
      decision_code TEXT NOT NULL,
      decision_message TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('authorized','denied','settled','released')),
      estimated_input_tokens INTEGER NOT NULL CHECK(estimated_input_tokens >= 0),
      max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens >= 0),
      cached_input_tokens INTEGER NOT NULL CHECK(cached_input_tokens >= 0),
      reservation_microcredits INTEGER NOT NULL CHECK(reservation_microcredits >= 0),
      price_input_per_million INTEGER NOT NULL CHECK(price_input_per_million >= 0),
      price_output_per_million INTEGER NOT NULL CHECK(price_output_per_million >= 0),
      price_cached_input_per_million INTEGER NOT NULL CHECK(price_cached_input_per_million >= 0),
      price_fixed_request INTEGER NOT NULL CHECK(price_fixed_request >= 0),
      period_key TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      authorized_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_billing_reservation_customer_status
      ON billing_request_reservations(customer_id, status, period_key);
    CREATE TABLE IF NOT EXISTS billing_usage_events (
      usage_id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE REFERENCES billing_request_reservations(request_id) ON DELETE RESTRICT,
      external_request_id TEXT,
      customer_id TEXT REFERENCES billing_customers(customer_id) ON DELETE RESTRICT,
      manager_id TEXT NOT NULL,
      service_client_id TEXT NOT NULL,
      model TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      stream INTEGER NOT NULL CHECK(stream IN (0,1)),
      response_status INTEGER NOT NULL CHECK(response_status >= 0 AND response_status <= 599),
      ok INTEGER NOT NULL CHECK(ok IN (0,1)),
      terminal_state TEXT NOT NULL CHECK(terminal_state IN ('completed','failed','cancelled','timeout','disconnected','ambiguous')),
      usage_source TEXT NOT NULL CHECK(usage_source IN ('reported','estimated','missing')),
      input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
      total_tokens INTEGER NOT NULL CHECK(total_tokens >= 0),
      cached_input_tokens INTEGER NOT NULL CHECK(cached_input_tokens >= 0),
      projected_microcredits INTEGER NOT NULL CHECK(projected_microcredits >= 0),
      charged_microcredits INTEGER NOT NULL CHECK(charged_microcredits >= 0),
      enforcement_mode TEXT NOT NULL CHECK(enforcement_mode IN ('shadow','hard')),
      decision_code TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_usage_customer_at ON billing_usage_events(customer_id, at);
    -- Usage summary and request drill-down (04 §15). The immutability triggers
    -- block only UPDATE and DELETE, so adding an index is allowed.
    CREATE INDEX IF NOT EXISTS idx_billing_usage_at ON billing_usage_events(at);
    CREATE INDEX IF NOT EXISTS idx_billing_usage_external ON billing_usage_events(external_request_id);
    CREATE TABLE IF NOT EXISTS billing_wallet_ledger (
      entry_id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      customer_id TEXT NOT NULL REFERENCES billing_customers(customer_id) ON DELETE RESTRICT,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('adjustment','usage_debit','refund')),
      delta_microcredits INTEGER NOT NULL CHECK(delta_microcredits != 0),
      request_id TEXT UNIQUE REFERENCES billing_request_reservations(request_id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      actor_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_ledger_customer_at ON billing_wallet_ledger(customer_id, at);
    CREATE TABLE IF NOT EXISTS billing_admin_audit (
      audit_id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      customer_id TEXT REFERENCES billing_customers(customer_id) ON DELETE RESTRICT,
      details_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_audit_customer_at ON billing_admin_audit(customer_id, at);
    CREATE TRIGGER IF NOT EXISTS billing_wallet_ledger_no_update
      BEFORE UPDATE ON billing_wallet_ledger BEGIN SELECT RAISE(ABORT, 'billing wallet ledger is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS billing_wallet_ledger_no_delete
      BEFORE DELETE ON billing_wallet_ledger BEGIN SELECT RAISE(ABORT, 'billing wallet ledger is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS billing_usage_events_no_update
      BEFORE UPDATE ON billing_usage_events BEGIN SELECT RAISE(ABORT, 'billing usage events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS billing_usage_events_no_delete
      BEFORE DELETE ON billing_usage_events BEGIN SELECT RAISE(ABORT, 'billing usage events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS billing_admin_audit_no_update
      BEFORE UPDATE ON billing_admin_audit BEGIN SELECT RAISE(ABORT, 'billing admin audit is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS billing_admin_audit_no_delete
      BEFORE DELETE ON billing_admin_audit BEGIN SELECT RAISE(ABORT, 'billing admin audit is immutable'); END;
  `);
  ensureColumn(db, "billing_customers", "external_ref", "TEXT");
  ensureColumn(db, "billing_customers", "monthly_token_limit", "INTEGER CHECK(monthly_token_limit IS NULL OR monthly_token_limit >= 0)");
  ensureColumn(db, "billing_customers", "monthly_request_limit", "INTEGER CHECK(monthly_request_limit IS NULL OR monthly_request_limit >= 0)");
  ensureColumn(db, "billing_model_prices", "source_template_id", "TEXT");
  ensureColumn(db, "billing_model_prices", "source_catalog_version", "TEXT");
  ensureColumn(db, "billing_model_prices", "source_snapshot_date", "TEXT");
  ensureColumn(db, "billing_model_prices", "source_url", "TEXT");
  // TTS billing (F3): per-plan audio pricing, per-customer daily quota, and an
  // immutable usage table separate from token usage.
  ensureColumn(db, "billing_plans", "tts_per_minute_microcredits", "INTEGER NOT NULL DEFAULT 0 CHECK(tts_per_minute_microcredits >= 0)");
  ensureColumn(db, "billing_plans", "tts_per_thousand_chars_microcredits", "INTEGER NOT NULL DEFAULT 0 CHECK(tts_per_thousand_chars_microcredits >= 0)");
  ensureColumn(db, "billing_customers", "tts_daily_seconds_limit", "INTEGER CHECK(tts_daily_seconds_limit IS NULL OR tts_daily_seconds_limit >= 0)");
  // Billing principal (05 §6.4): the scope the credential binding was found
  // under. NULL on older reservations, which read as their manager_id.
  ensureColumn(db, "billing_request_reservations", "credential_manager_id", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_customer_external_ref
      ON billing_customers(external_ref) WHERE external_ref IS NOT NULL;
    CREATE TABLE IF NOT EXISTS billing_tts_usage_events (
      usage_id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      external_request_id TEXT,
      customer_id TEXT REFERENCES billing_customers(customer_id) ON DELETE RESTRICT,
      manager_id TEXT NOT NULL,
      service_client_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      response_status INTEGER NOT NULL CHECK(response_status >= 0 AND response_status <= 599),
      ok INTEGER NOT NULL CHECK(ok IN (0,1)),
      characters INTEGER NOT NULL CHECK(characters >= 0),
      audio_ms INTEGER NOT NULL CHECK(audio_ms >= 0),
      duration_source TEXT NOT NULL CHECK(duration_source IN ('reported','measured','missing')),
      projected_microcredits INTEGER NOT NULL CHECK(projected_microcredits >= 0),
      charged_microcredits INTEGER NOT NULL CHECK(charged_microcredits >= 0),
      enforcement_mode TEXT NOT NULL CHECK(enforcement_mode IN ('shadow','hard')),
      decision_code TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_tts_usage_customer_at ON billing_tts_usage_events(customer_id, at);
    CREATE INDEX IF NOT EXISTS idx_billing_tts_usage_client_at ON billing_tts_usage_events(manager_id, service_client_id, at);
    CREATE INDEX IF NOT EXISTS idx_billing_tts_usage_at ON billing_tts_usage_events(at);
    CREATE TRIGGER IF NOT EXISTS billing_tts_usage_events_no_update
      BEFORE UPDATE ON billing_tts_usage_events BEGIN SELECT RAISE(ABORT, 'billing tts usage events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS billing_tts_usage_events_no_delete
      BEFORE DELETE ON billing_tts_usage_events BEGIN SELECT RAISE(ABORT, 'billing tts usage events are immutable'); END;
  `);
}

function dayPeriod(date, tzOffsetMinutes = 0) {
  const offsetMs = clampTzOffsetMinutes(tzOffsetMinutes) * 60 * 1000;
  const shifted = new Date(date.getTime() + offsetMs);
  const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    key: `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function ttsUsageFromRow(row, replayed = false) {
  return {
    ok: true,
    replayed,
    usageId: row.usage_id,
    at: row.at,
    requestId: row.request_id,
    externalRequestId: row.external_request_id || null,
    customerId: row.customer_id || null,
    managerId: row.manager_id,
    clientId: row.service_client_id,
    engine: row.engine,
    endpoint: row.endpoint,
    status: Number(row.response_status),
    success: Number(row.ok) === 1,
    characters: Number(row.characters),
    audioMs: Number(row.audio_ms),
    audioSeconds: Number(row.audio_ms) / 1000,
    durationSource: row.duration_source,
    projectedMicrocredits: decimal(row.projected_microcredits),
    chargedMicrocredits: decimal(row.charged_microcredits),
    enforcementMode: row.enforcement_mode,
    code: row.decision_code,
  };
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  // Table, column and definition are compile-time constants from ensureSchema.
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function normalizeAuthorizeInput(input, uuid) {
  rejectUnknownKeys(input, [
    "requestId", "externalRequestId", "managerId", "credentialManagerId", "clientId", "serviceClientId", "model",
    "endpoint", "stream", "estimatedInputTokens", "maxOutputTokens", "cachedInputTokens",
  ], "authorization request");
  const estimatedInputTokens = nonNegativeInt64(input.estimatedInputTokens ?? 0, "estimatedInputTokens");
  const maxOutputTokens = nonNegativeInt64(input.maxOutputTokens ?? 0, "maxOutputTokens");
  const cachedInputTokens = nonNegativeInt64(input.cachedInputTokens ?? 0, "cachedInputTokens");
  if (cachedInputTokens > estimatedInputTokens) throw new BillingStoreError("billing_invalid_tokens", "cachedInputTokens cannot exceed estimatedInputTokens.");
  const managerId = managerIdentifier(input.managerId);
  return {
    requestId: uuid(input.requestId, "requestId"),
    externalRequestId: optionalText(input.externalRequestId, "externalRequestId", 128),
    managerId,
    credentialManagerId: credentialManagerIdentifier(input.credentialManagerId, managerId),
    clientId: clientIdentifier(input.clientId ?? input.serviceClientId),
    model: text(input.model, "model", 1, 256),
    endpoint: text(input.endpoint, "endpoint", 1, 256),
    stream: strictBoolean(input.stream, false, "stream"),
    estimatedInputTokens,
    maxOutputTokens,
    cachedInputTokens,
  };
}

function normalizeSettlementInput(input, uuid) {
  rejectUnknownKeys(input, [
    "requestId", "externalRequestId", "managerId", "credentialManagerId", "clientId", "serviceClientId", "model",
    "status", "ok", "terminalState", "usageSource", "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens",
  ], "settlement request");
  const inputTokens = nonNegativeInt64(input.inputTokens ?? 0, "inputTokens");
  const outputTokens = nonNegativeInt64(input.outputTokens ?? 0, "outputTokens");
  const totalTokens = nonNegativeInt64(input.totalTokens ?? inputTokens + outputTokens, "totalTokens");
  const cachedInputTokens = nonNegativeInt64(input.cachedInputTokens ?? 0, "cachedInputTokens");
  if (cachedInputTokens > inputTokens) throw new BillingStoreError("billing_invalid_tokens", "cachedInputTokens cannot exceed inputTokens.");
  if (totalTokens !== inputTokens + outputTokens) throw new BillingStoreError("billing_invalid_tokens", "totalTokens must equal inputTokens plus outputTokens.");
  const usageSource = String(input.usageSource || "missing").trim().toLowerCase();
  if (!USAGE_SOURCES.has(usageSource)) throw new BillingStoreError("billing_invalid_usage_source", "usageSource is invalid.");
  const rawTerminalState = String(input.terminalState || (input.ok ? "completed" : "failed")).trim().toLowerCase();
  const terminalState = TERMINAL_STATE_ALIASES.get(rawTerminalState) || rawTerminalState;
  if (!TERMINAL_STATES.has(terminalState)) throw new BillingStoreError("billing_invalid_terminal_state", "terminalState is invalid.");
  const managerId = managerIdentifier(input.managerId);
  return {
    requestId: uuid(input.requestId, "requestId"),
    externalRequestId: optionalText(input.externalRequestId, "externalRequestId", 128),
    managerId,
    credentialManagerId: credentialManagerIdentifier(input.credentialManagerId, managerId),
    clientId: clientIdentifier(input.clientId ?? input.serviceClientId),
    model: text(input.model, "model", 1, 256),
    status: boundedInteger(input.status ?? 0, "status", 0, 599),
    ok: strictBoolean(input.ok, false, "ok"),
    terminalState,
    usageSource,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
  };
}

function calculateMicrocredits(tokens, price) {
  const input = BigInt(tokens.inputTokens ?? tokens.estimatedInputTokens ?? 0);
  const output = BigInt(tokens.outputTokens ?? tokens.maxOutputTokens ?? 0);
  const cached = BigInt(tokens.cachedInputTokens ?? 0);
  const uncached = input - cached;
  const numerator = uncached * BigInt(price.input_per_million_microcredits || 0)
    + cached * BigInt(price.cached_input_per_million_microcredits || 0)
    + output * BigInt(price.output_per_million_microcredits || 0);
  return ceilDiv(numerator, MICROCREDS_PER_MILLION_TOKENS) + BigInt(price.fixed_request_microcredits || 0);
}

function ceilDiv(value, divisor) {
  if (value <= 0n) return 0n;
  return (value + divisor - 1n) / divisor;
}

// COALESCE(credential_manager_id, manager_id): reservations written before the
// column existed were always bound under their serving manager.
function reservationCredentialManagerId(row) {
  return row.credential_manager_id || row.manager_id;
}

function assertReservationIdentity(row, input) {
  if (row.manager_id !== input.managerId || row.service_client_id !== input.clientId || row.model !== input.model
    || reservationCredentialManagerId(row) !== input.credentialManagerId) {
    throw new BillingStoreError("billing_idempotency_conflict", "requestId was already used for a different billing request.", 409);
  }
  if (input.externalRequestId && row.external_request_id && input.externalRequestId !== row.external_request_id) {
    throw new BillingStoreError("billing_idempotency_conflict", "requestId has a different externalRequestId.", 409);
  }
}

// The immutable usage row has no credential column, so a replayed settlement
// checks the credential scope against the reservation it settled.
function assertUsageIdentity(row, input, reservation) {
  if (row.manager_id !== input.managerId || row.service_client_id !== input.clientId || row.model !== input.model
    || (reservation && reservationCredentialManagerId(reservation) !== input.credentialManagerId)) {
    throw new BillingStoreError("billing_idempotency_conflict", "requestId was already settled for a different billing request.", 409);
  }
}

function authorizationFromRow(row, replayed) {
  return {
    ok: true,
    allowed: Number(row.allowed) === 1,
    bound: Boolean(row.customer_id),
    enforcementMode: row.enforcement_mode,
    customerId: row.customer_id || null,
    requestId: row.request_id,
    externalRequestId: row.external_request_id || null,
    reservationMicrocredits: decimal(row.reservation_microcredits),
    code: row.decision_code,
    message: row.decision_message,
    replayed: Boolean(replayed),
  };
}

function settlementFromRow(row, replayed) {
  return {
    ok: true,
    settled: true,
    replayed: Boolean(replayed),
    requestId: row.request_id,
    externalRequestId: row.external_request_id || null,
    customerId: row.customer_id || null,
    managerId: row.manager_id,
    clientId: row.service_client_id,
    model: row.model,
    status: Number(row.response_status),
    terminalState: row.terminal_state,
    usageSource: row.usage_source,
    inputTokens: decimal(row.input_tokens),
    outputTokens: decimal(row.output_tokens),
    totalTokens: decimal(row.total_tokens),
    cachedInputTokens: decimal(row.cached_input_tokens),
    enforcementMode: row.enforcement_mode,
    projectedMicrocredits: decimal(row.projected_microcredits),
    chargedMicrocredits: decimal(row.charged_microcredits),
    code: row.usage_source === "missing"
      ? "billing_usage_missing"
      : Number(row.ok) === 1
        ? "billing_settled"
        : BigInt(row.projected_microcredits || 0) > 0n
          ? "billing_partial_usage_settled"
          : "billing_released",
  };
}

function planFromRow(row) {
  return {
    planId: row.plan_id,
    code: row.code,
    name: row.name,
    currency: row.currency,
    monthlyPriceMicrocredits: decimal(row.monthly_price_microcredits),
    includedMicrocredits: decimal(row.included_microcredits),
    periodCreditLimitMicrocredits: decimal(row.included_microcredits),
    monthlyTokenLimit: decimal(row.monthly_token_limit),
    periodTokenLimit: decimal(row.monthly_token_limit),
    monthlyRequestLimit: decimal(row.monthly_request_limit),
    periodRequestLimit: decimal(row.monthly_request_limit),
    enforcementMode: row.enforcement_mode,
    active: Number(row.active) === 1,
    ttsPerMinuteMicrocredits: decimal(row.tts_per_minute_microcredits ?? 0),
    ttsPerThousandCharsMicrocredits: decimal(row.tts_per_thousand_chars_microcredits ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicPlanFields(value) {
  return {
    code: value.code,
    name: value.name,
    currency: value.currency,
    monthlyPriceMicrocredits: decimal(value.monthlyPrice),
    includedMicrocredits: decimal(value.included),
    monthlyTokenLimit: decimal(value.tokenLimit),
    monthlyRequestLimit: decimal(value.requestLimit),
    enforcementMode: value.enforcementMode,
    active: Boolean(Number(value.active)),
  };
}

function customerFromRow(row, wallet) {
  return {
    customerId: row.customer_id,
    externalRef: row.external_ref || "",
    name: row.name,
    status: row.status,
    planId: row.plan_id || null,
    enforcementMode: row.enforcement_mode || null,
    creditLimitMicrocredits: decimal(row.credit_limit_microcredits),
    monthlyTokenLimit: decimal(row.monthly_token_limit),
    monthlyRequestLimit: decimal(row.monthly_request_limit),
    ttsDailySecondsLimit: decimal(row.tts_daily_seconds_limit),
    notes: row.notes,
    balanceMicrocredits: decimal(wallet.balance),
    reservedMicrocredits: decimal(wallet.reserved),
    availableMicrocredits: decimal(wallet.available),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function credentialBindingFromRow(row) {
  return {
    bindingId: row.binding_id,
    customerId: row.customer_id,
    managerId: row.manager_id,
    serviceClientId: row.service_client_id,
    clientId: row.service_client_id,
    label: row.label,
    active: Number(row.active) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function priceFromRow(row, replayed = false) {
  return {
    priceId: row.price_id,
    planId: row.plan_id || null,
    managerId: row.manager_id,
    model: row.model_pattern,
    modelPattern: row.model_pattern,
    inputPerMillionMicrocredits: decimal(row.input_per_million_microcredits),
    inputMicrocreditsPerMillion: decimal(row.input_per_million_microcredits),
    outputPerMillionMicrocredits: decimal(row.output_per_million_microcredits),
    outputMicrocreditsPerMillion: decimal(row.output_per_million_microcredits),
    cachedInputPerMillionMicrocredits: decimal(row.cached_input_per_million_microcredits),
    fixedRequestMicrocredits: decimal(row.fixed_request_microcredits),
    sourceTemplateId: row.source_template_id || null,
    templateId: row.source_template_id || null,
    sourceCatalogVersion: row.source_catalog_version || null,
    sourceSnapshotDate: row.source_snapshot_date || null,
    snapshotDate: row.source_snapshot_date || null,
    sourceUrl: row.source_url || null,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to || null,
    active: !row.effective_to,
    replayed: Boolean(replayed),
  };
}

function usageFromRow(row) {
  return {
    usageId: row.usage_id,
    at: row.at,
    requestId: row.request_id,
    externalRequestId: row.external_request_id || null,
    customerId: row.customer_id || null,
    managerId: row.manager_id,
    serviceClientId: row.service_client_id,
    clientId: row.service_client_id,
    model: row.model,
    endpoint: row.endpoint,
    stream: Number(row.stream) === 1,
    status: Number(row.response_status),
    ok: Number(row.ok) === 1,
    terminalState: row.terminal_state,
    usageSource: row.usage_source,
    inputTokens: decimal(row.input_tokens),
    outputTokens: decimal(row.output_tokens),
    totalTokens: decimal(row.total_tokens),
    cachedInputTokens: decimal(row.cached_input_tokens),
    projectedMicrocredits: decimal(row.projected_microcredits),
    chargedMicrocredits: decimal(row.charged_microcredits),
    enforcementMode: row.enforcement_mode,
    decisionCode: row.decision_code,
  };
}

function ledgerFromRow(row, replayed) {
  return {
    entryId: row.entry_id,
    at: row.at,
    customerId: row.customer_id,
    entryType: row.entry_type,
    deltaMicrocredits: decimal(row.delta_microcredits),
    requestId: row.request_id || null,
    idempotencyKey: row.idempotency_key,
    reason: row.reason,
    actorId: row.actor_id,
    replayed: Boolean(replayed),
  };
}

function auditFromRow(row) {
  return {
    auditId: row.audit_id,
    at: row.at,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    customerId: row.customer_id || null,
    details: parseJsonObject(row.details_json),
  };
}

function normalizeDatabaseFile(value) {
  const textValue = String(value || "").trim();
  if (!textValue) throw new BillingStoreError("billing_database_file_required", "Billing database file is required.");
  return textValue === ":memory:" ? textValue : path.resolve(textValue);
}

function text(value, name, min, max) {
  if (typeof value !== "string") throw new BillingStoreError("billing_invalid_input", `${name} must be a string.`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new BillingStoreError("billing_invalid_input", `${name} has an invalid length or characters.`);
  }
  return normalized;
}

function optionalText(value, name, max) {
  if (value === undefined || value === null || value === "") return "";
  return text(value, name, 1, max);
}

function nullableText(value, name, max) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, name, 1, max);
}

function identifier(value, name, min = 1, max = 128) {
  const normalized = text(value, name, min, max);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)) throw new BillingStoreError("billing_invalid_input", `${name} contains invalid characters.`);
  return normalized;
}

function managerIdentifier(value) {
  return identifier(value, "managerId", 1, 64).toLowerCase();
}

// The billing scope a credential is bound under (05 §6.4): "platform" for
// platform keys, a manager billing id for migrated ones. It defaults to the
// serving manager, which is the only scope requests carried before.
function credentialManagerIdentifier(value, managerId) {
  if (isBlank(value)) return managerId;
  return identifier(value, "credentialManagerId", 1, 64).toLowerCase();
}

function clientIdentifier(value) {
  return identifier(value, "clientId", 1, 128);
}

function normalizePriceScope(value, name) {
  if (value === "*") return "*";
  return name === "managerId" ? managerIdentifier(value) : text(value, name, 1, 256);
}

function planCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) throw new BillingStoreError("billing_invalid_plan_code", "Plan code is invalid.");
  return normalized;
}

function currencyCode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(normalized)) throw new BillingStoreError("billing_invalid_currency", "Currency code is invalid.");
  return normalized;
}

function normalizeEnforcementMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!ENFORCEMENT_MODES.has(normalized)) throw new BillingStoreError("billing_invalid_enforcement_mode", "enforcementMode must be shadow or hard.");
  return normalized;
}

function normalizeCustomerStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!CUSTOMER_STATUSES.has(normalized)) throw new BillingStoreError("billing_invalid_customer_status", "Customer status is invalid.");
  return normalized;
}

function signedInt64(value, name) {
  const parsed = integerBigInt(value, name);
  if (parsed < -MAX_INT64 - 1n || parsed > MAX_INT64) throw new BillingStoreError("billing_integer_out_of_range", `${name} is outside SQLite INTEGER range.`);
  return parsed;
}

function nonNegativeInt64(value, name) {
  const parsed = signedInt64(value, name);
  if (parsed < 0n) throw new BillingStoreError("billing_negative_integer", `${name} must be non-negative.`);
  return parsed;
}

function optionalNonNegativeInt64(value, name) {
  if (value === undefined || value === null || value === "") return null;
  return nonNegativeInt64(value, name);
}

function optionalQuotaInt64(value, name) {
  const parsed = optionalNonNegativeInt64(value, name);
  return parsed === 0n ? null : parsed;
}

function integerBigInt(value, name) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new BillingStoreError("billing_invalid_integer", `${name} must be a safe integer or decimal string.`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new BillingStoreError("billing_invalid_integer", `${name} must be an integer.`);
}

function boundedInteger(value, name, min, max) {
  if (typeof value === "bigint") {
    if (value < BigInt(min) || value > BigInt(max)) throw new BillingStoreError("billing_invalid_integer", `${name} is out of range.`);
    return Number(value);
  }
  const number = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new BillingStoreError("billing_invalid_integer", `${name} is out of range.`);
  return number;
}

function strictBoolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new BillingStoreError("billing_invalid_boolean", `${name} must be a boolean.`);
  return value;
}

function booleanInteger(value, fallback, name) {
  return strictBoolean(value, fallback, name) ? 1 : 0;
}

function pagination(query = {}, defaultLimit = 100) {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new BillingStoreError("billing_invalid_input", "List options must be an object.");
  return {
    limit: boundedInteger(query.limit ?? defaultLimit, "limit", 1, 1000),
    offset: boundedInteger(query.offset ?? 0, "offset", 0, 10_000_000),
  };
}

function rejectUnknownKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BillingStoreError("billing_invalid_input", `${label} must be an object.`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new BillingStoreError("billing_unknown_field", `${label} contains an unknown field.`);
}

function safeAuditDetails(value, depth = 0) {
  if (depth > 5) throw new BillingStoreError("billing_audit_details_too_deep", "Audit details are too deeply nested.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return text(value, "audit detail", 0, 1000);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new BillingStoreError("billing_invalid_audit_details", "Audit numbers must be safe integers.");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (value.length > 50) throw new BillingStoreError("billing_invalid_audit_details", "Audit arrays are too large.");
    return value.map((item) => safeAuditDetails(item, depth + 1));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new BillingStoreError("billing_invalid_audit_details", "Audit details must be plain JSON data.");
  }
  const entries = Object.entries(value);
  if (entries.length > 50) throw new BillingStoreError("billing_invalid_audit_details", "Audit objects are too large.");
  const output = {};
  for (const [key, item] of entries) {
    if (isSensitiveAuditKey(key)) throw new BillingStoreError("billing_sensitive_audit_field", "Sensitive fields are not allowed in audit details.");
    output[text(key, "audit detail key", 1, 80)] = safeAuditDetails(item, depth + 1);
  }
  return output;
}

function isSensitiveAuditKey(value) {
  const key = String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!key) return false;
  if (/^(?:authorization|cookie|password|passwd|secret|privatekey|bearer)/.test(key)) return true;
  if (/^(?:apikey|accesstoken|refreshtoken|idtoken|authtoken)(?:$|value|secret|hash|header|digest|encrypted)/.test(key)) return true;
  if (/^token(?:$|value|secret|hash|header|digest|encrypted)/.test(key)) return true;
  return /^credential(?:value|secret|hash|encrypted)/.test(key);
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function decimal(value) {
  return value === null || value === undefined ? null : BigInt(value).toString();
}

function sumBigInts(values) {
  return values.reduce((sum, value) => sum + BigInt(value || 0), 0n);
}

function minimumNullable(...values) {
  const present = values.filter((value) => value !== null && value !== undefined).map(BigInt);
  return present.length ? present.reduce((min, value) => value < min ? value : min) : null;
}

function modelGlobMatches(pattern, model) {
  const value = String(model || "");
  const source = String(pattern || "");
  if (!source) return false;
  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let retryValueIndex = 0;
  while (valueIndex < value.length) {
    if (patternIndex < source.length && (source[patternIndex] === "?" || source[patternIndex] === value[valueIndex])) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (patternIndex < source.length && source[patternIndex] === "*") {
      starIndex = patternIndex;
      retryValueIndex = valueIndex;
      patternIndex += 1;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      retryValueIndex += 1;
      valueIndex = retryValueIndex;
    } else {
      return false;
    }
  }
  while (source[patternIndex] === "*") patternIndex += 1;
  return patternIndex === source.length;
}

function comparePriceSpecificity(left, right, planId, managerId, model) {
  const leftRank = priceSpecificity(left, planId, managerId, model);
  const rightRank = priceSpecificity(right, planId, managerId, model);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
  }
  return String(right.effective_from).localeCompare(String(left.effective_from));
}

function priceSpecificity(price, planId, managerId, model) {
  const pattern = String(price.model_pattern || "");
  const exact = pattern === model;
  const catchAll = pattern === "*";
  const literalLength = pattern.replace(/[?*]/g, "").length;
  const wildcardCount = (pattern.match(/[?*]/g) || []).length;
  return [
    price.plan_id === planId ? 1 : 0,
    price.manager_id === managerId ? 1 : 0,
    exact ? 2 : catchAll ? 0 : 1,
    literalLength,
    -wildcardCount,
  ];
}

function clampTzOffsetMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(n)));
}

function monthPeriod(date, tzOffsetMinutes = 0) {
  const offsetMs = clampTzOffsetMinutes(tzOffsetMinutes) * 60 * 1000;
  const shifted = new Date(date.getTime() + offsetMs);
  const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - offsetMs);
  const end = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - offsetMs);
  return {
    key: `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`,
    start: start.toISOString(),
    end: end.toISOString(),
    tzOffsetMinutes: clampTzOffsetMinutes(tzOffsetMinutes),
  };
}

function utcMonthPeriod(date, tzOffsetMinutes = 0) {
  return monthPeriod(date, tzOffsetMinutes);
}

// Unlike clampTzOffsetMinutes (kept for listUsage), the summary rejects a bad
// offset: it becomes part of the strftime modifier, so it must be an integer.
function strictTzOffsetMinutes(value) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^[+-]?\d{1,4}$/.test(text)) {
    throw new BillingStoreError("billing_invalid_tz_offset", "tzOffsetMinutes must be an integer number of minutes.");
  }
  const minutes = Number(text);
  if (Math.abs(minutes) > MAX_TZ_OFFSET_MINUTES) {
    throw new BillingStoreError("billing_invalid_tz_offset", "tzOffsetMinutes must be between -840 and 840.");
  }
  return minutes || 0;
}

function usageSummaryKind(value) {
  const kind = value === undefined || value === null || value === "" ? "llm" : String(value).trim().toLowerCase();
  if (!Object.hasOwn(USAGE_SUMMARY_SOURCES, kind)) throw new BillingStoreError("billing_invalid_kind", "kind must be llm or tts.");
  return kind;
}

function usageSummaryGroupBy(value, kind) {
  const list = value === undefined || value === null || value === ""
    ? []
    : Array.isArray(value) ? value : String(value).split(",");
  const names = [];
  for (const item of list) {
    const name = typeof item === "string" ? item.trim().toLowerCase() : "";
    if (!USAGE_SUMMARY_GROUP_BY.includes(name)) {
      throw new BillingStoreError("billing_invalid_group_by", `groupBy accepts only: ${USAGE_SUMMARY_GROUP_BY.join(", ")}.`);
    }
    if (!USAGE_SUMMARY_TIME_FORMATS[name] && !USAGE_SUMMARY_SOURCES[kind].dimensions[name]) {
      throw new BillingStoreError("billing_invalid_group_by", `${name} is not recorded for ${kind} usage.`);
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

// from/to accept epoch milliseconds, ISO 8601 with Z or an explicit offset, or
// a YYYY-MM-DD date taken as midnight at tzOffsetMinutes. The default window
// is the current billing month, like the overview's "this period".
function usageSummaryRange(fromInput, toInput, tzOffsetMinutes, now) {
  const period = monthPeriod(now, tzOffsetMinutes);
  const from = isBlank(fromInput) ? new Date(period.start) : usageSummaryInstant(fromInput, "from", tzOffsetMinutes);
  const to = isBlank(toInput) ? new Date(period.end) : usageSummaryInstant(toInput, "to", tzOffsetMinutes);
  if (from.getTime() >= to.getTime()) throw new BillingStoreError("billing_invalid_range", "from must be earlier than to.");
  if (to.getTime() - from.getTime() > USAGE_SUMMARY_MAX_RANGE_MS) {
    throw new BillingStoreError("billing_range_too_large", "A usage summary covers at most 400 days.");
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function usageSummaryInstant(value, name, tzOffsetMinutes) {
  let ms = Number.NaN;
  if (typeof value === "number") {
    ms = Number.isSafeInteger(value) ? value : Number.NaN;
  } else if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === "string") {
    const text = value.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (/^\d{1,15}$/.test(text)) {
      ms = Number(text);
    } else if (dateOnly) {
      const [year, month, day] = dateOnly.slice(1).map(Number);
      const midnight = new Date(Date.UTC(year, month - 1, day));
      if (midnight.getUTCFullYear() === year && midnight.getUTCMonth() === month - 1 && midnight.getUTCDate() === day) {
        ms = midnight.getTime() - tzOffsetMinutes * 60 * 1000;
      }
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
      ms = Date.parse(text);
    }
  }
  // Stored `at` values are toISOString() text compared lexically, which only
  // holds for four-digit years.
  if (!Number.isFinite(ms) || ms < 0 || ms > Date.UTC(9999, 11, 31)) {
    throw new BillingStoreError("billing_invalid_time", `${name} must be epoch milliseconds, an ISO 8601 time with an offset, or a YYYY-MM-DD date.`);
  }
  return new Date(ms);
}

function isBlank(value) {
  return value === undefined || value === null || value === "";
}

// listUsage keyset cursor: base64url JSON {t: at, id: usageId} of the last row
// of a page, the same shape as the telemetry request cursor (04 §11.5).
function encodeUsageCursor(item) {
  const at = item?.at;
  const usageId = item?.usageId;
  if (typeof at !== "string" || typeof usageId !== "string" || !STORED_AT_RE.test(at) || !UUID_RE.test(usageId)) return null;
  return Buffer.from(JSON.stringify({ t: at, id: usageId }), "utf8").toString("base64url");
}

function decodeUsageCursor(value) {
  const text = typeof value === "string" ? value.trim() : "";
  let parsed = null;
  if (text.length <= 512 && /^[A-Za-z0-9_-]+$/.test(text)) {
    try { parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8")); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.t !== "string" || typeof parsed.id !== "string"
    || !STORED_AT_RE.test(parsed.t) || !UUID_RE.test(parsed.id)) {
    throw new BillingStoreError("billing_invalid_cursor", "cursor is invalid.");
  }
  return { at: parsed.t, usageId: parsed.id.toLowerCase() };
}

function limitMessage(code) {
  return {
    billing_insufficient_balance: "Insufficient billing balance.",
    billing_period_credit_limit: "Billing period credit limit exceeded.",
    billing_period_token_limit: "Billing period token limit exceeded.",
    billing_period_request_limit: "Billing period request limit exceeded.",
  }[code] || "Billing limit exceeded.";
}

function sqliteConstraint(error, code, message) {
  if (/constraint/i.test(`${String(error?.code || "")} ${String(error?.message || "")}`)) return new BillingStoreError(code, message, 409);
  return error;
}

module.exports = {
  BillingStoreError,
  MICROCREDS_PER_MILLION_TOKENS,
  USAGE_SUMMARY_GROUP_BY,
  calculateMicrocredits,
  clampTzOffsetMinutes,
  createBillingStore,
  decodeUsageCursor,
  encodeUsageCursor,
  monthPeriod,
  utcMonthPeriod,
};
