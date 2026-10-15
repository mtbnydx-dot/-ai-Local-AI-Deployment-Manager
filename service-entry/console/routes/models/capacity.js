// Capacity bars (07 §6.4 "Library"): one StackedBar per registered storage root
// and one for the Hugging Face cache drive, from GET /api/hub/storage/usage.
// A bar shows what else is on the drive, the models, the leftovers of
// interrupted downloads and the bytes active downloads still have to write; the
// rest is free (StackedBar lists every part, so color is never the only cue).

import { cacheBar, rootBars } from "../../lib/library-model.js";
import { Card } from "../../components/card.js";
import { Skeleton } from "../../components/skeleton.js";
import { StackedBar } from "../../components/stacked-bar.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

function RootBar({ bar }) {
  const { t } = useT();
  const parts = [
    { id: "used", label: t("hub.storage.bar.used"), value: bar.parts.used },
    { id: "models", label: t("hub.storage.bar.models"), value: bar.parts.models },
    { id: "residue", label: t("hub.storage.bar.residue"), value: bar.parts.residue },
    { id: "pending", label: t("hub.storage.bar.pending"), value: bar.parts.pending },
  ].filter((part) => part.value > 0 || part.id === "models");
  return html`<div class="stack-sm capacity-root" data-testid="capacity.root" data-root=${bar.id} data-online=${bar.online ? "true" : "false"}>
    <div class="row">
      <strong data-user-content="">${bar.label}</strong>
      ${bar.default ? html`<span class="badge badge-info">${t("hub.storage.badge.default")}</span>` : null}
      ${bar.volume ? html`<span class="muted small mono">${bar.volume}</span>` : null}
      <span class="muted small">${t("hub.storage.bar.models.count", { count: bar.modelCount })}</span>
    </div>
    ${bar.online
      ? html`<${StackedBar} total=${bar.totalBytes} parts=${parts} testid="capacity.bar" />`
      : html`<p class="small muted" data-testid="capacity.offline">${t("hub.storage.bar.offline")}</p>`}
  </div>`;
}

function CacheBar({ bar }) {
  const { t } = useT();
  if (!bar || (bar.empty && bar.freeBytes === null)) return null;
  const parts = [
    { id: "hub", label: t("hub.storage.cache.hub"), value: bar.parts.hub },
    { id: "xet", label: t("hub.storage.cache.xet"), value: bar.parts.xet },
    { id: "modelscope", label: t("hub.storage.cache.modelscope"), value: bar.parts.modelscope },
  ].filter((part) => part.value > 0);
  return html`<div class="stack-sm capacity-root" data-testid="capacity.cache">
    <div class="row">
      <strong>${t("hub.storage.cache.title")}</strong>
      ${bar.volume ? html`<span class="muted small mono">${bar.volume}</span>` : null}
    </div>
    <${StackedBar} total=${bar.totalBytes} parts=${parts} testid="capacity.cache.bar" />
  </div>`;
}

/** @param query the useUsageQuery() result */
export function CapacityBars({ query, testid }) {
  const { t } = useT();
  const usage = query.data?.usage;
  const bars = usage ? rootBars(usage) : [];
  const cache = usage ? cacheBar(usage) : null;
  const hidden = Array.isArray(usage?.roots) && usage.roots.some((root) => root?.hidden === true);
  let body;
  if (query.error && !usage) {
    body = html`<p class="muted" data-testid="capacity.unavailable">${t("hub.storage.bar.unavailable")}</p>`;
  } else if (!usage) {
    body = html`<div aria-busy="true"><${Skeleton} shape="line" rows=${2} /></div>`;
  } else if (!bars.length && !cache) {
    body = html`<p class="muted">${t("hub.storage.bar.none")}</p>`;
  } else {
    body = html`<div class="stack capacity-list">
      ${bars.map((bar) => html`<${RootBar} key=${bar.id} bar=${bar} />`)}
      <${CacheBar} bar=${cache} />
      ${hidden ? html`<p class="small muted" data-testid="capacity.hidden">${t("hub.storage.root.hidden")}</p>` : null}
    </div>`;
  }
  return html`<${Card} title=${t("hub.storage.bar.title")} testid=${testid || "capacity"}>${body}<//>`;
}
