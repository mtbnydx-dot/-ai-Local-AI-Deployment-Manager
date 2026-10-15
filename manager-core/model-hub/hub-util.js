"use strict";

// Small helpers the hub's modules share (index.js, search.js, plan.js): value
// guards, the 400 helper and the provider-failure mapping into the hub's
// taxonomy (03 §6.3).

const hubErrors = require("./errors");
const { ProviderError } = require("./providers/http");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function badRequest(field, message) {
  return new hubErrors.HubError("invalid_request", message, { status: 400, details: { field } });
}

// A provider failure while resolving a request, in the hub's taxonomy.
function fromProviderError(error) {
  if (!(error instanceof ProviderError)) return error;
  const code = hubErrors.HUB_ERROR_CODES.includes(error.code) ? error.code
    : hubErrors.HUB_ERROR_CODES.includes(error.baseCode) ? error.baseCode : String(error.code || "unknown");
  const upstream = Number(error.status);
  const status = hubErrors.HUB_ERROR_STATUS[code] || (upstream >= 400 && upstream < 600 ? upstream : 502);
  return new hubErrors.HubError(code, error.message, { status, ...(error.details ? { details: error.details } : {}) });
}

module.exports = { badRequest, fromProviderError, isPlainObject, nonEmpty };
