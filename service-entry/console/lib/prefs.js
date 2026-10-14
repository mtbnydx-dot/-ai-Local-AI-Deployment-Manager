// Preferences and theming (07 §3.8, C6).
//
// Stored as JSON in localStorage "console.prefs.v1" through lib/storage.js
// and mirrored, for theme, locale and density only, into the console_prefs
// cookie the server reads to inject lang, data-theme and data-density
// (service-entry/lib/console-routes.js parsePrefsCookie). Unknown or invalid
// values fall back to the defaults.

export const PREFS_KEY = "console.prefs.v1";
export const PREFS_COOKIE = "console_prefs";
const COOKIE_ATTRIBUTES = "Path=/; SameSite=Strict; Max-Age=31536000";
const COOKIE_FIELDS = ["theme", "locale", "density"];
const LEGACY_THEME_KEY = "billingThemeMode";
const MIGRATED_KEY = "console.prefs.migrated";

export const PREFS = Object.freeze({
  theme: ["auto", "light", "dark"],
  locale: ["auto", "zh-CN", "en-US"],
  density: ["comfortable", "compact"],
  sidebar: ["expanded", "collapsed"],
  notifyBrowser: [false, true],
  tableColumns: "object",
  dismissedSetup: [false, true],
  notificationsReadAt: "iso",
});

export const DEFAULT_PREFS = Object.freeze({
  theme: "auto",
  locale: "auto",
  density: "comfortable",
  sidebar: "expanded",
  notifyBrowser: false,
  tableColumns: Object.freeze({}),
  dismissedSetup: false,
  notificationsReadAt: null,
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// tableColumns: { tableId: [columnId…] }, ids are short plain strings.
function validTableColumns(value) {
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([table, columns]) => /^[\w.:-]{1,80}$/.test(table)
    && Array.isArray(columns) && columns.length <= 64 && columns.every((column) => typeof column === "string" && /^[\w.:-]{1,80}$/.test(column)));
}

/** True when `value` is allowed for preference `name`. */
export function isValidPref(name, value) {
  const rule = PREFS[name];
  if (rule === undefined) return false;
  if (Array.isArray(rule)) return rule.includes(value);
  if (rule === "object") return validTableColumns(value);
  if (rule === "iso") return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
  return false;
}

/** The stored preferences, every field validated; anything unknown or invalid is the default. */
export function readPrefs(storage) {
  let stored = {};
  try {
    const raw = storage?.get?.(PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    stored = isPlainObject(parsed) ? parsed : {};
  } catch {
    stored = {};
  }
  const prefs = {};
  for (const name of Object.keys(PREFS)) {
    prefs[name] = Object.hasOwn(stored, name) && isValidPref(name, stored[name]) ? stored[name] : DEFAULT_PREFS[name];
  }
  return prefs;
}

/** `theme:dark|locale:en-US|density:compact`, the cookie value the server parses. */
export function prefsCookieValue(prefs) {
  return COOKIE_FIELDS.map((name) => `${name}:${isValidPref(name, prefs?.[name]) ? prefs[name] : DEFAULT_PREFS[name]}`).join("|");
}

/**
 * Validates and stores one preference, then refreshes the cookie.
 * @returns the new preferences, or null when the value is not allowed
 */
export function writePref(storage, name, value) {
  if (!isValidPref(name, value)) return null;
  const prefs = { ...readPrefs(storage), [name]: value };
  storage?.set?.(PREFS_KEY, JSON.stringify(prefs));
  storage?.writeCookie?.(PREFS_COOKIE, prefsCookieValue(prefs), COOKIE_ATTRIBUTES);
  return prefs;
}

/**
 * The live preferences for ui/hooks.js usePref: { get(name), all(), set(name, value) → boolean, subscribe(fn) → off }.
 */
export function createPrefsStore(storage) {
  let prefs = readPrefs(storage);
  const listeners = new Set();
  return {
    get: (name) => prefs[name],
    all: () => ({ ...prefs }),
    set(name, value) {
      const next = writePref(storage, name, value);
      if (!next) return false;
      prefs = next;
      for (const fn of [...listeners]) {
        try {
          fn(prefs, name);
        } catch {
          // One broken listener must not starve the others.
        }
      }
      return true;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const LEGACY_LANG = { "zh-cn": "zh-CN", zh: "zh-CN", "en-us": "en-US", en: "en-US" };

/**
 * Runs once per browser: the classic billing page's theme (billingThemeMode)
 * becomes `theme`, and `?theme=` / `?lang=` from a legacy banner link win
 * over it. `query` is a URLSearchParams or a plain object.
 * @returns the preferences after migration
 */
export function migrateLegacyPrefs(storage, query) {
  const get = (name) => (typeof query?.get === "function" ? query.get(name) : query?.[name]) ?? null;
  const fromQueryTheme = get("theme");
  const fromQueryLang = LEGACY_LANG[String(get("lang") || "").toLowerCase()] || null;
  let prefs = readPrefs(storage);
  if (storage?.get?.(MIGRATED_KEY) !== "1") {
    const legacyTheme = storage?.get?.(LEGACY_THEME_KEY);
    if (isValidPref("theme", legacyTheme) && prefs.theme === DEFAULT_PREFS.theme) prefs = writePref(storage, "theme", legacyTheme) || prefs;
    storage?.set?.(MIGRATED_KEY, "1");
  }
  if (isValidPref("theme", fromQueryTheme)) prefs = writePref(storage, "theme", fromQueryTheme) || prefs;
  if (fromQueryLang) prefs = writePref(storage, "locale", fromQueryLang) || prefs;
  return prefs;
}

/** Sets html[data-theme] for light or dark and removes it for auto, so the OS setting applies. */
export function applyTheme(doc, pref) {
  const root = doc?.documentElement;
  if (!root) return;
  if (pref === "light" || pref === "dark") root.setAttribute("data-theme", pref);
  else root.removeAttribute("data-theme");
}

/** Sets html[data-density]. */
export function applyDensity(doc, pref) {
  const root = doc?.documentElement;
  if (!root) return;
  root.setAttribute("data-density", isValidPref("density", pref) ? pref : DEFAULT_PREFS.density);
}
