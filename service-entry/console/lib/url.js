// URL helpers (07 §10, C11). Pure: the location is always passed in.

const SAFE_PROTOCOLS = new Set(["http:", "https:"]);
// Control characters and whitespace that browsers strip or fold inside URLs.
const UNSAFE_CHARS = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/;

/**
 * A URL that is safe to render as a link: http(s) absolute, same-origin
 * relative (`/x`, `./x`, `x`, `?q`) or a fragment. Anything else, such as
 * `javascript:`, `data:` or a protocol-relative `//host`, returns null.
 */
export function safeUrl(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || UNSAFE_CHARS.test(text) || text.includes("\\")) return null;
  if (text.startsWith("#") || text.startsWith("?")) return text;
  if (text.startsWith("//")) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(text);
  if (scheme) return SAFE_PROTOCOLS.has(`${scheme[1].toLowerCase()}:`) ? text : null;
  return text;
}

/** A same-origin absolute path (`/…`, not `//…` or `/\…`), the only href a notification may carry (§3.6). */
export function isSameOriginPath(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !UNSAFE_CHARS.test(value);
}

/** A same-origin `/api/…` path without dot segments, the only target of a notification apiCall. */
export function isApiPath(value) {
  if (!isSameOriginPath(value) || !value.startsWith("/api/")) return false;
  const pathname = value.split(/[?#]/)[0];
  return !pathname.split("/").some((segment) => segment === ".." || segment === "." || /%2e/i.test(segment) || /%2f|%5c/i.test(segment));
}

/**
 * `?a=1&b=2` from an object; null, undefined and "" values are left out and
 * arrays repeat the key. Keys are sorted so the same query gives the same URL.
 */
export function buildQuery(query) {
  if (!query || typeof query !== "object") return "";
  const params = new URLSearchParams();
  for (const name of Object.keys(query).sort()) {
    const value = query[name];
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (item === undefined || item === null || item === "") continue;
      params.append(name, String(item));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** `path` plus `buildQuery(query)`, joined with & when the path already has a query. */
export function withQuery(path, query) {
  const text = buildQuery(query);
  if (!text) return path;
  return path.includes("?") ? `${path}&${text.slice(1)}` : `${path}${text}`;
}

/**
 * The "Open legacy UI" link of a manager (§3.9): the page's own protocol and
 * hostname with the manager's port, never a hard-coded loopback host.
 */
export function legacyUiHref(location, port) {
  if (!location || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const protocol = location.protocol === "https:" ? "https:" : "http:";
  const hostname = String(location.hostname || "");
  if (!hostname) return null;
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `${protocol}//${host}:${port}/`;
}
