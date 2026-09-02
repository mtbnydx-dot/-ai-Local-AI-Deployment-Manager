import { timingSafeEqual } from "node:crypto";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import type { PlatformMcpConfig } from "./config.js";
import type { AuditLogger } from "./audit.js";
import type { PlatformDataSource } from "./platform-client.js";
import { cleanText } from "./redaction.js";
import { SERVER_NAME, SERVER_VERSION, TOOL_NAMES } from "./constants.js";
import { createPlatformMcpServer, SearchRateLimiter } from "./tools.js";

export type PlatformMcpAppDependencies = {
  config: PlatformMcpConfig;
  dataSource: PlatformDataSource;
  auditLogger: AuditLogger;
};

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || "").trim());
  return match?.[1]?.trim() || "";
}

function safeClientId(value: string | undefined): string {
  return cleanText(value || "http-local-client", 120).replace(/[^A-Za-z0-9_.:@/-]/g, "_") || "http-local-client";
}

export function createPlatformMcpApp(dependencies: PlatformMcpAppDependencies) {
  const { config } = dependencies;
  const allowedNames = config.allowedHosts.map((host) => host === "::1" ? "[::1]" : host);
  const app = createMcpHonoApp({
    host: config.host,
    allowedHosts: allowedNames,
    allowedOrigins: allowedNames,
  });
  const searchRateLimiter = new SearchRateLimiter(config.searchRateLimitPerMinute);
  const mcpHandler = createMcpHandler(
    () => createPlatformMcpServer({
      dataSource: dependencies.dataSource,
      auditLogger: dependencies.auditLogger,
      maxResponseChars: config.maxResponseChars,
      defaultClientId: "http-local-client",
      searchRateLimiter,
    }),
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error) => console.error(`[platform-mcp] protocol error: ${cleanText(error.message, 500)}`),
    },
  );

  app.get("/health", (context) => context.json({
    ok: true,
    service: "local-ai-platform-mcp",
    version: SERVER_VERSION,
    transport: "streamable-http",
    auth_required: config.requireAuth,
    read_only: true,
  }));

  app.use("/info", async (context, next) => {
    if (!config.requireAuth) return next();
    const token = bearerToken(context.req.header("authorization"));
    if (!token || !equalSecret(token, config.apiKey)) {
      context.header("WWW-Authenticate", "Bearer realm=\"local-ai-platform-mcp\"");
      return context.json({ ok: false, error: "Bearer authentication is required." }, 401);
    }
    return next();
  });

  app.get("/info", (context) => context.json({
    ok: true,
    name: SERVER_NAME,
    version: SERVER_VERSION,
    endpoint: "/mcp",
    transports: ["streamable-http", "stdio"],
    protocol_versions: SUPPORTED_PROTOCOL_VERSIONS,
    compatibility: { legacy_stateless: true, modern_per_request: true },
    policy: {
      read_only: true,
      arbitrary_urls: false,
      web_search: true,
      search_rate_limit_per_minute: config.searchRateLimitPerMinute,
      shell_access: false,
      file_access: false,
    },
    tools: TOOL_NAMES,
  }));

  app.use("/mcp", async (context, next) => {
    if (!config.requireAuth) return next();
    const token = bearerToken(context.req.header("authorization"));
    if (!token || !equalSecret(token, config.apiKey)) {
      context.header("WWW-Authenticate", "Bearer realm=\"local-ai-platform-mcp\"");
      return context.json({ ok: false, error: "Bearer authentication is required." }, 401);
    }
    return next();
  });

  app.all("/mcp", async (context) => {
    const token = config.requireAuth ? bearerToken(context.req.header("authorization")) : "stdio-local";
    const clientId = safeClientId(context.req.header("x-mcp-client-id"));
    const parsedBody = context.get("parsedBody" as never) as unknown;
    return mcpHandler.fetch(context.req.raw, {
      parsedBody,
      authInfo: {
        token: token ? "[validated]" : "[local]",
        clientId,
        scopes: ["platform:read", "web:search"],
      },
    });
  });

  app.notFound((context) => context.json({ ok: false, error: "Not found." }, 404));

  return {
    app,
    close: () => mcpHandler.close(),
  };
}
