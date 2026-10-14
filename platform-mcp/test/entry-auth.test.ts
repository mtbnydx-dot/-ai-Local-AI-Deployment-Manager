import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { buildMachineHeaders, createSignedEntryFetch, createTrustTokenReader, MCP_PRINCIPAL } from "../src/entry-auth.js";
import { LocalPlatformClient } from "../src/platform-client.js";

// The fake service entry below checks every signature with manager-core's
// verifier, the code the real entry runs (05 §5.7). This file runs from
// dist/test, three levels below the repository root.
type MachineVerification = { ok: boolean; principal?: string; bodySha256?: string; code?: string };
type InternalAuth = {
  verifyMachineSignature(req: IncomingMessage, token: string): MachineVerification;
  buildMachineHeaders(token: string, input: { method: string; pathWithQuery: string; principal: string; body?: string; now?: number }): Record<string, string>;
  bodySha256Hex(body: Buffer | string): string;
};
const requireCjs = createRequire(import.meta.url);
const currentDir = dirname(fileURLToPath(import.meta.url));
const internalAuth = requireCjs(resolve(currentDir, "..", "..", "..", "manager-core", "internal-auth.js")) as InternalAuth;

const TOKEN = "fake-entry-trust-token-for-mcp-tests-0123456789";
const ROTATED_TOKEN = "fake-entry-trust-token-after-restart-9876543210";

const FULL_FLEET = {
  ok: true,
  updatedAt: "2026-10-14T00:00:00.000Z",
  gatewayBase: "http://127.0.0.1:5176/gateway/auto/openai/v1",
  gpuMemory: { totalMb: 100, usedMb: 60, freeMb: 40, reserveMb: 10, allocatableMb: 30, warningThresholdPct: 90, gpus: [{ id: "0", totalMb: 100, usedMb: 60, freeMb: 40 }] },
  instances: [{
    id: "primary", instanceId: "primary", engine: "vllm", managerId: "vllm", containerName: "vllm-local", running: true,
    lifecycleState: "ready", status: "healthy", port: 8000,
    models: [{ id: "safe-model", root: "E:\\models\\safe", maxModelLen: 4096, capabilities: ["text"] }],
  }],
};
// What service-entry's redactFleetForViewer leaves for a caller without
// credentials once PUB-5 lands: no ports, paths, container names or URLs.
const REDACTED_FLEET = {
  ok: true,
  updatedAt: "2026-10-14T00:00:00.000Z",
  settings: { mode: "auto", reserveMb: 10, maxUtilizationPct: 90, preferEngine: "auto" },
  gpuMemory: { totalMb: 100, usedMb: 60, freeMb: 40, reserveMb: 10, allocatableMb: 30, warningThresholdPct: 90, gpus: [{ id: "0", totalMb: 100, usedMb: 60, freeMb: 40 }] },
  instances: [{
    id: "primary", fleetId: "vllm:primary", instanceId: "primary", managerId: "vllm", engine: "vllm", running: true,
    lifecycleState: "ready", status: "healthy",
    models: [{ id: "safe-model", maxModelLen: 4096, capabilities: ["text"] }],
  }],
  slots: [],
  routing: { mode: "auto", genericModelIds: ["auto"], capabilityCounts: { text: 1 } },
};

type Seen = { method: string; path: string; principal: string; code: string; signed: boolean };

function listen(server: Server): Promise<number> {
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));
}

async function unusedPort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const servers: Server[] = [];
const roots: string[] = [];
after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  })));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A service entry that, like the entry after PUB-5, serves the full fleet only to system:mcp. */
async function fakeEntry(currentToken: () => string) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const result = internalAuth.verifyMachineSignature(req, currentToken());
    const digestOk = Boolean(result.ok && result.bodySha256 === internalAuth.bodySha256Hex(raw));
    const principal = digestOk ? String(result.principal) : "";
    const code = result.ok && !digestOk ? "digest_mismatch" : String(result.code ?? "");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push({ method: String(req.method), path: url.pathname, principal, code, signed: Boolean(req.headers["x-ai-internal-signature"]) });
    // A bad signature never falls back to other credentials.
    if (!principal && code !== "internal_signature_missing") return sendJson(res, 401, { ok: false, error: { code: "internal_signature_invalid" } });
    const full = principal === MCP_PRINCIPAL;
    if (url.pathname === "/api/fleet") return sendJson(res, 200, full ? FULL_FLEET : REDACTED_FLEET);
    if (url.pathname === "/api/status") return sendJson(res, 200, { ok: true, entry: { host: "127.0.0.1", port: 5176, uptimeSeconds: 5 }, managers: [] });
    if (url.pathname === "/api/fleet/route-preview" && req.method === "POST") {
      const body = JSON.parse(raw.toString("utf8") || "{}") as { model?: string };
      return sendJson(res, 200, {
        ok: true, status: 200, error: "", message: "", capability: "text", reason: "model",
        request: { engine: "auto", protocol: "openai", path: "v1/chat/completions", requestedModel: String(body.model ?? "") },
        manager: { id: "vllm", name: "vLLM Manager", ...(full ? { port: 5177 } : {}) },
        instance: { id: "primary", instanceId: "primary", primary: true, status: "healthy" },
        model: { id: String(body.model ?? ""), capabilities: ["text"] },
      });
    }
    return sendJson(res, 404, { ok: false });
  });
  servers.push(server);
  return { port: await listen(server), seen };
}

/** A manager stand-in that records which headers reached it. */
async function fakeManager() {
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((req, res) => {
    headers.push({ ...req.headers });
    req.resume();
    sendJson(res, 200, { models: [] });
  });
  servers.push(server);
  return { port: await listen(server), headers };
}

function tempRoot(token: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-entry-auth-"));
  roots.push(root);
  if (token !== null) writeFileSync(join(root, ".gateway-trust.json"), JSON.stringify({ token }), "utf8");
  return root;
}

async function clientFor(root: string, entryPort: number, managerPort: number): Promise<LocalPlatformClient> {
  const config = loadConfig({
    requireApiKey: false,
    env: {
      AI_ROOT: root,
      PLATFORM_MCP_SERVICE_ENTRY_URL: `http://127.0.0.1:${entryPort}`,
      PLATFORM_MCP_VLLM_MANAGER_URL: `http://127.0.0.1:${managerPort}`,
      PLATFORM_MCP_LLAMA_MANAGER_URL: `http://127.0.0.1:${await unusedPort()}`,
      PLATFORM_MCP_SEARCH_GATEWAY_URL: `http://127.0.0.1:${await unusedPort()}`,
      PLATFORM_MCP_CACHE_TTL_MS: "0",
      PLATFORM_MCP_TIMEOUT_MS: "3000",
    },
  });
  // No injected http client: the default one is the signed one.
  return new LocalPlatformClient(config);
}

describe("service entry calls as system:mcp", () => {
  it("signs exactly like manager-core's machine form", () => {
    const input = { method: "POST", pathWithQuery: "/api/fleet/route-preview?x=1", principal: MCP_PRINCIPAL, body: "{\"model\":\"a\"}", now: 1760400000000 };
    assert.deepEqual(buildMachineHeaders(TOKEN, input), internalAuth.buildMachineHeaders(TOKEN, input));
    assert.deepEqual(buildMachineHeaders("", input), {}, "no token, no signature");
    assert.deepEqual(buildMachineHeaders(TOKEN, { ...input, principal: "system:root" }), {});
  });

  it("the fake entry sees system:mcp on every entry call, and managers get no signature", async () => {
    const entry = await fakeEntry(() => TOKEN);
    const manager = await fakeManager();
    const client = await clientFor(tempRoot(TOKEN), entry.port, manager.port);

    const running = await client.listRunningModels("all");
    assert.equal(running.ok, true);
    assert.equal(running.data.instances[0]?.port, 8000, "the signed call gets the full fleet");
    const preview = await client.previewRoute({ model: "safe-model", engine: "auto", protocol: "openai", capability: "text" });
    assert.equal(preview.ok, true);
    const overview = await client.getOverview();
    assert.equal(overview.data.service_entry.online, true);
    await client.listLocalModels({ engine: "vllm", inventory: "local", limit: 10, offset: 0 });

    assert.ok(entry.seen.length >= 4);
    assert.deepEqual(new Set(entry.seen.map((item) => item.principal)), new Set([MCP_PRINCIPAL]));
    assert.ok(entry.seen.some((item) => item.method === "POST" && item.path === "/api/fleet/route-preview"), "the POST body digest verified");
    assert.ok(manager.headers.length >= 1);
    for (const headers of manager.headers) {
      assert.equal(Object.keys(headers).some((name) => name.startsWith("x-ai-internal-")), false, "a manager never sees the entry signature");
    }
  });

  it("without a trust token the call goes out unsigned and the redacted fleet still parses", async () => {
    const entry = await fakeEntry(() => TOKEN);
    const manager = await fakeManager();
    const client = await clientFor(tempRoot(null), entry.port, manager.port);

    const running = await client.listRunningModels("all");
    assert.equal(running.ok, true);
    assert.equal(running.data.total_models, 1);
    const [instance] = running.data.instances;
    assert.equal(instance?.port, null);
    assert.equal(instance?.container_name, "");
    assert.equal(instance?.lifecycle_state, "ready");
    assert.deepEqual(instance?.models.map((model) => [model.id, model.max_model_len, model.capabilities]), [["safe-model", 4096, ["text"]]]);
    const gpu = await client.getGpuStatus();
    assert.equal(gpu.data.gpu?.allocatable_mb, 30);
    assert.deepEqual(entry.seen.map((item) => [item.signed, item.code]), [[false, "internal_signature_missing"], [false, "internal_signature_missing"]]);
  });

  it("follows the entry's trust file when the entry restarts with a new token", async () => {
    let expected = TOKEN;
    const entry = await fakeEntry(() => expected);
    const manager = await fakeManager();
    const root = tempRoot(TOKEN);
    const client = await clientFor(root, entry.port, manager.port);
    assert.equal((await client.listRunningModels("all")).ok, true);

    expected = ROTATED_TOKEN;
    writeFileSync(join(root, ".gateway-trust.json"), JSON.stringify({ token: ROTATED_TOKEN }), "utf8");
    const rotated = await client.listRunningModels("all");
    assert.equal(rotated.ok, true);
    assert.equal(rotated.data.instances[0]?.port, 8000);
    assert.equal(entry.seen.at(-1)?.principal, MCP_PRINCIPAL);
  });

  it("a 401 re-reads the trust token and retries once, only when the token changed", async () => {
    const sent: string[] = [];
    let current = TOKEN;
    const signedFetch = createSignedEntryFetch({
      entryUrl: new URL("http://127.0.0.1:5176"),
      // A cache that still holds the old token until it is told to reload.
      tokens: { read: () => TOKEN, reload: () => current },
      fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const signature = headers.get("x-ai-internal-signature") ?? "";
        const expectedHeaders = internalAuth.buildMachineHeaders(ROTATED_TOKEN, {
          method: "GET", pathWithQuery: "/api/fleet", principal: MCP_PRINCIPAL, body: "", now: Number(headers.get("x-ai-internal-ts")),
        });
        sent.push(signature === expectedHeaders["x-ai-internal-signature"] ? "rotated" : "stale");
        return new Response("{}", { status: signature === expectedHeaders["x-ai-internal-signature"] ? 200 : 401 });
      }) as typeof fetch,
    });
    assert.equal((await signedFetch(new URL("http://127.0.0.1:5176/api/fleet"))).status, 401, "same token: no retry");
    assert.deepEqual(sent, ["stale"]);
    current = ROTATED_TOKEN;
    assert.equal((await signedFetch(new URL("http://127.0.0.1:5176/api/fleet"))).status, 200);
    assert.deepEqual(sent, ["stale", "stale", "rotated"]);
  });

  it("passes requests to other origins through untouched", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const signedFetch = createSignedEntryFetch({
      entryUrl: new URL("http://127.0.0.1:5176"),
      tokens: { read: () => TOKEN, reload: () => TOKEN },
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    await signedFetch(new URL("http://127.0.0.1:5177/api/models"), { headers: { accept: "application/json" } });
    await signedFetch(new URL("http://127.0.0.1:5176/api/fleet?fresh=1"), { headers: { accept: "application/json" } });
    assert.equal(calls[0]?.headers.get("x-ai-internal-principal"), null);
    assert.equal(calls[1]?.headers.get("x-ai-internal-principal"), MCP_PRINCIPAL);
    assert.equal(calls[1]?.headers.get("accept"), "application/json", "the caller's headers stay");
  });

  it("treats an unreadable or missing trust file as no token, never as an error", () => {
    const root = tempRoot(TOKEN);
    const reader = createTrustTokenReader(root);
    assert.equal(reader.read(), TOKEN);
    writeFileSync(join(root, ".gateway-trust.json"), "{not json", "utf8");
    assert.equal(reader.reload(), "", "an unreadable file is no token, never an error");
    assert.equal(createTrustTokenReader(join(root, "missing")).read(), "");
  });
});
