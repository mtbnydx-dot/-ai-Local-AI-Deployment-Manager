const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const errors = require("../lib/public-errors");

// Public error taxonomy (05-public.md §10, PUB-7). The golden file is the §10.2
// table rendered once; regenerate it with UPDATE_GOLDEN=1 only when the table
// itself changes, and review the diff against the spec.
const GOLDEN_PATH = path.join(__dirname, "golden", "public-errors.json");

// Every code in the §10.2 table. csrf_invalid is the ADMIN console-session code
// (00 §9.8), answered in the route's protocol shape.
const SPEC_CODES = [
  "missing_api_key", "invalid_api_key", "key_expired", "key_disabled", "scope_denied", "model_not_allowed",
  "origin_not_allowed", "ip_not_allowed", "csrf_invalid", "model_not_found", "not_found", "method_not_allowed",
  "invalid_request", "invalid_json", "max_tokens_exceeded", "request_exceeds_tpm", "unknown_engine",
  "request_too_large", "unsupported_media_type", "ip_rate_limited", "auth_banned", "rate_limit_exceeded",
  "tokens_rate_limit_exceeded", "concurrency_limit_exceeded", "insufficient_quota", "overloaded",
  "model_unavailable", "service_unavailable", "auth_unavailable", "billing_unavailable", "upstream_error",
  "upstream_timeout", "internal_error",
];

// The spec's leak regex (§17.1), plus the stricter checks gateway-errors.test.js
// applies to gateway bodies. Public route paths are the only "/" paths allowed.
// The spec prints the regex string-escaped; both readings are checked.
const SPEC_LEAK_RE = /[A-Z]:\\|\d{4,5}|SERVICE_ENTRY_|\.json/;
const SPEC_LEAK_RE_AS_PRINTED = /[A-Z]:\\|\\d{4,5}|SERVICE_ENTRY_|\\.json/;
const LEAKS = [
  [SPEC_LEAK_RE, "the spec leak pattern"],
  [SPEC_LEAK_RE_AS_PRINTED, "the spec leak pattern as printed"],
  [/[A-Za-z]:[\\/]|\\/, "a Windows path"],
  [/\b(?:5176|5177|5178|5180|5186|5190|7000)\b|\bport\s+\d+|:\d{2,5}\b/i, "a port"],
  [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, "an env var name"],
  [/\b(?:vllm|llama|sglang)-manager\b|\bmanager\b/i, "a manager name"],
  [/\.(?:js|cjs|mjs|json|sqlite|db|cmd|ps1|log|py|ya?ml)\b/i, "a file name"],
];
const PUBLIC_PATHS = new Set(["/v1/models"]);

function assertNoLeak(text, label) {
  for (const [pattern, what] of LEAKS) {
    assert.doesNotMatch(String(text), pattern, `${label} leaks ${what}: ${text}`);
  }
  for (const match of String(text).matchAll(/(?:^|[\s("'])(\/[^\s)"',;]*)/g)) {
    assert.ok(PUBLIC_PATHS.has(match[1].replace(/[.:]$/, "")), `${label} names a path that is not a public route: ${match[1]}`);
  }
}

const FIXED_ID = "req_abcdefghijklmnopqrst";
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function pick(error) {
  return { status: error.status, anthropicStatus: error.anthropicStatus, headers: error.headers, openai: error.openai, anthropic: error.anthropic };
}

function readGolden() {
  if (process.env.UPDATE_GOLDEN === "1") {
    const current = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
    const codes = {};
    for (const code of errors.publicErrorCodes()) codes[code] = pick(errors.publicError(code, { requestId: FIXED_ID }));
    const cases = current.cases.map((item) => ({ ...item, expect: pick(errors.publicError(item.code, { ...item.opts, requestId: FIXED_ID })) }));
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify({ ...current, codes, cases }, null, 2)}\n`);
  }
  return JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
}

function fakeReq({ method = "GET", url = "/", headers = {} } = {}) {
  return { method, url, headers };
}

test("the taxonomy is exactly the §10.2 table, csrf_invalid included", () => {
  const golden = readGolden();
  assert.equal(golden.requestId, FIXED_ID);
  assert.deepEqual(errors.publicErrorCodes(), SPEC_CODES);
  assert.deepEqual(Object.keys(golden.codes), SPEC_CODES);
  assert.ok(errors.publicErrorCodes().includes("csrf_invalid"));
});

test("every code renders the golden OpenAI and Anthropic shapes, status and headers", () => {
  const golden = readGolden();
  for (const code of SPEC_CODES) {
    const error = errors.publicError(code, { requestId: FIXED_ID });
    assert.equal(error.code, code);
    assert.deepEqual(pick(error), golden.codes[code], `golden mismatch for ${code}`);
    // The documented shapes, field for field (§10.1).
    assert.deepEqual(Object.keys(error.openai), ["error", "request_id"]);
    assert.deepEqual(Object.keys(error.openai.error), ["message", "type", "code", "param"]);
    assert.deepEqual(Object.keys(error.anthropic), ["type", "error", "request_id"]);
    assert.deepEqual(Object.keys(error.anthropic.error), ["type", "message"]);
    assert.equal(error.anthropic.type, "error");
    assert.equal(error.openai.error.code, code);
    assert.equal(error.openai.request_id, FIXED_ID);
    assert.equal(error.anthropic.request_id, FIXED_ID);
    assert.equal(error.headers["x-request-id"], FIXED_ID);
    if (error.status === 429) assert.match(error.headers["retry-after"], /^\d+$/, `${code} is a 429 without retry-after`);
  }
  for (const item of golden.cases) {
    assert.deepEqual(pick(errors.publicError(item.code, { ...item.opts, requestId: FIXED_ID })), item.expect, `golden case: ${item.name}`);
  }
});

test("spot checks against the §10.2 table", () => {
  const golden = readGolden().codes;
  assert.equal(golden.csrf_invalid.status, 403);
  assert.equal(golden.csrf_invalid.openai.error.type, "permission_error");
  assert.equal(golden.csrf_invalid.anthropic.error.type, "permission_error");
  assert.equal(golden.overloaded.status, 503);
  assert.equal(golden.overloaded.anthropicStatus, 529);
  assert.equal(golden.overloaded.anthropic.error.type, "overloaded_error");
  assert.equal(golden.overloaded.headers["retry-after"], "5");
  assert.equal(golden.insufficient_quota.openai.error.type, "insufficient_quota");
  assert.equal(golden.insufficient_quota.anthropic.error.type, "rate_limit_error");
  assert.equal(golden.request_too_large.anthropic.error.type, "request_too_large");
  assert.equal(golden.unsupported_media_type.anthropic.error.type, "invalid_request_error");
  assert.equal(golden.model_not_found.anthropic.error.type, "not_found_error");
  assert.equal(golden.method_not_allowed.status, 405);
  assert.equal(golden.model_not_allowed.openai.error.param, "model");
  assert.deepEqual(
    ["upstream_error", "upstream_timeout", "internal_error"].map((code) => golden[code].status),
    [502, 504, 500],
  );
});

test("options: param is validated, retry-after rounds up, detail never reaches a body", () => {
  const scoped = errors.publicError("scope_denied", { param: "/v1/audio/speech" });
  assert.equal(scoped.openai.error.param, "/v1/audio/speech");
  for (const bad of ["D:\\example-root\\data\\keys", "two words", "x".repeat(200), { nested: true }]) {
    assert.equal(errors.publicError("invalid_request", { param: bad }).openai.error.param, null, `param ${String(bad)} must be dropped`);
  }
  assert.equal(errors.publicError("rate_limit_exceeded", { retryAfterSeconds: 0.2 }).headers["retry-after"], "1");
  assert.equal(errors.publicError("rate_limit_exceeded", { retryAfterSeconds: -5 }).headers["retry-after"], "60");
  assert.equal(errors.publicError("auth_banned", { retryAfterSeconds: 1e12 }).headers["retry-after"], String(30 * 24 * 60 * 60));

  const detail = "manager not listening on D:\\example-root\\x; Authorization: Bearer test-token-not-real; SERVICE_ENTRY_PORT";
  const upstream = errors.publicError("upstream_error", { detail });
  for (const body of [upstream.openai, upstream.anthropic]) {
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /example-root|test-token-not-real|SERVICE_ENTRY_PORT|listening/);
  }
  assert.match(upstream.detail, /listening/, "the detail is kept for the server log");
  assert.doesNotMatch(upstream.detail, /test-token-not-real/, "the log detail is redacted");

  const unmapped = errors.publicError("manager_not_listening", { requestId: FIXED_ID });
  assert.equal(unmapped.code, "internal_error");
  assert.equal(unmapped.status, 500);
  assert.doesNotMatch(JSON.stringify([unmapped.openai, unmapped.anthropic]), /manager_not_listening/);
  assert.match(unmapped.detail, /manager_not_listening/);

  const minted = errors.publicError("not_found");
  assert.match(minted.openai.request_id, /^req_[a-z2-7]{20}$/);
  assert.equal(minted.headers["x-request-id"], minted.openai.request_id);
  assert.match(errors.publicError("not_found", { requestId: "<script>" }).openai.request_id, /^req_[a-z2-7]{20}$/);
});

test("no message or page copy leaks a path, port, env, manager or file name", () => {
  for (const code of SPEC_CODES) {
    const error = errors.publicError(code, { requestId: FIXED_ID });
    assertNoLeak(error.openai.error.message, `${code} OpenAI message`);
    assertNoLeak(error.anthropic.error.message, `${code} Anthropic message`);
    const item = errors.lookupPublicError(code);
    for (const lang of ["zh-CN", "en-US"]) {
      const copy = item.copy[lang];
      assert.ok(copy.title && copy.explanation && copy.steps.length, `${code} ${lang} copy is complete`);
      for (const text of [copy.title, copy.explanation, ...copy.steps]) assertNoLeak(text, `${code} ${lang} copy`);
      if (lang === "en-US") {
        for (const text of [copy.title, copy.explanation, ...copy.steps]) {
          assert.doesNotMatch(text, /\p{Script=Han}/u, `${code} English copy has Han text`);
        }
      }
    }
  }
  // The whole rendered page, both variants and languages, passes as well.
  for (const code of SPEC_CODES) {
    for (const lang of ["zh-CN", "en-US"]) {
      for (const variant of ["error", "api"]) {
        const page = errors.renderErrorPage({ code, lang, variant, requestId: FIXED_ID });
        // Template comments name source files; they never reach a caller.
        assert.doesNotMatch(page, /<!--|public-errors|service-entry/, `${code} ${lang} ${variant} page keeps a comment`);
        assert.doesNotMatch(page, SPEC_LEAK_RE, `${code} ${lang} ${variant} page`);
      }
    }
  }
});

test("wantsHtml: only a keyless GET that ranks text/html above application/json", () => {
  const cases = [
    [{ headers: { accept: BROWSER_ACCEPT } }, true, "browser navigation"],
    [{ headers: { accept: "text/html" } }, true, "text/html only"],
    [{ headers: { accept: "application/json;q=0.5, text/html" } }, true, "html ranked higher"],
    [{ headers: {} }, false, "no Accept header means */*, a tie"],
    [{ headers: { accept: "*/*" } }, false, "*/* is a tie"],
    [{ headers: { accept: "application/json" } }, false, "JSON client"],
    [{ headers: { accept: "application/json, text/plain, */*" } }, false, "axios default"],
    [{ headers: { accept: "text/html;q=0.5, application/json" } }, false, "JSON ranked higher"],
    [{ headers: { accept: "text/html, application/json" } }, false, "equal quality"],
    [{ headers: { accept: "text/html;q=0" } }, false, "html refused"],
    [{ method: "POST", headers: { accept: BROWSER_ACCEPT } }, false, "POST"],
    [{ method: "HEAD", headers: { accept: BROWSER_ACCEPT } }, false, "HEAD"],
    [{ headers: { accept: BROWSER_ACCEPT, authorization: "Bearer test-token-not-real" } }, false, "Authorization header"],
    [{ headers: { accept: BROWSER_ACCEPT, "x-api-key": "test-key" } }, false, "x-api-key header"],
    [{ headers: { accept: BROWSER_ACCEPT, "api-key": "test-key" } }, false, "api-key header"],
    [{ headers: { accept: BROWSER_ACCEPT, "anthropic-api-key": "test-key" } }, false, "anthropic-api-key header"],
  ];
  for (const [input, expected, label] of cases) {
    assert.equal(errors.wantsHtml(fakeReq(input)), expected, label);
  }
  // Portal routes: a tie goes to HTML, an explicit JSON preference still wins.
  assert.equal(errors.wantsHtml(fakeReq({ headers: { accept: "*/*" } }), { portal: true }), true);
  assert.equal(errors.wantsHtml(fakeReq({ headers: {} }), { portal: true }), true);
  assert.equal(errors.wantsHtml(fakeReq({ headers: { accept: "application/json" } }), { portal: true }), false);
  assert.equal(errors.wantsHtml(fakeReq({ method: "POST", headers: { accept: "*/*" } }), { portal: true }), false);
  assert.equal(errors.wantsHtml(fakeReq({ headers: { accept: "*/*", "x-api-key": "test-key" } }), { portal: true }), false);
});

test("paths: API prefixes, portal routes and the Anthropic routes", () => {
  for (const pathname of ["/v1", "/v1/models", "/anthropic/v1/messages", "/vllm/v1/chat/completions", "/llama/v1", "/gateway/auto/openai/v1/models"]) {
    assert.equal(errors.isApiPath(pathname), true, pathname);
  }
  for (const pathname of ["/v10", "/docs", "/status", "/gatewayx", "/"]) {
    assert.equal(errors.isApiPath(pathname), false, pathname);
  }
  for (const pathname of ["/", "/status", "/models", "/models/qwen3.8-35b-a3b", "/docs", "/docs/quickstart", "/me", "/playground", "/announcements"]) {
    assert.equal(errors.isPortalPath(pathname), true, pathname);
  }
  for (const pathname of ["/nope", "/status.json", "/catalog.json", "/models/a/b", "/v1/models", "/assets/x/app.js"]) {
    assert.equal(errors.isPortalPath(pathname), false, pathname);
  }
  const anthropic = [
    "/anthropic/v1/messages", "/anthropic/v1/models", "/v1/messages", "/v1/messages/count_tokens",
    "/vllm/v1/messages", "/gateway/auto/claude/v1/messages", "/gateway/llama/claude", "/gateway/external/lan-box/claude/v1/messages",
  ];
  for (const pathname of anthropic) assert.equal(errors.protocolForPath(pathname), "anthropic", pathname);
  const openai = ["/v1/chat/completions", "/v1/models", "/gateway/auto/openai/v1/chat/completions", "/gateway/vllm/opencode/v1/responses", "/v1/messagesx", "/nope"];
  for (const pathname of openai) assert.equal(errors.protocolForPath(pathname), "openai", pathname);
});

test("Accept-Language picks zh or en, highest quality first", () => {
  assert.equal(errors.pickLanguage("zh-CN,zh;q=0.9,en;q=0.8"), "zh-CN");
  assert.equal(errors.pickLanguage("zh-TW"), "zh-CN");
  assert.equal(errors.pickLanguage("en-US,en;q=0.9,zh;q=0.8"), "en-US");
  assert.equal(errors.pickLanguage("zh;q=0.1, en;q=0.9"), "en-US");
  assert.equal(errors.pickLanguage("fr-FR, de;q=0.5"), "en-US");
  assert.equal(errors.pickLanguage("zh;q=0, en;q=0.2"), "en-US");
  assert.equal(errors.pickLanguage(""), "en-US");
});

test("error.html has no script, no inline style and only known placeholders", () => {
  const template = fs.readFileSync(errors.ERROR_TEMPLATE_PATH, "utf8");
  assert.doesNotMatch(template, /<script|<style|\sstyle=|\son[a-z]+\s*=|javascript:|<iframe|<object|<embed|<form/i);
  const placeholders = new Set(Array.from(template.matchAll(/\{\{([A-Za-z]+)\}\}/g), (match) => match[1]));
  for (const required of ["lang", "status", "title", "explanation", "steps", "code", "requestId", "statusHref", "docsHref", "stylesheets"]) {
    assert.ok(placeholders.has(required), `template lacks {{${required}}}`);
  }
  for (const code of SPEC_CODES) {
    for (const lang of ["zh-CN", "en-US"]) {
      const page = errors.renderErrorPage({ code, lang, requestId: FIXED_ID });
      assert.doesNotMatch(page, /\{\{|\}\}/, `${code} ${lang} left a placeholder`);
      assert.doesNotMatch(page, /<script/i);
      assert.match(page, new RegExp(`<html lang="${lang}">`));
      assert.match(page, new RegExp(`<code>${code}</code>`));
      assert.match(page, new RegExp(`<code>${FIXED_ID}</code>`));
      assert.match(page, /<a href="\/status">/, "every page links to /status");
      assert.match(page, new RegExp(`<a href="/docs/errors#${code}">`));
      const item = errors.lookupPublicError(code);
      assert.ok(page.includes(errors.escapeHtml(item.copy[lang].title)), `${code} ${lang} title`);
      assert.match(page, /<li>/, "every page lists next steps");
    }
  }
});

test("the page escapes every value and never re-expands placeholders", () => {
  const hostile = `"><script>alert(1)</script><img src=x onerror=alert(1)>{{steps}}'`;
  const page = errors.renderErrorPage({ code: "not_found", lang: "en-US", requestId: hostile, stylesheets: ["/assets/b1/styles/portal.css", "https://cdn.example.com/x.css", "//evil/x.css", "/a\"onload=\"x"] });
  assert.doesNotMatch(page, /<script|<img/i);
  for (const tag of page.match(/<[^>]+>/g)) {
    assert.doesNotMatch(tag, /\son[a-z]+\s*=/i, `an event handler attribute was injected: ${tag}`);
  }
  assert.ok(page.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;{{steps}}&#39;"));
  assert.equal((page.match(/<link /g) || []).length, 1, "only the same-origin stylesheet is linked");
  assert.match(page, /<link rel="stylesheet" href="\/assets\/b1\/styles\/portal\.css">/);

  // A template value is always text, even with markup-like copy.
  const custom = errors.renderErrorPage({ code: "invalid_request", template: "<p>{{title}}|{{code}}|{{unknownKey}}|{{steps}}</p>", lang: "en-US" });
  assert.equal(custom, "<p>Invalid request|invalid_request||<li>Compare the request with the API docs.</li>\n<li>Quote the request ID if you ask the owner for help.</li></p>");
  assert.equal(errors.escapeHtml(`<a href="x" onclick='y'>&\``), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;");
});

test("the API endpoint variant explains the endpoint and links the docs", () => {
  const en = errors.renderErrorPage({ code: "missing_api_key", variant: "api", lang: "en-US", requestId: FIXED_ID });
  assert.match(en, /This is an API endpoint/);
  assert.match(en, /<a href="\/docs\/quickstart">API docs<\/a>/);
  assert.match(en, /<code>missing_api_key<\/code>/);
  assert.match(en, /Error 401/);
  const zh = errors.renderErrorPage({ code: "missing_api_key", variant: "api", lang: "zh-CN", requestId: FIXED_ID });
  assert.match(zh, /这是 API 接口地址/);
});

// sendPublicError over a real socket: ephemeral port, no other service.
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("sendPublicError negotiates protocol and content", async () => {
  const sent = [];
  const handler = (req, res) => {
    const [, code = "not_found", extra = ""] = new URL(req.url, "http://localhost").search.match(/code=([a-z_]+)(?:&(.*))?/) || [];
    if (extra === "preset") res.setHeader("x-request-id", FIXED_ID);
    const result = errors.sendPublicError(req, res, code, {
      retryAfterSeconds: extra === "retry" ? 7 : undefined,
      headers: { Vary: "Origin", "access-control-allow-origin": "https://app.example.com", "Content-Type": "text/plain" },
      stylesheets: ["/assets/b1/styles/portal.css"],
      log: (entry) => sent.push(entry),
    });
    assert.equal(result.sent, true);
  };
  await withServer(handler, async (base) => {
    // OpenAI route, API client: JSON in the OpenAI shape.
    let response = await fetch(`${base}/v1/chat/completions?code=rate_limit_exceeded&retry`, { method: "POST", headers: { accept: BROWSER_ACCEPT } });
    let body = await response.json();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("retry-after"), "7");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com", "caller headers are kept");
    assert.equal(response.headers.get("vary"), "Origin, Accept, Accept-Language");
    assert.equal(body.error.code, "rate_limit_exceeded");
    assert.equal(body.error.type, "rate_limit_error");
    assert.match(body.request_id, /^req_[a-z2-7]{20}$/);
    assert.equal(response.headers.get("x-request-id"), body.request_id);

    // Anthropic route: Anthropic shape, and 529 for overloaded.
    response = await fetch(`${base}/anthropic/v1/messages?code=overloaded`, { method: "POST" });
    body = await response.json();
    assert.equal(response.status, 529);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.deepEqual(Object.keys(body), ["type", "error", "request_id"]);
    assert.equal(body.error.type, "overloaded_error");
    response = await fetch(`${base}/gateway/auto/claude/v1/messages?code=csrf_invalid`, { method: "POST" });
    body = await response.json();
    assert.equal(response.status, 403);
    assert.deepEqual(body.error, { type: "permission_error", message: errors.publicError("csrf_invalid").openai.error.message });
    response = await fetch(`${base}/gateway/auto/openai/v1/chat/completions?code=csrf_invalid`, { method: "POST" });
    body = await response.json();
    assert.equal(body.error.code, "csrf_invalid");
    assert.equal(body.error.type, "permission_error");

    // An existing x-request-id on the response is reused.
    response = await fetch(`${base}/v1/models?code=invalid_api_key&preset`, { headers: { accept: "application/json" } });
    body = await response.json();
    assert.equal(body.request_id, FIXED_ID);
    assert.equal(response.headers.get("x-request-id"), FIXED_ID);

    // A client-sent x-request-id is never echoed (the pipeline keeps it as clientRequestId).
    response = await fetch(`${base}/v1/models?code=invalid_api_key`, { headers: { "x-request-id": "req_aaaaaaaaaaaaaaaaaaaa" } });
    body = await response.json();
    assert.notEqual(body.request_id, "req_aaaaaaaaaaaaaaaaaaaa");

    // A browser opening an API path gets the "API endpoint" page.
    response = await fetch(`${base}/v1/models?code=missing_api_key`, { headers: { accept: BROWSER_ACCEPT, "accept-language": "en-US,en;q=0.9" } });
    let html = await response.text();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    assert.doesNotMatch(response.headers.get("content-security-policy"), /script-src/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(html, /This is an API endpoint/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/b1\/styles\/portal\.css">/);
    assert.match(html, new RegExp(`<code>${response.headers.get("x-request-id")}</code>`));
    assert.doesNotMatch(html, /<script/i);

    // The same path with a key header stays JSON.
    response = await fetch(`${base}/v1/models?code=invalid_api_key`, { headers: { accept: BROWSER_ACCEPT, authorization: "Bearer test-token-not-real" } });
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal((await response.json()).error.code, "invalid_api_key");

    // Unknown path: a browser gets the HTML 404 (zh by Accept-Language), an API client JSON.
    response = await fetch(`${base}/nope?code=not_found`, { headers: { accept: BROWSER_ACCEPT, "accept-language": "zh-CN,zh;q=0.9" } });
    html = await response.text();
    assert.equal(response.status, 404);
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /页面不存在/);
    assert.match(html, /<a href="\/status">服务状态<\/a>/);
    response = await fetch(`${base}/nope?code=not_found`);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal((await response.json()).error.code, "not_found");

    // Portal route: a tie goes to HTML; an explicit JSON preference stays JSON.
    response = await fetch(`${base}/models/missing?code=model_not_found`, { headers: { accept: "*/*" } });
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    response = await fetch(`${base}/models/missing?code=model_not_found`, { headers: { accept: "application/json" } });
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");

    // HEAD: headers only.
    response = await fetch(`${base}/v1/models?code=not_found`, { method: "HEAD" });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  });
  assert.ok(sent.length >= 10);
  assert.ok(sent.every((item) => typeof item.code === "string" && /^req_[a-z2-7]{20}$/.test(item.requestId)));
});

test("sendPublicError honours an explicit protocol and survives a sent response", () => {
  const writes = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    getHeader: () => undefined,
    writeHead(status, headers) { writes.push({ status, headers }); this.headersSent = true; },
    end(body) { writes.push({ body: body ? body.toString("utf8") : "" }); this.writableEnded = true; },
  };
  const result = errors.sendPublicError(fakeReq({ method: "POST", url: "/v1/chat/completions" }), res, "overloaded", { protocol: "claude", requestId: FIXED_ID });
  assert.deepEqual(result, { sent: true, code: "overloaded", status: 529, requestId: FIXED_ID, protocol: "anthropic", format: "json" });
  assert.equal(writes[0].status, 529);
  assert.equal(JSON.parse(writes[1].body).error.type, "overloaded_error");

  let ended = false;
  const late = { headersSent: true, writableEnded: false, end() { ended = true; this.writableEnded = true; }, writeHead() { throw new Error("must not write headers twice"); } };
  const lateResult = errors.sendPublicError(fakeReq({ method: "POST", url: "/v1/chat/completions" }), late, "upstream_error", { log: () => { throw new Error("log failure is ignored"); } });
  assert.equal(lateResult.sent, false);
  assert.equal(lateResult.code, "upstream_error");
  assert.equal(ended, true);
});
