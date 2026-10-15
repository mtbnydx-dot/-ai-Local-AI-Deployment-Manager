// Console entry point (07 §3.2).
//
// boot() runs the steps in order: (1) pairing through `#pair=`, which strips
// the fragment before anything else runs; (2) the bootstrap the server
// embedded and the preferences; (3) the catalog of the locale the server
// chose; (4) the services; (5) legacy-bookmark redirects, done by the router;
// (6) the App, after which `aria-busy` is cleared; (7) the event stream. Step 8
// (first-run routing, CON-25) is not here yet. Nothing touches the DOM or
// the network until boot() runs, so Node can import the module.
//
// The libraries (lib/, ui/) and the route table are this module's static
// imports; the shell (components/app-shell.js with the topbar, sidebar,
// notifications and toasts) is imported while pairing and the catalog load, so
// the static closure stays inside the 07 §11 budget and the shell still
// downloads in parallel with them.

import { createApiClient } from "./lib/api.js";
import { createAuditSession } from "./lib/audit-session.js";
import { runBootPair } from "./lib/boot-pair.js";
import { applyEvent, createEventStream, EVENT_TYPES, VIEWER_EVENT_TYPES } from "./lib/events.js";
import { createFormatters } from "./lib/format.js";
import { createI18n } from "./lib/i18n.js";
import { applyDensity, applyTheme, createPrefsStore, migrateLegacyPrefs, PREFS_KEY, writePref } from "./lib/prefs.js";
import { createRouter } from "./lib/router.js";
import { createStorage } from "./lib/storage.js";
import { createQueryCache, createSignal } from "./lib/store.js";
import { ROUTES } from "./routes.js";
import { createServices } from "./ui/context.js";
import { html, render } from "./ui/html.js";

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

/** The page shown when the console cannot start: the product name and the way back to the classic console. */
export function renderHoldingPage(doc, root, catalog, { failed = true } = {}) {
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

/** Theme, density and language as the server rendered them into <html>, for a browser with no stored preferences. */
export function documentPrefs(doc) {
  const root = doc?.documentElement;
  const theme = root?.getAttribute?.("data-theme");
  const density = root?.getAttribute?.("data-density");
  return {
    theme: theme === "light" || theme === "dark" ? theme : "auto",
    density: density === "compact" ? "compact" : "comfortable",
    locale: pickLocale(doc),
  };
}

// Preferences over storage. A browser that has only the server-set cookie has
// nothing stored yet; its first write stores what the page shows first, so
// changing one preference never resets the others.
function createConsolePrefs(storage, doc) {
  const base = createPrefsStore(storage);
  const fromDocument = (name) => documentPrefs(doc)[name];
  const pristine = () => storage.get(PREFS_KEY) === null;
  return {
    ...base,
    get: (name) => (pristine() && ["theme", "density", "locale"].includes(name) ? fromDocument(name) : base.get(name)),
    set(name, value) {
      if (pristine()) for (const [key, current] of Object.entries(documentPrefs(doc))) writePref(storage, key, current);
      return base.set(name, value);
    },
  };
}

function createVisibility(doc) {
  return {
    hidden: () => Boolean(doc.hidden),
    onChange(fn) {
      doc.addEventListener("visibilitychange", fn);
      return () => doc.removeEventListener("visibilitychange", fn);
    },
  };
}

function scrollMemory(win) {
  const positions = new Map();
  const keyOf = () => `${win.location.pathname}${win.location.search}`;
  try {
    win.history.scrollRestoration = "manual";
  } catch {
    // Without history control the browser restores scroll itself.
  }
  win.addEventListener("scroll", () => positions.set(keyOf(), win.scrollY), { passive: true });
  return {
    arrive(action) {
      if (typeof win.scrollTo !== "function") return;
      if (action === "pop") win.scrollTo(0, positions.get(keyOf()) ?? 0);
      else if (action === "push") win.scrollTo(0, 0);
    },
  };
}

// With no event bus on the entry (features.events false) there is nothing to
// stream: the per-key refetch timers of ui/hooks.js carry the updates.
function timersOnlyEvents() {
  return { on: () => () => undefined, reconnect() {}, close() {}, needsTimers: () => true, state: "offline", lastId: null };
}

function desktopNotification(win, doc, prefs, i18n, entry) {
  if (!prefs.get("notifyBrowser") || !doc.hidden || !win.isSecureContext || typeof win.Notification !== "function" || win.Notification.permission !== "granted") return;
  try {
    const notice = new win.Notification(i18n.pick(entry.title), { body: entry.body ? i18n.pick(entry.body) : undefined });
    notice.onclick = () => win.focus?.();
  } catch {
    // The browser refused; the bell still has it.
  }
}

/** Boot steps 1 to 7. Resolves with the services (for tests) or null when the console could not start. */
export async function boot({ doc, win = globalThis, fetchImpl, base, EventSourceImpl }) {
  const root = doc.getElementById(APP_ELEMENT_ID);
  if (!root) return null;
  const { location, history } = win;

  // Signals the API hooks and the shell share.
  const role = createSignal("viewer");
  const pairing = createSignal(null);
  const stale = createSignal(false);
  const connection = createSignal({ state: "connecting", lastOkAt: null });
  const route = createSignal(null);
  let toasts = null;
  const cache = createQueryCache();
  const embedded = readBootstrap(doc);
  let i18n = createI18n({ locale: pickLocale(doc), catalog: {} });
  let bootstrap = embedded;

  const api = createApiClient({
    fetchImpl,
    csrfToken: embedded?.auth?.csrf,
    onUnpaired() {
      role.set("viewer");
      pairing.set({ reason: "unpaired" });
    },
    onReadOnly() {
      toasts?.push({ level: "info", title: i18n.t("shell.localOnly") });
      api.get("/api/console/bootstrap").then((fresh) => role.set(fresh.role), () => undefined);
    },
    onStale() {
      stale.set(true);
    },
  });

  // 1. Pairing first: the fragment leaves the address bar before anything awaits.
  const pairingRun = runBootPair({
    location,
    history,
    pair: (code) => api.post("/api/session/pair", { code }),
    reloadBootstrap: () => api.get("/api/console/bootstrap"),
  });
  const shellLoading = import("./components/app-shell.js");
  shellLoading.catch(() => undefined);
  const paired = await pairingRun;
  if (paired.status === "paired") {
    if (!paired.bootstrap) {
      location.reload();
      return null;
    }
    bootstrap = paired.bootstrap;
    api.setCsrfToken(paired.csrfToken || bootstrap.auth?.csrf);
  } else if (paired.screen) {
    pairing.set({ reason: paired.screen.reason });
  }

  // 2 and 3. Bootstrap, preferences, catalog.
  const storage = createStorage();
  const locale = pickLocale(doc);
  const catalog = await loadCatalog(fetchImpl, catalogUrl(locale, base));
  if (!bootstrap) {
    renderHoldingPage(doc, root, catalog, { failed: true });
    root.removeAttribute("aria-busy");
    return null;
  }
  let shell;
  try {
    shell = await shellLoading;
  } catch {
    renderHoldingPage(doc, root, catalog, { failed: true });
    root.removeAttribute("aria-busy");
    return null;
  }
  toasts = shell.createToasts();
  migrateLegacyPrefs(storage, new URLSearchParams(location.search));
  const prefs = createConsolePrefs(storage, doc);
  i18n = createI18n({ locale, catalog });
  role.set(bootstrap.role);

  // 4. Services.
  const notifications = shell.createNotificationStore();
  const router = createRouter({
    routes: ROUTES,
    history,
    location,
    onChange(current, { action }) {
      route.set(current);
      if (current.route?.redirect) {
        queueMicrotask(() => router.navigate(`${current.route.redirect}${current.search}${current.hash}`, { replace: true }));
        return;
      }
      scroll.arrive(action);
    },
  });
  const scroll = scrollMemory(win);
  prefs.subscribe((all, name) => {
    if (name === "theme") applyTheme(doc, all.theme);
    else if (name === "density") applyDensity(doc, all.density);
    else if (name === "locale") location.reload();
  });

  async function retryPairing() {
    try {
      const session = await api.get("/api/session");
      if (session?.role !== "owner") return false;
      api.setCsrfToken(session.csrfToken);
      location.reload();
      return true;
    } catch {
      return false;
    }
  }

  let lastOkAt = null;
  const noBus = bootstrap.features?.events === false;
  const stream = role.get() === "none" ? null : noBus ? timersOnlyEvents() : createEventStream({
    types: role.get() === "owner" ? EVENT_TYPES : VIEWER_EVENT_TYPES,
    EventSourceImpl: EventSourceImpl || win.EventSource,
    recent: ({ since, types }) => api.get("/api/events/recent", { query: { since, types } }),
    visibility: createVisibility(doc),
    onState(state) {
      if (state === "open" || state === "polling") lastOkAt = Date.now();
      connection.set({ state, lastOkAt });
    },
  });
  if (stream) {
    stream.on("*", (envelope) => {
      lastOkAt = Date.now();
      applyEvent(cache, envelope);
    });
    stream.on("notification", (envelope) => {
      const entry = notifications.push(envelope.data, envelope.at);
      if (!entry) return;
      if (entry.severity === "warn" || entry.severity === "error") {
        toasts.push({ level: entry.severity, title: i18n.pick(entry.title), body: entry.body ? i18n.pick(entry.body) : "" });
      }
      desktopNotification(win, doc, prefs, i18n, entry);
    });
  }

  const services = createServices({
    api, cache, i18n, router, prefs, role, toasts, notifications, route, connection, pairing, stale, retryPairing, bootstrap,
    events: stream || undefined,
    audit: createAuditSession(),
    formatters: createFormatters(locale),
    visibility: createVisibility(doc),
  });

  // 5 and 6. The router redirects legacy bookmarks while it starts; then the App renders.
  router.start();
  root.replaceChildren();
  render(html`<${shell.ConsoleApp} services=${services} />`, root);
  root.removeAttribute("aria-busy");
  try {
    win.performance?.mark?.("console:first-render");
  } catch {
    // Marks are optional.
  }
  return services;
}

if (typeof document !== "undefined" && typeof globalThis.fetch === "function") {
  boot({ doc: document, fetchImpl: globalThis.fetch.bind(globalThis), base: import.meta.url });
}
