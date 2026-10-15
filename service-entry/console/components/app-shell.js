// AppShell and the root component (07 §4.4, §3.3, §6.15).
//
// AppShell is the frame every page renders in: skip link, one polite live
// region, the sidebar (an off-canvas drawer at md and below), the topbar, the
// connection, update and read-only banners, `<main id="main">`, and the toast
// host. RouteView resolves the current route to a page module and puts it
// inside an ErrorBoundary; ConsoleApp chooses between the pairing screen
// (role "none") and the shell.
//
// A page that is not in the build yet shows the "still being built" page; a
// page that fails to load because the console was redeployed raises the
// update banner instead (§3.3). Links to console paths navigate in place.

import { createI18n } from "../lib/i18n.js";
import { documentTitle, matchRoute } from "../lib/router.js";
import { pairingScreenState } from "../lib/boot-pair.js";
import { NAV_GROUPS } from "../data/nav.js";
import { FORBIDDEN_ROUTE, NOT_FOUND_ROUTE, ROUTES } from "../routes.js";
import { ServicesContext, useServices } from "../ui/context.js";
import { useMediaQuery, usePref, useQuery, useRole, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useRoute, useConnection, useSignal } from "../ui/shell.js";
import { useCallback, useEffect, useRef, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { copyText } from "./code-block.js";
import { ConnectionBanner } from "./connection-banner.js";
import { Modal } from "./dialog.js";
import { EmptyState } from "./empty-state.js";
import { ErrorBoundary } from "./error-boundary.js";
import { Icon } from "./icon.js";
import { PageHeader } from "./page-header.js";
import { PairingScreen } from "./pairing-screen.js";
import { SetupReturnBar } from "./setup-return-bar.js";
import { Sidebar } from "./sidebar.js";
import { Skeleton } from "./skeleton.js";
import { ToastHost } from "./toast.js";
import { Topbar } from "./topbar.js";

const NARROW = "(max-width: 1023px)";

// app.js reaches the toast queue and the notification store through this module,
// so the shell and everything it needs load as one dynamic import.
export { createNotificationStore } from "./notification-center.js";
export { createToasts } from "./toast.js";

/** True for a path the router serves; /classic and /billing/classic belong to the server. */
export function isConsolePath(pathname) {
  if (pathname === "/classic" || pathname.startsWith("/classic/") || pathname === "/billing/classic") return false;
  return Boolean(matchRoute(ROUTES, pathname));
}

/**
 * Decides whether a click on a link is a console navigation: a plain left
 * click on a same-origin link to a console route. Returns the target
 * (path, query, hash) or null to leave the click to the browser.
 */
export function navigationTarget(event, origin) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target?.closest?.("a[href]");
  if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return null;
  const raw = link.getAttribute("href") || "";
  if (raw.startsWith("#")) return null;
  let url;
  try {
    url = new URL(link.href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !isConsolePath(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

function UpdateBanner() {
  const { t } = useT();
  return html`<div class="notice notice-warn" role="status" data-testid="app-shell.update">
    <${Icon} name="info" /><span class="grow">${t("shell.update")}</span>
    <${Button} size="sm" onClick=${() => globalThis.location.reload()} testid="app-shell.reload">${t("shell.updateReload")}<//>
  </div>`;
}

function ReadOnlyBanner({ onHow }) {
  const { t } = useT();
  return html`<div class="notice" data-testid="app-shell.readonly">
    <${Icon} name="lock" /><span class="grow">${t("shell.readonly")}</span>
    ${onHow ? html`<${Button} size="sm" onClick=${onHow} testid="app-shell.readonly-how">${t("shell.pairHow")}<//>` : null}
  </div>`;
}

// The document title and the polite announcement follow every navigation.
function useNavigationAnnouncement(setLive) {
  const route = useRoute();
  const { t } = useT();
  const title = route ? documentTitle(route.route || NOT_FOUND_ROUTE, t) : "";
  useEffect(() => {
    if (!title) return;
    globalThis.document.title = title;
    setLive(title);
  }, [title]);
}

// Focus goes to the page's h1 (or <main>) once its content is on screen (§3.3).
function focusPage() {
  const main = globalThis.document.getElementById("main");
  (main?.querySelector("h1") || main)?.focus?.({ preventScroll: true });
}

function PendingPage({ route }) {
  const { t } = useT();
  return html`<div class="stack" data-testid="app-shell.pending">
    <${PageHeader} title=${t(route.titleKey)} />
    <${EmptyState} icon="info" level=${2} title=${t("shell.pending.title")} body=${t("shell.pending.body")} action=${{ label: t("shell.boot.openClassic"), href: "/classic" }} />
  </div>`;
}

function PairingGate({ reason = "unpaired", onDismiss, standalone = false }) {
  const services = useServices();
  const session = useQuery(["session"], () => services.api.get("/api/session"), { ttlMs: 60000 });
  const state = pairingScreenState({ reason, session: session.data });
  return html`<${PairingScreen} ...${state} onRetry=${services.retryPairing} onDismiss=${onDismiss} standalone=${standalone} />`;
}

async function classifyLoadFailure(services) {
  try {
    const fresh = await services.api.get("/api/console/bootstrap");
    return fresh?.buildId && services.bootstrap?.buildId && fresh.buildId !== services.bootstrap.buildId ? "stale" : "missing";
  } catch {
    return "missing";
  }
}

// Resolves the route on screen: redirect, role gate, then the page module.
function RouteView() {
  const services = useServices();
  const role = useRole();
  const current = useRoute();
  const [view, setView] = useState({ key: null, state: "loading", Component: null });
  const match = current?.route || null;
  const key = `${current?.pathname}|${role}`;
  const local = services.bootstrap?.access?.local !== false;

  useEffect(() => {
    if (!current || match?.redirect) return undefined;
    let alive = true;
    const target = match || NOT_FOUND_ROUTE;
    const denied = Boolean(match?.ownerOnly) && role !== "owner";
    const next = (patch) => alive && setView({ key, ...patch });
    if (denied && local) {
      next({ state: "pair", Component: null });
      return () => {
        alive = false;
      };
    }
    setView((previous) => (previous.key === key ? previous : { key: null, state: "loading", Component: null }));
    (denied ? FORBIDDEN_ROUTE : target).load().then(
      (module) => next({ state: "ready", Component: module.default }),
      async () => {
        const kind = await classifyLoadFailure(services);
        if (kind === "stale") services.stale?.set?.(true);
        next({ state: kind === "stale" ? "stale" : "missing", Component: null });
      },
    );
    return () => {
      alive = false;
    };
  }, [key]);

  const settled = view.key === key && view.state !== "loading";
  const focused = useRef(null);
  useEffect(() => {
    if (!settled || focused.current === key) return;
    focused.current = key;
    focusPage();
  }, [settled, key]);

  if (!current || match?.redirect) return null;
  if (!settled) return html`<div aria-busy="true"><${Skeleton} shape="line" rows=${4} /></div>`;
  if (view.state === "pair") return html`<${PairingGate} />`;
  if (view.state === "missing" || view.state === "stale") return html`<${PendingPage} route=${match || NOT_FOUND_ROUTE} />`;
  const { Component } = view;
  return html`<${ErrorBoundary} key=${key}><${Component} route=${match} params=${current.params} query=${current.query} /><//>`;
}

export { RouteView };

// Builds the palette's commands from live state; the module loads on first use.
async function loadPalette(services, role, instances) {
  const module = await import("./command-palette.js");
  let other = null;
  try {
    const target = services.i18n.locale === "zh-CN" ? "en-US" : "zh-CN";
    const catalog = await services.api.get(`/c/${services.bootstrap.buildId}/i18n/${target}.json`);
    other = createI18n({ locale: target, catalog });
  } catch {
    other = null;
  }
  const { prefs, bootstrap, toasts, i18n } = services;
  const cycle = (name, values) => prefs.set(name, values[(values.indexOf(prefs.get(name)) + 1) % values.length]);
  const actions = {
    toggleTheme: () => cycle("theme", ["auto", "light", "dark"]),
    toggleLocale: () => prefs.set("locale", i18n.locale === "zh-CN" ? "en-US" : "zh-CN"),
    toggleDensity: () => cycle("density", ["comfortable", "compact"]),
    copyGateway: bootstrap?.gateway?.autoOpenAi
      ? async () => {
        const ok = await copyText(`${globalThis.location.origin}${bootstrap.gateway.autoOpenAi}`);
        toasts?.push?.({ level: ok ? "success" : "warn", title: i18n.t(ok ? "shell.palette.copied" : "common.copyFailed") });
      }
      : null,
  };
  return { Palette: module.CommandPalette, commands: module.buildCommands({ role, i18n, other, instances, actions: Object.fromEntries(Object.entries(actions).filter(([, fn]) => fn)) }) };
}

/** The frame around a page. `nav` is data/nav.js NAV_GROUPS; `children` is the page. */
export function AppShell({ nav = NAV_GROUPS, children }) {
  const services = useServices();
  const { t } = useT();
  const role = useRole();
  const route = useRoute();
  const connection = useConnection();
  const stale = useSignal(services.stale, false);
  const pairing = useSignal(services.pairing, null);
  const [sidebar, setSidebar] = usePref("sidebar");
  const narrow = useMediaQuery(NARROW);
  const [navOpen, setNavOpen] = useState(false);
  const [palette, setPaletteState] = useState(null);
  const paletteRef = useRef(null);
  // The ref is current the moment the palette opens or closes, so a quick second Ctrl+K never sees a stale value.
  const setPalette = useCallback((next) => {
    paletteRef.current = next;
    setPaletteState(next);
  }, []);
  const [live, setLive] = useState("");
  const paletteBusy = useRef(false);
  useNavigationAnnouncement(setLive);

  useEffect(() => {
    setNavOpen(false);
  }, [route?.pathname]);
  useEffect(() => {
    if (!narrow) setNavOpen(false);
  }, [narrow]);

  const openPalette = useCallback(async () => {
    if (paletteBusy.current) return;
    paletteBusy.current = true;
    try {
      const fleet = services.cache.get(["fleet"]).data;
      setPalette(await loadPalette(services, role, Array.isArray(fleet?.instances) ? fleet.instances : []));
    } finally {
      paletteBusy.current = false;
    }
  }, [services, role]);

  useEffect(() => {
    const doc = globalThis.document;
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === "k") {
        event.preventDefault();
        if (paletteRef.current) setPalette(null);
        else openPalette();
      }
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [openPalette]);

  function onClick(event) {
    const target = navigationTarget(event, globalThis.location.origin);
    if (!target) return;
    event.preventDefault();
    services.router.navigate(target);
  }

  function runCommand(command) {
    setPalette(null);
    if (command.href) services.router.navigate(command.href);
    else command.run?.();
  }

  const section = route?.route?.section || null;
  const sidebarProps = { groups: nav, role, section };
  const PaletteView = palette?.Palette;
  return html`<div class="app-shell" data-collapsed=${sidebar === "collapsed" ? "true" : "false"} onClick=${onClick} data-testid="app-shell.root">
    <a class="skip-link" href="#main" data-testid="app-shell.skip">${t("shell.skip")}</a>
    <div class="sr-only" role="status" aria-live="polite" data-testid="app-shell.live">${live}</div>
    <div class="app-side hide-md"><${Sidebar} ...${sidebarProps} collapsed=${sidebar === "collapsed"} onToggle=${() => setSidebar(sidebar === "collapsed" ? "expanded" : "collapsed")} /></div>
    <div class="app-col">
      <${Topbar} onOpenNav=${() => setNavOpen(true)} onOpenPalette=${openPalette} />
      <main id="main" class="app-main" tabindex="-1" data-testid="app-shell.main">
        <div class="app-banners">
          <${ConnectionBanner} state=${connection.state} lastOkAt=${connection.lastOkAt} onRetry=${() => services.events?.reconnect?.()} />
          ${stale ? html`<${UpdateBanner} />` : null}
          <${SetupReturnBar} query=${route?.query} />
          ${role === "viewer" ? html`<${ReadOnlyBanner} onHow=${services.bootstrap?.access?.local === false ? null : () => services.pairing?.set?.({ reason: "unpaired" })} />` : null}
        </div>
        ${pairing ? html`<${PairingGate} reason=${pairing.reason} onDismiss=${() => services.pairing.set(null)} />` : children}
      </main>
    </div>
    ${navOpen ? html`<${Modal} class="drawer drawer-nav" labelId="nav-drawer-title" onRequestClose=${() => setNavOpen(false)} initialFocus="a" testid="app-shell.nav-drawer">
      <div class="overlay-head"><h2 id="nav-drawer-title" class="card-title grow">${t("shell.menu")}</h2>
        <${Button} variant="ghost" iconOnly icon="x" label=${t("common.close")} onClick=${() => setNavOpen(false)} testid="app-shell.nav-close" /></div>
      <div class="overlay-body"><${Sidebar} ...${sidebarProps} drawer=${true} /></div>
    <//>` : null}
    ${PaletteView ? html`<${PaletteView} commands=${palette.commands} onRun=${runCommand} onClose=${() => setPalette(null)} />` : null}
    <${ToastHost} />
  </div>`;
}

function Root({ services }) {
  const role = useRole();
  if (role === "none") {
    return html`<${PairingGate} reason=${services.pairing?.get?.()?.reason || "unpaired"} standalone=${true} />`;
  }
  return html`<${AppShell} nav=${NAV_GROUPS}><${RouteView} /><//>`;
}

/** The whole console: services for every hook, then the shell or the pairing screen. */
export function ConsoleApp({ services }) {
  return html`<${ServicesContext.Provider} value=${services}><${Root} services=${services} /><//>`;
}
