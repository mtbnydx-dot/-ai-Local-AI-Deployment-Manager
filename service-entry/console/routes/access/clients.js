// /access/clients (07 §6.10): copy-and-paste guides for pointing common apps
// at the gateway. A viewer may open it (05 §5.4): the page needs no secret,
// because the guides say `$API_KEY` where the person's own key goes. The base
// URL selector offers this machine, the LAN address and, when an owner has
// set one, the public base URL.

import { buildBaseUrls, fillGuide, modelNames } from "../../lib/access-model.js";
import { tk } from "../../lib/i18n.js";
import { CLIENT_GUIDES } from "../../data/client-guides.js";
import { Button } from "../../components/button.js";
import { CodeBlock, useCopy } from "../../components/code-block.js";
import { PageHeader } from "../../components/page-header.js";
import { readQueryParam, Tabs } from "../../components/tabs.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";
import { useId, useState } from "../../ui/vendor.js";

const ROUTES = ["local", "lan", "public"];

function CopyValue({ value, label, testid }) {
  const { t } = useT();
  const [state, copy] = useCopy();
  return html`<div class="row-nowrap" data-testid=${testid}>
    <code class="code-inline grow clients-value" data-testid=${`${testid}.value`}>${value}</code>
    <${Button} size="sm" onClick=${() => copy(value)} label=${label} testid=${`${testid}.copy`}>${state === "copied" ? t("common.copied") : t("common.copy")}<//>
  </div>`;
}

function Guide({ guide, urls, model }) {
  const { t } = useT();
  const fill = (text) => fillGuide(text, { baseUrl: urls.openai, anthropicUrl: urls.anthropic, model });
  return html`<div class="stack" data-testid=${`clients.guide.${guide.id}`}>
    <ol class="clients-steps">${guide.steps.map((step) => html`<li key=${step}>${t(step)}</li>`)}</ol>
    ${guide.rows.length ? html`<dl class="kv clients-rows">${guide.rows.map((row) => html`<dt key=${`${row.label}-t`}>${t(row.label)}</dt><dd key=${`${row.label}-d`}><${CopyValue} value=${fill(row.value)} label=${t(row.label)} testid=${`clients.row.${guide.id}.${row.label.split(".").pop()}`} /></dd>`)}</dl>` : null}
    ${guide.snippets.map((snippet) => html`<section key=${snippet.id} class="stack-sm">
      <h3 class="card-title">${t(snippet.label)}</h3>
      <${CodeBlock} code=${fill(snippet.code)} language=${snippet.language} testid=${`clients.snippet.${guide.id}.${snippet.id}`} />
    </section>`)}
  </div>`;
}

export default function Clients() {
  const { api } = useServices();
  const { t } = useT();
  const role = useRole();
  const bootstrap = useBootstrap();
  const modelId = useId();
  const [route, setRoute] = useState("local");
  const [model, setModel] = useState("auto");
  const [guideId, setGuideId] = useState(() => (CLIENT_GUIDES.some((item) => item.id === readQueryParam("guide")) ? readQueryParam("guide") : CLIENT_GUIDES[0].id));
  const settings = useQuery(["access", "settings"], () => api.get("/api/public/settings"), { ttlMs: 30_000, enabled: role === "owner" });
  const fleet = useQuery(["fleet"], () => api.get("/api/fleet"), { ttlMs: 10_000 });
  const location = globalThis.location;
  const publicBase = settings.data?.config?.listeners?.public?.baseUrl || "";
  const all = buildBaseUrls({ where: { protocol: location?.protocol, hostname: location?.hostname, port: location?.port }, gateway: bootstrap.gateway, publicBase });
  const urls = all.find((item) => item.id === route && item.available) || all[0];
  const models = modelNames(fleet.data);
  const guide = CLIENT_GUIDES.find((item) => item.id === guideId) || CLIENT_GUIDES[0];

  return html`<div class="stack" data-testid="clients.root">
    <${PageHeader} title=${t("access.clients.title")} subtitle=${t("access.clients.subtitle")}
      breadcrumbs=${[{ label: t("shell.nav.access"), href: "/access" }, { label: t("access.clients.title") }]} />
    <section class="card stack" aria-labelledby="clients-where">
      <h2 id="clients-where" class="card-title">${t("access.clients.where")}</h2>
      <div class="sf-seg" role="group" aria-label=${t("access.clients.where")} data-testid="clients.routes">
        ${ROUTES.map((id) => {
          const entry = all.find((item) => item.id === id);
          return html`<button key=${id} type="button" class="sf-seg-opt" aria-pressed=${urls.id === id} disabled=${!entry?.available} onClick=${() => setRoute(id)} data-testid=${`clients.route.${id}`}>${t(tk("access.clients.route.", id))}</button>`;
        })}
      </div>
      ${all.find((item) => item.id === "public")?.available ? null : html`<p class="muted small" data-testid="clients.public-missing">${t("access.clients.publicMissing")}</p>`}
      ${urls.placeholder ? html`<p class="muted small" data-testid="clients.lan-hint">${t("access.clients.lanHint")}</p>` : null}
      <dl class="kv">
        <dt>${t("access.clients.openaiBase")}</dt><dd><${CopyValue} value=${urls.openai} label=${t("access.clients.openaiBase")} testid="clients.openai" /></dd>
        <dt>${t("access.clients.anthropicBase")}</dt><dd><${CopyValue} value=${urls.anthropic} label=${t("access.clients.anthropicBase")} testid="clients.anthropic" /></dd>
      </dl>
      <div class="field">
        <label class="field-label" for=${modelId}>${t("access.clients.model")}</label>
        <input id=${modelId} class="input mono" list=${`${modelId}-list`} value=${model} autocomplete="off" spellcheck="false" onInput=${(event) => setModel(event.currentTarget.value || "auto")} data-testid="clients.model" />
        <datalist id=${`${modelId}-list`}>${["auto", ...models].map((item) => html`<option key=${item} value=${item}></option>`)}</datalist>
        <div class="field-hint">${t("access.clients.modelHint")}</div>
      </div>
      <p class="notice" role="note" data-testid="clients.key-note">${t("access.clients.keyNote")}</p>
    </section>
    <${Tabs} tabs=${CLIENT_GUIDES.map((item) => ({ id: item.id, label: item.name }))} value=${guideId} onChange=${setGuideId} urlParam="guide" label=${t("access.clients.guides")}
      renderPanel=${() => html`<${Guide} guide=${guide} urls=${urls} model=${model.trim() || "auto"} />`} />
  </div>`;
}
