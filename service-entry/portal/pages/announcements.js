// Announcements (05 §12.7): what is active now and what is scheduled.

import { html } from "../lib/html.js";
import { usePortal, usePageTitle } from "../lib/context.js";
import { useResource } from "../lib/hooks.js";
import { getAnnouncements } from "../lib/api.js";
import { pickText } from "../lib/i18n.js";
import { formatDateTime } from "../lib/format.js";
import { StatusBadge } from "../components/status-badge.js";
import { EmptyState, ErrorNotice, Loading } from "../components/notice.js";

const REFRESH_MS = 60_000;
const RANK = { incident: 0, maintenance: 1, info: 2 };

/** Splits the document into { active, upcoming }, most urgent (then newest) first. */
export function groupAnnouncements(list) {
  const items = Array.isArray(list) ? list : [];
  const order = (a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3) || String(b.starts_at).localeCompare(String(a.starts_at));
  return {
    active: items.filter((item) => item.active !== false).sort(order),
    upcoming: items.filter((item) => item.active === false).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at))),
  };
}

function Announcement({ item }) {
  const { t, lang } = usePortal();
  const body = pickText(item.body, lang);
  const from = formatDateTime(item.starts_at, lang);
  const until = item.ends_at ? formatDateTime(item.ends_at, lang) : "";
  return html`<article class="card announcement" data-severity=${item.severity} data-id=${item.id}>
    <header class="card-head">
      <h3 class="card-title">${pickText(item.title, lang)}</h3>
      <${StatusBadge} kind=${item.severity} label=${t(`severity.${item.severity}`)} />
    </header>
    <p class="muted small">${until ? t("announcements.window", { from, until }) : t("announcements.since", { from })}</p>
    ${body ? html`<p class="card-text preline">${body}</p>` : null}
  </article>`;
}

export default function AnnouncementsPage() {
  const { t } = usePortal();
  usePageTitle(t("nav.announcements"));
  const resource = useResource((signal) => getAnnouncements({ signal }), [], { intervalMs: REFRESH_MS });
  const groups = groupAnnouncements(resource.data?.announcements);
  const empty = resource.data && !groups.active.length && !groups.upcoming.length;
  return html`<div class="page page-announcements">
    <h1>${t("announcements.title")}</h1>
    <p class="lead">${t("announcements.lead")}</p>
    ${resource.loading && !resource.data ? html`<${Loading} />` : null}
    ${resource.error ? html`<${ErrorNotice} error=${resource.error} onRetry=${resource.reload} />` : null}
    ${empty ? html`<${EmptyState} title=${t("announcements.empty")} />` : null}
    ${groups.active.length ? html`<section aria-labelledby="active-title">
      <h2 id="active-title" class="section-title">${t("announcements.active")}</h2>
      <div class="stack">${groups.active.map((item) => html`<${Announcement} key=${item.id} item=${item} />`)}</div>
    </section>` : null}
    ${groups.upcoming.length ? html`<section aria-labelledby="upcoming-title">
      <h2 id="upcoming-title" class="section-title">${t("announcements.upcoming")}</h2>
      <div class="stack">${groups.upcoming.map((item) => html`<${Announcement} key=${item.id} item=${item} />`)}</div>
    </section>` : null}
  </div>`;
}
