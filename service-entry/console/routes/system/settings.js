// /system/settings (06 §4, §10.2, §11; 07 §4.5 config mode, §6.13, CON-24b):
// the platform's settings as a schema-driven form.
//
// Data: GET /api/platform/config -> describeEffectiveConfig() with an etag.
// Every leaf shows where its value comes from (platform.source.*, the SchemaForm
// badge), and a leaf that needs a restart says which components
// (platform.settings.restartRequired). Secret leaves are write-only Set, Replace
// and Clear: the text is sent once in `secrets` and is never echoed, kept or
// logged.
//
// Save is PUT /api/platform/config with `If-Match: "<etag>"` and only the
// changed leaves ({set, unset, secrets}):
//   400 config_invalid  errors[] are placed on their fields;
//   409 config_conflict the settings are reloaded and a DiffTable shows the
//                       person's edits next to what changed elsewhere;
//   409 config_locked   another writer holds the file: one retry after 2 s.
// A saved leaf that needs a restart queues its components in the Apply card.
// Apply is POST /api/platform/config/apply {restart, when:"idle"}: the
// components restart once the platform is idle. "Restart now" asks first, and
// restarting the entry drops this connection until the shell reconnects.

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DiffTable } from "../../components/diff-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { describeError } from "../../lib/api.js";
import { PlatformStatusGuard } from "../../lib/schemas.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { LazyView } from "../deployment-detail/lazy.js";
import { isUnavailable, P6Required, usePlatformOn } from "./gate.js";
import { platformRows } from "./model.js";
import { OperationPanel } from "./operation.js";
import { buildCatalog, buildPlan, collectChanges, conflictRows, expandRestart, indexOf, mergePending, overlayValues, runningIds } from "./settings-model.js";
import { SystemNav } from "./subnav.js";

const CONFIG_KEY = ["platform-config"];
const LOCKED_RETRY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function etagHeader(etag) {
  return typeof etag === "string" && etag ? { "If-Match": `"${etag}"` } : {};
}

export default function Settings() {
  const { api, cache, toasts } = useServices();
  const i18n = useT();
  const { t, pick } = i18n;
  const platformOn = usePlatformOn();
  const config = useQuery(CONFIG_KEY, () => api.get("/api/platform/config"), { ttlMs: 10000, enabled: platformOn });
  const status = useQuery(["platform"], () => api.get("/api/platform/status", { guard: PlatformStatusGuard }), { ttlMs: 5000, enabled: platformOn });
  const [edits, setEdits] = useState({});
  const [fieldErrors, setFieldErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [pending, setPending] = useState([]);
  const [applying, setApplying] = useState(false);
  const [runs, setRuns] = useState([]);
  const [askNow, setAskNow] = useState(false);
  const [entryNote, setEntryNote] = useState(false);

  const description = config.data;
  const rows = useMemo(() => platformRows(status.data, pick), [status.data, pick]);
  const catalog = useMemo(() => buildCatalog(description), [description]);
  const plan = useMemo(() => buildPlan(description), [description]);
  const values = useMemo(() => overlayValues(description, edits), [description, edits]);
  const index = useMemo(() => indexOf(description), [description]);
  const changes = useMemo(() => collectChanges(description, edits), [description, edits]);
  const nameOf = (id) => rows.find((row) => row.id === id)?.label || id;
  const namesOf = (ids) => ids.map(nameOf).join(", ");

  const header = html`<${PageHeader} title=${t("platform.settings.title")} subtitle=${t("platform.settings.subtitle")} />`;
  const nav = html`<${SystemNav} current="settings" owner=${true} />`;

  if (!platformOn || (isUnavailable(config.error) && description === undefined)) return html`<${P6Required} current="settings" titleKey="platform.settings.title" />`;
  if (description === undefined && config.status !== "error") {
    return html`<div class="stack" data-testid="settings.root" aria-busy="true">${header}${nav}<${Skeleton} shape="table" rows=${6} /></div>`;
  }
  if (description === undefined) {
    return html`<div class="stack" data-testid="settings.root">${header}${nav}
      <${EmptyState} icon="circle-x" level=${2} title=${t("platform.settings.error.title")} body=${describeError(config.error, i18n)}
        action=${{ label: t("shell.conn.retry"), onClick: () => config.refetch() }} testid="settings.error" />
    </div>`;
  }

  async function reload() {
    const fresh = await api.get("/api/platform/config");
    cache.set(CONFIG_KEY, fresh);
    return fresh;
  }

  async function save() {
    if (!changes.body || saving) return;
    const sent = changes;
    const base = description;
    setSaving(true);
    setFieldErrors([]);
    try {
      let answer = null;
      for (let attempt = 0; attempt < 2 && !answer; attempt += 1) {
        try {
          answer = await api.put("/api/platform/config", sent.body, { headers: etagHeader(base.etag) });
        } catch (error) {
          if (error?.code === "config_locked" && attempt === 0) {
            toasts?.push?.({ level: "info", title: t("platform.settings.title"), body: t("platform.settings.locked") });
            await sleep(LOCKED_RETRY_MS);
          } else {
            throw error;
          }
        }
      }
      const restart = expandRestart(answer?.restartRequired, runningIds(rows));
      setEdits({});
      setConflict(null);
      setPending((current) => mergePending(current, restart));
      await reload().catch(() => cache.invalidate(CONFIG_KEY));
      toasts?.push?.({ level: "success", title: t("platform.settings.title"), body: restart.length ? t("platform.settings.savedRestart", { components: namesOf(restart) }) : t("platform.settings.saved") });
    } catch (error) {
      if (error?.code === "config_conflict") {
        try {
          await reload();
          setConflict({ base, mine: { set: sent.set, unset: sent.unset } });
        } catch (reloadError) {
          toasts?.push?.({ level: "error", title: t("platform.settings.title"), body: describeError(reloadError, i18n), requestId: reloadError?.requestId || null });
        }
      } else if (error?.code === "config_invalid") {
        setFieldErrors(Array.isArray(error.fieldErrors) ? error.fieldErrors : []);
        toasts?.push?.({ level: "error", title: t("platform.settings.title"), body: t("platform.settings.invalid"), requestId: error?.requestId || null });
      } else {
        toasts?.push?.({ level: "error", title: t("platform.settings.title"), body: describeError(error, i18n), requestId: error?.requestId || null });
      }
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setEdits({});
    setFieldErrors([]);
    setConflict(null);
  }

  function onChange(id, value) {
    // A plain leaf keeps a null edit ("use the default"); only a secret's null is Clear.
    setEdits((current) => ({ ...current, [id]: value === undefined ? null : value }));
    setFieldErrors((current) => current.filter((item) => item.field !== id));
  }

  function onReset(id) {
    setEdits((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setFieldErrors((current) => current.filter((item) => item.field !== id));
  }

  async function apply(when) {
    const restart = pending.slice();
    const answer = await api.post("/api/platform/config/apply", { restart, when });
    const results = Array.isArray(answer?.results) ? answer.results : [];
    const started = results.filter((item) => item.opId);
    const queued = results.filter((item) => item.queued);
    if (started.length) setRuns((current) => [...current, ...started.map((item) => ({ opId: String(item.opId), label: t("platform.settings.restarting", { component: nameOf(item.id) }) }))]);
    else if (!queued.length && answer?.opId) setRuns((current) => [...current, { opId: String(answer.opId), label: t("platform.settings.restarting", { component: namesOf(restart) }) }]);
    if (queued.length) toasts?.push?.({ level: "success", title: t("platform.settings.apply"), body: t("platform.settings.applyQueued", { components: namesOf(queued.map((item) => item.id)) }) });
    setPending([]);
    setEntryNote(restart.includes("entry") && when === "now");
    cache.invalidate(["platform"]);
  }

  async function applyIdle() {
    setApplying(true);
    try {
      await apply("idle");
    } catch (error) {
      toasts?.push?.({ level: "error", title: t("platform.settings.apply"), body: describeError(error, i18n), requestId: error?.requestId || null });
    } finally {
      setApplying(false);
    }
  }

  function fieldBadges(field) {
    const item = index.get(field.id);
    if (!item) return null;
    const restart = item.restartRequired ? (Array.isArray(item.restartRequired) ? item.restartRequired : ["*"]) : [];
    const reverting = !item.secret && Object.hasOwn(edits, field.id) && edits[field.id] === null && item.source === "file";
    return html`${restart.length
      ? html`<span class="badge badge-warn badge-wrap" data-testid="settings.restart-badge">${t("platform.settings.restartRequired", { components: namesOf(expandRestart(restart, runningIds(rows))) })}</span>`
      : null}
      ${(item.secret ? item.secret.source : item.source) === "env" && Array.isArray(item.envNames) && item.envNames.length
        ? html`<span class="badge badge-info badge-wrap" data-testid="settings.env-badge">${t("platform.settings.envSet", { names: item.envNames.join(", ") })}</span>`
        : null}
      ${!item.secret && item.source === "file" && !reverting
        ? html`<${Button} size="sm" variant="ghost" onClick=${() => onChange(field.id, null)} testid="settings.use-default">${t("platform.settings.useDefault")}<//>`
        : null}
      ${reverting
        ? html`<span class="badge badge-warn badge-wrap" data-testid="settings.reverting">${t("platform.settings.unsetPending")}</span>
          <${Button} size="sm" variant="ghost" onClick=${() => onReset(field.id)} testid="settings.undo">${t("platform.settings.undo")}<//>`
        : null}`;
  }

  const fileErrors = [...(Array.isArray(description.errors) ? description.errors : []), ...(Array.isArray(description.overrideErrors) ? description.overrideErrors : [])];
  const diff = conflict
    ? conflictRows(conflict.mine, conflict.base, description, { pick, mineLabel: t("platform.settings.conflict.mine"), theirsLabel: t("platform.settings.conflict.theirs") })
    : [];

  return html`<div class="stack" data-testid="settings.root">
    ${header}
    ${nav}
    ${fileErrors.length ? html`<div class="notice notice-warn" role="status" data-testid="settings.file-errors">
      <div class="stack-sm grow">
        <strong>${t("platform.settings.fileErrors")}</strong>
        <ul>${fileErrors.map((item, at) => html`<li key=${at} data-user-content>${item.message || item.code}</li>`)}</ul>
      </div>
    </div>` : null}
    ${conflict ? html`<${Card} title=${t("platform.settings.conflict.title")} level=${2} testid="settings.conflict">
      <div class="stack">
        <p>${t("platform.settings.conflict.body")}</p>
        <${DiffTable} rows=${diff} caption=${t("platform.settings.conflict.caption")} testid="settings.conflict-diff" />
        <div class="row">
          <${Button} variant="primary" busy=${saving} onClick=${save} testid="settings.conflict-save">${t("platform.settings.conflict.saveAgain")}<//>
          <${Button} onClick=${discard} testid="settings.conflict-discard">${t("platform.settings.conflict.discard")}<//>
        </div>
      </div>
    <//>` : null}
    <div class="row" data-testid="settings.bar">
      <span class="grow small" role="status" data-testid="settings.count">${changes.count ? t("platform.settings.changes", { count: changes.count }) : t("platform.settings.noChanges")}</span>
      <${Button} disabled=${!changes.count || saving} onClick=${discard} testid="settings.discard">${t("platform.settings.discard")}<//>
      <${Button} variant="primary" icon="save" busy=${saving} disabled=${!changes.count} onClick=${save} testid="settings.save">${t("platform.settings.save")}<//>
    </div>
    <${Card} title=${t("platform.settings.form")} level=${2} testid="settings.card">
      <${LazyView} load=${() => import("./settings-form.js")} name="SettingsForm" catalog=${catalog} plan=${plan} values=${values} onChange=${onChange} onReset=${onReset}
        fieldErrors=${fieldErrors} fieldBadges=${fieldBadges} engineLabel=${t("platform.settings.title")} testid="settings.form" />
    <//>
    <${Card} title=${t("platform.settings.apply")} level=${2} testid="settings.apply-card">
      <div class="stack">
        ${pending.length
          ? html`<p data-testid="settings.pending">${t("platform.settings.restartRequired", { components: namesOf(pending) })}</p>`
          : html`<p class="muted" data-testid="settings.pending-none">${t("platform.settings.pendingNone")}</p>`}
        <p class="small muted">${t("platform.settings.applyHint")}</p>
        <div class="row">
          <${Button} variant="primary" busy=${applying} disabled=${!pending.length} onClick=${applyIdle} testid="settings.apply">${t("platform.settings.apply")}<//>
          <${Button} disabled=${!pending.length || applying} onClick=${() => setAskNow(true)} testid="settings.apply-now">${t("platform.settings.applyNow")}<//>
        </div>
        ${entryNote ? html`<p class="notice" role="status" data-testid="settings.entry-note">${t("platform.settings.entryRestart")}</p>` : null}
        ${runs.map((run) => html`<${OperationPanel} key=${run.opId} opId=${run.opId} label=${run.label}
          onDone=${(op) => toasts?.push?.({ level: op.state === "ok" ? "success" : "error", title: run.label, body: op.state === "ok" ? t("platform.operation.state.ok") : op.result?.message || t("platform.operation.state.failed") })}
          onDismiss=${() => setRuns((current) => current.filter((item) => item.opId !== run.opId))} testid="settings.operation" />`)}
      </div>
    <//>
    <${ConfirmDialog} open=${askNow} tone="danger" title=${t("platform.settings.applyNow.title", { components: namesOf(pending) })} body=${t("platform.settings.applyNow.body")}
      confirmLabel=${t("platform.settings.applyNow")} onConfirm=${() => apply("now")} onClose=${() => setAskNow(false)} testid="settings.apply-confirm" />
  </div>`;
}
