"use strict";
// Search gateway and MCP behind the unified entry.
//
//   /gateway/search/<rest>  ->  http://127.0.0.1:5180/<rest>
//   /gateway/mcp            ->  http://127.0.0.1:5190/mcp   (Streamable HTTP)
//   /gateway/mcp/info       ->  http://127.0.0.1:5190/info
//   /gateway/mcp/health     ->  http://127.0.0.1:5190/health
//
// The entry authenticates the caller with a platform service key and then
// presents the upstream's own credential, so a public client needs one key
// for models, TTS, search and MCP alike.

const SEARCH_ALLOWED = [
  /^v1\/chat\/completions$/,
  /^v1\/models$/,
  /^v1\/search$/,
  /^search$/,
  /^v1\/research$/,
  /^v1\/read$/,
  /^v1\/find$/,
  /^v1\/open$/,
  /^health$/,
];

const MCP_ALLOWED = new Set(["", "info", "health"]);

function parseAuxGatewayRoute(pathname) {
  const text = String(pathname || "");
  const search = text.match(/^\/gateway\/search(?:\/(.*))?$/);
  if (search) return { service: "search", engine: "search", protocol: "search", rest: search[1] || "" };
  const mcp = text.match(/^\/gateway\/mcp(?:\/(.*))?$/);
  if (mcp) return { service: "mcp", engine: "mcp", protocol: "mcp", rest: mcp[1] || "" };
  return null;
}

function invalidPath(message) {
  const error = new Error(message);
  error.code = "invalid_gateway_path";
  error.status = 400;
  return error;
}

function sanitizeRest(rest) {
  const decoded = (() => {
    try { return decodeURIComponent(String(rest || "")); } catch { throw invalidPath("Gateway path is not valid UTF-8."); }
  })();
  if (decoded.includes("\\") || decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw invalidPath("Gateway path may not contain relative segments.");
  }
  return decoded.replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildAuxUpstreamPath(route) {
  if (!route) throw invalidPath("Unknown auxiliary gateway route.");
  const rest = sanitizeRest(route.rest);
  if (route.service === "search") {
    if (!SEARCH_ALLOWED.some((pattern) => pattern.test(rest))) {
      const error = new Error(`Search gateway path is not exposed through the entry: /${rest}`);
      error.code = "not_found";
      error.status = 404;
      throw error;
    }
    return `/${rest}`;
  }
  if (route.service === "mcp") {
    if (!MCP_ALLOWED.has(rest)) {
      const error = new Error(`MCP path is not exposed through the entry: /${rest}`);
      error.code = "not_found";
      error.status = 404;
      throw error;
    }
    return rest ? `/${rest}` : "/mcp";
  }
  throw invalidPath("Unknown auxiliary gateway route.");
}

// Reads PLATFORM_MCP_API_KEY from the MCP server env file the start script
// writes. The file lives under the platform root and is never sent anywhere;
// the entry only uses it to speak to the loopback MCP server.
function parseEnvFileValue(text, name) {
  const line = String(text || "").split(/\r?\n/).find((item) => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
}

module.exports = {
  MCP_ALLOWED,
  SEARCH_ALLOWED,
  buildAuxUpstreamPath,
  parseAuxGatewayRoute,
  parseEnvFileValue,
};
