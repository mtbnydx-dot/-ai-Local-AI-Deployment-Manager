// The banner every portal page shows for the most urgent active announcement
// (05 §12.7). Dismissal is remembered per announcement id.

import { html } from "../lib/html.js";
import { usePortal } from "../lib/context.js";
import { pickText } from "../lib/i18n.js";
import { StatusBadge } from "./status-badge.js";

const RANK = { incident: 0, maintenance: 1, info: 2 };

/** The announcements to banner: active, not dismissed, most urgent first. */
export function bannerCandidates(announcements, dismissed) {
  return (Array.isArray(announcements) ? announcements : [])
    .filter((item) => item && item.active !== false && !dismissed.has(item.id))
    .sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));
}

export function AnnouncementBanner() {
  const { t, lang, announcements, dismissed, dismissAnnouncement } = usePortal();
  const list = bannerCandidates(announcements, dismissed);
  if (!list.length) return null;
  const top = list[0];
  return html`<section class=${`banner banner-${top.severity}`} aria-label=${t("banner.label")}>
    <div class="container banner-row">
      <${StatusBadge} kind=${top.severity} label=${t(`severity.${top.severity}`)} />
      <p class="banner-text"><strong>${pickText(top.title, lang)}</strong></p>
      <a href="/announcements">${list.length > 1 ? t("banner.more", { count: list.length - 1 }) : t("banner.details")}</a>
      <button type="button" class="banner-close" aria-label=${t("banner.dismiss")} onClick=${() => dismissAnnouncement(top.id)}>×</button>
    </div>
  </section>`;
}
