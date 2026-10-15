// CON-18 (07 §6.8, 04 §16): the pure parts of the Audit pages and the audit
// unlock, run in Node with 04's fixtures. Rendering, the two unlock modes, Lock,
// expiry, hostile Markdown and axe are covered in a browser by
// tests/frontend/console/console-audit.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);

const FIXTURES = path.resolve(CONSOLE_DIR, "..", "..", "tests", "fixtures", "telemetry");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

const model = await load("lib/audit-model.js");
const { createAuditSession } = await load("lib/audit-session.js");
const { parseMarkdown } = await load("lib/markdown.js");

// ---------------------------------------------------------------------------
// The unlock

test("the unlock keeps the expiry only in cookie mode, and the token only as a header in the degrade mode", () => {
  let now = 1_000_000;
  const session = createAuditSession({ now: () => now });
  assert.equal(session.mode(), "locked");
  assert.deepEqual(session.headers(), {});

  assert.equal(session.unlock({ ok: true, expiresAt: new Date(now + 60_000).toISOString() }), true);
  assert.equal(session.mode(), "cookie");
  assert.deepEqual(session.headers(), {}, "05's cookie rides on its own, so no header is sent");

  assert.equal(session.unlock({ ok: true, token: "fake-token", expiresAt: new Date(now + 60_000).toISOString() }), true);
  assert.equal(session.mode(), "token");
  assert.deepEqual(session.headers(), { "x-audit-session": "fake-token" });
  // Neither the state nor its JSON form exposes the token.
  assert.equal(JSON.stringify(session).includes("fake-token"), false);
  assert.equal(JSON.stringify(Object.entries(session).map(([name, value]) => [name, typeof value === "function" ? "fn" : value])).includes("fake-token"), false);

  now += 61_000;
  assert.equal(session.active(), false);
  assert.equal(session.mode(), "locked");
  assert.deepEqual(session.headers(), {});
});

test("a failed or past login leaves the session locked, and lock() forgets the token", () => {
  const now = 5_000;
  const session = createAuditSession({ now: () => now });
  assert.equal(session.unlock({ ok: false }), false);
  assert.equal(session.unlock({ ok: true, expiresAt: "not a time" }), false);
  assert.equal(session.unlock({ ok: true, token: "t", expiresAt: new Date(now - 1).toISOString() }), false);
  assert.equal(session.mode(), "locked");
  session.unlock({ ok: true, token: "t", expiresAt: new Date(now + 1000).toISOString() });
  session.lock();
  assert.equal(session.mode(), "locked");
  assert.deepEqual(session.headers(), {});
  // A new unlock without a token must not keep the old one.
  session.unlock({ ok: true, token: "old", expiresAt: new Date(now + 1000).toISOString() });
  session.unlock({ ok: true, expiresAt: new Date(now + 1000).toISOString() });
  assert.deepEqual(session.headers(), {});
});

test("pages are told when the unlock changes, once per change, and an unsubscribed page is not", () => {
  const now = 10;
  const session = createAuditSession({ now: () => now });
  let calls = 0;
  const off = session.subscribe(() => {
    calls += 1;
  });
  session.lock();
  assert.equal(calls, 0, "locking a locked session changes nothing");
  session.unlock({ ok: true, expiresAt: new Date(now + 1000).toISOString() });
  assert.equal(calls, 1);
  session.lock();
  assert.equal(calls, 2);
  session.subscribe(() => {
    throw new Error("a broken listener");
  });
  session.unlock({ ok: true, expiresAt: new Date(now + 1000).toISOString() });
  assert.equal(calls, 3, "one broken listener does not starve the others");
  off();
  session.lock();
  assert.equal(calls, 3);
});

test("only a 401 audit_session_required counts as a lost unlock", () => {
  assert.equal(model.isLockedError({ status: 401, code: "audit_session_required" }), true);
  assert.equal(model.isLockedError({ status: 401, code: "admin_session_required" }), false);
  assert.equal(model.isLockedError({ status: 403, code: "audit_session_required" }), false);
  assert.equal(model.isLockedError(null), false);
});

// ---------------------------------------------------------------------------
// Conversations

test("the search is read from the URL and becomes the documented query", () => {
  const state = model.parseChatSearch("?q=plan&user=Fixture%20User&model=model-a&archived=no&from=2026-10-01&to=2026-10-14&chat=chat-1&auditId=a1");
  assert.deepEqual(state.filters, { q: "plan", user: "Fixture User", model: "model-a", archived: "no", from: "2026-10-01", to: "2026-10-14" });
  assert.equal(state.chat, "chat-1");
  assert.equal(state.auditId, "a1");
  const query = model.chatsQuery(state.filters);
  assert.deepEqual({ ...query, from: undefined, to: undefined }, { limit: 50, q: "plan", user: "Fixture User", model: "model-a", archived: "false", from: undefined, to: undefined });
  assert.ok(Date.parse(query.from) < Date.parse(query.to));
  // `to` is the end of that day: 2026-10-01 .. 2026-10-14 spans 14 days (a DST change can move an hour).
  const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000;
  assert.ok(days > 13.9 && days < 14.1, String(days));
  assert.equal(model.chatsQuery({ archived: "yes" }, { cursor: "c", limit: 10 }).archived, "true");
  assert.equal(model.chatsQuery({}, { cursor: "c" }).cursor, "c");
  assert.equal("archived" in model.chatsQuery({}), false);
});

test("a bad day, an unknown archived value and an auditId without a chat are ignored", () => {
  const state = model.parseChatSearch("?from=yesterday&to=2026-13-45&archived=maybe&auditId=a1&q=%20");
  assert.deepEqual(state.filters, {});
  assert.equal(state.chat, null);
  assert.equal(state.auditId, null);
  assert.equal(model.parseChatSearch(`?q=${"x".repeat(500)}`).filters.q.length, 200);
});

test("patching the search sets, removes and keeps parameters", () => {
  assert.equal(model.patchChatSearch("?q=a&chat=c1", { chat: null, user: "u" }), "?q=a&user=u");
  assert.equal(model.patchChatSearch("", { q: "" }), "");
  assert.equal(model.patchChatSearch("?range=7d", { chat: "c" }), "?range=7d&chat=c");
});

test("the chat list fixture becomes rows with a cursor, and a malformed row is dropped", () => {
  const page = model.chatsPage(fixture("audit-chats"));
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0].chatId, "chat-2");
  assert.deepEqual(page.rows[0].models, ["model-b"]);
  assert.equal(page.cursor, null);
  assert.equal(page.building, false);
  const next = model.chatsPage({ rows: [{ chatId: "c" }, { title: "no id" }, null], nextCursor: "n", index: { building: true } });
  assert.equal(next.rows.length, 1);
  assert.equal(next.cursor, "n");
  assert.equal(next.building, true);
});

test("a thread is ordered oldest first, whatever the answer's order and time format", () => {
  assert.equal(model.messageTime(1791885600), 1791885600000);
  assert.equal(model.messageTime(1791885600000), 1791885600000);
  assert.equal(model.messageTime("2026-10-14T01:00:00Z"), Date.parse("2026-10-14T01:00:00Z"));
  assert.equal(model.messageTime("1791885600"), 1791885600000);
  assert.equal(model.messageTime("soon"), null);
  const thread = model.threadModel({
    chat: { chatId: "c1", title: "T", userName: "U", models: ["m"] },
    auditId: "a1",
    isLatest: false,
    messages: [
      { id: "b", role: "assistant", timestamp: 1791885700, content: "answer" },
      { id: "a", role: "user", timestamp: 1791885600, content: "question" },
      { id: "c", role: "robot", timestamp: null, content: { odd: true } },
    ],
  });
  assert.deepEqual(thread.messages.map((message) => message.id), ["a", "b", "c"]);
  assert.equal(thread.messages[2].role, "other");
  assert.equal(typeof thread.messages[2].content, "string");
  assert.equal(thread.isLatest, false);
  assert.equal(thread.title, "T");
  assert.deepEqual(model.threadModel(null).messages, []);
});

test("message text reaches the viewer as text: the Markdown parser yields no raw HTML node for hostile input", () => {
  const tree = parseMarkdown("# Plan <script>window.__pwned = 1</script>\n\n<img src=x onerror=\"y()\"> [a](javascript:alert(1)) ![b](https://example.invalid/p.png)\n\n<iframe src=\"https://example.invalid\"></iframe>");
  const types = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    types.add(node.type);
    for (const child of node.children || []) walk(child);
    for (const item of node.items || []) walk(item);
  };
  walk(tree);
  assert.equal([...types].some((type) => /html|raw/i.test(String(type))), false, [...types].join(","));
});

test("versions come newest first", () => {
  const versions = model.versionRows({ versions: [
    { auditId: "old", createdAt: "2026-10-01T00:00:00Z", messageCount: 1 },
    { auditId: "new", createdAt: "2026-10-13T00:00:00Z", messageCount: 3 },
    { createdAt: "x" },
  ] });
  assert.deepEqual(versions.map((item) => item.auditId), ["new", "old"]);
});

// ---------------------------------------------------------------------------
// Export chain

const exportsAnswer = () => ({
  ok: true,
  exports: [
    { auditId: "i2", mode: "incremental", createdAt: "2026-10-13T09:00:00Z", chatCount: 2, messageCount: 4, mdFile: "x.md", mdBytes: 10, chainId: "f1", skippedEmpty: false },
    { auditId: "i1", mode: "incremental", createdAt: "2026-10-10T09:00:00Z", chatCount: 0, messageCount: 0, mdFile: "", mdBytes: 0, chainId: "f1", skippedEmpty: true },
    { auditId: "f1", mode: "full", createdAt: "2026-10-01T04:00:00Z", chatCount: 7, messageCount: 26, mdFile: "x.md", mdBytes: 99, chainId: "f1", skippedEmpty: false },
    { auditId: "lost", mode: "incremental", createdAt: "2026-09-01T00:00:00Z", chatCount: 1, messageCount: 1, mdFile: "x.md", mdBytes: 1, chainId: null, skippedEmpty: false },
  ],
});

test("a chain is one full baseline and its incrementals, with the retention plan and the exports outside any chain", () => {
  const status = fixture("audit-status");
  status.chains = [{ fullAuditId: "f1", createdAt: "2026-10-01T04:00:00Z", auditIds: ["i2", "i1", "f1"], incrementals: 2, chats: 7, messages: 26, bytes: 109, active: true }];
  status.retention.plan = { remove: [{ auditId: "i1", reason: "empty-incremental" }], warnings: [{ code: "over_max_exports", message: "m" }], needsRebaseline: true };
  const view = model.chainModel(status, exportsAnswer());
  assert.equal(view.chains.length, 1);
  const chain = view.chains[0];
  assert.equal(chain.id, "f1");
  assert.equal(chain.baseline.mode, "full");
  assert.deepEqual(chain.incrementals.map((row) => row.auditId), ["i2", "i1"]);
  assert.equal(model.incrementalCount(chain), 2);
  assert.equal(chain.empties, 1);
  assert.equal(chain.incrementals[1].empty, true);
  assert.equal(chain.incrementals[1].removeReason, "empty-incremental");
  assert.equal(chain.incrementals[0].removeReason, null);
  assert.deepEqual(view.loose.map((row) => row.auditId), ["lost"]);
  assert.equal(view.needsRebaseline, true);
  assert.deepEqual(view.warnings, [{ code: "over_max_exports", message: "m" }]);
});

test("a chain whose baseline file is gone, and an empty status, still produce a view", () => {
  const status = { chains: [{ fullAuditId: "gone", auditIds: ["i9", "gone"], active: false }], retention: { plan: {} } };
  const view = model.chainModel(status, { exports: [{ auditId: "i9", mode: "incremental", chatCount: 1 }] });
  assert.equal(view.chains[0].baseline, null);
  assert.equal(view.chains[0].incrementals.length, 1);
  assert.deepEqual(model.chainModel(null, null), { chains: [], loose: [], needsRebaseline: false, warnings: [] });
});

test("the export body has a valid mode and a bounded note", () => {
  assert.deepEqual(model.exportBody("full", "  before the upgrade "), { mode: "full", note: "before the upgrade" });
  assert.deepEqual(model.exportBody("whatever", null), { mode: "full", note: "" });
  assert.equal(model.exportBody("incremental", "x".repeat(900)).note.length, 500);
  assert.equal(model.exportBody("incremental", "").mode, "incremental");
});

// ---------------------------------------------------------------------------
// Access log and timeline

test("access log rows keep the chain fields, details become one safe line, and verification names the broken entry", () => {
  const page = model.accessPage({ rows: [
    { seq: 2, at: "2026-10-14T00:00:00Z", action: "view_chat", outcome: "ok", target: "c", detail: { auditId: "a", messages: 2, nested: { x: 1 } }, hash: "h2" },
    { seq: "bad" },
    null,
  ], nextCursor: "1" });
  assert.equal(page.rows.length, 1);
  assert.equal(page.cursor, "1");
  assert.equal(model.detailText(page.rows[0].detail), "auditId=a messages=2");
  assert.equal(model.detailText(null), "");
  assert.equal(model.detailText("plain"), "plain");
  assert.equal(model.outcomeTone("ok"), "ok");
  assert.equal(model.outcomeTone("denied"), "warn");
  assert.equal(model.outcomeTone("error"), "error");
  assert.equal(model.outcomeTone("x"), "neutral");
  assert.deepEqual(model.verifyView({ ok: true, rows: 9, firstBrokenSeq: null }), { ok: true, rows: 9, firstBrokenSeq: null });
  assert.deepEqual(model.verifyView({ ok: false, rows: 9, firstBrokenSeq: 7 }), { ok: false, rows: 9, firstBrokenSeq: 7 });
  assert.equal(model.verifyView({ ok: true, rows: 9, firstBrokenSeq: 4 }).ok, false, "a broken entry is never ok");
  assert.equal(model.verifyView(null), null);
});

test("timeline events keep their family, severity tone and links; the type filter always names prefixes", () => {
  const rows = model.timelineRows({ rows: [
    { id: 1, at: "2026-10-14T11:00:00Z", type: "launch.ready", severity: "info", title: { zh: "z", en: "e" }, fleetId: "vllm:primary" },
    { id: 2, at: "2026-10-14T10:00:00Z", type: "security.ban", severity: "warning", requestId: "req_x", title: "t" },
    { id: 3, at: "never" },
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.family, row.tone]), [["launch", "info"], ["security", "warn"]]);
  assert.equal(model.eventFamily("alert.fired"), "alert");
  assert.equal(model.eventFamily("billing.x"), "other");
  assert.equal(model.timelineTypes([]), "launch.,alert.,access.,security.");
  assert.equal(model.timelineTypes(["security", "launch", "bogus"]), "security.,launch.");
});

// ---------------------------------------------------------------------------
// Settings

const SETTINGS = { schedule: { enabled: true, incrementalEveryMinutes: 60, fullAtLocal: "04:00" }, retention: { maxExports: 30, maxAgeDays: 90, rebaselineDays: 7, maxChains: 8 }, logQueryText: false, etag: "e1" };

test("the settings draft sends only what changed, nested as the writer expects", () => {
  const draft = model.settingsDraft(SETTINGS);
  assert.equal(draft["schedule.incrementalEveryMinutes"], "60");
  assert.equal(draft["schedule.enabled"], true);
  assert.deepEqual(model.settingsPatch(SETTINGS, draft), { patch: {}, errors: {}, changed: false });
  const changed = model.settingsPatch(SETTINGS, { ...draft, "schedule.incrementalEveryMinutes": "30", "retention.rebaselineDays": "3.5", logQueryText: true, "schedule.fullAtLocal": "05:30" });
  assert.deepEqual(changed.patch, { schedule: { incrementalEveryMinutes: 30, fullAtLocal: "05:30" }, retention: { rebaselineDays: 3.5 }, logQueryText: true });
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.errors, {});
});

test("invalid settings are reported with a code and never reach the patch", () => {
  const draft = model.settingsDraft(SETTINGS);
  const bad = model.settingsPatch(SETTINGS, { ...draft, "schedule.incrementalEveryMinutes": "5", "schedule.fullAtLocal": "25:00", "retention.maxExports": "", "retention.maxAgeDays": "-1", "retention.maxChains": "1.5", "retention.rebaselineDays": "abc" });
  assert.deepEqual(bad.errors, {
    "schedule.incrementalEveryMinutes": "range",
    "schedule.fullAtLocal": "clock",
    "retention.maxExports": "required",
    "retention.maxAgeDays": "number",
    "retention.maxChains": "number",
    "retention.rebaselineDays": "number",
  });
  assert.deepEqual(bad.patch, {});
  assert.equal(model.settingsPatch(SETTINGS, { ...draft, "schedule.incrementalEveryMinutes": "2000" }).errors["schedule.incrementalEveryMinutes"], "range");
});

test("the writer's field errors map onto the form's fields and the rest are kept apart", () => {
  const mapped = model.serverSettingErrors([
    { field: "retention.maxChains", code: "out_of_range", message: "x" },
    { field: "audit.schedule.fullAtLocal", code: "bad_clock" },
    { field: "mystery", code: "unknown", message: "y" },
    null,
  ]);
  assert.deepEqual(mapped.byPath, { "retention.maxChains": "out_of_range", "schedule.fullAtLocal": "bad_clock" });
  assert.deepEqual(mapped.other, [{ field: "mystery", code: "unknown", message: "y" }]);
  assert.deepEqual(model.serverSettingErrors(undefined), { byPath: {}, other: [] });
});

// ---------------------------------------------------------------------------
// The API client's text mode (the Markdown of an export)

test("a text request returns the body as text, sends the audit header, and still raises JSON errors", async () => {
  const { createApiClient } = await load("lib/api.js");
  const seen = [];
  const answers = [
    { ok: true, status: 200, headers: new Map([["content-type", "text/markdown; charset=utf-8"]]), text: async () => "# Export\n\nA line." },
    { ok: false, status: 404, headers: new Map([["content-type", "application/json"]]), text: async () => JSON.stringify({ ok: false, error: { code: "audit_file_missing", message: "gone" } }) },
    { ok: true, status: 200, headers: new Map([["content-type", "text/markdown"]]), text: async () => "# not wanted as json" },
  ];
  const fetchImpl = async (url, options) => {
    seen.push({ url, headers: options.headers });
    const answer = answers.shift();
    return { ...answer, headers: { get: (name) => answer.headers.get(name.toLowerCase()) ?? null } };
  };
  const api = createApiClient({ fetchImpl, csrfToken: "csrf-fake" });
  const text = await api.get("/api/audit/exports/a1/markdown", { text: true, headers: { "x-audit-session": "fake-token" } });
  assert.equal(text, "# Export\n\nA line.");
  assert.equal(seen[0].headers["x-audit-session"], "fake-token");
  assert.match(seen[0].headers.accept, /text\/markdown/);
  await assert.rejects(api.get("/api/audit/exports/a2/markdown", { text: true }), (error) => error.code === "audit_file_missing" && !String(error.message).includes("fake-token"));
  // Without the text option a non-JSON body is still a bad response.
  await assert.rejects(api.get("/api/audit/exports/a3/markdown"), (error) => error.code === "bad_response");
});
