"use strict";

// Request ids for telemetry (00 §3, §9.9). The entry mints `req_` for every
// gateway request; a manager that is called directly falls back to `mgr_`.
// Both carry 100 random bits as 20 characters of RFC 4648 base32 in lower
// case (a-z, 2-7), so they also pass the manager's x-request-id normaliser,
// which accepts `[A-Za-z0-9._:/-]` up to 128 bytes.
//
// The format, not this module, is the contract: other packages may mint the
// same format themselves.

const crypto = require("node:crypto");

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_CHARS = 20; // 20 × 5 bits = 100 random bits
const REQUEST_ID_PREFIX = "req_";
const DIRECT_REQUEST_ID_PREFIX = "mgr_";
const TELEMETRY_REQUEST_ID_PATTERN = /^(?:req|mgr)_[a-z2-7]{20}$/;
const CLIENT_REQUEST_ID_MAX_BYTES = 128;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;

// 13 random bytes give 104 bits; the first 100 become 20 base32 characters.
function randomBase32(chars = ID_CHARS) {
  const bytes = crypto.randomBytes(Math.ceil((chars * 5) / 8));
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < chars) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return output;
}

function newRequestId() {
  return `${REQUEST_ID_PREFIX}${randomBase32()}`;
}

function newDirectRequestId() {
  return `${DIRECT_REQUEST_ID_PREFIX}${randomBase32()}`;
}

function isTelemetryRequestId(value) {
  return typeof value === "string" && TELEMETRY_REQUEST_ID_PATTERN.test(value);
}

// An inbound client x-request-id, kept as client_request_id. It is the same
// rule as the manager normaliser (normalizeOpenAiGatewayRequestId): a value
// with other characters or over 128 bytes is dropped rather than rewritten,
// so the stored id is always exactly what the client sent.
function normalizeClientRequestId(value) {
  const text = String(Array.isArray(value) ? value[0] : value || "").trim();
  if (!text || Buffer.byteLength(text, "utf8") > CLIENT_REQUEST_ID_MAX_BYTES) return "";
  return CLIENT_REQUEST_ID_PATTERN.test(text) ? text : "";
}

module.exports = {
  BASE32_ALPHABET,
  REQUEST_ID_PREFIX,
  DIRECT_REQUEST_ID_PREFIX,
  TELEMETRY_REQUEST_ID_PATTERN,
  newRequestId,
  newDirectRequestId,
  isTelemetryRequestId,
  normalizeClientRequestId,
};
