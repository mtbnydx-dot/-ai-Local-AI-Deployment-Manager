// Step 7 of the Public access wizard (05 §13.5): go live. It sets
// `public.managersGatewayOnly: enforce` (managers refuse calls that skipped the
// entry) and `admin.legacyProxyGateway: reject` (ADMIN refuses gateway calls
// that came through a proxy). Before it does, it lists who still does that,
// from the last seven days of `security.direct_manager_gateway` and
// `security.admin_via_proxy` events, because their URLs stop working.

import { DIRECT_CALLER_DAYS, fetchSecurityEvents, goLivePatches, groupCallers, isLive } from "../../lib/exposure-model.js";
import { Button } from "../../components/button.js";
import { CodeBlock } from "../../components/code-block.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { accessError } from "./errors.js";

function CallersTables({ callers }) {
  const { t } = useT();
  const fmt = useFormat();
  if (!callers.total) return html`<p class="notice notice-success" role="status" data-testid="public.live.none">${t("public.live.none", { days: DIRECT_CALLER_DAYS })}</p>`;
  return html`<div class="stack" data-testid="public.live.callers">
    <p class="notice notice-warn" role="status" data-testid="public.live.warn">${t("public.live.warn", { count: callers.total, days: DIRECT_CALLER_DAYS })}</p>
    ${callers.direct.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label=${t("public.live.directCaption")}><table class="table" data-testid="public.live.direct">
      <caption class="sr-only">${t("public.live.directCaption")}</caption>
      <thead><tr><th scope="col">${t("public.live.address")}</th><th scope="col">${t("public.live.kind")}</th><th scope="col">${t("public.live.path")}</th><th scope="col">${t("public.live.calls")}</th><th scope="col">${t("public.live.last")}</th></tr></thead>
      <tbody>${callers.direct.map((row) => html`<tr key=${row.id} data-testid="public.live.direct-row">
        <td class="mono" data-user-content>${row.address || "-"}</td><td data-user-content>${row.kind || "-"}</td><td class="mono small" data-user-content>${row.path || "-"}</td>
        <td class="num">${fmt.integer(row.count)}</td><td>${fmt.dateTime(row.lastAt, { style: "short" })}</td>
      </tr>`)}</tbody>
    </table></div>` : null}
    ${callers.viaProxy.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label=${t("public.live.proxyCaption")}><table class="table" data-testid="public.live.proxy">
      <caption class="sr-only">${t("public.live.proxyCaption")}</caption>
      <thead><tr><th scope="col">${t("public.live.path")}</th><th scope="col">${t("public.live.headers")}</th><th scope="col">${t("public.live.calls")}</th><th scope="col">${t("public.live.last")}</th></tr></thead>
      <tbody>${callers.viaProxy.map((row) => html`<tr key=${row.id} data-testid="public.live.proxy-row">
        <td class="mono small" data-user-content>${row.pathClass || "-"}</td><td class="mono small" data-user-content>${row.headers.join(", ") || "-"}</td>
        <td class="num">${fmt.integer(row.count)}</td><td>${fmt.dateTime(row.lastAt, { style: "short" })}</td>
      </tr>`)}</tbody>
    </table></div>` : null}
  </div>`;
}

export function GoLiveStep({ settings }) {
  const { api, cache, i18n } = useServices();
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(null);
  const [failure, setFailure] = useState(null);
  const callers = useQuery(["access", "security", "callers"], async () => {
    const get = (path, options) => api.get(path, options);
    const [direct, viaProxy] = await Promise.all([fetchSecurityEvents(get, "direct_manager_gateway"), fetchSecurityEvents(get, "admin_via_proxy")]);
    return groupCallers({ direct, viaProxy });
  }, { ttlMs: 30_000 });
  const live = isLive(settings);
  const known = Boolean(callers.data);

  async function enforce() {
    setFailure(null);
    let etag = settings.etag;
    const restart = new Set();
    try {
      for (const body of goLivePatches()) {
        const answer = await api.patch("/api/public/settings", body, { headers: { "if-match": etag } });
        etag = answer?.etag || etag;
        for (const id of Array.isArray(answer?.restartRequired) ? answer.restartRequired : []) restart.add(String(id));
      }
      setDone({ restart: [...restart] });
    } catch (error) {
      setFailure(accessError(error, i18n));
      throw error;
    } finally {
      cache.invalidate(["access", "settings"]);
    }
  }

  return html`<div class="stack" data-testid="public.live">
    <p>${t("public.intro.golive")}</p>
    <p class="small" data-testid="public.live.current">${t("public.live.current", { managers: settings.gatewayOnly, admin: settings.legacyGateway })}</p>
    <section class="stack-sm" aria-labelledby="public-live-callers">
      <h3 id="public-live-callers" class="card-title">${t("public.live.callers", { days: DIRECT_CALLER_DAYS })}</h3>
      ${callers.status === "error" && !callers.data
        ? html`<p class="notice notice-danger" role="alert" data-testid="public.live.failed">${t("public.live.failed")} <${Button} size="sm" onClick=${callers.refetch}>${t("access.retry")}<//></p>`
        : known ? html`<${CallersTables} callers=${callers.data} />` : html`<p class="muted" aria-busy="true">${t("public.live.loading")}</p>`}
    </section>
    ${live || done ? html`<div class="stack-sm" data-testid="public.live.done">
      <p class="notice notice-success" role="status">${t("public.live.done")}${done?.restart?.length ? ` ${t("public.restart", { list: done.restart.join(", ") })}` : ""}</p>
      <p class="small muted">${t("public.live.revert")}</p>
      <${CodeBlock} code=${"platform config set public.managersGatewayOnly warn\nplatform config set admin.legacyProxyGateway serve"} language="powershell" />
    </div>` : html`<div class="row">
      <${Button} variant="danger" disabled=${callers.status === "loading" && !known} onClick=${() => setConfirming(true)} testid="public.live.enforce">${t("public.live.enforce")}<//>
    </div>`}
    ${failure ? html`<p class="notice notice-danger" role="alert" data-testid="public.live.error">${failure}</p>` : null}
    ${confirming ? html`<${ConfirmDialog} open tone="danger" title=${t("public.live.confirmTitle")} body=${t("public.live.confirmBody")}
      details=${[t("public.live.confirmDirect", { count: callers.data?.direct?.length ?? 0 }), t("public.live.confirmProxy", { count: callers.data?.viaProxy?.length ?? 0 })]}
      confirmLabel=${t("public.live.enforce")} testid="public.live.confirm" onConfirm=${enforce} onClose=${() => setConfirming(false)} />` : null}
  </div>`;
}
