// Portal entry (05 §12.1): the router, the language, the key session and the
// API client's shared state. Pages are lazy modules under pages/; a page that
// a later package has not shipped yet shows a plain "not available" notice.

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { html, render } from "./lib/html.js";
import { PortalContext, usePortal } from "./lib/context.js";
import { DISMISSED_KEY, LANG_KEY, readStorage, writeStorage } from "./lib/storage.js";
import { DEFAULT_LANG, createTranslator, detectLang, loadDictionary, pickText } from "./lib/i18n.js";
import { captureKeyFromLocation, readKey, storeKey } from "./lib/session.js";
import { getAnnouncements, getPortalConfig } from "./lib/api.js";
import { internalHref, matchRoute } from "./lib/router.js";
import { Header } from "./components/header.js";
import { Footer } from "./components/footer.js";
import { AnnouncementBanner } from "./components/announcement-banner.js";
import { ToastRegion } from "./components/toast.js";
import { Loading } from "./components/notice.js";

const BASE = import.meta.url;
const BUILD_ID = (/\/assets\/([^/]+)\//.exec(new URL(BASE).pathname) || [])[1] || "";
const RELOAD_KEY = "portal.reloaded";
const ANNOUNCEMENT_REFRESH_MS = 60_000;
const CONFIG_REFRESH_MS = 5 * 60_000;
const TOAST_MS = 4000;
const DEFAULT_CONFIG = Object.freeze({ baseUrl: "", openaiBase: "", anthropicBase: "", brand: {}, buildId: "", features: {} });

const pageModules = new Map();

// A page module from this build. A 410 or a missing file makes the import
// reject; the caller tells those apart from a page that simply is not there.
function loadPage(name) {
  if (!pageModules.has(name)) pageModules.set(name, import(new URL(`./pages/${name}.js`, BASE).href));
  return pageModules.get(name);
}

// An older build id is no longer served (410): reload once to pick up the new
// shell. The timestamp keeps a persistent mismatch from looping.
function reloadForNewBuild() {
  const last = Number(readStorage("session", RELOAD_KEY)) || 0;
  if (Date.now() - last < 60_000) return false;
  writeStorage("session", RELOAD_KEY, Date.now());
  window.location.reload();
  return true;
}

function readDismissed() {
  try {
    const list = JSON.parse(readStorage("local", DISMISSED_KEY) || "[]");
    return new Set(Array.isArray(list) ? list.filter((id) => typeof id === "string").slice(-200) : []);
  } catch {
    return new Set();
  }
}

function PageHost({ route }) {
  const { t } = usePortal();
  const [state, setState] = useState({ name: null, Page: null, failed: false });
  useEffect(() => {
    let alive = true;
    if (!route.page) {
      setState({ name: null, Page: null, failed: false });
      return undefined;
    }
    loadPage(route.page).then(
      (module) => alive && setState({ name: route.page, Page: module.default, failed: false }),
      () => {
        pageModules.delete(route.page);
        if (!alive) return;
        // A stale build id answers 410 for the file; a reload fixes that. Any
        // other failure leaves the notice below.
        fetch(new URL(`./pages/${route.page}.js`, BASE), { method: "HEAD", credentials: "omit" })
          .then((response) => {
            if (response.status === 410 && reloadForNewBuild()) return;
            if (alive) setState({ name: route.page, Page: null, failed: true });
          })
          .catch(() => alive && setState({ name: route.page, Page: null, failed: true }));
      },
    );
    return () => {
      alive = false;
    };
  }, [route.page]);

  if (route.name === "not-found") {
    return html`<div class="page"><h1>${t("notfound.title")}</h1><p class="lead">${t("notfound.text")}</p><p><a class="btn btn-primary" href="/">${t("notfound.home")}</a></p></div>`;
  }
  if (state.failed && state.name === route.page) {
    return html`<div class="page"><h1>${t("page.unavailable_title")}</h1><p class="lead">${t("page.unavailable_text")}</p><p><a class="btn" href="/">${t("notfound.home")}</a></p></div>`;
  }
  if (!state.Page || state.name !== route.page) return html`<div class="page"><${Loading} /></div>`;
  const Page = state.Page;
  return html`<${Page} route=${route} />`;
}

function App({ initial }) {
  const [path, setPath] = useState(() => window.location.pathname);
  const [lang, setLangState] = useState(initial.lang);
  const [dictionary, setDictionary] = useState(initial.dictionary);
  const [config, setConfig] = useState(initial.config);
  const [key, setKeyState] = useState(initial.key);
  const [announcements, setAnnouncements] = useState([]);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [toasts, setToasts] = useState([]);
  const [titleText, setTitleText] = useState("");

  const t = useMemo(() => createTranslator(dictionary), [dictionary]);
  const route = useMemo(() => matchRoute(path), [path]);

  const navigate = useCallback((target, { replace = false } = {}) => {
    const url = new URL(target, window.location.origin);
    if (url.origin !== window.location.origin) return;
    if (replace) window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    else window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setPath(url.pathname);
    window.scrollTo(0, 0);
  }, []);

  const setLang = useCallback(async (next) => {
    try {
      const nextDictionary = await loadDictionary(next, BASE);
      writeStorage("local", LANG_KEY, next);
      // ?lang= wins over the stored choice, so an explicit pick removes it.
      const url = new URL(window.location.href);
      if (url.searchParams.has("lang")) {
        url.searchParams.delete("lang");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
      setDictionary(nextDictionary);
      setLangState(next);
    } catch {
      // The dictionary did not load; the current language stays.
    }
  }, []);

  const toast = useCallback((message, kind = "ok") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((list) => [...list.slice(-3), { id, message, kind }]);
    setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), TOAST_MS);
  }, []);

  const setKey = useCallback((value) => {
    storeKey(value || "");
    setKeyState(value || "");
  }, []);

  const dismissAnnouncement = useCallback((id) => {
    setDismissed((previous) => {
      const next = new Set(previous);
      next.add(id);
      writeStorage("local", DISMISSED_KEY, JSON.stringify([...next].slice(-200)));
      return next;
    });
  }, []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    const onClick = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      const target = anchor ? internalHref(anchor, window.location.origin) : null;
      if (!target) return;
      event.preventDefault();
      navigate(target);
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, [navigate]);

  // Announcements for the banner on every page.
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      getAnnouncements().then(
        (doc) => alive && setAnnouncements((Array.isArray(doc?.announcements) ? doc.announcements : []).filter((item) => item.active !== false)),
        () => {},
      );
    };
    load();
    const timer = setInterval(load, ANNOUNCEMENT_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // portal-config follows the Host and the build; a new build id means this tab is old.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      getPortalConfig().then((next) => {
        setConfig({ ...DEFAULT_CONFIG, ...next });
        if (BUILD_ID && next?.buildId && next.buildId !== BUILD_ID) reloadForNewBuild();
      }, () => {});
    }, CONFIG_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const brand = pickText(config.brand, lang);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = titleText ? `${titleText} · ${brand || t("brand.fallback")}` : (brand || t("brand.fallback"));
  }, [lang, titleText, brand, t]);

  const context = {
    t, lang, setLang, config, key, setKey, path, navigate, toast, announcements, dismissed, dismissAnnouncement, setTitle: setTitleText,
  };
  return html`<${PortalContext.Provider} value=${context}>
    <a class="skip-link" href="#main">${t("a11y.skip")}</a>
    <${Header} route=${route} />
    <${AnnouncementBanner} />
    <main id="main" class="container main" tabindex="-1">
      <${PageHost} route=${route} />
    </main>
    <${Footer} />
    <${ToastRegion} toasts=${toasts} closeLabel=${t("toast.close")} onDismiss=${(id) => setToasts((list) => list.filter((item) => item.id !== id))} />
  <//>`;
}

async function boot() {
  const root = document.getElementById("app");
  const key = captureKeyFromLocation(window.location, window.history) || readKey();
  const lang = detectLang({
    search: window.location.search,
    stored: readStorage("local", LANG_KEY),
    languages: [...(navigator.languages || []), navigator.language],
  });
  let language = lang;
  let dictionary;
  try {
    dictionary = await loadDictionary(language, BASE);
  } catch {
    // Without a dictionary the keys would show; the default language is the one that always ships.
    language = DEFAULT_LANG;
    dictionary = await loadDictionary(language, BASE).catch(() => ({}));
  }
  const config = await getPortalConfig().then((value) => ({ ...DEFAULT_CONFIG, ...value }), () => ({ ...DEFAULT_CONFIG }));
  root.className = "";
  root.textContent = "";
  render(html`<${App} initial=${{ lang: language, dictionary, config, key }} />`, root);
}

boot();
