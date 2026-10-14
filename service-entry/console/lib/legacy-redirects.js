// Old bookmarks into the new console's clean paths (07 §3.3, C3).
//
// The classic console used hash sections on `/`; the manager UIs link here
// with `?from=<manager>` plus their own hash. A `#pair=` or `#key=` fragment
// is a credential hand-off (§3.2) and is never redirected.

/** Classic console hashes on `/`. */
export const CONSOLE_HASHES = Object.freeze({
  overview: "/overview",
  models: "/deployments",
  tasks: "/models/downloads",
  playground: "/playground",
  voice: "/voice",
  clients: "/access",
  operations: "/system",
});

/** Manager UI hashes, arriving with `?from=<manager>`; `{mgr}` is the manager id. */
export const MANAGER_HASHES = Object.freeze({
  service: "/deployments?manager={mgr}",
  download: "/models/discover",
  "online-models": "/models/discover",
  models: "/models",
  stats: "/observability",
  "external-access": "/observability/traffic",
  audit: "/audit",
  logs: "/deployments?manager={mgr}&tab=logs",
  exposure: "/access",
  tools: "/system",
});

const MANAGER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const CREDENTIAL_FRAGMENT = /^(pair|key)=/i;

function split(href) {
  let rest = String(href ?? "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  let hash = "";
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) {
    hash = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }
  let search = "";
  const searchAt = rest.indexOf("?");
  if (searchAt >= 0) {
    search = rest.slice(searchAt + 1);
    rest = rest.slice(0, searchAt);
  }
  return { pathname: rest || "/", search, hash };
}

/**
 * The clean path an old bookmark should become, or null when `href` is not
 * a legacy link. `href` may be absolute or a path with query and hash.
 */
export function legacyRedirect(href) {
  const { pathname, search, hash } = split(href);
  if (!hash || CREDENTIAL_FRAGMENT.test(hash)) return null;
  if (pathname !== "/") return null;
  const section = /^[a-z][a-z-]*/.exec(hash.toLowerCase())?.[0] || "";
  if (!section) return null;
  const from = new URLSearchParams(search).get("from");
  if (from && MANAGER_ID.test(from) && Object.hasOwn(MANAGER_HASHES, section)) {
    return MANAGER_HASHES[section].replace("{mgr}", encodeURIComponent(from));
  }
  return Object.hasOwn(CONSOLE_HASHES, section) ? CONSOLE_HASHES[section] : null;
}
