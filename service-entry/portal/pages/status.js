// Status page (05 §12.2) and the portal home. It states the overall state in
// words, one card per published model, a 7-day hourly uptime bar and the time
// of the last update; it refreshes itself every 30 s while the tab is visible.

import { html } from "../lib/html.js";
import { usePortal, usePageTitle } from "../lib/context.js";
import { useNow, useResource } from "../lib/hooks.js";
import { getStatus } from "../lib/api.js";
import { pickText } from "../lib/i18n.js";
import { formatMilliseconds, formatPercent, formatRelative, formatDateTime } from "../lib/format.js";
import { StatusBadge } from "../components/status-badge.js";
import { CopyButton } from "../components/copy-button.js";
import { ErrorNotice, Loading } from "../components/notice.js";
import { stateLabel } from "../components/model-card.js";

const REFRESH_MS = 30_000;
const OVERALL = ["operational", "degraded", "offline", "maintenance"];

/** Counts the hourly buckets of an uptime document: { up, down, none }. */
export function summarizeHours(hours) {
  const out = { up: 0, down: 0, none: 0 };
  for (const hour of Array.isArray(hours) ? hours : []) {
    if (hour?.up === 1) out.up += 1;
    else if (hour?.up === 0) out.down += 1;
    else out.none += 1;
  }
  return out;
}

function UptimeBar({ hours }) {
  const { t, lang } = usePortal();
  const list = Array.isArray(hours) ? hours : [];
  if (!list.length) return null;
  const counts = summarizeHours(list);
  const summary = t("status.uptime_bar", { up: counts.up, down: counts.down, none: counts.none });
  // 168 bars in a 168-unit box: the SVG scales to the container width, so it
  // never forces a horizontal scroll.
  return html`<figure class="uptime">
    <svg class="uptime-bar" viewBox=${`0 0 ${list.length} 14`} preserveAspectRatio="none" role="img" aria-label=${summary}>
      ${list.map((hour, index) => {
        const kind = hour?.up === 1 ? "up" : hour?.up === 0 ? "down" : "none";
        return html`<rect key=${index} class=${`uptime-${kind}`} x=${index} y="0" width="0.82" height="14"><title>${formatDateTime(hour?.hour, lang)} — ${t(`status.hour_${kind}`)}</title></rect>`;
      })}
    </svg>
    <figcaption class="uptime-axis"><span>${t("status.days_ago", { count: 7 })}</span><span>${t("status.now")}</span></figcaption>
    <p class="muted small">${summary}</p>
  </figure>`;
}

function ModelStatusCard({ model }) {
  const { t } = usePortal();
  const ttft = formatMilliseconds(model.ttft_p50_ms);
  const speed = Number.isFinite(Number(model.tokens_per_second)) ? Number(model.tokens_per_second) : null;
  return html`<article class="card status-model" data-model-id=${model.id}>
    <header class="card-head">
      <h3 class="card-title">${model.display_name || model.id}</h3>
      <${StatusBadge} kind=${model.state} label=${stateLabel(t, model.state)} />
    </header>
    <dl class="facts">
      <div class="fact"><dt>${t("status.queue")}</dt><dd>${t.has(`queue.${model.queue}`) ? t(`queue.${model.queue}`) : t("queue.unknown")}</dd></div>
      ${ttft ? html`<div class="fact"><dt>${t("status.ttft")}</dt><dd>≈ ${ttft}</dd></div>` : null}
      ${speed !== null ? html`<div class="fact"><dt>${t("status.speed")}</dt><dd>≈ ${speed} ${t("status.tokens_per_second")}</dd></div>` : null}
    </dl>
  </article>`;
}

function GetStarted() {
  const { t, config } = usePortal();
  if (!config.openaiBase) return null;
  return html`<section class="card get-started" aria-labelledby="get-started-title">
    <h2 id="get-started-title" class="section-title">${t("home.start_title")}</h2>
    <p class="card-text">${t("home.start_text")}</p>
    <dl class="endpoints">
      <div><dt>${t("home.openai_base")}</dt><dd><code>${config.openaiBase}</code> <${CopyButton} text=${config.openaiBase} label=${t("home.copy_openai")} /></dd></div>
      ${config.anthropicBase ? html`<div><dt>${t("home.anthropic_base")}</dt><dd><code>${config.anthropicBase}</code> <${CopyButton} text=${config.anthropicBase} label=${t("home.copy_anthropic")} /></dd></div>` : null}
    </dl>
    <p class="card-actions">
      <a class="btn btn-primary" href="/docs/quickstart">${t("home.quickstart")}</a>
      <a class="btn" href="/models">${t("home.browse_models")}</a>
    </p>
  </section>`;
}

export default function StatusPage({ route }) {
  const { t, lang } = usePortal();
  const resource = useResource((signal) => getStatus({ signal }), [], { intervalMs: REFRESH_MS });
  const now = useNow(30_000);
  const home = route.name === "home";
  usePageTitle(home ? "" : t("nav.status"));
  const doc = resource.data;
  const overall = doc && OVERALL.includes(doc.status) ? doc.status : null;
  const message = doc ? pickText(doc.message, lang) || t(`status.${overall || "unknown"}`) : "";

  return html`<div class="page page-status">
    <section class="status-hero" aria-labelledby="status-title" data-state=${overall || "unknown"}>
      ${overall ? html`<${StatusBadge} kind=${overall} label=${t(`status.${overall}`)} large />` : null}
      <h1 id="status-title">${doc ? message : home ? t("home.title") : t("status.title")}</h1>
      ${doc ? html`<p class="muted" aria-live="polite">${t("status.updated", { when: formatRelative(doc.updated_at, now, lang) })} · ${t("status.auto_refresh")}</p>` : null}
    </section>
    ${resource.loading && !doc ? html`<${Loading} />` : null}
    ${resource.error ? html`<${ErrorNotice} error=${resource.error} onRetry=${resource.reload} />` : null}
    ${home ? html`<${GetStarted} />` : null}
    ${doc ? html`
      <section aria-labelledby="models-title">
        <h2 id="models-title" class="section-title">${t("status.models")}</h2>
        ${doc.models?.length
          ? html`<div class="grid">${doc.models.map((model) => html`<${ModelStatusCard} key=${model.id} model=${model} />`)}</div>`
          : html`<p class="muted">${t("status.no_models")}</p>`}
      </section>
      <section aria-labelledby="uptime-title">
        <h2 id="uptime-title" class="section-title">${t("status.uptime")}</h2>
        <dl class="facts uptime-numbers">
          <div class="fact"><dt>${t("status.uptime_24h")}</dt><dd>${formatPercent(doc.uptime?.h24, lang) || t("common.no_data")}</dd></div>
          <div class="fact"><dt>${t("status.uptime_7d")}</dt><dd>${formatPercent(doc.uptime?.d7, lang) || t("common.no_data")}</dd></div>
        </dl>
        <${UptimeBar} hours=${doc.uptime?.hours_7d} />
      </section>` : null}
  </div>`;
}
