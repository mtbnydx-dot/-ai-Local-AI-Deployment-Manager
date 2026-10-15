// Wizard step 3, "Resources" (07 §6.3, 02 §18 step 4 "Plans"): where the model
// runs and how much of the GPUs it may take.
//
//   Instance   replace one running instance or start a parallel one; name and
//              port, the port checked live (GET /api/m/:id/port-check).
//   GPUs       picker cards with free / total memory and other tenants.
//   Goals      four chips; each calls POST /api/launch/recommend and shows
//              PlanCards. A pick shows a DiffTable first and only Apply copies
//              its values in, marked `planner` (resources-goals.js).
//   Settings   the SchemaForm of this step's groups; the `contextLength` field
//              carries a FitBar that follows the plan (resources-form.js).
//   Resources  the admission verdict, a GpuMemoryBar per GPU, the KV pool, the
//              memory policy and the FitSolver (resources-panel.js). Beside the
//              form on wide screens; below md a chip opens it in a Drawer.
//
// The heavy parts load on demand (07 §11: a route module's own static imports
// stay under 60 KB). The pure rules are in lib/resources-model.js.

import { buildDeployments } from "../../lib/deployments-model.js";
import { engineIndex } from "../../lib/compat-model.js";
import { hostGpus, admissionOf, currentValues } from "../../lib/resources-model.js";
import { EnginesResponseGuard } from "../../lib/schemas.js";
import { Card } from "../../components/card.js";
import { Drawer } from "../../components/drawer.js";
import { EmptyState } from "../../components/empty-state.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useDebounced, useFormat, useMediaQuery, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useMemo, useState } from "../../ui/vendor.js";
import { compatKey, loadCompatibility, useCard } from "./card-source.js";

const MIB = 1048576;
const PORT_DEBOUNCE_MS = 400;
const NARROW = "(max-width: 1023px)";

function list(value) {
  return Array.isArray(value) ? value : [];
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---- parts loaded on demand -------------------------------------------------------------------

const PARTS = Object.freeze({
  goals: () => import("./resources-goals.js"),
  form: () => import("./resources-form.js"),
  panel: () => import("./resources-panel.js"),
});

function LazyPart({ part, props }) {
  const { t } = useT();
  const [state, setState] = useState({ part: "", Component: null, failed: false });
  useEffect(() => {
    let alive = true;
    PARTS[part]().then(
      (module) => alive && setState({ part, Component: module.default, failed: false }),
      () => alive && setState({ part, Component: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [part]);
  if (state.failed) return html`<p class="muted" data-testid=${`wizard.res.part-failed.${part}`}>${t("models.wizard.pendingBody")}</p>`;
  if (!state.Component || state.part !== part) return html`<div aria-busy="true" data-testid=${`wizard.res.part-loading.${part}`}><${Skeleton} shape="line" rows=${3} /></div>`;
  const Component = state.Component;
  return html`<${Component} ...${props} />`;
}

// ---- instance --------------------------------------------------------------------------------

function InstanceCard({ draft, update }) {
  const { api } = useServices();
  const { t } = useT();
  const managerId = draft.managerId;
  const instance = draft.instance;
  const running = useQuery(["wizard", "instances", managerId], async () => {
    const body = await api.manager(managerId).get("/instances");
    return buildDeployments({ managers: [{ managerId, instances: body }] }).rows.filter((row) => row.managerId === managerId);
  }, { ttlMs: 10000, enabled: Boolean(managerId) });
  const rows = list(running.data);
  const target = rows.find((row) => row.instanceId === instance.targetInstanceId) || null;
  const port = useDebounced(instance.port, PORT_DEBOUNCE_MS);
  const portCheck = useQuery(["wizard", "port", managerId, port], () => api.manager(managerId).get("/port-check", { query: { port } }), { ttlMs: 5000, enabled: Boolean(managerId && port) });
  const check = port && portCheck.data?.port === port ? portCheck.data : null;
  const ownPort = instance.mode === "replace" && target && finite(target.port) === port;
  const busy = check?.available === false && !ownPort && check?.isOwnContainer !== true;
  const set = (patch) => update({ instance: patch });
  const slot = instance.mode === "replace" ? "targetInstanceId" : "instanceId";
  return html`<${Card} title=${t("models.wizard.resources.instance")} testid="wizard.res.instance">
    <div class="stack-sm">
      <div class="sf-seg" role="group" aria-label=${t("models.wizard.resources.mode")} data-testid="wizard.res.mode">
        ${[["replace", t("models.wizard.resources.mode.replace")], ["parallel", t("models.wizard.resources.mode.parallel")]].map(([id, label]) => html`<button key=${id} type="button" class="sf-seg-opt"
          aria-pressed=${instance.mode === id ? "true" : "false"} onClick=${() => set({ mode: id })} data-testid="wizard.res.mode-option" data-mode=${id}>${label}</button>`)}
      </div>
      <p class="small muted">${instance.mode === "replace" ? t("models.wizard.resources.mode.replaceHint") : t("models.wizard.resources.mode.parallelHint")}</p>
      ${instance.mode === "replace" ? html`<div class="field">
        <label class="field-label" for="wizard-res-target">${t("models.wizard.resources.target")}</label>
        <select id="wizard-res-target" class="input" value=${instance.targetInstanceId} onChange=${(event) => set({ targetInstanceId: event.currentTarget.value })} data-testid="wizard.res.target">
          <option value="">${rows.length ? t("models.wizard.resources.targetPick") : t("models.wizard.resources.targetNone")}</option>
          ${rows.map((row) => html`<option key=${row.instanceId} value=${row.instanceId}>${row.model} · ${row.instanceId}</option>`)}
        </select>
        ${!instance.targetInstanceId && rows.length ? html`<p class="small muted" data-testid="wizard.res.target-hint">${t("models.wizard.resources.targetHint")}</p>` : null}
      </div>` : null}
      <div class="field">
        <label class="field-label" for="wizard-res-name">${t("models.wizard.resources.name")}</label>
        <input id="wizard-res-name" class="input mono" type="text" value=${instance[slot]} autocomplete="off" spellcheck="false"
          onInput=${(event) => set({ [slot]: event.currentTarget.value.trim() })} data-testid="wizard.res.name" />
      </div>
      <div class="field">
        <label class="field-label" for="wizard-res-served">${t("models.wizard.resources.servedName")}</label>
        <input id="wizard-res-served" class="input mono" type="text" value=${instance.servedName} autocomplete="off" spellcheck="false"
          onInput=${(event) => set({ servedName: event.currentTarget.value.trim() })} data-testid="wizard.res.served" />
      </div>
      <div class="field">
        <label class="field-label" for="wizard-res-port">${t("models.wizard.resources.port")}</label>
        <input id="wizard-res-port" class="input num" type="number" min="1024" max="65535" inputmode="numeric" value=${instance.port ?? ""} aria-describedby="wizard-res-port-status"
          onInput=${(event) => {
            const text = event.currentTarget.value.trim();
            set({ port: text === "" ? null : Number(text) });
          }} data-testid="wizard.res.port" />
        <p id="wizard-res-port-status" class=${`small ${busy ? "text-danger" : "muted"}`} role="status" data-testid="wizard.res.port-status" data-state=${!instance.port ? "idle" : !check ? "checking" : busy ? "busy" : "free"}>
          ${!instance.port ? t("models.wizard.resources.portAuto") : !check ? t("models.wizard.resources.portChecking") : busy ? t("models.wizard.resources.portBusy", { detail: check.detail || "" }) : t("models.wizard.resources.portFree")}
        </p>
      </div>
    </div>
  <//>`;
}

// ---- GPUs --------------------------------------------------------------------------------------

function GpuPicker({ draft, update, gpus, loading }) {
  const { t } = useT();
  const fmt = useFormat();
  if (loading) return html`<${Card} title=${t("models.wizard.resources.gpus")} testid="wizard.res.gpus"><div aria-busy="true"><${Skeleton} shape="line" rows=${2} /></div><//>`;
  const toggle = (id) => update({ gpus: draft.gpus.includes(id) ? draft.gpus.filter((item) => item !== id) : [...draft.gpus, id] });
  const gib = (mb) => fmt.bytes(mb * MIB, { unit: "GiB" });
  return html`<${Card} title=${t("models.wizard.resources.gpus")} testid="wizard.res.gpus">
    ${gpus.length ? html`<div class="stack-sm">
      <p class="small muted">${draft.gpus.length ? t("models.wizard.resources.gpusPicked", { gpus: draft.gpus.join(", ") }) : t("models.wizard.resources.gpusAll")}</p>
      <ul class="wizard-gpu-cards">
        ${gpus.map((gpu) => html`<li key=${gpu.id}>
          <button type="button" class="wizard-gpu-card" aria-pressed=${draft.gpus.includes(gpu.id) ? "true" : "false"} onClick=${() => toggle(gpu.id)} data-testid="wizard.res.gpu" data-gpu=${gpu.id}>
            <strong>${t("models.wizard.model.gpu", { id: gpu.id })}</strong>
            <span class="small muted" data-user-content="">${gpu.name}</span>
            ${gpu.totalMb ? html`<span class="small num">${gpu.freeMb !== null ? t("models.wizard.model.gpuFree", { free: gib(gpu.freeMb), total: gib(gpu.totalMb) }) : gib(gpu.totalMb)}</span>` : null}
            ${gpu.usedMb ? html`<span class="small muted num" data-testid="wizard.res.gpu-tenants">${t("models.wizard.resources.gpuTenants", { used: gib(gpu.usedMb) })}</span>` : null}
          </button>
        </li>`)}
      </ul>
    </div>` : html`<p class="muted" data-testid="wizard.res.gpus-none">${t("models.wizard.model.noGpu")}</p>`}
  <//>`;
}

// ---- the page ------------------------------------------------------------------------------------

export default function StepResources({ draft, update, plan, catalog }) {
  const { api } = useServices();
  const { t } = useT();
  const narrow = useMediaQuery(NARROW);
  const [drawer, setDrawer] = useState(false);
  const { card, loading: cardLoading } = useCard(draft.modelRef);
  const cardId = card?.cardId || draft.modelRef?.cardId || "";
  const engines = useQuery(["engines"], () => api.get("/api/engines", { guard: EnginesResponseGuard }), { ttlMs: 10000 });
  const index = useMemo(() => engineIndex(engines.data), [engines.data]);
  const compat = useQuery(compatKey(cardId, []), () => loadCompatibility(api, cardId, []), { ttlMs: 30000, enabled: Boolean(cardId) });
  const gpus = useMemo(() => hostGpus(compat.data?.host), [compat.data]);
  const current = useMemo(() => currentValues(plan.plan, draft), [plan.plan, draft.values]);

  if (!draft.modelRef || !draft.engineId) {
    return html`<${EmptyState} testid="wizard.step.resources" icon="info" title=${t(draft.modelRef ? "models.wizard.resources.noEngine" : "models.wizard.engine.noModel")}
      action=${{ label: t(draft.modelRef ? "models.wizard.step.engine" : "models.wizard.step.model"), href: `/deployments/new?step=${draft.modelRef ? "engine" : "model"}` }} />`;
  }
  const verdict = admissionOf(plan.plan);
  const panel = html`<${LazyPart} part="panel" props=${{ draft, update, plan, catalog, cardId, gpus, current }} />`;
  return html`<div class="wizard-res" data-testid="wizard.step.resources">
    <div class="stack wizard-res-main">
      <${InstanceCard} draft=${draft} update=${update} />
      <${GpuPicker} draft=${draft} update=${update} gpus=${gpus} loading=${cardLoading || (Boolean(cardId) && !compat.data && !compat.error)} />
      <${LazyPart} part="goals" props=${{ draft, update, cardId, catalog, engines: index, current }} />
      <${LazyPart} part="form" props=${{ draft, update, plan, catalog, gpus }} />
    </div>
    ${narrow ? html`<div class="wizard-res-chip" data-testid="wizard.res.chip-bar">
      <button type="button" class="chip wizard-res-chip-btn" onClick=${() => setDrawer(true)} data-testid="wizard.res.chip" data-verdict=${verdict?.verdict || "none"}>
        ${t("models.wizard.resources.panel")}${verdict ? html` · ${t(verdict.key)}` : null}
      </button>
    </div>
    <${Drawer} open=${drawer} title=${t("models.wizard.resources.panel")} width=${480} onClose=${() => setDrawer(false)} testid="wizard.res.drawer">${panel}<//>`
    : html`<aside class="wizard-res-panel" aria-label=${t("models.wizard.resources.panel")} data-testid="wizard.res.aside">
      <${Card} title=${t("models.wizard.resources.panel")} testid="wizard.res.panel-card">${panel}<//>
    </aside>`}
  </div>`;
}
