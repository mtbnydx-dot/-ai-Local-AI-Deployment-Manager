// Console entry point (07 §3.2).
//
// CON-2 delivers the serving layer: the shell, the snapshot under
// /c/<buildId>/ and the merged catalogs. Until the core libraries (CON-4) and
// the AppShell (CON-6) land, this module runs boot steps 2, 3 and 6 only: it
// reads the bootstrap the server embedded, loads the catalog of the locale
// the server chose and renders a holding page that links to the classic
// console. Nothing touches the DOM or the network until boot() runs, so Node
// can import the module.

const BOOTSTRAP_ELEMENT_ID = "console-bootstrap";
const APP_ELEMENT_ID = "app";
const LOCALES = Object.freeze(["zh-CN", "en-US"]);
const DEFAULT_LOCALE = "zh-CN";
const CLASSIC_HREF = "/classic";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The §2.5 bootstrap from the shell's JSON data block, or null. */
export function readBootstrap(doc) {
  const node = doc?.getElementById?.(BOOTSTRAP_ELEMENT_ID);
  if (!node) return null;
  try {
    const value = JSON.parse(node.textContent || "");
    return isPlainObject(value) && value.ok === true ? value : null;
  } catch {
    return null;
  }
}

/** The locale the server injected into <html lang>, which follows the console_prefs cookie. */
export function pickLocale(doc) {
  const lang = doc?.documentElement?.lang;
  return LOCALES.includes(lang) ? lang : DEFAULT_LOCALE;
}

/** The snapshot's merged catalog, served next to this module (/c/<buildId>/i18n/<locale>.json). */
export function catalogUrl(locale, base) {
  return new URL(`./i18n/${LOCALES.includes(locale) ? locale : DEFAULT_LOCALE}.json`, base).href;
}

/** The catalog, or an empty one when it cannot be read; the page then shows key names. */
export async function loadCatalog(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!response.ok) return {};
    const body = await response.json();
    return isPlainObject(body) ? body : {};
  } catch {
    return {};
  }
}

/** A catalog string, or the key itself when the catalog lacks it (07 §2.6). */
export function text(catalog, key) {
  const value = isPlainObject(catalog) ? catalog[key] : undefined;
  return typeof value === "string" && value ? value : key;
}

function paragraph(doc, value) {
  const node = doc.createElement("p");
  node.textContent = value;
  return node;
}

/** The holding page: product name, what is ready, and the way back to the classic console. */
export function renderHoldingPage(doc, root, catalog, { failed = false } = {}) {
  const main = doc.createElement("main");
  main.className = "console-holding";
  const heading = doc.createElement("h1");
  heading.textContent = text(catalog, "shell.product");
  const link = doc.createElement("a");
  link.href = CLASSIC_HREF;
  link.textContent = text(catalog, "shell.boot.openClassic");
  const action = doc.createElement("p");
  action.append(link);
  main.append(heading, paragraph(doc, text(catalog, failed ? "shell.boot.failed" : "shell.boot.preview")), action);
  root.replaceChildren(main);
  doc.title = text(catalog, "shell.product");
}

export async function boot({ doc, fetchImpl, base }) {
  const root = doc.getElementById(APP_ELEMENT_ID);
  if (!root) return;
  const bootstrap = readBootstrap(doc);
  const catalog = await loadCatalog(fetchImpl, catalogUrl(pickLocale(doc), base));
  renderHoldingPage(doc, root, catalog, { failed: !bootstrap });
  root.removeAttribute("aria-busy");
}

if (typeof document !== "undefined" && typeof globalThis.fetch === "function") {
  boot({ doc: document, fetchImpl: globalThis.fetch.bind(globalThis), base: import.meta.url });
}
