// 07 §4.4 MarkdownViewer / §10 / §13.1: hostile and ordinary markdown becomes
// token trees (golden/markdown.json) that hold no raw HTML node and no
// unsafe URL, however the input is built, and that stay bounded for giant or
// deeply nested input.
//
// To refresh the golden after a deliberate parser change, run this file with
// CONSOLE_GOLDEN_UPDATE=1 and review the diff before committing it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LIMITS, parseMarkdown, resolveImage, resolveLink } from "../../console/lib/markdown.js";
import { safeUrl } from "../../console/lib/url.js";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "markdown.json");

const CASES = [
  ["headings, paragraphs and emphasis", "# Title\n\nSome **bold**, *italic*, ~~gone~~ and `code`.\n\nSetext\n======\n\nSecond\n------"],
  ["raw script block stays text", "<script>alert(1)</script>\n\nafter"],
  ["raw html inside a paragraph stays text", "hello <b onclick=\"x()\">bold</b> <img src=x onerror=alert(1)> end"],
  ["nested html", "<div><div><iframe src=\"https://evil.invalid\"></iframe></div></div>"],
  ["html comment and cdata", "<!-- hidden --> text <![CDATA[ x ]]>"],
  ["javascript links are dropped", "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](  javascript:alert(1)) [d](java\tscript:alert(1)) [e](&#106;avascript:alert(1))"],
  ["other unsafe schemes are dropped", "[a](data:text/html,<script>alert(1)</script>) [b](vbscript:msgbox) [c](file:///etc/passwd) [d](//evil.invalid/x) [e](\\\\host\\share)"],
  ["safe links survive", "[web](https://example.invalid/a?b=1#c) [rel](./docs/readme.md) [up](../x) [anchor](#top) [query](?page=2) <https://example.invalid/auto>"],
  ["unsafe autolink and image", "<javascript:alert(1)> ![x](javascript:alert(1)) ![ok](/img/a.png \"title\") ![remote](https://example.invalid/p.png)"],
  ["link text keeps its formatting when the link is dropped", "[**bold** `code`](javascript:alert(1))"],
  ["lists", "- a\n- b\n  - nested\n  - nested two\n- c\n\n1. one\n2. two\n\n3) three"],
  ["code fences keep html as text", "```html\n<script>alert(1)</script>\n```\n\n~~~\nplain\n~~~\n\n    indented <b>\n    code"],
  ["tables with alignment", "| a | b | c |\n|:--|:-:|--:|\n| 1 | **2** | [x](javascript:alert(1)) |\n| 3 | `|` | \\| |"],
  ["block quote and rule", "> quote\n> more\n>\n> > nested\n\n---\n\n***"],
  ["escapes and breaks", "line one  \nline two\\\nline three \\*not em\\* and \\<b\\>"],
  ["unicode", "你好 **世界**\n\n表 | 值\n--- | ---\n甲 | 乙"],
  ["unclosed constructs stay text", "**open [link](https://example.invalid `code\n\n```\nunclosed fence"],
  ["a stray html table is text", "<table><tr><td>x</td></tr></table>"],
];

const BLOCK_TYPES = new Set(["heading", "paragraph", "blockquote", "list", "code", "hr", "table"]);
const INLINE_TYPES = new Set(["text", "code", "em", "strong", "del", "link", "image", "br"]);

/** Throws on any node type outside the whitelist, any unsafe URL and any unexpected field holding markup. */
function assertSafeTree(node, where = "root") {
  if (Array.isArray(node)) {
    node.forEach((child, index) => assertSafeTree(child, `${where}[${index}]`));
    return;
  }
  assert.ok(node && typeof node === "object", `${where} is a node`);
  assert.ok(node.type === "root" || BLOCK_TYPES.has(node.type) || INLINE_TYPES.has(node.type), `${where}: unknown node type ${node.type}`);
  assert.notEqual(node.type, "html", `${where}: raw HTML node`);
  if (node.type === "link") assert.equal(safeUrl(node.href), node.href, `${where}: unsafe link ${node.href}`);
  if (node.type === "image") assert.equal(safeUrl(node.src), node.src, `${where}: unsafe image ${node.src}`);
  if (node.children) assertSafeTree(node.children, `${where}.children`);
  if (node.items) node.items.forEach((item, index) => assertSafeTree(item.children, `${where}.items[${index}]`));
  if (node.head) node.head.forEach((cell, index) => assertSafeTree(cell, `${where}.head[${index}]`));
  if (node.rows) node.rows.forEach((row, at) => row.forEach((cell, index) => assertSafeTree(cell, `${where}.rows[${at}][${index}]`)));
}

function collect(node, predicate, out = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, predicate, out));
    return out;
  }
  if (!node || typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  for (const key of ["children", "head"]) if (node[key]) collect(node[key], predicate, out);
  if (node.items) node.items.forEach((item) => collect(item.children, predicate, out));
  if (node.rows) node.rows.forEach((row) => row.forEach((cell) => collect(cell, predicate, out)));
  return out;
}

test("the trees match the golden", () => {
  const actual = { schemaVersion: 1, cases: CASES.map(([name, input]) => ({ case: name, tree: parseMarkdown(input) })) };
  if (process.env.CONSOLE_GOLDEN_UPDATE === "1") fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  assert.equal(golden.cases.length, CASES.length, "the golden lists every case");
  for (let index = 0; index < CASES.length; index += 1) {
    assert.equal(golden.cases[index].case, CASES[index][0]);
    assert.deepEqual(actual.cases[index].tree, golden.cases[index].tree, CASES[index][0]);
  }
});

test("no tree has a raw HTML node or an unsafe URL", () => {
  for (const [name, input] of CASES) assertSafeTree(parseMarkdown(input), name);
  assert.equal(CASES.length > 10, true);
});

test("raw HTML is only ever text", () => {
  const tree = parseMarkdown("<script>alert(1)</script>\n\nhi <b>there</b>");
  const texts = collect(tree, (node) => node.type === "text").map((node) => node.text).join("|");
  assert.match(texts, /<script>alert\(1\)<\/script>/);
  assert.match(texts, /<b>/);
  assert.equal(collect(tree, (node) => node.type !== "root" && !BLOCK_TYPES.has(node.type) && !INLINE_TYPES.has(node.type)).length, 0);
});

test("javascript: and other unsafe links are dropped but their text stays", () => {
  const tree = parseMarkdown("[click me](javascript:alert(1)) and [x](JAVASCRIPT:alert(1)) and [y](data:text/html;base64,AAAA) and [z](vbscript:x)");
  assert.equal(collect(tree, (node) => node.type === "link").length, 0);
  const texts = collect(tree, (node) => node.type === "text").map((node) => node.text).join("");
  assert.match(texts, /click me/);
  assert.equal(/javascript:/i.test(JSON.stringify(collect(tree, (node) => node.type === "link" || node.type === "image"))), false);
});

test("safe links keep their href and title", () => {
  const tree = parseMarkdown("[a](https://example.invalid/x \"T\") [b](/rel) [c](#frag) [d](sub/page.md)");
  const links = collect(tree, (node) => node.type === "link");
  assert.deepEqual(links.map((link) => link.href), ["https://example.invalid/x", "/rel", "#frag", "sub/page.md"]);
  assert.equal(links[0].title, "T");
});

test("an image with an unsafe source becomes its alt text", () => {
  const tree = parseMarkdown("![alt text](javascript:alert(1))");
  assert.equal(collect(tree, (node) => node.type === "image").length, 0);
  assert.match(collect(tree, (node) => node.type === "text").map((node) => node.text).join(""), /alt text/);
});

test("a giant table is cut at the row and column caps", () => {
  const columns = LIMITS.maxTableColumns + 8;
  const header = `|${Array.from({ length: columns }, (_, index) => ` h${index} `).join("|")}|`;
  const delimiter = `|${Array.from({ length: columns }, () => " --- ").join("|")}|`;
  const row = `|${Array.from({ length: columns }, (_, index) => ` c${index} `).join("|")}|`;
  const source = [header, delimiter, ...Array.from({ length: LIMITS.maxTableRows + 200 }, () => row)].join("\n");
  const tree = parseMarkdown(source);
  const table = tree.children[0];
  assert.equal(table.type, "table");
  assert.equal(table.head.length, LIMITS.maxTableColumns);
  assert.equal(table.rows.length, LIMITS.maxTableRows);
  assert.equal(table.rows[0].length, LIMITS.maxTableColumns);
  assert.equal(table.truncated, true);
  assert.equal(tree.truncated, true);
  assertSafeTree(tree);
});

test("deep nesting is bounded and does not overflow the stack", () => {
  const quotes = `${"> ".repeat(500)}deep`;
  const lists = Array.from({ length: 300 }, (_, depth) => `${"  ".repeat(depth)}- item`).join("\n");
  for (const source of [quotes, lists, `${"*a ".repeat(2000)}`, `${"[".repeat(3000)}x${"]".repeat(3000)}`, "_".repeat(5000), "**".repeat(3000)]) {
    const started = Date.now();
    const tree = parseMarkdown(source);
    assertSafeTree(tree);
    assert.ok(Date.now() - started < 3000, "parses in bounded time");
  }
  assert.equal(parseMarkdown(quotes).truncated, true);
});

test("oversized input is cut and marked truncated", () => {
  const tree = parseMarkdown("a".repeat(LIMITS.maxChars + 10));
  assert.equal(tree.truncated, true);
  const paragraph = tree.children[0];
  assert.equal(paragraph.type, "paragraph");
  assert.ok(paragraph.children[0].text.length <= LIMITS.maxChars);
});

test("non-string input is an empty document", () => {
  for (const value of [undefined, null, 42, {}, []]) assert.deepEqual(parseMarkdown(value), { type: "root", children: [], truncated: false });
});

test("a broken construct never loses text or throws", () => {
  const tree = parseMarkdown("[unclosed(https://example.invalid\n\n[a](<broken\n\n![img(x)\n\n`tick");
  const texts = collect(tree, (node) => node.type === "text" || node.type === "code").map((node) => node.text).join(" ");
  for (const word of ["unclosed", "broken", "img", "tick"]) assert.match(texts, new RegExp(word));
});

test("resolveLink resolves against the base, marks other origins external and refuses unsafe URLs", () => {
  const origin = "https://console.example.invalid";
  assert.deepEqual(resolveLink("#top", { origin }), { href: "#top", external: false });
  assert.deepEqual(resolveLink("https://other.invalid/x", { origin }), { href: "https://other.invalid/x", external: true });
  assert.deepEqual(resolveLink("/models/a", { origin }), { href: "/models/a", external: false });
  assert.deepEqual(resolveLink("img/a.png", { baseHref: "/models/qwen/", origin }), { href: "/models/qwen/img/a.png", external: false });
  assert.equal(resolveLink("img/a.png", { baseHref: "https://raw.example.invalid/repo/", origin }).external, true);
  assert.equal(resolveLink("javascript:alert(1)", { origin }), null);
  assert.equal(resolveLink("//evil.invalid", { origin }), null);
  assert.deepEqual(resolveLink("https://a.invalid", {}), { href: "https://a.invalid/", external: true }, "without an origin every absolute URL is external");
  assert.deepEqual(resolveLink("docs/a.md", {}), { href: "docs/a.md", external: false });
});

test("resolveImage loads only same-origin images and nothing when images are off", () => {
  const origin = "https://console.example.invalid";
  assert.equal(resolveImage("/assets/a.png", { origin }), "/assets/a.png");
  assert.equal(resolveImage("a.png", { origin, baseHref: "/docs/" }), "/docs/a.png");
  assert.equal(resolveImage(`${origin}/x.png`, { origin }), "/x.png");
  assert.equal(resolveImage("https://tracker.invalid/p.png", { origin }), null);
  assert.equal(resolveImage("a.png", { origin, baseHref: "https://raw.example.invalid/" }), null, "a relative image on a remote base is remote");
  assert.equal(resolveImage("/assets/a.png", { origin, allow: "none" }), null);
  assert.equal(resolveImage("javascript:alert(1)", { origin }), null);
  assert.equal(resolveImage("#x", { origin }), null);
  assert.equal(resolveImage("https://tracker.invalid/p.png", {}), null, "without an origin nothing absolute loads");
});
