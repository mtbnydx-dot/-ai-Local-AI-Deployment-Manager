import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Signs platform-mcp's calls to the service entry as the machine principal
 * `system:mcp` (05 §5.7). The entry then serves the viewer-registered routes
 * unredacted, also after loopback callers without credentials become viewers.
 *
 * The scheme is manager-core/internal-auth.js's machine form, reimplemented
 * here because this package does not load the CommonJS core:
 *
 *   HMAC_SHA256(token, METHOD \n pathname+search \n principal \n ts \n sha256hex(body)), base64url
 *
 * The key is the entry trust token in `<AI_ROOT>/.gateway-trust.json`, re-read
 * whenever the file changes. Without a readable token the request goes out
 * unsigned; the entry then answers it as it answers any loopback caller
 * without credentials (the redacted copy once PUB-5 lands). The token is
 * never logged and never appears in an error.
 */

export const MCP_PRINCIPAL = "system:mcp";
export const TRUST_FILE_NAME = ".gateway-trust.json";

const MACHINE_PRINCIPAL_RE = /^system:(hub-shim:(vllm|llama)|supervisor|cli|mcp)$/;

export type MachineSignatureInput = {
  method: string;
  pathWithQuery: string;
  principal: string;
  body?: string;
  now?: number;
};

export function bodySha256Hex(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

export function signInternal(
  token: string,
  fields: { method: string; path: string; principal: string; ts: string; bodySha256: string },
): string {
  return createHmac("sha256", token)
    .update([fields.method.toUpperCase(), fields.path, fields.principal, fields.ts, fields.bodySha256].join("\n"), "utf8")
    .digest("base64url");
}

/** The machine-form headers, or an empty object when the input cannot be signed. */
export function buildMachineHeaders(token: string, input: MachineSignatureInput): Record<string, string> {
  const target = String(input.pathWithQuery || "");
  if (!token || !MACHINE_PRINCIPAL_RE.test(input.principal) || !target.startsWith("/") || target.startsWith("//")) return {};
  const ts = String(input.now ?? Date.now());
  const digest = bodySha256Hex(input.body ?? "");
  return {
    "x-ai-internal-principal": input.principal,
    "x-ai-internal-ts": ts,
    "x-ai-internal-signature": signInternal(token, {
      method: input.method || "GET",
      path: target,
      principal: input.principal,
      ts,
      bodySha256: digest,
    }),
    "x-ai-internal-body-sha256": digest,
    "x-ai-internal-version": "1",
  };
}

export type TrustTokenReader = {
  /** The current token, re-read when the trust file's mtime moved. "" when unavailable. */
  read(): string;
  /** Reads the file again regardless of its mtime. */
  reload(): string;
};

export function createTrustTokenReader(aiRoot: string, fileName = TRUST_FILE_NAME): TrustTokenReader {
  const file = path.join(aiRoot, fileName);
  let cached = { token: "", mtimeMs: Number.NaN };

  function load(mtimeMs: number): string {
    let token = "";
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: unknown };
      token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
    } catch {
      token = "";
    }
    cached = { token, mtimeMs };
    return token;
  }

  function mtime(): number {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return Number.NaN;
    }
  }

  return {
    read() {
      const mtimeMs = mtime();
      if (Number.isNaN(mtimeMs)) {
        cached = { token: "", mtimeMs };
        return "";
      }
      return mtimeMs === cached.mtimeMs ? cached.token : load(mtimeMs);
    },
    reload() {
      return load(mtime());
    },
  };
}

export type SignedEntryFetchOptions = {
  entryUrl: URL;
  tokens: TrustTokenReader;
  principal?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

function requestUrl(input: Parameters<typeof fetch>[0]): URL | null {
  try {
    if (input instanceof URL) return input;
    if (typeof input === "string") return new URL(input);
    return new URL(input.url);
  } catch {
    return null;
  }
}

/**
 * A fetch that signs every request to the service entry's origin and passes
 * other requests (managers, search gateway) through untouched. A 401 to a
 * signed request re-reads the trust token and, when it changed (the entry
 * restarted), retries once.
 */
export function createSignedEntryFetch(options: SignedEntryFetchOptions): typeof fetch {
  const entryOrigin = options.entryUrl.origin;
  const principal = options.principal ?? MCP_PRINCIPAL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  return async (input, init) => {
    const url = requestUrl(input);
    if (!url || url.origin !== entryOrigin || input instanceof Request) return fetchImpl(input, init);
    const rawBody = init?.body;
    if (rawBody !== undefined && rawBody !== null && typeof rawBody !== "string") return fetchImpl(input, init);
    const body = rawBody ?? "";
    const method = String(init?.method || "GET").toUpperCase();
    const pathWithQuery = `${url.pathname}${url.search}`;
    const send = (token: string) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(buildMachineHeaders(token, { method, pathWithQuery, principal, body, now: now() }))) {
        headers.set(name, value);
      }
      return fetchImpl(input, { ...init, headers });
    };

    const token = options.tokens.read();
    if (!token) return send("");
    const response = await send(token);
    if (response.status !== 401) return response;
    const fresh = options.tokens.reload();
    if (!fresh || fresh === token) return response;
    await response.body?.cancel().catch(() => undefined);
    return send(fresh);
  };
}
