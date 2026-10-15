// What every Audit page shares (07 §6.8): the header with its sub-navigation
// and the lock state, the unlock form, the audit-aware API calls and the
// loaders that keep conversation text in component state only.
//
// Two factors guard the content routes (04 §16.5): the owner session, then
// the audit unlock. The unlock is either 05's HttpOnly cookie (the console
// holds only `expiresAt`, lib/audit-session.js) or, on the degrade path, a
// token kept in a closure and sent as `x-audit-session`. Transcripts are never
// put into the query cache, so locking, a lost unlock or leaving the page
// drops them with the component.

import { describeError } from "../../lib/api.js";
import { AUDIT_PAGES, auditPath, isLockedError, patchChatSearch } from "../../lib/audit-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useAuditSession } from "../../ui/audit.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";
import { useCallback, useEffect, useRef, useState } from "../../ui/vendor.js";

// ---------------------------------------------------------------------------
// Calls

/**
 * GET/POST helpers for /api/audit/*. They send the audit headers (empty in
 * cookie mode) and treat "the unlock is gone" as a lock: the session is
 * cleared, so the page falls back to the unlock form.
 */
export function useAuditApi() {
  const { api } = useServices();
  const session = useAuditSession();
  const guard = useCallback(async (run) => {
    try {
      return await run();
    } catch (error) {
      if (isLockedError(error)) session.lock();
      throw error;
    }
  }, [session]);
  return {
    session,
    get: (rest, query, options = {}) => guard(() => api.get(auditPath(rest), { query, headers: session.headers(), ...options })),
    post: (rest, body, options = {}) => guard(() => api.post(auditPath(rest), body, { headers: session.headers(), ...options })),
    put: (rest, body, options = {}) => guard(() => api.put(auditPath(rest), body, { headers: session.headers(), ...options })),
  };
}

// ---------------------------------------------------------------------------
// Loaders

/**
 * Runs `load()` while `enabled` and whenever `deps` change; `reload()` runs it
 * again. The answer lives in this component's state only.
 * @returns {{ data, error, loading, reload }}
 */
export function useAuditLoad(load, deps, { enabled = true } = {}) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [state, setState] = useState({ data: undefined, error: null, loading: enabled });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setState({ data: undefined, error: null, loading: false });
      return undefined;
    }
    let alive = true;
    setState((previous) => ({ data: previous.data, error: null, loading: true }));
    Promise.resolve().then(() => loadRef.current()).then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState({ data: undefined, error, loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [...deps, enabled, nonce]);
  return { ...state, reload: () => setNonce((value) => value + 1) };
}

/**
 * A cursor list: `fetchPage(cursor)` answers `{ rows, cursor, meta? }`. The
 * first page loads when `id` changes; `loadMore()` appends the next one.
 * @returns {{ rows, cursor, meta, loading, loadingMore, error, moreError, loadMore, reload }}
 */
export function useAuditPages(id, fetchPage, { enabled = true } = {}) {
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const [state, setState] = useState({ id, rows: [], cursor: null, meta: null, loading: enabled, loadingMore: false, error: null, moreError: null });
  const [nonce, setNonce] = useState(0);
  const idRef = useRef(id);
  idRef.current = id;
  useEffect(() => {
    if (!enabled) {
      setState({ id, rows: [], cursor: null, meta: null, loading: false, loadingMore: false, error: null, moreError: null });
      return undefined;
    }
    let alive = true;
    setState((previous) => ({ ...previous, id, loading: true, error: null, moreError: null }));
    Promise.resolve().then(() => fetchRef.current(null)).then(
      (page) => alive && setState({ id, rows: page.rows, cursor: page.cursor, meta: page.meta ?? null, loading: false, loadingMore: false, error: null, moreError: null }),
      (error) => alive && setState({ id, rows: [], cursor: null, meta: null, loading: false, loadingMore: false, error, moreError: null }),
    );
    return () => {
      alive = false;
    };
  }, [id, enabled, nonce]);
  async function loadMore() {
    if (!state.cursor || state.loadingMore) return;
    const startedFor = id;
    setState((previous) => ({ ...previous, loadingMore: true, moreError: null }));
    try {
      const page = await fetchRef.current(state.cursor);
      setState((previous) => (idRef.current !== startedFor ? previous : { ...previous, rows: [...previous.rows, ...page.rows], cursor: page.cursor, loadingMore: false }));
    } catch (error) {
      setState((previous) => ({ ...previous, loadingMore: false, moreError: error }));
    }
  }
  return { ...state, loadMore, reload: () => setNonce((value) => value + 1) };
}

/** The page's URL search, with `patch(changes, { replace })` to set or remove (null) parameters. */
export function useUrlSearch() {
  const services = useServices();
  const read = () => {
    try {
      return globalThis.location?.search ?? "";
    } catch {
      return "";
    }
  };
  const [search, setSearch] = useState(read);
  const latest = useRef(search);
  latest.current = search;
  useEffect(() => {
    const onPop = () => setSearch(read());
    globalThis.addEventListener?.("popstate", onPop);
    return () => globalThis.removeEventListener?.("popstate", onPop);
  }, []);
  const patch = useCallback((changes, { replace = true } = {}) => {
    const next = patchChatSearch(latest.current, changes);
    latest.current = next;
    setSearch(next);
    try {
      const location = globalThis.location;
      const target = `${location.pathname}${next}${location.hash}`;
      if (services.router?.navigate) services.router.navigate(target, { replace });
      else if (replace) globalThis.history.replaceState(globalThis.history.state, "", target);
      else globalThis.history.pushState(globalThis.history.state, "", target);
    } catch {
      // Without a history (tests, previews) the state stays in memory.
    }
  }, [services]);
  return [search, patch];
}

// ---------------------------------------------------------------------------
// Frame

/** The state line and the Lock button. */
function LockStatus() {
  const { api, toasts, cache } = useServices();
  const session = useAuditSession();
  const { t } = useT();
  const fmt = useFormat();
  const [busy, setBusy] = useState(false);
  const unlocked = session.active();
  async function lock() {
    setBusy(true);
    try {
      // The headers are read before the lock clears them (degrade mode).
      await api.post(auditPath("logout"), {}, { headers: session.headers() });
    } catch {
      // The unlock ends locally either way; the server drops it at expiry.
    } finally {
      session.lock();
      cache?.invalidate?.(["telemetry", "request"]);
      toasts?.push?.({ level: "info", title: t("audit.locked") });
      setBusy(false);
    }
  }
  return html`<div class="row audit-lock" data-testid="audit.lock-state" data-state=${unlocked ? "unlocked" : "locked"} data-mode=${session.mode()}>
    <span class="chip chip-neutral"><span>${unlocked ? t("audit.unlockedUntil", { time: fmt.time(session.expiresAt()) }) : t("audit.lockedState")}</span></span>
    ${unlocked ? html`<${Button} size="sm" icon="lock" busy=${busy} onClick=${lock} testid="audit.lock">${t("audit.lock")}<//>` : null}
  </div>`;
}

export function AuditHeader({ id }) {
  const { t } = useT();
  const page = t(tk("audit.nav.", id));
  return html`<div class="stack-sm obs-header" data-testid="audit.header">
    <${PageHeader} title=${t("audit.title")} subtitle=${page} breadcrumbs=${[{ label: t("shell.nav.audit"), href: "/audit" }, { label: page }]}
      actions=${html`<${LockStatus} />`} />
    <nav aria-label=${t("audit.subnav")} data-testid="audit.subnav">
      <ul class="obs-subnav">
        ${AUDIT_PAGES.map((item) => html`<li key=${item.id}><a class="obs-subnav-link" href=${item.path} aria-current=${item.id === id ? "page" : undefined} data-testid=${`audit.nav.${item.id}`}>
          ${t(tk("audit.nav.", item.id))}${item.locked ? html` <span class="sr-only">(${t("audit.needsUnlock")})</span>` : null}
        </a></li>`)}
      </ul>
    </nav>
  </div>`;
}

/** The error of a failed audit call, in words: its catalog entry, else the shared error text. */
export function useAuditErrorText() {
  const i18n = useT();
  return (error) => {
    const key = tk("audit.err.", String(error?.code || ""));
    return i18n.has(key) ? i18n.t(key) : describeError(error, i18n);
  };
}

/** The failure of a load, with Retry. */
export function LoadError({ error, onRetry, testid }) {
  const { t } = useT();
  const text = useAuditErrorText();
  return html`<div class="notice notice-warn" role="alert" data-testid=${testid || "audit.error"}>
    <span class="grow">${text(error)}</span>
    ${onRetry ? html`<${Button} size="sm" onClick=${onRetry} testid="audit.retry">${t("obs.retry")}<//>` : null}
  </div>`;
}

export function Loading({ rows = 3 }) {
  return html`<div aria-busy="true" data-testid="audit.loading"><${Skeleton} shape="line" rows=${rows} /></div>`;
}

// ---------------------------------------------------------------------------
// Unlock

/** The password form (POST /api/audit/login). The password lives in this form only and is cleared after the answer. */
export function UnlockCard({ reason }) {
  const { api, cache } = useServices();
  const session = useAuditSession();
  const i18n = useT();
  const { t } = i18n;
  const errorText = useAuditErrorText();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(event) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await api.post(auditPath("login"), { password });
      if (!session.unlock(answer)) throw Object.assign(new Error("unlock failed"), { code: "audit_unlock_failed" });
      cache?.invalidate?.(["telemetry", "request"]);
    } catch (failure) {
      setError(failure);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return html`<${Card} title=${t("audit.unlockTitle")} testid="audit.unlock-card">
    <form class="stack-sm audit-unlock" onSubmit=${submit} data-testid="audit.unlock-form" noValidate>
      <p>${t("audit.unlock")}</p>
      ${reason === "expired" ? html`<p class="notice notice-info" role="status">${t("audit.expired")}</p>` : null}
      <div class="field">
        <label class="field-label" for="audit-password">${t("audit.password")}</label>
        <input class="input" id="audit-password" type="password" name="audit-password" autocomplete="off" spellcheck="false" maxlength="1024" data-1p-ignore="true" data-lpignore="true"
          value=${password} aria-invalid=${error ? "true" : undefined} aria-describedby=${error ? "audit-password-error" : undefined}
          data-testid="audit.password" onInput=${(event) => setPassword(event.currentTarget.value)} />
        ${error ? html`<div class="field-error" id="audit-password-error" role="alert" data-testid="audit.unlock-error">${errorText(error)}</div>` : null}
      </div>
      <div class="row">
        <${Button} type="submit" variant="primary" icon="lock" busy=${busy} disabled=${!password} testid="audit.unlock-submit">${t("audit.unlockButton")}<//>
      </div>
      <p class="small muted">${t("audit.unlockNote")}</p>
    </form>
  <//>`;
}

/**
 * The frame of an Audit page: header, then the unlock form when the page's
 * content needs the audit unlock and there is none, else `children()`.
 * Without the audit service (`features.audit`) the page says so.
 */
export function AuditPage({ id, needsUnlock = false, children, testid }) {
  const { t } = useT();
  const features = useBootstrap().features || {};
  const session = useAuditSession();
  const unlocked = session.active();
  return html`<div class="stack audit-page" data-page=${id} data-testid=${testid || `audit.${id}.root`}>
    <${AuditHeader} id=${id} />
    ${!features.audit
      ? html`<${EmptyState} icon="file-search" title=${t("audit.unavailable")} body=${t("audit.unavailableBody")} action=${{ label: t("audit.unavailableAction"), href: "/system" }} testid="audit.unavailable" />`
      : needsUnlock && !unlocked ? html`<${UnlockCard} />` : children()}
  </div>`;
}
