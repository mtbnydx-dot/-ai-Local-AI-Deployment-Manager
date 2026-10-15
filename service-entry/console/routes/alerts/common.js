// What the Alerts tabs share: the loading and error frame of a query, the
// severity badge, the unit and metric labels, toast helpers and relative times.

import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { localizedTitle } from "../../lib/observability-model.js";
import { Button } from "../../components/button.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { SEVERITY_BADGE } from "../../lib/alerts-model.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

export function Load({ query, rows = 4, children }) {
  const i18n = useT();
  if (query.data === undefined && query.error) {
    return html`<div class="notice notice-warn" role="alert" data-testid="alerts.error"><span class="grow">${describeError(query.error, i18n)}</span>
      <${Button} size="sm" onClick=${() => query.refetch()} testid="alerts.retry">${i18n.t("obs.retry")}<//></div>`;
  }
  if (query.data === undefined) return html`<${Skeleton} shape="table" rows=${rows} testid="alerts.loading" />`;
  return children(query.data);
}

export function SeverityBadge({ severity }) {
  const { t, has } = useT();
  const key = tk("obs.severity.", severity);
  return html`<${StatusBadge} status=${SEVERITY_BADGE[severity] || "unknown"} label=${has(key) ? t(key) : String(severity)} />`;
}

export function unitLabel(i18n, unit) {
  const key = tk("obs.alert.unit.", unit);
  return unit && i18n.has(key) ? i18n.t(key) : "";
}

export function metricLabel(metrics, id, locale) {
  const found = metrics.find((item) => item.id === id);
  return found ? localizedTitle(found.label, locale) : id;
}

export function useNotify() {
  const { toasts, i18n } = useServices();
  return (level, title, error) => toasts?.push?.({ level, title: title || describeError(error, i18n), requestId: error?.requestId || undefined });
}

export function Time({ value }) {
  const fmt = useFormat();
  return value ? html`<time dateTime=${value} title=${fmt.dateTime(value)}>${fmt.relative(value)}</time>` : "—";
}

export function ruleTitle(rule, locale) {
  return localizedTitle({ zh: rule.titleZh, en: rule.titleEn }, locale);
}
