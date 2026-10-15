"use strict";

// The limiter wired into the entry (05 §9, PUB-9): rpm, tpm and quota answers
// with their headers on PUBLIC keys, the 401 storm ban for off-box clients (and
// never for loopback or the trusted proxy), persistence of that ban, and the
// public share gate shrinking while the owner works.
//
// The entry runs in-process against fake managers on ephemeral ports; the
// ledgers and the access store live in a temp dir.

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { listen, loadEntry, ownerSession, request } = require("./helpers/entry-harness");
const { tagListener } = require("../lib/listeners");

const servers = [];
const held = [];
let entry = null;
let adminPort = 0;
let publicPort = 0;
let holdMode = false;

// A manager that answers instantly, or holds a request whose first message
// says "hold" until its answer function is called.
function fakeManager(instances) {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    // A hop-v2 manager (05 §7.1): platform keys are only served by those.
    if (url.pathname === "/api/manager/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, gatewayTrust: { version: 2, mode: "warn" } }));
    }
    if (url.pathname === "/api/instances") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ instances }));
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const answer = () => {
        if (res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "cmpl-test", choices: [], usage: { prompt_tokens: 3, completion_tokens: fakeCompletionTokens } }));
      };
      if (holdMode && text.includes("hold")) held.push(answer);
      else answer();
    });
    return undefined;
  });
}

async function setup() {
  if (entry) return;
  const loaded = await loadEntry();
  entry = loaded.entry;
  const vllm = fakeManager([{ id: "primary", primary: true, running: true, models: [{ id: "qwen-chat" }] }]);
  const llama = fakeManager([{ id: "primary", primary: true, running: true, models: [{ id: "gemma-gguf" }] }]);
  await new Promise((resolve) => vllm.listen(Number(process.env.VLLM_MANAGER_PORT), "127.0.0.1", resolve));
  await new Promise((resolve) => llama.listen(Number(process.env.LLAMA_MANAGER_PORT), "127.0.0.1", resolve));
  const admin = http.createServer((req, res) => entry.handleRequest(req, res));
  // PUBLIC with a claimable peer address, as the ADMIN harness has.
  const handle = entry.createPublicHandler();
  const pub = http.createServer((req, res) => {
    const peer = req.headers["x-test-peer"];
    if (peer) {
      delete req.headers["x-test-peer"];
      Object.defineProperty(req.socket, "remoteAddress", { value: String(peer), configurable: true });
    }
    tagListener(req, "public", false);
    handle(req, res);
  });
  servers.push(vllm, llama, admin, pub);
  adminPort = await listen(admin);
  publicPort = await listen(pub);
}

test.after(async () => {
  holdMode = false;
  while (held.length) held.pop()();
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

const ADMIN_CHAT = "/gateway/auto/openai/v1/chat/completions";
let keySeq = 0;
function createKey(input) {
  keySeq += 1;
  return entry.getAccessStore().createKey({
    class: "friend", models: ["*"], scopes: ["models.read", "chat", "messages"], listeners: ["public", "admin"], ...input, name: `limiter key ${keySeq}`,
  }, { actor: "test" });
}

function chat(port, secret, { content = "hi", pathname = "/v1/chat/completions", body = {}, headers = {}, peer, owner } = {}) {
  return request(port, pathname, {
    method: "POST",
    peer,
    owner,
    headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...headers },
    body: { model: "qwen-chat", messages: [{ role: "user", content }], ...body },
  });
}

async function until(check, label) {
  for (let index = 0; index < 300; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a PUBLIC key's rpm is a bucket: headers on every answer, 429 rate_limit_exceeded with retry-after when empty", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const { secret } = createKey({ limits: { rpm: 2, tpm: null, maxOutputTokens: 100 } });
  const first = await chat(publicPort, secret);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.headers["x-ratelimit-limit-requests"], "2");
  assert.equal(first.headers["x-ratelimit-remaining-requests"], "1");
  assert.match(first.headers["x-ratelimit-reset-requests"], /^\d+s$/);
  assert.equal((await chat(publicPort, secret)).headers["x-ratelimit-remaining-requests"], "0");
  const refused = await chat(publicPort, secret);
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error.code, "rate_limit_exceeded");
  assert.equal(refused.json.error.type, "rate_limit_error");
  assert.equal(refused.headers["x-ratelimit-remaining-requests"], "0");
  assert.ok(Number(refused.headers["retry-after"]) >= 1);
  assert.match(refused.headers["x-request-id"], /^req_/);
});

// What the fake manager reports as used. Since PUB-11 the tpm bucket is
// settled with the real usage, so draining it takes requests that really use
// tokens.
let fakeCompletionTokens = 4;

test("tpm: request_exceeds_tpm is 400 with the token headers; ordinary requests report the bucket", async (t) => {
  await setup();
  fakeCompletionTokens = 100;
  t.after(() => { fakeCompletionTokens = 4; });
  entry.resetEntryRateLimitBuckets();
  const { secret } = createKey({ limits: { rpm: 100, tpm: 500, maxOutputTokens: 100 } });
  const served = await chat(publicPort, secret, { body: { max_tokens: 50 } });
  assert.equal(served.status, 200, served.text);
  assert.equal(served.headers["x-ratelimit-limit-tokens"], "500");
  assert.ok(Number(served.headers["x-ratelimit-remaining-tokens"]) < 500);
  const huge = await chat(publicPort, secret, { content: "word ".repeat(2000) });
  assert.equal(huge.status, 400);
  assert.equal(huge.json.error.code, "request_exceeds_tpm");
  assert.equal(huge.headers["x-ratelimit-limit-tokens"], "500");
  // Each request reserves its input plus 100 output tokens and then uses
  // them (the fake reports 100 completion tokens): the bucket runs dry.
  let drained = null;
  for (let index = 0; index < 8 && !drained; index += 1) {
    const attempt = await chat(publicPort, secret, { body: { max_tokens: 100 } });
    if (attempt.status === 429) drained = attempt;
  }
  assert.ok(drained, "the 500-token bucket is exhausted");
  assert.equal(drained.json.error.code, "tokens_rate_limit_exceeded");
  assert.ok(Number(drained.headers["retry-after"]) >= 1);
});

test("quotas: an exhausted daily cap is 429 insufficient_quota with the param and the reset as retry-after", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const { key, secret } = createKey({ limits: { rpm: 100, tpm: null, dailyTokens: 100, maxOutputTokens: 10 } });
  const open = await chat(publicPort, secret, { body: { max_tokens: 5 } });
  assert.equal(open.status, 200, open.text);
  assert.ok(open.headers["x-quota-remaining-tokens-day"], "a cap reports its headroom");
  assert.equal(open.headers["x-quota-remaining-tokens-month"], undefined, "no monthly cap, no header");
  entry.getAccessStore().addUsage(key.id, { requests: 1, inputTokens: 90, outputTokens: 20 });
  entry.getLimiter().invalidateUsage(key.id);
  const refused = await chat(publicPort, secret, { body: { max_tokens: 5 } });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error.code, "insufficient_quota");
  assert.equal(refused.json.error.type, "insufficient_quota");
  assert.equal(refused.json.error.param, "daily_tokens");
  assert.ok(Number(refused.headers["retry-after"]) >= 1);
});

test("Anthropic routes carry the anthropic-ratelimit headers and the Anthropic error shape", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const { secret } = createKey({ limits: { rpm: 1, tpm: null, maxOutputTokens: 100 } });
  const headers = { "x-api-key": secret, "anthropic-version": "2023-06-01" };
  const body = { model: "qwen-chat", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
  const served = await request(publicPort, "/v1/messages", { method: "POST", headers, body });
  assert.equal(served.status, 200, served.text);
  assert.equal(served.headers["anthropic-ratelimit-requests-limit"], "1");
  assert.equal(served.headers["anthropic-ratelimit-requests-remaining"], "0");
  assert.match(served.headers["anthropic-ratelimit-requests-reset"], /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  const refused = await request(publicPort, "/v1/messages", { method: "POST", headers, body });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.type, "error");
  assert.equal(refused.json.error.type, "rate_limit_error");
  assert.ok(Number(refused.headers["retry-after"]) >= 1);
});

test("the keyless ADMIN gateway reports its rpm headers too", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const served = await request(adminPort, "/gateway/auto/openai/v1/models");
  assert.ok([200, 503].includes(served.status), served.text);
  assert.ok(Number(served.headers["x-ratelimit-limit-requests"]) >= 1);
  assert.ok(Number(served.headers["x-ratelimit-remaining-requests"]) >= 0);
  assert.equal(served.headers["x-ratelimit-limit-tokens"], undefined, "keyless callers have no tpm bucket");
  // The owner's console session is judged per session and is not metered by tokens.
  const owner = await ownerSession(entry, adminPort);
  const session = await chat(adminPort, "", { owner, pathname: ADMIN_CHAT });
  assert.equal(session.status, 200, session.text);
  assert.ok(Number(session.headers["x-ratelimit-limit-requests"]) >= 1);
  assert.equal(session.headers["x-ratelimit-limit-tokens"], undefined);
});

test("a 401 storm from an off-box client is banned and the ban is stored; loopback and the trusted proxy never are", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const limiter = entry.getLimiter();
  const peer = "198.51.100.44";
  for (let index = 0; index < 20; index += 1) {
    const attempt = await chat(publicPort, "sk-plat-not-a-real-key", { peer });
    assert.equal(attempt.status, 401, `attempt ${index + 1}`);
  }
  const banned = await chat(publicPort, "sk-plat-not-a-real-key", { peer });
  assert.equal(banned.status, 429);
  assert.equal(banned.json.error.code, "auth_banned");
  assert.ok(Number(banned.headers["retry-after"]) > 0);
  const stored = entry.getAccessStore().listBans({}).find((ban) => ban.subject === peer);
  assert.ok(stored && stored.source === "auto" && stored.strikes === 1, "the ban is in the access store");
  assert.equal(limiter.bans.check(peer).banned, true);
  assert.ok(limiter.bans.describe().bannedCount >= 1);

  // The trusted proxy (loopback) itself: failures without a client-IP header.
  for (let index = 0; index < 25; index += 1) {
    const attempt = await chat(publicPort, "sk-plat-not-a-real-key");
    assert.equal(attempt.status, 401, `proxy attempt ${index + 1} is never an auth_banned`);
  }
  assert.equal(limiter.bans.check("127.0.0.1").banned, false);
  // Behind the proxy the real client address is what is judged.
  const viaProxy = "198.51.100.45";
  for (let index = 0; index < 20; index += 1) {
    entry.resetEntryRateLimitBuckets();
    await chat(publicPort, "sk-plat-not-a-real-key", { headers: { "cf-connecting-ip": viaProxy } });
  }
  entry.resetEntryRateLimitBuckets();
  const proxied = await chat(publicPort, "sk-plat-not-a-real-key", { headers: { "cf-connecting-ip": viaProxy } });
  assert.equal(proxied.status, 429);
  assert.equal(proxied.json.error.code, "auth_banned");
  assert.equal(limiter.bans.check("127.0.0.1").banned, false, "the proxy socket stayed unbanned");
});

test("the pre-auth bucket answers 429 ip_rate_limited before any key is looked up", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const peer = "198.51.100.90";
  let refused = null;
  for (let index = 0; index < 40 && !refused; index += 1) {
    const attempt = await request(publicPort, "/status.json", { peer });
    if (attempt.status === 429) refused = attempt;
  }
  assert.ok(refused, "the default burst of 30 is exceeded");
  assert.equal(refused.json.error.code, "ip_rate_limited");
  assert.ok(Number(refused.headers["retry-after"]) >= 1);
  const other = await request(publicPort, "/status.json", { peer: "198.51.100.91" });
  assert.notEqual(other.status, 429, "another client is not affected");
});

test("the share gate shrinks to ownerActiveMaxConcurrent while owner traffic is in flight, and recovers", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const gate = entry.getLimiter().shareGate;
  const baseline = gate.snapshot();
  assert.equal(baseline.effectiveConcurrency, baseline.maxConcurrent);
  holdMode = true;
  const friend = createKey({ limits: { rpm: 1000, tpm: null, maxOutputTokens: 100 } });
  const owner = await ownerSession(entry, adminPort);
  const pending = [];
  try {
    // The owner works through the console session on ADMIN: owner traffic.
    pending.push(chat(adminPort, "", { content: "hold owner", owner, pathname: ADMIN_CHAT }));
    await until(() => gate.snapshot().ownerActive === 1 && held.length === 1, "the owner request upstream");
    const reduced = Math.min(baseline.maxConcurrent, baseline.ownerActiveMaxConcurrent);
    assert.equal(gate.snapshot().effectiveConcurrency, reduced);
    // Public friends fill the reduced share; one more has to queue.
    for (let index = 0; index < reduced; index += 1) pending.push(chat(publicPort, friend.secret, { content: `hold public ${index}` }));
    await until(() => gate.snapshot().active === reduced, "the public share to fill");
    pending.push(chat(publicPort, friend.secret, { content: "hold queued" }));
    await until(() => gate.snapshot().queued === 1, "one public request to queue");
    assert.equal(held.length, 1 + reduced, "the queued request has not reached the upstream");
    // The owner finishes: the cap returns and the queue moves.
    held.shift()();
    await until(() => gate.snapshot().ownerActive === 0, "the owner request to end");
    assert.equal(gate.snapshot().effectiveConcurrency, baseline.maxConcurrent);
    await until(() => gate.snapshot().queued === 0 && held.length === reduced + 1, "the queued request to start");
  } finally {
    holdMode = false;
    while (held.length) held.shift()();
  }
  const answers = await Promise.all(pending);
  assert.deepEqual(answers.map((answer) => answer.status), pending.map(() => 200));
  await until(() => gate.snapshot().active === 0, "every slot to be released");
});

test("an owner-class PUBLIC key is owner traffic and is not held by the share gate", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const gate = entry.getLimiter().shareGate;
  const owner = createKey({ class: "owner", limits: { rpm: 1000 } });
  holdMode = true;
  let call;
  try {
    call = chat(publicPort, owner.secret, { content: "hold owner key" });
    await until(() => gate.snapshot().ownerActive === 1, "owner key traffic");
    assert.equal(gate.snapshot().active, 0, "it never took a public slot");
  } finally {
    holdMode = false;
    while (held.length) held.shift()();
  }
  assert.equal((await call).status, 200);
});
