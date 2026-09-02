const assert = require("node:assert/strict");
const test = require("node:test");

const gateway = require("../server");

test("auto search detects current web intent and respects no-search intent", () => {
  assert.equal(gateway.shouldAutoSearch({
    messages: [{ role: "user", content: "帮我查一下今天 Qwen 最新版本" }],
  }), true);
  assert.equal(gateway.shouldAutoSearch({
    messages: [{ role: "user", content: "不要联网，解释一下 transformer attention" }],
  }), false);
});

test("search policy can be controlled by header or body", () => {
  const config = { searchMode: "auto" };
  assert.equal(gateway.resolveSearchPolicy({ "x-web-search": "always" }, {}, config), "always");
  assert.equal(gateway.resolveSearchPolicy({}, { web_search: false }, config), "off");
  assert.equal(gateway.resolveSearchPolicy({}, {}, { searchMode: "off" }), "off");
});

test("direct-search options normalize safe-search levels", () => {
  const config = { maxResults: 5 };
  assert.equal(gateway.searchOptionsFromInput({ safesearch: "0" }, config).safesearch, 0);
  assert.equal(gateway.searchOptionsFromInput({ safesearch: "2" }, config).safesearch, 2);
  assert.equal(gateway.searchOptionsFromInput({ safesearch: "9" }, config).safesearch, 1);
});

test("direct-search route forwards the normalized safe-search level", async (t) => {
  let backendUrl = "";
  const config = {
    host: "127.0.0.1",
    gatewayApiKey: "search-test-key",
    allowNoKey: false,
    searchBackendUrl: "http://searxng.test",
    searchTimeoutMs: 1000,
    maxResults: 5,
  };
  const server = gateway.createSearchGatewayServer(config, {
    fetch: async (url) => {
      backendUrl = String(url);
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.equal(typeof address, "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/search?q=mcp&safesearch=2`, {
    headers: { authorization: "Bearer search-test-key" },
  });
  assert.equal(response.status, 200);
  assert.equal(new URL(backendUrl).searchParams.get("safesearch"), "2");
});

test("augmented chat body inserts search context after system messages", () => {
  const body = {
    model: "local-current",
    web_search: true,
    search_options: { query: "example" },
    messages: [
      { role: "system", content: "Follow developer rules." },
      { role: "user", content: "最新消息是什么？" },
    ],
  };
  const augmented = gateway.buildAugmentedChatBody(body, {
    query: "example",
    searchedAt: "2026-07-02T00:00:00.000Z",
    results: [{ title: "Result", url: "https://example.com", content: "Snippet" }],
  });

  assert.equal(augmented.web_search, undefined);
  assert.equal(augmented.search_options, undefined);
  assert.equal(augmented.messages.length, 3);
  assert.equal(augmented.messages[0].role, "system");
  assert.equal(augmented.messages[1].role, "system");
  assert.match(augmented.messages[1].content, /Search results/);
  assert.match(augmented.messages[1].content, /https:\/\/example.com/);
});

test("search result normalization keeps bounded source fields", () => {
  const results = gateway.normalizeSearchResults([
    { title: "A", url: "https://a.example", content: "alpha", engines: ["duckduckgo"] },
    { title: "B", url: "", content: "missing url" },
    { title: "C", url: "https://c.example", content: "gamma" },
  ], 1);

  assert.deepEqual(results, [{
    title: "A",
    url: "https://a.example",
    content: "alpha",
    engine: "duckduckgo",
    score: null,
    category: "",
    publishedDate: "",
  }]);
});

test("answer normalization handles SearXNG object answers", () => {
  assert.deepEqual(gateway.normalizeAnswers([
    { answer: "direct answer" },
    { content: "content answer" },
    "plain answer",
  ]), ["direct answer", "content answer", "plain answer"]);
});

test("buildSearchQuery removes command words and clips long prompts", () => {
  const query = gateway.buildSearchQuery("请帮我联网搜索一下 Qwen 2026 最新 release notes");
  assert.equal(query.includes("搜索"), false);
  assert.match(query, /Qwen 2026/);
  assert.ok(query.length <= 240);
});

test("search, research, direct-open, and result-reading routes preserve their safety boundaries", async (t) => {
  const pageUrls = [];
  const config = {
    host: "127.0.0.1",
    gatewayApiKey: "workflow-test-key",
    allowNoKey: false,
    searchBackendUrl: "http://searxng.test",
    searchTimeoutMs: 1000,
    maxResults: 8,
    searchDefaultEngines: ["bing"],
    searchChineseEngines: ["baidu"],
    searchFallbackEngines: ["brave"],
  };
  const server = gateway.createSearchGatewayServer(config, {
    fetch: async (url) => {
      const query = new URL(String(url)).searchParams.get("q");
      return new Response(JSON.stringify({
        results: [{
          title: `${query} official source`,
          url: `https://example.com/${encodeURIComponent(query)}`,
          content: `${query} source text`,
          engines: ["bing"],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    readPage: async (url) => {
      pageUrls.push(url);
      return {
        finalUrl: url,
        domain: "example.com",
        title: "Readable source",
        description: "",
        publishedAt: null,
        contentType: "text/html",
        content: "Bounded page text.",
        charCount: 18,
        truncated: false,
      };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer workflow-test-key" };

  const healthResponse = await fetch(`${base}/health`);
  const health = await healthResponse.json();
  assert.equal(health.version, "0.4.0");

  const searchResponse = await fetch(`${base}/search?q=MCP+workflow`, { headers });
  const search = await searchResponse.json();
  assert.equal(searchResponse.status, 200);
  assert.match(search.searchId, /^[0-9a-f-]{36}$/);
  assert.equal(search.results[0].resultId, "r1");

  const readResponse = await fetch(`${base}/read`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      search_id: search.searchId,
      result_ids: ["r1"],
      url: "http://127.0.0.1:5177/api/status",
    }),
  });
  const read = await readResponse.json();
  assert.equal(read.ok, true);
  assert.equal(read.documents[0].content, "Bounded page text.");
  assert.deepEqual(pageUrls, [search.results[0].url]);

  const findResponse = await fetch(`${base}/find`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ search_id: search.searchId, result_id: "r1", pattern: "page text" }),
  });
  const found = await findResponse.json();
  assert.equal(findResponse.status, 200);
  assert.equal(found.matchCount, 1);
  assert.match(found.matches[0].context, /Bounded page text/);
  assert.deepEqual(pageUrls, [search.results[0].url], "find should reuse the safely extracted page cache");

  const openResponse = await fetch(`${base}/open`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ urls: ["https://example.org/direct-page"], max_chars_per_url: 3000 }),
  });
  const opened = await openResponse.json();
  assert.equal(openResponse.status, 200);
  assert.equal(opened.ok, true);
  assert.equal(opened.documents[0].requestId, "u1");
  assert.equal(opened.documents[0].url, "https://example.org/direct-page");
  assert.equal(opened.documents[0].content, "Bounded page text.");
  assert.deepEqual(pageUrls, [search.results[0].url, "https://example.org/direct-page"]);

  const repeatedOpenResponse = await fetch(`${base}/open`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ urls: ["https://example.org/direct-page"] }),
  });
  assert.equal(repeatedOpenResponse.status, 200);
  assert.deepEqual(pageUrls, [search.results[0].url, "https://example.org/direct-page"], "direct open should reuse the page cache");

  const privateOpenResponse = await fetch(`${base}/open`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ urls: ["http://127.0.0.1:5177/api/status"] }),
  });
  assert.equal(privateOpenResponse.status, 400);

  const invalidRead = await fetch(`${base}/read`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ search_id: search.searchId, result_ids: ["r99"] }),
  });
  assert.equal(invalidRead.status, 400);

  const researchResponse = await fetch(`${base}/research`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      queries: [{ id: "docs", query: "MCP documentation" }, { id: "sdk", query: "MCP TypeScript SDK" }],
      max_sources: 10,
    }),
  });
  const research = await researchResponse.json();
  assert.equal(researchResponse.status, 200);
  assert.equal(research.queryCoverage.length, 2);
  assert.equal(research.results.every((item) => /^r\d+$/.test(item.resultId)), true);
});
