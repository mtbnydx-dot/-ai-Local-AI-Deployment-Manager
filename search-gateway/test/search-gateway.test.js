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
