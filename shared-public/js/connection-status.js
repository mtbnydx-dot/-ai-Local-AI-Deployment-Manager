(function () {
  // Every polled refresh used to end in `.catch(() => {})`, so when a manager
  // died the console kept showing whatever it had last seen with no sign the
  // numbers had stopped moving. For an ops console that is the worst failure
  // mode: you cannot tell "this is the current state" from "this is ten minutes
  // stale". This tracks poll outcomes and says so.

  const DEFAULT_FAILURE_THRESHOLD = 2;
  const DEFAULT_STALE_AFTER_MS = 20000;

  const defaultEscape = (value) => window.LocalAiDomUtils.escapeHtml(value);

  function formatClock(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return "";
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
  }

  function formatAgo(ms, english) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return english ? `${seconds}s ago` : `${seconds} 秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return english ? `${minutes}m ago` : `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    return english ? `${hours}h ago` : `${hours} 小时前`;
  }

  function create(options = {}) {
    const escapeHtml = typeof options.escapeHtml === "function" ? options.escapeHtml : defaultEscape;
    const getElement = typeof options.getElement === "function" ? options.getElement : (selector) => document.querySelector(selector);
    const isEnglish = typeof options.isEnglish === "function" ? options.isEnglish : () => false;
    const renderIcons = typeof options.renderIcons === "function" ? options.renderIcons : () => {};
    const failureThreshold = Math.max(1, Number(options.failureThreshold || DEFAULT_FAILURE_THRESHOLD));
    const staleAfterMs = Math.max(1000, Number(options.staleAfterMs || DEFAULT_STALE_AFTER_MS));
    const bannerSelector = options.bannerSelector || "#connectionBanner";
    const freshnessSelector = options.freshnessSelector || "#dataFreshness";
    // Resolved per render: the two managers use different i18n systems, so the
    // host supplies already-localised copy rather than a key. The title is
    // supplied whole instead of spliced from a name, which never punctuates
    // correctly across both languages.
    const resolveLabel = typeof options.label === "function"
      ? options.label
      : () => options.label || "管理器";
    const resolveTitle = typeof options.title === "function"
      ? options.title
      : () => options.title || "";

    const state = {
      consecutiveFailures: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      lastError: "",
      offline: false,
      // Set once the first poll resolves, so a still-loading console does not
      // immediately claim to be disconnected.
      started: false,
    };

    let tickTimer = null;

    // Wraps a polled refresh. Returns a promise that never rejects, matching the
    // `.catch(() => {})` call sites it replaces.
    function track(promise) {
      return Promise.resolve(promise).then(
        (value) => { markSuccess(); return value; },
        (error) => { markFailure(error); return undefined; },
      );
    }

    function markSuccess() {
      const wasOffline = state.offline;
      state.started = true;
      state.consecutiveFailures = 0;
      state.lastSuccessAt = Date.now();
      state.lastError = "";
      state.offline = false;
      render();
      if (wasOffline && typeof options.onReconnect === "function") options.onReconnect();
    }

    function markFailure(error) {
      state.started = true;
      state.consecutiveFailures += 1;
      state.lastFailureAt = Date.now();
      state.lastError = String(error?.message || error || "");
      // One dropped poll is usually a restart or a slow request; only sustained
      // failure is worth interrupting the user for. The exception is a console
      // that has never loaded anything -- there is no stale data to look at, so
      // say so immediately rather than showing an empty page.
      const nowOffline = !state.lastSuccessAt || state.consecutiveFailures >= failureThreshold;
      const changed = nowOffline !== state.offline;
      state.offline = nowOffline;
      render();
      if (changed && nowOffline && typeof options.onDisconnect === "function") options.onDisconnect(state.lastError);
    }

    // True when the last successful poll is old enough that displayed values
    // should not be read as current.
    function isStale(now = Date.now()) {
      if (!state.started || !state.lastSuccessAt) return false;
      return now - state.lastSuccessAt > staleAfterMs;
    }

    function snapshot() {
      return {
        ...state,
        stale: isStale(),
        lastSuccessAt: state.lastSuccessAt,
      };
    }

    // Short suffix for per-view headers: empty while live, "· 数据停留在 hh:mm"
    // once the data is known to be old.
    function freshnessLabel(now = Date.now()) {
      if (!state.lastSuccessAt || !isStale(now)) return "";
      const english = isEnglish();
      const clock = formatClock(state.lastSuccessAt);
      return english
        ? `data from ${clock} (${formatAgo(now - state.lastSuccessAt, true)})`
        : `数据停留在 ${clock}（${formatAgo(now - state.lastSuccessAt, false)}）`;
    }

    function render() {
      renderFreshness();
      renderBanner();
    }

    // Always-visible marker in the topbar. Stays empty while the data is fresh,
    // so it only draws attention when what is on screen is no longer current.
    function renderFreshness() {
      const node = getElement(freshnessSelector);
      if (!node) return;
      const text = freshnessLabel();
      node.textContent = text;
      node.title = text;
    }

    function renderBanner() {
      const root = getElement(bannerSelector);
      if (!root) return;
      if (!state.offline) {
        root.classList.add("hidden");
        root.innerHTML = "";
        return;
      }
      const english = isEnglish();
      const label = resolveLabel(english);
      const clock = formatClock(state.lastSuccessAt);
      const ago = state.lastSuccessAt ? formatAgo(Date.now() - state.lastSuccessAt, english) : "";
      const title = resolveTitle(english)
        || (english ? `Lost connection to the ${label}` : `与 ${label} 的连接已中断`);
      const detail = state.lastSuccessAt
        ? english
          ? `Everything below is from ${clock} (${ago}) and is no longer updating.`
          : `下方所有数据停留在 ${clock}（${ago}），已停止更新。`
        : english
          ? "No data has been received yet."
          : "尚未成功获取过数据。";
      const hint = english
        ? "Retrying automatically. Check that the manager process and Docker are still running."
        : "正在自动重试。请检查管理器进程和 Docker 是否仍在运行。";

      root.innerHTML = `
        <div class="connection-banner-icon" aria-hidden="true"><i data-lucide="plug-zap"></i></div>
        <div class="connection-banner-body">
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(detail)}</span>
          <small>${escapeHtml(hint)}${state.lastError ? ` · ${escapeHtml(state.lastError)}` : ""}</small>
        </div>
        <div class="connection-banner-meta">${escapeHtml(english ? `${state.consecutiveFailures} failed checks` : `连续 ${state.consecutiveFailures} 次失败`)}</div>
      `;
      root.classList.remove("hidden");
      renderIcons();
    }

    // The "n minutes ago" text has to keep counting up on its own: while
    // disconnected no poll will come back to re-render it, and after the tab has
    // been hidden for a while the data is stale even though nothing failed.
    function startTicking() {
      if (tickTimer) return;
      tickTimer = window.setInterval(() => {
        if (!document.hidden) render();
      }, 10000);
    }

    function stopTicking() {
      if (!tickTimer) return;
      window.clearInterval(tickTimer);
      tickTimer = null;
    }

    function mount() {
      render();
      startTicking();
      // Coming back to a hidden tab should re-evaluate freshness right away
      // instead of waiting out the tick.
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) render();
      });
    }

    return { track, markSuccess, markFailure, snapshot, isStale, freshnessLabel, render, mount, stopTicking };
  }

  window.ConnectionStatus = { create, formatClock, formatAgo };
})();
