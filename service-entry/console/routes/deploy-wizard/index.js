// /deployments/new (07 §6.3): the deployment wizard's shell. It owns the draft
// (lib/wizard-state.js), keeps it in sessionStorage as `console.wizard.draft`
// (no secret and no extraEnv value, so those are retyped after a reload),
// follows the launch plan of the draft on every step (use-plan.js,
// plan-status.js) and loads the steps on demand:
//
//   1 model → 2 engine → 3 resources → 4 capabilities → 5 access → 6 review → 7 launch
//
// Steps are modules next to this file (step-<id>.js, default export); a step
// whose module is not in the build yet shows a "still being built" panel, so a
// later package adds its step without editing this file. Leaving the page with
// a draft asks "Discard this deployment draft?". The quick paths (?model=,
// ?clone=, ?draft=, ?profile=, ?step=) are in quick-paths.js.

import { describeError } from "../../lib/api.js";
import {
  DOWNLOADS_STORAGE_KEY, DRAFT_STORAGE_KEY, STATUS_STEPS, STEP_IDS, applySuggestion, createDraft, diffValues, draftForJob, forgetDownload, isDirty, isServableRole,
  modelRefFromCard, normalizeDraft, parseDownloads, parseDraft, patchDraft, serializeDraft, stepStatus,
} from "../../lib/wizard-state.js";
import { createStorage } from "../../lib/storage.js";
import { SchemaCatalogGuard, EnginesResponseGuard } from "../../lib/schemas.js";
import { Button } from "../../components/button.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DiffTable } from "../../components/diff-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { Stepper } from "../../components/stepper.js";
import { useServices } from "../../ui/context.js";
import { useEvent, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "../../ui/vendor.js";
import { useCard } from "./card-source.js";
import { PlanStatus } from "./plan-status.js";
import { loadLaunchDraft, loadProfileDraft, loadRecentDraft, quickPathOf } from "./quick-paths.js";
import { useLaunch } from "./use-launch.js";
import { usePlan } from "./use-plan.js";

const enc = encodeURIComponent;

// One loader per step; a package that has not landed yet makes the import fail and the panel says so.
const STEP_MODULES = Object.freeze({
  model: () => import("./step-model.js"),
  engine: () => import("./step-engine.js"),
  resources: () => import("./step-resources.js"),
  capabilities: () => import("./step-capabilities.js"),
  access: () => import("./step-access.js"),
  review: () => import("./step-review.js"),
  launch: () => import("./step-launch.js"),
});
const SCROLL_TOP = { top: 0, behavior: "auto" };

function initialDraft(storage, query) {
  const stored = parseDraft(storage.sessionGet(DRAFT_STORAGE_KEY));
  const quick = quickPathOf(query);
  const step = STEP_IDS.includes(query.step) ? { step: query.step } : {};
  switch (quick.kind) {
    case "draft":
      return stored && stored.id === quick.id ? patchDraft(stored, step) : { missing: quick.id, draft: createDraft() };
    case "seed":
      return createDraft(quick.seed);
    case "clone":
    case "profile":
    case "recent":
      return createDraft({ managerId: quick.managerId, ...step });
    default:
      return stored ? patchDraft(stored, step) : createDraft(step);
  }
}

function LazyStep({ id, props }) {
  const { t } = useT();
  const [state, setState] = useState({ id: "", Component: null, failed: false });
  useEffect(() => {
    let alive = true;
    setState({ id, Component: null, failed: false });
    STEP_MODULES[id]().then(
      (module) => alive && setState({ id, Component: module.default, failed: false }),
      () => alive && setState({ id, Component: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [id]);
  // The skeleton shows until the module has loaded; the "still being built" panel is for a module that is not in the build.
  if (state.id !== id || (!state.Component && !state.failed)) return html`<div aria-busy="true" data-testid="wizard.step-loading"><${Skeleton} shape="line" rows=${5} /></div>`;
  if (state.failed || !state.Component) {
    return html`<div data-testid=${`wizard.step.${id}`} data-pending="true"><${EmptyState} icon="info" title=${t("models.wizard.pending")} body=${t("models.wizard.pendingBody")}
      action=${{ label: t("models.wizard.back"), onClick: () => props.goto(STEP_IDS[Math.max(0, STEP_IDS.indexOf(id) - 1)]) }} /></div>`;
  }
  const Component = state.Component;
  return html`<${Component} ...${props} />`;
}

export default function DeployWizardPage({ query = {} }) {
  const services = useServices();
  const { api, router, toasts, notifications, i18n } = services;
  const { t, tk, locale } = useT();
  const storage = useMemo(() => createStorage(), []);
  const seeded = useRef(null);
  if (seeded.current === null) seeded.current = initialDraft(storage, query);
  const [draft, setDraft] = useState(() => seeded.current.draft || seeded.current);
  const quick = useMemo(() => quickPathOf(query), []);
  const [notice, setNotice] = useState(seeded.current.missing ? "draftMissing" : "");
  const [quickState, setQuickState] = useState(quick.kind === "clone" || quick.kind === "profile" || quick.kind === "recent" ? "loading" : "idle");
  const [profile, setProfile] = useState(null);
  const [discard, setDiscard] = useState(null);
  const keepOnLeave = useRef(false);
  const dirtyRef = useRef(false);

  const update = useCallback((change) => setDraft((current) => {
    const next = typeof change === "function" ? change(current) : patchDraft(current, change);
    return !next || next === current ? current : normalizeDraft(next, { random: () => 0 });
  }), []);

  // Engines and the engine's catalog: the manager of a chosen engine, and the field labels and groups.
  const engines = useQuery(["engines"], () => api.get("/api/engines", { guard: EnginesResponseGuard }), { ttlMs: 10000 });
  useEffect(() => {
    if (!draft.engineId || draft.managerId) return;
    const found = list(engines.data?.engines).find((engine) => engine?.engineId === draft.engineId);
    if (found?.managerId) update({ managerId: found.managerId });
  }, [draft.engineId, draft.managerId, engines.data]);
  const catalogQuery = useQuery(
    ["engines", "schema", draft.managerId, draft.engineId],
    () => api.manager(draft.managerId).get(`/engines/${enc(draft.engineId)}/schema`, { guard: SchemaCatalogGuard }),
    { ttlMs: 60000, enabled: Boolean(draft.managerId && draft.engineId) },
  );
  const catalog = draft.managerId && draft.engineId ? catalogQuery.data ?? null : null;

  // The plan of the draft; a remote model is planned from its full card (00 §9.2).
  const { card } = useCard(draft.modelRef);
  useEffect(() => {
    if (!card) return;
    update((current) => (current.modelRef && current.modelRef.cardId !== card.cardId && isServableRole(card.role?.value)
      ? patchDraft(current, { modelRef: modelRefFromCard(card, current.modelRef) }) : current));
  }, [card?.cardId]);
  const plan = usePlan(draft, { card: draft.modelRef?.kind === "remote" ? card : undefined, catalog });
  const status = useMemo(() => stepStatus(draft, plan.plan, catalog), [draft, plan.plan, catalog]);

  // A quick path seeds a draft once. Its query is dropped from the address afterwards, so a reload brings the
  // stored draft back instead of starting the quick path again with a new draft id.
  const dropQuery = () => {
    if (quick.kind !== "none" && quick.kind !== "draft") router?.navigate?.("/deployments/new", { replace: true });
  };
  useEffect(() => {
    if (quick.kind === "seed") dropQuery();
  }, []);

  // Quick paths that need a request: a stored launch (clone) or a saved profile.
  useEffect(() => {
    if (quick.kind !== "clone" && quick.kind !== "profile" && quick.kind !== "recent") return undefined;
    let alive = true;
    const step = STEP_IDS.includes(query.step) ? query.step : quick.kind === "profile" || quick.kind === "recent" ? "review" : "model";
    (async () => {
      try {
        if (quick.kind === "clone") {
          const cloned = await loadLaunchDraft(api, quick.managerId, quick.launchId, { id: draft.id, step });
          if (alive) update(() => cloned);
        } else if (quick.kind === "recent") {
          const recent = await loadRecentDraft(api, quick.managerId, quick.index, { id: draft.id, step });
          if (alive && recent) update(() => recent);
          else if (alive) setNotice("recentMissing");
        } else {
          const loaded = await loadProfileDraft(api, quick.managerId, quick.profileId, { id: draft.id, step });
          if (alive && loaded) setProfile(loaded);
          else if (alive) setNotice("profileMissing");
        }
        if (alive) {
          setQuickState("idle");
          dropQuery();
        }
      } catch (error) {
        if (alive) {
          setQuickState("error");
          setNotice(describeError(error, i18n));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Leaving the page with a draft asks first (the Stepper keeps the draft in the tab otherwise).
  useEffect(() => {
    if (!router?.addGuard) return undefined;
    return router.addGuard((next) => {
      if (next?.match?.route?.name === "deployments.new" || keepOnLeave.current || !dirtyRef.current) return true;
      return new Promise((resolve) => setDiscard({ resolve }));
    });
  }, [router]);

  // "Download first": when the download of a remote model is ready, link back to this draft.
  useEvent("downloads", (envelope) => {
    const jobs = list(envelope?.data?.jobs);
    let map = parseDownloads(storage.sessionGet(DOWNLOADS_STORAGE_KEY));
    for (const job of jobs) {
      const draftId = draftForJob(map, String(job?.id));
      if (!draftId || job.state !== "ready") continue;
      map = forgetDownload(map, String(job.id));
      storage.sessionSet(DOWNLOADS_STORAGE_KEY, JSON.stringify(map));
      const href = `/deployments/new?draft=${enc(draftId)}&step=model`;
      const both = (text) => ({ zh: text, en: text });
      notifications?.push?.({ kind: "download", severity: "info", title: both(t("models.wizard.downloadReady")), body: both(t("models.wizard.downloadReadyBody")), action: { label: both(t("models.wizard.continue")), href } });
      toasts?.push?.({ level: "success", title: t("models.wizard.downloadReady"), body: t("models.wizard.downloadReadyBody"), action: { label: t("models.wizard.continue"), href } });
    }
  });

  const goto = useCallback((step) => {
    if (!STEP_IDS.includes(step)) return;
    update({ step });
    try {
      globalThis.scrollTo?.(SCROLL_TOP);
    } catch {
      // Scrolling is a nicety.
    }
  }, [update]);
  const leaveTo = useCallback((href) => {
    keepOnLeave.current = true;
    Promise.resolve(router?.navigate?.(href)).finally(() => {
      keepOnLeave.current = false;
    });
  }, [router]);
  // The launch the Review step starts and the Launch step follows (use-launch.js).
  const launch = useLaunch({ draft, plan, catalog, card: draft.modelRef?.kind === "remote" ? card : undefined, storage, goto });
  const settled = launch.state.settled;
  // A launch that is under way (or done) has used the draft: leaving does not ask to discard it.
  dirtyRef.current = isDirty(draft) && !settled && !(launch.state.status === "started" && launch.state.jobState === "running");

  // The draft survives a reload, minus its secrets. A launch that reached ready has used it up.
  useEffect(() => {
    if (isDirty(draft) && !settled) storage.sessionSet(DRAFT_STORAGE_KEY, serializeDraft(draft, catalog));
    else storage.sessionRemove(DRAFT_STORAGE_KEY);
  }, [draft, catalog, settled]);

  function startOver() {
    launch.reset();
    storage.sessionRemove(DRAFT_STORAGE_KEY);
    setDraft(createDraft());
    setNotice("");
  }
  function applySuggestionToDraft(suggestion) {
    update((current) => applySuggestion(current, suggestion));
  }

  const at = Math.max(0, STEP_IDS.indexOf(draft.step));
  const steps = STEP_IDS.map((id, index) => {
    let state = "pending";
    if (index === at) state = "active";
    else if (index < at) state = STATUS_STEPS.includes(id) && status[id] === "error" ? "error" : "done";
    return { id, label: t(tk("models.wizard.step.", id)), state };
  });
  const canNext = draft.step === "model" ? Boolean(draft.modelRef) : draft.step === "engine" ? Boolean(draft.engineId && draft.managerId) : true;
  const stepProps = { draft, update, plan, catalog, goto, leaveTo, status, launch };

  const profileRows = profile ? diffValues(draft.values, profile.draft.values, profile.catalog, { locale }) : [];
  return html`<div class="stack" data-testid="wizard" data-step=${draft.step} data-draft=${draft.id}>
    <${PageHeader} title=${t("models.wizard.title")} subtitle=${t("models.wizard.subtitle")}
      actions=${html`<${Button} variant="ghost" onClick=${() => setDiscard({ resolve: null })} testid="wizard.reset" disabled=${!isDirty(draft)}>${t("models.wizard.reset")}<//>`} />
    ${notice ? html`<div class="notice notice-warn" role="status" data-testid="wizard.notice">
      <span class="grow" data-user-content="">${notice === "draftMissing" ? t("models.wizard.draftMissing") : notice === "profileMissing" ? t("models.wizard.profileMissing") : notice === "recentMissing" ? t("models.wizard.recentMissing") : notice}</span>
      <${Button} size="sm" variant="ghost" onClick=${() => setNotice("")}>${t("common.dismiss")}<//>
    </div>` : null}
    ${quickState === "loading" ? html`<div aria-busy="true" data-testid="wizard.quick-loading"><${Skeleton} shape="line" rows=${2} /></div>` : null}
    <${Stepper} steps=${steps} label=${t("models.wizard.steps")} testid="wizard.stepper" />
    <${PlanStatus} state=${plan} catalog=${catalog} onSuggestion=${applySuggestionToDraft} onGoto=${goto} />
    <${LazyStep} id=${draft.step} props=${stepProps} />
    <div class="row wizard-nav" data-testid="wizard.nav">
      <${Button} disabled=${at === 0} onClick=${() => goto(STEP_IDS[at - 1])} testid="wizard.back">${t("models.wizard.back")}<//>
      <span class="grow"></span>
      ${at < STATUS_STEPS.length - 1 ? html`<${Button} variant="primary" disabled=${!canNext} onClick=${() => goto(STEP_IDS[at + 1])} testid="wizard.next">${t("models.wizard.next")}<//>` : null}
    </div>

    <${ConfirmDialog} open=${Boolean(discard)} testid="wizard.discard" title=${t("models.wizard.discard.title")} body=${t("models.wizard.discard.body")}
      confirmLabel=${t("models.wizard.discard.confirm")} cancelLabel=${t("models.wizard.discard.keep")} tone="danger"
      onConfirm=${() => {
        if (discard) discard.confirmed = true;
        storage.sessionRemove(DRAFT_STORAGE_KEY);
        if (!discard?.resolve) startOver();
      }}
      onClose=${() => {
        discard?.resolve?.(Boolean(discard.confirmed));
        setDiscard(null);
      }} />
    <${ConfirmDialog} open=${Boolean(profile)} testid="wizard.profile" title=${t("models.wizard.profile.title")}
      body=${profile ? html`<div class="stack-sm"><p>${t("models.wizard.profile.body")}</p><${DiffTable} rows=${profileRows} testid="wizard.profile.diff" />
        ${profile.draft.legacy && Object.keys(profile.draft.legacy.unmapped || {}).length ? html`<p class="small muted" data-testid="wizard.profile.unmapped">${t("models.wizard.profile.unmapped", { count: Object.keys(profile.draft.legacy.unmapped).length })}</p>` : null}</div>` : null}
      confirmLabel=${t("models.wizard.profile.apply")} cancelLabel=${t("common.cancel")}
      onConfirm=${() => {
        update(() => profile.draft);
      }}
      onClose=${() => setProfile(null)} />
  </div>`;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

