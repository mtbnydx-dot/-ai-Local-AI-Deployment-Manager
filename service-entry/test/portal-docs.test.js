"use strict";

// The portal's docs data (05 §12.4, PUB-16): the markdown renderer
// (portal/lib/md.js), the client snippets (portal/data/client-snippets.json,
// portal/lib/snippets.js), the docs pages and the errors page data generated
// from the error taxonomy. The Preact pages themselves are covered by
// tests/public-portal.spec.cjs.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { PUBLIC_ERROR_TAXONOMY, renderErrorPage } = require("../lib/public-errors");
const { DATA_PATH, serializeErrorDocs } = require("../lib/portal-error-docs");

const PORTAL = path.join(__dirname, "..", "portal");
const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const SLUGS = ["quickstart", "api", "streaming", "tools", "vision", "tts", "errors", "limits", "privacy", "clients"];
const LOCALES = ["zh-CN", "en-US"];
const load = (name) => import(pathToFileURL(path.join(PORTAL, "lib", name)).href);
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(PORTAL, ...parts), "utf8").replace(/^\uFEFF/, ""));
const readDoc = (slug, locale) => fs.readFileSync(path.join(PORTAL, "docs", `${slug}.${locale}.md`), "utf8");

const CONFIG = Object.freeze({
  baseUrl: "https://api.example.test",
  openaiBase: "https://api.example.test/v1",
  anthropicBase: "https://api.example.test/anthropic",
});

// ---- markdown ---------------------------------------------------------------

test("md: headings, paragraphs, lists, fenced code, inline code, bold and https links", async () => {
  const md = await load("md.js");
  const html = md.renderHtml([
    "# Title",
    "",
    "Some **bold** text with `code` and a [link](https://example.com/a?b=1&c=2).",
    "",
    "- one",
    "- two",
    "  continued",
    "",
    "1. first",
    "2. second",
    "",
    "```python",
    "print('<hi>')",
    "```",
    "",
    "See [the quickstart](/docs/quickstart).",
  ].join("\n"));
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">link<\/a>/);
  assert.match(html, /<ul><li>one<\/li><li>two continued<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<pre><code class="language-python">print\(&#39;&lt;hi&gt;&#39;\)<\/code><\/pre>/);
  assert.match(html, /<a href="\/docs\/quickstart">the quickstart<\/a>/);
});

test("md: XSS sentinel - raw HTML, scripts, handlers and bad links never become markup", async () => {
  const md = await load("md.js");
  const sentinel = [
    "# <script>alert('x')</script>",
    "",
    "<img src=x onerror=alert(1)> and <b>bold</b>",
    "",
    "[click](javascript:alert(1)) [data](data:text/html,<script>1</script>) [plain](http://example.com) [proto](//evil.example/x)",
    "",
    "- <iframe src=//evil.example></iframe>",
    "",
    "`<svg onload=alert(1)>`",
    "",
    "[quote](https://example.com/\" onmouseover=\"alert(1))",
    "",
    "```",
    "</code></pre><script>alert(2)</script>",
    "```",
    "",
    "**<u>x</u>**",
  ].join("\n");
  const html = md.renderHtml(sentinel);
  // The only tags in the output are the ones the renderer itself writes.
  const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((match) => match[1].toLowerCase());
  const allowed = new Set(["h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "pre", "code", "strong", "a"]);
  assert.deepEqual(tags.filter((tag) => !allowed.has(tag)), [], html);
  // Event-handler text survives only as escaped text, never inside a tag.
  assert.doesNotMatch(html, /<(?:script|img|iframe|svg|b|u)[\s>/]/i);
  assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /href="(?:javascript|data|http:|\/\/)/i);
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  // The AST carries the same text; the Preact renderer escapes text nodes.
  const blocks = md.parseMarkdown(sentinel);
  const links = JSON.stringify(blocks).match(/"type":"link","href":"[^"]*"/g) || [];
  assert.deepEqual(links, [], "no sentinel link is allowed through");
});

test("md: safeHref allows https URLs and site paths only", async () => {
  const md = await load("md.js");
  assert.equal(md.safeHref("https://example.com/x"), "https://example.com/x");
  assert.equal(md.safeHref("/docs/errors#rate_limit_exceeded"), "/docs/errors#rate_limit_exceeded");
  for (const bad of ["http://example.com", "javascript:alert(1)", "JaVaScRiPt:1", "data:text/plain,x", "//evil.example", "ftp://x", "https://", "https://a b", "", "mailto:a@b.c", " java\nscript:1"]) {
    assert.equal(md.safeHref(bad), "", bad);
  }
});

test("md: an unterminated fence and odd input never throw", async () => {
  const md = await load("md.js");
  assert.match(md.renderHtml("```\nopen\nforever"), /<pre><code>open\nforever<\/code><\/pre>/);
  for (const odd of ["", null, undefined, "[", "[a](", "**", "`", "# ", "#", "\r\n\r\n", "\uFEFF# bom"]) {
    assert.doesNotThrow(() => md.renderHtml(odd));
  }
  assert.match(md.renderHtml("\uFEFF# bom"), /<h1 id="bom">bom<\/h1>/);
});

test("md: heading ids are unique and non-ASCII headings still get one", async () => {
  const md = await load("md.js");
  const ids = md.parseMarkdown("## Same\n\n## Same\n\n## 中文标题").filter((b) => b.type === "heading").map((b) => b.id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((id) => /^[a-z0-9-]+$/.test(id)));
});

// ---- client snippets -----------------------------------------------------------

test("snippets: every required client of 05 §12.4 is present with asOf and versionTested", async () => {
  const snippets = await load("snippets.js");
  const doc = readJson("data", "client-snippets.json");
  assert.deepEqual(snippets.validateSnippetDocument(doc), []);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.staleAfterDays, 90);
  const byId = new Map(doc.clients.map((entry) => [entry.id, entry]));
  for (const id of snippets.REQUIRED_CLIENT_IDS) {
    const entry = byId.get(id);
    assert.ok(entry, `missing ${id}`);
    assert.match(entry.asOf, /^\d{4}-\d{2}-\d{2}$/, `${id} asOf`);
    assert.ok(String(entry.versionTested).trim(), `${id} versionTested`);
  }
  // The required list itself covers the spec's clients.
  const names = doc.clients.map((entry) => entry.name).join("|").toLowerCase();
  for (const wanted of ["curl", "python", "node", "anthropic", "claude code", "open webui", "chatbox", "cherry studio", "nextchat", "lobechat", "cursor", "continue", "cline"]) {
    assert.ok(names.includes(wanted), `no client named ${wanted}`);
  }
  assert.match(byId.get("curl-chat").code, /\/chat\/completions/);
  assert.match(byId.get("curl-stream").code, /"stream": true/);
  assert.match(byId.get("curl-embeddings").code, /\/embeddings/);
  assert.match(byId.get("curl-tts").code, /\/audio\/speech/);
  assert.match(byId.get("tts-openai").code, /audio\.speech/);
});

test("snippets: the spec's exact variables appear in each client", async () => {
  const doc = readJson("data", "client-snippets.json");
  const text = (id) => JSON.stringify(doc.clients.find((entry) => entry.id === id));
  assert.match(text("python-anthropic"), /base_url=\\"\{\{ANTHROPIC_BASE\}\}\\"/);
  for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"]) assert.match(text("claude-code"), new RegExp(name));
  assert.match(text("openwebui"), /\{\{OPENAI_BASE\}\}/);
  assert.match(text("chatbox"), /\{\{BASE\}\}[\s\S]*\/v1\/chat\/completions/);
  assert.match(text("cherry-studio"), /\{\{BASE\}\}/);
  assert.match(text("nextchat"), /BASE_URL=\{\{BASE\}\}/);
  assert.match(text("lobechat"), /OPENAI_PROXY_URL=\{\{OPENAI_BASE\}\}/);
  assert.match(text("continue"), /provider: openai[\s\S]*apiBase: \{\{OPENAI_BASE\}\}/);
  for (const id of ["nextchat", "lobechat"]) {
    const entry = doc.clients.find((item) => item.id === id);
    assert.match(entry.note_en, /My Key/);
    assert.match(entry.note_zh, /我的密钥/);
  }
});

test("snippets: base URLs come from portal-config and the key is $API_KEY by default", async () => {
  const snippets = await load("snippets.js");
  const doc = readJson("data", "client-snippets.json");
  const context = snippets.templateContext({ config: CONFIG, model: "demo-model", key: "sk-test-fake0001" });
  assert.equal(context.KEY, "$API_KEY");
  for (const entry of doc.clients) {
    for (const lang of LOCALES) {
      const view = snippets.renderClient(entry, lang, context);
      const text = view.kind === "code" ? view.code : view.steps.join("\n");
      assert.doesNotMatch(text, /\{\{/, `${entry.id} ${lang} leaves a placeholder`);
      assert.doesNotMatch(text, /sk-test-fake0001/, `${entry.id} ${lang} leaks the key`);
      if (entry.fields.includes("KEY")) assert.ok(text.includes("$API_KEY"), `${entry.id} ${lang} has no $API_KEY`);
      if (entry.fields.includes("OPENAI_BASE")) assert.ok(text.includes(CONFIG.openaiBase), `${entry.id} ${lang} has no OpenAI base`);
      if (entry.fields.includes("ANTHROPIC_BASE")) assert.ok(text.includes(CONFIG.anthropicBase), `${entry.id} ${lang} has no Anthropic base`);
      if (entry.fields.includes("BASE")) assert.ok(text.includes(CONFIG.baseUrl), `${entry.id} ${lang} has no base`);
      if (entry.fields.includes("MODEL")) assert.ok(text.includes("demo-model"), `${entry.id} ${lang} has no model`);
    }
  }
});

test("snippets: the key is inserted only on request and only when it is key-safe", async () => {
  const snippets = await load("snippets.js");
  const key = "sk-test-fake0001";
  assert.equal(snippets.templateContext({ config: CONFIG, key, insertKey: true }).KEY, key);
  assert.equal(snippets.templateContext({ config: CONFIG, key, insertKey: false }).KEY, "$API_KEY");
  assert.equal(snippets.templateContext({ config: CONFIG, key: "", insertKey: true }).KEY, "$API_KEY");
  // A value that could break out of a command or a file is never inserted.
  for (const bad of ['sk-"; rm -rf /', "sk-a b", "sk-$(x)", "sk-`x`", "sk-'x'", "sk-\nx"]) {
    assert.equal(snippets.templateContext({ config: CONFIG, key: bad, insertKey: true }).KEY, "$API_KEY", bad);
  }
});

test("snippets: a missing portal-config falls back to the request origin; models are validated", async () => {
  const snippets = await load("snippets.js");
  const context = snippets.templateContext({ config: { baseUrl: "", openaiBase: "", anthropicBase: "" }, origin: "http://192.0.2.10:5186/", model: "bad model!" });
  assert.equal(context.BASE, "http://192.0.2.10:5186");
  assert.equal(context.OPENAI_BASE, "http://192.0.2.10:5186/v1");
  assert.equal(context.ANTHROPIC_BASE, "http://192.0.2.10:5186/anthropic");
  assert.equal(context.MODEL, snippets.DEFAULT_MODEL);
  // Replacement text containing $& or $1 is inserted literally.
  assert.equal(snippets.fillTemplate("a {{MODEL}} b {{UNKNOWN}}", { MODEL: "$& $1" }), "a $& $1 b {{UNKNOWN}}");
});

test("snippets: the document goes stale after 90 days", async () => {
  const snippets = await load("snippets.js");
  const doc = { asOf: "2026-01-01", staleAfterDays: 90 };
  assert.deepEqual(snippets.snippetAge(doc, Date.parse("2026-02-01T00:00:00Z")), { asOf: "2026-01-01", ageDays: 31, stale: false });
  assert.equal(snippets.snippetAge(doc, Date.parse("2026-04-02T00:00:00Z")).stale, true);
  assert.equal(snippets.snippetAge({}, Date.now()).stale, true);
});

test("snippets: the validator reports a broken document", async () => {
  const snippets = await load("snippets.js");
  const doc = readJson("data", "client-snippets.json");
  const broken = JSON.parse(JSON.stringify(doc));
  delete broken.clients[0].versionTested;
  delete broken.clients[1].asOf;
  broken.clients[2].code = "{{TOKEN}}";
  broken.clients = broken.clients.filter((entry) => entry.id !== "cline");
  const problems = snippets.validateSnippetDocument(broken).join("\n");
  assert.match(problems, /curl-chat: no versionTested/);
  assert.match(problems, /curl-stream: no asOf/);
  assert.match(problems, /unknown placeholder \{\{TOKEN\}\}/);
  assert.match(problems, /missing required client cline/);
});

test("snippets: no tracked sample holds a real-looking key, address or user path", () => {
  const text = readJson("data", "client-snippets.json").clients.map((entry) => [entry.code, ...(entry.steps_zh || []), ...(entry.steps_en || []), entry.note_zh, entry.note_en].join("\n")).join("\n");
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}/);
  assert.doesNotMatch(text, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  assert.doesNotMatch(text, /\b[A-Za-z]:\\[A-Za-z]|\/Users\/|\/home\//);
});

// ---- docs pages --------------------------------------------------------------------

test("docs: every page exists in both languages, and the router can reach them", async () => {
  for (const slug of SLUGS) {
    for (const locale of LOCALES) {
      const file = path.join(PORTAL, "docs", `${slug}.${locale}.md`);
      assert.ok(fs.existsSync(file), `${slug}.${locale}.md`);
      assert.match(fs.readFileSync(file, "utf8"), /^# \S/, `${slug}.${locale}.md starts with a title`);
    }
  }
  const docsDir = fs.readdirSync(path.join(PORTAL, "docs"));
  assert.equal(docsDir.length, SLUGS.length * 2, "no stray files in docs/");
  const router = await load("router.js");
  for (const slug of SLUGS) assert.equal(router.matchRoute(`/docs/${slug}`).page, "docs");
  const source = fs.readFileSync(path.join(PORTAL, "pages", "docs.js"), "utf8");
  assert.deepEqual(SLUGS, [...source.match(/DOC_SLUGS = Object\.freeze\(\[([^\]]+)\]/)[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
});

test("docs: English pages have no Han text outside code, and Chinese pages have some", () => {
  for (const slug of SLUGS) {
    const en = readDoc(slug, "en-US").replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    assert.doesNotMatch(en, HAN, `${slug}.en-US.md has Han text`);
    assert.match(readDoc(slug, "zh-CN"), HAN, `${slug}.zh-CN.md has no Chinese`);
  }
});

test("docs: both languages use the same placeholders, links and code fences", async () => {
  const snippets = await load("snippets.js");
  const md = await load("md.js");
  for (const slug of SLUGS) {
    const placeholders = (locale) => [...new Set([...readDoc(slug, locale).matchAll(/\{\{([A-Za-z_]+)\}\}/g)].map((m) => m[1]))].sort();
    assert.deepEqual(placeholders("zh-CN"), placeholders("en-US"), `${slug} placeholders`);
    for (const name of placeholders("en-US")) assert.ok(snippets.PLACEHOLDERS.includes(name), `${slug}: unknown {{${name}}}`);
    const links = (locale) => [...readDoc(slug, locale).matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(links("zh-CN"), links("en-US"), `${slug} links`);
    const fences = (locale) => md.parseMarkdown(readDoc(slug, locale)).filter((block) => block.type === "code").map((block) => block.lang);
    assert.deepEqual(fences("zh-CN"), fences("en-US"), `${slug} code blocks`);
  }
});

test("docs: internal links point at real portal pages and every external link is https", () => {
  const routes = new Set(["/me", "/models", "/status", "/playground", "/announcements", "/docs", ...SLUGS.map((slug) => `/docs/${slug}`)]);
  for (const slug of SLUGS) {
    for (const locale of LOCALES) {
      for (const match of readDoc(slug, locale).matchAll(/\]\(([^)]+)\)/g)) {
        const href = match[1];
        if (href.startsWith("/")) assert.ok(routes.has(href.split("#")[0]), `${slug}.${locale}: ${href}`);
        else assert.match(href, /^https:\/\//, `${slug}.${locale}: ${href}`);
      }
    }
  }
});

test("docs: no page carries a real key, an address or a user path", () => {
  for (const slug of SLUGS) {
    for (const locale of LOCALES) {
      const text = readDoc(slug, locale);
      assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}/, `${slug}.${locale}`);
      assert.doesNotMatch(text, /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[A-Za-z]:\\[A-Za-z]|\/Users\/|\/home\//, `${slug}.${locale}`);
    }
  }
});

test("docs: the privacy page lists the logged fields, the unlogged content, retention and the chat-site audit notice", () => {
  const en = readDoc("privacy", "en-US");
  const zh = readDoc("privacy", "zh-CN");
  for (const field of ["time of the request", "key id", "model", "token counts", "timings", "network address", "country"]) {
    assert.match(en, new RegExp(field, "i"), `en: ${field}`);
  }
  for (const field of ["请求时间", "密钥 ID", "模型", "token 数量", "耗时", "网络地址", "国家"]) assert.ok(zh.includes(field), `zh: ${field}`);
  assert.match(en, /prompt and the response[^.]*not stored/i);
  assert.match(zh, /提示词和回答内容不会被保存/);
  assert.match(en, /\{\{RETENTION_DAYS\}\}/);
  assert.match(zh, /\{\{RETENTION_DAYS\}\}/);
  assert.match(en, /Open WebUI[^.]*audit/i);
  assert.match(zh, /Open WebUI[^。]*审计/);
  assert.match(en, /Cloudflare/);
});

test("docs: retention days come from the portal config when it carries them", async () => {
  const snippets = await load("snippets.js");
  assert.equal(snippets.templateContext({ config: CONFIG }).RETENTION_DAYS, "30");
  assert.equal(snippets.templateContext({ config: { ...CONFIG, retention: { requestDays: 14 } } }).RETENTION_DAYS, "14");
  assert.equal(snippets.templateContext({ config: { ...CONFIG, retention: { requestDays: -1 } } }).RETENTION_DAYS, "30");
});

test("docs: the quickstart, streaming and limits pages say what 05 §12.4 requires", () => {
  assert.match(readDoc("quickstart", "en-US"), /\{\{OPENAI_BASE\}\}/);
  assert.match(readDoc("quickstart", "en-US"), /\{\{ANTHROPIC_BASE\}\}/);
  assert.match(readDoc("streaming", "en-US"), /stream: true[\s\S]*100 seconds|100 seconds[\s\S]*stream: true/);
  assert.match(readDoc("streaming", "zh-CN"), /100 秒/);
  assert.match(readDoc("clients", "en-US"), /stream: true/);
  const limits = readDoc("limits", "en-US");
  for (const word of ["x-ratelimit-limit-requests", "retry-after", "insufficient_quota", "overloaded"]) assert.match(limits, new RegExp(word));
});

// ---- errors page ---------------------------------------------------------------------

test("errors: the page data is generated from the taxonomy and has not drifted", () => {
  const onDisk = fs.readFileSync(DATA_PATH, "utf8").replace(/\r\n/g, "\n");
  assert.equal(onDisk, serializeErrorDocs(), "run: node service-entry/lib/portal-error-docs.js --write");
});

test("errors: every taxonomy code has an entry with status, types, message and zh/en copy", () => {
  const data = readJson("data", "error-taxonomy.json");
  assert.equal(data.schemaVersion, 1);
  assert.deepEqual(data.errors.map((item) => item.code), PUBLIC_ERROR_TAXONOMY.map((item) => item.code));
  for (const item of data.errors) {
    assert.ok(Number.isInteger(item.status) && item.status >= 400, item.code);
    assert.ok(item.openaiType && item.anthropicType && item.message, item.code);
    for (const locale of LOCALES) {
      const copy = item.copy[locale];
      assert.ok(copy.title && copy.explanation && copy.steps.length, `${item.code} ${locale}`);
    }
    assert.ok(!HAN.test(item.message), `${item.code}: the message is a stable English constant`);
    assert.ok(!HAN.test(JSON.stringify(item.copy["en-US"])), `${item.code}: English copy has Han text`);
  }
  const rate = data.errors.find((item) => item.code === "rate_limit_exceeded");
  assert.equal(rate.retryAfter, true);
  assert.equal(data.errors.find((item) => item.code === "missing_api_key").retryAfter, false);
});

test("errors: the HTML error page links to an anchor the docs page has", () => {
  const codes = new Set(readJson("data", "error-taxonomy.json").errors.map((item) => item.code));
  for (const item of PUBLIC_ERROR_TAXONOMY) {
    const page = renderErrorPage({ code: item.code, lang: "en-US", requestId: "req_aaaaaaaaaaaaaaaaaaaa" });
    const href = /href="(\/docs\/errors#[a-z_]+)"/.exec(page);
    assert.ok(href, `${item.code}: no docs link`);
    assert.ok(codes.has(href[1].split("#")[1]), `${item.code}: the docs page has no such anchor`);
  }
});

test("errors: the docs page names the same code in the markdown intro, never a path or port", () => {
  for (const locale of LOCALES) {
    const intro = readDoc("errors", locale);
    assert.match(intro, /request_id/);
  }
  const text = fs.readFileSync(DATA_PATH, "utf8");
  assert.doesNotMatch(text, /\b[A-Za-z]:\\[A-Za-z]|\/Users\/|\.js\b|\.json\b|localhost|127\.0\.0\.1|:\d{4,5}\b/);
});

// ---- serving -----------------------------------------------------------------------------

test("serving: docs markdown and data files are part of the portal snapshot's servable set", () => {
  // portal-routes serves every file under portal/ with a known extension; the new
  // files must all have one (a file without it would be a silent 404).
  const exts = new Set([".js", ".mjs", ".css", ".json", ".svg", ".woff2", ".md"]);
  for (const dir of ["docs", "data"]) {
    for (const name of fs.readdirSync(path.join(PORTAL, dir))) assert.ok(exts.has(path.extname(name)), `${dir}/${name}`);
  }
});
