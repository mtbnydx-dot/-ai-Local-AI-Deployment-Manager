// The only module that touches localStorage, sessionStorage or
// document.cookie (07 §3.1 rule 3). Every access is wrapped in try/catch:
// private windows, blocked site data and sandboxed frames throw, and the
// console must still render with defaults. Nothing secret is ever written
// here (07 §10): keys, tokens and pair codes live in closures only.

function resolve(source) {
  try {
    return typeof source === "function" ? source() : source;
  } catch {
    return null;
  }
}

/**
 * @param options.local a Storage, or a function returning one (default: window.localStorage, read lazily)
 * @param options.session the same for sessionStorage
 * @param options.doc the document whose cookie is used (default: the global document, read lazily)
 * @returns {{ get, set, remove, sessionGet, sessionSet, sessionRemove, readCookie, writeCookie }}
 */
export function createStorage({ local, session, doc } = {}) {
  const localStore = () => resolve(local === undefined ? () => globalThis.localStorage : local);
  const sessionStore = () => resolve(session === undefined ? () => globalThis.sessionStorage : session);
  const cookieDoc = () => resolve(doc === undefined ? () => globalThis.document : doc);

  function read(store, name) {
    try {
      const value = store()?.getItem(name);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  function write(store, name, value) {
    try {
      const target = store();
      if (!target) return false;
      target.setItem(name, String(value));
      return true;
    } catch {
      return false;
    }
  }

  function drop(store, name) {
    try {
      store()?.removeItem(name);
      return true;
    } catch {
      return false;
    }
  }

  function readCookie(name) {
    try {
      const text = String(cookieDoc()?.cookie || "");
      for (const part of text.split(";")) {
        const at = part.indexOf("=");
        if (at < 0 || part.slice(0, at).trim() !== name) continue;
        const value = part.slice(at + 1).trim();
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }
    } catch {
      // Unreadable cookies read as absent.
    }
    return null;
  }

  /** `attributes` is appended as given, e.g. "Path=/; SameSite=Strict; Max-Age=31536000". */
  function writeCookie(name, value, attributes = "Path=/; SameSite=Strict") {
    try {
      const target = cookieDoc();
      if (!target) return false;
      target.cookie = `${name}=${value}${attributes ? `; ${attributes}` : ""}`;
      return true;
    } catch {
      return false;
    }
  }

  return {
    get: (name) => read(localStore, name),
    set: (name, value) => write(localStore, name, value),
    remove: (name) => drop(localStore, name),
    sessionGet: (name) => read(sessionStore, name),
    sessionSet: (name, value) => write(sessionStore, name, value),
    sessionRemove: (name) => drop(sessionStore, name),
    readCookie,
    writeCookie,
  };
}
