// /access (07 §6.10): the landing page of Access & keys. One card per page
// (keys, public access, security, client guides, sessions, portal) with the
// key counts, and a banner when the migration of the old per-engine keys
// left something to look at. Without the platform key store it points at the
// legacy per-engine keys instead of failing.

import { Card } from "../../components/card.js";
import { Icon } from "../../components/icon.js";
import { PageHeader } from "../../components/page-header.js";
import { tk } from "../../lib/i18n.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useFeature } from "../../ui/shell.js";
import { legacyClients } from "../../lib/access-model.js";

const CARDS = Object.freeze([
  { id: "keys", href: "/access/keys", icon: "key-round", feature: null },
  { id: "public", href: "/access/public", icon: "external-link", feature: "public" },
  { id: "security", href: "/access/security", icon: "lock", feature: "public" },
  { id: "clients", href: "/access/clients", icon: "message-square", feature: null },
  { id: "sessions", href: "/access/sessions", icon: "settings", feature: "session" },
  { id: "portal", href: "/access/portal", icon: "boxes", feature: "public" },
]);

function MigrationBanner({ report }) {
  const { t, has } = useT();
  const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
  if (!report || (!warnings.length && report.complete !== false)) return null;
  return html`<section class="notice notice-warn" role="region" aria-label=${t("access.migration.title")} data-testid="access.migration">
    <div class="stack-sm grow">
      <strong>${t("access.migration.title")}</strong>
      <span>${t("access.migration.body", { inserted: report.counts?.inserted ?? 0, warnings: warnings.length })}</span>
      ${warnings.length ? html`<ul class="small">${warnings.slice(0, 8).map((item, index) => html`<li key=${index}>${has(tk("access.migration.warning.", item.code)) ? t(tk("access.migration.warning.", item.code), { manager: item.managerId || "" }) : item.code}</li>`)}</ul>` : null}
      <a href="/access/keys" data-testid="access.migration-link">${t("access.migration.review")}</a>
    </div>
  </section>`;
}

export default function AccessIndex() {
  const { api } = useServices();
  const { t } = useT();
  const modern = useFeature("access");
  const features = { public: useFeature("public"), session: useFeature("session") };
  const keys = useQuery(["access", "keys", "summary"], () => api.get("/api/access/keys", { query: { limit: 1 } }), { ttlMs: 10_000, enabled: modern });
  const migration = useQuery(["access", "migration"], () => api.get("/api/access/migration"), { ttlMs: 30_000, enabled: modern });
  const legacy = useQuery(["legacy", "keys"], () => api.get("/api/keys"), { ttlMs: 10_000, enabled: !modern });
  const counts = keys.data?.counts;
  const legacyRows = legacyClients(legacy.data);

  const summary = (id) => {
    if (id !== "keys") return "";
    if (modern) return counts ? t("access.index.keysCount", { active: counts.active ?? 0, total: counts.total ?? 0 }) : "";
    return legacy.data ? t("access.index.legacyCount", { count: legacyRows.length }) : "";
  };

  return html`<div class="stack" data-testid="access.root">
    <${PageHeader} title=${t("access.title")} subtitle=${t("access.subtitle")} />
    ${modern ? html`<${MigrationBanner} report=${migration.data?.report} />` : html`<p class="notice notice-warn" role="note" data-testid="access.legacy-note">${t("access.legacy.banner")}: ${t("access.legacy.body")}</p>`}
    <ul class="grid-auto access-cards" data-testid="access.cards">
      ${CARDS.map((card) => {
        const missing = card.feature && !features[card.feature];
        return html`<li key=${card.id} class="access-card-item">
          <${Card} title=${html`<a href=${card.href} data-testid=${`access.card.${card.id}`}><${Icon} name=${card.icon} /> ${t(tk("access.index.", card.id, "title"))}</a>`} level=${2}>
            <p>${t(tk("access.index.", card.id, "body"))}</p>
            ${summary(card.id) ? html`<p class="muted small" data-testid=${`access.summary.${card.id}`}>${summary(card.id)}</p>` : null}
            ${missing ? html`<p class="muted small">${t("access.index.unavailable")}</p>` : null}
          <//>
        </li>`;
      })}
    </ul>
  </div>`;
}
