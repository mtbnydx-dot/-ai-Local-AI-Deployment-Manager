// CON-26: shared-public/js/legacy-banner.js, the banner both manager UIs show
// to point at the unified console (07 §12).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const banner = require(path.join(__dirname, "..", "..", "shared-public", "js", "legacy-banner.js"));
const { buildUrl, sectionOf, init } = banner;

const base = { protocol: "http:", hostname: "192.0.2.10", entryPort: 5176, manager: "vllm", theme: "dark", lang: "en-US" };

test("sectionOf maps the manager hashes and ignores everything else", () => {
  for (const section of ["service", "download", "online-models", "models", "stats", "external-access", "audit", "logs", "exposure", "tools"]) {
    assert.equal(sectionOf(`#${section}`), section);
  }
  assert.equal(sectionOf("#STATS"), "stats");
  assert.equal(sectionOf("#stats?x=1"), "stats");
  assert.equal(sectionOf(""), "");
  assert.equal(sectionOf("#nonsense"), "");
  assert.equal(sectionOf("#pair=abc"), "");
  assert.equal(sectionOf("#key=abc"), "");
});

test("buildUrl is host-relative and carries the manager, theme and lang", () => {
  const url = new URL(buildUrl(base));
  assert.equal(url.origin, "http://192.0.2.10:5176");
  assert.equal(url.pathname, "/deployments");
  assert.deepEqual(Object.fromEntries(url.searchParams), { from: "vllm", theme: "dark", lang: "en-US" });
  assert.equal(url.hash, "");
  assert.equal(new URL(buildUrl({ ...base, protocol: "https:", hostname: "console.example.test" })).origin, "https://console.example.test:5176");
  assert.equal(new URL(buildUrl({ ...base, hostname: "::1" })).origin, "http://[::1]:5176");
});

test("buildUrl falls back to 5176, auto and zh-CN, and sanitizes odd input", () => {
  for (const entryPort of [undefined, null, "", 0, -1, 70000, 1.5, "abc"]) {
    assert.equal(new URL(buildUrl({ ...base, entryPort })).port, "5176", String(entryPort));
  }
  assert.equal(new URL(buildUrl({ ...base, entryPort: "6001" })).port, "6001");
  const url = new URL(buildUrl({ ...base, theme: "neon", lang: "fr" }));
  assert.equal(url.searchParams.get("theme"), "auto");
  assert.equal(url.searchParams.get("lang"), "zh-CN");
  assert.equal(new URL(buildUrl({ ...base, lang: "en" })).searchParams.get("lang"), "en-US");
});

test("buildUrl sends a mapped hash through / so the console redirects it, and drops others", () => {
  const url = new URL(buildUrl({ ...base, hash: "#stats" }));
  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("ui"), "new");
  assert.equal(url.searchParams.get("from"), "vllm");
  assert.equal(url.hash, "#stats");
  for (const hash of ["#pair=abc", "#key=abc", "#unknown"]) {
    const other = new URL(buildUrl({ ...base, hash }));
    assert.equal(other.pathname, "/deployments", hash);
    assert.equal(other.hash, "", hash);
  }
});

function fakeDom({ lang = "en-US", theme = "light" } = {}) {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.attrs = {}; this.removed = false; }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); return node; }
    setAttribute(name, value) { this.attrs[name] = value; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    remove() { this.removed = true; }
    fire(type) { for (const fn of this.listeners[type] || []) fn(); }
  }
  const doc = {
    documentElement: { lang, dataset: { theme } },
    body: new Node("body"),
    createElement: (tag) => new Node(tag),
  };
  return doc;
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

const config = (body, ok = true) => async () => ({ ok, json: async () => body });
const location = { protocol: "http:", hostname: "192.0.2.10", hash: "" };

test("init shows the banner with entryPort from /api/config and the page's theme and lang", async () => {
  const doc = fakeDom();
  const calls = [];
  const bar = await init({ document: doc, location, storage: memoryStorage(), manager: "llama", fetch: async (url, options) => { calls.push(url); return config({ entryPort: 6002 })(url, options); } });
  assert.deepEqual(calls, ["/api/config"]);
  assert.equal(doc.body.children[0], bar);
  const [message, link, close] = bar.children;
  assert.match(message.textContent, /unified console/);
  assert.equal(link.textContent, "Open");
  assert.equal(link.href, "http://192.0.2.10:6002/deployments?from=llama&theme=light&lang=en-US");
  assert.equal(link.rel, "noopener noreferrer");
  // The link follows the page when it is used.
  doc.documentElement.dataset.theme = "dark";
  location.hash = "#logs";
  link.fire("pointerdown");
  location.hash = "";
  assert.equal(link.href, "http://192.0.2.10:6002/?ui=new&from=llama&theme=dark&lang=en-US#logs");
  assert.ok(close);
});

test("init uses 5176 when entryPort is absent, the call fails or the response is not ok", async () => {
  for (const fetchImpl of [config({}), config({ entryPort: "x" }), config({ entryPort: 6002 }, false), async () => { throw new Error("offline"); }, async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })]) {
    const bar = await init({ document: fakeDom({ lang: "zh-CN" }), location, storage: memoryStorage(), manager: "vllm", fetch: fetchImpl });
    assert.equal(bar.children[1].href, "http://192.0.2.10:5176/deployments?from=vllm&theme=light&lang=zh-CN");
    assert.match(bar.children[0].textContent, /新的统一控制台已上线/);
  }
});

test("dismissing removes the banner and keeps it away; broken storage never throws", async () => {
  const storage = memoryStorage();
  const bar = await init({ document: fakeDom(), location, storage, manager: "vllm", fetch: config({}) });
  bar.children[2].fire("click");
  assert.equal(bar.removed, true);
  assert.equal(storage.map.get(banner.DISMISS_KEY), "1");
  assert.equal(await init({ document: fakeDom(), location, storage, manager: "vllm", fetch: config({}) }), null);

  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const shown = await init({ document: fakeDom(), location, storage: broken, manager: "vllm", fetch: config({}) });
  assert.ok(shown);
  shown.children[2].fire("click");
  assert.equal(shown.removed, true);
  assert.equal(await init({ document: fakeDom(), location, storage: null, manager: "", fetch: config({}) }), null);
});
