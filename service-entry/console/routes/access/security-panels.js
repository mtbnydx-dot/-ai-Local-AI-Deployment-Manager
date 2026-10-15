// The chart and table panels of the Security page (05 §13.6), loaded on first
// use by security.js so the page's own imports stay small (07 §11): failed
// sign-ins over time with the top addresses and their ban actions, and the
// busiest keys.

import { authSeries } from "../../lib/exposure-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { DataTable } from "../../components/data-table.js";
import { StatusBadge } from "../../components/status-badge.js";
import { TimeSeriesChart } from "../../components/time-series-chart.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useRouter } from "../../ui/shell.js";
import { useMemo } from "../../ui/vendor.js";

function TopIps({ ips, onBan, onUnban }) {
  const { t } = useT();
  const fmt = useFormat();
  const columns = [
    { id: "ip", header: t("security.ips.ip"), sort: (row) => row.ip, cell: (row) => html`<span class="mono" data-user-content>${row.ip}</span>`, csv: (row) => row.ip },
    { id: "country", header: t("security.ips.country"), sort: (row) => row.country, cell: (row) => row.country || "-", csv: (row) => row.country || "" },
    { id: "count", header: t("security.ips.count"), align: "end", sort: (row) => row.count, cell: (row) => fmt.integer(row.count), csv: (row) => row.count },
    { id: "state", header: t("security.ips.state"), cell: (row) => html`<${StatusBadge} status=${row.banned ? "error" : "neutral"} label=${row.banned ? t("security.ips.banned") : t("security.ips.open")} />`, csv: (row) => (row.banned ? "banned" : "") },
    {
      id: "actions",
      header: t("security.ips.actions"),
      csv: false,
      cell: (row) => (row.banned
        ? html`<${Button} size="sm" onClick=${() => onUnban(row.ip)} label=${t("security.unban.label", { subject: row.ip })} testid="security.ips.unban">${t("security.unban.open")}<//>`
        : html`<${Button} size="sm" variant="danger" onClick=${() => onBan(row.ip)} label=${t("security.ban.label", { subject: row.ip })} testid="security.ips.ban">${t("security.ban.open")}<//>`),
    },
  ];
  return html`<${DataTable} id="access-top-ips" columns=${columns} rows=${ips} rowKey=${(row) => row.ip} responsive="cards" caption=${t("security.ips.title")}
    empty=${html`<p class="muted" data-testid="security.ips.empty">${t("security.ips.empty")}</p>`} />`;
}

/** @param failures `overview.authFailures`  @param windowText the chart's time window label  @param onBan(ip)  @param onUnban(ip) */
export function FailuresPanel({ failures, windowText, onBan, onUnban }) {
  const { t } = useT();
  const series = useMemo(() => authSeries(failures?.series), [failures?.series]);
  const ips = Array.isArray(failures?.topIps) ? failures.topIps : [];
  return html`<${Card} title=${t("security.failures.title")} testid="security.failures">
    ${!failures?.available ? html`<p class="notice" role="note" data-testid="security.failures.unavailable">${t("security.failures.unavailable")}</p>` : html`
      <${TimeSeriesChart} series=${[{ id: "failures", label: t("security.failures.series"), unit: "count", values: series.values }]} x=${series.x} height=${180}
        title=${t("security.failures.title")} window=${windowText} />`}
    <h3 class="card-title">${t("security.ips.title")}</h3>
    <${TopIps} ips=${ips} onBan=${onBan} onUnban=${onUnban} />
  <//>`;
}

/** @param keys `overview.topKeys` */
export function KeysPanel({ keys }) {
  const { t } = useT();
  const fmt = useFormat();
  const router = useRouter();
  const columns = [
    { id: "name", header: t("security.keys.name"), sort: (row) => row.name || row.keyId, cell: (row) => html`<a href=${router.href("access.key", { keyId: row.keyId })} data-user-content data-testid="security.keys.link">${row.name || row.keyId}</a>`, csv: (row) => row.name || row.keyId },
    { id: "requests", header: t("security.keys.requests"), align: "end", sort: (row) => row.requests, cell: (row) => fmt.integer(row.requests), csv: (row) => row.requests },
    { id: "tokens", header: t("security.keys.tokens"), align: "end", sort: (row) => row.tokens, cell: (row) => fmt.integer(row.tokens), csv: (row) => row.tokens },
  ];
  return html`<${Card} title=${t("security.keys.title")} testid="security.keys">
    <${DataTable} id="access-top-keys" columns=${columns} rows=${Array.isArray(keys) ? keys : []} rowKey=${(row) => row.keyId} responsive="cards" caption=${t("security.keys.title")}
      empty=${html`<p class="muted" data-testid="security.keys.empty">${t("security.keys.empty")}</p>`} />
  <//>`;
}
