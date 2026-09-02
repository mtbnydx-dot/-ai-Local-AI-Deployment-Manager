import { serve } from "@hono/node-server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { FileAuditLogger } from "./audit.js";
import { createPlatformMcpApp } from "./app.js";
import { loadConfig } from "./config.js";
import { LocalPlatformClient } from "./platform-client.js";
import { createPlatformMcpServer, SearchRateLimiter } from "./tools.js";

async function runStdio(): Promise<void> {
  const config = loadConfig({ requireApiKey: false });
  const dataSource = new LocalPlatformClient(config);
  const auditLogger = new FileAuditLogger(config.auditLogPath);
  const handle = serveStdio(
    () => createPlatformMcpServer({
      dataSource,
      auditLogger,
      maxResponseChars: config.maxResponseChars,
      defaultClientId: "stdio-local-client",
      searchRateLimiter: new SearchRateLimiter(config.searchRateLimitPerMinute),
    }),
    {
      legacy: "serve",
      onerror: (error) => console.error(`[platform-mcp] stdio protocol error: ${error.message}`),
    },
  );
  const close = () => void handle.close().finally(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

async function runHttp(): Promise<void> {
  const config = loadConfig({ requireApiKey: true });
  const dataSource = new LocalPlatformClient(config);
  const auditLogger = new FileAuditLogger(config.auditLogPath);
  const mcp = createPlatformMcpApp({ config, dataSource, auditLogger });
  const httpServer = serve({
    fetch: mcp.app.fetch,
    hostname: config.host,
    port: config.port,
  });
  console.log(`[platform-mcp] listening on http://${config.host}:${config.port}/mcp (read-only)`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await mcp.close().catch(() => {});
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

if (process.argv.includes("--stdio")) {
  await runStdio();
} else {
  await runHttp();
}
