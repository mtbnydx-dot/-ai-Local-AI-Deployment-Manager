// One model (05 §12.3): its facts, limits, prices, aliases and the ways to try it.

import { html } from "../lib/html.js";
import { usePortal, usePageTitle } from "../lib/context.js";
import { formatInteger, formatTokenCount } from "../lib/format.js";
import { findModel } from "../lib/models.js";
import { StatusBadge } from "../components/status-badge.js";
import { CopyButton } from "../components/copy-button.js";
import { DataTable } from "../components/table.js";
import { EmptyState, ErrorNotice, Loading } from "../components/notice.js";
import { stateLabel, tagKeys } from "../components/model-card.js";
import { useModelList } from "./models.js";

function Row({ label, value }) {
  if (value === null || value === undefined || value === "") return null;
  return html`<div class="fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function pricingUnit(t, unit) {
  return t.has(`price.unit.${unit}`) ? t(`price.unit.${unit}`) : String(unit);
}

export default function ModelPage({ route }) {
  const { t, lang } = usePortal();
  const { list, catalog } = useModelList();
  const model = list ? findModel(list, route.params.id) : null;
  usePageTitle(model ? model.name : t("nav.models"));

  if (!list) {
    return html`<div class="page page-model">${catalog.error ? html`<${ErrorNotice} error=${catalog.error} onRetry=${catalog.reload} />` : html`<${Loading} />`}</div>`;
  }
  if (!model) {
    return html`<div class="page page-model">
      <${EmptyState} title=${t("model.not_found")}>
        <p class="muted">${t("model.not_found_hint")}</p>
        <p><a class="btn" href="/models">${t("model.back")}</a></p>
      <//>
    </div>`;
  }

  const tags = tagKeys(model);
  const limits = model.limits;
  const limitRows = [
    [t("limits.rpm"), limits.rpm === null ? t("common.not_set") : formatInteger(limits.rpm, lang)],
    [t("limits.tpm"), limits.tpm === null ? t("common.not_set") : formatInteger(limits.tpm, lang)],
    [t("limits.concurrency"), limits.concurrency === null ? t("common.not_set") : formatInteger(limits.concurrency, lang)],
    [t("limits.max_output"), formatTokenCount(limits.maxOutput ?? model.maxOutput) || t("common.not_set")],
  ];
  const pricing = model.pricing;
  const priceRows = pricing
    ? [
      pricing.input !== null ? [t("price.input"), pricing.input] : null,
      pricing.cachedInput !== null ? [t("price.cached_input"), pricing.cachedInput] : null,
      pricing.output !== null ? [t("price.output"), pricing.output] : null,
    ].filter(Boolean)
    : [];

  return html`<div class="page page-model" data-model-id=${model.id}>
    <p class="breadcrumb"><a href="/models">${t("nav.models")}</a> / <span>${model.name}</span></p>
    <header class="model-head">
      <h1>${model.name}</h1>
      <${StatusBadge} kind=${model.state} label=${stateLabel(t, model.state)} large />
    </header>
    <p class="model-id"><code>${model.id}</code> <${CopyButton} text=${model.id} label=${t("model.copy_id", { id: model.id })} /></p>
    ${model.description ? html`<p class="lead">${model.description}</p>` : null}
    ${model.available === true ? html`<p><span class="chip chip-accent">${t("model.available")}</span></p>` : null}
    ${model.available === false ? html`<p><span class="chip">${t("model.unavailable")}</span> <a href="/me">${t("models.key_manage")}</a></p>` : null}
    ${tags.length ? html`<ul class="chips" aria-label=${t("model.capabilities")}>${tags.map((key) => html`<li class="chip" key=${key}>${t(key)}</li>`)}</ul>` : null}
    <p class="card-actions">
      <a class="btn btn-primary" href=${`/playground?model=${encodeURIComponent(model.id)}`}>${t("model.try")}</a>
      <a class="btn" href="/docs/quickstart">${t("model.docs")}</a>
    </p>

    <section aria-labelledby="specs-title">
      <h2 id="specs-title" class="section-title">${t("model.specs")}</h2>
      <dl class="facts facts-wide">
        <${Row} label=${t("model.family")} value=${model.family} />
        <${Row} label=${t("model.parameters")} value=${model.parameters} />
        <${Row} label=${t("model.quantization")} value=${model.quantization} />
        <${Row} label=${t("model.context")} value=${formatTokenCount(model.context)} />
        <${Row} label=${t("model.max_output")} value=${formatTokenCount(model.maxOutput)} />
        <${Row} label=${t("model.modalities")} value=${model.modalities.map((name) => t(`tag.${name}`)).join(", ")} />
      </dl>
    </section>

    <section aria-labelledby="limits-title">
      <h2 id="limits-title" class="section-title">${model.perKey ? t("model.limits_key") : t("model.limits_default")}</h2>
      <${DataTable} caption=${t("model.limits_caption")} head=${[t("table.limit"), t("table.value")]} rows=${limitRows} />
      <p class="muted small">${t("model.limits_note")}</p>
    </section>

    ${priceRows.length ? html`<section aria-labelledby="price-title">
      <h2 id="price-title" class="section-title">${t("model.pricing")}</h2>
      <${DataTable} caption=${t("model.pricing_caption")} head=${[t("table.kind"), t("table.price")]} rows=${priceRows} />
      <p class="muted small">${pricingUnit(t, pricing.unit)}</p>
    </section>` : null}

    ${model.aliases.length ? html`<section aria-labelledby="alias-title">
      <h2 id="alias-title" class="section-title">${t("model.aliases")}</h2>
      <p class="muted">${t("model.aliases_hint")}</p>
      <ul class="chips">${model.aliases.map((alias) => html`<li class="chip" key=${alias}><code>${alias}</code></li>`)}</ul>
    </section>` : null}
  </div>`;
}
