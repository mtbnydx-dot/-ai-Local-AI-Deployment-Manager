// A tiny History-API router. The server answers the shell for every portal
// path (05 §3.2), so the client matches the same table.

const TABLE = [
  ["home", /^\/$/],
  ["status", /^\/status\/?$/],
  ["models", /^\/models\/?$/],
  ["model", /^\/models\/([^/]+)\/?$/],
  ["docs", /^\/docs\/?$/],
  ["doc", /^\/docs\/([a-z0-9][a-z0-9-]{0,63})\/?$/],
  ["me", /^\/me\/?$/],
  ["playground", /^\/playground\/?$/],
  ["announcements", /^\/announcements\/?$/],
];

// The page module of each route name (pages/<file>.js).
const PAGE_FILES = { home: "status", status: "status", models: "models", model: "model", docs: "docs", doc: "docs", me: "me", playground: "playground", announcements: "announcements" };

/** "/models/a%2Fb" -> { name: "model", params: { id: "a/b" }, page: "model" }; unknown -> name "not-found". */
export function matchRoute(pathname) {
  const path = String(pathname || "/");
  for (const [name, pattern] of TABLE) {
    const match = pattern.exec(path);
    if (!match) continue;
    const params = {};
    try {
      if (name === "model" && match[1]) params.id = decodeURIComponent(match[1]);
      if (name === "doc" && match[1]) params.slug = match[1];
    } catch {
      return { name: "not-found", params: {}, page: null };
    }
    return { name, params, page: PAGE_FILES[name] };
  }
  return { name: "not-found", params: {}, page: null };
}

/** The navigation group a route highlights in the header. */
export function navGroup(name) {
  if (name === "home" || name === "status") return "status";
  if (name === "model" || name === "models") return "models";
  if (name === "doc" || name === "docs") return "docs";
  return name;
}

/** The same-origin path of an <a> click that the router may take over, or null. */
export function internalHref(anchor, origin) {
  if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return null;
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) return null;
  let url;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  // Only the portal pages are the router's; /healthz, the JSON documents, the
  // assets and the API paths are plain navigations the server answers.
  if (matchRoute(url.pathname).name === "not-found") return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
