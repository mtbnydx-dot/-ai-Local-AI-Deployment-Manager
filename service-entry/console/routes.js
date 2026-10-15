// The route table (07 §3.3, §5). Each page is a module under routes/ whose
// default export is the page component; it gets `{ route, params, query }`.
// Pages arrive package by package: a path whose module is not in the build
// yet shows the shell's "still being built" page (components/app-shell.js),
// so adding a page never means editing this file again.
//
// route = { name, path, load, titleKey, section, ownerOnly, viewerReadable, feature, spec }
//   section         the sidebar entry the page belongs to (data/nav.js)
//   ownerOnly       a viewer sees the PairingScreen instead of the page
//   viewerReadable  documents the pages 05 §5.4 lets a viewer read
//   feature         the bootstrap `features` flag whose absence is the page's degrade path
//   spec            whose requirements the page meets (07, 06, 05, 02)

function page(name, path, load, { section, titleKey, ownerOnly = true, viewerReadable = false, feature, spec = "07" }) {
  return Object.freeze({
    name,
    path,
    load,
    titleKey: titleKey || `shell.nav.${section}`,
    section,
    ownerOnly,
    viewerReadable,
    ...(feature ? { feature } : {}),
    spec,
  });
}

const OPEN = { ownerOnly: false, viewerReadable: true };

export const ROUTES = Object.freeze([
  Object.freeze({ name: "home", path: "/", redirect: "/overview", titleKey: "shell.nav.overview", section: "overview", ownerOnly: false, spec: "07" }),

  page("overview", "/overview", () => import("./routes/overview.js"), { section: "overview", ...OPEN }),

  page("deployments", "/deployments", () => import("./routes/deployments.js"), { section: "deployments", feature: "engines", ...OPEN }),
  page("deployments.new", "/deployments/new", () => import("./routes/deploy-wizard/index.js"), { section: "deployments", feature: "engines" }),
  page("deployments.routing", "/deployments/routing", () => import("./routes/deployments-routing.js"), { section: "deployments", feature: "engines" }),
  page("deployments.detail", "/deployments/:fleetId", () => import("./routes/deployment-detail.js"), { section: "deployments", feature: "engines", ...OPEN }),

  page("models", "/models", () => import("./routes/models/library.js"), { section: "models", feature: "hub" }),
  page("models.discover", "/models/discover", () => import("./routes/models/discover.js"), { section: "models", feature: "hub" }),
  page("models.downloads", "/models/downloads", () => import("./routes/models/downloads.js"), { section: "models", feature: "hub" }),
  page("models.storage", "/models/storage", () => import("./routes/models/storage.js"), { section: "models", feature: "hub" }),
  page("models.knowledge", "/models/knowledge", () => import("./routes/models/knowledge.js"), { section: "models", feature: "models", spec: "02" }),
  page("models.library", "/models/library/:entryId", () => import("./routes/models/model-detail.js"), { section: "models", feature: "hub" }),
  page("models.hub", "/models/hub/:provider/:owner/:name", () => import("./routes/models/model-detail.js"), { section: "models", feature: "hub" }),

  page("engines", "/engines", () => import("./routes/engines/index.js"), { section: "engines", feature: "engines", spec: "01" }),
  page("engines.new", "/engines/new", () => import("./routes/engines/engine-new.js"), { section: "engines", feature: "engines", spec: "01" }),
  page("engines.external", "/engines/external", () => import("./routes/engines/external.js"), { section: "engines", feature: "engines", spec: "01" }),
  page("engines.detail", "/engines/:engineId", () => import("./routes/engines/engine-detail.js"), { section: "engines", feature: "engines", spec: "01" }),

  page("playground", "/playground", () => import("./routes/playground.js"), { section: "playground", ...OPEN }),

  page("observability", "/observability", () => import("./routes/observability/overview.js"), { section: "observability", feature: "telemetry" }),
  page("observability.performance", "/observability/performance", () => import("./routes/observability/performance.js"), { section: "observability", feature: "telemetry" }),
  page("observability.traffic", "/observability/traffic", () => import("./routes/observability/traffic.js"), { section: "observability", feature: "telemetry" }),
  page("observability.errors", "/observability/errors", () => import("./routes/observability/errors.js"), { section: "observability", feature: "telemetry" }),
  page("observability.gpu", "/observability/gpu", () => import("./routes/observability/gpu.js"), { section: "observability", feature: "telemetry" }),
  page("observability.models", "/observability/models", () => import("./routes/observability/models.js"), { section: "observability", feature: "telemetry" }),
  page("observability.requests", "/observability/requests", () => import("./routes/observability/requests.js"), { section: "observability", feature: "telemetry" }),
  page("observability.request", "/observability/requests/:requestId", () => import("./routes/observability/request-detail.js"), { section: "observability", feature: "telemetry" }),
  page("observability.settings", "/observability/settings", () => import("./routes/observability/settings.js"), { section: "observability", feature: "telemetry" }),

  page("audit", "/audit", () => import("./routes/audit/timeline.js"), { section: "audit", feature: "audit" }),
  page("audit.conversations", "/audit/conversations", () => import("./routes/audit/conversations.js"), { section: "audit", feature: "audit" }),
  page("audit.exports", "/audit/exports", () => import("./routes/audit/exports.js"), { section: "audit", feature: "audit" }),
  page("audit.access-log", "/audit/access-log", () => import("./routes/audit/access-log.js"), { section: "audit", feature: "audit" }),
  page("audit.settings", "/audit/settings", () => import("./routes/audit/settings.js"), { section: "audit", feature: "audit" }),

  page("alerts", "/alerts", () => import("./routes/alerts.js"), { section: "alerts", feature: "alerts" }),

  page("access", "/access", () => import("./routes/access/index.js"), { section: "access", feature: "access", spec: "05" }),
  page("access.keys", "/access/keys", () => import("./routes/access/keys.js"), { section: "access", feature: "access", spec: "05" }),
  page("access.key", "/access/keys/:keyId", () => import("./routes/access/key-detail.js"), { section: "access", feature: "access", spec: "05" }),
  page("access.clients", "/access/clients", () => import("./routes/access/clients.js"), { section: "access", feature: "access", spec: "05", ...OPEN }),
  page("access.public", "/access/public", () => import("./routes/access/public.js"), { section: "access", feature: "public", spec: "05" }),
  page("access.security", "/access/security", () => import("./routes/access/security.js"), { section: "access", feature: "public", spec: "05" }),
  page("access.portal", "/access/portal", () => import("./routes/access/portal.js"), { section: "access", feature: "public", spec: "05" }),
  page("access.sessions", "/access/sessions", () => import("./routes/access/sessions.js"), { section: "access", feature: "session", spec: "05" }),

  page("billing", "/billing", () => import("./routes/billing.js"), { section: "billing" }),
  page("voice", "/voice", () => import("./routes/voice.js"), { section: "voice", ...OPEN }),

  page("system", "/system", () => import("./routes/system/index.js"), { section: "system", feature: "platform", spec: "06", ...OPEN }),
  page("system.doctor", "/system/doctor", () => import("./routes/system/doctor.js"), { section: "system", feature: "platform", spec: "06" }),
  page("system.settings", "/system/settings", () => import("./routes/system/settings.js"), { section: "system", feature: "platform", spec: "06" }),
  page("system.updates", "/system/updates", () => import("./routes/system/updates.js"), { section: "system", feature: "platform", spec: "06" }),
  page("system.ops", "/system/ops", () => import("./routes/system/ops.js"), { section: "system", feature: "platform", spec: "06" }),
  page("system.preferences", "/system/preferences", () => import("./routes/system/preferences.js"), { section: "system", titleKey: "prefs.title", ...OPEN }),
  page("system.ui-kit", "/system/ui-kit", () => import("./routes/system/ui-kit.js"), { section: "system", titleKey: "uikit.title", ...OPEN }),

  page("setup", "/setup", () => import("./routes/setup.js"), { section: "system", titleKey: "shell.title.setup", feature: "setup", spec: "06" }),
]);

/** The pages the shell falls back to (routes/not-found.js, routes/forbidden.js). */
export const NOT_FOUND_ROUTE = Object.freeze({
  name: "not-found",
  path: "*",
  load: () => import("./routes/not-found.js"),
  titleKey: "shell.notFound.title",
  section: null,
  ownerOnly: false,
  spec: "07",
});

export const FORBIDDEN_ROUTE = Object.freeze({
  name: "forbidden",
  path: "*",
  load: () => import("./routes/forbidden.js"),
  titleKey: "shell.forbidden.title",
  section: null,
  ownerOnly: false,
  spec: "07",
});
