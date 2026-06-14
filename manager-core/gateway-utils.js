function serviceApiKeySource(headers = {}) {
  const auth = String(headers.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return "authorization-bearer";
  if (auth) return "authorization-raw";
  if (headers["x-api-key"]) return "x-api-key";
  if (headers["anthropic-api-key"]) return "anthropic-api-key";
  if (headers["anthropic_api_key"]) return "anthropic_api_key";
  if (headers["api-key"]) return "api-key";
  return "";
}

function extractServiceApiKey(headers = {}) {
  const auth = String(headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return String(
    headers["x-api-key"]
    || headers["anthropic-api-key"]
    || headers["anthropic_api_key"]
    || headers["api-key"]
    || "",
  ).trim();
}

function openAiGatewayError(code, message) {
  return { error: { message, type: code, code } };
}

function claudeGatewayError(type, message) {
  return { type: "error", error: { type, message } };
}

module.exports = {
  serviceApiKeySource,
  extractServiceApiKey,
  openAiGatewayError,
  claudeGatewayError,
};
