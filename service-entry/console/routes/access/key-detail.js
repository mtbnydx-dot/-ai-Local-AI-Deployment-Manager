// /access/keys/:keyId (07 §6.10, 05 §13.4): one key's settings, its limits
// (edited in the same drawer as creation), the usage counters of today and
// this month, and, from telemetry, a usage chart and the recent requests. The
// charts load on demand (key-usage.js); revoke, rotate and the one-time
// ShareCard are the same as on the list.

import { displayStatus, LIMIT_FIELDS, STATUS_TONE } from "../../lib/access-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatTile } from "../../components/stat-tile.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useMutation, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useFeature } from "../../ui/shell.js";
import { useState } from "../../ui/vendor.js";
import { RevokeDialog, RotateDialog } from "./key-dialogs.js";
import { LazyView } from "./lazy.js";

function Chips({ items, empty }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return html`<span class="muted">${empty}</span>`;
  return html`<span class="row">${list.map((item) => html`<code key=${item} class="code-inline" data-user-content>${item}</code>`)}</span>`;
}

function Usage({ usage, record }) {
  const { t } = useT();
  const fmt = useFormat();
  const tiles = (counters, resetsAt, scope, windowKey, tokenCap) => {
    const tokens = (counters?.inputTokens || 0) + (counters?.outputTokens || 0);
    return html`
      <${StatTile} label=${t("access.usage.requests")} value=${fmt.integer(counters?.requests || 0)} window=${t(windowKey)} testid=${`key-detail.usage.${scope}.requests`} />
      <${StatTile} label=${t("access.usage.tokens")} value=${fmt.integer(tokens)} window=${t(windowKey)}
        denominator=${tokenCap ? { value: fmt.integer(tokenCap), label: t("access.usage.cap") } : undefined} testid=${`key-detail.usage.${scope}.tokens`} />
      <${StatTile} label=${t("access.usage.errors")} value=${fmt.integer(counters?.errors || 0)} window=${t(windowKey)} testid=${`key-detail.usage.${scope}.errors`} />
      <div class="muted small kd-reset">${resetsAt ? t("access.usage.resets", { time: fmt.dateTime(resetsAt, { style: "short" }) }) : ""}</div>`;
  };
  return html`<div class="stack" data-testid="key-detail.usage">
    <h3 class="card-title">${t("access.usage.today")}</h3>
    <div class="grid-auto">${tiles(usage?.day, usage?.dayResetsAt, "day", "access.usage.windowDay", record?.limits?.dailyTokens)}</div>
    <h3 class="card-title">${t("access.usage.month")}</h3>
    <div class="grid-auto">${tiles(usage?.month, usage?.monthResetsAt, "month", "access.usage.windowMonth", record?.limits?.monthlyTokens)}</div>
  </div>`;
}

export default function KeyDetail({ params }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const telemetry = useFeature("telemetry");
  const keyId = params.keyId;
  const detail = useQuery(["access", "key", keyId], () => api.get(`/api/access/keys/${encodeURIComponent(keyId)}`), { ttlMs: 5000 });
  const [editing, setEditing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [share, setShare] = useState(null);
  const toggle = useMutation((status) => api.patch(`/api/access/keys/${encodeURIComponent(keyId)}`, { status }), { invalidates: [["access"]], toast: { error: true } });

  const record = detail.data?.key;
  const crumbs = [{ label: t("shell.nav.access"), href: "/access" }, { label: t("access.keys.title"), href: "/access/keys" }, { label: record?.name || keyId }];

  if (detail.error && !record) {
    const missing = detail.error.code === "key_not_found";
    return html`<div class="stack" data-testid="key-detail.root">
      <${PageHeader} title=${t(missing ? "access.detail.missing" : "access.detail.failed")} breadcrumbs=${crumbs} />
      <${EmptyState} icon=${missing ? "key-round" : "triangle-alert"} title=${t(missing ? "access.detail.missing" : "access.detail.failed")} body=${missing ? t("access.detail.missingBody") : detail.error.message}
        action=${missing ? { label: t("access.detail.back"), href: "/access/keys" } : { label: t("access.retry"), onClick: detail.refetch }} />
    </div>`;
  }
  if (!record) return html`<div class="stack" aria-busy="true" data-testid="key-detail.root"><${PageHeader} title=${t("access.detail.loading")} breadcrumbs=${crumbs} /><${Skeleton} shape="tile" rows=${3} /></div>`;

  const status = displayStatus(record);
  const live = record.status !== "revoked";
  const limitText = (field) => {
    const value = record.limits?.[field.id];
    return value === null || value === undefined ? t(field.blank === "unlimited" ? "access.limit.unlimited" : "access.limit.inherit") : `${fmt.integer(value)} ${t(field.unit)}`;
  };

  return html`<div class="stack" data-testid="key-detail.root">
    <${PageHeader} title=${record.name} subtitle=${record.preview || ""} breadcrumbs=${crumbs}
      meta=${html`<${StatusBadge} status=${STATUS_TONE[status] || "neutral"} label=${t(tk("access.status.", status))} /><span class="chip chip-neutral">${t(tk("access.class.", record.class))}</span>`}
      actions=${live ? html`
        <${Button} variant="primary" onClick=${() => setEditing(true)} testid="key-detail.edit">${t("access.detail.edit")}<//>
        <${Button} onClick=${() => toggle.run(record.status === "disabled" ? "active" : "disabled")} busy=${toggle.status === "pending"} testid="key-detail.toggle">${t(record.status === "disabled" ? "access.detail.enable" : "access.detail.disable")}<//>
        <${Button} onClick=${() => setRotating(true)} testid="key-detail.rotate">${t("access.table.rotate")}<//>
        <${Button} variant="danger" onClick=${() => setRevoking(true)} testid="key-detail.revoke">${t("access.table.revoke")}<//>` : null} />

    <${Card} title=${t("access.detail.settings")} testid="key-detail.settings">
      <dl class="kv">
        <dt>${t("access.field.holder.label")}</dt><dd data-user-content>${record.holder || "—"}</dd>
        <dt>${t("access.field.customerId.label")}</dt><dd class="mono" data-user-content>${record.customerId || "—"}</dd>
        <dt>${t("access.table.lastUsed")}</dt><dd>${record.lastUsedAt ? `${fmt.relative(record.lastUsedAt)}${record.lastUsedCountry ? ` · ${record.lastUsedCountry}` : ""}` : t("access.table.neverUsed")}</dd>
        <dt>${t("access.table.expires")}</dt><dd>${record.expiresAt ? fmt.dateTime(record.expiresAt, { style: "date" }) : t("access.expiry.never")}</dd>
        <dt>${t("access.detail.created")}</dt><dd>${fmt.dateTime(record.createdAt, { style: "short" })} <span class="muted small" data-user-content>${record.createdBy || ""}</span></dd>
        <dt>${t("access.field.listeners.label")}</dt><dd><${Chips} items=${(record.listeners || []).map((item) => t(tk("access.listener.", item)))} empty="—" /></dd>
        <dt>${t("access.field.scopes.label")}</dt><dd><${Chips} items=${record.scopes} empty="—" /></dd>
        <dt>${t("access.field.models.label")}</dt><dd><${Chips} items=${record.models} empty=${t("access.models.none")} /></dd>
        <dt>${t("access.field.allowedOrigins.label")}</dt><dd><${Chips} items=${record.allowedOrigins} empty=${t("access.detail.none")} /></dd>
        <dt>${t("access.field.allowedIps.label")}</dt><dd><${Chips} items=${record.allowedIps} empty=${t("access.detail.none")} /></dd>
        ${record.notes ? html`<dt>${t("access.field.notes.label")}</dt><dd data-user-content>${record.notes}</dd>` : null}
      </dl>
    <//>

    <${Card} title=${t("access.detail.limits")} testid="key-detail.limits" actions=${live ? html`<${Button} size="sm" onClick=${() => setEditing(true)} testid="key-detail.edit-limits">${t("access.detail.editLimits")}<//>` : null}>
      <dl class="kv">
        ${LIMIT_FIELDS.map((field) => html`<dt key=${`${field.id}-t`}>${t(field.label)}</dt><dd key=${`${field.id}-d`} data-testid=${`key-detail.limit.${field.id}`}>${limitText(field)}</dd>`)}
      </dl>
    <//>

    <${Card} title=${t("access.detail.usage")} testid="key-detail.usage-card"><${Usage} usage=${detail.data.usage} record=${record} /><//>

    ${telemetry
      ? html`<${LazyView} load=${() => import("./key-usage.js")} name="KeyUsage" keyId=${keyId} />`
      : html`<${Card} title=${t("access.detail.history")}><${EmptyState} icon="activity" title=${t("access.detail.noTelemetry")} body=${t("access.detail.noTelemetryBody")} action=${{ label: t("access.detail.openObservability"), href: "/observability" }} /><//>`}

    ${editing ? html`<${LazyView} load=${() => import("./key-drawer.js")} name="KeyDrawer" mode="edit" keyRecord=${record} onClose=${() => setEditing(false)} onSaved=${() => setEditing(false)} />` : null}
    ${revoking ? html`<${RevokeDialog} keyRecord=${record} onClose=${() => setRevoking(false)} />` : null}
    ${rotating ? html`<${RotateDialog} keyRecord=${record} onClose=${() => setRotating(false)} onRotated=${(result) => setShare(result)} />` : null}
    ${share ? html`<${LazyView} load=${() => import("../../components/share-card.js")} name="ShareCard" data=${share} onClose=${() => setShare(null)} />` : null}
  </div>`;
}
