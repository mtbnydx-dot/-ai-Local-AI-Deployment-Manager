"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const { createViewerRegistry } = require("../lib/viewer-allowlist");
const { redactManagerReadForViewer } = require("../lib/mgmt-proxy");
const { loadEntry, ownerSession, quietLogger, request, serveEntry, spyModule } = require("./helpers/entry-harness");

// 05 §5.4: deny by default, central redaction, viewer event types, and the
// route inventory that every entry GET must be part of.

const LAN = "192.168.1.50";
const ENTRY_DIR = path.join(__dirname, "..");

// --- the registry ------------------------------------------------------------

test("match picks the most specific entry, HEAD follows GET and admin-only wins a tie", () => {
  const registry = createViewerRegistry();
  const redact = (body) => body;
  registry.registerAdminOnly({ owner: "07", method: "GET", path: "/api/m/:managerId/*" });
  registry.registerRoute({ owner: "07", path: "/api/m/:managerId/status", redact });
  registry.registerRoute({ owner: "07", path: "/c/*" });
  registry.registerRoute({ owner: "05", path: "/api/x/:id" });
  registry.registerAdminOnly({ owner: "05", method: "GET", path: "/api/x/:name" });
  registry.registerReadOnlyPost({ owner: "05", path: "/api/fleet/route-preview" });

  const status = registry.match("GET", "/api/m/vllm/status");
  assert.equal(status.access, "viewer");
  assert.deepEqual(status.params, { managerId: "vllm" });
  assert.equal(status.entry.redact, redact);
  assert.equal(status.entry.owner, "07");
  assert.equal(registry.match("HEAD", "/api/m/llama/status").access, "viewer", "HEAD follows GET");
  assert.equal(registry.match("GET", "/api/m/vllm/config").access, "admin", "the wildcard covers the rest");
  assert.equal(registry.match("POST", "/api/m/vllm/status"), null, "a GET entry never covers a POST");
  assert.deepEqual(registry.match("GET", "/c/assets/app.js").params, { "*": "assets/app.js" });
  assert.equal(registry.match("GET", "/api/x/1").access, "admin", "an equally specific admin-only entry wins");
  assert.equal(registry.match("POST", "/api/fleet/route-preview").access, "viewer");
  assert.equal(registry.match("GET", "/api/fleet/route-preview"), null);
  assert.equal(registry.match("GET", "/api/nothing"), null);
});

test("registration rules: GET-only viewer routes, one entry per route, frozen after startup", () => {
  const registry = createViewerRegistry();
  assert.throws(() => registry.registerRoute({ owner: "05", method: "POST", path: "/api/write" }), TypeError, "a viewer POST must be declared read-only");
  assert.throws(() => registry.registerRoute({ path: "/api/x" }), /owner/);
  for (const bad of ["api/x", "/a/*/b", "/a?b=1", "/a b", "/a/:"]) {
    assert.throws(() => registry.registerRoute({ owner: "05", path: bad }), TypeError, bad);
  }
  assert.throws(() => registry.registerRoute({ owner: "05", path: "/api/x", redact: "strip" }), /redact/);
  assert.throws(() => registry.registerAdminOnly({ owner: "05", method: "BREW", path: "/api/x" }), TypeError);

  registry.registerRoute({ owner: "05", path: "/api/x" });
  assert.throws(() => registry.registerAdminOnly({ owner: "07", method: "GET", path: "/api/x" }), /already registered by 05/);
  assert.throws(() => registry.registerRoute({ owner: "07", path: "/api/x" }), /already registered by 05/);
  registry.registerAdminOnly({ owner: "05", method: "DELETE", path: "/api/x" });
  // A second admin-only declaration of the same route is a no-op; turning an
  // admin-only route into a viewer route is a conflict.
  registry.registerAdminOnly({ owner: "05", method: "GET", path: "/api/access/*" });
  registry.registerAdminOnly({ owner: "05-access", method: "GET", path: "/api/access/*" });
  assert.equal(registry.inventory().filter((item) => item.path === "/api/access/*").length, 1);
  assert.equal(registry.match("GET", "/api/access/keys").entry.owner, "05");
  assert.throws(() => registry.registerRoute({ owner: "05-access", path: "/api/access/*" }), /already registered/);

  assert.equal(registry.frozen, false);
  registry.freeze();
  assert.equal(registry.frozen, true);
  assert.throws(() => registry.registerRoute({ owner: "05", path: "/api/late" }), /frozen/);
  assert.throws(() => registry.registerEventType({ owner: "05", type: "late" }), /frozen/);
  assert.equal(registry.match("GET", "/api/x").access, "viewer", "lookups keep working");
});

test("event types: viewers get registered types through their redaction, a failing one drops the event", () => {
  const logger = quietLogger();
  const registry = createViewerRegistry({ logger });
  registry.registerEventType({ owner: "05", type: "status", redact: (data) => ({ reason: data.reason }) });
  registry.registerEventType({ owner: "03", type: "downloads" });
  registry.registerEventType({ owner: "04", type: "alerts", redact: () => { throw new Error("rule bug"); } });
  assert.throws(() => registry.registerEventType({ owner: "04", type: "status" }), /already registered/);

  assert.deepEqual(registry.viewerEventTypes(), ["status", "downloads", "alerts"]);
  assert.deepEqual(registry.redactEvent("status", { reason: "manager_up", pid: 42 }), { reason: "manager_up" });
  const download = { jobs: [{ id: "dl_1" }] };
  assert.equal(registry.redactEvent("downloads", download), download);
  assert.equal(registry.redactEvent("alerts", { action: "firing" }), null);
  assert.equal(registry.redactEvent("notification", { kind: "x" }), null, "unregistered types never reach viewers");
  assert.equal(logger.lines.length, 1, "one log line for the failed redaction");
  assert.match(logger.lines[0], /alerts event redaction failed/);

  assert.deepEqual(registry.inventory().filter((item) => item.method === "EVENT").map((item) => item.path), ["status", "downloads", "alerts"]);
});

// --- deny by default and central redaction through the real entry -----------

function reportModule(report) {
  return {
    name: "report-fixture",
    mount(ctx) {
      const registry = ctx.auth.viewerRegistry;
      registry.registerRoute({ owner: "test", path: "/api/fixture/report", redact: redactManagerReadForViewer });
      registry.registerRoute({ owner: "test", path: "/api/fixture/static" });
      registry.registerRoute({ owner: "test", path: "/api/fixture/broken", redact: () => { throw new Error("redaction bug"); } });
      return {
        // The route never redacts anything itself.
        async handle(req, res, url) {
          if (url.pathname === "/api/fixture/report" || url.pathname === "/api/fixture/broken") {
            ctx.sendJson(res, report);
            return true;
          }
          if (url.pathname === "/api/fixture/static") {
            ctx.sendJson(res, { ok: true, page: "help" });
            return true;
          }
          return false;
        },
      };
    },
  };
}

async function mountEntry(t, extraModules = []) {
  const { entry } = await loadEntry();
  const ctx = entry.createRouteContext({ logger: quietLogger() });
  const routes = await entry.mountRouteModules({ ctx, modules: [...entry.ROUTE_MODULES, ...extraModules] });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  return { entry, ctx, routes, port, owner: await ownerSession(entry, port) };
}

test("LAN viewers are denied by default before any route code runs", async (t) => {
  const spy = spyModule(["/api/spy", "/api/hub/", "/api/stop-all"]);
  const { port, owner: session } = await mountEntry(t, [spy]);

  const denied = [
    ["GET", "/api/spy"],
    ["GET", "/api/hub/downloads/dl_aaaaaaaaaaaaaaaa/logs"],
    ["GET", "/api/keys"],
    ["GET", "/api/mcp/status"],
    ["GET", "/billing"],
    ["GET", "/api/billing/overview"],
    ["GET", "/api/m/vllm/config"],
    ["GET", "/api/no-such-route"],
    ["GET", "/docs/server.js"],
    ["OPTIONS", "/api/status"],
    ["POST", "/api/fleet/settings"],
    ["POST", "/api/stop-all"],
  ];
  for (const [method, pathname] of denied) {
    const response = await request(port, pathname, { method, peer: LAN, ...(method === "POST" ? { body: {} } : {}) });
    assert.equal(response.status, 401, `${method} ${pathname}`);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.error.code, "admin_session_required", `${method} ${pathname}`);
  }
  assert.deepEqual(spy.seen, [], "no denied request reached a route");

  // Registered viewer routes pass, HEAD included.
  for (const pathname of ["/", "/favicon.ico", "/shared-js/tokens.css", "/docs/client-setup-guide.md", "/api/security", "/api/events/recent"]) {
    assert.equal((await request(port, pathname, { peer: LAN })).status < 400, true, pathname);
  }
  assert.notEqual((await request(port, "/api/security", { method: "HEAD", peer: LAN })).status, 401, "HEAD follows GET");

  // Since PUB-5 loopback without credentials is a viewer too; a paired
  // session is the owner.
  const before = spy.seen.length;
  assert.equal((await request(port, "/api/spy")).status, 401);
  assert.equal((await request(port, "/api/keys")).status, 401);
  assert.equal((await request(port, "/api/security")).status, 200);
  assert.equal(spy.seen.length, before);
  const owner = await request(port, "/api/spy", { owner: session });
  assert.equal(owner.status, 200);
  assert.equal(owner.json.role, "owner");
  assert.equal((await request(port, "/api/keys", { owner: session })).status, 200);
});

test("registered routes are redacted centrally through sendJson", async (t) => {
  const report = {
    ok: true,
    model: "demo-model",
    cwd: "E:\\platform\\work",
    argv: ["node", "E:\\platform\\work\\server.js", "--port", "8000"],
    weightsFile: "E:\\models\\demo\\weights.safetensors",
    note: "weights read from /mnt/models/demo",
    gpu: { usedMb: 100 },
  };
  const { port, owner: session } = await mountEntry(t, [reportModule(report)]);

  const owner = await request(port, "/api/fixture/report", { owner: session });
  assert.deepEqual(owner.json, report, "the owner gets the body as the route sent it");

  const viewer = await request(port, "/api/fixture/report", { peer: LAN });
  assert.equal(viewer.status, 200);
  for (const key of ["cwd", "argv", "weightsFile"]) assert.equal(Object.hasOwn(viewer.json, key), false, key);
  assert.equal(viewer.json.model, "demo-model");
  assert.deepEqual(viewer.json.gpu, { usedMb: 100 });
  for (const leak of ["E:\\", "/mnt/", "server.js"]) assert.equal(viewer.text.includes(leak), false, leak);

  // An entry without a redaction is a static read.
  assert.deepEqual((await request(port, "/api/fixture/static", { peer: LAN })).json, { ok: true, page: "help" });

  // A redaction that throws answers 500 and never sends the unredacted body.
  const errors = t.mock.method(console, "error", () => {});
  const broken = await request(port, "/api/fixture/broken", { peer: LAN });
  assert.equal(broken.status, 500);
  assert.deepEqual(broken.json, { ok: false, error: { code: "internal_error", message: "Service entry error." } });
  assert.equal(broken.text.includes("demo-model"), false);
  assert.equal(errors.mock.calls.length, 1);
  assert.equal((await request(port, "/api/fixture/broken", { owner: session })).status, 200, "the owner is not redacted");
});

test("the 05 baseline serves LAN viewers redacted copies of status, security, fleet and access", async (t) => {
  const { port, owner } = await mountEntry(t);

  const ownerStatus = (await request(port, "/api/status", { owner })).json;
  assert.equal(typeof ownerStatus.entry.pid, "number");
  const status = await request(port, "/api/status", { peer: LAN });
  assert.equal(status.status, 200);
  assert.equal(status.json.ok, true);
  assert.equal(status.json.entry.pid, undefined);
  assert.equal(status.json.entry.exitLog, undefined);
  assert.equal(status.json.security.switches, undefined);
  for (const manager of status.json.managers) assert.equal(manager.root, undefined);

  const security = await request(port, "/api/security", { peer: LAN });
  assert.deepEqual(Object.keys(security.json.security).sort(), ["allowLanAdmin", "apiKeyEnforced", "corsMode", "exposure", "lanMode", "publicMode", "requireApiKey", "requireApiKeyMode"]);
  assert.ok((await request(port, "/api/security", { owner })).json.security.switches, "the owner keeps the switches");

  const fleet = await request(port, "/api/fleet", { peer: LAN });
  assert.equal(fleet.status, 200);
  assert.equal(fleet.json.ok, true);
  assert.equal(Object.hasOwn(fleet.json, "gatewayBase"), false);
  assert.ok(Array.isArray(fleet.json.instances));

  const preview = await request(port, "/api/fleet/route-preview", { method: "POST", peer: LAN, body: { model: "auto" } });
  assert.equal(preview.status, 200);
  assert.ok(Object.hasOwn(preview.json, "request"));

  const access = await request(port, "/api/gateway-access", { peer: LAN });
  assert.equal(access.status, 200);
  for (const key of ["logPath", "clients", "recent"]) assert.equal(Object.hasOwn(access.json, key), false, key);
});

test("redactFleetForViewer keeps model ids, states and capabilities and drops paths, ports and container details", async () => {
  const { entry } = await loadEntry();
  const snapshot = {
    ok: true,
    updatedAt: "2026-10-14T00:00:00.000Z",
    settings: { mode: "auto", reserveMb: 8192, maxUtilizationPct: 90, preferEngine: "auto" },
    gpuMemory: { totalMb: 98000, usedMb: 60000, freeMb: 38000, reserveMb: 8192, allocatableMb: 29808, warningThresholdPct: 90, gpus: [{ id: "0", sourceId: "0", name: "GPU 0", totalMb: 98000, usedMb: 60000, freeMb: 38000 }] },
    instances: [{
      id: "primary",
      fleetId: "vllm:primary",
      instanceId: "primary",
      primary: true,
      manager: { id: "vllm", name: "vLLM Manager", root: "E:\\platform\\vllm-manager", port: 5177 },
      managerId: "vllm",
      engine: "vllm",
      containerName: "vllm-local",
      running: true,
      status: "running",
      lifecycleState: "ready",
      image: "registry.example/vllm:dev",
      port: 18081,
      localBaseUrl: "http://127.0.0.1:18081/v1",
      lanBaseUrl: "http://192.168.1.10:18081/v1",
      pid: 4242,
      argv: ["vllm", "serve", "/mnt/models/demo"],
      env: { VLLM_API_KEY: "test-placeholder-not-a-key" },
      models: [{ id: "demo-model", root: "/mnt/models/demo", path: "E:\\models\\demo", maxModelLen: 32768, capabilities: ["text", "tools"], container_name: "vllm-local" }],
    }],
    slots: [{ id: "vision", label: "视觉模型槽位", capability: "vision", state: "empty", managerId: "vllm" }],
    gatewayBase: "http://127.0.0.1:5176/gateway/auto/openai/v1",
    routing: { mode: "auto", genericModelIds: ["auto"], capabilityCounts: { text: 1 } },
  };
  const viewer = entry.redactFleetForViewer(snapshot);
  const text = JSON.stringify(viewer);
  for (const leak of ["E:\\", "/mnt/", "vllm-local", "5177", "18081", "4242", "registry.example", "192.168.1.10", "test-placeholder", "gatewayBase"]) {
    assert.equal(text.includes(leak), false, leak);
  }
  const [instance] = viewer.instances;
  assert.deepEqual(instance.models, [{ id: "demo-model", maxModelLen: 32768, capabilities: ["text", "tools"] }]);
  assert.equal(instance.lifecycleState, "ready");
  assert.equal(instance.running, true);
  assert.equal(instance.managerId, "vllm");
  assert.equal(viewer.gpuMemory.allocatableMb, 29808);
  assert.equal(viewer.gpuMemory.gpus[0].name, "GPU 0");
  assert.deepEqual(viewer.routing.capabilityCounts, { text: 1 });
  assert.equal(viewer.slots[0].state, "empty");

  const preview = entry.redactFleetForViewer({
    ok: true,
    status: 200,
    request: { engine: "auto", protocol: "openai", path: "v1/chat/completions", requestedModel: "demo-model" },
    manager: { id: "vllm", name: "vLLM Manager", port: 5177 },
    instance: { id: "primary", instanceId: "primary", primary: true, containerName: "vllm-local", port: 8000, status: "running" },
    model: { id: "demo-model", root: "E:\\models\\demo", capabilities: ["text"] },
  });
  assert.deepEqual(preview.manager, { id: "vllm", name: "vLLM Manager" });
  assert.deepEqual(preview.instance, { id: "primary", instanceId: "primary", primary: true, status: "running" });
  assert.deepEqual(preview.model, { id: "demo-model", capabilities: ["text"] });
  assert.equal(preview.request.requestedModel, "demo-model");
});

function openStream(port, pathname, peer) {
  return new Promise((resolve, reject) => {
    const call = http.get({ host: "127.0.0.1", port, path: pathname, agent: false, headers: { host: "127.0.0.1:5176", ...(peer ? { "x-test-peer": peer } : {}) } }, (response) => {
      response.setEncoding("utf8");
      const stream = { status: response.statusCode, text: "", close: () => call.destroy() };
      response.on("data", (chunk) => { stream.text += chunk; });
      resolve(stream);
    });
    call.on("error", reject);
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a viewer's event stream carries only the registered types, redacted", async (t) => {
  const { ctx, port } = await mountEntry(t);
  const stream = await openStream(port, "/api/events", LAN);
  t.after(() => stream.close());
  assert.equal(stream.status, 200);
  await waitFor(() => ctx.bus.stats().clients === 1);
  ctx.bus.publish("jobs", { managerId: "vllm", jobs: [{ id: "job-1" }] });
  ctx.bus.publish("notification", { kind: "test", severity: "info", title: { zh: "测试", en: "Test" } });
  ctx.bus.publish("instances", { managerId: "vllm", changed: ["primary"], removed: [], instances: [{ id: "primary", state: "ready", root: "E:\\models\\demo" }] });
  const last = ctx.bus.publish("status", { reason: "manager_up", managerId: "vllm", detail: "E:\\platform" });
  await waitFor(() => stream.text.includes(`id: ${last.id}`));
  const types = [...stream.text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(types, ["instances", "status"]);
  assert.equal(stream.text.includes("E:\\"), false);
});

// --- the route inventory (05 §5.4) --------------------------------------------

// The key-checked gateway and the manager-signed /internal/* calls have their
// own authentication and never meet the viewer registry.
const INVENTORY_EXEMPT_PREFIXES = ["/gateway", "/internal"];
const ANY_METHOD = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const READ_METHODS = new Set(["GET", "HEAD"]);

function isExempt(pathname) {
  return INVENTORY_EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// The body of the regex literal that starts at `start` (its opening slash).
function regexLiteralAt(text, start) {
  let inClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "\\") {
      index += 1;
    } else if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      return text.slice(start + 1, index);
    }
  }
  return null;
}

// A path the regex matches: each top-level group or class becomes "x".
function regexSample(source) {
  let out = "";
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "\\") {
      if (depth === 0 && !inClass) out += source[index + 1] || "";
      index += 1;
    } else if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
      if (depth === 0) out += "x";
    } else if (ch === "(") {
      if (depth === 0) out += "x";
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    } else if (depth === 0 && !"^$*+?".includes(ch)) {
      out += ch;
    }
  }
  return out;
}

// Route literals in one source file: url.pathname === "…",
// pathname.startsWith("/…"), /^\/api\/…/ patterns and the `path:` entries of
// a *ROUTES table. The method is the one compared on the same line, if any.
function scanRouteLiterals(source, file) {
  const literals = [];
  let table = null;
  source.split(/\r?\n/).forEach((text, index) => {
    const line = index + 1;
    const method = (/\bmethod\s*===\s*"([A-Z]+)"/.exec(text) || [])[1] || "";
    const add = (kind, value, verb = method) => literals.push({ file, line, kind, path: value, method: verb });
    for (const found of text.matchAll(/pathname\s*===\s*"(\/[^"]*)"/g)) add("exact", found[1]);
    for (const found of text.matchAll(/pathname\.startsWith\(\s*"(\/[^"]+)"\s*\)/g)) {
      if (found[1] !== "/") add("prefix", found[1]);
    }
    for (let at = text.indexOf("/^\\/api\\/"); at !== -1; at = text.indexOf("/^\\/api\\/", at + 1)) {
      const body = regexLiteralAt(text, at);
      if (body) add("regex", regexSample(body));
    }
    if (!table && /\b[A-Z][A-Z0-9_]*ROUTES\s*=/.test(text)) table = { depth: 0, opened: false };
    if (table) {
      const verb = (/\bmethod\s*:\s*["']([A-Z]+)["']/.exec(text) || [])[1] || "";
      for (const found of text.matchAll(/\bpath\s*:\s*["'`](\/[^"'`]*)["'`]/g)) {
        add("table", found[1].replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "x").replace(/\/\*$/, "/x"), verb);
      }
      for (const ch of text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) {
        if ("[({".includes(ch)) {
          table.depth += 1;
          table.opened = true;
        } else if ("])}".includes(ch)) {
          table.depth -= 1;
        }
      }
      if (table.opened && table.depth <= 0) table = null;
    }
  });
  return literals;
}

// GET literals (and those whose method the line does not say) that no
// inventory entry covers. Admin-only entries count: what matters is that the
// owner declared the route.
function unregisteredReads(literals, registry) {
  const inventory = registry.inventory().filter((item) => item.method !== "EVENT");
  return literals.filter((literal) => {
    if (isExempt(literal.path)) return false;
    if (literal.method && !READ_METHODS.has(literal.method)) return false;
    const methods = literal.method ? ["GET"] : ANY_METHOD;
    if (literal.kind === "prefix") {
      const base = literal.path.endsWith("/") ? literal.path : `${literal.path}/`;
      const declared = inventory.some((item) => methods.includes(item.method) && (item.path === literal.path || item.path.startsWith(base)));
      return !declared;
    }
    return !methods.some((method) => registry.match(method, literal.path));
  });
}

function describeLiteral(literal) {
  return `${literal.file}:${literal.line} ${literal.method || "ANY"} ${literal.path}`;
}

function entrySources() {
  const files = [path.join(ENTRY_DIR, "server.js")];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith(".js")) files.push(full);
    }
  };
  walk(path.join(ENTRY_DIR, "lib"));
  return files.map((file) => ({ file: path.relative(ENTRY_DIR, file).split(path.sep).join("/"), source: fs.readFileSync(file, "utf8") }));
}

test("the inventory scan passes on the real tree", async (t) => {
  const { entry } = await loadEntry();
  const ctx = entry.createRouteContext({ logger: quietLogger() });
  const routes = await entry.mountRouteModules({ ctx });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const literals = entrySources().flatMap(({ file, source }) => scanRouteLiterals(source, file));
  assert.ok(literals.filter((literal) => !isExempt(literal.path)).length >= 30, "the scan sees the entry's routes");
  assert.ok(literals.some((literal) => literal.file === "lib/billing-http.js" && literal.kind === "regex"));
  const missing = unregisteredReads(literals, ctx.auth.viewerRegistry).map(describeLiteral);
  assert.deepEqual(missing, [], `register these routes (viewer or admin-only):\n${missing.join("\n")}`);
});

test("the inventory scan fails on a fixture module with an unregistered GET literal", () => {
  const source = [
    '"use strict";',
    "const FIXTURE_ROUTES = [",
    '  { method: "GET", path: "/api/fixture/table/:id" },',
    '  { method: "POST", path: "/api/fixture/table" },',
    "];",
    "module.exports = { name: \"fixture\", mount(ctx) {",
    '  ctx.auth.viewerRegistry.registerRoute({ owner: "test", path: "/api/fixture/listed" });',
    "  return { async handle(req, res, url) {",
    '    if (req.method === "GET" && url.pathname === "/api/fixture/listed") return true;',
    '    if (req.method === "GET" && url.pathname === "/api/fixture/unlisted") return true;',
    '    if (req.method === "POST" && url.pathname === "/api/fixture/write") return true;',
    "    const item = url.pathname.match(/^\\/api\\/fixture\\/items\\/([^/]+)$/);",
    '    if (url.pathname.startsWith("/api/fixture/files/")) return Boolean(item);',
    '    if (url.pathname === "/gateway/fixture") return true;',
    "    return false;",
    "  } };",
    "} };",
  ].join("\n");
  const registry = createViewerRegistry();
  registry.registerRoute({ owner: "test", path: "/api/fixture/listed" });
  const literals = scanRouteLiterals(source, "lib/fixture-routes.js");
  assert.deepEqual(unregisteredReads(literals, registry).map(describeLiteral), [
    "lib/fixture-routes.js:3 GET /api/fixture/table/x",
    "lib/fixture-routes.js:10 GET /api/fixture/unlisted",
    "lib/fixture-routes.js:12 ANY /api/fixture/items/x",
    "lib/fixture-routes.js:13 ANY /api/fixture/files/",
  ]);

  // Declaring them, viewer or admin-only, makes the same scan pass.
  registry.registerAdminOnly({ owner: "test", method: "GET", path: "/api/fixture/table/:id" });
  registry.registerRoute({ owner: "test", path: "/api/fixture/unlisted" });
  registry.registerAdminOnly({ owner: "test", method: "GET", path: "/api/fixture/items/:id" });
  registry.registerAdminOnly({ owner: "test", method: "GET", path: "/api/fixture/files/*" });
  assert.deepEqual(unregisteredReads(literals, registry).map(describeLiteral), []);
});
