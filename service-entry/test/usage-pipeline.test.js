"use strict";

// The usage tap in the gateway pipeline and PUBLIC CORS (05 §8.2 step 15, §11,
// PUB-11): counters once per request, the tpm refund, last-used stamps, the
// telemetry identity, preflight and actual CORS.
//
// The entry runs in-process against fake managers on ephemeral-port-free
// env ports; the access store and telemetry live in a temp dir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { listen, loadEntry, request } = require("./helpers/entry-harness");

const ORIGIN = "https://app.example.com";
const servers = [];
let entry = null;
let publicPort = 0;
let dbFile = "";

const OPENAI_SSE = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "he" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: "llo" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 4 } } })}\n\n`,
  "data: [DONE]\n\n",
];
const ANTHROPIC_SSE = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 21, output_tokens: 1 } } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 9 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
];

function fakeManager(models) {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/instances") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ instances: [{ id: "primary", primary: true, running: true, models }] }));
    }
    if (url.pathname === "/api/manager/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, gatewayTrust: { version: 2, mode: "warn" } }));
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      // The upstream tries to set its own CORS: PUBLIC must drop it.
      const common = { "access-control-allow-origin": "*", "access-control-allow-credentials": "true", "access-control-allow-private-network": "true" };
      const claude = url.pathname.endsWith("/messages");
      if (body.stream) {
        res.writeHead(200, { ...common, "content-type": "text/event-stream" });
        res.end((claude ? ANTHROPIC_SSE : OPENAI_SSE).join(""));
        return;
      }
      res.writeHead(200, { ...common, "content-type": "application/json" });
      res.end(JSON.stringify(claude
        ? { type: "message", content: [], usage: { input_tokens: 15, output_tokens: 6, cache_read_input_tokens: 2 } }
        : { id: "cmpl", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
    return undefined;
  });
}

async function setup() {
  if (entry) return;
  const loaded = await loadEntry();
  entry = loaded.entry;
  dbFile = path.join(loaded.tempDir, "telemetry.sqlite");
  const vllm = fakeManager([{ id: "qwen-chat" }]);
  const llama = fakeManager([{ id: "gemma-gguf" }]);
  await new Promise((resolve) => vllm.listen(Number(process.env.VLLM_MANAGER_PORT), "127.0.0.1", resolve));
  await new Promise((resolve) => llama.listen(Number(process.env.LLAMA_MANAGER_PORT), "127.0.0.1", resolve));
  const pub = entry.createPublicServer();
  servers.push(vllm, llama, pub);
  publicPort = await listen(pub);
}

test.after(async () => {
  await entry?.stopTelemetry();
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  entry?.closeAccessStore();
  try {
    entry?.getBillingStore().close();
  } catch {
    // Already closed.
  }
});

function createKey(input) {
  const { key, secret } = entry.getAccessStore().createKey({
    class: "friend",
    models: ["*"],
    scopes: ["models.read", "chat", "messages"],
    allowedOrigins: [ORIGIN],
    ...input,
    name: input.name || "usage key",
  }, { actor: "test" });
  return { id: key.id, secret };
}

function call(key, body, { pathname = "/v1/chat/completions", headers = {}, claude = false, keepBuckets = false } = {}) {
  if (!keepBuckets) entry.resetEntryRateLimitBuckets();
  const auth = claude ? { "x-api-key": key.secret } : { authorization: `Bearer ${key.secret}` };
  return request(publicPort, pathname, { method: "POST", headers: { ...auth, ...headers }, body: { model: "auto", messages: [{ role: "user", content: "hi" }], ...body } });
}

async function usageOf(keyId, expectRequests) {
  const deadline = Date.now() + 3000;
  let usage = entry.getAccessStore().getUsage(keyId);
  while (usage.day.requests < expectRequests && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    usage = entry.getAccessStore().getUsage(keyId);
  }
  return usage;
}

function remainingTokens(answer) {
  return Number(answer.headers["x-ratelimit-remaining-tokens"]);
}

test("counters: one update per request from JSON, OpenAI SSE and Anthropic usage, with the last-used stamp", async () => {
  await setup();
  const key = createKey({ limits: { tpm: 1_000_000 } });

  const json = await call(key, {});
  assert.equal(json.status, 200);
  let usage = await usageOf(key.id, 1);
  assert.deepEqual([usage.day.requests, usage.day.inputTokens, usage.day.outputTokens, usage.day.errors], [1, 10, 5, 0]);
  assert.deepEqual([usage.month.requests, usage.month.inputTokens], [1, 10], "month and day move together");

  const sse = await call(key, { stream: true });
  assert.equal(sse.status, 200);
  assert.match(sse.text, /\[DONE\]/);
  usage = await usageOf(key.id, 2);
  assert.deepEqual([usage.day.requests, usage.day.inputTokens, usage.day.cachedInputTokens, usage.day.outputTokens], [2, 21, 4, 12]);

  const claudeStream = await call(key, { stream: true, max_tokens: 50 }, { pathname: "/v1/messages", claude: true });
  assert.equal(claudeStream.status, 200);
  usage = await usageOf(key.id, 3);
  assert.deepEqual([usage.day.requests, usage.day.inputTokens, usage.day.outputTokens], [3, 42, 21]);

  const claudeJson = await call(key, { max_tokens: 50 }, { pathname: "/v1/messages", claude: true });
  assert.equal(claudeJson.status, 200);
  usage = await usageOf(key.id, 4);
  assert.deepEqual([usage.day.requests, usage.day.inputTokens, usage.day.cachedInputTokens, usage.day.outputTokens], [4, 57, 6, 27]);

  const stored = entry.getAccessStore().getKey(key.id);
  assert.ok(stored.lastUsedAt, "touchKey stamped the key");
});

test("the tpm reservation is refunded with the real usage", async () => {
  await setup();
  const key = createKey({ limits: { tpm: 100_000 } });
  entry.resetEntryRateLimitBuckets();
  const first = await call(key, {}, { keepBuckets: true });
  assert.equal(first.status, 200);
  await usageOf(key.id, 1);
  const second = await call(key, {}, { keepBuckets: true });
  assert.equal(second.status, 200);
  // Without the refund two reservations (about 8k each) would be held; with
  // it the bucket holds the real 15 tokens of the first plus one reservation.
  const reserved = remainingTokens(first) === 100_000 ? 0 : 100_000 - remainingTokens(first);
  assert.ok(reserved > 1000, "the first request reserved the tpm estimate");
  assert.ok(remainingTokens(second) > 100_000 - reserved - 100, `remaining ${remainingTokens(second)}`);
});

test("the answer's bytes are unchanged by the tap", async () => {
  await setup();
  const key = createKey({ limits: { tpm: 1_000_000 } });
  const answer = await call(key, { stream: true });
  assert.equal(answer.text, OPENAI_SSE.join(""));
});

test("telemetry carries the principal and listener of the key request", async (t) => {
  await setup();
  const key = createKey({ limits: { tpm: 1_000_000 } });
  await entry.stopTelemetry();
  await entry.startTelemetry({
    config: { enabled: true, dbPath: dbFile, keepJsonlAccessLog: false },
    dataDir: path.dirname(dbFile),
    inProcess: true,
    jobs: { enabled: false },
    flushMs: 40,
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(() => entry.stopTelemetry());
  const marker = `usage-marker-${Date.now()}`;
  const answer = await call(key, {}, { headers: { "user-agent": marker } });
  assert.equal(answer.status, 200);
  const deadline = Date.now() + 4000;
  let rows = [];
  while (Date.now() < deadline) {
    await entry.getTelemetry()?.recorder?.flush();
    if (fs.existsSync(dbFile)) {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        rows = db.prepare("SELECT * FROM requests WHERE user_agent = ?").all(marker);
      } finally {
        db.close();
      }
    }
    if (rows.length) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key_id, key.id);
  const extra = JSON.parse(rows[0].extra);
  assert.equal(extra.principal, "key");
  assert.equal(extra.listener, "public");
});

test("a request refused before the upstream is not counted", async () => {
  await setup();
  const key = createKey({ limits: { tpm: 1_000_000 }, scopes: ["models.read"] });
  const denied = await call(key, {});
  assert.equal(denied.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(entry.getAccessStore().getUsage(key.id).day.requests, 0);
});

test("preflight: only an origin of an active key, no credentials or private-network", async () => {
  await setup();
  createKey({ name: "cors key" });
  const allowed = await request(publicPort, "/v1/chat/completions", {
    method: "OPTIONS",
    headers: {
      origin: ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type, x-stainless-os, x-stainless-lang, x-evil",
    },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers["access-control-allow-origin"], ORIGIN);
  assert.equal(allowed.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
  assert.equal(allowed.headers["access-control-max-age"], "600");
  assert.equal(allowed.headers.vary, "Origin");
  const names = allowed.headers["access-control-allow-headers"].split(",").map((item) => item.trim());
  assert.ok(["authorization", "content-type", "x-api-key", "api-key", "anthropic-api-key", "anthropic-version", "anthropic-beta", "x-stainless-os", "x-stainless-lang"].every((name) => names.includes(name)));
  assert.equal(names.includes("x-evil"), false);
  assert.equal(allowed.headers["access-control-allow-credentials"], undefined);
  assert.equal(allowed.headers["access-control-allow-private-network"], undefined);

  const denied = await request(publicPort, "/v1/chat/completions", { method: "OPTIONS", headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" } });
  assert.equal(denied.status, 204);
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
  assert.equal(denied.headers["access-control-allow-headers"], undefined);
});

test("actual requests: the key's own origins, exposed headers, the upstream's CORS dropped", async () => {
  await setup();
  const key = createKey({ limits: { tpm: 1_000_000 } });
  const listed = await call(key, {}, { headers: { origin: ORIGIN } });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers["access-control-allow-origin"], ORIGIN, "the upstream's * is replaced");
  assert.match(listed.headers["access-control-expose-headers"], /x-request-id/);
  assert.match(listed.headers["access-control-expose-headers"], /x-ratelimit-remaining-tokens/);
  assert.match(listed.headers["access-control-expose-headers"], /retry-after/);
  assert.equal(listed.headers["access-control-allow-credentials"], undefined);
  assert.equal(listed.headers["access-control-allow-private-network"], undefined);
  assert.match(listed.headers.vary, /Origin/i);

  // Another origin is refused by the key, with no allow header.
  const other = await call(key, {}, { headers: { origin: "https://other.example.com" } });
  assert.equal(other.status, 403);
  assert.equal(other.json.error.code, "origin_not_allowed");
  assert.equal(other.headers["access-control-allow-origin"], undefined);

  // No Origin (curl, SDKs) is never judged.
  const plain = await call(key, {});
  assert.equal(plain.status, 200);
  assert.equal(plain.headers["access-control-allow-origin"], undefined);

  // A key without allowed origins refuses every browser origin.
  const noOrigins = createKey({ name: "no origins", allowedOrigins: [] });
  const refused = await call(noOrigins, {}, { headers: { origin: ORIGIN } });
  assert.equal(refused.status, 403);
});
