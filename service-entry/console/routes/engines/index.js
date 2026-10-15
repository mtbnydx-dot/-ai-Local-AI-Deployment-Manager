// /engines (07 §6.5): the engine cards, the external endpoints and the knowledge
// status.
//
// Cards come from the entry aggregate GET /api/engines (01 §21.2): label, tier,
// host manager, health, runtimes (an image that is not pulled is called out) and
// capability chips. A manager that did not answer is listed in `errors[]` and
// shows as a grey card with a Start button for the owner (07 §3.4). Descriptor
// problems the managers reported are listed under the cards.

import { describeError } from "../../lib/api.js";
import { runtimeState, summarizeEngines } from "../../lib/engines-model.js";
import { EnginesResponseGuard } from "../../lib/schemas.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { CapabilityChips, HealthBadge, TierBadge, managerName } from "./engine-parts.js";
import { ExternalEndpointsPanel } from "./external.js";

const enc = encodeURIComponent;

function EngineCard({ engine }) {
  const { t, has, tk, pick } = useT();
  const runtimes = Array.isArray(engine.runtimes) ? engine.runtimes : [];
  const missing = runtimes.filter((runtime) => runtimeState(runtime) === "missing").length;
  const label = pick(engine.label) || engine.engineId;
  const title = html`<a href=${`/engines/${enc(engine.engineId)}`} data-testid="engine-card.link">${label}</a>`;
  return html`<${Card} title=${title} level=${3} testid="engine-card">
    <div class="stack-sm" data-engine=${engine.engineId} data-manager=${engine.managerId}>
      <div class="row"><${TierBadge} engine=${engine} /><${HealthBadge} engine=${engine} /></div>
      <dl class="kv">
        <dt>${t("engines.page.card.host")}</dt><dd>${managerName(t, has, tk, engine.managerId)}</dd>
        <dt>${t("engines.page.card.runtimes")}</dt><dd data-testid="engine-card.runtimes">${t("engines.page.card.runtimeCount", { count: runtimes.length })}
          ${missing ? html` <span class="badge badge-warn" data-testid="engine-card.missing">${t("engines.page.card.notPulled", { count: missing })}</span>` : null}</dd>
        ${Number.isFinite(engine.health?.instances) ? html`<dt>${t("engines.page.card.instances")}</dt><dd>${engine.health.instances}</dd>` : null}
      </dl>
      <${CapabilityChips} engine=${engine} />
    </div>
  <//>`;
}

function OfflineCard({ managerId, owner }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t, has, tk } = useT();
  const [busy, setBusy] = useState(false);
  const name = managerName(t, has, tk, managerId);
  async function start() {
    setBusy(true);
    try {
      await api.post(`/api/managers/${enc(managerId)}/start`);
      cache.invalidate(["engines"]);
    } catch (error) {
      toasts?.push?.({ level: "error", title: describeError(error, i18n) });
    } finally {
      setBusy(false);
    }
  }
  return html`<${Card} title=${name} level=${3} tone="flat" testid="engine-offline">
    <div class="stack-sm" data-manager=${managerId}>
      <p class="muted" data-testid="engine-offline.text">${t("engines.page.offline", { manager: name })}</p>
      <p class="small muted">${t("engines.page.offlineHint")}</p>
      ${owner ? html`<div><${Button} size="sm" onClick=${start} busy=${busy} testid="engine-offline.start">${t("engines.page.offlineStart")}<//></div>` : null}
    </div>
  <//>`;
}

function Problems({ problems }) {
  const { t } = useT();
  return html`<${Card} title=${t("engines.page.problems")} testid="engine-problems">
    <ul class="stack-sm">${problems.map((item, index) => html`<li key=${index} data-code=${item.code}>
      ${item.engineId ? html`<code class="code-inline">${item.engineId}</code> ` : null}${item.path ? html`<code class="code-inline">${item.path}</code> ` : null}
      <span class="muted">${item.code}</span> <span data-user-content="">${item.message}</span></li>`)}</ul>
  <//>`;
}

function KnowledgeStatus() {
  const { api } = useServices();
  const { t } = useT();
  const query = useQuery(["engines", "knowledge"], () => api.get("/api/knowledge/status"), { ttlMs: 30000 });
  const domains = Array.isArray(query.data?.domains) ? query.data.domains.filter((item) => item && typeof item === "object") : [];
  let body;
  if (query.error && !query.data) {
    body = html`<p class="muted" data-testid="engine-knowledge.unavailable">${t(query.error.code === "endpoint_unavailable" ? "engines.page.knowledge.unavailable" : "engines.page.knowledge.failed")}</p>`;
  } else if (!query.data) {
    body = html`<div aria-busy="true"><${Skeleton} shape="line" rows=${2} /></div>`;
  } else if (!domains.length) {
    body = html`<p class="muted">${t("engines.page.knowledge.empty")}</p>`;
  } else {
    body = html`<ul class="stack-sm" data-testid="engine-knowledge.list">${domains.map((domain) => {
      const errors = Array.isArray(domain.errors) ? domain.errors.length : 0;
      const status = domain.unavailable ? "unknown" : errors ? "warn" : "ok";
      return html`<li key=${String(domain.domain)} class="row" data-domain=${String(domain.domain)}>
        <code class="code-inline">${String(domain.domain)}</code>
        <${StatusBadge} status=${status} label=${domain.unavailable ? t("engines.page.knowledge.domainUnavailable") : errors ? t("engines.page.knowledge.errorCount", { count: errors }) : t("engines.page.knowledge.domainOk")} />
      </li>`;
    })}</ul>`;
  }
  return html`<${Card} title=${t("engines.page.knowledge.title")} testid="engine-knowledge">
    ${body}
    <p class="small"><a href="/models/knowledge">${t("engines.page.knowledge.open")}</a></p>
  <//>`;
}

export default function EnginesPage() {
  const { api } = useServices();
  const { t } = useT();
  const owner = useRole() === "owner";
  const query = useQuery(["engines"], () => api.get("/api/engines", { guard: EnginesResponseGuard }), { ttlMs: 10000, refetchMs: 30000 });
  const summary = useMemo(() => (query.data ? summarizeEngines(query.data) : null), [query.data]);

  const actions = html`${owner ? html`<${Button} variant="primary" href="/engines/new" testid="engines.new">${t("engines.page.new")}<//>` : null}
    <${Button} href="/engines/external" testid="engines.external">${t("engines.page.externalLink")}<//>`;
  let body;
  if (query.error && !summary) {
    body = html`<${EmptyState} testid="engines.unavailable" icon="triangle-alert" title=${t("engines.page.unavailable")} body=${t("engines.page.unavailableBody")}
      action=${{ label: t("engines.page.retry"), onClick: () => query.refetch() }} />`;
  } else if (!summary) {
    body = html`<div aria-busy="true" data-testid="engines.loading"><${Skeleton} shape="tile" /><${Skeleton} shape="line" rows=${4} /></div>`;
  } else {
    body = html`<div class="stack">
      ${summary.engines.length || summary.offline.length ? html`<section aria-labelledby="engines-cards-title"><h2 id="engines-cards-title" class="sr-only">${t("engines.page.cardsTitle")}</h2><div class="grid-auto" data-testid="engines.cards">
        ${summary.engines.map((engine) => html`<${EngineCard} key=${`${engine.managerId}:${engine.engineId}`} engine=${engine} />`)}
        ${summary.offline.map((item) => html`<${OfflineCard} key=${`offline:${item.managerId}`} managerId=${item.managerId} owner=${owner} />`)}
      </div></section>` : html`<${EmptyState} title=${t("engines.page.none")} body=${t("engines.page.noneBody")} action=${{ label: t("engines.page.retry"), onClick: () => query.refetch() }} />`}
      ${summary.problems.length ? html`<${Problems} problems=${summary.problems} />` : null}
    </div>`;
  }
  return html`<div class="stack" data-testid="engines">
    <${PageHeader} title=${t("shell.nav.engines")} subtitle=${t("engines.page.subtitle")} actions=${actions} />
    ${body}
    <${ExternalEndpointsPanel} />
    <${KnowledgeStatus} />
  </div>`;
}
