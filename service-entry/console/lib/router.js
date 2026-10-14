// History-API router (07 §3.3, C3). Pure: history, location and the
// popstate subscription are passed in, so Node tests drive it with fakes.
//
// route = { name, path: "/deployments/:fleetId", load: () => import(...), titleKey, section,
//           ownerOnly, viewerReadable, feature, spec }
// A path segment ":name" captures one segment; a trailing "*" captures the rest.

import { legacyRedirect } from "./legacy-redirects.js";
import { buildQuery } from "./url.js";

export { legacyRedirect };

function segmentsOf(pathname) {
  return String(pathname || "/").split("/").filter(Boolean);
}

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function matchOne(route, parts) {
  const pattern = segmentsOf(route.path);
  const params = {};
  let score = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const piece = pattern[index];
    if (piece === "*") {
      const rest = parts.slice(index).map(decode);
      if (rest.includes(null)) return null;
      params["*"] = rest.join("/");
      return { params, score };
    }
    if (index >= parts.length) return null;
    const value = decode(parts[index]);
    if (value === null) return null;
    if (piece.startsWith(":")) {
      params[piece.slice(1)] = value;
      score += 1;
    } else if (piece === value) {
      score += 2;
    } else {
      return null;
    }
  }
  return parts.length === pattern.length ? { params, score: score + 1 } : null;
}

/**
 * The best route for `pathname`: static segments beat parameters, an exact
 * length beats a trailing "*", and ties go to the earlier route.
 * @returns {{ route, params } | null}
 */
export function matchRoute(routes, pathname) {
  const parts = segmentsOf(String(pathname || "/").split(/[?#]/)[0]);
  let best = null;
  for (const route of Array.isArray(routes) ? routes : []) {
    if (!route || typeof route.path !== "string") continue;
    const found = matchOne(route, parts);
    if (found && (!best || found.score > best.score)) best = { route, params: found.params, score: found.score };
  }
  return best ? { route: best.route, params: best.params } : null;
}

/** The path of route `name` with encoded params (`vllm:primary` → `vllm%3Aprimary`) and a sorted query. */
export function buildHref(routes, name, params = {}, query = null) {
  const route = (Array.isArray(routes) ? routes : []).find((item) => item?.name === name);
  if (!route) throw new Error(`Unknown route: ${name}`);
  const path = segmentsOf(route.path).map((piece) => {
    if (piece === "*") return String(params["*"] ?? "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
    if (!piece.startsWith(":")) return piece;
    const value = params[piece.slice(1)];
    if (value === undefined || value === null || value === "") throw new Error(`Route ${name} needs the parameter ${piece.slice(1)}`);
    return encodeURIComponent(String(value));
  }).filter(Boolean);
  return `/${path.join("/")}${buildQuery(query)}`;
}

/** `title · product`, the document title on navigation. */
export function documentTitle(route, t) {
  const product = t("shell.product");
  return route?.titleKey ? `${t(route.titleKey)} \u00b7 ${product}` : product;
}

function parseLocation(location) {
  const pathname = String(location?.pathname || "/");
  const search = String(location?.search || "");
  return { pathname, search, hash: String(location?.hash || ""), query: Object.fromEntries(new URLSearchParams(search)) };
}

/**
 * @param options.listen (fn) → off, subscribes to popstate; defaults to the window's.
 * @param options.guards initial guards; a guard (next, current) returning false, or a
 *   Promise resolving to false, blocks the navigation (the wizard's unsaved draft).
 * @returns {{ start(), stop(), navigate(to, { replace, state }), current, href(name, params, query), addGuard(fn) → off }}
 */
export function createRouter({ routes = [], history, location, onChange, guards = [], listen } = {}) {
  const guardList = new Set(guards);
  let current = null;
  let off = null;

  function resolve(action) {
    const where = parseLocation(location);
    const match = matchRoute(routes, where.pathname);
    current = { route: match?.route || null, params: match?.params || {}, ...where };
    if (typeof onChange === "function") onChange(current, { action });
    return current;
  }

  async function allowed(to) {
    const next = { to, match: matchRoute(routes, String(to).split(/[?#]/)[0]) };
    for (const guard of [...guardList]) {
      try {
        if ((await guard(next, current)) === false) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async function navigate(to, { replace = false, state = null } = {}) {
    const target = String(to || "/");
    if (!(await allowed(target))) return false;
    if (replace) history.replaceState(state, "", target);
    else history.pushState(state, "", target);
    resolve(replace ? "replace" : "push");
    return true;
  }

  function onPop() {
    resolve("pop");
  }

  return {
    start() {
      const redirect = legacyRedirect(`${location?.pathname || "/"}${location?.search || ""}${location?.hash || ""}`);
      if (redirect) history.replaceState(history.state ?? null, "", redirect);
      const subscribe = typeof listen === "function"
        ? listen
        : (fn) => {
          globalThis.addEventListener?.("popstate", fn);
          return () => globalThis.removeEventListener?.("popstate", fn);
        };
      off = subscribe(onPop);
      return resolve(redirect ? "replace" : "start");
    },
    stop() {
      if (typeof off === "function") off();
      off = null;
    },
    navigate,
    get current() {
      return current;
    },
    href(name, params, query) {
      return buildHref(routes, name, params, query);
    },
    addGuard(fn) {
      guardList.add(fn);
      return () => guardList.delete(fn);
    },
  };
}
