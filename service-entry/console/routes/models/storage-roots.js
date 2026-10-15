// The registered roots of the Storage page (07 §6.4): capacity, "Set default",
// "Unregister", and the "Register folder" drawer. Every write goes to the
// manager that served the snapshot (`managerApi`, /model-storage*), and
// unregistering asks first (the files on disk stay).

import { describeError } from "../../lib/api.js";
import { registerBody, rootBadge } from "../../lib/storage-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { Drawer } from "../../components/drawer.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useId, useState } from "../../ui/vendor.js";

function refresh(cache) {
  cache.invalidate(["hub", "storage"]);
  cache.invalidate(["hub", "library"]);
}

// ---- roots ---------------------------------------------------------------------------------

export function RootsCard({ snapshot, managerApi, onRegister }) {
  const { cache, toasts, i18n } = useServices();
  const { t, tk } = useT();
  const fmt = useFormat();
  const [busy, setBusy] = useState("");
  const [removing, setRemoving] = useState(null);
  const roots = Array.isArray(snapshot?.roots) ? snapshot.roots : [];

  async function setDefault(root) {
    setBusy(root.id);
    try {
      await managerApi.post("/model-storage/default", { id: root.id });
      refresh(cache);
      toasts?.push?.({ level: "success", title: t("hub.storage.root.defaultDone", { name: root.label }) });
    } catch (error) {
      toasts?.push?.({ level: "error", title: describeError(error, i18n) });
    } finally {
      setBusy("");
    }
  }
  async function unregister() {
    await managerApi.post("/model-storage/unregister", { id: removing.id });
    refresh(cache);
  }

  return html`<${Card} title=${t("hub.storage.roots.title")} testid="storage.roots"
    actions=${html`<${Button} size="sm" onClick=${onRegister} testid="storage.register-open">${t("hub.storage.register.open")}<//>`}>
    <p class="small muted">${t("hub.storage.roots.lead")}</p>
    <ul class="stack">
      ${roots.map((root) => {
        const badge = rootBadge(root, snapshot.defaultRootId);
        return html`<li key=${root.id} class="stack-sm" data-testid="storage.root" data-root=${root.id} data-badge=${badge}>
          <div class="row">
            <strong data-user-content="">${root.label || root.path}</strong>
            <${StatusBadge} status=${badge === "offline" ? "error" : badge === "default" ? "info" : "neutral"} label=${t(tk("hub.storage.badge.", badge))} />
          </div>
          <code class="code-inline mono xsmall" data-user-content="">${root.path}</code>
          <p class="small muted">${root.online === false ? t("hub.storage.root.offline") : t("hub.storage.root.free", { free: fmt.bytes(root.freeBytes), total: fmt.bytes(root.totalBytes) })}</p>
          <div class="row">
            ${root.online !== false && root.mode === "library" && root.id !== snapshot.defaultRootId
              ? html`<${Button} size="sm" busy=${busy === root.id} onClick=${() => setDefault(root)} testid="storage.set-default">${t("hub.storage.root.setDefault")}<//>` : null}
            ${root.id !== "legacy" ? html`<${Button} size="sm" onClick=${() => setRemoving(root)} testid="storage.unregister">${t("hub.storage.root.unregister")}<//>` : null}
          </div>
        </li>`;
      })}
    </ul>
    <${ConfirmDialog} open=${Boolean(removing)} testid="storage.unregister-confirm" title=${t("hub.storage.unregister.title", { name: removing?.label || "" })}
      body=${t("hub.storage.unregister.body")} confirmLabel=${t("hub.storage.root.unregister")} onConfirm=${unregister} onClose=${() => setRemoving(null)} />
  <//>`;
}

// ---- register -------------------------------------------------------------------------------

const BLANK = Object.freeze({ path: "", label: "", mode: "library", create: false, makeDefault: false });

export function RegisterDrawer({ open, managerApi, onClose, onBrowse, picked }) {
  const { cache, toasts, i18n } = useServices();
  const { t } = useT();
  const id = useId();
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A folder chosen in the dialog lands in the path field.
  useEffect(() => {
    if (picked) setForm((current) => ({ ...current, path: picked.path }));
  }, [picked]);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await managerApi.post("/model-storage/roots", registerBody(form));
      refresh(cache);
      toasts?.push?.({ level: "success", title: t("hub.storage.register.done") });
      setForm(BLANK);
      onClose();
    } catch (failure) {
      setError(describeError(failure, i18n));
    } finally {
      setBusy(false);
    }
  }
  const footer = html`<${Button} onClick=${onClose} testid="storage.register-cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" type="submit" form=${`${id}-form`} busy=${busy} disabled=${!form.path.trim()} testid="storage.register-save">${t("hub.storage.register.save")}<//>`;
  return html`<${Drawer} open=${open} title=${t("hub.storage.register.title")} onClose=${onClose} footer=${footer} testid="storage.register">
    <form id=${`${id}-form`} class="stack" onSubmit=${submit}>
      <p class="small muted">${t("hub.storage.register.lead")}</p>
      <div class="field">
        <label class="field-label" for=${`${id}-path`}>${t("hub.storage.register.path")}</label>
        <div class="row-nowrap">
          <input id=${`${id}-path`} class="input mono grow" name="path" value=${form.path} required autocomplete="off" spellcheck="false"
            onInput=${(event) => set({ path: event.currentTarget.value })} data-testid="storage.register-path" />
          <${Button} onClick=${() => onBrowse(form.path)} testid="storage.register-browse">${t("hub.storage.folder.browse")}<//>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for=${`${id}-label`}>${t("hub.storage.register.label")}</label>
        <input id=${`${id}-label`} class="input" name="label" maxlength="80" value=${form.label} onInput=${(event) => set({ label: event.currentTarget.value })} data-testid="storage.register-label" />
      </div>
      <div class="field">
        <label class="field-label" for=${`${id}-mode`}>${t("hub.storage.register.mode")}</label>
        <select id=${`${id}-mode`} class="select" name="mode" value=${form.mode} onChange=${(event) => set({ mode: event.currentTarget.value })} data-testid="storage.register-mode">
          <option value="library" selected=${form.mode === "library"}>${t("hub.storage.register.modeLibrary")}</option>
          <option value="model" selected=${form.mode === "model"}>${t("hub.storage.register.modeModel")}</option>
        </select>
      </div>
      <label class="row-nowrap"><input type="checkbox" checked=${form.create} onChange=${(event) => set({ create: event.currentTarget.checked })} data-testid="storage.register-create" />
        <span>${t("hub.storage.register.create")}</span></label>
      <label class="row-nowrap"><input type="checkbox" checked=${form.makeDefault} onChange=${(event) => set({ makeDefault: event.currentTarget.checked })} data-testid="storage.register-default" />
        <span>${t("hub.storage.register.makeDefault")}</span></label>
      <p class="small muted">${t("hub.storage.register.note")}</p>
      ${error ? html`<p class="field-error" role="alert" data-testid="storage.register-error" data-user-content="">${error}</p>` : null}
    </form>
  <//>`;
}
