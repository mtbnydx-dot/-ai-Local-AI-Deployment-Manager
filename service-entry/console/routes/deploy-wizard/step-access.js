// Wizard step 5, "Access" (07 §6.3): who can reach the model.
//
//   Network    Local (this computer only) or LAN (other devices on the network)
//   API key    "auto" generates the direct-port key into the manager's secret store: the
//              console never shows or stores the plaintext (the draft only holds the mode).
//              LAN without a key is a red warning.
//   Gateway    the gateway reaches the model by its served name, whatever the port is bound to
//   Idle       the manager's idle-unload policy as it applies to this model (read-only here)
//
// The catalog's own `network-security` parameters (a key you choose yourself is a
// write-only secret) sit under "Advanced".

import { accessIssues, idleSummary } from "../../lib/capabilities-model.js";
import { withValue } from "../../lib/schema-form-model.js";
import { applySuggestion, groupsForStep } from "../../lib/wizard-state.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { EmptyState } from "../../components/empty-state.js";
import { SchemaForm } from "../../components/schema-form.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useId, useMemo } from "../../ui/vendor.js";

function Choice({ name, value, options, onChange, label, testid }) {
  const group = useId();
  return html`<fieldset class="wizard-choice" data-testid=${testid}>
    <legend class="field-label">${label}</legend>
    ${options.map((option) => html`<label key=${option.id} class=${`wizard-choice-opt${value === option.id ? " is-selected" : ""}`} data-option=${option.id}>
      <input type="radio" name=${`${group}-${name}`} value=${option.id} checked=${value === option.id} onChange=${() => onChange(option.id)} data-testid=${`${testid}.option`} />
      <span><strong>${option.label}</strong><span class="small muted wizard-choice-hint">${option.hint}</span></span>
    </label>`)}
  </fieldset>`;
}

function IdleCard({ managerId, servedName }) {
  const { api } = useServices();
  const { t } = useT();
  const idle = useQuery(["wizard", "idle", managerId], () => api.manager(managerId).get("/idle-unload"), { ttlMs: 20000, enabled: Boolean(managerId) });
  const summary = idleSummary(idle.data?.settings, servedName);
  if (!summary) return null;
  return html`<${Card} title=${t("models.wizard.access.idle.title")} testid="wizard.access.idle">
    <p data-testid="wizard.access.idle-state" data-enabled=${String(summary.enabled)} data-excluded=${String(summary.excluded)}>
      ${!summary.enabled ? t("models.wizard.access.idle.off")
        : summary.excluded ? t("models.wizard.access.idle.excluded", { name: servedName })
          : t("models.wizard.access.idle.on", { minutes: summary.idleMinutes })}
      ${summary.enabled && !summary.excluded ? html` ${summary.wakeOnDemand ? t("models.wizard.access.idle.wake") : t("models.wizard.access.idle.noWake")}` : null}
    </p>
    <p class="small muted">${t("models.wizard.access.idle.hint")}</p>
  <//>`;
}

export default function StepAccess({ draft, update, plan, catalog, goto }) {
  const { t } = useT();
  const { bootstrap } = useServices();
  const issues = accessIssues(draft);
  const groups = useMemo(() => groupsForStep(catalog, "access"), [catalog]);
  if (!draft.modelRef || !draft.engineId) {
    return html`<${EmptyState} testid="wizard.step.access" icon="info" title=${t(draft.modelRef ? "models.wizard.resources.noEngine" : "models.wizard.engine.noModel")}
      action=${{ label: t(draft.modelRef ? "models.wizard.step.engine" : "models.wizard.step.model"), href: `/deployments/new?step=${draft.modelRef ? "engine" : "model"}` }} />`;
  }
  const servedName = draft.instance.servedName || (plan.plan?.values?.servedName?.value ?? "") || "";
  const gateway = bootstrap?.gateway?.autoOpenAi || "";
  const change = (id, value, field) => update((now) => ({ ...now, values: withValue(now.values, id, value, { keepNull: field?.secret }) }));
  const reset = (id) => update((now) => ({ ...now, values: withValue(now.values, id, undefined) }));
  const suggestion = (id, value) => update((now) => applySuggestion(now, { param: id, value }));
  return html`<div class="stack" data-testid="wizard.step.access">
    <${Card} title=${t("models.wizard.access.network.title")} testid="wizard.access.network">
      <${Choice} name="network" value=${draft.access.networkAccess} onChange=${(networkAccess) => update({ access: { networkAccess } })} testid="wizard.access.network-choice"
        label=${t("models.wizard.access.network.label")}
        options=${[
          { id: "local", label: t("models.wizard.access.network.local"), hint: t("models.wizard.access.network.localHint") },
          { id: "lan", label: t("models.wizard.access.network.lan"), hint: t("models.wizard.access.network.lanHint") },
        ]} />
    <//>
    <${Card} title=${t("models.wizard.access.key.title")} testid="wizard.access.key">
      <${Choice} name="key" value=${draft.access.apiKey} onChange=${(apiKey) => update({ access: { apiKey } })} testid="wizard.access.key-choice"
        label=${t("models.wizard.access.key.label")}
        options=${[
          { id: "auto", label: t("models.wizard.access.key.auto"), hint: t("models.wizard.access.key.autoHint") },
          { id: "none", label: t("models.wizard.access.key.none"), hint: t("models.wizard.access.key.noneHint") },
        ]} />
      ${issues.lanWithoutKey ? html`<div class="notice notice-danger" role="alert" data-testid="wizard.access.lan-warning">${t("models.wizard.access.key.lanWarning")}</div>` : null}
      ${draft.access.apiKey === "auto" ? html`<p class="small muted" data-testid="wizard.access.key-note">${t("models.wizard.access.key.note")}</p>` : null}
    <//>
    <${Card} title=${t("models.wizard.access.gateway.title")} testid="wizard.access.gateway">
      <dl class="kv" data-testid="wizard.access.gateway-facts">
        <dt>${t("models.wizard.access.gateway.served")}</dt>
        <dd class="mono" data-user-content="" data-testid="wizard.access.served">${servedName || t("models.wizard.access.gateway.servedAuto")}</dd>
        <dt>${t("models.wizard.access.gateway.route")}</dt>
        <dd class="mono" data-testid="wizard.access.route">${gateway || t("models.wizard.access.gateway.routeUnknown")}</dd>
        <dt>${t("models.wizard.access.gateway.port")}</dt>
        <dd data-testid="wizard.access.port">${draft.instance.port ? t(issues.lan ? "models.wizard.access.gateway.portLan" : "models.wizard.access.gateway.portLocal", { port: String(draft.instance.port) }) : t("models.wizard.access.gateway.portAuto")}</dd>
      </dl>
      <p class="small muted">${t("models.wizard.access.gateway.hint")}</p>
      <${Button} size="sm" variant="ghost" onClick=${() => goto("resources")} testid="wizard.access.edit-served">${t("models.wizard.access.gateway.edit")}<//>
    <//>
    <${IdleCard} managerId=${draft.managerId} servedName=${servedName} />
    ${catalog && groups.length ? html`<${Card} title=${t("models.wizard.access.advanced")} testid="wizard.access.form">
      <${SchemaForm} catalog=${catalog} plan=${plan.plan} values=${draft.values} mode="launch" groups=${groups}
        onChange=${change} onReset=${reset} onApplySuggestion=${suggestion} testid="wizard.access.schema-form" />
    <//>` : null}
  </div>`;
}
