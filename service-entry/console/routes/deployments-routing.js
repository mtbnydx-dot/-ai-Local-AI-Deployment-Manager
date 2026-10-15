// Routing `/deployments/routing` (07 §6.2): the old fleet behaviour with its
// request bodies kept exactly.
//
// - The mode buttons (`aria-pressed`) send `POST /api/fleet/settings {mode}`.
// - The VRAM policy form sends `{maxUtilizationPct, reserveMb}`; the reserve is
//   typed in GiB.
// - The route preview sends `POST /api/fleet/route-preview {capability,
//   engine, protocol, model?}` and never any message content.
// - The gateway URLs can be copied.
//
// A save answers with the fleet snapshot. The page shows that snapshot until a
// fleet read that started after the save arrives, so a read that was already
// in flight cannot flip the buttons back.

import {
  FLEET_MODES, gibOfMb, gibText, gpuHeadroom, modeBody, policyBody, POLICY_LIMITS, PREVIEW_CAPABILITIES, previewBody, previewModels, previewOutcome, routableCounts,
} from "../lib/deployments-model.js";
import { describeError } from "../lib/api.js";
import { tk } from "../lib/i18n.js";
import { FleetGuard } from "../lib/schemas.js";
import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { copyText } from "../components/code-block.js";
import { PageHeader } from "../components/page-header.js";
import { useServices } from "../ui/context.js";
import { useFormat, useQuery, useRole, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useId, useState } from "../ui/vendor.js";

// The time a fleet read started, kept beside its data (a frozen reply cannot carry a property).
const startedAtOf = new WeakMap();

function stamp(data, startedAt) {
  if (data !== null && typeof data === "object") startedAtOf.set(data, startedAt);
  return data;
}

function GpuCard({ fleet }) {
  const { t } = useT();
  const fmt = useFormat();
  const memory = gpuHeadroom(fleet);
  const counts = routableCounts(fleet);
  const gib = (mb) => gibText(fmt, mb);
  return html`<${Card} title=${t("deploy.routing.gpu.title")} testid="deploy.routing.gpu">
    <p class="small muted" data-testid="deploy.routing.counts">${t("deploy.routing.counts", { routable: counts.routable, other: counts.other, total: counts.total })}</p>
    ${memory ? html`<dl class="deploy-facts" data-testid="deploy.routing.memory">
      <div class="deploy-fact"><dt class="small muted">${t("deploy.routing.gpu.total")}</dt><dd class="tabular">${gib(memory.totalMb)}</dd></div>
      <div class="deploy-fact"><dt class="small muted">${t("deploy.routing.gpu.used")}</dt><dd class="tabular">${gib(memory.usedMb)}</dd></div>
      <div class="deploy-fact"><dt class="small muted">${t("deploy.routing.gpu.allocatable")}</dt><dd class="tabular" data-testid="deploy.routing.allocatable">${gib(memory.allocatableMb)}</dd></div>
      <div class="deploy-fact"><dt class="small muted">${t("deploy.routing.gpu.protect", { pct: memory.protectPct === null ? "—" : fmt.number(memory.protectPct, 1) })}</dt><dd class="tabular" data-testid="deploy.routing.headroom">${gib(memory.protectHeadroomMb)}</dd></div>
      <div class="deploy-fact"><dt class="small muted">${t("deploy.routing.gpu.reserve")}</dt><dd class="tabular">${gib(memory.reserveMb)}</dd></div>
      <div class="deploy-fact"><dt class="small muted">${t("deploy.routing.gpu.recommended")}</dt><dd class="tabular" data-testid="deploy.routing.recommended">${gib(memory.recommendedMb)}</dd></div>
    </dl>` : html`<p class="muted">${t("deploy.routing.gpu.none")}</p>`}
  <//>`;
}

function CapabilityCard({ fleet }) {
  const { t } = useT();
  const counts = fleet?.routing?.capabilityCounts && typeof fleet.routing.capabilityCounts === "object" ? fleet.routing.capabilityCounts : {};
  return html`<${Card} title=${t("deploy.routing.capabilities.title")} testid="deploy.routing.capabilities">
    <p class="small muted">${t("deploy.routing.capabilities.hint")}</p>
    <ul class="deploy-capcounts">
      ${PREVIEW_CAPABILITIES.map((id) => html`<li key=${id} data-testid="deploy.routing.capability" data-capability=${id}>
        <span>${t(tk("deploy.capability.", id))}</span><strong class="tabular">${Number.isFinite(Number(counts[id])) ? Number(counts[id]) : 0}</strong>
      </li>`)}
    </ul>
  <//>`;
}

function GatewayCard({ managers }) {
  const services = useServices();
  const { t } = useT();
  const origin = globalThis.location?.origin || "";
  const gateway = services.bootstrap?.gateway || {};
  const urls = [
    gateway.autoOpenAi ? { id: "auto", label: t("deploy.routing.gateway.auto"), url: `${origin}${gateway.autoOpenAi}` } : null,
    gateway.autoClaude ? { id: "claude", label: t("deploy.routing.gateway.claude"), url: `${origin}${gateway.autoClaude}` } : null,
    ...managers.map((item) => ({ id: item.id, label: t("deploy.routing.gateway.manager", { manager: item.id }), url: `${origin}/gateway/${encodeURIComponent(item.id)}/openai/v1` })),
  ].filter(Boolean);

  async function copy(url) {
    const ok = await copyText(url);
    services.toasts?.push?.({ level: ok ? "success" : "warn", title: t(ok ? "shell.palette.copied" : "common.copyFailed") });
  }

  return html`<${Card} title=${t("deploy.routing.gateway.title")} testid="deploy.routing.gateway">
    <ul class="deploy-endpoints">
      ${urls.map((item) => html`<li key=${item.id} data-testid="deploy.routing.gateway-url">
        <span class="small muted">${item.label}</span><code class="code-inline deploy-url">${item.url}</code>
        <${Button} size="sm" label=${t("deploy.endpoint.copyFor", { name: item.label })} onClick=${() => copy(item.url)} testid="deploy.routing.gateway-copy">${t("common.copy")}<//>
      </li>`)}
    </ul>
  <//>`;
}

function PreviewCard({ fleet }) {
  const { api } = useServices();
  const i18n = useT();
  const { t } = i18n;
  const id = useId();
  const [capability, setCapability] = useState("text");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const body = previewBody({ capability, model });
    setBusy(true);
    try {
      setResult(previewOutcome(await api.post("/api/fleet/route-preview", body), { capability: body.capability }));
    } catch (error) {
      setResult(previewOutcome(error, { capability: body.capability }));
    } finally {
      setBusy(false);
    }
  }

  return html`<${Card} title=${t("deploy.routing.preview.title")} testid="deploy.routing.preview">
    <form class="stack-sm" onSubmit=${submit} data-testid="deploy.preview.form">
      <p class="small muted">${t("deploy.routing.preview.hint")}</p>
      <div class="deploy-preview-grid">
        <label class="field" for=${`${id}-cap`}><span class="field-label">${t("deploy.routing.preview.capability")}</span>
          <select id=${`${id}-cap`} class="select" value=${capability} data-testid="deploy.preview.capability" onChange=${(event) => setCapability(event.currentTarget.value)}>
            ${PREVIEW_CAPABILITIES.map((item) => html`<option key=${item} value=${item} selected=${item === capability}>${t(tk("deploy.capability.", item))}</option>`)}
          </select></label>
        <label class="field" for=${`${id}-model`}><span class="field-label">${t("deploy.routing.preview.model")}</span>
          <input id=${`${id}-model`} class="input" list=${`${id}-models`} autocomplete="off" placeholder=${t("deploy.routing.preview.modelHint")} value=${model}
            data-testid="deploy.preview.model" onInput=${(event) => setModel(event.currentTarget.value)} />
          <datalist id=${`${id}-models`}>${previewModels(fleet).map((name) => html`<option key=${name} value=${name}></option>`)}</datalist></label>
      </div>
      <div><${Button} type="submit" busy=${busy} testid="deploy.preview.submit">${t("deploy.routing.preview.submit")}<//></div>
    </form>
    <div class=${`deploy-preview-result${result ? (result.ok ? " ok" : " fail") : ""}`} role="status" aria-live="polite" aria-busy=${busy ? "true" : "false"} data-testid="deploy.preview.result">
      ${result === null ? html`<span class="muted">${t("deploy.routing.preview.idle")}</span>`
        : result.ok ? html`<strong>${t("deploy.routing.preview.routed", { model: result.model })}</strong>
          <span>${t("deploy.routing.preview.target", { manager: result.manager, instance: result.instance, capability: result.capability })}</span>
          <span>${t("deploy.routing.preview.why", { reason: result.reason || "—" })}</span>`
          : html`<strong>${t("deploy.routing.preview.unroutable", { code: result.code })}</strong>
            <span>${result.message}</span>
            <span>${t("deploy.routing.preview.asked", { capability: result.capability })}</span>`}
    </div>
  <//>`;
}

export default function DeploymentsRouting() {
  const services = useServices();
  const { api, bootstrap, cache, toasts } = services;
  const i18n = useT();
  const { t } = i18n;
  const fmt = useFormat();
  const role = useRole();
  const owner = role === "owner";
  const managers = Array.isArray(bootstrap?.managers) ? bootstrap.managers : [];
  const [saving, setSaving] = useState(false);
  const [adopted, setAdopted] = useState(null);
  const [pct, setPct] = useState("");
  const [reserve, setReserve] = useState("");
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState("");

  // Its own key under "fleet" (events and saves refresh it with the rest), so only this fetch stamps the read.
  const fleetQuery = useQuery(["fleet", "routing"], async () => {
    const startedAt = Date.now();
    return stamp(await api.get("/api/fleet", { guard: FleetGuard }), startedAt);
  }, { ttlMs: 5000, refetchMs: 10000 });
  // A read that started before the last save may carry the old settings.
  const read = fleetQuery.data || null;
  const readStartedAt = read ? startedAtOf.get(read) : undefined;
  const stale = adopted && read && Number.isFinite(readStartedAt) && readStartedAt < adopted.at;
  const fleet = adopted && (!read || stale) ? adopted.fleet : read;
  const settings = fleet?.settings && typeof fleet.settings === "object" ? fleet.settings : {};
  const mode = FLEET_MODES.includes(settings.mode) ? settings.mode : "";

  // The form follows the server's settings until the person edits it.
  useEffect(() => {
    if (dirty) return;
    setPct(Number.isFinite(Number(settings.maxUtilizationPct)) ? String(settings.maxUtilizationPct) : "");
    setReserve(gibOfMb(settings.reserveMb));
  }, [settings.maxUtilizationPct, settings.reserveMb, dirty]);

  async function save(body, done) {
    if (saving || !owner) return;
    setSaving(true);
    setProblem("");
    try {
      const response = await api.post("/api/fleet/settings", body);
      const next = response?.fleet && typeof response.fleet === "object" ? response.fleet : { ...(fleet || {}), instances: fleet?.instances || [] };
      const merged = { ...next, settings: { ...(next.settings || {}), ...(response?.settings || {}) } };
      setAdopted({ fleet: merged, at: Date.now() });
      setDirty(false);
      cache.invalidate(["fleet"]);
      toasts?.push?.({ level: "success", title: done(merged.settings) });
    } catch (error) {
      toasts?.push?.({ level: "error", title: describeError(error, i18n), requestId: error?.requestId || null });
    } finally {
      setSaving(false);
    }
  }

  function chooseMode(id) {
    const body = modeBody(id);
    if (!body || id === mode) return;
    save(body, (saved) => t("deploy.routing.modeSaved", { mode: t(tk("deploy.routing.mode.", saved.mode || id)) }));
  }

  function savePolicy(event) {
    event.preventDefault();
    const body = policyBody({ maxUtilizationPct: pct, reserveGiB: reserve });
    if (!body) {
      setProblem(t("deploy.routing.policy.invalid", { min: POLICY_LIMITS.pctMin, max: POLICY_LIMITS.pctMax, reserveMax: POLICY_LIMITS.reserveMax }));
      return;
    }
    save(body, (saved) => t("deploy.routing.policySaved", { pct: fmt.number(Number(saved.maxUtilizationPct ?? body.maxUtilizationPct), 1), reserve: gibText(fmt, Number(saved.reserveMb ?? body.reserveMb)) }));
  }

  const loading = !fleet && !fleetQuery.error;
  return html`<div class="stack deploy" data-ready=${loading ? "false" : "true"} data-testid="deploy.routing.root">
    <${PageHeader} title=${t("deploy.routing.title")} subtitle=${t("deploy.routing.subtitle")}
      actions=${html`<${Button} icon="refresh-cw" onClick=${() => cache.invalidate(["fleet"])} testid="deploy.routing.refresh">${t("deploy.list.refresh")}<//>`}
      breadcrumbs=${[{ label: t("shell.nav.deployments"), href: "/deployments" }, { label: t("deploy.routing.title") }]} />
    ${fleetQuery.error && !fleet ? html`<div class="notice notice-danger" role="alert" data-testid="deploy.routing.error">${describeError(fleetQuery.error, i18n)}</div>` : null}
    ${!owner ? html`<p class="notice" role="status" data-testid="deploy.routing.readonly">${t("deploy.routing.readonly")}</p>` : null}
    <${Card} title=${t("deploy.routing.modes.title")} testid="deploy.routing.mode">
      <p class="small muted">${t("deploy.routing.modes.hint")}</p>
      <div class="row deploy-modes" role="group" aria-label=${t("deploy.routing.modes.label")} data-testid="deploy.mode.group">
        ${FLEET_MODES.map((id) => html`<button key=${id} type="button" class="btn deploy-mode" aria-pressed=${mode === id ? "true" : "false"} data-fleet-mode=${id}
          disabled=${saving || !owner || !fleet} data-testid=${`deploy.mode.${id}`} onClick=${() => chooseMode(id)}>${t(tk("deploy.routing.mode.", id))}</button>`)}
      </div>
    <//>
    <${Card} title=${t("deploy.routing.policy.title")} testid="deploy.routing.policy">
      <form class="deploy-policy" noValidate onSubmit=${savePolicy} data-testid="deploy.policy.form">
        <p class="small muted">${t("deploy.routing.policy.hint")}</p>
        <div class="deploy-preview-grid">
          <label class="field"><span class="field-label">${t("deploy.routing.policy.pct")}</span>
            <input class="input" type="number" inputmode="decimal" min=${POLICY_LIMITS.pctMin} max=${POLICY_LIMITS.pctMax} step="0.5" value=${pct} disabled=${!owner || saving}
              data-testid="deploy.policy.pct" onInput=${(event) => { setPct(event.currentTarget.value); setDirty(true); }} /></label>
          <label class="field"><span class="field-label">${t("deploy.routing.policy.reserve")}</span>
            <input class="input" type="number" inputmode="decimal" min=${POLICY_LIMITS.reserveMin} max=${POLICY_LIMITS.reserveMax} step="0.5" value=${reserve} disabled=${!owner || saving}
              data-testid="deploy.policy.reserve" onInput=${(event) => { setReserve(event.currentTarget.value); setDirty(true); }} /></label>
        </div>
        ${problem ? html`<p class="field-error" role="alert" data-testid="deploy.policy.problem">${problem}</p>` : null}
        <div><${Button} type="submit" variant="primary" busy=${saving} disabled=${!owner} testid="deploy.policy.save">${t("deploy.routing.policy.save")}<//></div>
      </form>
    <//>
    <div class="deploy-routing-grid">
      <${GpuCard} fleet=${fleet} />
      <${CapabilityCard} fleet=${fleet} />
    </div>
    <${PreviewCard} fleet=${fleet} />
    <${GatewayCard} managers=${managers} />
  </div>`;
}
