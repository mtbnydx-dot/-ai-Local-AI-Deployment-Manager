// CON-18 (07 §6.7, 04 §11.5, §11.6): the pure parts of the Requests explorer
// and the request detail, run in Node with 04's fixtures. Rendering, the
// endpoint calls, the brush and axe are covered in a browser by
// tests/frontend/console/console-observability.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);

const FIXTURES = path.resolve(CONSOLE_DIR, "..", "..", "tests", "fixtures", "telemetry");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

const model = await load("lib/requests-model.js");
const obs = await load("lib/observability-model.js");
const schemas = await load("lib/schemas.js");
const { check } = await load("lib/guards.js");

const NOW = Date.parse("2026-10-14T12:00:00Z");
const state = (search) => obs.parseObsSearch(search);

// ---------------------------------------------------------------------------
// URL state

test("request-only filters are read from the URL, cleaned, and unusable values are dropped", () => {
  const filters = model.parseRequestFilters("?range=6h&status_class=5xx,2xx,9xx&error_class=upstream_5xx,Bad%20Class&terminal_state=failed,nope&q=req_abc123&min_ttft_ms=500&min_duration_ms=-3&min_output_tokens=12x&client_ip=192.0.2.1");
  assert.deepEqual(filters, { status_class: "5xx,2xx", error_class: "upstream_5xx", terminal_state: "failed", q: "req_abc123", min_ttft_ms: "500", client_ip: "192.0.2.1" });
  assert.deepEqual(model.parseRequestFilters(""), {});
  assert.equal(model.parseRequestFilters("?q=a b;c").q, undefined, "an id search is a request id, never free text");
  assert.equal(model.parseRequestFilters(`?q=${"a".repeat(129)}`).q, undefined);
  assert.equal(model.cleanFilter("min_ttft_ms", " 0300 "), "300");
  assert.equal(model.cleanFilter("terminal_state", "bogus"), null);
});

test("toggling a facet value adds it to the comma list and removes it again", () => {
  assert.equal(model.toggleListValue(undefined, "5xx"), "5xx");
  assert.equal(model.toggleListValue("5xx", "4xx"), "5xx,4xx");
  assert.equal(model.toggleListValue("5xx,4xx", "5xx"), "4xx");
  assert.equal(model.toggleListValue("5xx", "5xx"), null);
  assert.deepEqual(model.listValues(" a, b ,,a"), ["a", "b"]);
});

test("a filter change goes to the common filters or to the request-only parameters", () => {
  assert.deepEqual(model.filterPatch("model", "model-a"), { filters: { model: "model-a" } });
  assert.deepEqual(model.filterPatch("status_class", "5xx"), { extra: { status_class: "5xx" } });
  assert.deepEqual(model.filterPatch("min_ttft_ms", "bad"), { extra: { min_ttft_ms: null } });
  // The patch is applied by the shared view-state patcher and keeps everything else.
  const next = obs.patchObsSearch("?range=6h&model=model-a", model.filterPatch("status_class", "5xx"));
  assert.equal(next, "?range=6h&model=model-a&status_class=5xx");
  assert.equal(obs.patchObsSearch(next, model.filterPatch("status_class", null)), "?range=6h&model=model-a");
  assert.equal(model.clearRequestFilters("?range=6h&status_class=5xx&q=req_abc123&model=m"), "?range=6h&model=m");
});

// ---------------------------------------------------------------------------
// Parameters

test("the list query carries the window, the common filters, the request filters, the page size and the facet flag", () => {
  const view = state("?range=6h&model=model-a&refresh=1");
  const filters = model.parseRequestFilters("?status_class=5xx&min_ttft_ms=500");
  const query = model.requestsQuery(view, filters, NOW, { facets: true });
  assert.equal(Date.parse(query.to) - Date.parse(query.from), 6 * 3600 * 1000);
  assert.deepEqual({ ...query, from: undefined, to: undefined }, { from: undefined, to: undefined, model: "model-a", status_class: "5xx", min_ttft_ms: "500", limit: 100, facets: 1 });
  const next = model.requestsQuery(view, filters, NOW, { cursor: "abc", limit: 50 });
  assert.equal(next.cursor, "abc");
  assert.equal(next.limit, 50);
  assert.equal(next.facets, undefined);
});

test("an id search leaves the window out so older requests are found", () => {
  const query = model.requestsQuery(state("?range=1h"), { q: "req_abc123" }, NOW);
  assert.equal(query.from, undefined);
  assert.equal(query.to, undefined);
  assert.equal(query.q, "req_abc123");
});

test("the chart gets only the two list filters timeseries accepts", () => {
  assert.deepEqual(model.seriesFilters({ status_class: "5xx", error_class: "x", q: "req_abc123", min_ttft_ms: "5", terminal_state: "failed" }), { status_class: "5xx", error_class: "x" });
  assert.deepEqual(model.seriesFilters({}), {});
});

test("the export link covers the window and the filters the export accepts, and says when others are left out", () => {
  const view = state("?range=24h&model=model-a&key_id=k_1");
  const plain = model.exportLink(view, { status_class: "5xx" }, NOW);
  const url = new URL(plain.href, "http://console.test");
  assert.equal(url.pathname, "/api/telemetry/export");
  assert.deepEqual(Object.fromEntries(url.searchParams).kind, "requests");
  assert.equal(url.searchParams.get("format"), "csv");
  assert.equal(url.searchParams.get("model"), "model-a");
  assert.equal(url.searchParams.get("key_id"), "k_1");
  assert.equal(url.searchParams.get("status_class"), "5xx");
  assert.equal(Date.parse(url.searchParams.get("to")) - Date.parse(url.searchParams.get("from")), 24 * 3600 * 1000);
  assert.equal(plain.partial, false);
  assert.equal(model.exportLink(view, { terminal_state: "failed" }, NOW).partial, true);
  assert.equal(new URL(model.exportLink(view, { terminal_state: "failed" }, NOW).href, "http://console.test").searchParams.get("terminal_state"), null, "04 answers unknown_parameter to it");
});

// ---------------------------------------------------------------------------
// Answers

test("the fixture answer passes the row guard and becomes rows, a cursor and facets", () => {
  const answer = fixture("requests");
  for (const row of answer.rows) assert.equal(check(schemas.RequestRowGuard, row).ok, true);
  const page = model.requestsPage(answer);
  assert.equal(page.rows.length, 5);
  assert.equal(page.rows[0].model, "model-b");
  assert.equal(page.rows[0].status, 200);
  assert.equal(page.rows[4].terminalState, "client_abort");
  assert.equal(page.cursor, answer.nextCursor);
  assert.deepEqual(Object.keys(page.facets), ["status_class", "error_class", "model", "source_program"]);
  assert.equal(page.facetsTruncated, false);
  assert.equal(model.requestsPage({ ok: true, rows: [], nextCursor: null }).cursor, null);
  assert.equal(model.requestsPage(null).rows.length, 0);
});

test("a malformed row is dropped, numbers sent as text become numbers, and pages append without repeats", () => {
  const page = model.requestsPage({ rows: [null, { receivedAt: "x" }, { requestId: "req_1", receivedAt: "2026-10-14T11:00:00Z", ttftMs: "120", durationMs: null, status: 200 }, { requestId: 5 }] });
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].ttftMs, 120);
  assert.equal(page.rows[0].durationMs, null);
  const more = model.requestsPage({ rows: [{ requestId: "req_1", receivedAt: "x" }, { requestId: "req_2", receivedAt: "y" }] }).rows;
  assert.deepEqual(model.appendRows(page.rows, more).map((row) => row.requestId), ["req_1", "req_2"]);
});

test("facets list the most frequent values first, mark the active ones, and keep a selected value that the answer no longer counts", () => {
  const facets = fixture("requests").facets;
  const groups = model.facetGroups(facets, state("?model=model-a"), { status_class: "5xx,3xx" });
  assert.deepEqual(groups.map((group) => group.id), ["status_class", "error_class", "model", "source_program"]);
  const status = groups.find((group) => group.id === "status_class");
  assert.deepEqual(status.items.map((item) => [item.value, item.count, item.active]), [["2xx", 14, false], ["4xx", 2, false], ["5xx", 1, true], ["3xx", 0, true]]);
  assert.deepEqual(groups.find((group) => group.id === "model").items.map((item) => [item.value, item.active]), [["model-b", false], ["model-a", true]]);
  assert.deepEqual(model.facetGroups(null, state(""), {}).map((group) => group.items), [[], [], [], []]);
  const facet = model.FACETS.find((item) => item.id === "model");
  assert.deepEqual(model.facetToggle(facet, "model-b", state("?model=model-a"), {}), { filters: { model: "model-a,model-b" } });
  const status5 = model.FACETS.find((item) => item.id === "status_class");
  assert.deepEqual(model.facetToggle(status5, "5xx", state(""), { status_class: "5xx" }), { extra: { status_class: null } });
});

test("terminal states read as ok, warn or error; status classes group the HTTP status", () => {
  assert.equal(model.terminalTone("completed"), "ok");
  assert.equal(model.terminalTone("client_abort"), "warn");
  assert.equal(model.terminalTone("rejected"), "warn");
  assert.equal(model.terminalTone("failed"), "error");
  assert.equal(model.terminalTone("timeout"), "error");
  assert.equal(model.terminalTone(""), "unknown");
  assert.equal(model.statusClass(204), "2xx");
  assert.equal(model.statusClass(503), "5xx");
  assert.equal(model.statusClass(null), "none");
});

// ---------------------------------------------------------------------------
// Detail

test("the waterfall of the fixture has one segment per interval, positioned on the request's own axis", () => {
  const water = model.waterfallModel(fixture("request-detail"));
  assert.equal(water.totalMs, 800);
  assert.deepEqual(water.marks.map((mark) => [mark.mark, mark.offsetMs]), [["received", 0], ["dispatched", 3], ["headers", 140], ["first_token", 140], ["done", 800]]);
  assert.deepEqual(water.segments.map((segment) => [segment.kind, segment.durationMs]), [["queue", 3], ["upstream", 137], ["prefill", 0], ["decode", 660]]);
  const decode = water.segments[3];
  assert.equal(decode.leftPct, 17.5);
  assert.equal(decode.widthPct, 82.5);
  // The segments tile the axis: each starts where the one before ended.
  for (let at = 1; at < water.segments.length; at += 1) assert.equal(water.segments[at].startMs, water.segments[at - 1].endMs);
  const sum = water.segments.reduce((total, segment) => total + segment.widthPct, 0);
  assert.ok(Math.abs(sum - 100) < 0.05, `widths add up to ${sum}`);
});

test("a non-streamed answer ends in a response segment, an aborted one ends at its last mark, and marks given only as times are placed", () => {
  const plain = model.waterfallModel({ request: { receivedAt: "2026-10-14T11:00:00.000Z", durationMs: 500 }, timeline: [
    { at: "2026-10-14T11:00:00.000Z", mark: "received" }, { mark: "dispatched", offsetMs: 10 }, { mark: "headers", offsetMs: 480 }, { mark: "done", offsetMs: 500 },
  ] });
  assert.deepEqual(plain.segments.map((segment) => segment.kind), ["queue", "upstream", "response"]);
  const aborted = model.waterfallModel({ request: { receivedAt: "2026-10-14T11:00:00.000Z", durationMs: 900 }, timeline: [
    { at: "2026-10-14T11:00:00.000Z", mark: "received" }, { mark: "dispatched", offsetMs: 10 }, { mark: "headers", offsetMs: 100 },
  ] });
  assert.equal(aborted.totalMs, 900, "the axis is the request's duration even when the last mark is earlier");
  assert.equal(aborted.segments.length, 2);
  const byTime = model.waterfallModel({ request: { receivedAt: "2026-10-14T11:00:00.000Z" }, timeline: [
    { at: "2026-10-14T11:00:00.000Z", mark: "received" }, { at: "2026-10-14T11:00:00.250Z", mark: "first_token" }, { mark: "done", offsetMs: 1000 },
  ] });
  assert.deepEqual(byTime.marks.map((mark) => mark.offsetMs), [0, 250, 1000]);
});

test("a missing or malformed timeline gives an empty waterfall, never NaN", () => {
  for (const detail of [{}, { request: {}, timeline: null }, { request: {}, timeline: [{ mark: 5 }, null, { mark: "x" }, { mark: "done", offsetMs: -4 }] }]) {
    const water = model.waterfallModel(detail);
    assert.deepEqual(water.marks, []);
    assert.deepEqual(water.segments, []);
    assert.equal(water.totalMs, 0);
  }
  const instant = model.waterfallModel({ request: {}, timeline: [{ mark: "received", offsetMs: 0 }, { mark: "done", offsetMs: 0 }] });
  assert.equal(instant.segments[0].widthPct, 0);
  assert.ok(Number.isFinite(instant.segments[0].leftPct));
});

test("microcredit strings become exact decimal credits", () => {
  assert.equal(model.creditsText("1834"), "0.001834");
  assert.equal(model.creditsText("0"), "0");
  assert.equal(model.creditsText("1750000"), "1.75");
  assert.equal(model.creditsText("-2500000"), "-2.5");
  assert.equal(model.creditsText("12345678901234567890"), "12345678901234.56789");
  assert.equal(model.creditsText("1.5"), null);
  assert.equal(model.creditsText(null), null);
  assert.equal(model.creditsText("12abc"), null);
});

test("the billing block shows usage and reservation, and is empty for a request with neither", () => {
  assert.equal(model.billingView(null), null);
  assert.equal(model.billingView({}), null);
  const view = model.billingView({
    usage: { usageId: "usg_1", chargedMicrocredits: "0", projectedMicrocredits: "1834", usageSource: "reported", terminalState: "completed", decisionCode: "billing_shadow_allowed" },
    reservation: { enforcementMode: "shadow", decisionCode: "x", reservationMicrocredits: "4096" },
  });
  assert.deepEqual([view.usage.charged, view.usage.projected, view.reservation.reserved], ["0", "0.001834", "0.004096"]);
  assert.equal(model.billingView({ usage: null, reservation: { enforcementMode: "off" } }).usage, null);
});

test("the audit block tells locked from linked and lists the candidates with links that carry only ids", () => {
  const locked = model.auditLink(fixture("request-detail").audit);
  assert.deepEqual(locked, { unlocked: false, linkable: true, chatId: null, candidates: [] });
  const linked = model.auditLink({ unlocked: true, linkable: true, chatId: "chat-1", candidates: [{ chatId: "chat-2", title: "T", auditId: "a1", offsetSeconds: -5 }, { title: "no id" }, null] });
  assert.equal(linked.candidates.length, 1);
  assert.equal(linked.candidates[0].offsetSeconds, -5);
  assert.equal(model.conversationHref("chat-1"), "/audit/conversations?chat=chat-1");
  assert.equal(model.conversationHref("chat 2&x", "a/b"), "/audit/conversations?chat=chat+2%26x&auditId=a%2Fb");
  assert.equal(model.deploymentHref("vllm:primary"), "/deployments/vllm%3Aprimary");
  assert.equal(model.deploymentHref("vllm:primary", "config"), "/deployments/vllm%3Aprimary?tab=config");
  assert.deepEqual(model.auditLink(null), { unlocked: false, linkable: false, chatId: null, candidates: [] });
});
