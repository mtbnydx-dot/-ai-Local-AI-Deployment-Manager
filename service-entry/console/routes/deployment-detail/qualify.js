// The qualification block (07 §6.2, 02 steps 7 and 8, R-UI-5 and R-UI-7): on the
// deployment's Config tab and on the wizard's success step.
//
//   Start       `Qualify this deployment` sends POST /api/models/:cardId/qualify {fleetId}
//               (202 job). The card id comes from the launch's model (the same inspect
//               cache the wizard uses).
//   Checklist   follows the relayed `jobs` events of kind `model-qualify` (the same cache key
//               the entry's events merge into; a slow refetch is the safety net), with each
//               check's status; once the entry has stored the host record, the rows come from
//               it, with each check's detail. Past runs are GET /api/models/:id/qualifications.
//   Failure     a qualification that fails shows the job error object in a RootCausePanel.
//   Save        `Save as recipe` opens the Drawer after a passing `chat` check (save-recipe.js).
//   Unavailable a manager entry before 02 MOD-16 answers 404, which the client maps to
//               `endpoint_unavailable`; the whole block is then hidden.

import { jobFailure, signatureMap } from "../../lib/launch-model.js";
import {
  canSaveRecipe, checkRows, followedJob, jobProgress, lockCandidates, modelRefOf, recordsFor,
} from "../../lib/qualify-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { QualifyChecklist } from "../../components/qualify-checklist.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useMemo, useRef, useState } from "../../ui/vendor.js";
import { useCard } from "../deploy-wizard/card-source.js";
import { LazyView } from "./lazy.js";

const enc = encodeURIComponent;
// The failure card and the Save as recipe form load when they are first needed (07 §11 route budget).
const loadRootCause = () => import("../../components/root-cause-panel.js");
const loadSaveRecipe = () => import("./save-recipe.js");
const SAFETY_REFRESH_MS = 5000;
const RECORD_POLL_MS = 2000;
const RECORD_POLL_TRIES = 8;
const PAST_RUNS = 5;

/** A 404 from a build without MOD-16 (or a card lookup that does not exist at all): the block stays hidden. */
export function isUnavailable(error) {
  if (!error) return false;
  if (error.code === "endpoint_unavailable") return true;
  return error.status === 404 && error.code !== "card_not_found" && error.code !== "launch_not_found";
}

function useQualifyJob(managerId, fleetId, startedId) {
  const { api, visibility } = useServices();
  const jobs = useQuery(["m", managerId, "jobs"], () => api.manager(managerId).get("/jobs", { query: { fields: "summary" } }), { ttlMs: 2000, enabled: Boolean(managerId) });
  const refetch = useRef(jobs.refetch);
  refetch.current = jobs.refetch;
  // A run found already going (a reload, or the entry's auto-qualify) is followed to its end by its id.
  const [adopted, setAdopted] = useState("");
  const jobId = startedId || adopted;
  const job = useMemo(() => followedJob(jobs.data, { jobId, fleetId }), [jobs.data, jobId, fleetId]);
  const running = Boolean(job) && jobProgress(job).state === "running";
  useEffect(() => {
    if (!startedId && running && job.id !== adopted) setAdopted(String(job.id));
  }, [startedId, running, job?.id]);
  useEffect(() => {
    if (jobId) refetch.current();
  }, [jobId]);
  useEffect(() => {
    if (!running && !(jobId && !job)) return undefined;
    const timer = globalThis.setInterval(() => {
      if (!visibility?.hidden?.()) refetch.current();
    }, SAFETY_REFRESH_MS);
    return () => globalThis.clearInterval(timer);
  }, [running, jobId, Boolean(job)]);
  return job;
}

function useSignature(failure) {
  const { api } = useServices();
  const signatures = useQuery(["knowledge", "error-signatures"], () => api.get("/api/knowledge", { query: { kind: "error-signatures" } }), { ttlMs: 60000, enabled: Boolean(failure?.signatureId) });
  const map = useMemo(() => signatureMap(signatures.data), [signatures.data]);
  return failure?.signatureId ? map.get(failure.signatureId) || null : null;
}

/**
 * @param managerId,instanceId,fleetId the running deployment
 * @param launchId its LaunchStore record (the recipe is built from it)
 * @param modelRef { kind:"local", path } | { kind:"remote", ... , cardId? } of its model
 * @param engineId the engine, for the link to its Recipes tab
 * @param values the launch's resolved values, for the locks to tick
 * @param modelName a name for the suggested recipe id
 * @param framed draw the block in its own Card (the Config tab); the wizard places it in its own
 * @param canStart false while the deployment is not ready: the checklist and Save stay, Qualify waits
 */
export function QualifyBlock({ managerId, fleetId, launchId = "", modelRef: given = null, engineId = "", values = null, modelName = "", compact = false, framed = false, canStart = true }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = i18n;
  const fmt = useFormat();
  // A remote model (or a caller without a reference) is found through its launch: the record names the local path that was served.
  const launchRecord = useQuery(["m", managerId, "launch-record", launchId], () => api.manager(managerId).get(`/launches/${enc(launchId)}`), { ttlMs: 30000, enabled: !given && Boolean(launchId) });
  const modelRef = given || modelRefOf(launchRecord.data?.launch || launchRecord.data);
  const pendingRef = !given && Boolean(launchId) && launchRecord.status !== "success" && !launchRecord.error;
  const card = useCard(modelRef, { enabled: Boolean(modelRef) });
  const cardId = card.card?.cardId || "";
  const recordsQuery = useQuery(["hub", "library", "qualifications", cardId], () => api.get(`/api/models/${enc(cardId)}/qualifications`), { ttlMs: 5000, enabled: Boolean(cardId) });
  const [started, setStarted] = useState(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const [selected, setSelected] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [saved, setSaved] = useState(null);
  const [hidden, setHidden] = useState(false);
  const job = useQualifyJob(managerId, fleetId, started?.jobId || "");
  const progress = jobProgress(job);
  const running = Boolean(job) && progress.state === "running";

  const all = Array.isArray(recordsQuery.data?.records) ? recordsQuery.data.records : [];
  const mine = recordsFor(all, { launchId, fleetId });
  const wanted = job && progress.state !== "running" ? job.meta?.hostRecordId || "" : "";
  const record = running ? null
    : selected ? mine.find((item) => item.id === selected) || null
      : wanted ? mine.find((item) => item.id === wanted) || null
        : job ? null : mine[0] || null;
  const rows = checkRows({ job: record ? null : job, record });
  const failure = job && progress.state === "failed" ? jobFailure(job) : null;
  const signature = useSignature(failure);
  const awaitingRecord = Boolean(wanted) && !mine.some((item) => item.id === wanted);

  // The record reaches the entry after the job ends (a signed push); ask again a few times.
  useEffect(() => {
    if (!cardId || !job || progress.state === "running") return undefined;
    recordsQuery.refetch();
    if (!awaitingRecord) return undefined;
    let tries = 0;
    const timer = globalThis.setInterval(() => {
      tries += 1;
      recordsQuery.refetch();
      if (tries >= RECORD_POLL_TRIES) globalThis.clearInterval(timer);
    }, RECORD_POLL_MS);
    return () => globalThis.clearInterval(timer);
  }, [cardId, job?.id, progress.state, awaitingRecord]);

  const unavailable = hidden || isUnavailable(card.error) || isUnavailable(recordsQuery.error);
  if (unavailable) return null;

  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      const result = await api.post(`/api/models/${enc(cardId)}/qualify`, { fleetId });
      setSelected("");
      setSaved(null);
      setStarted({ jobId: String(result.jobId), managerId: result.managerId || managerId });
      cache.invalidate(["m", managerId, "jobs"]);
    } catch (error) {
      if (isUnavailable(error)) setHidden(true);
      else setStartError(error);
    } finally {
      setStarting(false);
    }
  }

  const canSave = canSaveRecipe(all, { launchId, fleetId });
  const loading = pendingRef || (Boolean(modelRef) && !card.error && (card.loading || (cardId && recordsQuery.status !== "success" && !recordsQuery.error)));
  const cardProblem = card.error || recordsQuery.error;
  const durationMs = record ? Number(record.durationMs) || null : null;
  const dateOf = (record) => (record?.at ? fmt.dateTime(new Date(record.at)) : "");
  const counts = (item) => {
    const out = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const result of item.results || []) if (result.status in out) out[result.status] += 1;
    return out;
  };

  const body = html`<div class="stack-sm" data-testid="qualify.root" data-running=${running ? "true" : "false"} data-compact=${compact ? "true" : "false"}>
    ${compact ? null : html`<p class="muted small">${t("models.qualify.intro")}</p>`}
    ${!modelRef && !pendingRef ? html`<p class="muted" data-testid="qualify.nomodel">${t("models.qualify.noModel")}</p>` : null}
    ${loading ? html`<p class="muted" aria-busy="true" data-testid="qualify.loading">…</p>` : null}
    ${cardProblem && !loading ? html`<p class="notice notice-warn" role="status" data-testid="qualify.unreadable">${t("models.qualify.unreadable")}</p>` : null}
    ${modelRef && cardId ? html`<div class="row">
      <${Button} variant=${record || running ? "default" : "primary"} icon="circle-check" busy=${starting || running} disabled=${!cardId || !canStart} onClick=${start} testid="qualify.start">
        ${t(record || job ? "models.qualify.rerun" : "models.qualify.start")}<//>
      <${Button} variant="primary" icon="save" disabled=${!canSave || running} onClick=${() => setDrawer(true)} testid="qualify.save">${t("models.recipe.save")}<//>
    </div>` : null}
    ${modelRef && cardId && !canStart ? html`<p class="muted small" data-testid="qualify.notready">${t("models.qualify.notReady")}</p>` : null}
    ${modelRef && cardId && !canSave ? html`<p class="muted small" data-testid="qualify.save-hint">${t("models.qualify.saveNeedsChat")}</p>` : null}
    ${startError ? html`<p class="notice notice-danger" role="alert" data-testid="qualify.start-error">${startError.message && startError.message !== startError.code ? startError.message : startError.code}</p>` : null}
    ${rows.length ? html`<${QualifyChecklist} rows=${rows} running=${running} percent=${progress.percent} durationMs=${durationMs} testid="qualify.checklist" />`
      : cardId && !loading && !job ? html`<p class="muted" data-testid="qualify.never">${t("models.qualify.never")}</p>` : null}
    ${awaitingRecord && !running ? html`<p class="muted small" role="status" data-testid="qualify.awaiting">${t("models.qualify.awaitingRecord")}</p>` : null}
    ${failure ? html`<${LazyView} load=${loadRootCause} name="RootCausePanel" kind="qualify" error=${failure} signature=${signature} testid="qualify.failure" />` : null}
    ${saved ? html`<${LazyView} load=${loadSaveRecipe} name="SavedRecipe" result=${saved} engineId=${engineId} testid="qualify.saved" />` : null}
    ${mine.length > 1 || (mine.length === 1 && (running || job)) ? html`<details class="stack-sm" data-testid="qualify.past">
      <summary>${t("models.qualify.past")}</summary>
      <ul class="stack-sm">
        ${mine.slice(0, PAST_RUNS).map((item) => {
          const count = counts(item);
          return html`<li key=${item.id} class="row" data-record=${item.id} data-testid="qualify.past-run">
            <span class="grow">${t("models.qualify.pastRun", { date: dateOf(item), pass: count.pass, warn: count.warn, fail: count.fail })}</span>
            <${Button} size="sm" onClick=${() => setSelected(item.id)} testid="qualify.past-show">${t("models.qualify.showRun")}<//>
          </li>`;
        })}
      </ul>
    </details>` : null}
    ${drawer ? html`<${LazyView} load=${loadSaveRecipe} name="SaveRecipeDrawer" launchId=${launchId} modelName=${modelName} candidates=${lockCandidates(values)}
      onClose=${() => setDrawer(false)}
      onSaved=${(result) => {
        setDrawer(false);
        setSaved(result);
        toasts?.push?.({ level: result.warnings?.length ? "warn" : "success", title: t("models.recipe.saved", { id: result.recipeId }) });
      }} />` : null}
  </div>`;
  return framed ? html`<${Card} title=${t("models.qualify.title")} testid="deploy.config.qualify">${body}<//>` : body;
}

export default QualifyBlock;
