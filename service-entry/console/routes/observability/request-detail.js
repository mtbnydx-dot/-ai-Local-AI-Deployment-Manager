// Observability › Request detail `/observability/requests/:requestId` (07
// §6.7, 04 §11.6, §19): the timeline waterfall, the billing decision, the
// instance and launch the request ran on, the events around it, and the link
// to its conversation in the audit. The page is metadata only; message text
// never appears here. `x-audit-session` is sent only while the audit is
// unlocked in the degrade mode (the cookie mode sends nothing of its own).

import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { auditLink, billingView, conversationHref, deploymentHref, terminalTone } from "../../lib/requests-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { EmptyState } from "../../components/empty-state.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useCopy } from "../../components/code-block.js";
import { ObsPage, useObsState } from "./common.js";
import { Waterfall } from "./waterfall.js";
import { useServices } from "../../ui/context.js";
import { useAuditSession } from "../../ui/audit.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

const dash = "—";

function Facts({ items, testid }) {
  return html`<dl class="obs-facts req-facts" data-testid=${testid}>
    ${items.filter((item) => item.value !== null && item.value !== undefined && item.value !== "").map((item) => html`<div key=${item.label} data-fact=${item.id || undefined}>
      <dt>${item.label}</dt><dd>${item.value}</dd>
    </div>`)}
  </dl>`;
}

function Summary({ request }) {
  const { t, has } = useT();
  const fmt = useFormat();
  const [copyState, copy] = useCopy();
  const errorText = request.errorClass && request.errorClass !== "none" ? (has(tk("obs.err.", request.errorClass)) ? t(tk("obs.err.", request.errorClass)) : request.errorClass) : null;
  const term = request.terminalState;
  const user = (value) => (value ? html`<span data-user-content>${value}</span>` : null);
  const mono = (value) => (value ? html`<span class="mono small" data-user-content>${value}</span>` : null);
  const requested = request.modelRequested && request.modelRequested !== request.modelResolved ? t("obs.req.modelRouted", { requested: request.modelRequested, resolved: request.modelResolved || dash }) : request.modelResolved || request.modelRequested;
  return html`<${Card} title=${t("obs.req.summary")} testid="obs.req.summary"
    actions=${html`<${Button} size="sm" icon=${copyState === "copied" ? "check" : "copy"} onClick=${() => copy(request.requestId)} testid="obs.req.copy-id">${copyState === "copied" ? t("common.copied") : t("obs.req.copyId")}<//>`}>
    <div class="stack-sm">
      <p class="row">
        <${StatusBadge} status=${terminalTone(term)} label=${has(tk("obs.term.", term)) ? t(tk("obs.term.", term)) : term || t("common.badge.unknown")} testid="obs.req.state" />
        ${request.status !== null && request.status !== undefined ? html`<span class="mono" data-testid="obs.req.http">HTTP ${request.status}</span>` : null}
        ${errorText ? html`<span data-testid="obs.req.error-class">${errorText}</span>` : null}
        ${request.errorCode ? html`<span class="mono small muted" data-user-content>${request.errorCode}</span>` : null}
      </p>
      <${Facts} testid="obs.req.facts" items=${[
        { id: "id", label: t("obs.req.col.id"), value: mono(request.requestId) },
        { id: "managerRequestId", label: t("obs.req.managerRequestId"), value: mono(request.managerRequestId) },
        { id: "clientRequestId", label: t("obs.req.clientRequestId"), value: mono(request.clientRequestId) },
        { id: "received", label: t("obs.req.col.time"), value: request.receivedAt ? html`<time dateTime=${request.receivedAt}>${fmt.dateTime(request.receivedAt, { style: "long" })}</time>` : null },
        { id: "model", label: t("obs.col.model"), value: user(requested) },
        { id: "route", label: t("obs.req.route"), value: mono([request.method, request.path].filter(Boolean).join(" ")) },
        { id: "protocol", label: t("obs.req.col.protocol"), value: request.protocol ? `${request.protocol}${request.op ? ` · ${request.op}` : ""}` : null },
        { id: "ingress", label: t("obs.req.ingress"), value: request.ingress },
        { id: "stream", label: t("obs.req.col.stream"), value: request.stream === undefined ? null : t(request.stream ? "obs.yes" : "obs.no") },
        { id: "source", label: t("obs.req.col.source"), value: user(request.sourceProgram) },
        { id: "key", label: t("obs.col.key"), value: mono(request.keyId) },
        { id: "ip", label: t("obs.col.ip"), value: mono(request.clientIp) },
        { id: "duration", label: t("obs.req.col.duration"), value: request.durationMs === null || request.durationMs === undefined ? null : fmt.duration(request.durationMs) },
        { id: "ttft", label: t("obs.req.col.ttft"), value: request.ttftMs === null || request.ttftMs === undefined ? null : fmt.duration(request.ttftMs) },
        { id: "queue", label: t("obs.req.seg.queue"), value: request.queueMs === null || request.queueMs === undefined ? null : fmt.duration(request.queueMs) },
        { id: "tps", label: t("obs.col.tps"), value: request.decodeTps === null || request.decodeTps === undefined ? null : fmt.rate(request.decodeTps, t("obs.req.tpsUnit")) },
        { id: "prompt", label: t("obs.col.promptTokens"), value: request.promptTokens === null || request.promptTokens === undefined ? null : fmt.integer(request.promptTokens) },
        { id: "cached", label: t("obs.req.col.cached"), value: request.cachedTokens === null || request.cachedTokens === undefined ? null : fmt.integer(request.cachedTokens) },
        { id: "output", label: t("obs.col.outputTokens"), value: request.outputTokens === null || request.outputTokens === undefined ? null : fmt.integer(request.outputTokens) },
        { id: "reasoning", label: t("obs.req.reasoningTokens"), value: request.reasoningTokens === null || request.reasoningTokens === undefined ? null : fmt.integer(request.reasoningTokens) },
        { id: "usageSource", label: t("obs.req.usageSource"), value: request.usageSource },
        { id: "finish", label: t("obs.req.finishReason"), value: mono(request.finishReason) },
      ]} />
    </div>
  <//>`;
}

function Billing({ billing }) {
  const { t } = useT();
  const view = billingView(billing);
  return html`<${Card} title=${t("obs.req.billing")} testid="obs.req.billing">
    ${view ? html`<div class="stack-sm">
      ${view.usage ? html`<${Facts} testid="obs.req.billing.usage" items=${[
        { id: "charged", label: t("obs.req.billing.charged"), value: view.usage.charged === null ? null : t("obs.req.credits", { value: view.usage.charged }) },
        { id: "projected", label: t("obs.req.billing.projected"), value: view.usage.projected === null ? null : t("obs.req.credits", { value: view.usage.projected }) },
        { id: "decision", label: t("obs.req.billing.decision"), value: view.usage.decisionCode ? html`<span class="mono small">${view.usage.decisionCode}</span>` : null },
        { id: "usageSource", label: t("obs.req.usageSource"), value: view.usage.usageSource },
        { id: "usageId", label: t("obs.req.billing.usageId"), value: view.usage.usageId ? html`<span class="mono small">${view.usage.usageId}</span>` : null },
      ]} />` : null}
      ${view.reservation ? html`<${Facts} testid="obs.req.billing.reservation" items=${[
        { id: "mode", label: t("obs.req.billing.mode"), value: view.reservation.enforcementMode },
        { id: "reserved", label: t("obs.req.billing.reserved"), value: view.reservation.reserved === null ? null : t("obs.req.credits", { value: view.reservation.reserved }) },
        { id: "reservationDecision", label: t("obs.req.billing.decision"), value: view.reservation.decisionCode ? html`<span class="mono small">${view.reservation.decisionCode}</span>` : null },
      ]} />` : null}
    </div>` : html`<p class="muted" data-testid="obs.req.billing.none">${t("obs.req.billing.none")}</p>`}
  <//>`;
}

function InstanceCard({ instance }) {
  const { t } = useT();
  const fmt = useFormat();
  if (!instance) {
    return html`<${Card} title=${t("obs.req.instance")} testid="obs.req.instance"><p class="muted">${t("obs.req.instance.none")}</p><//>`;
  }
  const launch = instance.launch && typeof instance.launch === "object" ? instance.launch : null;
  const summary = launch?.summary && typeof launch.summary === "object" ? Object.entries(launch.summary).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)) : [];
  const sample = instance.nearestSample && typeof instance.nearestSample === "object" ? instance.nearestSample : null;
  return html`<${Card} title=${t("obs.req.instance")} testid="obs.req.instance"
    actions=${instance.fleetId ? html`<${Button} size="sm" href=${deploymentHref(instance.fleetId)} testid="obs.req.instance.open">${t("obs.req.openDeployment")}<//>` : null}>
    <div class="stack-sm">
      <${Facts} testid="obs.req.instance.facts" items=${[
        { id: "fleet", label: t("obs.req.col.fleet"), value: instance.fleetId ? html`<a class="mono small" href=${deploymentHref(instance.fleetId)} data-testid="obs.req.fleet-link" data-user-content>${instance.fleetId}</a>` : null },
        { id: "engine", label: t("obs.req.engine"), value: instance.engineId ? html`<span data-user-content>${instance.engineId}</span>` : null },
        { id: "runtime", label: t("obs.req.runtime"), value: instance.runtimeId ? html`<span class="mono small" data-user-content>${instance.runtimeId}</span>` : null },
        { id: "launch", label: t("obs.req.launch"), value: instance.launchId ? html`<a class="mono small" href=${deploymentHref(instance.fleetId, "config")} data-testid="obs.req.launch-link" data-user-content>${instance.launchId}</a>` : null },
        { id: "recipe", label: t("obs.req.recipe"), value: instance.recipeId ? html`<span class="mono small" data-user-content>${instance.recipeId}</span>` : null },
        { id: "ready", label: t("obs.req.launchReady"), value: launch?.readyAt ? fmt.dateTime(launch.readyAt) : null },
      ]} />
      ${summary.length ? html`<div><h3 class="obs-subtitle">${t("obs.req.launchSummary")}</h3>
        <${Facts} testid="obs.req.launch.summary" items=${summary.map(([name, value]) => ({ id: name, label: name, value: html`<span class="mono small" data-user-content>${String(value)}</span>` }))} /></div>` : null}
      ${sample ? html`<div><h3 class="obs-subtitle">${t("obs.req.nearestSample")}</h3>
        <${Facts} testid="obs.req.sample" items=${[
          { id: "at", label: t("obs.req.sampleAt"), value: sample.at ? fmt.dateTime(sample.at, { style: "long" }) : null },
          { id: "running", label: t("obs.col.running"), value: Number.isFinite(sample.running) ? fmt.integer(sample.running) : null },
          { id: "waiting", label: t("obs.col.waiting"), value: Number.isFinite(sample.waiting) ? fmt.integer(sample.waiting) : null },
          { id: "kv", label: t("obs.col.kv"), value: Number.isFinite(sample.kvUsage) ? fmt.percent(sample.kvUsage, 0) : null },
        ]} /></div>` : null}
    </div>
  <//>`;
}

function Events({ events }) {
  const { t } = useT();
  const fmt = useFormat();
  const rows = Array.isArray(events) ? events.filter((item) => item && typeof item === "object") : [];
  return html`<${Card} title=${t("obs.req.events")} testid="obs.req.events">
    ${rows.length ? html`<ul class="req-events">
      ${rows.map((event, index) => html`<li key=${event.id ?? index} data-testid="obs.req.event">
        <time class="small muted" dateTime=${event.at}>${fmt.dateTime(event.at, { style: "long" })}</time>
        <span class="mono small" data-user-content>${event.type}</span>
        ${event.title ? html` <span data-user-content>${typeof event.title === "string" ? event.title : ""}</span>` : null}
      </li>`)}
    </ul>` : html`<p class="muted" data-testid="obs.req.events.none">${t("obs.req.events.none")}</p>`}
  <//>`;
}

function AuditCard({ audit: block }) {
  const { t } = useT();
  const link = auditLink(block);
  return html`<${Card} title=${t("obs.req.audit")} testid="obs.req.audit">
    ${!link.linkable ? html`<p class="muted" data-testid="obs.req.audit.none">${t("obs.req.audit.notLinkable")}</p>`
      : !link.unlocked ? html`<div class="stack-sm" data-testid="obs.req.audit.locked">
        <p>${t("obs.req.audit.locked")}</p>
        <div><${Button} href="/audit/conversations" testid="obs.req.audit.unlock">${t("obs.req.audit.unlock")}<//></div>
      </div>`
      : html`<div class="stack-sm" data-testid="obs.req.audit.open">
        ${link.chatId ? html`<p><a class="btn" href=${conversationHref(link.chatId)} data-testid="obs.req.audit.chat">${t("obs.req.audit.openChat")}</a></p>` : null}
        ${link.candidates.length ? html`<ul class="req-candidates" aria-label=${t("obs.req.audit.candidates")}>
          ${link.candidates.map((item) => html`<li key=${`${item.chatId}:${item.auditId}`}>
            <a href=${conversationHref(item.chatId, item.auditId)} data-testid="obs.req.audit.candidate"><span data-user-content>${item.title || item.chatId}</span></a>
            ${item.offsetSeconds === null ? null : html` <span class="muted small">${t("obs.req.audit.offset", { seconds: item.offsetSeconds })}</span>`}
          </li>`)}
        </ul>` : !link.chatId ? html`<p class="muted" data-testid="obs.req.audit.nomatch">${t("obs.req.audit.noMatch")}</p>` : null}
      </div>`}
  <//>`;
}

function Detail({ detail }) {
  const { t } = useT();
  const request = detail.request && typeof detail.request === "object" ? detail.request : {};
  return html`<div class="stack" data-testid="obs.req.detail">
    <${Summary} request=${request} />
    <${Card} title=${t("obs.req.waterfall")} testid="obs.req.waterfall"><${Waterfall} detail=${detail} /><//>
    <div class="obs-grid">
      <${Billing} billing=${detail.billing} />
      <${InstanceCard} instance=${detail.instance} />
    </div>
    <div class="obs-grid">
      <${Events} events=${detail.events} />
      <${AuditCard} audit=${detail.audit} />
    </div>
  </div>`;
}

function Body({ requestId }) {
  const { api } = useServices();
  const audit = useAuditSession();
  const i18n = useT();
  const { t } = i18n;
  // The unlock mode is part of the key: unlocking refetches, so the audit link resolves.
  const query = useQuery(["telemetry", "request", requestId, audit.mode()], () => api.get(`/api/telemetry/requests/${encodeURIComponent(requestId)}`, { headers: audit.headers() }), { ttlMs: 15_000, keepPrevious: false });
  if (query.data === undefined && query.error) {
    const gone = query.error.status === 404;
    return html`<${EmptyState} icon="search" title=${gone ? t("obs.req.notFound") : describeError(query.error, i18n)} body=${gone ? t("obs.req.notFoundBody") : undefined}
      action=${{ label: t("obs.req.back"), href: "/observability/requests" }} testid="obs.req.missing" />`;
  }
  if (query.data === undefined) return html`<div aria-busy="true" data-testid="obs.loading"><${Skeleton} shape="line" rows=${6} /></div>`;
  return html`<${Detail} detail=${query.data} />`;
}

export default function ObservabilityRequestDetail({ params = {} }) {
  const obs = useObsState();
  const { t } = useT();
  const requestId = String(params.requestId ?? "");
  const back = `/observability/requests${obs.search}`;
  const trail = [
    { label: t("obs.title"), href: "/observability" },
    { label: t("obs.page.requests"), href: back },
    { label: requestId },
  ];
  return html`<${ObsPage} obs=${obs} id="requests" ownerOnly=${true} bare=${true} title=${t("obs.req.detailTitle")} trail=${trail} testid="obs.request.root">${() => html`<div class="stack">
    <p><a class="btn btn-sm" href=${back} data-testid="obs.req.back">${t("obs.req.back")}</a></p>
    <${Body} requestId=${requestId} />
  </div>`}<//>`;
}
