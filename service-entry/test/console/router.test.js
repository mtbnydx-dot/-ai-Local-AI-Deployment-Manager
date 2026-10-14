// 07 §3.3 router: matching, href building with encoded ids, every legacy
// redirect, credential fragments left alone, guards and history handling.

import assert from "node:assert/strict";
import test from "node:test";

import { buildHref, createRouter, documentTitle, legacyRedirect, matchRoute } from "../../console/lib/router.js";
import { CONSOLE_HASHES, MANAGER_HASHES } from "../../console/lib/legacy-redirects.js";

const ROUTES = [
  { name: "overview", path: "/overview", titleKey: "shell.nav.overview" },
  { name: "deployments", path: "/deployments", titleKey: "shell.nav.deployments" },
  { name: "deployment-new", path: "/deployments/new" },
  { name: "deployment", path: "/deployments/:fleetId" },
  { name: "routing", path: "/deployments/routing" },
  { name: "models", path: "/models" },
  { name: "model", path: "/models/:modelId" },
  { name: "model-tab", path: "/models/:modelId/:tab" },
  { name: "observability", path: "/observability/*" },
  { name: "request", path: "/observability/requests/:requestId" },
  { name: "home", path: "/" },
];

test("matchRoute prefers static segments, decodes params and handles the rest wildcard", () => {
  assert.equal(matchRoute(ROUTES, "/deployments").route.name, "deployments");
  assert.equal(matchRoute(ROUTES, "/deployments/").route.name, "deployments");
  assert.equal(matchRoute(ROUTES, "/deployments/new").route.name, "deployment-new");
  assert.equal(matchRoute(ROUTES, "/deployments/routing").route.name, "routing");
  assert.deepEqual(matchRoute(ROUTES, "/deployments/vllm%3Aprimary"), { route: ROUTES[3], params: { fleetId: "vllm:primary" } });
  assert.deepEqual(matchRoute(ROUTES, "/deployments/vllm:primary").params, { fleetId: "vllm:primary" });
  assert.deepEqual(matchRoute(ROUTES, "/models/a%2Fb/files").params, { modelId: "a/b", tab: "files" });
  assert.deepEqual(matchRoute(ROUTES, "/observability/traffic/keys").params, { "*": "traffic/keys" });
  assert.equal(matchRoute(ROUTES, "/observability/requests/req_1").route.name, "request");
  assert.equal(matchRoute(ROUTES, "/observability").route.name, "observability");
  assert.equal(matchRoute(ROUTES, "/").route.name, "home");
  assert.equal(matchRoute(ROUTES, "/deployments/x?tab=logs#top").params.fleetId, "x");
  assert.equal(matchRoute(ROUTES, "/nowhere"), null);
  assert.equal(matchRoute(ROUTES, "/deployments/a/b"), null);
  assert.equal(matchRoute(ROUTES, "/deployments/%E0%A4%A"), null, "bad percent-encoding never matches");
});

test("buildHref encodes ids, sorts the query and refuses missing params", () => {
  assert.equal(buildHref(ROUTES, "deployment", { fleetId: "vllm:primary" }), "/deployments/vllm%3Aprimary");
  assert.equal(buildHref(ROUTES, "model-tab", { modelId: "org/name", tab: "files" }), "/models/org%2Fname/files");
  assert.equal(buildHref(ROUTES, "deployments", {}, { tab: "logs", manager: "vllm", empty: "" }), "/deployments?manager=vllm&tab=logs");
  assert.equal(buildHref(ROUTES, "observability", { "*": "traffic/keys" }), "/observability/traffic/keys");
  assert.equal(buildHref(ROUTES, "home"), "/");
  assert.throws(() => buildHref(ROUTES, "deployment", {}), /fleetId/);
  assert.throws(() => buildHref(ROUTES, "nope"), /Unknown route/);
  const href = buildHref(ROUTES, "deployment", { fleetId: "llama:a b/c" });
  assert.deepEqual(matchRoute(ROUTES, href).params, { fleetId: "llama:a b/c" }, "build and match round-trip");
});

test("every old console hash redirects", () => {
  const expected = {
    "/#overview": "/overview",
    "/#models": "/deployments",
    "/#tasks": "/models/downloads",
    "/#playground": "/playground",
    "/#voice": "/voice",
    "/#clients": "/access",
    "/#operations": "/system",
  };
  for (const [from, to] of Object.entries(expected)) assert.equal(legacyRedirect(from), to, from);
  assert.equal(Object.keys(CONSOLE_HASHES).length, Object.keys(expected).length);
  assert.equal(legacyRedirect("http://host.example:5176/#overview"), "/overview", "absolute hrefs work too");
});

test("every manager hash with ?from=<mgr> redirects", () => {
  const expected = {
    service: "/deployments?manager=vllm",
    download: "/models/discover",
    "online-models": "/models/discover",
    models: "/models",
    stats: "/observability",
    "external-access": "/observability/traffic",
    audit: "/audit",
    logs: "/deployments?manager=vllm&tab=logs",
    exposure: "/access",
    tools: "/system",
  };
  for (const [hash, to] of Object.entries(expected)) assert.equal(legacyRedirect(`/?from=vllm#${hash}`), to, hash);
  assert.equal(Object.keys(MANAGER_HASHES).length, Object.keys(expected).length);
  assert.equal(legacyRedirect("/?from=llama#logs"), "/deployments?manager=llama&tab=logs");
  assert.equal(legacyRedirect("/?from=llama#overview"), "/overview", "console hashes still apply with from");
  assert.equal(legacyRedirect("/?from=<script>#service"), null, "a bad manager id is not echoed");
});

test("#pair= and #key= are never redirected; other paths and unknown hashes are left alone", () => {
  assert.equal(legacyRedirect("/#pair=abcd1234"), null);
  assert.equal(legacyRedirect("/?from=vllm#pair=abcd1234"), null);
  assert.equal(legacyRedirect("/#key=sk-fake"), null);
  assert.equal(legacyRedirect("/#unknown"), null);
  assert.equal(legacyRedirect("/"), null);
  assert.equal(legacyRedirect("/classic#overview"), null);
  assert.equal(legacyRedirect("/deployments#models"), null);
});

function fakeHistory(start = "/") {
  const location = { pathname: "/", search: "", hash: "" };
  const set = (href) => {
    const [rest, hash = ""] = href.split("#");
    const [pathname, search = ""] = rest.split("?");
    location.pathname = pathname || "/";
    location.search = search ? `?${search}` : "";
    location.hash = hash ? `#${hash}` : "";
  };
  set(start);
  const entries = [];
  const history = {
    state: null,
    pushState(state, title, href) {
      entries.push(["push", href]);
      this.state = state;
      set(href);
    },
    replaceState(state, title, href) {
      entries.push(["replace", href]);
      this.state = state;
      set(href);
    },
  };
  return { history, location, entries, set };
}

test("createRouter starts with the legacy redirect, navigates, pops and honours guards", async () => {
  const { history, location, entries, set } = fakeHistory("/?from=vllm#service");
  const changes = [];
  let pop = null;
  const router = createRouter({
    routes: ROUTES,
    history,
    location,
    onChange: (current, { action }) => changes.push([action, current.route?.name ?? null, current.query]),
    listen: (fn) => {
      pop = fn;
      return () => {
        pop = null;
      };
    },
  });
  const first = router.start();
  assert.deepEqual(entries, [["replace", "/deployments?manager=vllm"]]);
  assert.equal(first.route.name, "deployments");
  assert.deepEqual(first.query, { manager: "vllm" });

  assert.equal(await router.navigate(router.href("deployment", { fleetId: "vllm:primary" })), true);
  assert.equal(router.current.params.fleetId, "vllm:primary");
  let draftDirty = true;
  const off = router.addGuard(async (next) => !(draftDirty && next.match?.route.name !== "deployment-new"));
  assert.equal(await router.navigate("/overview"), false);
  assert.equal(router.current.route.name, "deployment", "a blocked navigation changes nothing");
  draftDirty = false;
  assert.equal(await router.navigate("/overview", { replace: true }), true);
  off();
  router.addGuard(() => {
    throw new Error("broken guard");
  });
  assert.equal(await router.navigate("/models"), false, "a throwing guard blocks");

  set("/nowhere");
  pop();
  assert.equal(router.current.route, null);
  router.stop();
  assert.equal(pop, null);
  assert.deepEqual(changes.map(([action, name]) => `${action}:${name}`), ["replace:deployments", "push:deployment", "replace:overview", "pop:null"]);
});

test("createRouter leaves a #pair= fragment for boot to strip", () => {
  const { history, location, entries } = fakeHistory("/#pair=abcd1234");
  const router = createRouter({ routes: ROUTES, history, location, listen: () => () => {} });
  router.start();
  assert.deepEqual(entries, []);
});

test("documentTitle is `title · product`", () => {
  const t = (key) => ({ "shell.product": "Local AI Platform", "shell.nav.overview": "Overview" })[key] || key;
  assert.equal(documentTitle(ROUTES[0], t), `Overview ${String.fromCharCode(0xb7)} Local AI Platform`);
  assert.equal(documentTitle(null, t), "Local AI Platform");
});
