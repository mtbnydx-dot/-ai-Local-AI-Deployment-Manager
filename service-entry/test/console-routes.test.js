"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const core = require("../../manager-core");
const { createEntrySecurity } = require("../lib/security");
const { createRequestAuth } = require("../lib/request-auth");
const { createViewerRegistry } = require("../lib/viewer-allowlist");
const {
  BILLING_CLASSIC_CSP,
  SHELL_CSP,
  SPA_PREFIXES,
  createConsoleRoutes,
  localeFromAcceptLanguage,
  mergeI18nAreas,
  parsePrefsCookie,
  readDefaultUi,
  registerConsoleRoutes,
} = require("../lib/console-routes");
const { ownerSession } = require("./helpers/entry-harness");

// The console serving layer (07 §2.3–§2.6, §13.1). Each test builds its own
// AI root in a temp folder: a copy of the real console, vendor tree and pages,
// so the snapshot, the build id and the catalogs come from real files. The
// entry tests at the end mount the module through server.js; every upstream
// port the entry knows points at a port nothing listens on.

const ENTRY_DIR = path.join(__dirname, "..");
const AI_ROOT = path.join(ENTRY_DIR, "..");
const EXPECTED_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; worker-src 'none'";
const SWITCH_ENV = [
  "SERVICE_ENTRY_ALLOW_LAN_ADMIN",
  "SERVICE_ENTRY_CONSOLE_DEFAULT",
  "SERVICE_ENTRY_CONSOLE_DEV",
  "SERVICE_ENTRY_REQUIRE_API_KEY",
  "SERVICE_ENTRY_TRUSTED_PROXIES",
  "PLATFORM_CONFIG_FILE",
];

function withEnv(t, values = {}) {
  const saved = Object.fromEntries(SWITCH_ENV.map((name) => [name, process.env[name]]));
  for (const name of SWITCH_ENV) delete process.env[name];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function quietLogger() {
  const lines = [];
  return { lines, log: () => {}, warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
}

function write(root, rel, text) {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// <tmp>/service-entry/{console,index.html,billing.html} and
// <tmp>/shared-public/{vendor,styles}: the layout getBuildId hashes.
function makeTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-routes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entryDir = path.join(root, "service-entry");
  fs.cpSync(path.join(ENTRY_DIR, "console"), path.join(entryDir, "console"), { recursive: true });
  // The tests below add their own stylesheets; the real ones (CON-3) would make the "only files held" checks vacuous.
  fs.rmSync(path.join(entryDir, "console", "styles"), { recursive: true, force: true });
  fs.cpSync(path.join(AI_ROOT, "shared-public", "vendor"), path.join(root, "shared-public", "vendor"), { recursive: true });
  fs.copyFileSync(path.join(ENTRY_DIR, "index.html"), path.join(entryDir, "index.html"));
  fs.copyFileSync(path.join(ENTRY_DIR, "billing.html"), path.join(entryDir, "billing.html"));
  write(root, "shared-public/styles/tokens.css", ":root { --bg: #f5f7fa; }\n");
  return { root, entryDir, consoleDir: path.join(entryDir, "console") };
}

function entrySecurity() {
  return createEntrySecurity({ host: "0.0.0.0", managers: [], getLanAddress: () => "192.168.0.10" });
}

// A build-id source with its own clock, so a test can step past the 2 s
// re-stat window instead of sleeping.
function buildIdClock(tree) {
  const clock = { now: 1_000_000 };
  const source = core.platform.createBuildIdSource({ now: () => clock.now });
  return {
    clock,
    getBuildId: () => source.getBuildId({ aiRoot: tree.root }),
    advance() {
      clock.now += 5000;
    },
  };
}

function makeRoutes(tree, overrides = {}) {
  const logger = overrides.logger || quietLogger();
  const security = overrides.security || entrySecurity();
  const ids = overrides.getBuildId ? null : buildIdClock(tree);
  const state = { defaultUi: overrides.defaultUi || "classic" };
  const routes = createConsoleRoutes({
    rootDir: tree.consoleDir,
    vendorDir: path.join(tree.root, "shared-public", "vendor"),
    stylesDir: path.join(tree.root, "shared-public", "styles"),
    classicHtml: path.join(tree.entryDir, "index.html"),
    billingHtml: path.join(tree.entryDir, "billing.html"),
    aiRoot: tree.root,
    auth: overrides.auth || createRequestAuth({ security, logger }),
    security,
    managers: [{ id: "vllm", port: 5177 }, { id: "llama", port: 5178 }],
    features: overrides.features || { events: true, mgmtProxy: true },
    getBuildId: overrides.getBuildId || ids.getBuildId,
    getDefaultUi: () => state.defaultUi,
    readVersion: overrides.readVersion || (() => ({ version: "0.2.0", deployedAt: null })),
    logger,
    dev: Boolean(overrides.dev),
  });
  return { routes, logger, ids, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// A bare server around handle(); a declined request answers 599 so a test
// can tell "the module said no" from the module's own answers.
async function serve(t, routes) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (await routes.handle(req, res, url)) return;
      res.writeHead(599, { "content-type": "application/json" });
      res.end(JSON.stringify({ declined: true }));
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error?.stack || error));
    }
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return port;
}

function raw(port, pathname, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.end();
  });
}

const html = (port, pathname, headers = {}) => raw(port, pathname, { headers: { accept: "text/html", ...headers } });

function buildIdOf(body) {
  const found = /<meta name="console-build" content="([^"]*)">/.exec(body.toString("utf8"));
  return found ? found[1] : null;
}

function bootstrapOf(body) {
  const found = /<script type="application\/json" id="console-bootstrap">([\s\S]*?)<\/script>/.exec(body.toString("utf8"));
  assert.ok(found, "the shell embeds the bootstrap");
  return JSON.parse(found[1]);
}

function fakeReq(remoteAddress, headers = {}, method = "GET") {
  return { method, url: "/", headers: { host: "127.0.0.1:5176", ...headers }, socket: { remoteAddress } };
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    headersSent: false,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    },
  };
}

function bump(file, extra) {
  fs.appendFileSync(file, extra);
}

// --- shell and snapshot --------------------------------------------------------

test("the shell replaces every placeholder, sends exactly the §2.3 CSP and runs no inline script", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const hostile = "</script><script>alert(1)</script>%TITLE%";
  const { routes, ids } = makeRoutes(tree, { readVersion: () => ({ version: hostile, deployedAt: null }) });
  const port = await serve(t, routes);
  const response = await raw(port, "/?ui=new");
  assert.equal(response.status, 200);
  assert.equal(SHELL_CSP, EXPECTED_CSP);
  assert.equal(response.headers["content-security-policy"], EXPECTED_CSP);
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"], /^text\/html; charset=utf-8$/);

  const text = response.body.toString("utf8");
  // The hostile version string carries a placeholder of its own, which stays data.
  assert.doesNotMatch(text.replace(/<script type="application\/json"[\s\S]*?<\/script>/, ""), /%[A-Z_]+%/, "every placeholder is replaced");
  const id = ids.getBuildId().contentHash;
  assert.equal(buildIdOf(response.body), id);
  assert.match(text, /<html lang="zh-CN"\s+data-density="comfortable">/);
  assert.match(text, /<title>本地 AI 平台<\/title>/);
  assert.match(text, /<p class="boot-splash">正在加载控制台…<\/p><noscript>需要启用 JavaScript<\/noscript>/);
  assert.ok(text.includes(`<script type="module" src="/c/${id}/app.js"></script>`));

  // Only the module script and the JSON data block; no handler or style attribute.
  const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  for (const [, attrs, body] of scripts) {
    if (/type="module"/.test(attrs)) {
      assert.match(attrs, /\bsrc="\/c\/[^"]+\/app\.js"/);
      assert.equal(body, "");
    } else {
      assert.match(attrs, /type="application\/json"/);
    }
  }
  assert.doesNotMatch(text, /\son[a-z]+=|\sstyle=/i);

  // The data block cannot end its own element, and a placeholder inside data stays data.
  const bootstrap = bootstrapOf(response.body);
  assert.equal(bootstrap.platform.version, hostile);
  assert.equal(text.includes("</script><script>alert(1)"), false);
  assert.equal(bootstrap.buildId, id);
  assert.equal(bootstrap.platform.contentHash, id);
});

test("the URL id is getBuildId().contentHash and follows a file edit without a restart", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const { routes, ids } = makeRoutes(tree, { defaultUi: "new" });
  const port = await serve(t, routes);

  const first = buildIdOf((await raw(port, "/")).body);
  assert.equal(first, ids.getBuildId().contentHash);
  assert.equal(first, core.platform.getBuildId({ aiRoot: tree.root }).contentHash, "the same id the shared 06 source computes");
  const oldApp = (await raw(port, `/c/${first}/app.js`)).body;
  assert.ok(oldApp.equals(fs.readFileSync(path.join(tree.consoleDir, "app.js"))));

  bump(path.join(tree.consoleDir, "app.js"), "\n// edited while running\n");
  ids.advance();
  const second = buildIdOf((await raw(port, "/")).body);
  assert.notEqual(second, first);
  assert.equal(second, ids.getBuildId().contentHash);
  assert.match((await raw(port, `/c/${second}/app.js`)).body.toString(), /edited while running/);
  // The previous id still serves its own bytes for tabs that loaded it.
  const previous = await raw(port, `/c/${first}/app.js`);
  assert.equal(previous.status, 200);
  assert.ok(previous.body.equals(oldApp));

  bump(path.join(tree.consoleDir, "app.js"), "// edited again\n");
  ids.advance();
  const third = buildIdOf((await raw(port, "/")).body);
  assert.notEqual(third, second);
  const stale = await raw(port, `/c/${first}/app.js`);
  assert.equal(stale.status, 410);
  assert.deepEqual(JSON.parse(stale.body), {
    ok: false,
    error: { code: "console_stale", message: "This console version is no longer served. Reload the page.", hint: "reload" },
  });
  assert.equal((await raw(port, `/c/${second}/app.js`)).status, 200);
  assert.equal((await raw(port, "/c/000000000000/app.js")).status, 410);
});

test("a hash that moves during the read triggers a rebuild; one that keeps moving keeps the previous snapshot", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const sequence = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  let calls = 0;
  const { routes } = makeRoutes(tree, {
    defaultUi: "new",
    getBuildId: () => ({ commit: null, contentHash: sequence[Math.min(calls++, sequence.length - 1)] }),
  });
  const port = await serve(t, routes);
  assert.equal(buildIdOf((await raw(port, "/")).body), "bbbbbbbbbbbb");
  assert.equal(calls, 4, "read once between a and b, then again between b and b");

  // A deploy that never settles: the snapshot already served stays.
  let moving = false;
  let counter = 0;
  const logger = quietLogger();
  const { routes: settled } = makeRoutes(tree, {
    defaultUi: "new",
    logger,
    getBuildId: () => ({ commit: null, contentHash: moving ? `m${String(counter++).padStart(11, "0")}` : "cccccccccccc" }),
  });
  const settledPort = await serve(t, settled);
  assert.equal(buildIdOf((await raw(settledPort, "/")).body), "cccccccccccc");
  moving = true;
  assert.equal(buildIdOf((await raw(settledPort, "/")).body), "cccccccccccc");
  assert.equal(buildIdOf((await raw(settledPort, "/")).body), "cccccccccccc");
  assert.equal((await raw(settledPort, "/c/cccccccccccc/app.js")).status, 200);
  const moved = logger.lines.filter((line) => line.includes("build_id_moving"));
  assert.ok(moved.length >= 1);
  assert.ok(moved.every((line) => line.includes("still serving cccccccccccc")));

  // With nothing built yet, / is the classic console's.
  const neverLogger = quietLogger();
  const { routes: never } = makeRoutes(tree, {
    defaultUi: "new",
    logger: neverLogger,
    getBuildId: () => ({ commit: null, contentHash: `n${String(counter++).padStart(11, "0")}` }),
  });
  const neverPort = await serve(t, never);
  assert.equal((await raw(neverPort, "/")).status, 599);
  assert.ok(neverLogger.lines.some((line) => line.includes("build_id_moving") && line.includes("/ serves the classic console")));
});

test("build_id_unavailable keeps the previous snapshot, and with none yet / serves classic after one log line", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  let failing = false;
  const unavailable = () => {
    const error = new Error("The build id is unavailable: service-entry/console/app.js could not be read (EBUSY).");
    error.code = "build_id_unavailable";
    return error;
  };
  const logger = quietLogger();
  const { routes } = makeRoutes(tree, {
    defaultUi: "new",
    logger,
    getBuildId: () => {
      if (failing) throw unavailable();
      return { commit: "abcdef123456", contentHash: "dddddddddddd" };
    },
  });
  const port = await serve(t, routes);
  assert.equal(buildIdOf((await raw(port, "/")).body), "dddddddddddd");
  failing = true;
  for (let index = 0; index < 3; index += 1) {
    const response = await raw(port, "/");
    assert.equal(response.status, 200);
    assert.equal(buildIdOf(response.body), "dddddddddddd");
  }
  assert.equal(logger.lines.filter((line) => line.includes("build_id_unavailable")).length, 1, "one line, not one per request");
  assert.equal(bootstrapOf((await raw(port, "/")).body).platform.commit, "abcdef123456");

  const coldLogger = quietLogger();
  const { routes: cold } = makeRoutes(tree, { defaultUi: "new", logger: coldLogger, getBuildId: () => { throw unavailable(); } });
  const coldPort = await serve(t, cold);
  assert.equal((await raw(coldPort, "/")).status, 599, "declined, so the inline handler serves the classic console");
  assert.equal((await raw(coldPort, "/")).status, 599);
  assert.equal(coldLogger.lines.filter((line) => line.includes("build_id_unavailable")).length, 1);
  const redirect = await html(coldPort, "/overview");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, "/classic");
  const rescue = await raw(coldPort, "/classic");
  assert.equal(rescue.status, 200, "with no snapshot the old page is the rescue, so the redirect cannot loop");
  assert.ok(rescue.body.equals(fs.readFileSync(path.join(tree.entryDir, "index.html"))));
  assert.equal(cold.bootstrap(fakeReq("127.0.0.1")).buildId, null);
});

test("a missing vendor file or an invalid VENDOR.json fails the snapshot and / falls back to classic", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  fs.rmSync(path.join(tree.root, "shared-public", "vendor", "htm", "3.1.1", "htm.module.js"));
  const logger = quietLogger();
  const { routes, ids } = makeRoutes(tree, { defaultUi: "new", logger });
  const port = await serve(t, routes);
  assert.equal((await raw(port, "/")).status, 599);
  assert.equal(routes.snapshot(), null);
  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0], /vendor_invalid.*htm\/3\.1\.1\/htm\.module\.js/);

  fs.copyFileSync(path.join(AI_ROOT, "shared-public", "vendor", "htm", "3.1.1", "htm.module.js"), path.join(tree.root, "shared-public", "vendor", "htm", "3.1.1", "htm.module.js"));
  ids.advance();
  assert.equal((await raw(port, "/")).status, 200, "the next HTML request retries");

  write(tree.root, "shared-public/vendor/VENDOR.json", "{ not json");
  ids.advance();
  const kept = await raw(port, "/");
  assert.equal(kept.status, 200, "a broken deploy keeps the snapshot already served");
  assert.ok(logger.lines.some((line) => /vendor_invalid.*VENDOR\.json is not valid JSON/.test(line)));

  // A tampered vendored file fails its sha256.
  const tree2 = makeTree(t);
  bump(path.join(tree2.root, "shared-public", "vendor", "preact", "10.29.8", "preact.module.js"), "\n");
  const tampered = makeRoutes(tree2, { defaultUi: "new" });
  assert.equal(await tampered.routes.refresh(), null);
  assert.match(tampered.logger.lines.join("\n"), /preact\.module\.js does not have the size VENDOR\.json lists/);
});

test("assets negotiate br and gzip, cache immutably, answer If-None-Match and never leave the snapshot", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const { routes } = makeRoutes(tree);
  const port = await serve(t, routes);
  const id = buildIdOf((await raw(port, "/?ui=new")).body);
  const appBytes = fs.readFileSync(path.join(tree.consoleDir, "app.js"));
  const url = `/c/${id}/app.js`;

  const br = await raw(port, url, { headers: { "accept-encoding": "gzip, deflate, br" } });
  assert.equal(br.status, 200);
  assert.equal(br.headers["content-encoding"], "br");
  assert.ok(zlib.brotliDecompressSync(br.body).equals(appBytes));
  assert.equal(br.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(br.headers.etag, `"${id}"`);
  assert.equal(br.headers.vary, "accept-encoding");
  assert.equal(br.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(br.headers["x-content-type-options"], "nosniff");

  const gzip = await raw(port, url, { headers: { "accept-encoding": "br;q=0, gzip" } });
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.ok(zlib.gunzipSync(gzip.body).equals(appBytes));
  const plain = await raw(port, url, { headers: { "accept-encoding": "identity" } });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.ok(plain.body.equals(appBytes));
  const none = await raw(port, url);
  assert.ok(none.body.equals(appBytes));

  const cached = await raw(port, url, { headers: { "if-none-match": `"${id}"` } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  const head = await raw(port, url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers["content-length"]), appBytes.length);

  // Vendor and shared styles under their snapshot names; LICENSE files too.
  const preact = await raw(port, `/c/${id}/vendor/preact/10.29.8/preact.module.js`);
  assert.equal(preact.status, 200);
  assert.ok(preact.body.equals(fs.readFileSync(path.join(tree.root, "shared-public", "vendor", "preact", "10.29.8", "preact.module.js"))));
  assert.equal((await raw(port, `/c/${id}/vendor/preact/10.29.8/LICENSE`)).headers["content-type"], "text/plain; charset=utf-8");
  const tokens = await raw(port, `/c/${id}/shared/styles/tokens.css`);
  assert.equal(tokens.headers["content-type"], "text/css; charset=utf-8");

  // Map-key lookups only: raw catalogs, the marker, the template and traversal are 404.
  for (const pathname of [
    `/c/${id}/i18n/shell/zh-CN.json`,
    `/c/${id}/package.json`,
    `/c/${id}/index.html`,
    `/c/${id}/nope.js`,
    `/c/${id}/%2e%2e/index.html`,
    `/c/${id}/..%2f..%2fserver.js`,
    `/c/${id}/%E0%A4%A`,
    `/c/${id}`,
  ]) {
    const response = await raw(port, pathname);
    assert.equal(response.status, 404, pathname);
    assert.equal(JSON.parse(response.body).error.code, "not_found", pathname);
  }
});

test("the shell links only files the snapshot holds", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const { routes, ids } = makeRoutes(tree, { defaultUi: "new" });
  const port = await serve(t, routes);
  let text = (await raw(port, "/")).body.toString();
  let id = buildIdOf(Buffer.from(text));
  assert.ok(text.includes(`<link rel="stylesheet" href="/c/${id}/shared/styles/tokens.css">`));
  assert.ok(text.includes(`<link rel="modulepreload" href="/c/${id}/app.js">`));
  assert.equal(text.includes("styles/base.css"), false);
  assert.equal(text.includes("assets/favicon.svg"), false);

  write(tree.consoleDir, "styles/base.css", "body { margin: 0; }\n");
  write(tree.consoleDir, "assets/favicon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
  ids.advance();
  text = (await raw(port, "/")).body.toString();
  id = buildIdOf(Buffer.from(text));
  assert.ok(text.includes(`<link rel="stylesheet" href="/c/${id}/styles/base.css">`));
  assert.ok(text.includes(`<link rel="icon" type="image/svg+xml" href="/c/${id}/assets/favicon.svg">`));
  assert.equal(text.includes("styles/components.css"), false);
  const icon = await raw(port, `/c/${id}/assets/favicon.svg`);
  assert.equal(icon.headers["content-type"], "image/svg+xml");
});

test("SERVICE_ENTRY_CONSOLE_DEV rescans on every request and sends no-store", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const { routes } = makeRoutes(tree, { dev: true, getBuildId: () => ({ commit: null, contentHash: "eeeeeeeeeeee" }) });
  const port = await serve(t, routes);
  assert.equal((await raw(port, "/?ui=new")).status, 200);
  const first = await raw(port, "/c/eeeeeeeeeeee/app.js", { headers: { "accept-encoding": "br" } });
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(first.headers["content-encoding"], undefined);
  bump(path.join(tree.consoleDir, "app.js"), "// dev edit\n");
  const second = await raw(port, "/c/eeeeeeeeeeee/app.js");
  assert.match(second.body.toString(), /dev edit/, "same id, fresh bytes");
});

// --- i18n merge -----------------------------------------------------------------

function area(dir, name, locale, keys, prefixes = [`${name}.`]) {
  write(dir, `${name}/${locale}.json`, `${JSON.stringify({ $locale: locale, $prefixes: prefixes, ...keys }, null, 2)}\n`);
}

test("mergeI18nAreas merges per locale and reports a duplicate, an invalid file and the other rule breaks", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-i18n-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const locale of ["zh-CN", "en-US"]) {
    area(dir, "access", locale, { "access.title": `${locale} access`, "pair.title": { one: "a", other: "b" } }, ["access.", "pair."]);
    area(dir, "shell", locale, { "shell.product": `${locale} product` }, ["shell.", "common."]);
    // Sorts after shell and redefines its key: left out, shell keeps it.
    area(dir, "zz-dup", locale, { "shell.product": "duplicate", "zz-dup.only": "x" }, ["shell.", "zz-dup."]);
  }
  area(dir, "broken", "en-US", { "broken.ok": "fine" });
  write(dir, "broken/zh-CN.json", "{ \"$locale\": \"zh-CN\", ");
  area(dir, "outside", "zh-CN", { "elsewhere.key": "x" });
  area(dir, "outside", "en-US", { "outside.key": "x" });
  area(dir, "wronglocale", "zh-CN", { "wronglocale.key": "x" });
  write(dir, "wronglocale/en-US.json", JSON.stringify({ $locale: "zh-CN", $prefixes: ["wronglocale."], "wronglocale.key": "x" }));
  area(dir, "plural", "zh-CN", { "plural.count": { one: "x" } });
  area(dir, "plural", "en-US", { "plural.count": { one: "x", other: "y" } });
  area(dir, "noprefix", "zh-CN", {}, []);
  area(dir, "half", "en-US", { "half.key": "x" });
  write(dir, "shell/dynamic-keys.json", JSON.stringify({ prefixes: ["status."], unused: ["shell.product"] }));
  write(dir, "access/dynamic-keys.json", "[1]");
  write(dir, "Not-An-Area/zh-CN.json", "ignored");

  const merged = mergeI18nAreas(dir);
  assert.equal(merged.catalogs["zh-CN"]["shell.product"], "zh-CN product");
  assert.equal(merged.catalogs["en-US"]["shell.product"], "en-US product");
  assert.equal(merged.catalogs["en-US"]["zz-dup.only"], undefined, "the whole duplicate file is left out");
  assert.equal(merged.catalogs["en-US"]["broken.ok"], "fine", "only the invalid locale file of an area is left out");
  assert.equal(merged.catalogs["zh-CN"]["broken.ok"], undefined);
  assert.deepEqual(merged.catalogs["zh-CN"]["pair.title"], { one: "a", other: "b" });
  assert.deepEqual(Object.keys(merged.catalogs["en-US"]), [...Object.keys(merged.catalogs["en-US"])].sort(), "keys are sorted");
  assert.deepEqual(merged.dynamicKeys, { shell: { prefixes: ["status."], unused: ["shell.product"] } });

  const codes = merged.problems.map((problem) => `${problem.file}:${problem.code}${problem.key ? `:${problem.key}` : ""}`).sort();
  assert.deepEqual(codes, [
    "access/dynamic-keys.json:invalid_dynamic_keys",
    "broken/zh-CN.json:invalid_json",
    "half/zh-CN.json:missing_file",
    "noprefix/en-US.json:missing_file",
    "noprefix/zh-CN.json:invalid_prefixes",
    "outside/zh-CN.json:key_outside_prefixes:elsewhere.key",
    "plural/zh-CN.json:invalid_value:plural.count",
    "wronglocale/en-US.json:invalid_locale",
    "zz-dup/en-US.json:duplicate_key:shell.product",
    "zz-dup/zh-CN.json:duplicate_key:shell.product",
  ]);
  for (const problem of merged.problems) assert.ok(problem.message.includes(problem.file), problem.message);
});

test("the real console catalogs merge without problems and with the same keys in both locales", () => {
  const merged = mergeI18nAreas(path.join(ENTRY_DIR, "console", "i18n"));
  assert.deepEqual(merged.problems, []);
  assert.deepEqual(Object.keys(merged.catalogs["zh-CN"]), Object.keys(merged.catalogs["en-US"]));
  for (const key of ["shell.product", "shell.boot.loading", "shell.boot.noscript", "shell.boot.preview", "shell.boot.reload", "shell.boot.failed"]) {
    assert.ok(merged.catalogs["zh-CN"][key], key);
    assert.doesNotMatch(merged.catalogs["en-US"][key], /\p{Script=Han}/u, key);
  }
});

test("the snapshot serves the merged catalog per locale and logs a left-out area file once", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const i18nDir = path.join(tree.consoleDir, "i18n");
  for (const locale of ["zh-CN", "en-US"]) area(i18nDir, "zz-dup", locale, { "shell.product": "duplicate" }, ["shell."]);
  write(i18nDir, "broken/zh-CN.json", "{");
  area(i18nDir, "broken", "en-US", { "broken.ok": "fine" });
  const { routes, logger, ids } = makeRoutes(tree, { defaultUi: "new" });
  const port = await serve(t, routes);
  const shell = await raw(port, "/");
  const id = buildIdOf(shell.body);
  const zh = JSON.parse((await raw(port, `/c/${id}/i18n/zh-CN.json`)).body);
  const en = JSON.parse((await raw(port, `/c/${id}/i18n/en-US.json`)).body);
  assert.equal(zh.$locale, "zh-CN");
  assert.equal(zh["shell.product"], "本地 AI 平台");
  assert.equal(en["shell.product"], "Local AI Platform");
  assert.equal(zh["broken.ok"], undefined);
  assert.equal(en["broken.ok"], "fine");
  assert.match(shell.body.toString(), /<title>本地 AI 平台<\/title>/, "the shell title comes from the shell area, not the duplicate");
  const lines = () => logger.lines.filter((line) => line.includes("i18n area"));
  assert.equal(lines().length, 3);
  assert.equal(lines().filter((line) => line.includes("zz-dup") && line.includes("which area shell already defines")).length, 2);
  assert.equal(lines().filter((line) => line.includes("broken/zh-CN.json")).length, 1);

  // A rebuild with the same problems logs nothing new.
  bump(path.join(tree.consoleDir, "app.js"), "// rebuild\n");
  ids.advance();
  assert.notEqual(buildIdOf((await raw(port, "/")).body), id);
  assert.equal(lines().length, 3);
  assert.deepEqual(routes.snapshot().problems.map((problem) => problem.code).sort(), ["duplicate_key", "duplicate_key", "invalid_json"]);
});

// --- routing --------------------------------------------------------------------

test("the SPA fallback answers only the prefix list and only for an HTML Accept", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const { routes, state } = makeRoutes(tree);
  const port = await serve(t, routes);
  assert.equal(SPA_PREFIXES.length, 13);
  for (const name of SPA_PREFIXES) {
    if (name === "billing") continue;
    for (const pathname of [`/${name}`, `/${name}/`, `/${name}/deep/link?x=1`]) {
      const response = await html(port, pathname);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers["content-security-policy"], EXPECTED_CSP, pathname);
    }
  }
  for (const pathname of ["/overview", "/deployments/vllm:primary"]) {
    assert.equal((await raw(port, pathname)).status, 599, `${pathname} without Accept`);
    assert.equal((await raw(port, pathname, { headers: { accept: "application/json" } })).status, 599, `${pathname} as JSON`);
  }
  for (const pathname of ["/overviewx", "/nope", "/api/status", "/docs/x.md", "/index.html", "/shared-js/tokens.css"]) {
    assert.equal((await html(port, pathname)).status, 599, pathname);
  }
  assert.equal((await raw(port, "/overview", { method: "POST", headers: { accept: "text/html" } })).status, 599);

  // /billing stays the legacy page until the new console is the default.
  assert.equal((await html(port, "/billing")).status, 599);
  assert.equal((await html(port, "/billing/")).status, 599);
  assert.equal((await html(port, "/billing/usage")).status, 200);
  state.defaultUi = "new";
  assert.equal((await html(port, "/billing?manager=vllm")).headers["content-security-policy"], EXPECTED_CSP);
});

test("/ follows the default UI and ?ui= overrides it for one request", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const { routes, state } = makeRoutes(tree);
  const port = await serve(t, routes);
  assert.equal((await raw(port, "/")).status, 599, "classic by default: the inline handler answers");
  assert.equal((await raw(port, "/?ui=classic")).status, 599);
  assert.equal((await raw(port, "/?ui=new")).status, 200);
  assert.equal((await raw(port, "/?ui=bogus")).status, 599);
  state.defaultUi = "new";
  assert.equal((await raw(port, "/")).status, 200);
  assert.equal((await raw(port, "/?ui=classic")).status, 599);
  assert.equal((await raw(port, "/index.html")).status, 599, "/index.html stays the classic page");
});

test("/classic redirects to /overview, and /billing/classic is local-only and framable by the same origin", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const { routes } = makeRoutes(tree);
  const port = await serve(t, routes);
  const classic = await raw(port, "/classic");
  assert.equal(classic.status, 302);
  assert.equal(classic.headers.location, "/overview");
  assert.equal(classic.headers["cache-control"], "no-store");

  for (const pathname of ["/billing/classic", "/billing/classic/?manager=vllm&embed=1&theme=dark"]) {
    const billing = await raw(port, pathname);
    assert.equal(billing.status, 200, pathname);
    assert.ok(billing.body.equals(fs.readFileSync(path.join(tree.entryDir, "billing.html"))));
    assert.equal(billing.headers["content-security-policy"], BILLING_CLASSIC_CSP);
    assert.match(billing.headers["content-security-policy"], /frame-ancestors 'self'$/);
    assert.equal(billing.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(billing.headers["cache-control"], "no-store");
  }
  // Today's billing policy with only frame-ancestors changed.
  assert.equal(BILLING_CLASSIC_CSP, "default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");

  // Loopback only: a LAN socket, a LAN Host header or a forwarding header is refused.
  for (const req of [
    fakeReq("192.168.0.60", { host: "192.168.0.10:5176" }),
    fakeReq("127.0.0.1", { host: "192.168.0.10:5176" }),
    fakeReq("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }),
  ]) {
    const res = fakeRes();
    assert.equal(await routes.handle(req, res, new URL("http://127.0.0.1/billing/classic")), true);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, "billing_admin_local_only");
  }
});

// --- role and config ------------------------------------------------------------

test("before 05 the role is the legacy rule: loopback owner, LAN viewer, LAN with ALLOW_LAN_ADMIN owner", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const { routes } = makeRoutes(tree);
  await routes.refresh();
  const local = routes.bootstrap(fakeReq("127.0.0.1"));
  assert.equal(local.role, "owner");
  assert.deepEqual(local.access, { local: true, lanViewer: false, allowLanAdmin: false });
  assert.deepEqual(local.auth, { mode: "loopback-trust", session: null, csrf: null });

  const lanReq = fakeReq("192.168.0.60", { host: "192.168.0.10:5176" });
  const lan = routes.bootstrap(lanReq);
  assert.equal(lan.role, "viewer");
  assert.deepEqual(lan.access, { local: false, lanViewer: true, allowLanAdmin: false });

  process.env.SERVICE_ENTRY_ALLOW_LAN_ADMIN = "1";
  const admin = routes.bootstrap(fakeReq("192.168.0.60", { host: "192.168.0.10:5176" }));
  assert.equal(admin.role, "owner");
  assert.deepEqual(admin.access, { local: false, lanViewer: false, allowLanAdmin: true });
});

test("the bootstrap has the §2.5 shape, features from the mount table and the build from getBuildId", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const features = { events: true, mgmtProxy: true };
  const { routes, ids } = makeRoutes(tree, {
    features: () => features,
    readVersion: () => ({ version: "0.2.0", commit: "f".repeat(40), shortCommit: "ffffffffffff", deployedAt: "2026-10-14T08:00:00.000Z" }),
  });
  const port = await serve(t, routes);
  const body = JSON.parse((await raw(port, "/api/console/bootstrap")).body);
  const id = ids.getBuildId().contentHash;
  assert.deepEqual(Object.keys(body), ["ok", "buildId", "role", "access", "auth", "defaults", "platform", "managers", "gateway", "features"]);
  assert.equal(body.buildId, id, "the bootstrap builds the snapshot when none exists");
  assert.deepEqual(body.defaults, { locale: "zh-CN", theme: "auto", density: "comfortable" });
  assert.deepEqual(body.platform, { version: "0.2.0", commit: "ffffffffffff", contentHash: id, deployedAt: "2026-10-14T08:00:00.000Z" });
  assert.deepEqual(body.managers, [
    { id: "vllm", label: { zh: "vLLM / SGLang 管理器", en: "vLLM / SGLang manager" }, legacyUiPort: 5177 },
    { id: "llama", label: { zh: "llama.cpp 管理器", en: "llama.cpp manager" }, legacyUiPort: 5178 },
  ]);
  assert.deepEqual(body.gateway, { autoOpenAi: "/gateway/auto/openai/v1", autoClaude: "/gateway/auto/claude", consoleSession: false });
  assert.deepEqual(body.features, {
    events: true, mgmtProxy: true, engines: false, models: false, hub: false, telemetry: false,
    alerts: false, audit: false, session: false, access: false, public: false, platform: false, setup: false,
  });
  // A module that mounts later turns its feature on without a rebuild.
  features.hub = true;
  assert.equal(JSON.parse((await raw(port, "/api/console/bootstrap")).body).features.hub, true);
  assert.equal((await raw(port, "/api/console/bootstrap", { method: "POST" })).status, 599, "GET only");
});

// What 05's PUB-5 seam looks like from here: principal() plus session(),
// the GET /api/session body (05 §5.6) including the CSRF token.
function sessionAuth(sessions) {
  const registry = createViewerRegistry({ logger: quietLogger() });
  return {
    mode: "session",
    viewerRegistry: registry,
    principal(req) {
      const found = sessions.get(String(req.headers.cookie || ""));
      return found ? { role: found.role, principal: "session", via: "session", redact: found.role !== "owner" } : { role: "viewer", principal: "loopback", via: "loopback", redact: true };
    },
    session(req) {
      const found = sessions.get(String(req.headers.cookie || ""));
      if (!found) return { ok: true, role: "viewer", via: "loopback", paired: false, autoPairAvailable: true, pairCommand: "platform admin pair" };
      return { ok: true, role: found.role, via: "session", paired: true, autoPairAvailable: false, csrfToken: found.csrf, pairCommand: "platform admin pair", token: "should-never-appear" };
    },
  };
}

test("with a stub request-auth the role and auth.session come from it, and no cookie value reaches the bootstrap", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const cookieSecret = "lai_session=fake-session-cookie-value-0001";
  const auth = sessionAuth(new Map([[cookieSecret, { role: "owner", csrf: "fake-csrf-0001" }]]));
  const { routes } = makeRoutes(tree, { auth, defaultUi: "new" });
  const port = await serve(t, routes);

  const paired = await raw(port, "/", { headers: { cookie: cookieSecret } });
  const text = paired.body.toString();
  const body = bootstrapOf(paired.body);
  assert.equal(body.role, "owner");
  assert.deepEqual(body.auth, { mode: "session", session: { role: "owner", via: "session", paired: true, autoPairAvailable: false }, csrf: "fake-csrf-0001" });
  assert.equal(text.includes("fake-session-cookie-value-0001"), false);
  assert.equal(text.includes("should-never-appear"), false);
  const api = await raw(port, "/api/console/bootstrap", { headers: { cookie: cookieSecret } });
  assert.equal(api.body.toString().includes("fake-session-cookie-value-0001"), false);
  assert.equal(api.headers["cache-control"], "no-store");

  // Loopback without a session is a viewer once sessions exist (00 §9.8).
  const anonymous = JSON.parse((await raw(port, "/api/console/bootstrap")).body);
  assert.equal(anonymous.role, "viewer");
  assert.deepEqual(anonymous.auth, { mode: "session", session: { role: "viewer", via: "loopback", paired: false, autoPairAvailable: true }, csrf: null });

  const none = makeRoutes(tree, { auth: { ...auth, principal: () => ({ role: "none" }), session: () => { throw new Error("store offline"); } } });
  await none.routes.refresh();
  const unpaired = none.routes.bootstrap(fakeReq("127.0.0.1"));
  assert.equal(unpaired.role, "none");
  assert.deepEqual(unpaired.auth, { mode: "session", session: null, csrf: null });
  assert.ok(none.logger.lines.some((line) => line.includes("store offline")));
});

test("console_prefs sets lang, theme and density; a tampered cookie is ignored", async (t) => {
  withEnv(t);
  const tree = makeTree(t);
  const { routes } = makeRoutes(tree, { defaultUi: "new" });
  const port = await serve(t, routes);

  const english = (await raw(port, "/", { headers: { cookie: "other=1; console_prefs=theme:dark|locale:en-US|density:compact" } })).body.toString();
  assert.match(english, /<html lang="en-US" data-theme="dark" data-density="compact">/);
  assert.match(english, /<title>Local AI Platform<\/title>/);
  assert.match(english, /<p class="boot-splash">Loading console…<\/p><noscript>JavaScript is required<\/noscript>/);
  const encoded = (await raw(port, "/", { headers: { cookie: "console_prefs=theme%3Alight%7Clocale%3Azh-CN" } })).body.toString();
  assert.match(encoded, /<html lang="zh-CN" data-theme="light" data-density="comfortable">/);

  for (const cookie of [
    "console_prefs=theme:\"><script>alert(1)</script>|locale:xx|density:huge",
    "console_prefs=theme:dark%ZZ",
    `console_prefs=${"theme:dark|".repeat(60)}`,
    "console_prefs=",
  ]) {
    const text = (await raw(port, "/", { headers: { cookie } })).body.toString();
    assert.match(text, /<html lang="zh-CN"\s+data-density="comfortable">/, cookie);
    assert.equal(text.includes("alert(1)"), false);
  }
  assert.deepEqual(parsePrefsCookie("console_prefs=theme:auto|locale:auto|density:compact|sidebar:collapsed"), { theme: "auto", locale: "auto", density: "compact" });

  // Without a locale preference the browser language decides: zh* or else en-US.
  const viaHeader = (await raw(port, "/", { headers: { "accept-language": "en-GB,en;q=0.9,zh-CN;q=0.8" } })).body.toString();
  assert.match(viaHeader, /<html lang="en-US"/);
  assert.equal(localeFromAcceptLanguage(""), "zh-CN");
  assert.equal(localeFromAcceptLanguage("zh-TW"), "zh-CN");
  assert.equal(localeFromAcceptLanguage("fr-FR, zh;q=0.5"), "en-US");
  assert.equal(localeFromAcceptLanguage("de;q=0.2, zh-CN;q=0.9"), "zh-CN");
  assert.equal(localeFromAcceptLanguage("*"), "zh-CN");
});

test("SERVICE_ENTRY_CONSOLE_DEFAULT beats console.defaultUi", (t) => {
  withEnv(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-default-ui-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readDefaultUi({ aiRoot: root, env: {} }), "new", "new since CON-26");
  assert.equal(readDefaultUi({ aiRoot: root, env: { SERVICE_ENTRY_CONSOLE_DEFAULT: "classic" } }), "classic", "the env reverts it");
  assert.equal(readDefaultUi({ aiRoot: root, env: { SERVICE_ENTRY_CONSOLE_DEFAULT: "new" } }), "new");
  write(root, "config/platform.json", JSON.stringify({ schemaVersion: 1, console: { defaultUi: "new" } }));
  assert.equal(readDefaultUi({ aiRoot: root, env: {} }), "new");
  assert.equal(readDefaultUi({ aiRoot: root, env: { SERVICE_ENTRY_CONSOLE_DEFAULT: "classic" } }), "classic");
  write(root, "config/platform.json", JSON.stringify({ schemaVersion: 1, console: { defaultUi: "classic" } }));
  assert.equal(readDefaultUi({ aiRoot: root, env: { SERVICE_ENTRY_CONSOLE_DEFAULT: "new" } }), "new");
  write(root, "config/platform.json", JSON.stringify({ schemaVersion: 1, console: { defaultUi: "classic" } }));
  assert.equal(readDefaultUi({ aiRoot: root, env: {} }), "classic", "console.defaultUi=classic reverts it");
  write(root, "config/platform.json", "{ broken");
  assert.equal(readDefaultUi({ aiRoot: root, env: {} }), "new");
});

test("the console's viewer paths are registered, and the legacy billing page stays owner-only", () => {
  const registry = createViewerRegistry({ logger: quietLogger() });
  // 05's baseline for / and /billing is registered first in the entry.
  registry.registerRoute({ owner: "05", path: "/" });
  registry.registerAdminOnly({ owner: "05", method: "GET", path: "/billing" });
  registry.registerAdminOnly({ owner: "05", method: "GET", path: "/billing/" });
  const warnings = [];
  registerConsoleRoutes(registry, (line) => warnings.push(line));
  assert.deepEqual(warnings, []);
  for (const pathname of ["/classic", "/c/abcdef123456/app.js", "/c/abcdef123456/vendor/preact/10.29.8/preact.module.js", "/api/console/bootstrap",
    "/overview", "/deployments/vllm:primary", "/models/discover", "/system/preferences", "/setup", "/billing/usage"]) {
    assert.equal(registry.match("GET", pathname)?.access, "viewer", pathname);
    assert.equal(registry.match("HEAD", pathname)?.access, "viewer", `HEAD ${pathname}`);
  }
  for (const pathname of ["/billing/classic", "/billing/classic/", "/billing"]) {
    assert.equal(registry.match("GET", pathname)?.access, "admin", pathname);
  }
  assert.equal(registry.match("POST", "/overview"), null);
  assert.equal(registry.inventory().filter((item) => item.owner === "07").length, 5 + SPA_PREFIXES.length * 2 - 1);

  // Registering twice (a second context on the same registry) is logged, not thrown.
  registerConsoleRoutes(registry, (line) => warnings.push(line));
  assert.ok(warnings.length > 0);
});

// --- through server.js ------------------------------------------------------------

let entry = null;
let entryTempDir = "";

test.after(() => {
  // Owner sessions opened the access store; Windows will not delete an open file.
  entry?.closeAccessStore();
  if (entryTempDir) fs.rmSync(entryTempDir, { recursive: true, force: true });
});

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function loadEntry() {
  if (entry) return entry;
  entryTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-routes-entry-"));
  const tempDir = entryTempDir;
  for (const name of ["SERVICE_ENTRY_HOST", "SERVICE_ENTRY_REQUIRE_API_KEY", "SERVICE_ENTRY_ALLOW_LAN_ADMIN", "SERVICE_ENTRY_ALLOWED_ORIGINS", "SERVICE_ENTRY_ALLOWED_HOSTS", "SERVICE_ENTRY_PUBLIC_BASE_URL", "SERVICE_ENTRY_TRUSTED_PROXIES"]) {
    delete process.env[name];
  }
  for (const name of ["VLLM_MANAGER_PORT", "LLAMA_MANAGER_PORT", "TTS_GATEWAY_PORT", "SEARCH_GATEWAY_PORT", "PLATFORM_MCP_PORT"]) {
    process.env[name] = String(await unusedPort());
  }
  process.env.SERVICE_ENTRY_STATUS_CACHE_MS = "600000";
  process.env.SERVICE_ENTRY_MODEL_CACHE_MS = "600000";
  process.env.PLATFORM_MCP_ENV_FILE = path.join(tempDir, "platform-mcp.env");
  process.env.AI_BILLING_DB = path.join(tempDir, "billing.sqlite");
  process.env.SERVICE_ENTRY_DATA_DIR = path.join(tempDir, "data");
  entry = require("../server");
  entry.setEntryGatewayAccessSink(async () => {});
  return entry;
}

async function startEntry(t, routes = null) {
  const server = entry.createServiceEntryServer(routes ? { routes } : {});
  const port = await listen(server);
  t.after(() => new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return port;
}

async function mountConsole(t, tree, logger = quietLogger()) {
  const ctx = entry.createRouteContext({ logger, rootDir: tree.entryDir, aiRoot: tree.root });
  const routes = await entry.mountRouteModules({ ctx, modules: ["./lib/events", "./lib/console-routes"] });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  return { ctx, routes };
}

function comparableHeaders(response) {
  const copy = { ...response.headers };
  delete copy.date;
  delete copy["keep-alive"];
  delete copy.connection;
  return copy;
}

test("with the classic default the module declines / and /billing, and the inline handlers answer byte-identically", async (t) => {
  withEnv(t);
  process.env.SERVICE_ENTRY_CONSOLE_DEFAULT = "classic";
  await loadEntry();
  const tree = makeTree(t);
  const plainPort = await startEntry(t);
  const { routes } = await mountConsole(t, tree);
  const port = await startEntry(t, routes);
  // /billing needs the owner (a paired session since PUB-5).
  const owner = await ownerSession(entry, port);
  for (const [pathname, plain] of [["/", {}], ["/", { accept: "text/html" }], ["/index.html", {}], ["/billing", { accept: "text/html" }], ["/billing/", {}], ["/billing?manager=vllm", { accept: "text/html" }]]) {
    const headers = { ...plain, ...owner.headers() };
    const before = await raw(plainPort, pathname, { headers });
    const after = await raw(port, pathname, { headers });
    assert.equal(after.status, before.status, pathname);
    assert.deepEqual(comparableHeaders(after), comparableHeaders(before), pathname);
    assert.ok(after.body.equals(before.body), `${pathname} body`);
  }
  // /classic is retired (CON-28): it hands over to the console.
  const classic = await raw(port, "/classic");
  assert.equal(classic.status, 302);
  assert.equal(classic.headers.location, "/overview");
  // /billing/classic from loopback through the whole entry.
  const billing = await raw(port, "/billing/classic?embed=1", { headers: owner.headers() });
  assert.equal(billing.status, 200);
  assert.equal(billing.headers["x-frame-options"], "SAMEORIGIN");
});

test("through the entry: the role comes from request-auth, a proxied / is 404 and the new default serves the shell", async (t) => {
  withEnv(t);
  await loadEntry();
  const tree = makeTree(t);
  const { ctx, routes } = await mountConsole(t, tree);
  const port = await startEntry(t, routes);

  // The entry's PUB-5 admin auth: loopback without a session is a viewer,
  // and a paired session is the owner with its CSRF token in the bootstrap.
  const anonymous = JSON.parse((await raw(port, "/api/console/bootstrap")).body);
  assert.equal(anonymous.role, "viewer");
  assert.equal(anonymous.auth.mode, "session");
  assert.deepEqual({ ...anonymous.auth.session, autoPairAvailable: undefined }, { role: "viewer", via: "loopback", paired: false, autoPairAvailable: undefined });
  assert.equal(anonymous.auth.csrf, null);
  const owner = await ownerSession(entry, port);
  const bootstrap = JSON.parse((await raw(port, "/api/console/bootstrap", { headers: owner.headers() })).body);
  assert.equal(bootstrap.role, "owner");
  assert.equal(bootstrap.auth.mode, "session");
  assert.deepEqual(bootstrap.auth.session, { role: "owner", via: "session", paired: true, autoPairAvailable: false });
  assert.equal(bootstrap.auth.csrf, owner.csrfToken);
  assert.equal(bootstrap.buildId, core.platform.getBuildId({ aiRoot: tree.root }).contentHash);
  assert.equal(ctx.auth.viewerRegistry.match("GET", "/c/x/app.js")?.access, "viewer");

  process.env.SERVICE_ENTRY_CONSOLE_DEFAULT = "new";
  const shell = await raw(port, "/");
  assert.equal(shell.status, 200);
  assert.equal(shell.headers["content-security-policy"], EXPECTED_CSP);
  assert.equal(buildIdOf(shell.body), bootstrap.buildId);
  const proxied = await raw(port, "/", { headers: { "x-forwarded-for": "203.0.113.5" } });
  assert.equal(proxied.status, 404);
  assert.equal(JSON.parse(proxied.body).code, "public_proxy_gateway_only");
  const proxiedAsset = await raw(port, `/c/${bootstrap.buildId}/app.js`, { headers: { "x-forwarded-for": "203.0.113.5" } });
  assert.equal(proxiedAsset.status, 404);
  assert.equal((await raw(port, `/c/${bootstrap.buildId}/app.js`)).status, 200);
  // The module never sees /gateway/*.
  assert.equal(JSON.parse((await raw(port, "/gateway/health")).body).service, "local-ai-gateway");
});
