// The two drawers of the portal page (05 §12.7, §13.1): an announcement and
// the public description of a model. Both keep a draft of strings (lib/
// portal-model.js), check it lightly, send it, and show the server's field
// errors next to the fields. Loaded on first use by portal.js.

import { ANNOUNCEMENT_AUDIENCES, ANNOUNCEMENT_SEVERITIES, announcementBody, announcementProblems, blankAnnouncement, draftFromAnnouncement, draftFromMeta, metaBody, metaProblems, serverProblems } from "../../lib/portal-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Drawer } from "../../components/drawer.js";
import { FormField } from "../../components/form-field.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";
import { accessError } from "./errors.js";

function useSaver() {
  const { cache, toasts, i18n } = useServices();
  return (messageKey, vars) => {
    cache.invalidate(["access", "portal"]);
    toasts?.push?.({ level: "success", title: i18n.t(messageKey, vars) });
  };
}

function Text({ label, field, draft, set, errors, multiline = false, required = false, testid }) {
  const { t, has } = useT();
  const code = errors[field];
  const error = code ? (has(tk("access.err.", code)) ? t(tk("access.err.", code)) : t("access.err.invalid")) : undefined;
  return html`<${FormField} label=${label} error=${error} required=${required} testid=${`${testid}.field`}>
    ${(props) => (multiline
      ? html`<textarea ...${props} class="textarea" rows="4" value=${draft[field]} onInput=${(event) => set({ [field]: event.currentTarget.value })} data-testid=${testid}></textarea>`
      : html`<input ...${props} class="input" value=${draft[field]} autocomplete="off" onInput=${(event) => set({ [field]: event.currentTarget.value })} data-testid=${testid} />`)}
  <//>`;
}

/** @param item the announcement to edit, or null to create one  @param onClose() */
export function AnnouncementDrawer({ item, onClose }) {
  const { api, i18n } = useServices();
  const { t } = useT();
  const saved = useSaver();
  const [draft, setDraft] = useState(() => (item ? draftFromAnnouncement(item) : blankAnnouncement()));
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));

  async function submit() {
    const found = announcementProblems(draft);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const body = announcementBody(draft);
      if (item) await api.patch(`/api/public/announcements/${encodeURIComponent(item.id)}`, body);
      else await api.post("/api/public/announcements", body);
      saved(item ? "access.portal.announcements.updated" : "access.portal.announcements.created");
      onClose?.();
    } catch (error) {
      setBusy(false);
      setErrors(serverProblems(error));
      setFailure(accessError(error, i18n));
    }
  }

  const footer = html`
    <${Button} onClick=${() => onClose?.()} disabled=${busy} testid="portal.announcement.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" busy=${busy} onClick=${submit} testid="portal.announcement.save">${t("access.portal.save")}<//>`;
  return html`<${Drawer} open width=${640} title=${t(item ? "access.portal.announcements.edit" : "access.portal.announcements.new")} onClose=${busy ? undefined : onClose} footer=${footer} testid="portal.announcement-drawer">
    <div class="stack" data-testid="portal.announcement-form">
      ${failure ? html`<p class="notice notice-danger" role="alert" data-testid="portal.announcement.error">${failure}</p>` : null}
      <${FormField} label=${t("access.portal.severity")} testid="portal.announcement.severity.field">
        ${(props) => html`<select ...${props} class="select" value=${draft.severity} onChange=${(event) => set({ severity: event.currentTarget.value })} data-testid="portal.announcement.severity">
          ${ANNOUNCEMENT_SEVERITIES.map((value) => html`<option key=${value} value=${value}>${t(tk("access.portal.severity.", value))}</option>`)}
        </select>`}
      <//>
      <${Text} label=${t("access.portal.titleZh")} field="titleZh" draft=${draft} set=${set} errors=${errors} required testid="portal.announcement.title-zh" />
      <${Text} label=${t("access.portal.titleEn")} field="titleEn" draft=${draft} set=${set} errors=${errors} required testid="portal.announcement.title-en" />
      <${Text} label=${t("access.portal.bodyZh")} field="bodyZh" draft=${draft} set=${set} errors=${errors} multiline testid="portal.announcement.body-zh" />
      <${Text} label=${t("access.portal.bodyEn")} field="bodyEn" draft=${draft} set=${set} errors=${errors} multiline testid="portal.announcement.body-en" />
      <div class="row">
        <${FormField} label=${t("access.portal.startsAt")} error=${errors.startsAt ? t(tk("access.err.", errors.startsAt)) : undefined} testid="portal.announcement.starts.field">
          ${(props) => html`<input ...${props} class="input" type="datetime-local" value=${draft.startsAt} onInput=${(event) => set({ startsAt: event.currentTarget.value })} data-testid="portal.announcement.starts" />`}
        <//>
        <${FormField} label=${t("access.portal.endsAt")} hint=${t("access.portal.endsHint")} error=${errors.endsAt ? t(tk("access.err.", errors.endsAt)) : undefined} testid="portal.announcement.ends.field">
          ${(props) => html`<input ...${props} class="input" type="datetime-local" value=${draft.endsAt} onInput=${(event) => set({ endsAt: event.currentTarget.value })} data-testid="portal.announcement.ends" />`}
        <//>
      </div>
      <${FormField} label=${t("access.portal.audience")} testid="portal.announcement.audience.field">
        ${(props) => html`<select ...${props} class="select" value=${draft.audience} onChange=${(event) => set({ audience: event.currentTarget.value })} data-testid="portal.announcement.audience">
          ${ANNOUNCEMENT_AUDIENCES.map((value) => html`<option key=${value} value=${value}>${t(tk("access.portal.audience.", value))}</option>`)}
        </select>`}
      <//>
      <label class="check"><input type="checkbox" checked=${draft.published} onChange=${(event) => set({ published: event.currentTarget.checked })} data-testid="portal.announcement.published" />${t("access.portal.published")}</label>
    </div>
  <//>`;
}

function MetaForm({ modelId, meta, onClose }) {
  const { api, i18n } = useServices();
  const { t } = useT();
  const saved = useSaver();
  const [draft, setDraft] = useState(() => draftFromMeta(meta));
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));

  async function submit() {
    const found = metaProblems(draft);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await api.put(`/api/public/models/${encodeURIComponent(modelId)}/meta`, metaBody(draft));
      saved("access.portal.models.saved", { model: modelId });
      onClose?.();
    } catch (error) {
      setBusy(false);
      setErrors(serverProblems(error));
      setFailure(accessError(error, i18n));
    }
  }

  const footer = html`
    <${Button} onClick=${() => onClose?.()} disabled=${busy} testid="portal.meta.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" busy=${busy} onClick=${submit} testid="portal.meta.save">${t("access.portal.save")}<//>`;
  return html`<${Drawer} open width=${640} title=${t("access.portal.models.edit", { model: modelId })} onClose=${busy ? undefined : onClose} footer=${footer} testid="portal.meta-drawer">
    <div class="stack" data-testid="portal.meta-form">
      ${failure ? html`<p class="notice notice-danger" role="alert" data-testid="portal.meta.error">${failure}</p>` : null}
      <${Text} label=${t("access.portal.models.nameZh")} field="nameZh" draft=${draft} set=${set} errors=${errors} testid="portal.meta.name-zh" />
      <${Text} label=${t("access.portal.models.nameEn")} field="nameEn" draft=${draft} set=${set} errors=${errors} testid="portal.meta.name-en" />
      <${Text} label=${t("access.portal.models.descriptionZh")} field="descriptionZh" draft=${draft} set=${set} errors=${errors} multiline testid="portal.meta.description-zh" />
      <${Text} label=${t("access.portal.models.descriptionEn")} field="descriptionEn" draft=${draft} set=${set} errors=${errors} multiline testid="portal.meta.description-en" />
      <${Text} label=${t("access.portal.models.aliases")} field="aliases" draft=${draft} set=${set} errors=${errors} testid="portal.meta.aliases" />
      <${Text} label=${t("access.portal.models.sort")} field="sort" draft=${draft} set=${set} errors=${errors} testid="portal.meta.sort" />
      <label class="check"><input type="checkbox" checked=${draft.recommended} onChange=${(event) => set({ recommended: event.currentTarget.checked })} data-testid="portal.meta.recommended" />${t("access.portal.models.recommended")}</label>
      <label class="check"><input type="checkbox" checked=${draft.hidden} onChange=${(event) => set({ hidden: event.currentTarget.checked })} data-testid="portal.meta.hidden" />${t("access.portal.models.hidden")}</label>
    </div>
  <//>`;
}

/** Loads the model's current description (GET …/meta), then shows the form. */
export function ModelMetaDrawer({ modelId, onClose }) {
  const { api } = useServices();
  const { t } = useT();
  const meta = useQuery(["access", "portal", "meta", modelId], () => api.get(`/api/public/models/${encodeURIComponent(modelId)}/meta`), { ttlMs: 0, keepPrevious: false });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (meta.status === "success" || meta.status === "error") setReady(true);
  }, [meta.status]);
  if (!ready) {
    return html`<${Drawer} open width=${640} title=${t("access.portal.models.edit", { model: modelId })} onClose=${onClose} testid="portal.meta-drawer"><p class="muted" aria-busy="true">${t("access.portal.loading")}</p><//>`;
  }
  return html`<${MetaForm} modelId=${modelId} meta=${meta.data?.meta || null} onClose=${onClose} />`;
}
