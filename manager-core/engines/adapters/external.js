"use strict";

// The `external` adapter (01 §20): OpenAI-compatible endpoints that the user
// runs elsewhere (Ollama, LM Studio, a remote API). Nothing is launched, so the
// adapter holds only data rules: endpoint validation, the SSRF guard on
// baseUrl, host classification and the declared capabilities. The I/O (health,
// model listing, the upstream request) is hosts/external.js; the registry file
// and the CRUD routes belong to service-entry (service-entry/lib/engine-routes.js).
//
// The endpoint record never holds a key. apiKeyRef only says that a key exists
// in the secret store (namespace engines.external, name = endpointId).

const ENGINE_ID = "external";
const SECRET_NAMESPACE = "engines.external";
const ENDPOINT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const ENDPOINT_KINDS = Object.freeze(["ollama", "openai", "lmstudio", "generic"]);
const ACKNOWLEDGEMENTS = Object.freeze(["plaintext-remote"]);
const MAX_BASE_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 4096;
const MAX_LIST_ENTRIES = 200;

const CAPABILITY_FLAGS = Object.freeze(["text", "vision", "tools", "reasoning", "embedding", "rerank"]);
const API_SURFACE_FLAGS = Object.freeze(["chat", "completions", "responses", "messages", "embeddings", "rerank"]);
const RECORD_KEYS = Object.freeze([
  "endpointId", "label", "kind", "baseUrl", "apiKeyRef", "enabled", "models", "capabilities", "apiSurface",
  "routing", "localGpu", "createdAt", "acknowledged",
]);
// Request-only fields: handled by the route (secret store, acknowledgement), never stored as given.
const REQUEST_KEYS = Object.freeze(["apiKey", "acknowledge"]);

// Hostnames cloud providers answer with instance credentials.
const BLOCKED_HOSTNAMES = Object.freeze(["metadata.google.internal", "metadata", "instance-data"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// --- address classification -----------------------------------------------

function parseIpv4(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

// URL.hostname already compresses and lower-cases an IPv6 literal. Returns the
// eight 16-bit groups, or null when the text is not an IPv6 address.
function parseIpv6(text) {
  let source = text.replace(/^\[|\]$/g, "");
  const zone = source.indexOf("%");
  if (zone >= 0) source = source.slice(0, zone);
  if (!source.includes(":")) return null;
  const tail = source.slice(source.lastIndexOf(":") + 1);
  const embedded = tail.includes(".") ? parseIpv4(tail) : null;
  if (tail.includes(".") && !embedded) return null;
  if (embedded) {
    source = `${source.slice(0, source.lastIndexOf(":") + 1)}${((embedded[0] << 8) | embedded[1]).toString(16)}:${((embedded[2] << 8) | embedded[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const values = groups.map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN));
  return values.some(Number.isNaN) ? null : values;
}

// The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d) IPv6 address.
function mappedIpv4(groups) {
  if (groups.slice(0, 5).some((value) => value !== 0) || groups[5] !== 0xffff) return null;
  return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255];
}

function ipv4Blocked(octets) {
  const [a, b, c, d] = octets;
  if (a === 0) return true; // 0.0.0.0/8, "this host"
  if (a === 169 && b === 254) return true; // link-local, includes 169.254.169.254
  if (a === 100 && b === 100 && c === 100 && d === 200) return true; // Alibaba metadata
  if (a === 192 && b === 0 && c === 0 && d === 192) return true; // Oracle metadata
  return false;
}

function ipv6Blocked(groups) {
  const mapped = mappedIpv4(groups);
  if (mapped) return ipv4Blocked(mapped);
  if (groups.every((value) => value === 0)) return true; // ::
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if (groups[0] === 0xfd00 && groups[1] === 0x0ec2 && groups[7] === 0x0254) return true; // AWS IPv6 metadata
  return false;
}

function ipv4Class(octets) {
  const [a, b] = octets;
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
  if (a === 100 && b >= 64 && b <= 127) return "lan"; // CGNAT, Tailscale
  return "remote";
}

/**
 * Is this host an address or name the platform must never call? Takes a URL
 * hostname (IPv6 in brackets) or the text of a resolved address.
 */
function isBlockedHost(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.includes(host)) return true;
  const v4 = parseIpv4(host);
  if (v4) return ipv4Blocked(v4);
  const v6 = parseIpv6(host);
  return v6 ? ipv6Blocked(v6) : false;
}

/** "loopback" | "lan" | "remote" for a hostname or a baseUrl. */
function classifyHost(hostOrUrl) {
  let host = String(hostOrUrl ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "remote";
    }
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  const v4 = parseIpv4(host);
  if (v4) return ipv4Class(v4);
  const v6 = parseIpv6(host);
  if (v6) {
    const mapped = mappedIpv4(v6);
    if (mapped) return ipv4Class(mapped);
    if (v6.slice(0, 7).every((value) => value === 0) && v6[7] === 1) return "loopback";
    if ((v6[0] & 0xfe00) === 0xfc00) return "lan"; // fc00::/7
    return "remote";
  }
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return "lan";
  return "remote";
}

/** hostClass of a stored or submitted record; "remote" when it has no usable baseUrl. */
function hostClassOf(endpoint) {
  return classifyHost(endpoint?.baseUrl || "");
}

// --- validation -------------------------------------------------------------

function createCollector() {
  const errors = [];
  return { errors, add: (path, code, message) => errors.push({ path, code, message }) };
}

function checkBoolean(out, value, path, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    out.add(path, "type", `${path} must be true or false.`);
    return fallback;
  }
  return value;
}

function checkKnownKeys(out, value, path, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) out.add(path ? `${path}.${key}` : key, "unknown_field", `${path ? `${path}.` : ""}${key} is not a known field.`);
  }
}

function checkStringList(out, value, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
    out.add(path, "type", `${path} must be a list of at most ${MAX_LIST_ENTRIES} non-empty strings.`);
    return [];
  }
  return [...new Set(value.map((item) => item.trim()))];
}

// The SSRF guard on baseUrl (01 §20). Returns { url, hostClass } or null.
function checkBaseUrl(out, value, acknowledged) {
  if (typeof value !== "string" || !value.trim()) {
    out.add("baseUrl", "required", "baseUrl is required.");
    return null;
  }
  const text = value.trim();
  if (text.length > MAX_BASE_URL_LENGTH || /[\s\u0000-\u001f\\]/.test(text)) {
    out.add("baseUrl", "invalid_base_url", "baseUrl must be a plain http(s) URL.");
    return null;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    out.add("baseUrl", "invalid_base_url", "baseUrl must be an absolute http(s) URL.");
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    out.add("baseUrl", "invalid_base_url", "baseUrl must start with http:// or https://.");
    return null;
  }
  if (url.username || url.password) {
    out.add("baseUrl", "credentials_in_url", "baseUrl must not contain credentials; use the write-only apiKey field.");
    return null;
  }
  if (url.search || url.hash) {
    out.add("baseUrl", "invalid_base_url", "baseUrl must not contain a query string or fragment.");
    return null;
  }
  if (isBlockedHost(url.hostname)) {
    out.add("baseUrl", "blocked_address", "baseUrl points at a link-local, metadata or unspecified address, which is never allowed.");
    return null;
  }
  const hostClass = classifyHost(url.hostname);
  if (url.protocol === "http:" && hostClass === "remote" && !acknowledged.includes("plaintext-remote")) {
    out.add("baseUrl", "plaintext_remote", "A remote http:// endpoint sends prompts and keys in clear text; confirm it with acknowledge:[\"plaintext-remote\"] or use https://.");
    return null;
  }
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return { url: base, hostClass };
}

function checkModels(out, value) {
  const models = { discover: true, allow: [], aliases: {} };
  if (value === undefined) return models;
  if (!isPlainObject(value)) {
    out.add("models", "type", "models must be an object.");
    return models;
  }
  checkKnownKeys(out, value, "models", ["discover", "allow", "aliases"]);
  models.discover = checkBoolean(out, value.discover, "models.discover", true);
  models.allow = checkStringList(out, value.allow, "models.allow");
  if (value.aliases !== undefined) {
    const entries = isPlainObject(value.aliases) ? Object.entries(value.aliases) : null;
    if (!entries || entries.length > MAX_LIST_ENTRIES) {
      out.add("models.aliases", "type", `models.aliases must be an object of at most ${MAX_LIST_ENTRIES} alias to model entries.`);
    } else {
      for (const [alias, target] of entries) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(alias) || alias === "__proto__" || alias === "constructor") {
          out.add(`models.aliases.${alias}`, "invalid_alias", "An alias is a model name of letters, digits and . _ : / -.");
        } else if (typeof target !== "string" || !target.trim() || target.length > 200) {
          out.add(`models.aliases.${alias}`, "type", "An alias target must be a non-empty model name.");
        } else {
          models.aliases[alias] = target.trim();
        }
      }
    }
  }
  return models;
}

function checkCapabilities(out, value) {
  const capabilities = { text: true, vision: false, tools: false, reasoning: false, embedding: false, rerank: false, maxContext: null };
  if (value === undefined) return capabilities;
  if (!isPlainObject(value)) {
    out.add("capabilities", "type", "capabilities must be an object.");
    return capabilities;
  }
  checkKnownKeys(out, value, "capabilities", [...CAPABILITY_FLAGS, "maxContext"]);
  for (const key of CAPABILITY_FLAGS) capabilities[key] = checkBoolean(out, value[key], `capabilities.${key}`, capabilities[key]);
  if (value.maxContext !== undefined && value.maxContext !== null) {
    if (!Number.isInteger(value.maxContext) || value.maxContext < 1 || value.maxContext > 100_000_000) {
      out.add("capabilities.maxContext", "range", "capabilities.maxContext must be a whole number of tokens, or null.");
    } else {
      capabilities.maxContext = value.maxContext;
    }
  }
  return capabilities;
}

function checkApiSurface(out, value) {
  const surface = { chat: true, completions: true, responses: false, messages: false, embeddings: false, rerank: false };
  if (value === undefined) return surface;
  if (!isPlainObject(value)) {
    out.add("apiSurface", "type", "apiSurface must be an object.");
    return surface;
  }
  checkKnownKeys(out, value, "apiSurface", API_SURFACE_FLAGS);
  for (const key of API_SURFACE_FLAGS) surface[key] = checkBoolean(out, value[key], `apiSurface.${key}`, surface[key]);
  return surface;
}

/**
 * validateEndpoint(input, { now?, acknowledged? })
 *   → { ok, errors: [{ path, code, message }], endpoint }
 *
 * `input` is a complete endpoint (a create body, or a stored record with a
 * patch applied); options.acknowledged lists the acknowledgements already given
 * for this address (the record's own `acknowledged` field is not trusted).
 * Request-only fields (apiKey, acknowledge) are accepted and
 * ignored here; the route handles them. `endpoint` is the normalised record to
 * store and is null when `ok` is false. Pure: no DNS, no I/O.
 */
function validateEndpoint(input, options = {}) {
  const out = createCollector();
  if (!isPlainObject(input)) {
    out.add("", "type", "An endpoint must be a JSON object.");
    return { ok: false, errors: out.errors, endpoint: null };
  }
  checkKnownKeys(out, input, "", [...RECORD_KEYS, ...REQUEST_KEYS]);

  const endpointId = typeof input.endpointId === "string" ? input.endpointId : "";
  if (!ENDPOINT_ID_PATTERN.test(endpointId)) {
    out.add("endpointId", "invalid_endpoint_id", "endpointId must be 2-32 characters: a lower-case letter, then lower-case letters, digits or hyphens.");
  }
  let label = endpointId;
  if (input.label !== undefined) {
    if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 80) out.add("label", "type", "label must be 1-80 characters.");
    else label = input.label.trim();
  }
  let kind = "generic";
  if (input.kind !== undefined) {
    if (!ENDPOINT_KINDS.includes(input.kind)) out.add("kind", "invalid_kind", `kind must be one of ${ENDPOINT_KINDS.join(", ")}.`);
    else kind = input.kind;
  }

  const requested = input.acknowledge === undefined ? [] : input.acknowledge;
  if (!Array.isArray(requested) || requested.some((item) => !ACKNOWLEDGEMENTS.includes(item))) {
    out.add("acknowledge", "invalid_acknowledge", `acknowledge may list only: ${ACKNOWLEDGEMENTS.join(", ")}.`);
  }
  const acknowledged = [...new Set([
    ...(Array.isArray(options.acknowledged) ? options.acknowledged : []),
    ...(Array.isArray(requested) ? requested : []),
  ])].filter((item) => ACKNOWLEDGEMENTS.includes(item));

  const base = checkBaseUrl(out, input.baseUrl, acknowledged);
  const enabled = checkBoolean(out, input.enabled, "enabled", true);
  const models = checkModels(out, input.models);
  const capabilities = checkCapabilities(out, input.capabilities);
  const apiSurface = checkApiSurface(out, input.apiSurface);
  let includeInAuto = false;
  if (input.routing !== undefined) {
    if (!isPlainObject(input.routing)) {
      out.add("routing", "type", "routing must be an object.");
    } else {
      checkKnownKeys(out, input.routing, "routing", ["includeInAuto"]);
      includeInAuto = checkBoolean(out, input.routing.includeInAuto, "routing.includeInAuto", false);
    }
  }
  const localGpu = checkBoolean(out, input.localGpu, "localGpu", base ? base.hostClass === "loopback" : false);

  const expectedRef = `${SECRET_NAMESPACE}:${endpointId}`;
  const apiKeyRef = input.apiKeyRef === undefined ? "" : input.apiKeyRef;
  if (apiKeyRef !== "" && apiKeyRef !== expectedRef) {
    out.add("apiKeyRef", "invalid_api_key_ref", "apiKeyRef is set by the platform; send the key as the write-only apiKey field.");
  }

  let createdAt = new Date(typeof options.now === "function" ? options.now() : Date.now()).toISOString();
  if (input.createdAt !== undefined) {
    if (typeof input.createdAt !== "string" || Number.isNaN(Date.parse(input.createdAt))) out.add("createdAt", "type", "createdAt must be an ISO date.");
    else createdAt = new Date(input.createdAt).toISOString();
  }

  if (out.errors.length) return { ok: false, errors: out.errors, endpoint: null };
  return {
    ok: true,
    errors: [],
    endpoint: {
      endpointId,
      label,
      kind,
      baseUrl: base.url,
      apiKeyRef,
      enabled,
      models,
      capabilities,
      apiSurface,
      routing: { includeInAuto },
      localGpu,
      createdAt,
      acknowledged,
    },
  };
}

/** An apiKey sent with a create or patch: a usable header value, never logged. */
function validateApiKey(value) {
  if (typeof value !== "string" || !value || value.length > MAX_API_KEY_LENGTH || /[\s\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, error: { path: "apiKey", code: "invalid_api_key", message: "apiKey must be a single token without spaces or control characters." } };
  }
  return { ok: true };
}

/** `external:<endpointId>`, the fleet id of an endpoint's instance (00 §3). */
function fleetIdOf(endpointId) {
  return `${ENGINE_ID}:${endpointId}`;
}

// --- adapter interface (01 §6) ------------------------------------------------

function notManaged() {
  const error = new Error("An external endpoint is not started or stopped by the platform.");
  error.code = "external_not_managed";
  error.status = 405;
  return error;
}

function ctxEndpoint(ctx) {
  return isPlainObject(ctx?.endpoint) ? ctx.endpoint : null;
}

module.exports = {
  id: ENGINE_ID,
  ENGINE_ID,
  SECRET_NAMESPACE,
  ENDPOINT_ID_PATTERN,
  ENDPOINT_KINDS,
  ACKNOWLEDGEMENTS,
  RECORD_KEYS,
  classifyHost,
  fleetIdOf,
  hostClassOf,
  isBlockedHost,
  validateApiKey,
  validateEndpoint,

  /** There is nothing to launch (RuntimeHost.stop answers 405 external_not_managed too). */
  buildLaunch() {
    throw notManaged();
  },

  /** No admission lease and no VRAM model; Ollama's /api/ps is shown for display only (01 §12). */
  estimateMemory() {
    return {
      policy: "server-reported",
      perGpuMb: {},
      breakdown: { weights: 0, kv: 0, activations: 0, draft: 0, mmproj: 0, overhead: 0 },
      admissionRequestMb: 0,
      kvPoolTokens: null,
      maxFullLengthRequests: null,
      lease: false,
    };
  },

  /** Findings for the endpoint in ctx.endpoint: every validation error is a failure. */
  validate(plan, ctx) {
    const endpoint = ctxEndpoint(ctx);
    if (!endpoint) return [];
    const { errors } = validateEndpoint(endpoint, { acknowledged: endpoint.acknowledged });
    return errors.map((item) => ({
      severity: "fail",
      code: item.code,
      title: { zh: "外部端点配置无效", en: "External endpoint is not valid" },
      detail: { zh: item.message, en: item.message },
      field: item.path,
    }));
  },

  /** Declared capabilities of the endpoint's instance (00 §4.1 capabilities + apiSurface). */
  declaredCapabilities(plan, ctx) {
    const endpoint = ctxEndpoint(ctx);
    const capabilities = endpoint?.capabilities || {};
    const surface = endpoint?.apiSurface || {};
    return {
      capabilities: {
        text: capabilities.text !== false,
        vision: Boolean(capabilities.vision),
        audio: false,
        embedding: Boolean(capabilities.embedding),
        rerank: Boolean(capabilities.rerank),
        tools: Boolean(capabilities.tools),
        reasoning: Boolean(capabilities.reasoning),
        maxContext: Number.isInteger(capabilities.maxContext) ? capabilities.maxContext : null,
      },
      apiSurface: {
        chat: surface.chat !== false,
        completions: surface.completions !== false,
        responses: Boolean(surface.responses),
        messages: Boolean(surface.messages),
        embeddings: Boolean(surface.embeddings),
        rerank: Boolean(surface.rerank),
      },
    };
  },

  /** Ollama reports its version at /api/version; other kinds have no version route. */
  async probeVersion(endpoint, fetchImpl = globalThis.fetch) {
    if (!isPlainObject(endpoint) || endpoint.kind !== "ollama" || typeof fetchImpl !== "function") return null;
    try {
      const url = new URL(endpoint.baseUrl);
      url.pathname = `${url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "")}/api/version`;
      const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      if (!response.ok) return null;
      const raw = await response.json();
      return typeof raw?.version === "string" ? { version: raw.version, raw } : null;
    } catch {
      return null;
    }
  },
};
