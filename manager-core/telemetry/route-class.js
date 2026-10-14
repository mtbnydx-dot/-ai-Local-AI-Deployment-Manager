"use strict";

// Gateway route classification (04 §5.5). `traffic` requests become rows in
// `requests`; `control` and `static` requests only increment
// control_counts_1m(route, status_class), unless the status is 401, 403, 429
// or >= 500, which the recorder keeps as a row so auth storms stay visible.
//
// classifyGatewayRoute(method, pathname) returns
//   { kind: "traffic"|"control"|"static", protocol, op, route }
// or null for a path that is not a gateway path. `protocol` and `op` use the
// requests-table vocabulary; requests that belong to no protocol (health,
// status, unknown gateway paths) use protocol "gateway" and op "other".
// `route` is the routing target (auto, vllm, llama, <engineId>,
// external:<id>, tts, search, mcp) or, for gateway-level control requests,
// the endpoint name (health, status, me, other).
//
// The PUBLIC listener's aliases (/v1/*, /anthropic/v1/*, /vllm/v1/*,
// /llama/v1/*, 05 §8) classify exactly like the canonical route they map to.

const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PROTOCOLS = new Set(["openai", "claude", "opencode"]);
// First path segments under /gateway/ that are not engine routes.
const RESERVED_SEGMENTS = new Set(["tts", "search", "mcp", "health", "status", "me", "external"]);
const GATEWAY_ENDPOINTS = new Set(["health", "status", "me"]);

// Order matters: chat/completions before completions.
const OPENAI_TRAFFIC_OPS = [
  [/(?:^|\/)chat\/completions$/, "chat"],
  [/(?:^|\/)completions$/, "completions"],
  [/(?:^|\/)responses$/, "responses"],
  [/(?:^|\/)embeddings$/, "embeddings"],
  [/(?:^|\/)(?:rerank|score)$/, "rerank"],
];

// The entry's TTS synthesis routes (service-entry/lib/tts-usage.js).
const TTS_SPEECH_RESTS = new Set(["v1/audio/speech", "openai/v1/audio/speech", "api/tts"]);
const TTS_BATCH_PATTERN = /^api\/jobs(?:\/[A-Za-z0-9_-]+\/retry)?$/;
const TTS_STATIC_PATTERN = /(?:^|\/)[^/]+\.(?:html?|js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf)$/i;

function result(kind, protocol, op, route) {
  return { kind, protocol, op, route };
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function isRead(method) {
  return method === "GET" || method === "HEAD";
}

// Maps a PUBLIC listener alias to its canonical /gateway path, or "".
function canonicalAliasPath(pathname) {
  const v1 = pathname.match(/^\/(v1|vllm\/v1|llama\/v1|anthropic\/v1)(?:\/(.*))?$/);
  if (!v1) return "";
  const prefix = v1[1];
  const rest = trimSlashes(v1[2] || "");
  if (prefix === "anthropic/v1") return `/gateway/auto/claude/v1${rest ? `/${rest}` : ""}`;
  const route = prefix === "v1" ? "auto" : prefix.split("/")[0];
  if (prefix === "v1" && (rest === "me" || rest.startsWith("me/"))) return "/gateway/me";
  if (prefix === "v1" && rest === "audio/speech") return "/gateway/tts/openai/v1/audio/speech";
  if (rest === "messages" || rest.startsWith("messages/")) return `/gateway/${route}/claude/v1/${rest}`;
  return `/gateway/${route}/openai/v1${rest ? `/${rest}` : ""}`;
}

function classifyProtocolRequest(method, protocol, rest, route) {
  if (method === "OPTIONS") return result("control", protocol, "other", route);
  const tail = trimSlashes(rest);
  if (protocol === "claude") {
    if (method === "POST") {
      if (/(?:^|\/)messages\/count_tokens$/.test(tail)) return result("traffic", protocol, "count_tokens", route);
      // POST /gateway/<route>/claude is the messages endpoint itself.
      if (!tail || /(?:^|\/)messages$/.test(tail)) return result("traffic", protocol, "messages", route);
      return result("traffic", protocol, "other", route);
    }
  } else if (method === "POST") {
    const match = OPENAI_TRAFFIC_OPS.find(([pattern]) => pattern.test(tail));
    return result("traffic", protocol, match ? match[1] : "other", route);
  }
  if (isRead(method) && /(?:^|\/)models(?:\/[^/]+)?$/.test(tail)) return result("control", protocol, "models", route);
  return result("control", protocol, "other", route);
}

function classifyTtsRequest(method, rest) {
  const tail = trimSlashes(rest);
  if (method === "POST") {
    if (TTS_SPEECH_RESTS.has(tail)) return result("traffic", "tts", "speech", "tts");
    if (TTS_BATCH_PATTERN.test(tail)) return result("traffic", "tts", "tts_batch", "tts");
  }
  // The TTS workbench UI shell and its assets.
  if (isRead(method) && (!tail || TTS_STATIC_PATTERN.test(tail) || /^(?:static|assets)\//.test(tail))) {
    return result("static", "tts", "other", "tts");
  }
  return result("control", "tts", "other", "tts");
}

function classifyGatewayRoute(method, pathname) {
  const verb = String(method || "GET").toUpperCase();
  let path = String(pathname || "").split("?")[0];
  if (!path.startsWith("/gateway/") && path !== "/gateway") {
    const canonical = canonicalAliasPath(path);
    if (!canonical) return null;
    path = canonical;
  }
  const segments = trimSlashes(path.slice("/gateway".length)).split("/");
  const first = segments[0] || "";

  if (GATEWAY_ENDPOINTS.has(first) && segments.length === 1) return result("control", "gateway", "other", first);
  if (first === "tts") return classifyTtsRequest(verb, segments.slice(1).join("/"));
  if (first === "search") {
    if (verb === "POST" && segments[1] === "v1") return result("traffic", "search", "search", "search");
    return result("control", "search", "other", "search");
  }
  if (first === "mcp") {
    if (verb === "POST" && segments.length === 1) return result("traffic", "mcp", "tool", "mcp");
    return result("control", "mcp", "other", "mcp");
  }
  if (first === "external" && EXTERNAL_ID_PATTERN.test(segments[1] || "") && PROTOCOLS.has(segments[2])) {
    return classifyProtocolRequest(verb, segments[2], segments.slice(3).join("/"), `external:${segments[1]}`);
  }
  if (!RESERVED_SEGMENTS.has(first) && ENGINE_ID_PATTERN.test(first) && PROTOCOLS.has(segments[1])) {
    return classifyProtocolRequest(verb, segments[1], segments.slice(2).join("/"), first);
  }
  return result("control", "gateway", "other", "other");
}

module.exports = {
  classifyGatewayRoute,
};
