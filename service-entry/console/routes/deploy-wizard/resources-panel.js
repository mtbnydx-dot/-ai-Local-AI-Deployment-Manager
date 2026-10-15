// The resource panel of wizard step 3 (07 §6.3): what the plan reserves.
//
//   - the admission verdict (Fits / Tight / Does not fit) with its message;
//   - a GpuMemoryBar per GPU from `plan.memory.breakdown` and `perGpuMb`;
//   - the reservation and the KV pool it leaves;
//   - a label for `memory.policy` (an unknown policy shows its raw name in mono);
//   - the RAM bar and `models.fit.spill` when weights, experts or KV sit in RAM;
//   - the FitSolver over POST /api/models/:id/fit-grid. Where that route is not
//     served (404 → endpoint_unavailable) or fails, the FitResult suggestions
//     are Apply chips instead.
//
// Loaded by step-resources.js on demand.

import { admissionOf, fitOf, gpuSegments, missingEndpoint } from "../../lib/resources-model.js";
import { applySuggestion } from "../../lib/wizard-state.js";
import { FitBar, fitModel, policyKey } from "../../components/fit-bar.js";
import { FitSolver, gridKvDtypes } from "../../components/fit-solver.js";
import { GpuMemoryBar } from "../../components/gpu-memory-bar.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo } from "../../ui/vendor.js";
import { guards } from "./guards.js";

const enc = encodeURIComponent;
const CONCURRENCY_LADDER = Object.freeze([1, 2, 4, 8]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The fit-grid of the draft's engine for the picked GPUs: { grid, loading, unavailable, error, refetch }. */
function useFitGrid({ cardId, draft, catalog }) {
  const { api } = useServices();
  const body = useMemo(() => ({
    engineId: draft.engineId,
    ...(draft.runtimeId ? { runtimeId: draft.runtimeId } : {}),
    ...(draft.recipeId ? { recipeId: draft.recipeId } : {}),
    gpuIds: draft.gpus,
    kvDtypes: gridKvDtypes(draft.engineId, catalog),
    concurrency: [...CONCURRENCY_LADDER],
  }), [draft.engineId, draft.runtimeId, draft.recipeId, draft.gpus.join(","), catalog]);
  const query = useQuery(["models", "fit-grid", cardId, JSON.stringify(body)], () => api.post(`/api/models/${enc(cardId)}/fit-grid`, body, { guard: guards.fitGrid }), {
    ttlMs: 60000,
    enabled: Boolean(cardId && draft.engineId),
    keepPrevious: false,
  });
  return {
    grid: query.data && Array.isArray(query.data.cells) && query.data.cells.length ? query.data : null,
    loading: Boolean(cardId) && !query.data && !query.error,
    unavailable: missingEndpoint(query.error),
    error: query.error && !missingEndpoint(query.error) ? query.error : null,
    refetch: query.refetch,
  };
}

function PolicyLabel({ policy }) {
  const { t } = useT();
  const key = policyKey(policy);
  return html`<span data-testid="wizard.res.policy" data-policy=${policy}>${key
    ? html`${t(key)} <code class="code-inline xsmall">${policy}</code>`
    : html`<code class="code-inline" data-testid="wizard.res.policy-raw">${policy}</code>`}</span>`;
}

/** @param plan the usePlan() state  @param gpus hostGpus()  @param current the effective values the solver's diff starts from */
export default function ResourcePanel({ draft, update, plan, catalog, cardId, gpus, current }) {
  const { t } = useT();
  const fmt = useFormat();
  const memory = plan.plan?.memory || null;
  const fit = fitOf(memory, gpus);
  const verdict = admissionOf(plan.plan);
  const grid = useFitGrid({ cardId, draft, catalog });
  const gpuIds = memory && isObject(memory.perGpuMb) && Object.keys(memory.perGpuMb).length ? Object.keys(memory.perGpuMb) : draft.gpus;
  const reserve = finite(memory?.admissionRequestMb);
  const poolTokens = finite(memory?.kvPoolTokens);
  const apply = (values) => update((draftNow) => {
    let next = draftNow;
    for (const [id, value] of Object.entries(values)) next = applySuggestion(next, { param: id, value });
    return next;
  });
  if (!memory && !verdict) {
    return html`<div class="stack-sm" data-testid="wizard.res.panel" data-state="empty">
      ${plan.status === "updating"
        ? html`<div aria-busy="true"><${Skeleton} shape="line" rows=${3} /></div>`
        : html`<p class="muted" data-testid="wizard.res.panel-empty">${t("models.wizard.resources.noPlan")}</p>`}
    </div>`;
  }
  return html`<div class="stack-sm" data-testid="wizard.res.panel" data-state=${plan.status === "updating" ? "updating" : "ready"}>
    ${verdict ? html`<div class="stack-sm" data-testid="wizard.res.admission" data-verdict=${verdict.verdict}>
      <${StatusBadge} status=${verdict.status} label=${t(verdict.key)} testid="wizard.res.verdict" />
      ${verdict.message ? html`<p class="small" data-user-content="" data-testid="wizard.res.admission-message">${verdict.message}</p>` : null}
    </div>` : null}
    ${memory ? html`<div class="stack-sm" data-testid="wizard.res.gpu-bars">
      ${gpuIds.map((id) => {
        const gpu = gpus.find((item) => item.id === id) || { id, name: "", totalMb: null, usedMb: null };
        const name = gpu.name ? `${t("models.wizard.model.gpu", { id })} · ${gpu.name}` : t("models.wizard.model.gpu", { id });
        return html`<${GpuMemoryBar} key=${id} gpu=${{ id, name, totalMb: gpu.totalMb || 0 }} segments=${gpuSegments(memory, id)}
          budgetMb=${finite(fit?.budgetMb?.[id]) ?? undefined} admissionMb=${reserve ?? undefined} otherTenantsMb=${gpu.usedMb || 0} testid="wizard.res.gpu-bar" />`;
      })}
    </div>` : null}
    ${reserve !== null && poolTokens !== null ? html`<p class="small" data-testid="wizard.res.kv-pool">${t("models.fit.kvPool", {
      reserve: fmt.number(reserve / 1024, 1),
      pool: fmt.number((finite(memory.breakdown?.kv) || 0) / 1024, 1),
      tokens: fmt.number(poolTokens, 0),
      n: fmt.number(finite(memory.maxFullLengthRequests) || 0, 0),
    })}</p>` : null}
    ${memory?.policy ? html`<p class="small"><span class="muted">${t("models.fit.policy.label")}</span> <${PolicyLabel} policy=${memory.policy} /></p>` : null}
    ${fitModel(fit)?.spill ? html`<${FitBar} fit=${fit} ramOnly testid="wizard.res.ram" />` : null}
    <${FitSolver} grid=${grid.grid} fit=${fit} current=${current} catalog=${catalog} loading=${grid.loading} unavailable=${grid.unavailable} error=${grid.error}
      onRetry=${grid.refetch} onApply=${apply} testid="wizard.res.solver" />
  </div>`;
}
