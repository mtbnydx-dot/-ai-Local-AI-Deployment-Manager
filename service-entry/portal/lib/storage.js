// Web storage that never throws: a private window, blocked site data or a
// preview can make the accessor itself throw, and every page must still work.

function area(kind) {
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export function readStorage(kind, key) {
  try {
    return area(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(kind, key, value) {
  try {
    const target = area(kind);
    if (!target) return false;
    if (value === null || value === undefined) target.removeItem(key);
    else target.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

export const SESSION_KEY = "portal.key";
export const LANG_KEY = "portal.lang";
export const DISMISSED_KEY = "portal.dismissed";
