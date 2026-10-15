"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEntryClient } = require("../platform/entry-client");
const { collectBlockers } = require("../platform/idle");
const { createLauncher } = require("../platform/launcher");
const { verifyMachineSignature, bodySha256Hex } = require("../internal-auth");

const KEY = "fixture-internal-key-0123456789abcdefghijklmnop";
const PROCESS = { pid: 5120, processCreatedAt: "2026-10-14T07:00:00.000Z", exe: "C:\\fixture\\bin\\node.exe", commandLine: "node server.js" };

// A fake entry that judges machine signatures the way 05's machine-auth does:
// verifyMachineSignature on the target, then the body digest. An unsigned
// request is a loopback viewer (401 on writes and on the busy probe), unless
// the entry predates PUB-5.
async function fakeEntry(t, { prePub5 = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const verified = verifyMachineSignature(req, KEY);
      const signed = verified.ok && verified.bodySha256 === bodySha256Hex(body.length ? body : undefined);
      const principal = signed ? verified.principal : null;
      seen.push({ method: req.method, url: req.url, principal, code: verified.code || null, body: body.toString("utf8") });
      const send = (status, json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (verified.ok && !signed) return send(401, { ok: false, error: { code: "internal_signature_invalid" } });
      if (!principal && !(prePub5 && req.url === "/api/manager/shutdown")) return send(401, { ok: false, error: { code: "unauthorized" } });
      if (req.method === "POST" && req.url === "/api/manager/shutdown") return send(200, { ok: true });
      if (req.method === "GET" && req.url === "/api/platform/busy") {
        if (principal !== "system:supervisor") return send(403, { ok: false });
        return send(200, { blockers: [{ kind: "download", id: "dl_fixture", title: "Fixture model", since: "2026-10-14T07:59:00.000Z" }, { kind: "requests", id: "streams", title: "2 streams" }] });
      }
      if (req.method === "POST" && req.url === "/api/session/pair-codes") {
        if (principal !== "system:cli") return send(403, { ok: false });
        return send(200, { code: "PAIR-FIXTURE", url: "http://127.0.0.1:5176/#pair=PAIR-FIXTURE", expiresAt: "2026-10-14T08:02:00.000Z" });
      }
      if (req.method === "GET" && req.url.startsWith("/api/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`id: 7\nevent: notification\ndata: ${JSON.stringify({ type: "notification", at: "2026-10-14T08:00:00.000Z", source: "entry", data: { kind: "component.failed" } })}\n\n`);
        return undefined;
      }
      return send(404, { ok: false });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, seen };
}

test("signed shutdown, busy and SSE calls verify as system:supervisor", async (t) => {
  const entry = await fakeEntry(t);
  const client = createEntryClient({ principal: "system:supervisor", baseUrl: entry.baseUrl, readKey: () => KEY });
  const shutdown = await client.request("POST", "/api/manager/shutdown");
  assert.deepEqual(shutdown, { status: 200, json: { ok: true }, signed: true });
  const busy = await client.request("GET", "/api/platform/busy");
  assert.equal(busy.status, 200);
  const envelopes = await new Promise((resolve, reject) => {
    const stream = client.events(["notification", "platform"], (envelope) => { stream.close(); resolve([envelope]); }, { client: "supervisor", onError: reject });
  });
  assert.equal(envelopes[0].type, "notification");
  assert.equal(envelopes[0].data.kind, "component.failed");
  assert.equal(envelopes[0].id, "7");
  assert.deepEqual(entry.seen.map((item) => [item.method, item.url, item.principal]), [
    ["POST", "/api/manager/shutdown", "system:supervisor"],
    ["GET", "/api/platform/busy", "system:supervisor"],
    ["GET", "/api/events?client=supervisor&types=notification,platform", "system:supervisor"],
  ]);
});

test("the pair-code call verifies as system:cli, and a tampered body is rejected", async (t) => {
  const entry = await fakeEntry(t);
  const cli = createEntryClient({ principal: "system:cli", baseUrl: entry.baseUrl, readKey: () => KEY });
  const pair = await cli.request("POST", "/api/session/pair-codes", { body: { ttlSeconds: 120 } });
  assert.equal(pair.status, 200);
  assert.equal(pair.json.code, "PAIR-FIXTURE");
  assert.equal(entry.seen[0].principal, "system:cli");
  assert.deepEqual(JSON.parse(entry.seen[0].body), { ttlSeconds: 120 });

  const tampering = createEntryClient({
    principal: "system:cli", baseUrl: entry.baseUrl, readKey: () => KEY,
    fetch: (url, init) => fetch(url, { ...init, body: JSON.stringify({ ttlSeconds: 86400 }) }),
  });
  const tampered = await tampering.request("POST", "/api/session/pair-codes", { body: { ttlSeconds: 120 } });
  assert.equal(tampered.status, 401);
  assert.ok(entry.seen.slice(1).every((item) => item.principal === null));
  assert.throws(() => createEntryClient({ principal: "system:hub-shim:vllm", baseUrl: entry.baseUrl }), /system:supervisor or system:cli/);
});

test("without the internal key: GET probes go unsigned, one unsigned shutdown is tried and logged, other writes fail", async (t) => {
  const entry = await fakeEntry(t);
  const lines = [];
  const client = createEntryClient({ principal: "system:supervisor", baseUrl: entry.baseUrl, readKey: () => "", log: (line) => lines.push(line) });
  const busy = await client.request("GET", "/api/platform/busy");
  assert.equal(busy.status, 401);
  assert.equal(busy.signed, false);
  const shutdown = await client.request("POST", "/api/manager/shutdown");
  assert.equal(shutdown.status, 401, "a PUB-5 entry refuses the unsigned stop; the launcher falls through to its kill");
  assert.deepEqual(lines, [{ code: "entry_shutdown_unsigned", path: "/api/manager/shutdown", principal: "system:supervisor" }]);
  assert.ok(!JSON.stringify(lines).includes(KEY));
  await assert.rejects(client.request("POST", "/api/session/pair-codes", { body: { ttlSeconds: 120 } }), (error) => error.code === "internal_key_unavailable");
  assert.equal(entry.seen.filter((item) => item.url === "/api/manager/shutdown").length, 1, "the unsigned shutdown is tried once");
  assert.ok(entry.seen.every((item) => item.code === "internal_signature_missing"), "no machine header is ever sent without a key");

  const old = await fakeEntry(t, { prePub5: true });
  const legacy = createEntryClient({ principal: "system:supervisor", baseUrl: old.baseUrl, readKey: () => "" });
  assert.equal((await legacy.request("POST", "/api/manager/shutdown")).status, 200);
});

test("the launcher's entry stop and the idle gate's busy probe are signed as system:supervisor", async (t) => {
  const entry = await fakeEntry(t);
  const aiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "platform-entry-client-"));
  t.after(() => fs.rmSync(aiRoot, { recursive: true, force: true }));
  const entryClient = createEntryClient({ principal: "system:supervisor", baseUrl: entry.baseUrl, readKey: () => KEY });
  let alive = true;
  let clock = Date.parse("2026-10-14T08:00:00.000Z");
  const launcher = createLauncher({
    aiRoot, entryClient, getSecrets: () => [], pollMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; alive = !entry.seen.some((item) => item.url === "/api/manager/shutdown"); },
    winproc: { processInfo: async () => (alive ? PROCESS : null), killTree: async () => { throw new Error("must not kill"); } },
  });
  const component = { id: "entry", kind: "node", stop: { strategy: "http-then-kill", http: `${entry.baseUrl}/api/manager/shutdown`, auth: "system", graceSec: 15 } };
  const stopped = await launcher.stop(component, { identity: { schemaVersion: 1, id: "entry", ...PROCESS } });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.reason, "requested");
  assert.deepEqual(entry.seen.map((item) => [item.url, item.principal]), [["/api/manager/shutdown", "system:supervisor"]]);

  const blockers = await collectBlockers({
    entryClient,
    components: [{ id: "entry", busy: { http: `${entry.baseUrl}/api/platform/busy`, parser: "entry-busy", auth: "system" } }],
  });
  assert.deepEqual(blockers, [
    { kind: "download", source: "entry", id: "dl_fixture", title: "Fixture model", since: "2026-10-14T07:59:00.000Z" },
    { kind: "requests", source: "entry", id: "streams", title: "2 streams", since: null },
  ]);
  assert.equal(entry.seen.at(-1).principal, "system:supervisor");
});

test("manager busy probes read jobs and loading instances over plain loopback and fail closed", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push([String(url), init.headers]);
    if (String(url).endsWith("/api/jobs?fields=summary")) {
      return Response.json([
        { id: "j1", type: "serve", status: "running", title: "Launch", startedAt: "2026-10-14T07:58:00.000Z" },
        { id: "j2", type: "download", status: "queued", title: "Download" },
        { id: "j3", type: "benchmark", status: "done" },
        { id: "j4", type: "automation", status: "running" },
      ]);
    }
    return Response.json({ instances: [{ id: "primary", name: "Qwen", lifecycle: { state: "loading", since: "2026-10-14T07:59:00.000Z" } }, { id: "b", lifecycle: { state: "ready" } }] });
  };
  const blockers = await collectBlockers({ fetch, components: [{ id: "vllm-manager", busy: { http: "http://127.0.0.1:5177/api/jobs?fields=summary", parser: "manager-jobs" } }] });
  assert.deepEqual(blockers.map((item) => [item.kind, item.id]), [["launch", "j1"], ["download", "j2"], ["loading", "primary"]]);
  assert.ok(requests.every(([, headers]) => !Object.keys(headers).some((name) => name.startsWith("x-ai-internal"))));
  const down = await collectBlockers({ fetch: async () => { throw new TypeError("fetch failed"); }, components: [{ id: "llama-manager", busy: { http: "http://127.0.0.1:5178/api/jobs?fields=summary", parser: "manager-jobs" } }] });
  assert.equal(down.length, 1);
  assert.equal(down[0].kind, "unknown");
  assert.equal(down[0].source, "llama-manager");
});
