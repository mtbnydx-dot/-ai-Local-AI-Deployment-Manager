// 07 §13.4 cross-spec check for CON-21: what the 05 exposure scanner, the
// security overview and the settings writer really produce is what the
// console draws and sends. The reports are the scanner's own goldens
// (test/golden/exposure-scan), so a new check id, node, recommendation or
// anomaly rule in 05 fails here until the console catalog has its text.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { check } from "../../console/lib/guards.js";
import * as schemas from "../../console/lib/schemas.js";
import { anomalyVars, baseUrlPatch, goLivePatches, groupCallers, mapLayout, parseBaseUrl, templateTopology, TOPOLOGIES, trustPatch } from "../../console/lib/exposure-model.js";

const require = createRequire(import.meta.url);
const exposure = require("../../lib/exposure-scan.js");
const overview = require("../../lib/security-overview.js");
const templates = require("../../lib/deploy-templates.js");
const publicConfig = require("../../lib/public-config.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), "utf8"));
const GOLDEN = (name) => readJson(HERE, "..", "golden", "exposure-scan", `${name}.json`);
const CATALOG = {
  en: readJson(HERE, "..", "..", "console", "i18n", "access", "en-US.json"),
  zh: readJson(HERE, "..", "..", "console", "i18n", "access", "zh-CN.json"),
};
const REPORTS = ["report-healthy", "report-legacy", "report-unsupported"].map((name) => [name, GOLDEN(name)]);

function hasText(key) {
  return typeof CATALOG.en[key] === "string" && typeof CATALOG.zh[key] === "string" && CATALOG.en[key] && CATALOG.zh[key];
}

test("every check the scanner can report has a title and a fix hint in both languages", () => {
  for (const id of exposure.CHECK_IDS) {
    assert.ok(hasText(`access.check.${id}`), `access.check.${id}`);
    assert.ok(hasText(`access.fix.${id}`), `access.fix.${id}`);
  }
  for (const [name, report] of REPORTS) {
    for (const check of report.checks) {
      assert.ok(hasText(check.title), `${name}: ${check.title}`);
      assert.ok(hasText(check.fix), `${name}: ${check.fix}`);
      assert.ok(exposure.STATES.includes(check.state), `${name}: state ${check.state}`);
    }
  }
});

test("every legacy recommendation the scanner can send has text in both languages", () => {
  const source = fs.readFileSync(path.join(HERE, "..", "..", "lib", "exposure-scan.js"), "utf8");
  const keys = [...new Set([...source.matchAll(/"(access\.legacy\.[a-z_]+)"/g)].map((match) => match[1]))];
  assert.ok(keys.length >= 8, `found ${keys.length} recommendation keys`);
  for (const key of keys) assert.ok(hasText(key), key);
  const findings = REPORTS.flatMap(([, report]) => report.legacy);
  assert.ok(findings.length > 0, "a golden report with legacy findings");
  for (const finding of findings) {
    assert.ok(hasText(finding.recommendation), finding.recommendation);
    assert.ok(finding.suggestedCommand, "every finding has a command to copy");
    assert.ok(["high", "medium"].includes(finding.risk));
  }
});

test("the real map has only nodes the console positions and names, and every edge survives the layout", () => {
  for (const [name, report] of REPORTS) {
    const layout = mapLayout(report.map);
    assert.equal(layout.nodes.length, report.map.nodes.length, name);
    assert.equal(layout.edges.length, report.map.edges.length, `${name}: no edge dropped`);
    assert.equal(layout.height, 430, `${name}: every node has a place on the grid`);
    for (const node of report.map.nodes) assert.ok(hasText(`public.map.node.${node.id}`), `public.map.node.${node.id}`);
    for (const edge of layout.edges) {
      assert.ok(["ok", "warn", "fail", "unknown", "manual"].includes(edge.state), edge.state);
      assert.ok(Number.isFinite(edge.x1 + edge.y1 + edge.x2 + edge.y2 + edge.mx + edge.my));
    }
  }
  const legacy = mapLayout(GOLDEN("report-legacy").map);
  assert.ok(legacy.edges.some((edge) => edge.state === "fail" && edge.evidence), "a failing edge carries its evidence");
});

test("every state the scanner reports has a label", () => {
  for (const state of exposure.STATES) assert.ok(hasText(`public.state.${state}`), state);
});

test("each anomaly rule the overview detects has a title and a detail line whose placeholders the console fills", () => {
  const found = overview.detectAnomalies({
    nowMs: Date.parse("2026-10-14T12:00:00Z"),
    keyHourly: [{ keyId: "k_a", lastHourTokens: 200_000, hourlyP95: 10_000 }],
    newCountries: [{ keyId: "k_a", country: "DE", lastSeenBefore: 0 }],
    authFailures10m: 250,
    directManagerCalls: 7,
    names: { k_a: "Alice" },
  });
  assert.deepEqual(found.map((item) => item.rule).sort(), ["auth_storm", "direct_manager_calls", "new_country", "tpm_spike"]);
  const fmt = { integer: (value) => String(value) };
  for (const item of found) {
    assert.ok(hasText(`security.rule.${item.rule}`), item.rule);
    const detail = CATALOG.en[`security.rule.${item.rule}.detail`];
    assert.ok(hasText(`security.rule.${item.rule}.detail`), `${item.rule} detail`);
    const vars = anomalyVars(item, fmt);
    for (const [, name] of detail.matchAll(/\{(\w+)\}/g)) {
      assert.ok(name in vars && vars[name] !== "" && vars[name] !== "-", `${item.rule}: {${name}} is filled`);
    }
    assert.ok(hasText(`security.severity.${item.severity === "critical" ? "critical" : "warning"}`));
  }
});

test("real ring events of both kinds group into callers", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  const events = [
    { id: 1, at: new Date(now - 60_000).toISOString(), data: { kind: "direct_manager_gateway", severity: "warning", path: "/v1/chat/completions", remoteAddress: "192.0.2.30", suppressed: 2 } },
    { id: 2, at: new Date(now - 120_000).toISOString(), data: { kind: "admin_via_proxy", severity: "warning", pathClass: "gateway", outcome: "served", headers: ["cf-connecting-ip"], lanBound: false } },
  ];
  const bus = { recent: () => ({ events }) };
  const direct = overview.ringEvents(bus, { type: "security.direct_manager_gateway" });
  const viaProxy = overview.ringEvents(bus, { type: "security.admin_via_proxy" });
  const grouped = groupCallers({ direct, viaProxy }, { now });
  assert.deepEqual(grouped.direct.map((row) => [row.address, row.path, row.count]), [["192.0.2.30", "/v1/chat/completions", 3]]);
  assert.deepEqual(grouped.viaProxy.map((row) => [row.pathClass, row.headers.join(",")]), [["gateway", "cf-connecting-ip"]]);
});

test("the console's topologies are the templates API's, and its base URL check agrees with the generator", () => {
  const offered = TOPOLOGIES.flatMap((item) => item.templates).sort();
  assert.deepEqual(offered, [...templates.TOPOLOGIES].sort());
  const parsed = parseBaseUrl("https://AI.Example.com/");
  assert.equal(parsed.ok, true);
  for (const topology of offered) {
    const plan = templates.planTemplates({ topology, baseUrl: parsed.value });
    assert.ok(Array.isArray(plan.files) && Array.isArray(plan.commands), topology);
  }
  assert.equal(templateTopology("cloudflared", "config"), "cloudflared-config");
  for (const bad of ["http://ai.example.com", "ai.example.com", "https://ai.example.com/x"]) {
    assert.equal(parseBaseUrl(bad).ok, false, bad);
  }
});

test("the settings patches the wizard sends pass the real settings writer, section by section", async () => {
  const writes = [];
  const writeSection = async (section, patch, options) => {
    writes.push({ section, patch, etag: options.etag });
    return { ok: true, etag: `e${writes.length + 1}`, changed: ["x"], restartRequired: [] };
  };
  const base = baseUrlPatch("https://ai.example.com");
  const trust = trustPatch(["127.0.0.1/32"], "172.17.0.1");
  for (const body of [base, ...goLivePatches(), trust]) {
    const result = await publicConfig.updateAccessSection(body.section, body.patch, { etag: "e1", actor: "session:test", writeSection });
    assert.equal(result.ok, true, `${body.section}: ${JSON.stringify(result.errors || result.error || "")}`);
  }
  assert.deepEqual(writes.map((write) => write.section), ["listeners", "public", "admin", "trustedProxies"]);
  assert.deepEqual(writes[0].patch, { public: { baseUrl: "https://ai.example.com" } });
  assert.equal(writes[1].patch.managersGatewayOnly, "enforce");
  assert.equal(writes[2].patch.legacyProxyGateway, "reject");
  assert.deepEqual(writes[3].patch.cidrs, ["127.0.0.1/32", "172.17.0.1/32"]);
});

test("the goldens of the real scanner pass the console's exposure guard", () => {
  for (const [name, report] of REPORTS) {
    const result = check(schemas.ExposureReportGuard, report);
    assert.deepEqual(result.errors, [], name);
    assert.equal(result.dropped, 0, name);
  }
});

test("the real security overview, built over a real store, passes the console's overview and ban guards", async () => {
  const { DatabaseSync } = require("node:sqlite");
  const { createKeysStore } = require("../../lib/keys-store.js");
  const NOW = Date.parse("2026-10-14T12:00:00Z");
  const store = createKeysStore({ DatabaseSync, file: ":memory:", now: () => new Date(NOW) });
  const { key } = store.createKey({ name: "Alice", class: "friend", scopes: ["chat"], models: ["*"], listeners: ["public"] }, { actor: "test" });
  store.upsertBan({ subject: "203.0.113.9", kind: "ip", reason: "test", source: "admin" }, { actor: "test" });
  const security = overview.createSecurityOverview({
    getStore: () => store,
    getBus: () => null,
    getConfig: () => ({ public: { managersGatewayOnly: "warn" } }),
    now: () => NOW,
    telemetry: {
      authFailures: async () => ({ series: [[NOW - 3_600_000, 4], [NOW, 9]], topIps: [{ ip: "203.0.113.9", country: "DE", count: 13 }] }),
      keyTraffic: async () => [{ keyId: key.id, requests: 3, tokens: 90 }],
      directManagerCalls: async () => 2,
    },
  });
  const answer = await security.overview({});
  const result = check(schemas.SecurityOverviewGuard, answer);
  assert.deepEqual(result.errors, []);
  assert.equal(result.dropped, 0);
  assert.equal(answer.authFailures.topIps[0].banned, true);
  assert.equal(check(schemas.BanListGuard, { ok: true, items: store.listBans({}) }).errors.length, 0);
});
