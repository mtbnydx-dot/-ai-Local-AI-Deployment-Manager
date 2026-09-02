const crypto = require("node:crypto");

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
}

function previewSecret(secret) {
  const text = String(secret || "");
  if (!text) return "";
  if (text.length <= 12) return `${text.slice(0, 3)}...${text.slice(-2)}`;
  return `${text.slice(0, 7)}...${text.slice(-4)}`;
}

function timingSafeEqualText(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function normalizeSecretRecord(value = {}, previous = {}) {
  // Same rule as normalizeServiceExposureSecret: only a non-empty value sets a
  // new secret, and a record that already carries a hash keeps it. Clearing has
  // its own explicit flag.
  if (value.clearApiKey || value.clearSecret) return { secret: "", hash: "", preview: "" };
  const direct = String((value.apiKey !== undefined ? value.apiKey : value.secret) ?? "").trim();
  if (direct) return { secret: "", hash: hashSecret(direct), preview: previewSecret(direct) };
  const carriedHash = String(value.apiKeyHash || value.secretHash || value.hash || "").trim();
  if (carriedHash) {
    return { secret: "", hash: carriedHash, preview: String(value.apiKeyPreview || value.secretPreview || value.preview || "") };
  }
  const previousHash = String(previous.apiKeyHash || previous.secretHash || previous.hash || "").trim();
  if (previousHash) {
    return { secret: "", hash: previousHash, preview: String(previous.apiKeyPreview || previous.secretPreview || previous.preview || "") };
  }
  const legacy = String(previous.apiKey || previous.secret || "").trim();
  return legacy ? { secret: "", hash: hashSecret(legacy), preview: previewSecret(legacy) } : { secret: "", hash: "", preview: "" };
}

function hasSecretRecord(record = {}) {
  return Boolean(record.apiKeyHash || record.secretHash || record.hash || record.apiKey || record.secret);
}

function isSecretAccepted(presented, record = {}) {
  const key = String(presented || "").trim();
  if (!key) return false;
  const hash = record.apiKeyHash || record.secretHash || record.hash;
  if (hash) return hashSecret(key) === hash;
  const legacy = record.apiKey || record.secret;
  return Boolean(legacy && timingSafeEqualText(key, legacy));
}

module.exports = {
  hashSecret,
  previewSecret,
  timingSafeEqualText,
  normalizeSecretRecord,
  hasSecretRecord,
  isSecretAccepted,
};
