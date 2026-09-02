import path from "node:path";

export type ManagerTarget = {
  id: "vllm" | "llama";
  name: string;
  baseUrl: URL;
};

export type PlatformMcpConfig = {
  host: "127.0.0.1" | "localhost" | "::1";
  port: number;
  apiKey: string;
  requireAuth: boolean;
  allowedHosts: string[];
  aiRoot: string;
  serviceEntryUrl: URL;
  managers: ManagerTarget[];
  searchGatewayUrl: URL;
  searchGatewayApiKey: string;
  searchRateLimitPerMinute: number;
  timeoutMs: number;
  maxResponseChars: number;
  maxUpstreamBytes: number;
  auditLogPath: string;
};

type LoadConfigOptions = {
  env?: NodeJS.ProcessEnv;
  requireApiKey?: boolean;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  }
  return parsed;
}

function normalizeLoopbackBaseUrl(value: string | undefined, fallback: string, label: string): URL {
  const url = new URL(String(value || fallback).trim());
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`${label} must remain on loopback in this release.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query parameters, or fragments.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

function normalizeAllowedHosts(value: string | undefined): string[] {
  const defaults = ["127.0.0.1", "localhost", "::1", "host.docker.internal"];
  return Array.from(new Set([
    ...defaults,
    ...String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean),
  ])).filter((host) => /^[a-z0-9.:[\]-]+$/i.test(host));
}

function assertChildPath(candidate: string, parent: string, label: string): string {
  const resolved = path.resolve(candidate);
  const root = path.resolve(parent);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay below AI_ROOT.`);
  }
  return resolved;
}

export function loadConfig(options: LoadConfigOptions = {}): PlatformMcpConfig {
  const env = options.env ?? process.env;
  const requireAuth = options.requireApiKey ?? true;
  const hostValue = String(env.PLATFORM_MCP_HOST || "127.0.0.1").trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostValue)) {
    throw new Error("PLATFORM_MCP_HOST must remain on loopback in this release.");
  }
  const host = hostValue as PlatformMcpConfig["host"];
  const apiKey = String(env.PLATFORM_MCP_API_KEY || "").trim();
  if (requireAuth && apiKey.length < 32) {
    throw new Error("PLATFORM_MCP_API_KEY must contain at least 32 characters for HTTP mode.");
  }
  const searchGatewayApiKey = String(env.PLATFORM_MCP_SEARCH_GATEWAY_API_KEY || "").trim();
  if (searchGatewayApiKey && searchGatewayApiKey.length < 16) {
    throw new Error("PLATFORM_MCP_SEARCH_GATEWAY_API_KEY must contain at least 16 characters when configured.");
  }

  const aiRoot = path.resolve(String(env.AI_ROOT || path.resolve(process.cwd(), "..")));
  const auditLogPath = assertChildPath(
    String(env.PLATFORM_MCP_AUDIT_LOG || path.join(aiRoot, "audit-logs", "platform-mcp.jsonl")),
    aiRoot,
    "PLATFORM_MCP_AUDIT_LOG",
  );

  return {
    host,
    port: boundedInteger(env.PLATFORM_MCP_PORT, 5190, 1024, 65535, "PLATFORM_MCP_PORT"),
    apiKey,
    requireAuth,
    allowedHosts: normalizeAllowedHosts(env.PLATFORM_MCP_ALLOWED_HOSTS),
    aiRoot,
    serviceEntryUrl: normalizeLoopbackBaseUrl(
      env.PLATFORM_MCP_SERVICE_ENTRY_URL,
      "http://127.0.0.1:5176",
      "PLATFORM_MCP_SERVICE_ENTRY_URL",
    ),
    managers: [
      {
        id: "vllm",
        name: "vLLM Manager",
        baseUrl: normalizeLoopbackBaseUrl(
          env.PLATFORM_MCP_VLLM_MANAGER_URL,
          "http://127.0.0.1:5177",
          "PLATFORM_MCP_VLLM_MANAGER_URL",
        ),
      },
      {
        id: "llama",
        name: "llama.cpp Manager",
        baseUrl: normalizeLoopbackBaseUrl(
          env.PLATFORM_MCP_LLAMA_MANAGER_URL,
          "http://127.0.0.1:5178",
          "PLATFORM_MCP_LLAMA_MANAGER_URL",
        ),
      },
    ],
    searchGatewayUrl: normalizeLoopbackBaseUrl(
      env.PLATFORM_MCP_SEARCH_GATEWAY_URL,
      "http://127.0.0.1:5180",
      "PLATFORM_MCP_SEARCH_GATEWAY_URL",
    ),
    searchGatewayApiKey,
    searchRateLimitPerMinute: boundedInteger(
      env.PLATFORM_MCP_SEARCH_RATE_LIMIT_PER_MINUTE,
      20,
      1,
      120,
      "PLATFORM_MCP_SEARCH_RATE_LIMIT_PER_MINUTE",
    ),
    timeoutMs: boundedInteger(env.PLATFORM_MCP_TIMEOUT_MS, 7000, 250, 30000, "PLATFORM_MCP_TIMEOUT_MS"),
    maxResponseChars: boundedInteger(
      env.PLATFORM_MCP_MAX_RESPONSE_CHARS,
      25000,
      2000,
      100000,
      "PLATFORM_MCP_MAX_RESPONSE_CHARS",
    ),
    maxUpstreamBytes: boundedInteger(
      env.PLATFORM_MCP_MAX_UPSTREAM_BYTES,
      2 * 1024 * 1024,
      64 * 1024,
      8 * 1024 * 1024,
      "PLATFORM_MCP_MAX_UPSTREAM_BYTES",
    ),
    auditLogPath,
  };
}
