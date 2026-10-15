// The create and edit drawer for platform keys (07 §6.10, 05 §13.4). It owns
// the form draft, the validation and the request; the page that opens it
// gets `onSaved` with the response (the secret of a new key included, to be
// shown once in the ShareCard) and decides what to show next. Loaded on first
// use by keys.js and key-detail.js (see lazy.js).

import { draftFromKey, draftFromPreset, draftToCreateBody, draftToPatch, fieldErrorMap, blankDraft, modelNames, validateDraft } from "../../lib/access-model.js";
import { describeError } from "../../lib/api.js";
import { Button } from "../../components/button.js";
import { Drawer } from "../../components/drawer.js";
import { KeyForm } from "../../components/key-form.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useRef, useState } from "../../ui/vendor.js";
import { fetchCustomers } from "./queries.js";

/**
 * @param mode "create" | "edit"
 * @param keyRecord the key being edited (edit)
 * @param initial { preset?, customerId? } to start a create from (the Customers tab uses it)
 * @param onClose() the drawer was dismissed
 * @param onSaved(result) the request succeeded: { kind: "create", key, secret, share } | { kind: "edit", key }
 */
export function KeyDrawer({ mode = "create", keyRecord = null, initial = null, onClose, onSaved }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = useT();
  const create = mode === "create";
  const presets = useQuery(["access", "presets"], async () => (await api.get("/api/access/presets")).presets || [], { ttlMs: 60_000, enabled: create });
  const customers = useQuery(["billing", "customers"], () => fetchCustomers(api), { ttlMs: 30_000 });
  const fleet = useQuery(["fleet"], () => api.get("/api/fleet"), { ttlMs: 10_000 });
  const [draft, setDraft] = useState(() => (create ? { ...blankDraft(), customerId: initial?.customerId || "" } : draftFromKey(keyRecord)));
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const touched = useRef(false);
  const list = presets.data || [];

  // The first time the presets arrive, start from the one the opener asked for (default: friend).
  useEffect(() => {
    if (!create || touched.current || !list.length) return;
    const wanted = list.find((item) => item.id === (initial?.preset || "friend"));
    if (wanted) setDraft((current) => draftFromPreset(wanted, { previous: current }));
  }, [list.length]);

  const presetInfo = create ? list.find((item) => item.id === draft.preset) || null : null;
  const change = (next) => {
    touched.current = true;
    setDraft(next);
  };
  const pick = (id) => {
    touched.current = true;
    setDraft((current) => draftFromPreset(list.find((item) => item.id === id) || null, { previous: current }));
    setErrors({});
  };

  function focusFirstProblem() {
    queueMicrotask(() => globalThis.document?.querySelector?.('[data-testid="key-drawer.root"] [aria-invalid="true"]')?.focus?.());
  }

  async function submit() {
    const found = validateDraft(draft, { presetInfo, mode });
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length) {
      focusFirstProblem();
      return;
    }
    setBusy(true);
    try {
      if (create) {
        const result = await api.post("/api/access/keys", draftToCreateBody(draft));
        cache.invalidate(["access"]);
        setBusy(false);
        onSaved?.({ kind: "create", key: result.key, secret: result.secret, share: result.share });
        return;
      }
      const patch = draftToPatch(draft, keyRecord);
      if (!Object.keys(patch).length) {
        onClose?.();
        return;
      }
      const result = await api.patch(`/api/access/keys/${encodeURIComponent(keyRecord.id)}`, patch);
      cache.invalidate(["access"]);
      toasts?.push?.({ level: "success", title: i18n.t("access.edit.saved", { name: result.key?.name || keyRecord.name }) });
      setBusy(false);
      onSaved?.({ kind: "edit", key: result.key });
    } catch (error) {
      setBusy(false);
      setErrors(fieldErrorMap(error));
      setFailure(error);
      focusFirstProblem();
    }
  }

  const footer = html`
    <${Button} onClick=${() => onClose?.()} disabled=${busy} testid="key-drawer.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" busy=${busy} onClick=${submit} testid="key-drawer.submit">${create ? t("access.create.submit") : t("access.edit.submit")}<//>`;

  return html`<${Drawer} open width=${640} title=${create ? t("access.create.title") : t("access.edit.title", { name: keyRecord?.name || "" })} onClose=${busy ? undefined : onClose} footer=${footer} testid="key-drawer.root">
    ${failure ? html`<p class="notice notice-danger" role="alert" data-testid="key-drawer.error">${Object.keys(errors).length ? t("access.err.fix") : describeError(failure, i18n)}</p>` : null}
    <${KeyForm} mode=${mode} draft=${draft} onChange=${change} errors=${errors} presets=${list} presetInfo=${presetInfo} customers=${customers.data?.rows || []} models=${modelNames(fleet.data)} onPickPreset=${pick} disabled=${busy} />
  <//>`;
}
