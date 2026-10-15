// The download plan sheet (07 §6.4 "Download plan sheet"): a Drawer that plans
// one download with POST /api/hub/plan (03 §13.4, no side effects) and queues it
// with POST /api/hub/downloads {planId}.
//
// It shows the artifact summary and a quant radio group, the target root with a
// before/after free-space bar and an "already have it" warning, companions
// (projector, draft model), the source (`Auto` with the measured latency, or a
// manual one), the Hugging Face access state with its fixes, the ETA and the
// fit. Every blocker comes with fix buttons; the one call to action is never
// silently disabled: with blockers it moves focus to them instead of sending.
//
// Plans are cheap and cached by the hub for ten minutes, so every choice plans
// again (250 ms debounce, identical requests once). A plan that expired or
// whose repository changed (`plan_not_found`, `plan_changed`) is planned again
// by itself.

import { describeError } from "../../lib/api.js";
import { degradable, fitLabelKey, repoPath, sourceUrl } from "../../lib/library-model.js";
import { detailHref, splitRepo } from "../../lib/discover-model.js";
import {
  alternateSource, artifactChoices, blockersFromError, defaultCompanions, deployEngine, duplicateState, freeSpaceBars, initialArtifact,
  normalizeBlocker, planKey, planRequest, probeRows, replanCode, rootChoices, sourceChoices,
} from "../../lib/plan-model.js";
import { Button } from "../../components/button.js";
import { Drawer } from "../../components/drawer.js";
import { Skeleton } from "../../components/skeleton.js";
import { StackedBar } from "../../components/stacked-bar.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useDebounced, useFormat, useQuery, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useRef, useState } from "../../ui/vendor.js";
import { useUsageQuery } from "./data.js";
import { TokenFields } from "./hub-token.js";

const enc = encodeURIComponent;
const FIT_STATUS = Object.freeze({ fits: "ok", tight: "warn", spills: "warn", "wont-fit": "error", unknown: "unknown" });
// Blocker codes the console has its own wording for (`hub.plan.code.<code>`); anything else shows the hub's message.
const KNOWN_CODES = Object.freeze(["disk_full", "hf_login_required", "hf_approval_required", "gated_official_required", "already_downloading", "already_in_library", "target_occupied", "filter_no_match", "repo_not_found", "revision_not_found"]);

function FitLine({ plan }) {
  const { t, tk } = useT();
  const fmt = useFormat();
  const fit = plan?.fit;
  if (!fit || !fit.label) return null;
  const key = fitLabelKey(fit.label, fit.spill === true);
  return html`<p class="row" data-testid="plan.fit">
    <${StatusBadge} status=${FIT_STATUS[key]} label=${t(tk("hub.fit.", key))} />
    ${Number(fit.neededMb) > 0 ? html`<span class="small num">${fmt.bytes(Number(fit.neededMb) * 1048576)}</span>` : null}
    ${fit.basis === "params" ? html`<span class="xsmall muted">${t("hub.fit.basis.params")}</span>` : null}
  </p>`;
}

function Blockers({ blockers, fixes, regionRef }) {
  const { t, has, tk } = useT();
  return html`<section ref=${regionRef} tabindex="-1" class="stack-sm notice notice-danger" role="alert" aria-label=${t("hub.plan.blockers")} data-testid="plan.blockers" hidden=${!blockers.length}>
    ${blockers.map((blocker) => html`<div key=${blocker.code} class="stack-sm" data-testid="plan.blocker" data-code=${blocker.code}>
      <strong data-user-content="">${KNOWN_CODES.includes(blocker.code) && has(tk("hub.plan.code.", blocker.code)) ? t(tk("hub.plan.code.", blocker.code)) : blocker.message || blocker.code}</strong>
      ${KNOWN_CODES.includes(blocker.code) && has(tk("hub.plan.hint.", blocker.code)) ? html`<span class="small">${t(tk("hub.plan.hint.", blocker.code))}</span>`
        : blocker.hint ? html`<span class="small" data-user-content="">${blocker.hint}</span>` : null}
      <span class="row">${blocker.actions.map((action) => fixes(action, blocker)).filter(Boolean)}</span>
    </div>`)}
  </section>`;
}

export default function DownloadPlanSheet({ target, onClose, onQueued }) {
  const { api, cache, i18n, toasts } = useServices();
  const { t, tk } = useT();
  const fmt = useFormat();
  const owner = useRole() === "owner";
  const { owner: repoOwner, name } = splitRepo(target.repo);
  const usage = useUsageQuery();
  const detail = useQuery(["hub", "repos", target.provider, repoOwner, name, "detail"], () => api.get(repoPath({ provider: target.provider, owner: repoOwner, name }), { query: { context: 8192 } }), { ttlMs: 60000 });
  const choices = artifactChoices(detail.data?.artifacts);
  const [form, setForm] = useState({
    provider: target.provider, repo: target.repo, artifactKey: "", companions: [], rootId: target.rootId || "", outputName: "",
    source: target.source || "auto", credentialMode: "auto", hfToken: "", remember: false, deploy: target.runAfter === true, priority: "normal",
  });
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  // The token is planned with once it is committed (the field lost focus, or Check again), not on every keystroke: each plan with a token puts it in the hub's vault.
  const [committedToken, setCommittedToken] = useState("");
  const [planState, setPlanState] = useState({ status: "idle", plan: null, error: null });
  const [probe, setProbe] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [runAfterMissing, setRunAfterMissing] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
  const [tick, setTick] = useState(0);
  const blockersRef = useRef(null);
  const rootRef = useRef(null);
  const radioRef = useRef(null);
  const latest = useRef(0);

  const choice = choices.find((item) => item.key === form.artifactKey) || null;
  const engine = deployEngine(choice);
  const deploy = form.deploy && Boolean(engine) && !runAfterMissing;
  const body = form.artifactKey ? planRequest({ ...form, hfToken: committedToken, revision: detail.data?.revision || "main", runAfter: deploy ? { engineId: engine } : null }) : null;
  const key = body ? planKey(body) : "";
  const debouncedKey = useDebounced(key, 250);
  const bodyRef = useRef(body);
  bodyRef.current = body;

  // The artifact (and its default companions) once the repository is known.
  useEffect(() => {
    if (!choices.length || form.artifactKey) return;
    const artifactKey = initialArtifact(choices, target.artifact);
    setForm((current) => ({ ...current, artifactKey, companions: defaultCompanions(choices.find((item) => item.key === artifactKey)?.companions) }));
  }, [choices.length]);

  // Plan again whenever a choice changes.
  useEffect(() => {
    if (!debouncedKey || !bodyRef.current) return undefined;
    const run = (latest.current += 1);
    setSubmitError(null);
    setPlanState((current) => ({ ...current, status: "loading", error: null }));
    api.post("/api/hub/plan", bodyRef.current).then((plan) => {
      if (run !== latest.current) return;
      setPlanState({ status: "ready", plan, error: null });
      setLocalOnly(false);
    }, (error) => {
      if (run !== latest.current) return;
      if (error?.code === "run_after_unavailable") {
        setRunAfterMissing(true);
        return;
      }
      setLocalOnly(error?.code === "token_requires_local");
      setPlanState({ status: "error", plan: null, error });
    });
    return () => {
      latest.current += 1;
    };
  }, [debouncedKey, tick]);

  // The measured latency of the sources, once per repository and artifact (the hub caches it for ten minutes).
  useEffect(() => {
    if (!form.artifactKey || !owner) return undefined;
    let alive = true;
    api.post("/api/hub/sources/probe", { repo: target.repo, artifactKey: form.artifactKey }).then((result) => alive && setProbe(result), () => alive && setProbe(null));
    return () => {
      alive = false;
    };
  }, [form.artifactKey, owner]);

  const plan = planState.plan;
  const root = rootChoices(usage.data?.usage).find((item) => item.id === (plan?.target?.rootId || form.rootId)) || null;
  const bars = plan ? freeSpaceBars(plan, root) : null;
  const existing = duplicateState(plan);
  const blockers = [
    ...(planState.error ? blockersFromError(planState.error) : (plan?.blocking || []).map(normalizeBlocker)),
    ...(submitError || []),
    ...(existing.duplicate && !allowDuplicate ? [{ ...normalizeBlocker({ code: "already_in_library", message: plan?.existing?.message, actions: ["open-library", "allow-duplicate"] }), entryId: plan?.existing?.entryId || "" }] : []),
  ];
  const probeList = probeRows(probe);

  function patch(next) {
    setSubmitError(null);
    setForm((current) => ({ ...current, ...next }));
  }
  function pick(artifactKey) {
    patch({ artifactKey, companions: defaultCompanions(choices.find((item) => item.key === artifactKey)?.companions) });
  }
  async function login() {
    try {
      await api.post("/api/hub/auth/huggingface/login", {});
      toasts?.push?.({ level: "info", title: t("hub.plan.loginOpened") });
    } catch (error) {
      toasts?.push?.({ level: "error", title: error?.code === "token_requires_local" ? t("hub.token.localOnly") : describeError(error, i18n) });
    }
  }
  function focusBlockers() {
    blockersRef.current?.focus?.();
  }
  // The buttons that fix a blocker (03 §6.3 action ids).
  function fixes(action, blocker) {
    const label = (id) => t(tk("hub.action.", id));
    const link = (id, href, extra = {}) => html`<${Button} key=${id} size="sm" href=${href} testid=${`plan.fix.${id}`} ...${extra}>${label(id)}<//>`;
    const press = (id, onClick, text = label(id)) => html`<${Button} key=${id} size="sm" onClick=${onClick} testid=${`plan.fix.${id}`}>${text}<//>`;
    switch (action) {
      case "sign-in": return owner ? press("sign-in", login) : null;
      case "open-approval": return link("open-approval", plan?.access?.authorizationUrl || sourceUrl({ provider: target.provider, owner: repoOwner, name }) || "#", { target: "_blank", rel: "noopener noreferrer" });
      case "switch-source": return press("switch-source", () => patch({ source: alternateSource(plan?.source?.chosen || form.source) }));
      case "choose-root": return press("choose-root", () => rootRef.current?.focus?.());
      case "open-storage": return link("open-storage", "/models/storage");
      case "free-space": return link("free-space", "/models/storage");
      case "open-downloads": return link("open-downloads", blocker.existingJobId ? `/models/downloads?job=${enc(blocker.existingJobId)}` : "/models/downloads");
      case "open-library": return blocker.entryId ? link("open-library", `/models/library/${enc(blocker.entryId)}`) : null;
      case "pick-artifact": return press("pick-artifact", () => radioRef.current?.focus?.());
      case "check-id": return link("check-id", detailHref(target.provider, target.repo) || "/models/discover");
      case "enter-token": return press("enter-token", () => patch({ credentialMode: "temp-token" }));
      case "install-cli": return link("install-cli", "/system/doctor");
      case "allow-duplicate": return press("allow-duplicate", () => setAllowDuplicate(true), t("hub.plan.allowDuplicate"));
      default: return null;
    }
  }
  async function submit() {
    if (blockers.length) {
      focusBlockers();
      return;
    }
    if (!plan?.planId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post("/api/hub/downloads", {
        planId: plan.planId, priority: form.priority, ...(allowDuplicate ? { allowDuplicate: true } : {}),
        ...(deploy ? { runAfter: body.runAfter } : {}),
      });
      cache.invalidate(["hub", "downloads"]);
      onQueued?.(result?.job || result);
    } catch (error) {
      if (replanCode(error)) {
        setTick((value) => value + 1);
        toasts?.push?.({ level: "warn", title: t("hub.plan.replanned") });
      } else {
        if (error?.code === "run_after_unavailable") setRunAfterMissing(true);
        setSubmitError(blockersFromError(error));
        setLocalOnly(error?.code === "token_requires_local");
        globalThis.setTimeout(focusBlockers, 0);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const cta = deploy ? t("hub.detail.action.downloadDeploy") : t("hub.detail.action.download");
  const footer = html`<${Button} variant="ghost" onClick=${onClose} testid="plan.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" busy=${submitting || (planState.status === "loading" && !plan)} onClick=${submit} data-blocked=${blockers.length ? "true" : "false"}
      aria-describedby=${blockers.length ? "plan-blockers" : undefined} testid="plan.submit">${cta}<//>`;

  let content;
  if (detail.error && !detail.data) {
    const missing = degradable(detail.error);
    content = html`<div class="notice notice-danger" role="alert" data-testid="plan.error">
      <span class="grow" data-user-content="">${missing ? t("hub.unavailable") : describeError(detail.error, i18n)}</span>
      <${Button} size="sm" onClick=${() => detail.refetch()}>${t("hub.library.retry")}<//></div>`;
  } else if (!detail.data) {
    content = html`<div aria-busy="true" data-testid="plan.loading"><${Skeleton} shape="tile" /><${Skeleton} shape="line" rows=${5} /></div>`;
  } else {
    const roots = rootChoices(usage.data?.usage);
    const sources = sourceChoices(target.provider);
    const access = plan?.access || detail.data.access || {};
    const gated = access.gated === true || (access.status && access.status !== "not_required");
    content = html`<div class="stack plan-sheet" data-testid="plan" aria-busy=${planState.status === "loading" ? "true" : "false"}>
      <section class="stack-sm" aria-label=${t("hub.plan.summary")}>
        <p class="row"><strong class="mono" data-user-content="" data-testid="plan.repo">${target.repo}</strong>
          <span class="small muted mono" data-user-content="">${(plan?.artifact?.revisionSha || detail.data.revisionSha || "").slice(0, 8)}</span></p>
        ${plan ? html`<p class="small num" data-testid="plan.size">${t("hub.plan.size", { size: fmt.bytes(plan.artifact?.totalBytes), files: plan.artifact?.files?.length || 0 })}</p>` : null}
      </section>

      <div id="plan-blockers"><${Blockers} blockers=${blockers} fixes=${fixes} regionRef=${blockersRef} /></div>

      <fieldset class="plan-choices" data-testid="plan.artifacts">
        <legend class="card-title">${t("hub.plan.artifact")}</legend>
        ${choices.length ? choices.map((item, index) => html`<label key=${item.key} class="plan-choice" data-testid="plan.artifact" data-artifact=${item.key} data-selected=${item.key === form.artifactKey ? "true" : "false"}>
          <input type="radio" name="plan-artifact" value=${item.key} checked=${item.key === form.artifactKey} ref=${item.key === form.artifactKey || (index === 0 && !form.artifactKey) ? radioRef : undefined}
            onChange=${() => pick(item.key)} />
          <span class="grow"><strong class="mono">${item.label}</strong>
            ${item.recommended ? html` <span class="badge badge-info">${t("hub.detail.quants.recommended")}</span>` : null}
            ${item.libraryState !== "absent" ? html` <span class="badge badge-success">${t("hub.detail.quants.inLibrary")}</span>` : null}
            ${!item.complete ? html` <span class="badge badge-warn">${t("hub.plan.incomplete")}</span>` : null}</span>
          <span class="num small">${fmt.bytes(item.bytes)}</span>
          ${item.fit ? html`<${StatusBadge} status=${FIT_STATUS[fitLabelKey(item.fit.label, item.fit.spill)]} label=${t(tk("hub.fit.", fitLabelKey(item.fit.label, item.fit.spill)))} />` : null}
        </label>`) : html`<p class="muted" data-testid="plan.no-artifacts">${t("hub.detail.quants.none")}</p>`}
      </fieldset>

      ${choice?.companions?.length ? html`<fieldset class="plan-choices" data-testid="plan.companions">
        <legend class="card-title">${t("hub.plan.companions")}</legend>
        ${choice.companions.map((file) => html`<label key=${file.path} class="plan-choice">
          <input type="checkbox" checked=${form.companions.includes(file.path)} data-testid="plan.companion" data-path=${file.path}
            onChange=${(event) => patch({ companions: event.currentTarget.checked ? [...form.companions, file.path] : form.companions.filter((path) => path !== file.path) })} />
          <span class="grow mono small" data-user-content="">${file.path}</span>
          <span class="badge badge-neutral">${t(tk("hub.plan.companion.", file.kind))}</span>
          ${file.size ? html`<span class="num small">${fmt.bytes(file.size)}</span>` : null}
        </label>`)}
      </fieldset>` : null}

      <section class="stack-sm" aria-labelledby="plan-target-h">
        <h3 id="plan-target-h" class="card-title">${t("hub.plan.target")}</h3>
        <div class="row deploy-filters">
          <label class="deploy-filter"><span class="small muted">${t("hub.library.filter.root")}</span>
            <select class="select" ref=${rootRef} value=${form.rootId} data-testid="plan.root" onChange=${(event) => patch({ rootId: event.currentTarget.value })}>
              <option value="" selected=${!form.rootId}>${t("hub.plan.rootDefault")}</option>
              ${roots.map((item) => html`<option key=${item.id} value=${item.id} selected=${form.rootId === item.id}>${item.label}${item.freeBytes !== null ? ` (${t("hub.plan.free", { size: fmt.bytes(item.freeBytes) })})` : ""}</option>`)}
            </select></label>
          <label class="deploy-filter grow"><span class="small muted">${t("hub.plan.folder")}</span>
            <input class="input" type="text" value=${form.outputName} placeholder=${plan?.target?.localDir ? splitRepo(target.repo).owner + "-" + name : ""} autocomplete="off" data-testid="plan.folder"
              onInput=${(event) => patch({ outputName: event.currentTarget.value })} /></label>
        </div>
        ${plan?.target?.localDir ? html`<p class="xsmall muted mono truncate" data-user-content="" data-testid="plan.localdir">${plan.target.localDir}</p>` : null}
        ${bars ? html`<div class="plan-bars" data-testid="plan.bars">
          <div><span class="small muted">${t("hub.plan.before")}</span><${StackedBar} total=${bars.total} parts=${bars.before.map((part) => ({ ...part, label: t("hub.storage.bar.used") }))} testid="plan.bar.before" /></div>
          <div><span class="small muted">${t("hub.plan.after")}</span><${StackedBar} total=${bars.total} parts=${bars.after.filter((part) => part.value > 0 || part.id === "used").map((part) => ({ ...part, label: part.id === "used" ? t("hub.storage.bar.used") : t(tk("hub.plan.bar.", part.id)) }))} testid="plan.bar.after" /></div>
          <p class="small num" data-testid="plan.free-after">${t("hub.plan.freeAfter", { free: fmt.bytes(bars.freeAfterBytes), reserve: bars.reserveBytes === null ? "—" : fmt.bytes(bars.reserveBytes) })}</p>
        </div>` : null}
        ${existing.warn && !existing.duplicate ? html`<p class="notice notice-warn" data-testid="plan.existing" data-user-content="">${plan?.existing?.message || t("hub.plan.existing")}</p>` : null}
        ${allowDuplicate ? html`<p class="small muted" data-testid="plan.duplicate-on">${t("hub.plan.duplicateOn")}</p>` : null}
      </section>

      <section class="stack-sm" aria-labelledby="plan-source-h">
        <h3 id="plan-source-h" class="card-title">${t("hub.plan.source")}</h3>
        <label class="deploy-filter"><span class="small muted">${t("hub.discover.source")}</span>
          <select class="select" value=${form.source} data-testid="plan.source" onChange=${(event) => patch({ source: event.currentTarget.value })}>
            ${sources.map((id) => html`<option key=${id} value=${id} selected=${form.source === id}>${id === "auto" ? t("hub.plan.sourceAuto") : t(tk("hub.discover.source.", id))}</option>`)}
          </select></label>
        ${plan?.source?.chosen ? html`<p class="small" data-testid="plan.source-chosen">${t("hub.plan.sourceChosen", { source: t(tk("hub.discover.source.", plan.source.chosen)) })}
          ${plan.source.reason === "gated-official" ? html` <span class="muted">${t("hub.plan.sourceOfficial")}</span>` : null}</p>` : null}
        ${probeList.length ? html`<ul class="row plan-probe" data-testid="plan.probe">${probeList.map((row) => html`<li key=${row.source} class="small" data-source=${row.source}>
          ${t(tk("hub.discover.source.", row.source))}: <span class="num">${row.ok && row.ms !== null ? t("hub.plan.latency", { ms: row.ms }) : t("hub.plan.unreachable")}</span>${row.recommended ? html` <span class="badge badge-info">${t("hub.plan.fastest")}</span>` : null}</li>`)}</ul>` : null}
      </section>

      ${gated || owner ? html`<section class="stack-sm" aria-labelledby="plan-auth-h">
        <h3 id="plan-auth-h" class="card-title">${t("hub.plan.auth")}</h3>
        <p class="small" data-testid="plan.access" data-status=${access.status || "unknown"}>${t(tk("hub.detail.access.", access.status || "unknown"))}</p>
        ${owner && target.provider === "huggingface" ? html`<div class="row">
          <${Button} size="sm" onClick=${login} testid="plan.login">${t("hub.action.sign-in")}<//>
          ${gated ? html`<${Button} size="sm" href=${access.authorizationUrl || sourceUrl({ provider: target.provider, owner: repoOwner, name })} target="_blank" rel="noopener noreferrer" testid="plan.approval">${t("hub.action.open-approval")}<//>` : null}
          <${Button} size="sm" onClick=${() => {
            setCommittedToken(form.hfToken);
            setTick((value) => value + 1);
          }} testid="plan.recheck">${t("hub.plan.recheck")}<//>
          <${Button} size="sm" variant="ghost" onClick=${() => patch({ credentialMode: form.credentialMode === "temp-token" ? "auto" : "temp-token" })} aria-pressed=${form.credentialMode === "temp-token" ? "true" : "false"} testid="plan.token-toggle">${t("hub.action.enter-token")}<//>
        </div>` : null}
        ${form.credentialMode === "temp-token" ? html`<${TokenFields} value=${{ token: form.hfToken, remember: form.remember }} onChange=${(next) => patch({ hfToken: next.token, remember: next.remember })} onCommit=${() => setCommittedToken(form.hfToken)} localOnly=${localOnly} testid="plan.token" />` : null}
      </section>` : null}

      ${choice && engine && owner ? html`<label class="row-nowrap" data-testid="plan.deploy-row"><input type="checkbox" checked=${deploy} data-testid="plan.deploy" onChange=${(event) => {
        setRunAfterMissing(false);
        patch({ deploy: event.currentTarget.checked });
      }} />
        <span class="small">${t("hub.plan.deploy", { engine })}</span></label>` : null}
      ${runAfterMissing ? html`<p class="small muted" role="status" data-testid="plan.deploy-missing">${t("hub.plan.deployMissing")}</p>` : null}

      ${plan ? html`<section class="stack-sm" aria-label=${t("hub.plan.estimate")}>
        <p class="small num" data-testid="plan.eta">${plan.eta?.seconds ? t("hub.plan.eta", { time: fmt.duration(plan.eta.seconds * 1000) }) : t("hub.plan.etaUnknown")}
          ${plan.eta?.basisBps ? html` <span class="muted">${t("hub.plan.etaBasis", { speed: `${fmt.bytes(plan.eta.basisBps)}/s` })}</span>` : null}</p>
        <${FitLine} plan=${plan} />
        ${(plan.warnings || []).length ? html`<ul class="stack-sm plan-warnings" data-testid="plan.warnings">${plan.warnings.map((warning) => html`<li key=${warning.code} class="notice notice-warn" data-code=${warning.code} data-user-content="">${warning.message}${Array.isArray(warning.files) && warning.files.length ? html` <span class="mono xsmall">${warning.files.join(", ")}</span>` : null}</li>`)}</ul>` : null}
      </section>` : null}
    </div>`;
  }

  return html`<${Drawer} open=${true} title=${t("hub.plan.title")} width=${640} onClose=${onClose} urlId="plan" footer=${footer} testid="plan.drawer">${content}<//>`;
}
