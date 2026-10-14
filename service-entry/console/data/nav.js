// The sidebar's information architecture (07 §5): four groups, twelve
// entries. `viewer` says what a viewer (05 §5.4) may open: "read" for the
// pages backed by the viewer allowlist, "partial" when only a sub-page is
// readable (`viewerPath`), "none" for owner-only pages, which show a lock.
// Labels are catalog keys (`shell.nav.*`); the page title of a route comes
// from routes.js.

export const NAV_GROUPS = Object.freeze([
  Object.freeze({
    id: "operate",
    labelKey: "shell.group.operate",
    items: Object.freeze([
      Object.freeze({ id: "overview", path: "/overview", labelKey: "shell.nav.overview", icon: "layout-dashboard", viewer: "read" }),
      Object.freeze({ id: "deployments", path: "/deployments", labelKey: "shell.nav.deployments", icon: "rocket", viewer: "read" }),
      Object.freeze({ id: "models", path: "/models", labelKey: "shell.nav.models", icon: "boxes", viewer: "none" }),
      Object.freeze({ id: "engines", path: "/engines", labelKey: "shell.nav.engines", icon: "cpu", viewer: "none" }),
      Object.freeze({ id: "playground", path: "/playground", labelKey: "shell.nav.playground", icon: "message-square", viewer: "read" }),
    ]),
  }),
  Object.freeze({
    id: "insight",
    labelKey: "shell.group.insight",
    items: Object.freeze([
      Object.freeze({ id: "observability", path: "/observability", labelKey: "shell.nav.observability", icon: "activity", viewer: "none" }),
      Object.freeze({ id: "audit", path: "/audit", labelKey: "shell.nav.audit", icon: "file-search", viewer: "none" }),
      Object.freeze({ id: "alerts", path: "/alerts", labelKey: "shell.nav.alerts", icon: "bell-ring", viewer: "none" }),
    ]),
  }),
  Object.freeze({
    id: "serve",
    labelKey: "shell.group.serve",
    items: Object.freeze([
      Object.freeze({ id: "access", path: "/access", labelKey: "shell.nav.access", icon: "key-round", viewer: "partial", viewerPath: "/access/clients" }),
      Object.freeze({ id: "billing", path: "/billing", labelKey: "shell.nav.billing", icon: "receipt", viewer: "none" }),
      Object.freeze({ id: "voice", path: "/voice", labelKey: "shell.nav.voice", icon: "mic", viewer: "read" }),
    ]),
  }),
  Object.freeze({
    id: "platform",
    labelKey: "shell.group.platform",
    items: Object.freeze([
      Object.freeze({ id: "system", path: "/system", labelKey: "shell.nav.system", icon: "settings", viewer: "partial" }),
    ]),
  }),
]);

/** Every entry, in sidebar order. */
export const NAV_ITEMS = Object.freeze(NAV_GROUPS.flatMap((group) => group.items));

/** The entry with this id (a route's `section`), or null. */
export function navItem(id) {
  return NAV_ITEMS.find((item) => item.id === id) || null;
}

/** True when the entry is closed to this role: owner-only for a viewer. */
export function isLockedFor(item, role) {
  return role !== "owner" && item?.viewer === "none";
}

/** Where the entry's link goes for this role (a viewer of a partial entry lands on its readable sub-page). */
export function navHref(item, role) {
  return role !== "owner" && item?.viewerPath ? item.viewerPath : item?.path || "/overview";
}
