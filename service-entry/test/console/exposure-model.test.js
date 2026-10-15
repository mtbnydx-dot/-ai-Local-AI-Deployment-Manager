// CON-21: the pure model behind the Public access wizard and the Security page
// (console/lib/exposure-model.js): the base URL check, the settings patches,
// the step outcomes, the exposure map geometry, who still bypasses the entry,
// and the numbers of the Security page.

import assert from "node:assert/strict";
import test from "node:test";

import {
  anomalyVars,
  authSeries,
  badgeFor,
  banBody,
  banExpiry,
  banSubjectProblem,
  baseUrlPatch,
  fetchSecurityEvents,
  goLivePatches,
  groupCallers,
  isLive,
  mapLayout,
  parseBaseUrl,
  publicKeys,
  readSettings,
  severityBadge,
  stepOutcomes,
  stepperStates,
  summarizeChecks,
  templateTopology,
  trustPatch,
  WIZARD_STEPS,
  worseState,
} from "../../console/lib/exposure-model.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const ago = (hours) => new Date(NOW - hours * 3_600_000).toISOString();

test("the wizard has the seven steps of 05 §13.5 in order", () => {
  assert.deepEqual([...WIZARD_STEPS], ["topology", "baseUrl", "templates", "keys", "checks", "map", "golive"]);
});

test("templateTopology maps a card and its mode to the templates API value", () => {
  assert.equal(templateTopology("cloudflared", "token"), "cloudflared-token");
  assert.equal(templateTopology("cloudflared", "config"), "cloudflared-config");
  assert.equal(templateTopology("caddy"), "caddy");
  assert.equal(templateTopology("lan"), "lan");
  assert.equal(templateTopology("nonsense"), "lan");
});

test("parseBaseUrl accepts an https origin only and reports a code for everything else", () => {
  assert.deepEqual(parseBaseUrl("  https://AI.Example.com/ "), { ok: true, value: "https://ai.example.com" });
  assert.deepEqual(parseBaseUrl("https://ai.example.com:8443"), { ok: true, value: "https://ai.example.com:8443" });
  assert.equal(parseBaseUrl("").code, "required");
  assert.equal(parseBaseUrl("http://ai.example.com").code, "not_https");
  assert.equal(parseBaseUrl("ai.example.com").code, "not_https");
  assert.equal(parseBaseUrl("https://").code, "invalid");
  assert.equal(parseBaseUrl("https://user:pass@ai.example.com").code, "invalid");
  assert.equal(parseBaseUrl("https://ai.example.com/v1").code, "has_path");
  assert.equal(parseBaseUrl("https://ai.example.com/?a=1").code, "has_path");
  assert.equal(parseBaseUrl("https://localhost").code, "not_public");
  assert.equal(parseBaseUrl("https://127.0.0.5").code, "not_public");
});

test("the settings patches have the section and nesting 05 §13.1 takes", () => {
  assert.deepEqual(baseUrlPatch("https://ai.example.com"), { section: "listeners", patch: { public: { baseUrl: "https://ai.example.com" } } });
  assert.deepEqual(goLivePatches(), [
    { section: "public", patch: { managersGatewayOnly: "enforce" } },
    { section: "admin", patch: { legacyProxyGateway: "reject" } },
  ]);
});

test("trustPatch adds the observed proxy as /32 or /128 once, and refuses what is not an address", () => {
  assert.deepEqual(trustPatch(["10.0.0.0/8"], "172.17.0.1"), { section: "trustedProxies", patch: { cidrs: ["10.0.0.0/8", "172.17.0.1/32"] }, cidr: "172.17.0.1/32" });
  assert.equal(trustPatch(["172.17.0.1/32"], "172.17.0.1"), null);
  assert.equal(trustPatch([], "fd00::5").cidr, "fd00::5/128");
  assert.equal(trustPatch([], "999.1.1.1"), null);
  assert.equal(trustPatch([], "not an ip"), null);
  assert.equal(trustPatch(undefined, "172.17.0.1").patch.cidrs[0], "172.17.0.1/32");
});

test("readSettings and isLive read the sections the wizard shows", () => {
  const settings = readSettings({ etag: "e1", config: { listeners: { public: { baseUrl: "https://ai.example.com" } }, public: { managersGatewayOnly: "enforce" }, admin: { legacyProxyGateway: "reject" }, trustedProxies: { cidrs: ["127.0.0.1/32"] } } });
  assert.equal(settings.etag, "e1");
  assert.equal(settings.baseUrl, "https://ai.example.com");
  assert.equal(isLive(settings), true);
  const blank = readSettings(null);
  assert.deepEqual(blank, { etag: "", baseUrl: "", gatewayOnly: "warn", legacyGateway: "serve", cidrs: [] });
  assert.equal(isLive(blank), false);
  assert.equal(isLive({ ...settings, legacyGateway: "serve" }), false);
});

test("states: badge mapping, the worse of two, and the summary counts", () => {
  assert.deepEqual(["ok", "warn", "fail", "unknown", "manual", "x"].map(badgeFor), ["ok", "warn", "error", "unknown", "neutral", "unknown"]);
  assert.equal(worseState("ok", "warn"), "warn");
  assert.equal(worseState("fail", "warn"), "fail");
  assert.equal(worseState("unknown", "ok"), "unknown");
  assert.deepEqual(summarizeChecks([{ state: "ok" }, { state: "ok" }, { state: "fail" }, { state: "bogus" }, { state: "manual" }]), { ok: 2, warn: 0, fail: 1, unknown: 1, manual: 1 });
  assert.equal(severityBadge("critical"), "error");
  assert.equal(severityBadge("warning"), "warn");
  assert.equal(severityBadge("?"), "neutral");
});

test("publicKeys keeps active keys with the public listener that have not expired", () => {
  const keys = [
    { id: "a", name: "a", status: "active", listeners: ["public"], expiresAt: null },
    { id: "b", name: "b", status: "active", listeners: ["admin"], expiresAt: null },
    { id: "c", name: "c", status: "revoked", listeners: ["public"], expiresAt: null },
    { id: "d", name: "d", status: "active", listeners: ["public"], expiresAt: ago(1) },
    { id: "e", name: "e", status: "active", listeners: ["public", "admin"], expiresAt: new Date(NOW + 86_400_000).toISOString() },
  ];
  assert.deepEqual(publicKeys(keys, NOW).map((key) => key.id), ["a", "e"]);
  assert.deepEqual(publicKeys(undefined, NOW), []);
});

test("step outcomes and Stepper states follow what is saved, found and enforced", () => {
  const live = { baseUrl: "https://ai.example.com", gatewayOnly: "enforce", legacyGateway: "reject" };
  const open = { baseUrl: "", gatewayOnly: "warn", legacyGateway: "serve" };
  assert.deepEqual(stepOutcomes({ topology: "cloudflared", settings: open }), { topology: "done", baseUrl: "open", templates: "open", keys: "open", checks: "open", map: "open", golive: "open" });
  const all = stepOutcomes({ topology: "cloudflared", settings: live, written: true, publicKeyCount: 2, report: { checks: [{ state: "ok" }] }, mapSeen: true });
  assert.ok(Object.values(all).every((value) => value === "done"));
  assert.equal(stepOutcomes({ topology: "cloudflared", settings: live, report: { checks: [{ state: "fail" }] } }).checks, "error");
  const lan = stepOutcomes({ topology: "lan", settings: open });
  assert.equal(lan.baseUrl, "skipped");
  assert.equal(lan.templates, "done");

  const states = Object.fromEntries(stepperStates("keys", stepOutcomes({ topology: "cloudflared", settings: { ...open, baseUrl: "https://ai.example.com" } })).map((item) => [item.id, item.state]));
  assert.deepEqual(states, { topology: "done", baseUrl: "done", templates: "skipped", keys: "active", checks: "pending", map: "pending", golive: "pending" });
});

test("mapLayout places 05's eight nodes, keeps the edges with their evidence and colours a node by its worst edge", () => {
  const map = {
    nodes: [
      { id: "internet", label: "Internet", kind: "network" },
      { id: "edge", label: "Cloudflare / Caddy", kind: "proxy" },
      { id: "public", label: "PUBLIC listener", kind: "listener" },
    ],
    edges: [
      { from: "internet", to: "edge", state: "ok", evidence: "tunnel ready" },
      { from: "edge", to: "public", state: "fail", evidence: "nonce not seen" },
      { from: "edge", to: "gone", state: "warn", evidence: "dropped" },
    ],
  };
  const layout = mapLayout(map);
  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.edges.length, 2, "an edge to a missing node is dropped");
  assert.deepEqual(layout.edges.map((edge) => edge.evidence), ["tunnel ready", "nonce not seen"]);
  const byId = Object.fromEntries(layout.nodes.map((node) => [node.id, node]));
  assert.equal(byId.internet.state, "ok");
  assert.equal(byId.edge.state, "fail");
  assert.equal(byId.public.state, "fail");
  const first = layout.edges[0];
  assert.ok(first.x1 > byId.internet.x && first.x2 < byId.edge.x, "an edge leaves one box and ends at the other's border");
  assert.ok(first.mx > first.x1 && first.mx < first.x2);
  assert.deepEqual(mapLayout(null), { width: layout.width, height: layout.height, nodes: [], edges: [] });
});

test("mapLayout puts a node it does not know on an extra row and treats an odd state as unknown", () => {
  const layout = mapLayout({ nodes: [{ id: "internet" }, { id: "newcomer", label: "New" }], edges: [{ from: "internet", to: "newcomer", state: "???" }] });
  const newcomer = layout.nodes.find((node) => node.id === "newcomer");
  assert.ok(newcomer.y > 400);
  assert.ok(layout.height > 430);
  assert.equal(layout.edges[0].state, "unknown");
});

test("groupCallers counts direct and proxied callers of the last 7 days, with the calls a throttle swallowed", () => {
  const direct = [
    { id: 1, at: ago(1), type: "security.direct_manager_gateway", data: { kind: "service", path: "/v1/chat/completions", remoteAddress: "192.0.2.10", suppressed: 4 } },
    { id: 2, at: ago(30), type: "security.direct_manager_gateway", data: { kind: "service", path: "/v1/chat/completions", remoteAddress: "192.0.2.10", suppressed: 0 } },
    { id: 3, at: ago(2), type: "security.direct_manager_gateway", data: { kind: "legacy", path: "/v1/models", remoteAddress: "192.0.2.11" } },
    { id: 4, at: ago(24 * 8), type: "security.direct_manager_gateway", data: { kind: "service", path: "/old", remoteAddress: "192.0.2.12" } },
    { id: 5, at: "not a date", data: {} },
  ];
  const viaProxy = [
    { id: 6, at: ago(3), type: "security.admin_via_proxy", data: { pathClass: "gateway", outcome: "served", headers: ["x-forwarded-for"] } },
    { id: 7, at: ago(5), type: "security.admin_via_proxy", data: { pathClass: "gateway", outcome: "served", headers: ["x-forwarded-for"] } },
  ];
  const result = groupCallers({ direct, viaProxy }, { now: NOW });
  assert.equal(result.direct.length, 2, "the 8-day-old event and the one without a date are left out");
  assert.deepEqual(result.direct.map((row) => [row.address, row.kind, row.count]), [["192.0.2.10", "service", 6], ["192.0.2.11", "legacy", 1]]);
  assert.equal(result.viaProxy.length, 1);
  assert.deepEqual([result.viaProxy[0].pathClass, result.viaProxy[0].count, result.viaProxy[0].headers], ["gateway", 2, ["x-forwarded-for"]]);
  assert.equal(result.total, 3);
  assert.deepEqual(groupCallers({}, { now: NOW }), { direct: [], viaProxy: [], total: 0 });
});

test("fetchSecurityEvents follows nextCursor and stops at maxPages", async () => {
  const calls = [];
  const get = async (path, { query }) => {
    calls.push({ path, query });
    return query.cursor === "c2" ? { items: [{ id: 3 }], nextCursor: null } : query.cursor === "c1" ? { items: [{ id: 2 }], nextCursor: "c2" } : { items: [{ id: 1 }], nextCursor: "c1" };
  };
  const items = await fetchSecurityEvents(get, "direct_manager_gateway");
  assert.deepEqual(items.map((item) => item.id), [1, 2, 3]);
  assert.deepEqual(calls.map((call) => call.query.cursor), [undefined, "c1", "c2"]);
  assert.equal(calls[0].path, "/api/security/events");
  assert.equal(calls[0].query.type, "direct_manager_gateway");
  const endless = async () => ({ items: [{ id: 1 }], nextCursor: "again" });
  assert.equal((await fetchSecurityEvents(endless, "x", { maxPages: 2 })).length, 2);
  assert.deepEqual(await fetchSecurityEvents(async () => ({}), "x"), []);
});

test("authSeries reads [ms, count] pairs (or seconds) onto one sorted axis", () => {
  const series = authSeries([[NOW, 9], [NOW - 3_600_000, 3], ["x", 1], { t: Math.floor(NOW / 1000) + 3600, count: 2 }]);
  assert.deepEqual(series.values, [3, 9, 2]);
  assert.equal(series.x[1], Math.floor(NOW / 1000));
  assert.equal(series.total, 14);
  assert.deepEqual(authSeries(undefined), { x: [], values: [], total: 0 });
});

test("ban helpers: expiry from a duration, the request body and the light subject check", () => {
  assert.equal(banExpiry("forever", NOW), undefined);
  assert.equal(banExpiry("24h", NOW), new Date(NOW + 86_400_000).toISOString());
  assert.deepEqual(banBody({ subject: " 203.0.113.9 ", kind: "ip", reason: " ", duration: "forever" }, NOW), { subject: "203.0.113.9", kind: "ip" });
  assert.deepEqual(banBody({ subject: "203.0.113.0/24", kind: "cidr", reason: "scan", duration: "1h" }, NOW), { subject: "203.0.113.0/24", kind: "cidr", reason: "scan", expiresAt: new Date(NOW + 3_600_000).toISOString() });
  assert.equal(banSubjectProblem("", "ip"), "required");
  assert.equal(banSubjectProblem("203.0.113.9", "ip"), null);
  assert.equal(banSubjectProblem("2001:db8::1", "ip"), null);
  assert.equal(banSubjectProblem("203.0.113.9/24", "ip"), "invalid");
  assert.equal(banSubjectProblem("203.0.113.0", "cidr"), "invalid");
  assert.equal(banSubjectProblem("203.0.113.0/33", "cidr"), "invalid");
  assert.equal(banSubjectProblem("203.0.113.0/24", "cidr"), null);
  assert.equal(banSubjectProblem("999.0.0.1", "ip"), "invalid");
  assert.equal(banSubjectProblem("k_0123456789", "key"), null);
  assert.equal(banSubjectProblem("no spaces allowed", "key"), "invalid");
});

test("anomalyVars fills every placeholder of the four rules", () => {
  const fmt = { integer: (value) => String(value) };
  assert.deepEqual(anomalyVars({ rule: "tpm_spike", keyId: "k1", name: "Alice", detail: { lastHourTokens: 90000, hourlyP95: 12000, factor: 7.5 } }, fmt), {
    name: "Alice", tokens: "90000", p95: "12000", factor: 7.5, country: "", failures: "-", minutes: "10", calls: "-",
  });
  assert.equal(anomalyVars({ rule: "new_country", keyId: "k1", name: null, detail: { country: "DE" } }, fmt).name, "k1");
  assert.equal(anomalyVars({ rule: "auth_storm", detail: { failures: 250, windowMinutes: 10 } }, fmt).failures, "250");
  assert.equal(anomalyVars({ rule: "direct_manager_calls", detail: { calls24h: 12 } }, fmt).calls, "12");
  assert.equal(anomalyVars(null, fmt).name, "");
});
