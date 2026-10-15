// /access/security (07 §6.10, 05 §13.6): "Security & audit". Anomalies, auth
// failures over time, the top addresses with their ban state and ban actions,
// the active bans, the busiest keys, recent security events, the legacy
// findings of the exposure scan (copy only) and the admin audit trail. The
// numbers come from GET /api/security/overview over a time range kept in the
// URL; every ban or unban asks for confirmation first and is audited by 05.
// The panels load on first use (security-panels.js, security-bans.js,
// security-extra.js) so this module stays small (07 §11).

import { anomalyVars, severityBadge } from "../../lib/exposure-model.js";
import { tk } from "../../lib/i18n.js";
import { resolveTimeRange, timeRangeQuery } from "../../lib/time-range.js";
import { Card } from "../../components/card.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { StatusBadge } from "../../components/status-badge.js";
import { TimeRangePicker, useRangeLabel, useTimeRangeParam } from "../../components/time-range-picker.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useRouter } from "../../ui/shell.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { LazyView } from "./lazy.js";

function Anomalies({ items }) {
  const { t, has } = useT();
  const fmt = useFormat();
  const router = useRouter();
  return html`<${Card} title=${t("security.anomalies.title")} testid="security.anomalies">
    ${items.length ? html`<ul class="stack-sm">${items.map((item, index) => {
      const known = has(tk("security.rule.", item.rule));
      return html`<li key=${`${item.rule}-${item.keyId || index}`} class="check-row" data-rule=${item.rule} data-testid="security.anomaly">
        <div class="row">
          <${StatusBadge} status=${severityBadge(item.severity)} label=${t(tk("security.severity.", item.severity === "critical" ? "critical" : "warning"))} />
          <strong class="grow">${known ? t(tk("security.rule.", item.rule)) : item.rule}</strong>
          ${item.keyId ? html`<a href=${router.href("access.key", { keyId: item.keyId })} data-testid="security.anomaly.key">${t("security.anomalies.openKey")}</a>` : null}
        </div>
        ${known ? html`<p class="small muted">${t(tk("security.rule.", item.rule, "detail"), anomalyVars(item, fmt))}</p>` : null}
      </li>`;
    })}</ul>` : html`<p class="notice notice-success" role="status" data-testid="security.anomalies.none">${t("security.anomalies.none")}</p>`}
  <//>`;
}

export default function Security() {
  const { api } = useServices();
  const { t } = useT();
  const rangeLabel = useRangeLabel();
  const [value, setValue] = useTimeRangeParam({ fallback: "24h" });
  const span = useMemo(() => resolveTimeRange(value, Date.now()), [timeRangeQuery(value)]);
  const bounds = { from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString() };
  const [dialog, setDialog] = useState(null);

  const overview = useQuery(["access", "security", "overview", timeRangeQuery(value)], () => api.get("/api/security/overview", { query: bounds }), { ttlMs: 15_000, keepPrevious: false });
  const bans = useQuery(["access", "security", "bans"], () => api.get("/api/security/bans"), { ttlMs: 10_000 });
  const exposure = useQuery(["access", "exposure"], () => api.get("/api/public/exposure"), { ttlMs: 60_000 });

  const data = overview.data;
  const banFor = (subject) => (Array.isArray(bans.data?.items) ? bans.data.items : []).find((item) => item.subject === subject);
  const ban = (ip) => setDialog({ kind: "ban", ip });
  const unban = (ip) => setDialog({ kind: "unban", ban: banFor(ip) || { subject: ip } });

  return html`<div class="stack" data-testid="security.root">
    <${PageHeader} title=${t("security.title")} subtitle=${t("security.subtitle")}
      breadcrumbs=${[{ label: t("shell.nav.access"), href: "/access" }, { label: t("security.title") }]} />
    <${TimeRangePicker} value=${value} onChange=${setValue} maxRangeDays=${90} />
    ${overview.status === "error" && !data
      ? html`<${EmptyState} icon="triangle-alert" title=${t("security.failed")} body=${overview.error?.message || ""} action=${{ label: t("access.retry"), onClick: overview.refetch }} />`
      : html`
        <${Anomalies} items=${Array.isArray(data?.anomalies) ? data.anomalies : []} />
        ${data ? html`<${LazyView} load=${() => import("./security-panels.js")} name="FailuresPanel" failures=${data.authFailures} windowText=${rangeLabel(value)} onBan=${ban} onUnban=${unban} />` : null}
        <${LazyView} load=${() => import("./security-bans.js")} name="BansCard" query=${bans} onAdd=${() => ban("")} onUnban=${(row) => setDialog({ kind: "unban", ban: row })} />
        ${data ? html`<${LazyView} load=${() => import("./security-panels.js")} name="KeysPanel" keys=${data.topKeys} />` : null}`}
    <${LazyView} load=${() => import("./security-extra.js")} name="EventsCard" />
    <${LazyView} load=${() => import("./security-extra.js")} name="LegacyCard" findings=${exposure.data?.report?.legacy} state=${exposure.status === "error" && !exposure.data ? "unavailable" : "ok"} />
    <${Card} title=${t("security.audit.title")} testid="security.audit">
      <p class="muted small">${t("security.audit.hint")}</p>
      <${LazyView} load=${() => import("./keys-extra.js")} name="AuditTab" />
    <//>
    ${dialog?.kind === "ban" ? html`<${LazyView} load=${() => import("./security-bans.js")} name="BanDialog" initial=${{ subject: dialog.ip, kind: "ip" }} onClose=${() => setDialog(null)} />` : null}
    ${dialog?.kind === "unban" ? html`<${LazyView} load=${() => import("./security-bans.js")} name="UnbanDialog" ban=${dialog.ban} onClose=${() => setDialog(null)} />` : null}
  </div>`;
}
