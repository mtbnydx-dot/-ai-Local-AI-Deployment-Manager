// Catalog lookup, plurals and backend {zh,en} text (07 §3.7, C5).
//
// The catalog is the snapshot's merge of every area for one locale: flat
// dotted keys whose values are strings with {var} placeholders or plural
// objects {one?, other} resolved through Intl.PluralRules. A missing key
// renders as the key itself, so a gap is visible instead of blank.

export const LOCALES = Object.freeze(["zh-CN", "en-US"]);
export const DEFAULT_LOCALE = "zh-CN";

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SHORT_LOCALE = { "zh-CN": "zh", "en-US": "en" };

/** `pref` when it names a locale, else the first navigator language (zh* → zh-CN, other → en-US), else zh-CN. */
export function resolveLocale({ pref, navigatorLanguages } = {}) {
  if (LOCALES.includes(pref)) return pref;
  const languages = Array.isArray(navigatorLanguages) ? navigatorLanguages : [];
  const first = languages.find((item) => typeof item === "string" && item.trim());
  if (!first) return DEFAULT_LOCALE;
  return first.trim().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

/**
 * A computed key: `tk("status.", state)` → `status.ready`. Every literal
 * prefix passed to tk must be listed in some area's dynamic-keys.json
 * (checked by test/console/i18n.test.js).
 */
export function tk(prefix, ...parts) {
  return `${prefix}${parts.map((part) => String(part ?? "")).join(".")}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The placeholder names of a catalog value (all plural forms together). */
export function placeholdersOf(value) {
  const names = new Set();
  const forms = typeof value === "string" ? [value] : isPlainObject(value) ? Object.values(value) : [];
  for (const form of forms) {
    if (typeof form !== "string") continue;
    for (const match of form.matchAll(PLACEHOLDER)) names.add(match[1]);
  }
  return names;
}

/**
 * @returns {{ locale, t(key, vars), has(key), pick(textObj), pickInfo(textObj), tk }}
 */
export function createI18n({ locale = DEFAULT_LOCALE, catalog = {}, fallbackCatalog = null, onFallback = null } = {}) {
  const active = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const own = isPlainObject(catalog) ? catalog : {};
  const fallback = isPlainObject(fallbackCatalog) ? fallbackCatalog : {};
  const plurals = new Intl.PluralRules(active);
  const numbers = new Intl.NumberFormat(active);
  const warned = new Set();

  function warn(what) {
    if (typeof onFallback !== "function" || warned.has(what)) return;
    warned.add(what);
    try {
      onFallback(what);
    } catch {
      // A dev warning must never break rendering.
    }
  }

  function lookup(key) {
    if (Object.hasOwn(own, key)) return own[key];
    if (Object.hasOwn(fallback, key)) {
      warn(key);
      return fallback[key];
    }
    return undefined;
  }

  function interpolate(template, vars) {
    return template.replace(PLACEHOLDER, (match, name) => {
      if (!vars || !Object.hasOwn(vars, name) || vars[name] === undefined || vars[name] === null) return match;
      const value = vars[name];
      return typeof value === "number" ? numbers.format(value) : String(value);
    });
  }

  function t(key, vars) {
    const value = lookup(key);
    if (typeof value === "string") return interpolate(value, vars);
    if (isPlainObject(value)) {
      const count = Number(vars?.count);
      const form = Number.isFinite(count) ? value[plurals.select(count)] ?? value.other : value.other;
      return typeof form === "string" ? interpolate(form, vars) : key;
    }
    return key;
  }

  function has(key) {
    return lookup(key) !== undefined;
  }

  /** Backend text `{zh, en}` or `{"zh-CN", "en-US"}`; `fallback` is true when the other locale had to be used. */
  function pickInfo(textObj) {
    if (typeof textObj === "string") return { text: textObj, fallback: false };
    if (!isPlainObject(textObj)) return { text: "", fallback: false };
    const short = SHORT_LOCALE[active];
    const mine = textObj[active] ?? textObj[short];
    if (typeof mine === "string" && mine) return { text: mine, fallback: false };
    for (const other of LOCALES) {
      if (other === active) continue;
      const value = textObj[other] ?? textObj[SHORT_LOCALE[other]];
      if (typeof value === "string" && value) {
        warn(`pick:${active}`);
        return { text: value, fallback: true };
      }
    }
    return { text: "", fallback: false };
  }

  return {
    locale: active,
    t,
    has,
    pick: (textObj) => pickInfo(textObj).text,
    pickInfo,
    tk,
  };
}
