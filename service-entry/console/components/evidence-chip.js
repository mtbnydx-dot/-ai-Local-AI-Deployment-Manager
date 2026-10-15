// EvidenceChip (07 §6.3, 02 §4.2, R-UI-1): how sure the platform is about one
// fact of a ModelCard. The four confidences are written out
// (declared, detected, name-heuristic, verified-on-host); a fact with no
// evidence reads "unknown" in grey. A name-heuristic fact is always labelled
// as a guess, and the chip never relies on color alone: it has an icon and the
// text. The source reference (a file pointer, a registry key) is the tooltip.

import { tk } from "../lib/i18n.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { Icon } from "./icon.js";

export const CONFIDENCES = Object.freeze(["declared", "detected", "name-heuristic", "verified-on-host"]);

// 02 §4.2: verified-on-host > declared > detected > name-heuristic.
const RANK = Object.freeze({ "verified-on-host": 3, declared: 2, detected: 1, "name-heuristic": 0 });
const TONE = Object.freeze({
  "verified-on-host": ["check", "badge-success"],
  declared: ["circle-check", "badge-info"],
  detected: ["search", "badge-neutral"],
  "name-heuristic": ["triangle-alert", "badge-warn"],
  unknown: ["circle-help", "badge-neutral"],
});

/** Whether an evidence entry is about `pointer` (the fact itself or a part of it). */
function covers(fact, pointer) {
  return typeof fact === "string" && (fact === pointer || fact.startsWith(`${pointer}/`));
}

/** The best evidence entry for a JSON pointer of a card, or null (02 §4.2 `confidenceOf`). */
export function evidenceFor(card, pointer) {
  const list = Array.isArray(card?.evidence) ? card.evidence : [];
  let best = null;
  for (const item of list) {
    if (!item || typeof item !== "object" || !covers(item.fact, pointer) || !Object.hasOwn(RANK, item.confidence)) continue;
    if (!best || RANK[item.confidence] > RANK[best.confidence]) best = item;
  }
  return best;
}

/** One of the four confidences, or "unknown" when the card has no evidence for the pointer. */
export function confidenceOf(card, pointer) {
  return evidenceFor(card, pointer)?.confidence || "unknown";
}

/** The tooltip text: where the evidence comes from, and its note. */
export function evidenceTitle(evidence) {
  if (!evidence) return "";
  const ref = typeof evidence.source?.ref === "string" ? evidence.source.ref : "";
  const note = typeof evidence.note === "string" ? evidence.note : "";
  return [ref, note].filter(Boolean).join(" · ");
}

/**
 * @param confidence a CONFIDENCES value; anything else (or nothing) renders as unknown
 * @param evidence the evidence entry, for the tooltip
 */
export function EvidenceChip({ confidence, evidence, testid }) {
  const { t } = useT();
  const key = Object.hasOwn(RANK, confidence) ? confidence : "unknown";
  const [icon, tone] = TONE[key];
  return html`<span class=${`badge evidence-chip ${tone}`} data-confidence=${key} title=${evidenceTitle(evidence) || undefined} data-testid=${testid || "evidence-chip.root"}>
    <${Icon} name=${icon} />
    <span>${t(tk("models.confidence.", key))}</span>
  </span>`;
}
