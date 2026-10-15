// Audit › Export chain `/audit/exports` (07 §6.8, 04 §16): the audit exports
// as chains — one full baseline plus the incrementals after it — with the
// retention plan, the "export now" action and the Markdown of each export.
// The list and the status need the owner only; opening or downloading an
// export's Markdown is content and needs the audit unlock.

import { chainModel, exportBody, incrementalCount } from "../../lib/audit-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { Drawer } from "../../components/drawer.js";
import { MarkdownViewer } from "../../components/markdown-viewer.js";
import { StatusBadge } from "../../components/status-badge.js";
import { AuditPage, LoadError, Loading, useAuditApi, useAuditLoad } from "./common.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";

function saveText(name, text) {
  try {
    const url = globalThis.URL.createObjectURL(new globalThis.Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = globalThis.document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    globalThis.document.body.appendChild(link);
    link.click();
    link.remove();
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// One export's Markdown

function MarkdownDrawer({ auditId, onClose }) {
  const audit = useAuditApi();
  const { t } = useT();
  const loaded = useAuditLoad(() => audit.get(`exports/${encodeURIComponent(auditId)}/markdown`, undefined, { text: true, timeoutMs: 60_000 }), [auditId]);
  return html`<${Drawer} open=${true} title=${t("audit.exports.markdownTitle", { id: auditId })} width=${840} onClose=${onClose} testid="audit.markdown"
    footer=${html`<${Button} icon="save" disabled=${typeof loaded.data !== "string"} onClick=${() => saveText(`${auditId}.md`, loaded.data)} testid="audit.markdown.download">${t("audit.exports.download")}<//>`}>
    ${loaded.error ? html`<${LoadError} error=${loaded.error} onRetry=${loaded.reload} />`
      : loaded.data === undefined ? html`<${Loading} rows=${6} />`
      : html`<div data-user-content><${MarkdownViewer} source=${loaded.data} allowImages="none" flatHeadings=${true} testid="audit.markdown.body" /></div>`}
  <//>`;
}

// ---------------------------------------------------------------------------
// Chains

function ExportRow({ row, unlocked, onOpen }) {
  const { t } = useT();
  const fmt = useFormat();
  return html`<tr data-audit-id=${row.auditId} data-mode=${row.mode} data-testid="audit.export" class=${row.removeReason ? "audit-removable" : undefined}>
    <th scope="row" class="mono small" data-user-content>${row.auditId}</th>
    <td>${row.mode === "full" ? t("audit.mode.full") : t("audit.mode.incremental")}</td>
    <td>${row.createdAt ? html`<time dateTime=${row.createdAt} title=${fmt.dateTime(row.createdAt, { style: "long" })}>${fmt.dateTime(row.createdAt, { style: "short" })}</time>` : "—"}</td>
    <td class="num tabular">${fmt.integer(row.chatCount)}</td>
    <td class="num tabular">${fmt.integer(row.messageCount)}</td>
    <td class="num tabular">${fmt.bytes(row.mdBytes)}</td>
    <td>
      ${row.empty ? html`<${StatusBadge} status="neutral" label=${t("audit.export.empty")} />` : null}
      ${row.removeReason ? html`<${StatusBadge} status="warn" label=${t("audit.export.removable", { reason: t(tk("audit.reason.", row.removeReason)) })} />` : null}
    </td>
    <td>${row.hasMarkdown ? html`<${Button} size="sm" icon="file-search" disabled=${!unlocked} onClick=${() => onOpen(row.auditId)} testid="audit.export.open">${t("audit.exports.view")}<//>` : "—"}</td>
  </tr>`;
}

function ExportTable({ rows, unlocked, onOpen, caption }) {
  const { t } = useT();
  return html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: caption })}>
    <table class="table" data-testid="audit.export-table">
      <caption class="sr-only">${caption}</caption>
      <thead><tr>
        <th scope="col">${t("audit.col.export")}</th><th scope="col">${t("audit.col.mode")}</th><th scope="col">${t("audit.col.time")}</th>
        <th scope="col" class="num">${t("audit.col.chats")}</th><th scope="col" class="num">${t("audit.col.messages")}</th><th scope="col" class="num">${t("audit.col.size")}</th>
        <th scope="col">${t("audit.col.state")}</th><th scope="col">${t("audit.col.markdown")}</th>
      </tr></thead>
      <tbody>${rows.map((row) => html`<${ExportRow} key=${row.auditId} row=${row} unlocked=${unlocked} onOpen=${onOpen} />`)}</tbody>
    </table>
  </div>`;
}

function Chain({ chain, unlocked, onOpen }) {
  const { t } = useT();
  const fmt = useFormat();
  const rows = [...(chain.baseline ? [chain.baseline] : []), ...chain.incrementals];
  return html`<${Card} title=${t("audit.chain.title", { id: chain.id })} testid="audit.chain-card"
    actions=${chain.active ? html`<${StatusBadge} status="ok" label=${t("audit.chain.active")} />` : null}>
    <div class="stack-sm" data-chain=${chain.id}>
      <p data-testid="audit.chain" data-incrementals=${incrementalCount(chain)}>${t("audit.chain", { n: incrementalCount(chain) })}</p>
      <dl class="obs-facts small">
        <div><dt>${t("audit.col.chats")}</dt><dd>${fmt.integer(chain.chats)}</dd></div>
        <div><dt>${t("audit.col.messages")}</dt><dd>${fmt.integer(chain.messages)}</dd></div>
        <div><dt>${t("audit.col.size")}</dt><dd>${fmt.bytes(chain.bytes)}</dd></div>
        ${chain.empties ? html`<div><dt>${t("audit.chain.empties")}</dt><dd>${fmt.integer(chain.empties)}</dd></div>` : null}
      </dl>
      ${chain.baseline ? null : html`<p class="notice notice-warn" role="status" data-testid="audit.chain.nobaseline">${t("audit.chain.noBaseline")}</p>`}
      <${ExportTable} rows=${rows} unlocked=${unlocked} onOpen=${onOpen} caption=${t("audit.chain.title", { id: chain.id })} />
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Export now

function ExportNow({ onDone }) {
  const { api, toasts, cache } = useServices();
  const audit = useAuditApi();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("incremental");
  const [note, setNote] = useState("");
  async function run() {
    const answer = await api.post("/api/audit/export", exportBody(mode, note), { headers: audit.session.headers(), timeoutMs: 120_000 });
    cache?.invalidate?.(["audit"]);
    const text = answer?.skipped ? t("audit.export.skipped", { reason: answer.reason || "—" }) : answer?.empty ? t("audit.export.emptyDone") : t("audit.export.done", { id: answer?.auditId || "—" });
    toasts?.push?.({ level: answer?.skipped ? "warn" : "success", title: text });
    onDone?.();
  }
  return html`<${Button} variant="primary" onClick=${() => setOpen(true)} testid="audit.export-now">${t("audit.exportNow")}<//>
    <${ConfirmDialog} open=${open} title=${t("audit.exportNow")} confirmLabel=${t("audit.exportNow")} onConfirm=${run} onClose=${() => setOpen(false)} testid="audit.export-dialog"
      body=${html`<div class="stack-sm">
        <p>${t("audit.export.explain")}</p>
        <fieldset class="obs-sources">
          <legend>${t("audit.col.mode")}</legend>
          ${["incremental", "full"].map((value) => html`<label class="check" key=${value}><input type="radio" name="audit-export-mode" value=${value} checked=${mode === value} data-testid=${`audit.export-mode.${value}`}
            onChange=${() => setMode(value)} /> ${t(tk("audit.mode.", value))}</label>`)}
        </fieldset>
        <div class="field">
          <label class="field-label" for="audit-export-note">${t("audit.export.note")}</label>
          <input class="input" id="audit-export-note" type="text" maxlength="500" autocomplete="off" value=${note} data-testid="audit.export-note" onInput=${(event) => setNote(event.currentTarget.value)} />
        </div>
      </div>`} />`;
}

// ---------------------------------------------------------------------------
// Page

function Body() {
  const audit = useAuditApi();
  const { t, has } = useT();
  const fmt = useFormat();
  const [viewing, setViewing] = useState(null);
  const loaded = useAuditLoad(async () => {
    const [status, exports] = await Promise.all([audit.get("status"), audit.get("exports")]);
    return { status, exports };
  }, []);
  if (loaded.error) return html`<${LoadError} error=${loaded.error} onRetry=${loaded.reload} />`;
  if (!loaded.data) return html`<${Loading} rows=${5} />`;
  const { status, exports } = loaded.data;
  const model = chainModel(status, exports);
  const unlocked = audit.session.active();
  const policy = status?.retention?.policy || {};
  const index = status?.index || {};
  return html`<div class="stack" data-testid="audit.exports">
    <${Card} title=${t("audit.exports.title")} testid="audit.exports.summary" actions=${html`<${ExportNow} onDone=${loaded.reload} />`}>
      <div class="stack-sm">
        ${model.needsRebaseline ? html`<p class="notice notice-warn" role="status" data-testid="audit.rebaseline">${t("audit.rebaseline")}</p>` : null}
        ${model.warnings.map((warning) => html`<p key=${warning.code} class="notice notice-warn" role="status" data-testid="audit.warning" data-code=${warning.code}>${has(tk("audit.warn.", warning.code)) ? t(tk("audit.warn.", warning.code)) : warning.message}</p>`)}
        ${index.building ? html`<p class="notice notice-info" role="status" data-testid="audit.index-building">${t("audit.indexBuilding")}</p>` : null}
        <dl class="obs-facts small">
          <div><dt>${t("audit.exports.chains")}</dt><dd>${fmt.integer(model.chains.length)}</dd></div>
          <div><dt>${t("audit.exports.indexed")}</dt><dd>${t("audit.exports.indexedValue", { chats: fmt.integer(index.chats ?? 0), messages: fmt.integer(index.messages ?? 0) })}</dd></div>
          <div><dt>${t("audit.exports.policy")}</dt><dd>${t("audit.exports.policyValue", { exports: policy.maxExports ?? "—", days: policy.maxAgeDays ?? "—", chains: policy.maxChains ?? "—" })}</dd></div>
        </dl>
        ${unlocked ? null : html`<p class="small muted" data-testid="audit.exports.locked">${t("audit.exports.unlockHint")} <a href="/audit/conversations">${t("audit.nav.conversations")}</a></p>`}
      </div>
    <//>
    ${model.chains.length ? model.chains.map((chain) => html`<${Chain} key=${chain.id} chain=${chain} unlocked=${unlocked} onOpen=${setViewing} />`)
      : html`<p class="muted" data-testid="audit.exports.none">${t("audit.exports.none")}</p>`}
    ${model.loose.length ? html`<${Card} title=${t("audit.exports.loose")} testid="audit.loose"><${ExportTable} rows=${model.loose} unlocked=${unlocked} onOpen=${setViewing} caption=${t("audit.exports.loose")} /><//>` : null}
    ${viewing && unlocked ? html`<${MarkdownDrawer} auditId=${viewing} onClose=${() => setViewing(null)} />` : null}
  </div>`;
}

export default function AuditExports() {
  return html`<${AuditPage} id="exports">${() => html`<${Body} />`}<//>`;
}
