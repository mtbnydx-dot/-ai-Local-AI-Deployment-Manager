// Loading, error and empty states shared by the pages.

import { html } from "../lib/html.js";
import { usePortal } from "../lib/context.js";

/** The translated text of an ApiError (by code), else the generic one. */
export function errorMessage(t, error) {
  const code = error?.code;
  if (code && t.has(`error.${code}`)) return t(`error.${code}`);
  if (error?.status >= 500 && t.has("error.server")) return t("error.server");
  return t("error.generic");
}

export function Loading({ label }) {
  const { t } = usePortal();
  return html`<p class="notice notice-loading" role="status">${label || t("common.loading")}</p>`;
}

/** ErrorNotice({ error, onRetry }): the reason in plain words, the request id to quote, a retry button. */
export function ErrorNotice({ error, onRetry }) {
  const { t } = usePortal();
  return html`<div class="notice notice-error" role="alert">
    <p>${errorMessage(t, error)}</p>
    ${error?.requestId ? html`<p class="muted small">${t("common.request_id")} <code>${error.requestId}</code></p>` : null}
    ${onRetry ? html`<button type="button" class="btn" onClick=${onRetry}>${t("common.retry")}</button>` : null}
  </div>`;
}

export function EmptyState({ title, children }) {
  return html`<div class="notice notice-empty">
    <p class="notice-title">${title}</p>
    ${children}
  </div>`;
}
