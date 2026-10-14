"use strict";

// Admin sessions, pairing, CSRF and elevation (docs/overhaul/05-public.md
// §5.1-§5.6, PUB-5). Units run over an in-memory access store and a fake
// clock (helpers/admin-auth-fixture); the flip itself runs through the real
// entry (helpers/entry-harness) with its stdout and stderr captured.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const internalAuth = require("../../manager-core/internal-auth");
const { createEntrySecurity } = require("../lib/security");
const { PAIR_COMMAND_NODE, PAIR_COMMAND_PLATFORM, parseCookies, selectPairCommand } = require("../lib/admin-session");
const adminPair = require("../scripts/admin-pair");
const { LAN, TRUST_TOKEN, cookiePair, fakeRequest, makeAdminAuth, reply } = require("./helpers/admin-auth-fixture");
const { loadEntry, request, serveEntry } = require("./helpers/entry-harness");

const AUTO_PAIR_HEADERS = Object.freeze({
  host: "127.0.0.1:5176",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
});

// Pairs through a freshly minted code; returns the cookie pair and CSRF token.
function pair(fixture, { peer, lan = false } = {}) {
  const { code } = fixture.auth.mintPairCode({ actor: "test", lan });
  const result = fixture.auth.pairWithCode(fakeRequest({ method: "POST", url: "/api/session/pair", peer }), code);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { cookie: cookiePair(result.setCookie), csrfToken: result.csrfToken, setCookie: result.setCookie, sessionId: result.sessionId };
}

function sessionRequest(session, options = {}) {
  const headers = { cookie: session.cookie, ...(options.csrf === false ? {} : options.method && options.method !== "GET" ? { "x-csrf-token": options.csrf || session.csrfToken } : {}), ...(options.headers || {}) };
  return fakeRequest({ ...options, headers });
}

async function guarded(fixture, req) {
  const res = reply();
  const answered = await fixture.auth.guard(req, res, new URL(req.url, "http://127.0.0.1:5176"));
  return { answered, res, req };
}

// --- pair codes ------------------------------------------------------------------

test("pair codes are single use, expire after their TTL and pair the browser as the owner", () => {
  const fixture = makeAdminAuth();
  const minted = fixture.auth.mintPairCode({ actor: "system:cli" });
  assert.match(minted.code, /^[A-Z2-7]{10}$/);
  assert.equal(minted.url, `http://127.0.0.1:5176/#pair=${minted.code}`);
  assert.equal(minted.expiresAt, new Date(fixture.clock.now + 120_000).toISOString());

  const first = fixture.auth.pairWithCode(fakeRequest({ method: "POST" }), minted.code.toLowerCase());
  assert.equal(first.ok, true, "codes are case-insensitive");
  assert.match(first.setCookie, /^lai_admin=[a-z2-7]{26}\.[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=15552000$/);
  assert.equal(typeof first.csrfToken, "string");
  const again = fixture.auth.pairWithCode(fakeRequest({ method: "POST" }), minted.code);
  assert.deepEqual({ ok: again.ok, status: again.status, code: again.code }, { ok: false, status: 400, code: "pair_code_invalid" });

  const late = fixture.auth.mintPairCode({ actor: "system:cli", ttlSeconds: 30 });
  fixture.clock.now += 31_000;
  assert.equal(fixture.auth.pairWithCode(fakeRequest({ method: "POST" }), late.code).code, "pair_code_invalid");
  for (const bad of ["", "SHORT", "AAAAAAAAA1", null, { code: "x" }]) {
    assert.equal(fixture.auth.pairWithCode(fakeRequest({ method: "POST" }), bad).code, "pair_code_invalid");
  }
  // A proxied request never pairs.
  const proxied = fixture.auth.mintPairCode({ actor: "system:cli" });
  assert.equal(fixture.auth.pairWithCode(fakeRequest({ method: "POST", headers: { "x-forwarded-for": "203.0.113.4" } }), proxied.code).code, "pair_code_invalid");

  assert.throws(() => fixture.auth.mintPairCode({ ttlSeconds: 601 }), (error) => error.status === 400 && error.code === "invalid_request");
  assert.throws(() => fixture.auth.mintPairCode({ ttlSeconds: 0 }), (error) => error.code === "invalid_request");
});

test("the paired cookie is the owner; the session API lists and revokes sessions", async () => {
  const fixture = makeAdminAuth();
  const session = pair(fixture);
  const who = fixture.auth.authenticate(sessionRequest(session));
  assert.equal(who.role, "owner");
  assert.equal(who.via, "session");
  assert.match(who.principal, /^session:[a-z2-7]{8}$/);
  assert.equal(who.redact, false);

  const info = fixture.auth.sessionInfo(sessionRequest(session));
  assert.deepEqual({ ...info, csrfToken: undefined }, { ok: true, role: "owner", via: "session", paired: true, autoPairAvailable: false, pairCommand: PAIR_COMMAND_NODE, csrfToken: undefined });
  assert.equal(info.csrfToken, session.csrfToken);
  const anonymous = fixture.auth.sessionInfo(fakeRequest());
  assert.equal(anonymous.role, "viewer");
  assert.equal(anonymous.paired, false);
  assert.equal(Object.hasOwn(anonymous, "csrfToken"), false, "no CSRF token without a session");

  const list = fixture.auth.listSessions(sessionRequest(session));
  assert.equal(list.length, 1);
  assert.equal(list[0].current, true);
  assert.equal(Object.keys(list[0]).some((key) => /secret|hash/i.test(key)), false);

  // A tampered secret or an unknown id is no session.
  const [name, value] = session.cookie.split("=");
  const tampered = `${name}=${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
  assert.equal(fixture.auth.authenticate(fakeRequest({ headers: { cookie: tampered } })).role, "viewer");

  assert.equal(fixture.auth.revokeSession(session.sessionId, { actor: "test" }), true);
  assert.equal(fixture.auth.authenticate(sessionRequest(session)).role, "viewer");
  assert.equal(fixture.auth.revokeSession(session.sessionId, { actor: "test" }), false);
});

// --- auto-pair -------------------------------------------------------------------

test("first-run auto-pair fires only when every §5.2 condition holds, and only once", () => {
  const eligible = () => fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS } });
  const negations = {
    "a LAN socket": () => fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS }, peer: LAN }),
    "a forwarding header": () => fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS, "x-forwarded-for": "203.0.113.4" } }),
    "the PUBLIC listener": () => Object.assign(eligible(), { listener: "public" }),
    "another host": () => fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS, host: "192.168.1.10:5176" } }),
    "another port": () => fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS, host: "127.0.0.1:5186" } }),
    "a POST": () => fakeRequest({ method: "POST", url: "/", headers: { ...AUTO_PAIR_HEADERS } }),
    "another path": () => fakeRequest({ url: "/billing", headers: { ...AUTO_PAIR_HEADERS } }),
    "sec-fetch-site same-origin": () => fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS, "sec-fetch-site": "same-origin" } }),
    "sec-fetch-site cross-site": () => fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS, "sec-fetch-site": "cross-site" } }),
    "no sec-fetch-mode": () => fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS, "sec-fetch-mode": "" } }),
    "sec-fetch-dest iframe": () => fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS, "sec-fetch-dest": "iframe" } }),
  };
  for (const [label, make] of Object.entries(negations)) {
    const fixture = makeAdminAuth();
    assert.equal(fixture.auth.maybeAutoPair(make()), null, label);
    assert.ok(fixture.auth.maybeAutoPair(eligible()), `${label}: the window stays open`);
  }

  // localhost works as well as 127.0.0.1.
  assert.ok(makeAdminAuth().auth.maybeAutoPair(fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS, host: "localhost:5176" } })));

  // Once: the second eligible request does not pair again, ever.
  const once = makeAdminAuth();
  const paired = once.auth.maybeAutoPair(eligible());
  assert.match(paired.setCookie, /^lai_admin=/);
  assert.equal(once.store.getMeta("autoPairConsumed"), "1");
  assert.equal(once.auth.maybeAutoPair(eligible()), null);
  once.auth.revokeSession(once.auth.listSessions()[0].id, { actor: "test" });
  assert.equal(once.auth.maybeAutoPair(eligible()), null, "revoking the session does not reopen the window");

  // The window closes after firstRunWindowMinutes.
  const late = makeAdminAuth();
  late.clock.now += 31 * 60 * 1000;
  assert.equal(late.auth.maybeAutoPair(eligible()), null);
  assert.equal(late.auth.sessionInfo(fakeRequest()).autoPairAvailable, false);

  // Switched off in the settings.
  assert.equal(makeAdminAuth({ config: { admin: { firstRunAutoPair: false } } }).auth.maybeAutoPair(eligible()), null);

  // Any pairing closes the window.
  const coded = makeAdminAuth();
  assert.equal(coded.auth.sessionInfo(fakeRequest()).autoPairAvailable, true);
  pair(coded);
  assert.equal(coded.auth.maybeAutoPair(eligible()), null);

  // A red exposure scan for a forwarder or an exposed admin bind blocks it;
  // other findings and an unavailable scan do not.
  for (const id of ["legacy_proxy", "admin_bind"]) {
    assert.equal(makeAdminAuth({ scanState: { available: true, red: [id] } }).auth.maybeAutoPair(eligible()), null, id);
  }
  assert.ok(makeAdminAuth({ scanState: { available: true, red: ["firewall_open"] } }).auth.maybeAutoPair(eligible()));
  assert.ok(makeAdminAuth({ scanState: { available: false } }).auth.maybeAutoPair(eligible()));
});

test("the guard auto-pairs GET / and the same request is served as the owner", async () => {
  const fixture = makeAdminAuth();
  const { answered, res, req } = await guarded(fixture, fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS } }));
  assert.equal(answered, false);
  assert.match(String([].concat(res.headers["set-cookie"])[0]), /^lai_admin=.*; HttpOnly; SameSite=Strict; Path=\/; Max-Age=15552000$/);
  assert.equal(fixture.auth.authenticate(req).role, "owner");
  const second = await guarded(fixture, fakeRequest({ url: "/", headers: { ...AUTO_PAIR_HEADERS } }));
  assert.equal(second.res.headers["set-cookie"], undefined);
  assert.equal(fixture.auth.authenticate(second.req).role, "viewer");
});

// --- writes and CSRF ----------------------------------------------------------------

test("every write without an owner credential is 401 admin_session_required", async () => {
  const fixture = makeAdminAuth();
  for (const [method, url, peer] of [["POST", "/api/stop-all"], ["DELETE", "/api/keys/k_1"], ["PATCH", "/api/hub/settings"], ["POST", "/api/stop-all", LAN], ["GET", "/api/keys"]]) {
    const { answered, res } = await guarded(fixture, fakeRequest({ method, url, peer }));
    assert.equal(answered, true, `${method} ${url}`);
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.equal(res.json.error.code, "admin_session_required");
    const check = fixture.auth.checkManagementAccess(fakeRequest({ method, url, peer }), { write: true });
    assert.deepEqual([check.ok, check.status, check.code], [false, 401, "admin_session_required"]);
  }
  // A registered viewer read passes with its redaction attached.
  const viewer = await guarded(fixture, fakeRequest({ url: "/api/status" }));
  assert.equal(viewer.answered, false);
  assert.equal(typeof viewer.req.viewer.redact, "function");
  assert.equal(viewer.req.viewer.ctx.via, "loopback");
  // A browser opening an owner-only page gets the pairing page.
  const page = await guarded(fixture, fakeRequest({ url: "/api/keys", headers: { accept: "text/html" } }));
  assert.equal(page.res.status, 401);
  assert.match(page.res.headers["content-type"], /text\/html/);
  assert.match(page.res.body, /此浏览器尚未与本机控制台配对/);
  assert.match(page.res.body, /This browser is not paired with the console yet/);
  assert.ok(page.res.body.includes(PAIR_COMMAND_NODE.replace(/\\/g, "\\")));

  // admin.loopbackViewer off: loopback without credentials is nobody.
  const strict = makeAdminAuth({ config: { admin: { loopbackViewer: false } } });
  assert.equal((await guarded(strict, fakeRequest({ url: "/api/status" }))).res.status, 401);
  const lanOff = makeAdminAuth({ config: { admin: { lanAnonymousViewer: false } } });
  assert.equal((await guarded(lanOff, fakeRequest({ url: "/api/status", peer: LAN }))).res.status, 401);
});

test("a session write needs a valid x-csrf-token, else 403 csrf_invalid", async () => {
  const fixture = makeAdminAuth();
  const session = pair(fixture);
  const other = pair(fixture);
  const cases = [
    ["missing", { csrf: false }],
    ["wrong", { csrf: "not-the-token" }],
    ["another session's", { csrf: other.csrfToken }],
  ];
  for (const [label, options] of cases) {
    const req = sessionRequest(session, { method: "POST", url: "/api/stop-all", ...options });
    const { answered, res } = await guarded(fixture, req);
    assert.equal(answered, true, label);
    assert.equal(res.status, 403, label);
    assert.deepEqual(res.json.error, { code: "csrf_invalid", message: "The CSRF token is missing or stale. Reload the page and try again.", hint: "reload" }, label);
    assert.equal(fixture.auth.checkManagementAccess(sessionRequest(session, { method: "POST", url: "/api/stop-all", ...options }), { write: true }).code, "csrf_invalid");
  }
  const ok = await guarded(fixture, sessionRequest(session, { method: "POST", url: "/api/stop-all" }));
  assert.equal(ok.answered, false);
  assert.equal(fixture.auth.checkManagementAccess(ok.req, { write: true }).ok, true);
  // Reads need no token.
  assert.equal((await guarded(fixture, sessionRequest(session, { url: "/api/keys" }))).answered, false);
  assert.equal(fixture.auth.requireCsrf(sessionRequest(session, { url: "/api/keys" })), true);
});

test("the ADMIN Origin check is exact: a POST from http://127.0.0.1:5186 is rejected", (t) => {
  const aiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-origin-"));
  t.after(() => fs.rmSync(aiRoot, { recursive: true, force: true }));
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [], getLanAddress: () => "192.168.1.10", aiRoot, readSection: () => ({}) });
  const url = new URL("http://127.0.0.1:5176/api/stop-all");
  const post = (origin, extra = {}) => security.checkRequest({ method: "POST", headers: { host: "127.0.0.1:5176", origin }, socket: { remoteAddress: "127.0.0.1", ...extra } }, url);
  for (const origin of ["http://127.0.0.1:5176", "http://localhost:5176", "http://[::1]:5176", "http://192.168.1.10:5176"]) {
    assert.equal(post(origin).ok, true, origin);
  }
  for (const origin of ["http://127.0.0.1:5186", "http://localhost:3000", "https://127.0.0.1:5176", "http://127.0.0.1", "http://evil.example:5176", "null"]) {
    const result = post(origin);
    assert.equal(result.ok, false, origin);
    assert.equal(result.code, "origin_not_allowed", origin);
  }
  // The port the request arrived on also counts (a test server on port 0).
  assert.equal(post("http://127.0.0.1:41234", { localPort: 41234 }).ok, true);
  assert.equal(post("http://127.0.0.1:5186", { localPort: 41234 }).ok, false);
});

// --- LAN, tokens -------------------------------------------------------------------

test("a LAN session is the owner only with admin.allowLanOwner on a LAN-bound ADMIN", async () => {
  const fixture = makeAdminAuth();
  assert.throws(() => fixture.auth.mintPairCode({ lan: true }), (error) => error.status === 403 && error.code === "lan_owner_disabled");

  // A loopback code cannot be redeemed from the LAN.
  const loopbackCode = fixture.auth.mintPairCode({ actor: "test" });
  assert.equal(fixture.auth.pairWithCode(fakeRequest({ method: "POST", peer: LAN }), loopbackCode.code).code, "pair_code_invalid");

  fixture.setConfig({ admin: { allowLanOwner: true }, lanBound: true });
  const lanCode = fixture.auth.mintPairCode({ actor: "test", lan: true });
  assert.equal(lanCode.url, `http://192.168.1.10:5176/#pair=${lanCode.code}`);
  const paired = fixture.auth.pairWithCode(fakeRequest({ method: "POST", peer: LAN }), lanCode.code);
  assert.equal(paired.ok, true);
  const session = { cookie: cookiePair(paired.setCookie), csrfToken: paired.csrfToken };
  assert.equal(fixture.auth.authenticate(sessionRequest(session, { peer: LAN })).role, "owner");

  // The owner turns LAN owners off: the same session is a redacted viewer.
  fixture.setConfig({ admin: { allowLanOwner: false }, lanBound: true });
  const who = fixture.auth.authenticate(sessionRequest(session, { peer: LAN }));
  assert.deepEqual([who.role, who.redact], ["viewer", true]);
  const write = await guarded(fixture, sessionRequest(session, { method: "POST", url: "/api/stop-all", peer: LAN }));
  assert.equal(write.res.status, 403);
  assert.equal(write.res.json.error.code, "lan_owner_disabled");
  const read = await guarded(fixture, sessionRequest(session, { url: "/api/status", peer: LAN }));
  assert.equal(read.answered, false);
  assert.equal(read.req.viewer.ctx.via, "lan");

  // A loopback session used from a LAN socket is no owner either.
  const local = pair(fixture);
  assert.equal(fixture.auth.authenticate(sessionRequest(local, { peer: LAN })).role, "viewer");

  // With allowLanOwner but a loopback-only ADMIN, LAN codes stay off.
  fixture.setConfig({ admin: { allowLanOwner: true }, lanBound: false });
  assert.throws(() => fixture.auth.mintPairCode({ lan: true }), (error) => error.code === "lan_owner_disabled");
});

test("tool tokens carry their role, need no CSRF and stop working when revoked", async () => {
  const fixture = makeAdminAuth();
  const owner = fixture.auth.issueToolToken({ name: "backup script", role: "owner", actor: "test" });
  const viewer = fixture.auth.issueToolToken({ name: "dashboard", role: "viewer", actor: "test" });
  assert.match(owner.token, /^pat_[a-z2-7]{32}$/);
  const bearer = (token, options = {}) => fakeRequest({ ...options, headers: { authorization: `Bearer ${token}` } });

  const ownerWho = fixture.auth.authenticate(bearer(owner.token));
  assert.deepEqual([ownerWho.role, ownerWho.via, ownerWho.principal], ["owner", "token", `token:${owner.id}`]);
  assert.equal((await guarded(fixture, bearer(owner.token, { method: "POST", url: "/api/stop-all" }))).answered, false);
  assert.equal(fixture.auth.authenticate(bearer(viewer.token)).role, "viewer");
  assert.equal((await guarded(fixture, bearer(viewer.token, { method: "POST", url: "/api/stop-all" }))).res.status, 401);
  // From the LAN an owner token is a viewer unless allowLanOwner.
  assert.equal(fixture.auth.authenticate(bearer(owner.token, { peer: LAN })).role, "viewer");

  assert.equal(JSON.stringify(fixture.auth.listToolTokens()).includes(owner.token), false);
  assert.equal(fixture.auth.listToolTokens().some((item) => Object.hasOwn(item, "tokenHash")), false);
  assert.equal(fixture.auth.revokeToolToken(owner.id, { actor: "test" }), true);
  assert.equal(fixture.auth.authenticate(bearer(owner.token)).role, "viewer");
  assert.throws(() => fixture.auth.issueToolToken({ name: "x", role: "system" }), (error) => error.code === "invalid_request");
});

// --- elevation ---------------------------------------------------------------------

test("the elevation cookie is HttpOnly, SameSite=Strict, Path=/api, bound to its session and revoked with it", () => {
  const fixture = makeAdminAuth();
  const session = pair(fixture);
  const res = reply();
  const issued = fixture.auth.issueElevation(sessionRequest(session), res, { scope: "audit", ttlSeconds: 7200 });
  const line = [].concat(res.headers["set-cookie"])[0];
  assert.match(line, /^lai_elev=[a-z2-7]{26}\.[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=3600$/, "the TTL is capped at an hour");
  assert.equal(issued.expiresAt, new Date(fixture.clock.now + 3600_000).toISOString());
  const elevated = { ...session, cookie: `${session.cookie}; ${cookiePair(line)}` };
  assert.equal(fixture.auth.checkElevation(sessionRequest(elevated), "audit"), true);

  // Bound to the session: another session presenting the same cookie fails.
  const other = pair(fixture);
  assert.equal(fixture.auth.checkElevation(sessionRequest({ ...other, cookie: `${other.cookie}; ${cookiePair(line)}` }), "audit"), false);
  assert.equal(fixture.auth.checkElevation(sessionRequest(session), "audit"), false, "no cookie, no elevation");

  // Expiry.
  fixture.clock.now += 3601_000;
  assert.equal(fixture.auth.checkElevation(sessionRequest(elevated), "audit"), false);
  fixture.clock.now -= 3601_000;

  // revokeElevation ends it and clears the cookie.
  const revokeRes = reply();
  assert.equal(fixture.auth.revokeElevation(sessionRequest(elevated), revokeRes), true);
  assert.equal(fixture.auth.checkElevation(sessionRequest(elevated), "audit"), false);
  assert.match([].concat(revokeRes.headers["set-cookie"])[0], /^lai_elev=; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=0$/);

  // Logout revokes the session and its elevations and clears both cookies.
  const again = reply();
  fixture.auth.issueElevation(sessionRequest(session), again, { scope: "audit" });
  const relogged = { ...session, cookie: `${session.cookie}; ${cookiePair([].concat(again.headers["set-cookie"])[0])}` };
  assert.equal(fixture.auth.checkElevation(sessionRequest(relogged), "audit"), true);
  const out = fixture.auth.logout(sessionRequest(relogged));
  assert.equal(out.ok, true);
  assert.deepEqual(out.setCookie, [
    "lai_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    "lai_elev=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0",
  ]);
  assert.equal(fixture.auth.checkElevation(sessionRequest(relogged), "audit"), false);
  assert.equal(fixture.auth.authenticate(sessionRequest(relogged)).role, "viewer");

  // Revoking a session from the sessions page ends its elevations too.
  const third = pair(fixture);
  const thirdRes = reply();
  fixture.auth.issueElevation(sessionRequest(third), thirdRes, { scope: "audit" });
  const elevationId = cookiePair([].concat(thirdRes.headers["set-cookie"])[0]).split("=")[1].split(".")[0];
  fixture.auth.revokeSession(third.sessionId, { actor: "test" });
  assert.ok(fixture.store.admin.getElevation(elevationId).revokedAt);
});

test("tokens and machine principals cannot elevate", () => {
  const fixture = makeAdminAuth();
  const token = fixture.auth.issueToolToken({ name: "t", role: "owner", actor: "test" });
  assert.throws(() => fixture.auth.issueElevation(fakeRequest({ headers: { authorization: `Bearer ${token.token}` } }), reply(), { scope: "audit" }),
    (error) => error.status === 403 && error.code === "elevation_requires_session");
  const machine = fakeRequest();
  fixture.machineAuth.remember(machine, "system:cli");
  assert.throws(() => fixture.auth.issueElevation(machine, reply(), { scope: "audit" }), (error) => error.code === "elevation_requires_session");
  assert.throws(() => fixture.auth.issueElevation(fakeRequest(), reply(), { scope: "audit" }), (error) => error.code === "elevation_requires_session");
});

// --- the rest of the session API ------------------------------------------------------

test("pairCommand names the launcher once platform.cmd exists", () => {
  assert.equal(selectPairCommand({ aiRoot: "<AI_ROOT>", exists: () => false }), "node service-entry\\scripts\\admin-pair.js --open");
  assert.equal(selectPairCommand({ aiRoot: "<AI_ROOT>", exists: (file) => file === path.join("<AI_ROOT>", "platform.cmd") }), "platform admin pair");
  assert.equal(selectPairCommand({}), PAIR_COMMAND_NODE);
  const fixture = makeAdminAuth({ files: [path.join("<AI_ROOT>", "platform.cmd")] });
  assert.equal(fixture.auth.sessionInfo(fakeRequest()).pairCommand, PAIR_COMMAND_PLATFORM);
});

test("sessions renew at most once an hour; pairing is rate-limited per socket", async () => {
  const fixture = makeAdminAuth();
  const session = pair(fixture);
  const early = await guarded(fixture, sessionRequest(session, { url: "/api/keys" }));
  assert.equal(early.res.headers["set-cookie"], undefined);
  fixture.clock.now += 61 * 60 * 1000;
  const renewed = await guarded(fixture, sessionRequest(session, { url: "/api/keys" }));
  assert.equal([].concat(renewed.res.headers["set-cookie"])[0], `${session.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=15552000`);
  assert.equal(fixture.auth.listSessions()[0].lastSeenAt, new Date(fixture.clock.now).toISOString());

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    assert.equal((await guarded(fixture, fakeRequest({ method: "POST", url: "/api/session/pair" }))).answered, false, `attempt ${attempt}`);
  }
  const limited = await guarded(fixture, fakeRequest({ method: "POST", url: "/api/session/pair" }));
  assert.equal(limited.res.status, 429);
  assert.equal((await guarded(fixture, fakeRequest({ method: "POST", url: "/api/session/pair", peer: LAN }))).answered, false, "per socket address");
  fixture.clock.now += 61_000;
  assert.equal((await guarded(fixture, fakeRequest({ method: "POST", url: "/api/session/pair" }))).answered, false);
});

test("without an access store nobody is the owner and signed machine principals still pass", async () => {
  const fixture = makeAdminAuth({ storeGetter: () => { throw Object.assign(new Error("store offline"), { code: "access_store_unavailable" }); } });
  const forged = fakeRequest({ method: "POST", url: "/api/stop-all", headers: { cookie: `lai_admin=${"a".repeat(26)}.${"A".repeat(43)}` } });
  assert.equal((await guarded(fixture, forged)).res.status, 401);
  const body = "{}";
  const signed = fakeRequest({
    method: "POST",
    url: "/api/stop-all",
    headers: internalAuth.buildMachineHeaders(TRUST_TOKEN, { method: "POST", pathWithQuery: "/api/stop-all", principal: "system:cli", body, now: fixture.clock.now }),
  });
  const { Readable } = require("node:stream");
  const stream = Object.assign(Readable.from([Buffer.from(body)]), { method: signed.method, url: signed.url, headers: signed.headers, socket: signed.socket });
  const res = reply();
  assert.equal(await fixture.auth.guard(stream, res, new URL("http://127.0.0.1:5176/api/stop-all")), false);
  assert.equal(fixture.auth.checkManagementAccess(stream, { write: true }).ok, true);
  assert.ok(fixture.logged.some((line) => /access store is unavailable/.test(line)));
});

// --- through the real entry -------------------------------------------------------------

function captureOutput(t) {
  const chunks = [];
  const originals = { out: process.stdout.write, err: process.stderr.write };
  const tap = (original) => function write(chunk, ...rest) {
    chunks.push(String(chunk));
    return original.call(this, chunk, ...rest);
  };
  process.stdout.write = tap(originals.out);
  process.stderr.write = tap(originals.err);
  const restore = () => {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
  };
  t.after(restore);
  return { text: () => chunks.join(""), restore };
}

function signedRequest(port, token, method, pathWithQuery, principal, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  return request(port, pathWithQuery, {
    method,
    ...(body === undefined ? {} : { body: text }),
    headers: internalAuth.buildMachineHeaders(token, { method, pathWithQuery, principal, body: text, now: Date.now() }),
  });
}

test("after the flip loopback is a viewer, machine principals keep working and no secret reaches the logs", async (t) => {
  const output = captureOutput(t);
  const { entry } = await loadEntry();
  const ctx = entry.createRouteContext({ logger: console });
  const routes = await entry.mountRouteModules({ ctx });
  t.after(() => routes.close());
  const port = await serveEntry(t, entry, routes);
  const token = entry.security.getTrustToken();

  // Loopback without credentials: reads of registered routes, redacted; no writes.
  const status = await request(port, "/api/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.entry.pid, undefined, "the loopback viewer copy is redacted");
  const write = await request(port, "/api/stop-all", { method: "POST", body: {} });
  assert.equal(write.status, 401);
  assert.equal(write.json.error.code, "admin_session_required");
  assert.equal((await request(port, "/api/keys")).status, 401);
  const session = await request(port, "/api/session");
  assert.deepEqual([session.json.role, session.json.via, session.json.paired], ["viewer", "loopback", false]);

  // system:* principals and platform-mcp's GETs.
  const supervisor = await signedRequest(port, token, "GET", "/api/status", "system:supervisor");
  assert.equal(supervisor.status, 200);
  assert.equal(typeof supervisor.json.entry.pid, "number");
  assert.equal((await signedRequest(port, token, "GET", "/api/keys", "system:cli")).status, 200);
  const mcpFleet = await signedRequest(port, token, "GET", "/api/fleet", "system:mcp");
  assert.equal(mcpFleet.status, 200);
  assert.ok(Object.hasOwn(mcpFleet.json, "gatewayBase"), "system:mcp reads unredacted");
  assert.equal((await signedRequest(port, token, "GET", "/api/status", "system:mcp")).status, 200);
  assert.equal((await signedRequest(port, token, "POST", "/api/session/pair-codes", "system:supervisor", {})).json.error.code, "principal_scope_denied");

  // Pairing through the session API, as the console does.
  const minted = await signedRequest(port, token, "POST", "/api/session/pair-codes", "system:cli", { ttlSeconds: 60 });
  assert.equal(minted.status, 200, minted.text);
  const paired = await request(port, "/api/session/pair", { method: "POST", body: { code: minted.json.code } });
  assert.equal(paired.status, 200);
  const cookie = String([].concat(paired.headers["set-cookie"])[0]).split(";")[0];
  const csrf = paired.json.csrfToken;
  assert.equal((await request(port, "/api/session/pair", { method: "POST", body: { code: minted.json.code } })).json.error.code, "pair_code_invalid");
  const me = await request(port, "/api/session", { headers: { cookie } });
  assert.deepEqual([me.json.role, me.json.paired, me.json.csrfToken], ["owner", true, csrf]);
  assert.equal((await request(port, "/api/keys", { headers: { cookie } })).status, 200);
  const noCsrf = await request(port, "/api/session/pair-codes", { method: "POST", body: {}, headers: { cookie } });
  assert.deepEqual([noCsrf.status, noCsrf.json.error.code], [403, "csrf_invalid"]);
  const another = await request(port, "/api/session/pair-codes", { method: "POST", body: {}, headers: { cookie, "x-csrf-token": csrf } });
  assert.equal(another.status, 200);
  const crossPort = await request(port, "/api/session/pair-codes", { method: "POST", body: {}, headers: { cookie, "x-csrf-token": csrf, origin: "http://127.0.0.1:5186" } });
  assert.deepEqual([crossPort.status, crossPort.json.code], [403, "origin_not_allowed"]);

  // Tool tokens and the sessions list.
  const issued = await request(port, "/api/admin-tokens", { method: "POST", body: { name: "nightly", role: "owner" }, headers: { cookie, "x-csrf-token": csrf } });
  assert.equal(issued.status, 200);
  assert.match(issued.json.token, /^pat_/);
  assert.equal((await request(port, "/api/keys", { headers: { authorization: `Bearer ${issued.json.token}` } })).status, 200);
  const sessions = await request(port, "/api/session/list", { headers: { cookie } });
  assert.ok(sessions.json.items.some((item) => item.current));

  // Logout clears both cookies and ends the session.
  const out = await request(port, "/api/session/logout", { method: "POST", body: {}, headers: { cookie, "x-csrf-token": csrf } });
  assert.equal(out.status, 200);
  assert.deepEqual([].concat(out.headers["set-cookie"]).map((line) => line.split(";")[0]), ["lai_admin=", "lai_elev="]);
  assert.equal((await request(port, "/api/keys", { headers: { cookie } })).status, 401);

  output.restore();
  const logs = output.text();
  const secrets = [cookie.split("=")[1], cookie.split("=")[1].split(".")[1], csrf, minted.json.code, another.json.code, issued.json.token];
  for (const secret of secrets) assert.equal(logs.includes(secret), false, "a session secret reached stdout or stderr");
});

test("admin-pair.js prints only the #pair= URL, signed as system:cli, and --open opens it", async (t) => {
  delete process.env.SERVICE_GATEWAY_TRUST_TOKEN;
  const { entry } = await loadEntry();
  const port = await serveEntry(t, entry);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-pair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".gateway-trust.json"), JSON.stringify({ token: entry.security.getTrustToken() }), "utf8");

  const captured = () => {
    const out = { text: "", write(chunk) { out.text += chunk; return true; } };
    return out;
  };
  const stdout = captured();
  const stderr = captured();
  const opened = [];
  assert.equal(await adminPair.main(["--open", "--port", String(port), "--ai-root", root], { stdout, stderr, env: {}, openUrl: (url) => opened.push(url) }), 0, stderr.text);
  assert.match(stdout.text, /^http:\/\/127\.0\.0\.1:5176\/#pair=[A-Z2-7]{10}\n$/);
  assert.deepEqual(opened, [stdout.text.trim()]);
  assert.equal(stderr.text, "");
  // The code in the URL pairs once.
  const code = stdout.text.trim().split("#pair=")[1];
  assert.equal((await request(port, "/api/session/pair", { method: "POST", body: { code } })).status, 200);

  const direct = await adminPair.requestPairCode({ aiRoot: root, port, ttlSeconds: 30 });
  assert.match(direct.url, /#pair=[A-Z2-7]{10}$/);
  assert.equal(direct.url.endsWith(direct.code), true);

  // No trust file: nothing printed, exit 2.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "admin-pair-empty-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const quiet = captured();
  assert.equal(await adminPair.main(["--port", String(port), "--ai-root", empty], { stdout: quiet, stderr: captured(), env: {} }), 2);
  assert.equal(quiet.text, "");
  // A LAN code on a loopback entry is refused by the entry: exit 1.
  assert.equal(await adminPair.main(["--lan", "--port", String(port), "--ai-root", root], { stdout: quiet, stderr: captured(), env: {} }), 1);
  assert.equal(quiet.text, "");

  // --open on Windows hands the URL to the URL handler as one argument.
  const calls = [];
  adminPair.openUrl("http://127.0.0.1:5176/#pair=ABCDEFGHIJ", { platform: "win32", spawnFn: (command, args, options) => { calls.push({ command, args, options }); return { on() {}, unref() {} }; } });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [["rundll32", ["url.dll,FileProtocolHandler", "http://127.0.0.1:5176/#pair=ABCDEFGHIJ"]]]);
  assert.throws(() => adminPair.parseArgs(["--ttl", "601"]), /--ttl/);
});

test("parseCookies keeps the first value of each name", () => {
  assert.deepEqual([...parseCookies("a=1; lai_admin=x.y; a=2; junk; =v")], [["a", "1"], ["lai_admin", "x.y"]]);
});

