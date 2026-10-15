(function (root) {
  // Points the two manager UIs at the unified console (07 §12, CON-26). The
  // banner is dismissible and its link is built from the page's own host, so
  // it works from localhost, a LAN address or a tunnel alike. The entry port
  // comes from the manager's GET /api/config (entryPort, 00 §9.17) and is
  // 5176 when the field is absent or the call fails.

  const DEFAULT_ENTRY_PORT = 5176;
  const DISMISS_KEY = "legacyConsoleBanner.dismissed";
  // Manager hashes the console maps to a page (legacy-redirects.js MANAGER_HASHES).
  const MAPPED_SECTIONS = ["service", "download", "online-models", "models", "stats", "external-access", "audit", "logs", "exposure", "tools"];
  const THEMES = ["auto", "light", "dark"];

  const TEXT = {
    "zh-CN": { message: "新的统一控制台已上线：在那里部署、下载和观测模型。", open: "打开", dismiss: "关闭" },
    "en-US": { message: "The unified console is live: deploy, download and observe models there.", open: "Open", dismiss: "Dismiss" },
  };

  function normalizeLang(value) {
    return /^en/i.test(String(value || "")) ? "en-US" : "zh-CN";
  }

  function normalizePort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_ENTRY_PORT;
  }

  /** The mapped manager section of a location hash, or "" (also for #pair= and #key= hand-offs). */
  function sectionOf(hash) {
    const raw = String(hash || "").replace(/^#/, "").toLowerCase();
    const section = /^[a-z][a-z-]*/.exec(raw)?.[0] || "";
    return MAPPED_SECTIONS.includes(section) ? section : "";
  }

  /**
   * The console URL for a manager page. A mapped hash goes to `/` so the
   * console's legacy redirect lands it on the right page (#stats becomes
   * /observability); `ui=new` keeps that working when the classic console is
   * the entry's default. Without one the link opens /deployments.
   */
  function buildUrl({ protocol, hostname, entryPort, manager, theme, lang, hash }) {
    const host = String(hostname || "127.0.0.1");
    const origin = `${protocol || "http:"}//${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${normalizePort(entryPort)}`;
    const params = new URLSearchParams();
    const section = sectionOf(hash);
    if (section) params.set("ui", "new");
    params.set("from", String(manager || ""));
    params.set("theme", THEMES.includes(theme) ? theme : "auto");
    params.set("lang", normalizeLang(lang));
    return `${origin}${section ? "/" : "/deployments"}?${params.toString()}${section ? `#${section}` : ""}`;
  }

  function readDismissed(storage) {
    try { return storage?.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  }

  function writeDismissed(storage) {
    try { storage?.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
  }

  async function fetchEntryPort(fetchImpl) {
    try {
      const response = await fetchImpl("/api/config", { headers: { accept: "application/json" } });
      if (!response.ok) return DEFAULT_ENTRY_PORT;
      const config = await response.json();
      return normalizePort(config?.entryPort);
    } catch {
      return DEFAULT_ENTRY_PORT;
    }
  }

  /** Shows the banner unless it was dismissed. `manager` is "vllm" or "llama". */
  async function init({ document: doc, location: loc, storage, fetch: fetchImpl, manager } = {}) {
    if (!doc || !loc || !manager || readDismissed(storage)) return null;
    const entryPort = await fetchEntryPort(fetchImpl);
    const lang = normalizeLang(doc.documentElement.lang);
    const text = TEXT[lang];
    const bar = doc.createElement("div");
    bar.id = "legacyConsoleBanner";
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:1000;display:flex;align-items:center;gap:12px;max-width:min(720px,calc(100vw - 32px));padding:10px 14px;border-radius:10px;border:1px solid var(--border,#8884);background:var(--surface,#fff);color:var(--text,#222);box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:14px;line-height:1.4";
    const message = doc.createElement("span");
    message.textContent = text.message;
    const link = doc.createElement("a");
    link.textContent = text.open;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.style.cssText = "font-weight:600;white-space:nowrap";
    // The theme, language and hash can change while the page is open, so the
    // link is rebuilt when it is used.
    const refresh = () => {
      link.href = buildUrl({
        protocol: loc.protocol,
        hostname: loc.hostname,
        entryPort,
        manager,
        theme: doc.documentElement.dataset?.theme,
        lang: doc.documentElement.lang,
        hash: loc.hash,
      });
    };
    refresh();
    for (const type of ["pointerdown", "focus", "keydown"]) link.addEventListener(type, refresh);
    const close = doc.createElement("button");
    close.type = "button";
    close.textContent = "\u00d7";
    close.title = text.dismiss;
    close.setAttribute("aria-label", text.dismiss);
    close.style.cssText = "border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:0 4px";
    close.addEventListener("click", () => {
      writeDismissed(storage);
      bar.remove();
    });
    bar.append(message, link, close);
    doc.body.appendChild(bar);
    return bar;
  }

  const api = { DEFAULT_ENTRY_PORT, DISMISS_KEY, buildUrl, sectionOf, init };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LocalAiLegacyBanner = api;

  const script = root.document?.currentScript;
  const manager = script?.dataset?.manager;
  if (manager && root.document) {
    const start = () => {
      let storage = null;
      try { storage = root.localStorage; } catch { /* blocked */ }
      init({ document: root.document, location: root.location, storage, fetch: root.fetch.bind(root), manager }).catch(() => {});
    };
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis);
