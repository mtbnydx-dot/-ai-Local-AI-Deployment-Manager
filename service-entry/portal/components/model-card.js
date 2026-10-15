// One model of the catalog as a card (05 §12.3): name, state, the facts that
// matter when choosing, and the way into the playground and the docs.

import { html } from "../lib/html.js";
import { usePortal } from "../lib/context.js";
import { formatInteger, formatTokenCount, modelPath } from "../lib/format.js";
import { StatusBadge } from "./status-badge.js";
import { CopyButton } from "./copy-button.js";

const CAPABILITY_TAGS = ["vision", "audio", "embedding", "rerank"];

/** The plain-language capability tags of a model, as translation keys. */
export function tagKeys(model) {
  const keys = model.modalities.filter((name) => CAPABILITY_TAGS.includes(name)).map((name) => `tag.${name}`);
  if (model.tools) keys.push("tag.tools");
  if (model.reasoning) keys.push("tag.reasoning");
  return keys;
}

export function stateLabel(t, state) {
  return t.has(`state.${state}`) ? t(`state.${state}`) : t("state.unknown");
}

function Fact({ label, value }) {
  if (value === null || value === undefined || value === "") return null;
  return html`<div class="fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}

export function priceLine(t, pricing) {
  if (!pricing) return null;
  const parts = [];
  if (pricing.input !== null) parts.push(`${t("price.input")} ${pricing.input}`);
  if (pricing.output !== null) parts.push(`${t("price.output")} ${pricing.output}`);
  return parts.length ? parts.join(" · ") : null;
}

export function ModelCard({ model }) {
  const { t, lang } = usePortal();
  const tags = tagKeys(model);
  const params = [model.parameters, model.quantization].filter(Boolean).join(" · ");
  const rpm = model.limits.rpm;
  const price = priceLine(t, model.pricing);
  return html`<article class="card model-card" data-model-id=${model.id}>
    <header class="card-head">
      <h2 class="card-title"><a href=${modelPath(model.id)}>${model.name}</a></h2>
      <${StatusBadge} kind=${model.state} label=${stateLabel(t, model.state)} />
    </header>
    <p class="model-id"><code>${model.id}</code> <${CopyButton} text=${model.id} label=${t("model.copy_id", { id: model.id })} /></p>
    ${model.description ? html`<p class="card-text">${model.description}</p>` : null}
    ${model.available === true ? html`<p><span class="chip chip-accent">${t("model.available")}</span></p>` : null}
    ${model.available === false ? html`<p><span class="chip">${t("model.unavailable")}</span></p>` : null}
    ${tags.length || model.recommended ? html`<ul class="chips" aria-label=${t("model.capabilities")}>
      ${model.recommended ? html`<li class="chip chip-accent">${t("tag.recommended")}</li>` : null}
      ${tags.map((key) => html`<li class="chip" key=${key}>${t(key)}</li>`)}
    </ul>` : null}
    <dl class="facts">
      <${Fact} label=${t("model.family")} value=${model.family} />
      <${Fact} label=${t("model.size")} value=${params} />
      <${Fact} label=${t("model.context")} value=${formatTokenCount(model.context)} />
      <${Fact} label=${t("model.max_output")} value=${formatTokenCount(model.maxOutput)} />
      <${Fact} label=${model.perKey ? t("model.rpm_key") : t("model.rpm")} value=${rpm === null ? null : formatInteger(rpm, lang)} />
      <${Fact} label=${t("model.price")} value=${price} />
    </dl>
    <footer class="card-actions">
      <a class="btn btn-primary" href=${`/playground?model=${encodeURIComponent(model.id)}`}>${t("model.try")}</a>
      <a class="btn" href="/docs/quickstart">${t("model.docs")}</a>
    </footer>
  </article>`;
}
