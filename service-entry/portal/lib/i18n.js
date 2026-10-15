// Portal language (05 §12.1): ?lang= first, then localStorage['portal.lang'],
// then navigator.language. The dictionaries are the portal's own
// (i18n/<locale>.json), flat keys with {name} placeholders.

export const LANGS = Object.freeze(["zh-CN", "en-US"]);
export const DEFAULT_LANG = "zh-CN";

/** "zh", "zh-cn", "zh-Hans-CN" -> "zh-CN"; "en", "en-GB" -> "en-US"; anything else null. */
export function normalizeLang(value) {
  const tag = String(value ?? "").trim().toLowerCase();
  if (!tag) return null;
  if (tag === "zh" || tag.startsWith("zh-") || tag.startsWith("zh_")) return "zh-CN";
  if (tag === "en" || tag.startsWith("en-") || tag.startsWith("en_")) return "en-US";
  return null;
}

/** The language for a page load: { search, stored, languages } -> "zh-CN" | "en-US". */
export function detectLang({ search = "", stored = null, languages = [] } = {}) {
  let asked = null;
  try {
    asked = new URLSearchParams(search).get("lang");
  } catch {
    asked = null;
  }
  const fromQuery = normalizeLang(asked);
  if (fromQuery) return fromQuery;
  const fromStore = normalizeLang(stored);
  if (fromStore) return fromStore;
  for (const tag of Array.isArray(languages) ? languages : [languages]) {
    const found = normalizeLang(tag);
    if (found) return found;
  }
  return DEFAULT_LANG;
}

/** t(key, params): {name} placeholders; a missing key falls back, then to the key itself. */
export function createTranslator(dictionary, fallback = {}) {
  function t(key, params) {
    const raw = Object.hasOwn(dictionary, key) ? dictionary[key] : Object.hasOwn(fallback, key) ? fallback[key] : key;
    if (!params) return raw;
    return String(raw).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (Object.hasOwn(params, name) && params[name] !== null && params[name] !== undefined ? String(params[name]) : match));
  }
  t.has = (key) => Object.hasOwn(dictionary, key);
  return t;
}

/** A bilingual value ({ "zh-CN", "en-US" } or a plain string) in the language, falling back to the other. */
export function pickText(value, lang) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const other = lang === "zh-CN" ? "en-US" : "zh-CN";
  const first = value[lang];
  if (typeof first === "string" && first.trim()) return first;
  const second = value[other];
  return typeof second === "string" ? second : "";
}

const dictionaries = new Map();

/** Loads i18n/<lang>.json from the build the page came from (cached). */
export async function loadDictionary(lang, base) {
  if (dictionaries.has(lang)) return dictionaries.get(lang);
  const response = await fetch(new URL(`./i18n/${lang}.json`, base), { credentials: "omit" });
  if (!response.ok) throw new Error(`dictionary ${lang} (${response.status})`);
  const dictionary = await response.json();
  dictionaries.set(lang, dictionary);
  return dictionary;
}
