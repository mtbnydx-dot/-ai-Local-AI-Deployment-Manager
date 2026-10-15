// The three destructive key actions (07 §6.10, 05 §13.4), each behind a
// ConfirmDialog with type-to-confirm: revoke (the key name typed back, sent
// as `confirmName`), rotate (the name typed back plus the overlap to keep the
// old key working) and bulk revoke (`REVOKE n`). The server checks the same
// phrases again. A rotate hands `{ key, secret }` to the page, which shows it
// once in the ShareCard.

import { bulkRevokePhrase, ROTATE_OVERLAPS } from "../../lib/access-model.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useServices } from "../../ui/context.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useId, useState } from "../../ui/vendor.js";

function useDone() {
  const { cache, toasts, i18n } = useServices();
  return (messageKey, vars) => {
    cache.invalidate(["access"]);
    toasts?.push?.({ level: "success", title: i18n.t(messageKey, vars) });
  };
}

/** @param keyRecord a KeyRecord  @param onClose(reason)  @param onDone() after the server revoked it */
export function RevokeDialog({ keyRecord, onClose, onDone }) {
  const { t } = useT();
  const { api } = useServices();
  const done = useDone();
  return html`<${ConfirmDialog} open tone="danger" title=${t("access.revoke.title", { name: keyRecord.name })} body=${t("access.revoke.body")}
    details=${[t("access.revoke.detail.immediate"), t("access.revoke.detail.final"), t("access.revoke.detail.keeps")]}
    confirmLabel=${t("access.revoke.confirm")} typeToConfirm=${keyRecord.name} testid="key-dialog.revoke"
    onConfirm=${async () => {
      await api.post(`/api/access/keys/${encodeURIComponent(keyRecord.id)}/revoke`, { confirmName: keyRecord.name });
      done("access.revoke.done", { name: keyRecord.name });
      onDone?.();
    }} onClose=${onClose} />`;
}

/** @param onRotated({ key, secret, overlapSeconds }) the new secret, to be shown once */
export function RotateDialog({ keyRecord, onClose, onRotated }) {
  const { t } = useT();
  const { api } = useServices();
  const done = useDone();
  const id = useId();
  const [overlap, setOverlap] = useState(0);
  const body = html`<div class="stack-sm">
    <p>${t("access.rotate.body")}</p>
    <fieldset class="kf-overlap" data-testid="key-dialog.overlap">
      <legend class="field-label">${t("access.rotate.overlap")}</legend>
      ${ROTATE_OVERLAPS.map((item) => html`<label key=${item.seconds} class="check"><input type="radio" name=${`${id}-overlap`} value=${item.seconds}
        checked=${overlap === item.seconds} onChange=${() => setOverlap(item.seconds)} data-testid=${`key-dialog.overlap.${item.seconds}`} />${t(item.label)}</label>`)}
    </fieldset>
  </div>`;
  return html`<${ConfirmDialog} open title=${t("access.rotate.title", { name: keyRecord.name })} body=${body}
    confirmLabel=${t("access.rotate.confirm")} typeToConfirm=${keyRecord.name} testid="key-dialog.rotate"
    onConfirm=${async () => {
      const result = await api.post(`/api/access/keys/${encodeURIComponent(keyRecord.id)}/rotate`, { overlapSeconds: overlap });
      done("access.rotate.done", { name: keyRecord.name });
      onRotated?.({ kind: "rotate", key: result.key, secret: result.secret, overlapSeconds: overlap });
    }} onClose=${onClose} />`;
}

/** @param keys the KeyRecords to revoke (already limited to the ones not revoked) */
export function BulkRevokeDialog({ keys, onClose, onDone }) {
  const { t } = useT();
  const { api } = useServices();
  const done = useDone();
  const phrase = bulkRevokePhrase(keys.length);
  const names = keys.slice(0, 8).map((key) => key.name);
  const more = keys.length - names.length;
  return html`<${ConfirmDialog} open tone="danger" title=${t("access.bulk.title", { count: keys.length })} body=${t("access.bulk.body", { count: keys.length })}
    details=${[...names, ...(more > 0 ? [t("access.bulk.more", { count: more })] : [])]}
    confirmLabel=${t("access.bulk.confirm", { count: keys.length })} typeToConfirm=${phrase} testid="key-dialog.bulk"
    onConfirm=${async () => {
      const result = await api.post("/api/access/keys/bulk-revoke", { keyIds: keys.map((key) => key.id), confirm: phrase });
      done("access.bulk.done", { count: result?.revoked ?? keys.length });
      onDone?.(result);
    }} onClose=${onClose} />`;
}
