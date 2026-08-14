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
    ], "plan");
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
      insertAudit({ actorId, action: "plan.create", targetType: "plan", targetId: planId, details: { code, name } });
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
    };
    rejectUnknownKeys(patch, [
      "code", "name", "currency", "monthlyPriceMicrocredits", "includedMicrocredits", "periodCreditLimitMicrocredits",
      "monthlyTokenLimit", "periodTokenLimit", "monthlyRequestLimit", "periodRequestLimit", "enforcementMode", "active", "actorId",
    ], "plan patch");
    return transaction(() => {
      try {
        prepare(`
          UPDATE billing_plans SET
            code=?, name=?, currency=?, monthly_price_microcredits=?, included_microcredits=?,
            monthly_token_limit=?, monthly_request_limit=?, enforcement_mode=?, active=?, updated_at=?
          WHERE plan_id=?
        `).run(
          next.code, next.name, next.currency, next.monthlyPrice, next.included, next.tokenLimit,
          next.requestLimit, next.enforcementMode, next.active, nowIso(), planId,
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
      "monthlyTokenLimit", "monthlyRequestLimit", "notes", "actorId",
    ], "customer");
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
      insertAudit({ actorId: input.actorId || "system", action: "customer.create", targetType: "customer", targetId: customerId, customerId, details: { externalRef, name, status, planId, enforcementMode, creditLimitMicrocredits: decimal(creditLimit), monthlyTokenLimit: decimal(tokenLimit), monthlyRequestLimit: decimal(requestLimit) } });
      return getCustomer(customerId);
    });
  }

  function updateCustomer(customerIdInput, patch = {}) {
    const customerId = uuid(customerIdInput, "customerId");
    const current = getCustomerRow(customerId);
    if (!current) throw new BillingStoreError("billing_customer_not_found", "Customer not found.", 404);
    rejectUnknownKeys(patch, ["externalRef", "name", "status", "planId", "enforcementMode", "creditLimitMicrocredits", "monthlyTokenLimit", "monthlyRequestLimit", "notes", "actorId"], "customer patch");
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
    };
    return transaction(() => {
      if (planId && !getPlanRow(planId)) throw new BillingStoreError("billing_plan_not_found", "Plan not found.", 404);
      try {
        prepare(`
          UPDATE billing_customers SET
            external_ref=?, name=?, status=?, plan_id=?, enforcement_mode=?, credit_limit_microcredits=?,
            monthly_token_limit=?, monthly_request_limit=?, notes=?, updated_at=?
          WHERE customer_id=?
        `).run(next.externalRef, next.name, next.status, planId, enforcementMode, next.creditLimit, next.tokenLimit, next.requestLimit, next.notes, nowIso(), customerId);
      } catch (error) {
        throw sqliteConstraint(error, "billing_customer_conflict", "Customer external reference already exists.");
      }
      insertAudit({ actorId: patch.actorId || "system", action: "customer.update", targetType: "customer", targetId: customerId, customerId, details: { externalRef: next.externalRef, name: next.name, status: next.status, planId, enforcementMode, creditLimitMicrocredits: decimal(next.creditLimit), monthlyTokenLimit: decimal(next.tokenLimit), monthlyRequestLimit: decimal(next.requestLimit) } });
      return getCustomer(customerId);
    });
  }

  function updateCustomerPolicy(customerId, patch = {}) {
    rejectUnknownKeys(patch, ["planId", "enforcementMode", "creditLimitMicrocredits", "monthlyTokenLimit", "monthlyRequestLimit", "status", "actorId"], "customer policy patch");
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

  function bindCredential(input = {}) {
    const customerId = uuid(input.customerId, "customerId");
    const managerId = managerIdentifier(input.managerId);
    const serviceClientId = clientIdentifier(input.serviceClientId ?? input.clientId);
    const label = optionalText(input.label, "label", 120);
    const active = booleanInteger(input.active, true, "active");
    const at = nowIso();
    return transaction(() => {
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
  }

  function getBindingRow(managerId, serviceClientId) {
    return prepare(`
      SELECT b.*, c.status AS customer_status, c.plan_id, c.enforcement_mode AS customer_enforcement_mode,
             c.credit_limit_microcredits, c.monthly_token_limit AS customer_monthly_token_limit,
             c.monthly_request_limit AS customer_monthly_request_limit,
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
      const binding = getBindingRow(request.managerId, request.clientId);
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
         price_fixed_request, period_key, period_start, period_end, authorized_at, expires_at, settled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      input.requestId, input.reservationId, input.externalRequestId || null, input.managerId, input.clientId,
      binding?.customer_id || null, binding?.binding_id || null, binding?.plan_id || null, price?.price_id || null,
      input.model, input.endpoint, input.stream ? 1 : 0, input.enforcementMode, input.allowed ? 1 : 0,
      input.code, input.message, input.allowed ? "authorized" : "denied", input.estimatedInputTokens,
      input.maxOutputTokens, input.cachedInputTokens, input.reserved,
      price?.input_per_million_microcredits ?? 0n, price?.output_per_million_microcredits ?? 0n,
      price?.cached_input_per_million_microcredits ?? 0n, price?.fixed_request_microcredits ?? 0n,
      input.period.key, input.period.start, input.period.end, input.at, input.expiresAt,
    );
    return getReservationRow(input.requestId);
  }

  function settleRequest(input = {}) {
    const settlement = normalizeSettlementInput(input, uuid);
    return transaction(() => {
      const existingUsage = getUsageRow(settlement.requestId);
      if (existingUsage) {
        assertUsageIdentity(existingUsage, settlement);
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
    const authorized = prepare(`
      SELECT reservation_microcredits, estimated_input_tokens, max_output_tokens
      FROM billing_request_reservations
      WHERE customer_id=? AND enforcement_mode='hard' AND status='authorized' AND period_key=? AND expires_at>?
    `).all(customerId, period.key, at);
    const usage = prepare(`
      SELECT projected_microcredits, total_tokens
      FROM billing_usage_events
      WHERE customer_id=? AND at>=? AND at<?
        AND usage_source!='missing'
        AND terminal_state!='ambiguous'
        AND ((ok=1 AND terminal_state='completed') OR total_tokens>0)
    `).all(customerId, period.start, period.end);
    const reservedCredits = sumBigInts(authorized.map((row) => row.reservation_microcredits));
    const reservedTokens = sumBigInts(authorized.map((row) => row.estimated_input_tokens + row.max_output_tokens));
    const spentCredits = sumBigInts(usage.map((row) => row.projected_microcredits));
    const spentTokens = sumBigInts(usage.map((row) => row.total_tokens));
    // Request quota counts each effective settled usage once, including failed,
    // cancelled, disconnected, or timed-out requests with measured token
    // consumption. Missing/ambiguous and unmeasured failures do not consume the
    // quota. Each live Hard reservation counts once, as does this candidate.
    const requestCount = BigInt(usage.length + authorized.length + 1);
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
    const entries = prepare("SELECT delta_microcredits FROM billing_wallet_ledger WHERE customer_id=?").all(customerId);
    const reservations = prepare(`
      SELECT reservation_microcredits FROM billing_request_reservations
      WHERE customer_id=? AND enforcement_mode='hard' AND status='authorized' AND expires_at>?
    `).all(customerId, nowIso());
    const balance = sumBigInts(entries.map((row) => row.delta_microcredits));
    const reserved = sumBigInts(reservations.map((row) => row.reservation_microcredits));
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
    const sql = `SELECT * FROM billing_usage_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ? OFFSET ?`;
    params.push(BigInt(limit), BigInt(offset));
    return prepare(sql).all(...params).map(usageFromRow);
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
    const customers = prepare("SELECT customer_id, status FROM billing_customers").all();
    const credentials = prepare("SELECT active FROM billing_credential_bindings").all();
    const usage = prepare("SELECT projected_microcredits, charged_microcredits, total_tokens FROM billing_usage_events").all();
    const periodUsage = prepare(`
      SELECT projected_microcredits, charged_microcredits, total_tokens
      FROM billing_usage_events WHERE at>=? AND at<?
    `).all(period.start, period.end);
    const ledger = prepare("SELECT delta_microcredits FROM billing_wallet_ledger").all();
    const reservations = prepare("SELECT reservation_microcredits FROM billing_request_reservations WHERE enforcement_mode='hard' AND status='authorized' AND expires_at>?").all(overviewAt);
    const balanceMicrocredits = decimal(sumBigInts(ledger.map((row) => row.delta_microcredits)));
    const reservedMicrocredits = decimal(sumBigInts(reservations.map((row) => row.reservation_microcredits)));
    const availableMicrocredits = (BigInt(balanceMicrocredits) - BigInt(reservedMicrocredits)).toString();
    const activeCustomers = customers.filter((row) => row.status === "active").length;
    const activeCredentials = credentials.filter((row) => Number(row.active) === 1).length;
    const periodTokens = decimal(sumBigInts(periodUsage.map((row) => row.total_tokens)));
    const periodCostMicrocredits = decimal(sumBigInts(periodUsage.map((row) => row.projected_microcredits)));
    return {
      ok: true,
      updatedAt: overviewAt,
      customerCount: customers.length,
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
        customers: customers.length,
        activeCustomers,
        activeCredentials,
        balanceMicrocredits,
        availableMicrocredits,
        periodTokens,
        periodCostMicrocredits,
      },
      customers: { total: customers.length, active: activeCustomers },
      usage: {
        requests: usage.length,
        tokens: decimal(sumBigInts(usage.map((row) => row.total_tokens))),
        projectedMicrocredits: decimal(sumBigInts(usage.map((row) => row.projected_microcredits))),
        chargedMicrocredits: decimal(sumBigInts(usage.map((row) => row.charged_microcredits))),
      },
      period: {
        key: period.key,
        start: period.start,
        end: period.end,
        requests: periodUsage.length,
        tokens: periodTokens,
        projectedMicrocredits: periodCostMicrocredits,
        chargedMicrocredits: decimal(sumBigInts(periodUsage.map((row) => row.charged_microcredits))),
      },
      wallet: {
        balanceMicrocredits,
        reservedMicrocredits,
        availableMicrocredits,
      },
      recentUsage: listUsage({ limit: 20 }),
    };
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
    listCustomers,
    bindCredential,
    listCredentialBindings,
    adjustBalance,
    upsertPrice,
    applyPriceTemplates,
    listPrices,
    getRequest,
    listUsage,
    listLedger,
    listAuditEvents,
    writeAdminAudit,
    getOverview,
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
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_customer_external_ref
      ON billing_customers(external_ref) WHERE external_ref IS NOT NULL;
  `);
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  // Table, column and definition are compile-time constants from ensureSchema.
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function normalizeAuthorizeInput(input, uuid) {
  rejectUnknownKeys(input, [
    "requestId", "externalRequestId", "managerId", "clientId", "serviceClientId", "model", "endpoint", "stream",
    "estimatedInputTokens", "maxOutputTokens", "cachedInputTokens",
  ], "authorization request");
  const estimatedInputTokens = nonNegativeInt64(input.estimatedInputTokens ?? 0, "estimatedInputTokens");
  const maxOutputTokens = nonNegativeInt64(input.maxOutputTokens ?? 0, "maxOutputTokens");
  const cachedInputTokens = nonNegativeInt64(input.cachedInputTokens ?? 0, "cachedInputTokens");
  if (cachedInputTokens > estimatedInputTokens) throw new BillingStoreError("billing_invalid_tokens", "cachedInputTokens cannot exceed estimatedInputTokens.");
  return {
    requestId: uuid(input.requestId, "requestId"),
    externalRequestId: optionalText(input.externalRequestId, "externalRequestId", 128),
    managerId: managerIdentifier(input.managerId),
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
    "requestId", "externalRequestId", "managerId", "clientId", "serviceClientId", "model", "status", "ok",
    "terminalState", "usageSource", "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens",
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
  return {
    requestId: uuid(input.requestId, "requestId"),
    externalRequestId: optionalText(input.externalRequestId, "externalRequestId", 128),
    managerId: managerIdentifier(input.managerId),
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

function assertReservationIdentity(row, input) {
  if (row.manager_id !== input.managerId || row.service_client_id !== input.clientId || row.model !== input.model) {
    throw new BillingStoreError("billing_idempotency_conflict", "requestId was already used for a different billing request.", 409);
  }
  if (input.externalRequestId && row.external_request_id && input.externalRequestId !== row.external_request_id) {
    throw new BillingStoreError("billing_idempotency_conflict", "requestId has a different externalRequestId.", 409);
  }
}

function assertUsageIdentity(row, input) {
  if (row.manager_id !== input.managerId || row.service_client_id !== input.clientId || row.model !== input.model) {
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
  calculateMicrocredits,
  clampTzOffsetMinutes,
  createBillingStore,
  monthPeriod,
  utcMonthPeriod,
};
