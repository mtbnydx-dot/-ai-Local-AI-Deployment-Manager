"use strict";

// The portal serving layer (05 §12.1, PUB-15): the asset snapshot keyed by the
// build id, the inline import map generated from VENDOR.json and named by hash
// in the CSP, 410 for stale ids, and static serving that refuses traversal and
// anything outside the snapshot. Every tree is a temp directory; nothing
// listens except an ephemeral loopback port.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const { createPortalRoutes, buildCsp, pickLanguage } = require("../lib/portal-routes");
const { createPublicListener } = require("../lib/public-listener");
const { loadEntry } = require("./helpers/entry-harness");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const INDEX = [
  "<!doctype html>",
  '<html lang="%LANG%"><head>',
  '<link rel="stylesheet" href="/assets/%BUILD_ID%/shared/styles/tokens.css">',
  '<link rel="stylesheet" href="/assets/%BUILD_ID%/styles/portal.css">',
  "%IMPORT_MAP%",
  '<script type="module" src="/assets/%BUILD_ID%/app.js"></script>',
  "</head><body><div id=\"app\"></div></body></html>",
].join("\n");

const VENDOR_FILES = {
  "preact/1.0.0/preact.module.js": "export const h = 1;\n".repeat(60),
  "preact/1.0.0/hooks.module.js": "export const useState = 1;\n",
  "preact/1.0.0/LICENSE": "MIT preact\n",
  "htm/2.0.0/htm.module.js": "export default 1;\n",
  "uplot/3.0.0/uPlot.esm.js": "export default 3;\n",
  "uplot/3.0.0/uPlot.min.css": ".u{}\n",
  "qrcode/4.0.0/qrcode.mjs": "export default 4;\n",
  "lucide/5.0.0/icons.js": "export const icons = {};\n",
  "preact/1.0.0/unlisted.js": "export const secret = 1;\n",
};

function manifestFor(files) {
  const entry = (name, version, dir, entries, list) => ({
    name,
    version,
    dir,
    entries,
    files: list.map((rel) => ({ path: rel.split("/").pop(), sha256: sha256(files[`${dir}/${rel}`]), bytes: Buffer.byteLength(files[`${dir}/${rel}`]) })),
  });
  return {
    schemaVersion: 1,
    packages: [
      entry("htm", "2.0.0", "htm/2.0.0", { htm: "htm.module.js" }, ["htm.module.js"]),
      entry("lucide", "5.0.0", "lucide/5.0.0", { lucide: "icons.js" }, ["icons.js"]),
      entry("preact", "1.0.0", "preact/1.0.0", { preact: "preact.module.js", "preact/hooks": "hooks.module.js" }, ["preact.module.js", "hooks.module.js", "LICENSE"]),
      entry("qrcode-generator", "4.0.0", "qrcode/4.0.0", { "qrcode-generator": "qrcode.mjs" }, ["qrcode.mjs"]),
      entry("uplot", "3.0.0", "uplot/3.0.0", { uplot: "uPlot.esm.js" }, ["uPlot.esm.js", "uPlot.min.css"]),
    ],
    importMap: {
      htm: "htm/2.0.0/htm.module.js",
      lucide: "lucide/5.0.0/icons.js",
      preact: "preact/1.0.0/preact.module.js",
      "preact/hooks": "preact/1.0.0/hooks.module.js",
      "qrcode-generator": "qrcode/4.0.0/qrcode.mjs",
      uplot: "uplot/3.0.0/uPlot.esm.js",
    },
  };
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A tree shaped like the repository: <root>/service-entry/portal and
// <root>/shared-public/{vendor,styles}.
function makeTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portal-routes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const portal = path.join(root, "service-entry", "portal");
  const vendor = path.join(root, "shared-public", "vendor");
  const styles = path.join(root, "shared-public", "styles");
  write(path.join(portal, "index.html"), INDEX);
  write(path.join(portal, "package.json"), '{"type":"module"}');
  write(path.join(portal, "error.html"), "<!doctype html><title>error</title>");
  write(path.join(portal, "app.js"), "export const app = 'v1';\n".repeat(40));
  write(path.join(portal, "pages", "status.js"), "export default 1;\n");
  write(path.join(portal, "styles", "portal.css"), "body{margin:0}\n");
  write(path.join(portal, "i18n", "en-US.json"), '{"a.b":"x"}');
  write(path.join(portal, "notes.txt"), "not servable");
  write(path.join(styles, "tokens.css"), ":root{--bg:#fff}\n");
  write(path.join(styles, "contrast-pairs.json"), "{}");
  for (const [rel, content] of Object.entries(VENDOR_FILES)) write(path.join(vendor, ...rel.split("/")), content);
  write(path.join(vendor, "VENDOR.json"), JSON.stringify(manifestFor(VENDOR_FILES)));
  write(path.join(root, "service-entry", "server.js"), "// secret source");
  return { root, portal, vendor, styles };
}

function makeBuildId() {
  const state = { contentHash: "aaaaaaaaaaaa", commit: "0123456789ab", calls: 0, throwNext: false, onCall: null };
  const getBuildId = () => {
    state.calls += 1;
    if (state.onCall) state.onCall(state);
    if (state.throwNext) throw Object.assign(new Error("scan failed"), { code: "build_id_unavailable" });
    return { commit: state.commit, contentHash: state.contentHash };
  };
  return { state, getBuildId };
}

function silent() {
  const lines = [];
  return { lines, warn: (line) => lines.push(String(line)), log() {}, error() {} };
}

async function boot(t, tree, buildId, options = {}) {
  const logger = silent();
  const routes = createPortalRoutes({
    rootDir: tree.portal,
    vendorDir: tree.vendor,
    stylesDir: tree.styles,
    getBuildId: buildId.getBuildId,
    logger,
    backoffMs: 0,
    ...options,
  });
  const listener = createPublicListener({
    security: { publicHostnames: () => new Set(["127.0.0.1"]) },
    portal: routes,
    logger,
  });
  const server = http.createServer((req, res) => listener.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const port = server.address().port;
  const get = (pathname, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: { host: "127.0.0.1", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  return { get, routes, logger };
}

const text = (answer) => answer.body.toString("utf8");

function importMapOf(html) {
  const match = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "the shell carries an import map");
  return match[1];
}

test("the shell carries the build id, the import map from VENDOR.json and a CSP naming it by hash", async (t) => {
  const tree = makeTree(t);
  const { get } = await boot(t, tree, makeBuildId());
  const answer = await get("/status?lang=en");
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(answer.headers["cache-control"], "no-store");
  const html = text(answer);
  assert.ok(!/%[A-Z_]+%/.test(html), "no placeholder is left");
  assert.match(html, /<html lang="en-US">/);
  assert.match(html, /href="\/assets\/aaaaaaaaaaaa\/shared\/styles\/tokens\.css"/);
  assert.match(html, /src="\/assets\/aaaaaaaaaaaa\/app\.js"/);

  const mapText = importMapOf(html);
  const map = JSON.parse(mapText);
  assert.deepEqual(map.imports, {
    htm: "/assets/aaaaaaaaaaaa/vendor/htm/2.0.0/htm.module.js",
    preact: "/assets/aaaaaaaaaaaa/vendor/preact/1.0.0/preact.module.js",
    "preact/hooks": "/assets/aaaaaaaaaaaa/vendor/preact/1.0.0/hooks.module.js",
    "qrcode-generator": "/assets/aaaaaaaaaaaa/vendor/qrcode/4.0.0/qrcode.mjs",
    uplot: "/assets/aaaaaaaaaaaa/vendor/uplot/3.0.0/uPlot.esm.js",
  }, "the portal's four packages; the console's icon subset is not served here");

  const csp = answer.headers["content-security-policy"];
  const hash = crypto.createHash("sha256").update(mapText, "utf8").digest("base64");
  assert.equal(csp, buildCsp(mapText));
  assert.equal(csp, [
    "default-src 'none'", `script-src 'self' 'sha256-${hash}'`, "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
  ].join("; "));
  assert.ok(!/unsafe-/.test(csp));
  assert.equal(answer.headers["x-content-type-options"], "nosniff");
  assert.equal(answer.headers["referrer-policy"], "no-referrer");
  assert.equal(answer.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(answer.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
});

test("the document language follows ?lang= and then Accept-Language", async (t) => {
  const tree = makeTree(t);
  const { get } = await boot(t, tree, makeBuildId());
  assert.match(text(await get("/")), /<html lang="zh-CN">/);
  assert.match(text(await get("/", { headers: { "accept-language": "en-GB,en;q=0.8" } })), /<html lang="en-US">/);
  assert.match(text(await get("/?lang=zh", { headers: { "accept-language": "en" } })), /<html lang="zh-CN">/);
  assert.match(text(await get("/?lang=%3Cscript%3E")), /<html lang="zh-CN">/, "an unknown value never reaches the page");
  assert.equal(pickLanguage(new URL("http://x/?lang=en-US"), { headers: {} }), "en-US");
  // Every shell route answers the same document.
  for (const route of ["/", "/status", "/models", "/models/qwen3", "/docs", "/docs/quickstart", "/me", "/playground", "/announcements"]) {
    assert.equal((await get(route)).status, 200, route);
  }
  const head = await get("/status", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test("assets come from the snapshot with immutable caching, validators and compression", async (t) => {
  const tree = makeTree(t);
  const { get } = await boot(t, tree, makeBuildId());
  const app = await get("/assets/aaaaaaaaaaaa/app.js");
  assert.equal(app.status, 200);
  assert.equal(app.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(app.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(app.headers.etag, '"aaaaaaaaaaaa"');
  assert.equal(app.headers["x-content-type-options"], "nosniff");
  assert.match(text(app), /app = 'v1'/);

  assert.equal((await get("/assets/aaaaaaaaaaaa/app.js", { headers: { "if-none-match": '"aaaaaaaaaaaa"' } })).status, 304);

  const zipped = await get("/assets/aaaaaaaaaaaa/app.js", { headers: { "accept-encoding": "gzip" } });
  assert.equal(zipped.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(zipped.body).toString("utf8"), text(app));
  const brotli = await get("/assets/aaaaaaaaaaaa/app.js", { headers: { "accept-encoding": "br, gzip" } });
  assert.equal(brotli.headers["content-encoding"], "br");
  assert.equal(zlib.brotliDecompressSync(brotli.body).toString("utf8"), text(app));
  assert.equal((await get("/assets/aaaaaaaaaaaa/app.js", { headers: { "accept-encoding": "gzip;q=0, br;q=0" } })).headers["content-encoding"], undefined);

  assert.equal((await get("/assets/aaaaaaaaaaaa/pages/status.js")).status, 200);
  assert.equal((await get("/assets/aaaaaaaaaaaa/styles/portal.css")).headers["content-type"], "text/css; charset=utf-8");
  assert.equal((await get("/assets/aaaaaaaaaaaa/i18n/en-US.json")).headers["content-type"], "application/json; charset=utf-8");
  assert.equal(text(await get("/assets/aaaaaaaaaaaa/shared/styles/tokens.css")), ":root{--bg:#fff}\n", "tokens come from shared-public/styles");
  const vendor = await get("/assets/aaaaaaaaaaaa/vendor/preact/1.0.0/hooks.module.js");
  assert.equal(vendor.status, 200);
  assert.equal(text(vendor), VENDOR_FILES["preact/1.0.0/hooks.module.js"]);
  assert.equal((await get("/assets/aaaaaaaaaaaa/vendor/uplot/3.0.0/uPlot.min.css")).headers["content-type"], "text/css; charset=utf-8");
  assert.equal((await get("/assets/aaaaaaaaaaaa/vendor/preact/1.0.0/LICENSE")).headers["content-type"], "text/plain; charset=utf-8");
  const head = await get("/assets/aaaaaaaaaaaa/app.js", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test("static serving rejects traversal and anything outside the snapshot", async (t) => {
  const tree = makeTree(t);
  const { get } = await boot(t, tree, makeBuildId());
  const refused = [
    "/assets/aaaaaaaaaaaa/../server.js",
    "/assets/aaaaaaaaaaaa/%2e%2e/%2e%2e/server.js",
    "/assets/aaaaaaaaaaaa/..%2f..%2fserver.js",
    "/assets/aaaaaaaaaaaa/%2e%2e%2f%2e%2e%2fservice-entry%2fserver.js",
    "/assets/aaaaaaaaaaaa/pages/..%5c..%5capp.js",
    "/assets/aaaaaaaaaaaa/..\\app.js",
    "/assets/aaaaaaaaaaaa/app.js%00.css",
    "/assets/aaaaaaaaaaaa/package.json",
    "/assets/aaaaaaaaaaaa/index.html",
    "/assets/aaaaaaaaaaaa/error.html",
    "/assets/aaaaaaaaaaaa/notes.txt",
    "/assets/aaaaaaaaaaaa/pages/",
    "/assets/aaaaaaaaaaaa/pages",
    "/assets/aaaaaaaaaaaa/shared/styles/contrast-pairs.json",
    "/assets/aaaaaaaaaaaa/shared/styles/",
    "/assets/aaaaaaaaaaaa/vendor/VENDOR.json",
    "/assets/aaaaaaaaaaaa/vendor/preact/1.0.0/unlisted.js",
    "/assets/aaaaaaaaaaaa/vendor/lucide/5.0.0/icons.js",
    "/assets/aaaaaaaaaaaa/vendor/preact/1.0.0/",
    "/assets/aaaaaaaaaaaa/APP.JS",
    "/assets/aaaaaaaaaaaa",
    "/assets/aaaaaaaaaaaa/",
    "/assets//app.js",
  ];
  for (const target of refused) {
    const answer = await get(target);
    assert.ok([404, 410].includes(answer.status), `${target} -> ${answer.status}`);
    assert.ok(!/secret source|"type":"module"|not servable|export const app/.test(text(answer)), `${target} leaked a file`);
  }
  assert.equal((await get("/assets/aaaaaaaaaaaa/nothing.js")).status, 404);
  assert.equal((await get("/assets/aaaaaaaaaaaa/app.js", { method: "POST" })).status, 404);
});

test("the previous build id is still served, older ids answer 410 portal_stale", async (t) => {
  const tree = makeTree(t);
  const build = makeBuildId();
  const { get, routes } = await boot(t, tree, build);
  assert.equal((await get("/")).status, 200);
  assert.equal(routes.snapshot().id, "aaaaaaaaaaaa");

  // A deploy copies a changed file; the next HTML request sees the new id.
  write(path.join(tree.portal, "app.js"), "export const app = 'v2';\n");
  build.state.contentHash = "bbbbbbbbbbbb";
  const second = await get("/models");
  assert.match(text(second), /src="\/assets\/bbbbbbbbbbbb\/app\.js"/);
  assert.match(text(await get("/assets/bbbbbbbbbbbb/app.js")), /v2/);
  assert.match(text(await get("/assets/aaaaaaaaaaaa/app.js")), /v1/, "the previous id keeps serving what it held");

  write(path.join(tree.portal, "app.js"), "export const app = 'v3';\n");
  build.state.contentHash = "cccccccccccc";
  await get("/");
  assert.match(text(await get("/assets/cccccccccccc/app.js")), /v3/);
  assert.match(text(await get("/assets/bbbbbbbbbbbb/app.js")), /v2/);
  const stale = await get("/assets/aaaaaaaaaaaa/app.js");
  assert.equal(stale.status, 410);
  assert.equal(stale.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(stale.headers["cache-control"], "no-store");
  const body = JSON.parse(text(stale));
  assert.equal(body.error.code, "portal_stale");
  assert.match(body.request_id, /^req_/);
  assert.equal((await get("/assets/never-seen/app.js")).status, 410);
});

test("an unchanged build id rebuilds nothing; an unreadable one keeps the current snapshot", async (t) => {
  const tree = makeTree(t);
  const build = makeBuildId();
  const { get, routes, logger } = await boot(t, tree, build);
  await get("/");
  const first = routes.snapshot();
  await get("/status");
  await get("/models");
  assert.equal(routes.snapshot(), first, "the same object while the hash holds");
  build.state.throwNext = true;
  assert.equal((await get("/")).status, 200);
  assert.equal((await get("/")).status, 200);
  assert.equal(routes.snapshot(), first);
  assert.equal(logger.lines.filter((line) => /build_id_unavailable/.test(line)).length, 1, "one log line per distinct failure");
});

test("a build id that moves during every read keeps the previous snapshot; a first read answers 503", async (t) => {
  const tree = makeTree(t);
  const build = makeBuildId();
  const { get, routes, logger } = await boot(t, tree, build);
  let n = 0;
  build.state.onCall = (state) => {
    n += 1;
    state.contentHash = `moving${n}`;
  };
  const first = await get("/");
  assert.equal(first.status, 503, "no snapshot has ever been built");
  assert.equal(JSON.parse(text(first)).error.code, "service_unavailable");
  assert.ok(logger.lines.some((line) => /build_id_moving/.test(line)));
  build.state.onCall = null;
  build.state.contentHash = "stable000000";
  assert.equal((await get("/")).status, 200);
  assert.equal(routes.snapshot().id, "stable000000");
  let m = 0;
  build.state.onCall = (state) => {
    m += 1;
    state.contentHash = `again${m}`;
  };
  assert.equal((await get("/")).status, 200, "the previous snapshot answers");
  assert.equal(routes.snapshot().id, "stable000000");
});

test("a vendor file that does not match VENDOR.json fails the snapshot instead of serving it", async (t) => {
  const tree = makeTree(t);
  write(path.join(tree.vendor, "htm", "2.0.0", "htm.module.js"), "export default 'tampered';\n");
  const { get, logger } = await boot(t, tree, makeBuildId());
  assert.equal((await get("/")).status, 503);
  assert.equal((await get("/assets/aaaaaaaaaaaa/app.js")).status, 410, "no snapshot, so no id is served");
  assert.ok(logger.lines.some((line) => /vendor_invalid/.test(line) && /htm\.module\.js/.test(line)));
});

test("a missing app.js or a missing shell fails the snapshot", async (t) => {
  const noApp = makeTree(t);
  fs.rmSync(path.join(noApp.portal, "app.js"));
  const first = await boot(t, noApp, makeBuildId());
  assert.equal((await first.get("/")).status, 503);
  assert.ok(first.logger.lines.some((line) => /shell_missing/.test(line)));
  const noIndex = makeTree(t);
  fs.rmSync(path.join(noIndex.portal, "index.html"));
  const second = await boot(t, noIndex, makeBuildId());
  assert.equal((await second.get("/status")).status, 503);
});

test("error pages carry the portal stylesheets once a snapshot exists", async (t) => {
  const tree = makeTree(t);
  const { get, routes } = await boot(t, tree, makeBuildId());
  assert.deepEqual(routes.errorStylesheets(), [], "none before the first snapshot");
  await get("/");
  assert.deepEqual(routes.errorStylesheets(), ["/assets/aaaaaaaaaaaa/shared/styles/tokens.css", "/assets/aaaaaaaaaaaa/styles/portal.css"]);
  const missing = await get("/no-such-page", { headers: { accept: "text/html" } });
  assert.equal(missing.status, 404);
  assert.match(text(missing), /<link rel="stylesheet" href="\/assets\/aaaaaaaaaaaa\/styles\/portal\.css">/);
  const json = await get("/no-such-page", { headers: { accept: "application/json" } });
  assert.equal(JSON.parse(text(json)).error.code, "not_found");
});

test("dev mode serves uncompressed no-store assets and rebuilds on every request", async (t) => {
  const tree = makeTree(t);
  const { get } = await boot(t, tree, makeBuildId(), { dev: true });
  const app = await get("/assets/aaaaaaaaaaaa/app.js", { headers: { "accept-encoding": "gzip" } });
  assert.equal(app.headers["cache-control"], "no-store");
  assert.equal(app.headers["content-encoding"], undefined);
  write(path.join(tree.portal, "app.js"), "export const app = 'edited';\n");
  assert.match(text(await get("/assets/aaaaaaaaaaaa/app.js")), /edited/);
});

test("the real portal tree builds a snapshot against the real vendor tree", async () => {
  const routes = createPortalRoutes({ getBuildId: () => ({ commit: "0123456789ab", contentHash: "realbuild001" }), logger: silent() });
  const snapshot = await routes.refresh();
  assert.ok(snapshot, "the repository's portal, VENDOR.json and tokens.css form a valid snapshot");
  for (const file of ["app.js", "styles/portal.css", "i18n/zh-CN.json", "i18n/en-US.json", "pages/status.js", "pages/models.js", "pages/model.js", "pages/announcements.js", "shared/styles/tokens.css"]) {
    assert.ok(snapshot.files.has(file), file);
  }
  assert.ok([...snapshot.files.keys()].some((key) => key.startsWith("vendor/preact/")));
  assert.ok(![...snapshot.files.keys()].some((key) => key.startsWith("vendor/lucide/")));
  const map = JSON.parse(importMapOf(snapshot.template.replace(/%LANG%/g, "en-US"))).imports;
  assert.deepEqual(Object.keys(map).sort(), ["htm", "preact", "preact/hooks", "qrcode-generator", "uplot"]);
  for (const target of Object.values(map)) assert.ok(snapshot.files.has(target.replace(/^\/assets\/realbuild001\//, "")), target);
});

test("the entry wires the portal documents over its access store and an offline fleet", async (t) => {
  const { entry } = await loadEntry();
  const data = entry.createPublicPortalData();
  t.after(() => entry.closeAccessStore());
  assert.ok(data, "the access store opens in the temp directory of the harness");
  const status = await data.respond("/status.json", {});
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.status, "offline", "no manager answers, so no model is ready");
  assert.deepEqual(status.models, []);
  assert.deepEqual((await data.respond("/catalog.json", {})).models, []);
  assert.deepEqual((await data.respond("/announcements.json", {})).announcements, []);
  const config = await data.respond("/portal-config.json", { headers: { host: "127.0.0.1:5186" }, socket: {} });
  assert.equal(config.baseUrl, "http://127.0.0.1:5186");
  assert.match(config.buildId, /^[0-9a-f]{12}$/, "the real build id of the checkout");
  assert.equal(await data.respond("/other.json", {}), null);
});

test("a failed build is not retried on every request, only after the backoff", async (t) => {
  const tree = makeTree(t);
  const original = fs.readFileSync(path.join(tree.vendor, "htm", "2.0.0", "htm.module.js"));
  write(path.join(tree.vendor, "htm", "2.0.0", "htm.module.js"), "export default 'broken';\n");
  const clock = { ms: 1_000_000 };
  const build = makeBuildId();
  const { get, routes } = await boot(t, tree, build, { backoffMs: 5000, now: () => clock.ms });
  assert.equal((await get("/")).status, 503);
  const callsAfterFirst = build.state.calls;
  fs.writeFileSync(path.join(tree.vendor, "htm", "2.0.0", "htm.module.js"), original);
  for (let index = 0; index < 5; index += 1) assert.equal((await get("/")).status, 503, "still inside the backoff");
  routes.errorStylesheets();
  assert.equal(build.state.calls, callsAfterFirst, "nothing was re-read while backing off");
  clock.ms += 5001;
  assert.equal((await get("/")).status, 200, "the next attempt after the backoff succeeds");
});
