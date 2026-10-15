// Docs (05 §12.4): /docs lists the pages, /docs/<slug> shows one. The text is
// markdown under docs/<slug>.<lang>.md, rendered by lib/md.js (escape-first).
// {{OPENAI_BASE}}, {{KEY}} and the other placeholders are filled from
// /portal-config.json; the key stays $API_KEY unless the reader opts in. The
// errors page is generated from data/error-taxonomy.json (the service's own
// taxonomy) and the clients page from data/client-snippets.json.

import { useEffect, useMemo, useState } from "preact/hooks";
import { html } from "../lib/html.js";
import { usePortal, usePageTitle } from "../lib/context.js";
import { useResource } from "../lib/hooks.js";
import { ApiError, fetchJson, getCatalog } from "../lib/api.js";
import { parseMarkdown } from "../lib/md.js";
import { fillTemplate, groupClients, renderClient, snippetAge, templateContext } from "../lib/snippets.js";
import { fromCatalog } from "../lib/models.js";
import { Markdown } from "../components/markdown.js";
import { CodeBlock } from "../components/code-block.js";
import { EmptyState, ErrorNotice, Loading } from "../components/notice.js";

/** The docs pages in reading order (05 §12.4). */
export const DOC_SLUGS = Object.freeze(["quickstart", "api", "streaming", "tools", "vision", "tts", "errors", "limits", "privacy", "clients"]);
// Pages whose text carries no base URL, model or key.
const PLAIN_PAGES = new Set(["errors", "privacy"]);
const BASE = import.meta.url;
const dataUrl = (name) => new URL(`../data/${name}`, BASE).href;

async function fetchText(url, signal) {
  let response;
  try {
    response = await fetch(url, { credentials: "omit", signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError("Network error", { code: "network_error" });
  }
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, { status: response.status, code: `http_${response.status}` });
  return response.text();
}

// The page text in the reader's language; the other language when that file is missing.
async function loadDocText(slug, lang, signal) {
  const other = lang === "zh-CN" ? "en-US" : "zh-CN";
  try {
    return await fetchText(new URL(`../docs/${slug}.${lang}.md`, BASE).href, signal);
  } catch (error) {
    if (error?.status !== 404) throw error;
    return fetchText(new URL(`../docs/${slug}.${other}.md`, BASE).href, signal);
  }
}

/** The model a snippet shows when the reader typed none: the first catalog model of the entry's kind. */
export function defaultModelId(models, modality = "text") {
  const list = Array.isArray(models) ? models : [];
  const found = list.find((model) => model.modalities.includes(modality)) || (modality === "text" ? list[0] : null);
  return found ? found.id : "";
}

function DocNav({ slug }) {
  const { t } = usePortal();
  return html`<nav class="docs-nav" aria-label=${t("docs.nav_label")}>
    <ul>
      ${DOC_SLUGS.map((name) => html`<li><a href=${`/docs/${name}`} aria-current=${name === slug ? "page" : null}>${t(`docs.page.${name}`)}</a></li>`)}
    </ul>
  </nav>`;
}

function Personalize({ model, onModel, models, insertKey, onInsertKey, hasKey }) {
  const { t } = usePortal();
  return html`<div class="docs-controls toolbar">
    <div class="field">
      <label for="docs-model">${t("docs.model")}</label>
      <input id="docs-model" type="text" list="docs-models" value=${model} placeholder=${t("docs.model_placeholder")} autocomplete="off" spellcheck="false"
        onInput=${(event) => onModel(event.currentTarget.value.trim())} />
      <datalist id="docs-models">${models.map((item) => html`<option value=${item.id}></option>`)}</datalist>
    </div>
    <label class="check">
      <input type="checkbox" checked=${insertKey} disabled=${!hasKey} onChange=${(event) => onInsertKey(event.currentTarget.checked)} />
      <span>${t("docs.insert_key")}</span>
    </label>
    <p class="muted small docs-controls-hint">${hasKey ? t("docs.insert_key_hint") : t("docs.insert_key_none")}</p>
  </div>`;
}

function ErrorsSection({ lang }) {
  const { t } = usePortal();
  const taxonomy = useResource((signal) => fetchJson(dataUrl("error-taxonomy.json"), { signal }), []);
  const errors = taxonomy.data?.errors;
  // /docs/errors#<code> points at one entry; it exists only once the data has loaded.
  useEffect(() => {
    if (!errors || !window.location.hash) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    document.getElementById(id)?.scrollIntoView();
  }, [errors]);
  if (taxonomy.error) return html`<${ErrorNotice} error=${taxonomy.error} onRetry=${taxonomy.reload} />`;
  if (!errors) return html`<${Loading} />`;
  return html`<section aria-labelledby="errors-list-title">
    <h2 id="errors-list-title">${t("docs.errors.list")}</h2>
    <div class="stack">
      ${errors.map((item) => {
        const copy = item.copy[lang] || item.copy["en-US"];
        const status = item.anthropicStatus !== item.status ? `${item.status} / ${item.anthropicStatus}` : String(item.status);
        const types = item.anthropicType !== item.openaiType ? `${item.openaiType} / ${item.anthropicType}` : item.openaiType;
        return html`<article class="card error-doc" id=${item.code} key=${item.code}>
          <header class="card-head">
            <h3 class="card-title"><code>${item.code}</code></h3>
            <span class="badge" data-status=${item.status}>HTTP ${status}</span>
          </header>
          <p class="card-text"><strong>${copy.title}.</strong> ${copy.explanation}</p>
          <ul class="error-doc-steps">${copy.steps.map((step) => html`<li>${step}</li>`)}</ul>
          <dl class="error-facts">
            <dt>${t("docs.errors.type")}</dt><dd><code>${types}</code></dd>
            <dt>${t("docs.errors.message")}</dt><dd><code>${item.message}</code></dd>
            ${item.param ? html`<dt>${t("docs.errors.param")}</dt><dd><code>${item.param}</code></dd>` : null}
            ${item.retryAfter ? html`<dt>${t("docs.errors.retry")}</dt><dd>${t("docs.errors.retry_yes")}</dd>` : null}
          </dl>
        </article>`;
      })}
    </div>
  </section>`;
}

function ClientsSection({ lang, context, modelFor }) {
  const { t } = usePortal();
  const resource = useResource((signal) => fetchJson(dataUrl("client-snippets.json"), { signal }), []);
  const doc = resource.data;
  const age = useMemo(() => (doc ? snippetAge(doc) : null), [doc]);
  if (resource.error) return html`<${ErrorNotice} error=${resource.error} onRetry=${resource.reload} />`;
  if (!doc) return html`<${Loading} />`;
  const groups = groupClients(doc);
  if (!groups.length) return html`<${EmptyState} title=${t("docs.clients.empty")} />`;
  return html`<section aria-labelledby="clients-list-title">
    <h2 id="clients-list-title">${t("docs.clients.list")}</h2>
    <p class="muted small docs-checked" data-stale=${String(age.stale)}>${t("docs.clients.checked", { date: age.asOf })}${age.stale ? html` <strong>${t("docs.clients.stale")}</strong>` : null}</p>
    <div class="stack">
      ${groups.map((group) => html`<section class="client-group" key=${group.id} aria-labelledby=${`group-${group.id}`}>
        <h3 id=${`group-${group.id}`}>${t(`docs.group.${group.id}`)}</h3>
        <div class="stack">
          ${group.clients.map((entry) => {
            const view = renderClient(entry, lang, { ...context, MODEL: modelFor(entry, context.MODEL) });
            return html`<article class="card client-snippet" id=${entry.id} key=${entry.id} data-client=${entry.id}>
              <header class="card-head">
                <h4 class="card-title">${entry.name}</h4>
                <span class="muted small">${t("docs.clients.tested", { version: entry.versionTested, date: entry.asOf })}</span>
              </header>
              ${view.kind === "code"
                ? html`<${CodeBlock} code=${view.code} language=${view.language} label=${t("docs.clients.copy_label", { name: entry.name })} />`
                : html`<ol class="client-steps">${view.steps.map((step) => html`<li>${step}</li>`)}</ol>`}
              ${view.note ? html`<p class="muted small client-note">${view.note}</p>` : null}
            </article>`;
          })}
        </div>
      </section>`)}
    </div>
  </section>`;
}

function DocIndex() {
  const { t } = usePortal();
  usePageTitle(t("nav.docs"));
  return html`<div class="page page-docs">
    <h1>${t("docs.title")}</h1>
    <p class="lead">${t("docs.lead")}</p>
    <div class="grid docs-index">
      ${DOC_SLUGS.map((slug) => html`<a class="card card-link" href=${`/docs/${slug}`} key=${slug}>
        <span class="card-title">${t(`docs.page.${slug}`)}</span>
        <span class="card-text">${t(`docs.desc.${slug}`)}</span>
      </a>`)}
    </div>
  </div>`;
}

function DocPage({ slug }) {
  const { t, lang, config, key } = usePortal();
  usePageTitle(t(`docs.page.${slug}`));
  const [model, setModel] = useState("");
  const [insertKey, setInsertKey] = useState(false);
  const text = useResource((signal) => loadDocText(slug, lang, signal), [slug, lang]);
  const catalog = useResource((signal) => getCatalog({ signal }), [], { enabled: !PLAIN_PAGES.has(slug) });
  const models = useMemo(() => (Array.isArray(catalog.data?.models) ? catalog.data.models.map((entry) => fromCatalog(entry, lang)) : []), [catalog.data, lang]);
  const modelFor = (entry, current) => (model ? current : defaultModelId(models, entry?.modality || (slug === "tts" ? "audio" : "text")) || current);
  const context = templateContext({
    config,
    origin: window.location.origin,
    model,
    key,
    insertKey: insertKey && Boolean(key),
  });
  const filled = useMemo(() => (text.data === null ? null : fillTemplate(text.data, { ...context, MODEL: modelFor(null, context.MODEL) })), [text.data, config, model, key, insertKey, models, slug]);
  const blocks = useMemo(() => (filled === null ? null : parseMarkdown(filled)), [filled]);
  const personalize = !PLAIN_PAGES.has(slug);

  return html`<div class="page page-docs">
    <div class="docs-layout">
      <${DocNav} slug=${slug} />
      <article class="docs-article" data-doc=${slug}>
        ${personalize ? html`<${Personalize} model=${model} onModel=${setModel} models=${models} insertKey=${insertKey} onInsertKey=${setInsertKey} hasKey=${Boolean(key)} />` : null}
        ${text.error ? html`<${ErrorNotice} error=${text.error} onRetry=${text.reload} />` : null}
        ${blocks ? html`<${Markdown} blocks=${blocks} copyLabel=${t("copy.label")} />` : text.error ? null : html`<${Loading} />`}
        ${slug === "errors" ? html`<${ErrorsSection} lang=${lang} />` : null}
        ${slug === "clients" ? html`<${ClientsSection} lang=${lang} context=${context} modelFor=${modelFor} />` : null}
      </article>
    </div>
  </div>`;
}

export default function DocsPage({ route }) {
  const { t } = usePortal();
  if (route.name === "doc") {
    if (!DOC_SLUGS.includes(route.params.slug)) {
      return html`<div class="page"><h1>${t("notfound.title")}</h1><p class="lead">${t("notfound.text")}</p><p><a class="btn btn-primary" href="/docs">${t("docs.back")}</a></p></div>`;
    }
    return html`<${DocPage} slug=${route.params.slug} key=${route.params.slug} />`;
  }
  return html`<${DocIndex} />`;
}
