import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ToolAuditEvent = {
  requestId: string;
  timestamp: string;
  tool: string;
  clientId: string;
  ok: boolean;
  durationMs: number;
  errorCode: string | null;
};

export interface AuditLogger {
  write(event: ToolAuditEvent): Promise<void>;
}

export class FileAuditLogger implements AuditLogger {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async write(event: ToolAuditEvent): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
  }
}

export class NoopAuditLogger implements AuditLogger {
  async write(_event: ToolAuditEvent): Promise<void> {}
}

export async function audited<T>(
  logger: AuditLogger,
  tool: string,
  clientId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const requestId = randomUUID();
  const startedAt = performance.now();
  try {
    const result = await operation();
    await safeWrite(logger, {
      requestId,
      timestamp: new Date().toISOString(),
      tool,
      clientId,
      ok: true,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: null,
    });
    return result;
  } catch (error) {
    await safeWrite(logger, {
      requestId,
      timestamp: new Date().toISOString(),
      tool,
      clientId,
      ok: false,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: error instanceof Error ? error.name : "unknown_error",
    });
    throw error;
  }
}

export async function auditRejected(
  logger: AuditLogger,
  tool: string,
  clientId: string,
  errorCode: string,
): Promise<void> {
  await safeWrite(logger, {
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    tool,
    clientId,
    ok: false,
    durationMs: 0,
    errorCode,
  });
}

async function safeWrite(logger: AuditLogger, event: ToolAuditEvent): Promise<void> {
  try {
    await logger.write(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown audit error";
    console.error(`[platform-mcp] audit write failed: ${message}`);
  }
}
