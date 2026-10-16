"use strict";

// The shipped access defaults (owner decision after the overhaul): a request
// whose socket is on this machine is the owner with no pairing and no
// session, a LAN device is the owner too when ADMIN is LAN-bound, and the
// opt-outs (admin.requirePairingOnLoopback, admin.allowLanOwner,
// SERVICE_ENTRY_ALLOW_LAN_ADMIN=0) bring the pairing model back. PUBLIC never
// grants admin. Units run over the admin-auth fixture with defaults: true;
// the end-to-end part runs through the real entry with the pairing opt-out
// left off (loadEntry({ pairing: false })).

const assert = require("node:assert/strict");
const test = require("node:test");

const { LAN, fakeRequest, makeAdminAuth, reply } = require("./helpers/admin-auth-fixture");
const { loadEntry, request, serveEntry } = require("./helpers/entry-harness");

const SAME_ORIGIN = { origin: "http://127.0.0.1:5176" };
const write = (fixture, options = {}) => fixture.auth.checkManagementAccess(fakeRequest({ method: "POST", url: "/api/stop-all", ...options }), { write: true });

test("defaults: this machine is the owner with no pairing, no session and no access store", () => {
  const fixture = makeAdminAuth({ defaults: true, storeGetter: () => null });
  const who = fixture.auth.authenticate(fakeRequest());
  assert.deepEqual([who.role, who.via, who.network, who.redact, who.implicit], ["owner", "loopback", "loopback", false, true]);
  // A script with no Origin and no Sec-Fetch-Site writes as before the overhaul.
  assert.equal(write(fixture).ok, true);
  assert.equal(write(fixture, { peer: "::1" }).ok, true);
  assert.equal(fixture.auth.eventTypesFor(who), "*");
  assert.equal(fixture.auth.checkElevation(fakeRequest()), true, "an owner with nothing to unlock passes the audit elevation");
  // The session API tells the console it is the owner (no pairing screen).
  const info = fixture.auth.sessionInfo(fakeRequest());
  assert.deepEqual([info.role, info.via, info.paired], ["owner", "loopback", false]);
});

test("defaults: a browser write must be same-origin, otherwise csrf_invalid", async () => {
  const fixture = makeAdminAuth({ defaults: true });
  assert.equal(write(fixture, { headers: { ...SAME_ORIGIN, "sec-fetch-site": "same-origin" } }).ok, true, "the console's own write needs no token");
  assert.equal(write(fixture, { headers: { host: "localhost:5176", origin: "http://localhost:5176" } }).ok, true);
  for (const headers of [
    { origin: "http://evil.example.com" },
    { origin: "http://127.0.0.1:5186" },
    { origin: "http://localhost:5176" },
    { origin: "null" },
    { origin: "not a url" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { ...SAME_ORIGIN, "sec-fetch-site": "cross-site" },
  ]) {
    const refused = write(fixture, { headers });
    assert.deepEqual([refused.ok, refused.status, refused.code], [false, 403, "csrf_invalid"], JSON.stringify(headers));
  }
  // The pre-dispatch guard refuses the same request before any route runs.
  const res = reply();
  const handled = await fixture.auth.guard(fakeRequest({ method: "POST", url: "/api/stop-all", headers: { origin: "http://evil.example.com" } }), res, new URL("http://127.0.0.1:5176/api/stop-all"));
  assert.equal(handled, true);
  assert.deepEqual([res.status, res.json.error.code], [403, "csrf_invalid"]);
  // Reads are never CSRF-checked.
  assert.equal(fixture.auth.requireCsrf(fakeRequest({ headers: { origin: "http://evil.example.com" } })), true);
});

test("defaults: forwarded headers and the PUBLIC listener never make a request the owner", () => {
  const fixture = makeAdminAuth({ defaults: true, config: { lanBound: true } });
  for (const header of ["x-forwarded-for", "forwarded", "x-forwarded-host", "x-real-ip"]) {
    const loopback = fixture.auth.authenticate(fakeRequest({ headers: { [header]: "203.0.113.9" } }));
    assert.equal(loopback.role, "none", `${header} on a loopback socket`);
    const lan = fixture.auth.authenticate(fakeRequest({ peer: LAN, headers: { [header]: "127.0.0.1" } }));
    assert.equal(lan.role, "none", `${header} claiming loopback from a LAN socket`);
  }
  // A LAN socket that says it is local in its Host header is still a LAN socket.
  const lanHost = fixture.auth.authenticate(fakeRequest({ peer: LAN, headers: { host: "127.0.0.1:5176" } }));
  assert.equal(lanHost.network, "lan");
  const pub = fakeRequest({ method: "POST" });
  pub.listener = { kind: "public", lanBound: false };
  assert.equal(fixture.auth.authenticate(pub).role, "none");
  assert.equal(fixture.auth.checkManagementAccess(pub, { write: true }).ok, false);
});

test("defaults: a LAN device is the owner only on a LAN-bound ADMIN listener, and the opt-outs turn it off", () => {
  const lanBound = makeAdminAuth({ defaults: true, config: { lanBound: true } });
  const lan = lanBound.auth.authenticate(fakeRequest({ peer: LAN }));
  assert.deepEqual([lan.role, lan.via, lan.network, lan.implicit], ["owner", "lan", "lan", true]);
  assert.equal(write(lanBound, { peer: LAN }).ok, true);
  assert.equal(write(lanBound, { peer: LAN, headers: { origin: "http://evil.example.com" } }).code, "csrf_invalid");
  assert.equal(write(lanBound, { peer: LAN, headers: { host: `${LAN}:5176`, origin: `http://${LAN}:5176` } }).ok, true);

  // A loopback-bound listener has no LAN owner.
  const loopbackBound = makeAdminAuth({ defaults: true });
  assert.equal(loopbackBound.auth.authenticate(fakeRequest({ peer: LAN })).role, "viewer");
  // admin.allowLanOwner=false: LAN devices are viewers.
  const off = makeAdminAuth({ defaults: true, config: { lanBound: true, admin: { allowLanOwner: false } } });
  assert.equal(off.auth.authenticate(fakeRequest({ peer: LAN })).role, "viewer");
  assert.deepEqual([write(off, { peer: LAN }).ok, write(off, { peer: LAN }).code], [false, "admin_session_required"]);
  assert.equal(write(off).ok, true, "this machine stays the owner");
  // SERVICE_ENTRY_ALLOW_LAN_ADMIN=0 reaches the auth as lanOwnerForcedOff.
  const forcedOff = makeAdminAuth({ defaults: true, lanOwnerForcedOff: true, config: { lanBound: true } });
  assert.equal(forcedOff.auth.authenticate(fakeRequest({ peer: LAN })).role, "viewer");
  assert.throws(() => forcedOff.auth.mintPairCode({ actor: "test", lan: true }), (error) => error.code === "lan_owner_disabled");
});

test("defaults: admin.requirePairingOnLoopback brings the pairing model back on this machine", () => {
  const fixture = makeAdminAuth({ defaults: true, config: { admin: { requirePairingOnLoopback: true } } });
  assert.equal(fixture.auth.authenticate(fakeRequest()).role, "viewer");
  const refused = write(fixture);
  assert.deepEqual([refused.ok, refused.status, refused.code], [false, 401, "admin_session_required"]);
  const { code } = fixture.auth.mintPairCode({ actor: "test" });
  assert.equal(fixture.auth.pairWithCode(fakeRequest({ method: "POST" }), code).ok, true, "pairing still works");
});

test("through the entry: the console opens as the owner on this machine, a cross-origin browser write is refused, a LAN-looking peer is not the owner", async (t) => {
  const { entry } = await loadEntry({ pairing: false });
  const port = await serveEntry(t, entry);

  const session = await request(port, "/api/session");
  assert.equal(session.status, 200);
  assert.deepEqual([session.json.role, session.json.via, session.json.paired], ["owner", "loopback", false]);

  // A script (no Origin, no Sec-Fetch-Site) writes with nothing but loopback.
  const script = await request(port, "/api/session/pair-codes", { method: "POST", body: {} });
  assert.equal(script.status, 200, script.text);
  // The console's own write: same-origin Origin and Sec-Fetch-Site.
  const sameOrigin = await request(port, "/api/session/pair-codes", { method: "POST", body: {}, headers: { origin: "http://127.0.0.1:5176", "sec-fetch-site": "same-origin" } });
  assert.equal(sameOrigin.status, 200, sameOrigin.text);
  // A page on another origin, or another site without Origin, is refused.
  const crossOrigin = await request(port, "/api/session/pair-codes", { method: "POST", body: {}, headers: { origin: "http://evil.example.com" } });
  assert.equal(crossOrigin.status, 403);
  const crossSite = await request(port, "/api/session/pair-codes", { method: "POST", body: {}, headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json.error.code, "csrf_invalid");

  // A forwarded header demotes even a loopback socket; the entry is not LAN-bound, so a LAN peer is a viewer.
  const forwarded = await request(port, "/api/session/pair-codes", { method: "POST", body: {}, headers: { "x-forwarded-for": "203.0.113.5" } });
  assert.notEqual(forwarded.status, 200);
  const lan = await request(port, "/api/session/pair-codes", { method: "POST", body: {}, peer: "192.168.1.50" });
  assert.equal(lan.status, 401);
  const lanSession = await request(port, "/api/session", { peer: "192.168.1.50" });
  assert.equal(lanSession.json.role, "viewer");
});
