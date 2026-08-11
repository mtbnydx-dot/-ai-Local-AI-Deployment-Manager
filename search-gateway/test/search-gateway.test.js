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
