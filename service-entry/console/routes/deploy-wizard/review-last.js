// Review's two small cards that talk to the manager (07 §6.3 step 6):
//
//   LastLaunch   "Diff vs last successful launch": the plan's values against the newest stored
//                launch of this model (GET /api/m/:id/launches, 01 §15). Before the LaunchStore
//                route exists, the legacy recent-launches list stands in and its flat config is
//                mapped through the catalog.
//   SaveProfile  "Save as profile": POST /api/m/:id/tools/profiles with the sparse values the
//                user set and the catalog version they were made against; never a secret.

import { lastLaunchOf, lastLaunchRows, profileBody } from "../../lib/launch-model.js";
import { diffValues, fromLegacyProfile } from "../../lib/wizard-state.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { DiffTable } from "../../components/diff-table.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";

function list(value) {
  return Array.isArray(value) ? value : [];
}

function unavailable(error) {
  return error?.status === 404 || error?.status === 405 || error?.status === 501 || error?.code === "endpoint_unavailable";
}

export function LastLaunch({ draft, plan, catalog }) {
  const { api } = useServices();
  const { t, locale } = useT();
  const managerId = draft.managerId;
  const path = draft.modelRef?.kind === "local" ? draft.modelRef.path : "";
  const history = useQuery(["wizard", "launches", managerId], async () => {
    try {
      const body = await api.manager(managerId).get("/launches", { query: { limit: 50 } });
      return { source: "launches", items: list(Array.isArray(body) ? body : body?.launches ?? body?.items) };
    } catch (error) {
      if (!unavailable(error)) throw error;
      const body = await api.manager(managerId).get("/recent-launches");
      return { source: "recent", items: list(body?.launches ?? body?.items) };
    }
  }, { ttlMs: 20000, enabled: Boolean(managerId && path) });

  let content;
  if (!path) content = html`<p class="muted" data-testid="wizard.last.none">${t("models.wizard.review.last.none")}</p>`;
  else if (history.error && !history.data) content = html`<p class="muted" data-testid="wizard.last.failed">${t("models.wizard.review.last.failed")}</p>`;
  else if (!history.data) content = html`<div aria-busy="true"><${Skeleton} shape="line" rows=${2} /></div>`;
  else {
    let rows = null;
    if (history.data.source === "launches") {
      const record = lastLaunchOf(history.data.items, path);
      if (record) rows = lastLaunchRows(record, plan, catalog, locale);
    } else {
      const entry = history.data.items.find((item) => item && item.model === path && item.config);
      if (entry) {
        const before = fromLegacyProfile({ config: entry.config, engineId: draft.engineId }, catalog, { managerId });
        rows = diffValues(before.values, draft.values, catalog, { locale });
      }
    }
    content = rows
      ? html`<${DiffTable} rows=${rows} caption=${t("models.wizard.review.last.caption")} testid="wizard.last.diff" />`
      : html`<p class="muted" data-testid="wizard.last.none">${t("models.wizard.review.last.none")}</p>`;
  }
  return html`<${Card} title=${t("models.wizard.review.last.title")} testid="wizard.last">${content}<//>`;
}

export function SaveProfile({ draft, plan }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = i18n;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.manager(draft.managerId).post("/tools/profiles", profileBody(draft, plan, name));
      cache?.invalidate?.(["m", draft.managerId, "profiles"]);
      toasts?.push?.({ level: "success", title: t("models.wizard.review.profile.saved", { name: name.trim() }) });
      setOpen(false);
      setName("");
    } catch (failure) {
      setError(failure?.message || String(failure?.code || ""));
    } finally {
      setBusy(false);
    }
  }
  if (!open) return html`<${Button} onClick=${() => setOpen(true)} testid="wizard.profile.open">${t("models.wizard.review.profile.open")}<//>`;
  return html`<form class="row" onSubmit=${save} data-testid="wizard.profile.form">
    <label class="sr-only" for="wizard-profile-name">${t("models.wizard.review.profile.name")}</label>
    <input id="wizard-profile-name" class="input" type="text" maxlength="80" autocomplete="off" value=${name} placeholder=${t("models.wizard.review.profile.name")}
      onInput=${(event) => setName(event.currentTarget.value)} data-testid="wizard.profile.name" />
    <${Button} type="submit" variant="primary" busy=${busy} disabled=${!name.trim()} testid="wizard.profile.save">${t("models.wizard.review.profile.save")}<//>
    <${Button} variant="ghost" onClick=${() => setOpen(false)} testid="wizard.profile.cancel">${t("common.cancel")}<//>
    ${error ? html`<span class="field-error" role="alert" data-testid="wizard.profile.error">${error}</span>` : null}
  </form>`;
}
