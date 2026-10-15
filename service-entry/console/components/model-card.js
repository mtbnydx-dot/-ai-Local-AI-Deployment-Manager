// ModelCardView (07 §6.3 step 1, 02 §4 and §18): what the platform found out
// about a model folder or repository. Every fact is one row with an
// EvidenceChip (R-UI-1), so a guess from the name reads "Guessed from the
// name" and a fact nothing vouches for reads "Unknown". Raw identifiers
// (model type, architecture, template format) are mono secondary text.
// remoteCodeFiles lists the card's auto_map files for the consent dialog
// (R-UI-9).

import { tk } from "../lib/i18n.js";
import { isServableRole } from "../lib/wizard-state.js";
import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { StatusBadge } from "./status-badge.js";
import { EvidenceChip, confidenceOf, evidenceFor } from "./evidence-chip.js";

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function billions(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return "";
  return n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : `${(n / 1e6).toFixed(0)}M`;
}

/**
 * The file names a card's custom code lives in: `customCode.files`, else the
 * module part of each `auto_map` entry ("dspark.DSparkDraftModel" is dspark.py).
 * An auto_map value may be a string or a [slow, fast] pair.
 */
export function remoteCodeFiles(card) {
  const custom = isObject(card?.customCode) ? card.customCode : {};
  const files = list(custom.files).filter((name) => typeof name === "string" && name);
  if (files.length) return [...new Set(files)];
  const out = [];
  for (const target of Object.values(isObject(custom.autoMap) ? custom.autoMap : {})) {
    for (const entry of list(Array.isArray(target) ? target : [target])) {
      if (typeof entry !== "string" || !entry) continue;
      const module = entry.includes(".") ? entry.slice(0, entry.lastIndexOf(".")) : entry;
      out.push(`${module.replace(/^.*--/, "").replaceAll(".", "/")}.py`);
    }
  }
  return [...new Set(out)];
}

/** Whether running the model needs the repository's own Python code (probe consent, R-UI-9). */
export { isServableRole };

export function needsRemoteCode(card) {
  const custom = isObject(card?.customCode) ? card.customCode : {};
  return custom.trustRemoteCodeRequired === true || remoteCodeFiles(card).length > 0;
}

/**
 * The rows of the facts table: { id, pointer, value, mono?, confidence, evidence }.
 * A fact with no value is left out; one with a value and no evidence is "unknown".
 */
export function cardFacts(card, { fmt, pick = (text) => (typeof text === "string" ? text : ""), t = (key) => key } = {}) {
  if (!isObject(card)) return [];
  const identity = isObject(card.identity) ? card.identity : {};
  const quant = isObject(card.quant) ? card.quant : {};
  const topology = isObject(card.topology) ? card.topology : {};
  const rows = [];
  const add = (id, pointer, value, mono = false) => {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return;
    const evidence = evidenceFor(card, pointer);
    rows.push({ id, pointer, value: Array.isArray(value) ? value.join(", ") : String(value), mono, confidence: confidenceOf(card, pointer), evidence });
  };
  add("family", "/identity/familyId", pick(identity.familyLabel) || identity.familyId);
  add("modelType", "/identity/modelType", identity.modelType, true);
  add("architectures", "/identity/architectures", list(identity.architectures).length ? identity.architectures : identity.ggufArchitecture, true);
  add("format", "/format/kind", card.format?.kind === "none" ? "" : card.format?.kind, true);
  add("size", "/weights/totalBytes", Number(card.weights?.totalBytes) > 0 && fmt ? fmt.bytes(card.weights.totalBytes) : "");
  const total = billions(topology.paramsTotal);
  const active = billions(topology.paramsActive);
  add("params", "/topology/paramsTotal", total && active ? t("models.card.paramsActive", { total, active }) : total);
  add("layers", "/topology/layers", topology.layers);
  add("context", "/context/native", Number(card.context?.native) > 0 && fmt ? fmt.tokens(card.context.native) : "");
  add("quant", "/quant/method", [quant.method === "none" ? "" : quant.method, quant.algo].filter(Boolean).join(" · "), true);
  add("modalities", "/modalities/input", list(card.modalities?.input).map((name) => t(tk("models.card.modality.", name))));
  add("toolFormat", "/template/toolFormat", card.template?.toolFormat === "none" ? "" : card.template?.toolFormat, true);
  add("reasoningFormat", "/template/reasoningFormat", card.template?.reasoningFormat === "none" ? "" : card.template?.reasoningFormat, true);
  if (needsRemoteCode(card)) add("customCode", "/customCode", remoteCodeFiles(card).join(", ") || t("models.card.customCodeYes"), true);
  return rows;
}

function messageOf(item, pick) {
  return pick(item?.message) || String(item?.code || "");
}

/** @param card a ModelCard (02 §4.3), `view=full` */
export function ModelCardView({ card, testid, children }) {
  const { t, pick } = useT();
  const fmt = useFormat();
  const identity = isObject(card?.identity) ? card.identity : {};
  const role = card?.role?.value || "main";
  const facts = cardFacts(card, { fmt, pick, t });
  const name = identity.displayName || identity.familyId || card?.cardId || "";
  const warnings = list(card?.warnings);
  const errors = list(card?.errors);
  return html`<div class="model-card stack-sm" data-testid=${testid || "model-card.root"} data-card=${card?.cardId || ""} data-role=${role}>
    <div class="row">
      <strong class="model-card-name" data-user-content="" data-testid="model-card.name">${name}</strong>
      <span class="badge badge-neutral" data-testid="model-card.role">${t(tk("models.role.", role))}</span>
      ${card?.support === "unknown" ? html`<${StatusBadge} status="unknown" label=${t("models.compat.unknownArch")} testid="model-card.support" />` : null}
    </div>
    <table class="table model-card-facts" data-testid="model-card.facts">
      <caption class="sr-only">${t("models.card.caption")}</caption>
      <thead class="sr-only"><tr><th scope="col">${t("models.card.fact")}</th><th scope="col">${t("models.card.value")}</th><th scope="col">${t("models.card.confidence")}</th></tr></thead>
      <tbody>
        ${facts.map((row) => html`<tr key=${row.id} data-fact=${row.id} data-testid="model-card.fact">
          <th scope="row">${t(tk("models.card.fact.", row.id))}</th>
          <td class=${row.mono ? "mono" : ""} data-user-content="">${row.value}</td>
          <td><${EvidenceChip} confidence=${row.confidence} evidence=${row.evidence} /></td>
        </tr>`)}
      </tbody>
    </table>
    ${errors.length || warnings.length ? html`<ul class="stack-sm model-card-notes" data-testid="model-card.notes">
      ${errors.map((item, index) => html`<li key=${`e${index}`} class="small" data-level="error"><${StatusBadge} status="error" label=${t("models.card.error")} /> <span data-user-content="">${messageOf(item, pick)}</span></li>`)}
      ${warnings.map((item, index) => html`<li key=${`w${index}`} class="small" data-level="warn"><${StatusBadge} status="warn" label=${t("models.card.warning")} /> <span data-user-content="">${messageOf(item, pick)}</span></li>`)}
    </ul>` : null}
    ${children}
  </div>`;
}
