"use strict";

// TEL-2 (docs/overhaul/04-telemetry.md §5.1, §5.2, §6.6): a manager takes its
// request identity from the verified hop v2 and falls back to `mgr_` ids when
// the call is direct. gateway-trust.js is PUB-10's and is not changed here.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// The default trust reader is built lazily from these on first use, so they are
// set before anything resolves a hop. No trust file exists there: the env token wins.
const TOKEN = "fake-trust-token-for-telemetry-hop-tests";
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tel2-hop-"));
process.env.AI_ROOT = TEMP_ROOT;
process.env.SERVICE_GATEWAY_TRUST_TOKEN = TOKEN;

const core = require("..");
const trust = require("../gateway-trust");

const REQUEST_ID = "req_abcdefghijklmnopqrst";
const PRINCIPAL = Object.freeze({ k: "key_abc123", b: "vllm-manager", c: "egg", t: "", l: "public", p: "key" });
const PATHNAME = "/serve/v1/chat/completions";

function hopHeaders(input = {}) {
  return trust.buildEntryHeaders(TOKEN, {
    method: "POST",
    pathname: PATHNAME,
    clientIp: "203.0.113.9",
    requestId: REQUEST_ID,
    principal: PRINCIPAL,
    context: { v: 1, src: "openwebui", cc: "CN" },
    ...input,
  }, Date.now());
}

function managerRequest(headers, extra = {}) {
  return {
    method: "POST",
    originalUrl: `${PATHNAME}?stream=1`,
    headers: { "user-agent": "curl/8.0", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    body: { model: "local-model", stream: true },
    ...extra,
  };
}

function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headersSent = false;
  res.writableFinished = false;
  res.write = () => { res.headersSent = true; return true; };
  res.end = () => {
    res.headersSent = true;
    res.writableFinished = true;
    res.emit("finish");
    res.emit("close");
  };
  return res;
}

function oneRow(req, res, finish) {
  const rows = [];
  core.attachServiceGatewayAccessLog(req, res, "openai", (entry) => rows.push(entry));
  finish(res);
  assert.equal(rows.length, 1);
  return rows[0];
}

test("a verified hop yields hop.requestId, principal.k and context.src in the access row", () => {
  const req = managerRequest(hopHeaders());
  assert.equal(core.ensureOpenAiGatewayRequestId(req), REQUEST_ID);
  const row = oneRow(req, fakeResponse(), (res) => { res.write("x"); res.end(); });
  assert.equal(row.requestId, REQUEST_ID);
  assert.equal(row.keyId, "key_abc123");
  assert.equal(row.sourceProgram, "openwebui");
  assert.equal(row.viaEntry, true);
  assert.equal(row.remoteAddress, "203.0.113.9");
  assert.equal(row.socketAddress, "127.0.0.1");
  assert.equal(row.clientRequestId, "");
  assert.equal(row.errorClass, "none");
  assert.ok(row.firstByteMs >= 1);
});

test("a tampered context fails the v2 verification, so the request is direct ingress", () => {
  const headers = hopHeaders();
  const forged = `v1.${Buffer.from(JSON.stringify({ v: 1, src: "claude-code", cc: "US" })).toString("base64url")}`;
  assert.notEqual(forged, headers[trust.GATEWAY_CONTEXT_HEADER]);
  const req = managerRequest({ ...headers, [trust.GATEWAY_CONTEXT_HEADER]: forged });
  const verified = trust.verifyEntryRequest(req, { token: TOKEN });
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, "signature_invalid");
  const row = oneRow(req, fakeResponse(), (res) => res.end());
  assert.equal(row.viaEntry, false);
  assert.equal(row.keyId, "");
  assert.notEqual(row.sourceProgram, "claude-code");
});

test("a context with an unknown version or bad payload is ignored without rejecting the hop", () => {
  const unknownVersion = managerRequest(hopHeaders({ context: { v: 9, src: "openwebui" } }));
  const row = oneRow(unknownVersion, fakeResponse(), (res) => res.end());
  assert.equal(row.viaEntry, true);
  assert.equal(row.requestId, REQUEST_ID);
  assert.equal(row.keyId, "key_abc123");
  assert.ok(!("sourceProgram" in row));

  const garbage = `v1.${Buffer.from("not json").toString("base64url")}`;
  const unparsable = managerRequest(hopHeaders({ context: garbage }));
  const verified = trust.verifyEntryRequest(unparsable, { token: TOKEN });
  assert.equal(verified.ok, true);
  assert.equal(verified.context, null);
  const row2 = oneRow(unparsable, fakeResponse(), (res) => res.end());
  assert.equal(row2.viaEntry, true);
  assert.ok(!("sourceProgram" in row2));
});

test("the context for the real entry shape fits in 256 bytes of JSON", () => {
  const json = JSON.stringify({ v: 1, src: "x".repeat(40), cc: "CN" });
  assert.ok(Buffer.byteLength(json) <= 256);
  const header = hopHeaders({ context: JSON.parse(json) })[trust.GATEWAY_CONTEXT_HEADER];
  assert.ok(header && header.length <= 512);
});

test("without a hop the fallback id is mgr_ and a valid client id is still honoured", () => {
  const direct = managerRequest({});
  const id = core.ensureOpenAiGatewayRequestId(direct);
  assert.match(id, /^mgr_[a-z2-7]{20}$/);
  assert.equal(core.ensureOpenAiGatewayRequestId(direct), id);

  const withClientId = managerRequest({ "x-request-id": "client-supplied.id:7" });
  assert.equal(core.ensureOpenAiGatewayRequestId(withClientId), "client-supplied.id:7");
  const row = oneRow(withClientId, fakeResponse(), (res) => res.end());
  assert.equal(row.requestId, "client-supplied.id:7");
  assert.equal(row.clientRequestId, "client-supplied.id:7");
  assert.equal(row.viaEntry, false);
  assert.equal(row.errorClass, "none");
});

test("a direct call records the legacy client id as keyId and an error class", () => {
  const req = managerRequest({}, { serviceGateway: { clientId: "legacy-client" } });
  const res = fakeResponse();
  res.statusCode = 429;
  const row = oneRow(req, res, (r) => r.end());
  assert.equal(row.keyId, "legacy-client");
  assert.equal(row.errorClass, "rate_limited");
});

test("firstByteMs stays 0 for an abort before any byte, and the status is 499", () => {
  const req = managerRequest({});
  const res = fakeResponse();
  const rows = [];
  core.attachServiceGatewayAccessLog(req, res, "openai", (entry) => rows.push(entry));
  res.emit("close");
  assert.equal(rows[0].firstByteMs, 0);
  assert.equal(rows[0].status, 499);
  assert.equal(rows[0].errorClass, "client_abort");
});

test("the TEL-2 fields are kept by the normaliser and appended to the export columns", async () => {
  const dir = fs.mkdtempSync(path.join(TEMP_ROOT, "log-"));
  const store = core.createServiceGatewayAccessLogStore({ file: path.join(dir, "access.jsonl"), host: "127.0.0.1", port: 5177 });
  await store.appendServiceGatewayAccessLog({
    at: "2026-06-14T12:00:00.000Z",
    requestId: REQUEST_ID,
    clientRequestId: "c-1",
    viaEntry: true,
    keyId: "key_abc123",
    sourceProgram: "openwebui",
    errorClass: "none",
    firstByteMs: 42,
    status: 200,
    path: PATHNAME,
  });
  const exported = await store.exportServiceGatewayAccessLogs({ format: "csv" });
  const lines = exported.text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = lines[0].split(",").map((cell) => cell.replace(/"/g, ""));
  assert.deepEqual(header.slice(0, 4), ["at", "remoteAddress", "external", "sourceProgram"]);
  assert.deepEqual(header.slice(-7), ["requestId", "terminalState", "clientRequestId", "viaEntry", "keyId", "errorClass", "firstByteMs"]);
  assert.ok(lines[1].includes("openwebui") && lines[1].includes("key_abc123") && lines[1].includes("42"));
});

test("the request-id normaliser regex is the P0 one", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "gateway-utils.js"), "utf8");
  assert.ok(source.includes('Buffer.byteLength(text, "utf8") > 128 || !/^[a-zA-Z0-9._:/-]+$/.test(text)'));
});
